// SERVER-ONLY staff payment recovery (HYP-09). POST /api/kitchen/payments/[ref] — one action per request, written ONLY
// through the HYP-05 SECURITY DEFINER functions (resolve_payment_intent / finalize_paid_intent). All I/O injected.
//
// AUTHORIZATION (same pattern as S4-04D reconciliation, stricter): DISABLED unless HYP_STAFF_RECOVERY_ENABLED === 'true'
// (404 otherwise, before any session or body access); then same-origin JSON, the DB-backed kitchen session, role 'admin'
// AND the account listed exactly in HYP_STAFF_RECOVERY_USERS (default: nobody; same 404 otherwise); the intent must be
// in the session's branch scope (404 otherwise). The staff identity written to the ledger is the session username —
// never a browser value. Independent of HYP_PAYMENTS_ENABLED: already-paid customers must be recoverable with it off.
//
// EVIDENCE: a portal confirmation needs the HYP transaction Id + amount + note; a recorded void / refund needs the HYP
// reference of a reversal ALREADY performed in the HYP portal + amount + note; every action needs confirm === true.
// Nothing here contacts HYP, refunds, voids or treats a browser value as proof of payment. Idempotency: the database
// (portal Id, reversal reference, finalize, flags) — a repeated request returns already_* instead of a second effect.

import { checkSameOriginJson, type KitchenSession } from '../kitchenAuth'
import { isBranchInScope } from '../kitchenMutations'
import { parseDispatchAllowlist } from '../kitchenDispatch'
import { HYP_ORDER_REF_RE, HYP_TRANS_ID_RE, amountToAgorot } from './hypProtocol'

if (typeof window !== 'undefined') {
  throw new Error('lib/hyp/hypStaffRecovery is server-only')
}

type EnvLike = Record<string, string | undefined>
const USERNAME_RULE = /^[a-z0-9_-]{2,32}$/
const REFERENCE_RULE = /^[0-9A-Za-z_-]{1,40}$/

export const isStaffRecoveryEnabled = (env: EnvLike): boolean => env.HYP_STAFF_RECOVERY_ENABLED === 'true'

/** Financial actions: flag on AND role admin AND the account listed exactly (shared branch tablets never qualify). */
export function isStaffRecoveryAllowedFor(env: EnvLike, session: Pick<KitchenSession, 'role' | 'username'>): boolean {
  if (!isStaffRecoveryEnabled(env) || session.role !== 'admin') return false
  if (typeof session.username !== 'string' || !USERNAME_RULE.test(session.username)) return false
  const list = parseDispatchAllowlist(env.HYP_STAFF_RECOVERY_USERS)   // strict, fail-closed list format
  return list.ok && list.users.has(session.username)
}

export const RECOVERY_ACTIONS = ['portal_paid', 'finalize', 'no_charge_found', 'flag_refund_required', 'flag_investigation',
  'clear_flag', 'record_void', 'record_refund'] as const
export type RecoveryAction = (typeof RECOVERY_ACTIONS)[number]

export interface RecoveryIntentState {
  status: string; holdReason: string | null; staffFlag: string | null; duplicateChargeAt: string | null; expiresAt: string
}

/** The actions the HYP-05 state machine accepts for this intent (the database re-checks every one). */
export function allowedRecoveryActions(s: RecoveryIntentState, now: Date): RecoveryAction[] {
  const expired = new Date(s.expiresAt) <= now
  const out: RecoveryAction[] = []
  if (['returned', 'verify_rejected', 'outcome_unknown', 'declined', 'no_charge_found'].includes(s.status) || (s.status === 'redirected' && expired)) out.push('portal_paid')
  if (s.status === 'paid' || s.status === 'paid_hold') out.push('finalize')
  if (['returned', 'verify_rejected', 'outcome_unknown'].includes(s.status) || (s.status === 'redirected' && expired)) out.push('no_charge_found')
  if (['paid', 'paid_hold', 'paid_amount_mismatch', 'finalized'].includes(s.status) && s.staffFlag !== 'refund_required') out.push('flag_refund_required')
  if (!['created', 'not_sent'].includes(s.status) && s.staffFlag !== 'investigation') out.push('flag_investigation')
  if (s.staffFlag) out.push('clear_flag')
  if (['paid_hold', 'paid_amount_mismatch', 'finalized'].includes(s.status)) out.push('record_void', 'record_refund')
  return out
}

