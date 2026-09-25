/** Runtime constructors, config resolution, and path helpers for the coop domain. @module @deepseek-ai/dsh-coop/runtime */

import { isAbsolute, join, normalize, resolve, basename } from 'node:path'
import { HarnessError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { CwdScope, CoopErrorCode, MasterId, PlanId, ReviewLevel, Role, V2Role } from './types.ts'
import { randomUUID } from 'node:crypto'


/** All roles that may hold `cwdScope: "any"` when the deployment allows any-scope at all. */
export const DEFAULT_ANY_CWD_ROLES: readonly Role[] = ['master', 'worker']

/** Deployment-tunable coop defaults; every value is a validated `Config` field, none are hardcoded at use sites. */
export interface ResolvedCoopConfig {
  inboxPollMs: number
  mirrorEvents: boolean
  defaultReviewLevel: ReviewLevel
  docRoot: string
  allowNoWorker: boolean
  staleMs: number
  executingStaleMs: number
  abortAckTimeoutMs: number
  workerSelector: 'earliest' | 'round-robin'
  inboxCompactThreshold: number
  allowAnyCwdRoles: Role[]
  /** Registry/tool model in force: `v1` keeps the shipped master/worker plan flow, `v2` selects the multi-master node registry. */
  mode: 'v1' | 'v2'
  /** v2 per-master worker capacity enforced at bind and registration. */
  maxWorkers: number
  /** v2 per-master reviewer capacity enforced at bind and registration. */
  maxReviewers: number
  /** v2 per-master limit on concurrently assigned+executing tasks across plans. */
  maxParallelTasks: number
  /** v2 whether the master may verify its own tasks when no reviewer is bound (§12.4; default off). */
  allowSelfReview: boolean
  /** v2 rework rounds before a task escalates to blocked (§5.2). */
  maxReworkAttempts: number
  /** v2 memory records injected into the coop:memory prompt section (§12.3 recency top-K). */
  memoryInjectTopK: number
  /** v2 memory trail retention budget per master; appends drop the oldest beyond it. */
  memoryRetainEntries: number
  /** v2 node auto-creation transport: herdr pane when available, else in-process headless. */
  spawn: 'auto' | 'herdr' | 'headless'
  /** v2 command template run in a spawned herdr pane; `{cwd}` is replaced. */
  spawnCommand: string
  /** v2 regex herdr pane output must match before the registration line is sent (empty = send immediately). */
  spawnReadyRegex: string
  /** v2 window waiting for a spawned pane's registration to land in the registry, re-sending the line meanwhile. */
  spawnRegisterTimeoutMs: number
  /** v2 herdr pane arrangement for auto-spawned nodes: role columns or every pane right of the master. */
  spawnLayout: 'columns' | 'right'
  /** v2 per-role LLM routes applied to every request of a registered session (mode v2 only). */
  roleLlm: RoleLlmRoutes
}

/**
 * Validate and materialize deployment defaults. Every field explains its own
 * rejection; misconfiguration fails loud here rather than mid-workflow.
 * @param config - raw deployment config.
 * @returns the resolved config.
 */
export function resolveCoopConfig(config: {
  inboxPollMs?: number
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
  mode?: string
  maxWorkers?: number
  maxReviewers?: number
  maxParallelTasks?: number
  allowSelfReview?: boolean
  maxReworkAttempts?: number
  memoryInjectTopK?: number
  memoryRetainEntries?: number
  spawn?: string
  spawnCommand?: string
  spawnReadyRegex?: string
  spawnRegisterTimeoutMs?: number
  roleLlm?: RoleLlmSettings | null
  spawnLayout?: string
}): ResolvedCoopConfig {
  const positive = (value: number | undefined, name: string): number | undefined => {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new CoopError(`config ${name} must be a positive safe integer, got ${String(value)}`, 'COOP_CONFIG_UNSUPPORTED')
    }
    return value
  }
  if (config.mode !== undefined && config.mode !== 'v1' && config.mode !== 'v2') {
    throw new CoopError(`config mode must be "v1" or "v2", got "${config.mode}"`, 'COOP_CONFIG_UNSUPPORTED')
  }
  if (config.spawn !== undefined && config.spawn !== 'auto' && config.spawn !== 'herdr' && config.spawn !== 'headless') {
    throw new CoopError(`config spawn must be "auto" | "herdr" | "headless", got "${config.spawn}"`, 'COOP_CONFIG_UNSUPPORTED')
  }
  if (config.spawnLayout !== undefined && config.spawnLayout !== 'columns' && config.spawnLayout !== 'right') {
    throw new CoopError(`config spawnLayout must be "columns" | "right", got "${config.spawnLayout}"`, 'COOP_CONFIG_UNSUPPORTED')
  }
  const roleLlm = resolveRoleLlm(config.roleLlm)
  const spawnRegisterTimeoutMs = positive(config.spawnRegisterTimeoutMs, 'spawnRegisterTimeoutMs') ?? 30_000
  return {
    mode: config.mode ?? 'v1',
    defaultReviewLevel: config.defaultReviewLevel ?? 'standard',
    docRoot: config.docRoot ?? '.dsh/coop',
    allowNoWorker: config.allowNoWorker ?? false,
    inboxPollMs: positive(config.inboxPollMs, 'inboxPollMs') ?? 1_000,
    staleMs: positive(config.staleMs, 'staleMs') ?? 300_000,
    executingStaleMs: positive(config.executingStaleMs, 'executingStaleMs') ?? 600_000,
    abortAckTimeoutMs: positive(config.abortAckTimeoutMs, 'abortAckTimeoutMs') ?? 120_000,
    workerSelector: config.workerSelector ?? 'earliest',
    inboxCompactThreshold: positive(config.inboxCompactThreshold, 'inboxCompactThreshold') ?? 256,
    allowAnyCwdRoles: config.allowAnyCwdRoles ?? [...DEFAULT_ANY_CWD_ROLES],
    mirrorEvents: config.mirrorEvents ?? false,
    maxWorkers: positive(config.maxWorkers, 'maxWorkers') ?? 4,
    maxReviewers: positive(config.maxReviewers, 'maxReviewers') ?? 2,
    maxParallelTasks: positive(config.maxParallelTasks, 'maxParallelTasks') ?? 3,
    allowSelfReview: config.allowSelfReview ?? false,
    maxReworkAttempts: positive(config.maxReworkAttempts, 'maxReworkAttempts') ?? 3,
    memoryInjectTopK: positive(config.memoryInjectTopK, 'memoryInjectTopK') ?? 8,
    memoryRetainEntries: positive(config.memoryRetainEntries, 'memoryRetainEntries') ?? 256,
    spawn: config.spawn === 'herdr' || config.spawn === 'headless' ? config.spawn : 'auto',
    spawnCommand: config.spawnCommand ?? 'dsh --cwd {cwd}',
    spawnReadyRegex: config.spawnReadyRegex ?? '',
    spawnRegisterTimeoutMs,
    spawnLayout: config.spawnLayout === 'right' ? 'right' : 'columns',
    roleLlm,
  }
}

