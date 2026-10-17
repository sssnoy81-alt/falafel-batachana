import { NextResponse } from 'next/server'
import { isParcelCheckoutEnabled } from '@/lib/parcelCheckout'

// GET /api/checkout/config — public, read-only checkout capabilities for app/order (GATE S4-B).
// Exposes ONLY a boolean derived from the server flag PARCEL_CHECKOUT_ENABLED (never the raw value, never any other
// configuration). The customer page treats anything but `parcelCheckout: true` as disabled (fail closed), and
// POST /api/orders stays authoritative: it rejects a parcel whenever the flag is off, whatever this endpoint said.
// Read at request time (no caching) so turning the flag off takes effect immediately.

export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json(
    { parcelCheckout: isParcelCheckoutEnabled(process.env) },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
