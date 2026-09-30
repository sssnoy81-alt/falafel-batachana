// SERVER-ONLY Maale Express dispatch service (FALAFEL-SN-08D10 / 08D11). NOT CALLED FROM ANYWHERE YET — no kitchen
// trigger, no order-creation hook, no cron / queue / webhook / retry loop, no public or browser entry point.
// Calling it again for a failed_retryable (or stale 'sending') order IS the (future, manual) retry; it always reuses
// external_order_id = orders.id, which Maale treats idempotently (duplicate → 200).
//
// Live dispatch is currently impossible by construction (all must hold, checked BEFORE any DB write or network):
//   1. MAALE_EXPRESS_ENABLED === 'true' and MAALE_EXPRESS_API_KEY set           (not set anywhere)
//   2. server-verified HYP payment success                                       (HYP not integrated → always false)
//   3. assessDeliveryDispatch(...) === 'ready'                                   (no delivery area approved yet)
//   plus: delivery order, מישור אדומים branch, credit, status confirmed/preparing, valid 08D9 payload.
// A controlled provider test (08D11) may bypass ONLY gates 2 / 3, ONLY per call, ONLY for an explicitly named order
// whose customer name carries the test marker — never via env, never globally, never for a normal order.

import { assessDeliveryDispatch, type DispatchAssessment, type DispatchReadiness } from './deliveryLocation'
import {
  buildMaaleOrderPayload, MAALE_ORDER_SELECT, snapshotFromOrderRow,
  type MaaleOrderPayload, type MaaleOrderSnapshot, type MaalePayloadError,
} from './maalePayload'
import { resolveMaaleConfig, sendMaaleOrder, type MaaleConfig, type MaaleErrorCode, type MaaleSendResult } from './maaleClient'
import type { DeliveryGeoFields } from './geocoding'
import type { DeliveryAreaGeoConfig } from './deliveryAreasGeo'
import { getServerSupabase } from './supabaseServer'

/* ─── Constants ─── */

/** A 'sending' row older than this (by last_attempt_at) is presumed abandoned (crash mid-request) and may be reclaimed. */
export const MAALE_SENDING_STALE_MS = 5 * 60 * 1000
export const MAX_DISPATCH_ATTEMPTS = 20 // delivery_dispatches_attempts_check
/** Maale's recommended test customer name is "🧪 בדיקה — לא לשלוח"; controlled tests require this prefix. */
export const TEST_ORDER_MARKER = '🧪 בדיקה'
const DISPATCHABLE_ORDER_STATUSES = ['confirmed', 'preparing']

/* ─── Persistence contract (public.delivery_dispatches, existing schema) ─── */

export type DispatchStatus = 'pending' | 'sending' | 'sent' | 'failed_retryable' | 'failed_final'

export interface DispatchRow {
  order_id: string
  external_order_id: string
  status: DispatchStatus
  attempts: number
  last_attempt_at: string | null
}

export interface ReadOnlyDispatchRepo {
  /** Authoritative order snapshot + current order status, or null. */
  loadOrder(orderId: string): Promise<{ snapshot: MaaleOrderSnapshot; status: string } | null>
  getDispatch(orderId: string): Promise<DispatchRow | null>
}

export interface DispatchRepo extends ReadOnlyDispatchRepo {
  /** INSERT … ON CONFLICT (order_id) DO NOTHING with status 'pending' and external_order_id = order_id. */
  insertPending(orderId: string): Promise<void>
  /** Compare-and-set → 'sending', attempts + 1, last_attempt_at = now — only if status, attempts AND
   *  last_attempt_at are exactly what the caller read. Returns true for exactly one concurrent caller. */
  claim(orderId: string, seen: Pick<DispatchRow, 'status' | 'attempts' | 'last_attempt_at'>, nowIso: string): Promise<boolean>
  /** Only from 'sending'. */
  markSent(orderId: string, v: { providerOrderId?: string; providerStatus?: string }, nowIso: string): Promise<void>
  markFailed(orderId: string, status: 'failed_retryable' | 'failed_final', errorCode: string, nowIso: string): Promise<void>
}

