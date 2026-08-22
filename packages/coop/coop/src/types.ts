/** Shared wire and storage types for the coop domain. Types only — no runtime code. @module @deepseek-ai/dsh-coop/types */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** A workspace cooperation role. Roles stack: one session may hold several. */
export type Role = 'master' | 'worker'

/** Gating strictness a master demands of worker pre-reviews. */
export type ReviewLevel = 'strict' | 'standard' | 'lenient'

/** Directory visibility of one registry entry. */
export type CwdScope = 'cwd' | 'any'

/** Lifecycle of a shared plan (the seven workflow states plus the abort pair). */
export type PlanStatus =
  | 'draft'
  | 'pending_pre_review'
  | 'needs_plan_revision'
  | 'ready_to_execute'
  | 'executing'
  | 'pending_verify'
  | 'needs_rework'
  | 'done'
  | 'closed'
  | 'aborting'
  | 'aborted'

/** Branded plan identifier (`plan-<uuid>`). */
export type PlanId = Branded<'CoopPlanId'>

/** One entry of the workspace-shared role registry. */
export interface CoopRegistryEntry {
  /** Session id of the registered agent (shared agent/session id space). */
  sessionId: string
  /** Roles held by that session; non-empty by invariant. */
  roles: Role[]
  /** Pre-review gating this session applies when acting as worker. */
  reviewLevel?: ReviewLevel
  /** Last registration mutation, epoch ms. */
  updatedAt: number
  /** Liveness heartbeat touched by the owning session on coop activity, epoch ms. */
  heartbeatAt: number
  /** Normalized absolute workspace the entry belongs to. */
  cwd: string
  /** Whether the entry talks only inside `cwd` or across workspaces. */
  cwdScope: CwdScope
}

/** On-disk shape of `.dsh/coop/registry.json` (per-cwd) and the global any-scope table. */
export interface CoopRegistryFile {
  version: 1
  entries: CoopRegistryEntry[]
}

/** One append to a plan's durable history trail. */
export interface CoopPlanHistoryEntry {
  time: number
  sessionId: string
  op: string
  status: PlanStatus
  summary?: string
}

/** On-disk authoritative plan state: `.dsh/coop/plans/<planId>.json`. */
export interface CoopPlanFile {
  version: 1
  planId: PlanId
  /** Absolute path of the companion markdown document. */
  docPath: string
  title: string
  objective: string
  status: PlanStatus
  /** Creating master's session id — the only identity allowed to verify or abort. */
  createdBy: string
  /** Affine worker bound at first notify; all execution gates check it. */
  assignedWorkerSessionId?: string
  /** Normalized cwd the plan was created in, for same-directory checks. */
  cwd: string
  reviewLevel: ReviewLevel
  history: CoopPlanHistoryEntry[]
  /** Present while `executing`; `heartbeatAt` feeds the executing watchdog. */
  execution?: { startedAt: number; heartbeatAt: number }
  lastReview?: CoopReviewEventData
  lastExecution?: CoopExecutionEventData
}

/** One line of an inbox signal file (cross-process delivery intent). */
export interface CoopInboxEntry {
  /** Monotonic per-file sequence assigned under the inbox writer lock. */
  seq: number
  time: number
  from: string
  planId: string
  kind: 'notify' | 'pre_review' | 'verify' | 'execution' | 'abort'
  summary: string
  docPath: string
  reason?: string
}

/** Per-session mirror of a registry mutation (audit + fold tests only). */
export interface CoopRegistryEventData {
  roles: Role[]
  reviewLevel?: ReviewLevel
  updatedAt: number
}

/** Per-session mirror of one shared-plan mutation. */
export interface CoopPlanChangeEventData {
  planId: string
  op: 'create' | 'update' | 'notify' | 'status' | 'abort'
  status: PlanStatus
  summary?: string
}

/** Per-session mirror of one review-phase outcome. */
export interface CoopReviewEventData {
  planId: string
  phase: 'pre_review' | 'verify' | 'abort_ack'
  decision: 'pass' | 'request_changes' | 'ack'
  summary?: string
}

/** Per-session mirror of one execution report. */
export interface CoopExecutionEventData {
  planId: string
  phase: 'begin' | 'report'
  summary?: string
}

/** Stable machine-routable coop failure codes. */
export type CoopErrorCode =
  | 'COOP_MASTER_ALREADY_EXISTS'
  | 'COOP_NO_WORKER'
  | 'COOP_NOT_ASSIGNED_WORKER'
  | 'COOP_NOT_PLAN_OWNER'
  | 'COOP_INVALID_TRANSITION'
  | 'COOP_REGISTRY_MISSING'
  | 'COOP_ANY_CWD_FORBIDDEN'
  | 'COOP_REMOTE_DRIVE_FORBIDDEN'
  | 'COOP_DOC_PATH_OUTSIDE_WORKSPACE'
  | 'COOP_PLAN_NOT_FOUND'
  | 'COOP_CONFIG_UNSUPPORTED'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Registry mutation mirror; audit and fold tests read it, authority stays in the shared file. */
    'coop/registry': CoopRegistryEventData
    /** Shared-plan mutation mirror. */
    'coop/plan-change': CoopPlanChangeEventData
    /** Review-phase outcome mirror. */
    'coop/review': CoopReviewEventData
    /** Execution report mirror. */
    'coop/execution': CoopExecutionEventData
  }
}
