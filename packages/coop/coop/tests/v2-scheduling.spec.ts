import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import CoopService, { readV2Registry, v2RegistryPath, v2Root } from '../src/index.ts'
import { contextPctOf } from '../src/runtime.ts'
import * as store from '../src/store.ts'
import type { CoopV2RegistryFile } from '../src/types.ts'

/**
 * v2 scheduling suite over a real agent spine: master-designated worker pins
 * (`pinnedAssignee`), context-occupancy-aware worker priority, and
 * context-ceiling recycling (release the hottest idle worker, spawn a fresh
 * replacement) once every bound worker is saturated at capacity.
 */

let cleanup: (() => Promise<void>) | undefined

afterAll(async () => {
  await cleanup?.()
})

interface Harness {
  ctx: Context
  cwd: string
  master: Agent
  worker: Agent
  extra: Agent
  reviewer: Agent
}

async function harness(config: Partial<ConstructorParameters<typeof CoopService>[1]> = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-coop-v2-sched-'))
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
  const create = (id: string): Promise<Agent> =>
    ctx.agentLoop.create(SessionId(id), { provider: 'mock', model: 'mock' }, { cwd: root })
  return {
    ctx,
    cwd: root,
    master: await create('master'),
    worker: await create('worker'),
    extra: await create('extra'),
    reviewer: await create('reviewer'),
  }
}

/** Register the reviewer for the master (idempotent) and walk submit → pass. */
async function activate(ctx: Context, master: Agent, reviewer: Agent, planId: string): Promise<void> {
  const visible = await ctx.coop.listNodesV2(master)
  if (!visible.some(entry => entry.sessionId === String(reviewer.session.id) && entry.roles.includes('reviewer'))) {
    const m = String((await ctx.coop.statusV2(master)).self?.masterId)
    await ctx.coop.registerV2(reviewer, { roles: ['reviewer'], masterId: m })
  }
  await ctx.coop.submitReviewV2(master, planId)
  await ctx.coop.reviewPlanV2(reviewer, planId, 'pass')
}

