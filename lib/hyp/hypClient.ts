// SERVER-ONLY Hyp Pay client (HYP-06): SIGN → hosted payment page redirect → server-to-server VERIFY.
// Contract per developers.hyp.co.il/pay (Creating a Payment Page, Transaction Validation, API Actions, Status Codes).
// Never logs. Credentials appear only in the outgoing request URL, which never leaves this module (errors and results
// carry codes, never URLs). The browser's return query string is NEVER proof of payment: only a VERIFY answer is.
//
// What the documentation states (and nothing more is assumed):
//  - SIGN: GET pay.hyp.co.il/p/?action=APISign&What=SIGN&Sign=True&Masof&KEY&PassP[&Amount&Coin&Tash&Order&Info&PageLang…];
//    the answer is a query string "in the same order" with action changed to pay and a signature parameter added;
//    the customer is sent to pay.hyp.co.il/p/? + that answer, unmodified.
//  - Return: the success page receives Id, CCode, Amount, ACode, Order, Fild1–3, Sign.
//  - VERIFY: GET …?action=APISign&What=VERIFY&Masof&KEY&PassP + every success-page parameter "in the exact same order";
//    CCode=0 = validation succeeded (signature matches Hyp's record); failure = an error code (902 = authentication error).
//  - Status codes: 0 approved; 600 (J2: card checked, no charge), 700 (J5: funds held ~5 days, captured only by a
//    separate J4; requested with J5=True), 800 (postponed: charged only after commitTrans within 72 h; requested with
//    Postpone=True) are non-error codes that are NOT a capture; everything else is an error / decline. SIGN here never
//    sends J5 or Postpone, so 600 / 700 / 800 indicate a terminal configuration we did not request → reconciliation.
// NOT documented (kept ambiguous here, see HYP-06 report): whether VERIFY may be repeated, whether a declined
// transaction reaches the success page or can be VERIFYed, duplicate-Order behaviour, Order length / charset, Amount
// formatting in the return, the full VERIFY response format, and any status query or webhook (none exist in Hyp Pay).

import type { HypConfig } from './hypConfig'
import {
  HYP_ACODE_RE, HYP_CCODE_RE, HYP_ORDER_REF_RE, HYP_PAY_URL, HYP_RETURN_RAW_MAX, HYP_RETURN_RAW_RE, HYP_TRANS_ID_RE,
  HYP_VERIFY_RESPONSE_MAX, agorotToAmount, amountToAgorot, keyCount, parseQueryPairs, redactHypText, singleValue,
  type QueryPair,
} from './hypProtocol'

if (typeof window !== 'undefined') {
  throw new Error('lib/hyp/hypClient is server-only')
}

/* ─── Transport (injected in tests; the default uses fetch with no redirects and no caching) ─── */

export type HypTransport = (url: string, init: { method: 'GET'; cache: 'no-store'; redirect: 'error'; signal: AbortSignal }) =>
  Promise<{ status: number; text(): Promise<string> }>

export const HYP_TIMEOUT_MS = 10000
export const HYP_SIGN_ATTEMPTS = 2
export const HYP_VERIFY_ATTEMPTS = 2
const MAX_BODY = 8000

const defaultTransport: HypTransport = (url, init) => fetch(url, init)

type Exchange = { kind: 'response'; status: number; body: string } | { kind: 'timeout' } | { kind: 'network_error' }

async function exchange(transport: HypTransport, url: string, timeoutMs: number): Promise<Exchange> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await transport(url, { method: 'GET', cache: 'no-store', redirect: 'error', signal: controller.signal })
    const body = await res.text()
    return { kind: 'response', status: res.status, body: body.length > MAX_BODY ? body.slice(0, MAX_BODY) : body }
  } catch {
    return controller.signal.aborted ? { kind: 'timeout' } : { kind: 'network_error' }
  } finally {
    clearTimeout(timer)
  }
}

export interface HypCallOptions {
  transport?: HypTransport
  timeoutMs?: number
}

const enc = encodeURIComponent

/* ─── SIGN + hosted payment page redirect ─── */

export interface HypSignRequest {
  orderRef: string       // payment_intents.hyp_order_ref
  amountAgorot: number   // payment_intents.amount_agorot
  description: string    // "Info" shown on the payment page; no customer data
}

