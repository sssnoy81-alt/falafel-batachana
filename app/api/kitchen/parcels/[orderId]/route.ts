import { NextRequest, NextResponse } from 'next/server'
import { checkSameOriginJson } from '@/lib/kitchenAuth'
import { getKitchenSession } from '@/lib/kitchenUsers'
import { isUuid } from '@/lib/kitchenMutations'
import { changeParcelStatus, ParcelRuleRejectedError, parseParcelActionBody } from '@/lib/kitchenParcels'
import { parcelStatusFromEmbed } from '@/lib/parcelRequest'
import { getServerSupabase, ServerConfigError } from '@/lib/supabaseServer'

// PATCH /api/kitchen/parcels/[orderId] — { action }   (GATE 03H / S2)
// action: found | not_found | reset | food_only | handed_to_courier | carrier_verified | delivery_problem | returned_to_store
// Kitchen session + same-origin JSON. Branch scope from the session only (out-of-scope → 404, like the other
// kitchen routes). Transition rules are validated here and again by the database trigger. The update is
// conditional (order_id AND current parcel status), so concurrent tablets cannot overwrite each other and a
// retried request never writes a second history event. last_actor = the kitchen account.
// Never changes orders.status, never dispatches a courier, never returns or logs tracking numbers.

const NO_STORE = { 'Cache-Control': 'no-store' }
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE })
const PARCEL_RULE = /^parcel_[a-z_]+$/

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ orderId: string }> }) {
  if (!checkSameOriginJson(req)) return json({ error: 'invalid_request' }, 400)
  const auth = await getKitchenSession(req)
  if (!auth.ok) return json({ error: auth.error }, auth.status)

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return json({ error: 'invalid_request' }, 400)
  }
  const { orderId } = await params
  // Cheap input validation first, so malformed requests get 400 regardless of server config.
  if (!isUuid(orderId) || !parseParcelActionBody(body)) return json({ error: 'invalid_request' }, 400)

  try {
    const supabase = getServerSupabase()
    const result = await changeParcelStatus({
      async loadOrder(id) {
        const { data, error } = await supabase.from('orders').select('id, status, branch_id, parcel_requests(status)')
          .eq('id', id).maybeSingle()
        if (error) throw new Error(`load ${error.code}`)
        if (!data) return null
        const row = data as { id: string; status: string; branch_id: string | null; parcel_requests?: unknown }
        return { id: row.id, status: row.status, branch_id: row.branch_id, parcel_status: parcelStatusFromEmbed(row.parcel_requests) }
      },
      async updateParcelIfCurrent(id, from, to, closeReason, actor) {
        const patch: Record<string, string> = { status: to, last_actor: actor }
        if (closeReason) patch.close_reason = closeReason
        const { data, error } = await supabase.from('parcel_requests').update(patch)
          .eq('order_id', id).eq('status', from).select('status')
        if (error) {
          if (error.code === '22023' && PARCEL_RULE.test(error.message)) throw new ParcelRuleRejectedError(error.message)
          throw new Error(`update ${error.code}`)
        }
        return Array.isArray(data) && data.length === 1
      },
    }, auth.session, orderId, body)

    if (!result.ok) return json({ error: result.error }, result.status)
    return json(result.value)
  } catch (e) {
    if (e instanceof ServerConfigError) {
      console.error('kitchen parcel: server config error')
      return json({ error: 'server_config' }, 500)
    }
    console.error('kitchen parcel: failed', e instanceof Error ? e.message : 'error') // codes only, no payloads
    return json({ error: 'server_error' }, 500)
  }
}
