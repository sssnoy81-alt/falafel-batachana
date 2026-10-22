import { NextRequest, NextResponse } from 'next/server'
import { checkSameOriginJson } from '@/lib/kitchenAuth'
import { getKitchenSession } from '@/lib/kitchenUsers'
import { isUuid } from '@/lib/kitchenMutations'
import {
  consumeQuoteSlotRpc, isKitchenDispatchAllowedFor, isKitchenDispatchEnabled, parseDispatchBody, requestKitchenDispatch,
} from '@/lib/kitchenDispatch'
import { defaultDispatchDeps, dispatchOrderToMaale } from '@/lib/maaleDispatch'
import { getServerSupabase, ServerConfigError } from '@/lib/supabaseServer'

// POST /api/kitchen/orders/[id]/dispatch — { expectedFeeAgorot }   (S4-INTEGRATIONS-03K, MANUAL courier request)
// DISABLED unless MAALE_KITCHEN_DISPATCH_ENABLED === 'true' → otherwise 404 before any session or DB access.
// The ONLY production dispatch entry point; kitchen-operated and manual (no automatic trigger anywhere).
// Then: same-origin JSON, DB-backed kitchen session, body + UUID; branch scope, stored fee and status from the DATABASE
// (lib/kitchenDispatch); every Maale gate again in lib/maaleDispatch (never test mode). No automatic dispatch, no retry.
// S4-04B: just before the provider quote, one slot of the durable rate limit (public.consume_maale_quote_slot).
// Responses and logs: short codes only — no API key, provider body, phone, address or DB error text.

const NO_STORE = { 'Cache-Control': 'no-store' }
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE })

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // Re-read on every request: turning the flag off takes effect immediately, with no DB access at all.
  if (!isKitchenDispatchEnabled(process.env)) return json({ error: 'not_found' }, 404)
  if (!checkSameOriginJson(req)) return json({ error: 'invalid_request' }, 400)
  const auth = await getKitchenSession(req)
  if (!auth.ok) return json({ error: auth.error }, auth.status)
  // S4-04C: only accounts listed exactly in MAALE_KITCHEN_DISPATCH_USERS. Everyone else gets the same 404 as "feature
  // off", before the body is read or any order / dispatch data is touched (no probing of orders or branches).
  if (!isKitchenDispatchAllowedFor(process.env, auth.session.username)) return json({ error: 'not_found' }, 404)

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return json({ error: 'invalid_request' }, 400)
  }
  const { id } = await params
  // Cheap input validation first, so malformed requests get 400 regardless of server config.
  const parsed = parseDispatchBody(body)
  if (!isUuid(id) || !parsed) return json({ error: 'invalid_request' }, 400)

  try {
    const supabase = getServerSupabase()
    const result = await requestKitchenDispatch({
      async loadOrder(orderId) {
        const { data, error } = await supabase.from('orders').select('id, branch_id, status, type, deliveries(delivery_fee)')
          .eq('id', orderId).maybeSingle()
        if (error) throw new Error(`load ${error.code}`)
        if (!data) return null
        const row = data as { id: string; branch_id: string | null; status: string; type: string | null; deliveries?: unknown }
        const d = Array.isArray(row.deliveries) ? row.deliveries[0] : row.deliveries
        const fee = d && typeof d === 'object' ? (d as { delivery_fee?: unknown }).delivery_fee : null
        return { id: row.id, branch_id: row.branch_id, status: row.status, type: row.type,
          delivery_fee: typeof fee === 'number' || typeof fee === 'string' ? fee : null }
      },
      // S4-04B: the durable quote rate limit is always wired here. Actor = the authenticated session's account; the branch
      // is supplied by the dispatch service from the DATABASE order. Missing function / SQL error → fail closed (503).
      dispatch: orderId => dispatchOrderToMaale(orderId, {
        ...defaultDispatchDeps(),
        consumeQuoteSlot: (id, branchId) => consumeQuoteSlotRpc(supabase, id, branchId, auth.session.username),
      }),
      async loadDispatchRow(orderId) {
        const { data, error } = await supabase.from('delivery_dispatches')
          .select('status, error_code, provider_order_id, provider_status').eq('order_id', orderId).maybeSingle()
        if (error) throw new Error(`dispatch row ${error.code}`)
        return (data as { status: 'pending' | 'sending' | 'sent' | 'failed_retryable' | 'failed_final'; error_code: string | null;
          provider_order_id: string | null; provider_status: string | null } | null) ?? null
      },
      log: code => console.warn('kitchen dispatch:', code),
    }, auth.session, id, parsed.expectedFeeAgorot)
    return json(result.body, result.status)
  } catch (e) {
    if (e instanceof ServerConfigError) {
      console.error('kitchen dispatch: server config error')
      return json({ error: 'server_config' }, 500)
    }
    console.error('kitchen dispatch: failed', e instanceof Error ? e.message : 'error') // codes only, no payloads
    return json({ error: 'server_error' }, 500)
  }
}