export type RecoveryRequest =
  | { action: 'portal_paid'; note: string; hypTransId: string; amountAgorot: number }
  | { action: 'record_void' | 'record_refund'; note: string; hypTransId: string; amountAgorot: number; reference: string }
  | { action: 'finalize'; note: string; ackDuplicate: boolean }
  | { action: 'no_charge_found' | 'flag_refund_required' | 'flag_investigation' | 'clear_flag'; note: string }

/** Strict body validation. Unknown keys are refused; confirm must be literally true. */
export function parseRecoveryBody(body: unknown): { ok: true; value: RecoveryRequest } | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, error: 'invalid_request' }
  const b = body as Record<string, unknown>
  const allowed = ['action', 'note', 'confirm', 'hypTransId', 'amount', 'reference', 'ackDuplicate']
  if (Object.keys(b).some(k => !allowed.includes(k))) return { ok: false, error: 'invalid_request' }
  if (b.confirm !== true) return { ok: false, error: 'confirmation_required' }
  if (typeof b.action !== 'string' || !(RECOVERY_ACTIONS as readonly string[]).includes(b.action)) return { ok: false, error: 'invalid_action' }
  const note = typeof b.note === 'string' ? b.note.trim() : ''
  if (note.length < 3 || note.length > 500 || /[\u0000-\u001f\u007f]/.test(note.replace(/\n/g, ' '))) return { ok: false, error: 'invalid_note' }
  const action = b.action as RecoveryAction
  if (action === 'portal_paid' || action === 'record_void' || action === 'record_refund') {
    if (typeof b.hypTransId !== 'string' || !HYP_TRANS_ID_RE.test(b.hypTransId)) return { ok: false, error: 'invalid_hyp_trans_id' }
    const agorot = typeof b.amount === 'string' ? amountToAgorot(b.amount.trim()) : null
    if (agorot === null || agorot < 1) return { ok: false, error: 'invalid_amount' }
    if (action === 'portal_paid') return { ok: true, value: { action, note, hypTransId: b.hypTransId, amountAgorot: agorot } }
    if (typeof b.reference !== 'string' || !REFERENCE_RULE.test(b.reference)) return { ok: false, error: 'invalid_reference' }
    return { ok: true, value: { action, note, hypTransId: b.hypTransId, amountAgorot: agorot, reference: b.reference } }
  }
  if (action === 'finalize') return { ok: true, value: { action, note, ackDuplicate: b.ackDuplicate === true } }
  return { ok: true, value: { action, note } }
}

export interface RecoveryIntent extends RecoveryIntentState { id: string; branchId: string }
export interface RecoveryDb {
  findIntent(ref: string): Promise<RecoveryIntent | null>
  findApprovedTransaction(intentId: string, hypTransId: string): Promise<string | null>   // payment_transactions.id
  sweepExpired(): Promise<void>
  resolve(a: { intentId: string; action: string; staffUser: string; note: string; hypTransId: string | null; amountAgorot: number | null;
               transactionId: string | null; reference: string | null }): Promise<{ result: string; status: string | null }>
  finalize(intentId: string, staffUser: string): Promise<{ result: string }>
}
export class RecoveryDbError extends Error {
  constructor(readonly code: string) { super('recovery_db_failed'); this.name = 'RecoveryDbError' }
}
export interface RecoveryDeps {
  env: EnvLike
  getSession: (req: Request) => Promise<{ ok: true; session: KitchenSession } | { ok: false; status: number; error: string }>
  db: RecoveryDb
  now: () => Date
  log: (event: string, code?: string) => void
}

