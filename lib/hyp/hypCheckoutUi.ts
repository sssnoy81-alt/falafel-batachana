// Customer checkout helpers for the online-payment option (HYP-08). Pure: no env, no network, no window access
// (storage is injected). Safe to import from client components. Visibility here is presentation only — the server
// (POST /api/payments/hyp/start) re-checks the flag, branch, order type, prices and everything else.

import type { CreateOrderRequest } from '../orderRequest'
import type { OrderType } from '../orderConfig'

export const ONLINE_PAYMENT_LABEL = 'תשלום מאובטח בכרטיס אשראי'
export const HYP_PAYMENT_PAGE_ORIGIN = 'https://pay.hyp.co.il'
/** localStorage: the customer's open online payment (status token only, never order or payment data). */
export const HYP_PENDING_PAYMENT_KEY = 'falafel_hyp_payment'
/** sessionStorage: the idempotency key of the current checkout attempt, bound to the exact request content. */
export const HYP_CHECKOUT_KEY = 'falafel_hyp_checkout'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export interface HypCheckoutConfig {
  readonly branchIds: readonly string[]
  readonly orderTypes: readonly OrderType[]
}

/** GET /api/payments/config → config, or null (OFF) for anything but the exact expected shape. Delivery only when the
 *  server advertises it (HYP_DELIVERY_ENABLED, HYP-DELIVERY-02). */
export function parsePaymentsConfig(json: unknown): HypCheckoutConfig | null {
  if (typeof json !== 'object' || json === null) return null
  const h = (json as { hypPayments?: unknown }).hypPayments
  if (typeof h !== 'object' || h === null) return null
  const { branchIds, orderTypes } = h as { branchIds?: unknown; orderTypes?: unknown }
  if (!Array.isArray(branchIds) || !Array.isArray(orderTypes)) return null
  const branches = branchIds.filter((b): b is string => typeof b === 'string' && UUID_RE.test(b))
  const types = orderTypes.filter((t): t is OrderType => t === 'pickup' || t === 'delivery')
  return branches.length && types.length ? { branchIds: branches, orderTypes: types } : null
}

export function isOnlinePaymentAvailable(config: HypCheckoutConfig | null, branchId: string | null | undefined,
                                         orderType: OrderType | null, isParcelOrder: boolean): boolean {
  return !!config && !!branchId && !!orderType && (orderType === 'pickup' ? !isParcelOrder : orderType === 'delivery')
    && config.branchIds.includes(branchId) && config.orderTypes.includes(orderType)
}

/** HYP-DELIVERY-02: true when the server has retired telephone credit for new delivery orders (cash or HYP only) —
 *  advertised independently of HYP availability, so cash stays when HYP is down. Anything else → false (as before). */
export function parseDeliveryCreditRetired(json: unknown): boolean {
  return typeof json === 'object' && json !== null && (json as { deliveryCreditRetired?: unknown }).deliveryCreditRetired === true
}

/** The start body: the same order intent as POST /api/orders, without the payment method. Pickup: exactly the five
 *  fields as before; delivery (HYP-DELIVERY-02) adds the delivery address and, when attached, the parcel.
 *  S4-HYP-PREFILL-03: `names` (the separately entered first / last name; customerName = "<first> <last>") adds
 *  customerFirstName / customerLastName for the payment-page pre-fill. */
export function buildHypStartBody(request: CreateOrderRequest, checkoutKey: string, names?: { first: string; last: string }) {
  const { branchId, type, customerName, phone, items } = request
  const n = names ? { customerFirstName: names.first, customerLastName: names.last } : {}
  if (type !== 'delivery') return { checkoutKey, branchId, type, customerName, phone, items, ...n }
  return { checkoutKey, branchId, type, customerName, phone, items, ...n, delivery: request.delivery, ...(request.parcel ? { parcel: request.parcel } : {}) }
}

