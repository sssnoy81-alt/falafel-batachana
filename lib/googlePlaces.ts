// SERVER-ONLY Google Places API (New) client for the developer address POC (FALAFEL-SN-08D7).
// NOT part of the order flow: nothing here is imported by /order, POST /api/orders, pricing or the kitchen.
// The API key is read from GOOGLE_PLACES_API_KEY (never NEXT_PUBLIC_*), sent only in the X-Goog-Api-Key
// header (never in a URL), and never logged or returned. Raw Google responses are mapped here and only the
// fields the POC displays are returned.

import { DELIVERY_AREAS, DELIVERY_FIELD_LIMITS } from './orderConfig'
import { isValidCoordinatePair, localityMatches } from './geocoding'

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; cache: 'no-store'; signal?: AbortSignal }) =>
  Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>
type EnvLike = Record<string, string | undefined>

/* ─── Gate: Preview / local only ─── */

/** Enabled only with ADDRESS_POC_ENABLED=true and never on Vercel Production. */
export const isAddressPocEnabled = (env: EnvLike): boolean =>
  env.ADDRESS_POC_ENABLED === 'true' && env.VERCEL_ENV !== 'production'

export const placesApiKey = (env: EnvLike): string | null => {
  const k = (env.GOOGLE_PLACES_API_KEY ?? '').trim()
  return k ? k : null
}

/* ─── Request policy ─── */

const AUTOCOMPLETE_URL = 'https://places.googleapis.com/v1/places:autocomplete'
const DETAILS_URL = 'https://places.googleapis.com/v1/places/'
// Minimum fields for address + coordinates (address components, formatted address, location, types).
export const DETAILS_FIELD_MASK = 'id,formattedAddress,location,addressComponents,types'

// SEARCH BIAS ONLY (not a delivery boundary, not used for dispatch): a circle over the Ma'ale Adumim /
// Jordan-valley-edge delivery region so nearby matches rank first. Results stay restricted to Israel.
export const DELIVERY_REGION_BIAS = Object.freeze({ center: { latitude: 31.7805, longitude: 35.3116 }, radius: 30_000 })

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PLACE_ID = /^[A-Za-z0-9_-]{1,300}$/
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const text = (v: unknown): string | null => (isObj(v) && typeof v.text === 'string' ? v.text : null)

export class PlacesError extends Error {
  constructor(code: string) { super(code); this.name = 'PlacesError' } // short code only
}

/* ─── Input validation (shared by the dev API routes) ─── */

export function parseAutocompleteInput(body: unknown): { input: string; city: string; sessionToken: string } | null {
  if (!isObj(body)) return null
  const { input, city, sessionToken } = body
  if (typeof input !== 'string' || typeof city !== 'string' || typeof sessionToken !== 'string') return null
  const q = input.trim()
  if (q.length < 2 || q.length > 120 || !DELIVERY_AREAS.includes(city) || !UUID.test(sessionToken)) return null
  return { input: q, city, sessionToken }
}

export function parseDetailsInput(body: unknown): { placeId: string; city: string; sessionToken: string } | null {
  if (!isObj(body)) return null
  const { placeId, city, sessionToken } = body
  if (typeof placeId !== 'string' || typeof city !== 'string' || typeof sessionToken !== 'string') return null
  if (!PLACE_ID.test(placeId) || !DELIVERY_AREAS.includes(city) || !UUID.test(sessionToken)) return null
  return { placeId, city, sessionToken }
}

/* ─── Autocomplete (New) ─── */

export interface PlaceSuggestion { placeId: string; text: string; mainText: string | null; secondaryText: string | null; types: string[] }

export function buildAutocompleteBody(input: string, city: string, sessionToken: string) {
  return {
    input: `${input}, ${city}`,        // the selected delivery area narrows the query
    languageCode: 'he',
    regionCode: 'il',
    includedRegionCodes: ['il'],       // restrict to Israel
    locationBias: { circle: DELIVERY_REGION_BIAS },
    sessionToken,                      // same token for every keystroke + the final details call
  }
}

