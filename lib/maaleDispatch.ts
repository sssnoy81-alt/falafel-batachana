// SERVER-ONLY Maale Express dispatch service (FALAFEL-SN-08D10 / 08D11, hardened in S4-INTEGRATIONS-03F).
// NOT CALLED FROM ANYWHERE IN THE APP — no kitchen trigger, no order-creation hook, no cron / queue / webhook, no public
// or browser entry point. Only the local controlled-test runner (scripts/) calls it.
//
// A real dispatch happens only when ALL hold (checked BEFORE any dispatch-state write or real send):
//   1. MAALE_EXPRESS_ENABLED === 'true' and MAALE_EXPRESS_API_KEY set
//   2. delivery order of the Mishor Adumim branch, status confirmed / preparing (never received / ready / delivered /
//      cancelled), valid 08D9/03E payload (active settlement, precise coordinates, cash food total ≤ ₪600, …)
//   3. CASH only in this phase — payment_method 'credit' is never treated as paid (HYP is not integrated)
//   4. parcel: none, or cancelled (food only). An unresolved parcel, or any parcel the provider contract cannot
//      express yet, means manual dispatch
//   5. location: settlements without a verified boundary to a different-fee neighbour (כפר אדומים ↔ נופי פרת) are
//      manual-review only — no geography is invented
//   6. no recent HTTP 401 for this integration (global stop)
//   7. a fresh server-side dry_run QUOTE (dedicated q- id, never stored as dispatch state) whose delivery fee equals
//      the stored fee, with consistent cash amounts and no provider warnings. The provider zone label is never used
//      as proof of settlement.
//
// Idempotency: external_order_id = orders.id, never regenerated. The DB claim is a compare-and-set.
// NO AUTOMATIC RETRY (03G): once a real request has been submitted for an order, it is never submitted again by this
// service — whatever the answer (429 rate limit, timeout, network, 5xx, unexpected 2xx, 409) or a stale 'sending' row
// after a crash. The schema has no immutable request snapshot, so a second body cannot be proven identical to the first
// (the payload is rebuilt from rows that can change, e.g. menu_items.name_he); a 429 keeps its Retry-After for display
// only. Every such row goes to manual review.
// FUTURE REQUIREMENT before any automatic retry: an immutable request snapshot (or verified fingerprint such as
// delivery_dispatches.request_sha256 written atomically with the claim) so a retry re-sends exactly the original bytes,
// plus a provider status lookup to resolve unknown outcomes.
// Controlled test mode (08D11) only requires the explicit order id + the 🧪 marker; it bypasses NO safety gate.

import {
  buildMaaleOrderPayload, MAALE_ORDER_SELECT, snapshotFromOrderRow,
  type MaaleOrderPayload, type MaaleOrderSnapshot, type MaalePayloadError,
} from './maalePayload'
import {
  newQuoteExternalId, quoteMaaleOrder, resolveMaaleConfig, sendMaaleOrder,
  type MaaleConfig, type MaaleErrorCode, type MaaleQuoteResult, type MaaleSendResult,
} from './maaleClient'
import { hasPreciseCoordinates } from './deliveryLocation'
import type { DeliveryGeoFields } from './geocoding'
import type { DeliveryAreaGeoConfig } from './deliveryAreasGeo'
import { parcelStatusFromEmbed } from './parcelRequest'
import { getServerSupabase } from './supabaseServer'

/* ─── Constants ─── */

/** A 'sending' row older than this (by last_attempt_at) is presumed abandoned (crash mid-request). Its outcome is
 *  unknown, so it is reported for manual review — never resent automatically (03F). */
export const MAALE_SENDING_STALE_MS = 5 * 60 * 1000
export const MAX_DISPATCH_ATTEMPTS = 20 // delivery_dispatches_attempts_check (0..20)
/** Earliest time shown to staff for a manual retry (provider doc: "try again after a minute"). Display only. */
export const MIN_RETRY_INTERVAL_MS = 60 * 1000
/** A HTTP 401 anywhere in the integration stops every dispatch for this long (provider locks an IP after 10 bad keys). */
export const AUTH_FAILURE_STOP_MS = 30 * 60 * 1000
/** Maale's recommended test customer name is "🧪 בדיקה — לא לשלוח"; controlled tests require this prefix. */
export const TEST_ORDER_MARKER = '🧪 בדיקה'
export const DISPATCHABLE_ORDER_STATUSES: readonly string[] = ['confirmed', 'preparing']
/** Phase rule (03F): automatic dispatch for cash orders only. */
export const AUTO_DISPATCH_PAYMENT_METHODS: readonly string[] = ['cash']
/** Settlements that need manual review because a different-fee neighbour cannot be told apart from verified data
 *  (02B: Google lists Nofei Prat (₪40) streets under locality "כפר אדומים" (₪35), no neighbourhood, no house numbers). */
