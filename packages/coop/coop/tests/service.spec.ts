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
import CoopService from '../src/index.ts'
import { planPath, readPlanFile, registryPath } from '../src/index.ts'

/**
 * Service behavior suite over a real agent spine: registration and the master
 * singleton, the full plan workflow across two live sessions with single-path
 * signal delivery, affinity denials, abort closure, and the lazy watchdog.
 */

let cleanup: (() => Promise<void>) | undefined

afterAll(async () => {
  await cleanup?.()
})

async function harness(config: Partial<ConstructorParameters<typeof CoopService>[1]> = {}): Promise<{
  ctx: Context
  cwd: string
  master: Agent
  worker: Agent
  other: Agent
}> {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-coop-svc-'))
  const previousCleanup = cleanup
  cleanup = async () => {
    await previousCleanup?.()
    await rm(cwd)
  }
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  // Mirrors on: the suite pins the dual-write contract that mixed-version
  // deployments must leave off (see Config.mirrorEvents).
  await ctx.plugin(CoopService, { mirrorEvents: true, ...config })
  const create = (id: string): Agent => ctx.agentLoop.create(SessionId(id), { provider: 'mock', model: 'mock' }, { cwd })
  return { ctx, cwd, master: create('master'), worker: create('worker'), other: create('other') }
}

async function rm(target: string): Promise<void> {
  const { rm: remove } = await import('node:fs/promises')
  await remove(target, { recursive: true, force: true })
}

/** The woken-turn messages the agent received from coop, as text. */
function coopMessages(agent: Agent): string[] {
  return [...agent.session.events]
    .filter((event): event is SessionEvent<'user/message'> => event.type === 'user/message' && event.data.source.kind === 'plugin')
    .map(event => event.data.content.map(block => block.type === 'text' ? block.text : '').join(''))
}


describe('registration', () => {
  it('creates the registry on first role set and mirrors the event', async () => {
    const { ctx, cwd, master } = await harness()
    const roles = await ctx.coop.setRoles(master, { set: ['master'] })
    expect(roles).toEqual(['master'])
    interface StoredRegistry { entries: unknown[] }
    const table = JSON.parse(await readFile(registryPath(join(cwd, '.dsh/coop')), 'utf8')) as StoredRegistry
    expect(table.entries).toHaveLength(1)
    expect(master.session.events.some(event => event.type === 'coop/registry')).toBe(true)
  })

  it('rejects a second live master in the same workspace', async () => {
    const { ctx, master, worker } = await harness()
    await ctx.coop.setRoles(master, { set: ['master'] })
    await ctx.coop.setRoles(worker, { set: ['worker'] })
    await expect(ctx.coop.setRoles(worker, { add: ['master'] }))
      .rejects.toMatchObject({ code: 'COOP_MASTER_ALREADY_EXISTS' })
  })

  it('fails loud when reading roles without a registry', async () => {
    const { ctx, master } = await harness()
    await expect(ctx.coop.getRoles(master)).rejects.toMatchObject({ code: 'COOP_REGISTRY_MISSING' })
  })

  it('writes no mirror events by default (cross-build resume safety)', async () => {
    const { ctx, master } = await harness({ mirrorEvents: false })
    await ctx.coop.setRoles(master, { set: ['master'] })
    expect(master.session.events.some(event => event.type.startsWith('coop/'))).toBe(false)
  })

  it('deregisters through an empty replacement set', async () => {
    const { ctx, master } = await harness()
    await ctx.coop.setRoles(master, { set: ['master'] })
    expect(await ctx.coop.setRoles(master, { set: [] })).toEqual([])
    expect(await ctx.coop.getRoles(master)).toEqual([])
  })
})

