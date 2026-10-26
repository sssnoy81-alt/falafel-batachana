// Kitchen read model (FALAFEL-SN-06C): branch scoping, minimal DB select, explicit normalization.
// Pure (no Supabase / network). Server-side use only — imports lib/kitchenAuth (node:crypto).

import { KITCHEN_BRANCH_IDS, type KitchenSession } from './kitchenAuth'
import type { KitchenDispatch, KitchenOrder, KitchenReconciliation, KitchenReconciliationEvent } from './kitchenTypes'
import { kitchenDispatchView } from './kitchenDispatchUi'
import {
  isReconciliationEventType, PROVIDER_ORDER_ID_RULE, PROVIDER_STATUS_RULE, RECONCILIATION_REASON_CODES, sortEventsNewestFirst, summarizeReconciliation,
} from './kitchenReconciliationUi'

/* ─── Branch scope ─── */

export type BranchScope =
  | { ok: true; branchIds: string[] }
  | { ok: false; status: 400 | 403; error: 'invalid_request' | 'forbidden' }

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * Policy:
 *  - `branch` param must be absent, "all", or a lowercase UUID — anything else → 400.
 *  - branch user: always scoped to session.branchId. Absent or own id → OK. Any other value
 *    (incl. "all" or another branch) → 403 forbidden (explicit, never silently widened).
 *  - admin: absent / "all" → all known branches; a known branch UUID → that branch; unknown UUID → 400.
 */
export function resolveBranchScope(session: Pick<KitchenSession, 'role' | 'branchId'>, branchParam: string | null): BranchScope {
  const param = branchParam === null || branchParam === '' ? undefined : branchParam
  if (param !== undefined && param !== 'all' && !UUID_REGEX.test(param))
    return { ok: false, status: 400, error: 'invalid_request' }

  if (session.role === 'branch') {
    if (!session.branchId || !KITCHEN_BRANCH_IDS.includes(session.branchId))
      return { ok: false, status: 403, error: 'forbidden' }
    if (param === undefined || param === session.branchId) return { ok: true, branchIds: [session.branchId] }
    return { ok: false, status: 403, error: 'forbidden' }
  }

  if (param === undefined || param === 'all') return { ok: true, branchIds: [...KITCHEN_BRANCH_IDS] }
  if (KITCHEN_BRANCH_IDS.includes(param)) return { ok: true, branchIds: [param] }
  return { ok: false, status: 400, error: 'invalid_request' }
}

/* ─── Minimal select (never '*', never deliveries(*)) ─── */

export const KITCHEN_ORDER_SELECT = [
  'id', 'daily_number', 'type', 'status', 'created_at', 'customer_name', 'phone',
  'payment_method', 'total_price', 'branch_id',
  'branches(name)',
  'order_items(id, quantity, notes, menu_items(name_he))',
  'deliveries(address, notes, meal_quantity, meal_surcharge, delivery_fee)',
  // GATE 03H — kitchen only (service role; RLS blocks anon). recipient_name needs Migration 05 installed first.
  'parcel_requests(status, tracking_ref, carrier, recipient_name)',
].join(', ')

// S4-03M — courier request state, embedded ONLY while kitchen dispatch is enabled (the disabled read is unchanged).
// delivery_dispatches.order_id is UNIQUE + FK → orders(id): a one-to-one embed like deliveries / parcel_requests.
export const KITCHEN_DISPATCH_EMBED = 'delivery_dispatches(status, error_code, provider_order_id, provider_status, last_attempt_at)'
// S4-04D — human-reported reconciliation records (FK order_id → orders; many per order). Only when explicitly requested
// (reconciliation flag on = migration s4_04d installed); without it the select is exactly as before.
export const KITCHEN_RECONCILIATION_EMBED =
  'maale_dispatch_reconciliations(id, event_type, actor_username, provider_order_id, provider_status, reason_code, created_at)'
// S4-MAALE-03 — automatic courier request task (order_id PK + FK → orders: one-to-one). Only while
// MAALE_AUTO_DISPATCH_ENABLED (= migration s4_05 installed); without it the select is exactly as before.
export const KITCHEN_AUTO_DISPATCH_EMBED = 'maale_auto_dispatch_queue(state, reason_code)'
export const kitchenOrderSelect = (dispatchEnabled: boolean, reconciliationEnabled = false, autoDispatchEnabled = false): string =>
  [KITCHEN_ORDER_SELECT, ...(dispatchEnabled ? [KITCHEN_DISPATCH_EMBED] : []), ...(reconciliationEnabled ? [KITCHEN_RECONCILIATION_EMBED] : []),
   ...(autoDispatchEnabled ? [KITCHEN_AUTO_DISPATCH_EMBED] : [])].join(', ')

/* ─── Response contract (types live in lib/kitchenTypes.ts, shared with the kitchen UI) ─── */

export type { KitchenDelivery, KitchenDispatch, KitchenOrder, KitchenOrderItem, KitchenParcel } from './kitchenTypes'
import type { KitchenAutoDispatch, KitchenAutoDispatchState } from './kitchenTypes'

/* ─── Normalization (explicit field-by-field; raw rows are never passed through) ─── */

const AUTO_STATES: readonly KitchenAutoDispatchState[] = ['queued', 'processing', 'dispatched', 'manual', 'investigate', 'skipped']
/** S4-MAALE-03 embed → { state, reason } or null (no task). An unknown state fails closed to 'investigate'. */
export function normalizeAutoDispatch(v: unknown): KitchenAutoDispatch | null {
  const r = (Array.isArray(v) ? v[0] : v) as { state?: unknown; reason_code?: unknown } | null | undefined
  if (!r || typeof r !== 'object') return null
  const state = AUTO_STATES.includes(r.state as KitchenAutoDispatchState) ? (r.state as KitchenAutoDispatchState) : 'investigate'
  const reason = typeof r.reason_code === 'string' && /^[a-z0-9_]{1,64}$/.test(r.reason_code) ? r.reason_code : null
  return { state, reason }
}

