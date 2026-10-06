// Delivery geocoding domain (FALAFEL-SN-08C): provider-neutral types, validation and classification.
// Pure: no env, no network, no Supabase. The provider (HTTP) lives in lib/geocodingProvider.ts (server-only)
// and is always passed in, so this module is testable and safe to import anywhere.
//
// Geocoding is a SOFT dependency: geocodeDeliveryAddress() never throws. Every failure becomes an
// explicit unresolved result and the food order is still created.

import { DELIVERY_AREAS } from './orderConfig'

/* ─── Stored values (must match the CHECK constraints on public.deliveries) ─── */

export type GeoPrecision = 'street' | 'locality' | 'unresolved'
export type GeoSource = 'geocoder' | 'manual' | 'none'

export type GeocodeFailureReason =
  | 'disabled'
  | 'not_configured'
  | 'timeout'
  | 'provider_error'
  | 'no_result'
  | 'invalid_coordinates'
  | 'locality_mismatch'
  | 'insufficient_precision'

export interface GeocodeSuccess {
  ok: true
  lat: number
  lng: number
  precision: 'street' | 'locality'
  source: 'geocoder'
}

export interface GeocodeFailure {
  ok: false
  lat: null
  lng: null
  precision: 'unresolved'
  source: 'none'
  reason: GeocodeFailureReason
}

export type GeocodeResult = GeocodeSuccess | GeocodeFailure

/** The four deliveries columns, exactly as passed to create_order in p_delivery. */
export interface DeliveryGeoFields {
  delivery_lat: number | null
  delivery_lng: number | null
  geo_source: GeoSource
  geo_precision: GeoPrecision
}

/** Explicit state for a new delivery order whose address could not be (or was not) geocoded. */
export const UNRESOLVED_DELIVERY_GEO: DeliveryGeoFields = Object.freeze({
  delivery_lat: null,
  delivery_lng: null,
  geo_source: 'none',
  geo_precision: 'unresolved',
})

export const toDeliveryGeoFields = (r: GeocodeResult): DeliveryGeoFields =>
  r.ok
    ? { delivery_lat: r.lat, delivery_lng: r.lng, geo_source: r.source, geo_precision: r.precision }
    : { ...UNRESOLVED_DELIVERY_GEO }

/** Future courier dispatch trusts street-level coordinates only (locality needs explicit approval). */
export const AUTO_DISPATCH_PRECISIONS: readonly GeoPrecision[] = ['street']

/* ─── Provider contract ─── */

export interface GeocodeQuery {
  /** "<street> <house number>, <city>, Israel" — built only from validated address fields. */
  text: string
  city: string
  street: string
  houseNumber: string
}

/** Provider-neutral view of the provider's best result. Raw responses never leave the provider adapter. */
export interface ProviderGeocodeResult {
  lat: unknown
  lng: unknown
  /** Settlement-level names the provider reported for the result (e.g. place + locality); [] when none. */
  localities: string[]
  /** street = address / building level; locality = settlement / approximate centre; other = anything coarser. */
  level: 'street' | 'locality' | 'other'
  /** Provider says it matched only part of the query. */
  partial: boolean
}

/** One attempt. Resolves null for "no result"; throws on provider/HTTP errors. Must honour the abort signal. */
export type GeocodingProvider = (query: GeocodeQuery, signal: AbortSignal) => Promise<ProviderGeocodeResult | null>

export type GeocodingProviderResolution =
  | { status: 'ready'; provider: GeocodingProvider }
  | { status: 'disabled' }
  | { status: 'not_configured' }

/* ─── Validation ─── */

// Coarse sanity box (same values as deliveries_geo_lat/lng_range_check). NOT a delivery-area check.
export const GEO_BOUNDS = { minLat: 29.0, maxLat: 34.0, minLng: 34.0, maxLng: 36.0 } as const

export const isValidCoordinatePair = (lat: unknown, lng: unknown): lat is number =>
  typeof lat === 'number' && typeof lng === 'number' &&
  Number.isFinite(lat) && Number.isFinite(lng) &&
  lat >= GEO_BOUNDS.minLat && lat <= GEO_BOUNDS.maxLat &&
  lng >= GEO_BOUNDS.minLng && lng <= GEO_BOUNDS.maxLng

/** numeric(9,6) precision. */
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6

/* ─── Locality matching (explicit aliases only — no fuzzy matching) ─── */

/** Harmless formatting only: Unicode NFC, case, apostrophes / geresh / gershayim / quotes removed,
 *  hyphens / maqaf / dots / commas → space, whitespace collapsed. */
