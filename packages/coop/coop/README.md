# @deepseek-ai/dsh-coop

English | [中文](README.zh.md)

Cross-session Master/Worker plan cooperation over a workspace-shared file store. Several `dsh` sessions in the same project directory (same normalized `cwd`) register as `master` or `worker` and drive shared plans through an eleven-state workflow; the files under `.dsh/coop/` are the authority, and each session mirrors what it did into its own session log.

## Model

- **Registry** — `.dsh/coop/registry.json` holds `{ sessionId, roles, reviewLevel?, updatedAt, heartbeatAt, cwd, cwdScope }`. One live `master` per workspace: the singleton check runs inside the registry writer lock (`withFileLock`), so two processes cannot both become master. A stale entry (`heartbeatAt` older than `staleMs`) stops blocking and may be preempted. Entries with `cwdScope: "any"` are also written to the global table under `$DSH_HOME`/`~/.dsh` and are visible from any workspace.
- **Plans** — `.dsh/coop/plans/<planId>.json` is the authoritative plan state; `.dsh/coop/docs/<planId>.md` carries the human-readable trail (Objective / Pre-review / Execution / Verify / Abort / Changelog). Every status transition validates and commits inside one plan lock; model callers never see conflicts and never retry.
- **Delivery** — single-path. A notification appends a signal line to `.dsh/coop/inbox/<sessionId>.jsonl` (monotonic `seq`); the receiving session delivers every line above its watermark (`.dsh/coop/inbox/.consumed/<sessionId>`) to its own agent via `Agent.followup`, which wakes the driver and lands in the transcript as a real turn. Same-process targets drain immediately; cross-process targets drain on their next activation (`agent/session-start`). Append and watermark writes never touch the same file, so nothing can be lost or delivered twice.
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
| `defaultReviewLevel` | `standard` | Worker gating level when a registration omits it |
| `docRoot` | `.dsh/coop` | Workspace-relative store root |
| `allowNoWorker` | `false` | Let a master self-assign when no worker is visible |
| `staleMs` | `300000` | Registry heartbeat window; also gates master takeover |
| `executingStaleMs` | `600000` | Executing-heartbeat window before needs_rework |
| `abortAckTimeoutMs` | `120000` | Abort-ack window before the master closes aborted |
| `workerSelector` | `earliest` | `earliest` or `round-robin` first-notify binding |
| `inboxCompactThreshold` | `256` | Delivered signal lines before compaction |
| `allowAnyCwdRoles` | `[master, worker]` | Roles allowed to declare `cwdScope: "any"` |

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
- **Liveness is heartbeat-only** — the persisted-header existence check (`ctx.sessionPersistence.list()`) named by the spec is deferred; `staleMs` alone decides freshness and takeover.
- **Cross-process delivery waits for activation** — a parked worker process learns about signals only on its next session start; there is no watcher or push channel (non-goal for v1).
