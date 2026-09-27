// Pure pricing model shared by the customer UI (display) and POST /api/orders (authoritative).
// No Supabase, no network, no browser APIs. The server result is always the one that is stored.

import {
  DELIVERY_FEE,
  DELIVERY_MEAL_SURCHARGE,
  isMealCategory,
  setAddonExtra,
  setDrinkExtra,
  type OrderType,
} from './orderConfig'

/** Round money to 2 decimals (avoids float noise such as 0.1 + 0.2). */
export const roundMoney = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100

export interface PricingLineInput {
  categoryId: string
  basePrice: number            // branch_prices.price
  paidAddonPrices: number[]    // prices of chosen paid_addon toppings
  setDrink?: string | null     // deal drink choice (name)
  setAddon?: string | null     // deal side choice (name)
  quantity: number
}

export interface PricedLine {
  unitPrice: number        // base + paid add-ons + deal extras (what order_items.unit_price stores)
  lineTotal: number        // unitPrice × quantity
  qualifiesMeal: boolean   // category is in MEAL_CATEGORY_IDS
  quantity: number
}

export interface PricingBreakdown {
  subtotal: number
  mealQuantity: number     // qualifying units (counted for both types; charged only for delivery)
  mealSurcharge: number
  deliveryFee: number
  discount: 0
  total: number
}

export interface OrderTotals extends PricingBreakdown {
  lines: PricedLine[]
}

export function priceLine(line: PricingLineInput): PricedLine {
  const addons = line.paidAddonPrices.reduce((s, p) => s + p, 0)
  const unitPrice = roundMoney(line.basePrice + addons + setDrinkExtra(line.setDrink) + setAddonExtra(line.setAddon))
  return {
    unitPrice,
    lineTotal: roundMoney(unitPrice * line.quantity),
    qualifiesMeal: isMealCategory(line.categoryId),
    quantity: line.quantity,
  }
}

/* ─── Customer-facing DISPLAY prices ───
 * For delivery, the customer sees qualifying items with the +₪4/unit already included
 * ("inclusive" prices) and only the fixed fee as a separate line. This is presentation only:
 * internally (server, DB, kitchen) the breakdown stays subtotal + mealSurcharge + deliveryFee.
 * Invariant: displayItemsTotal + deliveryFee === computeOrderTotals(...).total
 */

/** Per-unit display add-on for a category under the given fulfillment type (₪4 or ₪0). */
export const displayUnitSurcharge = (categoryId: string, type: OrderType): number =>
  type === 'delivery' && isMealCategory(categoryId) ? DELIVERY_MEAL_SURCHARGE : 0

/** Menu card price for a plain item (no options). */
export const displayMenuPrice = (basePrice: number, categoryId: string, type: OrderType): number =>
  roundMoney(basePrice + displayUnitSurcharge(categoryId, type))

/** Customer-facing line total: authoritative line total + (₪4 × qty for qualifying delivery lines). */
export function displayLineTotal(line: PricingLineInput, type: OrderType): number {
  const priced = priceLine(line)
  return roundMoney(priced.lineTotal + displayUnitSurcharge(line.categoryId, type) * line.quantity)
}

export interface DisplayTotals {
  itemsTotal: number    // "מחיר המנות" — inclusive of the per-meal delivery surcharge
  deliveryFee: number   // shown separately (₪20 for delivery, 0 for pickup)
  total: number         // identical to the authoritative total
}

export function computeDisplayTotals(lines: PricingLineInput[], type: OrderType): DisplayTotals {
  const t = computeOrderTotals(lines, type)
  return { itemsTotal: roundMoney(t.subtotal + t.mealSurcharge), deliveryFee: t.deliveryFee, total: t.total }
}

/**
 * pickup:   total = subtotal
 * delivery: total = subtotal + mealQuantity × DELIVERY_MEAL_SURCHARGE + DELIVERY_FEE
 * Payment method never affects price. Discount is always 0.
 */
export function computeOrderTotals(lines: PricingLineInput[], type: OrderType): OrderTotals {
  const priced = lines.map(priceLine)
  const subtotal = roundMoney(priced.reduce((s, l) => s + l.lineTotal, 0))
  const mealQuantity = priced.reduce((s, l) => s + (l.qualifiesMeal ? l.quantity : 0), 0)
  const isDelivery = type === 'delivery'
  const mealSurcharge = isDelivery ? roundMoney(mealQuantity * DELIVERY_MEAL_SURCHARGE) : 0
  const deliveryFee = isDelivery ? DELIVERY_FEE : 0
  return {
    lines: priced,
    subtotal,
    mealQuantity,
    mealSurcharge,
    deliveryFee,
    discount: 0,
    total: roundMoney(subtotal + mealSurcharge + deliveryFee),
  }
}
