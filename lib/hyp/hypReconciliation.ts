// SERVER-ONLY staff payment reconciliation view (HYP-08) — READ ONLY.
// GET /api/kitchen/payments: kitchen session required (re-validated against the user store), branch scope exactly as
// GET /api/kitchen/orders (lib/kitchenOrders resolveBranchScope). Lists payment intents that need staff attention.
// No RPC is called and no action exists here: void / refund / portal confirmation / staff finalize are NOT authorized
// in this phase. Works whether or not HYP_PAYMENTS_ENABLED is on (already-paid intents must stay visible).

import type { KitchenSession } from '../kitchenAuth'
import { resolveBranchScope } from '../kitchenOrders'
import { allowedRecoveryActions, type RecoveryAction } from './hypStaffRecovery'

if (typeof window !== 'undefined') {
  throw new Error('lib/hyp/hypReconciliation is server-only')
}

/** Statuses fetched (plus any intent with a recorded duplicate charge). Settled / never-sent intents are not listed. */
export const RECONCILIATION_STATUSES = ['redirected', 'returned', 'verify_rejected', 'outcome_unknown', 'paid', 'paid_hold', 'paid_amount_mismatch'] as const

// The service_role read used by the route (PostgREST). Only what staff need; never the return query string,
// the VERIFY answer, the snapshot items or the public token.
export const RECONCILIATION_SELECT = [
  'hyp_order_ref', 'status', 'hold_reason', 'amount_agorot', 'branch_id', 'created_at', 'expires_at', 'redirected_at',
  'returned_at', 'paid_at', 'finalized_at', 'updated_at', 'last_error', 'duplicate_charge_at', 'finalize_attempts',
  'staff_flag', 'staff_flag_note', 'staff_flag_by', 'staff_flag_at',
  'customer_name:snapshot->p_order->>customer_name', 'phone:snapshot->p_order->>phone',
  'orders!payment_intents_order_fk(daily_number)',
  'payment_transactions!payment_transactions_intent_fk(hyp_trans_id, source, ccode, outcome, amount_agorot, recorded_at)',
  'payment_returns!payment_returns_intent_fk(received_at, verify_outcome)',
  'payment_reversals!payment_reversals_intent_fk(kind, amount_agorot, hyp_reference, staff_user, created_at)',
].join(', ')

export type ReconciliationCategory =
  | 'paid_no_order' | 'finalize_failed' | 'late_return' | 'duplicate_charge' | 'amount_mismatch' | 'non_capture'
  | 'verify_rejected' | 'returned_unverified' | 'no_return' | 'manual_hold' | 'flagged' | 'awaiting_customer'

/** Display order: money received without an order first. */
export const CATEGORY_ORDER: readonly ReconciliationCategory[] = ['paid_no_order', 'finalize_failed', 'late_return', 'duplicate_charge',
  'amount_mismatch', 'non_capture', 'verify_rejected', 'returned_unverified', 'no_return', 'manual_hold', 'flagged', 'awaiting_customer']

/** What staff must know about the money, kept strictly apart (HYP-09). */
export type MoneyState = 'confirmed' | 'unknown' | 'not_captured' | 'refund_required' | 'refunded_externally'

export interface ReconciliationTransaction { hypTransId: string; source: string; ccode: string; outcome: string; amount: number; recordedAt: string }
export interface ReconciliationReversal { kind: string; amount: number; reference: string; staffUser: string; createdAt: string }
export interface ReconciliationItem {
  ref: string                     // hyp_order_ref — the reference to search in the HYP portal
  category: ReconciliationCategory
  status: string
  holdReason: string | null
  amount: number                  // ₪
  branchId: string
  createdAt: string; expiresAt: string; returnedAt: string | null; paidAt: string | null; updatedAt: string
  errorCode: string | null        // SQLSTATE / non-capture code only, never a message
  finalizeAttempts: number
  dailyNumber: number | null
  customerName: string | null; phone: string | null   // staff contact (same data the order board shows)
  transactions: ReconciliationTransaction[]
  returns: number; unverifiedReturns: number
  moneyState: MoneyState
  staffFlag: string | null; staffFlagNote: string | null; staffFlagBy: string | null; staffFlagAt: string | null
  reversals: ReconciliationReversal[]
  actions: RecoveryAction[]          // empty unless the viewing account may perform staff recovery
}

