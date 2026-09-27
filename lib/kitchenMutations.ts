// Kitchen mutations (FALAFEL-SN-06D): status transitions + item-note edits.
// Business rules live here with injectable DB/push dependencies (testable without a DB).
// Server-side use only — imports lib/kitchenAuth (node:crypto).

import { KITCHEN_BRANCH_IDS, type KitchenSession } from './kitchenAuth'

/* ─── Status model ─── */

export const ORDER_STATUSES = ['received', 'confirmed', 'preparing', 'ready', 'delivered', 'cancelled'] as const
export type OrderStatusValue = (typeof ORDER_STATUSES)[number]

// Locked transition table (mirrors the current kitchen buttons). delivered + cancelled are terminal.
export const ALLOWED_TRANSITIONS: Readonly<Record<OrderStatusValue, readonly OrderStatusValue[]>> = {
  received: ['confirmed'],
  confirmed: ['preparing', 'cancelled'],
  preparing: ['ready', 'cancelled'],
  ready: ['delivered'],
  delivered: [],
  cancelled: [],
}

export const NOTE_EDITABLE_STATUSES: readonly string[] = ['confirmed', 'preparing']
export const MAX_KITCHEN_NOTES = 500

const isStatus = (v: unknown): v is OrderStatusValue =>
  typeof v === 'string' && (ORDER_STATUSES as readonly string[]).includes(v)

export const isAllowedTransition = (from: string, to: string): boolean =>
  isStatus(from) && isStatus(to) && ALLOWED_TRANSITIONS[from].includes(to)

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_REGEX.test(v)

/** Branch user: only its own branch. Admin: only the known kitchen branches. */
export function isBranchInScope(session: Pick<KitchenSession, 'role' | 'branchId'>, branchId: string | null | undefined): boolean {
  if (!branchId || !KITCHEN_BRANCH_IDS.includes(branchId)) return false
  return session.role === 'admin' ? true : session.branchId === branchId
}

/* ─── Input parsing ─── */

export function parseStatusBody(body: unknown): OrderStatusValue | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  const keys = Object.keys(body)
  if (keys.length !== 1 || keys[0] !== 'status') return null
  const status = (body as { status?: unknown }).status
  // 'received' is never a valid target
  return isStatus(status) && status !== 'received' ? status : null
}

/** Returns the normalized note (trimmed; empty → null), or undefined when the body is invalid. */
export function parseNotesBody(body: unknown): string | null | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined
  const keys = Object.keys(body)
  if (keys.length !== 1 || keys[0] !== 'notes') return undefined
  const notes = (body as { notes?: unknown }).notes
  if (notes === null) return null
  if (typeof notes !== 'string') return undefined
  const trimmed = notes.trim()
  if (trimmed.length > MAX_KITCHEN_NOTES) return undefined
  return trimmed === '' ? null : trimmed
}

/* ─── Results ─── */

export type MutationError = 'invalid_request' | 'not_found' | 'invalid_transition' | 'invalid_state' | 'conflict'
export type MutationResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: 400 | 404 | 409; error: MutationError }

const err = (status: 400 | 404 | 409, error: MutationError) => ({ ok: false as const, status, error })

/* ─── Status change ─── */

export interface StatusDeps {
  loadOrder(id: string): Promise<{ id: string; status: string; branch_id: string | null } | null>
  /** Conditional update: WHERE id = :id AND status = :from. Returns true when exactly the row was updated. */
  updateStatusIfCurrent(id: string, from: string, to: OrderStatusValue): Promise<boolean>
  sendReadyPush(id: string): Promise<{ sent: number }>
}

export async function changeOrderStatus(
  deps: StatusDeps, session: Pick<KitchenSession, 'role' | 'branchId'>, orderId: unknown, body: unknown,
): Promise<MutationResult<{ id: string; status: OrderStatusValue; pushSent?: boolean }>> {
  if (!isUuid(orderId)) return err(400, 'invalid_request')
  const target = parseStatusBody(body)
  if (!target) return err(400, 'invalid_request')

  const order = await deps.loadOrder(orderId)
  // Out-of-scope orders are indistinguishable from missing ones.
  if (!order || !isBranchInScope(session, order.branch_id)) return err(404, 'not_found')

  if (order.status === target) return err(409, 'conflict') // someone else already did it
  if (!isAllowedTransition(order.status, target)) return err(409, 'invalid_transition')

  const updated = await deps.updateStatusIfCurrent(orderId, order.status, target)
  if (!updated) return err(409, 'conflict') // another tablet changed it in between

  if (target !== 'ready') return { ok: true, value: { id: orderId, status: target } }

  // The status change is final; a push failure never undoes it.
  let pushSent = false
  try {
    pushSent = (await deps.sendReadyPush(orderId)).sent > 0
  } catch (e) {
    console.error('kitchen status: ready push failed', e instanceof Error ? e.name : 'error')
  }
  return { ok: true, value: { id: orderId, status: target, pushSent } }
}

/* ─── Item notes ─── */

export interface NotesDeps {
  loadItem(id: string): Promise<{ id: string; orderBranchId: string | null; orderStatus: string | null } | null>
  updateNotes(id: string, notes: string | null): Promise<boolean>
}

export async function editItemNotes(
  deps: NotesDeps, session: Pick<KitchenSession, 'role' | 'branchId'>, itemId: unknown, body: unknown,
): Promise<MutationResult<{ id: string; notes: string | null }>> {
  if (!isUuid(itemId)) return err(400, 'invalid_request')
  const notes = parseNotesBody(body)
  if (notes === undefined) return err(400, 'invalid_request')

  const item = await deps.loadItem(itemId)
  if (!item || !isBranchInScope(session, item.orderBranchId)) return err(404, 'not_found')
  if (!item.orderStatus || !NOTE_EDITABLE_STATUSES.includes(item.orderStatus)) return err(409, 'invalid_state')

  const updated = await deps.updateNotes(itemId, notes)
  if (!updated) return err(404, 'not_found')
  return { ok: true, value: { id: itemId, notes } }
}
