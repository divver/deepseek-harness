import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import CoopService, { readV2PlanFile, v2PlanPath, v2Root } from '../src/index.ts'

// The dev shell may sit inside a herdr pane; revival must not see an ambient pane id.
delete process.env.HERDR_PANE_ID

/**
 * v2 quality-gate suite: `severityCounts` on review/verify, per-surface
 * thresholds from `qualityGate` (flat or plan/task split), missing-counts and
 * exceeded rejections, and the persisted verdict evidence.
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
  reviewer: Agent
}

async function harness(config: Partial<ConstructorParameters<typeof CoopService>[1]> = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-coop-v2-gate-'))
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
    reviewer: await create('reviewer'),
  }
}

/** Full team plus one reviewed-and-activated plan carrying one reported task. */
async function harnessWithReportedTask(config: Partial<ConstructorParameters<typeof CoopService>[1]> = {}) {
  const h = await harness(config)
  const m = await h.ctx.coop.registerV2(h.master, { roles: ['master'] })
  await h.ctx.coop.registerV2(h.worker, { roles: ['worker'], masterId: String(m.masterId) })
  await h.ctx.coop.registerV2(h.reviewer, { roles: ['reviewer'], masterId: String(m.masterId) })
  const plan = await h.ctx.coop.createPlanV2(h.master, { title: 'P', objective: 'O' })
  await h.ctx.coop.addTaskV2(h.master, plan.planId, { title: 't1', spec: 'do it' })
  await h.ctx.coop.submitReviewV2(h.master, plan.planId)
  await h.ctx.coop.reviewPlanV2(h.reviewer, plan.planId, 'pass', undefined, { p0: 0, p1: 0, p2: 0 })
  await h.ctx.coop.executeBeginV2(h.worker, plan.planId, 't1')
  await h.ctx.coop.executeReportV2(h.worker, plan.planId, 't1', 'done')
  return { ...h, planId: plan.planId, masterId: String(m.masterId) }
}

