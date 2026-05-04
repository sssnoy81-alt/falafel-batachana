import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

// ─── Rate limiter (in-memory) ───
const rateLimitMap = new Map<string, { count: number; resetAt: number }>()
const MAX_ORDERS = 3        // מקסימום הזמנות
const WINDOW_MS  = 10 * 60 * 1000  // תוך 10 דקות

function isRateLimited(ip: string): boolean {
  const now = Date.now()
  const entry = rateLimitMap.get(ip)

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + WINDOW_MS })
    return false
  }

  if (entry.count >= MAX_ORDERS) return true

  entry.count++
  return false
}

// ─── Supabase (service_role — בצד שרת בלבד) ───
const supabase = createClient(
  'https://sqgnrzcmjhwgfjxocvlr.supabase.co',
  process.env.SUPABASE_SERVICE_KEY!
)

export async function POST(req: NextRequest) {
  // קבל IP
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown'

  // בדוק rate limit
  if (isRateLimited(ip)) {
    return NextResponse.json(
      { error: 'יותר מדי הזמנות — נסה שוב בעוד 10 דקות' },
      { status: 429 }
    )
  }

  try {
    const body = await req.json()
    const {
      branch_id, phone, customer_name,
      payment_method, total_price, daily_number, items
    } = body

    // ולידציה בסיסית
    if (!branch_id || !phone || !customer_name || !items?.length) {
      return NextResponse.json({ error: 'נתונים חסרים' }, { status: 400 })
    }
    if (!/^05\d{8}$/.test(phone.replace(/[-\s]/g, ''))) {
      return NextResponse.json({ error: 'מספר טלפון לא תקין' }, { status: 400 })
    }
    if (customer_name.trim().length < 2) {
      return NextResponse.json({ error: 'שם לא תקין' }, { status: 400 })
    }

    // צור הזמנה
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .insert([{ branch_id, phone: phone.replace(/[-\s]/g, ''), customer_name: customer_name.trim(), payment_method, status: 'received', total_price, daily_number }])
      .select()
      .single()

    if (orderError || !order) {
      return NextResponse.json({ error: orderError?.message }, { status: 500 })
    }

    // צור פריטים
    const { error: itemsError } = await supabase
      .from('order_items')
      .insert(items.map((item: any) => ({ ...item, order_id: order.id })))

    if (itemsError) {
      return NextResponse.json({ error: itemsError.message }, { status: 500 })
    }

    return NextResponse.json({ id: order.id })
  } catch (e) {
    return NextResponse.json({ error: 'שגיאה פנימית' }, { status: 500 })
  }
}