const HEADERS = { 'Cache-Control': 'no-store, max-age=0', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }
const out = (body: unknown, status = 200) => Response.json(body, { status, headers: HEADERS })
/** Database answers that mean "done" (incl. idempotent repeats); everything else is a refused action (409). */
const SUCCESS = new Set(['recorded', 'already_recorded', 'already_flagged', 'reversed', 'reversal_recorded', 'amount_mismatch', 'finalized', 'already_finalized'])

export async function handleStaffRecovery(req: Request, ref: string, deps: RecoveryDeps): Promise<Response> {
  if (!isStaffRecoveryEnabled(deps.env)) return out({ error: 'not_found' }, 404)
  if (!checkSameOriginJson(req)) return out({ error: 'invalid_request' }, 400)
  const auth = await deps.getSession(req)
  if (!auth.ok) return out({ error: auth.error }, auth.status)
  if (!isStaffRecoveryAllowedFor(deps.env, auth.session)) return out({ error: 'not_found' }, 404)
  if (!HYP_ORDER_REF_RE.test(ref)) return out({ error: 'invalid_request' }, 400)
  const text = await req.text()
  if (text.length > 4096) return out({ error: 'invalid_request' }, 400)
  let body: unknown
  try { body = JSON.parse(text) } catch { return out({ error: 'invalid_request' }, 400) }
  const parsed = parseRecoveryBody(body)
  if (!parsed.ok) return out({ error: parsed.error }, 400)
  const a = parsed.value
  const staffUser = auth.session.username

  try {
    const intent = await deps.db.findIntent(ref)
    if (!intent || !isBranchInScope(auth.session, intent.branchId)) return out({ error: 'not_found' }, 404)   // no leak across branches
    if (!allowedRecoveryActions(intent, deps.now()).includes(a.action)) return out({ error: 'action_not_allowed', status: intent.status }, 409)

    if (a.action === 'finalize') {
      if ((intent.holdReason === 'duplicate_charge' || intent.duplicateChargeAt) && !a.ackDuplicate) return out({ error: 'duplicate_ack_required' }, 400)
      // The reason goes into the audit trail first (finalize_paid_intent itself takes no note).
      const n = await deps.db.resolve({ intentId: intent.id, action: 'note', staffUser, note: `finalize: ${a.note}`.slice(0, 500),
                                        hypTransId: null, amountAgorot: null, transactionId: null, reference: null })
      if (n.result !== 'recorded') return out({ error: n.result }, 409)
      const f = await deps.db.finalize(intent.id, staffUser)
      deps.log('staff_recovery', `finalize:${f.result}`)
      return SUCCESS.has(f.result) ? out({ result: f.result }) : out({ error: f.result }, 409)
    }
    // An expired redirect is still 'redirected' until the sweeper runs; no_charge_found needs outcome_unknown.
    if (a.action === 'no_charge_found' && intent.status === 'redirected') await deps.db.sweepExpired()

    let transactionId: string | null = null
    if (a.action === 'record_void' || a.action === 'record_refund') {
      transactionId = await deps.db.findApprovedTransaction(intent.id, a.hypTransId)
      if (!transactionId) return out({ error: 'transaction_not_found' }, 409)
    }
    const r = await deps.db.resolve({
      intentId: intent.id, staffUser, note: a.note,
      action: a.action === 'record_void' ? 'void' : a.action === 'record_refund' ? 'refund' : a.action,
      hypTransId: a.action === 'portal_paid' ? a.hypTransId : null,
      amountAgorot: 'amountAgorot' in a ? a.amountAgorot : null,
      transactionId, reference: 'reference' in a ? a.reference : null,
    })
    deps.log('staff_recovery', `${a.action}:${r.result}`)
    return SUCCESS.has(r.result) ? out({ result: r.result, status: r.status }) : out({ error: r.result, status: r.status }, 409)
  } catch (e) {
    deps.log('staff_recovery_db', e instanceof RecoveryDbError ? e.code : 'unexpected')
    return out({ error: 'server_error' }, 503)
  }
}
