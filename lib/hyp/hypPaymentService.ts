// SERVER-ONLY Hyp Pay payment flow (HYP-07). Every decision of the three public payment routes lives here, with all
// I/O injected (database, HYP transport, clock, opening hours, rate limiters, logger) so it is tested offline.
//
//   POST /api/payments/hyp/start        → server-built snapshot → payment intent → SIGN → redirect URL (no order yet)
//   GET  /api/payments/hyp/return       → store the raw return FIRST → VERIFY (server-to-server) → record → finalize
//   GET  /api/payments/intents/[token]  → sanitized state (+ order numbers once finalized)
//
// Invariants: no order before a confirmed, captured payment (finalize_paid_intent decides, HYP-05); the browser never
// supplies amount, payment method, terminal, payment status or the VERIFY result; the browser's CCode is never proof;
// unknown outcomes are left for reconciliation; no redirect target comes from the request; logs carry codes only.

import { checkSameOriginJson } from '../kitchenAuth'
import { buildOrderFromCatalog, isUuid, parseCreateOrderRequest, type CreateOrderRpcArgs } from '../orderRequest'
import { resolveHypConfig } from './hypConfig'
import { signPayment, toVerificationRecord, verificationRpcArgs, verifyHypReturn, type HypTransport } from './hypClient'
import { HypDbError, type HypDb } from './hypDb'
import { HYP_ALLOWED_BRANCH_IDS, HYP_ALLOWED_ORDER_TYPES, HYP_INTENT_TTL_SECONDS, HYP_PAYMENT_DESCRIPTION, hypPilotPhones, isHypPaymentsEnabled, isHypPilotPhoneAllowed, type EnvLike } from './hypFlags'
import { clientKey, type RateLimiter } from './hypRateLimit'

if (typeof window !== 'undefined') {
  throw new Error('lib/hyp/hypPaymentService is server-only')
}

export interface HypDeps {
  env: EnvLike
  db: HypDb
  transport?: HypTransport                 // tests inject a mock; production uses fetch (lib/hyp/hypClient)
  isShopOpen: () => boolean
  limits: { start: RateLimiter; startPhone: RateLimiter; ret: RateLimiter; status: RateLimiter }
  log: (event: string, code?: string) => void   // codes only — never raw query strings, URLs, names or phones
}

export const HYP_MAX_START_BODY_BYTES = 16384

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store, max-age=0',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
}
const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { ...SECURITY_HEADERS, ...extra } })
const fail = (status: number, error: string) => json(status, { error })
// Fixed, relative targets only (never derived from the request).
const STATUS_PAGE = (token: string) => `/order/payment/${token}`
const GENERIC_PAGE = '/order/payment'
const redirect = (location: string) => new Response(null, { status: 303, headers: { ...SECURITY_HEADERS, Location: location } })

/* ─── POST /api/payments/hyp/start ─── */

// The client sends order intent only (same body as POST /api/orders) + checkoutKey. None of these may be supplied.
const CLIENT_PAYMENT_KEYS = ['paymentMethod', 'payment_method', 'amount', 'amountAgorot', 'amount_agorot', 'terminal', 'terminalKind',
  'terminal_kind', 'Masof', 'status', 'intentId', 'intent_id', 'publicToken', 'public_token', 'hypOrderRef', 'hyp_order_ref', 'Order',
  'snapshot', 'p_order', 'p_items', 'p_delivery', 'redirectUrl', 'returnUrl', 'successUrl']