const CONFIRMED_CATEGORIES: readonly ReconciliationCategory[] = ['paid_no_order', 'finalize_failed', 'late_return', 'duplicate_charge', 'amount_mismatch', 'manual_hold']
export function moneyStateOf(category: ReconciliationCategory, status: string, staffFlag: string | null, reversals: number): MoneyState {
  if (staffFlag === 'refund_required') return 'refund_required'
  if (reversals > 0 && (status === 'voided' || status === 'refunded')) return 'refunded_externally'
  if (category === 'non_capture') return 'not_captured'
  if (CONFIRMED_CATEGORIES.includes(category) || ['finalized', 'voided', 'refunded'].includes(status)) return 'confirmed'
  return 'unknown'
}

type Row = Record<string, unknown>
const s = (v: unknown) => (typeof v === 'string' ? v : null)
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0)

/** Only a short code survives (e.g. '22023', 'non_capture_ccode_700'); messages and values are dropped. */
export function sanitizeErrorCode(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const m = /^(non_capture_ccode_\d{1,6}|[0-9A-Z]{5})(?=$|:)/.exec(v)
  return m ? m[1] : null
}

export function categorize(row: { status: string; hold_reason: string | null; last_error: string | null; expires_at: string; duplicate_charge_at: string | null; staff_flag?: string | null }, now: Date): ReconciliationCategory | null {
  switch (row.status) {
    case 'redirected': return new Date(row.expires_at) <= now ? 'no_return' : 'awaiting_customer'
    case 'returned': return 'returned_unverified'
    case 'verify_rejected': return 'verify_rejected'
    case 'outcome_unknown': return (row.last_error ?? '').startsWith('non_capture_ccode_') ? 'non_capture' : 'no_return'
    case 'paid': return 'paid_no_order'
    case 'paid_amount_mismatch': return 'amount_mismatch'
    case 'paid_hold':
      if (row.hold_reason === 'late_return') return 'late_return'
      if (row.hold_reason === 'duplicate_charge') return 'duplicate_charge'
      if (row.hold_reason === 'finalize_error' || row.hold_reason === 'parcel_conflict') return 'finalize_failed'
      return 'manual_hold'
    default: return row.duplicate_charge_at ? 'duplicate_charge' : row.staff_flag ? 'flagged' : null
  }
}

