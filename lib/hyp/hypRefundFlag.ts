// HYP-DELIVERY-02: a prepaid (HYP) order cancelled in the kitchen is MARKED "refund required" — never refunded and
// never recorded as refunded. SERVER-ONLY; I/O injected (testable without a database).
//
// After a successful → cancelled transition, the kitchen status route calls flagRefundForCancelledOrder (after the
// response: the cancellation itself never waits for or depends on it). If the order came from a finalized HYP payment
// intent, that intent gets staff_flag 'refund_required' through the existing HYP-05 function resolve_payment_intent
// (action flag_refund_required — idempotent: already_flagged). The HYP portal refund itself stays a manual owner
// action, recorded afterwards by an admin (record_refund) exactly as before: no new refund permission.

if (typeof window !== 'undefined') {
  throw new Error('lib/hyp/hypRefundFlag is server-only')
}

export const REFUND_FLAG_NOTE = 'הזמנה ששולמה מראש ב-HYP בוטלה במטבח — נדרש זיכוי בפורטל HYP'
const USERNAME_RULE = /^[a-z0-9_-]{2,32}$/

export interface RefundFlagDeps {
  /** The finalized HYP payment intent of this order (id), or null when the order was not paid online. Throws on error. */
  findFinalizedIntent(orderId: string): Promise<string | null>
  /** resolve_payment_intent(intent, 'flag_refund_required', staff, note) → its result code. Throws on error. */
  flagRefundRequired(intentId: string, staffUser: string, note: string): Promise<string>
  log(code: string): void
}

export type RefundFlagResult = 'not_prepaid' | 'recorded' | 'already_flagged' | 'refused' | 'failed'

export async function flagRefundForCancelledOrder(deps: RefundFlagDeps, orderId: string, staffUser: string): Promise<RefundFlagResult> {
  if (!USERNAME_RULE.test(staffUser)) { deps.log('refund_flag_invalid_actor'); return 'refused' }
  let intentId: string | null
  try { intentId = await deps.findFinalizedIntent(orderId) } catch { deps.log('refund_flag_lookup_failed'); return 'failed' }
  if (!intentId) return 'not_prepaid'
  for (let attempt = 0; attempt < 2; attempt++) {   // one retry for a transient database error; the flag is idempotent
    try {
      const r = await deps.flagRefundRequired(intentId, staffUser, REFUND_FLAG_NOTE)
      if (r === 'recorded' || r === 'already_flagged') { deps.log(`refund_flag_${r}`); return r }
      deps.log(`refund_flag_${/^[a-z_]{1,32}$/.test(r) ? r : 'unexpected'}`); return 'refused'
    } catch { /* retry once */ }
  }
  deps.log('refund_flag_failed'); return 'failed'
}