type Row = Record<string, unknown>
const isRow = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v)
// PostgREST embeds may arrive as an object or a one-element array depending on relationship detection.
const one = (v: unknown): Row | null => (Array.isArray(v) ? (isRow(v[0]) ? v[0] : null) : isRow(v) ? v : null)
const many = (v: unknown): Row[] => (Array.isArray(v) ? v.filter(isRow) : isRow(v) ? [v] : [])
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const num = (v: unknown, fallback = 0): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) ? n : fallback
}

export interface NormalizeOptions {
  /** Include `dispatch` (kitchen dispatch enabled). Off → the key is absent, exactly as before 03M. */
  dispatch?: boolean
  /** Include `reconciliation` (S4-04D). Off → the key is absent. */
  reconciliation?: boolean
  /** Include `autoDispatch` (S4-MAALE-03). Off → the key is absent. */
  autoDispatch?: boolean
  nowMs?: number
}

const USERNAME_RULE = /^[a-z0-9_-]{2,32}$/
export const RECONCILIATION_HISTORY_LIMIT = 10

/** Explicit, validated mapping; malformed rows are dropped. Summary over ALL events; history = newest 10. */
function normalizeReconciliation(v: unknown): KitchenReconciliation {
  const events: KitchenReconciliationEvent[] = many(v).flatMap(r => {
    const id = str(r.id), createdAt = str(r.created_at), actor = str(r.actor_username), eventType = r.event_type
    if (!id || !createdAt || !actor || !USERNAME_RULE.test(actor) || !isReconciliationEventType(eventType)) return []
    const pid = str(r.provider_order_id), pst = str(r.provider_status), reason = str(r.reason_code)
    return [{
      id, eventType, actor, createdAt,
      providerOrderId: pid && PROVIDER_ORDER_ID_RULE.test(pid) ? pid : null,
      providerStatus: pst && PROVIDER_STATUS_RULE.test(pst) ? pst : null,
      reasonCode: reason && RECONCILIATION_REASON_CODES.includes(reason) ? reason : null,
    }]
  })
  return { events: sortEventsNewestFirst(events).slice(0, RECONCILIATION_HISTORY_LIMIT), summary: summarizeReconciliation(events) }
}

function normalizeDispatch(v: unknown, nowMs: number): KitchenDispatch | null {
  const r = one(v)
  if (!r) return null
  return {
    view: kitchenDispatchView({ status: str(r.status), error_code: str(r.error_code), last_attempt_at: str(r.last_attempt_at) }, nowMs),
    errorCode: str(r.error_code),
    providerOrderId: str(r.provider_order_id),
    providerStatus: str(r.provider_status),
  }
}

export function normalizeKitchenOrder(raw: unknown, opts: NormalizeOptions = {}): KitchenOrder | null {
  if (!isRow(raw)) return null
  const id = str(raw.id), status = str(raw.status), createdAt = str(raw.created_at), branchId = str(raw.branch_id)
  if (!id || !status || !createdAt || !branchId) return null

  const type: 'pickup' | 'delivery' = raw.type === 'delivery' ? 'delivery' : 'pickup' // legacy NULL → pickup
  const d = type === 'delivery' ? one(raw.deliveries) : null
  const p = type === 'delivery' ? one(raw.parcel_requests) : null // parcels exist only on delivery orders

  return {
    id,
    dailyNumber: typeof raw.daily_number === 'number' ? raw.daily_number : null,
    type,
    status,
    createdAt,
    customerName: str(raw.customer_name),
    phone: str(raw.phone) ?? '',
    paymentMethod: str(raw.payment_method) ?? '',
    totalPrice: num(raw.total_price),
    branchId,
    branchName: str(one(raw.branches)?.name),
    items: many(raw.order_items).flatMap(it => {
      const itemId = str(it.id)
      if (!itemId) return []
      return [{
        id: itemId,
        name: str(one(it.menu_items)?.name_he) ?? 'פריט',
        quantity: num(it.quantity, 1),
        notes: str(it.notes),
      }]
    }),
    delivery: d && str(d.address)
      ? {
          address: str(d.address) as string,
          courierNotes: str(d.notes),
          mealQuantity: num(d.meal_quantity),
          mealSurcharge: num(d.meal_surcharge),
          deliveryFee: num(d.delivery_fee),
        }
      : null,
    // A malformed parcel row still shows up (status 'invalid'), so the kitchen never treats it as "no parcel".
    parcel: p
      ? {
          status: str(p.status) ?? 'invalid',
          trackingRef: str(p.tracking_ref) ?? '',
          carrier: str(p.carrier),
          recipientName: str(p.recipient_name) || null, // NULL before Migration 05 / without a recipient ('' never shown)
        }
      : null,
    ...(opts.dispatch ? { dispatch: type === 'delivery' ? normalizeDispatch(raw.delivery_dispatches, opts.nowMs ?? Date.now()) : null } : {}),
    ...(opts.reconciliation ? { reconciliation: type === 'delivery' ? normalizeReconciliation(raw.maale_dispatch_reconciliations) : null } : {}),
    ...(opts.autoDispatch ? { autoDispatch: type === 'delivery' ? normalizeAutoDispatch(raw.maale_auto_dispatch_queue) : null } : {}),
  }
}

export function normalizeKitchenOrders(rows: unknown, opts: NormalizeOptions = {}): KitchenOrder[] {
  return (Array.isArray(rows) ? rows : []).map(r => normalizeKitchenOrder(r, opts)).filter((o): o is KitchenOrder => o !== null)
}