describe('quality gate', () => {
  it('rejects a pass without counts on a constrained level, and accepts it with counts', async () => {
    const { ctx, master, worker, reviewer } = await harness()
    const m = await ctx.coop.registerV2(master, { roles: ['master'] })
    await ctx.coop.registerV2(worker, { roles: ['worker'], masterId: String(m.masterId) })
    await ctx.coop.registerV2(reviewer, { roles: ['reviewer'], masterId: String(m.masterId) })
    const plan = await ctx.coop.createPlanV2(master, { title: 'P', objective: 'O' })
    await ctx.coop.addTaskV2(master, plan.planId, { title: 't1', spec: 'do it' })
    await ctx.coop.submitReviewV2(master, plan.planId)
    await expect(ctx.coop.reviewPlanV2(reviewer, plan.planId, 'pass')).rejects.toMatchObject({ code: 'COOP_GATE_COUNTS_REQUIRED' })
    const active = await ctx.coop.reviewPlanV2(reviewer, plan.planId, 'pass', undefined, { p0: 0, p1: 2, p2: 5 })
    expect(active.status).toBe('active')
    expect(active.lastReview?.severityCounts).toEqual({ p0: 0, p1: 2, p2: 5 })
    expect(active.lastReview?.gate).toEqual({ p0: 0 })
  })

  it('rejects an exceeded level and names it', async () => {
    const { ctx, master, worker, reviewer } = await harness()
    const m = await ctx.coop.registerV2(master, { roles: ['master'] })
    await ctx.coop.registerV2(worker, { roles: ['worker'], masterId: String(m.masterId) })
    await ctx.coop.registerV2(reviewer, { roles: ['reviewer'], masterId: String(m.masterId) })
    const plan = await ctx.coop.createPlanV2(master, { title: 'P', objective: 'O' })
    await ctx.coop.submitReviewV2(master, plan.planId)
    await expect(ctx.coop.reviewPlanV2(reviewer, plan.planId, 'pass', undefined, { p0: 1, p1: 0, p2: 0 }))
      .rejects.toMatchObject({ code: 'COOP_GATE_EXCEEDED', message: expect.stringContaining('P0=1>0') })
  })

  it('splits plan and task gates; a flat gate sets both', async () => {
    const { ctx, master, worker, reviewer } = await harness({ qualityGate: { plan: { p2: 1 }, task: { p1: 0 } } })
    const m = await ctx.coop.registerV2(master, { roles: ['master'] })
    await ctx.coop.registerV2(worker, { roles: ['worker'], masterId: String(m.masterId) })
    await ctx.coop.registerV2(reviewer, { roles: ['reviewer'], masterId: String(m.masterId) })
    const plan = await ctx.coop.createPlanV2(master, { title: 'P', objective: 'O' })
    await ctx.coop.addTaskV2(master, plan.planId, { title: 't1', spec: 'do it' })
    await ctx.coop.submitReviewV2(master, plan.planId)
    await expect(ctx.coop.reviewPlanV2(reviewer, plan.planId, 'pass', undefined, { p0: 0, p1: 0, p2: 2 }))
      .rejects.toMatchObject({ code: 'COOP_GATE_EXCEEDED' })
    await ctx.coop.reviewPlanV2(reviewer, plan.planId, 'pass', undefined, { p0: 0, p1: 0, p2: 1 })
    await ctx.coop.executeBeginV2(worker, plan.planId, 't1')
    await ctx.coop.executeReportV2(worker, plan.planId, 't1', 'done')
    await expect(ctx.coop.verifyTaskV2(reviewer, plan.planId, 't1', 'pass', undefined, { p0: 0, p1: 1, p2: 0 }))
      .rejects.toMatchObject({ code: 'COOP_GATE_EXCEEDED', message: expect.stringContaining('P1=1>0') })
    // request_changes is never gated, and its counts persist as evidence.
    const rework = await ctx.coop.verifyTaskV2(reviewer, plan.planId, 't1', 'request_changes', 'fix p1', { p0: 0, p1: 1, p2: 0 })
    expect(rework.status).toBe('rework')
    const done = await (async () => {
      await ctx.coop.executeBeginV2(worker, plan.planId, 't1')
      await ctx.coop.executeReportV2(worker, plan.planId, 't1', 'fixed')
      return ctx.coop.verifyTaskV2(reviewer, plan.planId, 't1', 'pass', 'lgtm', { p0: 0, p1: 0, p2: 0 })
    })()
    expect(done.status).toBe('done')
    expect(done.verify?.severityCounts).toEqual({ p0: 0, p1: 0, p2: 0 })
    expect(done.verify?.gate).toEqual({ p1: 0 })
  })

  it('persists the task verdict evidence into the plan file', async () => {
    const { ctx, cwd, masterId, planId, reviewer } = await harnessWithReportedTask()
    await ctx.coop.verifyTaskV2(reviewer, planId, 't1', 'pass', 'lgtm', { p0: 0, p1: 0, p2: 0 })
    const file = await readV2PlanFile(v2PlanPath(v2Root(cwd, '.dsh/coop'), masterId, planId))
    const task = file?.tasks.find(candidate => candidate.taskId === 't1')
    expect(task?.status).toBe('done')
    expect(task?.verify?.severityCounts).toEqual({ p0: 0, p1: 0, p2: 0 })
    expect(task?.verify?.gate).toEqual({ p0: 0 })
  })

  it('rejects invalid gate config loud', async () => {
    await expect(harness({ qualityGate: { p9: 1 } as never })).rejects.toThrow()
    await expect(harness({ qualityGate: { p0: -1 } })).rejects.toThrow()
  })

  it('counts must be non-negative integers', async () => {
    const { ctx, master, worker, reviewer } = await harness()
    const m = await ctx.coop.registerV2(master, { roles: ['master'] })
    await ctx.coop.registerV2(worker, { roles: ['worker'], masterId: String(m.masterId) })
    await ctx.coop.registerV2(reviewer, { roles: ['reviewer'], masterId: String(m.masterId) })
    const plan = await ctx.coop.createPlanV2(master, { title: 'P', objective: 'O' })
    await ctx.coop.submitReviewV2(master, plan.planId)
    await expect(ctx.coop.reviewPlanV2(reviewer, plan.planId, 'pass', undefined, { p0: 1.5, p1: 0, p2: 0 }))
      .rejects.toMatchObject({ code: 'COOP_CONFIG_UNSUPPORTED' })
  })
})
