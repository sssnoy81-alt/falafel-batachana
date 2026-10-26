// Kitchen-side MANUAL Maale Express dispatch (S4-INTEGRATIONS-03K). SERVER-ONLY business rules with injectable
// dependencies (testable without a DB or network), used by POST /api/kitchen/orders/[id]/dispatch.
//
// DISABLED unless MAALE_KITCHEN_DISPATCH_ENABLED === 'true' (checked by the route on every request; the variable is
// not set in any environment). Live sending additionally needs MAALE_EXPRESS_ENABLED + key (lib/maaleClient).
// S4-04C: even then, only accounts listed exactly in MAALE_KITCHEN_DISPATCH_USERS may see or use it (default: nobody).
// The route authenticates the kitchen session first; this module then, from the DATABASE only:
//   loads the order → branch scope (out of scope ≡ not found) → delivery + stored fee → staff-confirmed fee must equal
//   it (stale screen → 409, nothing sent) → kitchen status confirmed / preparing → lib/maaleDispatch, which re-checks
//   every 03F/03G gate (cash only, verified location, active settlement, Kfar Adumim manual, no active parcel,
//   ₪600 cash cap, quote fee, 401 stop, atomic claim, never a second submission).
// Responses carry short codes only: never the API key, provider bodies, customer phone, address or DB errors.

import { isBranchInScope } from './kitchenMutations'
import type { KitchenSession } from './kitchenAuth'
import {
  DISPATCHABLE_ORDER_STATUSES, dispatchView,
  type DispatchResult, type DispatchRow, type DispatchView,
} from './maaleDispatch'

/* ─── Feature flag ─── */

/** Only the exact string 'true' enables kitchen dispatch; anything else (incl. unset) is OFF. */
export const isKitchenDispatchEnabled = (env: Record<string, string | undefined>): boolean =>
  env.MAALE_KITCHEN_DISPATCH_ENABLED === 'true'

/* ─── Authorized accounts (S4-04C) ─── */

/** Same rule as kitchen_users.username / lib/kitchenAuth USERNAME_REGEX (lower-case, already normalized at login). */
const USERNAME_RULE = /^[a-z0-9_-]{2,32}$/
export const MAX_DISPATCH_USERS = 50

export type DispatchAllowlist = { ok: true; users: ReadonlySet<string> } | { ok: false }

/**
 * MAALE_KITCHEN_DISPATCH_USERS: comma-separated kitchen account usernames, e.g. "mishor,boss". SERVER-ONLY.
 * Unset / blank → valid and EMPTY (nobody). Any malformed entry (empty item, wildcard, upper case, spaces inside, other
 * characters, > MAX_DISPATCH_USERS) rejects the WHOLE value → nobody (fail closed). No wildcards, no prefixes.
 */
export function parseDispatchAllowlist(raw: string | undefined): DispatchAllowlist {
  if (raw === undefined || raw.trim() === '') return { ok: true, users: new Set() }
  const parts = raw.split(',').map(p => p.trim())
  if (parts.length > MAX_DISPATCH_USERS || parts.some(p => !USERNAME_RULE.test(p))) return { ok: false }
  return { ok: true, users: new Set(parts) }
}

/**
 * The ONLY authorization check for courier controls and requests: feature flag on AND this authenticated account is
 * listed exactly (Set membership — no substring / case folding). The feature flag alone never authorizes anyone.
 */
export function isKitchenDispatchAllowedFor(env: Record<string, string | undefined>, username: unknown): boolean {
  if (!isKitchenDispatchEnabled(env)) return false
  if (typeof username !== 'string' || !USERNAME_RULE.test(username)) return false
  const list = parseDispatchAllowlist(env.MAALE_KITCHEN_DISPATCH_USERS)
  return list.ok && list.users.has(username)
}

/** Kitchen statuses from which staff may request a courier. 'ready' is deliberately NOT included (03K): adding it needs
 *  explicit approval plus provider confirmation of prep_minutes: 0, and the same change in lib/maaleDispatch. */