describe('plan workflow across two sessions', () => {
  async function flow() {
    const h = await harness()
    const { ctx, master, worker } = h
    await ctx.coop.setRoles(master, { set: ['master'] })
    await ctx.coop.setRoles(worker, { set: ['worker'] })
    const plan = await ctx.coop.createPlan(master, { title: 'Ship it', objective: 'Make the tests green.' })
    return { ...h, plan }
  }

  it('delivers notify to the live worker exactly once and gates on affinity', async () => {
    const h = await flow()
    const { ctx, master, worker, plan } = h
    await ctx.coop.notifyPlan(master, plan.planId, { summary: 'please review' })
    // Same-process delivery drains immediately; a repeat drain adds nothing.
    expect(coopMessages(worker).filter(text => text.includes('[coop]'))).toHaveLength(1)
    expect(await ctx.coop.drainInbox(worker)).toBe(0)

    // A bystander session holding the worker role is not the affine worker.
    await ctx.coop.setRoles(h.other, { set: ['worker'] })
    await expect(ctx.coop.submitPreReview(h.other, plan.planId, 'pass'))
      .rejects.toMatchObject({ code: 'COOP_NOT_ASSIGNED_WORKER' })
    await ctx.coop.submitPreReview(worker, plan.planId, 'pass', 'looks fine')
    expect((await readPlanFile(planPath(join(h.cwd, '.dsh/coop'), plan.planId)))?.status).toBe('ready_to_execute')
    expect(coopMessages(master).some(text => text.includes('pre-review pass'))).toBe(true)
    await ctx.coop.beginExecution(worker, plan.planId)
    const reported = await ctx.coop.reportExecution(worker, plan.planId, 'done the thing')
    expect(reported.status).toBe('pending_verify')
    expect(coopMessages(master).some(text => text.includes('execution reported'))).toBe(true)
  })

  it('walks request_changes → rework → close end to end', async () => {
    const h = await flow()
    const { ctx, master, worker, plan } = h
    await ctx.coop.notifyPlan(master, plan.planId)
    await ctx.coop.submitPreReview(worker, plan.planId, 'pass')
    await ctx.coop.beginExecution(worker, plan.planId)
    await ctx.coop.reportExecution(worker, plan.planId, 'first attempt')
    await expect(ctx.coop.verifyPlan(worker, plan.planId, 'pass'))
      .rejects.toMatchObject({ code: 'COOP_NOT_PLAN_OWNER' })
    const rework = await ctx.coop.verifyPlan(master, plan.planId, 'request_changes', 'more tests')
    expect(rework.status).toBe('needs_rework')
    expect(coopMessages(worker).some(text => text.includes('verify request_changes'))).toBe(true)
    await ctx.coop.beginExecution(worker, plan.planId)
    const done = await ctx.coop.reportExecution(worker, plan.planId, 'second attempt')
    expect(done.status).toBe('pending_verify')
    const closed = await ctx.coop.verifyPlan(master, plan.planId, 'pass')
    expect(closed.status).toBe('closed')
    const stored = await readPlanFile(planPath(join(h.cwd, '.dsh/coop'), plan.planId))
    expect(stored?.history.map(entry => entry.op)).toEqual(expect.arrayContaining(['create', 'notify', 'pre_review', 'execute_begin', 'execute_report', 'verify', 'close']))
    const md = await readFile(plan.docPath, 'utf8')
    for (const anchor of ['# Ship it', '## Objective', '## Pre-review', '## Execution', '## Verify']) {
      expect(md).toContain(anchor)
    }
  })

  it('aborts from executing and closes through the worker ack', async () => {
    const h = await flow()
    const { ctx, master, worker, plan } = h
    await ctx.coop.notifyPlan(master, plan.planId)
    await ctx.coop.submitPreReview(worker, plan.planId, 'pass')
    await ctx.coop.beginExecution(worker, plan.planId)
    const aborting = await ctx.coop.abortPlan(master, plan.planId, 'changed mind')
    expect(aborting.status).toBe('aborting')
    expect(coopMessages(worker).some(text => text.includes('ABORT'))).toBe(true)
    await expect(ctx.coop.abortAck(master, plan.planId))
      .rejects.toMatchObject({ code: 'COOP_NOT_ASSIGNED_WORKER' })
    const aborted = await ctx.coop.abortAck(worker, plan.planId)
    expect(aborted.status).toBe('aborted')
    await expect(ctx.coop.abortPlan(master, plan.planId))
      .rejects.toMatchObject({ code: 'COOP_INVALID_TRANSITION' })
  })

  it('re-notify while pending_pre_review is a no-op keeping the bound worker', async () => {
    const h = await flow()
    const { ctx, master, worker, plan } = h
    await ctx.coop.notifyPlan(master, plan.planId)
    await ctx.coop.setRoles(h.other, { set: ['worker'] })
    const again = await ctx.coop.notifyPlan(master, plan.planId)
    expect(again.assignedWorkerSessionId).toBe(String(worker.session.id))
  })
})

describe('watchdog', () => {
  it('closes a silent aborting plan after the ack timeout and a silent executing plan after the heartbeat timeout', async () => {
    const h = await harness({ abortAckTimeoutMs: 30_000, executingStaleMs: 30_000 })
    const { ctx, cwd, master, worker } = h
    await ctx.coop.setRoles(master, { set: ['master'] })
    await ctx.coop.setRoles(worker, { set: ['worker'] })
    const plan = await ctx.coop.createPlan(master, { title: 'W', objective: 'o' })
    await ctx.coop.notifyPlan(master, plan.planId)
    await ctx.coop.submitPreReview(worker, plan.planId, 'pass')

    // Backdate the filesystem clock instead of waiting out real time.
    const backdate = async (): Promise<void> => {
      const path = planPath(join(cwd, '.dsh/coop'), plan.planId)
      interface StoredPlan { history: { status: string; time: number }[] }
      const raw = JSON.parse(await readFile(path, 'utf8')) as StoredPlan
      const stale = Date.now() - 60_000
      const last = raw.history.at(-1)
      if (last?.status === 'aborting') last.time = stale
      await writeFile(path, JSON.stringify(raw))
    }

    await ctx.coop.beginExecution(worker, plan.planId)
    const execPath = planPath(join(cwd, '.dsh/coop'), plan.planId)
    interface ExecutingPlan { execution: { heartbeatAt: number } }
    const execRaw = JSON.parse(await readFile(execPath, 'utf8')) as ExecutingPlan
    execRaw.execution.heartbeatAt = Date.now() - 60_000
    await writeFile(execPath, JSON.stringify(execRaw))
    const rework = await ctx.coop.getPlan(master, plan.planId)
    expect(rework.status).toBe('needs_rework')

    await ctx.coop.abortPlan(master, plan.planId, 'stop')
    await backdate()
    const timedOut = await ctx.coop.getPlan(master, plan.planId)
    expect(timedOut.status).toBe('aborted')
  })
})
