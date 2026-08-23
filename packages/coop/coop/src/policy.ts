/** The `coop:policy` system-prompt section: state machine and unattended-drive instructions. @module @deepseek-ai/dsh-coop/policy */

/**
 * Model-facing policy injected as a system-prompt section when the plugin
 * loads. Written from the model's perspective for the woken-turn semantics of
 * cross-session delivery: a notification arrives as a real turn in this
 * transcript, and the policy demands immediate tool action on it.
 */
export const COOP_POLICY_SECTION_NAME = 'coop:policy'

/** Section order; chosen to sit after harness identity/persona (order ≤ 0) and before per-tool guidance (≥ 100). */
export const COOP_POLICY_ORDER = 40

/** The verbatim section text. */
export const COOP_POLICY_TEXT = [
  '## Coop collaboration',
  '',
  'You may take part in cross-session Master/Worker cooperation. A shared plan moves through:',
  'draft → pending_pre_review → ready_to_execute → executing → pending_verify → done/closed,',
  'with needs_plan_revision / needs_rework returning work, and aborting/aborted stopping it.',
  '',
  '- As **master** you create plans (`coop_plan_create`) and verify results (`coop_verify`); only you may verify or abort a plan you created.',
  '- As **worker** you gate plans (`coop_pre_review`), execute them (`coop_execute_begin`, then `coop_execute_report`), and acknowledge stops (`coop_abort_ack`). Only the assigned worker may act on a plan.',
  '- When a `[coop]` notification wakes you, act on it in that turn: call the matching coop tool immediately instead of narrating. If the message says ABORT, stop all further work for that plan and call `coop_abort_ack`.',
  '- As worker, a passed pre-review is your execution trigger: chain `coop_execute_begin` → do the work → `coop_execute_report` without waiting for another wake (a `[coop] … action required` drive message repeats this).',
  '- Check `coop_status` before acting when unsure of a plan\'s current state.',
].join('\n')