export const MANUAL_REVIEW_SETTLEMENTS: Readonly<Record<string, 'kfar_adumim_nofei_prat_ambiguous'>> = Object.freeze({
  'כפר אדומים': 'kfar_adumim_nofei_prat_ambiguous',
})
/** Retryable codes whose provider-side outcome is unknown — never resent automatically. */
export const AMBIGUOUS_ERROR_CODES: readonly string[] = ['timeout', 'network_error', 'provider_5xx', 'invalid_response']
/** Persisted form of a 429 with Retry-After (no extra column: fits error_code CHECK ^[a-z0-9_]{1,64}$). */
const RATE_LIMITED_CODE = /^rate_limited(?:_after_(\d{1,5}))?$/

/* ─── Persistence contract (public.delivery_dispatches — verified 03D/03E) ─── */

export type DispatchStatus = 'pending' | 'sending' | 'sent' | 'failed_retryable' | 'failed_final'

export interface DispatchRow {
  order_id: string
  external_order_id: string
  status: DispatchStatus
  attempts: number
  last_attempt_at: string | null
  /** Last failure code (null when none); read for retry / manual-review decisions. */
  error_code?: string | null
}

export interface LoadedOrder {
  snapshot: MaaleOrderSnapshot
  status: string
  /** parcel_requests.status of the order (null = no parcel). Undefined = not loaded → treated as unresolved. */
  parcelStatus?: string | null
}

export interface ReadOnlyDispatchRepo {
  /** Authoritative order snapshot + current order status + parcel status, or null. */
  loadOrder(orderId: string): Promise<LoadedOrder | null>
  getDispatch(orderId: string): Promise<DispatchRow | null>
  /** Is there any 'unauthorized' failure recorded since sinceIso (global stop)? */
  hasRecentAuthFailure(sinceIso: string): Promise<boolean>
}

export interface DispatchRepo extends ReadOnlyDispatchRepo {
  /** INSERT … ON CONFLICT (order_id) DO NOTHING with status 'pending' and external_order_id = order_id. */
  insertPending(orderId: string): Promise<void>
  /** Compare-and-set → 'sending', attempts + 1, last_attempt_at = now — only if status, attempts AND
   *  last_attempt_at are exactly what the caller read. Returns true for exactly one concurrent caller. */
  claim(orderId: string, seen: Pick<DispatchRow, 'status' | 'attempts' | 'last_attempt_at'>, nowIso: string): Promise<boolean>
  /** Only from 'sending'. Returns true only when exactly one row was updated. */
  markSent(orderId: string, v: { providerOrderId?: string; providerStatus?: string }, nowIso: string): Promise<boolean>
  /** Only from 'sending'. Returns true only when exactly one row was updated. */
  markFailed(orderId: string, status: 'failed_retryable' | 'failed_final', errorCode: string, nowIso: string,
    v?: { providerOrderId?: string }): Promise<boolean>
}

export interface DispatchDeps {
  config: MaaleConfig
  repo: DispatchRepo
  send: (payload: MaaleOrderPayload) => Promise<MaaleSendResult>
  /** Server-side dry_run quotation (lib/maaleClient.quoteMaaleOrder). Missing → dispatch fails closed. */
  quote?: (payload: MaaleOrderPayload) => Promise<MaaleQuoteResult>
  /** Kept for interface compatibility; NOT consulted in 03F — credit is never auto-dispatched until HYP exists. */
  isPaymentVerified: (orderId: string) => Promise<boolean>
  /** Ignored since 03F (the PENDING proximity gate was replaced by the provider quote check). */
  areaGeoConfig?: Readonly<Record<string, DeliveryAreaGeoConfig>>
  /**
   * S4-04B durable quote rate limit (public.consume_maale_quote_slot). The kitchen route ALWAYS supplies it, with the
   * actor bound from the authenticated session; the branch passed here comes from the database order. Consulted only
   * after every local gate and the existing-dispatch-state check, immediately before the provider quote. Any thrown
   * error or unknown answer blocks (no quote, no dispatch). S4-04C: REQUIRED — an ordinary call without it is blocked
   * (rate_limit_unavailable) before any quote; only the marker-checked testMode of the owner runner may omit it.
   */
  consumeQuoteSlot?: (orderId: string, branchId: string) => Promise<string>
  now?: () => string
  log?: (code: string) => void // short codes only — never PII, payloads or keys
}

/* ─── Pure classifications ─── */

export type SendingState = 'sending_not_stale' | 'sending_reclaimable' | 'sending_state_invalid' | 'attempts_exhausted'

export function classifySendingRow(row: Pick<DispatchRow, 'attempts' | 'last_attempt_at'>, nowMs: number): SendingState {
  if (row.attempts >= MAX_DISPATCH_ATTEMPTS) return 'attempts_exhausted'
  const last = row.last_attempt_at ? Date.parse(row.last_attempt_at) : NaN
  if (!Number.isFinite(last) || !Number.isFinite(nowMs)) return 'sending_state_invalid' // fail closed
  return nowMs - last > MAALE_SENDING_STALE_MS ? 'sending_reclaimable' : 'sending_not_stale'
}

/** error_code to persist for a failed send (429 keeps its Retry-After inside the code). */
export function persistedErrorCode(res: Extract<MaaleSendResult, { ok: false }>): string {
  if (res.errorCode === 'rate_limited' && res.retryAfterSec !== undefined)
    return `rate_limited_after_${Math.min(Math.max(0, Math.round(res.retryAfterSec)), 86_400)}`
  return res.errorCode
}