export interface KeyStorage { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

/** Same checkout content → same key (a retry or double click reuses the intent); any change → a new key. */
export function checkoutKeyFor(storage: KeyStorage | null, signature: string, newKey: () => string): string {
  try {
    const saved = storage ? JSON.parse(storage.getItem(HYP_CHECKOUT_KEY) ?? 'null') : null
    if (saved && saved.sig === signature && typeof saved.key === 'string' && UUID_RE.test(saved.key)) return saved.key
  } catch { /* corrupt entry → new key */ }
  const key = newKey()
  try { storage?.setItem(HYP_CHECKOUT_KEY, JSON.stringify({ sig: signature, key })) } catch { /* private mode: no reuse */ }
  return key
}

/** Only the documented Hyp Pay payment page may be navigated to; nothing that carries credentials. */
export function isSafeHypRedirect(url: unknown): url is string {
  if (typeof url !== 'string' || !url.startsWith(`${HYP_PAYMENT_PAGE_ORIGIN}/p/?`)) return false
  try {
    const u = new URL(url)
    return u.origin === HYP_PAYMENT_PAGE_ORIGIN && u.pathname === '/p/' && u.username === '' && u.password === ''
      && u.searchParams.get('action') === 'pay' && !u.searchParams.has('KEY') && !u.searchParams.has('PassP')
  } catch {
    return false
  }
}

export type HypStartOutcome =
  | { kind: 'redirect'; url: string; token: string }
  | { kind: 'status'; token: string }                       // an existing payment of this checkout → its status page
  | { kind: 'error'; message: string; disableOnline?: boolean; resetKey?: boolean }

export const HYP_START_MESSAGES = {
  generic: 'לא ניתן להתחיל את התשלום כרגע. אפשר לנסות שוב או לבחור אמצעי תשלום אחר.',
  disabled: 'התשלום המקוון אינו זמין כרגע. אפשר לבחור אמצעי תשלום אחר.',
  unavailable: 'שירות התשלום אינו זמין כרגע. אפשר לנסות שוב בעוד רגע או לבחור אמצעי תשלום אחר.',
  inProgress: 'כבר קיים תשלום פתוח עבור מספר הטלפון הזה. כדי למנוע חיוב כפול לא ניתן לפתוח תשלום נוסף — נא לפנות לסניף.',
  closed: 'המקום סגור כרגע — לא ניתן להזמין.',
  rateLimited: 'יותר מדי ניסיונות. נא להמתין דקה ולנסות שוב.',
  expired: 'פג תוקף ניסיון התשלום. נא ללחוץ שוב כדי להתחיל מחדש.',
  changed: 'ההזמנה השתנתה מאז ניסיון התשלום הקודם. נא ללחוץ שוב.',
} as const

export function interpretStartResponse(status: number, json: unknown): HypStartOutcome {
  const j = (typeof json === 'object' && json !== null ? json : {}) as { redirectUrl?: unknown; statusToken?: unknown; error?: unknown }
  const token = typeof j.statusToken === 'string' && UUID_RE.test(j.statusToken) ? j.statusToken : null
  if (status === 200) {
    return token && isSafeHypRedirect(j.redirectUrl) ? { kind: 'redirect', url: j.redirectUrl, token } : { kind: 'error', message: HYP_START_MESSAGES.generic }
  }
  switch (j.error) {
    case 'payments_disabled': return { kind: 'error', message: HYP_START_MESSAGES.disabled, disableOnline: true }
    case 'payment_in_progress': return token ? { kind: 'status', token } : { kind: 'error', message: HYP_START_MESSAGES.inProgress }
    case 'checkout_expired': return { kind: 'error', message: HYP_START_MESSAGES.expired, resetKey: true }
    case 'checkout_key_reused': return { kind: 'error', message: HYP_START_MESSAGES.changed, resetKey: true }
    case 'closed': return { kind: 'error', message: HYP_START_MESSAGES.closed }
    case 'rate_limited': return { kind: 'error', message: HYP_START_MESSAGES.rateLimited }
    case 'payments_unavailable': case 'payment_provider_unavailable': return { kind: 'error', message: HYP_START_MESSAGES.unavailable }
    case 'online_payment_branch_not_allowed': case 'online_payment_type_not_allowed':
      return { kind: 'error', message: HYP_START_MESSAGES.disabled, disableOnline: true }
    default: return { kind: 'error', message: HYP_START_MESSAGES.generic }
  }
}
