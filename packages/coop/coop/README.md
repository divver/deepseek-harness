# @deepseek-ai/dsh-coop

English | [中文](README.zh.md)

Cross-session Master/Worker plan cooperation over a workspace-shared file store. Several `dsh` sessions in the same project directory (same normalized `cwd`) register as `master` or `worker` and drive shared plans through an eleven-state workflow; the files under `.dsh/coop/` are the authority, and each session mirrors what it did into its own session log.

## Model

- **Registry** — `.dsh/coop/registry.json` holds `{ sessionId, roles, reviewLevel?, updatedAt, heartbeatAt, cwd, cwdScope }`. One live `master` per workspace: the singleton check runs inside the registry writer lock (`withFileLock`), so two processes cannot both become master. Every live session touches its heartbeat on each poll tick (`inboxPollMs`), so an open session stays visible indefinitely; a stale entry (`heartbeatAt` older than `staleMs`) stops blocking and may be preempted. Entries with `cwdScope: "any"` are also written to the global table under `$DSH_HOME`/`~/.dsh` and are visible from any workspace.
- **Plans** — `.dsh/coop/plans/<planId>.json` is the authoritative plan state; `.dsh/coop/docs/<planId>.md` carries the human-readable trail (Objective / Pre-review / Execution / Verify / Abort / Changelog). Every status transition validates and commits inside one plan lock; model callers never see conflicts and never retry.
- **Delivery** — single-path. A notification appends a signal line to `.dsh/coop/inbox/<sessionId>.jsonl` (monotonic `seq`); the receiving session delivers every line above its watermark (`.dsh/coop/inbox/.consumed/<sessionId>`) to its own agent via `Agent.followup`, which wakes the driver and lands in the transcript as a real turn. Same-process targets drain immediately; every live session also polls its inbox every `inboxPollMs` (default 1s), so an open-but-idle worker sees a notification — and streams the resulting turn into its TUI — within one poll interval. Append and watermark writes never touch the same file, so nothing can be lost or delivered twice.
- **Mirrors** — `coop/registry`, `coop/plan-change`, `coop/review`, `coop/execution` are appended to the acting session's log for audit and replay folds. They are observation records; the shared files win on any divergence.

## Workflow

```
create → draft → notify → pending_pre_review → pre_review(pass) → ready_to_execute
       → execute_begin → executing → execute_report → pending_verify
       → verify(pass) → done → closed
pre_review(request_changes) → needs_plan_revision → (master updates, re-notify)
verify(request_changes)     → needs_rework → execute_begin …
abort (any non-terminal)    → aborting → abort_ack → aborted
                            → ack timeout → aborted (master closes)
executing heartbeat timeout → needs_rework (worker may re-begin)
```

Only the creating master verifies or aborts; only the affine worker (bound at first notify) pre-reviews, executes, or acknowledges.

## Configuration

All fields optional; enum and positivity rules fail loud at load.

| Key | Default | Meaning |
|---|---|---|
| `mirrorEvents` | `false` | Append the four `coop/*` mirror events to each acting session log |
| `defaultReviewLevel` |
| `docRoot` | `.dsh/coop` | Workspace-relative store root |
| `allowNoWorker` | `false` | Let a master self-assign when no worker is visible |
| `staleMs` | `300000` | Registry heartbeat window; also gates master takeover |
| `executingStaleMs` | `600000` | Executing-heartbeat window before needs_rework |
| `abortAckTimeoutMs` | `120000` | Abort-ack window before the master closes aborted |
| `workerSelector` | `earliest` | `earliest` or `round-robin` first-notify binding |
| `inboxCompactThreshold` | `256` | Delivered signal lines before compaction |
| `allowAnyCwdRoles` | `[master, worker]` | Roles allowed to declare `cwdScope: "any"` |
| `mode` | `v1` | `v2` selects the multi-master node registry (see below) |
| `maxWorkers` | `4` | v2 per-master worker capacity enforced at bind and registration |
| `maxReviewers` | `2` | v2 per-master reviewer capacity enforced at bind and registration |
| `maxParallelTasks` | `3` | v2 per-master limit on concurrently assigned+executing tasks across plans |
| `allowSelfReview` | `false` | v2 let the master verify its own tasks when no reviewer is bound (§12.4) |

## v2 mode (P0 shipped)

Set `mode: "v2"` to switch to the multi-master node registry ([spec](../../../.agents/specs/2026-09-24-coop-v2-multi-master-dag.md)). P0 ships the registry layer; plan/DAG, worktrees, reviewer gates, and memory arrive with later phases.

