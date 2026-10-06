// SERVER-ONLY. Attaches server-side geocoding to a built delivery order before create_order (FALAFEL-SN-08C).
// Soft dependency: whatever happens here, the order goes on to be created — with coordinates when the
// geocoder produced a trusted result, otherwise with the explicit unresolved state.
// Logs short codes only (never the address, name, phone, provider response or key).

import { geocodeDeliveryAddress, toDeliveryGeoFields, UNRESOLVED_DELIVERY_GEO, type GeocodeAddressInput, type GeocodeResult } from './geocoding'
import { resolveGeocodingProvider } from './geocodingProvider'
import { deviceLocationGeoFields, isTrustedDeviceLocation } from './deliveryLocation'
import { applyDeliveryGeo, type BuiltOrder, type CreateOrderRequest } from './orderRequest'

export interface OrderGeoDeps {
  geocode(input: GeocodeAddressInput): Promise<GeocodeResult>
  log(code: string): void
}

// Expected while no provider is enabled — not worth a log line per delivery order.
const QUIET_REASONS: readonly string[] = ['disabled', 'not_configured']

export const defaultOrderGeoDeps = (): OrderGeoDeps => ({
  geocode: input => geocodeDeliveryAddress(input, { resolution: resolveGeocodingProvider(process.env, fetch) }),
  log: code => console.warn('orders: geocode', code),
})

/**
 * Delivery only; pickup (or a build without p_delivery) is returned untouched and the geocoder is never called.
 * Coordinate priority (the textual address is never changed here):
 *  1) trusted customer-confirmed device GPS (≤ 100 m) — navigation coordinates only
 *  2) server-verified Google place (resolveGoogleDeliveryAddress) → geocoder / street with Google's coordinates
 *  3) Google place selected but not verifiable (Google unavailable), or a route-only place without trusted GPS
 *     (rejected earlier by resolveGoogleDeliveryAddress; defensive) → explicit unresolved, Mapbox NOT called,
 *     the route centre is never used
 *  4) legacy requests without a Google place → server Mapbox geocoding → otherwise explicit unresolved
 */
export async function attachDeliveryGeo(
  order: CreateOrderRequest, built: BuiltOrder, deps: OrderGeoDeps = defaultOrderGeoDeps(),
): Promise<BuiltOrder> {
  if (order.type !== 'delivery' || !order.delivery || !built.rpcArgs.p_delivery) return built

  if (order.deliveryLocation) {
    if (isTrustedDeviceLocation(order.deliveryLocation))
      return applyDeliveryGeo(built, deviceLocationGeoFields(order.deliveryLocation))
    deps.log('location_low_accuracy') // code only — never coordinates or accuracy
  }

  if (order.googleAddress?.status === 'verified') {
    const { lat, lng } = order.googleAddress
    return applyDeliveryGeo(built, { delivery_lat: lat, delivery_lng: lng, geo_source: 'geocoder', geo_precision: 'street' })
  }
  if (order.googleAddress?.status === 'route_only') return applyDeliveryGeo(built, UNRESOLVED_DELIVERY_GEO) // no route centre
  if (order.googlePlaceId) return applyDeliveryGeo(built, UNRESOLVED_DELIVERY_GEO) // Google chosen: never Mapbox

  let result: GeocodeResult
  try {
    result = await deps.geocode({ city: order.delivery.city, street: order.delivery.street, houseNumber: order.delivery.houseNumber })
  } catch {
    deps.log('geocode_internal_error')
    return applyDeliveryGeo(built, UNRESOLVED_DELIVERY_GEO)
  }
  if (!result.ok && !QUIET_REASONS.includes(result.reason)) deps.log(`geocode_${result.reason}`)
  return applyDeliveryGeo(built, toDeliveryGeoFields(result))
}
