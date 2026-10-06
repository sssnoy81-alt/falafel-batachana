import { NextRequest, NextResponse } from 'next/server'
import { checkSameOriginJson } from '@/lib/kitchenAuth'
import { getKitchenSession } from '@/lib/kitchenUsers'
import { changeOrderStatus, isUuid, parseStatusBody, type OrderStatusValue } from '@/lib/kitchenMutations'
import { sendReadyPush } from '@/lib/push'
import { getServerSupabase, ServerConfigError } from '@/lib/supabaseServer'

// PATCH /api/kitchen/orders/[id]/status — { status }
// Kitchen session + same-origin JSON. Branch scope from the session only. Locked transition table,
// conditional update (id AND current status) against concurrent tablets. On 'ready' the server sends
// the push itself; a push failure never rolls back the status change.
// Timestamps: current production code only writes `status` (confirmed_at/ready_at/delivered_at are not
// maintained by the app or by an active trigger) — this route preserves that behavior exactly.

const NO_STORE = { 'Cache-Control': 'no-store' }
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE })

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!checkSameOriginJson(req)) return json({ error: 'invalid_request' }, 400)
  const auth = await getKitchenSession(req)
  if (!auth.ok) return json({ error: auth.error }, auth.status)

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return json({ error: 'invalid_request' }, 400)
  }
  const { id } = await params
  // Cheap input validation first, so malformed requests get 400 regardless of server config.
  if (!isUuid(id) || !parseStatusBody(body)) return json({ error: 'invalid_request' }, 400)

  try {
    const supabase = getServerSupabase()
    const result = await changeOrderStatus({
      async loadOrder(orderId) {
        const { data, error } = await supabase.from('orders').select('id, status, branch_id').eq('id', orderId).maybeSingle()
        if (error) throw new Error(`load ${error.code}`)
        return data as { id: string; status: string; branch_id: string | null } | null
      },
      async updateStatusIfCurrent(orderId, from, to: OrderStatusValue) {
        const { data, error } = await supabase.from('orders').update({ status: to })
          .eq('id', orderId).eq('status', from).select('id')
        if (error) throw new Error(`update ${error.code}`)
        return Array.isArray(data) && data.length === 1
      },
      sendReadyPush,
    }, auth.session, id, body)

    if (!result.ok) return json({ error: result.error }, result.status)
    return json(result.value)
  } catch (e) {
    if (e instanceof ServerConfigError) {
      console.error('kitchen status: server config error')
      return json({ error: 'server_config' }, 500)
    }
    console.error('kitchen status: failed', e instanceof Error ? e.message : 'error') // codes only, no payloads
    return json({ error: 'server_error' }, 500)
  }
}