/** Every decision for a failed_retryable row is manual review (03G: no automatic retry of a submitted request). */
export type RetryDecision = {
  kind: 'manual_review'
  reason: 'previous_outcome_ambiguous' | 'retry_state_invalid' | 'rate_limited'
  /** rate_limited only: earliest time a MANUAL retry is sensible (max(60 s, Retry-After) after the attempt). Display only. */
  retryAt?: string
}

/** A failed_retryable row is never retried automatically; a 429 keeps its retry time for display. */
export function decideRetry(row: Pick<DispatchRow, 'error_code' | 'last_attempt_at'>): RetryDecision {
  const code = row.error_code ?? ''
  const m = RATE_LIMITED_CODE.exec(code)
  if (!m) return { kind: 'manual_review', reason: AMBIGUOUS_ERROR_CODES.includes(code) || !code ? 'previous_outcome_ambiguous' : 'retry_state_invalid' }
  const last = row.last_attempt_at ? Date.parse(row.last_attempt_at) : NaN
  if (!Number.isFinite(last)) return { kind: 'manual_review', reason: 'rate_limited' }
  const waitMs = Math.max(MIN_RETRY_INTERVAL_MS, (m[1] ? Number(m[1]) : 0) * 1000)
  return { kind: 'manual_review', reason: 'rate_limited', retryAt: new Date(last + waitMs).toISOString() }
}

export type ParcelGate = 'ok' | 'parcel_unresolved' | 'parcel_manual_dispatch_required'

/** No parcel / cancelled parcel → food only. Anything else is manual: the provider contract has no parcel fields. */
export function parcelGate(parcelStatus: string | null | undefined): ParcelGate {
  if (parcelStatus === null || parcelStatus === 'cancelled') return 'ok'
  if (parcelStatus === undefined || parcelStatus === 'awaiting_search' || parcelStatus === 'not_found' || parcelStatus === 'invalid')
    return 'parcel_unresolved'
  return 'parcel_manual_dispatch_required'
}

export type QuoteCheck =
  | { ok: true; zone?: string }
  | { ok: false; reason: 'quote_unavailable' | 'quote_failed' | 'quote_unauthorized' | 'quote_created_real_order'
      | 'quote_fee_missing' | 'fee_mismatch' | 'quote_amount_mismatch' | 'quote_warnings'; detail?: string }

/** Compares a quote with what the customer was charged. The zone is reported, never trusted as settlement proof. */
export function checkQuote(q: MaaleQuoteResult, payload: MaaleOrderPayload, storedFeeIls: number): QuoteCheck {
  if (!q.ok) {
    if (q.errorCode === 'unauthorized') return { ok: false, reason: 'quote_unauthorized' }
    if (q.errorCode === 'quote_created_real_order') return { ok: false, reason: 'quote_created_real_order' }
    return { ok: false, reason: 'quote_failed', detail: q.errorCode }
  }
  const feeAgorot = Math.round(storedFeeIls * 100)
  if (q.deliveryFeeAgorot === undefined) return { ok: false, reason: 'quote_fee_missing' }
  if (q.deliveryFeeAgorot !== feeAgorot) return { ok: false, reason: 'fee_mismatch', detail: `${q.deliveryFeeAgorot}!=${feeAgorot}` }
  if (payload.payment_method === 'cash') {
    if (q.courierPaysMerchantAgorot !== undefined && q.courierPaysMerchantAgorot !== payload.food_total_agorot)
      return { ok: false, reason: 'quote_amount_mismatch', detail: 'courier_pays_merchant' }
    if (q.courierCollectsFromCustomerAgorot !== undefined && q.courierCollectsFromCustomerAgorot !== payload.food_total_agorot + feeAgorot)
      return { ok: false, reason: 'quote_amount_mismatch', detail: 'courier_collects_from_customer' }
  }
  if (q.warnings.length > 0) return { ok: false, reason: 'quote_warnings', detail: q.warnings.join(',') }
  return q.zone ? { ok: true, zone: q.zone } : { ok: true }
}

/** What staff should be shown for a dispatch row (pure; for a future kitchen view — not wired). */
export type DispatchView = 'not_dispatched' | 'in_progress' | 'sent' | 'rate_limited_manual_check' | 'needs_manual_check' | 'failed'
export function dispatchView(row: Pick<DispatchRow, 'status' | 'error_code'> | null): DispatchView {
  if (!row || row.status === 'pending') return 'not_dispatched'
  if (row.status === 'sent') return 'sent'
  if (row.status === 'sending') return 'in_progress'
  // 03G: nothing is ever "scheduled" — a rate-limited row waits for a person, like every other retryable failure.
  if (row.status === 'failed_retryable') return RATE_LIMITED_CODE.test(row.error_code ?? '') ? 'rate_limited_manual_check' : 'needs_manual_check'
  return row.error_code === 'unexpected_quote_response' ? 'needs_manual_check' : 'failed'
}

/* ─── Controlled test mode (per call, server-only) ─── */

export interface ControlledTestOptions {
  /** Must equal the orderId argument — an explicit, deliberate selection of ONE order. */
  orderId: string
  /** Ignored since 03F: no safety gate can be bypassed (kept for caller compatibility). */
  bypassPaymentGate?: boolean
  /** Ignored since 03F: no safety gate can be bypassed (kept for caller compatibility). */
  bypassAreaGate?: boolean
}