export function mapAutocompleteResponse(body: unknown): PlaceSuggestion[] {
  if (!isObj(body)) throw new PlacesError('places_bad_body')
  const suggestions = Array.isArray(body.suggestions) ? body.suggestions : []
  const out: PlaceSuggestion[] = []
  for (const s of suggestions) {
    const p = isObj(s) && isObj(s.placePrediction) ? s.placePrediction : null
    if (!p || typeof p.placeId !== 'string' || !PLACE_ID.test(p.placeId)) continue
    const sf = isObj(p.structuredFormat) ? p.structuredFormat : {}
    out.push({
      placeId: p.placeId,
      text: text(p.text) ?? '',
      mainText: text(sf.mainText),
      secondaryText: text(sf.secondaryText),
      types: Array.isArray(p.types) ? p.types.filter((t): t is string => typeof t === 'string') : [],
    })
  }
  return out.slice(0, 5)
}

export async function autocompletePlaces(
  q: { input: string; city: string; sessionToken: string }, apiKey: string, fetchImpl: FetchLike,
): Promise<PlaceSuggestion[]> {
  let res: Awaited<ReturnType<FetchLike>>
  try {
    res = await fetchImpl(AUTOCOMPLETE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey },
      body: JSON.stringify(buildAutocompleteBody(q.input, q.city, q.sessionToken)),
      cache: 'no-store',
    })
  } catch { throw new PlacesError('places_network') }
  if (!res.ok) throw new PlacesError(`places_http_${res.status}`)
  let body: unknown
  try { body = await res.json() } catch { throw new PlacesError('places_bad_json') }
  return mapAutocompleteResponse(body)
}

/* ─── Place Details (New) — ends the autocomplete session ─── */

export interface PlaceDetailsDiagnostic {
  placeId: string
  formattedAddress: string | null
  lat: number | null
  lng: number | null
  street: string | null
  houseNumber: string | null
  locality: string | null
  types: string[]
  cityMatchesSelectedArea: boolean
}

/** sessionToken: the UI's autocomplete session (ends it). Order-time re-verification has no session. */
export function detailsUrl(placeId: string, sessionToken?: string): string {
  if (!PLACE_ID.test(placeId)) throw new PlacesError('places_bad_place_id')
  const params = new URLSearchParams({ ...(sessionToken ? { sessionToken } : {}), languageCode: 'he', regionCode: 'il' })
  return `${DETAILS_URL}${encodeURIComponent(placeId)}?${params.toString()}`
}

export function mapPlaceDetails(body: unknown, selectedCity: string): PlaceDetailsDiagnostic {
  if (!isObj(body) || typeof body.id !== 'string') throw new PlacesError('places_bad_body')
  const comps = Array.isArray(body.addressComponents) ? body.addressComponents.filter(isObj) : []
  const find = (type: string): string | null => {
    const c = comps.find(x => Array.isArray(x.types) && x.types.includes(type))
    return c && typeof c.longText === 'string' ? c.longText : null
  }
  const loc = isObj(body.location) ? body.location : {}
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const locality = find('locality')
  return {
    placeId: body.id,
    formattedAddress: typeof body.formattedAddress === 'string' ? body.formattedAddress : null,
    lat: num(loc.latitude),
    lng: num(loc.longitude),
    street: find('route'),
    houseNumber: find('street_number'),
    locality,
    types: Array.isArray(body.types) ? body.types.filter((t): t is string => typeof t === 'string') : [],
    cityMatchesSelectedArea: localityMatches(selectedCity, locality),
  }
}

