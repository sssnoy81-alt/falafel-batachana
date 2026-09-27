import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase, ServerConfigError } from '@/lib/supabaseServer'
import { isUuid } from '@/lib/orderRequest'

// GET /api/orders/[id]/status — minimal customer tracking.
// The random order UUID acts as the capability. Returns ONLY id, dailyNumber, status, type.
// Never returns name, phone, address, prices or the full row.

const NO_STORE = { 'Cache-Control': 'no-store' }

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'invalid_id' }, { status: 400, headers: NO_STORE })

  try {
    const supabase = getServerSupabase()
    const { data, error } = await supabase
      .from('orders')
      .select('id, daily_number, status, type')
      .eq('id', id)
      .maybeSingle()

    if (error) {
      console.error('order status: query failed', error.code, error.message)
      return NextResponse.json({ error: 'server_error' }, { status: 500, headers: NO_STORE })
    }
    if (!data) return NextResponse.json({ error: 'not_found' }, { status: 404, headers: NO_STORE })

    return NextResponse.json(
      {
        id: data.id as string,
        dailyNumber: (data.daily_number as number | null) ?? null,
        status: data.status as string,
        type: (data.type as string | null) ?? null, // legacy orders: NULL → treated as pickup by the UI
      },
      { headers: NO_STORE },
    )
  } catch (e) {
    if (e instanceof ServerConfigError) {
      console.error('order status: server config error —', e.message)
      return NextResponse.json({ error: 'server_config' }, { status: 500, headers: NO_STORE })
    }
    console.error('order status: unexpected error —', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'server_error' }, { status: 500, headers: NO_STORE })
  }
}
