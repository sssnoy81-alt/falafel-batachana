// Optional parcel attached to a DELIVERY order at checkout (GATE S4-A). Pure: no I/O, no process.env.
// Validation mirrors the public.parcel_requests constraints installed by parcel_01 (the database stays the final
// authority — anything that slips through is rejected there and mapped to 400 invalid_parcel by the route):
//   tracking_ref ~ '^[A-Za-z0-9 ._/#-]{4,40}$', trimmed, no double spaces;
//   tracking_key = upper(tracking_ref without non-alphanumerics), 4–40 characters (generated column);
//   carrier NULL or 1–40 characters, trimmed, no control characters, no URL-like text;
//   recipient_name NULL or 2–60 characters, trimmed, no control characters (Migration 05, S4-PARCEL-30B).
// Never log a tracking reference, a carrier value or a recipient name.

export interface ParcelCheckoutInput {
  /** Normalized (trimmed, single spaces) — exactly what is stored. */
  trackingRef: string
  /** Trimmed carrier name, or null when not given. */
  carrier: string | null
  /** Name printed on the parcel when it differs from the food customer. Present ONLY when a value was entered —
   *  omitted (never null / '') otherwise, so a parcel without it is byte-for-byte the pre-Migration-05 payload. */
  recipientName?: string
}

export const PARCEL_TRACKING_REF_REGEX = /^[A-Za-z0-9 ._/#-]{4,40}$/
/** Same 40 as PARCEL_TRACKING_REF_REGEX (normalized length); used only for a clearer "too long" message. */
export const MAX_PARCEL_TRACKING_REF = 40
export const MAX_PARCEL_CARRIER = 40
/** Same 2–60 rule as the food customer's name (orderRequest / MAX_CUSTOMER_NAME); counted in characters (code points),
 *  like PostgreSQL char_length in parcel_requests_recipient_name_format. */
export const MIN_PARCEL_RECIPIENT_NAME = 2
export const MAX_PARCEL_RECIPIENT_NAME = 60
/** Upper bound on raw input before any processing (rejects oversized payloads early). */
export const MAX_RAW_PARCEL_FIELD = 200
// PostgreSQL [[:cntrl:]] in a UTF-8 database: C0 controls, DEL and C1 controls.
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/
const URL_LIKE = /(https?:|www\.|\/\/)/i

/** Server-side feature flag. Only the exact string 'true' enables parcel checkout; anything else is OFF. */
export const isParcelCheckoutEnabled = (env: Record<string, string | undefined>): boolean =>
  env.PARCEL_CHECKOUT_ENABLED === 'true'

/** Same normalization as the database's generated tracking_key column (duplicate detection key). */
export const parcelTrackingKey = (trackingRef: string): string => trackingRef.replace(/[^A-Za-z0-9]/g, '').toUpperCase()

export type ParcelParseResult = { ok: true; value: ParcelCheckoutInput } | { ok: false; detail: string }

export function parseParcelCheckout(raw: unknown): ParcelParseResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, detail: 'invalid_parcel_shape' }
  const keys = Object.keys(raw)
  if (keys.some(k => k !== 'trackingRef' && k !== 'carrier' && k !== 'recipientName')) return { ok: false, detail: 'unexpected_parcel_field' }
  const { trackingRef, carrier, recipientName } = raw as { trackingRef?: unknown; carrier?: unknown; recipientName?: unknown }

  if (typeof trackingRef !== 'string' || trackingRef.length > MAX_RAW_PARCEL_FIELD) return { ok: false, detail: 'invalid_tracking_ref' }
  const ref = trackingRef.trim().replace(/ {2,}/g, ' ')
  if (!PARCEL_TRACKING_REF_REGEX.test(ref)) return { ok: false, detail: 'invalid_tracking_ref' }
  const key = parcelTrackingKey(ref)
  if (key.length < 4 || key.length > 40) return { ok: false, detail: 'invalid_tracking_ref' }

  let parsedCarrier: string | null = null
  if (carrier !== undefined && carrier !== null) {
    if (typeof carrier !== 'string' || carrier.length > MAX_RAW_PARCEL_FIELD) return { ok: false, detail: 'invalid_carrier' }
    const c = carrier.trim()
    if (c !== '') {
      if (c.length > MAX_PARCEL_CARRIER || CONTROL_CHARS.test(c) || URL_LIKE.test(c)) return { ok: false, detail: 'invalid_carrier' }
      parsedCarrier = c
    }
  }

  // Optional recipient name: missing / null / '' / whitespace-only → not provided (key omitted, stored as NULL).
  let parsedRecipient: string | null = null
  if (recipientName !== undefined && recipientName !== null) {
    if (typeof recipientName !== 'string' || recipientName.length > MAX_RAW_PARCEL_FIELD) return { ok: false, detail: 'invalid_recipient_name' }
    const n = recipientName.trim()
    if (n !== '') {
      const chars = [...n].length
      if (chars < MIN_PARCEL_RECIPIENT_NAME || chars > MAX_PARCEL_RECIPIENT_NAME || CONTROL_CHARS.test(n))
        return { ok: false, detail: 'invalid_recipient_name' }
      parsedRecipient = n
    }
  }
  return { ok: true, value: { trackingRef: ref, carrier: parsedCarrier, ...(parsedRecipient !== null ? { recipientName: parsedRecipient } : {}) } }
}
