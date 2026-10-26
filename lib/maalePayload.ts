// Maale Express order payload contract (FALAFEL-SN-08D9). Pure: no env, no network, no logging.
// Builds the exact body for POST /api/v1/express/integrations/orders from a SERVER-AUTHORITATIVE order snapshot
// (DB rows), never from browser request data. Fails closed: any doubt → no payload.
//
// NOT CALLED ANYWHERE YET. There is no Maale API key, no HTTP client and no dispatch trigger in this module.
// Live dispatch additionally needs: server-verified HYP payment success, approved delivery-area proximity
// (assessDeliveryDispatch in lib/deliveryLocation) and the dispatch-state persistence (delivery_dispatches).

import {
  ACTIVE_DELIVERY_AREAS, DELIVERY_BRANCH_IDS, MAX_CUSTOMER_NAME, PHONE_REGEX, allowedPaymentMethods, normalizePhone,
} from './orderConfig'
import { hasPreciseCoordinates } from './deliveryLocation'
import type { DeliveryGeoFields } from './geocoding'
import { foodTotalAgorot, roundMoney } from './pricing'

/* ─── Documented contract (for the future client; nothing here sends it) ─── */

export const MAALE_ORDERS_URL = 'https://express.maalehamishlohim.co.il/api/v1/express/integrations/orders'

export interface MaaleOrderItem { name: string; quantity: number }

/** Exact outgoing body. Deliberately NO delivery_fee / delivery_area / delivery_price (Maale prices from lat/lng),
 *  no no_house_number (our checkout requires a house number) and NO dry_run (only lib/maaleClient.quoteMaaleOrder adds
 *  it). prep_minutes only when the caller passes it (otherwise Maale's default of 20 applies). */
export interface MaaleOrderPayload {
  external_order_id: string   // orders.id — idempotency key, identical on every retry
  /** cash → the courier collects food + delivery fee from the customer and pays the restaurant for the food;
   *  credit → paid to Falafel in advance, the courier collects nothing. From orders.payment_method only. */
  payment_method: 'cash' | 'credit'
  food_total_agorot: number   // (orders.total_price − deliveries.delivery_fee) × 100 — includes the internal +₪4
  items: MaaleOrderItem[]
  customer_name: string
  customer_phone: string
  customer_address: string    // "<street> <house number>, <city>"
  lat: number
  lng: number
  drop_description?: string   // entrance / floor / apartment / notes; omitted when empty; fitted to the provider limit
  prep_minutes?: number       // integer 0..240, only when explicitly requested by the caller
}

export const MAALE_PAYLOAD_KEYS = [
  'external_order_id', 'payment_method', 'food_total_agorot', 'items', 'customer_name', 'customer_phone',
  'customer_address', 'lat', 'lng', 'drop_description',
] as const
/** Documented optional key, present only when the caller asks for it (see buildMaaleOrderPayload options). */
export const MAALE_OPTIONAL_PAYLOAD_KEYS = ['prep_minutes'] as const

/* ─── Provider limits (doc 21 Oct 2026) ─── */

export const MAALE_CASH_FOOD_CAP_AGOROT = 60_000   // ₪600 food per cash order; credit has no cap
export const MAALE_MAX_ITEMS = 100
export const MAALE_MAX_CUSTOMER_NAME = 100
export const MAALE_MAX_ADDRESS = 300
export const MAALE_DROP_DESCRIPTION_MAX = 300
/** The provider prefixes the note with "הערת לקוח: " (11 characters). Until they confirm whether it counts toward the
 *  300-character limit, reserve it conservatively (with margin) and keep our text within the remainder. */
export const MAALE_DROP_LABEL_RESERVE = 20
export const MAALE_DROP_DESCRIPTION_BUDGET = MAALE_DROP_DESCRIPTION_MAX - MAALE_DROP_LABEL_RESERVE // 280
export const MAALE_PREP_MINUTES_MIN = 0
export const MAALE_PREP_MINUTES_MAX = 240