export const hasTestMarker = (customerName: string | null | undefined): boolean =>
  typeof customerName === 'string' && customerName.trim().startsWith(TEST_ORDER_MARKER)

/* ─── Result ─── */

export type DispatchBlockedReason =
  | 'maale_disabled' | 'maale_not_configured' | 'order_not_found' | 'order_not_confirmed'
  | 'invalid_payload' | 'credit_dispatch_disabled' | 'parcel_unresolved' | 'parcel_manual_dispatch_required'
  | 'location_manual_review' | 'auth_stop_active' | 'auth_state_unknown'
  | 'quote_unavailable' | 'quote_failed' | 'quote_fee_missing' | 'fee_mismatch' | 'quote_amount_mismatch' | 'quote_warnings'
  | 'test_order_id_mismatch' | 'test_order_marker_missing'
  /** S4-04B: local quote rate limit reached (before any provider call; the order stays dispatchable later). */
  | 'rate_limited_local'
  /** S4-04B: the rate-limit state could not be determined (SQL error, missing function, unknown answer). */
  | 'rate_limit_unavailable'
  /** S4-04B: the limiter refused the request shape (invalid input / order not found / branch mismatch). */
  | 'rate_limit_rejected'

export type DispatchResult =
  | { ok: true; outcome: 'sent'; kind: 'created' | 'duplicate' }
  | { ok: true; outcome: 'already_sent' }
  | { ok: false; outcome: 'blocked'; reason: DispatchBlockedReason; detail?: MaalePayloadError[] | string }
  | { ok: false; outcome: 'dispatch_in_progress' | 'final_failure_exists' | 'attempts_exhausted' }
  | { ok: false; outcome: 'manual_review_required'; reason: 'previous_outcome_ambiguous' | 'retry_state_invalid' | 'sending_outcome_unknown'
      | 'quote_created_real_order' | 'rate_limited'
      /** rate_limited only: earliest sensible MANUAL retry time (display). */
      retryAt?: string }
  | { ok: false; outcome: 'failed'; retryable: boolean; errorCode: MaaleErrorCode | 'db_error'; ambiguous?: boolean; retryAfterSec?: number }
  /** The provider answered but the outcome could not be recorded: a courier may exist → manual check. */
  | { ok: false; outcome: 'persistence_failed'; providerOutcome: 'created' | 'duplicate' | 'failed' }

/* ─── Shared read-only evaluation ─── */

interface Evaluation {
  payload: ReturnType<typeof buildMaaleOrderPayload>
  paymentMethod: string | null
  parcel: ParcelGate
  location: 'ok' | 'kfar_adumim_nofei_prat_ambiguous' | 'coordinates_not_precise'
}

function evaluate(loaded: LoadedOrder): Evaluation {
  const d = loaded.snapshot.delivery
  const toNum = (v: number | string | null) => (typeof v === 'string' ? Number(v) : v)
  const city = (d?.city ?? '').trim()
  const precise = !!d && hasPreciseCoordinates({
    delivery_lat: toNum(d.delivery_lat), delivery_lng: toNum(d.delivery_lng),
    geo_source: d.geo_source as DeliveryGeoFields['geo_source'], geo_precision: d.geo_precision as DeliveryGeoFields['geo_precision'],
  })
  return {
    payload: buildMaaleOrderPayload(loaded.snapshot),
    paymentMethod: loaded.snapshot.order.payment_method,
    parcel: parcelGate(loaded.parcelStatus),
    location: MANUAL_REVIEW_SETTLEMENTS[city] ?? (precise ? 'ok' : 'coordinates_not_precise'),
  }
}

const nowFn = (deps: { now?: () => string }) => deps.now ?? (() => new Date().toISOString())

/** Global-stop state. A repo without the check (older callers) cannot prove the stop is clear → 'unknown'. */
async function authStop(repo: Partial<ReadOnlyDispatchRepo>, sinceIso: string): Promise<'clear' | 'active' | 'unknown'> {
  if (typeof repo.hasRecentAuthFailure !== 'function') return 'unknown'
  try { return (await repo.hasRecentAuthFailure(sinceIso)) ? 'active' : 'clear' } catch { return 'unknown' }
}
const minus = (iso: string, ms: number) => new Date(Date.parse(iso) - ms).toISOString()

/* ─── Dispatch ─── */

