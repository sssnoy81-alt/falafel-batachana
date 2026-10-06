import { NextRequest, NextResponse } from 'next/server'
import { checkSameOriginJson } from '@/lib/kitchenAuth'
import { autocompletePlaces, isAddressPocEnabled, parseAutocompleteInput, placesApiKey, PlacesError } from '@/lib/googlePlaces'

// POST /api/dev/places/autocomplete — DEVELOPER ADDRESS POC ONLY (FALAFEL-SN-08D7).
// 404 unless ADDRESS_POC_ENABLED=true and not Vercel Production. Same-origin JSON only. Logs nothing.

const NO_STORE = { 'Cache-Control': 'no-store' }
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE })

export async function POST(req: NextRequest) {
  if (!isAddressPocEnabled(process.env)) return json({ error: 'not_found' }, 404)
  if (!checkSameOriginJson(req)) return json({ error: 'invalid_request' }, 400)
  let body: unknown
  try { body = await req.json() } catch { return json({ error: 'invalid_request' }, 400) }
  const q = parseAutocompleteInput(body)
  if (!q) return json({ error: 'invalid_request' }, 400)
  const apiKey = placesApiKey(process.env)
  if (!apiKey) return json({ error: 'not_configured' }, 503)
  try {
    return json({ suggestions: await autocompletePlaces(q, apiKey, fetch) })
  } catch (e) {
    return json({ error: e instanceof PlacesError ? e.message : 'places_error' }, 502)
  }
}