export type HypSignErrorCode =
  | 'invalid_input'          // refused before any network
  | 'sign_rejected'          // Hyp answered an error code instead of a signed query string
  | 'invalid_sign_response'  // not a signed query string for exactly this terminal / order / amount
  | 'credential_echo'        // the answer carries KEY / PassP → NEVER forwarded to a browser
  | 'http_status' | 'timeout' | 'network_error'

export type HypSignResult =
  | { ok: true; redirectUrl: string; attempts: number }
  | { ok: false; error: HypSignErrorCode; retryable: boolean; attempts: number; providerCode?: string; status?: number }

const DESCRIPTION_RE = /^[^\u0000-\u001f\u007f]{1,60}$/

/** The documented SIGN request. Exported for tests only — the URL contains credentials and must never be logged. */
export function buildSignUrl(config: HypConfig, req: HypSignRequest): string {
  if (!HYP_ORDER_REF_RE.test(req.orderRef)) throw new RangeError('invalid_order_ref')
  if (!DESCRIPTION_RE.test(req.description)) throw new RangeError('invalid_description')
  const pairs: [string, string][] = [
    ['action', 'APISign'], ['What', 'SIGN'], ['KEY', config.apiKey], ['PassP', config.passP], ['Masof', config.terminal],
    ['Amount', agorotToAmount(req.amountAgorot)], ['Coin', '1'], ['Tash', '1'], ['Order', req.orderRef],
    ['Info', req.description], ['PageLang', 'HEB'], ['Sign', 'True'],
  ]
  return `${HYP_PAY_URL}?${pairs.map(([k, v]) => `${k}=${enc(v)}`).join('&')}`
}

/** Validates a SIGN answer and builds the payment-page URL from it, unmodified. Pure. */
export function parseSignResponse(config: HypConfig, req: HypSignRequest, body: string):
  { ok: true; redirectUrl: string } | { ok: false; error: 'sign_rejected' | 'invalid_sign_response' | 'credential_echo'; providerCode?: string } {
  const text = body.trim()
  if (text.includes(config.apiKey) || text.includes(enc(config.apiKey)) || text.includes(config.passP) || text.includes(enc(config.passP))) {
    return { ok: false, error: 'credential_echo' }
  }
  const pairs = HYP_RETURN_RAW_RE.test(text) ? parseQueryPairs(text) : null
  if (!pairs) return { ok: false, error: 'invalid_sign_response' }
  if (keyCount(pairs, 'KEY') || keyCount(pairs, 'PassP')) return { ok: false, error: 'credential_echo' }
  const signature = singleValue(pairs, 'signature')
  if (!signature) {
    const code = singleValue(pairs, 'CCode')
    return code && HYP_CCODE_RE.test(code) && code !== '0'
      ? { ok: false, error: 'sign_rejected', providerCode: code }
      : { ok: false, error: 'invalid_sign_response' }
  }
  if (singleValue(pairs, 'action') !== 'pay' || singleValue(pairs, 'Masof') !== config.terminal
      || singleValue(pairs, 'Order') !== req.orderRef || amountToAgorot(singleValue(pairs, 'Amount') ?? '') !== req.amountAgorot) {
    return { ok: false, error: 'invalid_sign_response' }
  }
  return { ok: true, redirectUrl: `${HYP_PAY_URL}?${text}` }
}

/** SIGN. Retried only when no answer arrived (SIGN signs parameters; nothing is charged until the customer pays). */
export async function signPayment(config: HypConfig, req: HypSignRequest, opts: HypCallOptions = {}): Promise<HypSignResult> {
  let url: string
  try { url = buildSignUrl(config, req) } catch { return { ok: false, error: 'invalid_input', retryable: false, attempts: 0 } }
  const transport = opts.transport ?? defaultTransport
  let last: HypSignResult = { ok: false, error: 'network_error', retryable: true, attempts: 0 }
  for (let attempt = 1; attempt <= HYP_SIGN_ATTEMPTS; attempt++) {
    const x = await exchange(transport, url, opts.timeoutMs ?? HYP_TIMEOUT_MS)
    if (x.kind !== 'response') { last = { ok: false, error: x.kind, retryable: true, attempts: attempt }; continue }
    if (x.status >= 500) { last = { ok: false, error: 'http_status', status: x.status, retryable: true, attempts: attempt }; continue }
    if (x.status !== 200) return { ok: false, error: 'http_status', status: x.status, retryable: false, attempts: attempt }
    const parsed = parseSignResponse(config, req, x.body)
    return parsed.ok
      ? { ok: true, redirectUrl: parsed.redirectUrl, attempts: attempt }
      : { ok: false, error: parsed.error, providerCode: parsed.providerCode, retryable: false, attempts: attempt }
  }
  return last
}