export async function dispatchOrderToMaale(
  orderId: string, deps: DispatchDeps, options: { testMode?: ControlledTestOptions } = {},
): Promise<DispatchResult> {
  const now = nowFn(deps)
  const log = deps.log ?? (() => {})
  const test = options.testMode
  const blocked = (reason: DispatchBlockedReason, detail?: MaalePayloadError[] | string): DispatchResult =>
    (detail === undefined ? { ok: false, outcome: 'blocked', reason } : { ok: false, outcome: 'blocked', reason, detail })

  // 1) Feature flag / configuration — nothing else (no DB, no network) when off. Applies to test mode too.
  if (deps.config.status === 'disabled') return blocked('maale_disabled')
  if (deps.config.status !== 'ready') return blocked('maale_not_configured')
  if (test && test.orderId !== orderId) return blocked('test_order_id_mismatch')

  // 2) Authoritative order + eligibility (read-only).
  const loaded = await deps.repo.loadOrder(orderId)
  if (!loaded) return blocked('order_not_found')
  if (test && !hasTestMarker(loaded.snapshot.order.customer_name)) return blocked('test_order_marker_missing')
  if (!DISPATCHABLE_ORDER_STATUSES.includes(loaded.status)) return blocked('order_not_confirmed')
  const ev = evaluate(loaded)
  if (!ev.payload.ok) return blocked('invalid_payload', ev.payload.errors)
  const payload = ev.payload.payload
  if (!ev.paymentMethod || !AUTO_DISPATCH_PAYMENT_METHODS.includes(ev.paymentMethod)) return blocked('credit_dispatch_disabled')
  if (ev.parcel !== 'ok') return blocked(ev.parcel)
  if (ev.location !== 'ok') return blocked(ev.location === 'coordinates_not_precise' ? 'invalid_payload' : 'location_manual_review', ev.location)

  // 3) Global stop after an authorization failure (unknown auth state → fail closed).
  const auth = await authStop(deps.repo, minus(now(), AUTH_FAILURE_STOP_MS))
  if (auth !== 'clear') return blocked(auth === 'active' ? 'auth_stop_active' : 'auth_state_unknown')

  // 4) Existing dispatch state (read-only decisions).
  let row = await deps.repo.getDispatch(orderId)
  if (row) {
    const early = stateDecision(row, Date.parse(now()))
    if (early) return early
  }

  // 5) Fresh dry_run quote — dedicated id, never stored as dispatch state.
  if (!deps.quote) return blocked('quote_unavailable')

  // 5a) S4-04B durable quote rate limit — one slot per provider quote, consumed only now (after every local gate and the
  //     existing-state check), never for a request that was already blocked. Not ok → nothing is quoted or sent.
  //     S4-04C: REQUIRED for every ordinary call. The only exemption is the explicit testMode of the owner-run
  //     controlled runner (one named UUID that must carry the "🧪 בדיקה" marker, checked above). No silent skip.
  if (deps.consumeQuoteSlot) {
    const slot = await quoteSlotDecision(deps.consumeQuoteSlot, orderId, loaded.snapshot.order.branch_id)
    if (slot !== 'ok') { log(`maale_dispatch_${slot}`); return blocked(slot) }
  } else if (!test) {
    log('maale_dispatch_rate_limit_missing')
    return blocked('rate_limit_unavailable')
  }

  const fee = Number(loaded.snapshot.delivery?.delivery_fee)
  const q = checkQuote(await deps.quote({ ...payload, external_order_id: newQuoteExternalId() }), payload, fee)
  if (!q.ok) {
    log(`maale_dispatch_${q.reason}`)
    if (q.reason === 'quote_created_real_order') return { ok: false, outcome: 'manual_review_required', reason: 'quote_created_real_order' }
    if (q.reason === 'quote_unauthorized') return recordAuthFailure(orderId, row, deps, now, log)
    return blocked(q.reason as Exclude<typeof q.reason, 'quote_created_real_order' | 'quote_unauthorized'>, q.detail)
  }

  // 6) Idempotent state row (unique order_id / external_order_id; external_order_id = order_id).
  if (!row) { await deps.repo.insertPending(orderId); row = await deps.repo.getDispatch(orderId) }
  if (!row || row.external_order_id !== orderId) { log('maale_dispatch_state_error'); return { ok: false, outcome: 'failed', retryable: true, errorCode: 'db_error' } }
  const again = stateDecision(row, Date.parse(now()))
  if (again) return again

  // 7) Claim (compare-and-set on status + attempts + last_attempt_at) — exactly one concurrent caller wins.
  const claimed = await deps.repo.claim(orderId, { status: row.status, attempts: row.attempts, last_attempt_at: row.last_attempt_at }, now())
  if (!claimed) return { ok: false, outcome: 'dispatch_in_progress' }

  // 8) One real HTTP attempt; the outcome is reported only after it is persisted.
  const res = await deps.send(payload)
  if (res.ok) {
    const saved = await safeMark(() => deps.repo.markSent(orderId, { providerOrderId: res.providerOrderId, providerStatus: res.providerStatus }, now()))
    if (!saved) { log('maale_dispatch_state_lost'); return { ok: false, outcome: 'persistence_failed', providerOutcome: res.kind } }
    log(`maale_dispatch_${res.kind}`)
    return { ok: true, outcome: 'sent', kind: res.kind }
  }
  const saved = await safeMark(() => deps.repo.markFailed(orderId, res.retryable ? 'failed_retryable' : 'failed_final', persistedErrorCode(res), now(),
    res.providerOrderId ? { providerOrderId: res.providerOrderId } : undefined))
  if (!saved) { log('maale_dispatch_state_lost'); return { ok: false, outcome: 'persistence_failed', providerOutcome: 'failed' } }
  log(`maale_dispatch_${res.errorCode}`)
  return {
    ok: false, outcome: 'failed', retryable: res.retryable, errorCode: res.errorCode,
    ...(res.ambiguous ? { ambiguous: true } : {}), ...(res.retryAfterSec !== undefined ? { retryAfterSec: res.retryAfterSec } : {}),
  }
}

