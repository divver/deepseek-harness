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
import { join } from 'node:path'
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
  CoopPlanFile,
  CoopRegistryEntry,
  PlanStatus,
  ReviewLevel,
  Role,
} from './types.ts'
import {
  CoopError,
  PlanId as brandPlanId,
  canCommunicate,
  coopRoot,
  normalizeCwd,
  resolveCoopConfig,
} from './runtime.ts'
import type { ResolvedCoopConfig } from './runtime.ts'
import * as store from './store.ts'
import { COOP_POLICY_ORDER, COOP_POLICY_SECTION_NAME, COOP_POLICY_TEXT } from './policy.ts'
import { registerCoopCommands } from './commands.ts'
import { registerCoopTools } from './tools.ts'

/** Raw deployment config; enum and positivity rules are enforced in {@link resolveCoopConfig}. */
export interface Config {
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

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'coop')
    this.resolved = resolveCoopConfig(config)
    ctx.inject(['systemPrompt'], (promptCtx) => {
      promptCtx.systemPrompt.section({
        name: COOP_POLICY_SECTION_NAME,
        order: COOP_POLICY_ORDER,
        text: COOP_POLICY_TEXT,
      })
    })
    ctx.inject(['tools'], (toolCtx) => {
      registerCoopTools(toolCtx, this)
    })
    ctx.inject(['commands'], (commandCtx) => {
      registerCoopCommands(commandCtx, this)
    })
    // A cross-process worker receives signal lines on its next activation:
    // resume, fresh start, or any later turn-driven session-start replay.
    ctx.on('agent/session-start', ({ agent }) => {
      void this.drainInbox(agent).catch((error: unknown) => {
        this.ctx.logger.warn(`coop: draining inbox for "${String(agent.session.id)}" failed: ${String(error)}`)
      })
    })
  }

  /**
   * Append one coop mirror event when `mirrorEvents` is enabled. Mirrors are
   * audit/replay extras; the shared files stay authoritative either way.
   */
  private appendMirror(session: Agent['session'], type: 'coop/registry' | 'coop/plan-change' | 'coop/review' | 'coop/execution', data: unknown): void {
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
    await this.deliver(workerId, plan.createdBy, plan, 'pre_review', `pre-review ${decision}${summary === undefined ? '' : `: ${summary}`}`)
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
      await this.deliver(masterId, workerId, updated, 'verify', `verify ${decision}${summary === undefined ? '' : `: ${summary}`}`)
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
      case 'notify':
        return `[coop] New plan to pre-review "${entry.planId}" — ${entry.summary} Document: ${entry.docPath}. Call coop_status, then coop_pre_review(planId, decision).`
      case 'pre_review':
        return `[coop] Plan "${entry.planId}" pre-review result: ${entry.summary}. Revise via coop_plan_create/update or wait for execution.`
      case 'verify':
        return `[coop] Plan "${entry.planId}" update: ${entry.summary}. See ${entry.docPath}.`
      case 'execution':
        return `[coop] Plan "${entry.planId}" execution reported: ${entry.summary}. Call coop_verify(planId, decision).`
      case 'abort':
        return `[coop] ABORT plan "${entry.planId}"${entry.reason === undefined ? '' : ` — reason: ${entry.reason}`} — stop all further work for this plan immediately, clean up, then call coop_abort_ack(planId).`
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
    const root = this.rootOf(this.workspaceOf(agent))
    return this.drainAgentInbox(agent, root)
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
        source: { kind: 'plugin', plugin: 'coop', form: 'notice', summary: boundContextSummary(`${entry.kind}: ${entry.summary}`) },
      }))
      highest = Math.max(highest, entry.seq)
    }
    if (entries.length > 0) {
      await store.advanceConsumed(watermarkPath, highest)
      await store.compactSignals(path, watermarkPath, this.resolved.inboxCompactThreshold)
    }
    return entries.length
  }
}
