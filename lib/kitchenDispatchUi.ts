// Kitchen dispatch DISPLAY helpers (S4-INTEGRATIONS-03M). Pure, no imports with runtime code, safe for client
// components. Nothing here decides a dispatch: the server re-checks every gate on POST /api/kitchen/orders/[id]/dispatch.
// The constants mirror server values (asserted equal in scripts/verify-kitchen-dispatch-ui.mjs) because the server
// modules cannot be bundled into the browser.

import type { KitchenAutoDispatch, KitchenAutoDispatchState, KitchenDispatch, KitchenDispatchView, KitchenOrder } from './kitchenTypes'

/* ─── Mirrored server constants ─── */

/** Kitchen statuses from which staff may request a courier ('ready' deliberately excluded). */
export const UI_DISPATCH_STATUSES: readonly string[] = ['confirmed', 'preparing']
/** A 'sending' row older than this is presumed abandoned → manual check (never retried from the kitchen). */
export const UI_SENDING_STALE_MS = 5 * 60 * 1000
/** Cash food cap (₪600). Above it the order is arranged by phone. */
export const UI_CASH_FOOD_CAP_AGOROT = 60_000
/** Settlements that always need a manual decision (Kfar Adumim ↔ Nofei Prat cannot be told apart from verified data). */
export const UI_MANUAL_SETTLEMENTS: readonly string[] = ['כפר אדומים', 'נופי פרת']
/** Parcel statuses that do not block a food-only dispatch. */
const PARCEL_OK = (status: string | null | undefined) => status === undefined || status === null || status === 'cancelled'

/* ─── Read model → view ─── */

const RATE_LIMITED_CODE = /^rate_limited(?:_after_(\d{1,5}))?$/

/** Same mapping as the server's dispatch view, plus: a 'sending' row older than UI_SENDING_STALE_MS → manual check. */
export function kitchenDispatchView(
  row: { status: string | null; error_code: string | null; last_attempt_at?: string | null } | null, nowMs: number,
): KitchenDispatchView {
  if (!row || row.status === 'pending') return 'not_dispatched'
  if (row.status === 'sent') return 'sent'
  if (row.status === 'sending') {
    const at = row.last_attempt_at ? Date.parse(row.last_attempt_at) : NaN
    return Number.isFinite(at) && nowMs - at <= UI_SENDING_STALE_MS ? 'in_progress' : 'needs_manual_check'
  }
  if (row.status === 'failed_retryable') return RATE_LIMITED_CODE.test(row.error_code ?? '') ? 'rate_limited_manual_check' : 'needs_manual_check'
  if (row.status === 'failed_final') return row.error_code === 'unexpected_quote_response' ? 'needs_manual_check' : 'failed'
  return 'needs_manual_check' // unknown status: fail closed
}

export const DISPATCH_VIEW_LABELS: Record<KitchenDispatchView, string> = {
  not_dispatched: 'טרם הוזמן שליח',
  in_progress: 'בקשת שליח בתהליך…',
  sent: '✓ הוזמן שליח ממעלה אקספרס',
  rate_limited_manual_check: 'מעלה אקספרס עמוסה — נדרשת בדיקה ידנית',
  needs_manual_check: 'נדרשת בדיקה ידנית מול מעלה אקספרס',
  failed: 'הזמנת השליח נדחתה — יש להזמין ידנית',
}

/** Views after which the kitchen must not send another request (only 'not_dispatched' allows one). */
export const isDispatchFinalView = (view: KitchenDispatchView) => view !== 'not_dispatched'
/** Views where a courier may already be on the way (cancellation must be coordinated with the provider). */
export const isPossiblyDispatchedView = (view: KitchenDispatchView) =>
  view === 'sent' || view === 'in_progress' || view === 'needs_manual_check' || view === 'rate_limited_manual_check'

/* ─── Indicative eligibility (display only) ─── */

type DispatchOrder = Pick<KitchenOrder, 'type' | 'status' | 'paymentMethod' | 'totalPrice' | 'delivery' | 'parcel'> & {
  dispatch?: KitchenDispatch | null
  /** S4-04D: a recorded manual courier hides the in-app request (avoids a second courier). */
  reconciliation?: { summary: { manualCourier: boolean; reviewOpen?: boolean } } | null
  /** S4-MAALE-03: while the automatic request owns the order, the manual button is hidden. */
  autoDispatch?: KitchenAutoDispatch | null
}

