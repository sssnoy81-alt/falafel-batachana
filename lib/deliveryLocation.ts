// Customer device location for delivery orders (FALAFEL-SN-08D1).
// Pure: no env, no network, no browser APIs — shared by the checkout page and POST /api/orders so both
// apply exactly the same rules. The browser only ever sends location_* inputs; the server alone decides
// geo_source / geo_precision / dispatch eligibility.
//
// Storage (no migration): a trusted device location is stored as geo_source='manual', geo_precision='street'
// with the device coordinates — the combination deliveries_geo_consistency_check already allows. Accuracy is
// checked at order time and is not persisted.

import { AUTO_DISPATCH_PRECISIONS, isValidCoordinatePair, type DeliveryGeoFields } from './geocoding'
import { DELIVERY_AREAS } from './orderConfig'
import { checkDeliveryAreaProximity, DELIVERY_AREA_GEO, type AreaProximityResult, type DeliveryAreaGeoConfig } from './deliveryAreasGeo'

/** Trusted for courier use only when the device reports ≤ 100 m accuracy (building / street level). */
export const DEVICE_LOCATION_MAX_ACCURACY_M = 100
/** Request sanity cap — larger reported accuracy values are rejected as malformed, not just untrusted. */
export const DEVICE_LOCATION_MAX_REPORTED_ACCURACY_M = 10_000

/** The only location keys a client may send, and only inside `delivery`. */
export const LOCATION_INPUT_KEYS = ['location_lat', 'location_lng', 'location_accuracy', 'location_confirmed'] as const

export interface DeliveryLocationWire {
  location_lat: number
  location_lng: number
  location_accuracy: number
  /** The customer pressed "send my location" and is at the delivery address. */
  location_confirmed: true
}

export interface DeviceLocation {
  lat: number
  lng: number
  accuracy: number // metres, as reported by the device
}

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isValidAccuracy = (v: unknown): v is number =>
  isFiniteNumber(v) && v > 0 && v <= DEVICE_LOCATION_MAX_REPORTED_ACCURACY_M
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6

/* ─── Server: request parsing ─── */

/** No location keys → { ok, value: undefined }. Any location key present → all four must be valid, else not ok. */
export function parseDeviceLocationInput(delivery: Record<string, unknown>):
  { ok: true; value: DeviceLocation | undefined } | { ok: false } {
  const present = LOCATION_INPUT_KEYS.some(k => Object.prototype.hasOwnProperty.call(delivery, k))
  if (!present) return { ok: true, value: undefined }
  const { location_lat: lat, location_lng: lng, location_accuracy: accuracy, location_confirmed: confirmed } = delivery
  if (confirmed !== true) return { ok: false }
  if (!isValidCoordinatePair(lat, lng)) return { ok: false }
  if (!isValidAccuracy(accuracy)) return { ok: false }
  return { ok: true, value: { lat, lng: lng as number, accuracy } }
}

/** Valid coordinates AND accurate enough for a courier. */
export const isTrustedDeviceLocation = (loc: DeviceLocation): boolean =>
  isValidCoordinatePair(loc.lat, loc.lng) && isValidAccuracy(loc.accuracy) && loc.accuracy <= DEVICE_LOCATION_MAX_ACCURACY_M

/** Stored fields for a trusted device location (the caller must check isTrustedDeviceLocation first). */
export const deviceLocationGeoFields = (loc: DeviceLocation): DeliveryGeoFields => ({
  delivery_lat: round6(loc.lat),
  delivery_lng: round6(loc.lng),
  geo_source: 'manual',
  geo_precision: 'street',
})

/* ─── Future courier dispatch (pure; dispatches nothing) ─── */

/**
 * Source-level check only: coordinates are valid (Israel box) and came from a dispatch-safe source at
 * street level — manual + street (customer device GPS, accuracy checked at order time) or geocoder + street
 * (Mapbox street match that passed locality validation). NOT sufficient for dispatch on its own:
 * assessDeliveryDispatch() also requires a full address and approved-area proximity.
 */
export function hasPreciseCoordinates(geo: Partial<DeliveryGeoFields> | null | undefined): boolean {
  if (!geo) return false
  if (!isValidCoordinatePair(geo.delivery_lat, geo.delivery_lng)) return false
  if (geo.geo_source !== 'manual' && geo.geo_source !== 'geocoder') return false
  return !!geo.geo_precision && AUTO_DISPATCH_PRECISIONS.includes(geo.geo_precision)
}

