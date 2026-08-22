# Cross-session cooperation

English | [中文](coop.zh.md)

Master/Worker plan cooperation across several `dsh` sessions in one project directory. The workspace-shared file store under `.dsh/coop/` is the authority — registry, plans, markdown documents, and inbox signals — and every participating session mirrors its own actions into its log as `coop/registry`, `coop/plan-change`, `coop/review`, and `coop/execution` events (observation records; the shared files win on divergence).

## Roles and the workspace boundary

`Role` is `master | worker`; roles stack on one session. Registration lives in `.dsh/coop/registry.json`; exactly one live `master` per workspace is enforced inside the registry writer lock, and a stale entry (`heartbeatAt` older than `staleMs`) stops blocking takeover. `cwdScope: "any"` widens visibility beyond the project directory and additionally writes the entry to the global table under the harness home.

```ts type-equiv
/** A workspace cooperation role. */
type Role = 'master' | 'worker'
/** Pre-review gating a master demands of workers. */
type ReviewLevel = 'strict' | 'standard' | 'lenient'
/** Directory visibility of one registry entry. */
export type CwdScope = 'cwd' | 'any'
```

## Shared state

Plans are `.dsh/coop/plans/<planId>.json`; each has a companion markdown document carrying Objective / Pre-review / Execution / Verify / Abort / Changelog sections. Every status transition validates against the current status and commits inside one plan writer lock — model callers never observe conflicts and never retry.

```ts type-equiv
interface CoopPlanFile {
  version: 1
  planId: PlanId
  docPath: string
  title: string
  objective: string
  status: PlanStatus
  createdBy: string
  assignedWorkerSessionId?: string
  cwd: string
  reviewLevel: ReviewLevel
  history: { time: number; sessionId: string; op: string; status: PlanStatus }[]
  execution?: { startedAt: number; heartbeatAt: number }
}
```

The eleven-state workflow, delivery protocol, timeouts, and configuration keys are owned by the [package README](../../packages/coop/coop/README.md); the reviewed design decisions live in the [dsh-coop Agent Note](../../.agents/notes/implemented/architecture/2026-08-22-dsh-coop-shared-file-authority.md).

## Service behavior

[`CoopService`](../../packages/coop/coop/src/service.ts) owns registration, plan transitions, lazy watchdog closure (silent `executing` → `needs_rework`, unacknowledged `aborting` → `aborted`), and single-path notification delivery: every notification becomes an inbox signal line that the receiving session drains into a woken `Agent.followup` turn, advancing its watermark.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxcoop--coopservice"></a>

### `ctx.coop` — `CoopService`

Master/worker cooperation over a workspace-shared file store. The class is the plugin: the Loader instantiates it with Config, and the optional tool/command/policy children mount only when their seams are composed.