/** Settlement = prefix of the stored address ("city, street N"). */
export const addressSettlement = (address: string): string => address.split(',')[0].trim()

/** Fee the staff confirms, in agorot (the server rejects the request if the stored fee changed since). */
export const expectedFeeAgorot = (order: Pick<KitchenOrder, 'delivery'>): number | null =>
  order.delivery && Number.isFinite(order.delivery.deliveryFee) ? Math.round(order.delivery.deliveryFee * 100) : null

export type DispatchHint = { canRequest: true } | { canRequest: false; reason: string }

/** Whether to offer the button, and if not, why (Hebrew). Coordinates are not visible here — the server checks them. */
export function dispatchHint(order: DispatchOrder): DispatchHint {
  const no = (reason: string): DispatchHint => ({ canRequest: false, reason })
  if (order.type !== 'delivery' || !order.delivery) return no('לא הזמנת משלוח')
  const view = order.dispatch?.view ?? 'not_dispatched'
  if (isDispatchFinalView(view)) return no(DISPATCH_VIEW_LABELS[view])
  if (order.reconciliation?.summary.manualCourier) return no('נרשם ששליח הוזמן מחוץ למערכת — אין להזמין שליח נוסף')
  if (order.reconciliation?.summary.reviewOpen) return no('בירור ידני פתוח — אין להזמין שליח עד לסגירתו')
  if (!UI_DISPATCH_STATUSES.includes(order.status)) return no('ניתן להזמין שליח רק להזמנה שאושרה או בהכנה')
  if (order.paymentMethod !== 'cash') return no('תשלום באשראי — יש להזמין שליח ידנית')
  if (!PARCEL_OK(order.parcel?.status)) return no('יש חבילה בהזמנה — יש להזמין שליח ידנית')
  if (UI_MANUAL_SETTLEMENTS.includes(addressSettlement(order.delivery.address))) return no('כפר אדומים / נופי פרת — יש להזמין שליח ידנית')
  const fee = expectedFeeAgorot(order)
  if (fee === null) return no('דמי המשלוח חסרים — יש להזמין שליח ידנית')
  if (Math.round(order.totalPrice * 100) - fee > UI_CASH_FOOD_CAP_AGOROT) return no('סכום מזומן מעל ₪600 — יש לתאם טלפונית')
  return { canRequest: true }
}

const shekels = (n: number) => '₪' + (Number.isInteger(n) ? String(n) : n.toFixed(2))

/** Shown in the confirmation; staff must tick the acknowledgment before the final button is enabled (S4-03O).
 *  UI-only: it is NOT proof that no courier was booked by phone, and the server does not rely on it. */
export const MANUAL_COURIER_CHECK = 'יש לוודא שלא הוזמן כבר שליח טלפונית להזמנה זו.'
export const MANUAL_COURIER_ACK_LABEL = 'וידאתי שלא הוזמן שליח טלפונית להזמנה זו'

/** Staff confirmation before sending: address, stored fee, cash the courier collects (food + fee = order total). */
export function dispatchConfirmLines(order: DispatchOrder, num: string): string[] {
  return [
    'להזמין שליח ממעלה אקספרס להזמנה #' + num + '?',
    'כתובת: ' + (order.delivery?.address ?? ''),
    'דמי משלוח: ' + shekels(order.delivery?.deliveryFee ?? 0),
    'גבייה במזומן מהלקוח: ' + shekels(order.totalPrice),
    MANUAL_COURIER_CHECK,
  ]
}
export const dispatchConfirmText = (order: DispatchOrder, num: string): string => dispatchConfirmLines(order, num).join('\n')

/** The final confirmation is allowed only after an explicit acknowledgment (strictly `true`). */
export const canConfirmDispatch = (acknowledged: unknown): boolean => acknowledged === true

/** Synchronous single-flight guard (backed by a React ref in the page): a second call while one runs is dropped.
 *  Defence in depth only — the server's atomic claim is the real protection against duplicate dispatch. */
