// Customer parcel checkout — form logic for app/order (GATE S4-B). Pure and client-safe: no I/O, no env access.
// The server stays authoritative (POST /api/orders re-validates and rejects parcels while PARCEL_CHECKOUT_ENABLED is
// off); this module only decides what the UI shows and what it may send. Validation reuses lib/parcelCheckout so the
// browser and the server can never disagree on the rules. Never log or persist the tracking number.

import { parseParcelCheckout, type ParcelCheckoutInput } from './parcelCheckout'
import type { OrderType } from './orderConfig'
import type { OrderErrorCode } from './orderRequest'

export interface ParcelFormState {
  /** From GET /api/checkout/config; false by default and on any error (fail closed). */
  enabled: boolean
  /** The order type actually being placed (null while not chosen). */
  orderType: OrderType | null
  selected: boolean
  trackingRef: string
  carrier: string
}

export const EMPTY_PARCEL_FORM = { selected: false, trackingRef: '', carrier: '' } as const

/** Is the parcel section shown at all? Only with the flag on AND a delivery order. */
export const isParcelSectionVisible = (s: Pick<ParcelFormState, 'enabled' | 'orderType'>): boolean =>
  s.enabled === true && s.orderType === 'delivery'

/** Is a parcel part of this order (section visible and the checkbox ticked)? */
export const isParcelActive = (s: ParcelFormState): boolean => isParcelSectionVisible(s) && s.selected

export const PARCEL_FORM_MESSAGES = {
  trackingRequired: 'נא להזין את מספר המעקב של החבילה',
  trackingInvalid: 'מספר המעקב יכול להכיל אותיות באנגלית, ספרות, רווח ו-‎. _ / # -‎ (4–40 תווים)',
  carrierInvalid: 'שם חברת השילוח אינו תקין (עד 40 תווים, ללא קישורים)',
} as const

/** Hebrew validation message for the parcel fields, or null when they are valid / not in use. */
export function parcelFormError(s: ParcelFormState): string | null {
  if (!isParcelActive(s)) return null
  if (s.trackingRef.trim() === '') return PARCEL_FORM_MESSAGES.trackingRequired
  const p = parseParcelCheckout({ trackingRef: s.trackingRef, carrier: s.carrier })
  if (p.ok) return null
  return p.detail === 'invalid_carrier' ? PARCEL_FORM_MESSAGES.carrierInvalid : PARCEL_FORM_MESSAGES.trackingInvalid
}

/**
 * The `parcel` object to send with the order, or undefined. undefined → the request is built exactly as before
 * (no `parcel` key at all). Never returns a parcel for pickup, with the flag off, or when the fields are invalid.
 */
export function buildParcelWire(s: ParcelFormState): ParcelCheckoutInput | undefined {
  if (!isParcelActive(s)) return undefined
  const p = parseParcelCheckout({ trackingRef: s.trackingRef, carrier: s.carrier })
  return p.ok ? p.value : undefined
}

/** Friendly Hebrew messages for the S4-A server error codes (merged into the page's existing error map). */
export const PARCEL_ORDER_ERROR_MESSAGES: Partial<Record<OrderErrorCode, string>> = {
  parcel_checkout_disabled: 'צירוף חבילה אינו זמין כרגע. אפשר לשלוח את ההזמנה בלי חבילה',
  invalid_parcel: 'פרטי החבילה אינם תקינים. נא לבדוק את מספר המעקב ואת שם חברת השילוח',
  parcel_duplicate: 'מספר המעקב הזה כבר מצורף להזמנה פעילה. נא לבדוק את המספר או ליצור קשר עם הסניף',
}