export interface DispatchDeps {
  config: MaaleConfig
  repo: DispatchRepo
  send: (payload: MaaleOrderPayload) => Promise<MaaleSendResult>
  /** Server-verified HYP payment success. HYP is not integrated → default is always false. */
  isPaymentVerified: (orderId: string) => Promise<boolean>
  /** Tests only. Production always uses the real DELIVERY_AREA_GEO (no area approved yet). */
  areaGeoConfig?: Readonly<Record<string, DeliveryAreaGeoConfig>>
  now?: () => string
  log?: (code: string) => void // short codes only — never PII, payloads or keys
}

/* ─── Stale 'sending' classification (pure) ─── */

export type SendingState = 'sending_not_stale' | 'sending_reclaimable' | 'sending_state_invalid' | 'attempts_exhausted'

export function classifySendingRow(row: Pick<DispatchRow, 'attempts' | 'last_attempt_at'>, nowMs: number): SendingState {
  if (row.attempts >= MAX_DISPATCH_ATTEMPTS) return 'attempts_exhausted'
  const last = row.last_attempt_at ? Date.parse(row.last_attempt_at) : NaN
  if (!Number.isFinite(last) || !Number.isFinite(nowMs)) return 'sending_state_invalid' // fail closed
  return nowMs - last > MAALE_SENDING_STALE_MS ? 'sending_reclaimable' : 'sending_not_stale'
}

/* ─── Controlled test mode (per call, server-only) ─── */

export interface ControlledTestOptions {
  /** Must equal the orderId argument — an explicit, deliberate selection of ONE order. */
  orderId: string
  /** Temporary bypass of the HYP gate for this one test order only. */
  bypassPaymentGate?: boolean
  /** Temporary bypass of the approved-area gate for this one test order only. */
  bypassAreaGate?: boolean
}

export const hasTestMarker = (customerName: string | null | undefined): boolean =>
  typeof customerName === 'string' && customerName.trim().startsWith(TEST_ORDER_MARKER)

/* ─── Result ─── */

export type DispatchBlockedReason =
  | 'maale_disabled' | 'maale_not_configured' | 'order_not_found' | 'order_not_confirmed'
  | 'invalid_payload' | 'payment_not_verified' | 'area_not_ready'
  | 'test_order_id_mismatch' | 'test_order_marker_missing'

type DispatchBlockedDetail = MaalePayloadError[] | DispatchReadiness

export type DispatchResult =
  | { ok: true; outcome: 'sent'; kind: 'created' | 'duplicate'; reclaimed: boolean }
  | { ok: true; outcome: 'already_sent' }
  | { ok: false; outcome: 'blocked'; reason: DispatchBlockedReason; detail?: DispatchBlockedDetail }
  | { ok: false; outcome: 'dispatch_in_progress' | 'final_failure_exists' | 'attempts_exhausted' | 'sending_state_invalid' }
  | { ok: false; outcome: 'failed'; retryable: boolean; errorCode: MaaleErrorCode | 'db_error' }

/* ─── Shared gate evaluation (read-only) ─── */

interface GateEvaluation {
  payload: ReturnType<typeof buildMaaleOrderPayload>
  paymentVerified: boolean
  assessment: DispatchAssessment
}

async function evaluateGates(
  orderId: string, loaded: { snapshot: MaaleOrderSnapshot },
  deps: Pick<DispatchDeps, 'isPaymentVerified' | 'areaGeoConfig'>,
): Promise<GateEvaluation> {
  const d = loaded.snapshot.delivery
  const toNum = (v: number | string | null) => (typeof v === 'string' ? Number(v) : v)
  return {
    payload: buildMaaleOrderPayload(loaded.snapshot),
    paymentVerified: await deps.isPaymentVerified(orderId),
    assessment: assessDeliveryDispatch({
      type: loaded.snapshot.order.type,
      address: d ? { city: d.city, street: d.street, houseNumber: d.house_number } : null,
      geo: d ? {
        delivery_lat: toNum(d.delivery_lat), delivery_lng: toNum(d.delivery_lng),
        geo_source: d.geo_source as DeliveryGeoFields['geo_source'],
        geo_precision: d.geo_precision as DeliveryGeoFields['geo_precision'],
      } : null,
    }, deps.areaGeoConfig),
  }
}