export async function runExclusive<T>(flag: { current: boolean }, fn: () => Promise<T>): Promise<T | undefined> {
  if (flag.current) return undefined
  flag.current = true
  try { return await fn() } finally { flag.current = false }
}

/* ─── Local notes / locks (per tablet; display convenience, never a server-side guarantee) ─── */

export type DispatchNote = { message: string; ok: boolean; locked: boolean }
export const DISPATCH_LOCKS_KEY = 'kitchen_dispatch_locks'
/** Garbage collection only. The board shows today's orders (Israel day), so an entry this old can never belong to an
 *  order that is still displayed — retention never re-enables a button (S4-03O). */
export const DISPATCH_LOCK_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/** Stored JSON → locked notes. Malformed content is ignored. */
export function parseDispatchLocks(raw: string | null, nowMs: number): Record<string, DispatchNote> {
  let data: unknown
  try { data = JSON.parse(raw ?? '{}') } catch { return {} }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return {}
  const out: Record<string, DispatchNote> = {}
  for (const [id, v] of Object.entries(data as Record<string, { message?: unknown; at?: unknown }>))
    if (typeof v?.message === 'string' && typeof v.at === 'number' && nowMs - v.at < DISPATCH_LOCK_RETENTION_MS)
      out[id] = { message: v.message, ok: false, locked: true }
  return out
}

/** Locked notes → stored JSON (keeps each entry's first lock time). */
export function serializeDispatchLocks(notes: Record<string, DispatchNote>, prevRaw: string | null, nowMs: number): string {
  let prev: Record<string, { at?: unknown }> = {}
  try { const p = JSON.parse(prevRaw ?? '{}'); if (typeof p === 'object' && p !== null && !Array.isArray(p)) prev = p } catch {}
  const out: Record<string, { message: string; at: number }> = {}
  for (const [id, n] of Object.entries(notes)) if (n.locked) {
    const at = prev[id]?.at
    out[id] = { message: n.message, at: typeof at === 'number' ? at : nowMs }
  }
  return JSON.stringify(out)
}

/** The server's confirmed 'sent' overrides a stale local lock; anything else keeps the lock (fail closed). */
export function effectiveDispatchNote(view: KitchenDispatchView, note: DispatchNote | undefined): DispatchNote | undefined {
  return view === 'sent' && note?.locked ? undefined : note
}

/** Drops local locks of orders the server now shows as 'sent'. Returns the same object when nothing changes. */
export function reconcileDispatchNotes(
  notes: Record<string, DispatchNote>, orders: readonly { id: string; dispatch?: KitchenDispatch | null }[],
): Record<string, DispatchNote> {
  let next: Record<string, DispatchNote> | null = null
  for (const o of orders)
    if (o.dispatch?.view === 'sent' && notes[o.id]?.locked) { next ??= { ...notes }; delete next[o.id] }
  return next ?? notes
}

/** Whether the panel offers the button: server shows nothing attempted, indicative gates pass, no local lock, and no
 *  automatic request owns the order (S4-MAALE-03: the button is for exceptions — manual / skipped tasks — only). */
export const isDispatchButtonVisible = (order: DispatchOrder, note: DispatchNote | undefined): boolean =>
  (order.dispatch?.view ?? 'not_dispatched') === 'not_dispatched' && dispatchHint(order).canRequest && note?.locked !== true
  && !isAutoDispatchOwning(order.autoDispatch)

/* ─── S4-MAALE-03 automatic courier request ─── */

