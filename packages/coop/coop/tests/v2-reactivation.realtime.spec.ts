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

/**
 * Real-time companion to the fake-clock 'auto reactivation' suite: one full
 * 15-minute idle period under the default 5-minute stale window (three stale
 * windows), then each node's first use must reactivate it in place with its
 * role and bind intact. Opt-in because it burns wall-clock time:
 * `COOP_REALTIME=1 pnpm exec vitest run <this file>`.
 */
const maybe = process.env.COOP_REALTIME === '1' ? it : it.skip

let cleanup: (() => Promise<void>) | undefined
afterAll(async () => {
  await cleanup?.()
})

describe('auto reactivation (real time)', () => {
  maybe('keeps role and bind across a real 15-minute quiet period', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-coop-realtime-'))
    cleanup = async () => {
      const { rm } = await import('node:fs/promises')
      await rm(root, { recursive: true, force: true })
    }
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(CoopService, { mode: 'v2', mirrorEvents: true })
    const create = (id: string): Promise<Agent> =>
      ctx.agentLoop.create(SessionId(id), { provider: 'mock', model: 'mock' }, { cwd: root })
    const master = await create('master')
    const worker = await create('worker')
    const reviewer = await create('reviewer')
    const observer = await create('observer')

    const m = await ctx.coop.registerV2(master, { roles: ['master'] })
    await ctx.coop.registerV2(worker, { roles: ['worker'], masterId: String(m.masterId) })
    const plan = await ctx.coop.createPlanV2(master, { title: 'P', objective: 'O' })
    await ctx.coop.addTaskV2(master, plan.planId, { title: 't1', spec: 'do it' })
    await ctx.coop.registerV2(reviewer, { roles: ['reviewer'], masterId: String(m.masterId) })
    await ctx.coop.submitReviewV2(master, plan.planId)
    await ctx.coop.reviewPlanV2(reviewer, plan.planId, 'pass')
    console.log('[realtime] setup complete; going quiet for 15 minutes')

    const registry = v2RegistryPath(v2Root(root, '.dsh/coop'))
    const row = async (id: string) => (await readV2Registry(registry))?.entries.find(entry => entry.sessionId === id)

    // 15 real minutes of quiet with the process alive: the poll loop keeps
    // touching every agent's heartbeat, so nothing goes stale — the live-pane
    // contract (roles/bind intact, first use just works). The frozen/stale
    // paths are covered by the fake-clock suites.
    await new Promise(resolve => setTimeout(resolve, 15 * 60_000))
    console.log('[realtime] woke after 15 minutes; asserting live-pane contract')

    expect((await row('master'))?.roles).toEqual(['master'])
    const quietWorker = await row('worker')
    expect(quietWorker?.roles).toEqual(['worker'])
    expect(quietWorker?.bindState).toBe('bound')
    expect(String(quietWorker?.masterId)).toBe(String(m.masterId))
    const ageOf = async (id: string) => Date.now() - ((await row(id))?.heartbeatAt ?? 0)
    expect(await ageOf('master')).toBeLessThan(300_000)
    expect(await ageOf('worker')).toBeLessThan(300_000)
    const observed = await ctx.coop.statusV2(observer)
    expect(observed.stale).not.toContain('master')
    expect(observed.stale).not.toContain('worker')

    console.log('[realtime] first use after quiet: master addTask, worker executeBegin')
    const task = await ctx.coop.addTaskV2(master, plan.planId, { title: 't2', spec: 'more' })
    expect(task.title).toBe('t2')
    const executing = await ctx.coop.executeBeginV2(worker, plan.planId, 't1')
    expect(executing.status).toBe('executing')
    const after = await ctx.coop.statusV2(observer)
    expect(after.stale).not.toContain('master')
    expect(after.stale).not.toContain('worker')
    const finalWorker = await row('worker')
    expect(finalWorker?.bindState).toBe('bound')
    expect(String(finalWorker?.masterId)).toBe(String(m.masterId))
    console.log('[realtime] PASS: roles and binds intact, both nodes reactivated in place')
  }, 17 * 60_000)
})
