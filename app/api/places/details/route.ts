import { NextRequest, NextResponse } from 'next/server'
import { checkSameOriginJson } from '@/lib/kitchenAuth'
import { classifyDeliveryPlace, getPlaceDetails, parseDetailsInput, placesApiKey, PlacesError } from '@/lib/googlePlaces'

// POST /api/places/details — verifies the suggestion the customer selected (ends the autocomplete session).
// Returns only what checkout shows (street, house number, area, formatted address, kind) — never coordinates.
// kind 'route' = Google knows the street but not the house: the customer enters the number and must send
// trusted device GPS (route centre is never used). The order route re-verifies the place id on submit;
// this response is display-only. Logs nothing.

const NO_STORE = { 'Cache-Control': 'no-store' }
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE })

export async function POST(req: NextRequest) {
  if (!checkSameOriginJson(req)) return json({ error: 'invalid_request' }, 400)
  let body: unknown
  try { body = await req.json() } catch { return json({ error: 'invalid_request' }, 400) }
  const q = parseDetailsInput(body)
  if (!q) return json({ error: 'invalid_request' }, 400)
  const apiKey = placesApiKey(process.env)
  if (!apiKey) return json({ error: 'not_configured' }, 503)
  try {
    const v = classifyDeliveryPlace(await getPlaceDetails(q, apiKey, fetch), q.city)
    if (!v.ok) return json({ error: 'address_not_verified', reason: v.reason }, 422)
    if (v.kind === 'route') {
      const { placeId, city, street, formattedAddress } = v.value
      return json({ place: { kind: 'route', placeId, city, street, houseNumber: '', formattedAddress } })
    }
    const { placeId, city, street, houseNumber, formattedAddress } = v.value
    return json({ place: { kind: 'address', placeId, city, street, houseNumber, formattedAddress } })
  } catch (e) {
    const code = e instanceof PlacesError ? e.message : 'places_error'
    if (code === 'places_http_400' || code === 'places_http_404')
      return json({ error: 'address_not_verified', reason: 'place_not_found' }, 422)
    return json({ error: code }, 502)
  }
}