/** Stamp one entry's meta.contextPct directly in the shared registry file. */
async function seedContext(cwd: string, sessionId: string, contextPct: number): Promise<void> {
  const path = v2RegistryPath(v2Root(cwd, '.dsh/coop'))
  const file = JSON.parse(await readFile(path, 'utf8')) as CoopV2RegistryFile
  file.entries = file.entries.map(entry => entry.sessionId === sessionId
    ? { ...entry, meta: { ...entry.meta, contextPct } }
    : entry)
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`)
}

/** The `[coop]`-sourced follow-up turns one agent received, as text. */
function coopNotices(agent: Agent): string[] {
  return [...agent.session.snapshotEvents()]
    .filter((event): event is SessionEvent<'user/message'> => event.type === 'user/message' && event.data.source.kind === 'coop')
    .map(event => event.data.content.map(block => block.type === 'text' ? block.text : '').join(''))
}

describe('pinned assignment', () => {
  it('assigns a ready task only to the master-designated worker', async () => {
    const { ctx, master, worker, extra, reviewer } = await harness()
    const m = await ctx.coop.registerV2(master, { roles: ['master'] })
    await ctx.coop.registerV2(worker, { roles: ['worker'], masterId: String(m.masterId) })
    await ctx.coop.registerV2(extra, { roles: ['worker'], masterId: String(m.masterId) })
    const plan = await ctx.coop.createPlanV2(master, { title: 'P', objective: 'O' })
    await ctx.coop.addTaskV2(master, plan.planId, { title: 't1', spec: 'do it', pinnedAssignee: 'extra' })
    await activate(ctx, master, reviewer, plan.planId)
    const board = await ctx.coop.boardV2(master, plan.planId)
    expect(board[0]?.tasks[0]?.assignee).toBe('extra')
    expect(board[0]?.tasks[0]?.pinnedAssignee).toBe('extra')
  })

  it('keeps a pinned task ready while its designated worker is busy', async () => {
    const { ctx, master, worker, reviewer } = await harness()
    const m = await ctx.coop.registerV2(master, { roles: ['master'] })
    await ctx.coop.registerV2(worker, { roles: ['worker'], masterId: String(m.masterId) })
    const plan = await ctx.coop.createPlanV2(master, { title: 'P', objective: 'O' })
    await ctx.coop.addTaskV2(master, plan.planId, { title: 't1', spec: 'first', pinnedAssignee: 'worker' })
    await ctx.coop.addTaskV2(master, plan.planId, { title: 't2', spec: 'second', pinnedAssignee: 'worker' })
    await activate(ctx, master, reviewer, plan.planId)
    const board = await ctx.coop.boardV2(master, plan.planId)
    expect(board[0]?.tasks[0]?.assignee).toBe('worker')
    expect(board[0]?.tasks[1]?.status).toBe('ready')
    expect(board[0]?.tasks[1]?.assignee).toBeUndefined()
  })

  it('re-pins and clears through updateTaskV2, rejecting foreign pins', async () => {
    const { ctx, master, worker, extra, reviewer } = await harness()
    const m = await ctx.coop.registerV2(master, { roles: ['master'] })
    await ctx.coop.registerV2(worker, { roles: ['worker'], masterId: String(m.masterId) })
    await ctx.coop.registerV2(extra, { roles: ['worker'], masterId: String(m.masterId) })
    const plan = await ctx.coop.createPlanV2(master, { title: 'P', objective: 'O' })
    await ctx.coop.addTaskV2(master, plan.planId, { title: 't1', spec: 'do it' })
    await activate(ctx, master, reviewer, plan.planId)
    await expect(
      ctx.coop.updateTaskV2(master, plan.planId, 't1', { pinnedAssignee: 'reviewer' }),
    ).rejects.toMatchObject({ code: 'COOP_NO_WORKER' })
    const pinned = await ctx.coop.updateTaskV2(master, plan.planId, 't1', { pinnedAssignee: 'extra' })
    expect(pinned.pinnedAssignee).toBe('extra')
    const cleared = await ctx.coop.updateTaskV2(master, plan.planId, 't1', { pinnedAssignee: '' })
    expect(cleared.pinnedAssignee).toBeUndefined()
    await expect(
      ctx.coop.addTaskV2(master, plan.planId, { title: 'x', spec: 'y', pinnedAssignee: 'nowhere' }),
    ).rejects.toMatchObject({ code: 'COOP_NO_WORKER' })
  })
})

describe('context-aware scheduling', () => {
  it('prefers the lower-context free worker', async () => {
    const { ctx, cwd, master, worker, extra, reviewer } = await harness()
    const m = await ctx.coop.registerV2(master, { roles: ['master'] })
    await ctx.coop.registerV2(worker, { roles: ['worker'], masterId: String(m.masterId) })
    await ctx.coop.registerV2(extra, { roles: ['worker'], masterId: String(m.masterId) })
    await seedContext(cwd, 'worker', 0.9)
    await seedContext(cwd, 'extra', 0.2)
    const plan = await ctx.coop.createPlanV2(master, { title: 'P', objective: 'O' })
    await ctx.coop.addTaskV2(master, plan.planId, { title: 't1', spec: 'do it' })
    await activate(ctx, master, reviewer, plan.planId)
    const board = await ctx.coop.boardV2(master, plan.planId)
    expect(board[0]?.tasks[0]?.assignee).toBe('extra')
  })

  it('recycles a saturated worker at capacity and hands the task to the fresh replacement', async () => {
    const { ctx, cwd, master, worker, reviewer } = await harness({ maxWorkers: 1, workerContextCeilingPct: 0.5 })
    const m = await ctx.coop.registerV2(master, { roles: ['master'] })
    await ctx.coop.registerV2(worker, { roles: ['worker'], masterId: String(m.masterId) })
    await seedContext(cwd, 'worker', 0.8)
    const plan = await ctx.coop.createPlanV2(master, { title: 'P', objective: 'O' })
    await ctx.coop.addTaskV2(master, plan.planId, { title: 't1', spec: 'do it' })
    await activate(ctx, master, reviewer, plan.planId)
    const board = await ctx.coop.boardV2(master, plan.planId)
    const assignee = board[0]?.tasks[0]?.assignee
    expect(assignee).toMatch(/^coop-worker-/)
    const registry = await readV2Registry(v2RegistryPath(v2Root(cwd, '.dsh/coop')))
    const entries = registry?.entries ?? []
    expect(entries.find(entry => entry.sessionId === 'worker')?.bindState).toBe('unbound')
    const replacements = entries.filter(entry => entry.sessionId.startsWith('coop-worker-'))
    expect(replacements).toHaveLength(1)
    expect(replacements[0]?.bindState).toBe('bound')
    expect(coopNotices(master).some(text => text.includes('context ceiling'))).toBe(true)
    // The follow-up task lands on the fresh replacement — no further recycle
    // churn while it holds no context report at all.
    await ctx.coop.addTaskV2(master, plan.planId, { title: 't2', spec: 'more', dependsOn: ['t1'] })
    const after = await readV2Registry(v2RegistryPath(v2Root(cwd, '.dsh/coop')))
    expect((after?.entries ?? []).filter(entry => entry.sessionId.startsWith('coop-worker-'))).toHaveLength(1)
  })

  it('does not recycle below capacity even when the only worker is saturated', async () => {
    const { ctx, cwd, master, worker, reviewer } = await harness({ maxWorkers: 2, workerContextCeilingPct: 0.5 })
    const m = await ctx.coop.registerV2(master, { roles: ['master'] })
    await ctx.coop.registerV2(worker, { roles: ['worker'], masterId: String(m.masterId) })
    await seedContext(cwd, 'worker', 0.8)
    const plan = await ctx.coop.createPlanV2(master, { title: 'P', objective: 'O' })
    await ctx.coop.addTaskV2(master, plan.planId, { title: 't1', spec: 'do it' })
    await activate(ctx, master, reviewer, plan.planId)
    const board = await ctx.coop.boardV2(master, plan.planId)
    expect(board[0]?.tasks[0]?.assignee).toBe('worker')
    const registry = await readV2Registry(v2RegistryPath(v2Root(cwd, '.dsh/coop')))
    expect(registry?.entries.find(entry => entry.sessionId === 'worker')?.bindState).toBe('bound')
  })
})

describe('context occupancy helpers', () => {
  it('contextPctOf computes, clamps, and stays undefined on partial views', () => {
    expect(contextPctOf({ projectedTokens: 650, contextWindow: 1000 })).toBe(0.65)
    expect(contextPctOf({ pressureTokens: 500, contextWindow: 1000 })).toBe(0.5)
    expect(contextPctOf({ projectedTokens: 1200, contextWindow: 1000 })).toBe(1)
    expect(contextPctOf({ projectedTokens: 5 })).toBeUndefined()
    expect(contextPctOf({ contextWindow: 1000 })).toBeUndefined()
    expect(contextPctOf('junk')).toBeUndefined()
    expect(contextPctOf(undefined)).toBeUndefined()
  })

  it('touchHeartbeatV2 merges context meta without clobbering the rest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-coop-v2-meta-'))
    const path = join(dir, 'registry.json')
    const file: CoopV2RegistryFile = {
      version: 2,
      entries: [{
        sessionId: 'w1',
        roles: ['worker'],
        bindState: 'bound',
        cwd: dir,
        cwdScope: 'cwd',
        updatedAt: 1,
        heartbeatAt: 1,
        meta: { model: 'p/m' },
      }],
    }
    await writeFile(path, JSON.stringify(file))
    await store.touchHeartbeatV2(path, 'w1', 42, { contextPct: 0.4, contextTokens: 40_000, contextWindow: 100_000 })
    const after = JSON.parse(await readFile(path, 'utf8')) as CoopV2RegistryFile
    const entry = after.entries[0]
    expect(entry?.heartbeatAt).toBe(42)
    expect(entry?.meta).toMatchObject({ model: 'p/m', contextPct: 0.4, contextTokens: 40_000, contextWindow: 100_000 })
    const { rm } = await import('node:fs/promises')
    await rm(dir, { recursive: true, force: true })
  })
})

describe('availability-driven rescheduling', () => {
  it('assigns a ready task when a skilled worker registers after activation', async () => {
    const { ctx, master, worker, reviewer } = await harness()
    const m = await ctx.coop.registerV2(master, { roles: ['master'] })
    const plan = await ctx.coop.createPlanV2(master, { title: 'P', objective: 'O' })
    await ctx.coop.addTaskV2(master, plan.planId, { title: 't1', spec: 'go work', skills: ['go'] })
    await activate(ctx, master, reviewer, plan.planId)
    let board = await ctx.coop.boardV2(master, plan.planId)
    expect(board[0]?.tasks[0]?.assignee).toBeUndefined()
    await ctx.coop.registerV2(worker, { roles: ['worker'], masterId: String(m.masterId), skills: ['go'] })
    board = await ctx.coop.boardV2(master, plan.planId)
    expect(board[0]?.tasks[0]?.assignee).toBe('worker')
    expect(coopNotices(worker).some(text => text.includes('task assigned'))).toBe(true)
  })

  it('reschedules when the master clears skill demands via updateTaskV2', async () => {
    const { ctx, master, worker, reviewer } = await harness()
    const m = await ctx.coop.registerV2(master, { roles: ['master'] })
    await ctx.coop.registerV2(worker, { roles: ['worker'], masterId: String(m.masterId) })
    const plan = await ctx.coop.createPlanV2(master, { title: 'P', objective: 'O' })
    await ctx.coop.addTaskV2(master, plan.planId, { title: 't1', spec: 'go work', skills: ['go'] })
    await activate(ctx, master, reviewer, plan.planId)
    let board = await ctx.coop.boardV2(master, plan.planId)
    expect(board[0]?.tasks[0]?.assignee).toBeUndefined()
    await ctx.coop.updateTaskV2(master, plan.planId, 't1', { skills: [] })
    board = await ctx.coop.boardV2(master, plan.planId)
    expect(board[0]?.tasks[0]?.assignee).toBe('worker')
  })

  it('schedules a ready task when the master binds an idle worker', async () => {
    const { ctx, master, worker, reviewer } = await harness()
    await ctx.coop.registerV2(master, { roles: ['master'] })
    await ctx.coop.registerV2(worker, { roles: ['worker'] })
    const plan = await ctx.coop.createPlanV2(master, { title: 'P', objective: 'O' })
    await ctx.coop.addTaskV2(master, plan.planId, { title: 't1', spec: 'do it' })
    await activate(ctx, master, reviewer, plan.planId)
    let board = await ctx.coop.boardV2(master, plan.planId)
    expect(board[0]?.tasks[0]?.assignee).toBeUndefined()
    await ctx.coop.bindNode(master, String(worker.session.id))
    board = await ctx.coop.boardV2(master, plan.planId)
    expect(board[0]?.tasks[0]?.assignee).toBe('worker')
  })

  it('names the working root in the assignment notice', async () => {
    const { ctx, master, worker, reviewer } = await harness()
    const m = await ctx.coop.registerV2(master, { roles: ['master'] })
    await ctx.coop.registerV2(worker, { roles: ['worker'], masterId: String(m.masterId) })
    const plan = await ctx.coop.createPlanV2(master, { title: 'P', objective: 'O' })
    await ctx.coop.addTaskV2(master, plan.planId, { title: 't1', spec: 'do it' })
    await activate(ctx, master, reviewer, plan.planId)
    expect(coopNotices(worker).some(text => text.includes(`in repo ${plan.repoRoot} — create all files under that root`))).toBe(true)
  })
})