export const KITCHEN_DISPATCH_STATUSES: readonly string[] = DISPATCHABLE_ORDER_STATUSES

/* ─── Request body ─── */

export const MAX_EXPECTED_FEE_AGOROT = 100_000 // ₪1,000 — sanity bound, far above any delivery fee

/** { expectedFeeAgorot: integer } and nothing else; null when malformed. */
export function parseDispatchBody(body: unknown): { expectedFeeAgorot: number } | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  const keys = Object.keys(body)
  if (keys.length !== 1 || keys[0] !== 'expectedFeeAgorot') return null
  const v = (body as { expectedFeeAgorot?: unknown }).expectedFeeAgorot
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_EXPECTED_FEE_AGOROT ? { expectedFeeAgorot: v } : null
}

/* ─── Dependencies ─── */

export interface KitchenDispatchOrder {
  id: string
  branch_id: string | null
  status: string
  type: string | null
  /** deliveries.delivery_fee in ₪ (numeric may arrive as a string); null when the order has no delivery row. */
  delivery_fee: number | string | null
}

export interface KitchenDispatchDeps {
  loadOrder(orderId: string): Promise<KitchenDispatchOrder | null>
  /** The dispatch service of lib/maaleDispatch with production deps, injected by the route (never test mode). */
  dispatch(orderId: string): Promise<DispatchResult>
  /** Read-only: current dispatch row for display (provider id / status / view); null when none. */
  loadDispatchRow(orderId: string): Promise<(Pick<DispatchRow, 'status' | 'error_code'> & { provider_order_id: string | null; provider_status: string | null }) | null>
  /**
   * S4-04D3: reconciliation records that forbid a new courier request (manual courier / open review), or null.
   * The route supplies it whenever the reconciliation feature is on; a failed lookup blocks (fail closed).
   * Consulted BEFORE the dispatch service, i.e. before the quote slot, the provider quote, the claim and the send.
   */
  dispatchBlockingRecord?: (orderId: string) => Promise<'manual_courier_recorded' | 'manual_review_open' | null>
  log?: (code: string) => void // short codes only
}

/* ─── Response contract (sanitized) ─── */

export type KitchenDispatchBody =
  | { result: 'dispatched' | 'already_dispatched'; providerOrderId: string | null; providerStatus: string | null; view: DispatchView }
  | { error: string; reason?: string; retryAt?: string; view?: DispatchView }

export interface KitchenDispatchResponse { status: number; body: KitchenDispatchBody }

const reply = (status: number, body: KitchenDispatchBody): KitchenDispatchResponse => ({ status, body })
const NOT_FOUND = reply(404, { error: 'not_found' })

const LOCATION_PAYLOAD_ERRORS = ['invalid_lat', 'invalid_lng', 'coordinates_not_precise', 'missing_delivery', 'invalid_city', 'missing_street', 'missing_house_number']