/** Early exits for an existing row (identical before and after the quote). null = may proceed to claim. */
function stateDecision(row: DispatchRow, nowMs: number): DispatchResult | null {
  if (row.status === 'sent') return { ok: true, outcome: 'already_sent' }
  if (row.status === 'failed_final') return { ok: false, outcome: 'final_failure_exists' }
  if (row.attempts >= MAX_DISPATCH_ATTEMPTS) return { ok: false, outcome: 'attempts_exhausted' }
  if (row.status === 'sending') {
    const s = classifySendingRow(row, nowMs)
    if (s === 'sending_not_stale') return { ok: false, outcome: 'dispatch_in_progress' }
    if (s === 'attempts_exhausted') return { ok: false, outcome: 'attempts_exhausted' }
    return { ok: false, outcome: 'manual_review_required', reason: 'sending_outcome_unknown' } // stale / invalid: never resent
  }
  if (row.status === 'failed_retryable') {
    // 03G: a request was already submitted for this order → never submitted again automatically.
    const r = decideRetry(row)
    return r.retryAt ? { ok: false, outcome: 'manual_review_required', reason: r.reason, retryAt: r.retryAt }
      : { ok: false, outcome: 'manual_review_required', reason: r.reason }
  }
  // Only a never-attempted 'pending' row may proceed; anything else is an inconsistent state.
  if (row.status !== 'pending' || row.attempts !== 0) return { ok: false, outcome: 'manual_review_required', reason: 'retry_state_invalid' }
  return null
}

/** Bounded results of public.consume_maale_quote_slot (S4-04B1). */
export const QUOTE_SLOT_LIMIT_RESULTS: readonly string[] = ['order_limit', 'branch_limit', 'global_limit']
export const QUOTE_SLOT_REJECT_RESULTS: readonly string[] = ['invalid_request', 'order_not_found', 'branch_mismatch']

/** Maps the limiter's answer to a decision. Fail closed: a throw, a missing branch or any unknown value blocks. */
export async function quoteSlotDecision(
  consume: (orderId: string, branchId: string) => Promise<string>, orderId: string, branchId: string | null | undefined,
): Promise<'ok' | 'rate_limited_local' | 'rate_limit_unavailable' | 'rate_limit_rejected'> {
  if (typeof branchId !== 'string' || !branchId) return 'rate_limit_rejected'
  let answer: unknown
  try { answer = await consume(orderId, branchId) } catch { return 'rate_limit_unavailable' }
  if (answer === 'ok') return 'ok'
  if (typeof answer === 'string' && QUOTE_SLOT_LIMIT_RESULTS.includes(answer)) return 'rate_limited_local'
  if (typeof answer === 'string' && QUOTE_SLOT_REJECT_RESULTS.includes(answer)) return 'rate_limit_rejected'
  return 'rate_limit_unavailable'
}

async function safeMark(fn: () => Promise<boolean>): Promise<boolean> {
  try { return (await fn()) === true } catch { return false }
}

/** A 401 on the quote: record it on this order's row (claim + failed_final 'unauthorized', no real send) so the
 *  global stop sees it. */
async function recordAuthFailure(orderId: string, row: DispatchRow | null, deps: DispatchDeps, now: () => string, log: (c: string) => void): Promise<DispatchResult> {
  if (!row) { await deps.repo.insertPending(orderId); row = await deps.repo.getDispatch(orderId) }
  if (!row || row.external_order_id !== orderId) return { ok: false, outcome: 'failed', retryable: true, errorCode: 'db_error' }
  const claimed = await deps.repo.claim(orderId, { status: row.status, attempts: row.attempts, last_attempt_at: row.last_attempt_at }, now())
  if (!claimed) return { ok: false, outcome: 'dispatch_in_progress' }
  const saved = await safeMark(() => deps.repo.markFailed(orderId, 'failed_final', 'unauthorized', now()))
  if (!saved) { log('maale_dispatch_state_lost'); return { ok: false, outcome: 'persistence_failed', providerOutcome: 'failed' } }
  return { ok: false, outcome: 'failed', retryable: false, errorCode: 'unauthorized' }
}

/* ─── Controlled-test readiness (READ ONLY: no writes, no HTTP, no quote) ─── */

export type ReadinessBlocker =
  | 'order_not_found' | 'not_delivery' | 'wrong_branch' | 'test_order_marker_missing' | 'payment_method_not_allowed'
  | 'credit_dispatch_disabled' | 'address_incomplete' | 'coordinates_not_precise' | 'invalid_payload' | 'order_not_confirmed'
  | 'parcel_unresolved' | 'parcel_manual_dispatch_required' | 'location_manual_review' | 'auth_stop_active' | 'auth_state_unknown'
  | 'dispatch_already_sent' | 'dispatch_final_failure' | 'sending_not_stale' | 'sending_state_invalid' | 'sending_outcome_unknown'
  | 'attempts_exhausted' | 'previous_outcome_ambiguous' | 'retry_state_invalid' | 'rate_limited'
  | 'maale_disabled' | 'maale_not_configured'

