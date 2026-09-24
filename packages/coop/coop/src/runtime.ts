/** Runtime constructors, config resolution, and path helpers for the coop domain. @module @deepseek-ai/dsh-coop/runtime */

import { isAbsolute, join, normalize, resolve, basename } from 'node:path'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { CwdScope, CoopErrorCode, MasterId, PlanId, ReviewLevel, Role } from './types.ts'
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
