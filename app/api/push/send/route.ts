import { NextRequest, NextResponse } from 'next/server'
import { checkSameOriginJson } from '@/lib/kitchenAuth'
import { getKitchenSession } from '@/lib/kitchenUsers'
import { isBranchInScope, isUuid } from '@/lib/kitchenMutations'
import { sendReadyPush } from '@/lib/push'
import { getServerSupabase, ServerConfigError } from '@/lib/supabaseServer'

// POST /api/push/send — { orderId } only. Protected compatibility route (FALAFEL-SN-06D):
// requires a kitchen session + same-origin JSON, and the order must be in the caller's branch scope.
// The kitchen status route sends the ready push itself; this route stays for manual re-sends.
// Status and wording always come from the DB (lib/push.ts): only 'ready' orders are ever notified.

const NO_STORE = { 'Cache-Control': 'no-store' }
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE })

export async function POST(req: NextRequest) {
  if (!checkSameOriginJson(req)) return json({ error: 'invalid_request' }, 400)
  const auth = await getKitchenSession(req)
  if (!auth.ok) return json({ error: auth.error }, auth.status)

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return json({ error: 'invalid_request' }, 400)
  }
  const orderId = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).orderId : undefined
  if (!isUuid(orderId) || Object.keys(body as object).length !== 1) return json({ error: 'invalid_request' }, 400)

  try {
    const { data: order, error } = await getServerSupabase().from('orders').select('branch_id').eq('id', orderId).maybeSingle()
    if (error) {
      console.error('push send: order lookup failed', error.code)
      return json({ error: 'server_error' }, 500)
    }
    if (!order || !isBranchInScope(auth.session, order.branch_id as string | null)) return json({ error: 'not_found' }, 404)

    const result = await sendReadyPush(orderId)
    switch (result.outcome) {
      case 'not_found': return json({ error: 'not_found' }, 404)
      case 'not_ready': return json({ error: 'order_not_ready' }, 409)
      case 'no_subscription': return json({ error: 'no_subscription' }, 404)
      default: return json({ success: result.sent > 0, sent: result.sent })
    }
  } catch (e) {
    if (e instanceof ServerConfigError) {
      console.error('push send: server config error')
      return json({ error: 'server_config' }, 500)
    }
    console.error('push send: unexpected error')
    return json({ error: 'server_error' }, 500)
  }
}
