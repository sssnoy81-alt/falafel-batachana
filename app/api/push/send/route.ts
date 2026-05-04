import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import webpush from 'web-push'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

webpush.setVapidDetails(
  process.env.VAPID_EMAIL!,
  process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!,
  process.env.VAPID_PRIVATE_KEY!
)

export async function POST(req: NextRequest) {
  try {
    const { phone, orderNumber } = await req.json()
    if (!phone) return NextResponse.json({ error: 'Missing phone' }, { status: 400 })

    // מצא subscription
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