import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import webpush from 'web-push'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

function configureWebPush() {
  const vapidSubject =
    process.env.VAPID_EMAIL ||
    process.env.VAPID_SUBJECT ||
    'mailto:falafel.b001@gmail.com'

  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
  const privateKey = process.env.VAPID_PRIVATE_KEY

  if (!publicKey || !privateKey) {
    throw new Error('Missing VAPID keys. Set NEXT_PUBLIC_VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY.')
  }

  webpush.setVapidDetails(vapidSubject, publicKey, privateKey)
}

export async function POST(req: NextRequest) {
  try {
    configureWebPush()

    const { phone, orderNumber } = await req.json()
    if (!phone) {
      return NextResponse.json({ error: 'Missing phone' }, { status: 400 })
    }

    const { data, error } = await supabase
      .from('push_subscriptions')
      .select('subscription')
      .eq('phone', phone)
      .single()

    if (error || !data) {
      return NextResponse.json({ error: 'No subscription found' }, { status: 404 })
    }

    const payload = JSON.stringify({
      title: '🔔 ההזמנה שלך מוכנה!',
      body: `הזמנה #${orderNumber} מוכנה לאיסוף — פלאפל בתחנה 🧆`,
    })

    await webpush.sendNotification(data.subscription, payload)

    return NextResponse.json({ success: true })
  } catch (e: any) {
    console.error('Push error:', e)
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
