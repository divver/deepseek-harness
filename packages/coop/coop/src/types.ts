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
  kind: 'drive' | 'notify' | 'pre_review' | 'verify' | 'execution' | 'abort' | 'node'
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
    | 'COOP_NODE_NOT_FOUND'
    | 'COOP_NODE_ALREADY_BOUND'
    | 'COOP_NODE_LIMIT_REACHED'
    | 'COOP_NOT_YOUR_NODE'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Registry mutation mirror; audit and fold tests read it, authority stays in the shared file. */
    'coop/registry': CoopRegistryEventData
    /** v2 registry mutation mirror (roles, bind, release). */
    'coop/registry-v2': CoopV2RegistryEventData
    /** Shared-plan mutation mirror. */
    'coop/plan-change': CoopPlanChangeEventData
    /** Review-phase outcome mirror. */
    'coop/review': CoopReviewEventData
    /** Execution report mirror. */
    'coop/execution': CoopExecutionEventData
  }
}
/** A v2 cooperation role: master orchestrates, worker executes, reviewer gates. */
export type V2Role = 'master' | 'worker' | 'reviewer'

/** Whether a v2 node is adoptable by any master or exclusively owned by one. */
export type BindState = 'unbound' | 'bound'

/** Branded master identifier (`<slug>#<short-uuid>`); the v2 isolation unit. */
export type MasterId = Branded<'CoopMasterId'>

/** One entry of the v2 workspace-shared node registry. */
export interface CoopV2RegistryEntry {
  /** Session id of the registered agent (shared agent/session id space). */
  sessionId: string
  /** Roles held by that session; masters hold exactly `['master']`. */
  roles: V2Role[]
  /** Owning master for bound nodes; the master's own id for master nodes. */
  masterId?: MasterId
  /** Exclusive ownership marker; `unbound` nodes are visible to every master. */
  bindState: BindState
  /** Normalized absolute cwd the node registered from. */
  cwd: string
  /** Whether the node talks only inside its cwd or across workspaces. */
  cwdScope: CwdScope
  /** Last registry mutation, epoch ms. */
  updatedAt: number
  /** Liveness heartbeat touched by the owning session, epoch ms. */
  heartbeatAt: number
  /** Optional registration metadata; `model` is the LlmAdapter route string. */
  meta?: { model?: string; provider?: string; pid?: number; host?: string }
}

/** On-disk shape of `.dsh/coop/v2/registry.json` and the global any-scope v2 table. */
export interface CoopV2RegistryFile {
  version: 2
  entries: CoopV2RegistryEntry[]
}

/** Workspace anchor evidence: `<root>/.dsh/coop/workspace.json`, written only by `/coop workspace init`. */
export interface CoopWorkspaceFile {
  version: 2
  root: string
  createdAt: number
}

/** One master's durable profile under `v2/masters/<masterId>/profile.json`. */
export interface CoopV2MasterProfile {
  masterId: MasterId
  sessionId: string
  displayName: string
  createdAt: number
  status: 'active' | 'retired'
}

/** Per-session mirror of a v2 registry mutation (audit only; the shared file is authority). */
export interface CoopV2RegistryEventData {
  op: 'register' | 'bind' | 'release' | 'off'
  roles: V2Role[]
  masterId?: string
  bindState?: BindState
  updatedAt: number
}
