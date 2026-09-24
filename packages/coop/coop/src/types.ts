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
  kind: 'drive' | 'notify' | 'pre_review' | 'verify' | 'execution' | 'abort' | 'node' | 'task'
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
    | 'COOP_DAG_CYCLE_REJECTED'
    | 'COOP_TASK_NOT_FOUND'
    | 'COOP_WORKTREE_NOT_FOUND'
    | 'COOP_WORKTREE_NAME_TAKEN'
    | 'COOP_WORKTREE_MERGE_CONFLICT'

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
  /** Skills this node declares; the scheduler matches task skill demands against them. */
  skills?: string[]
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
/** Lifecycle of one v2 plan (review gate arrives with P3). */
export type V2PlanStatus = 'designing' | 'reviewing' | 'active' | 'closing' | 'closed' | 'aborted'

/** Lifecycle of one v2 task inside a plan DAG. */
export type V2TaskStatus =
  | 'pending'
  | 'ready'
  | 'assigned'
  | 'executing'
  | 'reporting'
  | 'verifying'
  | 'done'
  | 'rework'
  | 'blocked'
  | 'cancelled'

/** One task node of a v2 plan DAG. */
export interface CoopV2Task {
  /** Short per-plan task id (`t<n>`), unique inside the plan. */
  taskId: string
  title: string
  /** Full task brief handed to the assigned worker. */
  spec: string
  status: V2TaskStatus
  /** Upstream task ids derived from the plan's edges; all done ⇒ ready. */
  dependsOn: string[]
  /** Bound worker session currently owning the task. */
  assignee?: string
  /** Worktree directory the task runs in, once one is allocated. */
  worktreeId?: string
  /** Executor style the task declares; subagent arrives with P3. */
  executor: 'inline' | 'subagent'
  /** Skills the assigned worker must cover. */
  skills: string[]
  /** Rework round count; verify request_changes increments. */
  attempts: number
  /** Epoch ms of the first scheduler assignment; anchors the hard deadline. */
  assignedAt?: number
  /** Present while `executing`; `heartbeatAt` feeds the executing watchdog. */
  execution?: { startedAt: number; heartbeatAt: number }
  /** Deadline hints from assignment; `hardMs` past due blocks the task. */
  deadlines?: { softMs?: number; hardMs?: number }
  createdAt: number
  updatedAt: number
  /** Latest verify conclusion, once one exists. */
  verify?: { decision: 'pass' | 'request_changes'; summary?: string; by: string; at: number }
  /** Latest worker report text, once one exists. */
  report?: { summary: string; by: string; at: number }
}

/** One append to a v2 plan's history trail. */
export interface CoopV2PlanHistoryEntry {
  time: number
  sessionId: string
  op: string
  summary?: string
}

/** On-disk authoritative v2 plan: `v2/masters/<masterId>/plans/<planId>.json`. */
export interface CoopV2PlanFile {
  version: 2
  planId: string
  /** Owning master id; every operation filters on it. */
  masterId: MasterId
  /** Git repo root this plan is bound to (§12.1: no cross-repo plans). */
  repoRoot: string
  title: string
  objective: string
  status: V2PlanStatus
  /** Creating master session id. */
  createdBy: string
  /** Normalized workspace cwd the plan was created in. */
  cwd: string
  createdAt: number
  tasks: CoopV2Task[]
  /** DAG edges; `from` finishing unblocks `to`. */
  edges: { from: string; to: string }[]
  history: CoopV2PlanHistoryEntry[]
}
/** Lifecycle of one coop-managed worktree. */
export type CoopWtStatus = 'active' | 'merged' | 'cleaned'

/** One entry of the global worktree occupancy table `v2/wt-registry.json`. */
export interface CoopWtEntry {
  /** Absolute worktree directory (`<workspace>/wt/<masterId>/<seq>-<slug>`). */
  dir: string
  /** Owning master id. */
  masterId: string
  /** Plan the worktree was created for. */
  planId: string
  /** Git repo root the worktree branches from (§12.1). */
  repoRoot: string
  /** Branch checked out in the worktree. */
  branch: string
  /** Branch the worktree is merged back into. */
  baseBranch: string
  /** Free-form purpose recorded at creation. */
  purpose?: string
  createdAt: number
  status: CoopWtStatus
}

/** On-disk shape of `.dsh/coop/v2/wt-registry.json`. */
export interface CoopWtRegistryFile {
  version: 1
  entries: CoopWtEntry[]
}