export function normalizeLocalityName(s: string): string {
  return s
    .normalize('NFC')
    .toLowerCase()
    .replace(/['`’‘"״׳]/g, '')
    .replace(/[-–—־.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Known provider spellings per delivery area (Hebrew + common English transliterations).
const LOCALITY_ALIASES: Readonly<Record<string, readonly string[]>> = {
  'מעלה אדומים': ["Ma'ale Adumim", 'Maale Adumim', "Ma'ale Adummim"],
  'מישור אדומים': ['Mishor Adumim', 'Mishor Adummim'],
  'כפר אדומים': ['Kfar Adumim', 'Kfar Adummim', 'Kefar Adummim'],
  'נופי פרת': ['Nofei Prat', 'Nofe Prat'],
  'אלון': ['Alon'],
  'מצפה יריחו': ['Mitzpe Yericho', 'Mitspe Yeriho', 'Mizpe Yeriho'],
}

/** True when the provider's locality is the SELECTED delivery area (by name or a listed alias). */
export function localityMatches(selectedCity: string, providerLocality: string | null | undefined): boolean {
  if (!providerLocality || !DELIVERY_AREAS.includes(selectedCity)) return false
  const got = normalizeLocalityName(providerLocality)
  return [selectedCity, ...(LOCALITY_ALIASES[selectedCity] ?? [])].some(n => normalizeLocalityName(n) === got)
}

/** Areas without an alias entry (should be empty; checked by tests). */
export const areasWithoutAliases = (): string[] => DELIVERY_AREAS.filter(a => !(a in LOCALITY_ALIASES))

/* ─── Query ─── */

export interface GeocodeAddressInput {
  city: string
  street: string
  houseNumber: string
}

/** Only city / street / house number — never name, phone, apartment, floor, entrance or notes. */
export function buildGeocodeQuery(input: GeocodeAddressInput): GeocodeQuery {
  const city = input.city.trim()
  const street = input.street.trim()
  const houseNumber = input.houseNumber.trim()
  return { text: `${street} ${houseNumber}, ${city}, Israel`, city, street, houseNumber }
}

/* ─── Classification ─── */

const failure = (reason: GeocodeFailureReason): GeocodeFailure =>
  ({ ok: false, lat: null, lng: null, precision: 'unresolved', source: 'none', reason })

/** Provider-neutral classification of one provider result for the selected delivery area. */
export function classifyGeocode(selectedCity: string, r: ProviderGeocodeResult | null): GeocodeResult {
  if (!r) return failure('no_result')
  if (!isValidCoordinatePair(r.lat, r.lng)) return failure('invalid_coordinates')
  if (!r.localities.some(name => localityMatches(selectedCity, name))) return failure('locality_mismatch')

  let precision: 'street' | 'locality'
  if (r.level === 'street' && !r.partial) precision = 'street'
  else if (r.level === 'street' || r.level === 'locality') precision = 'locality' // partial street match is not trusted as street
  else return failure('insufficient_precision')

  return { ok: true, lat: round6(r.lat), lng: round6(r.lng as number), precision, source: 'geocoder' }
}

/* ─── Public entry point ─── */

export const GEOCODE_TIMEOUT_MS = 2500

export interface GeocodeDeps {
  resolution: GeocodingProviderResolution
  timeoutMs?: number
}

const TIMEOUT = Symbol('timeout')

/** One attempt, no retry, bounded by timeoutMs. Never throws. */
export async function geocodeDeliveryAddress(input: GeocodeAddressInput, deps: GeocodeDeps): Promise<GeocodeResult> {
  try {
    if (deps.resolution.status === 'disabled') return failure('disabled')
    if (deps.resolution.status !== 'ready') return failure('not_configured')

    const query = buildGeocodeQuery(input)
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<typeof TIMEOUT>(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve(TIMEOUT) }, deps.timeoutMs ?? GEOCODE_TIMEOUT_MS)
    })

    let raw: ProviderGeocodeResult | null | typeof TIMEOUT
    try {
      raw = await Promise.race([deps.resolution.provider(query, controller.signal), timeout])
    } catch {
      return failure(controller.signal.aborted ? 'timeout' : 'provider_error')
    } finally {
      clearTimeout(timer)
    }
    if (raw === TIMEOUT) return failure('timeout')
    return classifyGeocode(query.city, raw)
  } catch {
    return failure('provider_error')
  }
}
