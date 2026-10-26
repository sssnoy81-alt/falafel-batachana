import { after, NextRequest, NextResponse } from 'next/server'
import { checkSameOriginJson } from '@/lib/kitchenAuth'
import { getKitchenSession } from '@/lib/kitchenUsers'
import { changeOrderStatus, isUuid, ParcelNotReadyError, ParcelStateRejectedError, parseStatusBody, type OrderStatusValue } from '@/lib/kitchenMutations'
import { parcelStatusFromEmbed } from '@/lib/parcelRequest'
import { sendReadyPush } from '@/lib/push'
import { getServerSupabase, ServerConfigError } from '@/lib/supabaseServer'
import { isAutoDispatchEnabled, runAutoDispatchAfterConfirmation } from '@/lib/kitchenAutoDispatch'
import { productionAutoDispatchDeps } from '@/lib/kitchenAutoDispatchServer'

// PATCH /api/kitchen/orders/[id]/status — { status }
// Kitchen session + same-origin JSON. Branch scope from the session only. Locked transition table,
// conditional update (id AND current status) against concurrent tablets. On 'ready' the server sends
// the push itself; a push failure never rolls back the status change.
// Parcel gate (GATE 03H): the order's parcel status is loaded with the order; leaving 'received' (other than
// by cancellation) requires the parcel to be found or cancelled → 409 parcel_not_ready. A database refusal
// with 'parcel_not_ready' (Migration 03 gate trigger) maps to the same 409. Cancelling an order whose parcel is
// still in the store is completed by the Migration 03 sync trigger in the same transaction (GATE S2b); a parcel
// rule rejecting that sync (22023 parcel_*) maps to 409 invalid_state and leaves the order unchanged.
// Timestamps: current production code only writes `status` (confirmed_at/ready_at/delivered_at are not
// maintained by the app or by an active trigger) — this route preserves that behavior exactly.
// S4-MAALE-03: received → confirmed of a delivery order is queued for an automatic courier request BY THE DATABASE, in
// the same transaction (s4_05 trigger, switch public.maale_auto_dispatch_config). With MAALE_AUTO_DISPATCH_ENABLED the
// worker runs AFTER the response (the kitchen never waits for Maale); a lost run or a failed enqueue (S4-MAALE-02:
// the confirmation still commits) is picked up by the repair + dashboard sweep
// (POST /api/kitchen/dispatch/sweep). The response is unchanged.

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
        const { data, error } = await supabase.from('orders').select('id, status, branch_id, parcel_requests(status)')
          .eq('id', orderId).maybeSingle()
        if (error) throw new Error(`load ${error.code}`)
        if (!data) return null
        const row = data as { id: string; status: string; branch_id: string | null; parcel_requests?: unknown }
        return { id: row.id, status: row.status, branch_id: row.branch_id, parcel_status: parcelStatusFromEmbed(row.parcel_requests) }
      },
      async updateStatusIfCurrent(orderId, from, to: OrderStatusValue) {
        const { data, error } = await supabase.from('orders').update({ status: to })
          .eq('id', orderId).eq('status', from).select('id')
        if (error) {
          if (error.code === 'P0001' && error.message === 'parcel_not_ready') throw new ParcelNotReadyError()
          // Migration 03 cancel sync: a parcel rule of parcel_requests_before_write() rejected the parcel change
          if (error.code === '22023' && /^parcel_[a-z_]+$/.test(error.message)) throw new ParcelStateRejectedError()
          throw new Error(`update ${error.code}`)
        }
        return Array.isArray(data) && data.length === 1
      },
      sendReadyPush,
    }, auth.session, id, body)

    if (!result.ok) return json({ error: result.error }, result.status)
    if (result.value.status === 'confirmed' && isAutoDispatchEnabled(process.env)) {
      // S4-MAALE-02: a missing task (enqueue failed) is repaired in the session's branch scope, then run once more.
      const scope = auth.session.role === 'admin' ? null : auth.session.branchId ? [auth.session.branchId] : []
      after(async () => {
        try { await runAutoDispatchAfterConfirmation(productionAutoDispatchDeps(), id, scope) } catch { console.warn('kitchen auto dispatch: run_failed') }
      })
    }
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
