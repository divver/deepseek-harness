/** Runtime constructors, config resolution, and path helpers for the coop domain. @module @deepseek-ai/dsh-coop/runtime */

import { isAbsolute, join, normalize, resolve } from 'node:path'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { CwdScope, CoopErrorCode, PlanId, ReviewLevel, Role } from './types.ts'

/** All roles that may hold `cwdScope: "any"` when the deployment allows any-scope at all. */
export const DEFAULT_ANY_CWD_ROLES: readonly Role[] = ['master', 'worker']

/** Deployment-tunable coop defaults; every value is a validated `Config` field, none are hardcoded at use sites. */
export interface ResolvedCoopConfig {
  defaultReviewLevel: ReviewLevel
  docRoot: string
  allowNoWorker: boolean
  staleMs: number
  executingStaleMs: number
  abortAckTimeoutMs: number
  workerSelector: 'earliest' | 'round-robin'
  inboxCompactThreshold: number
  allowAnyCwdRoles: Role[]
}

/**
 * Validate and materialize deployment defaults. Every field explains its own
 * rejection; misconfiguration fails loud here rather than mid-workflow.
 * @param config - raw deployment config.
 * @returns the resolved config.
 */
export function resolveCoopConfig(config: {
  defaultReviewLevel?: ReviewLevel
  docRoot?: string
  allowNoWorker?: boolean
  staleMs?: number
  executingStaleMs?: number
  abortAckTimeoutMs?: number
  workerSelector?: 'earliest' | 'round-robin'
  inboxCompactThreshold?: number
  allowAnyCwdRoles?: Role[]
}): ResolvedCoopConfig {
  const positive = (value: number | undefined, name: string): number | undefined => {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new CoopError(`config ${name} must be a positive safe integer, got ${String(value)}`, 'COOP_CONFIG_UNSUPPORTED')
    }
    return value
  }
  return {
    defaultReviewLevel: config.defaultReviewLevel ?? 'standard',
    docRoot: config.docRoot ?? '.dsh/coop',
    allowNoWorker: config.allowNoWorker ?? false,
    staleMs: positive(config.staleMs, 'staleMs') ?? 300_000,
    executingStaleMs: positive(config.executingStaleMs, 'executingStaleMs') ?? 600_000,
    abortAckTimeoutMs: positive(config.abortAckTimeoutMs, 'abortAckTimeoutMs') ?? 120_000,
    workerSelector: config.workerSelector ?? 'earliest',
    inboxCompactThreshold: positive(config.inboxCompactThreshold, 'inboxCompactThreshold') ?? 256,
    allowAnyCwdRoles: config.allowAnyCwdRoles ?? [...DEFAULT_ANY_CWD_ROLES],
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