export type DispatchReadiness =
  | 'ready'                      // A: full address + precise location + approved-area match
  | 'location_area_mismatch'     // B
  | 'missing_precise_location'   // C
  | 'area_not_approved'          // D: area has no approved proximity config yet
  | 'incomplete_address'         // E
  | 'not_delivery'

export const DISPATCH_WARNINGS: Readonly<Record<Exclude<DispatchReadiness, 'ready' | 'not_delivery'>, string>> = {
  location_area_mismatch: 'מיקום המשלוח אינו תואם לאזור שנבחר',
  missing_precise_location: 'חסר מיקום מדויק למשלוח',
  area_not_approved: 'אזור המשלוח עדיין לא מאומת לשליחה אוטומטית',
  incomplete_address: 'כתובת המשלוח אינה מלאה',
}

export interface DispatchAssessment {
  readiness: DispatchReadiness
  /** Future automatic courier dispatch allowed. Computed here only — never stored or accepted from a client. */
  eligible: boolean
  warning: string | null
  proximity?: AreaProximityResult
}

export interface DispatchAssessmentInput {
  type: string | null | undefined
  address: { city?: string | null; street?: string | null; houseNumber?: string | null } | null | undefined
  geo: Partial<DeliveryGeoFields> | null | undefined
}

const filled = (s: string | null | undefined): boolean => typeof s === 'string' && s.trim() !== ''

/**
 * Automatic dispatch requires ALL of: delivery order; full textual address (area from DELIVERY_AREAS, street,
 * house number — Maale needs customer_address); precise coordinates from a dispatch-safe source; the area has
 * approved proximity config; and the coordinates are within that area's approved radius. The same area check
 * applies to device GPS and Mapbox street results. GPS is never checked against the street / house number.
 */
export function assessDeliveryDispatch(
  input: DispatchAssessmentInput,
  config: Readonly<Record<string, DeliveryAreaGeoConfig>> = DELIVERY_AREA_GEO,
): DispatchAssessment {
  const verdict = (readiness: DispatchReadiness, proximity?: AreaProximityResult): DispatchAssessment => ({
    readiness,
    eligible: readiness === 'ready',
    warning: readiness === 'ready' || readiness === 'not_delivery' ? null : DISPATCH_WARNINGS[readiness],
    ...(proximity ? { proximity } : {}),
  })
  if (input.type !== 'delivery') return verdict('not_delivery')
  const a = input.address
  if (!a || !filled(a.city) || !DELIVERY_AREAS.includes(a.city as string) || !filled(a.street) || !filled(a.houseNumber))
    return verdict('incomplete_address')
  if (!hasPreciseCoordinates(input.geo)) return verdict('missing_precise_location')
  const proximity = checkDeliveryAreaProximity(a.city as string, input.geo?.delivery_lat, input.geo?.delivery_lng, config)
  if (proximity.reason === 'matched') return verdict('ready', proximity)
  if (proximity.reason === 'outside_area') return verdict('location_area_mismatch', proximity)
  if (proximity.reason === 'invalid_coordinates') return verdict('missing_precise_location', proximity)
  return verdict('area_not_approved', proximity) // not configured / not approved / unknown
}

/* ─── Client: capture states (browser calls stay in the page) ─── */

export type LocationCaptureState = 'idle' | 'requesting' | 'success' | 'denied' | 'unavailable' | 'inaccurate'

/** GeolocationPositionError.code: 1 = PERMISSION_DENIED; 2 = POSITION_UNAVAILABLE / 3 = TIMEOUT / other → unavailable. */
export const classifyGeolocationError = (code: number): 'denied' | 'unavailable' => (code === 1 ? 'denied' : 'unavailable')

/** Evaluates a browser fix with the server's rules; only a trusted fix is kept for submission. */
export function evaluateDevicePosition(coords: { latitude: unknown; longitude: unknown; accuracy: unknown }):
  { state: 'success'; location: DeviceLocation } | { state: 'inaccurate' | 'unavailable'; location: null } {
  const { latitude: lat, longitude: lng, accuracy } = coords
  if (!isValidCoordinatePair(lat, lng) || !isValidAccuracy(accuracy)) return { state: 'unavailable', location: null }
  const location: DeviceLocation = { lat, lng: lng as number, accuracy }
  return isTrustedDeviceLocation(location) ? { state: 'success', location } : { state: 'inaccurate', location: null }
}

/** Request fields for a captured location; {} when nothing trusted was captured. */
export const deliveryLocationWireFields = (loc: DeviceLocation | null): DeliveryLocationWire | Record<string, never> =>
  loc ? { location_lat: loc.lat, location_lng: loc.lng, location_accuracy: loc.accuracy, location_confirmed: true } : {}
