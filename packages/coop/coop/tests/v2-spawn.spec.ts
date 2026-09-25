import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { SessionId } from '@deepseek-ai/dsh-session'
import CoopService from '../src/index.ts'

/**
 * v2 node-spawn suite (§8.2): the headless fallback creates and pre-binds an
 * in-process session, explicit herdr spawn fails loud outside a herdr pane,
 * auto falls back, and herdr-hosted sessions self-report pane metadata for
 * the state-mirroring loop (§8.3). The live herdr path needs a running herdr
 * server and a real pane, so it is exercised manually, not here.
 */

let cleanup: (() => Promise<void>) | undefined

afterAll(async () => {
  await cleanup?.()
})

async function harness(config: Partial<ConstructorParameters<typeof CoopService>[1]> = {}): Promise<{ ctx: Context; cwd: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-coop-v2-spawn-'))
  const previousCleanup = cleanup
  cleanup = async () => {
    await previousCleanup?.()
    const { rm } = await import('node:fs/promises')
    await rm(root, { recursive: true, force: true })
  }
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalBashExecutor, { timeoutMs: 20_000, graceMs: 200 })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(CoopService, { mode: 'v2', ...config })
  // Anchor the workspace so nodes spawned into subdirectories (workdirs,
  // worktrees) still resolve the same registry as the master (§3.1).
  const { mkdir, writeFile } = await import('node:fs/promises')
  await mkdir(join(root, '.dsh', 'coop'), { recursive: true })
  await writeFile(
    join(root, '.dsh', 'coop', 'workspace.json'),
    JSON.stringify({ version: 2, root, createdAt: 1 }),
  )
  return { ctx, cwd: root }
}

