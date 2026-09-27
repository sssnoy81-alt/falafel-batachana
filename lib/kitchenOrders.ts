// Kitchen read model (FALAFEL-SN-06C): branch scoping, minimal DB select, explicit normalization.
// Pure (no Supabase / network). Server-side use only — imports lib/kitchenAuth (node:crypto).

import { KITCHEN_BRANCH_IDS, type KitchenSession } from './kitchenAuth'
import type { KitchenOrder } from './kitchenTypes'

/* ─── Branch scope ─── */

export type BranchScope =
  | { ok: true; branchIds: string[] }
  | { ok: false; status: 400 | 403; error: 'invalid_request' | 'forbidden' }

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * Policy:
 *  - `branch` param must be absent, "all", or a lowercase UUID — anything else → 400.
 *  - branch user: always scoped to session.branchId. Absent or own id → OK. Any other value
 *    (incl. "all" or another branch) → 403 forbidden (explicit, never silently widened).
 *  - admin: absent / "all" → all known branches; a known branch UUID → that branch; unknown UUID → 400.
 */
export function resolveBranchScope(session: Pick<KitchenSession, 'role' | 'branchId'>, branchParam: string | null): BranchScope {
  const param = branchParam === null || branchParam === '' ? undefined : branchParam
  if (param !== undefined && param !== 'all' && !UUID_REGEX.test(param))
    return { ok: false, status: 400, error: 'invalid_request' }

  if (session.role === 'branch') {
    if (!session.branchId || !KITCHEN_BRANCH_IDS.includes(session.branchId))
      return { ok: false, status: 403, error: 'forbidden' }
    if (param === undefined || param === session.branchId) return { ok: true, branchIds: [session.branchId] }
    return { ok: false, status: 403, error: 'forbidden' }
  }

  if (param === undefined || param === 'all') return { ok: true, branchIds: [...KITCHEN_BRANCH_IDS] }
  if (KITCHEN_BRANCH_IDS.includes(param)) return { ok: true, branchIds: [param] }
  return { ok: false, status: 400, error: 'invalid_request' }
}

/* ─── Minimal select (never '*', never deliveries(*)) ─── */

export const KITCHEN_ORDER_SELECT = [
  'id', 'daily_number', 'type', 'status', 'created_at', 'customer_name', 'phone',
  'payment_method', 'total_price', 'branch_id',
  'branches(name)',
  'order_items(id, quantity, notes, menu_items(name_he))',
  'deliveries(address, notes, meal_quantity, meal_surcharge, delivery_fee)',
].join(', ')

/* ─── Response contract (types live in lib/kitchenTypes.ts, shared with the kitchen UI) ─── */

export type { KitchenDelivery, KitchenOrder, KitchenOrderItem } from './kitchenTypes'

/* ─── Normalization (explicit field-by-field; raw rows are never passed through) ─── */

type Row = Record<string, unknown>
const isRow = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v)
// PostgREST embeds may arrive as an object or a one-element array depending on relationship detection.
const one = (v: unknown): Row | null => (Array.isArray(v) ? (isRow(v[0]) ? v[0] : null) : isRow(v) ? v : null)
const many = (v: unknown): Row[] => (Array.isArray(v) ? v.filter(isRow) : isRow(v) ? [v] : [])
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const num = (v: unknown, fallback = 0): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) ? n : fallback
}

export function normalizeKitchenOrder(raw: unknown): KitchenOrder | null {
  if (!isRow(raw)) return null
  const id = str(raw.id), status = str(raw.status), createdAt = str(raw.created_at), branchId = str(raw.branch_id)
  if (!id || !status || !createdAt || !branchId) return null

  const type: 'pickup' | 'delivery' = raw.type === 'delivery' ? 'delivery' : 'pickup' // legacy NULL → pickup
  const d = type === 'delivery' ? one(raw.deliveries) : null

  return {
    id,
    dailyNumber: typeof raw.daily_number === 'number' ? raw.daily_number : null,
    type,
    status,
    createdAt,
    customerName: str(raw.customer_name),
    phone: str(raw.phone) ?? '',
    paymentMethod: str(raw.payment_method) ?? '',
    totalPrice: num(raw.total_price),
    branchId,
    branchName: str(one(raw.branches)?.name),
    items: many(raw.order_items).flatMap(it => {
      const itemId = str(it.id)
      if (!itemId) return []
      return [{
        id: itemId,
        name: str(one(it.menu_items)?.name_he) ?? 'פריט',
        quantity: num(it.quantity, 1),
        notes: str(it.notes),
      }]
    }),
    delivery: d && str(d.address)
      ? {
          address: str(d.address) as string,
          courierNotes: str(d.notes),
          mealQuantity: num(d.meal_quantity),
          mealSurcharge: num(d.meal_surcharge),
          deliveryFee: num(d.delivery_fee),
        }
      : null,
  }
}

export function normalizeKitchenOrders(rows: unknown): KitchenOrder[] {
  return (Array.isArray(rows) ? rows : []).map(normalizeKitchenOrder).filter((o): o is KitchenOrder => o !== null)
}
