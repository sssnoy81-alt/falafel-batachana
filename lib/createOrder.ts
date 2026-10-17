// SERVER-ONLY. Single entry point for persisting an order.
//
// Uses the atomic Postgres function public.create_order(p_order, p_items, p_delivery)
// (orders + order_items + deliveries + daily_number in ONE transaction, EXECUTE granted to service_role only).
//
// If the function is ever missing, this adapter raises OrderCreationUnavailableError (→ 503). It never fakes
// success and never falls back to direct / anon inserts.

import { getServerSupabase } from './supabaseServer'
import type { CreateOrderRpcArgs } from './orderRequest'
import type { ParcelCheckoutInput } from './parcelCheckout'

export class OrderCreationUnavailableError extends Error {
  constructor(message = 'create_order RPC is not available') {
    super(message)
    this.name = 'OrderCreationUnavailableError'
  }
}

export interface CreatedOrder {
  orderId: string
  orderNumber: number
  dailyNumber: number
}

interface CreateOrderRpcRow {
  created_order_id: string
  created_order_number: number
  created_daily_number: number
}

// PostgREST: PGRST202 = function not found in schema cache; 42883 = undefined function.
const MISSING_FUNCTION_CODES = new Set(['PGRST202', '42883'])

export async function createOrderAtomic(args: CreateOrderRpcArgs): Promise<CreatedOrder> {
  const supabase = getServerSupabase()
  const { data, error } = await supabase.rpc('create_order', args)

  if (error) {
    if (error.code && MISSING_FUNCTION_CODES.has(error.code)) throw new OrderCreationUnavailableError()
    throw new Error(`create_order failed: ${error.code ?? ''} ${error.message}`)
  }

  return toCreatedOrder(data, 'create_order')
}

function toCreatedOrder(data: unknown, fn: string): CreatedOrder {
  const row = (Array.isArray(data) ? data[0] : data) as CreateOrderRpcRow | null | undefined
  if (!row || !row.created_order_id || typeof row.created_daily_number !== 'number')
    throw new Error(`${fn} returned no row`)

  return {
    orderId: row.created_order_id,
    orderNumber: row.created_order_number,
    dailyNumber: row.created_daily_number,
  }
}

/* ─── Food order + parcel (GATE S4-A) ─── */

/** The same tracking number is already active for this branch (unique index parcel_requests_active_key_uq). */
export class ParcelDuplicateError extends Error {
  constructor() { super('parcel_duplicate'); this.name = 'ParcelDuplicateError' }
}

/** A parcel rule of the database rejected the request (CHECK constraint, parcel trigger or wrapper validation). */
export class ParcelRejectedError extends Error {
  /** Constraint / rule name only — never values (safe to log). */
  constructor(readonly reason: string) { super('parcel_rejected'); this.name = 'ParcelRejectedError' }
}

/**
 * Maps an error of create_order_with_parcel to a safe outcome. Uses only the SQLSTATE and the constraint / rule
 * NAME in the message — never PostgREST `details` (which can contain the tracking number).
 */
export function classifyParcelRpcError(error: { code?: string | null; message?: string | null }):
  { kind: 'unavailable' } | { kind: 'duplicate' } | { kind: 'rejected'; reason: string } | { kind: 'other' } {
  const code = error.code ?? ''
  const message = error.message ?? ''
  if (MISSING_FUNCTION_CODES.has(code)) return { kind: 'unavailable' }
  if (code === '23505' && /"parcel_requests_active_key_uq"/.test(message)) return { kind: 'duplicate' }
  if (code === '23514') {
    const m = /"(parcel_requests_[a-z_]+)"/.exec(message)
    if (m) return { kind: 'rejected', reason: m[1] }
  }
  if (code === '22023') {
    if (/^parcel_[a-z_]+$/.test(message)) return { kind: 'rejected', reason: message }        // parcel trigger rule
    if (message.startsWith('create_order_with_parcel: ')) return { kind: 'rejected', reason: 'wrapper_validation' }
  }
  return { kind: 'other' }
}

/**
 * Creates the food order AND its parcel in ONE database call: public.create_order_with_parcel(p_order, p_items,
 * p_delivery, p_parcel) runs the unchanged public.create_order (same pricing payload) and inserts the parcel row in
 * the same transaction; it has no exception handler, so any failure keeps nothing. EXECUTE: service_role only.
 * There is deliberately no fallback (no separate parcel insert, no retry as a food-only order).
 */
export async function createOrderWithParcelAtomic(args: CreateOrderRpcArgs, parcel: ParcelCheckoutInput): Promise<CreatedOrder> {
  const supabase = getServerSupabase()
  const { data, error } = await supabase.rpc('create_order_with_parcel', {
    ...args,
    p_parcel: { tracking_ref: parcel.trackingRef, carrier: parcel.carrier },
  })

  if (error) {
    const c = classifyParcelRpcError(error)
    if (c.kind === 'unavailable') throw new OrderCreationUnavailableError('create_order_with_parcel RPC is not available')
    if (c.kind === 'duplicate') throw new ParcelDuplicateError()
    if (c.kind === 'rejected') throw new ParcelRejectedError(c.reason)
    throw new Error(`create_order_with_parcel failed: ${error.code ?? ''}`) // code only: the message may carry input
  }

  return toCreatedOrder(data, 'create_order_with_parcel')
}
