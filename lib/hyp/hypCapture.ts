// Original-bytes envelope for the Hyp Pay success redirect (HYP-32). Pure: no env, no I/O, no logging.
//
// Next.js re-serializes every incoming query string before any application code runs (%20 → '+', '@' → '%40',
// lowercase hex → uppercase, …; reproduced on 15.5.28, 16.1.6 and 16.4.3 — HYP-29 / HYP-30), and that cannot be undone.
// The Hyp portal therefore points its success URL at a plain Vercel Function outside Next.js (api/hyp-return.js),
// which takes the request target's query exactly as received and redirects to
//   /api/payments/hyp/return?r=<canonical base64url of those bytes>
// Base64url (A–Z a–z 0–9 - _) passes Next.js unchanged, so the route can recover the original query byte for byte.
// The envelope is NOT trusted: the decoded query goes through the unchanged parser, record_hyp_return and server-side
// VERIFY exactly like before; only a VERIFY CCode=0 can ever lead to an order.

/** The single parameter name carrying the envelope. */
export const HYP_CAPTURE_PARAM = 'r'
/** Same bound as the stored callback (payment_returns.return_raw / HYP_RETURN_RAW_MAX). */
export const HYP_CAPTURE_RAW_MAX = 4000
const ENVELOPE_MAX = Math.ceil((HYP_CAPTURE_RAW_MAX * 4) / 3)
const ENVELOPE_RE = /^r=([A-Za-z0-9_-]+)$/

export type CaptureDecode =
  | { kind: 'legacy' }                                            // not an envelope: the query is the callback itself
  | { kind: 'envelope'; raw: string }                             // the original callback bytes
  | { kind: 'invalid'; reason: 'envelope_malformed' | 'envelope_not_canonical' | 'envelope_too_long' | 'envelope_empty' }

/**
 * Classifies a route query string (without the leading '?'). An envelope is exactly `r=<base64url>` — no other
 * parameter, no repetition, no padding, canonical encoding only (re-encoding the decoded bytes must give the same text),
 * so one callback has exactly one envelope. Anything else that mentions the parameter is refused (fail closed); a query
 * that does not start with it is the legacy form (callbacks already in flight before the portal switch).
 */
export function decodeCaptureEnvelope(search: string): CaptureDecode {
  const q = search.startsWith('?') ? search.slice(1) : search
  if (!/(^|&)r=/.test(q)) return { kind: 'legacy' }
  const m = ENVELOPE_RE.exec(q)
  if (!m) return { kind: 'invalid', reason: 'envelope_malformed' }
  if (m[1].length > ENVELOPE_MAX) return { kind: 'invalid', reason: 'envelope_too_long' }
  const bytes = Buffer.from(m[1], 'base64url')
  if (bytes.toString('base64url') !== m[1]) return { kind: 'invalid', reason: 'envelope_not_canonical' }
  if (bytes.length === 0) return { kind: 'invalid', reason: 'envelope_empty' }
  if (bytes.length > HYP_CAPTURE_RAW_MAX) return { kind: 'invalid', reason: 'envelope_too_long' }
  return { kind: 'envelope', raw: bytes.toString('latin1') }
}

/** The envelope the capture function builds (mirrored in api/hyp-return.js, asserted equal by the tests). */
export const encodeCaptureEnvelope = (raw: string): string => Buffer.from(raw, 'latin1').toString('base64url')