/* ─── Dispatch ─── */

export async function dispatchOrderToMaale(
  orderId: string, deps: DispatchDeps, options: { testMode?: ControlledTestOptions } = {},
): Promise<DispatchResult> {
  const now = deps.now ?? (() => new Date().toISOString())
  const log = deps.log ?? (() => {})
  const test = options.testMode

  // 1) Feature flag / configuration — nothing else (no DB, no network) when off. Applies to test mode too.
  if (deps.config.status === 'disabled') return { ok: false, outcome: 'blocked', reason: 'maale_disabled' }
  if (deps.config.status !== 'ready') return { ok: false, outcome: 'blocked', reason: 'maale_not_configured' }
  if (test && test.orderId !== orderId) return { ok: false, outcome: 'blocked', reason: 'test_order_id_mismatch' }

  // 2) Authoritative order + preconditions (read-only).
  const loaded = await deps.repo.loadOrder(orderId)
  if (!loaded) return { ok: false, outcome: 'blocked', reason: 'order_not_found' }
  if (test && !hasTestMarker(loaded.snapshot.order.customer_name)) return { ok: false, outcome: 'blocked', reason: 'test_order_marker_missing' }
  if (!DISPATCHABLE_ORDER_STATUSES.includes(loaded.status)) return { ok: false, outcome: 'blocked', reason: 'order_not_confirmed' }

  const gates = await evaluateGates(orderId, loaded, deps)
  if (!gates.payload.ok) return { ok: false, outcome: 'blocked', reason: 'invalid_payload', detail: gates.payload.errors }
  const payload = gates.payload.payload
  // Bypasses exist only inside an explicit, marker-verified test call (never env / global / normal orders).
  if (!gates.paymentVerified && !(test && test.bypassPaymentGate === true))
    return { ok: false, outcome: 'blocked', reason: 'payment_not_verified' }
  if (gates.assessment.readiness !== 'ready' && !(test && test.bypassAreaGate === true))
    return { ok: false, outcome: 'blocked', reason: 'area_not_ready', detail: gates.assessment.readiness }

  // 3) Idempotent state (DB unique order_id / external_order_id; external_order_id = order_id).
  let row = await deps.repo.getDispatch(orderId)
  if (!row) { await deps.repo.insertPending(orderId); row = await deps.repo.getDispatch(orderId) }
  if (!row || row.external_order_id !== orderId) { log('maale_dispatch_state_error'); return { ok: false, outcome: 'failed', retryable: true, errorCode: 'db_error' } }
  if (row.status === 'sent') return { ok: true, outcome: 'already_sent' }
  if (row.status === 'failed_final') return { ok: false, outcome: 'final_failure_exists' }
  if (row.attempts >= MAX_DISPATCH_ATTEMPTS) return { ok: false, outcome: 'attempts_exhausted' }
  let reclaimed = false
  if (row.status === 'sending') {
    const s = classifySendingRow(row, Date.parse(now()))
    if (s === 'sending_not_stale') return { ok: false, outcome: 'dispatch_in_progress' }
    if (s !== 'sending_reclaimable') return { ok: false, outcome: s } // invalid state / exhausted → fail closed
    reclaimed = true // possibly reached Maale before a crash — same external_order_id makes the retry idempotent
  }

  // 4) Claim (compare-and-set on status + attempts + last_attempt_at) — exactly one concurrent caller wins.
  const claimed = await deps.repo.claim(orderId, { status: row.status, attempts: row.attempts, last_attempt_at: row.last_attempt_at }, now())
  if (!claimed) return { ok: false, outcome: 'dispatch_in_progress' }
  if (reclaimed) log('maale_dispatch_reclaimed_stale_sending')

  // 5) One HTTP attempt with the 08D9 payload; persist the normalized outcome.
  const res = await deps.send(payload)
  if (res.ok) {
    await deps.repo.markSent(orderId, { providerOrderId: res.providerOrderId, providerStatus: res.providerStatus }, now())
    log(`maale_dispatch_${res.kind}`)
    return { ok: true, outcome: 'sent', kind: res.kind, reclaimed }
  }
  await deps.repo.markFailed(orderId, res.retryable ? 'failed_retryable' : 'failed_final', res.errorCode, now())
  log(`maale_dispatch_${res.errorCode}`)
  return { ok: false, outcome: 'failed', retryable: res.retryable, errorCode: res.errorCode }
}

