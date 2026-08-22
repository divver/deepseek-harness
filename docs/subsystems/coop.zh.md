# 跨 session 协作

English | [中文](coop.md)

同一项目目录下多个 `dsh` session 间的 Master/Worker 计划协作。`.dsh/coop/` 下的 workspace 共享文件存储是权威——注册表、计划、markdown 文档与 inbox 信令——每个参与 session 把自己的动作以 `coop/registry`、`coop/plan-change`、`coop/review`、`coop/execution` 事件镜像进各自日志（观察记录；任何分歧以共享文件为准）。

## 角色与 workspace 边界

`Role` 为 `master | worker`；角色可在同一 session 上叠加。注册信息存于 `.dsh/coop/registry.json`；每个 workspace 只允许一个存活 `master`（在注册表写锁内强制），过期条目（`heartbeatAt` 超过 `staleMs`）不再阻塞抢占。`cwdScope: "any"` 把可见性扩大到项目目录之外，并同时把条目写入 harness home 下的全局表。

```ts type-equiv
/** A workspace cooperation role. */
type Role = 'master' | 'worker'
/** Pre-review gating a master demands of workers. */
type ReviewLevel = 'strict' | 'standard' | 'lenient'
/** Directory visibility of one registry entry. */
export type CwdScope = 'cwd' | 'any'
```

## 共享状态

计划是 `.dsh/coop/plans/<planId>.json`；每份计划配有 markdown 文档，承载 Objective / Pre-review / Execution / Verify / Abort / Changelog 段落。每次状态迁移都对照当前状态校验，并在单个 plan 写锁内提交——模型侧调用者永远见不到冲突、也永远不需要重试。

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

十一态工作流、投递协议、超时与配置键由[包 README](../../packages/coop/coop/README.md) 拥有；评审后的设计决策见 [dsh-coop Agent Note](../../.agents/notes/implemented/architecture/2026-08-22-dsh-coop-shared-file-authority.md)。

## Service 行为

[`CoopService`](../../packages/coop/coop/src/service.ts) 拥有注册、计划迁移、惰性 watchdog 闭环（静默 `executing` → `needs_rework`，未确认的 `aborting` → `aborted`）以及单一路径的通知投递：每条通知成为一行 inbox 信令，由接收 session drain 成被唤醒的 `Agent.followup` turn 并推进其水位。

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
