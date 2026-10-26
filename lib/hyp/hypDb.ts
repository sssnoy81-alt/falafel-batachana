// SERVER-ONLY data access for the payment routes (HYP-07): the HYP-05 SECURITY DEFINER functions (EXECUTE: service_role
// only) and SELECT-only reads of the payment ledger. No direct write to any payment table exists here — service_role
// has SELECT only on them (HYP-05). Errors carry PostgREST codes only, never values or details.

import { getServerSupabase } from '../supabaseServer'
import type { CatalogBranchPrice, CatalogMenuItem, CatalogTopping, CreateOrderRequest, OrderCatalog } from '../orderRequest'

if (typeof window !== 'undefined') {
  throw new Error('lib/hyp/hypDb is server-only')
}

export class HypDbError extends Error {
  constructor(readonly op: string, readonly code: string) { super(`hyp_db_${op}_failed`); this.name = 'HypDbError' }
}

export interface HypIntentCreated { result: string; intentId: string | null; publicToken: string | null; hypOrderRef: string | null; status: string | null }
export interface HypReturnRecorded { result: string; returnId: string | null; intentId: string | null; publicToken: string | null; status: string | null }
export interface HypIntentForReturn { id: string; status: string; amountAgorot: number; hypOrderRef: string; terminalKind: 'test' | 'live'; publicToken: string }
export interface HypStoredReturn { id: string; intentId: string; returnRaw: string; verifyOutcome: string | null }
export interface HypFinalized { result: string; orderId: string | null; orderNumber: number | null; dailyNumber: number | null }

export interface HypDb {
  createIntent(a: { checkoutKey: string; terminalKind: 'test' | 'live'; orderKind?: 'plain' | 'parcel'; snapshot: object; amountAgorot: number; ttlSeconds: number }): Promise<HypIntentCreated>
  recordSignResult(intentId: string, redirected: boolean): Promise<{ result: string; status: string | null }>
  recordReturn(raw: string): Promise<HypReturnRecorded>
  recordVerification(args: { p_return_id: string; p_outcome: 'authentic' | 'rejected'; p_verify_response: string }): Promise<{ result: string; status: string | null }>
  finalize(intentId: string): Promise<HypFinalized>
  getIntentForReturn(intentId: string): Promise<HypIntentForReturn | null>
  getReturn(returnId: string): Promise<HypStoredReturn | null>
  getPublicStatus(token: string): Promise<{ status: string; orderId: string | null } | null>
  getOrderSummary(orderId: string): Promise<{ orderNumber: number | null; dailyNumber: number | null; status: string | null; type: string | null } | null>
  loadCatalog(order: CreateOrderRequest): Promise<OrderCatalog | 'invalid_branch'>
}

type Row = Record<string, unknown>
const first = (data: unknown): Row | null => (Array.isArray(data) ? (data[0] as Row | undefined) ?? null : (data as Row | null))
const str = (v: unknown) => (typeof v === 'string' ? v : null)
const num = (v: unknown) => (typeof v === 'number' ? v : null)

async function rpc(fn: string, args: Record<string, unknown>): Promise<Row> {
  const { data, error } = await getServerSupabase().rpc(fn, args)
  if (error) throw new HypDbError(fn, error.code ?? 'unknown')
  const row = first(data)
  if (!row) throw new HypDbError(fn, 'no_row')
  return row
}

