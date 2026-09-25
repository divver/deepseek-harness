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
| `maxReworkAttempts` | `3` | v2 rework rounds before a task escalates to blocked |
| `memoryInjectTopK` | `8` | v2 memory records injected into the coop:memory prompt section (§12.3 recency top-K) |
| `memoryRetainEntries` | `256` | v2 memory trail retention budget per master; appends drop the oldest beyond it |
| `spawn` | `auto` | v2 node auto-creation transport: `herdr` pane when reachable, `headless` in-process, `auto` picks |
| `spawnCommand` | `dsh --cwd {cwd}` | v2 command template run in a spawned herdr pane; `{cwd}` is replaced |
| `spawnReadyRegex` | _(empty)_ | v3 regex the spawned pane must match before its registration line is sent |
| `allowSelfReview` | `false` | v2 let the master verify its own tasks when no reviewer is bound (§12.4) |
| `roleLlm` | _(empty)_ | v2 per-role LLM routes `{ master\|worker\|reviewer: { provider, model, reasoningEffort? } }`; every request of a session registered under that role is rewritten onto the route (provider+model pair, adapter-interpreted effort) |
| `spawnRegisterTimeoutMs` | `30000` | v2 window waiting for a spawned pane's registration to land in the registry; the registration line is re-sent roughly every 4 s meanwhile, and a timeout fails loud with the manual line quoted |
| `spawnLayout` | `columns` | v2 arrangement of auto-spawned panes: `columns` — master in one column, workers stacked in a column, reviewers stacked in a column right of the workers; `right` — legacy behavior, every pane split right of the master |

## v2 mode (P0 shipped)

Set `mode: "v2"` to switch to the multi-master node registry ([spec](../../../.agents/specs/2026-09-24-coop-v2-multi-master-dag.md)). P0 ships the registry layer; plan/DAG, worktrees, reviewer gates, and memory arrive with later phases.

- **Roles** — `master` / `worker` / `reviewer` register into `.dsh/coop/v2/registry.json`. A master mints a `masterId` (`<slug>#<uuid>`); workers/reviewers land `unbound`.
- **Exclusive bind** — `coop_bind` adopts an unbound node under the registry writer lock; once bound, the node is visible to that master alone (isolation is enforced by visibility). `coop_release` returns it to the unbound pool; capacity follows `maxWorkers` / `maxReviewers`.
- **Workspace anchor** — nodes resolve the nearest `.dsh/coop/workspace.json` walking up from the session cwd, else the cwd itself. A parent directory becomes a workspace only via `/coop workspace init [path]` — never silently.
- **Commands** — `/coop master|worker|reviewer [--master <id>] [--model <route>] [--any-cwd]`, `/coop list [--unbound]`, `/coop bind|release <sessionId>`, `/coop status`, `/coop off`, `/coop workspace init [path]`.
- **Tools** — `coop_register`, `coop_list`, `coop_bind`, `coop_release`, `coop_status`; the v1 eleven are not registered in v2 mode.
- **Plans are task DAGs (P1)** — `coop_plan_create` (bound to one `repoRoot`, §12.1) → `coop_task_add`/`coop_task_link`/`coop_task_cancel` (cycle-checked under the plan lock) → review-gated activation (P3). Readiness derives from the DAG; the scheduler assigns ready tasks to idle bound workers (skill demands ⊆ declared skills, `maxParallelTasks`) and wakes them with `task assigned` signals. Workers run `coop_execute_begin` → `coop_execute_report`; a bound reviewer verifies with `coop_task_verify` (`pass` → done and downstream goes ready; `request_changes` → rework for the same worker). `coop_board` is the kanban projection; `coop_plan_close` requires every task done/cancelled; `coop_plan_abort` cancels open tasks and signals in-flight assignees.
- **Worktrees (P2)** — `coop_worktree_create` branches a plan's `repoRoot` into `<workspace>/wt/<masterId>/<seq>-<slug>` through the mounted shell seam (git runs via `ctx.shell`, never raw `child_process`); the directory name is claimed under the global `wt-registry.json` lock, so masters never collide. The scheduler hands each assigned task a free worktree (exclusive) and names it in the wake-up signal. `coop_worktree_merge` merges back with `git merge --no-ff` (a moved base or a conflict aborts fail-loud as `COOP_WORKTREE_MERGE_CONFLICT` — no auto-resolution, §6.4); `coop_plan_close` auto-merges every still-active worktree first; `coop_worktree_clean` removes one (`force` discards modifications). Plan-review gating, subagent executors, and memory arrive with P3–P4.
- **Reviewer gates and escalation (P3)** — activation now runs through review: `coop_plan_submit_review` (designing → reviewing, bound reviewers woken) and `coop_plan_review` (pass → active with scheduling; request_changes → designing; same reviewer/allowSelfReview gate as task verify). Tasks carry an executing heartbeat (`coop_execute_touch`) whose silence past `executingStaleMs` returns the task to rework, and a `hardDeadlineMs` measured from first assignment whose expiry blocks the task; `maxReworkAttempts` exhausted `request_changes` verdicts also block, signalling both the worker and the master. Subagent-executor tasks tell the assigned worker to delegate the task spec to a spawned sub-agent.
- **Herdr TUI integration (P5a)** — `coop_worker_create` (and `/coop spawn worker|reviewer [--model <route>] [--workdir <dir> | --worktree <dir|branch>]`) auto-creates nodes: with herdr reachable and the master inside a herdr pane, the freshly split pane follows the default column layout (`spawnLayout: columns`: same-role panes stack onto the bottom of their column, and a role's first pane inserts a fresh full-height column beside the master — column order follows spawn order; derived from live geometry plus each node's self-reported pane id, no stored state) and is anchored with `--cwd` at the node's living directory (worktree > workdir > workspace root) and runs `spawnCommand`, then receives its `/coop <role> --master <id>` line; coop polls the registry until the node actually lands (re-sending the line roughly every 4 s inside the `spawnRegisterTimeoutMs` window; a timeout fails loud quoting the manual line). The line carries the master id, so the node pre-binds — no follow-up `coop_bind` from the master. Otherwise an in-process headless session is created pre-bound. Every poll tick mirrors node states into herdr (`pane report-agent`/`report-metadata`, only on change), so herdr's sidebar becomes the node card row. The kanban board is the separate `coop-board` Ratatui plugin ([herdr/coop-board](../../../herdr/coop-board/README.md)): `herdr plugin link <repo>/herdr/coop-board` then `herdr plugin pane open --plugin coop.board --entrypoint board` opens the overlay (q/Esc closes, `d` toggles the DAG view); the pane command runs from the plugin root, so point it at a workspace with a `/coop workspace init` anchor or pass an explicit root — see the plugin README's discovery section.
- **Per-role LLM routes (roleLlm)** — with `roleLlm: { master|worker|reviewer: { provider, model, reasoningEffort? } }` configured, every LLM request of a session registered under that role is rewritten onto the route by a local `agent/request` listener (provider/model/effort). `/coop master` and `/coop worker|reviewer` apply it at registration; herdr panes from `/coop spawn` apply the same deployment config when their registration line lands, and headless nodes also launch with the route's provider/model. The effective route is recorded in registry `meta.model`; `/coop off` lifts the pin.
- **Summarizer → memory (P4)** — every verified task and closed plan is deterministically summarized into the master's memory trail `v2/masters/<masterId>/memory.jsonl` (report text + verify rationale as lessons) with a human-readable `memory.md` mirror; appends compact to `memoryRetainEntries`. The `coop:memory` prompt section injects the newest `memoryInjectTopK` records (recency only, §12.3) for every member of the master; targeted recall is `coop_memory_search` (keyword, per-master isolation). The optional summarizer-model LLM pass is deferred — the deterministic composition stays lossless over report/verify text. `coop_board` is the kanban projection; `coop_plan_close` requires every task done/cancelled; `coop_plan_abort` cancels open tasks and signals in-flight assignees. Worktrees, plan-review gating, subagent executors, and memory arrive with P2–P4.