```ts cordis-catalog
/**
 * Roles held by one agent, read from the shared registry (fail-loud when absent).
 * @param agent - querying live agent.
 * @returns the roles held in the shared registry (empty when unregistered).
 */
async getRoles(agent: Agent): Promise<Role[]>

/**
 * Register, update, or drop the calling agent's roles in the shared registry.
 * Master registration runs its singleton check under the registry writer
 * lock, so two processes cannot both become master.
 * @param agent - acting live agent.
 * @param ops - additive/removal deltas or a full replacement set.
 * @param opts - directory scope for newly declared visibility, and the worker gating level.
 * @returns the resulting role set (empty means deregistered).
 */
async setRoles( agent: Agent, ops: { add?: Role[]; remove?: Role[] } | { set: Role[] }, opts: { cwdScope?: 'cwd' | 'any'; reviewLevel?: ReviewLevel } = {}, ): Promise<Role[]>

/**
 * Visible live registrations for one workspace (same cwd plus any-scope), or
 * every entry in both tables with `all`.
 * @param agent - querying live agent anchoring the workspace.
 * @param opts - `all` bypasses the same-directory filter (the `--all` flag).
 * @returns fresh entries, deduplicated across the local and global tables.
 */
async listWorkspace(agent: Agent, opts: { all?: boolean } = {}): Promise<CoopRegistryEntry[]>

/**
 * Create a shared plan and its markdown document. Master-only.
 * @param agent - creating live agent (must hold the master role).
 * @param req - title, objective, and optional review level override.
 * @returns the committed draft plan.
 */
async createPlan(agent: Agent, req: { title: string; objective: string; reviewLevel?: ReviewLevel }): Promise<CoopPlanFile>

/**
 * Load one plan with lazy watchdog transitions applied.
 * @param agent - reading live agent anchoring the workspace.
 * @param planId - plan to load.
 * @returns the plan with any due watchdog transition applied.
 */
async getPlan(agent: Agent, planId: string): Promise<CoopPlanFile>

/**
 * All plans in the agent's workspace, watchdog applied, newest history first.
 * @param agent - querying live agent.
 * @returns plans ordered by most recent history entry.
 */
async listPlans(agent: Agent): Promise<CoopPlanFile[]>

/**
 * Bind (or rebind) the affine worker and deliver the plan notification.
 * Master-only, creator-only. A repeat notify while already
 * `pending_pre_review` is a no-op that keeps the bound worker.
 * @param agent - notifying live agent.
 * @param planId - plan to announce.
 * @param opts - explicit worker, reassignment intent, and a short summary.
 * @returns the committed plan with its affine worker bound.
 */
async notifyPlan( agent: Agent, planId: string, opts: { workerSessionId?: string; reassign?: boolean; summary?: string } = {}, ): Promise<CoopPlanFile>

/**
 * Worker pre-review gate.
 * @param agent - assigned worker live agent.
 * @param planId - plan under review.
 * @param decision - pass promotes to ready_to_execute; request_changes returns the plan.
 * @param summary - one-line rationale recorded in the plan document.
 * @returns the committed plan in ready_to_execute or needs_plan_revision.
 */
async submitPreReview(agent: Agent, planId: string, decision: 'pass' | 'request_changes', summary?: string): Promise<CoopPlanFile>

/**
 * Worker starts executing: ready_to_execute (or needs_rework retry) → executing.
 * @param agent - assigned worker live agent.
 * @param planId - plan to begin.
 * @returns the committed executing plan.
 */
async beginExecution(agent: Agent, planId: string): Promise<CoopPlanFile>

/**
 * Worker heartbeat while executing; feeds the executing watchdog.
 * @param agent - assigned worker live agent.
 * @param planId - executing plan.
 */
async touchExecution(agent: Agent, planId: string): Promise<void>

/**
 * Worker reports execution results: executing → pending_verify, then wakes the master.
 * @param agent - assigned worker live agent.
 * @param planId - executed plan.
 * @param summary - what was done, recorded in the plan document.
 * @returns the committed pending_verify plan.
 */
async reportExecution(agent: Agent, planId: string, summary: string): Promise<CoopPlanFile>

/**
 * Master verification: pass closes the plan (done → closed); request_changes
 * returns it to the assigned worker as needs_rework.
 * @param agent - creating master live agent.
 * @param planId - plan under verification.
 * @param decision - pass or request_changes.
 * @param summary - acceptance rationale or rework demand.
 * @returns the committed plan (closed on pass, needs_rework otherwise).
 */
async verifyPlan(agent: Agent, planId: string, decision: 'pass' | 'request_changes', summary?: string): Promise<CoopPlanFile>

/**
 * Master abort: any non-terminal status moves to aborting and the assigned
 * worker is told to stop. Repeat aborts while already aborting re-deliver.
 * @param agent - creating master live agent.
 * @param planId - plan to stop.
 * @param reason - human-readable stop rationale.
 * @returns the committed aborting plan.
 */
async abortPlan(agent: Agent, planId: string, reason?: string): Promise<CoopPlanFile>

/**
 * Assigned worker acknowledges an abort: aborting → aborted.
 * @param agent - assigned worker live agent.
 * @param planId - stopped plan.
 * @returns the committed aborted plan.
 */
async abortAck(agent: Agent, planId: string): Promise<CoopPlanFile>

/**
 * Deliver every undelivered signal addressed to one agent and advance its
 * watermark. Each delivered line becomes a woken follow-up turn.
 * @param agent - receiving live agent.
 * @returns how many previously undelivered signals were delivered.
 */
async drainInbox(agent: Agent): Promise<number>
```

Types: [Agent](core.md)

Source: [`packages/coop/coop/src/service.ts:113`](../../packages/coop/coop/src/service.ts)
<!-- END GENERATED cordis-surface -->