/* ─── Server snapshot (DB rows) ─── */

export interface MaaleOrderSnapshot {
  order: {
    id: string
    type: string | null
    branch_id: string | null
    payment_method: string | null
    customer_name: string | null
    phone: string | null
    total_price: number | string | null
  }
  delivery: {
    city: string | null
    street: string | null
    house_number: string | null
    apartment: string | null
    floor: string | null
    entrance: string | null
    notes: string | null
    delivery_fee: number | string | null
    meal_surcharge: number | string | null
    delivery_lat: number | string | null
    delivery_lng: number | string | null
    geo_source: string | null
    geo_precision: string | null
  } | null
  /** order_items joined with menu_items.name_he — names come from the database only. */
  items: { name: string | null; quantity: number | string | null; unit_price: number | string | null }[]
}

/** Minimal PostgREST select for building a snapshot (server-side, service role). */
export const MAALE_ORDER_SELECT = [
  'id', 'type', 'branch_id', 'payment_method', 'customer_name', 'phone', 'total_price',
  'deliveries(city, street, house_number, apartment, floor, entrance, notes, delivery_fee, meal_surcharge, delivery_lat, delivery_lng, geo_source, geo_precision)',
  'order_items(quantity, unit_price, menu_items(name_he))',
].join(', ')

type Row = Record<string, unknown>
const isRow = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v)
const one = (v: unknown): Row | null => (Array.isArray(v) ? (isRow(v[0]) ? v[0] : null) : isRow(v) ? v : null)
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const numish = (v: unknown): number | string | null => (typeof v === 'number' || typeof v === 'string' ? v : null)

/** Normalizes a row fetched with MAALE_ORDER_SELECT into a snapshot (field-by-field; nothing passed through). */
export function snapshotFromOrderRow(raw: unknown): MaaleOrderSnapshot | null {
  if (!isRow(raw) || typeof raw.id !== 'string') return null
  const d = one(raw.deliveries)
  const items = Array.isArray(raw.order_items) ? raw.order_items.filter(isRow) : []
  return {
    order: {
      id: raw.id, type: str(raw.type), branch_id: str(raw.branch_id), payment_method: str(raw.payment_method),
      customer_name: str(raw.customer_name), phone: str(raw.phone), total_price: numish(raw.total_price),
    },
    delivery: d ? {
      city: str(d.city), street: str(d.street), house_number: str(d.house_number), apartment: str(d.apartment),
      floor: str(d.floor), entrance: str(d.entrance), notes: str(d.notes), delivery_fee: numish(d.delivery_fee),
      meal_surcharge: numish(d.meal_surcharge), delivery_lat: numish(d.delivery_lat), delivery_lng: numish(d.delivery_lng),
      geo_source: str(d.geo_source), geo_precision: str(d.geo_precision),
    } : null,
    items: items.map(it => ({ name: str(one(it.menu_items)?.name_he), quantity: numish(it.quantity), unit_price: numish(it.unit_price) })),
  }
}

/* ─── Builder ─── */

export type MaalePayloadError =
  | 'invalid_order_id' | 'not_delivery' | 'wrong_branch' | 'payment_method_not_allowed'
  | 'invalid_customer_name' | 'invalid_phone' | 'missing_delivery'
  | 'invalid_city' | 'missing_street' | 'missing_house_number'
  | 'invalid_lat' | 'invalid_lng' | 'coordinates_not_precise'
  | 'empty_items' | 'invalid_item_name' | 'invalid_item_quantity' | 'invalid_item_price'
  | 'invalid_amounts' | 'food_total_mismatch' | 'invalid_food_total'
  | 'cash_amount_too_high'    // cash food total above ₪600 (provider: arrange by phone)
  | 'too_many_items'          // more than 100 item lines
  | 'address_too_long'        // customer_address above 300 characters
  | 'invalid_prep_minutes'    // requested prep_minutes not an integer 0..240

/** Non-blocking notes about the built body (never personal data). */
export type MaalePayloadWarning = 'drop_description_truncated'