export const AUTO_DISPATCH_LABELS: Record<KitchenAutoDispatchState, string> = {
  queued: 'שליח יוזמן אוטומטית…',
  processing: 'בקשת שליח אוטומטית בתהליך…',
  dispatched: 'השליח הוזמן אוטומטית ✓',
  manual: 'לא הוזמן אוטומטית — יש להזמין שליח ידנית',
  investigate: 'נדרשת בדיקה מול מעלה אקספרס — אין להזמין שליח נוסף לפני בירור',
  skipped: 'לא הוזמן שליח אוטומטית',
}
const AUTO_REASON_TEXT: Record<string, string> = {
  credit_dispatch_disabled: 'תשלום באשראי', payment_not_verified: 'התשלום המקוון לא אומת', location_manual_review: 'כפר אדומים / נופי פרת', invalid_payload: 'פרטי הכתובת או הסכום אינם תקינים',
  parcel_unresolved: 'החבילה לא אותרה', parcel_manual_dispatch_required: 'יש חבילה בהזמנה', manual_courier_recorded: 'נרשם שליח שהוזמן ידנית',
  manual_review_open: 'בירור ידני פתוח', retries_exhausted: 'מעלה אקספרס לא זמינה כרגע', stale: 'עבר זמן רב מאישור ההזמנה',
  fee_mismatch: 'דמי המשלוח אינם תואמים להצעת הספק', quote_fee_missing: 'הספק לא החזיר דמי משלוח', quote_amount_mismatch: 'הסכומים אינם תואמים להצעת הספק',
  quote_warnings: 'הספק החזיר אזהרה', provider_auth_stopped: 'בעיית הרשאה מול הספק', auth_stop_active: 'בעיית הרשאה מול הספק',
  maale_disabled: 'החיבור למעלה אקספרס כבוי', maale_not_configured: 'החיבור למעלה אקספרס אינו מוגדר', not_delivery: 'אין פרטי משלוח',
  order_status: 'ההזמנה אינה במצב מאושר', out_of_area: 'מחוץ לאזור השירות של הספק', dispatch_closed: 'הספק אינו מקבל הזמנות כרגע',
}
/** queued / processing / dispatched / investigate: the automatic request owns the order — never a second courier. */
export const isAutoDispatchOwning = (a: KitchenAutoDispatch | null | undefined): boolean =>
  !!a && (a.state === 'queued' || a.state === 'processing' || a.state === 'dispatched' || a.state === 'investigate')
/** One display line for the order card, or null when there is no automatic task. */
export function autoDispatchLine(a: KitchenAutoDispatch | null | undefined): { text: string; tone: 'info' | 'ok' | 'warn' | 'alert' } | null {
  if (!a) return null
  const why = a.reason && AUTO_REASON_TEXT[a.reason] ? ` (${AUTO_REASON_TEXT[a.reason]})` : ''
  const tone = a.state === 'dispatched' ? 'ok' : a.state === 'investigate' ? 'alert' : a.state === 'manual' || a.state === 'skipped' ? 'warn' : 'info'
  return { text: AUTO_DISPATCH_LABELS[a.state] + (a.state === 'manual' || a.state === 'skipped' || a.state === 'investigate' ? why : ''), tone }
}
/** The dashboard asks the server to process due tasks only while one of its orders still waits for the worker — or
 *  (S4-MAALE-02) while a confirmed / preparing delivery order has neither a task nor a courier record yet (the enqueue
 *  failed; the sweep's repair re-creates the task). autoDispatch === null only when the feature is on (key absent off). */
export const needsAutoDispatchSweep = (orders: readonly { type?: string; status?: string; dispatch?: unknown; autoDispatch?: KitchenAutoDispatch | null }[]): boolean =>
  orders.some(o => o.autoDispatch?.state === 'queued' || o.autoDispatch?.state === 'processing'
    || (o.autoDispatch === null && o.type === 'delivery' && (o.status === 'confirmed' || o.status === 'preparing') && !o.dispatch))
export const AUTO_DISPATCH_SWEEP_MS = 60_000

/* ─── Server response → Hebrew ─── */