/* ─── Controlled-test readiness (READ ONLY: no writes, no HTTP, no dispatch) ─── */

export type ReadinessBlocker =
  | 'order_not_found' | 'not_delivery' | 'wrong_branch' | 'test_order_marker_missing' | 'payment_method_not_allowed'
  | 'address_incomplete' | 'coordinates_not_precise' | 'invalid_payload' | 'order_not_confirmed'
  | 'dispatch_already_sent' | 'dispatch_final_failure' | 'sending_not_stale' | 'sending_state_invalid' | 'attempts_exhausted'
  | 'maale_disabled' | 'maale_not_configured'

export interface MaaleTestReadiness {
  orderId: string
  orderExists: boolean
  orderStatus: string | null
  isDelivery: boolean
  branchOk: boolean
  hasTestMarker: boolean
  paymentMethodCredit: boolean
  addressComplete: boolean
  coordinatesPrecise: boolean
  payloadValid: boolean
  payloadErrors: MaalePayloadError[]
  dispatchState: DispatchStatus | 'none'
  sendingState?: SendingState
  maaleEnabled: boolean
  maaleKeyConfigured: boolean
  areaReady: boolean
  areaReadiness: DispatchReadiness | null
  hypVerified: boolean
  requiresPaymentOverride: boolean
  requiresAreaOverride: boolean
  blockers: ReadinessBlocker[]
  /** No blockers (overrides may still be needed, see result). */
  safeForControlledTest: boolean
  result: 'ready_for_controlled_test' | 'test_override_required' | ReadinessBlocker
}