/* ─── Browser return (untrusted) ─── */

export interface HypReturnFields {
  readonly transId: string
  readonly ccode: string
  readonly acode: string | null
  readonly amountAgorot: number
  readonly orderRef: string
}

export type HypReturnParse =
  | { ok: true; raw: string; pairs: readonly QueryPair[]; fields: HypReturnFields }
  | { ok: false; reason: 'empty' | 'too_long' | 'invalid_charset' | 'malformed' | 'missing_field' | 'duplicate_field' | 'invalid_field' | 'reserved_field'; field?: string }

// Keys we put in front of the return when calling VERIFY: a return carrying them could redirect the verification.
const RESERVED_RETURN_KEYS = ['action', 'What', 'KEY', 'PassP', 'Masof']

/** Structural check of the success-page query string, mirroring record_hyp_return / record_hyp_verification. */
export function parseHypReturn(rawQuery: string): HypReturnParse {
  const raw = rawQuery.startsWith('?') ? rawQuery.slice(1) : rawQuery
  if (!raw) return { ok: false, reason: 'empty' }
  if (raw.length > HYP_RETURN_RAW_MAX) return { ok: false, reason: 'too_long' }
  if (!HYP_RETURN_RAW_RE.test(raw)) return { ok: false, reason: 'invalid_charset' }
  const pairs = parseQueryPairs(raw)
  if (!pairs) return { ok: false, reason: 'malformed' }
  for (const key of RESERVED_RETURN_KEYS) if (keyCount(pairs, key)) return { ok: false, reason: 'reserved_field', field: key }
  const get = (key: string, re: RegExp, optional = false): string | null | { fail: HypReturnParse } => {
    const v = singleValue(pairs, key)
    if (v === null) return { fail: { ok: false, reason: 'duplicate_field', field: key } }
    if (v === undefined || v === '') return optional ? null : { fail: { ok: false, reason: 'missing_field', field: key } }
    return re.test(v) ? v : { fail: { ok: false, reason: 'invalid_field', field: key } }
  }
  const id = get('Id', HYP_TRANS_ID_RE), ccode = get('CCode', HYP_CCODE_RE), order = get('Order', HYP_ORDER_REF_RE)
  const amount = get('Amount', /^[0-9.]+$/), acode = get('ACode', HYP_ACODE_RE, true)
  for (const v of [id, ccode, amount, order, acode]) if (v && typeof v === 'object') return v.fail
  const agorot = amountToAgorot(amount as string)
  if (agorot === null) return { ok: false, reason: 'invalid_field', field: 'Amount' }
  return { ok: true, raw, pairs, fields: Object.freeze({ transId: id as string, ccode: ccode as string, acode: acode as string | null, amountAgorot: agorot, orderRef: order as string }) }
}

/* ─── VERIFY ─── */

export type HypVerifyOutcome =
  | 'confirmed'        // VERIFY CCode=0 AND the return says CCode=0 AND Order + Amount equal the intent
  | 'amount_mismatch'  // VERIFY CCode=0, return CCode=0, but a different amount was charged
  | 'declined'         // VERIFY CCode=0 and the return carries an error / decline code (not 0, 600, 700, 800)
  | 'not_a_charge'     // VERIFY CCode=0 but the return code is 600 / 700 / 800 (J2 / J5 / postponed): no capture, funds may be held
  | 'verify_rejected'  // VERIFY answered a non-zero code on a first, clean attempt: authenticity NOT established
  | 'unknown'          // no conclusive answer (timeout, network, 5xx, non-zero after an ambiguous attempt)
  | 'protocol_error'   // VERIFY answered something that is not a documented CCode response
  | 'invalid_return'   // the browser query string is unusable; VERIFY was NOT called
  | 'order_mismatch'   // the return's Order is not this intent's reference; VERIFY was NOT called

