import { NextRequest, NextResponse } from 'next/server'
import { getKitchenSession } from '@/lib/kitchenUsers'
import { KITCHEN_ORDER_SELECT, normalizeKitchenOrders, resolveBranchScope } from '@/lib/kitchenOrders'
import { getServerSupabase, ServerConfigError } from '@/lib/supabaseServer'
import { israelDayBounds } from '@/lib/hours'

// GET /api/kitchen/orders[?branch=all|<branch uuid>] — READ ONLY (06C).
// Requires a kitchen session. Returns today's orders (Asia/Jerusalem day) for the session's branch scope,
// with a minimal explicit field set. Delivery details are only included for delivery orders.

const NO_STORE = { 'Cache-Control': 'no-store' }
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE })

export async function GET(req: NextRequest) {
  const auth = await getKitchenSession(req)
  if (!auth.ok) return json({ error: auth.error }, auth.status)

  const scope = resolveBranchScope(auth.session, req.nextUrl.searchParams.get('branch'))
  if (!scope.ok) return json({ error: scope.error }, scope.status)

  try {
    const supabase = getServerSupabase()
    const { start, end } = israelDayBounds()
    const { data, error } = await supabase
      .from('orders')
      .select(KITCHEN_ORDER_SELECT)
      .in('branch_id', scope.branchIds)
      .gte('created_at', start.toISOString())
      .lt('created_at', end.toISOString())
      .order('created_at', { ascending: false })

    if (error) {
      console.error('kitchen orders: query failed', error.code) // no payloads / PII in logs
      return json({ error: 'server_error' }, 500)
    }
    return json({ orders: normalizeKitchenOrders(data) })
  } catch (e) {
    if (e instanceof ServerConfigError) {
      console.error('kitchen orders: server config error')
      return json({ error: 'server_config' }, 500)
    }
    console.error('kitchen orders: unexpected error')
    return json({ error: 'server_error' }, 500)
  }
}
