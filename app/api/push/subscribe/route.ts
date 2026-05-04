import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

export async function POST(req: NextRequest) {
  try {
    const { subscription, phone, orderId } = await req.json()
    if (!subscription || !phone) {
      return NextResponse.json({ error: 'Missing data' }, { status: 400 })
    }

    // מחק subscription ישן לאותו טלפון
    await supabase.from('push_subscriptions').delete().eq('phone', phone)

    // שמור חדש
    const { error } = await supabase.from('push_subscriptions').insert({
      phone,
      order_id: orderId,
      subscription,
    })

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true })
  } catch (e) {
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}