// Production wiring of the auto-dispatch worker (S4-MAALE-03): Supabase service-role reads / conditional updates of
// public.maale_auto_dispatch_queue (s4_05) and the existing dispatch service with the AUTO_DISPATCH_ACTOR quote slot.
// Mirrors POST /api/kitchen/orders/[id]/dispatch: same order load, same reconciliation block, same Maale gates.

import { consumeQuoteSlotRpc } from './kitchenDispatch'
import { defaultDispatchDeps, dispatchOrderToMaale } from './maaleDispatch'
import { isReconciliationEnabled } from './kitchenReconciliation'
import { dispatchBlockReason } from './kitchenReconciliationUi'
import { getServerSupabase } from './supabaseServer'
import { AUTO_DISPATCH_ACTOR, type AutoDispatchDeps, type AutoDispatchTask } from './kitchenAutoDispatch'

const TASK_SELECT = 'order_id, branch_id, state, reason_code, attempts, enqueued_at, claimed_at'
const code = (e: { code?: string } | null) => (e && typeof e.code === 'string' && /^[A-Z0-9]{1,8}$/.test(e.code) ? e.code : 'error')

export function productionAutoDispatchDeps(): AutoDispatchDeps {
  const supabase = getServerSupabase()
  const queue = () => supabase.from('maale_auto_dispatch_queue')
  const log = (c: string) => console.warn('kitchen auto dispatch:', c)
  return {
    async loadTask(orderId) {
      const { data, error } = await queue().select(TASK_SELECT).eq('order_id', orderId).maybeSingle()
      if (error) throw new Error(`task ${code(error)}`)
      return (data as AutoDispatchTask | null) ?? null
    },
    async claim(task, nowIso) {
      // attempts grows by exactly one per claim (database guard), so it is the compare-and-set token
      const { data, error } = await queue().update({ state: 'processing', attempts: task.attempts + 1, claimed_at: nowIso, updated_at: nowIso })
        .eq('order_id', task.order_id).eq('state', task.state).eq('attempts', task.attempts).select('order_id')
      if (error) { log(`claim_${code(error)}`); return false }
      return Array.isArray(data) && data.length === 1
    },
    async finish(orderId, from, to, reason, nowIso) {
      const { data, error } = await queue().update({ state: to, reason_code: reason, updated_at: nowIso })
        .eq('order_id', orderId).eq('state', from).select('order_id')
      if (error) { log(`finish_${code(error)}`); return false }
      return Array.isArray(data) && data.length === 1
    },
    async listDue(branchIds, staleBeforeIso, limit) {
      let q = queue().select(TASK_SELECT).or(`state.eq.queued,and(state.eq.processing,claimed_at.lt.${staleBeforeIso})`)
      if (branchIds) q = q.in('branch_id', [...branchIds])
      const { data, error } = await q.order('enqueued_at', { ascending: true }).limit(limit)
      if (error) throw new Error(`due ${code(error)}`)
      return (Array.isArray(data) ? data : []) as AutoDispatchTask[]
    },
    async loadOrder(orderId) {
      const { data, error } = await supabase.from('orders').select('id, branch_id, status, type, deliveries(delivery_fee)').eq('id', orderId).maybeSingle()
      if (error) throw new Error(`load ${code(error)}`)
      if (!data) return null
      const row = data as { id: string; branch_id: string | null; status: string; type: string | null; deliveries?: unknown }
      const d = Array.isArray(row.deliveries) ? row.deliveries[0] : row.deliveries
      const fee = d && typeof d === 'object' ? (d as { delivery_fee?: unknown }).delivery_fee : null
      return { id: row.id, branch_id: row.branch_id, status: row.status, type: row.type,
        delivery_fee: typeof fee === 'number' || typeof fee === 'string' ? fee : null }
    },
    ...(isReconciliationEnabled(process.env) ? {
      async dispatchBlockingRecord(orderId: string) {
        const { data, error } = await supabase.from('maale_dispatch_reconciliations').select('event_type').eq('order_id', orderId)
        if (error) throw new Error(`ledger ${code(error)}`)
        return dispatchBlockReason((Array.isArray(data) ? data : []).map(r => (r as { event_type?: unknown }).event_type))
      },
    } : {}),
    dispatch: orderId => dispatchOrderToMaale(orderId, {
      ...defaultDispatchDeps(),
      consumeQuoteSlot: (id, branchId) => consumeQuoteSlotRpc(supabase, id, branchId, AUTO_DISPATCH_ACTOR),
    }),
    async repairMissing(branchIds) {
      const { data, error } = await supabase.rpc('enqueue_missing_maale_auto_dispatch', { p_branch_ids: branchIds ? [...branchIds] : null })
      if (error) throw new Error(`repair ${code(error)}`)
      return typeof data === 'number' ? data : 0
    },
    now: () => Date.now(),
    log,
  }
}
