// Courier reconciliation rules + display helpers (S4-INTEGRATIONS-04D2). Pure, type-only imports, safe for client
// components AND the server (single source of the event rules, mirroring the CHECK constraints of
// db/migrations/s4_04d_maale_dispatch_reconciliations.sql — asserted equal in scripts/verify-kitchen-reconciliation.mjs).
// A reconciliation record is what a kitchen ACCOUNT reported (usually after a phone call with Maale Express); it is NOT
// a live or verified provider status, and it never changes the dispatch record.

import type {
  KitchenReconciliationEvent, KitchenReconciliationEventType, KitchenReconciliationSummary,
} from './kitchenTypes'

export const RECONCILIATION_EVENT_TYPES: readonly KitchenReconciliationEventType[] = [
  'confirmed_sent', 'cancelled_at_provider', 'not_received', 'manual_courier',
  'provider_status_checked', 'manual_review_opened', 'manual_review_resolved',
]
export const RECONCILIATION_REASON_CODES: readonly string[] = [
  'provider_phone_confirmed', 'provider_dashboard_confirmed', 'customer_cancelled', 'kitchen_cancelled',
  'outcome_unknown', 'persistence_failed', 'duplicate_suspected', 'courier_booked_by_phone', 'other',
]
export const PROVIDER_ORDER_ID_RULE = /^[A-Za-z0-9_-]{1,100}$/
/** S4-04D3 idempotency key: a lower-case RFC 4122 UUID (crypto.randomUUID()), one per user-confirmed action. */
export const REQUEST_ID_RULE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
export const PROVIDER_STATUS_RULE = /^[a-z_]{1,40}$/
/** The provider confirmed something about ITS order → its order number is required. */
export const EVENTS_REQUIRING_PROVIDER_ID: readonly string[] = ['confirmed_sent', 'cancelled_at_provider']
/** The provider never had an order (or it was arranged outside the app) → no provider order number. */
export const EVENTS_FORBIDDING_PROVIDER_ID: readonly string[] = ['not_received', 'manual_courier']
/** Events about a submission made through the application → a dispatch record must exist. */
export const EVENTS_REQUIRING_DISPATCH: readonly string[] = ['confirmed_sent', 'cancelled_at_provider', 'not_received', 'provider_status_checked']

export const isReconciliationEventType = (v: unknown): v is KitchenReconciliationEventType =>
  typeof v === 'string' && (RECONCILIATION_EVENT_TYPES as readonly string[]).includes(v)

export interface ReconciliationInput {
  eventType: string
  providerOrderId: string | null
  providerStatus: string | null
  reasonCode: string | null
  confirmCancellation: boolean
}

/** Shape rules shared by the form and the server (the database enforces the same rules again). */
export function validateReconciliationInput(i: ReconciliationInput): { ok: true } | { ok: false; code: string } {
  const no = (code: string) => ({ ok: false as const, code })
  if (!isReconciliationEventType(i.eventType)) return no('invalid_event_type')
  if (i.providerOrderId !== null && !PROVIDER_ORDER_ID_RULE.test(i.providerOrderId)) return no('invalid_provider_order_id')
  if (EVENTS_REQUIRING_PROVIDER_ID.includes(i.eventType) && i.providerOrderId === null) return no('provider_order_id_required')
  if (EVENTS_FORBIDDING_PROVIDER_ID.includes(i.eventType) && i.providerOrderId !== null) return no('provider_order_id_forbidden')
  if (i.providerStatus !== null && !PROVIDER_STATUS_RULE.test(i.providerStatus)) return no('invalid_provider_status')
  if (i.eventType === 'provider_status_checked' && i.providerStatus === null) return no('provider_status_required')
  if (i.eventType !== 'provider_status_checked' && i.providerStatus !== null) return no('provider_status_forbidden')
  if (i.reasonCode !== null && !RECONCILIATION_REASON_CODES.includes(i.reasonCode)) return no('invalid_reason_code')
  if (i.eventType === 'cancelled_at_provider' && i.confirmCancellation !== true) return no('confirmation_required')
  return { ok: true }
}

/* ─── Read model ─── */

/** Newest first; identical timestamps are ordered by id so the history is stable (the summary never depends on it). */
export const sortEventsNewestFirst = (events: readonly KitchenReconciliationEvent[]): KitchenReconciliationEvent[] =>
  [...events].sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : a.createdAt < b.createdAt ? 1 : -1))

/** Derived from ALL events, not the latest one: e.g. confirmed_sent → cancelled_at_provider → manual_review_resolved
 *  keeps "cancelled at provider (reported)" AND shows the review as resolved. */
export function summarizeReconciliation(events: readonly KitchenReconciliationEvent[]): KitchenReconciliationSummary {
  const has = (t: KitchenReconciliationEventType) => events.some(e => e.eventType === t)
  const opened = events.filter(e => e.eventType === 'manual_review_opened').length
  const resolved = events.filter(e => e.eventType === 'manual_review_resolved').length
  const lastCheck = sortEventsNewestFirst(events).find(e => e.eventType === 'provider_status_checked' && e.providerStatus)
  return {
    confirmedSent: has('confirmed_sent'),
    cancelledAtProvider: has('cancelled_at_provider'),
    notReceived: has('not_received'),
    manualCourier: has('manual_courier'),
    reviewOpen: opened > resolved,
    reviewResolved: resolved > 0 && opened <= resolved,
    lastCheckedProviderStatus: lastCheck?.providerStatus ?? null,
  }
}

