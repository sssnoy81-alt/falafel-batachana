// SERVER-ONLY geocoding provider resolution + adapters (FALAFEL-SN-08C).
// Reads GEOCODING_PROVIDER / GEOCODING_API_KEY (never NEXT_PUBLIC_*). The key is only placed in the
// outgoing provider request and is never logged or returned. Raw provider responses are mapped to the
// provider-neutral ProviderGeocodeResult here and never leave this module.
//
// Status: the Google adapter is implemented against the documented Geocoding API response shape and is
// covered by fixture tests only. It is NOT enabled until GEOCODING_PROVIDER + GEOCODING_API_KEY are set
// (approval required) and it has been verified against the real API on a Preview deployment.

import type { GeocodingProvider, GeocodingProviderResolution, ProviderGeocodeResult } from './geocoding'

type FetchLike = (url: string, init: { signal: AbortSignal; cache: 'no-store' }) =>
  Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

type EnvLike = Record<string, string | undefined>

export class GeocodingProviderError extends Error {
  constructor(code: string) {
    super(code) // a short code only — never a URL, key or response body
    this.name = 'GeocodingProviderError'
  }
}

/** Missing / "none" / "disabled" → disabled. Unknown provider or missing key → not_configured. */
export function resolveGeocodingProvider(env: EnvLike, fetchImpl: FetchLike): GeocodingProviderResolution {
  const name = (env.GEOCODING_PROVIDER ?? '').trim().toLowerCase()
  if (name === '' || name === 'none' || name === 'disabled') return { status: 'disabled' }
  const apiKey = (env.GEOCODING_API_KEY ?? '').trim()
  if (!apiKey) return { status: 'not_configured' }
  if (name === 'google') return { status: 'ready', provider: googleProvider(apiKey, fetchImpl) }
  return { status: 'not_configured' } // e.g. 'mapbox' — adapter not implemented yet
}

/* ─── Google Geocoding API ─── */

const GOOGLE_GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json'

interface GoogleComponent { long_name?: unknown; types?: unknown }
interface GoogleResult {
  types?: unknown
  partial_match?: unknown
  address_components?: unknown
  geometry?: { location?: { lat?: unknown; lng?: unknown }; location_type?: unknown }
}

const strArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

const STREET_TYPES = ['street_address', 'premise', 'subpremise']
const STREET_LOCATION_TYPES = ['ROOFTOP', 'RANGE_INTERPOLATED']
// Coarser than an address but inside a settlement. ('political' is deliberately absent: countries carry it too.)
const LOCALITY_TYPES = ['locality', 'route', 'neighborhood', 'sublocality', 'sublocality_level_1']

/** Pure mapping of a Google Geocoding JSON body to the neutral result. ZERO_RESULTS → null; other non-OK → throws. */
export function mapGoogleGeocodeResponse(body: unknown): ProviderGeocodeResult | null {
  if (typeof body !== 'object' || body === null) throw new GeocodingProviderError('google_bad_body')
  const status = (body as { status?: unknown }).status
  if (status === 'ZERO_RESULTS') return null
  if (status !== 'OK') throw new GeocodingProviderError('google_status_not_ok')

  const results = (body as { results?: unknown }).results
  if (!Array.isArray(results) || results.length === 0) return null
  const r = results[0] as GoogleResult

  const types = strArray(r.types)
  const locationType = typeof r.geometry?.location_type === 'string' ? r.geometry.location_type : ''
  const components = Array.isArray(r.address_components) ? (r.address_components as GoogleComponent[]) : []
  const locality = components.find(c => strArray(c.types).includes('locality'))?.long_name

  let level: ProviderGeocodeResult['level'] = 'other'
  const streetType = types.some(t => STREET_TYPES.includes(t))
  if (streetType && STREET_LOCATION_TYPES.includes(locationType)) level = 'street'
  else if (streetType || types.some(t => LOCALITY_TYPES.includes(t))) level = 'locality' // approximate address → locality only

  return {
    lat: r.geometry?.location?.lat,
    lng: r.geometry?.location?.lng,
    locality: typeof locality === 'string' ? locality : null,
    level,
    partial: r.partial_match === true,
  }
}

export function googleProvider(apiKey: string, fetchImpl: FetchLike): GeocodingProvider {
  return async (query, signal) => {
    const params = new URLSearchParams({
      address: query.text,
      components: 'country:IL',
      language: 'he',
      region: 'il',
      key: apiKey,
    })
    const res = await fetchImpl(`${GOOGLE_GEOCODE_URL}?${params.toString()}`, { signal, cache: 'no-store' })
    if (!res.ok) throw new GeocodingProviderError(`google_http_${res.status}`)
    return mapGoogleGeocodeResponse(await res.json())
  }
}