export interface HypVerifyInput {
  rawQuery: string              // the success-page query string exactly as received (order preserved)
  expectedOrderRef: string      // from the payment intent (server-side), never from the browser
  expectedAmountAgorot: number  // from the payment intent (server-side), never from the browser
}

export interface HypVerifyResult {
  readonly outcome: HypVerifyOutcome
  readonly stages: {
    readonly transport: 'ok' | 'failed' | 'not_called'   // an HTTP answer was received
    readonly parsed: boolean                              // the answer was a documented CCode response
    readonly identityVerified: boolean                    // Hyp confirmed these parameters (Id / Order / Sign) are its own
    readonly amountVerified: boolean                      // … and the verified Amount equals the intent amount
  }
  readonly attempts: number
  readonly verifyCode?: string       // CCode of the VERIFY answer
  readonly fields?: HypReturnFields  // parsed return fields (meaningful only when identityVerified)
  readonly verifyResponse?: string   // the VERIFY answer, redacted, for payment_returns.verify_response
  readonly reason?: string
}

const NON_CAPTURE_CODES = new Set(['600', '700', '800'])

/** The documented VERIFY request: auth parameters first, then the return query string byte-for-byte. Never log it. */
export function buildVerifyUrl(config: HypConfig, raw: string): string {
  return `${HYP_PAY_URL}?action=APISign&What=VERIFY&KEY=${enc(config.apiKey)}&PassP=${enc(config.passP)}&Masof=${enc(config.terminal)}&${raw}`
}

export async function verifyHypReturn(config: HypConfig, input: HypVerifyInput, opts: HypCallOptions = {}): Promise<HypVerifyResult> {
  const notCalled = (outcome: HypVerifyOutcome, reason: string, fields?: HypReturnFields): HypVerifyResult =>
    ({ outcome, reason, fields, attempts: 0, stages: { transport: 'not_called', parsed: false, identityVerified: false, amountVerified: false } })
  const ret = parseHypReturn(input.rawQuery)
  if (!ret.ok) return notCalled('invalid_return', ret.field ? `${ret.reason}:${ret.field}` : ret.reason)
  if (!HYP_ORDER_REF_RE.test(input.expectedOrderRef) || ret.fields.orderRef !== input.expectedOrderRef) {
    return notCalled('order_mismatch', 'order_ref_differs_from_intent', ret.fields)
  }

  const url = buildVerifyUrl(config, ret.raw)
  const transport = opts.transport ?? defaultTransport
  const secrets = [config.apiKey, config.passP]
  let ambiguousBefore = false
  let lastReason = 'no_attempt'
  for (let attempt = 1; attempt <= HYP_VERIFY_ATTEMPTS; attempt++) {
    const x = await exchange(transport, url, opts.timeoutMs ?? HYP_TIMEOUT_MS)
    if (x.kind !== 'response' || x.status >= 500) {
      ambiguousBefore = true
      lastReason = x.kind === 'response' ? `http_${x.status}` : x.kind
      continue   // VERIFY changes nothing at Hyp per the documentation (it compares against Hyp's records)
    }
    const verifyResponse = redactHypText(x.body.trim(), secrets).slice(0, HYP_VERIFY_RESPONSE_MAX)
    const base = { attempts: attempt, fields: ret.fields }
    // The browser's own parameters are not a VERIFY answer (checked before redaction, which would mask the echo).
    if (x.body.trim() === ret.raw) {
      return { ...base, outcome: 'protocol_error', reason: 'response_echoes_return',
               stages: { transport: 'ok', parsed: false, identityVerified: false, amountVerified: false } }
    }
    if (x.status !== 200) {
      return { ...base, outcome: 'protocol_error', reason: `http_${x.status}`, verifyResponse: verifyResponse || undefined,
               stages: { transport: 'ok', parsed: false, identityVerified: false, amountVerified: false } }
    }
    const pairs = HYP_RETURN_RAW_RE.test(x.body.trim()) ? parseQueryPairs(x.body.trim()) : null
    const code = pairs ? singleValue(pairs, 'CCode') : undefined
    if (!code || !HYP_CCODE_RE.test(code)) {
      return { ...base, outcome: 'protocol_error', reason: 'unparseable_verify_response', verifyResponse: verifyResponse || undefined,
               stages: { transport: 'ok', parsed: false, identityVerified: false, amountVerified: false } }
    }
    if (code !== '0') {
      // A first, clean non-zero answer is an explicit refusal. After a lost answer it may only mean "already checked"
      // (repeatability is not documented), so it stays unknown for reconciliation.
      return { ...base, verifyCode: code, verifyResponse, outcome: ambiguousBefore ? 'unknown' : 'verify_rejected',
               reason: ambiguousBefore ? 'non_zero_after_ambiguous_attempt' : `verify_ccode_${code}`,
               stages: { transport: 'ok', parsed: true, identityVerified: false, amountVerified: false } }
    }
    const amountVerified = ret.fields.amountAgorot === input.expectedAmountAgorot
    const outcome: HypVerifyOutcome = ret.fields.ccode === '0' ? (amountVerified ? 'confirmed' : 'amount_mismatch')
      : NON_CAPTURE_CODES.has(ret.fields.ccode) ? 'not_a_charge' : 'declined'
    return { ...base, verifyCode: code, verifyResponse, outcome, reason: `return_ccode_${ret.fields.ccode}`,
             stages: { transport: 'ok', parsed: true, identityVerified: true, amountVerified } }
  }
  return { outcome: 'unknown', reason: lastReason, attempts: HYP_VERIFY_ATTEMPTS, fields: ret.fields,
           stages: { transport: 'failed', parsed: false, identityVerified: false, amountVerified: false } }
}

