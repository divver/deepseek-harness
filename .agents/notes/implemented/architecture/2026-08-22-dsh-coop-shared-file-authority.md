# Agent Note: dsh-coop — cross-session cooperation over shared files (2026-08-22)

Implements [`.agents/specs/2026-08-21-coop-cross-session-v3.md`](../../../.agents/specs/2026-08-21-coop-cross-session-v3.md) (P0–P3). The spec was adversarially reviewed against the codebase before implementation; this note records where the shipped design diverged from the reviewed text and why.

## Delivery is one path, not two

The spec's fast/slow split suggested "followup for online peers, signal file for offline ones". Shipped: every notification appends an inbox signal line, then the delivering process drains the target's watermark immediately when the peer agent is live in-process. One delivery mechanism, no fast/slow dedup problem; cross-process targets simply drain later (`agent/session-start`). The watermark file (`.consumed/<id>`) is written only by the consumer and signal lines only by producers, so the append/consume race the review flagged cannot occur.

`Agent.inject` is deliberately unused for notifications: it queues without waking the driver, so an idle worker would never act. `followup` wakes.

## Locks replaced conflict retries

The spec draft's "rename atomicity as a planId lock + COOP_CONFLICT retry" misread `rename` semantics; the review established that readers never see intermediate states under atomic publish and that LLM-driven retries are a nondeterministic loop. All registry/plan read-modify-write cycles run inside `withFileLock` from `@deepseek-ai/dsh-atomic-write`, with validation inside the locked callback. The master singleton check shares the registry lock with its write, closing the TOCTOU the draft had.

## Deviations from the reviewed spec

- **`ignorable: true` is not attached to mirror events.** `Session.append()` has no way to set the envelope marker (only persistence-seed writers can); instead the four `coop/*` types join `KNOWN_SESSION_EVENT_TYPES` via `gen-persistence-catalog`. Cross-build tolerance therefore rides the repo's pre-release lockstep stance rather than the per-event guard. If a downstream plugin ecosystem ever needs out-of-vocabulary coop events, `Session.append` must grow an ignorable option first.
- **`coop_execute_begin` exists** (not in the spec's tool list): without it nothing transitions `ready_to_execute → executing`, so the executing watchdog would be dead code and the state machine unobservable.
- **Liveness is heartbeat-only**; the persisted-header existence check is deferred (README Known Limitations) because a crashed session stops ticking either way.
- **`autoDrive` config throws at load** (`COOP_CONFIG_UNSUPPORTED`) until the P4 execution-interrupt pipeline exists — accepting the key would promise deterministic execution the package cannot deliver.
- **`--any-cwd` global-table writes** happen before the local commit; a crash between them leaves a reclaimable stale row rather than a torn local entry.

## Verification shape

Store behavior is covered directly over temp dirs; service behavior runs through a real agent spine (`mountAgentLoopTestDependencies`) with three live sessions sharing one temp workspace — registration/singleton denials, the full happy path to `closed`, affinity denials, abort closure, re-notify idempotence, and both watchdog timeouts (backdated files, not sleeps). The keyless double-session snapshot fixture demanded by the testing policy for model-visible transcripts is still owed; the service-level suite pins the same transcript facts (woken `[coop]` turns are asserted verbatim) until it lands with `examples/coop`.

## Follow-up (same day): mirrors are opt-in after a real mixed-version failure

The ignorable deviation above bit immediately: running the repo-built plugin inside the published `dsh` profile made every mirror append land in a log whose reader build predates the `coop/*` vocabulary, and resume failed loud (`session contains event type "coop/registry"`). Neither rc.5 nor rc.7 `Session.append` can attach the envelope marker, so no writer-side fix exists within the public API. Shipped resolution: `Config.mirrorEvents` (default off) gates all eleven mirror appends; the shared files stay authoritative and model-visible inputs remain covered by the natively logged followup turns. Existing poisoned logs are repairable offline by adding `"ignorable":true` to each `coop/*` line of the zstd JSONL. The proper fix — an append-time ignorable option in core session, or publishing coop so vocabulary and readers move together — is deferred until one of those lands.

## Follow-up: live inbox polling for idle sessions

Session-start alone left an open-but-idle worker blind to signals written after its activation — exactly the master-notifies-worker moment the TUI user watches. CoopService now runs a `ctx.effect` interval (`inboxPollMs`, default 1s) draining every live agent's inbox with a per-session reentrancy guard; non-participants cost one ENOENT read per tick.
