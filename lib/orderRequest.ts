// Pure request validation + authoritative order building for POST /api/orders.
// No I/O: the route loads the catalog and passes it in, so this module is fully testable.

import {
  CUSTOMER_HIDDEN_BRANCH_IDS,
  DELIVERY_AREAS,
  DELIVERY_FIELD_LIMITS,
  MAX_CART_LINES,
  MAX_CUSTOMER_NAME,
  MAX_ITEM_NOTES,
  MAX_LINE_QUANTITY,
  PHONE_REGEX,
  isDealCategory,
  isDeliveryBranch,
  isOrderType,
  isPaymentMethod,
  isToppingAllowedForItem,
  isValidSetAddon,
  isValidSetDrink,
  normalizePhone,
  setAddonExtra,
  setDrinkExtra,
  type OrderType,
  type PaymentMethod,
  type ToppingType,
} from './orderConfig'
import { computeOrderTotals, type PricingBreakdown, type PricingLineInput } from './pricing'
import { formatDeliveryAddress, type DeliveryAddress } from './deliveryAddress'

/* ─── Public contract ─── */

export interface OrderItemRequest {
  itemId: string
  quantity: number
  sauceIds: string[]
  saladIds: string[]
  paidAddonIds: string[]
  setDrink?: string
  setAddon?: string
  notes?: string
}

export interface CreateOrderRequest {
  branchId: string
  type: OrderType
  customerName: string
  phone: string
  paymentMethod: PaymentMethod
  items: OrderItemRequest[]
  delivery?: DeliveryAddress
}

export interface CreateOrderResponse {
  id: string
  dailyNumber: number
  type: OrderType
  total: number
  breakdown: PricingBreakdown
  lines: { unitPrice: number; lineTotal: number }[]
}

export type OrderErrorCode =
  | 'invalid_request'
  | 'client_prices_not_accepted'
  | 'invalid_branch'
  | 'invalid_type'
  | 'delivery_not_available'
  | 'invalid_delivery_area'
  | 'invalid_address'
  | 'invalid_name'
  | 'invalid_phone'
  | 'invalid_payment_method'
  | 'empty_cart'
  | 'invalid_quantity'
  | 'item_unavailable'
  | 'invalid_option'
  | 'closed'
  | 'server_config'
  | 'order_creation_unavailable'
  | 'server_error'

export type Result<T> = { ok: true; value: T } | { ok: false; code: OrderErrorCode; detail?: string }

const fail = (code: OrderErrorCode, detail?: string): { ok: false; code: OrderErrorCode; detail?: string } =>
  ({ ok: false, code, detail })

/* ─── Shape validation ─── */

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_REGEX.test(v)

// Money is never accepted from the client. Presence of any of these keys is rejected.
const FORBIDDEN_ORDER_KEYS = ['total', 'totalPrice', 'total_price', 'subtotal', 'deliveryFee', 'delivery_fee',
  'mealSurcharge', 'meal_surcharge', 'mealQuantity', 'meal_quantity', 'discount', 'breakdown']
const FORBIDDEN_ITEM_KEYS = ['price', 'unitPrice', 'unit_price', 'lineTotal', 'basePrice', 'setDrinkExtra', 'setAddonExtra']

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const hasAnyKey = (o: Record<string, unknown>, keys: string[]) => keys.some(k => Object.prototype.hasOwnProperty.call(o, k))

function optionalText(v: unknown, max: number): string | undefined | null {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') return null
  const t = v.trim()
  if (t.length > max) return null
  return t || undefined
}

function uuidList(v: unknown): string[] | null {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v) || v.length > 30) return null
  if (!v.every(isUuid)) return null
  if (new Set(v).size !== v.length) return null
  return v as string[]
}

