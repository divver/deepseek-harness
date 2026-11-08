---
name: coop-flow
description: The six-step coop v2 working loop for master, worker, and reviewer nodes — requirement clarification, gated design review, DAG planning, parallel execution, gated verification, and close-out. Read this when a [coop] wake or task assignment first reaches your node.
---

# Coop flow (v2 six-step loop)

You are one node (master / worker / reviewer) in a coop v2 workspace. This is
the operating manual for the whole loop; your role's section is your script.

## Master — orchestrate

1. **Requirement clarification — PAUSE.** When a new objective arrives, stop
   and ask the user to pick an interview skill: `brainstorming` (divergent,
   finds the why) or `grilling` (relentless, resolves every branch of the
   design tree). Do not start designing until they choose or decline. Both
   also fit mid-design disputes after a `request_changes` round.
2. **Design.** Write the design into the plan's markdown trail. Load `how`
   or `architect` when the change crosses module boundaries.
3. **Design gate.** `coop_plan_submit_review` → your reviewer(s) judge the
   DAG. On `request_changes`, revise and resubmit; the loop ends only when
   the review passes the quality gate (no P0). With no reviewer bound you
   gate it yourself — same bar.
4. **Plan.** `coop_task_add` per task: `dependsOn` builds the DAG,
   `skills` demands coverage (e.g. `['tdd']`), `assigneeSessionId` pins a
   worker. `coop_task_link` adjusts edges later. Sharpen a fuzzy task spec
   with `sharpen` before dispatching.
5. **Dispatch.** The scheduler assigns ready tasks to idle bound workers
   (`maxParallelTasks` concurrent). Spawn more workers or reviewers with
   `coop_worker_create` (`--worktree`, `--model`, `--skills`). Watch
   `coop_board`; `ketchup`/`recall` when the user returns after an absence.
6. **Close.** All tasks done/cancelled → `coop_plan_close` (merges active
   worktrees). Then `reflect` to capture lessons into memory.

## Worker — execute

1. A `[coop] task assigned` wake means: call `coop_execute_begin`, then do
   the work per the spec (a subagent-style task says to delegate — only then).
2. **Skills by default**: implementing → `tdd` (red-green-refactor, one
   vertical slice at a time); debugging → `diagnosing-bugs` (build a feedback
   loop that goes red first). `typescript-best-practices` when editing TS;
   `blast-radius` before a risky small change; `figure-it-out` when no
   playbook fits. Touch `coop_execute_touch` on long runs.
3. Report: `coop_execute_report` with what you did, evidence it works
   (test names, commands, output), and open questions.
4. On rework: `coop_execute_begin` again, address every finding, report again.
   On a context hard-limit order: load `handoff`, write the handover doc, call
   `coop_handoff`.

## Reviewer — gate

1. Wakes follow `coop_plan_submit_review` (design) and `coop_execute_report`
   (task verification, with `coop_task_verify`).
2. **Skills**: `interrogate` to attack the diff/design (keep only findings a
   run or a citation proves), `unslop` on prose deliverables,
   `benchmark-checklist` before accepting any perf claim, `no-comments` for
   comment discipline, `how`/`why` to verify claimed behavior against the
   code.
3. **Grade and count** every finding: P0 correctness / security / data loss /
   spec-or-objective break; P1 fix before merge; P2 minor. Pass the counts as
   `severityCounts` — a `pass` needs them, and any P0 means `request_changes`
   with each P0 named and the evidence for it.
4. Work inline: never spawn parallel review subagents. (Parallel review is
   multiple reviewer nodes, each reviewing the whole thing — that is the
   master's call.)

## Loop end conditions

- Design: gate pass (no P0) → plan `active`.
- Task: verify gate pass → `done`; rework budget exhausted → `blocked` and
  the master decides.
- Plan: every task done/cancelled → `close` (worktrees merge).
