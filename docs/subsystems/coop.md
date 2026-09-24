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

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

/**
     * Explicitly anchor a workspace root for this session's directory tree.
     * Never invoked implicitly — the anchor file is the only marker later
     * sessions use to adopt this root (spec §3.1/§12.5: a parent directory is
     * never claimed silently).
     * @param agent - anchoring live agent.
     * @param target - explicit root; defaults to the session cwd's parent.
     * @returns the anchored workspace root.
     */
async initWorkspace(agent: Agent, target?: string): Promise<string>

/**
     * Register this session as a v2 node. A master mints (or resumes) its
     * masterId and profile; a worker/reviewer lands `unbound` for any master to
     * adopt, or pre-bound when `masterId` names a live master with spare
     * capacity. Empty roles deregister.
     * @param agent - registering live agent.
     * @param req - target roles, optional owning master, model route, and directory scope.
     * @returns the committed registry entry.
     */
async registerV2( agent: Agent, req: { roles: V2Role[]; masterId?: string; model?: string; cwdScope?: CwdScope; skills?: string[] }, ): Promise<CoopV2RegistryEntry>

/**
     * Nodes visible to the caller under v2 isolation: a master sees itself, its
     * bound nodes, and every `unbound` worker/reviewer (the only globally
     * visible window); a worker/reviewer sees itself and its owning master.
     * @param agent - querying live agent.
     * @param opts - `unboundOnly` keeps just adoptable nodes.
     * @returns fresh entries in scope.
     */
async listNodesV2(agent: Agent, opts: { unboundOnly?: boolean } = {}): Promise<CoopV2RegistryEntry[]>

/**
     * Adopt one `unbound` worker/reviewer for the calling master. The bind
     * commits under the registry writer lock; once bound, the node disappears
     * from every other master's view — isolation is enforced by visibility, not
     * by a second lock domain.
     * @param agent - binding live master.
     * @param sessionId - target node session id.
     * @returns the bound entry.
     */
async bindNode(agent: Agent, sessionId: string): Promise<CoopV2RegistryEntry>

/**
     * Return one bound node to the `unbound` pool; only its owning master may.
     * @param agent - releasing live master.
     * @param sessionId - target node session id.
     */
async releaseNode(agent: Agent, sessionId: string): Promise<void>

/**
     * Human/model summary across the workspace: live masters, the caller's own
     * nodes, and the adoptable unbound count. Cross-master detail stays
     * summarized — isolation applies to agents, not to the human operator.
     * @param agent - querying live agent.
     * @returns the caller's entry, master ids, own nodes, and unbound count.
     */
async statusV2(agent: Agent): Promise<{ self: CoopV2RegistryEntry | undefined masters: string[] own: CoopV2RegistryEntry[] unbound: number }>

/**
     * Create a v2 plan bound to one repo root (§12.1: no cross-repo plans).
     * Master-only; the plan lands `designing` with an empty DAG and a markdown
     * trail. P3 routes activation through reviewer sign-off.
     * @param agent - creating live master.
     * @param req - title, objective, and optional repo root (defaults to the cwd).
     * @returns the committed designing plan.
     */
async createPlanV2(agent: Agent, req: { title: string; objective: string; repoRoot?: string }): Promise<CoopV2PlanFile>

/**
     * Submit a designing plan to review (master only): designing → reviewing
     * and every fresh bound reviewer is woken (§6.3).
     * @param agent - submitting live master.
     * @param planId - plan to submit.
     * @returns the committed reviewing plan.
     */
async submitReviewV2(agent: Agent, planId: string): Promise<CoopV2PlanFile>

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
async reviewPlanV2( agent: Agent, planId: string, decision: 'pass' | 'request_changes', summary?: string, ): Promise<CoopV2PlanFile>

/**
     * Add one task to a non-terminal plan; `dependsOn` becomes DAG edges and a
     * cycle is rejected under the plan lock. Schedules afterwards.
     * @param agent - adding live master.
     * @param planId - target plan.
     * @param req - title, spec, dependencies, executor style, and skill demands.
     * @returns the committed task.
     */
async addTaskV2( agent: Agent, planId: string, req: { title: string spec: string dependsOn?: string[] executor?: 'inline' | 'subagent' skills?: string[] worktreeId?: string deadlines?: { softMs?: number; hardMs?: number } }, ): Promise<CoopV2Task>

/**
     * Update a task's brief while it is not in flight (executing/reporting/
     * verifying tasks are locked).
     * @param agent - updating live master.
     * @param planId - owning plan.
     * @param taskId - target task.
     * @param req - optional title, spec, executor style, and skill demands.
     * @returns the committed task.
     */
async updateTaskV2( agent: Agent, planId: string, taskId: string, req: { title?: string; spec?: string; executor?: 'inline' | 'subagent'; skills?: string[] }, ): Promise<CoopV2Task>

