import { mkdir, mkdtemp } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import CoopService from '../src/index.ts'

/**
 * v2 worktree suite over a real git repo and the mounted shell seam:
 * occupancy naming, scheduler allocation, the merge-on-close happy path,
 * conflicted-merge fail-loud behavior, and cleanup.
 */

let cleanup: (() => Promise<void>) | undefined

afterAll(async () => {
  await cleanup?.()
})

interface Harness {
  ctx: Context
  shellCtx: Context
  parent: string
  repo: string
  master: Agent
  worker: Agent
  reviewer: Agent
}

async function shell(shellCtx: Context, workdir: string, command: string): Promise<string> {
  const spec = shellCtx.shell.resolve({ command, workdir, timeoutMs: 20_000 })
  const result = await (await shellCtx.shell.execute(spec)).result()
  if (result.exitCode !== 0) {
    throw new Error(`shell failed (${command}): ${result.stderr.text}${result.stdout.text}`)
  }
  return result.stdout.text
}

async function harness(config: Partial<ConstructorParameters<typeof CoopService>[1]> = {}): Promise<Harness> {
  const parent = await mkdtemp(join(tmpdir(), 'dsh-coop-wt-'))
  const repo = join(parent, 'repo')
  await mkdir(repo)
  const previousCleanup = cleanup
  cleanup = async () => {
    await previousCleanup?.()
    const { rm } = await import('node:fs/promises')
    await rm(parent, { recursive: true, force: true })
  }
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalBashExecutor, { timeoutMs: 20_000, graceMs: 200 })
  const shellCtx = await new Promise<Context>((resolve) => {
    ctx.inject(['shell'], (injected) => { resolve(injected) })
  })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(CoopService, { mode: 'v2', ...config })
  const create = (id: string): Promise<Agent> =>
    ctx.agentLoop.create(SessionId(id), { provider: 'mock', model: 'mock' }, { cwd: parent })
  const master = await create('master')
  const worker = await create('worker')
  const reviewer = await create('reviewer')
  await shell(shellCtx, repo, 'git init')
  await shell(shellCtx, repo, 'git config user.email coop@test')
  await shell(shellCtx, repo, 'git config user.name coop')
  await shell(shellCtx, repo, 'git commit --allow-empty -m base')
  await ctx.coop.initWorkspace(master, parent)
  await ctx.coop.registerV2(master, { roles: ['master'] })
  return { ctx, shellCtx, parent, repo, master, worker, reviewer }
}

/** The `[coop]`-sourced follow-up turns one agent received, as text. */
function coopNotices(agent: Agent): string[] {
  return [...agent.session.snapshotEvents()]
    .filter((event): event is SessionEvent<'user/message'> => event.type === 'user/message' && event.data.source.kind === 'coop')
    .map(event => event.data.content.map(block => block.type === 'text' ? block.text : '').join(''))
}

async function readyPlan(h: Harness): Promise<string> {
  const plan = await h.ctx.coop.createPlanV2(h.master, { title: 'P', objective: 'O', repoRoot: h.repo })
  return plan.planId
}