export async function handleHypStart(req: Request, deps: HypDeps): Promise<Response> {
  if (!isHypPaymentsEnabled(deps.env)) return fail(404, 'payments_disabled')
  if (!checkSameOriginJson(req)) return fail(403, 'forbidden')
  if (!deps.limits.start.hit(`ip:${clientKey(req)}`)) return fail(429, 'rate_limited')
  const declared = Number(req.headers.get('content-length') ?? '0')
  if (!Number.isFinite(declared) || declared > HYP_MAX_START_BODY_BYTES) return fail(413, 'payload_too_large')
  const text = await req.text()
  if (new TextEncoder().encode(text).length > HYP_MAX_START_BODY_BYTES) return fail(413, 'payload_too_large')

  const configured = resolveHypConfig(deps.env)
  if (!configured.ok) { deps.log('hyp_start_config', configured.error); return fail(503, 'payments_unavailable') }
  const config = configured.config

  let body: unknown
  try { body = JSON.parse(text) } catch { return fail(400, 'invalid_request') }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return fail(400, 'invalid_request')
  const raw = body as Record<string, unknown>
  if (CLIENT_PAYMENT_KEYS.some(k => Object.prototype.hasOwnProperty.call(raw, k))) return fail(400, 'client_payment_fields_not_accepted')
  const { checkoutKey, ...orderBody } = raw
  if (!isUuid(checkoutKey)) return fail(400, 'invalid_checkout_key')

  // The authoritative order parser, exactly as POST /api/orders (parcels off). 'credit' is only the parser's pickup
  // placeholder (pricing never reads the method); the stored snapshot says 'online'.
  const parsed = parseCreateOrderRequest({ ...orderBody, paymentMethod: 'credit' }, { parcelCheckoutEnabled: false })
  if (!parsed.ok) return json(400, parsed.detail ? { error: parsed.code, detail: parsed.detail } : { error: parsed.code })
  const order = parsed.value
  if (!HYP_ALLOWED_ORDER_TYPES.includes(order.type)) return fail(400, 'online_payment_type_not_allowed')
  if (!HYP_ALLOWED_BRANCH_IDS.includes(order.branchId)) return fail(400, 'online_payment_branch_not_allowed')
  if (order.parcel || order.delivery) return fail(400, 'online_payment_type_not_allowed')
  // Controlled pilot: outside HYP_PILOT_PHONES the feature behaves exactly as if it were off.
  if (!isHypPilotPhoneAllowed(deps.env, order.phone)) return fail(404, 'payments_disabled')
  if (!deps.limits.startPhone.hit(`phone:${order.phone}`)) return fail(429, 'rate_limited')
  if (!deps.isShopOpen()) return fail(409, 'closed')

  try {
    const catalog = await deps.db.loadCatalog(order)
    if (catalog === 'invalid_branch') return fail(400, 'invalid_branch')
    const built = buildOrderFromCatalog(order, catalog)
    if (!built.ok) return json(400, built.detail ? { error: built.code, detail: built.detail } : { error: built.code })

    const snapshot = toSnapshot(built.value.rpcArgs)
    const amountAgorot = Math.round(built.value.breakdown.total * 100)
    if (!Number.isSafeInteger(amountAgorot) || amountAgorot < 1 || Math.abs(built.value.breakdown.total * 100 - amountAgorot) > 1e-6
        || snapshot.p_order.total_price !== built.value.breakdown.total) {
      deps.log('hyp_start_amount_invariant'); return fail(500, 'server_error')
    }

    const intent = await deps.db.createIntent({ checkoutKey, terminalKind: config.terminalKind, snapshot, amountAgorot, ttlSeconds: HYP_INTENT_TTL_SECONDS })
    if (intent.result === 'checkout_key_reused') return fail(409, 'checkout_key_reused')
    if (intent.result === 'open_payment_exists') return fail(409, 'payment_in_progress')
    if (intent.result !== 'created' && intent.result !== 'existing') {
      deps.log('hyp_start_intent', intent.result); return fail(intent.result === 'retry' ? 409 : 500, intent.result === 'retry' ? 'retry' : 'server_error')
    }
    if (!intent.intentId || !intent.publicToken || !intent.hypOrderRef) { deps.log('hyp_start_intent', 'no_row'); return fail(500, 'server_error') }
    // The same checkout (same key, same cart) already reached HYP: never a second payment page.
    if (intent.status !== 'created') return json(409, { error: 'payment_in_progress', statusToken: intent.publicToken })

    const signed = await signPayment(config, { orderRef: intent.hypOrderRef, amountAgorot, description: HYP_PAYMENT_DESCRIPTION }, { transport: deps.transport })
    if (!signed.ok) {
      deps.log('hyp_start_sign', signed.error)
      await deps.db.recordSignResult(intent.intentId, false)          // never handed out → not_sent (no charge possible)
      return fail(502, 'payment_provider_unavailable')
    }
    const recorded = await deps.db.recordSignResult(intent.intentId, true)
    // Only the request that moved created → redirected hands out the payment-page URL.
    if (recorded.result !== 'recorded' || recorded.status !== 'redirected') {
      return json(409, { error: recorded.result === 'expired' ? 'checkout_expired' : 'payment_in_progress', statusToken: intent.publicToken })
    }
    return json(200, { redirectUrl: signed.redirectUrl, statusToken: intent.publicToken })
  } catch (e) {
    deps.log('hyp_start_db', e instanceof HypDbError ? `${e.op}:${e.code}` : 'unexpected')
    return fail(500, 'server_error')
  }
}

