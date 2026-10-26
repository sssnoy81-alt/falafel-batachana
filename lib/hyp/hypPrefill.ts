// SERVER-ONLY customer details pre-fill for the Hyp Pay hosted payment page (S4-HYP-PREFILL-01). Pure.
//
// Source: ONLY the server-built payment-intent snapshot (the order the server validated: customer_name, normalized
// phone, and for a delivery the verified street / house number / city). Nothing is invented: no email and no Israeli
// ID are collected, so `email` / `UserId` are never sent; a one-word name fills ClientName only.
// Documented APISign SIGN customer parameters (developers.hyp.co.il/pay, API Actions): UserId, ClientName,
// ClientLName, street, city, email, cell — all optional. Whether the payment page DISPLAYS them is not documented
// (it depends on the page template); a value that is not a plain printable text is dropped, never "repaired".
// Observed on the Production page (owner screenshots, S4-HYP-PREFILL-03): first name, last name, email, card, expiry,
// CVV and Israeli ID are required there; mobile, address, city and ZIP optional. Email / ID / card stay for the
// customer to enter on HYP — never sent from here.

if (typeof window !== 'undefined') {
  throw new Error('lib/hyp/hypPrefill is server-only')
}

/** The SIGN customer parameters we may send, in the order they are appended to the request. */
export const HYP_PREFILL_KEYS = ['ClientName', 'ClientLName', 'cell', 'street', 'city'] as const
export type HypPrefillKey = (typeof HYP_PREFILL_KEYS)[number]
export type HypCustomerPrefill = Partial<Record<HypPrefillKey, string>>

/** Letters (Hebrew / Latin / any script), combining marks, digits, space and the punctuation of names / addresses
 *  (geresh ׳, gershayim ״, apostrophe, quote, dot, comma, hyphen, slash, parentheses). No control or URL syntax. */
export const HYP_PREFILL_VALUE_RE = /^[\p{L}\p{M}\p{N} '".,\-/()׳״]{1,60}$/u
const CELL_RE = /^05\d{8}$/

const clean = (v: unknown): string | null => {
  if (typeof v !== 'string') return null
  const s = v.normalize('NFC').replace(/\s+/g, ' ').trim()
  return s && HYP_PREFILL_VALUE_RE.test(s) ? s : null
}

export interface PrefillSource {
  p_order: { customer_name?: unknown; phone?: unknown }
  p_delivery?: { street?: unknown; house_number?: unknown; city?: unknown }
}

/** Customer details for the SIGN request; only fields we really have and that are valid plain text.
 *  S4-HYP-PREFILL-03: `names` = the first / last name the customer entered separately (lib/customerName, checked
 *  against the snapshot's full name by the caller); without it (an older page) the full name is split as before. */
export function customerPrefillFromSnapshot(s: PrefillSource, names?: { first: string; last: string } | null): HypCustomerPrefill {
  const out: HypCustomerPrefill = {}
  const name = clean(s.p_order.customer_name)
  if (names) {
    const first = clean(names.first), last = clean(names.last)
    if (first) out.ClientName = first
    if (last) out.ClientLName = last
  } else if (name) {
    const space = name.indexOf(' ')
    if (space === -1) out.ClientName = name
    else { out.ClientName = name.slice(0, space); out.ClientLName = name.slice(space + 1) }
  }
  if (typeof s.p_order.phone === 'string' && CELL_RE.test(s.p_order.phone)) out.cell = s.p_order.phone
  if (s.p_delivery) {
    const street = clean(s.p_delivery.street), house = clean(s.p_delivery.house_number), city = clean(s.p_delivery.city)
    const line = street && house ? clean(`${street} ${house}`) : street
    if (line) out.street = line
    if (city) out.city = city
  }
  return out
}

/** True when every key is a documented prefill key and every value passes the same rule (SIGN builder re-check). */
export function isValidPrefill(p: HypCustomerPrefill): boolean {
  return Object.entries(p).every(([k, v]) => (HYP_PREFILL_KEYS as readonly string[]).includes(k) && typeof v === 'string'
    && (k === 'cell' ? CELL_RE.test(v) : HYP_PREFILL_VALUE_RE.test(v)))
}
