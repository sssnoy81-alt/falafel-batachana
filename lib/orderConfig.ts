// Central order / delivery configuration.
// IDs below are PRODUCTION database IDs (verified read-only). A separate staging DB would differ.
// Pure module: safe to import from both client components and server routes.

/* ─── Branches ─── */
export const DELIVERY_BRANCH_IDS: readonly string[] = [
  '8fed141d-0e7c-46c1-803b-88d3d811c1f8', // מישור אדומים
]

// Branches that exist in the DB but are not offered to customers.
export const CUSTOMER_HIDDEN_BRANCH_IDS: readonly string[] = [
  '3ab15ad1-e835-492b-bae5-11b202ee2314', // מעבר מכמש
]

export const isDeliveryBranch = (branchId: string | null | undefined): boolean =>
  !!branchId && DELIVERY_BRANCH_IDS.includes(branchId)

/* ─── Menu categories ─── */
// Explicit allowlist for the delivery meal surcharge. A new category never qualifies automatically.
export const MEAL_CATEGORY_IDS: readonly string[] = [
  '02e0f987-6cce-4a1d-85c6-5ff6f97c80a4', // פלאפל/סביח
  '82952bb4-b2b6-44a1-83e2-844ed6e3edd2', // בשרי
  'b5545b23-5582-4bbd-a0aa-b31db07993cf', // צלחות ("בצלחת")
  'b9f67c42-7ea8-4643-b70c-db49e9e23bc5', // עסקיות
  'a8407f94-c5b1-4adb-b452-5d60008fefad', // תוספות
]

export const DRINK_CATEGORY_IDS: readonly string[] = [
  'f70b04f0-c87d-496b-b044-857a477f441d', // שתייה — never surcharged
]

export const DEAL_CATEGORY_ID = 'b9f67c42-7ea8-4643-b70c-db49e9e23bc5'  // עסקיות
export const SIDES_CATEGORY_ID = 'a8407f94-c5b1-4adb-b452-5d60008fefad' // תוספות

export const isMealCategory = (categoryId: string | null | undefined): boolean =>
  !!categoryId && MEAL_CATEGORY_IDS.includes(categoryId)
export const isDrinkCategory = (categoryId: string | null | undefined): boolean =>
  !!categoryId && DRINK_CATEGORY_IDS.includes(categoryId)
export const isDealCategory = (categoryId: string | null | undefined): boolean =>
  categoryId === DEAL_CATEGORY_ID
export const isSidesCategory = (categoryId: string | null | undefined): boolean =>
  categoryId === SIDES_CATEGORY_ID

/* ─── Delivery ─── */
export const DELIVERY_AREAS: readonly string[] = [
  'מעלה אדומים',
  'מישור אדומים',
  'כפר אדומים',
  'נופי פרת',
  'אלון',
  'מצפה יריחו',
]

export const DELIVERY_FEE = 20            // ₪ per delivery order
export const DELIVERY_MEAL_SURCHARGE = 4  // ₪ per qualifying meal unit

// Must match the DB CHECK constraints on public.deliveries.
export const DELIVERY_FIELD_LIMITS = {
  city: 80,
  street: 120,
  houseNumber: 20,
  apartment: 20,
  floor: 20,
  entrance: 20,
  courierNotes: 300,
  address: 500,
} as const

/* ─── Order types ─── */
export const ORDER_TYPES = ['pickup', 'delivery'] as const
export type OrderType = (typeof ORDER_TYPES)[number]
export const ORDER_TYPE_LABELS: Record<OrderType, string> = {
  pickup: 'איסוף עצמי',
  delivery: 'משלוח',
}
export const isOrderType = (v: unknown): v is OrderType =>
  typeof v === 'string' && (ORDER_TYPES as readonly string[]).includes(v)