export function parseCreateOrderRequest(body: unknown): Result<CreateOrderRequest> {
  if (!isRecord(body)) return fail('invalid_request')
  if (hasAnyKey(body, FORBIDDEN_ORDER_KEYS)) return fail('client_prices_not_accepted')

  const { branchId, type, customerName, phone, paymentMethod, items, delivery } = body

  if (!isUuid(branchId) || CUSTOMER_HIDDEN_BRANCH_IDS.includes(branchId)) return fail('invalid_branch')
  if (!isOrderType(type)) return fail('invalid_type')

  if (typeof customerName !== 'string') return fail('invalid_name')
  const name = customerName.trim()
  if (name.length < 2 || name.length > MAX_CUSTOMER_NAME) return fail('invalid_name')

  if (typeof phone !== 'string') return fail('invalid_phone')
  const normalizedPhone = normalizePhone(phone)
  if (!PHONE_REGEX.test(normalizedPhone)) return fail('invalid_phone')

  if (!isPaymentMethod(paymentMethod)) return fail('invalid_payment_method')

  if (!Array.isArray(items) || items.length === 0) return fail('empty_cart')
  if (items.length > MAX_CART_LINES) return fail('invalid_request', 'too_many_lines')

  const parsedItems: OrderItemRequest[] = []
  for (const raw of items) {
    if (!isRecord(raw)) return fail('invalid_request')
    if (hasAnyKey(raw, FORBIDDEN_ITEM_KEYS)) return fail('client_prices_not_accepted')
    if (!isUuid(raw.itemId)) return fail('item_unavailable')
    const q = raw.quantity
    if (typeof q !== 'number' || !Number.isInteger(q) || q < 1 || q > MAX_LINE_QUANTITY) return fail('invalid_quantity')
    const sauceIds = uuidList(raw.sauceIds)
    const saladIds = uuidList(raw.saladIds)
    const paidAddonIds = uuidList(raw.paidAddonIds)
    if (!sauceIds || !saladIds || !paidAddonIds) return fail('invalid_option')
    const setDrink = optionalText(raw.setDrink, 40)
    const setAddon = optionalText(raw.setAddon, 40)
    const notes = optionalText(raw.notes, MAX_ITEM_NOTES)
    if (setDrink === null || setAddon === null) return fail('invalid_option')
    if (notes === null) return fail('invalid_request', 'notes_too_long')
    parsedItems.push({ itemId: raw.itemId, quantity: q, sauceIds, saladIds, paidAddonIds, setDrink, setAddon, notes })
  }

  let parsedDelivery: DeliveryAddress | undefined
  if (type === 'pickup') {
    if (delivery !== undefined && delivery !== null) return fail('invalid_request', 'pickup_with_delivery')
  } else {
    if (!isDeliveryBranch(branchId)) return fail('delivery_not_available')
    if (!isRecord(delivery)) return fail('invalid_address')
    if (typeof delivery.city !== 'string' || !DELIVERY_AREAS.includes(delivery.city)) return fail('invalid_delivery_area')
    const street = optionalText(delivery.street, DELIVERY_FIELD_LIMITS.street)
    const houseNumber = optionalText(delivery.houseNumber, DELIVERY_FIELD_LIMITS.houseNumber)
    const apartment = optionalText(delivery.apartment, DELIVERY_FIELD_LIMITS.apartment)
    const floor = optionalText(delivery.floor, DELIVERY_FIELD_LIMITS.floor)
    const entrance = optionalText(delivery.entrance, DELIVERY_FIELD_LIMITS.entrance)
    const courierNotes = optionalText(delivery.courierNotes, DELIVERY_FIELD_LIMITS.courierNotes)
    if (!street || !houseNumber) return fail('invalid_address')
    if (apartment === null || floor === null || entrance === null || courierNotes === null) return fail('invalid_address')
    parsedDelivery = { city: delivery.city, street, houseNumber, apartment, floor, entrance, courierNotes }
  }

  return {
    ok: true,
    value: {
      branchId, type, customerName: name, phone: normalizedPhone, paymentMethod,
      items: parsedItems, delivery: parsedDelivery,
    },
  }
}

/* ─── Authoritative building from the catalog ─── */

export interface CatalogMenuItem {
  id: string
  category_id: string
  is_active: boolean
  has_lettuce?: boolean | null
  has_pita?: boolean | null
  has_egg?: boolean | null
}
export interface CatalogTopping { id: string; name_he: string; type: ToppingType; price: number | null }
export interface CatalogBranchPrice { item_id: string; price: number; is_available: boolean }

export interface OrderCatalog {
  items: Map<string, CatalogMenuItem>
  toppings: Map<string, CatalogTopping>
  prices: Map<string, CatalogBranchPrice> // for the requested branch only
}

/** Payload for public.create_order(p_order, p_items, p_delivery). */
export interface CreateOrderRpcArgs {
  p_order: {
    branch_id: string
    type: OrderType
    phone: string
    customer_name: string
    payment_method: PaymentMethod
    total_price: number
  }
  p_items: { item_id: string; quantity: number; unit_price: number; notes: string | null }[]
  p_delivery: null | {
    address: string
    city: string
    street: string
    house_number: string
    apartment: string | null
    floor: string | null
    entrance: string | null
    notes: string | null
    delivery_fee: number
    meal_surcharge: number
    meal_quantity: number
  }
}

export interface BuiltOrder {
  rpcArgs: CreateOrderRpcArgs
  breakdown: PricingBreakdown
  lines: { unitPrice: number; lineTotal: number }[]
}

