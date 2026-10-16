// Parcel-with-food rules for the kitchen (GATE 03H / S2). Pure, no imports: safe for server routes and the
// kitchen UI. The database is the final authority — public.parcel_requests_before_write() (Production
// prosrc md5 9da7eec21b14950cfcbe4481ecbddf40 after parcel_01b) enforces the same transitions and order-state
// conditions; this module mirrors them so the API can answer with a precise 409 before touching the DB.

export const PARCEL_STATUSES = [
  'awaiting_search', 'found', 'not_found', 'handed_to_courier',
  'carrier_verified', 'delivery_problem', 'returned_to_store', 'cancelled',
] as const
export type ParcelStatus = (typeof PARCEL_STATUSES)[number]

export const isParcelStatus = (v: unknown): v is ParcelStatus =>
  typeof v === 'string' && (PARCEL_STATUSES as readonly string[]).includes(v)

/** Mirror of the DB transition check (parcel_requests_before_write). Terminal: carrier_verified, returned_to_store, cancelled. */
export const PARCEL_TRANSITIONS: Readonly<Record<ParcelStatus, readonly ParcelStatus[]>> = {
  awaiting_search: ['found', 'not_found', 'cancelled'],
  not_found: ['found', 'cancelled'],
  found: ['awaiting_search', 'handed_to_courier', 'cancelled'],
  handed_to_courier: ['carrier_verified', 'delivery_problem', 'returned_to_store'],
  delivery_problem: ['carrier_verified', 'returned_to_store'],
  carrier_verified: [],
  returned_to_store: [],
  cancelled: [],
}

/** Kitchen actions (PATCH /api/kitchen/parcels/[orderId] { action }). */
export const PARCEL_ACTIONS = [
  'found', 'not_found', 'reset', 'food_only',
  'handed_to_courier', 'carrier_verified', 'delivery_problem', 'returned_to_store',
] as const
export type ParcelAction = (typeof PARCEL_ACTIONS)[number]

export const isParcelAction = (v: unknown): v is ParcelAction =>
  typeof v === 'string' && (PARCEL_ACTIONS as readonly string[]).includes(v)

const ACTION_TARGET: Readonly<Record<ParcelAction, ParcelStatus>> = {
  found: 'found',
  not_found: 'not_found',
  reset: 'awaiting_search',
  food_only: 'cancelled',          // cancels ONLY the parcel (close_reason 'food_only'); the food order continues
  handed_to_courier: 'handed_to_courier',
  carrier_verified: 'carrier_verified',
  delivery_problem: 'delivery_problem',
  returned_to_store: 'returned_to_store',
}

/** Order statuses in which the food order counts as accepted (handoff to the courier is possible). */
const ACCEPTED_ORDER_STATUSES: readonly string[] = ['confirmed', 'preparing', 'ready', 'delivered']

/**
 * Full order cancellation for a parcel order (received + parcel not_found) stays DISABLED until Migration 03 is
 * installed: only its database trigger cancels the parcel atomically with the order. Do not enable without it.
 */
export const PARCEL_ORDER_CANCEL_ENABLED = false

/**
 * Parcel states that still require the parcel to be closed together with a cancelled order (the parcel is in the
 * store and its tracking number is still "active"). Mirrors the Migration 03 cancel-sync scope. Until Migration 03
 * is installed, a food order carrying such a parcel cannot be cancelled at all (no non-atomic workaround).
 */
export const PARCEL_STATUSES_REQUIRING_CANCEL_SYNC: readonly string[] = ['awaiting_search', 'found', 'not_found']

/** May the kitchen fully cancel a food order that carries this parcel right now? (null = no parcel → unchanged.) */
export const isOrderCancellationAllowedForParcel = (parcelStatus: unknown): boolean =>
  parcelStatus === null || PARCEL_ORDER_CANCEL_ENABLED || !PARCEL_STATUSES_REQUIRING_CANCEL_SYNC.includes(parcelStatus as string)

export type ParcelActionCheck =
  | { ok: true; from: ParcelStatus; to: ParcelStatus; closeReason: 'food_only' | null }
  | { ok: false; error: 'invalid_transition' | 'invalid_state' }

