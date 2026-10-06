import { NextRequest, NextResponse } from 'next/server'
import { checkSameOriginJson } from '@/lib/kitchenAuth'
import { getKitchenSession } from '@/lib/kitchenUsers'
import { editItemNotes, isUuid, parseNotesBody } from '@/lib/kitchenMutations'
import { getServerSupabase, ServerConfigError } from '@/lib/supabaseServer'

// PATCH /api/kitchen/order-items/[id]/notes — { notes: string | null }  (≤ 500 chars, empty → null)
// Kitchen session + same-origin JSON. Parent order must be in the session's branch scope and in
// status confirmed/preparing (same as the current edit button). Updates only that order_items row.

const NO_STORE = { 'Cache-Control': 'no-store' }
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE })

type Row = Record<string, unknown>
const one = (v: unknown): Row | null =>
  Array.isArray(v) ? ((v[0] as Row) ?? null) : typeof v === 'object' && v !== null ? (v as Row) : null

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
  if (!isUuid(id) || parseNotesBody(body) === undefined) return json({ error: 'invalid_request' }, 400)

  try {
    const supabase = getServerSupabase()
    const result = await editItemNotes({
      async loadItem(itemId) {
        const { data, error } = await supabase.from('order_items').select('id, orders(branch_id, status)').eq('id', itemId).maybeSingle()
        if (error) throw new Error(`load ${error.code}`)
        if (!data) return null
        const parent = one((data as Row).orders)
        return {
          id: String((data as Row).id),
          orderBranchId: typeof parent?.branch_id === 'string' ? parent.branch_id : null,
          orderStatus: typeof parent?.status === 'string' ? parent.status : null,
        }
      },
      async updateNotes(itemId, notes) {
        const { data, error } = await supabase.from('order_items').update({ notes }).eq('id', itemId).select('id')
        if (error) throw new Error(`update ${error.code}`)
        return Array.isArray(data) && data.length === 1
      },
    }, auth.session, id, body)

    if (!result.ok) return json({ error: result.error }, result.status)
    return json(result.value)
  } catch (e) {
    if (e instanceof ServerConfigError) {
      console.error('kitchen notes: server config error')
      return json({ error: 'server_config' }, 500)
    }
    console.error('kitchen notes: failed', e instanceof Error ? e.message : 'error')
    return json({ error: 'server_error' }, 500)
  }
}