/** Exactly the create_order arguments the server built; pickup carries no p_delivery key (HYP-05 snapshot CHECK). */
export function toSnapshot(args: CreateOrderRpcArgs): { p_order: Omit<CreateOrderRpcArgs['p_order'], 'payment_method'> & { payment_method: 'online' }; p_items: CreateOrderRpcArgs['p_items']; p_delivery?: NonNullable<CreateOrderRpcArgs['p_delivery']> } {
  const p_order = { ...args.p_order, payment_method: 'online' as const }
  return args.p_delivery ? { p_order, p_items: args.p_items, p_delivery: args.p_delivery } : { p_order, p_items: args.p_items }
}

/* ─── GET /api/payments/hyp/return ─── */

export async function handleHypReturn(req: Request, deps: HypDeps): Promise<Response> {
  if (!deps.limits.ret.hit(`ip:${clientKey(req)}`)) return fail(429, 'rate_limited')
  let raw: string
  try { raw = new URL(req.url).search.replace(/^\?/, '') } catch { return redirect(GENERIC_PAGE) }
  if (!raw) return redirect(GENERIC_PAGE)

  let token: string | null = null
  try {
    // 1. Evidence first: the return is stored verbatim before any VERIFY (also when the flag is off).
    const stored = await deps.db.recordReturn(raw)
    if (!['recorded', 'duplicate_return'].includes(stored.result) || !stored.returnId || !stored.intentId || !stored.publicToken) {
      deps.log('hyp_return_unmatched', stored.result)
      return redirect(GENERIC_PAGE)
    }
    token = stored.publicToken

    const intent = await deps.db.getIntentForReturn(stored.intentId)
    const ret = await deps.db.getReturn(stored.returnId)
    if (!intent || !ret || ret.intentId !== intent.id) { deps.log('hyp_return_lookup', 'missing'); return redirect(STATUS_PAGE(token)) }

    // 2. VERIFY only for a return not verified yet, with the terminal the intent was created for.
    let status = intent.status
    if (ret.verifyOutcome === null) {
      const configured = resolveHypConfig(deps.env)
      if (!configured.ok || configured.config.terminalKind !== intent.terminalKind) {
        deps.log('hyp_return_config', configured.ok ? 'terminal_kind_changed' : configured.error)
        return redirect(STATUS_PAGE(token))                         // stays 'returned' → reconciliation
      }
      const result = await verifyHypReturn(configured.config,
        { rawQuery: ret.returnRaw, expectedOrderRef: intent.hypOrderRef, expectedAmountAgorot: intent.amountAgorot }, { transport: deps.transport })
      const decision = toVerificationRecord(ret.id, ret.returnRaw, result)
      if (decision.action === 'do_not_record') {
        deps.log('hyp_return_unverified', decision.reason)              // unknown outcome kept for reconciliation
        return redirect(STATUS_PAGE(token))
      }
      const db = await deps.db.recordVerification(verificationRpcArgs(decision.record))
      if (db.result !== decision.expectedDbResult && !['already_verified', 'already_recorded', 'duplicate_charge', 'declined_ignored', 'not_captured_ignored'].includes(db.result)) {
        deps.log('hyp_return_contract', `${decision.expectedDbResult}->${db.result}`)
      }
      status = db.status ?? status
    }

    // 3. Kitchen order only for a confirmed, captured payment — and only while the pilot flag is on.
    if (status === 'paid') {
      if (!isHypPaymentsEnabled(deps.env)) { deps.log('hyp_return_finalize', 'payments_disabled'); return redirect(STATUS_PAGE(token)) }
      const f = await deps.db.finalize(intent.id)
      if (!['finalized', 'already_finalized'].includes(f.result)) deps.log('hyp_return_finalize', f.result)
    }
    return redirect(STATUS_PAGE(token))
  } catch (e) {
    deps.log('hyp_return_db', e instanceof HypDbError ? `${e.op}:${e.code}` : 'unexpected')
    return redirect(token ? STATUS_PAGE(token) : GENERIC_PAGE)
  }
}

