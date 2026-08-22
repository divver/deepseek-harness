/** Package-owned durable coop-mirror invariants. @module @deepseek-ai/dsh-coop/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-coop'

/** Cordis companion plugin name. */
export const name = 'coop-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

const PLAN_STATUSES = new Set([
  'draft',
  'pending_pre_review',
  'needs_plan_revision',
  'ready_to_execute',
  'executing',
  'pending_verify',
  'needs_rework',
  'done',
  'closed',
  'aborting',
  'aborted',
])

const ROLES = new Set(['master', 'worker'])
const REVIEW_LEVELS = new Set(['strict', 'standard', 'lenient'])

/** The decision each review phase may record; anything else is a broken mirror. */
const PHASE_DECISIONS: Record<string, Set<string>> = {
  pre_review: new Set(['pass', 'request_changes']),
  verify: new Set(['pass', 'request_changes']),
  abort_ack: new Set(['ack']),
}

/** Validate one `coop/registry` mirror payload. */
function validateRegistry(value: Record<string, unknown>, fail: InvariantFailure): void {
  const roles = value['roles']
  if (!Array.isArray(roles)) return fail('coop/registry roles must be an array')
  for (const role of roles) {
    if (typeof role !== 'string' || !ROLES.has(role)) fail(`coop/registry carries unknown role ${JSON.stringify(role)}`)
  }
  if (typeof value['updatedAt'] !== 'number') fail('coop/registry updatedAt must be a number')
  const level = value['reviewLevel']
  if (level !== undefined && (typeof level !== 'string' || !REVIEW_LEVELS.has(level))) {
    fail(`coop/registry carries unknown reviewLevel ${JSON.stringify(level)}`)
  }
}

/** Validate the planId/status spine shared by plan-change mirrors. */
function validatePlanRef(value: Record<string, unknown>, fail: InvariantFailure): boolean {
  if (typeof value['planId'] !== 'string' || value['planId'].length === 0) {
    fail('coop mirror carries an empty planId')
    return false
  }
  if (typeof value['status'] !== 'string' || !PLAN_STATUSES.has(value['status'])) {
    fail(`coop/plan-change carries unknown status ${JSON.stringify(value['status'])}`)
    return false
  }
  return true
}

/** Validate one `coop/review` mirror payload: phase and decision must pair. */
function validateReview(value: Record<string, unknown>, fail: InvariantFailure): void {
  const phase = value['phase']
  const decision = value['decision']
  const allowed = typeof phase === 'string' ? PHASE_DECISIONS[phase] : undefined
  if (allowed === undefined) return fail(`coop/review carries unknown phase ${JSON.stringify(phase)}`)
  if (typeof decision !== 'string' || !allowed.has(decision)) {
    fail(`coop/review phase "${String(phase)}" rejects decision ${JSON.stringify(decision)}`)
  }
}

/** Validate one `coop/execution` mirror payload. */
function validateExecution(value: Record<string, unknown>, fail: InvariantFailure): void {
  const phase = value['phase']
  if (phase !== 'begin' && phase !== 'report') {
    return fail(`coop/execution carries unknown phase ${JSON.stringify(phase)}`)
  }
  if (phase === 'report' && (typeof value['summary'] !== 'string' || value['summary'].length === 0)) {
    fail('coop/execution report requires a non-empty summary')
  }
}

/**
 * Validate the package-owned event fields and their phase/decision relations;
 * unrelated events pass through. Authority lives in the shared files, so these
 * guards pin the mirror stream that replay and UI folds consume.
 */
function validateEvent(event: SessionEvent, fail: InvariantFailure): void {
  switch (event.type) {
    case 'coop/registry':
      validateRegistry(event.data as never, fail)
      break
    case 'coop/plan-change':
      if (validatePlanRef(event.data as never, fail)) {
        const op = (event.data as { op?: unknown }).op
        if (typeof op !== 'string' || !['create', 'update', 'notify', 'status', 'abort'].includes(op)) {
          fail(`coop/plan-change carries unknown op ${JSON.stringify(op)}`)
        }
      }
      break
    case 'coop/review':
      validateReview(event.data as never, fail)
      break
    case 'coop/execution':
      validateExecution(event.data as never, fail)
      break
    default:
      break
  }
}

/* jscpd:ignore-start -- package companions share replay and dispatch plumbing */
/** Install validation for loaded and newly appended coop mirrors. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) {
    for (const event of session.events) validateEvent(event, fail)
  }
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    validateEvent((args as [Session, SessionEvent])[1], fail)
  }, { global: true })
}, { inject: ['sessions'] })
/* jscpd:ignore-end */

/**
 * Register the coop invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
