import { getKitchenSession } from '@/lib/kitchenUsers'
import { getServerSupabase } from '@/lib/supabaseServer'
import { handleStaffRecovery, RecoveryDbError, type RecoveryDb } from '@/lib/hyp/hypStaffRecovery'

// POST /api/kitchen/payments/[ref] — ONE staff recovery action for the payment with HYP Order reference [ref] (HYP-09).
// { action, note, confirm: true, hypTransId?, amount?, reference?, ackDuplicate? }
// DISABLED unless HYP_STAFF_RECOVERY_ENABLED === 'true' (404). Exact HYP_STAFF_RECOVERY_USERS allowlist + recovery tier
// (admin: full; pilot-branch user: restricted actions), branch scope, same-origin JSON (lib/hyp/hypStaffRecovery). Writes only through resolve_payment_intent /
// finalize_paid_intent with the session username as the staff identity. Never contacts HYP; never refunds.

export const dynamic = 'force-dynamic'

type Row = Record<string, unknown>
const first = (data: unknown): Row | null => (Array.isArray(data) ? (data[0] as Row | undefined) ?? null : (data as Row | null))

const db: RecoveryDb = {
  async findIntent(ref) {
    const { data, error } = await getServerSupabase().from('payment_intents')
      .select('id, branch_id, status, hold_reason, staff_flag, duplicate_charge_at, expires_at, paid_source').eq('hyp_order_ref', ref).maybeSingle()
    if (error) throw new RecoveryDbError(error.code ?? 'unknown')
    if (!data) return null
    const d = data as Row
    return { id: String(d.id), branchId: String(d.branch_id), status: String(d.status), holdReason: (d.hold_reason as string | null) ?? null,
             staffFlag: (d.staff_flag as string | null) ?? null, duplicateChargeAt: (d.duplicate_charge_at as string | null) ?? null, expiresAt: String(d.expires_at),
             paidSource: (d.paid_source as string | null) ?? null }
  },
  async findApprovedTransaction(intentId, hypTransId) {
    const { data, error } = await getServerSupabase().from('payment_transactions').select('id')
      .eq('intent_id', intentId).eq('hyp_trans_id', hypTransId).eq('outcome', 'approved').maybeSingle()
    if (error) throw new RecoveryDbError(error.code ?? 'unknown')
    return data ? String((data as Row).id) : null
  },
  async sweepExpired() {
    const { error } = await getServerSupabase().rpc('sweep_expired_payment_intents', { p_limit: 200 })
    if (error) throw new RecoveryDbError(error.code ?? 'unknown')
  },
  async resolve(a) {
    const { data, error } = await getServerSupabase().rpc('resolve_payment_intent', {
      p_intent_id: a.intentId, p_action: a.action, p_staff_user: a.staffUser, p_note: a.note, p_hyp_trans_id: a.hypTransId,
      p_amount_agorot: a.amountAgorot, p_transaction_id: a.transactionId, p_reference: a.reference })
    if (error) throw new RecoveryDbError(error.code ?? 'unknown')
    const r = first(data)
    if (!r) throw new RecoveryDbError('no_row')
    return { result: String(r.result), status: (r.intent_status as string | null) ?? null }
  },
  async finalize(intentId, staffUser) {
    const { data, error } = await getServerSupabase().rpc('finalize_paid_intent', { p_intent_id: intentId, p_staff_user: staffUser })
    if (error) throw new RecoveryDbError(error.code ?? 'unknown')
    const r = first(data)
    if (!r) throw new RecoveryDbError('no_row')
    return { result: String(r.result) }
  },
}

export async function POST(req: Request, { params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params
  return handleStaffRecovery(req, ref, {
    env: process.env,
    getSession: async r => await getKitchenSession(r),
    db, now: () => new Date(),
    log: (event, code) => console.error(`kitchen payments: ${event}${code ? ` ${code}` : ''}`),
  })
}