export async function getPlaceDetails(
  q: { placeId: string; city: string; sessionToken?: string }, apiKey: string, fetchImpl: FetchLike, signal?: AbortSignal,
): Promise<PlaceDetailsDiagnostic> {
  let res: Awaited<ReturnType<FetchLike>>
  try {
    res = await fetchImpl(detailsUrl(q.placeId, q.sessionToken), {
      method: 'GET',
      headers: { 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': DETAILS_FIELD_MASK },
      cache: 'no-store',
      ...(signal ? { signal } : {}),
    })
  } catch (e) { throw e instanceof PlacesError ? e : new PlacesError('places_network') }
  if (!res.ok) throw new PlacesError(`places_http_${res.status}`)
  let body: unknown
  try { body = await res.json() } catch { throw new PlacesError('places_bad_json') }
  return mapPlaceDetails(body, q.city)
}

/* ─── Delivery address verification (used by the real order flow, 08D8) ─── */

export const isValidPlaceId = (v: unknown): v is string => typeof v === 'string' && PLACE_ID.test(v)

export type PlaceVerificationReason = 'city_mismatch' | 'missing_street' | 'missing_house_number' | 'invalid_coordinates' | 'invalid_address'

export interface VerifiedDeliveryPlace {
  placeId: string
  city: string            // the selected delivery area (verified against Google's locality)
  street: string          // Google route
  houseNumber: string     // Google street_number
  formattedAddress: string | null
  lat: number
  lng: number
  types: string[]
}

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6

/**
 * Server-authoritative acceptance of a Google place as a delivery address (Maale needs street + house number +
 * coordinates). Requires: locality matches the selected area (exact aliases only), street, house number, valid
 * Israel coordinates. Result types are informational — a locality-only result fails on missing street / house.
 */
export function verifyDeliveryPlace(d: PlaceDetailsDiagnostic, selectedCity: string):
  { ok: true; value: VerifiedDeliveryPlace } | { ok: false; reason: PlaceVerificationReason } {
  if (!DELIVERY_AREAS.includes(selectedCity) || !localityMatches(selectedCity, d.locality)) return { ok: false, reason: 'city_mismatch' }
  const street = (d.street ?? '').trim()
  const houseNumber = (d.houseNumber ?? '').trim()
  if (!street) return { ok: false, reason: 'missing_street' }
  if (!houseNumber) return { ok: false, reason: 'missing_house_number' }
  if (street.length > DELIVERY_FIELD_LIMITS.street || houseNumber.length > DELIVERY_FIELD_LIMITS.houseNumber) return { ok: false, reason: 'invalid_address' }
  if (!isValidCoordinatePair(d.lat, d.lng)) return { ok: false, reason: 'invalid_coordinates' }
  return {
    ok: true,
    value: {
      placeId: d.placeId, city: selectedCity, street, houseNumber, formattedAddress: d.formattedAddress,
      lat: round6(d.lat), lng: round6(d.lng as number), types: d.types,
    },
  }
}

/* ─── Route-only places (08D14D) ─── */

/**
 * A Google place that identifies a STREET in the selected area but no house (place type `route`, a route
 * component, no street_number) — e.g. autocomplete shows "רחוב הגעש 3" but Google only knows the street.
 * Deliberately carries NO coordinates: a route centre is never a house location and must never be stored
 * as street precision or reach dispatch. Precise coordinates must come from trusted device GPS instead.
 */
export interface VerifiedRoutePlace {
  placeId: string
  city: string            // the selected delivery area (verified against Google's locality)
  street: string          // Google route
  formattedAddress: string | null
  types: string[]
}

export type ClassifiedDeliveryPlace =
  | { ok: true; kind: 'address'; value: VerifiedDeliveryPlace }
  | { ok: true; kind: 'route'; value: VerifiedRoutePlace }
  | { ok: false; reason: PlaceVerificationReason }

/** Full address → exactly verifyDeliveryPlace. Missing house number on a real route place → 'route'. */
export function classifyDeliveryPlace(d: PlaceDetailsDiagnostic, selectedCity: string): ClassifiedDeliveryPlace {
  const full = verifyDeliveryPlace(d, selectedCity)
  if (full.ok) return { ok: true, kind: 'address', value: full.value }
  if (full.reason !== 'missing_house_number' || !d.types.includes('route')) return full
  const street = (d.street ?? '').trim() // non-empty: missing_street is checked before missing_house_number
  if (street.length > DELIVERY_FIELD_LIMITS.street) return { ok: false, reason: 'invalid_address' }
  return { ok: true, kind: 'route', value: { placeId: d.placeId, city: selectedCity, street, formattedAddress: d.formattedAddress, types: d.types } }
}