export async function assessMaaleTestReadiness(
  orderId: string,
  deps: { config: MaaleConfig; repo: ReadOnlyDispatchRepo; isPaymentVerified: DispatchDeps['isPaymentVerified']; areaGeoConfig?: DispatchDeps['areaGeoConfig']; now?: () => string },
): Promise<MaaleTestReadiness> {
  const blockers: ReadinessBlocker[] = []
  const maaleEnabled = deps.config.status !== 'disabled'
  const maaleKeyConfigured = deps.config.status === 'ready'
  if (!maaleEnabled) blockers.push('maale_disabled')
  else if (!maaleKeyConfigured) blockers.push('maale_not_configured')

  const loaded = await deps.repo.loadOrder(orderId)
  const base: MaaleTestReadiness = {
    orderId, orderExists: !!loaded, orderStatus: loaded?.status ?? null, isDelivery: false, branchOk: false, hasTestMarker: false,
    paymentMethodCredit: false, addressComplete: false, coordinatesPrecise: false, payloadValid: false, payloadErrors: [],
    dispatchState: 'none', maaleEnabled, maaleKeyConfigured, areaReady: false, areaReadiness: null, hypVerified: false,
    requiresPaymentOverride: true, requiresAreaOverride: true, blockers, safeForControlledTest: false, result: 'order_not_found',
  }
  if (!loaded) { blockers.unshift('order_not_found'); return { ...base, result: blockers[0] } }

  const gates = await evaluateGates(orderId, loaded, deps)
  const errs = gates.payload.ok ? [] : gates.payload.errors
  const has = (e: MaalePayloadError) => errs.includes(e)
  const r: MaaleTestReadiness = {
    ...base,
    isDelivery: !has('not_delivery'),
    branchOk: !has('wrong_branch'),
    hasTestMarker: hasTestMarker(loaded.snapshot.order.customer_name),
    paymentMethodCredit: !has('payment_method_not_allowed'),
    addressComplete: !has('missing_delivery') && !has('invalid_city') && !has('missing_street') && !has('missing_house_number'),
    coordinatesPrecise: !has('invalid_lat') && !has('invalid_lng') && !has('coordinates_not_precise'),
    payloadValid: gates.payload.ok,
    payloadErrors: errs,
    hypVerified: gates.paymentVerified,
    areaReady: gates.assessment.readiness === 'ready',
    areaReadiness: gates.assessment.readiness,
    requiresPaymentOverride: !gates.paymentVerified,
    requiresAreaOverride: gates.assessment.readiness !== 'ready',
  }
  if (!r.isDelivery) blockers.push('not_delivery')
  if (!r.branchOk) blockers.push('wrong_branch')
  if (!r.hasTestMarker) blockers.push('test_order_marker_missing')
  if (!r.paymentMethodCredit) blockers.push('payment_method_not_allowed')
  if (!r.addressComplete) blockers.push('address_incomplete')
  if (!r.coordinatesPrecise) blockers.push('coordinates_not_precise')
  if (!r.payloadValid) blockers.push('invalid_payload')
  if (!DISPATCHABLE_ORDER_STATUSES.includes(loaded.status)) blockers.push('order_not_confirmed')

  const row = await deps.repo.getDispatch(orderId)
  if (row) {
    r.dispatchState = row.status
    if (row.status === 'sent') blockers.push('dispatch_already_sent')
    else if (row.status === 'failed_final') blockers.push('dispatch_final_failure')
    else if (row.attempts >= MAX_DISPATCH_ATTEMPTS) blockers.push('attempts_exhausted')
    else if (row.status === 'sending') {
      r.sendingState = classifySendingRow(row, Date.parse((deps.now ?? (() => new Date().toISOString()))()))
      if (r.sendingState !== 'sending_reclaimable') blockers.push(r.sendingState)
    }
  }

  const uniq = [...new Set(blockers)]
  const overrides = r.requiresPaymentOverride || r.requiresAreaOverride
  return {
    ...r, blockers: uniq, safeForControlledTest: uniq.length === 0,
    result: uniq.length > 0 ? uniq[0] : overrides ? 'test_override_required' : 'ready_for_controlled_test',
  }
}

/* ─── Real dependencies (server only; unused until a trigger / test phase is approved) ─── */

export function supabaseDispatchRepo(): DispatchRepo {
  const db = getServerSupabase()
  const table = () => db.from('delivery_dispatches')
  return {
    async loadOrder(orderId) {
      const { data, error } = await db.from('orders').select(`${MAALE_ORDER_SELECT}, status`).eq('id', orderId).maybeSingle()
      if (error) throw new Error(`maale_dispatch: order load ${error.code}`)
      const raw: unknown = data
      const snapshot = snapshotFromOrderRow(raw)
      const status = raw && typeof (raw as { status?: unknown }).status === 'string' ? (raw as { status: string }).status : null
      return snapshot && status ? { snapshot, status } : null
    },
    async getDispatch(orderId) {
      const { data, error } = await table().select('order_id, external_order_id, status, attempts, last_attempt_at').eq('order_id', orderId).maybeSingle()
      if (error) throw new Error(`maale_dispatch: state load ${error.code}`)
      return (data as DispatchRow | null) ?? null
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
      return Array.isArray(data) && data.length === 1
    },
    async markSent(orderId, v, nowIso) {
      const { error } = await table()
        .update({ status: 'sent', dispatched_at: nowIso, provider_order_id: v.providerOrderId ?? null, provider_status: v.providerStatus ?? null, error_code: null, updated_at: nowIso })
        .eq('order_id', orderId).eq('status', 'sending')
      if (error) throw new Error(`maale_dispatch: mark sent ${error.code}`)
    },
    async markFailed(orderId, status, errorCode, nowIso) {
      const { error } = await table()
        .update({ status, error_code: errorCode, updated_at: nowIso })
        .eq('order_id', orderId).eq('status', 'sending')
      if (error) throw new Error(`maale_dispatch: mark failed ${error.code}`)
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
    isPaymentVerified: async () => false,
    log: code => console.warn('maale:', code),
  }
}
