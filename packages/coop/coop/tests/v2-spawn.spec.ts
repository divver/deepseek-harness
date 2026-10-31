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

// The dev shell may sit inside a herdr pane; revival must not see an ambient pane id (panes come from config `paneId`).
delete process.env.HERDR_PANE_ID

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
    const { ctx, cwd } = await harness({ paneId: 't9:p7' })
    const worker = await ctx.agentLoop.create(SessionId('wtwo'), { provider: 'mock', model: 'mock' }, { cwd })
    const entry = await ctx.coop.registerV2(worker, { roles: ['worker'] })
    expect(entry.meta?.paneId).toBe('t9:p7')
    expect(entry.meta?.spawn).toBe('herdr')
  })

  it('spawnRegisterTimeoutMs defaults to 30s and rejects non-positive values', async () => {
    const { resolveCoopConfig } = await import('../src/runtime.ts')
    expect(resolveCoopConfig({}).spawnRegisterTimeoutMs).toBe(30_000)
    expect(() => resolveCoopConfig({ spawnRegisterTimeoutMs: 0 })).toThrow(/spawnRegisterTimeoutMs/)
  })

  it('spawnLayout defaults to columns and validates the enum', async () => {
    const { resolveCoopConfig } = await import('../src/runtime.ts')
    expect(resolveCoopConfig({}).spawnLayout).toBe('columns')
    expect(resolveCoopConfig({ spawnLayout: 'right' }).spawnLayout).toBe('right')
    expect(() => resolveCoopConfig({ spawnLayout: 'grid' })).toThrow(/spawnLayout/)
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

describe('spawn route env', () => {
  it('seeds nothing without a route', async () => {
    const { spawnRouteEnv } = await import('../src/runtime.ts')
    expect(spawnRouteEnv(undefined, undefined, undefined)).toEqual([])
  })

  it('uses the role route verbatim when no per-node model is set', async () => {
    const { spawnRouteEnv } = await import('../src/runtime.ts')
    const route = { provider: 'zai-coding-cn', model: 'glm-5.3-flash', reasoningEffort: 'high' } as NonNullable<Parameters<typeof spawnRouteEnv>[1]>
    expect(spawnRouteEnv(undefined, route, 'other')).toEqual([
      '--env', 'DSH_COOP_PROVIDER=zai-coding-cn',
      '--env', 'DSH_COOP_MODEL=glm-5.3-flash',
      '--env', 'DSH_COOP_EFFORT=high',
    ])
  })

  it('lets an explicit provider/model pair override the role route', async () => {
    const { spawnRouteEnv } = await import('../src/runtime.ts')
    const route = { provider: 'zai-coding-cn', model: 'glm-5.3-flash' } as NonNullable<Parameters<typeof spawnRouteEnv>[1]>
    expect(spawnRouteEnv('deepseek/deepseek-chat', route, 'other')).toEqual([
      '--env', 'DSH_COOP_PROVIDER=deepseek',
      '--env', 'DSH_COOP_MODEL=deepseek-chat',
    ])
  })

  it('keeps the role provider for a bare model and falls back to the master provider', async () => {
    const { spawnRouteEnv } = await import('../src/runtime.ts')
    expect(spawnRouteEnv('glm-5.3', { provider: 'zai-coding-cn', model: 'glm-5.3-flash' }, 'other')).toEqual([
      '--env', 'DSH_COOP_PROVIDER=zai-coding-cn',
      '--env', 'DSH_COOP_MODEL=glm-5.3',
    ])
    expect(spawnRouteEnv('glm-5.3', undefined, 'master-prov')).toEqual([
      '--env', 'DSH_COOP_PROVIDER=master-prov',
      '--env', 'DSH_COOP_MODEL=glm-5.3',
    ])
  })
})

describe('pane-keyed master revival', () => {
  async function paneHarness(cwd: string, paneId: string, staleMs = 300_000): Promise<Context> {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(CoopService, { mode: 'v2', mirrorEvents: true, inboxPollMs: 3_600_000, staleMs, paneId })
    return ctx
  }

  async function tmpRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'dsh-coop-v2-pane-'))
    const previousCleanup = cleanup
    cleanup = async () => {
      await previousCleanup?.()
      const { rm } = await import('node:fs/promises')
      await rm(root, { recursive: true, force: true })
    }
    return root
  }

  it('reuses the same-pane identity once its heartbeat went silent past half the stale window', async () => {
    const root = await tmpRoot()
    const ctx = await paneHarness(root, 't1:pR', 400)
    const first = await ctx.agentLoop.create(SessionId('pm1'), { provider: 'mock', model: 'mock' }, { cwd: root })
    await ctx.coop.registerV2(first, { roles: ['master'] })
    const id1 = String((await ctx.coop.statusV2(first)).self?.masterId)
    // The pane dies; with the poll silent the heartbeat ages past staleMs / 2
    // while the row is still formally fresh — the pane match must revive it.
    await new Promise(resolve => setTimeout(resolve, 250))
    const second = await ctx.agentLoop.create(SessionId('pm2'), { provider: 'mock', model: 'mock' }, { cwd: root })
    const entry = await ctx.coop.registerV2(second, { roles: ['master'] })
    expect(String(entry.masterId)).toBe(id1)
    const { readFile } = await import('node:fs/promises')
    const table = JSON.parse(await readFile(join(root, '.dsh', 'coop', 'v2', 'registry.json'), 'utf8')) as { entries: Array<{ roles: string[] }> }
    expect(table.entries.filter(candidate => candidate.roles.includes('master'))).toHaveLength(1)
  })

  it('follows a session switch inside one TUI process', async () => {
    const root = await tmpRoot()
    const ctx = await paneHarness(root, 't1:pS')
    const first = await ctx.agentLoop.create(SessionId('sm1'), { provider: 'mock', model: 'mock' }, { cwd: root })
    await ctx.coop.registerV2(first, { roles: ['master'] })
    const id1 = String((await ctx.coop.statusV2(first)).self?.masterId)
    // The prior session still lives in this process, so the successor
    // reuses the pane identity even though the heartbeat is fresh.
    const second = await ctx.agentLoop.create(SessionId('sm2'), { provider: 'mock', model: 'mock' }, { cwd: root })
    const entry = await ctx.coop.registerV2(second, { roles: ['master'] })
    expect(String(entry.masterId)).toBe(id1)
  })

  it('mints a new identity for a different pane', async () => {
    const root = await tmpRoot()
    const ctx1 = await paneHarness(root, 't1:pD1')
    const ctx2 = await paneHarness(root, 't1:pD2')
    const first = await ctx1.agentLoop.create(SessionId('dm1'), { provider: 'mock', model: 'mock' }, { cwd: root })
    await ctx1.coop.registerV2(first, { roles: ['master'] })
    const id1 = String((await ctx1.coop.statusV2(first)).self?.masterId)
    const second = await ctx2.agentLoop.create(SessionId('dm2'), { provider: 'mock', model: 'mock' }, { cwd: root })
    const entry = await ctx2.coop.registerV2(second, { roles: ['master'] })
    expect(String(entry.masterId)).not.toBe(id1)
    const { readFile } = await import('node:fs/promises')
    const table = JSON.parse(await readFile(join(root, '.dsh', 'coop', 'v2', 'registry.json'), 'utf8')) as { entries: Array<{ roles: string[] }> }
    expect(table.entries.filter(candidate => candidate.roles.includes('master'))).toHaveLength(2)
  })
})