/* ─── HYP-05 boundary: the only value a trusted server route may pass to public.record_hyp_verification ─── */

declare const verificationRecordBrand: unique symbol

/** Constructible only through toVerificationRecord (the brand is not exported). The browser never sees or sends it. */
export type HypVerificationRecord = {
  readonly returnId: string                    // payment_returns.id returned by record_hyp_return (server-side)
  readonly outcome: 'authentic' | 'rejected'   // p_outcome
  readonly verifyResponse: string              // p_verify_response (redacted VERIFY answer, 1–2000 chars)
  readonly [verificationRecordBrand]: true
}

export type HypRecordDecision =
  | { action: 'record'; record: HypVerificationRecord; expectedDbResult: HypExpectedDbResult }
  | { action: 'do_not_record'; reason: string }   // the intent stays 'returned' (suspected) for retry / reconciliation

/** The result public.record_hyp_verification returns for a first verification of a 'returned' intent (HYP-05 / 06A). */
export type HypExpectedDbResult = 'paid' | 'amount_mismatch' | 'declined' | 'not_captured' | 'rejected'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function toVerificationRecord(returnId: string, rawQuery: string, result: HypVerifyResult): HypRecordDecision {
  if (!UUID_RE.test(returnId)) return { action: 'do_not_record', reason: 'invalid_return_id' }
  const raw = rawQuery.startsWith('?') ? rawQuery.slice(1) : rawQuery
  const response = result.verifyResponse ?? ''
  const usable = response.length >= 1 && response.length <= 2000 && response !== raw && response !== redactHypText(raw)
  const make = (outcome: 'authentic' | 'rejected', expectedDbResult: HypExpectedDbResult): HypRecordDecision =>
    usable
      ? { action: 'record', expectedDbResult, record: Object.freeze({ returnId, outcome, verifyResponse: response }) as HypVerificationRecord }
      : { action: 'do_not_record', reason: 'unusable_verify_response' }
  switch (result.outcome) {
    case 'confirmed': return make('authentic', 'paid')
    case 'amount_mismatch': return make('authentic', 'amount_mismatch')
    case 'declined': return make('authentic', 'declined')
    case 'verify_rejected': return make('rejected', 'rejected')
    // HYP-06A: recorded as authentic; the database stores outcome non_capture and moves the intent to outcome_unknown
    // (blocks a new charge, refuses finalize) for staff reconciliation — never paid, never declined.
    case 'not_a_charge': return make('authentic', 'not_captured')
    default: return { action: 'do_not_record', reason: result.outcome }
  }
}

/** Arguments for public.record_hyp_verification(uuid, text, text) — server-side RPC call only. */
export const verificationRpcArgs = (r: HypVerificationRecord) =>
  ({ p_return_id: r.returnId, p_outcome: r.outcome, p_verify_response: r.verifyResponse })
