// SERVER-ONLY geocoding provider resolution + adapter (FALAFEL-SN-08C / 08C3).
// Reads GEOCODING_PROVIDER / GEOCODING_API_KEY (never NEXT_PUBLIC_*). The token is only placed in the
// outgoing provider request; it is never logged, returned or put into an error. Raw provider responses are
// mapped to the provider-neutral ProviderGeocodeResult here and never leave this module.
//
// Provider decision: Mapbox Geocoding API v6 with PERMANENT geocoding is the only supported provider,
// because coordinates are persisted in public.deliveries. Every request carries permanent=true.
// Google Geocoding is intentionally NOT supported (its caching terms do not fit indefinite storage).
//
// Status: implemented against the documented v6 response shape and covered by fixture tests only.
// NOT enabled until GEOCODING_PROVIDER=mapbox + GEOCODING_API_KEY are set (approval required) and the
// account is confirmed eligible for permanent geocoding, then verified on a Preview deployment.

import type { GeocodeQuery, GeocodingProvider, GeocodingProviderResolution, ProviderGeocodeResult } from './geocoding'

type FetchLike = (url: string, init: { signal: AbortSignal; cache: 'no-store' }) =>
  Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

type EnvLike = Record<string, string | undefined>

export class GeocodingProviderError extends Error {
  constructor(code: string) {
    super(code) // a short code only — never a URL, token or response body
    this.name = 'GeocodingProviderError'
  }
}

/** Missing / "none" / "disabled" → disabled. Missing token or any provider other than mapbox → not_configured. */
export function resolveGeocodingProvider(env: EnvLike, fetchImpl: FetchLike): GeocodingProviderResolution {
  const name = (env.GEOCODING_PROVIDER ?? '').trim().toLowerCase()
  if (name === '' || name === 'none' || name === 'disabled') return { status: 'disabled' }
  const token = (env.GEOCODING_API_KEY ?? '').trim()
  if (!token) return { status: 'not_configured' }
  if (name === 'mapbox') return { status: 'ready', provider: mapboxProvider(token, fetchImpl) }
  return { status: 'not_configured' } // incl. 'google' — deliberately unsupported
}

/* ─── Mapbox Geocoding API v6 (forward, permanent) ─── */

const MAPBOX_FORWARD_URL = 'https://api.mapbox.com/search/geocode/v6/forward'

// Fixed request policy. permanent=true is mandatory: results are stored in our DB.
export const MAPBOX_FIXED_PARAMS: Readonly<Record<string, string>> = Object.freeze({
  country: 'il',
  language: 'he',
  limit: '1',
  autocomplete: 'false',
  permanent: 'true',
})

/** The only way a Mapbox URL is built. q = the validated address text; fixed params cannot be overridden. */
export function buildMapboxForwardUrl(query: GeocodeQuery, token: string): string {
  const params = new URLSearchParams({ q: query.text, ...MAPBOX_FIXED_PARAMS, access_token: token })
  if (params.get('permanent') !== 'true') throw new GeocodingProviderError('mapbox_permanent_required')
  return `${MAPBOX_FORWARD_URL}?${params.toString()}`
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const nameOf = (v: unknown): string | null => (isObj(v) && typeof v.name === 'string' && v.name.trim() ? v.name : null)

const STREET_ACCURACY = ['rooftop', 'parcel', 'point', 'interpolated']
const SETTLEMENT_TYPES = ['place', 'locality', 'neighborhood', 'street'] // coarser than a house, inside a settlement

/** Pure mapping of a Mapbox v6 FeatureCollection body to the neutral result. No features → null. */
export function mapMapboxV6Response(body: unknown): ProviderGeocodeResult | null {
  if (!isObj(body) || !Array.isArray(body.features)) throw new GeocodingProviderError('mapbox_bad_body')
  const feature = body.features[0]
  if (feature === undefined) return null
  if (!isObj(feature) || !isObj(feature.properties)) throw new GeocodingProviderError('mapbox_bad_body')

  const p = feature.properties
  const featureType = typeof p.feature_type === 'string' ? p.feature_type : ''
  const context = isObj(p.context) ? p.context : {}
  const coords = isObj(p.coordinates) ? p.coordinates : {}
  const geometry = isObj(feature.geometry) && Array.isArray(feature.geometry.coordinates) ? feature.geometry.coordinates : []

  // Prefer properties.coordinates; fall back to GeoJSON geometry [lng, lat].
  const lat = coords.latitude ?? geometry[1]
  const lng = coords.longitude ?? geometry[0]

  // Settlement names: the containing place / locality, or the feature itself when it IS the settlement.
  const localities = [
    nameOf(context.place),
    nameOf(context.locality),
    featureType === 'place' || featureType === 'locality' ? nameOf(p) : null,
  ].filter((n): n is string => n !== null)

  let level: ProviderGeocodeResult['level'] = 'other'
  let partial = false
  if (featureType === 'address' || featureType === 'secondary_address') {
    level = 'street'
    const accuracy = typeof coords.accuracy === 'string' ? coords.accuracy : ''
    const mc = isObj(p.match_code) ? p.match_code : {}
    // Anything short of a confirmed house-level match is not trusted as street precision.
    partial = !STREET_ACCURACY.includes(accuracy)
      || (mc.address_number !== undefined && mc.address_number !== 'matched')
      || (mc.street !== undefined && mc.street !== 'matched')
      || mc.confidence === 'low'
  } else if (SETTLEMENT_TYPES.includes(featureType)) {
    level = 'locality'
  }

  return { lat, lng, localities, level, partial }
}

export function mapboxProvider(token: string, fetchImpl: FetchLike): GeocodingProvider {
  return async (query, signal) => {
    const url = buildMapboxForwardUrl(query, token)
    let res: Awaited<ReturnType<FetchLike>>
    try {
      res = await fetchImpl(url, { signal, cache: 'no-store' })
    } catch {
      throw new GeocodingProviderError('mapbox_network') // original error may carry the URL (token) — dropped
    }
    if (!res.ok) throw new GeocodingProviderError(`mapbox_http_${res.status}`)
    let body: unknown
    try {
      body = await res.json()
    } catch {
      throw new GeocodingProviderError('mapbox_bad_json')
    }
    return mapMapboxV6Response(body)
  }
}
