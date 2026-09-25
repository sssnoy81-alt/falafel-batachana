import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase, ServerConfigError } from '@/lib/supabaseServer'
import { isUuid } from '@/lib/orderRequest'
import { normalizePhone, PHONE_REGEX } from '@/lib/orderConfig'

// POST /api/push/subscribe — { orderId, phone, subscription }
// Server-only DB access (no anon fallback). The subscription is attached to a real, recent order whose
// phone matches, and is stored by order_id (no more "delete everything for this phone").

const MAX_ORDER_AGE_MS = 6 * 60 * 60 * 1000

interface PushSubscriptionJson {
  endpoint: string
  expirationTime?: number | null
  keys: { p256dh: string; auth: string }
}

function isPushSubscription(v: unknown): v is PushSubscriptionJson {
  if (typeof v !== 'object' || v === null) return false
  const s = v as Record<string, unknown>
  const keys = s.keys as Record<string, unknown> | undefined
  return typeof s.endpoint === 'string' && s.endpoint.startsWith('https://') && s.endpoint.length <= 1000
    && typeof keys === 'object' && keys !== null
    && typeof keys.p256dh === 'string' && keys.p256dh.length > 0 && keys.p256dh.length <= 200
    && typeof keys.auth === 'string' && keys.auth.length > 0 && keys.auth.length <= 100
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 })
  }

  const { orderId, phone, subscription } = body ?? {}
  if (!isUuid(orderId)) return NextResponse.json({ error: 'invalid_order' }, { status: 400 })
  if (typeof phone !== 'string' || !PHONE_REGEX.test(normalizePhone(phone)))
    return NextResponse.json({ error: 'invalid_phone' }, { status: 400 })
  if (!isPushSubscription(subscription)) return NextResponse.json({ error: 'invalid_subscription' }, { status: 400 })

  try {
    const supabase = getServerSupabase()

    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('id, phone, created_at')
      .eq('id', orderId)
      .maybeSingle()
    if (orderError) {
      console.error('push subscribe: order lookup failed', orderError.code, orderError.message)
      return NextResponse.json({ error: 'server_error' }, { status: 500 })
    }
    // Same response for "no such order" and "phone mismatch" (no order enumeration).
    if (!order || normalizePhone(String(order.phone ?? '')) !== normalizePhone(phone))
      return NextResponse.json({ error: 'order_not_found' }, { status: 404 })
    if (Date.now() - new Date(order.created_at as string).getTime() > MAX_ORDER_AGE_MS)
      return NextResponse.json({ error: 'order_too_old' }, { status: 409 })

    // push_subscriptions has no verified UNIQUE(order_id) → replace via delete + insert (no upsert assumption).
    const { error: delError } = await supabase.from('push_subscriptions').delete().eq('order_id', orderId)
    if (delError) {
      console.error('push subscribe: cleanup failed', delError.code, delError.message)
      return NextResponse.json({ error: 'server_error' }, { status: 500 })
    }
    const { error: insError } = await supabase.from('push_subscriptions').insert({
      phone: normalizePhone(phone),
      order_id: orderId,
      subscription: { endpoint: subscription.endpoint, expirationTime: subscription.expirationTime ?? null, keys: subscription.keys },
    })
    if (insError) {
      console.error('push subscribe: insert failed', insError.code, insError.message)
      return NextResponse.json({ error: 'server_error' }, { status: 500 })
    }
    return NextResponse.json({ success: true })
  } catch (e) {
    if (e instanceof ServerConfigError) {
      console.error('push subscribe: server config error —', e.message)
      return NextResponse.json({ error: 'server_config' }, { status: 500 })
    }
    console.error('push subscribe: unexpected error —', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'server_error' }, { status: 500 })
  }
}