export interface MaaleTestReadiness {
  orderId: string
  orderExists: boolean
  orderStatus: string | null
  isDelivery: boolean
  branchOk: boolean
  hasTestMarker: boolean
  /** orders.payment_method when it is a delivery method (cash / credit), else null. */
  paymentMethod: 'cash' | 'credit' | null
  paymentMethodAllowed: boolean
  /** Always false in 03F: credit is blocked outright (credit_dispatch_disabled), cash needs no payment check. */
  hypRequired: boolean
  addressComplete: boolean
  coordinatesPrecise: boolean
  payloadValid: boolean
  payloadErrors: MaalePayloadError[]
  parcelStatus: string | null
  dispatchState: DispatchStatus | 'none'
  sendingState?: SendingState
  maaleEnabled: boolean
  maaleKeyConfigured: boolean
  /** Location evidence acceptable for automatic dispatch (the fee itself is verified by a quote at dispatch time). */
  areaReady: boolean
  areaReadiness: string | null
  /** A dry_run quote with matching fee is always required before a real send. */
  quoteRequired: true
  hypVerified: boolean
  /** Always false since 03F (no gate can be overridden). */
  requiresPaymentOverride: boolean
  requiresAreaOverride: boolean
  blockers: ReadinessBlocker[]
  safeForControlledTest: boolean
  result: 'ready_for_controlled_test' | ReadinessBlocker
}

export async function assessMaaleTestReadiness(
  orderId: string,
  deps: { config: MaaleConfig; repo: ReadOnlyDispatchRepo; isPaymentVerified?: DispatchDeps['isPaymentVerified']; areaGeoConfig?: DispatchDeps['areaGeoConfig']; now?: () => string },
): Promise<MaaleTestReadiness> {
  const now = nowFn(deps)
  const blockers: ReadinessBlocker[] = []
  const maaleEnabled = deps.config.status !== 'disabled'
  const maaleKeyConfigured = deps.config.status === 'ready'
  if (!maaleEnabled) blockers.push('maale_disabled')
  else if (!maaleKeyConfigured) blockers.push('maale_not_configured')

  const loaded = await deps.repo.loadOrder(orderId)
  const base: MaaleTestReadiness = {
    orderId, orderExists: !!loaded, orderStatus: loaded?.status ?? null, isDelivery: false, branchOk: false, hasTestMarker: false,
    paymentMethod: null, paymentMethodAllowed: false, hypRequired: false, addressComplete: false, coordinatesPrecise: false,
    payloadValid: false, payloadErrors: [], parcelStatus: null, dispatchState: 'none', maaleEnabled, maaleKeyConfigured,
    areaReady: false, areaReadiness: null, quoteRequired: true, hypVerified: false, requiresPaymentOverride: false,
    requiresAreaOverride: false, blockers, safeForControlledTest: false, result: 'order_not_found',
  }
  if (!loaded) { blockers.unshift('order_not_found'); return { ...base, result: blockers[0] } }

  const ev = evaluate(loaded)
  const errs = ev.payload.ok ? [] : ev.payload.errors
  const has = (e: MaalePayloadError) => errs.includes(e)
  const pm = ev.paymentMethod === 'cash' || ev.paymentMethod === 'credit' ? ev.paymentMethod : null
  const r: MaaleTestReadiness = {
    ...base,
    isDelivery: !has('not_delivery'),
    branchOk: !has('wrong_branch'),
    hasTestMarker: hasTestMarker(loaded.snapshot.order.customer_name),
    paymentMethod: pm,
    paymentMethodAllowed: !has('payment_method_not_allowed'),
    addressComplete: !has('missing_delivery') && !has('invalid_city') && !has('missing_street') && !has('missing_house_number'),
    coordinatesPrecise: !has('invalid_lat') && !has('invalid_lng') && !has('coordinates_not_precise'),
    payloadValid: ev.payload.ok,
    payloadErrors: errs,
    parcelStatus: loaded.parcelStatus ?? null,
    areaReady: ev.location === 'ok',
    areaReadiness: ev.location,
  }
  if (!r.isDelivery) blockers.push('not_delivery')
  if (!r.branchOk) blockers.push('wrong_branch')
  if (!r.hasTestMarker) blockers.push('test_order_marker_missing')
  if (!r.paymentMethodAllowed) blockers.push('payment_method_not_allowed')
  else if (pm !== null && !AUTO_DISPATCH_PAYMENT_METHODS.includes(pm)) blockers.push('credit_dispatch_disabled')
  if (!r.addressComplete) blockers.push('address_incomplete')
  if (!r.coordinatesPrecise) blockers.push('coordinates_not_precise')
  if (!r.payloadValid) blockers.push('invalid_payload')
  if (!DISPATCHABLE_ORDER_STATUSES.includes(loaded.status)) blockers.push('order_not_confirmed')
  if (ev.parcel !== 'ok') blockers.push(ev.parcel)
  if (ev.location === 'kfar_adumim_nofei_prat_ambiguous') blockers.push('location_manual_review')
  const auth = await authStop(deps.repo, minus(now(), AUTH_FAILURE_STOP_MS))
  if (auth !== 'clear') blockers.push(auth === 'active' ? 'auth_stop_active' : 'auth_state_unknown')

  const row = await deps.repo.getDispatch(orderId)
  if (row) {
    r.dispatchState = row.status
    if (row.status === 'sending') r.sendingState = classifySendingRow(row, Date.parse(now()))
    const d = stateDecision(row, Date.parse(now()))
    if (d && !d.ok) {
      if (d.outcome === 'final_failure_exists') blockers.push('dispatch_final_failure')
      else if (d.outcome === 'attempts_exhausted') blockers.push('attempts_exhausted')
      else if (d.outcome === 'dispatch_in_progress') blockers.push('sending_not_stale')
      else if (d.outcome === 'manual_review_required')
        blockers.push(r.sendingState === 'sending_state_invalid' ? 'sending_state_invalid'
          : d.reason === 'quote_created_real_order' ? 'sending_outcome_unknown' : d.reason)
    } else if (d && d.ok) blockers.push('dispatch_already_sent')
  }

  const uniq = [...new Set(blockers)]
  return { ...r, blockers: uniq, safeForControlledTest: uniq.length === 0, result: uniq.length > 0 ? uniq[0] : 'ready_for_controlled_test' }
}