/* ─── GET /api/payments/config (HYP-08) ─── */

/** Whether the checkout may SHOW the online option. Presentation only: start re-checks everything. Fail closed —
 *  flag not exactly 'true', credentials not valid or no valid HYP_PILOT_PHONES list → null. The reason is never disclosed. */
export function handlePaymentsConfig(env: EnvLike): Response {
  const on = isHypPaymentsEnabled(env) && resolveHypConfig(env).ok && hypPilotPhones(env) !== null
  return json(200, { hypPayments: on ? { branchIds: [...HYP_ALLOWED_BRANCH_IDS], orderTypes: [...HYP_ALLOWED_ORDER_TYPES] } : null })
}

/* ─── GET /api/payments/intents/[token] ─── */

/** Customer-facing presentation of the HYP-05 states (not new states). */
export type HypPublicState = 'awaiting_payment' | 'processing' | 'confirmed' | 'failed' | 'in_review' | 'not_charged' | 'refunded'

export const PUBLIC_STATE: Readonly<Record<string, HypPublicState>> = Object.freeze({
  created: 'awaiting_payment', redirected: 'awaiting_payment',
  returned: 'processing', paid: 'processing',
  finalized: 'confirmed',
  not_sent: 'failed', declined: 'failed',
  verify_rejected: 'in_review', outcome_unknown: 'in_review', paid_hold: 'in_review', paid_amount_mismatch: 'in_review',
  no_charge_found: 'not_charged',
  voided: 'refunded', refunded: 'refunded',
})

export async function handleIntentStatus(req: Request, token: string, deps: HypDeps): Promise<Response> {
  if (!deps.limits.status.hit(`ip:${clientKey(req)}`)) return fail(429, 'rate_limited')
  if (!isUuid(token)) return fail(400, 'invalid_token')
  try {
    const intent = await deps.db.getPublicStatus(token.toLowerCase())
    if (!intent) return fail(404, 'not_found')
    const state = PUBLIC_STATE[intent.status] ?? 'in_review'
    if (state !== 'confirmed' || !intent.orderId) return json(200, { state })
    const o = await deps.db.getOrderSummary(intent.orderId)
    if (!o) return json(200, { state: 'in_review' })
    // trackingId = the order's random UUID: the same capability POST /api/orders already returns for tracking.
    return json(200, { state, order: { orderNumber: o.orderNumber, dailyNumber: o.dailyNumber, status: o.status, trackingId: intent.orderId } })
  } catch (e) {
    deps.log('hyp_status_db', e instanceof HypDbError ? `${e.op}:${e.code}` : 'unexpected')
    return fail(500, 'server_error')
  }
}