export function normalizeReconciliation(data: unknown, now: Date, canRecover = false): ReconciliationItem[] {
  if (!Array.isArray(data)) return []
  const items: ReconciliationItem[] = []
  for (const raw of data as Row[]) {
    const status = s(raw.status); const ref = s(raw.hyp_order_ref)
    if (!status || !ref) continue
    const category = categorize({ status, hold_reason: s(raw.hold_reason), last_error: s(raw.last_error), expires_at: s(raw.expires_at) ?? '',
                                  duplicate_charge_at: s(raw.duplicate_charge_at), staff_flag: s(raw.staff_flag) }, now)
    if (!category) continue
    const order = (Array.isArray(raw.orders) ? raw.orders[0] : raw.orders) as Row | null | undefined
    const txs = Array.isArray(raw.payment_transactions) ? (raw.payment_transactions as Row[]) : []
    const rets = Array.isArray(raw.payment_returns) ? (raw.payment_returns as Row[]) : []
    const revs = Array.isArray(raw.payment_reversals) ? (raw.payment_reversals as Row[]) : []
    const staffFlag = s(raw.staff_flag)
    const actions = canRecover ? allowedRecoveryActions({ status, holdReason: s(raw.hold_reason), staffFlag,
                                                          duplicateChargeAt: s(raw.duplicate_charge_at), expiresAt: s(raw.expires_at) ?? '' }, now) : []
    items.push({
      ref, category, status, holdReason: s(raw.hold_reason), amount: n(raw.amount_agorot) / 100, branchId: s(raw.branch_id) ?? '',
      createdAt: s(raw.created_at) ?? '', expiresAt: s(raw.expires_at) ?? '', returnedAt: s(raw.returned_at), paidAt: s(raw.paid_at),
      updatedAt: s(raw.updated_at) ?? '', errorCode: sanitizeErrorCode(raw.last_error), finalizeAttempts: n(raw.finalize_attempts),
      dailyNumber: order && typeof order.daily_number === 'number' ? order.daily_number : null,
      customerName: s(raw.customer_name), phone: s(raw.phone),
      transactions: txs.map(t => ({ hypTransId: s(t.hyp_trans_id) ?? '', source: s(t.source) ?? '', ccode: s(t.ccode) ?? '',
                                    outcome: s(t.outcome) ?? '', amount: n(t.amount_agorot) / 100, recordedAt: s(t.recorded_at) ?? '' })),
      returns: rets.length, unverifiedReturns: rets.filter(r => r.verify_outcome === null || r.verify_outcome === undefined).length,
      moneyState: moneyStateOf(category, status, staffFlag, revs.length),
      staffFlag, staffFlagNote: s(raw.staff_flag_note), staffFlagBy: s(raw.staff_flag_by), staffFlagAt: s(raw.staff_flag_at),
      reversals: revs.map(r => ({ kind: s(r.kind) ?? '', amount: n(r.amount_agorot) / 100, reference: s(r.hyp_reference) ?? '',
                                  staffUser: s(r.staff_user) ?? '', createdAt: s(r.created_at) ?? '' })),
      actions,
    })
  }
  return items.sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) || a.createdAt.localeCompare(b.createdAt))
}

/* ─── Handler (all I/O injected; the route wires the kitchen session + Supabase) ─── */

export type ReconciliationFetch = (branchIds: string[]) => Promise<{ data: unknown; error: { code?: string | null } | null }>
export interface ReconciliationDeps {
  getSession: (req: Request) => Promise<{ ok: true; session: KitchenSession } | { ok: false; status: number; error: string }>
  fetchIntents: ReconciliationFetch
  /** HYP-09: whether this account may perform staff recovery (lib/hyp/hypStaffRecovery isStaffRecoveryAllowedFor). */
  canRecover: (session: KitchenSession) => boolean
  now: () => Date
  log: (event: string, code?: string) => void
}

// The payment migration is not installed → the view says so instead of failing (Production before HYP-05).
const NOT_INSTALLED = new Set(['42P01', 'PGRST205', 'PGRST200', 'PGRST100'])
const HEADERS = { 'Cache-Control': 'no-store, max-age=0', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }
const out = (body: unknown, status = 200) => Response.json(body, { status, headers: HEADERS })

export async function handleKitchenPayments(req: Request, deps: ReconciliationDeps): Promise<Response> {
  const auth = await deps.getSession(req)
  if (!auth.ok) return out({ error: auth.error }, auth.status)
  let branchParam: string | null = null
  try { branchParam = new URL(req.url).searchParams.get('branch') } catch { return out({ error: 'invalid_request' }, 400) }
  const scope = resolveBranchScope(auth.session, branchParam)
  if (!scope.ok) return out({ error: scope.error }, scope.status)
  try {
    const { data, error } = await deps.fetchIntents(scope.branchIds)
    if (error) {
      if (error.code && NOT_INSTALLED.has(error.code)) return out({ available: false, items: [] })
      deps.log('kitchen_payments_query', error.code ?? 'unknown')
      return out({ error: 'server_error' }, 500)
    }
    const now = deps.now()
    const canRecover = deps.canRecover(auth.session)
    return out({ available: true, canRecover, generatedAt: now.toISOString(), items: normalizeReconciliation(data, now, canRecover) })
  } catch {
    deps.log('kitchen_payments_unexpected')
    return out({ error: 'server_error' }, 500)
  }
}
