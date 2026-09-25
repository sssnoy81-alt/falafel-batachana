// SERVER-ONLY. Single entry point for persisting an order.
//
// Target: the atomic Postgres function public.create_order(p_order, p_items, p_delivery)
// (orders + order_items + deliveries + daily_number in ONE transaction, EXECUTE granted to service_role only).
//
// STATUS: the function does NOT exist in the database yet (pending approved SQL — see FALAFEL-SN-03B7 §E).
// Until it exists this adapter raises OrderCreationUnavailableError. It never fakes success and never
// falls back to direct / anon inserts.

import { getServerSupabase } from './supabaseServer'
import type { CreateOrderRpcArgs } from './orderRequest'

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

  const row = (Array.isArray(data) ? data[0] : data) as CreateOrderRpcRow | null | undefined
  if (!row || !row.created_order_id || typeof row.created_daily_number !== 'number')
    throw new Error('create_order returned no row')

  return {
    orderId: row.created_order_id,
    orderNumber: row.created_order_number,
    dailyNumber: row.created_daily_number,
  }
}
