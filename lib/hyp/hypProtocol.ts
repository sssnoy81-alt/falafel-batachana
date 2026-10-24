// Hyp Pay protocol helpers (HYP-06). Pure: no env, no network, no logging.
// Order-preserving query-string handling, exact agorot ↔ amount conversion, identifier formats and log redaction.
// Formats deliberately equal the HYP-05 database rules (db/migrations/hyp05_payment_intents.sql), so anything
// accepted here is accepted there and vice versa (checked by scripts/verify-hyp-client.mjs).

/** Documented endpoint for SIGN, the payment page and VERIFY (developers.hyp.co.il/pay). Not configurable on purpose. */
export const HYP_PAY_URL = 'https://pay.hyp.co.il/p/'

export const HYP_ORDER_REF_RE = /^[A-Z0-9]{8,32}$/        // payment_intents_hyp_order_ref_format
export const HYP_TRANS_ID_RE = /^[0-9A-Za-z]{1,40}$/       // payment_transactions_trans_id_format
export const HYP_CCODE_RE = /^[0-9]{1,6}$/                 // payment_transactions_ccode_format
export const HYP_ACODE_RE = /^[0-9A-Za-z]{1,20}$/          // payment_transactions_acode_format
export const HYP_AMOUNT_RE = /^([0-9]{1,6})(?:\.([0-9]{1,2}))?$/   // record_hyp_verification Amount rule
export const HYP_RETURN_RAW_RE = /^[A-Za-z0-9._~%=&+*:,/-]+$/      // record_hyp_return charset
export const HYP_RETURN_RAW_MAX = 4000                             // payment_returns_raw_length
export const HYP_VERIFY_RESPONSE_MAX = 2000                        // payment_returns_response_length
export const HYP_MAX_AMOUNT_AGOROT = 500000                        // payment_intents_amount_matches_snapshot

export interface QueryPair {
  readonly key: string
  readonly rawValue: string   // exactly as received (still URL-encoded)
}

const KEY_RE = /^[A-Za-z0-9_]{1,40}$/

/** Splits a query string into pairs IN ORIGINAL ORDER without re-encoding anything. null when malformed. */
export function parseQueryPairs(raw: string): QueryPair[] | null {
  const s = raw.startsWith('?') ? raw.slice(1) : raw
  if (!s) return null
  const pairs: QueryPair[] = []
  for (const segment of s.split('&')) {
    const eq = segment.indexOf('=')
    if (eq <= 0) return null
    const key = segment.slice(0, eq)
    if (!KEY_RE.test(key)) return null
    pairs.push({ key, rawValue: segment.slice(eq + 1) })
  }
  return pairs
}

export const keyCount = (pairs: readonly QueryPair[], key: string) => pairs.filter(p => p.key === key).length

/** The single raw value of `key`; undefined when absent; null when it appears more than once. */
export function singleValue(pairs: readonly QueryPair[], key: string): string | null | undefined {
  const found = pairs.filter(p => p.key === key)
  if (found.length === 0) return undefined
  return found.length === 1 ? found[0].rawValue : null
}

/** Exact agorot → documented "Amount" text with two decimals (shekels). Throws on anything but a safe positive integer. */
export function agorotToAmount(agorot: number): string {
  if (!Number.isSafeInteger(agorot) || agorot < 1 || agorot > HYP_MAX_AMOUNT_AGOROT) throw new RangeError('amount_out_of_range')
  return `${Math.floor(agorot / 100)}.${String(agorot % 100).padStart(2, '0')}`
}

/** "Amount" text → exact agorot (no floating point). null when the text is not 1–6 digits with ≤ 2 decimals. */
export function amountToAgorot(text: string): number | null {
  const m = HYP_AMOUNT_RE.exec(text)
  if (!m) return null
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'))
}

// Values that must never reach a log line: credentials, signatures and customer / card data.
const SENSITIVE_KEYS = ['KEY', 'PassP', 'signature', 'Sign', 'UserId', 'ClientName', 'ClientLName', 'street', 'city', 'zip',
  'email', 'cell', 'phone', 'L4digit', 'Tmonth', 'Tyear', 'CardNum', 'Hesh', 'Fild1', 'Fild2', 'Fild3', 'Info', 'Bank', 'Brand', 'Issuer']
const SENSITIVE_RE = new RegExp(`(^|[?&])(${SENSITIVE_KEYS.join('|')})=([^&]*)`, 'gi')

/** Redacts sensitive query-string values and every given secret occurrence (secrets shorter than 4 chars are ignored). */
export function redactHypText(text: string, secrets: readonly string[] = []): string {
  let out = text.replace(SENSITIVE_RE, (_m, sep: string, key: string) => `${sep}${key}=[redacted]`)
  for (const secret of secrets) {
    if (!secret || secret.length < 4) continue
    out = out.split(secret).join('[redacted]')
    const encoded = encodeURIComponent(secret)
    if (encoded !== secret) out = out.split(encoded).join('[redacted]')
  }
  return out
}
