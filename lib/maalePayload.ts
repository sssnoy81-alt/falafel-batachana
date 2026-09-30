// Maale Express order payload contract (FALAFEL-SN-08D9). Pure: no env, no network, no logging.
// Builds the exact body for POST /api/v1/express/integrations/orders from a SERVER-AUTHORITATIVE order snapshot
// (DB rows), never from browser request data. Fails closed: any doubt → no payload.
//
// NOT CALLED ANYWHERE YET. There is no Maale API key, no HTTP client and no dispatch trigger in this module.
// Live dispatch additionally needs: server-verified HYP payment success, approved delivery-area proximity
// (assessDeliveryDispatch in lib/deliveryLocation) and the dispatch-state persistence (delivery_dispatches).

import {
  DELIVERY_AREAS, DELIVERY_BRANCH_IDS, MAX_CUSTOMER_NAME, PHONE_REGEX, allowedPaymentMethods, normalizePhone,
} from './orderConfig'
import { hasPreciseCoordinates } from './deliveryLocation'
import type { DeliveryGeoFields } from './geocoding'
import { foodTotalAgorot, roundMoney } from './pricing'

/* ─── Documented contract (for the future client; nothing here sends it) ─── */

export const MAALE_ORDERS_URL = 'https://express.maalehamishlohim.co.il/api/v1/express/integrations/orders'

export interface MaaleOrderItem { name: string; quantity: number }

/** Exact outgoing body. Deliberately NO delivery_fee / delivery_area / delivery_price (Maale prices from lat/lng),
 *  no no_house_number (our checkout requires a house number) and no prep_minutes (Maale defaults to 20). */
export interface MaaleOrderPayload {
  external_order_id: string   // orders.id — idempotency key, identical on every retry
  payment_method: 'credit'    // paid to Falafel; the courier collects nothing
  food_total_agorot: number   // (orders.total_price − deliveries.delivery_fee) × 100 — includes the internal +₪4
  items: MaaleOrderItem[]
  customer_name: string
  customer_phone: string
  customer_address: string    // "<street> <house number>, <city>"
  lat: number
  lng: number
  drop_description?: string   // entrance / floor / apartment / notes; omitted when empty
}

export const MAALE_PAYLOAD_KEYS = [
  'external_order_id', 'payment_method', 'food_total_agorot', 'items', 'customer_name', 'customer_phone',
  'customer_address', 'lat', 'lng', 'drop_description',
] as const

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

export type MaalePayloadResult = { ok: true; payload: MaaleOrderPayload } | { ok: false; errors: MaalePayloadError[] }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_ITEM_NAME = 120
const toNum = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}
const clean = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim()

/** "כניסה ב׳, קומה 2, דירה 6, קוד 1234" — empty fragments skipped; undefined when nothing to say. */
export function buildDropDescription(d: Pick<NonNullable<MaaleOrderSnapshot['delivery']>, 'entrance' | 'floor' | 'apartment' | 'notes'>): string | undefined {
  const parts = [
    clean(d.entrance) && `כניסה ${clean(d.entrance)}`,
    clean(d.floor) && `קומה ${clean(d.floor)}`,
    clean(d.apartment) && `דירה ${clean(d.apartment)}`,
    clean(d.notes),
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(', ') : undefined
}

/** Builds the Maale payload or fails closed with every problem found. */
export function buildMaaleOrderPayload(s: MaaleOrderSnapshot): MaalePayloadResult {
  const errors: MaalePayloadError[] = []
  const o = s.order
  const d = s.delivery

  if (typeof o.id !== 'string' || !UUID.test(o.id)) errors.push('invalid_order_id')
  if (o.type !== 'delivery') errors.push('not_delivery')
  if (!o.branch_id || !DELIVERY_BRANCH_IDS.includes(o.branch_id)) errors.push('wrong_branch')
  // Locked: delivery is credit-only (paid to Falafel; courier collects nothing).
  if (o.payment_method !== 'credit' || !allowedPaymentMethods('delivery').includes('credit')) errors.push('payment_method_not_allowed')

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
    if (!DELIVERY_AREAS.includes(city)) errors.push('invalid_city')
    if (!street) errors.push('missing_street')
    if (!house) errors.push('missing_house_number')
    address = `${street} ${house}, ${city}`
    drop = buildDropDescription(d)

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
  }

  const uniq = [...new Set(errors)]
  if (uniq.length > 0 || food === null || lat === null || lng === null) return { ok: false, errors: uniq.length ? uniq : ['invalid_amounts'] }

  const payload: MaaleOrderPayload = {
    external_order_id: o.id,
    payment_method: 'credit',
    food_total_agorot: foodTotalAgorot({ total: total as number, deliveryFee: fee as number }),
    items,
    customer_name: name,
    customer_phone: phone,
    customer_address: address,
    lat,
    lng,
    ...(drop ? { drop_description: drop } : {}),
  }
  return { ok: true, payload }
}
