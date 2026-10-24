// Customer payment-status presentation (HYP-08). Pure: safe for client components. The seven states are the HYP-07
// public presentation of the HYP-05 states (GET /api/payments/intents/[token]); nothing here decides a payment.

export type HypPublicState = 'awaiting_payment' | 'processing' | 'confirmed' | 'failed' | 'in_review' | 'not_charged' | 'refunded'
export const HYP_PUBLIC_STATES: readonly HypPublicState[] = ['awaiting_payment', 'processing', 'confirmed', 'failed', 'in_review', 'not_charged', 'refunded']

export interface HypPublicOrder { orderNumber: number | null; dailyNumber: number | null; status: string | null; trackingId: string }
export interface HypPublicStatus { state: HypPublicState; order?: HypPublicOrder }

export interface HypStateView {
  title: string
  body: string
  tone: 'info' | 'success' | 'error' | 'warning'
  terminal: boolean        // no more polling
  offerNewOrder: boolean   // only when it is certain that nothing was charged — never for an ambiguous outcome
}

export const STATE_VIEW: Readonly<Record<HypPublicState, HypStateView>> = Object.freeze({
  awaiting_payment: { title: 'ממתינים לתשלום', tone: 'info', terminal: false, offerNewOrder: false,
    body: 'התשלום עדיין לא הושלם בדף התשלום המאובטח. אם כבר שילמתם — אין צורך לשלם שוב, המסך יתעדכן לבד.' },
  processing: { title: 'מאמתים את התשלום…', tone: 'info', terminal: false, offerNewOrder: false,
    body: 'קיבלנו את החזרה מדף התשלום ואנחנו מאמתים אותה מול חברת הסליקה. אין לסגור את המסך ואין לשלם שוב.' },
  confirmed: { title: 'התשלום אושר וההזמנה התקבלה!', tone: 'success', terminal: true, offerNewOrder: false,
    body: 'ההזמנה הועברה למטבח. אפשר לעקוב אחרי ההכנה.' },
  failed: { title: 'התשלום לא הושלם', tone: 'error', terminal: true, offerNewOrder: true,
    body: 'לא בוצע חיוב והזמנה לא נוצרה. אפשר לחזור ולנסות שוב או לבחור אמצעי תשלום אחר.' },
  in_review: { title: 'התשלום בבדיקה', tone: 'warning', terminal: false, offerNewOrder: false,
    body: 'אנחנו בודקים את התשלום מול חברת הסליקה. כדי למנוע חיוב כפול אין לבצע תשלום נוסף — הסניף ייצור קשר במידת הצורך.' },
  not_charged: { title: 'לא בוצע חיוב', tone: 'info', terminal: true, offerNewOrder: true,
    body: 'בדקנו ונמצא שלא בוצע חיוב עבור ניסיון התשלום הזה. אפשר להזמין מחדש.' },
  refunded: { title: 'התשלום בוטל או הוחזר', tone: 'info', terminal: true, offerNewOrder: false,
    body: 'החיוב בוטל או זוכה. לשאלות אפשר לפנות לסניף.' },
})

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const intOrNull = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) ? v : null)

/** Validates the public status response; anything unexpected → null (shown as a temporary error, polling continues). */
export function parsePublicStatus(json: unknown): HypPublicStatus | null {
  if (typeof json !== 'object' || json === null) return null
  const { state, order } = json as { state?: unknown; order?: unknown }
  if (typeof state !== 'string' || !HYP_PUBLIC_STATES.includes(state as HypPublicState)) return null
  if (state !== 'confirmed') return { state: state as HypPublicState }
  if (typeof order !== 'object' || order === null) return { state: 'in_review' }
  const o = order as Record<string, unknown>
  if (typeof o.trackingId !== 'string' || !UUID_RE.test(o.trackingId)) return { state: 'in_review' }
  return { state: 'confirmed', order: { orderNumber: intOrNull(o.orderNumber), dailyNumber: intOrNull(o.dailyNumber),
                                        status: typeof o.status === 'string' ? o.status : null, trackingId: o.trackingId } }
}

/** Bounded polling: fast at first, slower later, and it always stops (refresh shows the latest state again). */
export const HYP_POLL_LIMIT_MS = 15 * 60_000
export function nextPollDelayMs(state: HypPublicState | null, elapsedMs: number): number | null {
  if (elapsedMs >= HYP_POLL_LIMIT_MS) return null
  if (state === null) return 10_000                        // temporary error: retry, still bounded
  if (STATE_VIEW[state].terminal) return null
  if (state === 'in_review') return 30_000
  return elapsedMs < 2 * 60_000 ? 3_000 : 10_000
}

/** The existing tracking screen (app/order) restores from this localStorage session; only the order capability. */
export function trackingSessionFor(order: HypPublicOrder, branchId: string, now: number) {
  return {
    orderId: order.trackingId, branchId, expires: now + 6 * 3600 * 1000,
    orderPaymentMethod: 'תשלום מאובטח בכרטיס אשראי',
    ...(typeof order.dailyNumber === 'number' ? { orderDailyNumber: order.dailyNumber } : {}),
  }
}
