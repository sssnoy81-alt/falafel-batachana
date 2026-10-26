// Automatic Maale Express courier request after a kitchen confirmation (S4-MAALE-03). SERVER-ONLY business rules with
// injectable dependencies (testable without a DB or network); production wiring in lib/kitchenAutoDispatchServer.ts.
//
// DISABLED unless MAALE_AUTO_DISPATCH_ENABLED === 'true' (read on every call). Tasks are created ONLY by the database:
// the s4_05 trigger adds one public.maale_auto_dispatch_queue row in the same transaction as received → confirmed of a
// delivery order (and only while public.maale_auto_dispatch_config.enqueue_enabled is on). This module never creates a
// task; it processes one:
//   claim (compare-and-set queued → processing, attempts + 1; a stale processing task is re-claimable) → reload the order
//   from the DATABASE (delivery, status confirmed / preparing) → reconciliation block (manual courier / open review) →
//   the lib/maaleDispatch dispatch service — every existing gate again (cash only, verified location, Kfar Adumim manual,
//   parcel, ₪600 cap, quote fee = stored fee, 401 stop, durable quote slot) and its atomic delivery_dispatches claim,
//   which stays the single guarantee that a provider order is submitted at most once.
// NO RETRY OF AN UNCERTAIN SEND: anything that may have reached the provider (sending, timeout, 429, 5xx, unexpected
// answer, persistence failure) ends the task in 'investigate'. Only outcomes decided BEFORE any provider order (quote
// unavailable, local rate limit, unknown auth state) return the task to 'queued', at most AUTO_DISPATCH_MAX_ATTEMPTS
// times, then 'manual'. A task older than AUTO_DISPATCH_FRESH_MS is never started ('skipped:stale').
// Logs: short codes only — never phone, address, tracking reference, provider body or key.

import type { DispatchResult } from './maaleDispatch'
import { KITCHEN_DISPATCH_STATUSES, type KitchenDispatchOrder } from './kitchenDispatch'

if (typeof window !== 'undefined') {
  throw new Error('lib/kitchenAutoDispatch is server-only')
}

type EnvLike = Record<string, string | undefined>

/** Only the exact string 'true' enables the worker; anything else (incl. unset) is OFF. */
export const isAutoDispatchEnabled = (env: EnvLike): boolean => env.MAALE_AUTO_DISPATCH_ENABLED === 'true'

/** Quote-ledger actor (maale_dispatch_requests.actor_username rule ^[a-z0-9_-]{2,32}$). RESERVED: no kitchen account
 *  may use this name. */
export const AUTO_DISPATCH_ACTOR = 'auto-dispatch'
export const AUTO_DISPATCH_MAX_ATTEMPTS = 3
/** Longer than the database guard's 2 minutes, so a re-claim is never refused for a clock skew of seconds. */
export const AUTO_DISPATCH_STALE_CLAIM_MS = 3 * 60 * 1000
/** A task not started within 30 minutes of the confirmation is skipped: a late courier is worse than a phone call. */
export const AUTO_DISPATCH_FRESH_MS = 30 * 60 * 1000
export const AUTO_DISPATCH_SWEEP_LIMIT = 5

export const AUTO_DISPATCH_STATES = ['queued', 'processing', 'dispatched', 'manual', 'investigate', 'skipped'] as const
export type AutoDispatchState = (typeof AUTO_DISPATCH_STATES)[number]
type FinalState = 'dispatched' | 'manual' | 'investigate' | 'skipped'

export interface AutoDispatchTask {
  order_id: string
  branch_id: string | null
  state: AutoDispatchState
  reason_code: string | null
  attempts: number
  enqueued_at: string
  claimed_at: string | null
}

