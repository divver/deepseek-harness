import { mkdir, mkdtemp } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import CoopService, { masterProfilePath, readMasterProfile, readV2Registry, v2RegistryPath, v2Root } from '../src/index.ts'

/**
 * v2 registry suite over a real agent spine: workspace anchoring (nearest
 * anchor, silent-cwd fallback, ancestor guard), multi-master registration,
 * exclusive bind with masterId isolation, per-master capacity, release, and
 * node-signal delivery into woken turns.
 */

let cleanup: (() => Promise<void>) | undefined

afterAll(async () => {
  await cleanup?.()
})

interface Harness {
  ctx: Context
  cwd: string
  master: Agent
  second: Agent
  worker: Agent
  extra: Agent
  reviewer: Agent
}

async function harness(config: Partial<ConstructorParameters<typeof CoopService>[1]> = {}, cwd?: string): Promise<Harness> {
  const root = cwd ?? await mkdtemp(join(tmpdir(), 'dsh-coop-v2-'))
  const previousCleanup = cleanup
  cleanup = async () => {
    await previousCleanup?.()
    const { rm } = await import('node:fs/promises')
    await rm(root, { recursive: true, force: true })
  }
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(CoopService, { mode: 'v2', mirrorEvents: true, ...config })
  const create = (id: string, at: string = root): Promise<Agent> =>
    ctx.agentLoop.create(SessionId(id), { provider: 'mock', model: 'mock' }, { cwd: at })
  return {
    ctx,
    cwd: root,
    master: await create('master'),
    second: await create('second'),
    worker: await create('worker'),
    extra: await create('extra'),
    reviewer: await create('reviewer'),
  }
}

/** The `[coop]`-sourced follow-up turns one agent received, as text. */
function coopNotices(agent: Agent): string[] {
  return [...agent.session.snapshotEvents()]
    .filter((event): event is SessionEvent<'user/message'> => event.type === 'user/message' && event.data.source.kind === 'coop')
    .map(event => event.data.content.map(block => block.type === 'text' ? block.text : '').join(''))
}

describe('workspace anchor', () => {
  it('falls back to the session cwd when no anchor exists', async () => {
    const { ctx, cwd, master } = await harness()
    const entry = await ctx.coop.registerV2(master, { roles: ['master'] })
    expect(existsSync(v2RegistryPath(v2Root(cwd, '.dsh/coop')))).toBe(true)
    expect(entry.roles).toEqual(['master'])
  })

  it('adopts the nearest anchor above the session cwd after init', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'dsh-coop-ws-'))
    const project = join(parent, 'project-a')
    await mkdir(project, { recursive: true })
    const { ctx, master } = await harness({}, project)
    const root = await ctx.coop.initWorkspace(master)
    expect(root).toBe(parent)
    await ctx.coop.registerV2(master, { roles: ['master'] })
    expect(existsSync(v2RegistryPath(v2Root(parent, '.dsh/coop')))).toBe(true)
    expect(existsSync(join(project, '.dsh'))).toBe(false)
  })

  it('rejects an anchor outside the session ancestry', async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), 'dsh-coop-not-ancestor-'))
    const { ctx, master } = await harness()
    await expect(ctx.coop.initWorkspace(master, elsewhere)).rejects.toMatchObject({ code: 'COOP_CONFIG_UNSUPPORTED' })
  })
})