export const supabaseHypDb: HypDb = {
  async createIntent(a) {
    const r = await rpc('create_payment_intent', { p_checkout_key: a.checkoutKey, p_terminal_kind: a.terminalKind, p_order_kind: a.orderKind ?? 'plain',
                                                   p_snapshot: a.snapshot, p_amount_agorot: a.amountAgorot, p_ttl_seconds: a.ttlSeconds })
    return { result: String(r.result), intentId: str(r.intent_id), publicToken: str(r.public_token), hypOrderRef: str(r.hyp_order_ref), status: str(r.intent_status) }
  },
  async recordSignResult(intentId, redirected) {
    const r = await rpc('record_hyp_sign_result', { p_intent_id: intentId, p_redirected: redirected })
    return { result: String(r.result), status: str(r.intent_status) }
  },
  async recordReturn(raw) {
    const r = await rpc('record_hyp_return', { p_return_raw: raw })
    return { result: String(r.result), returnId: str(r.return_id), intentId: str(r.intent_id), publicToken: str(r.public_token), status: str(r.intent_status) }
  },
  async recordVerification(args) {
    const r = await rpc('record_hyp_verification', args)
    return { result: String(r.result), status: str(r.intent_status) }
  },
  async finalize(intentId) {
    const r = await rpc('finalize_paid_intent', { p_intent_id: intentId, p_staff_user: null })
    return { result: String(r.result), orderId: str(r.order_id), orderNumber: num(r.order_number), dailyNumber: num(r.daily_number) }
  },
  async getIntentForReturn(intentId) {
    const { data, error } = await getServerSupabase().from('payment_intents')
      .select('id, status, amount_agorot, hyp_order_ref, terminal_kind, public_token').eq('id', intentId).maybeSingle()
    if (error) throw new HypDbError('intent', error.code ?? 'unknown')
    if (!data) return null
    const d = data as Row
    return { id: String(d.id), status: String(d.status), amountAgorot: Number(d.amount_agorot), hypOrderRef: String(d.hyp_order_ref),
             terminalKind: d.terminal_kind === 'live' ? 'live' : 'test', publicToken: String(d.public_token) }
  },
  async getReturn(returnId) {
    const { data, error } = await getServerSupabase().from('payment_returns')
      .select('id, intent_id, return_raw, verify_outcome').eq('id', returnId).maybeSingle()
    if (error) throw new HypDbError('return', error.code ?? 'unknown')
    if (!data) return null
    const d = data as Row
    return { id: String(d.id), intentId: String(d.intent_id), returnRaw: String(d.return_raw), verifyOutcome: str(d.verify_outcome) }
  },
  async getPublicStatus(token) {
    const { data, error } = await getServerSupabase().from('payment_intents').select('status, order_id').eq('public_token', token).maybeSingle()
    if (error) throw new HypDbError('status', error.code ?? 'unknown')
    return data ? { status: String((data as Row).status), orderId: str((data as Row).order_id) } : null
  },
  async getOrderSummary(orderId) {
    const { data, error } = await getServerSupabase().from('orders').select('order_number, daily_number, status, type').eq('id', orderId).maybeSingle()
    if (error) throw new HypDbError('order', error.code ?? 'unknown')
    if (!data) return null
    const d = data as Row
    return { orderNumber: num(d.order_number), dailyNumber: num(d.daily_number), status: str(d.status), type: str(d.type) }
  },
  // Same catalog reads as POST /api/orders (app/api/orders/route.ts), unchanged there.
  async loadCatalog(order) {
    const supabase = getServerSupabase()
    const itemIds = [...new Set(order.items.map(i => i.itemId))]
    const toppingIds = [...new Set(order.items.flatMap(i => [...i.sauceIds, ...i.saladIds, ...i.paidAddonIds]))]
    const [branchRes, itemsRes, pricesRes, toppingsRes] = await Promise.all([
      supabase.from('branches').select('id').eq('id', order.branchId).maybeSingle(),
      supabase.from('menu_items').select('id, category_id, is_active, has_lettuce, has_pita, has_egg').in('id', itemIds),
      supabase.from('branch_prices').select('item_id, price, is_available').eq('branch_id', order.branchId).in('item_id', itemIds),
      toppingIds.length > 0
        ? supabase.from('toppings').select('id, name_he, type, price').in('id', toppingIds)
        : Promise.resolve({ data: [] as CatalogTopping[], error: null }),
    ])
    const loadError = branchRes.error || itemsRes.error || pricesRes.error || toppingsRes.error
    if (loadError) throw new HypDbError('catalog', loadError.code ?? 'unknown')
    if (!branchRes.data) return 'invalid_branch'
    return {
      items: new Map((itemsRes.data as CatalogMenuItem[] ?? []).map(i => [i.id, i])),
      prices: new Map((pricesRes.data as CatalogBranchPrice[] ?? []).map(p => [p.item_id, { ...p, price: Number(p.price) }])),
      toppings: new Map((toppingsRes.data as CatalogTopping[] ?? []).map(t => [t.id, { ...t, price: t.price === null ? null : Number(t.price) }])),
    }
  },
}