/** Brand a string as a coop plan id. */
export function PlanId(id: string): PlanId {
  return id as PlanId
}

/** Error raised at the coop domain boundary. */
export class CoopError extends HarnessError {
  /**
   * @param message - human-readable rejection reason.
   * @param code - stable machine-routable classification.
   */
  // Keep the constructor to narrow HarnessError's string code at this boundary.
  // oxlint-disable-next-line typescript/no-useless-constructor -- type-only narrowing
  constructor(message: string, code: CoopErrorCode) {
    super(message, code)
  }
}

/**
 * Normalize one workspace anchor to a comparable absolute path.
 * @param cwd - the session header cwd or process cwd.
 * @returns the normalized absolute path.
 */
export function normalizeCwd(cwd: string): string {
  if (!isAbsolute(cwd)) throw new CoopError(`coop workspace cwd must be absolute, got "${cwd}"`, 'COOP_CONFIG_UNSUPPORTED')
  return normalize(resolve(cwd))
}

/**
 * The workspace-shared coop root for one normalized cwd.
 * @param cwd - normalized workspace.
 * @param docRoot - configured doc root relative to the workspace.
 * @returns the absolute `.dsh/coop` root.
 */
export function coopRoot(cwd: string, docRoot: string): string {
  return join(cwd, docRoot)
}

/** Whether two entries may communicate: same directory, or either side declared any-scope. */
export function canCommunicate(a: { cwd: string; cwdScope: CwdScope }, b: { cwd: string; cwdScope: CwdScope }): boolean {
  return normalizeCwd(a.cwd) === normalizeCwd(b.cwd) || a.cwdScope === 'any' || b.cwdScope === 'any'
}
/** Brand a string as a coop master id. */
export function MasterId(id: string): MasterId {
  return id as MasterId
}

/**
 * Mint a fresh v2 master identifier from a workspace seed.
 * @param seed - path whose basename names the master.
 * @returns the branded `<slug>#<short-uuid>` id.
 */
export function mintMasterId(seed: string): MasterId {
  const slug = basename(seed).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'master'
  return MasterId(`${slug}#${randomUUID().slice(0, 8)}`)
}

/**
 * The v2 namespace root under one workspace.
 * @param workspaceRoot - normalized workspace root.
 * @param docRoot - configured doc root relative to the workspace.
 * @returns the absolute `.dsh/coop/v2` root.
 */
