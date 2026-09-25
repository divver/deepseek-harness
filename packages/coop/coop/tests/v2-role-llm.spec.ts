import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import CoopService, { readV2Registry, v2RegistryPath, v2Root } from '../src/index.ts'
import { applyRoleLlmRoute, resolveCoopConfig } from '../src/runtime.ts'

/**
 * Per-role LLM routes: config validation, request rewrite, and the
 * registration-time wiring that pins a session onto its role route.
 */

let cleanup: (() => Promise<void>) | undefined

afterAll(async () => {
  await cleanup?.()
})

describe('resolveCoopConfig roleLlm', () => {
  it('validates routes and brands the effort', () => {
    const resolved = resolveCoopConfig({
      mode: 'v2',
      roleLlm: {
        master: { provider: 'deepseek-official', model: 'deepseek-reasoner', reasoningEffort: 'max' },
        worker: { provider: 'deepseek-official', model: 'deepseek-flash' },
      },
    })
    expect(resolved.roleLlm.master).toEqual({ provider: 'deepseek-official', model: 'deepseek-reasoner', reasoningEffort: 'max' })
    expect(resolved.roleLlm.worker).toEqual({ provider: 'deepseek-official', model: 'deepseek-flash' })
    expect(resolved.roleLlm.reviewer).toBeUndefined()
  })

  it('defaults to no routes', () => {
    expect(resolveCoopConfig({}).roleLlm).toEqual({})
  })

  it('rejects unknown role keys', () => {
    expect(() => resolveCoopConfig({ roleLlm: { waiter: { provider: 'p', model: 'm' } } as never }))
      .toThrowError(/roleLlm role must be one of/)
  })

  it('requires provider and model together', () => {
    expect(() => resolveCoopConfig({ roleLlm: { worker: { model: 'm' } } }))
      .toThrowError(/roleLlm\.worker requires provider and model together/)
    expect(() => resolveCoopConfig({ roleLlm: { worker: { provider: 'p' } } }))
      .toThrowError(/roleLlm\.worker requires provider and model together/)
  })

  it('rejects empty strings and non-object values', () => {
    expect(() => resolveCoopConfig({ roleLlm: { worker: { provider: '', model: 'm' } } }))
      .toThrowError(/must be non-empty/)
    expect(() => resolveCoopConfig({ roleLlm: { worker: { provider: 'p', model: 'm', reasoningEffort: '' } } }))
      .toThrowError(/reasoningEffort must be non-empty/)
    expect(() => resolveCoopConfig({ roleLlm: 'nope' as never }))
      .toThrowError(/roleLlm must be an object/)
  })

  it('skips empty entries', () => {
    expect(resolveCoopConfig({ roleLlm: { worker: {} } }).roleLlm).toEqual({})
  })
})

describe('applyRoleLlmRoute', () => {
  it('replaces the route pair and effort', () => {
    const rewritten = applyRoleLlmRoute(
      { provider: 'a', model: 'old', reasoningEffort: 'low' as never, maxTokens: 4096 },
      { provider: 'b', model: 'new', reasoningEffort: 'high' as never },
    )
    expect(rewritten).toEqual({ provider: 'b', model: 'new', reasoningEffort: 'high', maxTokens: 4096 })
  })

  it('clears the inherited effort when the route pins none', () => {
    const rewritten = applyRoleLlmRoute(
      { provider: 'a', model: 'old', reasoningEffort: 'low' as never },
      { provider: 'b', model: 'new' },
    )
    expect(rewritten).toEqual({ provider: 'b', model: 'new' })
  })
})

describe('registration wiring', () => {
  interface Harness {
    ctx: Context
    cwd: string
    master: Agent
    worker: Agent
  }

  async function harness(config: ConstructorParameters<typeof CoopService>[1] = {}): Promise<Harness> {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-coop-role-llm-'))
    const previousCleanup = cleanup
    cleanup = async () => {
      await previousCleanup?.()
      const { rm } = await import('node:fs/promises')
      await rm(cwd, { recursive: true, force: true })
    }
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(CoopService, { mode: 'v2', mirrorEvents: true, ...config })
    const create = (id: string): Promise<Agent> =>
      ctx.agentLoop.create(SessionId(id), { provider: 'mock', model: 'mock' }, { cwd })
    return { ctx, cwd, master: await create('master'), worker: await create('worker') }
  }

  it('pins each registered session onto its role route and records meta.model', async () => {
    const { ctx, cwd, master, worker } = await harness({
      roleLlm: {
        master: { provider: 'deepseek-official', model: 'deepseek-reasoner', reasoningEffort: 'max' },
        worker: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
      },
    })
    const masterEntry = await ctx.coop.registerV2(master, { roles: ['master'] })
    await ctx.coop.registerV2(worker, { roles: ['worker'], masterId: String(masterEntry.masterId) })
    expect(ctx.coop.roleLlmFor('master')).toEqual({ provider: 'deepseek-official', model: 'deepseek-reasoner', reasoningEffort: 'max' })
    expect(ctx.coop.roleLlmFor('worker')).toEqual({ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' })

    const registry = await readV2Registry(v2RegistryPath(v2Root(cwd, '.dsh/coop')))
    const workerEntry = registry?.entries.find(entry => entry.sessionId === 'worker')
    expect(workerEntry?.meta?.model).toBe('deepseek-official/deepseek-flash')
  })

  it('keeps an explicit spawn model ahead of the role default in meta', async () => {
    const { ctx, worker } = await harness({
      roleLlm: { worker: { provider: 'deepseek-official', model: 'deepseek-flash' } },
    })
    await ctx.coop.registerV2(worker, { roles: ['worker'], model: 'glm/glm-5.3-flash' })
    expect(ctx.coop.roleLlmFor('worker')).toEqual({ provider: 'deepseek-official', model: 'deepseek-flash' })
    expect((await ctx.coop.listNodesV2(worker))[0]?.meta?.model).toBe('glm/glm-5.3-flash')
  })

  it('drops the pin when the session deregisters', async () => {
    const { ctx, worker } = await harness({
      roleLlm: { worker: { provider: 'deepseek-official', model: 'deepseek-flash' } },
    })
    await ctx.coop.registerV2(worker, { roles: ['worker'] })
    expect(ctx.coop.roleLlmFor('worker')).toBeDefined()
    await ctx.coop.registerV2(worker, { roles: [] })
    expect(ctx.coop.roleLlmFor('worker')).toBeUndefined()
  })

  it('leaves requests untouched when no routes are configured', async () => {
    const { ctx, worker } = await harness()
    await ctx.coop.registerV2(worker, { roles: ['worker'] })
    expect(ctx.coop.roleLlmFor('worker')).toBeUndefined()
  })
})
