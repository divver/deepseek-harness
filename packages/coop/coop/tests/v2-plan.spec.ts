import { mkdtemp } from 'node:fs/promises'
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
import CoopService from '../src/index.ts'

/**
 * v2 plan-DAG suite over a real agent spine: plan lifecycle, task add/link
 * with cycle rejection, ready computation, scheduler assignment with skill
 * and parallelism gating, the worker execute→report→reviewer-verify loop,
 * rework, and isolation across masters.
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

async function harness(config: Partial<ConstructorParameters<typeof CoopService>[1]> = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-coop-v2-plan-'))
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

describe('plan lifecycle', () => {
  it('creates a designing plan bound to the cwd repo root with a markdown trail', async () => {
    const { ctx, cwd, master } = await harness()
    const m = await ctx.coop.registerV2(master, { roles: ['master'] })
    const plan = await ctx.coop.createPlanV2(master, { title: 'Ship', objective: 'Ship the release.' })
    expect(plan.status).toBe('designing')
    expect(plan.repoRoot).toBe(cwd)
    expect(existsSync(join(cwd, '.dsh', 'coop', 'v2', 'masters', String(m.masterId), 'docs', `${plan.planId}.md`))).toBe(true)
  })

  it('requires the master role', async () => {
    const { ctx, worker } = await harness()
    await ctx.coop.registerV2(worker, { roles: ['worker'] })
    await expect(ctx.coop.createPlanV2(worker, { title: 'x', objective: 'y' })).rejects.toMatchObject({ code: 'COOP_NODE_NOT_FOUND' })
  })

  it('closes only when every task is done or cancelled', async () => {
    const { ctx, master } = await harness()
    await ctx.coop.registerV2(master, { roles: ['master'] })
    const plan = await ctx.coop.createPlanV2(master, { title: 'P', objective: 'O' })
    await ctx.coop.addTaskV2(master, plan.planId, { title: 't1', spec: 'do it' })
    await ctx.coop.activatePlanV2(master, plan.planId)
    await expect(ctx.coop.closePlanV2(master, plan.planId)).rejects.toMatchObject({ code: 'COOP_INVALID_TRANSITION' })
    const board = await ctx.coop.boardV2(master, plan.planId)
    const t1 = board[0]?.tasks[0]
    expect(t1?.status).toBe('ready')
    await ctx.coop.cancelTaskV2(master, plan.planId, 't1')
    const closed = await ctx.coop.closePlanV2(master, plan.planId)
    expect(closed.status).toBe('closed')
  })

  it('hides plans from other masters', async () => {
    const { ctx, master, second } = await harness()
    await ctx.coop.registerV2(master, { roles: ['master'] })
    await ctx.coop.registerV2(second, { roles: ['master'] })
    const plan = await ctx.coop.createPlanV2(master, { title: 'P', objective: 'O' })
    await expect(ctx.coop.boardV2(second, plan.planId)).rejects.toMatchObject({ code: 'COOP_PLAN_NOT_FOUND' })
    await expect(ctx.coop.addTaskV2(second, plan.planId, { title: 'x', spec: 'y' })).rejects.toMatchObject({ code: 'COOP_PLAN_NOT_FOUND' })
  })
})

describe('dag', () => {
  it('computes readiness from dependencies and unblocks downstream on done', async () => {
    const { ctx, master, worker, reviewer } = await harness()
    await ctx.coop.registerV2(master, { roles: ['master'] })
    const m = String((await ctx.coop.statusV2(master)).self?.masterId)
    await ctx.coop.registerV2(worker, { roles: ['worker'], masterId: m })
    await ctx.coop.registerV2(reviewer, { roles: ['reviewer'], masterId: m })
    const plan = await ctx.coop.createPlanV2(master, { title: 'P', objective: 'O' })
    await ctx.coop.addTaskV2(master, plan.planId, { title: 'first', spec: 'A' })
    await ctx.coop.addTaskV2(master, plan.planId, { title: 'second', spec: 'B', dependsOn: ['t1'] })
    await ctx.coop.activatePlanV2(master, plan.planId)
    let board = await ctx.coop.boardV2(master, plan.planId)
    expect(board[0]?.tasks.find(task => task.taskId === 't1')?.status).toBe('assigned')
    expect(board[0]?.tasks.find(task => task.taskId === 't2')?.status).toBe('pending')
    await ctx.coop.executeBeginV2(worker, plan.planId, 't1')
    await ctx.coop.executeReportV2(worker, plan.planId, 't1', 'done A')
    await ctx.coop.verifyTaskV2(reviewer, plan.planId, 't1', 'pass', 'lgtm')
    board = await ctx.coop.boardV2(master, plan.planId)
    expect(board[0]?.tasks.find(task => task.taskId === 't1')?.status).toBe('done')
    expect(board[0]?.tasks.find(task => task.taskId === 't2')?.status).toBe('assigned')
  })

  it('rejects cycles at add and link time', async () => {
    const { ctx, master } = await harness()
    await ctx.coop.registerV2(master, { roles: ['master'] })
    const plan = await ctx.coop.createPlanV2(master, { title: 'P', objective: 'O' })
    await ctx.coop.addTaskV2(master, plan.planId, { title: 'a', spec: 'A' })
    await ctx.coop.addTaskV2(master, plan.planId, { title: 'b', spec: 'B' })
    await ctx.coop.linkTaskV2(master, plan.planId, { from: 't1', to: 't2' })
    await expect(ctx.coop.linkTaskV2(master, plan.planId, { from: 't2', to: 't1' })).rejects.toMatchObject({ code: 'COOP_DAG_CYCLE_REJECTED' })
    await expect(ctx.coop.addTaskV2(master, plan.planId, { title: 'c', spec: 'C', dependsOn: ['t3'] }))
      .rejects.toMatchObject({ code: 'COOP_TASK_NOT_FOUND' })
  })

  it('blocks downstream when an upstream task is cancelled', async () => {
    const { ctx, master } = await harness()
    await ctx.coop.registerV2(master, { roles: ['master'] })
    const plan = await ctx.coop.createPlanV2(master, { title: 'P', objective: 'O' })
    await ctx.coop.addTaskV2(master, plan.planId, { title: 'a', spec: 'A' })
    await ctx.coop.addTaskV2(master, plan.planId, { title: 'b', spec: 'B', dependsOn: ['t1'] })
    await ctx.coop.cancelTaskV2(master, plan.planId, 't1')
    const board = await ctx.coop.boardV2(master, plan.planId)
    expect(board[0]?.tasks.find(task => task.taskId === 't2')?.status).toBe('blocked')
  })
})

describe('scheduler', () => {
  it('assigns ready tasks to idle bound workers and wakes them in-process', async () => {
    const { ctx, master, worker } = await harness()
    await ctx.coop.registerV2(master, { roles: ['master'] })
    const status = await ctx.coop.statusV2(master)
    const m = String(status.self?.masterId)
    await ctx.coop.registerV2(worker, { roles: ['worker'], masterId: m })
    const plan = await ctx.coop.createPlanV2(master, { title: 'P', objective: 'O' })
    await ctx.coop.addTaskV2(master, plan.planId, { title: 't', spec: 'do' })
    await ctx.coop.activatePlanV2(master, plan.planId)
    const board = await ctx.coop.boardV2(master, plan.planId)
    expect(board[0]?.tasks[0]?.status).toBe('assigned')
    expect(board[0]?.tasks[0]?.assignee).toBe('worker')
    expect(coopNotices(worker).some(text => text.includes('task assigned') && text.includes('coop_execute_begin'))).toBe(true)
  })

  it('respects skill demands and maxParallelTasks', async () => {
    const { ctx, master, worker, extra } = await harness({ maxParallelTasks: 1 })
    await ctx.coop.registerV2(master, { roles: ['master'] })
    const m = String((await ctx.coop.statusV2(master)).self?.masterId)
    await ctx.coop.registerV2(worker, { roles: ['worker'], masterId: m, skills: ['rust'] })
    await ctx.coop.registerV2(extra, { roles: ['worker'], masterId: m })
    const plan = await ctx.coop.createPlanV2(master, { title: 'P', objective: 'O' })
    await ctx.coop.addTaskV2(master, plan.planId, { title: 'needs-rust', spec: 'A', skills: ['rust'] })
    await ctx.coop.addTaskV2(master, plan.planId, { title: 'any', spec: 'B' })
    await ctx.coop.activatePlanV2(master, plan.planId)
    const board = await ctx.coop.boardV2(master, plan.planId)
    expect(board[0]?.tasks.find(task => task.taskId === 't1')?.status).toBe('assigned')
    expect(board[0]?.tasks.find(task => task.taskId === 't1')?.assignee).toBe('worker')
    expect(board[0]?.tasks.find(task => task.taskId === 't2')?.status).toBe('ready')
  })

  it('keeps rework with its original worker', async () => {
    const { ctx, master, worker, reviewer } = await harness()
    await ctx.coop.registerV2(master, { roles: ['master'] })
    const m = String((await ctx.coop.statusV2(master)).self?.masterId)
    await ctx.coop.registerV2(worker, { roles: ['worker'], masterId: m })
    await ctx.coop.registerV2(reviewer, { roles: ['reviewer'], masterId: m })
    const plan = await ctx.coop.createPlanV2(master, { title: 'P', objective: 'O' })
    await ctx.coop.addTaskV2(master, plan.planId, { title: 't', spec: 'do' })
    await ctx.coop.activatePlanV2(master, plan.planId)
    await ctx.coop.executeBeginV2(worker, plan.planId, 't1')
    await ctx.coop.executeReportV2(worker, plan.planId, 't1', 'first try')
    const reworked = await ctx.coop.verifyTaskV2(reviewer, plan.planId, 't1', 'request_changes', 'tighter')
    expect(reworked.status).toBe('rework')
    expect(reworked.attempts).toBe(1)
    expect(reworked.assignee).toBe('worker')
    const again = await ctx.coop.executeBeginV2(worker, plan.planId, 't1')
    expect(again.status).toBe('executing')
    expect(coopNotices(worker).some(text => text.includes('rework requested'))).toBe(true)
  })
})

describe('verification gate', () => {
  it('rejects the master by default and allows it with allowSelfReview', async () => {
    const { ctx, master, worker } = await harness()
    await ctx.coop.registerV2(master, { roles: ['master'] })
    const m = String((await ctx.coop.statusV2(master)).self?.masterId)
    await ctx.coop.registerV2(worker, { roles: ['worker'], masterId: m })
    const plan = await ctx.coop.createPlanV2(master, { title: 'P', objective: 'O' })
    await ctx.coop.addTaskV2(master, plan.planId, { title: 't', spec: 'do' })
    await ctx.coop.activatePlanV2(master, plan.planId)
    await ctx.coop.executeBeginV2(worker, plan.planId, 't1')
    await ctx.coop.executeReportV2(worker, plan.planId, 't1', 'done')
    await expect(ctx.coop.verifyTaskV2(master, plan.planId, 't1', 'pass')).rejects.toMatchObject({ code: 'COOP_NOT_ASSIGNED_WORKER' })

    const { ctx: ctx2, master: m2, worker: w2 } = await harness({ allowSelfReview: true })
    await ctx2.coop.registerV2(m2, { roles: ['master'] })
    const m2id = String((await ctx2.coop.statusV2(m2)).self?.masterId)
    await ctx2.coop.registerV2(w2, { roles: ['worker'], masterId: m2id })
    const plan2 = await ctx2.coop.createPlanV2(m2, { title: 'P', objective: 'O' })
    await ctx2.coop.addTaskV2(m2, plan2.planId, { title: 't', spec: 'do' })
    await ctx2.coop.activatePlanV2(m2, plan2.planId)
    await ctx2.coop.executeBeginV2(w2, plan2.planId, 't1')
    await ctx2.coop.executeReportV2(w2, plan2.planId, 't1', 'done')
    const verified = await ctx2.coop.verifyTaskV2(m2, plan2.planId, 't1', 'pass', 'self ok')
    expect(verified.status).toBe('done')
  })

  it('rejects a reviewer bound to another master', async () => {
    const { ctx, master, second, worker, reviewer } = await harness()
    await ctx.coop.registerV2(master, { roles: ['master'] })
    await ctx.coop.registerV2(second, { roles: ['master'] })
    const m = String((await ctx.coop.statusV2(master)).self?.masterId)
    await ctx.coop.registerV2(worker, { roles: ['worker'], masterId: m })
    await ctx.coop.registerV2(reviewer, { roles: ['reviewer'], masterId: String((await ctx.coop.statusV2(second)).self?.masterId) })
    const plan = await ctx.coop.createPlanV2(master, { title: 'P', objective: 'O' })
    await ctx.coop.addTaskV2(master, plan.planId, { title: 't', spec: 'do' })
    await ctx.coop.activatePlanV2(master, plan.planId)
    await ctx.coop.executeBeginV2(worker, plan.planId, 't1')
    await ctx.coop.executeReportV2(worker, plan.planId, 't1', 'done')
    // Isolation by visibility: the cross-master reviewer cannot even resolve the plan.
    await expect(ctx.coop.verifyTaskV2(reviewer, plan.planId, 't1', 'pass')).rejects.toMatchObject({ code: 'COOP_PLAN_NOT_FOUND' })
  })

  it('abort cancels open tasks and signals in-flight assignees', async () => {
    const { ctx, master, worker } = await harness()
    await ctx.coop.registerV2(master, { roles: ['master'] })
    const m = String((await ctx.coop.statusV2(master)).self?.masterId)
    await ctx.coop.registerV2(worker, { roles: ['worker'], masterId: m })
    const plan = await ctx.coop.createPlanV2(master, { title: 'P', objective: 'O' })
    await ctx.coop.addTaskV2(master, plan.planId, { title: 't', spec: 'do' })
    await ctx.coop.activatePlanV2(master, plan.planId)
    await ctx.coop.executeBeginV2(worker, plan.planId, 't1')
    const aborted = await ctx.coop.abortPlanV2(master, plan.planId)
    expect(aborted.status).toBe('aborted')
    expect(aborted.tasks[0]?.status).toBe('cancelled')
    expect(coopNotices(worker).some(text => text.includes('plan aborted'))).toBe(true)
  })

  it('only the assignee may begin or report a task', async () => {
    const { ctx, master, worker, extra } = await harness()
    await ctx.coop.registerV2(master, { roles: ['master'] })
    const m = String((await ctx.coop.statusV2(master)).self?.masterId)
    await ctx.coop.registerV2(worker, { roles: ['worker'], masterId: m })
    await ctx.coop.registerV2(extra, { roles: ['worker'], masterId: m })
    const plan = await ctx.coop.createPlanV2(master, { title: 'P', objective: 'O' })
    await ctx.coop.addTaskV2(master, plan.planId, { title: 't', spec: 'do' })
    await ctx.coop.activatePlanV2(master, plan.planId)
    const board = await ctx.coop.boardV2(master, plan.planId)
    const assignee = board[0]?.tasks[0]?.assignee
    const outsider = assignee === 'worker' ? extra : worker
    await expect(ctx.coop.executeBeginV2(outsider, plan.planId, 't1')).rejects.toMatchObject({ code: 'COOP_NOT_ASSIGNED_WORKER' })
  })
})