## Per-role model pinning (roleLlm) — the full recipe

`roleLlm` pins provider + model + reasoningEffort per role (master / worker / reviewer). It takes effect in two layers, and both belong in the deployment:

**Layer 1: coop's `roleLlm` (request-level pin; applies in every deployment)**

Every LLM request of a session registered under that role is rewritten onto the route by a local `agent/request` listener; headless nodes launch with the route's provider/model; the effective route is recorded in registry `meta.model` (visible on the board and in `/coop list`); `/coop off` lifts the pin. Validation fails loud: provider+model must be a non-empty pair, role keys are exactly master|worker|reviewer, and the effort is a non-empty string interpreted by the target provider's adapter (an unlisted level falls back to the adapter default).

**Layer 2: the host TUI's startup route pair (so dsh-tui panes display AND use the role model from boot)**

dsh-tui resolves a new session's startup route as: a complete provider+model pair in the `dsh-tui` entry config > `~/.dsh-tui/model.json` (the `/model` picker's global persisted choice) > built-in defaults. With `roleLlm` alone, a fresh pane's statusline keeps showing the picker's model until the first request travels the pinned route. To boot panes correctly, pin an **env-driven complete pair** on the `dsh-tui` entry: `/coop spawn` automatically injects `DSH_COOP_PROVIDER` / `DSH_COOP_MODEL` / `DSH_COOP_EFFORT` (via `herdr pane split --env`) from the role's route when one is configured; panes without the env (master / plain panes) fall back to the pinned defaults.

Complete `~/.dsh/profiles/<name>/cordis.patch.yml` example:

```yaml
- id: dsh-tui
  config:
    # A complete pair wins over the /model picker; panes without coop env
    # boot on the fallback (the master's default route).
    provider: !!js process.env.DSH_COOP_PROVIDER ?? 'zai-coding-cn'
    model: !!js process.env.DSH_COOP_MODEL ?? 'glm-5.3'
    effort: !!js process.env.DSH_COOP_EFFORT ?? 'max'
- insert:
  - id: coop
    name: '@deepseek-ai/dsh-coop'
    config:
      mode: v2
      spawn: auto
      spawnCommand: dsh --profile <name>
      roleLlm:
        master:   { provider: zai-coding-cn, model: glm-5.3, reasoningEffort: max }
        worker:   { provider: zai-coding-cn, model: glm-5.3-flash, reasoningEffort: high }
        reviewer: { provider: zai-coding-cn, model: glm-5.3, reasoningEffort: max }
```

Behavior notes:

- The provider route must already exist (e.g. an `llm-pi-ai.providers.<id>` settings entry or a composed adapter), and the model id must be one the provider actually serves.
- Once a complete pair is pinned, NEW sessions no longer boot on the `/model` picker (an in-session `/model` switch still works); `roleLlm` remains the authoritative request-level override.
- An explicit `--model <route>` (spawn/register argument) only records registry meta and seeds the headless launch; it does not change the roleLlm pin.
- Non-TUI deployments (web/headless) need only layer 1; when the host composes the session-controller service, registration also commits a visible model selection and appends a durable `model/selection` event.

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