/* ─── Real dependencies (server only; unused until a trigger / test phase is approved) ─── */

export function supabaseDispatchRepo(): DispatchRepo {
  const db = getServerSupabase()
  const table = () => db.from('delivery_dispatches')
  const one = (data: unknown) => Array.isArray(data) && data.length === 1
  return {
    async loadOrder(orderId) {
      const { data, error } = await db.from('orders').select(`${MAALE_ORDER_SELECT}, status, parcel_requests(status)`).eq('id', orderId).maybeSingle()
      if (error) throw new Error(`maale_dispatch: order load ${error.code}`)
      const raw: unknown = data
      const snapshot = snapshotFromOrderRow(raw)
      const status = raw && typeof (raw as { status?: unknown }).status === 'string' ? (raw as { status: string }).status : null
      const parcelStatus = raw ? parcelStatusFromEmbed((raw as { parcel_requests?: unknown }).parcel_requests) : null
      return snapshot && status ? { snapshot, status, parcelStatus } : null
    },
    async getDispatch(orderId) {
      const { data, error } = await table().select('order_id, external_order_id, status, attempts, last_attempt_at, error_code').eq('order_id', orderId).maybeSingle()
      if (error) throw new Error(`maale_dispatch: state load ${error.code}`)
      return (data as DispatchRow | null) ?? null
    },
    async hasRecentAuthFailure(sinceIso) {
      const { data, error } = await table().select('order_id').eq('error_code', 'unauthorized').gte('updated_at', sinceIso).limit(1)
      if (error) throw new Error(`maale_dispatch: auth state ${error.code}`)
      return Array.isArray(data) && data.length > 0
    },
    async insertPending(orderId) {
      const { error } = await table().upsert(
        { order_id: orderId, external_order_id: orderId, provider: 'maale_express', status: 'pending' },
        { onConflict: 'order_id', ignoreDuplicates: true },
      )
      if (error) throw new Error(`maale_dispatch: insert ${error.code}`)
    },
    async claim(orderId, seen, nowIso) {
      let q = table()
        .update({ status: 'sending', attempts: seen.attempts + 1, last_attempt_at: nowIso, error_code: null, updated_at: nowIso })
        .eq('order_id', orderId).eq('status', seen.status).eq('attempts', seen.attempts)
      q = seen.last_attempt_at === null ? q.is('last_attempt_at', null) : q.eq('last_attempt_at', seen.last_attempt_at)
      const { data, error } = await q.select('order_id')
      if (error) throw new Error(`maale_dispatch: claim ${error.code}`)
      return one(data)
    },
    async markSent(orderId, v, nowIso) {
      const { data, error } = await table()
        .update({ status: 'sent', dispatched_at: nowIso, provider_order_id: v.providerOrderId ?? null, provider_status: v.providerStatus ?? null, error_code: null, updated_at: nowIso })
        .eq('order_id', orderId).eq('status', 'sending').select('order_id')
      if (error) throw new Error(`maale_dispatch: mark sent ${error.code}`)
      return one(data)
    },
    async markFailed(orderId, status, errorCode, nowIso, v) {
      const { data, error } = await table()
        .update({ status, error_code: errorCode, updated_at: nowIso, ...(v?.providerOrderId ? { provider_order_id: v.providerOrderId } : {}) })
        .eq('order_id', orderId).eq('status', 'sending').select('order_id')
      if (error) throw new Error(`maale_dispatch: mark failed ${error.code}`)
      return one(data)
    },
  }
}

/** Production wiring for a FUTURE trigger phase. HYP is not integrated, so payment verification is always false. */
export function defaultDispatchDeps(): DispatchDeps {
  const config = resolveMaaleConfig(process.env)
  return {
    config,
    repo: supabaseDispatchRepo(),
    send: payload => sendMaaleOrder(payload, { config, fetchImpl: fetch }),
    quote: payload => quoteMaaleOrder(payload, { config, fetchImpl: fetch }),
    isPaymentVerified: async () => false,
    log: code => console.warn('maale:', code),
  }
}
