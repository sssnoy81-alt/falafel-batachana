import { NextRequest, NextResponse } from 'next/server'
import { KITCHEN_BRANCH_IDS, publicUser } from '@/lib/kitchenAuth'
import { getKitchenSession } from '@/lib/kitchenUsers'
import { isKitchenDispatchAllowedFor } from '@/lib/kitchenDispatch'
import { isReconciliationAllowedFor } from '@/lib/kitchenReconciliation'
import { getServerSupabase, ServerConfigError } from '@/lib/supabaseServer'

// GET /api/kitchen/session — returns the authenticated kitchen user, or 401.
// Admin only: also returns the branch filter list [{ id, name }] for the known kitchen branches.
// Branch users get branches: [] (no DB access).
// maaleKitchenDispatchEnabled (S4-03M / 04C): whether THIS account may see courier-request controls — flag on AND the
// account is in the server-only allowlist (default false). The allowlist itself is never returned.

const NO_STORE = { 'Cache-Control': 'no-store' }
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE })

export async function GET(req: NextRequest) {
  const auth = await getKitchenSession(req)
  if (!auth.ok) return json({ error: auth.error }, auth.status)

  const base = {
    user: publicUser(auth.session),
    expiresAt: new Date(auth.session.exp * 1000).toISOString(),
    maaleKitchenDispatchEnabled: isKitchenDispatchAllowedFor(process.env, auth.session.username),
    // S4-04D: may THIS account record reconciliation events (manager allowlist). The list itself is never returned.
    maaleKitchenReconciliationEnabled: isReconciliationAllowedFor(process.env, auth.session.username),
  }
  if (auth.session.role !== 'admin') return json({ ...base, branches: [] })

  try {
    const { data, error } = await getServerSupabase()
      .from('branches')
      .select('id, name')
      .in('id', [...KITCHEN_BRANCH_IDS])
      .order('sort_order')
    if (error) {
      console.error('kitchen session: branch list failed', error.code)
      return json({ error: 'server_error' }, 500)
    }
    const branches = (data ?? [])
      .filter(b => typeof b.id === 'string' && typeof b.name === 'string')
      .map(b => ({ id: b.id as string, name: b.name as string }))
    return json({ ...base, branches })
  } catch (e) {
    if (e instanceof ServerConfigError) {
      console.error('kitchen session: server config error')
      return json({ error: 'server_config' }, 500)
    }
    console.error('kitchen session: unexpected error')
    return json({ error: 'server_error' }, 500)
  }
}