export type MaalePayloadResult =
  | { ok: true; payload: MaaleOrderPayload; warnings?: MaalePayloadWarning[] }
  | { ok: false; errors: MaalePayloadError[] }

export interface MaalePayloadOptions {
  /** Minutes until the food is ready (0..240). Omitted → not sent (provider default 20). */
  prepMinutes?: number
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_ITEM_NAME = 120
const toNum = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}
const clean = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim()

const chars = (s: string): number => [...s].length // code points, like the provider's character limits
const ELLIPSIS = '…'

type DropFields = Pick<NonNullable<MaaleOrderSnapshot['delivery']>, 'entrance' | 'floor' | 'apartment' | 'notes'>

/** Description + whether the customer's note had to be shortened to fit MAALE_DROP_DESCRIPTION_BUDGET.
 *  The structured parts (entrance / floor / apartment — 20 chars each at most) always fit; only the free-text note is cut. */
export function fitDropDescription(d: DropFields): { text: string | undefined; truncated: boolean } {
  const fixed = [
    clean(d.entrance) && `כניסה ${clean(d.entrance)}`,
    clean(d.floor) && `קומה ${clean(d.floor)}`,
    clean(d.apartment) && `דירה ${clean(d.apartment)}`,
  ].filter(Boolean) as string[]
  let note = clean(d.notes)
  const head = fixed.join(', ')
  const sep = head && note ? ', ' : ''
  let truncated = false
  const room = MAALE_DROP_DESCRIPTION_BUDGET - chars(head) - chars(sep)
  if (note && chars(note) > room) {
    note = room > 1 ? [...note].slice(0, room - 1).join('').trimEnd() + ELLIPSIS : ''
    truncated = true
  }
  const text = head + (note ? (head ? ', ' : '') + note : '')
  return { text: text || undefined, truncated }
}

/** "כניסה ב׳, קומה 2, דירה 6, קוד 1234" — empty fragments skipped; undefined when nothing to say; fitted to the budget. */
export function buildDropDescription(d: DropFields): string | undefined {
  return fitDropDescription(d).text
}