/**
     * Add one dependency edge (`from` finishing unblocks `to`) to a
     * non-terminal plan; cycles reject under the lock. Idempotent.
     * @param agent - linking live master.
     * @param planId - owning plan.
     * @param req - upstream and downstream task ids.
     */
async linkTaskV2(agent: Agent, planId: string, req: { from: string; to: string }): Promise<void>

/**
     * Cancel one task of a non-terminal plan; an in-flight task's assignee is
     * signalled, downstream dependencies go blocked, and capacity is freed.
     * @param agent - cancelling live master.
     * @param planId - owning plan.
     * @param taskId - target task.
     */
async cancelTaskV2(agent: Agent, planId: string, taskId: string): Promise<void>

/**
     * Kanban projection: one plan (or every plan of the caller's master) with
     * lazily recomputed readiness. Read-only for the caller.
     * @param agent - querying live master.
     * @param planId - optional single plan id.
     * @returns the plan snapshots.
     */
async boardV2(agent: Agent, planId?: string): Promise<CoopV2PlanFile[]>

/**
     * Assigned worker starts (or restarts after rework): assigned/rework →
     * executing. Only the task's assignee may begin.
     * @param agent - assigned live worker.
     * @param planId - owning plan.
     * @param taskId - target task.
     * @returns the committed executing task.
     */
async executeBeginV2(agent: Agent, planId: string, taskId: string): Promise<CoopV2Task>

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
async executeReportV2(agent: Agent, planId: string, taskId: string, summary: string): Promise<CoopV2Task>

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
async verifyTaskV2( agent: Agent, planId: string, taskId: string, decision: 'pass' | 'request_changes', summary?: string, ): Promise<CoopV2Task>

/**
     * Close a finished plan: every task must be done or cancelled. P2 inserts
     * worktree merge/clean ahead of this step.
     * @param agent - closing live master.
     * @param planId - plan to close.
     * @returns the committed closed plan.
     */
async closePlanV2(agent: Agent, planId: string): Promise<CoopV2PlanFile>

/**
     * Abort a plan: any non-terminal status cancels every open task (in-flight
     * assignees are signalled to stop) and the plan lands `aborted`.
     * @param agent - aborting live master.
     * @param planId - plan to abort.
     * @returns the committed aborted plan.
     */
async abortPlanV2(agent: Agent, planId: string): Promise<CoopV2PlanFile>

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
async createWorktreeV2( agent: Agent, planId: string, req: { from?: string; branch?: string; purpose?: string } = {}, ): Promise<CoopWtEntry>

/**
     * List the caller's worktree occupancy rows, optionally narrowed to a plan.
     * @param agent - querying live master.
     * @param planId - optional plan filter.
     * @returns the matching entries.
     */
async listWorktreesV2(agent: Agent, planId?: string): Promise<CoopWtEntry[]>

/**
     * Merge one active worktree's branch back into its base branch
     * (`git merge --no-ff`). A moved base checkout or a conflicted merge aborts
     * fail-loud with `COOP_WORKTREE_MERGE_CONFLICT` (§6.4: no auto-resolution).
     * @param agent - merging live master.
     * @param dir - worktree directory.
     * @returns the merged occupancy entry.
     */
async mergeWorktreeV2(agent: Agent, dir: string): Promise<CoopWtEntry>

/**
     * Remove one worktree (`git worktree remove`) and mark its row `cleaned`.
     * @param agent - cleaning live master.
     * @param dir - worktree directory.
     * @param opts - `force` discards local modifications.
     */
async cleanWorktreeV2(agent: Agent, dir: string, opts: { force?: boolean } = {}): Promise<void>

/**
     * Assigned worker heartbeat while executing; feeds the executing
     * watchdog (§5.2: silent `executingStaleMs` falls back to rework).
     * @param agent - executing live worker.
     * @param planId - owning plan.
     * @param taskId - target task.
     */
async touchExecutionV2(agent: Agent, planId: string, taskId: string): Promise<void>

/**
     * The newest memory lines of the calling node's master (§12.3: recency
     * top-K, no relevance algorithm; targeted recall is coop_memory_search).
     * @param agent - querying live node.
     * @returns the newest injected lines, newest first.
     */
async memoryLinesV2(agent: Agent): Promise<string[]>

/**
     * Keyword search over the calling node's master memory (isolation: other
     * masters' trails are invisible).
     * @param agent - querying live node.
     * @param req - query text and optional limit.
     * @returns matching entries, newest first.
     */
async searchMemoryV2(agent: Agent, req: { query: string; limit?: number }): Promise<CoopMemoryEntry[]>

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
async createNodeV2( agent: Agent, req: { role: 'worker' | 'reviewer'; model?: string; workdir?: string }, ): Promise<{ spawned: 'herdr' | 'headless'; paneId?: string; entry?: CoopV2RegistryEntry }>
```

Types: [Agent](core.md)

Source: [`packages/coop/coop/src/service.ts`](../../packages/coop/coop/src/service.ts)
<!-- END GENERATED cordis-surface -->
