import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase, ServerConfigError } from '@/lib/supabaseServer'
import { createOrderAtomic, OrderCreationUnavailableError } from '@/lib/createOrder'
import { isShopOpen } from '@/lib/hours'
import {
  buildOrderFromCatalog,
  parseCreateOrderRequest,
  type CatalogBranchPrice,
  type CatalogMenuItem,
  type CatalogTopping,
  type CreateOrderResponse,
  type OrderCatalog,
  type OrderErrorCode,
} from '@/lib/orderRequest'

// POST /api/orders — the only customer order-creation path.
// The request is untrusted: it carries order intent only (IDs, quantities, options, delivery address).
// All money is computed here from the database catalog via lib/pricing.

const NO_STORE = { 'Cache-Control': 'no-store' }

function errorResponse(status: number, code: OrderErrorCode, detail?: string) {
  return NextResponse.json(detail ? { error: code, detail } : { error: code }, { status, headers: NO_STORE })
}

export async function POST(req: NextRequest) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return errorResponse(400, 'invalid_request')
  }

  const parsed = parseCreateOrderRequest(body)
  if (!parsed.ok) return errorResponse(400, parsed.code, parsed.detail)
  const order = parsed.value

  if (!isShopOpen()) return errorResponse(409, 'closed')

  try {
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
    if (loadError) {
      console.error('orders: catalog load failed', loadError.code, loadError.message)
      return errorResponse(500, 'server_error')
    }
    if (!branchRes.data) return errorResponse(400, 'invalid_branch')

    const catalog: OrderCatalog = {
      items: new Map((itemsRes.data as CatalogMenuItem[] ?? []).map(i => [i.id, i])),
      prices: new Map((pricesRes.data as CatalogBranchPrice[] ?? []).map(p => [p.item_id, { ...p, price: Number(p.price) }])),
      toppings: new Map((toppingsRes.data as CatalogTopping[] ?? []).map(t => [t.id, { ...t, price: t.price === null ? null : Number(t.price) }])),
    }

    const built = buildOrderFromCatalog(order, catalog)
    if (!built.ok) return errorResponse(400, built.code, built.detail)

    const created = await createOrderAtomic(built.value.rpcArgs)

    const response: CreateOrderResponse = {
      id: created.orderId,
      dailyNumber: created.dailyNumber,
      type: order.type,
      total: built.value.breakdown.total,
      breakdown: built.value.breakdown,
      lines: built.value.lines,
    }
    return NextResponse.json(response, { status: 201, headers: NO_STORE })
  } catch (e) {
    if (e instanceof ServerConfigError) {
      console.error('orders: server config error —', e.message)
      return errorResponse(500, 'server_config')
    }
    if (e instanceof OrderCreationUnavailableError) {
      console.error('orders: create_order RPC not available yet')
      return errorResponse(503, 'order_creation_unavailable')
    }
    console.error('orders: unexpected error —', e instanceof Error ? e.message : e)
    return errorResponse(500, 'server_error')
  }
}