export interface AutoDispatchDeps {
  loadTask(orderId: string): Promise<AutoDispatchTask | null>
  /** Compare-and-set: queued (attempts = seen.attempts) or stale processing (claimed_at = seen.claimed_at) → processing,
   *  attempts + 1, claimed_at = now. true only for the single caller whose UPDATE changed the row. */
  claim(task: AutoDispatchTask, nowIso: string): Promise<boolean>
  /** Only from 'processing' (or 'queued' for skipped:stale). true only when exactly one row changed. */
  finish(orderId: string, from: 'processing' | 'queued', to: FinalState | 'queued', reason: string | null, nowIso: string): Promise<boolean>
  /** Due tasks in scope (null = every branch): queued, or processing claimed before staleBeforeIso; oldest first. */
  listDue(branchIds: readonly string[] | null, staleBeforeIso: string, limit: number): Promise<AutoDispatchTask[]>
  loadOrder(orderId: string): Promise<KitchenDispatchOrder | null>
  /** Same rule as the manual route: a recorded manual courier / open review forbids an API courier. Throws → blocked. */
  dispatchBlockingRecord?: (orderId: string) => Promise<'manual_courier_recorded' | 'manual_review_open' | null>
  /** The lib/maaleDispatch dispatch service with production deps and the AUTO_DISPATCH_ACTOR quote slot. */
  dispatch(orderId: string): Promise<DispatchResult>
  now(): number
  log(code: string): void
}

export type AutoDispatchRun =
  | { result: 'not_queued' | 'busy' }
  | { result: 'finished'; state: FinalState | 'queued'; reason: string | null }

const REASON_RE = /^[a-z0-9_]{1,64}$/
const reasonOf = (r: string | undefined | null): string => (r && REASON_RE.test(r) ? r : 'unspecified')

/** Outcomes decided BEFORE any provider order exists — safe to try again later (nothing was sent, nothing claimed). */
const RETRYABLE_BLOCKS = new Set(['quote_unavailable', 'quote_failed', 'rate_limited_local', 'rate_limit_unavailable', 'auth_state_unknown'])
/** Provider answers that definitely refused the order (nothing to investigate): the courier must be ordered by phone. */
const DEFINITE_PROVIDER_REJECTIONS = new Set(['zone_unknown', 'out_of_area', 'amount_too_high', 'dispatch_closed', 'validation_error', 'provider_rejected', 'blocked'])

/** Maps a dispatch outcome to the task's next state. Pure. 'queued' = transient (caller applies the attempt limit). */
export function classifyDispatchResult(r: DispatchResult): { state: FinalState | 'queued'; reason: string | null } {
  switch (r.outcome) {
    case 'sent': case 'already_sent': return { state: 'dispatched', reason: null }
    case 'dispatch_in_progress': return { state: 'investigate', reason: 'dispatch_in_progress' }
    case 'final_failure_exists': return { state: 'investigate', reason: 'previous_failure' }
    case 'attempts_exhausted': return { state: 'investigate', reason: 'attempts_exhausted' }
    case 'manual_review_required': return { state: 'investigate', reason: reasonOf(r.reason) }
    case 'persistence_failed': return { state: 'investigate', reason: 'state_not_recorded' }
    case 'failed':
      if (!r.ambiguous && DEFINITE_PROVIDER_REJECTIONS.has(r.errorCode)) return { state: 'manual', reason: reasonOf(r.errorCode) }
      return { state: 'investigate', reason: reasonOf(r.errorCode) }   // may have reached the provider: never retried
    case 'blocked':
      if (RETRYABLE_BLOCKS.has(r.reason)) return { state: 'queued', reason: r.reason }
      if (r.reason === 'order_not_confirmed' || r.reason === 'order_not_found') return { state: 'skipped', reason: r.reason }
      return { state: 'manual', reason: reasonOf(r.reason) }
  }
  return { state: 'investigate', reason: 'unknown_outcome' }
}