/** Maps a dispatch outcome to a kitchen-safe HTTP response. Pure. */
export function mapDispatchResult(r: DispatchResult): KitchenDispatchResponse {
  switch (r.outcome) {
    case 'sent': return reply(200, { result: 'dispatched', providerOrderId: null, providerStatus: null, view: 'sent' })
    case 'already_sent': return reply(200, { result: 'already_dispatched', providerOrderId: null, providerStatus: null, view: 'sent' })
    case 'dispatch_in_progress': return reply(409, { error: 'dispatch_in_progress', view: 'in_progress' })
    case 'final_failure_exists': return reply(409, { error: 'dispatch_failed_previously', view: 'failed' })
    case 'attempts_exhausted': return reply(409, { error: 'manual_review_required', reason: 'attempts_exhausted', view: 'needs_manual_check' })
    case 'manual_review_required':
      return reply(409, { error: 'manual_review_required', reason: r.reason, ...(r.retryAt ? { retryAt: r.retryAt } : {}), view: 'needs_manual_check' })
    case 'persistence_failed': return reply(500, { error: 'manual_review_required', reason: 'state_not_recorded', view: 'needs_manual_check' })
    case 'blocked': {
      switch (r.reason) {
        case 'maale_disabled': case 'maale_not_configured': case 'auth_state_unknown': return reply(503, { error: 'dispatch_unavailable' })
        case 'auth_stop_active': return reply(503, { error: 'provider_auth_stopped' })
        case 'order_not_found': return NOT_FOUND
        case 'order_not_confirmed': return reply(409, { error: 'not_eligible', reason: 'order_status' })
        case 'credit_dispatch_disabled': return reply(409, { error: 'not_eligible', reason: 'credit_not_supported' })
        case 'payment_not_verified': return reply(409, { error: 'not_eligible', reason: 'payment_not_verified' })
        case 'payment_state_unknown': return reply(503, { error: 'dispatch_unavailable' })
        case 'parcel_unresolved': case 'parcel_manual_dispatch_required': return reply(409, { error: 'not_eligible', reason: r.reason })
        case 'location_manual_review': return reply(409, { error: 'manual_review_required', reason: 'location_ambiguous', view: 'needs_manual_check' })
        case 'invalid_payload': {
          const codes = Array.isArray(r.detail) ? r.detail : []
          const reason = codes.includes('cash_amount_too_high') ? 'cash_amount_too_high'
            : codes.some(c => LOCATION_PAYLOAD_ERRORS.includes(c)) ? 'location_unverified' : 'order_data_invalid'
          return reply(409, { error: 'not_eligible', reason })
        }
        case 'quote_unavailable': case 'quote_failed': case 'quote_fee_missing': case 'fee_mismatch':
        case 'quote_amount_mismatch': case 'quote_warnings':
          return reply(409, { error: 'quote_mismatch', reason: r.reason })
        // S4-04B local quote rate limit — decided BEFORE any provider call, so nothing was sent and the order is not
        // locked (distinct from the provider's 429 'rate_limited', which means the outcome is unknown).
        case 'rate_limited_local': return reply(429, { error: 'rate_limited_local' })
        case 'rate_limit_unavailable': return reply(503, { error: 'rate_limit_unavailable' })
        case 'rate_limit_rejected': return reply(409, { error: 'rate_limit_rejected' })
        // S4-04E2: refused atomically by the claim (a manual courier / open review committed first) — nothing sent.
        case 'manual_courier_recorded': case 'manual_review_open': return reply(409, { error: 'not_eligible', reason: r.reason })
        default: return reply(400, { error: 'invalid_request' }) // test-mode reasons: unreachable from this route
      }
    }
    case 'failed': {
      if (r.ambiguous) return reply(502, { error: 'manual_review_required', reason: 'outcome_unknown', view: 'needs_manual_check' })
      switch (r.errorCode) {
        case 'unauthorized': return reply(502, { error: 'provider_auth_failed' })
        case 'blocked': return reply(409, { error: 'provider_blocked', view: 'failed' })
        case 'idempotency_mismatch': return reply(409, { error: 'provider_conflict', view: 'failed' })
        case 'rate_limited': return reply(429, { error: 'rate_limited', reason: 'manual_review_required', view: 'rate_limited_manual_check' })
        case 'timeout': case 'network_error': case 'provider_5xx': case 'invalid_response': case 'unexpected_quote_response':
          return reply(502, { error: 'manual_review_required', reason: 'outcome_unknown', view: 'needs_manual_check' })
        case 'zone_unknown': case 'out_of_area': case 'amount_too_high': case 'dispatch_closed': case 'validation_error': case 'provider_rejected':
          return reply(409, { error: 'provider_rejected', reason: r.errorCode, view: 'failed' })
        default: return reply(500, { error: 'server_error' }) // db_error and internal codes
      }
    }
  }
}

/* ─── S4-04B quote rate limit (public.consume_maale_quote_slot) ─── */

const ACTOR_REGEX = USERNAME_RULE // = kitchen_users.username rule = the function's own check

