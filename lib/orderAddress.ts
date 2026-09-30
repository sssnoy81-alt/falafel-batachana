// SERVER-ONLY. Server-side verification of a customer-selected Google place for a delivery order (FALAFEL-SN-08D8).
// The browser only sends delivery.google_place_id; the server fetches the place from Google (Place Details, New)
// and, if it is a real address in the selected delivery area, REPLACES the typed street / house number with
// Google's and records Google's coordinates for the geo step. Browser-sent place details are never trusted.
//
// Outcomes:
//  - verified            → order.delivery.street / houseNumber = Google's; googleAddress = { verified, lat, lng }
//  - rejected (400)      → place not found / wrong city / no street / no house number / bad coordinates
//  - Google unavailable  → typed address kept (already validated text), googleAddress = { unavailable }:
//                          the food order is not blocked by a Google outage; coordinates stay unresolved and
//                          Mapbox is NOT called (the customer did pick a Google address).
// Logs short codes only.

import { getPlaceDetails, placesApiKey, PlacesError, verifyDeliveryPlace, type PlaceDetailsDiagnostic } from './googlePlaces'
import type { CreateOrderRequest, OrderErrorCode } from './orderRequest'

export const PLACE_VERIFY_TIMEOUT_MS = 2500

export interface OrderAddressDeps {
  /** Resolves the place (throws PlacesError on HTTP / network / config problems). */
  lookup(placeId: string, city: string, signal: AbortSignal): Promise<PlaceDetailsDiagnostic>
  log(code: string): void
  timeoutMs?: number
}

export const defaultOrderAddressDeps = (): OrderAddressDeps => ({
  lookup: (placeId, city, signal) => {
    const key = placesApiKey(process.env)
    if (!key) throw new PlacesError('places_not_configured')
    return getPlaceDetails({ placeId, city }, key, fetch, signal)
  },
  log: code => console.warn('orders: address', code),
})

// Google's answer for a bad / unknown place id — the selection itself is invalid, not an outage.
const NOT_FOUND_CODES = ['places_http_400', 'places_http_404']

export type ResolvedOrderAddress =
  | { ok: true; order: CreateOrderRequest }
  | { ok: false; code: OrderErrorCode; detail: string }

export async function resolveGoogleDeliveryAddress(
  order: CreateOrderRequest, deps: OrderAddressDeps = defaultOrderAddressDeps(),
): Promise<ResolvedOrderAddress> {
  if (order.type !== 'delivery' || !order.delivery || !order.googlePlaceId) return { ok: true, order }
  const { city } = order.delivery

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? PLACE_VERIFY_TIMEOUT_MS)
  let details: PlaceDetailsDiagnostic
  try {
    details = await deps.lookup(order.googlePlaceId, city, controller.signal)
  } catch (e) {
    const code = e instanceof PlacesError ? e.message : 'places_error'
    if (!controller.signal.aborted && NOT_FOUND_CODES.includes(code))
      return { ok: false, code: 'address_not_verified', detail: 'place_not_found' }
    deps.log(controller.signal.aborted ? 'google_verify_timeout' : 'google_verify_unavailable')
    return { ok: true, order: { ...order, googleAddress: { status: 'unavailable' } } }
  } finally {
    clearTimeout(timer)
  }

  const v = verifyDeliveryPlace(details, city)
  if (!v.ok) return { ok: false, code: 'address_not_verified', detail: v.reason }
  return {
    ok: true,
    order: {
      ...order,
      delivery: { ...order.delivery, street: v.value.street, houseNumber: v.value.houseNumber },
      googleAddress: { status: 'verified', lat: v.value.lat, lng: v.value.lng },
    },
  }
}
