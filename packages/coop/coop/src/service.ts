/**
 * Cross-session master/worker cooperation service (`ctx.coop`). Authority lives
 * in workspace-shared files under `.dsh/coop/`; per-session events are mirrors.
 * Delivery is single-path: a notification becomes an inbox signal line, and the
 * receiving session — same process or after resume — delivers undelivered
 * signals to its own agent through `Agent.followup`, advancing its watermark.
 * @module @deepseek-ai/dsh-coop/service
 */

import { randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
// Type-only: resolves ctx.commands / ctx.systemPrompt for the optional children.
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { createUserMessage, boundContextSummary } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import type {
  CoopInboxEntry,
  CoopMemoryEntry,
  CoopPlanFile,
  CoopRegistryEntry,
  CoopV2PlanFile,
  CoopV2RegistryEntry,
  CoopV2RegistryFile,
  CoopV2Task,
  CoopWtEntry,
  CoopWtRegistryFile,
  CwdScope,
  MasterId,
  PlanStatus,
  ReviewLevel,
  Role,
  V2Role,
} from './types.ts'
import {
  CoopError,
  PlanId as brandPlanId,
  canCommunicate,
  coopRoot,
  mintMasterId,
  normalizeCwd,
  resolveCoopConfig,
  v2Root, applyRoleLlmRoute, planColumnSplit, PaneBox } from './runtime.ts'
import type { ResolvedCoopConfig, RoleLlmRoute, RoleLlmSettings } from './runtime.ts'
import * as store from './store.ts'
import { COOP_POLICY_ORDER, COOP_POLICY_SECTION_NAME, COOP_POLICY_TEXT, COOP_V2_POLICY_TEXT } from './policy.ts'
import { registerCoopCommands } from './commands.ts'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'coop': { kind: 'coop' } & ContextFormed
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Identical to the session-controller declaration so the interfaces merge when both are composed. */
    'model/selection': { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }
  }
}

import { registerCoopTools, registerCoopV2Tools } from './tools.ts'

/** Raw deployment config; enum and positivity rules are enforced in {@link resolveCoopConfig}. */
export interface Config {
  /** Inbox poll cadence for live sessions; watch degradation is a plain timer. */
  inboxPollMs?: number
  /**
   * Append `coop/*` mirror events to each acting session's log. Off by
   * default: `Session.append` cannot mark events ignorable, so mirrors are
   * unreadable to any build whose vocabulary predates this package (resume
   * fails loud). Enable only when every reader build knows `coop/*`.
   */
  mirrorEvents?: boolean
  defaultReviewLevel?: ReviewLevel
  docRoot?: string
  allowNoWorker?: boolean
  staleMs?: number
  executingStaleMs?: number
  abortAckTimeoutMs?: number
  workerSelector?: 'earliest' | 'round-robin'
  inboxCompactThreshold?: number
  allowAnyCwdRoles?: Role[]
  /** Registry/tool model: `v1` (default) ships the master/worker plan flow; `v2` selects the multi-master node registry. */
  mode?: 'v1' | 'v2'
  /** v2 per-master worker capacity enforced at bind and registration. */
  maxWorkers?: number
  /** v2 per-master reviewer capacity enforced at bind and registration. */
  maxReviewers?: number
  /** v2 per-master limit on concurrently assigned+executing tasks across plans. */
  maxParallelTasks?: number
  /** v2 whether the master may verify its own tasks when no reviewer is bound (§12.4; default off). */
  allowSelfReview?: boolean
  /** v2 rework rounds before a task escalates to blocked (§5.2). */
  maxReworkAttempts?: number
  /** v2 memory records injected into the coop:memory prompt section (§12.3). */
  memoryInjectTopK?: number
  /** v2 memory trail retention budget per master; appends drop the oldest beyond it. */
  memoryRetainEntries?: number
  /** v2 node auto-creation transport: herdr pane when available, else in-process headless (§8.2). */
  spawn?: 'auto' | 'herdr' | 'headless'
  /** v2 command template run in a spawned herdr pane; `{cwd}` is replaced. */
  spawnCommand?: string
  /** v2 regex herdr pane output must match before the registration line is sent (empty = send immediately). */
  spawnReadyRegex?: string
  /** v2 per-role LLM routes (`master`/`worker`/`reviewer` → provider/model/reasoningEffort) applied to registered sessions' requests. */
  roleLlm?: RoleLlmSettings
  /** v2 window waiting for a spawned pane's registration to land in the registry (default 30,000). */
  spawnRegisterTimeoutMs?: number
  /** v2 pane arrangement for auto-spawned nodes: role `columns` or legacy `right`. */
  spawnLayout?: 'columns' | 'right'
}

/** Schemastery surface of {@link Config}; enum narrowing happens in resolveCoopConfig. */
export const Config: z<Config> = z.object({
  defaultReviewLevel: z.string(),
  docRoot: z.string(),
  allowNoWorker: z.boolean(),
  staleMs: z.number(),
  executingStaleMs: z.number(),
  abortAckTimeoutMs: z.number(),
  workerSelector: z.string(),
  inboxCompactThreshold: z.number(),
  allowAnyCwdRoles: z.array(z.string()),
  mode: z.string(),
  maxWorkers: z.number(),
  maxReviewers: z.number(),
  maxParallelTasks: z.number(),
  allowSelfReview: z.boolean(),
  maxReworkAttempts: z.number(),
  memoryInjectTopK: z.number(),
  memoryRetainEntries: z.number(),
  spawn: z.string(),
  spawnCommand: z.string(),
  spawnReadyRegex: z.string(),
  spawnRegisterTimeoutMs: z.number(),
  spawnLayout: z.string(),
  roleLlm: z.any(),
  inboxPollMs: z.number(),
  mirrorEvents: z.boolean(),
}) as unknown as z<Config>

declare module '@deepseek-ai/cordis' {
  interface Context {
    coop: CoopService
  }
}

/** Terminal statuses accepting no further transitions except idempotent re-abort. */
const TERMINAL_STATUSES: ReadonlySet<PlanStatus> = new Set(['done', 'closed', 'aborted'])

/**
 * Apply lazy watchdog transitions to one loaded plan. Executing plans whose
 * heartbeat went silent fall back to `needs_rework`; `aborting` plans whose
 * ack never arrived close as `aborted` past the ack timeout. Returns the same
 * reference when nothing applies so read paths can skip the rewrite.
 */
function watchTransition(plan: CoopPlanFile, now: number, limits: Pick<ResolvedCoopConfig, 'executingStaleMs' | 'abortAckTimeoutMs'>): CoopPlanFile {
  if (plan.status === 'executing' && plan.execution !== undefined
    && now - plan.execution.heartbeatAt > limits.executingStaleMs) {
    const { execution: _dropped, ...rest } = plan
    return {
      ...rest,
      status: 'needs_rework',
      history: [...plan.history, { time: now, sessionId: plan.createdBy, op: 'execute_stale', status: 'needs_rework', summary: 'worker heartbeat timed out' }],
    }
  }
  if (plan.status === 'aborting') {
    const startedAt = [...plan.history].reverse().find(entry => entry.status === 'aborting')?.time
    if (startedAt !== undefined && now - startedAt > limits.abortAckTimeoutMs) {
      return {
        ...plan,
        status: 'aborted',
        history: [...plan.history, { time: now, sessionId: plan.createdBy, op: 'abort_timeout', status: 'aborted', summary: 'ack timeout elapsed' }],
      }
    }
  }
  return plan
}

/**
 * Master/worker cooperation over a workspace-shared file store. The class is
 * the plugin: the Loader instantiates it with {@link Config}, and the optional
 * tool/command/policy children mount only when their seams are composed.
 */
export class CoopService extends Service {
  static inject = ['agents']

  static Config = Config

  private readonly resolved: ResolvedCoopConfig

  /** Role-pinned LLM routes for sessions registered in THIS process; cross-process nodes apply their own deployment config. */
  private readonly roleLlmBySession = new Map<string, RoleLlmRoute>()

