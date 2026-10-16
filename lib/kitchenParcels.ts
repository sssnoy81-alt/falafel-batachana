// Kitchen parcel status changes (GATE 03H / S2). Business rules with injectable DB dependencies (testable
// without a DB). Server-side use only — imports lib/kitchenAuth (node:crypto) via kitchenMutations.
// The database trigger public.parcel_requests_before_write() remains the final authority for every rule.
// This module never touches orders.status, never dispatches a courier and never stores signing links.

import type { KitchenSession } from './kitchenAuth'
import { isBranchInScope, isUuid, type MutationResult } from './kitchenMutations'
import { checkParcelAction, isParcelAction, type ParcelAction, type ParcelStatus } from './parcelRequest'

export function parseParcelActionBody(body: unknown): ParcelAction | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  const keys = Object.keys(body)
  if (keys.length !== 1 || keys[0] !== 'action') return null
  const action = (body as { action?: unknown }).action
  return isParcelAction(action) ? action : null
}

/** The database refused the parcel change (its trigger raised a parcel_* rule, SQLSTATE 22023). */
export class ParcelRuleRejectedError extends Error {
  constructor(code: string) { super(code); this.name = 'ParcelRuleRejectedError' }
}

export interface ParcelDeps {
  /** The order with its parcel status (null when the order has no parcel request). */
  loadOrder(orderId: string): Promise<{ id: string; status: string; branch_id: string | null; parcel_status: string | null } | null>
  /**
   * Conditional update of the order's parcel: WHERE order_id = :orderId AND status = :from.
   * Sets status, close_reason (only for food_only) and last_actor. Returns true when exactly one row changed.
   * Throws ParcelRuleRejectedError when the database trigger rejects the change.
   */
  updateParcelIfCurrent(orderId: string, from: ParcelStatus, to: ParcelStatus, closeReason: 'food_only' | null, actor: string): Promise<boolean>
}

const err = (status: 400 | 404 | 409, error: 'invalid_request' | 'not_found' | 'invalid_transition' | 'invalid_state' | 'conflict') =>
  ({ ok: false as const, status, error })

export async function changeParcelStatus(
  deps: ParcelDeps,
  session: Pick<KitchenSession, 'role' | 'branchId' | 'username'>,
  orderId: unknown,
  body: unknown,
): Promise<MutationResult<{ orderId: string; parcelStatus: ParcelStatus }>> {
  if (!isUuid(orderId)) return err(400, 'invalid_request')
  const action = parseParcelActionBody(body)
  if (!action) return err(400, 'invalid_request')

  const order = await deps.loadOrder(orderId)
  // Out-of-scope orders and orders without a parcel are indistinguishable from missing ones.
  if (!order || !isBranchInScope(session, order.branch_id) || order.parcel_status === null) return err(404, 'not_found')

  const check = checkParcelAction(action, order.parcel_status, order.status)
  if (!check.ok) return err(409, check.error)

  let updated: boolean
  try {
    updated = await deps.updateParcelIfCurrent(orderId, check.from, check.to, check.closeReason, session.username)
  } catch (e) {
    if (e instanceof ParcelRuleRejectedError) return err(409, 'invalid_state') // DB trigger is authoritative
    throw e
  }
  if (!updated) return err(409, 'conflict') // changed by another tablet in between — no event is written

  return { ok: true, value: { orderId, parcelStatus: check.to } }
}
