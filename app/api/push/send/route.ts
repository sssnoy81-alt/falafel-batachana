import { NextRequest, NextResponse } from 'next/server'
import webpush, { type PushSubscription } from 'web-push'
import { getServerSupabase, ServerConfigError } from '@/lib/supabaseServer'
import { isUuid } from '@/lib/orderRequest'

// POST /api/push/send — { orderId } only.
// Status and wording come from the database, never from the caller: a notification is sent only when
// the order's actual status is 'ready'. Server-only DB access, no anon fallback.

function configureWebPush() {
  const vapidSubject = process.env.VAPID_EMAIL || process.env.VAPID_SUBJECT || 'mailto:falafel.b001@gmail.com'
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
  const privateKey = process.env.VAPID_PRIVATE_KEY
  if (!publicKey || !privateKey) throw new ServerConfigError('Missing VAPID keys (NEXT_PUBLIC_VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY)')
  webpush.setVapidDetails(vapidSubject, publicKey, privateKey)
}

function buildMessage(type: string | null, dailyNumber: number | null, orderId: string) {
  const num = dailyNumber ? String(dailyNumber).padStart(4, '0') : orderId.slice(-4).toUpperCase()
  if (type === 'delivery') return { title: '🛵 ההזמנה שלך בדרך!', body: `🛵 הזמנה #${num} מוכנה ויוצאת למשלוח` }
  // pickup + legacy NULL type
  return { title: '🔔 ההזמנה שלך מוכנה!', body: `🔔 הזמנה #${num} מוכנה לאיסוף` }
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 })
  }
  const orderId = body?.orderId
  if (!isUuid(orderId)) return NextResponse.json({ error: 'invalid_order' }, { status: 400 })

  try {
    configureWebPush()
    const supabase = getServerSupabase()

    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('id, status, type, daily_number')
      .eq('id', orderId)
      .maybeSingle()
    if (orderError) {
      console.error('push send: order lookup failed', orderError.code, orderError.message)
      return NextResponse.json({ error: 'server_error' }, { status: 500 })
    }
    if (!order) return NextResponse.json({ error: 'order_not_found' }, { status: 404 })
    if (order.status !== 'ready') return NextResponse.json({ error: 'order_not_ready' }, { status: 409 })

    const { data: subs, error: subError } = await supabase
      .from('push_subscriptions')
      .select('subscription')
      .eq('order_id', orderId)
      .limit(5)
    if (subError) {
      console.error('push send: subscription lookup failed', subError.code, subError.message)
      return NextResponse.json({ error: 'server_error' }, { status: 500 })
    }
    if (!subs || subs.length === 0) return NextResponse.json({ error: 'no_subscription' }, { status: 404 })

    const payload = JSON.stringify(buildMessage(order.type as string | null, order.daily_number as number | null, orderId))

    let sent = 0
    let expired = false
    for (const s of subs) {
      try {
        await webpush.sendNotification(s.subscription as PushSubscription, payload)
        sent++
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode
        if (statusCode === 404 || statusCode === 410) expired = true
        else console.error('push send: delivery failed', statusCode)
      }
    }
    if (expired && sent === 0) {
      // Subscription is gone on the push service side — remove it.
      await supabase.from('push_subscriptions').delete().eq('order_id', orderId)
    }

    return NextResponse.json({ success: sent > 0, sent })
  } catch (e) {
    if (e instanceof ServerConfigError) {
      console.error('push send: server config error —', e.message)
      return NextResponse.json({ error: 'server_config' }, { status: 500 })
    }
    console.error('push send: unexpected error —', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'server_error' }, { status: 500 })
  }
}
