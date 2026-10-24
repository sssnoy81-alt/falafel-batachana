import { getKitchenSession } from '@/lib/kitchenUsers'
import { getServerSupabase, ServerConfigError } from '@/lib/supabaseServer'
import { handleKitchenPayments, RECONCILIATION_SELECT, RECONCILIATION_STATUSES } from '@/lib/hyp/hypReconciliation'
import { isStaffRecoveryAllowedFor } from '@/lib/hyp/hypStaffRecovery'

// GET /api/kitchen/payments[?branch=all|<branch uuid>] — READ ONLY (HYP-08).
// Staff payment reconciliation list: kitchen session required, branch scope as GET /api/kitchen/orders.
// The service-role read is used only after the staff session and scope checks; nothing here writes or calls an RPC.

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  return handleKitchenPayments(req, {
    getSession: async r => await getKitchenSession(r),
    fetchIntents: async branchIds => {
      try {
        const { data, error } = await getServerSupabase().from('payment_intents').select(RECONCILIATION_SELECT)
          .in('branch_id', branchIds)
          .or(`status.in.(${RECONCILIATION_STATUSES.join(',')}),duplicate_charge_at.not.is.null,staff_flag.not.is.null`)
          .order('created_at', { ascending: false })
          .limit(200)
        return { data, error }
      } catch (e) {
        return { data: null, error: { code: e instanceof ServerConfigError ? 'server_config' : 'unexpected' } }
      }
    },
    canRecover: session => isStaffRecoveryAllowedFor(process.env, session),
    now: () => new Date(),
    log: (event, code) => console.error(`kitchen payments: ${event}${code ? ` ${code}` : ''}`),
  })
}
