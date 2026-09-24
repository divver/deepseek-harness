import { mkdtemp } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import CoopService, { memoryPath, readMemory, v2Root } from '../src/index.ts'

/**
 * v2 memory suite over a real agent spine: task/plan records land in the
 * master's jsonl trail with a markdown mirror, recency injection reads them
 * back newest-first, search isolates per master, and appends compact to the
 * retention budget (§7.4, §12.3).
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
  second: Agent
}

async function harness(config: Partial<ConstructorParameters<typeof CoopService>[1]> = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-coop-v2-mem-'))
  const previousCleanup = cleanup
  cleanup = async () => {
    await previousCleanup?.()
    const { rm } = await import('node:fs/promises')
    await rm(root, { recursive: true, force: true })
  }
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(CoopService, { mode: 'v2', ...config })
  const create = (id: string): Promise<Agent> =>
    ctx.agentLoop.create(SessionId(id), { provider: 'mock', model: 'mock' }, { cwd: root })
  return {
    ctx,
    cwd: root,
    master: await create('master'),
    worker: await create('worker'),
    reviewer: await create('reviewer'),
    second: await create('second'),
  }
}

/** Walk a single-task plan through assign → execute → report → verify-pass. */
async function finishTask(h: Harness, title: string, report: string, review: string): Promise<void> {
  const plan = await h.ctx.coop.createPlanV2(h.master, { title, objective: 'O' })
  await h.ctx.coop.addTaskV2(h.master, plan.planId, { title: 't1', spec: 'do' })
  await h.ctx.coop.submitReviewV2(h.master, plan.planId)
  await h.ctx.coop.reviewPlanV2(h.reviewer, plan.planId, 'pass')
  await h.ctx.coop.executeBeginV2(h.worker, plan.planId, 't1')
  await h.ctx.coop.executeReportV2(h.worker, plan.planId, 't1', report)
  await h.ctx.coop.verifyTaskV2(h.reviewer, plan.planId, 't1', 'pass', review)
}

describe('memory trail', () => {
  it('records verified tasks with lessons and mirrors the markdown projection', async () => {
    const h = await harness()
    await h.ctx.coop.registerV2(h.master, { roles: ['master'] })
    const m = String((await h.ctx.coop.statusV2(h.master)).self?.masterId)
    await h.ctx.coop.registerV2(h.worker, { roles: ['worker'], masterId: m })
    await h.ctx.coop.registerV2(h.reviewer, { roles: ['reviewer'], masterId: m })
    await finishTask(h, 'plan-a', 'wrote the parser', 'keep grammar tests close')
    const entries = await readMemory(memoryPath(v2Root(h.cwd, '.dsh/coop'), m))
    expect(entries).toHaveLength(1)
    expect(entries[0]?.kind).toBe('task')
    expect(entries[0]?.summary).toBe('wrote the parser')
    expect(entries[0]?.lessons).toEqual(['keep grammar tests close'])
    expect(existsSync(join(h.cwd, '.dsh', 'coop', 'v2', 'masters', m, 'memory.md'))).toBe(true)
  })

  it('records closed plans and injects recency top-K newest first', async () => {
    const h = await harness()
    await h.ctx.coop.registerV2(h.master, { roles: ['master'] })
    const m = String((await h.ctx.coop.statusV2(h.master)).self?.masterId)
    await h.ctx.coop.registerV2(h.worker, { roles: ['worker'], masterId: m })
    await h.ctx.coop.registerV2(h.reviewer, { roles: ['reviewer'], masterId: m })
    await finishTask(h, 'plan-a', 'first', 'ok')
    const plan = await h.ctx.coop.createPlanV2(h.master, { title: 'plan-b', objective: 'Ship it' })
    await h.ctx.coop.addTaskV2(h.master, plan.planId, { title: 't1', spec: 'do' })
    await h.ctx.coop.submitReviewV2(h.master, plan.planId)
    await h.ctx.coop.reviewPlanV2(h.reviewer, plan.planId, 'pass')
    await h.ctx.coop.executeBeginV2(h.worker, plan.planId, 't1')
    await h.ctx.coop.executeReportV2(h.worker, plan.planId, 't1', 'second')
    await h.ctx.coop.verifyTaskV2(h.reviewer, plan.planId, 't1', 'pass')
    await h.ctx.coop.closePlanV2(h.master, plan.planId)
    const lines = await h.ctx.coop.memoryLinesV2(h.master)
    expect(lines[0]).toContain('[plan]')
    expect(lines[0]).toContain('plan-b')
    expect(lines[1]).toContain('[task]')
    expect(lines[1]).toContain('second')
    expect(lines.length).toBeLessThanOrEqual(8)
  })

  it('searches own master only', async () => {
    const h = await harness()
    await h.ctx.coop.registerV2(h.master, { roles: ['master'] })
    const m = String((await h.ctx.coop.statusV2(h.master)).self?.masterId)
    await h.ctx.coop.registerV2(h.worker, { roles: ['worker'], masterId: m })
    await h.ctx.coop.registerV2(h.reviewer, { roles: ['reviewer'], masterId: m })
    await h.ctx.coop.registerV2(h.second, { roles: ['master'] })
    await finishTask(h, 'parser-hardening', 'hardened the parser', 'fuzz first')
    const own = await h.ctx.coop.searchMemoryV2(h.master, { query: 'parser' })
    expect(own.length).toBeGreaterThan(0)
    const foreign = await h.ctx.coop.searchMemoryV2(h.second, { query: 'parser' })
    expect(foreign).toHaveLength(0)
  })

  it('compacts to the retention budget, dropping the oldest records', async () => {
    const h = await harness({ memoryRetainEntries: 2 })
    await h.ctx.coop.registerV2(h.master, { roles: ['master'] })
    const m = String((await h.ctx.coop.statusV2(h.master)).self?.masterId)
    await h.ctx.coop.registerV2(h.worker, { roles: ['worker'], masterId: m })
    await h.ctx.coop.registerV2(h.reviewer, { roles: ['reviewer'], masterId: m })
    await finishTask(h, 'one', 'first work', 'l1')
    await finishTask(h, 'two', 'second work', 'l2')
    await finishTask(h, 'three', 'third work', 'l3')
    const entries = await readMemory(memoryPath(v2Root(h.cwd, '.dsh/coop'), m))
    expect(entries).toHaveLength(2)
    expect(entries.map(entry => entry.summary)).toEqual(['second work', 'third work'])
  })
})