export function v2Root(workspaceRoot: string, docRoot: string): string {
  return join(coopRoot(workspaceRoot, docRoot), 'v2')
}
/** One validated per-role LLM route; provider and model travel as a pair. */
export interface RoleLlmRoute {
  /** Registered provider route. */
  provider: string
  /** Provider-owned model id. */
  model: string
  /** Adapter-owned reasoning effort for the route. */
  reasoningEffort?: ReasoningEffortId
}
/** Per-role LLM routes keyed by v2 role. */
export type RoleLlmRoutes = Partial<Record<V2Role, RoleLlmRoute>>
/** Raw `roleLlm` deployment config; shape and pair rules are enforced in resolveCoopConfig. */
export type RoleLlmSettings = Partial<Record<V2Role, { provider?: string; model?: string; reasoningEffort?: string }>>
/** v2 roles that may pin an LLM route through `config.roleLlm`. */
const ROLE_LLM_ROLES: readonly V2Role[] = ['master', 'worker', 'reviewer']

/**
 * Validate per-role LLM route settings. Provider and model must be supplied
 * together and non-empty; the optional effort must be a non-empty string the
 * target adapter interprets. Unknown role keys fail loud so typos never
 * silently no-op.
 * @param input - raw `roleLlm` config value.
 * @returns the validated routes keyed by role.
 */
function resolveRoleLlm(input: RoleLlmSettings | null | undefined): RoleLlmRoutes {
  const routes: RoleLlmRoutes = {}
  if (input === undefined) return routes
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new CoopError('config roleLlm must be an object keyed by role', 'COOP_CONFIG_UNSUPPORTED')
  }
  for (const key of Object.keys(input)) {
    if (!(ROLE_LLM_ROLES as readonly string[]).includes(key)) {
      throw new CoopError(`config roleLlm role must be one of ${ROLE_LLM_ROLES.join('|')}, got "${key}"`, 'COOP_CONFIG_UNSUPPORTED')
    }
    const entry = input[key as V2Role]
    if (entry === undefined) continue
    const { provider, model, reasoningEffort } = entry
    if (provider === undefined && model === undefined && reasoningEffort === undefined) continue
    if (provider === undefined || model === undefined) {
      throw new CoopError(`config roleLlm.${key} requires provider and model together`, 'COOP_CONFIG_UNSUPPORTED')
    }
    if (provider.length === 0 || model.length === 0) {
      throw new CoopError(`config roleLlm.${key} provider and model must be non-empty`, 'COOP_CONFIG_UNSUPPORTED')
    }
    if (reasoningEffort !== undefined && reasoningEffort.length === 0) {
      throw new CoopError(`config roleLlm.${key} reasoningEffort must be non-empty`, 'COOP_CONFIG_UNSUPPORTED')
    }
    routes[key as V2Role] = {
      provider,
      model,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(reasoningEffort) }),
    }
  }
  return routes
}

/**
 * Rewrite one resolved request config onto a role-pinned route: provider and
 * model replace the inherited pair, and the route's effort replaces any
 * inherited effort (an absent route effort restores the route's default).
 * @param resolved - call config produced by the upstream waterfall.
 * @param route - validated role route.
 * @returns the rewritten config.
 */
export function applyRoleLlmRoute<
  T extends { provider?: string | undefined; model?: string | undefined; reasoningEffort?: ReasoningEffortId | undefined },
>(resolved: T, route: RoleLlmRoute): T {
  const { reasoningEffort: _inheritedEffort, ...rest } = resolved
  return {
    ...rest,
    provider: route.provider,
    model: route.model,
    ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
  } as T
}
/** One pane's geometry in the herdr layout grid. */
export interface PaneBox {
  paneId: string
  x: number
  y: number
  width: number
  height: number
}

/**
 * Choose where the next auto-spawned node's pane splits, arranging the
 * cluster as clean full-height role columns. Same-role spawns extend the
 * bottom of their column (a down split); a role's first pane splits the
 * MASTER right, which inserts a fresh full-height column beside the master
 * without touching the other role's stacked column. Column order therefore
 * follows spawn order (whichever role spawns first sits next to the master),
 * and the layout needs no persisted pane state — only the live geometry plus
 * each node's self-reported pane id.
 * @param masterPane - the master's herdr pane id (column zero).
 * @param roleBoxes - live panes of this role under the master (may be empty).
 * @returns the pane to split and the split direction.
 */
export function planColumnSplit(
  masterPane: string,
  roleBoxes: readonly PaneBox[],
): { targetPane: string; direction: 'right' | 'down' } {
  if (roleBoxes.length > 0) {
    const bottom = roleBoxes.reduce((deepest, box) =>
      box.y + box.height > deepest.y + deepest.height ? box : deepest)
    return { targetPane: bottom.paneId, direction: 'down' }
  }
  return { targetPane: masterPane, direction: 'right' }
}