export const DISPATCH_MESSAGES: Record<string, string> = {
  dispatched: 'השליח הוזמן בהצלחה',
  already_dispatched: 'השליח כבר הוזמן להזמנה זו',
  dispatch_in_progress: 'בקשת שליח כבר בתהליך — המתינו ורעננו',
  not_eligible: 'לא ניתן להזמין שליח אוטומטית להזמנה זו — יש להזמין ידנית',
  stale_confirmation: 'פרטי ההזמנה השתנו — הרשימה רועננה, בדקו שוב ואשרו מחדש',
  quote_mismatch: 'מעלה אקספרס החזירה מחיר שונה — לא נשלח שליח. יש להזמין ידנית',
  manual_review_required: 'נדרשת בדיקה ידנית מול מעלה אקספרס — אין לנסות שוב מהמערכת',
  rate_limited: 'מעלה אקספרס עמוסה — לא ברור אם הבקשה התקבלה. יש לבדוק מולם טלפונית',
  provider_auth_failed: 'שגיאת הרשאה מול מעלה אקספרס — הזמנת שליחים מושהית. יש להזמין ידנית ולעדכן מנהל',
  provider_auth_stopped: 'הזמנת שליחים מושהית זמנית עקב שגיאת הרשאה — יש להזמין ידנית',
  provider_blocked: 'מעלה אקספרס חסמה את הבקשה — יש להזמין ידנית',
  provider_conflict: 'מעלה אקספרס דיווחה על התנגשות בבקשה — יש לבדוק מולם טלפונית',
  provider_rejected: 'מעלה אקספרס דחתה את הבקשה — יש להזמין ידנית',
  outcome_unknown: 'לא ידוע אם השליח הוזמן. אין לנסות שוב — יש ליצור קשר עם מעלה אקספרס',
  state_not_recorded: 'ייתכן שהשליח הוזמן אך הדבר לא נשמר במערכת. אין לנסות שוב — יש ליצור קשר עם מעלה אקספרס',
  dispatch_failed_previously: 'בקשה קודמת להזמנה זו נכשלה — יש להזמין ידנית',
  dispatch_unavailable: 'הזמנת שליח אוטומטית אינה זמינה כרגע — יש להזמין ידנית',
  not_found: 'ההזמנה לא נמצאה — הרשימה רועננה',
  invalid_request: 'הבקשה לא תקינה — רעננו ונסו שוב',
  forbidden: 'אין הרשאה לפעולה זו',
  // S4-04B local quote rate limit: decided before any provider call → nothing was sent; NOT a locking code.
  rate_limited_local: 'יותר מדי בקשות שליח בזמן קצר — לא נשלחה בקשה. המתינו מספר דקות ונסו שוב, או הזמינו ידנית',
  rate_limit_unavailable: 'בדיקת עומס הבקשות אינה זמינה כרגע — לא נשלחה בקשה. נסו שוב מאוחר יותר או הזמינו ידנית',
  rate_limit_rejected: 'לא ניתן לאמת את ההזמנה לבקשת שליח — לא נשלחה בקשה. רעננו את הרשימה',
  // S4-04D3: the reconciliation ledger could not be read — nothing was sent; NOT a locking code.
  reconciliation_unavailable: 'לא ניתן לבדוק את רישומי ההתאמה כרגע — לא נשלחה בקשה. נסו שוב מאוחר יותר או הזמינו ידנית',
  server_error: 'שגיאת שרת — לא ברור אם השליח הוזמן. יש לבדוק מול מעלה אקספרס לפני ניסיון נוסף',
}

const NOT_ELIGIBLE_REASONS: Record<string, string> = {
  order_status: 'ניתן להזמין שליח רק להזמנה שאושרה או בהכנה',
  credit_not_supported: 'תשלום באשראי — יש להזמין שליח ידנית',
  payment_not_verified: 'התשלום המקוון לא אומת — אין להזמין שליח לפני בירור התשלום',
  parcel_unresolved: 'יש לטפל בחבילה לפני הזמנת שליח',
  parcel_manual_dispatch_required: 'יש חבילה בהזמנה — יש להזמין שליח ידנית',
  cash_amount_too_high: 'סכום מזומן מעל ₪600 — יש לתאם טלפונית',
  location_unverified: 'מיקום הכתובת לא אומת — יש להזמין שליח ידנית',
  order_data_invalid: 'נתוני ההזמנה אינם תקינים למשלוח אוטומטי — יש להזמין ידנית',
  not_delivery: 'לא הזמנת משלוח',
  manual_courier_recorded: 'נרשם ששליח הוזמן מחוץ למערכת — אין להזמין שליח נוסף',
  manual_review_open: 'בירור ידני פתוח להזמנה זו — אין להזמין שליח עד לסגירתו',
}

