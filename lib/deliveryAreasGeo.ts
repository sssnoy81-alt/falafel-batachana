// Delivery-area proximity (FALAFEL-SN-08D4). Pure: no env, no network, no logging.
//
// Safety boundary: we do NOT try to prove that coordinates correspond to the typed street + house number
// (text-geocoding coverage for these settlements is not reliable). We only check that the coordinates are
// reasonably near the delivery area the customer selected — enough to stop a location from another
// settlement from qualifying for automatic courier dispatch. Food ordering never depends on this check.
//
// THE ONE AUTHORITATIVE PLACE for per-area centres and radii. Values are added only after verification
// (see the calibration procedure); until then every area is unconfigured and NOT approved for dispatch.

import { DELIVERY_AREAS } from './orderConfig'

export interface DeliveryAreaGeoConfig {
  city: string
  /** Verified area centre, or null until verified. */
  center: { lat: number; lng: number } | null
  /** Conservative acceptance radius in metres, or null until verified. */
  radiusMeters: number | null
  /** Must be explicitly true — coordinates alone never make an area dispatch-eligible. */
  approvedForDispatch: boolean
  /** Where the centre / radius came from (for audit). */
  source: string | null
}

const PENDING = (city: string): DeliveryAreaGeoConfig =>
  ({ city, center: null, radiusMeters: null, approvedForDispatch: false, source: null })

export const DELIVERY_AREA_GEO: Readonly<Record<string, DeliveryAreaGeoConfig>> = Object.freeze({
  'מעלה אדומים': PENDING('מעלה אדומים'),
  'מישור אדומים': PENDING('מישור אדומים'),
  'כפר אדומים': PENDING('כפר אדומים'),
  'נופי פרת': PENDING('נופי פרת'),
  'אלון': PENDING('אלון'),
  'מצפה יריחו': PENDING('מצפה יריחו'),
})

/** Delivery areas with no config entry at all (should be empty; checked by tests). */
export const areasWithoutGeoConfig = (config: Readonly<Record<string, DeliveryAreaGeoConfig>> = DELIVERY_AREA_GEO): string[] =>
  DELIVERY_AREAS.filter(a => !(a in config))

/* ─── Haversine ─── */

const EARTH_RADIUS_M = 6_371_008.8 // IUGG mean Earth radius
const toRad = (deg: number): number => (deg * Math.PI) / 180
const isLat = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= -90 && v <= 90
const isLng = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= -180 && v <= 180

/** Great-circle distance in metres (Haversine). null for any non-finite / out-of-range input. */
export function distanceMetersBetweenCoordinates(lat1: unknown, lng1: unknown, lat2: unknown, lng2: unknown): number | null {
  if (!isLat(lat1) || !isLng(lng1) || !isLat(lat2) || !isLng(lng2)) return null
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)))
}

/* ─── Area match ─── */

export type AreaProximityReason =
  | 'matched'
  | 'outside_area'
  | 'area_not_configured'
  | 'area_not_approved'
  | 'invalid_coordinates'
  | 'unknown_area'

export interface AreaProximityResult {
  /** true only when a real distance comparison against an approved area was made. */
  checked: boolean
  matched: boolean
  distanceMeters?: number
  radiusMeters?: number
  reason: AreaProximityReason
}

const MAX_RADIUS_M = 20_000 // config sanity cap

/** Is (lat, lng) within the approved radius of the selected delivery area? Boundary (distance == radius) matches. */
export function checkDeliveryAreaProximity(
  selectedCity: string, lat: unknown, lng: unknown,
  config: Readonly<Record<string, DeliveryAreaGeoConfig>> = DELIVERY_AREA_GEO,
): AreaProximityResult {
  if (!DELIVERY_AREAS.includes(selectedCity)) return { checked: false, matched: false, reason: 'unknown_area' }
  const area = config[selectedCity]
  if (!area || !area.center || area.radiusMeters === null) return { checked: false, matched: false, reason: 'area_not_configured' }
  if (!area.approvedForDispatch) return { checked: false, matched: false, reason: 'area_not_approved' }
  const { radiusMeters } = area
  if (!Number.isFinite(radiusMeters) || radiusMeters <= 0 || radiusMeters > MAX_RADIUS_M)
    return { checked: false, matched: false, reason: 'area_not_configured' }
  const distance = distanceMetersBetweenCoordinates(lat, lng, area.center.lat, area.center.lng)
  if (distance === null) return { checked: false, matched: false, reason: 'invalid_coordinates' }
  const matched = distance <= radiusMeters
  return { checked: true, matched, distanceMeters: distance, radiusMeters, reason: matched ? 'matched' : 'outside_area' }
}