describe('node spawn', () => {
  it('headless spawn creates and pre-binds a worker session', async () => {
    const { ctx, cwd } = await harness({ spawn: 'headless' })
    const master = await ctx.agentLoop.create(SessionId('master'), { provider: 'mock', model: 'mock' }, { cwd })
    await ctx.coop.registerV2(master, { roles: ['master'] })
    const outcome = await ctx.coop.createNodeV2(master, { role: 'worker', model: 'glm-5.3-flash' })
    expect(outcome.spawned).toBe('headless')
    expect(outcome.entry?.bindState).toBe('bound')
    expect(outcome.entry?.meta?.model).toBe('glm-5.3-flash')
    const nodes = await ctx.coop.listNodesV2(master)
    expect(nodes.some(node => node.sessionId === outcome.entry?.sessionId && node.roles.includes('worker'))).toBe(true)
  })

  it('explicit herdr spawn outside a herdr pane fails loud', async () => {
    const { ctx, cwd } = await harness({ spawn: 'herdr' })
    const master = await ctx.agentLoop.create(SessionId('master'), { provider: 'mock', model: 'mock' }, { cwd })
    await ctx.coop.registerV2(master, { roles: ['master'] })
    const hadPane = process.env.HERDR_PANE_ID
    delete process.env.HERDR_PANE_ID
    try {
      await expect(ctx.coop.createNodeV2(master, { role: 'worker' })).rejects.toMatchObject({ code: 'COOP_SPAWN_FAILED' })
    } finally {
      if (hadPane !== undefined) process.env.HERDR_PANE_ID = hadPane
    }
  })

  it('auto falls back to headless when not running inside herdr', async () => {
    const { ctx, cwd } = await harness()
    const master = await ctx.agentLoop.create(SessionId('master'), { provider: 'mock', model: 'mock' }, { cwd })
    await ctx.coop.registerV2(master, { roles: ['master'] })
    const hadPane = process.env.HERDR_PANE_ID
    delete process.env.HERDR_PANE_ID
    try {
      const outcome = await ctx.coop.createNodeV2(master, { role: 'reviewer' })
      expect(outcome.spawned).toBe('headless')
    } finally {
      if (hadPane !== undefined) process.env.HERDR_PANE_ID = hadPane
    }
  })

  it('herdr-hosted sessions self-report pane metadata at registration', async () => {
    const { ctx, cwd } = await harness()
    const worker = await ctx.agentLoop.create(SessionId('wtwo'), { provider: 'mock', model: 'mock' }, { cwd })
    const hadPane = process.env.HERDR_PANE_ID
    process.env.HERDR_PANE_ID = 't9:p7'
    try {
      const entry = await ctx.coop.registerV2(worker, { roles: ['worker'] })
      expect(entry.meta?.paneId).toBe('t9:p7')
      expect(entry.meta?.spawn).toBe('herdr')
    } finally {
      if (hadPane === undefined) delete process.env.HERDR_PANE_ID
      else process.env.HERDR_PANE_ID = hadPane
    }
  })

  it('spawnRegisterTimeoutMs defaults to 30s and rejects non-positive values', async () => {
    const { resolveCoopConfig } = await import('../src/runtime.ts')
    expect(resolveCoopConfig({}).spawnRegisterTimeoutMs).toBe(30_000)
    expect(() => resolveCoopConfig({ spawnRegisterTimeoutMs: 0 })).toThrowError(/spawnRegisterTimeoutMs/)
  })

  it('spawnLayout defaults to columns and validates the enum', async () => {
    const { resolveCoopConfig } = await import('../src/runtime.ts')
    expect(resolveCoopConfig({}).spawnLayout).toBe('columns')
    expect(resolveCoopConfig({ spawnLayout: 'right' }).spawnLayout).toBe('right')
    expect(() => resolveCoopConfig({ spawnLayout: 'grid' as never })).toThrowError(/spawnLayout/)
  })

  it('planColumnSplit arranges clean full-height role columns', async () => {
    const { planColumnSplit } = await import('../src/runtime.ts')
    const box = (paneId: string, x: number, y: number, height: number) =>
      ({ paneId, x, y, width: 40, height })
    const master = 'm'
    // a role's first pane opens its own full-height column beside the master,
    // regardless of whether the other role already has panes
    expect(planColumnSplit(master, [])).toEqual({ targetPane: 'm', direction: 'right' })
    expect(planColumnSplit(master, [])).toEqual({ targetPane: 'm', direction: 'right' })
    // later same-role spawns extend the BOTTOM of their column
    const workers = [box('w1', 80, 0, 20), box('w2', 80, 20, 20)]
    expect(planColumnSplit(master, workers)).toEqual({ targetPane: 'w2', direction: 'down' })
    const reviewers = [box('r1', 120, 0, 20), box('r2', 120, 20, 20)]
    expect(planColumnSplit(master, reviewers)).toEqual({ targetPane: 'r2', direction: 'down' })
  })

  it('a spawned node placed in a workdir registers with that cwd', async () => {
    const { ctx, cwd } = await harness({ spawn: 'headless' })
    const master = await ctx.agentLoop.create(SessionId('master'), { provider: 'mock', model: 'mock' }, { cwd })
    await ctx.coop.registerV2(master, { roles: ['master'] })
    const dir = join(cwd, 'pkg-a')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(dir, { recursive: true })
    const outcome = await ctx.coop.createNodeV2(master, { role: 'worker', workdir: dir })
    expect(outcome.entry?.cwd).toBe(dir)
  })

  it('a spawned node targeted at a worktree by branch lives inside that worktree', async () => {
    const { ctx, cwd } = await harness({ spawn: 'headless' })
    const master = await ctx.agentLoop.create(SessionId('master'), { provider: 'mock', model: 'mock' }, { cwd })
    const masterEntry = await ctx.coop.registerV2(master, { roles: ['master'] })
    const wtDir = join(cwd, 'wt', '1-auth')
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(wtDir, { recursive: true })
    await writeFile(
      join(cwd, '.dsh', 'coop', 'v2', 'wt-registry.json'),
      JSON.stringify({
        version: 1,
        entries: [{
          dir: wtDir,
          masterId: String(masterEntry.masterId),
          planId: 'p1',
          repoRoot: cwd,
          branch: 'coop/wt-1-auth',
          baseBranch: 'main',
          createdAt: 1,
          status: 'active',
        }],
      }),
    )
    const outcome = await ctx.coop.createNodeV2(master, { role: 'worker', worktree: 'coop/wt-1-auth' })
    expect(outcome.entry?.cwd).toBe(wtDir)
    expect(outcome.entry?.bindState).toBe('bound')
    await expect(ctx.coop.createNodeV2(master, { role: 'worker', worktree: 'coop/ghost' }))
      .rejects.toMatchObject({ code: 'COOP_NODE_NOT_FOUND' })
  })
})