  /** Optional session-controller seam that makes a role pin visible in the owning session's model selection. */
  private sessionController: SessionControllerSeam | undefined

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'coop')
    this.resolved = resolveCoopConfig(config)
    ctx.inject(['sessionController'], (controllerCtx) => {
      this.sessionController = (controllerCtx as { sessionController?: SessionControllerSeam }).sessionController
    })
    // Deployment-pinned role routes rewrite every request of a locally
    // registered session; registration in any process applies the same
    // deployment config there, so herdr panes and headless spawns converge.
    if (this.resolved.mode === 'v2' && Object.keys(this.resolved.roleLlm).length > 0) {
      ctx.on('agent/request', async ({ agent }, next) => {
        const resolved = await next()
        const route = this.roleLlmBySession.get(String(agent.session.id))
        return route === undefined ? resolved : applyRoleLlmRoute(resolved, route)
      })
    }
    ctx.inject(['shell'], (shellCtx) => {
      this.shellSeam = (shellCtx as { shell?: unknown }).shell as typeof this.shellSeam
    })
    ctx.inject(['systemPrompt'], (promptCtx) => {
      promptCtx.systemPrompt.section({
        name: COOP_POLICY_SECTION_NAME,
        order: COOP_POLICY_ORDER,
        text: this.resolved.mode === 'v2' ? COOP_V2_POLICY_TEXT : COOP_POLICY_TEXT,
      })
      if (this.resolved.mode === 'v2') {
        promptCtx.systemPrompt.section({
          name: 'coop:memory',
          order: 41,
          text: '{{coopMemory}}',
        })
        promptCtx.systemPrompt.variable('coopMemory', (context) => {
          if (context.agent === undefined) return undefined
          const block = this.memoryCache.get(String(context.agent.session.id))
          return block === undefined || block.length === 0 ? undefined : block
        })
      }
    })
    ctx.inject(['tools'], (toolCtx) => {
      if (this.resolved.mode === 'v2') registerCoopV2Tools(toolCtx, this)
      else registerCoopTools(toolCtx, this)
    })
    ctx.inject(['commands'], (commandCtx) => {
      registerCoopCommands(commandCtx, this)
    })
    // A cross-process worker receives signal lines on its next activation:
    // resume, fresh start, or any later turn-driven session-start replay.
    ctx.on('agent/created', ({ agent }) => {
      void this.drainInbox(agent).catch((error: unknown) => {
        this.ctx.logger.warn(`coop: draining inbox for "${String(agent.session.id)}" failed: ${String(error)}`)
      })
    })
    // An open-but-idle session never re-fires session-start, so poll the live
    // agents' inboxes too: a plan notification then lands as a woken turn (and
    // streams straight into that session's TUI) within one poll interval.
    ctx.effect(() => {
      const timer = setInterval(() => {
        this.pollLiveInboxes().catch((error: unknown) => {
          this.ctx.logger.warn(`coop: inbox poll failed: ${String(error)}`)
        })
      }, this.resolved.inboxPollMs)
      return () => {
        clearInterval(timer)
      }
    }, 'coop:inbox-poll')
  }

  /**
   * Append one coop mirror event when `mirrorEvents` is enabled. Mirrors are
   * audit/replay extras; the shared files stay authoritative either way.
   */
  private appendMirror(session: Agent['session'], type: 'coop/registry' | 'coop/registry-v2' | 'coop/plan-change' | 'coop/review' | 'coop/execution', data: unknown): void {
    if (!this.resolved.mirrorEvents) return
    session.append(type, data as never)
  }

  // ---- workspace plumbing ----

  /** Normalized workspace of one agent's session. */
  private workspaceOf(agent: Agent): string {
    return normalizeCwd(agent.session.header.cwd ?? process.cwd())
  }

  private rootOf(cwd: string): string {
    return coopRoot(cwd, this.resolved.docRoot)
  }

  private localRegistryPath(cwd: string): string {
    return store.registryPath(this.rootOf(cwd))
  }

  private globalRegistryPath(): string {
    return store.globalRegistryPath(resolveDshHome())
  }

  /**
   * Entries alive per heartbeat. The persisted-header liveness check is
   * deliberately deferred (see README): the stale window alone decides
   * pre-release, and a crashed session stops touching its heartbeat either way.
   */
  private isFresh(entry: CoopRegistryEntry, now: number): boolean {
    return now - entry.heartbeatAt <= this.resolved.staleMs
  }

  /** Per-session throttle behind heartbeat touches: at most one registry write per quarter stale window. */
  private readonly lastTouch = new Map<string, number>()

  /**
   * Touch the calling session's registry heartbeat. A live process keeps its
   * entries fresh by polling; a crashed one stops touching and ages out of
   * visibility (and master preemption) after `staleMs`.
   */
  private async touchOwnEntry(agent: Agent): Promise<void> {
    const sessionId = String(agent.session.id)
    const now = Date.now()
    const last = this.lastTouch.get(sessionId) ?? 0
    if (now - last < Math.min(this.resolved.staleMs / 4, 30_000)) return
    this.lastTouch.set(sessionId, now)
    try {
      await store.touchHeartbeat(this.localRegistryPath(this.workspaceOf(agent)), sessionId, now)
    } catch {
      // A missing/corrupt registry surfaces on the next real operation;
      // heartbeat loss alone must not break the caller.
    }
  }

  private async requireRegistry(cwd: string): Promise<void> {
    if (await store.readRegistryFile(this.localRegistryPath(cwd)) === undefined) {
      throw new CoopError(`no coop registry under ${cwd} — register a role first (/coop role ...)`, 'COOP_REGISTRY_MISSING')
    }
  }

  /**
   * Roles held by one agent, read from the shared registry (fail-loud when absent).
   * @param agent - querying live agent.
   * @returns the roles held in the shared registry (empty when unregistered).
   */
  async getRoles(agent: Agent): Promise<Role[]> {
    await this.touchOwnEntry(agent)
    const cwd = this.workspaceOf(agent)
    await this.requireRegistry(cwd)
    const entry = await this.findOwnEntry(cwd, String(agent.session.id))
    return entry?.roles ?? []
  }

  private async findOwnEntry(cwd: string, sessionId: string): Promise<CoopRegistryEntry | undefined> {
    const local = await store.readRegistryFile(this.localRegistryPath(cwd))
    const own = local?.entries.find(entry => entry.sessionId === sessionId)
    if (own !== undefined) return own
    const global = await store.readRegistryFile(this.globalRegistryPath())
    return global?.entries.find(entry => entry.sessionId === sessionId)
  }

  /**
   * Register, update, or drop the calling agent's roles in the shared registry.
   * Master registration runs its singleton check under the registry writer
   * lock, so two processes cannot both become master.
   * @param agent - acting live agent.
   * @param ops - additive/removal deltas or a full replacement set.
   * @param opts - directory scope for newly declared visibility, and the worker gating level.
   * @returns the resulting role set (empty means deregistered).
   */
  async setRoles(
    agent: Agent,
    ops: { add?: Role[]; remove?: Role[] } | { set: Role[] },
    opts: { cwdScope?: 'cwd' | 'any'; reviewLevel?: ReviewLevel } = {},
  ): Promise<Role[]> {
    const sessionId = String(agent.session.id)
    const cwd = this.workspaceOf(agent)
    const localPath = this.localRegistryPath(cwd)
    const existingTable = await store.readRegistryFile(localPath)
    const current = existingTable?.entries.find(entry => entry.sessionId === sessionId)
    const previous: Role[] = current?.roles ?? []
    const previousScope = current?.cwdScope ?? 'cwd'
    const reviewLevel = opts.reviewLevel ?? current?.reviewLevel
    const roles: Role[] = 'set' in ops
      ? [...new Set(ops.set)]
      : [...new Set([...previous, ...ops.add ?? []].filter(role => !(ops.remove ?? []).includes(role)))]
    const scope = opts.cwdScope ?? previousScope
    for (const role of roles) {
      if (scope === 'any' && !this.resolved.allowAnyCwdRoles.includes(role)) {
        throw new CoopError(`role "${role}" may not declare cwdScope "any" (allowAnyCwdRoles)`, 'COOP_ANY_CWD_FORBIDDEN')
      }
    }
    const now = Date.now()
    if (existingTable === undefined) {
      // First registration in this workspace creates the table; anything else
      // without a registry is a misconfiguration and fails loud.
      if (previous.length !== 0 || roles.length === 0) {
        throw new CoopError(`no coop registry under ${cwd}`, 'COOP_REGISTRY_MISSING')
      }
      await store.writeRegistryFile(localPath, { version: 1, entries: [] })
    }
    if (roles.length === 0) {
      await store.removeEntry(localPath, sessionId)
      const globalPath = scope === 'any' ? this.globalRegistryPath() : undefined
      if (globalPath !== undefined) await store.removeEntry(globalPath, sessionId)
      this.appendMirror(agent.session, 'coop/registry', { roles: [], updatedAt: now })
      return []
    }
    const entry: CoopRegistryEntry = {
      sessionId,
      roles,
      ...(roles.includes('worker') || reviewLevel !== undefined ? { reviewLevel: reviewLevel ?? this.resolved.defaultReviewLevel } : {}),
      updatedAt: now,
      heartbeatAt: now,
      cwd,
      cwdScope: scope,
    }
    try {
      await store.registerEntry({
        localPath,
        ...(scope === 'any' ? { globalPath: this.globalRegistryPath() } : {}),
        entry,
        conflictsWith: candidate => candidate.roles.includes('master') && roles.includes('master') && this.isFresh(candidate, now),
      })
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('master role already held')) {
        throw new CoopError(`${error.message} — run "/coop role off" there or wait out the stale window`, 'COOP_MASTER_ALREADY_EXISTS')
      }
      throw error
    }
    this.appendMirror(agent.session, 'coop/registry', {
      roles,
      ...(entry.reviewLevel !== undefined ? { reviewLevel: entry.reviewLevel } : {}),
      updatedAt: now,
    })
    return roles
  }

  /**
   * Visible live registrations for one workspace (same cwd plus any-scope), or
   * every entry in both tables with `all`.
   * @param agent - querying live agent anchoring the workspace.
   * @param opts - `all` bypasses the same-directory filter (the `--all` flag).
   * @returns fresh entries, deduplicated across the local and global tables.
   */
  async listWorkspace(agent: Agent, opts: { all?: boolean } = {}): Promise<CoopRegistryEntry[]> {
    await this.touchOwnEntry(agent)
    const cwd = this.workspaceOf(agent)
    await this.requireRegistry(cwd)
    const tables = [await store.readRegistryFile(this.localRegistryPath(cwd)),
      await store.readRegistryFile(this.globalRegistryPath())]
    const now = Date.now()
    const seen = new Set<string>()
    const merged: CoopRegistryEntry[] = []
    for (const table of tables) {
      for (const entry of table?.entries ?? []) {
        if (seen.has(entry.sessionId)) continue
        seen.add(entry.sessionId)
        if (!this.isFresh(entry, now)) continue
        if (!opts.all && !canCommunicate({ cwd, cwdScope: 'cwd' }, entry)) continue
        merged.push(entry)
      }
    }
    return merged
  }

  // ---- plans ----

  /**
   * Create a shared plan and its markdown document. Master-only.
   * @param agent - creating live agent (must hold the master role).
   * @param req - title, objective, and optional review level override.
   * @returns the committed draft plan.
   */
  async createPlan(agent: Agent, req: { title: string; objective: string; reviewLevel?: ReviewLevel }): Promise<CoopPlanFile> {
    const roles = await this.getRoles(agent)
    if (!roles.includes('master')) {
      throw new CoopError('plan creation requires the master role', 'COOP_NOT_PLAN_OWNER')
    }
    const cwd = this.workspaceOf(agent)
    const root = this.rootOf(cwd)
    const planId = brandPlanId(`plan-${randomUUID()}`)
    const docPath = join(root, 'docs', `${planId}.md`)
    const now = Date.now()
    const plan: CoopPlanFile = {
      version: 1,
      planId,
      docPath,
      title: req.title,
      objective: req.objective,
      status: 'draft',
      createdBy: String(agent.session.id),
      cwd,
      reviewLevel: req.reviewLevel ?? this.resolved.defaultReviewLevel,
      history: [{ time: now, sessionId: String(agent.session.id), op: 'create', status: 'draft' }],
    }
    await store.appendDocSection(docPath, [
      `# ${req.title}`,
      '',
      '## Objective',
      '',
      req.objective,
      '',
      '## Changelog',
      '',
      `- ${new Date(now).toISOString()} created by ${String(agent.session.id)} (draft)`,
      '',
    ].join('\n'))
    await store.writePlanFile(store.planPath(root, planId), plan)
    this.appendMirror(agent.session, 'coop/plan-change', { planId, op: 'create', status: 'draft' })
    return plan
  }

  /**
   * Load one plan with lazy watchdog transitions applied.
   * @param agent - reading live agent anchoring the workspace.
   * @param planId - plan to load.
   * @returns the plan with any due watchdog transition applied.
   */
  async getPlan(agent: Agent, planId: string): Promise<CoopPlanFile> {
    const root = this.rootOf(this.workspaceOf(agent))
    return store.mutatePlan(store.planPath(root, planId), (current) => {
      if (current === undefined) {
        throw new CoopError(`plan "${planId}" not found`, 'COOP_PLAN_NOT_FOUND')
      }
      return watchTransition(current, Date.now(), this.resolved)
    })
  }

  /**
   * All plans in the agent's workspace, watchdog applied, newest history first.
   * @param agent - querying live agent.
   * @returns plans ordered by most recent history entry.
   */
  async listPlans(agent: Agent): Promise<CoopPlanFile[]> {
    const plansDir = join(this.rootOf(this.workspaceOf(agent)), 'plans')
    let names: string[]
    try {
      names = await readdir(plansDir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return []
      throw error
    }
    const plans: CoopPlanFile[] = []
    for (const name of names.filter(name => name.endsWith('.json'))) {
      plans.push(await this.getPlan(agent, name.replace(/\.json$/, '')))
    }
    return plans.sort((left, right) => (right.history.at(-1)?.time ?? 0) - (left.history.at(-1)?.time ?? 0))
  }

  /**
   * Bind (or rebind) the affine worker and deliver the plan notification.
   * Master-only, creator-only. A repeat notify while already
   * `pending_pre_review` is a no-op that keeps the bound worker.
   * @param agent - notifying live agent.
   * @param planId - plan to announce.
   * @param opts - explicit worker, reassignment intent, and a short summary.
   * @returns the committed plan with its affine worker bound.
   */
  async notifyPlan(
    agent: Agent,
    planId: string,
    opts: { workerSessionId?: string; reassign?: boolean; summary?: string } = {},
  ): Promise<CoopPlanFile> {
    const senderId = String(agent.session.id)
    const root = this.rootOf(this.workspaceOf(agent))
    const path = store.planPath(root, planId)
    const reassign = opts.reassign === true
    // Pre-flight on an unlocked read only to choose the no-op path; the
    // authoritative transition below re-validates everything under the lock.
    const current = await store.readPlanFile(path)
    if (current === undefined) throw new CoopError(`plan "${planId}" not found`, 'COOP_PLAN_NOT_FOUND')
    if (current.createdBy !== senderId) {
      throw new CoopError(`plan "${planId}" belongs to master "${current.createdBy}"`, 'COOP_NOT_PLAN_OWNER')
    }
    const watched = watchTransition(current, Date.now(), this.resolved)
    if (watched.status === 'pending_pre_review' && !reassign) return watched
    if (!['draft', 'needs_plan_revision', 'needs_rework'].includes(watched.status)) {
      throw new CoopError(`plan "${planId}" is "${watched.status}"; notify expects draft/needs_plan_revision/needs_rework`, 'COOP_INVALID_TRANSITION')
    }
    const boundWorker = await this.pickWorker(agent, opts.workerSessionId, watched)
    const nextStatus: PlanStatus = watched.status === 'needs_rework' ? 'needs_rework' : 'pending_pre_review'
    const now = Date.now()
    // Status transition and (re)binding commit together under one lock.
    const plan = await store.mutatePlan(path, (locked) => {
      if (locked === undefined) throw new CoopError(`plan "${planId}" not found`, 'COOP_PLAN_NOT_FOUND')
      return {
        ...watchTransition(locked, now, this.resolved),
        status: nextStatus,
        assignedWorkerSessionId: boundWorker,
        history: [...locked.history, { time: now, sessionId: senderId, op: 'notify', status: nextStatus, ...(opts.summary === undefined ? {} : { summary: opts.summary }) }],
      }
    })
    const summary = opts.summary ?? plan.objective.slice(0, 200)
    await this.deliver(senderId, boundWorker, plan, 'notify', summary)
    this.appendMirror(agent.session, 'coop/plan-change', { planId, op: 'notify', status: nextStatus, summary })
    return { ...plan, assignedWorkerSessionId: boundWorker }
  }

  /** Rotation counter behind the round-robin worker selector. */
  private roundRobin = 0

  /**
   * Choose the affine worker: explicit id (validated), else the configured
   * selector over visible live workers.
   */
  private async pickWorker(agent: Agent, requested: string | undefined, plan: CoopPlanFile): Promise<string> {
    const candidates = (await this.listWorkspace(agent)).filter(entry => entry.roles.includes('worker'))
    if (requested !== undefined) {
      const match = candidates.find(entry => entry.sessionId === requested)
      if (match === undefined) {
        throw new CoopError(`requested worker "${requested}" is not a visible live worker`, 'COOP_NO_WORKER')
      }
      return match.sessionId
    }
    if (candidates.length === 0) {
      if (this.resolved.allowNoWorker) return String(agent.session.id)
      throw new CoopError(`no live worker visible in ${plan.cwd}`, 'COOP_NO_WORKER')
    }
    const ordered = [...candidates].sort((left, right) => left.updatedAt - right.updatedAt)
    // `ordered` is non-empty here; the indexed reads below always land.
    const chosen = this.resolved.workerSelector === 'round-robin'
      // oxlint-disable-next-line typescript/no-non-null-assertion
      ? ordered[this.roundRobin++ % ordered.length]!
      // oxlint-disable-next-line typescript/no-non-null-assertion
      : ordered[0]!
    return chosen.sessionId
  }

  /** Worker-gate shared preconditions: assigned worker, plan present, expected status. */
  private async requireAssignedWorkerState(
    agent: Agent,
    planId: string,
    expected: PlanStatus[],
  ): Promise<{ root: string; plan: CoopPlanFile }> {
    const root = this.rootOf(this.workspaceOf(agent))
    const workerId = String(agent.session.id)
    const plan = await store.readPlanFile(store.planPath(root, planId))
    if (plan === undefined) throw new CoopError(`plan "${planId}" not found`, 'COOP_PLAN_NOT_FOUND')
    if (plan.assignedWorkerSessionId !== workerId) {
      throw new CoopError(`plan "${planId}" is assigned to "${plan.assignedWorkerSessionId ?? 'nobody'}"`, 'COOP_NOT_ASSIGNED_WORKER')
    }
    if (!expected.includes(plan.status)) {
      throw new CoopError(`plan "${planId}" is "${plan.status}", expected ${expected.join('/')}`, 'COOP_INVALID_TRANSITION')
    }
    return { root, plan }
  }

  /**
   * Worker pre-review gate.
   * @param agent - assigned worker live agent.
   * @param planId - plan under review.
   * @param decision - pass promotes to ready_to_execute; request_changes returns the plan.
   * @param summary - one-line rationale recorded in the plan document.
   * @returns the committed plan in ready_to_execute or needs_plan_revision.
   */
  async submitPreReview(agent: Agent, planId: string, decision: 'pass' | 'request_changes', summary?: string): Promise<CoopPlanFile> {
    const roles = await this.getRoles(agent)
    if (!roles.includes('worker')) throw new CoopError('pre-review requires the worker role', 'COOP_NOT_ASSIGNED_WORKER')
    const workerId = String(agent.session.id)
    const { root } = await this.requireAssignedWorkerState(agent, planId, ['pending_pre_review'])
    const now = Date.now()
    const nextStatus: PlanStatus = decision === 'pass' ? 'ready_to_execute' : 'needs_plan_revision'
    const review = { planId, phase: 'pre_review' as const, decision, ...(summary === undefined ? {} : { summary }) }
    const plan = await store.mutatePlan(store.planPath(root, planId), (current) => {
      if (current === undefined || current.status !== 'pending_pre_review') {
        throw new CoopError(`plan "${planId}" left pending_pre_review concurrently`, 'COOP_INVALID_TRANSITION')
      }
      return {
        ...current,
        status: nextStatus,
        lastReview: review,
        history: [...current.history, { time: now, sessionId: workerId, op: 'pre_review', status: nextStatus, ...(summary === undefined ? {} : { summary }) }],
      }
    })
    await store.appendDocSection(plan.docPath, [
      '## Pre-review',
      '',
      `- ${new Date(now).toISOString()} worker ${workerId}: **${decision}**${summary === undefined ? '' : ` — ${summary}`}`,
      '',
    ].join('\n'))
    this.appendMirror(agent.session, 'coop/review', review)
    if (decision === 'pass') {
      // The worker's own gate passing is the execution trigger: nothing else
      // wakes it, so drop a drive signal into its own inbox — the poll turns
      // it into a fresh followup turn that per policy begins execution.
      await this.deliver(workerId, workerId, plan, 'drive', `pre-review passed — call coop_execute_begin(planId="${planId}") now, do the work, then coop_execute_report`)
    }
    await this.deliver(workerId, plan.createdBy, plan,
      decision === 'pass' ? 'pre_review' : 'drive',
      decision === 'pass'
        ? `worker ${workerId} passed pre-review — execution starting; you will be woken to verify.`
        : `pre-review request_changes${summary === undefined ? '' : `: ${summary}`} — revise the plan via coop_plan_create/update, then coop_plan_notify(planId="${planId}") to send it back for review.`)
    return plan
  }

  /**
   * Worker starts executing: ready_to_execute (or needs_rework retry) → executing.
   * @param agent - assigned worker live agent.
   * @param planId - plan to begin.
   * @returns the committed executing plan.
   */
  async beginExecution(agent: Agent, planId: string): Promise<CoopPlanFile> {
    const workerId = String(agent.session.id)
    const { root } = await this.requireAssignedWorkerState(agent, planId, ['ready_to_execute', 'needs_rework'])
    const now = Date.now()
    const plan = await store.mutatePlan(store.planPath(root, planId), (current) => {
      if (current === undefined || !['ready_to_execute', 'needs_rework'].includes(current.status)) {
        throw new CoopError(`plan "${planId}" left ${String(current?.status)} concurrently`, 'COOP_INVALID_TRANSITION')
      }
      return {
        ...current,
        status: 'executing',
        execution: { startedAt: now, heartbeatAt: now },
        history: [...current.history, { time: now, sessionId: workerId, op: 'execute_begin', status: 'executing' }],
      }
    })
    this.appendMirror(agent.session, 'coop/execution', { planId, phase: 'begin' })
    return plan
  }

  /**
   * Worker heartbeat while executing; feeds the executing watchdog.
   * @param agent - assigned worker live agent.
   * @param planId - executing plan.
   */
  async touchExecution(agent: Agent, planId: string): Promise<void> {
    const { root } = await this.requireAssignedWorkerState(agent, planId, ['executing'])
    const now = Date.now()
    await store.mutatePlan(store.planPath(root, planId), (current) => {
      if (current === undefined || current.execution === undefined) {
        throw new CoopError(`plan "${planId}" is not executing`, 'COOP_INVALID_TRANSITION')
      }
      return { ...current, execution: { ...current.execution, heartbeatAt: now } }
    })
  }

  /**
   * Worker reports execution results: executing → pending_verify, then wakes the master.
   * @param agent - assigned worker live agent.
   * @param planId - executed plan.
   * @param summary - what was done, recorded in the plan document.
   * @returns the committed pending_verify plan.
   */
  async reportExecution(agent: Agent, planId: string, summary: string): Promise<CoopPlanFile> {
    const workerId = String(agent.session.id)
    const { root } = await this.requireAssignedWorkerState(agent, planId, ['executing'])
    const now = Date.now()
    const execution = { planId, phase: 'report' as const, summary }
    const plan = await store.mutatePlan(store.planPath(root, planId), (current) => {
      if (current === undefined || current.status !== 'executing') {
        throw new CoopError(`plan "${planId}" left executing concurrently`, 'COOP_INVALID_TRANSITION')
      }
      return {
        ...current,
        status: 'pending_verify',
        lastExecution: execution,
        history: [...current.history, { time: now, sessionId: workerId, op: 'execute_report', status: 'pending_verify', summary }],
      }
    })
    await store.appendDocSection(plan.docPath, [
      '## Execution',
      '',
      `- ${new Date(now).toISOString()} worker ${workerId}: ${summary}`,
      '',
    ].join('\n'))
    this.appendMirror(agent.session, 'coop/execution', execution)
    await this.deliver(workerId, plan.createdBy, plan, 'execution', summary)
    return plan
  }

  /**
   * Master verification: pass closes the plan (done → closed); request_changes
   * returns it to the assigned worker as needs_rework.
   * @param agent - creating master live agent.
   * @param planId - plan under verification.
   * @param decision - pass or request_changes.
   * @param summary - acceptance rationale or rework demand.
   * @returns the committed plan (closed on pass, needs_rework otherwise).
   */
  async verifyPlan(agent: Agent, planId: string, decision: 'pass' | 'request_changes', summary?: string): Promise<CoopPlanFile> {
    const masterId = String(agent.session.id)
    const root = this.rootOf(this.workspaceOf(agent))
    const plan = await store.readPlanFile(store.planPath(root, planId))
    if (plan === undefined) throw new CoopError(`plan "${planId}" not found`, 'COOP_PLAN_NOT_FOUND')
    if (plan.createdBy !== masterId) {
      throw new CoopError(`plan "${planId}" belongs to master "${plan.createdBy}"`, 'COOP_NOT_PLAN_OWNER')
    }
    if (plan.status !== 'pending_verify') {
      throw new CoopError(`plan "${planId}" is "${plan.status}", expected pending_verify`, 'COOP_INVALID_TRANSITION')
    }
    const now = Date.now()
    const nextStatus: PlanStatus = decision === 'pass' ? 'closed' : 'needs_rework'
    const review = { planId, phase: 'verify' as const, decision, ...(summary === undefined ? {} : { summary }) }
    const updated = await store.mutatePlan(store.planPath(root, planId), (current) => {
      if (current === undefined || current.status !== 'pending_verify') {
        throw new CoopError(`plan "${planId}" left pending_verify concurrently`, 'COOP_INVALID_TRANSITION')
      }
      // Pass records `done` at the accept boundary and closes in the same
      // commit chain; the intermediate status stays observable in history.
      const status: PlanStatus = decision === 'pass' ? 'done' : 'needs_rework'
      return {
        ...current,
        status,
        lastReview: review,
        history: [...current.history, { time: now, sessionId: masterId, op: 'verify', status, ...(summary === undefined ? {} : { summary }) }],
      }
    })
    if (decision === 'pass') {
      await store.mutatePlan(store.planPath(root, planId), (current) => {
        if (current === undefined || current.status !== 'done') {
          throw new CoopError(`plan "${planId}" did not settle at done`, 'COOP_INVALID_TRANSITION')
        }
        return {
          ...current,
          status: 'closed',
          history: [...current.history, { time: Date.now(), sessionId: masterId, op: 'close', status: 'closed' }],
        }
      })
    }
    await store.appendDocSection(plan.docPath, [
      '## Verify',
      '',
      `- ${new Date(now).toISOString()} master ${masterId}: **${decision}**${summary === undefined ? '' : ` — ${summary}`}`,
      '',
    ].join('\n'))
    this.appendMirror(agent.session, 'coop/review', review)
    const workerId = updated.assignedWorkerSessionId
    if (workerId !== undefined) {
      await this.deliver(masterId, workerId, updated,
        decision === 'pass' ? 'verify' : 'drive',
        decision === 'pass'
          ? 'verify passed — plan closed, nothing further to do.'
          : `rework requested${summary === undefined ? '' : `: ${summary}`} — call coop_execute_begin(planId="${planId}"), address the feedback, then coop_execute_report`)
    }
    return { ...updated, status: nextStatus }
  }

  /**
   * Master abort: any non-terminal status moves to aborting and the assigned
   * worker is told to stop. Repeat aborts while already aborting re-deliver.
   * @param agent - creating master live agent.
   * @param planId - plan to stop.
   * @param reason - human-readable stop rationale.
   * @returns the committed aborting plan.
   */
  async abortPlan(agent: Agent, planId: string, reason?: string): Promise<CoopPlanFile> {
    const masterId = String(agent.session.id)
    const root = this.rootOf(this.workspaceOf(agent))
    const now = Date.now()
    const plan = await store.mutatePlan(store.planPath(root, planId), (current) => {
      if (current === undefined) throw new CoopError(`plan "${planId}" not found`, 'COOP_PLAN_NOT_FOUND')
      if (current.createdBy !== masterId) {
        throw new CoopError(`plan "${planId}" belongs to master "${current.createdBy}"`, 'COOP_NOT_PLAN_OWNER')
      }
      if (TERMINAL_STATUSES.has(current.status)) {
        throw new CoopError(`plan "${planId}" is already "${current.status}"`, 'COOP_INVALID_TRANSITION')
      }
      if (current.status === 'aborting') return current
      return {
        ...current,
        status: 'aborting',
        history: [...current.history, { time: now, sessionId: masterId, op: 'abort', status: 'aborting', ...(reason === undefined ? {} : { summary: reason }) }],
      }
    })
    if (plan.status !== 'aborting') {
      await store.appendDocSection(plan.docPath, [
        '## Abort',
        '',
        `- ${new Date(now).toISOString()} master ${masterId} requested abort${reason === undefined ? '' : `: ${reason}`}`,
        '',
      ].join('\n'))
      this.appendMirror(agent.session, 'coop/plan-change', { planId, op: 'abort', status: 'aborting', ...(reason === undefined ? {} : { summary: reason }) })
    }
    const workerId = plan.assignedWorkerSessionId
    if (workerId !== undefined) {
      await this.deliver(masterId, workerId, plan, 'abort', `stop all work for plan "${plan.title}"`, reason)
    }
    return { ...plan, status: 'aborting' }
  }

  /**
   * Assigned worker acknowledges an abort: aborting → aborted.
   * @param agent - assigned worker live agent.
   * @param planId - stopped plan.
   * @returns the committed aborted plan.
   */
  async abortAck(agent: Agent, planId: string): Promise<CoopPlanFile> {
    const workerId = String(agent.session.id)
    const { root } = await this.requireAssignedWorkerState(agent, planId, ['aborting'])
    const now = Date.now()
    const plan = await store.mutatePlan(store.planPath(root, planId), (current) => {
      if (current === undefined || current.status !== 'aborting') {
        throw new CoopError(`plan "${planId}" is not aborting anymore`, 'COOP_INVALID_TRANSITION')
      }
      return {
        ...current,
        status: 'aborted',
        history: [...current.history, { time: now, sessionId: workerId, op: 'abort_ack', status: 'aborted' }],
      }
    })
    await store.appendDocSection(plan.docPath, [
      `- ${new Date(now).toISOString()} worker ${workerId} acknowledged abort.`,
      '',
    ].join('\n'))
    this.appendMirror(agent.session, 'coop/review', { planId, phase: 'abort_ack', decision: 'ack' })
    await this.deliver(workerId, plan.createdBy, plan, 'verify', 'abort acknowledged (plan aborted)')
    return plan
  }

  // ---- delivery ----

  /**
   * Deliver one notification: append the signal line, then — when the target
   * is live in this process — drain its inbox immediately so the line becomes
   * a woken follow-up turn. Cross-process targets stay parked until their next
   * activation replays `drainInbox`.
   */
  private async deliver(fromId: string, targetId: string, plan: CoopPlanFile, kind: CoopInboxEntry['kind'], summary: string, reason?: string): Promise<void> {
    const root = this.rootOf(plan.cwd)
    await store.appendSignal(store.inboxPath(root, targetId), {
      time: Date.now(),
      from: fromId,
      planId: plan.planId,
      kind,
      summary,
      docPath: plan.docPath,
      ...(reason === undefined ? {} : { reason }),
    })
    const target = this.ctx.agents.get(SessionId(targetId))
    if (target !== undefined) await this.drainAgentInbox(target, root)
  }

  private signalText(entry: CoopInboxEntry): string {
    switch (entry.kind) {
      case 'drive':
        return `[coop] Plan "${entry.planId}" action required. ${entry.summary}. Document: ${entry.docPath}.`
      case 'notify':
        return `[coop] New plan to pre-review "${entry.planId}" — ${entry.summary} Document: ${entry.docPath}. Call coop_status, then coop_pre_review(planId, decision); on pass, continue straight into execution.`
      case 'pre_review':
        return `[coop] Plan "${entry.planId}" pre-review result: ${entry.summary}`
      case 'verify':
        return `[coop] Plan "${entry.planId}" update: ${entry.summary}. See ${entry.docPath}.`
      case 'execution':
        return `[coop] Plan "${entry.planId}" execution reported: ${entry.summary}. Call coop_verify(planId, decision).`
      case 'abort':
        return `[coop] ABORT plan "${entry.planId}"${entry.reason === undefined ? '' : ` — reason: ${entry.reason}`} — stop all further work for this plan immediately, clean up, then call coop_abort_ack(planId).`
      case 'node':
        return `[coop] Node notice: ${entry.summary}`
      case 'task':
        return `[coop] Task notice (${entry.planId}): ${entry.summary}. Plan document: ${entry.docPath}. Act on it in this turn.`
      default:
        return `[coop] Plan "${entry.planId}" notification: ${entry.summary}`
    }
  }

  /**
   * Deliver every undelivered signal addressed to one agent and advance its
   * watermark. Each delivered line becomes a woken follow-up turn.
   * @param agent - receiving live agent.
   * @returns how many previously undelivered signals were delivered.
   */
  async drainInbox(agent: Agent): Promise<number> {
    const root = await this.activeRootOf(agent)
    return this.drainAgentInbox(agent, root)
  }

  /** Session ids with an in-flight drain, so poll ticks never double-deliver. */
  private readonly draining = new Set<string>()

  /**
   * Drain every live agent's inbox once per tick. Non-participants cost one
   * ENOENT read each; failures are logged by the caller and retried next tick.
   */
  private async pollLiveInboxes(): Promise<void> {
    for (const agent of this.ctx.agents.list()) {
      const id = String(agent.session.id)
      if (this.draining.has(id)) continue
      this.draining.add(id)
      try {
        const root = await this.activeRootOf(agent)
        await this.drainAgentInbox(agent, root)
        await this.touchActive(agent)
        await this.reportNodeStates(root)
      } finally {
        this.draining.delete(id)
      }
    }
  }

  private async drainAgentInbox(agent: Agent, root: string): Promise<number> {
    const sessionId = String(agent.session.id)
    const path = store.inboxPath(root, sessionId)
    const watermarkPath = store.consumedPath(root, sessionId)
    const { entries } = await store.readSignals(path, watermarkPath)
    let highest = await store.readConsumed(watermarkPath)
    for (const entry of entries) {
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: this.signalText(entry) }],
        source: { kind: 'coop', form: 'notice', summary: boundContextSummary(`${entry.kind}: ${entry.summary}`) },
      }))
      highest = Math.max(highest, entry.seq)
    }
    if (entries.length > 0) {
      await store.advanceConsumed(watermarkPath, highest)
      await store.compactSignals(path, watermarkPath, this.resolved.inboxCompactThreshold)
    }
    return entries.length
  }

  /** Per-session throttle behind v2 heartbeats; mirrors the v1 map's cadence. */
  private readonly lastTouchV2 = new Map<string, number>()

  /** Registry model in force for this deployment. */
  get mode(): 'v1' | 'v2' {
    return this.resolved.mode
  }

  /** Per-session coop:memory prompt blocks; refreshed on ticks, writes, and drains. */
  private readonly memoryCache = new Map<string, string>()

  /**
       * The v2 coop root for one agent: nearest explicit workspace anchor above
       * the session cwd, else the cwd itself (single-project fallback).
       * @param agent - anchoring live agent.
       * @returns the absolute `.dsh/coop/v2` root.
       */
  private async v2RootOf(agent: Agent): Promise<string> {
    const anchor = await store.findWorkspaceRoot(this.workspaceOf(agent), this.resolved.docRoot)
    return v2Root(anchor.root, this.resolved.docRoot)
  }

  /**
       * The coop root whose inbox the active mode's signals flow through.
       * @param agent - anchoring live agent.
       * @returns the v1 or v2 coop root for the session's workspace.
       */
  private async activeRootOf(agent: Agent): Promise<string> {
    return this.resolved.mode === 'v2' ? await this.v2RootOf(agent) : this.rootOf(this.workspaceOf(agent))
  }

  /** The global any-scope v2 registry path. */
  private v2GlobalRegistryPath(): string {
    return store.globalV2RegistryPath(resolveDshHome())
  }

  /**
       * Merge the local and global v2 tables, deduplicated by session id.
       * @param root - absolute v2 root.
       * @returns every registered entry across both tables.
       */
  private async v2Tables(root: string): Promise<CoopV2RegistryEntry[]> {
    const local = await store.readV2Registry(store.v2RegistryPath(root))
    const global = await store.readV2Registry(this.v2GlobalRegistryPath())
    const seen = new Set<string>()
    const merged: CoopV2RegistryEntry[] = []
    for (const entry of [...local?.entries ?? [], ...global?.entries ?? []]) {
      if (seen.has(entry.sessionId)) continue
      seen.add(entry.sessionId)
      merged.push(entry)
    }
    return merged
  }

  /** Whether one v2 entry is within the stale window. */
  private isFreshV2(entry: CoopV2RegistryEntry, now: number): boolean {
    return now - entry.heartbeatAt <= this.resolved.staleMs
  }

  /**
       * Heartbeat the calling session's entry in whichever registry its mode uses.
       * @param agent - owning live agent.
       */
  private async touchActive(agent: Agent): Promise<void> {
    if (this.resolved.mode === 'v2') {
      await this.touchOwnEntryV2(agent)
      await this.refreshMemoryCache(agent)
    } else {
      await this.touchOwnEntry(agent)
    }
  }

  /**
       * Touch the calling session's v2 registry heartbeat under the v1-style
       * per-session throttle; a crashed session ages out of visibility after
       * `staleMs` and its nodes return to the adoptable pool only via release.
       * @param agent - owning live agent.
       */
  private async touchOwnEntryV2(agent: Agent): Promise<void> {
    const sessionId = String(agent.session.id)
    const now = Date.now()
    const last = this.lastTouchV2.get(sessionId) ?? 0
    if (now - last < Math.min(this.resolved.staleMs / 4, 30_000)) return
    this.lastTouchV2.set(sessionId, now)
    try {
      await store.touchHeartbeatV2(store.v2RegistryPath(await this.v2RootOf(agent)), sessionId, now)
    } catch {
      // A missing/corrupt registry surfaces on the next real operation.
    }
  }

  /**
       * Explicitly anchor a workspace root for this session's directory tree.
       * Never invoked implicitly — the anchor file is the only marker later
       * sessions use to adopt this root (spec §3.1/§12.5: a parent directory is
       * never claimed silently).
       * @param agent - anchoring live agent.
       * @param target - explicit root; defaults to the session cwd's parent.
       * @returns the anchored workspace root.
       */
  async initWorkspace(agent: Agent, target?: string): Promise<string> {
    const cwd = this.workspaceOf(agent)
    const root = normalizeCwd(target ?? dirname(cwd))
    if (root !== cwd && !cwd.startsWith(`${root}/`)) {
      throw new CoopError(`workspace root "${root}" must be the current directory or one of its ancestors`, 'COOP_CONFIG_UNSUPPORTED')
    }
    await store.writeWorkspaceFile(store.workspaceAnchorPath(root, this.resolved.docRoot), {
      version: 2,
      root,
      createdAt: Date.now(),
    })
    return root
  }

  /**
       * Enforce per-master node capacity for one role set against already-bound others.
       * @param roles - roles the candidate node wants.
       * @param boundOthers - the master's other fresh bound nodes.
       */
  private assertCapacity(roles: V2Role[], boundOthers: CoopV2RegistryEntry[]): void {
    const workers = boundOthers.filter(candidate => candidate.roles.includes('worker')).length
    const reviewers = boundOthers.filter(candidate => candidate.roles.includes('reviewer')).length
    if (roles.includes('worker') && workers >= this.resolved.maxWorkers) {
      throw new CoopError(`master already holds ${workers} worker(s) (maxWorkers=${String(this.resolved.maxWorkers)})`, 'COOP_NODE_LIMIT_REACHED')
    }
    if (roles.includes('reviewer') && reviewers >= this.resolved.maxReviewers) {
      throw new CoopError(`master already holds ${reviewers} reviewer(s) (maxReviewers=${String(this.resolved.maxReviewers)})`, 'COOP_NODE_LIMIT_REACHED')
    }
  }

  /**
       * Register this session as a v2 node. A master mints (or resumes) its
       * masterId and profile; a worker/reviewer lands `unbound` for any master to
       * adopt, or pre-bound when `masterId` names a live master with spare
       * capacity. Empty roles deregister.
       * @param agent - registering live agent.
       * @param req - target roles, optional owning master, model route, and directory scope.
       * @returns the committed registry entry.
       */
  async registerV2(
    agent: Agent,
    req: { roles: V2Role[]; masterId?: string; model?: string; cwdScope?: CwdScope; skills?: string[] },
  ): Promise<CoopV2RegistryEntry> {
    if (req.roles.length === 0) return this.deregisterV2(agent)
    const sessionId = String(agent.session.id)
    const cwd = this.workspaceOf(agent)
    const scope = req.cwdScope ?? 'cwd'
    const now = Date.now()
    const root = await this.v2RootOf(agent)
    const localPath = store.v2RegistryPath(root)
    const roleRoute = this.roleLlmForRoles(req.roles)
    const paneEnv = process.env.HERDR_PANE_ID
    const meta = req.model === undefined && paneEnv === undefined
      ? {}
      : {
        meta: {
          ...(req.model === undefined && roleRoute === undefined
            ? {}
            : { model: req.model ?? `${String(roleRoute?.provider)}/${String(roleRoute?.model)}` }),
          ...(paneEnv === undefined ? {} : { paneId: paneEnv, spawn: 'herdr' as const }),
        },
      }
    if (req.roles.includes('master')) {
      const entry = await store.mutateV2Registry(localPath, (current) => {
        const existing = (current?.entries ?? []).find(candidate => candidate.sessionId === sessionId && candidate.roles.includes('master'))
        const masterId = existing?.masterId ?? mintMasterId(cwd)
        const next: CoopV2RegistryEntry = {
          sessionId,
          roles: ['master'],
          masterId,
          bindState: 'bound',
          cwd,
          cwdScope: scope,
          updatedAt: now,
          heartbeatAt: now,
          ...meta,
          ...(req.skills === undefined ? {} : { skills: req.skills }),
        }
        return {
          next: { version: 2, entries: [...(current?.entries ?? []).filter(candidate => candidate.sessionId !== sessionId), next] },
          value: next,
        }
      })
      const masterId = entry.masterId
      if (masterId === undefined) throw new CoopError('master registration lost its masterId', 'COOP_CONFIG_UNSUPPORTED')
      await store.writeMasterProfile(store.masterProfilePath(root, String(masterId)), {
        masterId,
        sessionId,
        displayName: String(masterId).split('#')[0] ?? 'master',
        createdAt: now,
        status: 'active',
      })
      if (roleRoute !== undefined) this.applyRoleRoute(agent, roleRoute)
      this.appendMirror(agent.session, 'coop/registry-v2', { op: 'register', roles: ['master'], masterId: String(masterId), bindState: 'bound', updatedAt: now })
      return entry
    }
    const result = await store.mutateV2Registry(localPath, (current) => {
      const entries = current?.entries ?? []
      const others = entries.filter(candidate => candidate.sessionId !== sessionId)
      const next: CoopV2RegistryEntry = {
        sessionId,
        roles: req.roles,
        bindState: 'unbound',
        cwd,
        cwdScope: scope,
        updatedAt: now,
        heartbeatAt: now,
        ...meta,
        ...(req.skills === undefined ? {} : { skills: req.skills }),
      }
      if (req.masterId === undefined) {
        return { next: { version: 2, entries: [...others, next] }, value: { entry: next, masterId: undefined as string | undefined } }
      }
      const master = entries.find(candidate => String(candidate.masterId ?? '') === req.masterId)
      if (master === undefined || !master.roles.includes('master') || !this.isFreshV2(master, now)) {
        throw new CoopError(`master "${req.masterId}" is not a live master in this workspace`, 'COOP_NODE_NOT_FOUND')
      }
      const masterId = master.masterId
      if (masterId === undefined) {
        throw new CoopError(`master "${req.masterId}" is not a live master in this workspace`, 'COOP_NODE_NOT_FOUND')
      }
      const boundOthers = entries.filter(candidate => candidate.bindState === 'bound' && String(candidate.masterId) === String(masterId) && candidate.sessionId !== sessionId && this.isFreshV2(candidate, now))
      this.assertCapacity(req.roles, boundOthers)
      const bound: CoopV2RegistryEntry = { ...next, masterId, bindState: 'bound' }
      return { next: { version: 2, entries: [...others, bound] }, value: { entry: bound, masterId: String(masterId) } }
    })
    if (scope === 'any') {
      await store.mutateV2Registry(this.v2GlobalRegistryPath(), (current) => {
        const others = (current?.entries ?? []).filter(candidate => candidate.sessionId !== sessionId)
        return { next: { version: 2, entries: [...others, result.entry] }, value: undefined }
      })
    }
    if (roleRoute !== undefined) this.applyRoleRoute(agent, roleRoute)
    this.appendMirror(agent.session, 'coop/registry-v2', {
      op: 'register',
      roles: req.roles,
      ...(result.masterId === undefined ? {} : { masterId: result.masterId }),
      bindState: result.entry.bindState,
      updatedAt: now,
    })
    return result.entry
  }

  /**
       * Remove this session's v2 entry; a retiring master's profile is marked
       * `retired` so a later revival can adopt its identity.
       * @param agent - leaving live agent.
       * @returns a synthetic entry describing the now-empty role set.
       */
  private async deregisterV2(agent: Agent): Promise<CoopV2RegistryEntry> {
    const sessionId = String(agent.session.id)
    const cwd = this.workspaceOf(agent)
    const now = Date.now()
    const root = await this.v2RootOf(agent)
    const removed = await store.mutateV2Registry<CoopV2RegistryEntry | undefined>(
      store.v2RegistryPath(root),
      (current): { next?: CoopV2RegistryFile; value: CoopV2RegistryEntry | undefined } => {
        const own = (current?.entries ?? []).find(candidate => candidate.sessionId === sessionId)
        const next = current === undefined
          ? undefined
          : ({ version: 2, entries: current.entries.filter(candidate => candidate.sessionId !== sessionId) } satisfies CoopV2RegistryFile)
        return next === undefined ? { value: own } : { next, value: own }
      })
    if (removed?.roles.includes('master') && removed.masterId !== undefined) {
      const profilePath = store.masterProfilePath(root, String(removed.masterId))
      const profile = await store.readMasterProfile(profilePath)
      if (profile !== undefined) await store.writeMasterProfile(profilePath, { ...profile, status: 'retired' })
    }
    this.roleLlmBySession.delete(sessionId)
    this.appendMirror(agent.session, 'coop/registry-v2', { op: 'off', roles: [], updatedAt: now })
    return removed ?? { sessionId, roles: [], bindState: 'unbound', cwd, cwdScope: 'cwd', updatedAt: now, heartbeatAt: now }
  }

  /**
       * Nodes visible to the caller under v2 isolation: a master sees itself, its
       * bound nodes, and every `unbound` worker/reviewer (the only globally
       * visible window); a worker/reviewer sees itself and its owning master.
       * @param agent - querying live agent.
       * @param opts - `unboundOnly` keeps just adoptable nodes.
       * @returns fresh entries in scope.
       */
  async listNodesV2(agent: Agent, opts: { unboundOnly?: boolean } = {}): Promise<CoopV2RegistryEntry[]> {
    await this.touchOwnEntryV2(agent)
    const now = Date.now()
    const entries = await this.v2Tables(await this.v2RootOf(agent))
    const own = entries.find(entry => entry.sessionId === String(agent.session.id))
    if (own === undefined || !this.isFreshV2(own, now)) {
      throw new CoopError('this session holds no live v2 coop role — register first', 'COOP_NODE_NOT_FOUND')
    }
    if (!own.roles.includes('master')) {
      const master = own.masterId === undefined
        ? undefined
        : entries.find(entry => entry.roles.includes('master') && String(entry.masterId) === String(own.masterId))
      const visible = [own, ...(master === undefined ? [] : [master])].filter(entry => this.isFreshV2(entry, now))
      return opts.unboundOnly ? [] : visible
    }
    const masterId = String(own.masterId)
    const visible = entries.filter((entry) => {
      if (!this.isFreshV2(entry, now)) return false
      if (entry.sessionId === own.sessionId) return true
      if (entry.roles.includes('master')) return false
      if (entry.bindState === 'unbound') return canCommunicate({ cwd: own.cwd, cwdScope: own.cwdScope }, entry)
      return String(entry.masterId) === masterId
    })
    return opts.unboundOnly ? visible.filter(entry => entry.bindState === 'unbound') : visible
  }

  /**
       * Adopt one `unbound` worker/reviewer for the calling master. The bind
       * commits under the registry writer lock; once bound, the node disappears
       * from every other master's view — isolation is enforced by visibility, not
       * by a second lock domain.
       * @param agent - binding live master.
       * @param sessionId - target node session id.
       * @returns the bound entry.
       */
  async bindNode(agent: Agent, sessionId: string): Promise<CoopV2RegistryEntry> {
    const callerId = String(agent.session.id)
    const now = Date.now()
    const root = await this.v2RootOf(agent)
    const bound = await store.mutateV2Registry(store.v2RegistryPath(root), (current) => {
      const entries = current?.entries ?? []
      const caller = entries.find(candidate => candidate.sessionId === callerId)
      if (caller === undefined || !caller.roles.includes('master') || !this.isFreshV2(caller, now)) {
        throw new CoopError('binding requires this session to be a live v2 master', 'COOP_NODE_NOT_FOUND')
      }
      const masterId = caller.masterId
      if (masterId === undefined) throw new CoopError('master entry lacks a masterId', 'COOP_CONFIG_UNSUPPORTED')
      const target = entries.find(candidate => candidate.sessionId === sessionId)
      if (target === undefined || !this.isFreshV2(target, now) || target.roles.includes('master') || target.bindState !== 'unbound' || !canCommunicate({ cwd: caller.cwd, cwdScope: caller.cwdScope }, target)) {
        throw new CoopError(`"${sessionId}" is not a visible unbound v2 node`, 'COOP_NODE_NOT_FOUND')
      }
      const boundOthers = entries.filter(candidate => candidate.bindState === 'bound' && String(candidate.masterId) === String(masterId) && candidate.sessionId !== sessionId && this.isFreshV2(candidate, now))
      this.assertCapacity(target.roles, boundOthers)
      const next: CoopV2RegistryEntry = { ...target, masterId, bindState: 'bound', updatedAt: now }
      return {
        next: { version: 2, entries: entries.map(candidate => candidate.sessionId === sessionId ? next : candidate) },
        value: next,
      }
    })
    this.appendMirror(agent.session, 'coop/registry-v2', { op: 'bind', roles: bound.roles, masterId: String(bound.masterId), bindState: 'bound', updatedAt: now })
    await this.deliverV2(callerId, sessionId, root, `bound by master ${String(bound.masterId)} — you now take task signals from this master only`)
    return bound
  }

  /**
       * Return one bound node to the `unbound` pool; only its owning master may.
       * @param agent - releasing live master.
       * @param sessionId - target node session id.
       */
  async releaseNode(agent: Agent, sessionId: string): Promise<void> {
    const callerId = String(agent.session.id)
    const now = Date.now()
    const root = await this.v2RootOf(agent)
    const masterId = await store.mutateV2Registry(store.v2RegistryPath(root), (current) => {
      const entries = current?.entries ?? []
      const caller = entries.find(candidate => candidate.sessionId === callerId)
      if (caller === undefined || !caller.roles.includes('master') || caller.masterId === undefined) {
        throw new CoopError('release requires this session to be a v2 master', 'COOP_NODE_NOT_FOUND')
      }
      const target = entries.find(candidate => candidate.sessionId === sessionId)
      if (target === undefined || target.bindState !== 'bound' || String(target.masterId) !== String(caller.masterId)) {
        throw new CoopError(`"${sessionId}" is not bound to this master`, 'COOP_NOT_YOUR_NODE')
      }
      const { masterId: _dropped, ...rest } = target
      const released: CoopV2RegistryEntry = { ...rest, bindState: 'unbound', updatedAt: now }
      return {
        next: { version: 2, entries: entries.map(candidate => candidate.sessionId === sessionId ? released : candidate) },
        value: String(caller.masterId),
      }
    })
    this.appendMirror(agent.session, 'coop/registry-v2', { op: 'release', roles: [], masterId, updatedAt: now })
    await this.deliverV2(callerId, sessionId, root, 'released by your master — you are unbound and visible to every master again')
  }

  /**
       * Human/model summary across the workspace: live masters, the caller's own
       * nodes, and the adoptable unbound count. Cross-master detail stays
       * summarized — isolation applies to agents, not to the human operator.
       * @param agent - querying live agent.
       * @returns the caller's entry, master ids, own nodes, and unbound count.
       */
  async statusV2(agent: Agent): Promise<{
    self: CoopV2RegistryEntry | undefined
    masters: string[]
    own: CoopV2RegistryEntry[]
    unbound: number
  }> {
    await this.touchOwnEntryV2(agent)
    const now = Date.now()
    const entries = (await this.v2Tables(await this.v2RootOf(agent))).filter(entry => this.isFreshV2(entry, now))
    const own = entries.find(entry => entry.sessionId === String(agent.session.id))
    const masters = [...new Set(entries.filter(entry => entry.roles.includes('master')).map(entry => String(entry.masterId)))]
    const ownNodes = own?.roles.includes('master') === true && own.masterId !== undefined
      ? entries.filter(entry => entry.bindState === 'bound' && String(entry.masterId) === String(own.masterId))
      : []
    const unbound = entries.filter(entry => entry.bindState === 'unbound' && !entry.roles.includes('master')).length
    return { self: own, masters, own: ownNodes, unbound }
  }

  /**
       * Append one v2 node signal and drain the target when it is live in-process.
       * @param fromId - sending session id.
       * @param targetId - receiving session id.
       * @param root - absolute v2 root carrying the inbox.
       * @param summary - one-line notice text.
       */
  private async deliverV2(fromId: string, targetId: string, root: string, summary: string): Promise<void> {
    await store.appendSignal(store.inboxPath(root, targetId), {
      time: Date.now(),
      from: fromId,
      planId: '',
      kind: 'node',
      summary,
      docPath: '',
    })
    const target = this.ctx.agents.get(SessionId(targetId))
    if (target !== undefined) await this.drainAgentInbox(target, root)
  }

  /**
       * The caller's live master entry plus the v2 root; every master-owned plan
       * operation funnels through this gate.
       * @param agent - acting live agent.
       * @returns the master id and v2 root.
       */
  private async requireV2Master(agent: Agent): Promise<{ masterId: MasterId; root: string }> {
    const root = await this.v2RootOf(agent)
    const now = Date.now()
    const own = (await this.v2Tables(root)).find(entry => entry.sessionId === String(agent.session.id))
    if (own === undefined || !own.roles.includes('master') || !this.isFreshV2(own, now)) {
      throw new CoopError('this operation requires this session to be a live v2 master', 'COOP_NODE_NOT_FOUND')
    }
    const { masterId } = own
    if (masterId === undefined) throw new CoopError('master entry lacks a masterId', 'COOP_CONFIG_UNSUPPORTED')
    return { masterId, root }
  }

  /**
       * Resolve one plan visible to the calling node: masters reach their own
       * plans; bound workers/reviewers reach their owning master's plans. Unbound
       * nodes and cross-master ids see nothing (isolation by visibility).
       * @param agent - acting live node.
       * @param planId - plan to resolve.
       * @returns the plan snapshot and the v2 root.
       */
  private async planForNode(agent: Agent, planId: string): Promise<{ plan: CoopV2PlanFile; root: string }> {
    const root = await this.v2RootOf(agent)
    const now = Date.now()
    const own = (await this.v2Tables(root)).find(entry => entry.sessionId === String(agent.session.id))
    if (own === undefined || !this.isFreshV2(own, now)) {
      throw new CoopError('this session holds no live v2 coop role — register first', 'COOP_NODE_NOT_FOUND')
    }
    const masterId = own.masterId
    if (masterId === undefined) {
      throw new CoopError('this node is not bound to a master', 'COOP_NODE_NOT_FOUND')
    }
    const plan = await store.readV2PlanFile(store.v2PlanPath(root, String(masterId), planId))
    if (plan === undefined) throw new CoopError(`plan "${planId}" not found`, 'COOP_PLAN_NOT_FOUND')
    return { plan, root }
  }

  /**
       * Assign ready tasks of the master's active plans to idle bound workers.
       * Single-writer per master (the acting process); each assignment commits
       * under its plan's writer lock and the busy set is rebuilt from a fresh scan
       * of every active plan, so `maxParallelTasks` holds across plans. A worker
       * without declared skills only receives tasks with no skill demand.
       * @param root - absolute v2 root.
       * @param masterId - owning master id.
       * @returns how many tasks were assigned.
       */
  private async scheduleV2(root: string, masterId: string): Promise<number> {
    const now = Date.now()
    const entries = await this.v2Tables(root)
    const workers = entries.filter(entry => entry.bindState === 'bound'
          && String(entry.masterId) === masterId
          && entry.roles.includes('worker')
          && this.isFreshV2(entry, now))
    if (workers.length === 0) return 0
    const dir = store.v2PlansDir(root, masterId)
    let names: string[]
    try {
      names = await readdir(dir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return 0
      throw error
    }
    const planIds = names.filter(name => name.endsWith('.json')).map(name => name.replace(/\.json$/u, ''))
    const busy = new Set<string>()
    const usedWorktrees = new Set<string>()
    const wtEntries = (await store.readWtRegistry(store.wtRegistryPath(root)))?.entries ?? []
    let inflight = 0
    for (const planId of planIds) {
      const plan = await store.readV2PlanFile(store.v2PlanPath(root, masterId, planId))
      if (plan?.status !== 'active') continue
      for (const task of plan.tasks) {
        if (task.assignee !== undefined && (task.status === 'assigned' || task.status === 'executing')) {
          busy.add(task.assignee)
          inflight++
        }
        if (task.worktreeId !== undefined && task.status !== 'done' && task.status !== 'cancelled') {
          usedWorktrees.add(task.worktreeId)
        }
      }
    }
    let assigned = 0
    for (const planId of planIds) {
      if (inflight + assigned >= this.resolved.maxParallelTasks) break
      const path = store.v2PlanPath(root, masterId, planId)
      const taken = await store.mutateV2Plan(path, (current): { next?: CoopV2PlanFile; value: CoopV2Task[] } => {
        if (current === undefined || current.status !== 'active') return { value: [] }
        let plan = watchTasks(recomputeReady(current, Date.now()), Date.now(), this.resolved.executingStaleMs)
        const picked: CoopV2Task[] = []
        for (const task of plan.tasks) {
          if (task.status !== 'ready') continue
          if (inflight + picked.length >= this.resolved.maxParallelTasks) break
          const free = workers.filter(worker => !busy.has(worker.sessionId)
                && task.skills.every(skill => (worker.skills ?? []).includes(skill)))
          const match = free[0]
          if (match === undefined) continue
          let worktreeId = task.worktreeId
          if (worktreeId === undefined) {
            const freeWorktree = wtEntries.find(candidate => candidate.planId === planId
              && candidate.status === 'active'
              && !usedWorktrees.has(candidate.dir))
            if (freeWorktree !== undefined) {
              worktreeId = freeWorktree.dir
              usedWorktrees.add(freeWorktree.dir)
            }
          }
          const next: CoopV2Task = {
            ...task,
            status: 'assigned',
            assignee: match.sessionId,
            updatedAt: Date.now(),
            ...(task.assignedAt === undefined ? { assignedAt: Date.now() } : {}),
            ...(worktreeId === undefined ? {} : { worktreeId }),
          }
          plan = {
            ...plan,
            tasks: plan.tasks.map(candidate => candidate.taskId === task.taskId ? next : candidate),
          }
          picked.push(next)
        }
        if (picked.length === 0) return plan === current ? { value: [] } : { next: plan, value: [] }
        return { next: plan, value: picked }
      })
      for (const task of taken) {
        if (task.assignee === undefined) continue
        busy.add(task.assignee)
        assigned++
        const workOrder = task.executor === 'subagent'
          ? 'delegate the work to a subagent with the task spec as its objective, then coop_execute_report'
          : 'do the work per the spec, then coop_execute_report'
        await this.deliverTask(root, masterId, task.assignee, planId, masterId, task,
          `task assigned — call coop_execute_begin(planId="${planId}", taskId="${task.taskId}"), ${workOrder}${task.worktreeId === undefined ? '' : ` in worktree ${task.worktreeId}`}`)
      }
    }
    return assigned
  }

  /**
       * Append one task signal and drain the target when it is live in-process.
       * @param root - absolute v2 root.
       * @param fromId - acting node id (master id or session id).
       * @param targetId - receiving session id.
       * @param planId - owning plan id.
       * @param masterId - owning master id (for the doc path).
       * @param task - task the notice is about.
       * @param text - one-line notice text.
       */
  private async deliverTask(
    root: string,
    fromId: string,
    targetId: string,
    planId: string,
    masterId: string,
    task: CoopV2Task,
    text: string,
  ): Promise<void> {
    await store.appendSignal(store.inboxPath(root, targetId), {
      time: Date.now(),
      from: fromId,
      planId,
      kind: 'task',
      summary: `${task.taskId} (${task.title}) — ${text}`,
      docPath: store.v2DocPath(root, masterId, planId),
    })
    const target = this.ctx.agents.get(SessionId(targetId))
    if (target !== undefined) await this.drainAgentInbox(target, root)
  }

  /**
       * Create a v2 plan bound to one repo root (§12.1: no cross-repo plans).
       * Master-only; the plan lands `designing` with an empty DAG and a markdown
       * trail. P3 routes activation through reviewer sign-off.
       * @param agent - creating live master.
       * @param req - title, objective, and optional repo root (defaults to the cwd).
       * @returns the committed designing plan.
       */
  async createPlanV2(agent: Agent, req: { title: string; objective: string; repoRoot?: string }): Promise<CoopV2PlanFile> {
    const sessionId = String(agent.session.id)
    const cwd = this.workspaceOf(agent)
    const { masterId, root } = await this.requireV2Master(agent)
    const planId = `plan-${randomUUID()}`
    const now = Date.now()
    const plan: CoopV2PlanFile = {
      version: 2,
      planId,
      masterId,
      repoRoot: normalizeCwd(req.repoRoot ?? cwd),
      title: req.title,
      objective: req.objective,
      status: 'designing',
      createdBy: sessionId,
      cwd,
      createdAt: now,
      tasks: [],
      edges: [],
      history: [{ time: now, sessionId, op: 'create' }],
    }
    await store.appendDocSection(store.v2DocPath(root, String(masterId), planId), [
      `# ${req.title}`,
      '',
      '## Objective',
      '',
      req.objective,
      '',
      `Plan ${planId} · master ${String(masterId)} · repo ${plan.repoRoot}`,
      '',
      '## Changelog',
      '',
      `- ${new Date(now).toISOString()} created by ${sessionId} (designing)`,
      '',
    ].join('\n'))
    await store.writeV2PlanFile(store.v2PlanPath(root, String(masterId), planId), plan)
    return plan
  }

  /**
       * Submit a designing plan to review (master only): designing → reviewing
       * and every fresh bound reviewer is woken (§6.3).
       * @param agent - submitting live master.
       * @param planId - plan to submit.
       * @returns the committed reviewing plan.
       */
  async submitReviewV2(agent: Agent, planId: string): Promise<CoopV2PlanFile> {
    const { masterId, root } = await this.requireV2Master(agent)
    const sessionId = String(agent.session.id)
    const now = Date.now()
    const masterIdStr = String(masterId)
    const plan = await store.mutateV2Plan(
      store.v2PlanPath(root, masterIdStr, planId),
      (current): { next?: CoopV2PlanFile; value: CoopV2PlanFile } => {
        if (current === undefined) throw new CoopError(`plan "${planId}" not found`, 'COOP_PLAN_NOT_FOUND')
        if (current.status !== 'designing') {
          throw new CoopError(`plan "${planId}" is "${current.status}", expected designing`, 'COOP_INVALID_TRANSITION')
        }
        const next: CoopV2PlanFile = {
          ...current,
          status: 'reviewing',
          history: [...current.history, { time: now, sessionId, op: 'submit_review' }],
        }
        return { next, value: next }
      })
    const reviewers = (await this.v2Tables(root)).filter(entry => entry.bindState === 'bound'
          && String(entry.masterId) === masterIdStr
          && entry.roles.includes('reviewer')
          && this.isFreshV2(entry, Date.now()))
    for (const reviewer of reviewers) {
      await this.deliverPlan(root, sessionId, reviewer.sessionId, planId, masterIdStr, plan,
        `plan ready for review — call coop_plan_review(planId="${planId}", decision) after judging the DAG against the objective`)
    }
    return plan
  }

  /**
       * Reviewer gate on a submitted plan (§6.3): pass → active (readiness
       * recomputed, scheduler runs); request_changes → designing for the master
       * to revise and resubmit. Gate: a reviewer bound to the owning master, or
       * the master with `allowSelfReview` (§12.4).
       * @param agent - reviewing live reviewer (or self-reviewing master).
       * @param planId - plan under review.
       * @param decision - pass or request_changes.
       * @param summary - one-line rationale.
       * @returns the committed plan.
       */
  async reviewPlanV2(
    agent: Agent,
    planId: string,
    decision: 'pass' | 'request_changes',
    summary?: string,
  ): Promise<CoopV2PlanFile> {
    const sessionId = String(agent.session.id)
    const root = await this.v2RootOf(agent)
    const now = Date.now()
    const own = (await this.v2Tables(root)).find(entry => entry.sessionId === sessionId)
    if (own === undefined || !this.isFreshV2(own, now)) {
      throw new CoopError('this session holds no live v2 coop role — register first', 'COOP_NODE_NOT_FOUND')
    }
    const masterId = own.masterId
    if (masterId === undefined) {
      throw new CoopError('this node is not bound to a master', 'COOP_NODE_NOT_FOUND')
    }
    const isReviewer = own.roles.includes('reviewer')
    const isMaster = own.roles.includes('master')
    if (!isReviewer && !(isMaster && this.resolved.allowSelfReview)) {
      throw new CoopError('plan review requires a reviewer bound to this master (or allowSelfReview)', 'COOP_NOT_ASSIGNED_WORKER')
    }
    const masterIdStr = String(masterId)
    const plan = await store.mutateV2Plan(
      store.v2PlanPath(root, masterIdStr, planId),
      (current): { next?: CoopV2PlanFile; value: CoopV2PlanFile } => {
        if (current === undefined) throw new CoopError(`plan "${planId}" not found`, 'COOP_PLAN_NOT_FOUND')
        if (current.status !== 'reviewing') {
          throw new CoopError(`plan "${planId}" is "${current.status}", expected reviewing`, 'COOP_INVALID_TRANSITION')
        }
        const at = Date.now()
        const status = decision === 'pass' ? 'active' : 'designing'
        const staged: CoopV2PlanFile = {
          ...current,
          status,
          history: [...current.history, { time: at, sessionId, op: `plan_review ${decision}`, ...(summary === undefined ? {} : { summary }) }],
        }
        const next = decision === 'pass' ? recomputeReady(staged, at) : staged
        return { next, value: next }
      })
    const masterEntry = (await this.v2Tables(root)).find(entry => entry.roles.includes('master') && String(entry.masterId) === masterIdStr)
    if (masterEntry !== undefined) {
      await this.deliverPlan(root, sessionId, masterEntry.sessionId, planId, masterIdStr, plan,
        decision === 'pass'
          ? 'plan review passed — plan is active; ready tasks are being scheduled'
          : `plan review requested changes${summary === undefined ? '' : `: ${summary}`} — revise the DAG, then coop_plan_submit_review again`)
    }
    if (decision === 'pass') await this.scheduleV2(root, masterIdStr)
    return plan
  }


  /**
       * Add one task to a non-terminal plan; `dependsOn` becomes DAG edges and a
       * cycle is rejected under the plan lock. Schedules afterwards.
       * @param agent - adding live master.
       * @param planId - target plan.
       * @param req - title, spec, dependencies, executor style, and skill demands.
       * @returns the committed task.
       */
  async addTaskV2(
    agent: Agent,
    planId: string,
    req: {
      title: string
      spec: string
      dependsOn?: string[]
      executor?: 'inline' | 'subagent'
      skills?: string[]
      worktreeId?: string
      deadlines?: { softMs?: number; hardMs?: number }
    },
  ): Promise<CoopV2Task> {
    const { masterId, root } = await this.requireV2Master(agent)
    const sessionId = String(agent.session.id)
    const task = await store.mutateV2Plan(
      store.v2PlanPath(root, String(masterId), planId),
      (current): { next?: CoopV2PlanFile; value: CoopV2Task } => {
        if (current === undefined) throw new CoopError(`plan "${planId}" not found`, 'COOP_PLAN_NOT_FOUND')
        if (current.status === 'closed' || current.status === 'aborted') {
          throw new CoopError(`plan "${planId}" is terminal (${current.status})`, 'COOP_INVALID_TRANSITION')
        }
        const taskId = `t${current.tasks.length + 1}`
        const dependsOn = req.dependsOn ?? []
        for (const dep of dependsOn) {
          if (!current.tasks.some(candidate => candidate.taskId === dep)) {
            throw new CoopError(`task "${dep}" does not exist in plan "${planId}"`, 'COOP_TASK_NOT_FOUND')
          }
        }
        const edges = [...current.edges, ...dependsOn.map(from => ({ from, to: taskId }))]
        const cycle = detectCycle(edges)
        if (cycle !== undefined) {
          throw new CoopError(`edge would create a cycle: ${cycle.join(' → ')}`, 'COOP_DAG_CYCLE_REJECTED')
        }
        const now = Date.now()
        const fresh: CoopV2Task = {
          taskId,
          title: req.title,
          spec: req.spec,
          status: 'pending',
          dependsOn,
          executor: req.executor ?? 'inline',
          skills: req.skills ?? [],
          ...(req.worktreeId === undefined ? {} : { worktreeId: req.worktreeId }),
          ...(req.deadlines === undefined ? {} : { deadlines: req.deadlines }),
          attempts: 0,
          createdAt: now,
          updatedAt: now,
        }
        const staged: CoopV2PlanFile = {
          ...current,
          tasks: [...current.tasks, fresh],
          edges,
          history: [...current.history, { time: now, sessionId, op: `task_add ${taskId}` }],
        }
        const next = recomputeReady(staged, now)
        const committed = next.tasks.find(candidate => candidate.taskId === taskId)
        if (committed === undefined) throw new CoopError('task vanished in commit', 'COOP_CONFIG_UNSUPPORTED')
        return { next, value: committed }
      })
    await this.scheduleV2(root, String(masterId))
    return task
  }

  /**
       * Update a task's brief while it is not in flight (executing/reporting/
       * verifying tasks are locked).
       * @param agent - updating live master.
       * @param planId - owning plan.
       * @param taskId - target task.
       * @param req - optional title, spec, executor style, and skill demands.
       * @returns the committed task.
       */
  async updateTaskV2(
    agent: Agent,
    planId: string,
    taskId: string,
    req: { title?: string; spec?: string; executor?: 'inline' | 'subagent'; skills?: string[] },
  ): Promise<CoopV2Task> {
    const { masterId, root } = await this.requireV2Master(agent)
    const sessionId = String(agent.session.id)
    return store.mutateV2Plan(
      store.v2PlanPath(root, String(masterId), planId),
      (current): { next?: CoopV2PlanFile; value: CoopV2Task } => {
        if (current === undefined) throw new CoopError(`plan "${planId}" not found`, 'COOP_PLAN_NOT_FOUND')
        const task = current.tasks.find(candidate => candidate.taskId === taskId)
        if (task === undefined) throw new CoopError(`task "${taskId}" not found in plan "${planId}"`, 'COOP_TASK_NOT_FOUND')
        if (task.status === 'executing' || task.status === 'reporting' || task.status === 'verifying') {
          throw new CoopError(`task "${taskId}" is "${task.status}" and locked while in flight`, 'COOP_INVALID_TRANSITION')
        }
        const now = Date.now()
        const next: CoopV2Task = {
          ...task,
          ...(req.title === undefined ? {} : { title: req.title }),
          ...(req.spec === undefined ? {} : { spec: req.spec }),
          ...(req.executor === undefined ? {} : { executor: req.executor }),
          ...(req.skills === undefined ? {} : { skills: req.skills }),
          updatedAt: now,
        }
        const plan: CoopV2PlanFile = {
          ...current,
          tasks: current.tasks.map(candidate => candidate.taskId === taskId ? next : candidate),
          history: [...current.history, { time: now, sessionId, op: `task_update ${taskId}` }],
        }
        return { next: plan, value: next }
      })
  }

  /**
       * Add one dependency edge (`from` finishing unblocks `to`) to a
       * non-terminal plan; cycles reject under the lock. Idempotent.
       * @param agent - linking live master.
       * @param planId - owning plan.
       * @param req - upstream and downstream task ids.
       */
  async linkTaskV2(agent: Agent, planId: string, req: { from: string; to: string }): Promise<void> {
    const { masterId, root } = await this.requireV2Master(agent)
    const sessionId = String(agent.session.id)
    await store.mutateV2Plan(store.v2PlanPath(root, String(masterId), planId), (current): { next?: CoopV2PlanFile; value: undefined } => {
      if (current === undefined) throw new CoopError(`plan "${planId}" not found`, 'COOP_PLAN_NOT_FOUND')
      if (current.status === 'closed' || current.status === 'aborted') {
        throw new CoopError(`plan "${planId}" is terminal (${current.status})`, 'COOP_INVALID_TRANSITION')
      }
      const { from, to } = req
      const target = current.tasks.find(candidate => candidate.taskId === to)
      if (target === undefined || !current.tasks.some(candidate => candidate.taskId === from)) {
        throw new CoopError(`link targets "${from}"/"${to}" do not both exist in plan "${planId}"`, 'COOP_TASK_NOT_FOUND')
      }
      if (current.edges.some(edge => edge.from === from && edge.to === to)) return { value: undefined }
      const edges = [...current.edges, { from, to }]
      const cycle = detectCycle(edges)
      if (cycle !== undefined) {
        throw new CoopError(`edge would create a cycle: ${cycle.join(' → ')}`, 'COOP_DAG_CYCLE_REJECTED')
      }
      const now = Date.now()
      const staged: CoopV2PlanFile = {
        ...current,
        tasks: current.tasks.map(candidate => candidate.taskId === to
          ? { ...candidate, dependsOn: [...new Set([...candidate.dependsOn, from])] }
          : candidate),
        edges,
        history: [...current.history, { time: now, sessionId, op: `task_link ${from}→${to}` }],
      }
      return { next: recomputeReady(staged, now), value: undefined }
    })
    await this.scheduleV2(root, String(masterId))
  }

  /**
       * Cancel one task of a non-terminal plan; an in-flight task's assignee is
       * signalled, downstream dependencies go blocked, and capacity is freed.
       * @param agent - cancelling live master.
       * @param planId - owning plan.
       * @param taskId - target task.
       */
  async cancelTaskV2(agent: Agent, planId: string, taskId: string): Promise<void> {
    const { masterId, root } = await this.requireV2Master(agent)
    const sessionId = String(agent.session.id)
    const outcome = await store.mutateV2Plan(
      store.v2PlanPath(root, String(masterId), planId),
      (current): { next?: CoopV2PlanFile; value: { task?: CoopV2Task; changed: boolean } } => {
        if (current === undefined) throw new CoopError(`plan "${planId}" not found`, 'COOP_PLAN_NOT_FOUND')
        if (current.status === 'closed' || current.status === 'aborted') {
          throw new CoopError(`plan "${planId}" is terminal (${current.status})`, 'COOP_INVALID_TRANSITION')
        }
        const task = current.tasks.find(candidate => candidate.taskId === taskId)
        if (task === undefined) throw new CoopError(`task "${taskId}" not found in plan "${planId}"`, 'COOP_TASK_NOT_FOUND')
        if (task.status === 'done' || task.status === 'cancelled') return { value: { task, changed: false } }
        const now = Date.now()
        const next: CoopV2Task = { ...task, status: 'cancelled', updatedAt: now }
        const staged: CoopV2PlanFile = {
          ...current,
          tasks: current.tasks.map(candidate => candidate.taskId === taskId ? next : candidate),
          history: [...current.history, { time: now, sessionId, op: `task_cancel ${taskId}` }],
        }
        return { next: recomputeReady(staged, now), value: { task: next, changed: true } }
      })
    if (outcome.changed && outcome.task !== undefined && outcome.task.assignee !== undefined) {
      await this.deliverTask(root, String(masterId), outcome.task.assignee, planId, String(masterId), outcome.task,
        'task cancelled — drop it and stand by for the next assignment')
    }
    if (outcome.changed) await this.scheduleV2(root, String(masterId))
  }

  /**
       * Kanban projection: one plan (or every plan of the caller's master) with
       * lazily recomputed readiness. Read-only for the caller.
       * @param agent - querying live master.
       * @param planId - optional single plan id.
       * @returns the plan snapshots.
       */
  async boardV2(agent: Agent, planId?: string): Promise<CoopV2PlanFile[]> {
    const { masterId, root } = await this.requireV2Master(agent)
    const dir = store.v2PlansDir(root, String(masterId))
    let names: string[]
    try {
      names = await readdir(dir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
        if (planId !== undefined) throw new CoopError(`plan "${planId}" not found`, 'COOP_PLAN_NOT_FOUND')
        return []
      }
      throw error
    }
    const ids = planId === undefined
      ? names.filter(name => name.endsWith('.json')).map(name => name.replace(/\.json$/u, ''))
      : [planId]
    const plans: CoopV2PlanFile[] = []
    for (const id of ids) {
      const plan = await store.mutateV2Plan(
        store.v2PlanPath(root, String(masterId), id),
        (current): { next?: CoopV2PlanFile; value: CoopV2PlanFile | undefined } => {
          if (current === undefined) {
            if (planId !== undefined) throw new CoopError(`plan "${planId}" not found`, 'COOP_PLAN_NOT_FOUND')
            return { value: undefined }
          }
          const next = watchTasks(recomputeReady(current, Date.now()), Date.now(), this.resolved.executingStaleMs)
          return next === current ? { value: current } : { next, value: next }
        })
      if (plan !== undefined) plans.push(plan)
    }
    return plans
  }

  /**
       * Assigned worker starts (or restarts after rework): assigned/rework →
       * executing. Only the task's assignee may begin.
       * @param agent - assigned live worker.
       * @param planId - owning plan.
       * @param taskId - target task.
       * @returns the committed executing task.
       */
  async executeBeginV2(agent: Agent, planId: string, taskId: string): Promise<CoopV2Task> {
    const sessionId = String(agent.session.id)
    const { plan, root } = await this.planForNode(agent, planId)
    return store.mutateV2Plan(
      store.v2PlanPath(root, String(plan.masterId), planId),
      (current): { next?: CoopV2PlanFile; value: CoopV2Task } => {
        if (current === undefined) throw new CoopError(`plan "${planId}" not found`, 'COOP_PLAN_NOT_FOUND')
        const task = current.tasks.find(candidate => candidate.taskId === taskId)
        if (task === undefined) throw new CoopError(`task "${taskId}" not found in plan "${planId}"`, 'COOP_TASK_NOT_FOUND')
        if (task.assignee !== sessionId) {
          throw new CoopError(`task "${taskId}" is assigned to "${task.assignee ?? 'nobody'}"`, 'COOP_NOT_ASSIGNED_WORKER')
        }
        if (task.status !== 'assigned' && task.status !== 'rework') {
          throw new CoopError(`task "${taskId}" is "${task.status}", expected assigned/rework`, 'COOP_INVALID_TRANSITION')
        }
        const now = Date.now()
        const next: CoopV2Task = {
          ...task,
          status: 'executing',
          updatedAt: now,
          execution: { startedAt: now, heartbeatAt: now },
        }
        const planNext: CoopV2PlanFile = {
          ...current,
          tasks: current.tasks.map(candidate => candidate.taskId === taskId ? next : candidate),
          history: [...current.history, { time: now, sessionId, op: `execute_begin ${taskId}` }],
        }
        return { next: planNext, value: next }
      })
  }

  /**
       * Assigned worker reports finished execution: executing → verifying, then
       * the master and every fresh bound reviewer are woken to verify and the
       * freed worker becomes schedulable again.
       * @param agent - reporting live worker.
       * @param planId - owning plan.
       * @param taskId - target task.
       * @param summary - what was done.
       * @returns the committed verifying task.
       */
  async executeReportV2(agent: Agent, planId: string, taskId: string, summary: string): Promise<CoopV2Task> {
    const sessionId = String(agent.session.id)
    const { plan, root } = await this.planForNode(agent, planId)
    const masterId = String(plan.masterId)
    const reported = await store.mutateV2Plan(
      store.v2PlanPath(root, masterId, planId),
      (current): { next?: CoopV2PlanFile; value: CoopV2Task } => {
        if (current === undefined) throw new CoopError(`plan "${planId}" not found`, 'COOP_PLAN_NOT_FOUND')
        const task = current.tasks.find(candidate => candidate.taskId === taskId)
        if (task === undefined) throw new CoopError(`task "${taskId}" not found in plan "${planId}"`, 'COOP_TASK_NOT_FOUND')
        if (task.assignee !== sessionId) {
          throw new CoopError(`task "${taskId}" is assigned to "${task.assignee ?? 'nobody'}"`, 'COOP_NOT_ASSIGNED_WORKER')
        }
        if (task.status !== 'executing') {
          throw new CoopError(`task "${taskId}" is "${task.status}", expected executing`, 'COOP_INVALID_TRANSITION')
        }
        const now = Date.now()
        const next: CoopV2Task = {
          ...task,
          status: 'verifying',
          updatedAt: now,
          report: { summary, by: sessionId, at: now },
        }
        const planNext: CoopV2PlanFile = {
          ...current,
          tasks: current.tasks.map(candidate => candidate.taskId === taskId ? next : candidate),
          history: [...current.history, { time: now, sessionId, op: `execute_report ${taskId}`, summary }],
        }
        return { next: planNext, value: next }
      })
    const now = Date.now()
    const entries = await this.v2Tables(root)
    const masterEntry = entries.find(entry => entry.roles.includes('master') && String(entry.masterId) === masterId)
    const reviewers = entries.filter(entry => entry.bindState === 'bound'
          && String(entry.masterId) === masterId
          && entry.roles.includes('reviewer')
          && this.isFreshV2(entry, now))
    const text = `execution reported — call coop_task_verify(planId="${planId}", taskId="${taskId}", decision)`
    if (masterEntry !== undefined) {
      await this.deliverTask(root, sessionId, masterEntry.sessionId, planId, masterId, reported, text)
    }
    for (const reviewer of reviewers) {
      await this.deliverTask(root, sessionId, reviewer.sessionId, planId, masterId, reported, text)
    }
    await this.scheduleV2(root, masterId)
    return reported
  }

  /**
       * Verify one reported task. Gate: a reviewer bound to the owning master,
       * or the master itself when `allowSelfReview` is on (§12.4, default off).
       * pass → done (downstream goes ready, capacity freed, scheduler runs);
       * request_changes → rework with `attempts` incremented and the assignee
       * re-signalled to begin again.
       * @param agent - verifying live reviewer (or self-reviewing master).
       * @param planId - owning plan.
       * @param taskId - target task.
       * @param decision - pass or request_changes.
       * @param summary - acceptance rationale or rework demand.
       * @returns the committed task.
       */
  async verifyTaskV2(
    agent: Agent,
    planId: string,
    taskId: string,
    decision: 'pass' | 'request_changes',
    summary?: string,
  ): Promise<CoopV2Task> {
    const sessionId = String(agent.session.id)
    const { plan, root } = await this.planForNode(agent, planId)
    const masterId = String(plan.masterId)
    const now = Date.now()
    const own = (await this.v2Tables(root)).find(entry => entry.sessionId === sessionId)
    if (own === undefined || !this.isFreshV2(own, now)) {
      throw new CoopError('this session holds no live v2 coop role — register first', 'COOP_NODE_NOT_FOUND')
    }
    const isReviewer = own.roles.includes('reviewer') && String(own.masterId) === masterId
    const isMaster = own.roles.includes('master') && String(own.masterId) === masterId
    if (!isReviewer && !(isMaster && this.resolved.allowSelfReview)) {
      throw new CoopError('task verification requires a reviewer bound to this master (or allowSelfReview)', 'COOP_NOT_ASSIGNED_WORKER')
    }
    const verified = await store.mutateV2Plan(
      store.v2PlanPath(root, masterId, planId),
      (current): { next?: CoopV2PlanFile; value: CoopV2Task } => {
        if (current === undefined) throw new CoopError(`plan "${planId}" not found`, 'COOP_PLAN_NOT_FOUND')
        const task = current.tasks.find(candidate => candidate.taskId === taskId)
        if (task === undefined) throw new CoopError(`task "${taskId}" not found in plan "${planId}"`, 'COOP_TASK_NOT_FOUND')
        if (task.status !== 'verifying') {
          throw new CoopError(`task "${taskId}" is "${task.status}", expected verifying`, 'COOP_INVALID_TRANSITION')
        }
        const at = Date.now()
        const attempts = task.attempts + 1
        const escalated = decision !== 'pass' && attempts >= this.resolved.maxReworkAttempts
        const next: CoopV2Task = {
          ...task,
          status: decision === 'pass' ? 'done' : (escalated ? 'blocked' : 'rework'),
          updatedAt: at,
          ...(decision === 'pass' ? {} : { attempts }),
          verify: { decision, ...(summary === undefined ? {} : { summary }), by: sessionId, at },
        }
        const staged: CoopV2PlanFile = {
          ...current,
          tasks: current.tasks.map(candidate => candidate.taskId === taskId ? next : candidate),
          history: [...current.history, { time: at, sessionId, op: `task_verify ${taskId} ${decision}`, ...(summary === undefined ? {} : { summary }) }],
        }
        return { next: recomputeReady(staged, at), value: next }
      })
    if (verified.assignee !== undefined) {
      const text = decision === 'pass'
        ? 'verify passed — task done; you are free for the next assignment'
        : verified.status === 'blocked'
          ? `rework budget exhausted (attempts ${String(verified.attempts)}) — task blocked; stop working on it, your master decides`
          : `rework requested${summary === undefined ? '' : `: ${summary}`} — call coop_execute_begin again, address the feedback, then coop_execute_report`
      await this.deliverTask(root, sessionId, verified.assignee, planId, masterId, verified, text)
    }
    if (verified.status === 'blocked') {
      const masterEntry = (await this.v2Tables(root)).find(entry => entry.roles.includes('master') && String(entry.masterId) === masterId)
      if (masterEntry !== undefined) {
        await this.deliverTask(root, sessionId, masterEntry.sessionId, planId, masterId, verified,
          `task ${verified.taskId} blocked — rework budget exhausted; cancel, revise, or re-scope it`)
      }
    }
    if (decision === 'pass') {
      await this.recordMemory(root, masterId, {
        time: Date.now(),
        kind: 'task',
        ref: `${verified.taskId}@${planId}`,
        title: verified.title,
        summary: verified.report?.summary ?? 'completed',
        ...(verified.verify?.summary === undefined ? {} : { lessons: [verified.verify.summary] }),
      })
      await this.scheduleV2(root, masterId)
    }
    return verified
  }

  /**
       * Close a finished plan: every task must be done or cancelled. P2 inserts
       * worktree merge/clean ahead of this step.
       * @param agent - closing live master.
       * @param planId - plan to close.
       * @returns the committed closed plan.
       */
  async closePlanV2(agent: Agent, planId: string): Promise<CoopV2PlanFile> {
    const { masterId, root } = await this.requireV2Master(agent)
    const sessionId = String(agent.session.id)
    // §6.4: merge every still-active worktree of this plan before closing;
    // a conflicted merge rejects here and the plan stays active.
    const wtEntries = (await store.readWtRegistry(store.wtRegistryPath(root)))?.entries ?? []
    for (const entry of wtEntries) {
      if (entry.planId !== planId || entry.status !== 'active') continue
      await this.mergeOneWorktree(root, entry)
    }
    const closed = await store.mutateV2Plan(
      store.v2PlanPath(root, String(masterId), planId),
      (current): { next?: CoopV2PlanFile; value: CoopV2PlanFile } => {
        if (current === undefined) throw new CoopError(`plan "${planId}" not found`, 'COOP_PLAN_NOT_FOUND')
        if (current.status === 'closed') return { value: current }
        if (current.status !== 'active') {
          throw new CoopError(`plan "${planId}" is "${current.status}", expected active`, 'COOP_INVALID_TRANSITION')
        }
        const open = current.tasks.filter(task => task.status !== 'done' && task.status !== 'cancelled')
        if (open.length > 0) {
          throw new CoopError(`plan "${planId}" still has ${open.length} open task(s): ${open.map(task => task.taskId).join(', ')}`, 'COOP_INVALID_TRANSITION')
        }
        const now = Date.now()
        const next: CoopV2PlanFile = { ...current, status: 'closed', history: [...current.history, { time: now, sessionId, op: 'close' }] }
        return { next, value: next }
      })
    await this.recordMemory(root, String(masterId), {
      time: Date.now(),
      kind: 'plan',
      ref: planId,
      title: closed.title,
      summary: `${closed.tasks.filter(task => task.status === 'done').length} done, ${closed.tasks.filter(task => task.status === 'cancelled').length} cancelled — ${closed.objective}`,
    })
    await store.appendDocSection(store.v2DocPath(root, String(masterId), planId), `- ${new Date().toISOString()} closed by ${sessionId}\n`)
    return closed
  }

  /**
       * Abort a plan: any non-terminal status cancels every open task (in-flight
       * assignees are signalled to stop) and the plan lands `aborted`.
       * @param agent - aborting live master.
       * @param planId - plan to abort.
       * @returns the committed aborted plan.
       */
  async abortPlanV2(agent: Agent, planId: string): Promise<CoopV2PlanFile> {
    const { masterId, root } = await this.requireV2Master(agent)
    const sessionId = String(agent.session.id)
    const outcome = await store.mutateV2Plan(
      store.v2PlanPath(root, String(masterId), planId),
      (current): { next?: CoopV2PlanFile; value: { plan?: CoopV2PlanFile; signalled: CoopV2Task[] } } => {
        if (current === undefined) throw new CoopError(`plan "${planId}" not found`, 'COOP_PLAN_NOT_FOUND')
        if (current.status === 'aborted') return { value: { plan: current, signalled: [] } }
        if (current.status === 'closed') {
          throw new CoopError(`plan "${planId}" is closed`, 'COOP_INVALID_TRANSITION')
        }
        const now = Date.now()
        const signalled: CoopV2Task[] = []
        const tasks = current.tasks.map((task) => {
          if (task.status === 'done' || task.status === 'cancelled') return task
          const next: CoopV2Task = { ...task, status: 'cancelled', updatedAt: now }
          if (next.assignee !== undefined) signalled.push(next)
          return next
        })
        const next: CoopV2PlanFile = { ...current, status: 'aborted', tasks, history: [...current.history, { time: now, sessionId, op: 'abort' }] }
        return { next, value: { plan: next, signalled } }
      })
    const plan = outcome.plan
    if (plan === undefined) throw new CoopError(`plan "${planId}" not found`, 'COOP_PLAN_NOT_FOUND')
    for (const task of outcome.signalled) {
      if (task.assignee === undefined) continue
      await this.deliverTask(root, String(masterId), task.assignee, planId, String(masterId), task,
        'plan aborted — drop this task and stop all further work for the plan')
    }
    await store.appendDocSection(store.v2DocPath(root, String(masterId), planId), `- ${new Date().toISOString()} aborted by ${sessionId}\n`)
    return plan
  }

  /**
       * Run one git command through the mounted shell seam (never a raw
       * `child_process`) and collect its exit code and trimmed output.
       * @param workdir - absolute working directory.
       * @param args - git arguments.
       * @returns exit code plus stdout/stderr text.
       */
  private async runGit(workdir: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const shell = this.shellSeam ?? (this.ctx.get('shell') as typeof this.shellSeam)
    if (shell === undefined) {
      throw new CoopError('worktree operations require a mounted shell provider (ctx.shell)', 'COOP_CONFIG_UNSUPPORTED')
    }
    const spec = shell.resolve({
      command: ['git', ...args].map(shellQuote).join(' '),
      workdir,
      timeoutMs: 30_000,
      stdoutMaxBytes: 1_000_000,
    })
    const result = await (await shell.execute(spec)).result()
    return { code: result.exitCode, stdout: result.stdout.text.trim(), stderr: result.stderr.text.trim() }
  }

  /**
       * Create one worktree for a plan (master only). The directory lands under
       * `<workspace>/wt/<masterId>/<seq>-<slug>`; the seq is monotonic per master
       * and the directory name is claimed under the wt-registry writer lock, so
       * concurrent masters can never collide (§3.2).
       * @param agent - creating live master.
       * @param planId - plan the worktree serves.
       * @param req - base ref (default HEAD), optional branch name, and purpose slug.
       * @returns the committed occupancy entry.
       */
  async createWorktreeV2(
    agent: Agent,
    planId: string,
    req: { from?: string; branch?: string; purpose?: string } = {},
  ): Promise<CoopWtEntry> {
    const { masterId, root } = await this.requireV2Master(agent)
    const masterIdStr = String(masterId)
    const plan = await store.readV2PlanFile(store.v2PlanPath(root, masterIdStr, planId))
    if (plan === undefined) throw new CoopError(`plan "${planId}" not found`, 'COOP_PLAN_NOT_FOUND')
    if (plan.status === 'closed' || plan.status === 'aborted') {
      throw new CoopError(`plan "${planId}" is terminal (${plan.status})`, 'COOP_INVALID_TRANSITION')
    }
    const anchor = await store.findWorkspaceRoot(this.workspaceOf(agent), this.resolved.docRoot)
    const wtRoot = join(anchor.root, 'wt')
    const base = req.from ?? 'HEAD'
    const baseBranch = base === 'HEAD'
      ? (await this.runGit(plan.repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout
      : base
    if (baseBranch.length === 0) {
      throw new CoopError(`cannot resolve the base branch of ${plan.repoRoot}`, 'COOP_CONFIG_UNSUPPORTED')
    }
    const entry = await store.mutateWtRegistry(
      store.wtRegistryPath(root),
      (current): { next?: CoopWtRegistryFile; value: { dir: string; branch: string } } => {
        const entries = current?.entries ?? []
        const seq = entries.filter(candidate => candidate.masterId === masterIdStr).length + 1
        const slug = (req.purpose ?? req.branch ?? 'task')
          .toLowerCase()
          .replace(/[^a-z0-9]+/gu, '-')
          .replace(/^-+|-+$/gu, '')
          .slice(0, 24) || 'task'
        const dir = join(wtRoot, masterIdStr, `${String(seq).padStart(2, '0')}-${slug}`)
        if (entries.some(candidate => candidate.dir === dir)) {
          throw new CoopError(`worktree directory "${dir}" is already registered`, 'COOP_WORKTREE_NAME_TAKEN')
        }
        const branch = req.branch ?? `coop/${masterIdStr}/${String(seq).padStart(2, '0')}-${slug}`
        return {
          next: { version: 1, entries: [...entries, {
            dir,
            masterId: masterIdStr,
            planId,
            repoRoot: plan.repoRoot,
            branch,
            baseBranch,
            ...(req.purpose === undefined ? {} : { purpose: req.purpose }),
            createdAt: Date.now(),
            status: 'active' as const,
          }] },
          value: { dir, branch },
        }
      })
    const addArgs = base === 'HEAD'
      ? ['worktree', 'add', '-b', entry.branch, entry.dir]
      : ['worktree', 'add', '-b', entry.branch, entry.dir, base]
    const run = await this.runGit(plan.repoRoot, addArgs)
    if (run.code !== 0) {
      // Roll the occupancy row back so the name stays claimable.
      await store.mutateWtRegistry(store.wtRegistryPath(root), (current) => {
        if (current === undefined) return { value: undefined }
        const entries = current.entries.filter(candidate => candidate.dir !== entry.dir)
        return { next: { version: 1, entries }, value: undefined }
      })
      throw new CoopError(`git worktree add failed (${String(run.code)}): ${run.stderr}`, 'COOP_CONFIG_UNSUPPORTED')
    }
    return { dir: entry.dir, masterId: masterIdStr, planId, repoRoot: plan.repoRoot, branch: entry.branch, baseBranch, createdAt: Date.now(), status: 'active' }
  }

  /**
       * List the caller's worktree occupancy rows, optionally narrowed to a plan.
       * @param agent - querying live master.
       * @param planId - optional plan filter.
       * @returns the matching entries.
       */
  async listWorktreesV2(agent: Agent, planId?: string): Promise<CoopWtEntry[]> {
    const { masterId, root } = await this.requireV2Master(agent)
    const entries = (await store.readWtRegistry(store.wtRegistryPath(root)))?.entries ?? []
    return entries.filter(entry => entry.masterId === String(masterId) && (planId === undefined || entry.planId === planId))
  }

  /**
       * Merge one active worktree's branch back into its base branch
       * (`git merge --no-ff`). A moved base checkout or a conflicted merge aborts
       * fail-loud with `COOP_WORKTREE_MERGE_CONFLICT` (§6.4: no auto-resolution).
       * @param agent - merging live master.
       * @param dir - worktree directory.
       * @returns the merged occupancy entry.
       */
  async mergeWorktreeV2(agent: Agent, dir: string): Promise<CoopWtEntry> {
    const { masterId, root } = await this.requireV2Master(agent)
    const entry = (await store.readWtRegistry(store.wtRegistryPath(root)))?.entries.find(candidate => candidate.dir === dir)
    if (entry === undefined || entry.masterId !== String(masterId)) {
      throw new CoopError(`worktree "${dir}" is not one of your registered worktrees`, 'COOP_WORKTREE_NOT_FOUND')
    }
    return this.mergeOneWorktree(root, entry)
  }

  /**
       * Remove one worktree (`git worktree remove`) and mark its row `cleaned`.
       * @param agent - cleaning live master.
       * @param dir - worktree directory.
       * @param opts - `force` discards local modifications.
       */
  async cleanWorktreeV2(agent: Agent, dir: string, opts: { force?: boolean } = {}): Promise<void> {
    const { masterId, root } = await this.requireV2Master(agent)
    const entry = (await store.readWtRegistry(store.wtRegistryPath(root)))?.entries.find(candidate => candidate.dir === dir)
    if (entry === undefined || entry.masterId !== String(masterId)) {
      throw new CoopError(`worktree "${dir}" is not one of your registered worktrees`, 'COOP_WORKTREE_NOT_FOUND')
    }
    const run = await this.runGit(entry.repoRoot, ['worktree', 'remove', ...(opts.force === true ? ['--force'] : []), entry.dir])
    if (run.code !== 0) {
      throw new CoopError(`git worktree remove failed (${String(run.code)}): ${run.stderr} — pass force to discard modifications`, 'COOP_CONFIG_UNSUPPORTED')
    }
    await store.mutateWtRegistry(store.wtRegistryPath(root), (current) => {
      if (current === undefined) return { value: undefined }
      return {
        next: { version: 1, entries: current.entries.map(candidate => candidate.dir === dir ? { ...candidate, status: 'cleaned' as const } : candidate) },
        value: undefined,
      }
    })
  }

  /**
       * Merge one active worktree row into its base and mark it `merged`.
       * @param root - absolute v2 root.
       * @param entry - occupancy row to merge.
       * @returns the merged row.
       */
  private async mergeOneWorktree(root: string, entry: CoopWtEntry): Promise<CoopWtEntry> {
    if (entry.status === 'merged') return entry
    if (entry.status !== 'active') {
      throw new CoopError(`worktree "${entry.dir}" is ${entry.status}`, 'COOP_WORKTREE_NOT_FOUND')
    }
    const head = await this.runGit(entry.repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])
    if (head.code !== 0 || head.stdout !== entry.baseBranch) {
      throw new CoopError(`repo HEAD is "${head.stdout || '?'}" but the worktree merges into "${entry.baseBranch}" — move the checkout back first`, 'COOP_WORKTREE_MERGE_CONFLICT')
    }
    const run = await this.runGit(entry.repoRoot, ['merge', '--no-ff', entry.branch, '-m', `coop: merge ${entry.branch}`])
    if (run.code !== 0) {
      await this.runGit(entry.repoRoot, ['merge', '--abort'])
      throw new CoopError(`merging "${entry.branch}" into "${entry.baseBranch}" conflicted — resolve manually or rework: ${run.stdout} ${run.stderr}`, 'COOP_WORKTREE_MERGE_CONFLICT')
    }
    const merged: CoopWtEntry = { ...entry, status: 'merged' }
    await store.mutateWtRegistry(store.wtRegistryPath(root), (current) => {
      if (current === undefined) return { value: undefined }
      return {
        next: { version: 1, entries: current.entries.map(candidate => candidate.dir === entry.dir ? merged : candidate) },
        value: undefined,
      }
    })
    return merged
  }

  /**
       * Assigned worker heartbeat while executing; feeds the executing
       * watchdog (§5.2: silent `executingStaleMs` falls back to rework).
       * @param agent - executing live worker.
       * @param planId - owning plan.
       * @param taskId - target task.
       */
  async touchExecutionV2(agent: Agent, planId: string, taskId: string): Promise<void> {
    const sessionId = String(agent.session.id)
    const { plan, root } = await this.planForNode(agent, planId)
    await store.mutateV2Plan(
      store.v2PlanPath(root, String(plan.masterId), planId),
      (current): { next?: CoopV2PlanFile; value: undefined } => {
        if (current === undefined) throw new CoopError(`plan "${planId}" not found`, 'COOP_PLAN_NOT_FOUND')
        const task = current.tasks.find(candidate => candidate.taskId === taskId)
        if (task === undefined) throw new CoopError(`task "${taskId}" not found in plan "${planId}"`, 'COOP_TASK_NOT_FOUND')
        if (task.assignee !== sessionId) {
          throw new CoopError(`task "${taskId}" is assigned to "${task.assignee ?? 'nobody'}"`, 'COOP_NOT_ASSIGNED_WORKER')
        }
        if (task.status !== 'executing' || task.execution === undefined) {
          throw new CoopError(`task "${taskId}" is "${task.status}", expected executing`, 'COOP_INVALID_TRANSITION')
        }
        const next: CoopV2Task = { ...task, execution: { ...task.execution, heartbeatAt: Date.now() } }
        return {
          next: { ...current, tasks: current.tasks.map(candidate => candidate.taskId === taskId ? next : candidate) },
          value: undefined,
        }
      })
  }

  /**
       * Append one plan-level signal and drain the target when it is live in-process.
       * @param root - absolute v2 root.
       * @param fromId - acting node id.
       * @param targetId - receiving session id.
       * @param planId - owning plan id.
       * @param masterId - owning master id (for the doc path).
       * @param text - one-line notice text.
       */
  private async deliverPlan(
    root: string,
    fromId: string,
    targetId: string,
    planId: string,
    masterId: string,
    plan: CoopV2PlanFile,
    text: string,
  ): Promise<void> {
    await store.appendSignal(store.inboxPath(root, targetId), {
      time: Date.now(),
      from: fromId,
      planId,
      kind: 'task',
      summary: `${plan.title} — ${text}`,
      docPath: store.v2DocPath(root, masterId, planId),
    })
    const target = this.ctx.agents.get(SessionId(targetId))
    if (target !== undefined) await this.drainAgentInbox(target, root)
  }

  /**
       * Deterministically summarize one finished task or closed plan into the
       * master's memory trail (P4; the optional summarizer-model pass is deferred —
       * the composition stays lossless over report/verify text). Appends the jsonl
       * record, mirrors a markdown section, compacts to the retention budget, and
       * refreshes the prompt cache for live in-process members.
       * @param root - absolute v2 root.
       * @param masterId - owning master id.
       * @param entry - the record to append.
       */
  private async recordMemory(root: string, masterId: string, entry: CoopMemoryEntry): Promise<void> {
    await store.appendMemory(store.memoryPath(root, masterId), entry, this.resolved.memoryRetainEntries)
    await store.appendDocSection(store.memoryDocPath(root, masterId), [
      `- ${new Date(entry.time).toISOString()} [${entry.kind}] ${entry.ref} ${entry.title}: ${entry.summary}`,
      '',
    ].join('\n'))
    for (const member of this.ctx.agents.list()) {
      await this.refreshMemoryCache(member)
    }
  }

  /**
       * The newest memory lines of the calling node's master (§12.3: recency
       * top-K, no relevance algorithm; targeted recall is coop_memory_search).
       * @param agent - querying live node.
       * @returns the newest injected lines, newest first.
       */
  async memoryLinesV2(agent: Agent): Promise<string[]> {
    const root = await this.v2RootOf(agent)
    const own = (await this.v2Tables(root)).find(entry => entry.sessionId === String(agent.session.id))
    const masterId = own?.masterId
    if (own === undefined || masterId === undefined) return []
    const entries = await store.readMemory(store.memoryPath(root, String(masterId)))
    return entries.slice(-this.resolved.memoryInjectTopK).reverse()
      .map(entry => `[${entry.kind}] ${entry.ref} ${entry.title} — ${entry.summary}`)
  }

  /**
       * Keyword search over the calling node's master memory (isolation: other
       * masters' trails are invisible).
       * @param agent - querying live node.
       * @param req - query text and optional limit.
       * @returns matching entries, newest first.
       */
  async searchMemoryV2(agent: Agent, req: { query: string; limit?: number }): Promise<CoopMemoryEntry[]> {
    const root = await this.v2RootOf(agent)
    const own = (await this.v2Tables(root)).find(entry => entry.sessionId === String(agent.session.id))
    const masterId = own?.masterId
    if (own === undefined || masterId === undefined) {
      throw new CoopError('this session holds no live v2 coop role — register first', 'COOP_NODE_NOT_FOUND')
    }
    const needle = req.query.toLowerCase()
    const limit = req.limit ?? 10
    const entries = (await store.readMemory(store.memoryPath(root, String(masterId)))).reverse()
    return entries.filter(entry => entry.title.toLowerCase().includes(needle)
          || entry.summary.toLowerCase().includes(needle)
          || (entry.lessons ?? []).some(lesson => lesson.toLowerCase().includes(needle))).slice(0, limit)
  }

  /**
       * Rebuild one agent's coop:memory prompt block from its master's trail.
       * @param agent - live member whose cache to refresh.
       */
  private async refreshMemoryCache(agent: Agent): Promise<void> {
    const sessionId = String(agent.session.id)
    try {
      const lines = await this.memoryLinesV2(agent)
      this.memoryCache.set(sessionId, lines.length === 0 ? '' : ['## Coop memory (most recent first)', ...lines].join('\n'))
    } catch {
      this.memoryCache.delete(sessionId)
    }
  }

  /** Cached herdr-binary probe; `undefined` until first checked. */
  private herdrAvailableCache: boolean | undefined
  /** Last state|summary reported to herdr per node, so only changes invoke the CLI. */
  private readonly reportedNodeStates = new Map<string, string>()

  /**
       * Run one herdr CLI call through the mounted shell seam. Output is JSON for
       * automation commands; callers parse what they need and treat nonzero exits
       * per their own fail-loud policy.
       * @param args - herdr arguments.
       * @param opts - `quiet` never throws; failures surface as a nonzero code.
       * @returns exit code plus trimmed stdout/stderr.
       */
  private async runHerdr(args: string[], opts: { quiet?: boolean } = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const shell = this.shellSeam ?? (this.ctx.get('shell') as typeof this.shellSeam)
    if (shell === undefined) return { code: null, stdout: '', stderr: 'no shell provider mounted' }
    const binary = process.env.HERDR_BIN_PATH ?? 'herdr'
    const spec = shell.resolve({
      command: [binary, ...args].map(shellQuote).join(' '),
      workdir: process.cwd(),
      timeoutMs: 30_000,
      stdoutMaxBytes: 1_000_000,
    })
    const result = await (await shell.execute(spec)).result()
    void opts
    return { code: result.exitCode, stdout: result.stdout.text.trim(), stderr: result.stderr.text.trim() }
  }

  /**
       * Whether a herdr binary is reachable through the shell seam (cached).
       * @returns true once a `--version` probe succeeds.
       */
  private async herdrAvailable(): Promise<boolean> {
    if (this.herdrAvailableCache !== undefined) return this.herdrAvailableCache
    const probe = await this.runHerdr(['--version'], { quiet: true })
    this.herdrAvailableCache = probe.code === 0
    return this.herdrAvailableCache
  }

  /**
       * Auto-create one bound worker/reviewer node (§4.4, §8.2). With herdr
       * reachable and the master running inside a herdr pane, the node lands in a
       * freshly split pane running `spawnCommand`, then receives its
       * `/coop <role> --master <id>` registration line (pre-bind). Otherwise the
       * node is an in-process headless session registered bound directly.
       * @param agent - creating live master.
       * @param req - role, optional model route, and working directory.
       * @returns the spawn outcome (herdr pane id, or the committed headless entry).
       */
  async createNodeV2(
    agent: Agent,
    req: { role: 'worker' | 'reviewer'; model?: string; workdir?: string; worktree?: string },
  ): Promise<{ spawned: 'herdr' | 'headless'; paneId?: string; entry?: CoopV2RegistryEntry }> {
    const { masterId, root } = await this.requireV2Master(agent)
    // Where the node LIVES: an assigned worktree wins, then an explicit
    // workdir, then the workspace root. Registration scope is unaffected —
    // worktrees sit under `<workspace>/wt/`, so anchor discovery still finds
    // the same registry the master id lives in.
    let cwd: string
    if (req.worktree !== undefined) {
      const entry = (await store.readWtRegistry(store.wtRegistryPath(root)))?.entries
        .find(candidate => candidate.masterId === String(masterId)
          && (candidate.dir === req.worktree || candidate.branch === req.worktree))
      if (entry === undefined) {
        throw new CoopError(`no worktree "${req.worktree}" under ${String(masterId)} — create one with coop_worktree_create first`, 'COOP_NODE_NOT_FOUND')
      }
      cwd = normalizeCwd(entry.dir)
    } else {
      cwd = req.workdir === undefined ? this.workspaceOf(agent) : normalizeCwd(req.workdir)
    }
    const masterPane = process.env.HERDR_PANE_ID
    const inHerdr = masterPane !== undefined
    const available = inHerdr ? await this.herdrAvailable() : false
    const wantHerdr = (this.resolved.spawn === 'herdr' || (this.resolved.spawn === 'auto' && available))
    if (!wantHerdr || (this.resolved.spawn === 'herdr' && (!inHerdr || !available))) {
      if (this.resolved.spawn === 'herdr') {
        throw new CoopError(
          inHerdr
            ? 'herdr spawn configured but no herdr binary is reachable'
            : 'herdr spawn requires the master to run inside a herdr pane (HERDR_PANE_ID absent)',
          'COOP_SPAWN_FAILED')
      }
      return this.createNodeHeadless(agent, req, masterId, cwd)
    }
    // --cwd anchors the new pane at the node's living directory; worktrees
    // sit under the workspace, so anchor discovery still finds the registry.
    // The split target arranges role columns (master | workers | reviewers).
    const plan = await this.planPaneSplit(String(masterId), masterPane ?? '', req.role, root)
    // Role-route env boot: the TUI resolves a complete provider+model pair
    // from its entry config over the persisted /model pick, so seeding
    // DSH_COOP_* here makes the pane boot (display AND first request) on the
    // role's route instead of the workspace's last picker choice.
    const roleRoute = this.roleLlmForRoles([req.role])
    const env: string[] = roleRoute === undefined
      ? []
      : [
        '--env', `DSH_COOP_PROVIDER=${roleRoute.provider}`,
        '--env', `DSH_COOP_MODEL=${roleRoute.model}`,
        ...(roleRoute.reasoningEffort === undefined
          ? []
          : ['--env', `DSH_COOP_EFFORT=${String(roleRoute.reasoningEffort)}`]),
      ]
    const split = await this.runHerdr(['pane', 'split', plan.targetPane, '--direction', plan.direction, '--no-focus', '--cwd', cwd, ...env])
    if (split.code !== 0) {
      throw new CoopError(`herdr pane split failed: ${split.stderr || split.stdout}`, 'COOP_SPAWN_FAILED')
    }
    let paneId: string | undefined
    try {
      const parsed = JSON.parse(split.stdout) as { result?: { pane?: { pane_id?: string } } }
      paneId = parsed.result?.pane?.pane_id
    } catch {
      paneId = undefined
    }
    if (paneId === undefined) {
      throw new CoopError(`herdr pane split returned no pane id: ${split.stdout}`, 'COOP_SPAWN_FAILED')
    }
    const run = await this.runHerdr(['pane', 'run', paneId, this.resolved.spawnCommand.replace('{cwd}', cwd)])
    if (run.code !== 0) {
      throw new CoopError(`herdr pane run failed: ${run.stderr || run.stdout}`, 'COOP_SPAWN_FAILED')
    }
    if (this.resolved.spawnReadyRegex.length > 0) {
      const ready = await this.runHerdr(['pane', 'wait-output', paneId, '--regex', this.resolved.spawnReadyRegex, '--timeout', '30000'])
      if (ready.code !== 0) {
        throw new CoopError(`spawned pane never matched spawnReadyRegex: ${ready.stderr || ready.stdout}`, 'COOP_SPAWN_FAILED')
      }
    }
    const line = `/coop ${req.role} --master ${String(masterId)}${req.model === undefined ? '' : ` --model ${req.model}`}`
    const send = await this.runHerdr(['pane', 'send-text', paneId, line])
    if (send.code !== 0) {
      throw new CoopError(`herdr pane send-text failed: ${send.stderr || send.stdout}`, 'COOP_SPAWN_FAILED')
    }
    const enter = await this.runHerdr(['pane', 'send-keys', paneId, 'Enter'])
    if (enter.code !== 0) {
      throw new CoopError(`herdr pane send-keys failed: ${enter.stderr || enter.stdout}`, 'COOP_SPAWN_FAILED')
    }
    // Delivery through a still-booting TUI is best-effort; the registry is
    // the truth. Poll for the entry, re-sending the line until it lands —
    // then report the committed bind state instead of hoping it arrived.
    const entry = await this.awaitPaneRegistration(root, paneId, req.role, line)
    return { spawned: 'herdr', paneId, entry }
  }

  /**
       * The headless fallback: an in-process durable session created through the
       * agent-loop seam and registered pre-bound to the calling master.
       * @param agent - creating live master.
       * @param req - role, optional model route, and working directory.
       * @param masterId - owning master id.
       * @returns the spawn outcome with the committed registry entry.
       */
  private async createNodeHeadless(
    agent: Agent,
    req: { role: 'worker' | 'reviewer'; model?: string; workdir?: string },
    masterId: MasterId,
    cwd: string,
  ): Promise<{ spawned: 'headless'; entry: CoopV2RegistryEntry }> {
    const loop = this.ctx.get('agentLoop') as {
      create: (id: SessionId, options: { provider?: string; model?: string }, meta: { cwd: string }) => Promise<Agent>
    } | undefined
    if (loop === undefined) {
      throw new CoopError('headless spawn requires the agent-loop service', 'COOP_SPAWN_FAILED')
    }
    const route = agent.options as { provider?: string; model?: string }
    const roleRoute = this.roleLlmForRoles([req.role])
    const model = req.model ?? roleRoute?.model ?? route.model
    const provider = roleRoute?.provider ?? route.provider
    const spawned = await loop.create(
      SessionId(`coop-${req.role}-${randomUUID().slice(0, 8)}`),
      {
        ...(provider === undefined ? {} : { provider }),
        ...(model === undefined ? {} : { model }),
      },
      { cwd },
    )
    const entry = await this.registerV2(spawned, {
      roles: [req.role],
      masterId: String(masterId),
      ...(req.model === undefined ? {} : { model: req.model }),
    })
    return { spawned: 'headless', entry }
  }

  /**
       * Mirror coop node states into herdr for every bound node that self-reported
       * a pane id (§8.3): workers/reviewers get working/blocked/idle plus a summary
       * token, so herdr's sidebar aggregation becomes the node card row. Invoked
       * from the poll tick; herdr CLI calls fire only on state changes.
       * @param root - absolute v2 root.
       */
  private async reportNodeStates(root: string): Promise<void> {
    if (this.resolved.mode !== 'v2') return
    const now = Date.now()
    const nodes = (await this.v2Tables(root)).filter(entry => this.isFreshV2(entry, now)
          && entry.bindState === 'bound'
          && entry.masterId !== undefined
          && entry.meta?.paneId !== undefined
          && !entry.roles.includes('master'))
    if (nodes.length === 0) return
    const plansByMaster = new Map<string, CoopV2PlanFile[]>()
    for (const node of nodes) {
      const key = String(node.masterId)
      if (plansByMaster.has(key)) continue
      const plans: CoopV2PlanFile[] = []
      try {
        const names = await readdir(store.v2PlansDir(root, key))
        for (const name of names.filter(candidate => candidate.endsWith('.json'))) {
          const plan = await store.readV2PlanFile(store.v2PlanPath(root, key, name.replace(/\.json$/u, '')))
          if (plan?.status === 'active') plans.push(plan)
        }
      } catch {
        // No plans directory yet for this master.
      }
      plansByMaster.set(key, plans)
    }
    for (const node of nodes) {
      const plans = plansByMaster.get(String(node.masterId)) ?? []
      let state = 'idle'
      let summary = 'idle'
      for (const plan of plans) {
        for (const task of plan.tasks) {
          if (node.roles.includes('worker') && task.assignee === node.sessionId) {
            if (task.status === 'executing' || task.status === 'assigned' || task.status === 'rework') {
              state = 'working'
              summary = `${task.taskId} ${task.status}`
            } else if (task.status === 'blocked') {
              state = 'blocked'
              summary = `${task.taskId} blocked`
            }
          }
          if (node.roles.includes('reviewer') && task.status === 'verifying') {
            state = 'working'
            summary = `${task.taskId} verifying`
          }
        }
      }
      const key = `${state}|${summary}`
      if (this.reportedNodeStates.get(node.sessionId) === key) continue
      const paneId = node.meta?.paneId
      if (paneId === undefined) continue
      const report = await this.runHerdr(['pane', 'report-agent', paneId, '--source', 'coop', '--agent', 'dsh', '--state', state], { quiet: true })
      const token = await this.runHerdr(['pane', 'report-metadata', paneId, '--source', 'coop', '--token', `summary=${summary}`], { quiet: true })
      if (report.code === 0 || token.code === 0) {
        this.reportedNodeStates.set(node.sessionId, key)
      }
    }
  }

  /** Shell seam captured through injection — `ctx.get('shell')` may return a
   * fiber wrapper whose method surface differs; the injected child's `shell`
   * is the service instance the tests and production both expose. */
  private shellSeam: {
    resolve: (request: Record<string, unknown>) => unknown
    execute: (spec: unknown) => Promise<{ result: () => Promise<{
      exitCode: number | null
      stdout: { text: string }
      stderr: { text: string }
    }> }>
  } | undefined

  /**
         * The role-pinned LLM route currently applied to one registered session.
         * @param sessionId - session to look up.
         * @returns the route, or undefined when the session has none in this process.
         */
  roleLlmFor(sessionId: string): RoleLlmRoute | undefined {
    return this.roleLlmBySession.get(sessionId)
  }

  /** First configured role route matching any of the entry's roles. */
  private roleLlmForRoles(roles: readonly V2Role[]): RoleLlmRoute | undefined {
    for (const role of roles) {
      const route = this.resolved.roleLlm[role]
      if (route !== undefined) return route
    }
    return undefined
  }

  /**
         * Wait for a spawned pane's registration line to land as a registry entry
         * (matched by the pane id the session self-reports), re-sending the line
         * while the pane is still booting. The first wait is longer to cover TUI
         * startup; afterwards the line repeats roughly every four seconds.
         * @param root - the master's v2 root (the registry the pane writes to).
         * @param paneId - herdr pane the node was spawned into.
         * @param role - role the registration line carries.
         * @param line - the registration line, resent on retry and quoted on timeout.
         * @returns the committed registry entry.
         * @throws CoopError `COOP_SPAWN_FAILED` when the window elapses with no entry.
         */
  private async awaitPaneRegistration(root: string, paneId: string, role: 'worker' | 'reviewer', line: string): Promise<CoopV2RegistryEntry> {
    const deadline = Date.now() + this.resolved.spawnRegisterTimeoutMs
    const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
    for (let attempt = 1; ; attempt++) {
      await sleep(attempt === 1 ? 1_500 : 1_000)
      const entry = (await store.readV2Registry(store.v2RegistryPath(root)))?.entries
        .find(candidate => candidate.meta?.paneId === paneId && candidate.roles.includes(role))
      if (entry !== undefined) return entry
      if (Date.now() >= deadline) {
        throw new CoopError(`spawned pane ${paneId} never registered as ${role} within ${String(this.resolved.spawnRegisterTimeoutMs)}ms — send the line manually: ${line}`, 'COOP_SPAWN_FAILED')
      }
      if (attempt % 4 === 0) {
        const send = await this.runHerdr(['pane', 'send-text', paneId, line])
        if (send.code === 0) await this.runHerdr(['pane', 'send-keys', paneId, 'Enter'])
      }
    }
  }

  /**
     * Pick the pane to split for the next auto-spawned node. Under the
     * default `columns` layout the live herdr geometry plus each node's
     * self-reported pane id derive the role columns with no stored state:
     * same-role panes extend the bottom of their column, and a role's first
     * pane splits the master right, inserting a fresh full-height column.
         * Unreadable layouts degrade to the legacy master-right split.
         * @param masterId - owning master id.
         * @param masterPane - the master's herdr pane id.
         * @param role - role being spawned.
         * @param root - the master's v2 root (registry source for live pane ids).
         * @returns the pane to split and the direction.
         */
  private async planPaneSplit(masterId: string, masterPane: string, role: 'worker' | 'reviewer', root: string): Promise<{ targetPane: string; direction: 'right' | 'down' }> {
    if (this.resolved.spawnLayout === 'right' || masterPane.length === 0) {
      return { targetPane: masterPane, direction: 'right' }
    }
    const layoutOut = await this.runHerdr(['pane', 'layout', '--pane', masterPane], { quiet: true })
    if (layoutOut.code !== 0) {
      return { targetPane: masterPane, direction: 'right' }
    }
    let panes: { pane_id?: string; rect?: { x?: number; y?: number; width?: number; height?: number } }[]
    try {
      const parsed = JSON.parse(layoutOut.stdout) as { result?: { layout?: { panes?: typeof panes } } }
      panes = parsed.result?.layout?.panes ?? []
    } catch {
      return { targetPane: masterPane, direction: 'right' }
    }
    const boxes = new Map<string, PaneBox>()
    for (const pane of panes) {
      const rect = pane.rect
      if (pane.pane_id === undefined || rect === undefined) continue
      boxes.set(pane.pane_id, {
        paneId: pane.pane_id,
        x: rect.x ?? 0,
        y: rect.y ?? 0,
        width: rect.width ?? 0,
        height: rect.height ?? 0,
      })
    }
    const now = Date.now()
    const entries = (await store.readV2Registry(store.v2RegistryPath(root)))?.entries ?? []
    const rolePanes = (wanted: 'worker' | 'reviewer'): PaneBox[] =>
      entries
        .filter(entry => entry.bindState === 'bound'
                && String(entry.masterId ?? '') === masterId
                && this.isFreshV2(entry, now)
                && entry.roles.includes(wanted)
                && entry.meta?.paneId !== undefined
                && boxes.has(entry.meta.paneId))
        .map(entry => boxes.get(String(entry.meta?.paneId)))
        .filter((box): box is PaneBox => box !== undefined)
    return planColumnSplit(masterPane, rolePanes(role))
  }

  /**
         * Pin one registered session onto its role route on BOTH surfaces: the
         * request waterfall (every later request rewrites onto the route) and the
         * session's own model selection, so the TUI statusline, the model-switch
         * notice, and the wire all agree instead of the UI still showing the
         * session default while requests silently travel the role route.
         * @param agent - freshly registered live agent.
         * @param route - validated role route to pin.
         */
  private applyRoleRoute(agent: Agent, route: RoleLlmRoute): void {
    this.roleLlmBySession.set(String(agent.session.id), route)
    const selection = {
      provider: route.provider,
      model: route.model,
      ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
    }
    const controller = this.sessionController
    if (controller !== undefined) {
      try {
        controller.selectForNextRequest(agent, selection)
        return
      } catch {
        // Fall through to the durable event below.
      }
    }
    try {
      // Without the session-controller service (e.g. the TUI profile), the
      // durable `model/selection` event still records the pin in the
      // transcript, and the first request's header carries the route.
      agent.session.append('model/selection', selection)
    } catch {
      // The event seam is optional; the request-waterfall pin alone carries
      // the route.
    }
  }
}
/**
 * Whether the edge set contains a cycle; returns the cycle path for the
 * rejection message, or `undefined` when the graph is acyclic.
 * @param edges - complete candidate edge set.
 * @returns the cycle node path, or `undefined`.
 */
function detectCycle(edges: { from: string; to: string }[]): string[] | undefined {
  const graph = new Map<string, string[]>()
  for (const { from, to } of edges) {
    const list = graph.get(from)
    if (list === undefined) graph.set(from, [to])
    else list.push(to)
  }
  const state = new Map<string, 0 | 1 | 2>()
  const stack: string[] = []
  const visit = (node: string): string[] | undefined => {
    const mark = state.get(node)
    if (mark === 2) return undefined
    if (mark === 1) return [...stack.slice(stack.indexOf(node)), node]
    state.set(node, 1)
    stack.push(node)
    for (const next of graph.get(node) ?? []) {
      const cycle = visit(next)
      if (cycle !== undefined) return cycle
    }
    stack.pop()
    state.set(node, 2)
    return undefined
  }
  for (const from of graph.keys()) {
    const cycle = visit(from)
    if (cycle !== undefined) return cycle
  }
  return undefined
}

/**
 * Recompute `pending`/`ready`/`blocked` from the DAG: every dependency done
 * ⇒ ready, any dependency cancelled/blocked ⇒ blocked, else pending. Tasks in
 * flight or terminal stay fixed. Returns the same reference when nothing
 * moved so locked writes can skip the rewrite.
 * @param plan - plan whose idle tasks need recomputation.
 * @param now - epoch ms stamped onto moved tasks.
 * @returns the plan with refreshed idle-task statuses.
 */
function recomputeReady(plan: CoopV2PlanFile, now: number): CoopV2PlanFile {
  const byId = new Map(plan.tasks.map(task => [task.taskId, task]))
  const tasks = plan.tasks.map((task) => {
    if (task.status !== 'pending' && task.status !== 'ready' && task.status !== 'blocked') return task
    let missing = false
    let dead = false
    let allDone = true
    for (const dep of task.dependsOn) {
      const upstream = byId.get(dep)
      if (upstream === undefined) {
        missing = true
        continue
      }
      if (upstream.status === 'cancelled' || upstream.status === 'blocked') dead = true
      if (upstream.status !== 'done') allDone = false
    }
    if (missing) return task
    if (dead) {
      if (task.status === 'blocked') return task
      return { ...task, status: 'blocked' as const, updatedAt: now }
    }
    if (allDone) {
      if (task.status === 'ready') return task
      return { ...task, status: 'ready' as const, updatedAt: now }
    }
    if (task.status !== 'pending') {
      return { ...task, status: 'pending' as const, updatedAt: now }
    }
    return task
  })
  return { ...plan, tasks }
}
/** Quote one argv element for the shell-string seam; plain tokens stay bare. */
function shellQuote(part: string): string {
  return /^[\w.\/@:%+=^,-]+$/u.test(part) ? part : `'${part.replaceAll("'", '\'\\\'\'')}'`
}
/**
 * Apply lazy watchdog transitions to a plan's tasks (§5.2): an `executing`
 * task whose heartbeat went silent falls back to `rework` (the same worker
 * may re-begin); a non-terminal task past its hard deadline (measured from
 * first assignment) escalates to `blocked` for the master to decide.
 * Returns the same reference when nothing applies.
 * @param plan - plan whose tasks need watching.
 * @param now - epoch ms.
 * @param executingStaleMs - silent-heartbeat window.
 * @returns the plan with watched tasks settled.
 */
function watchTasks(plan: CoopV2PlanFile, now: number, executingStaleMs: number): CoopV2PlanFile {
  const tasks = plan.tasks.map((task) => {
    if (task.status === 'executing' && task.execution !== undefined && now - task.execution.heartbeatAt > executingStaleMs) {
      const { execution: _dropped, ...rest } = task
      return { ...rest, status: 'rework' as const, updatedAt: now }
    }
    const hardMs = task.deadlines?.hardMs
    if (hardMs !== undefined && task.assignedAt !== undefined
      && task.status !== 'done' && task.status !== 'cancelled' && task.status !== 'blocked'
      && now - task.assignedAt > hardMs) {
      return { ...task, status: 'blocked' as const, updatedAt: now }
    }
    return task
  })
  return { ...plan, tasks }
}
/** The one session-controller operation coop consumes: commit a model selection the owning session's UI and routing both see. */
interface SessionControllerSeam {
  selectForNextRequest: (agent: Agent, selection: { provider: string; model: string; reasoningEffort?: unknown }) => void
}