- **Roles** — `master` / `worker` / `reviewer` register into `.dsh/coop/v2/registry.json`. A master mints a `masterId` (`<slug>#<uuid>`); workers/reviewers land `unbound`.
- **Exclusive bind** — `coop_bind` adopts an unbound node under the registry writer lock; once bound, the node is visible to that master alone (isolation is enforced by visibility). `coop_release` returns it to the unbound pool; capacity follows `maxWorkers` / `maxReviewers`.
- **Workspace anchor** — nodes resolve the nearest `.dsh/coop/workspace.json` walking up from the session cwd, else the cwd itself. A parent directory becomes a workspace only via `/coop workspace init [path]` — never silently.
- **Commands** — `/coop master|worker|reviewer [--master <id>] [--model <route>] [--any-cwd]`, `/coop list [--unbound]`, `/coop bind|release <sessionId>`, `/coop status`, `/coop off`, `/coop workspace init [path]`.
- **Tools** — `coop_register`, `coop_list`, `coop_bind`, `coop_release`, `coop_status`; the v1 eleven are not registered in v2 mode.
- **Plans are task DAGs (P1)** — `coop_plan_create` (bound to one `repoRoot`, §12.1) → `coop_task_add`/`coop_task_link`/`coop_task_cancel` (cycle-checked under the plan lock) → `coop_plan_activate`. Readiness derives from the DAG; the scheduler assigns ready tasks to idle bound workers (skill demands ⊆ declared skills, `maxParallelTasks`) and wakes them with `task assigned` signals. Workers run `coop_execute_begin` → `coop_execute_report`; a bound reviewer verifies with `coop_task_verify` (`pass` → done and downstream goes ready; `request_changes` → rework for the same worker). `coop_board` is the kanban projection; `coop_plan_close` requires every task done/cancelled; `coop_plan_abort` cancels open tasks and signals in-flight assignees.
- **Worktrees (P2)** — `coop_worktree_create` branches a plan's `repoRoot` into `<workspace>/wt/<masterId>/<seq>-<slug>` through the mounted shell seam (git runs via `ctx.shell`, never raw `child_process`); the directory name is claimed under the global `wt-registry.json` lock, so masters never collide. The scheduler hands each assigned task a free worktree (exclusive) and names it in the wake-up signal. `coop_worktree_merge` merges back with `git merge --no-ff` (a moved base or a conflict aborts fail-loud as `COOP_WORKTREE_MERGE_CONFLICT` — no auto-resolution, §6.4); `coop_plan_close` auto-merges every still-active worktree first; `coop_worktree_clean` removes one (`force` discards modifications). Plan-review gating, subagent executors, and memory arrive with P3–P4. `coop_board` is the kanban projection; `coop_plan_close` requires every task done/cancelled; `coop_plan_abort` cancels open tasks and signals in-flight assignees. Worktrees, plan-review gating, subagent executors, and memory arrive with P2–P4.

## Human commands

`/coop role <master|worker> [--level L] [--any-cwd]`, `/coop role list [--all]`, `/coop role off`, `/coop plan notify <planId> [--worker <sessionId>]`, `/coop abort <planId> [--reason <text>]`.

## Model Experience

### Tool schema

#### What the model sees

The model sees the generated [`coop_*` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-coop): `coop_register`, `coop_list`, `coop_plan_create`, `coop_plan_notify`, `coop_pre_review`, `coop_execute_begin`, `coop_execute_report`, `coop_verify`, `coop_abort`, `coop_abort_ack`, `coop_status`.

#### Token effect

Fixed schema cost while visible; the injected `coop:policy` prompt section adds a fixed block describing the state machine and the act-on-wake rule.

#### KV Cache effect

Prefix-stable while plugin visibility is unchanged.

### Tool-call history and result

#### What the model sees

Each tool answers with one compact text line naming the plan id and resulting status. Stable failures carry `CoopError` codes in the message: `COOP_MASTER_ALREADY_EXISTS`, `COOP_NO_WORKER`, `COOP_NOT_ASSIGNED_WORKER`, `COOP_NOT_PLAN_OWNER`, `COOP_INVALID_TRANSITION`, `COOP_REGISTRY_MISSING`, `COOP_PLAN_NOT_FOUND`, `COOP_DOC_PATH_OUTSIDE_WORKSPACE`. Cross-session notifications arrive as `[coop] …` user turns with a notice-form `plugin: coop` source.

#### Token effect

Plan history grows in the shared files, not in any transcript; each session's log only gains its own mirror events plus received notification turns.

#### KV Cache effect

Append-only notifications follow the reusable prefix and do not invalidate existing entries.

## Known Limitations and Deferred Work

- **Execution interrupt is deferred** — abort is a policy-level soft stop (state machine + prompt instruction). The plan→AbortController execution-interrupt pipeline over shell/subprocess/workflow is the spec's separate P4 and has no code here.
- **`autoDrive` config is rejected, not implemented** — deterministic service-driven execution would let a cross-cwd notification trigger tools without the model in the loop; until the execution-interrupt pipeline exists the loader fails loud instead of accepting the key.
- **Mirror events are off by default** — `Session.append` cannot mark an event envelope ignorable, so a log carrying `coop/*` mirrors is unresumable on any build whose vocabulary predates them. Set `mirrorEvents: true` only when every reader build knows the vocabulary; the shared files remain authoritative without them.
- **Liveness is heartbeat-only** — the persisted-header existence check (`ctx.sessionPersistence.list()`) named by the spec is deferred; `staleMs` alone decides freshness and takeover.
- **Delivery is poll-based across processes** — signals are picked up on session start plus a 1s inbox poll; there is no push channel or fs watcher (non-goal for v1), so worst-case cross-process latency is one poll interval.
