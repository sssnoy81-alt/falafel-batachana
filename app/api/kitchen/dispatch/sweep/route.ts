import { NextRequest, NextResponse } from 'next/server'
import { checkSameOriginJson, KITCHEN_BRANCH_IDS } from '@/lib/kitchenAuth'
import { getKitchenSession } from '@/lib/kitchenUsers'
import { isAutoDispatchEnabled, sweepAutoDispatch } from '@/lib/kitchenAutoDispatch'
import { productionAutoDispatchDeps } from '@/lib/kitchenAutoDispatchServer'
import { ServerConfigError } from '@/lib/supabaseServer'

// POST /api/kitchen/dispatch/sweep — {}   (S4-MAALE-03, fallback for the automatic courier request)
// DISABLED unless MAALE_AUTO_DISPATCH_ENABLED === 'true' → otherwise 404 before any session or DB access.
// Called by the kitchen dashboard about once a minute: processes due tasks of public.maale_auto_dispatch_queue (queued, or
// processing and stale) in the session's branch scope only (admin: every branch). Tasks exist only because the database
// queued a real confirmation; this route never creates one, never retries an uncertain send and returns counts only.

const NO_STORE = { 'Cache-Control': 'no-store' }
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE })

export async function POST(req: NextRequest) {
  if (!isAutoDispatchEnabled(process.env)) return json({ error: 'not_found' }, 404)
  if (!checkSameOriginJson(req)) return json({ error: 'invalid_request' }, 400)
  const auth = await getKitchenSession(req)
  if (!auth.ok) return json({ error: auth.error }, auth.status)

  const scope = auth.session.role === 'admin' ? null
    : auth.session.branchId && KITCHEN_BRANCH_IDS.includes(auth.session.branchId) ? [auth.session.branchId] : []
  if (scope && scope.length === 0) return json({ processed: 0, finished: 0 })

  try {
    return json(await sweepAutoDispatch(productionAutoDispatchDeps(), scope))
  } catch (e) {
    if (e instanceof ServerConfigError) { console.error('kitchen auto dispatch: server config error'); return json({ error: 'server_config' }, 500) }
    console.error('kitchen auto dispatch: sweep failed', e instanceof Error ? e.message : 'error')   // codes only
    return json({ error: 'server_error' }, 500)
  }
}
