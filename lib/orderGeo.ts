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
 * Priority: 1) trusted customer-confirmed device location (authoritative; Mapbox is not called and can never
 * overwrite it) → 2) server Mapbox geocoding (street match or locality) → 3) explicit unresolved.
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
