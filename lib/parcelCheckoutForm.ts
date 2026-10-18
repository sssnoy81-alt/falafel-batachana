// Customer parcel checkout — form logic for app/order (GATE S4-B). Pure and client-safe: no I/O, no env access.
// The server stays authoritative (POST /api/orders re-validates and rejects parcels while PARCEL_CHECKOUT_ENABLED is
// off); this module only decides what the UI shows and what it may send. Validation reuses lib/parcelCheckout so the
// browser and the server can never disagree on the rules. Never log or persist the tracking number.

import {
  MAX_PARCEL_CARRIER, MAX_PARCEL_TRACKING_REF, MAX_RAW_PARCEL_FIELD, parseParcelCheckout, type ParcelCheckoutInput,
} from './parcelCheckout'
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
  /** Optional name printed on the parcel ('' = not provided → the food customer's name identifies the parcel). */
  recipientName: string
}

export const EMPTY_PARCEL_FORM = { selected: false, trackingRef: '', carrier: '', recipientName: '' } as const

/**
 * maxLength for the parcel inputs. Deliberately far above the 40-character rule: a browser silently cuts a pasted
 * value at maxLength, and a cut tracking number can still look valid. Over-long input must stay visible and fail
 * validation instead. Same bound as the parser's raw-input limit.
 */
export const PARCEL_INPUT_MAX_LENGTH = MAX_RAW_PARCEL_FIELD

/** Is the parcel section shown at all? Only with the flag on AND a delivery order. */
export const isParcelSectionVisible = (s: Pick<ParcelFormState, 'enabled' | 'orderType'>): boolean =>
  s.enabled === true && s.orderType === 'delivery'

/** Is a parcel part of this order (section visible and the checkbox ticked)? */
export const isParcelActive = (s: ParcelFormState): boolean => isParcelSectionVisible(s) && s.selected

export const PARCEL_FORM_MESSAGES = {
  trackingRequired: 'נא להזין את מספר המעקב של החבילה',
  trackingInvalid: 'מספר המעקב יכול להכיל אותיות באנגלית, ספרות, רווח ו-‎. _ / # -‎ (4–40 תווים)',
  trackingTooLong: 'מספר המעקב ארוך מדי — מותר עד 40 תווים. נא לבדוק שהמספר הודבק נכון',
  carrierInvalid: 'שם חברת השילוח אינו תקין (עד 40 תווים, ללא קישורים)',
  carrierTooLong: 'שם חברת השילוח ארוך מדי — מותר עד 40 תווים',
  recipientInvalid: 'שם הנמען על החבילה צריך להכיל 2–60 תווים, ללא תווים מיוחדים. אפשר גם להשאיר את השדה ריק',
} as const

/** Hebrew validation message for the parcel fields, or null when they are valid / not in use. */
export function parcelFormError(s: ParcelFormState): string | null {
  if (!isParcelActive(s)) return null
  if (s.trackingRef.trim() === '') return PARCEL_FORM_MESSAGES.trackingRequired
  // Same normalization as parseParcelCheckout — only picks the clearer message; the parser below stays the rule.
  if (s.trackingRef.trim().replace(/ {2,}/g, ' ').length > MAX_PARCEL_TRACKING_REF) return PARCEL_FORM_MESSAGES.trackingTooLong
  const p = parseParcelCheckout({ trackingRef: s.trackingRef, carrier: s.carrier, recipientName: s.recipientName })
  if (p.ok) return null
  if (p.detail === 'invalid_recipient_name') return PARCEL_FORM_MESSAGES.recipientInvalid
  if (p.detail !== 'invalid_carrier') return PARCEL_FORM_MESSAGES.trackingInvalid
  return s.carrier.trim().length > MAX_PARCEL_CARRIER ? PARCEL_FORM_MESSAGES.carrierTooLong : PARCEL_FORM_MESSAGES.carrierInvalid
}

/**
 * The `parcel` object to send with the order, or undefined. undefined → the request is built exactly as before
 * (no `parcel` key at all). Never returns a parcel for pickup, with the flag off, or when the fields are invalid.
 */
export function buildParcelWire(s: ParcelFormState): ParcelCheckoutInput | undefined {
  if (!isParcelActive(s)) return undefined
  const p = parseParcelCheckout({ trackingRef: s.trackingRef, carrier: s.carrier, recipientName: s.recipientName })
  return p.ok ? p.value : undefined   // recipientName key present only when a value was entered
}

/** Friendly Hebrew messages for the S4-A server error codes (merged into the page's existing error map). */
export const PARCEL_ORDER_ERROR_MESSAGES: Partial<Record<OrderErrorCode, string>> = {
  parcel_checkout_disabled: 'צירוף חבילה אינו זמין כרגע. אפשר לשלוח את ההזמנה בלי חבילה',
  invalid_parcel: 'פרטי החבילה אינם תקינים. נא לבדוק את מספר המעקב, את שם חברת השילוח ואת שם הנמען',
  parcel_duplicate: 'מספר המעקב הזה כבר מצורף להזמנה פעילה. נא לבדוק את המספר או ליצור קשר עם הסניף',
}
