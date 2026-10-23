// Kitchen courier RECONCILIATION records (S4-INTEGRATIONS-04D2). SERVER-ONLY business rules with injectable
// dependencies, used by POST /api/kitchen/orders/[id]/reconciliation.
//
// A record is what an authorized MANAGER ACCOUNT reports (usually after a phone call with Maale Express). It is appended
// to public.maale_dispatch_reconciliations and NEVER changes public.orders or public.delivery_dispatches, never contacts
// the provider, never retries / resets / re-dispatches anything.
// S4-04E2: the append is public.record_maale_reconciliation_event (one transaction under the per-order lock shared with
// the dispatch claim: idempotent request_id, dispatch consistency, manual-courier gating, INSERT). There is no direct
// INSERT path; every answer of the function is mapped explicitly and anything unknown fails closed.
//
// DISABLED unless MAALE_KITCHEN_RECONCILIATION_ENABLED === 'true' (install db/migrations/s4_04d_* first). Writing also
// requires the account to be listed exactly in MAALE_KITCHEN_RECONCILIATION_USERS (default: nobody). Being allowed to
// dispatch never grants write permission here.

import { isBranchInScope } from './kitchenMutations'
import type { KitchenSession } from './kitchenAuth'
import { isKitchenDispatchAllowedFor, parseDispatchAllowlist } from './kitchenDispatch'
import { EVENTS_REQUIRING_DISPATCH, REQUEST_ID_RULE, validateReconciliationInput, type ReconciliationInput } from './kitchenReconciliationUi'

/* ─── Flags / authorization ─── */

const USERNAME_RULE = /^[a-z0-9_-]{2,32}$/

/** Only the exact string 'true' enables reconciliation (read embed + endpoint); anything else is OFF. */
export const isReconciliationEnabled = (env: Record<string, string | undefined>): boolean =>
  env.MAALE_KITCHEN_RECONCILIATION_ENABLED === 'true'

/** WRITE permission: flag on AND this account listed exactly in the server-only manager allowlist. */
export function isReconciliationAllowedFor(env: Record<string, string | undefined>, username: unknown): boolean {
  if (!isReconciliationEnabled(env)) return false
  if (typeof username !== 'string' || !USERNAME_RULE.test(username)) return false
  const list = parseDispatchAllowlist(env.MAALE_KITCHEN_RECONCILIATION_USERS) // same strict, fail-closed list format
  return list.ok && list.users.has(username)
}

/** READ permission (history shown on the board): reconciliation flag on AND a manager or a dispatch-authorized account. */
export const isReconciliationVisibleFor = (env: Record<string, string | undefined>, username: unknown): boolean =>
  isReconciliationEnabled(env) && (isReconciliationAllowedFor(env, username) || isKitchenDispatchAllowedFor(env, username))

/* ─── Request body ─── */

const BODY_KEYS = ['requestId', 'eventType', 'providerOrderId', 'providerStatus', 'reasonCode', 'confirmCancellation']
const optStr = (v: unknown): string | null | undefined => (v === undefined || v === null ? null : typeof v === 'string' ? (v.trim() || null) : undefined)

export type ParsedReconciliation = ReconciliationInput & { requestId: string }

/**
 * Exact keys only (actor / branch / order can never come from the browser). requestId is REQUIRED (S4-04D3): a lower-case
 * UUID the browser creates once per user-confirmed action and reuses when retrying that same action. null when malformed.
 */
export function parseReconciliationBody(body: unknown): ParsedReconciliation | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  if (Object.keys(body).some(k => !BODY_KEYS.includes(k))) return null
  const b = body as Record<string, unknown>
  if (typeof b.requestId !== 'string' || !REQUEST_ID_RULE.test(b.requestId)) return null
  if (typeof b.eventType !== 'string') return null
  const providerOrderId = optStr(b.providerOrderId), providerStatus = optStr(b.providerStatus), reasonCode = optStr(b.reasonCode)
  if (providerOrderId === undefined || providerStatus === undefined || reasonCode === undefined) return null
  if (b.confirmCancellation !== undefined && typeof b.confirmCancellation !== 'boolean') return null
  return { requestId: b.requestId, eventType: b.eventType, providerOrderId, providerStatus, reasonCode, confirmCancellation: b.confirmCancellation === true }
}

/* ─── Dependencies ─── */

export interface ReconciliationRow {
  request_id: string
  order_id: string
  event_type: string
  actor_username: string
  provider_order_id: string | null
  provider_status: string | null
  reason_code: string | null
}

/** The coordination function / ledger is missing, or the per-order lock timed out (retry with the SAME request_id). */
export class ReconciliationUnavailableError extends Error {
  constructor() { super('reconciliation_unavailable'); this.name = 'ReconciliationUnavailableError' }
}