/**
 * Validates an action against the current parcel status and the food order status (same rules as the DB trigger):
 *  - found / not_found / reset: only while the order is still 'received'
 *  - food_only: only from 'not_found', only while the order is still 'received'
 *  - handed_to_courier: only from 'found', only once the food order is accepted (confirmed … delivered)
 *  - carrier_verified / delivery_problem / returned_to_store: after the handoff (no order-status condition)
 * Unknown statuses fail closed.
 */
export function checkParcelAction(action: ParcelAction, parcelStatus: unknown, orderStatus: unknown): ParcelActionCheck {
  if (!isParcelStatus(parcelStatus) || typeof orderStatus !== 'string') return { ok: false, error: 'invalid_state' }
  const to = ACTION_TARGET[action]
  if (!PARCEL_TRANSITIONS[parcelStatus].includes(to)) return { ok: false, error: 'invalid_transition' }
  if (action === 'food_only' && parcelStatus !== 'not_found') return { ok: false, error: 'invalid_transition' }

  if ((action === 'found' || action === 'not_found' || action === 'reset' || action === 'food_only') && orderStatus !== 'received')
    return { ok: false, error: 'invalid_state' }
  if (action === 'handed_to_courier' && !ACCEPTED_ORDER_STATUSES.includes(orderStatus))
    return { ok: false, error: 'invalid_state' }

  return { ok: true, from: parcelStatus, to, closeReason: action === 'food_only' ? 'food_only' : null }
}

/**
 * May the food order leave 'received' (other than by cancellation)? null = no parcel → yes (food-only order,
 * unchanged behaviour). 'found' → yes. 'cancelled' (e.g. food_only) → yes, as food only. Anything else —
 * including unknown / malformed values — → no (fail closed).
 */
export const isParcelReadyForAcceptance = (parcelStatus: unknown): boolean =>
  parcelStatus === null || parcelStatus === 'found' || parcelStatus === 'cancelled'

/**
 * Reads the parcel status from a PostgREST embed `parcel_requests(status)` on an orders row. The embed is
 * one-to-one (UNIQUE order_id) and may arrive as an object, a one-element array, an empty array or null.
 * No parcel → null. A present row without a recognised status → 'invalid' (never ready: fail closed).
 */
export function parcelStatusFromEmbed(embed: unknown): string | null {
  const rows = Array.isArray(embed) ? embed : embed === null || embed === undefined ? [] : [embed]
  if (rows.length === 0) return null
  if (rows.length > 1) return 'invalid'
  const row = rows[0]
  const status = typeof row === 'object' && row !== null ? (row as { status?: unknown }).status : undefined
  return isParcelStatus(status) ? status : 'invalid'
}

/** Actions the kitchen UI offers for the current state (the server re-validates every request). */
export function availableParcelActions(parcelStatus: unknown, orderStatus: unknown): ParcelAction[] {
  return PARCEL_ACTIONS.filter(a => checkParcelAction(a, parcelStatus, orderStatus).ok)
}

export const PARCEL_STATUS_LABELS: Readonly<Record<ParcelStatus, string>> = {
  awaiting_search: 'ממתינה לאיתור',
  found: 'אותרה',
  not_found: 'לא נמצאה',
  handed_to_courier: 'נמסרה לשליח',
  carrier_verified: 'אומתה מול חברת השילוח',
  delivery_problem: 'בעיה במסירה',
  returned_to_store: 'הוחזרה לחנות',
  cancelled: 'בוטלה (אוכל בלבד)',
}

export const PARCEL_ACTION_LABELS: Readonly<Record<ParcelAction, string>> = {
  found: '📦 חבילה אותרה',
  not_found: 'חבילה לא נמצאה',
  reset: '↩︎ החזר לחיפוש',
  food_only: 'אוכל בלבד',
  handed_to_courier: 'נמסרה לשליח',
  carrier_verified: 'אומתה מול חברת השילוח',
  delivery_problem: 'בעיה במסירה',
  returned_to_store: 'הוחזרה לחנות',
}