/** Builds the Maale payload or fails closed with every problem found. Never adds dry_run. */
export function buildMaaleOrderPayload(s: MaaleOrderSnapshot, opts: MaalePayloadOptions = {}): MaalePayloadResult {
  const errors: MaalePayloadError[] = []
  const warnings: MaalePayloadWarning[] = []
  const o = s.order
  const d = s.delivery

  if (typeof o.id !== 'string' || !UUID.test(o.id)) errors.push('invalid_order_id')
  if (o.type !== 'delivery') errors.push('not_delivery')
  if (!o.branch_id || !DELIVERY_BRANCH_IDS.includes(o.branch_id)) errors.push('wrong_branch')
  // Delivery: server-authoritative orders.payment_method. cash → the courier collects; prepaid → the courier collects
  // NOTHING: telephone credit, and (HYP-DELIVERY-02) 'online' = paid through HYP — sent to the provider as 'credit'.
  // Whether an 'online' payment is really verified is decided by lib/maaleDispatch (isPaymentVerified), never here.
  const pm = o.payment_method
  const paymentMethod = pm === 'cash' ? 'cash' : pm === 'credit' || pm === 'online' ? 'credit' : null
  if (!paymentMethod || (pm !== 'online' && !allowedPaymentMethods('delivery').includes(pm as 'cash' | 'credit'))) errors.push('payment_method_not_allowed')

  const name = clean(o.customer_name)
  if (name.length < 2 || name.length > MAX_CUSTOMER_NAME) errors.push('invalid_customer_name')
  const phone = normalizePhone(o.phone ?? '')
  if (!PHONE_REGEX.test(phone)) errors.push('invalid_phone')

  let lat: number | null = null
  let lng: number | null = null
  let address = ''
  let drop: string | undefined
  if (!d) errors.push('missing_delivery')
  else {
    const city = clean(d.city), street = clean(d.street), house = clean(d.house_number)
    if (!ACTIVE_DELIVERY_AREAS.includes(city)) errors.push('invalid_city') // unavailable areas have no agreed Maale price
    if (!street) errors.push('missing_street')
    if (!house) errors.push('missing_house_number')
    address = `${street} ${house}, ${city}`
    if (chars(address) > MAALE_MAX_ADDRESS) errors.push('address_too_long')
    const fitted = fitDropDescription(d)
    drop = fitted.text
    if (fitted.truncated) warnings.push('drop_description_truncated')

    lat = toNum(d.delivery_lat)
    lng = toNum(d.delivery_lng)
    if (lat === null || lat < 29 || lat > 34) errors.push('invalid_lat')
    if (lng === null || lng < 34 || lng > 36) errors.push('invalid_lng')
    // Dispatch-safe coordinates only: device GPS (manual/street) or verified geocoder (street).
    if (!hasPreciseCoordinates({ delivery_lat: lat, delivery_lng: lng, geo_source: d.geo_source as DeliveryGeoFields['geo_source'], geo_precision: d.geo_precision as DeliveryGeoFields['geo_precision'] }))
      errors.push('coordinates_not_precise')
  }

  const items: MaaleOrderItem[] = []
  let itemsSubtotal = 0
  if (s.items.length === 0) errors.push('empty_items')
  if (s.items.length > MAALE_MAX_ITEMS) errors.push('too_many_items')
  for (const it of s.items) {
    const itemName = clean(it.name)
    const q = toNum(it.quantity)
    const price = toNum(it.unit_price)
    if (!itemName || itemName.length > MAX_ITEM_NAME) errors.push('invalid_item_name')
    if (q === null || !Number.isInteger(q) || q < 1) errors.push('invalid_item_quantity')
    if (price === null || price < 0) errors.push('invalid_item_price')
    if (itemName && q !== null && Number.isInteger(q) && q >= 1) items.push({ name: itemName, quantity: q })
    if (price !== null && q !== null) itemsSubtotal = roundMoney(itemsSubtotal + price * q)
  }

  const total = toNum(o.total_price)
  const fee = d ? toNum(d.delivery_fee) : null
  const surcharge = d ? toNum(d.meal_surcharge) : null
  let food: number | null = null
  if (total === null || fee === null || surcharge === null || total < 0 || fee < 0 || surcharge < 0) errors.push('invalid_amounts')
  else {
    food = roundMoney(total - fee)                                 // what the customer paid for food (incl. +₪4)
    if (food < 0) errors.push('invalid_food_total')
    if (Math.abs(food - roundMoney(itemsSubtotal + surcharge)) > 0.005) errors.push('food_total_mismatch')
    // Provider cap: cash food total ≤ ₪600 (60000 agorot); above it the order is arranged by phone. Credit: no cap.
    if (food >= 0 && paymentMethod === 'cash' && Math.round(food * 100) > MAALE_CASH_FOOD_CAP_AGOROT) errors.push('cash_amount_too_high')
  }

  const prep = opts.prepMinutes
  if (prep !== undefined && (!Number.isInteger(prep) || prep < MAALE_PREP_MINUTES_MIN || prep > MAALE_PREP_MINUTES_MAX))
    errors.push('invalid_prep_minutes')

  const uniq = [...new Set(errors)]
  if (uniq.length > 0 || food === null || lat === null || lng === null || !paymentMethod) return { ok: false, errors: uniq.length ? uniq : ['invalid_amounts'] }

  const payload: MaaleOrderPayload = {
    external_order_id: o.id,
    payment_method: paymentMethod,
    food_total_agorot: foodTotalAgorot({ total: total as number, deliveryFee: fee as number }),
    items,
    customer_name: name,
    customer_phone: phone,
    customer_address: address,
    lat,
    lng,
    ...(drop ? { drop_description: drop } : {}),
    ...(prep !== undefined ? { prep_minutes: prep } : {}),
  }
  return warnings.length ? { ok: true, payload, warnings } : { ok: true, payload }
}