/** Codes after which the kitchen must not try again for this order (the outcome at the provider may be unknown). */
export const LOCKING_CODES: readonly string[] = [
  'manual_review_required', 'outcome_unknown', 'state_not_recorded', 'rate_limited', 'provider_conflict', 'server_error', 'network_error',
]

export interface DispatchOutcome { ok: boolean; code: string; message: string; lock: boolean; refresh: boolean }

/** Interprets a dispatch response (status + parsed JSON, or null). Never echoes raw server text. */
export function interpretDispatchResponse(status: number, body: unknown): DispatchOutcome {
  const b = (typeof body === 'object' && body !== null ? body : {}) as { result?: unknown; error?: unknown; reason?: unknown }
  if (status === 200 && (b.result === 'dispatched' || b.result === 'already_dispatched'))
    return { ok: true, code: b.result, message: DISPATCH_MESSAGES[b.result], lock: false, refresh: true }
  const error = typeof b.error === 'string' && b.error in DISPATCH_MESSAGES ? b.error : 'server_error'
  const reason = typeof b.reason === 'string' ? b.reason : ''
  // Unknown provider outcomes surface as manual_review_required + a reason; show the specific warning.
  const code = error === 'manual_review_required' && (reason === 'outcome_unknown' || reason === 'state_not_recorded') ? reason : error
  const message = code === 'not_eligible' && NOT_ELIGIBLE_REASONS[reason] ? NOT_ELIGIBLE_REASONS[reason] : DISPATCH_MESSAGES[code]
  return { ok: false, code, message, lock: LOCKING_CODES.includes(code), refresh: true }
}

/** A request that never got an answer (network drop / timeout) may still have reached the provider. */
export const NETWORK_OUTCOME: DispatchOutcome = {
  ok: false, code: 'network_error', message: DISPATCH_MESSAGES.outcome_unknown, lock: true, refresh: true,
}

/* ─── Status-transition warnings ─── */

export const READY_WITHOUT_COURIER_WARNING = 'ההזמנה עדיין ללא שליח. להמשיך למצב מוכנה?'
export const CANCEL_AFTER_DISPATCH_WARNING = 'כבר הוזמן שליח. יש ליצור קשר עם מעלה אקספרס לביטול.'
export const CANCEL_MAYBE_DISPATCHED_WARNING = 'ייתכן שכבר הוזמן שליח. יש ליצור קשר עם מעלה אקספרס לפני הביטול.'

export const CANCEL_PHONE_NOTE = 'ביטול ההזמנה כאן אינו מבטל את השליח — ייתכן שמעלה אקספרס תדרוש שיחת טלפון נפרדת לביטולו.'

/** preparing → ready only when the app COULD have booked the courier and nothing was attempted (S4-03O):
 *  never for credit, active parcels, Kfar Adumim / Nofei Prat, the cash cap, failed / ambiguous / locked orders. */
export function needsReadyWarning(order: DispatchOrder & { status: string }, nextStatus: string, locked: boolean): boolean {
  return order.status === 'preparing' && nextStatus === 'ready' && !locked
    && (order.dispatch?.view ?? 'not_dispatched') === 'not_dispatched' && dispatchHint(order).canRequest
}

/** Warning text before cancelling an order whose courier may already be booked; null when none. Never cancels at the provider. */
export function cancelDispatchWarning(order: DispatchOrder, locked: boolean): string | null {
  if (order.type !== 'delivery') return null
  const view = order.dispatch?.view ?? 'not_dispatched'
  if (view === 'sent') return CANCEL_AFTER_DISPATCH_WARNING
  if (locked || isPossiblyDispatchedView(view)) return CANCEL_MAYBE_DISPATCHED_WARNING
  return null
}

/** ONE cancellation confirmation: the existing text, plus the courier notice when a dispatch exists or is uncertain. */
export function combinedCancelConfirmText(base: string, order: DispatchOrder, locked: boolean, dispatchEnabled: boolean): string {
  const warning = dispatchEnabled ? cancelDispatchWarning(order, locked) : null
  return warning ? `${base}\n\n⚠️ ${warning}\n${CANCEL_PHONE_NOTE}` : base
}