/** One answer of public.record_maale_reconciliation_event (RETURNS TABLE(result, event_id, event_created_at)). */
export interface RecordAnswer { result: string; event_id: string | null; event_created_at: string | null }

export interface ReconciliationDeps {
  loadOrder(orderId: string): Promise<{ id: string; branch_id: string | null; type: string | null } | null>
  /** Read-only: the dispatch record (one per order, never replaced). */
  loadDispatch(orderId: string): Promise<{ status: string; provider_order_id: string | null } | null>
  /** S4-04E2: calls record_maale_reconciliation_event. Throws ReconciliationUnavailableError when the function / ledger
   *  is missing or the lock timed out; any other error throws. Never updates or deletes. */
  recordEvent(row: ReconciliationRow): Promise<RecordAnswer>
  log?: (code: string) => void // short codes only
}

/** Function answers refused with 409 (nothing stored). dispatch_active / dispatch_outcome_unknown: a manual courier is
 *  not an ordinary booking while a Maale request is (or may be) live — never unlocks anything. */
export const RECORD_CONFLICT_RESULTS: readonly string[] = [
  'request_id_conflict', 'dispatch_active', 'dispatch_outcome_unknown', 'no_dispatch_record', 'no_dispatch_attempt', 'provider_order_mismatch',
]

export type ReconciliationBody =
  | { result: 'recorded' | 'already_recorded'; event: { id: string; eventType: string; createdAt: string } }
  | { error: string; reason?: string }
export interface ReconciliationResponse { status: number; body: ReconciliationBody }
const reply = (status: number, body: ReconciliationBody): ReconciliationResponse => ({ status, body })

/**
 * Called by the route AFTER the flag, same-origin JSON, kitchen session, manager allowlist, body and UUID checks.
 * Branch scope and dispatch consistency come from the DATABASE. Inserts at most one row; never touches anything else.
 */
export async function requestReconciliation(
  deps: ReconciliationDeps, session: Pick<KitchenSession, 'role' | 'branchId' | 'username'>, orderId: string, input: ParsedReconciliation,
): Promise<ReconciliationResponse> {
  const log = deps.log ?? (() => {})
  const order = await deps.loadOrder(orderId)
  if (!order || !isBranchInScope(session, order.branch_id)) return reply(404, { error: 'not_found' }) // no cross-branch oracle
  if (order.type !== 'delivery') return reply(409, { error: 'not_delivery' })

  const v = validateReconciliationInput(input)
  if (!v.ok) return reply(400, { error: 'invalid_request', reason: v.code })

  // Consistency with the dispatch record (fail closed on any mismatch).
  const dispatch = await deps.loadDispatch(orderId)
  if (EVENTS_REQUIRING_DISPATCH.includes(input.eventType) || input.providerOrderId !== null) {
    if (!dispatch) return reply(409, { error: 'no_dispatch_record' })
    if (dispatch.status === 'pending') return reply(409, { error: 'no_dispatch_attempt' })
  }
  if (input.providerOrderId !== null && dispatch?.provider_order_id && dispatch.provider_order_id !== input.providerOrderId)
    return reply(409, { error: 'provider_order_mismatch' })

  const row: ReconciliationRow = {
    request_id: input.requestId,
    order_id: orderId, event_type: input.eventType, actor_username: session.username,
    provider_order_id: input.providerOrderId, provider_status: input.providerStatus, reason_code: input.reasonCode,
  }

  // S4-04E2: one atomic call (idempotency by request_id, consistency + manual-courier gating under the shared lock).
  // Only AFTER authorization, branch scope and the checks above; the actor is the authenticated session, never the body.
  const answer = await deps.recordEvent(row)
  const stored = typeof answer.event_id === 'string' && typeof answer.event_created_at === 'string'
    ? { id: answer.event_id, eventType: row.event_type, createdAt: answer.event_created_at } : null
  switch (answer.result) {
    case 'recorded': case 'already_recorded':
      if (!stored) break // fail closed below: never report a record without its stored id
      // already_recorded: identical payload (order, actor, every field) — the stored row is returned, never modified
      log(answer.result === 'recorded' ? `kitchen_reconciliation_${row.event_type}` : 'kitchen_reconciliation_request_replayed')
      return reply(answer.result === 'recorded' ? 201 : 200, { result: answer.result, event: stored })
    case 'order_not_found': return reply(404, { error: 'not_found' })
    case 'invalid_request': return reply(400, { error: 'invalid_request' })
    default:
      if (RECORD_CONFLICT_RESULTS.includes(answer.result)) { log(`kitchen_reconciliation_${answer.result}`); return reply(409, { error: answer.result }) }
  }
  log('kitchen_reconciliation_unexpected_answer') // fail closed: nothing reported as recorded
  return reply(500, { error: 'server_error' })
}
