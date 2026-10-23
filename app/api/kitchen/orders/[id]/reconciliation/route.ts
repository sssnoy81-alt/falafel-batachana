import { NextRequest, NextResponse } from 'next/server'
import { checkSameOriginJson } from '@/lib/kitchenAuth'
import { getKitchenSession } from '@/lib/kitchenUsers'
import { isUuid } from '@/lib/kitchenMutations'
import {
  isReconciliationAllowedFor, isReconciliationEnabled, parseReconciliationBody, ReconciliationUnavailableError, requestReconciliation,
} from '@/lib/kitchenReconciliation'
import { getServerSupabase, ServerConfigError } from '@/lib/supabaseServer'

// POST /api/kitchen/orders/[id]/reconciliation — { requestId, eventType, providerOrderId?, providerStatus?, reasonCode?,
// confirmCancellation? }   (S4-INTEGRATIONS-04D2/04D3, manager-only courier reconciliation RECORD)
// requestId: one per user-confirmed action; a retry reuses it. UNIQUE (request_id) in the database is the final guard.
// S4-04E2: the record is written ONLY by public.record_maale_reconciliation_event (no direct INSERT — service_role has
// none after the 04E migration); the actor is the authenticated session's username, never a browser value.
// DISABLED unless MAALE_KITCHEN_RECONCILIATION_ENABLED === 'true' → otherwise 404 before any session or DB access.
// Then: same-origin JSON, DB-backed kitchen session, manager allowlist (same 404 otherwise), body + UUID; branch scope and
// dispatch consistency from the DATABASE (lib/kitchenReconciliation). Appends at most ONE row to maale_dispatch_reconciliations.
// Never changes orders / delivery_dispatches, never calls the provider, never retries / resets / re-dispatches.
// Responses and logs: short codes only.

const NO_STORE = { 'Cache-Control': 'no-store' }
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE })
// Coordination function / ledger missing (04E not installed) or the per-order lock timed out → 503, nothing stored;
// the browser may retry with the SAME requestId.
const UNAVAILABLE = ['42P01', '42883', 'PGRST202', 'PGRST205', 'PGRST204', 'PGRST200', '55P03']

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isReconciliationEnabled(process.env)) return json({ error: 'not_found' }, 404)
  if (!checkSameOriginJson(req)) return json({ error: 'invalid_request' }, 400)
  const auth = await getKitchenSession(req)
  if (!auth.ok) return json({ error: auth.error }, auth.status)
  // Manager accounts only — everyone else gets the same 404 as "feature off", before the body or any order data is read.
  if (!isReconciliationAllowedFor(process.env, auth.session.username)) return json({ error: 'not_found' }, 404)

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return json({ error: 'invalid_request' }, 400)
  }
  const { id } = await params
  const input = parseReconciliationBody(body)
  if (!isUuid(id) || !input) return json({ error: 'invalid_request' }, 400)

  try {
    const supabase = getServerSupabase()
    const result = await requestReconciliation({
      async loadOrder(orderId) {
        const { data, error } = await supabase.from('orders').select('id, branch_id, type').eq('id', orderId).maybeSingle()
        if (error) throw new Error(`load ${error.code}`)
        return (data as { id: string; branch_id: string | null; type: string | null } | null) ?? null
      },
      async loadDispatch(orderId) {
        const { data, error } = await supabase.from('delivery_dispatches').select('status, provider_order_id').eq('order_id', orderId).maybeSingle()
        if (error) throw new Error(`dispatch ${error.code}`)
        return (data as { status: string; provider_order_id: string | null } | null) ?? null
      },
      async recordEvent(row) {
        const { data, error } = await supabase.rpc('record_maale_reconciliation_event', {
          p_request_id: row.request_id, p_order_id: row.order_id, p_event_type: row.event_type, p_actor: row.actor_username,
          p_provider_order_id: row.provider_order_id, p_provider_status: row.provider_status, p_reason_code: row.reason_code,
        })
        if (error) { if (UNAVAILABLE.includes(error.code ?? '')) throw new ReconciliationUnavailableError(); throw new Error(`record ${error.code}`) }
        // RETURNS TABLE → exactly one row; anything else is unexpected (fails closed in the service).
        const r: unknown = Array.isArray(data) && data.length === 1 ? data[0] : null
        if (!r || typeof r !== 'object' || typeof (r as { result?: unknown }).result !== 'string') throw new Error('record unexpected payload')
        const { result, event_id, event_created_at } = r as { result: string; event_id: unknown; event_created_at: unknown }
        return { result, event_id: typeof event_id === 'string' ? event_id : null, event_created_at: typeof event_created_at === 'string' ? event_created_at : null }
      },
      log: code => console.warn('kitchen reconciliation:', code),
    }, auth.session, id, input)
    return json(result.body, result.status)
  } catch (e) {
    if (e instanceof ReconciliationUnavailableError) return json({ error: 'reconciliation_unavailable' }, 503)
    if (e instanceof ServerConfigError) {
      console.error('kitchen reconciliation: server config error')
      return json({ error: 'server_config' }, 500)
    }
    console.error('kitchen reconciliation: failed') // no payloads, no DB error text
    return json({ error: 'server_error' }, 500)
  }
}