/** Minimal shape of the server Supabase client used for the limiter RPC. */
export interface QuoteSlotRpcClient {
  rpc(fn: 'consume_maale_quote_slot', args: { p_order_id: string; p_branch_id: string; p_actor: string }): PromiseLike<{ data: unknown; error: { code?: string } | null }>
}

/**
 * Consumes one quote slot. orderId: validated route UUID; branchId: from the DATABASE order (never the browser);
 * actor: the authenticated kitchen session's username (an ACCOUNT, not necessarily one person).
 * Returns the function's bounded answer; THROWS on any RPC / SQL error or an unexpected payload (caller fails closed).
 * Error details never leave the server (short code only).
 */
export async function consumeQuoteSlotRpc(db: QuoteSlotRpcClient, orderId: string, branchId: string, actor: string): Promise<string> {
  if (!ACTOR_REGEX.test(actor)) throw new Error('quote_slot_invalid_actor')
  const { data, error } = await db.rpc('consume_maale_quote_slot', { p_order_id: orderId, p_branch_id: branchId, p_actor: actor })
  if (error) throw new Error(`quote_slot_rpc_${typeof error.code === 'string' && /^[A-Z0-9]{1,8}$/.test(error.code) ? error.code : 'error'}`)
  if (typeof data !== 'string') throw new Error('quote_slot_unexpected_payload')
  return data
}

/* ─── Request ─── */

/**
 * Called by the route AFTER the feature flag, same-origin JSON, kitchen session, body and UUID checks.
 * Never calls deps.dispatch for an unknown / out-of-scope order, a stale fee, a non-delivery order or a status other
 * than confirmed / preparing.
 */
export async function requestKitchenDispatch(
  deps: KitchenDispatchDeps, session: Pick<KitchenSession, 'role' | 'branchId'>, orderId: string, expectedFeeAgorot: number,
): Promise<KitchenDispatchResponse> {
  const log = deps.log ?? (() => {})
  const order = await deps.loadOrder(orderId)
  // Out-of-scope orders are indistinguishable from missing ones (no cross-branch existence oracle).
  if (!order || !isBranchInScope(session, order.branch_id)) return NOT_FOUND

  const fee = order.delivery_fee === null ? NaN : Number(order.delivery_fee)
  if (order.type !== 'delivery' || !Number.isFinite(fee)) return reply(409, { error: 'not_eligible', reason: 'not_delivery' })
  // The staff confirmation must refer to the fee stored now (stale screen / tampered request → nothing is sent).
  if (Math.round(fee * 100) !== expectedFeeAgorot) return reply(409, { error: 'stale_confirmation' })
  if (!KITCHEN_DISPATCH_STATUSES.includes(order.status)) return reply(409, { error: 'not_eligible', reason: 'order_status' })

  // S4-04D3: a recorded manual courier / open review forbids a new request — early exit before any quote / slot. The
  // race-free decision is the atomic claim (S4-04E2: claim_maale_dispatch re-checks the ledger under the shared lock).
  // Never unlocks anything; a failed lookup blocks before any quote / slot / claim / send.
  if (deps.dispatchBlockingRecord) {
    let block: 'manual_courier_recorded' | 'manual_review_open' | null
    try { block = await deps.dispatchBlockingRecord(orderId) } catch { log('kitchen_dispatch_reconciliation_unavailable'); return reply(503, { error: 'reconciliation_unavailable' }) }
    if (block) { log(`kitchen_dispatch_${block}`); return reply(409, { error: 'not_eligible', reason: block }) }
  }

  const result = await deps.dispatch(orderId)
  const mapped = mapDispatchResult(result)
  log(`kitchen_dispatch_${'result' in mapped.body ? mapped.body.result : mapped.body.error}`)

  // Success: show the provider's order id / status from the persisted row (read-only).
  if ('result' in mapped.body) {
    const row = await deps.loadDispatchRow(orderId).catch(() => null)
    if (row) mapped.body = { ...mapped.body, providerOrderId: row.provider_order_id, providerStatus: row.provider_status, view: dispatchView(row) }
  }
  return mapped
}