describe('worktree lifecycle', () => {
  it('creates a uniquely named worktree under wt/<masterId> and records occupancy', async () => {
    const h = await harness()
    const planId = await readyPlan(h)
    const first = await h.ctx.coop.createWorktreeV2(h.master, planId, { purpose: 'alpha work' })
    const second = await h.ctx.coop.createWorktreeV2(h.master, planId, { purpose: 'beta' })
    expect(existsSync(first.dir)).toBe(true)
    expect(existsSync(second.dir)).toBe(true)
    expect(first.dir).not.toBe(second.dir)
    const rows = await h.ctx.coop.listWorktreesV2(h.master, planId)
    expect(rows.filter(row => row.status === 'active')).toHaveLength(2)
  })

  it('rejects worktree creation for another master or a terminal plan', async () => {
    const h = await harness()
    const planId = await readyPlan(h)
    await h.ctx.coop.registerV2(h.worker, { roles: ['worker'] })
    await expect(h.ctx.coop.createWorktreeV2(h.worker, planId, {})).rejects.toMatchObject({ code: 'COOP_NODE_NOT_FOUND' })
  })

  it('scheduler allocates a free worktree to the assigned task and names it in the signal', async () => {
    const h = await harness()
    const planId = await readyPlan(h)
    const entry = await h.ctx.coop.createWorktreeV2(h.master, planId, { purpose: 'impl' })
    const m = String((await h.ctx.coop.statusV2(h.master)).self?.masterId)
    await h.ctx.coop.registerV2(h.worker, { roles: ['worker'], masterId: m })
    await h.ctx.coop.registerV2(h.reviewer, { roles: ['reviewer'], masterId: m })
    await h.ctx.coop.addTaskV2(h.master, planId, { title: 't1', spec: 'do it' })
    await h.ctx.coop.submitReviewV2(h.master, planId)
    await h.ctx.coop.reviewPlanV2(h.reviewer, planId, 'pass')
    const board = await h.ctx.coop.boardV2(h.master, planId)
    expect(board[0]?.tasks[0]?.worktreeId).toBe(entry.dir)
    expect(coopNotices(h.worker).some(text => text.includes('in worktree') && text.includes(entry.dir))).toBe(true)
  })

  it('merges on plan close and marks the row merged', async () => {
    const h = await harness()
    const planId = await readyPlan(h)
    const entry = await h.ctx.coop.createWorktreeV2(h.master, planId, { purpose: 'impl' })
    const m = String((await h.ctx.coop.statusV2(h.master)).self?.masterId)
    await h.ctx.coop.registerV2(h.worker, { roles: ['worker'], masterId: m })
    await h.ctx.coop.registerV2(h.reviewer, { roles: ['reviewer'], masterId: m })
    await h.ctx.coop.addTaskV2(h.master, planId, { title: 't1', spec: 'do it' })
    await h.ctx.coop.submitReviewV2(h.master, planId)
    await h.ctx.coop.reviewPlanV2(h.reviewer, planId, 'pass')
    await h.ctx.coop.executeBeginV2(h.worker, planId, 't1')
    await shell(h.shellCtx, entry.dir, 'echo change > file.txt && git add . && git commit -m work')
    await h.ctx.coop.executeReportV2(h.worker, planId, 't1', 'wrote file.txt')
    await h.ctx.coop.verifyTaskV2(h.reviewer, planId, 't1', 'pass', 'lgtm')
    const closed = await h.ctx.coop.closePlanV2(h.master, planId)
    expect(closed.status).toBe('closed')
    const log = await shell(h.shellCtx, h.repo, 'git log --oneline --first-parent -2')
    expect(log).toContain('coop: merge')
    expect((await h.ctx.coop.listWorktreesV2(h.master, planId)).every(row => row.status !== 'active')).toBe(true)
  })

  it('fails loud on a conflicted merge and leaves the repo clean', async () => {
    const h = await harness()
    const planId = await readyPlan(h)
    const entry = await h.ctx.coop.createWorktreeV2(h.master, planId, { purpose: 'impl' })
    await shell(h.shellCtx, entry.dir, 'echo work > shared.txt && git add . && git commit -m work')
    await shell(h.shellCtx, h.repo, 'echo base > shared.txt && git add . && git commit -m base-move')
    await expect(h.ctx.coop.mergeWorktreeV2(h.master, entry.dir)).rejects.toMatchObject({ code: 'COOP_WORKTREE_MERGE_CONFLICT' })
    const status = await shell(h.shellCtx, h.repo, 'git status --porcelain')
    expect(status.trim()).toBe('')
    expect((await h.ctx.coop.listWorktreesV2(h.master, planId)).find(row => row.dir === entry.dir)?.status).toBe('active')
  })

  it('clean removes the directory and marks the row cleaned', async () => {
    const h = await harness()
    const planId = await readyPlan(h)
    const entry = await h.ctx.coop.createWorktreeV2(h.master, planId, { purpose: 'scratch' })
    await h.ctx.coop.cleanWorktreeV2(h.master, entry.dir)
    expect(existsSync(entry.dir)).toBe(false)
    expect((await h.ctx.coop.listWorktreesV2(h.master, planId)).find(row => row.dir === entry.dir)?.status).toBe('cleaned')
  })

  it('hides worktree rows from other masters', async () => {
    const h = await harness()
    const planId = await readyPlan(h)
    await h.ctx.coop.createWorktreeV2(h.master, planId, { purpose: 'impl' })
    const second = await h.ctx.agentLoop.create(SessionId('second'), { provider: 'mock', model: 'mock' }, { cwd: h.parent })
    await h.ctx.coop.registerV2(second, { roles: ['master'] })
    expect(await h.ctx.coop.listWorktreesV2(second)).toHaveLength(0)
    const ownRow = (await h.ctx.coop.listWorktreesV2(h.master))[0]
    if (ownRow === undefined) throw new Error('expected one worktree row')
    await expect(h.ctx.coop.mergeWorktreeV2(second, ownRow.dir)).rejects.toMatchObject({ code: 'COOP_WORKTREE_NOT_FOUND' })
  })
})
