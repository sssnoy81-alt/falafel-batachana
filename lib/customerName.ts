// Customer first / last name (S4-HYP-PREFILL-03). Pure; shared by the order page and the server.
//
// The order form asks for first name and last name separately (both required). Everything downstream keeps the
// single full name exactly as before: customerName = "<first> <last>" goes to POST /api/orders, the payment-intent
// snapshot, orders.customer_name, the kitchen and Maale. Only the HYP start body additionally carries the two parts
// (customerFirstName / customerLastName) so the payment page gets ClientName / ClientLName without guessing.

import { MAX_CUSTOMER_NAME } from './orderConfig'

/** Per part, so that "<first> <last>" always fits MAX_CUSTOMER_NAME (60). */
export const MAX_NAME_PART = Math.floor((MAX_CUSTOMER_NAME - 1) / 2)

export const normalizeNamePart = (s: string): string => s.normalize('NFC').replace(/\s+/g, ' ').trim()

export const isValidNamePart = (s: string): boolean => {
  const n = normalizeNamePart(s)
  return n.length >= 1 && n.length <= MAX_NAME_PART
}

/** The single full name every existing consumer stores / shows. */
export const joinCustomerName = (first: string, last: string): string => `${normalizeNamePart(first)} ${normalizeNamePart(last)}`

/** Only to pre-fill the two form fields from a full name saved by the old single-field form (the customer sees and
 *  can correct both before ordering): first word / the rest. A one-word saved name leaves the last name empty. */
export function splitSavedFullName(full: string): { first: string; last: string } {
  const n = normalizeNamePart(full)
  const i = n.indexOf(' ')
  return i === -1 ? { first: n, last: '' } : { first: n.slice(0, i), last: n.slice(i + 1) }
}

export type NamePartsResult = { ok: true; parts: { first: string; last: string } | null } | { ok: false }

/** Server check of the optional HYP start fields against the already-parsed full name. Absent (an older page) → null;
 *  present → both valid and exactly "<first> <last>" = customerName, otherwise refused. */
export function parseCustomerNameParts(body: Record<string, unknown>, customerName: string): NamePartsResult {
  const { customerFirstName: f, customerLastName: l } = body
  if (f === undefined && l === undefined) return { ok: true, parts: null }
  if (typeof f !== 'string' || typeof l !== 'string' || !isValidNamePart(f) || !isValidNamePart(l)) return { ok: false }
  if (joinCustomerName(f, l) !== normalizeNamePart(customerName)) return { ok: false }
  return { ok: true, parts: { first: normalizeNamePart(f), last: normalizeNamePart(l) } }
}