function resolveToppings(
  ids: string[], expected: ToppingType, catalog: OrderCatalog, item: CatalogMenuItem, branchId: string,
): CatalogTopping[] | null {
  const out: CatalogTopping[] = []
  for (const id of ids) {
    const t = catalog.toppings.get(id)
    if (!t || t.type !== expected) return null
    if (!isToppingAllowedForItem(t, item, branchId)) return null
    if (expected === 'paid_addon' && (typeof t.price !== 'number' || t.price < 0)) return null // no ₪4 fallback
    out.push(t)
  }
  return out
}

// Same text format the kitchen already parses ("רטבים: … | סלטים: … | …").
function buildItemNotes(
  sauces: CatalogTopping[], salads: CatalogTopping[], addons: CatalogTopping[],
  setDrink: string | undefined, setAddon: string | undefined, notes: string | undefined,
): string | null {
  const drinkExtra = setDrinkExtra(setDrink)
  const addonExtra = setAddonExtra(setAddon)
  const text = [
    sauces.length > 0 ? `רטבים: ${sauces.map(t => t.name_he).join(', ')}` : '',
    salads.length > 0 ? `סלטים: ${salads.map(t => t.name_he).join(', ')}` : '',
    addons.length > 0 ? `תוספות: ${addons.map(t => t.name_he).join(', ')}` : '',
    setDrink ? `שתייה: ${setDrink}${drinkExtra ? ` (+₪${drinkExtra})` : ''}` : '',
    setAddon ? `תוספת עסקית: ${setAddon}${addonExtra ? ` (+₪${addonExtra})` : ' (כלול)'}` : '',
    notes || '',
  ].filter(Boolean).join(' | ')
  return text || null
}

export function buildOrderFromCatalog(req: CreateOrderRequest, catalog: OrderCatalog): Result<BuiltOrder> {
  const pricingInputs: PricingLineInput[] = []
  const itemRows: { item_id: string; quantity: number; notes: string | null }[] = []

  for (const line of req.items) {
    const item = catalog.items.get(line.itemId)
    const price = catalog.prices.get(line.itemId)
    if (!item || !item.is_active || !price || !price.is_available || typeof price.price !== 'number')
      return fail('item_unavailable', line.itemId)

    const sauces = resolveToppings(line.sauceIds, 'spread', catalog, item, req.branchId)
    const salads = resolveToppings(line.saladIds, 'filling', catalog, item, req.branchId)
    const addons = resolveToppings(line.paidAddonIds, 'paid_addon', catalog, item, req.branchId)
    if (!sauces || !salads || !addons) return fail('invalid_option', line.itemId)

    const deal = isDealCategory(item.category_id)
    if ((line.setDrink || line.setAddon) && !deal) return fail('invalid_option', line.itemId)
    if (line.setDrink && !isValidSetDrink(line.setDrink)) return fail('invalid_option', line.itemId)
    if (line.setAddon && !isValidSetAddon(line.setAddon)) return fail('invalid_option', line.itemId)

    pricingInputs.push({
      categoryId: item.category_id,
      basePrice: price.price,
      paidAddonPrices: addons.map(t => t.price as number),
      setDrink: line.setDrink,
      setAddon: line.setAddon,
      quantity: line.quantity,
    })
    itemRows.push({
      item_id: item.id,
      quantity: line.quantity,
      notes: buildItemNotes(sauces, salads, addons, line.setDrink, line.setAddon, line.notes),
    })
  }

  const totals = computeOrderTotals(pricingInputs, req.type)

  let p_delivery: CreateOrderRpcArgs['p_delivery'] = null
  if (req.type === 'delivery') {
    const d = req.delivery
    if (!d) return fail('invalid_address')
    const address = formatDeliveryAddress(d)
    if (!address || address.length > DELIVERY_FIELD_LIMITS.address) return fail('invalid_address')
    p_delivery = {
      address,
      city: d.city,
      street: d.street,
      house_number: d.houseNumber,
      apartment: d.apartment ?? null,
      floor: d.floor ?? null,
      entrance: d.entrance ?? null,
      notes: d.courierNotes ?? null,
      delivery_fee: totals.deliveryFee,
      meal_surcharge: totals.mealSurcharge,
      meal_quantity: totals.mealQuantity,
    }
  }

  const { lines, ...breakdown } = totals
  return {
    ok: true,
    value: {
      rpcArgs: {
        p_order: {
          branch_id: req.branchId,
          type: req.type,
          phone: req.phone,
          customer_name: req.customerName,
          payment_method: req.paymentMethod,
          total_price: totals.total,
        },
        p_items: itemRows.map((r, i) => ({ ...r, unit_price: lines[i].unitPrice })),
        p_delivery,
      },
      breakdown,
      lines: lines.map(l => ({ unitPrice: l.unitPrice, lineTotal: l.lineTotal })),
    },
  }
}
