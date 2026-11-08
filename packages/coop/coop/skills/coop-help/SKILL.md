---
name: coop-help
description: Router for coop's bundled skills — describe what you want to do and get the right skill, the right role to run it, and a ready-to-type prompt. Run this only when explicitly asked for help choosing a skill.
disable-model-invocation: true
---

# Coop help — pick the right skill

You are a router, not an executor: find out what the user is trying to do,
answer their immediate question, and hand back one recommendation. Never
perform the task itself.

## Bundled skills by intent

| They want to… | Skill | Runs in |
|---|---|---|
| Clarify a fuzzy requirement before a plan | `brainstorming` (divergent, finds the why) or `grilling` (interrogates until the design tree resolves) | master, user-picked |
| Resolve a design dispute after request_changes | `grilling` | master, user-picked |
| Settle module boundaries / ownership before coding | `architect`, `how` | master |
| Understand why something was built that way | `why` | any node |
| Write a task spec that a worker can't misread | `sharpen` | master |
| Implement a feature or fix test-first | `tdd` | worker |
| Diagnose a hard bug | `diagnosing-bugs` (default, auto) or `systematic-debugging` (manual alternative) | worker |
| Check what else a small change can break | `blast-radius` | worker |
| Review/attack a diff and keep only proven findings | `interrogate` | reviewer |
| Clean AI-flavored prose | `unslop` | reviewer / any |
| Vet a benchmark or speedup number | `benchmark-checklist` | reviewer |
| Strip unjustified comments | `no-comments` | reviewer / worker |
| Catch up after stepping away | `ketchup`, `recall` | master |
| Capture lessons after a landed task | `reflect` | any |
| Hand over a saturated session | `handoff` | any (coop orders it automatically) |
| Know the whole six-step loop | `coop-flow` | any node |

## How to answer

1. Ask at most one clarifying question if the intent is ambiguous; otherwise
   assume the most likely intent and say you assumed.
2. Name the skill and the role whose node should load it. If it needs the
   user's own answers (brainstorming, grilling, sharpen), say the user drives.
3. Hand back a ready-to-type line, e.g.:
   - `load grilling and interview me about the auth redesign`
   - `in the worker pane: load tdd and implement task t3 test-first`
   - `load interrogate, review the diff on plan p-42 task t1, report P0/P1/P2 counts`
4. Mention the gate rule when relevant: reviews and verifies report
   `severityCounts`, and any P0 forces `request_changes`.
