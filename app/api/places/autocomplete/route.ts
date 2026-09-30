import { NextRequest, NextResponse } from 'next/server'
import { checkSameOriginJson } from '@/lib/kitchenAuth'
import { autocompletePlaces, parseAutocompleteInput, placesApiKey, PlacesError } from '@/lib/googlePlaces'

// POST /api/places/autocomplete — delivery checkout address suggestions (Google Places API New, server-side key).
// Same-origin JSON only; validated input (supported delivery area, session token); returns suggestions only.
// 503 not_configured when GOOGLE_PLACES_API_KEY is absent (checkout then falls back to manual entry). Logs nothing.

const NO_STORE = { 'Cache-Control': 'no-store' }
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE })

export async function POST(req: NextRequest) {
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