/* ─── Payment methods (no HYP-specific values yet) ─── */
export const PAYMENT_METHODS = ['cash', 'credit', 'cibus', 'bit'] as const
export type PaymentMethod = (typeof PAYMENT_METHODS)[number]
export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: '💵 מזומן',
  credit: '💳 אשראי',
  cibus: '🍽️ סיבוס',
  bit: '💙 ביט',
}
export const isPaymentMethod = (v: unknown): v is PaymentMethod =>
  typeof v === 'string' && (PAYMENT_METHODS as readonly string[]).includes(v)
// Plain-text label (no emoji) for exports; unknown/legacy values are shown as-is.
export function paymentMethodText(v: string | null | undefined): string {
  switch (v) {
    case 'cash': return 'מזומן'
    case 'credit': return 'אשראי'
    case 'cibus': return 'סיבוס'
    case 'bit': return 'ביט'
    default: return v || ''
  }
}

/* ─── Deal (עסקית) options ─── */
export const SET_DRINKS_FREE: readonly string[] = ['פחית קולה', 'פחית זירו', 'פחית ענבים', 'מים', 'סודה']
export const SET_DRINKS_PAID: readonly string[] = ['קולה זכוכית', 'זירו זכוכית', 'פיוז טי']
export const SET_DRINK_EXTRA = 3
export const SET_ADDON_FREE = 'ציפס אישי'
export const SET_ADDONS_PAID: readonly { name: string; price: number }[] = [
  { name: 'ציפס גדול', price: 7 },
  { name: 'טבעות בצל', price: 10 },
]

export const isValidSetDrink = (name: string): boolean =>
  SET_DRINKS_FREE.includes(name) || SET_DRINKS_PAID.includes(name)
export const isValidSetAddon = (name: string): boolean =>
  name === SET_ADDON_FREE || SET_ADDONS_PAID.some(a => a.name === name)
export const setDrinkExtra = (name: string | null | undefined): number =>
  name && SET_DRINKS_PAID.includes(name) ? SET_DRINK_EXTRA : 0
export const setAddonExtra = (name: string | null | undefined): number =>
  (name && SET_ADDONS_PAID.find(a => a.name === name)?.price) || 0

/* ─── Topping availability rules (mirror of the existing menu UI rules) ─── */
export type ToppingType = 'spread' | 'filling' | 'paid_addon'

export interface ToppingRuleItem {
  category_id: string
  has_lettuce?: boolean | null
  has_pita?: boolean | null
  has_egg?: boolean | null
}

const LEMON_EXCLUDED_BRANCH_IDS: readonly string[] = ['3ab15ad1-e835-492b-bae5-11b202ee2314']

/** Whether a topping of the given type/name may be chosen for this item (same rules the menu sheet shows). */
export function isToppingAllowedForItem(
  topping: { type: ToppingType; name_he: string },
  item: ToppingRuleItem,
  branchId: string | null | undefined,
): boolean {
  const drink = isDrinkCategory(item.category_id)
  const sides = isSidesCategory(item.category_id)
  if (topping.type === 'spread') return !drink
  if (topping.type === 'filling') {
    if (drink || sides) return false
    if (topping.name_he === 'חסה' && !item.has_lettuce) return false
    if (topping.name_he === 'לימון כבוש' && !!branchId && LEMON_EXCLUDED_BRANCH_IDS.includes(branchId)) return false
    return true
  }
  // paid_addon
  if (drink || sides) return false
  if (topping.name_he === 'פיתה' && !item.has_pita) return false
  if (topping.name_he === 'ביצה קשה' && item.has_egg === false) return false
  return true
}

/* ─── Limits ─── */
export const MAX_LINE_QUANTITY = 20
export const MAX_CART_LINES = 50
export const MAX_ITEM_NOTES = 200
export const MAX_CUSTOMER_NAME = 60
export const PHONE_REGEX = /^05\d{8}$/
export const normalizePhone = (p: string): string => p.replace(/[-\s]/g, '')