/** Processes ONE task. Never throws for a dispatch problem: the task records what happened. */
export async function runAutoDispatch(deps: AutoDispatchDeps, orderId: string): Promise<AutoDispatchRun> {
  const nowMs = deps.now()
  const iso = () => new Date(deps.now()).toISOString()
  const task = await deps.loadTask(orderId)
  if (!task) return { result: 'not_queued' }

  if (task.state === 'queued' && nowMs - Date.parse(task.enqueued_at) > AUTO_DISPATCH_FRESH_MS) {
    const ok = await deps.finish(orderId, 'queued', 'skipped', 'stale', iso())
    deps.log('auto_dispatch_skipped_stale')
    return ok ? { result: 'finished', state: 'skipped', reason: 'stale' } : { result: 'busy' }
  }
  const reclaimable = task.state === 'processing' && !!task.claimed_at && nowMs - Date.parse(task.claimed_at) > AUTO_DISPATCH_STALE_CLAIM_MS
  if (task.state !== 'queued' && !reclaimable) return { result: 'busy' }
  if (task.attempts >= AUTO_DISPATCH_MAX_ATTEMPTS) {
    // a re-claim beyond the limit would only repeat a transient: hand it over to staff instead
    const from = task.state === 'queued' ? 'queued' : 'processing'
    if (from === 'queued') return (await deps.claim(task, iso())) ? finishAs(deps, orderId, 'manual', 'retries_exhausted') : { result: 'busy' }
    return finishAs(deps, orderId, 'investigate', 'stale_processing')
  }
  if (!(await deps.claim(task, iso()))) return { result: 'busy' }
  // A stale re-claim: the earlier worker may have reached the provider — the dispatch service's own claim decides
  // (a 'sending' / 'sent' delivery_dispatches row is never submitted again).

  let order: KitchenDispatchOrder | null
  try { order = await deps.loadOrder(orderId) } catch { return finishAs(deps, orderId, 'queued', 'order_unavailable', task.attempts + 1) }
  if (!order) return finishAs(deps, orderId, 'skipped', 'order_not_found')
  const fee = order.delivery_fee === null ? NaN : Number(order.delivery_fee)
  if (order.type !== 'delivery' || !Number.isFinite(fee)) return finishAs(deps, orderId, 'manual', 'not_delivery')
  if (!KITCHEN_DISPATCH_STATUSES.includes(order.status)) return finishAs(deps, orderId, 'skipped', 'order_status')

  if (deps.dispatchBlockingRecord) {
    let block: 'manual_courier_recorded' | 'manual_review_open' | null
    try { block = await deps.dispatchBlockingRecord(orderId) } catch { return finishAs(deps, orderId, 'queued', 'reconciliation_unavailable', task.attempts + 1) }
    if (block) return finishAs(deps, orderId, 'manual', block)
  }

  let result: DispatchResult
  try { result = await deps.dispatch(orderId) } catch { return finishAs(deps, orderId, 'investigate', 'dispatch_error') }   // unknown → never retried
  const next = classifyDispatchResult(result)
  return finishAs(deps, orderId, next.state, next.reason, task.attempts + 1)
}

async function finishAs(deps: AutoDispatchDeps, orderId: string, state: FinalState | 'queued', reason: string | null, attemptsNow?: number): Promise<AutoDispatchRun> {
  // a transient outcome on the last allowed attempt goes to staff
  const to = state === 'queued' && (attemptsNow ?? AUTO_DISPATCH_MAX_ATTEMPTS) >= AUTO_DISPATCH_MAX_ATTEMPTS ? 'manual' : state
  const ok = await deps.finish(orderId, 'processing', to, reason, new Date(deps.now()).toISOString())
  deps.log(`auto_dispatch_${to}${reason ? `:${reason}` : ''}${ok ? '' : ':not_recorded'}`)
  return { result: 'finished', state: to, reason }
}

/** Fallback sweep: processes due tasks (oldest first) one after another. branchIds null = every branch. */
export async function sweepAutoDispatch(deps: AutoDispatchDeps, branchIds: readonly string[] | null): Promise<{ processed: number; finished: number }> {
  const staleBefore = new Date(deps.now() - AUTO_DISPATCH_STALE_CLAIM_MS).toISOString()
  const due = await deps.listDue(branchIds, staleBefore, AUTO_DISPATCH_SWEEP_LIMIT)
  let finished = 0
  for (const t of due) {
    try {
      const r = await runAutoDispatch(deps, t.order_id)
      if (r.result === 'finished') finished++
    } catch {
      deps.log('auto_dispatch_sweep_error')   // DB unavailable: the task keeps its state for the next sweep
    }
  }
  return { processed: due.length, finished }
}