/* ─── Dispatch eligibility (S4-04D3) ─── */

export type DispatchBlockReason = 'manual_courier_recorded' | 'manual_review_open'

/**
 * Records that BLOCK a new in-app courier request (server gate in the kitchen dispatch path + the UI hint):
 *   manual_courier recorded → a courier was arranged outside the app (never book a second one);
 *   more review "opened" than "resolved" → someone is investigating this order.
 * Nothing ever UNLOCKS dispatch: cancelled_at_provider / not_received / confirmed_sent never make an order eligible
 * again — the dispatch record (one per order, never reset) stays authoritative.
 */
export function dispatchBlockReason(eventTypes: readonly unknown[]): DispatchBlockReason | null {
  if (eventTypes.includes('manual_courier')) return 'manual_courier_recorded'
  const opened = eventTypes.filter(t => t === 'manual_review_opened').length
  const resolved = eventTypes.filter(t => t === 'manual_review_resolved').length
  return opened > resolved ? 'manual_review_open' : null
}

/* ─── Hebrew labels ─── */

export const RECONCILIATION_EVENT_LABELS: Record<KitchenReconciliationEventType, string> = {
  confirmed_sent: 'מעלה אקספרס אישרה קבלת ההזמנה',
  cancelled_at_provider: 'מעלה אקספרס אישרה ביטול השליח',
  not_received: 'מעלה אקספרס: אין אצלם הזמנה כזו',
  manual_courier: 'הוזמן שליח מחוץ למערכת',
  provider_status_checked: 'נבדק סטטוס אצל מעלה אקספרס',
  manual_review_opened: 'נפתח בירור ידני',
  manual_review_resolved: 'הבירור הידני נסגר',
}
export const RECONCILIATION_REASON_LABELS: Record<string, string> = {
  provider_phone_confirmed: 'אישור טלפוני ממעלה',
  provider_dashboard_confirmed: 'אישור בלוח הבקרה של מעלה',
  customer_cancelled: 'הלקוח ביטל',
  kitchen_cancelled: 'המטבח ביטל',
  outcome_unknown: 'תוצאה לא ידועה',
  persistence_failed: 'המערכת לא שמרה את התוצאה',
  duplicate_suspected: 'חשד לכפילות',
  courier_booked_by_phone: 'שליח הוזמן טלפונית',
  other: 'אחר',
}
export const CANCELLATION_RECORD_WARNING =
  'רישום זה אינו מבטל את השליח. יש לבטל קודם בטלפון מול מעלה אקספרס, ולרשום רק לאחר אישור מפורש מהם.'
export const CANCELLATION_CONFIRM_LABEL = 'קיבלתי אישור מפורש ממעלה אקספרס שהשליח בוטל'
export const REPORTED_NOT_VERIFIED_NOTE = 'רישום צוות — לא סטטוס חי או מאומת מהספק'

export const RECONCILIATION_MESSAGES: Record<string, string> = {
  recorded: 'הרישום נשמר',
  already_recorded: 'הפעולה הזו כבר נשמרה — לא נוסף רישום כפול',
  request_id_conflict: 'מזהה הפעולה כבר שימש לרישום אחר — לא נשמר דבר. רעננו והתחילו רישום חדש',
  not_found: 'ההזמנה לא נמצאה',
  invalid_request: 'הנתונים אינם תקינים — בדקו את השדות',
  not_delivery: 'רישום התאמה אפשרי רק להזמנת משלוח',
  no_dispatch_record: 'אין בקשת שליח במערכת להזמנה זו — לשליח שהוזמן מחוץ למערכת בחרו „הוזמן שליח מחוץ למערכת”',
  no_dispatch_attempt: 'בקשת השליח לא נשלחה מעולם — לא ניתן לרשום אירוע של הספק',
  provider_order_mismatch: 'מספר ההזמנה של הספק אינו תואם למספר השמור במערכת — לא נשמר דבר',
  // S4-04E2: refused atomically by the database (a Maale request is or may be live) — nothing stored
  dispatch_active: 'בקשת שליח של מעלה אקספרס כבר נשלחה או בשליחה — לא נרשם שליח חיצוני. בדקו מול הספק לפני הזמנת שליח נוסף',
  dispatch_outcome_unknown: 'תוצאת בקשת השליח הקודמת אינה ידועה — לא נרשם שליח חיצוני. בררו מול הספק ופתחו בירור ידני',
  reconciliation_unavailable: 'רישום התאמה אינו זמין כרגע — לא נשמר דבר',
  server_error: 'שגיאת שרת — לא ברור אם הרישום נשמר. רעננו ובדקו את ההיסטוריה לפני רישום חוזר',
  network_error: 'אין תשובה מהשרת — לא ברור אם הרישום נשמר. רעננו ובדקו את ההיסטוריה לפני רישום חוזר',
}
export const reconciliationMessage = (status: number, body: unknown): { ok: boolean; message: string } => {
  const b = (typeof body === 'object' && body !== null ? body : {}) as { result?: unknown; error?: unknown }
  if ((status === 201 && b.result === 'recorded') || (status === 200 && b.result === 'already_recorded'))
    return { ok: true, message: RECONCILIATION_MESSAGES[b.result as string] }
  const code = typeof b.error === 'string' && b.error in RECONCILIATION_MESSAGES ? b.error : 'server_error'
  return { ok: false, message: RECONCILIATION_MESSAGES[code] }
}