describe('registration', () => {
  it('mints a masterId, writes the profile, and mirrors the event', async () => {
    const { ctx, cwd, master } = await harness()
    const entry = await ctx.coop.registerV2(master, { roles: ['master'] })
    const masterId = entry.masterId
    expect(masterId).toBeDefined()
    expect(String(masterId)).toMatch(/^[a-z0-9-]+#[0-9a-f]{8}$/u)
    const profile = await readMasterProfile(masterProfilePath(v2Root(cwd, '.dsh/coop'), String(masterId)))
    expect(profile?.status).toBe('active')
    expect(profile?.sessionId).toBe('master')
    expect(master.session.snapshotEvents().some(event => event.type === 'coop/registry-v2')).toBe(true)
  })

  it('resumes the same masterId on re-registration', async () => {
    const { ctx, master } = await harness()
    const first = await ctx.coop.registerV2(master, { roles: ['master'] })
    const again = await ctx.coop.registerV2(master, { roles: ['master'] })
    expect(again.masterId).toBe(first.masterId)
  })

  it('allows multiple live masters in one workspace', async () => {
    const { ctx, master, second } = await harness()
    await ctx.coop.registerV2(master, { roles: ['master'] })
    const other = await ctx.coop.registerV2(second, { roles: ['master'] })
    expect(other.masterId).toBeDefined()
    const status = await ctx.coop.statusV2(master)
    expect(status.masters).toHaveLength(2)
  })

  it('records the model route in node metadata', async () => {
    const { ctx, worker } = await harness()
    const entry = await ctx.coop.registerV2(worker, { roles: ['worker'], model: 'glm-5.3-flash' })
    expect(entry.meta?.model).toBe('glm-5.3-flash')
    expect(entry.bindState).toBe('unbound')
  })

  it('pre-binds to a named live master and rejects unknown ones', async () => {
    const { ctx, master, worker } = await harness()
    const m = await ctx.coop.registerV2(master, { roles: ['master'] })
    const bound = await ctx.coop.registerV2(worker, { roles: ['worker'], masterId: String(m.masterId) })
    expect(bound.bindState).toBe('bound')
    expect(String(bound.masterId)).toBe(String(m.masterId))
    const { ctx: ctx2, reviewer } = await harness()
    await expect(ctx2.coop.registerV2(reviewer, { roles: ['reviewer'], masterId: String(m.masterId) }))
      .rejects.toMatchObject({ code: 'COOP_NODE_NOT_FOUND' })
  })
})

describe('binding', () => {
  it('binds an unbound node exclusively and wakes it in-process', async () => {
    const { ctx, master, worker } = await harness()
    const m = await ctx.coop.registerV2(master, { roles: ['master'] })
    await ctx.coop.registerV2(worker, { roles: ['worker'] })
    const bound = await ctx.coop.bindNode(master, 'worker')
    expect(bound.bindState).toBe('bound')
    expect(String(bound.masterId)).toBe(String(m.masterId))
    expect(coopNotices(worker).some(text => text.includes('bound by master'))).toBe(true)
  })

  it('hides a bound node from every other master', async () => {
    const { ctx, master, second, worker } = await harness()
    await ctx.coop.registerV2(master, { roles: ['master'] })
    await ctx.coop.registerV2(second, { roles: ['master'] })
    await ctx.coop.registerV2(worker, { roles: ['worker'] })
    const before = await ctx.coop.listNodesV2(second)
    expect(before.some(entry => entry.sessionId === 'worker')).toBe(true)
    await ctx.coop.bindNode(master, 'worker')
    const after = await ctx.coop.listNodesV2(second)
    expect(after.some(entry => entry.sessionId === 'worker')).toBe(false)
    await expect(ctx.coop.bindNode(second, 'worker')).rejects.toMatchObject({ code: 'COOP_NODE_NOT_FOUND' })
  })

  it('enforces per-master worker capacity at bind', async () => {
    const { ctx, master, worker, extra } = await harness({ maxWorkers: 1 })
    await ctx.coop.registerV2(master, { roles: ['master'] })
    await ctx.coop.registerV2(worker, { roles: ['worker'] })
    await ctx.coop.registerV2(extra, { roles: ['worker'] })
    await ctx.coop.bindNode(master, 'worker')
    await expect(ctx.coop.bindNode(master, 'extra')).rejects.toMatchObject({ code: 'COOP_NODE_LIMIT_REACHED' })
  })

  it('binds reviewers under their own capacity', async () => {
    const { ctx, master, reviewer, extra } = await harness({ maxReviewers: 1 })
    await ctx.coop.registerV2(master, { roles: ['master'] })
    await ctx.coop.registerV2(reviewer, { roles: ['reviewer'] })
    await ctx.coop.registerV2(extra, { roles: ['reviewer'] })
    await ctx.coop.bindNode(master, 'reviewer')
    await expect(ctx.coop.bindNode(master, 'extra')).rejects.toMatchObject({ code: 'COOP_NODE_LIMIT_REACHED' })
  })

  it('requires the caller to be a live master', async () => {
    const { ctx, worker, extra } = await harness()
    await ctx.coop.registerV2(worker, { roles: ['worker'] })
    await ctx.coop.registerV2(extra, { roles: ['worker'] })
    await expect(ctx.coop.bindNode(worker, 'extra')).rejects.toMatchObject({ code: 'COOP_NODE_NOT_FOUND' })
  })

  it('shows a worker its own master and nothing else', async () => {
    const { ctx, master, second, worker } = await harness()
    const m = await ctx.coop.registerV2(master, { roles: ['master'] })
    await ctx.coop.registerV2(second, { roles: ['master'] })
    await ctx.coop.registerV2(worker, { roles: ['worker'] })
    await ctx.coop.bindNode(master, 'worker')
    const visible = await ctx.coop.listNodesV2(worker)
    expect(visible.map(entry => entry.sessionId).sort()).toEqual(['master', 'worker'])
    expect(visible.every(entry => entry.masterId === undefined || String(entry.masterId) === String(m.masterId))).toBe(true)
  })
})

describe('release and lifecycle', () => {
  it('release returns the node to the unbound pool for another master', async () => {
    const { ctx, master, second, worker } = await harness()
    await ctx.coop.registerV2(master, { roles: ['master'] })
    await ctx.coop.registerV2(second, { roles: ['master'] })
    await ctx.coop.registerV2(worker, { roles: ['worker'] })
    await ctx.coop.bindNode(master, 'worker')
    await ctx.coop.releaseNode(master, 'worker')
    const rebound = await ctx.coop.bindNode(second, 'worker')
    expect(rebound.bindState).toBe('bound')
    expect(coopNotices(worker).some(text => text.includes('released by your master'))).toBe(true)
  })

  it('only the owning master may release', async () => {
    const { ctx, master, second, worker } = await harness()
    await ctx.coop.registerV2(master, { roles: ['master'] })
    await ctx.coop.registerV2(second, { roles: ['master'] })
    await ctx.coop.registerV2(worker, { roles: ['worker'] })
    await ctx.coop.bindNode(master, 'worker')
    await expect(ctx.coop.releaseNode(second, 'worker')).rejects.toMatchObject({ code: 'COOP_NOT_YOUR_NODE' })
  })

  it('off removes the entry and retires the master profile', async () => {
    const { ctx, cwd, master } = await harness()
    const m = await ctx.coop.registerV2(master, { roles: ['master'] })
    await ctx.coop.registerV2(master, { roles: [] })
    const table = await readV2Registry(v2RegistryPath(v2Root(cwd, '.dsh/coop')))
    expect(table?.entries.some(entry => entry.sessionId === 'master')).toBe(false)
    const profile = await readMasterProfile(masterProfilePath(v2Root(cwd, '.dsh/coop'), String(m.masterId)))
    expect(profile?.status).toBe('retired')
    const status = await ctx.coop.statusV2(master)
    expect(status.self).toBeUndefined()
  })
})
