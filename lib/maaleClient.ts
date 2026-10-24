// SERVER-ONLY Maale Express HTTP client (FALAFEL-SN-08D10, contract per the provider doc of 21 Oct 2026 — S4-INTEGRATIONS-03E).
// DISABLED unless MAALE_EXPRESS_ENABLED === 'true'. Never logs; the API key is only placed in the X-Api-Key header; provider
// raw responses are reduced to normalized results here and never returned to browser callers.
//
// Two separate operations:
//  - sendMaaleOrder  → a REAL order (exactly the lib/maalePayload body; a body carrying dry_run is refused). One attempt
//                      per call — retry policy belongs to the dispatch service.
//  - quoteMaaleOrder → a dry_run QUOTATION ("dry_run": true added here and only here). Creates nothing, touches no
//                      dispatch state; must use a dedicated quote id (newQuoteExternalId), never an orders.id.
// A 200 carrying would_create / dry_run is a quote and is NEVER reported as a dispatched order.

import { MAALE_ORDERS_URL, type MaaleOrderPayload } from './maalePayload'

type FetchLike = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string; cache: 'no-store'; signal: AbortSignal }) =>
  Promise<{ ok: boolean; status: number; json(): Promise<unknown>; headers?: { get(name: string): string | null } }>
type EnvLike = Record<string, string | undefined>

export const MAALE_TIMEOUT_MS = 7000

/* ─── Config ─── */

export type MaaleConfig = { status: 'disabled' } | { status: 'not_configured' } | { status: 'ready'; apiKey: string }

/** Default OFF: anything other than the exact string 'true' is disabled. Missing key → not_configured. */
export function resolveMaaleConfig(env: EnvLike): MaaleConfig {
  if (env.MAALE_EXPRESS_ENABLED !== 'true') return { status: 'disabled' }
  const apiKey = (env.MAALE_EXPRESS_API_KEY ?? '').trim()
  return apiKey ? { status: 'ready', apiKey } : { status: 'not_configured' }
}

/* ─── Normalized results ─── */

// Every code fits delivery_dispatches.error_code CHECK ^[a-z0-9_]{1,64}$.
export type MaaleErrorCode =
  | 'zone_unknown' | 'out_of_area' | 'amount_too_high' | 'dispatch_closed' | 'validation_error'
  | 'unauthorized' | 'blocked' | 'idempotency_mismatch' | 'rate_limited'
  | 'provider_5xx' | 'timeout' | 'network_error' | 'invalid_response' | 'provider_rejected' | 'maale_not_configured'
  | 'unexpected_quote_response' // a real send was answered like a dry_run → never treated as dispatched
  | 'dry_run_not_allowed'       // a real send carried dry_run → refused before any network
  | 'quote_created_real_order'  // a quote was answered 201 → CRITICAL, a real order may exist
  | 'quote_id_required'         // a quote did not use a dedicated quote id → refused before any network

/** Fields read only when they fit our DB CHECK formats; anything else is ignored. */
export interface MaaleOrderInfo {
  providerOrderId?: string   // order.id — 1..100 chars (delivery_dispatches.provider_order_id)
  providerStatus?: string    // order.status — ^[a-z_]{1,40}$ (delivery_dispatches.provider_status)
  zone?: string              // order.zone — provider zone code; never assumed to equal our settlement name
  deliveryFeeAgorot?: number // same field name as would_create, when present
}

export type MaaleSendResult =
  | ({ ok: true; kind: 'created' | 'duplicate'; status: 200 | 201 } & MaaleOrderInfo)
  | {
      ok: false; retryable: boolean; errorCode: MaaleErrorCode; status?: number
      /** true when the provider may or may not have created the order (timeout, network, 5xx, unexpected 2xx):
       *  retry ONLY with the same external_order_id. */
      ambiguous?: boolean
      retryAfterSec?: number   // 429 Retry-After
      providerOrderId?: string // 402 blocked: the provider's order id when given
      providerCode?: string    // the provider's code (e.g. daily_limit), sanitized
    }

export interface MaaleQuote {
  ok: true; kind: 'quote'; status: 200
  zone?: string
  deliveryFeeAgorot?: number
  chargedFromWalletAgorot?: number
  courierCollectsFromCustomerAgorot?: number
  courierPaysMerchantAgorot?: number
  warnings: string[]
}
export type MaaleQuoteResult = MaaleQuote | Extract<MaaleSendResult, { ok: false }>

/* ─── Parsing helpers (pure) ─── */

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const idOf = (v: unknown): string | undefined => {
  const s = typeof v === 'number' && Number.isFinite(v) ? String(v) : typeof v === 'string' ? v.trim() : ''
  return s && s.length <= 100 ? s : undefined
}
const statusOf = (v: unknown): string | undefined => (typeof v === 'string' && /^[a-z_]{1,40}$/.test(v) ? v : undefined)
const zoneOf = (v: unknown): string | undefined => (typeof v === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(v) ? v : undefined)
const codeOf = (v: unknown): string | undefined => (typeof v === 'string' && /^[a-z0-9_]{1,64}$/.test(v) ? v : undefined)
const agorotOf = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 100_000_000 ? v : undefined
const prune = <T extends Record<string, unknown>>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T

/** Retry-After: delta-seconds or an HTTP date; undefined when absent / unparsable. Capped at one day. */
export function parseRetryAfter(value: string | null | undefined, nowMs: number = Date.now()): number | undefined {
  if (!value) return undefined
  const v = value.trim()
  if (/^\d{1,10}$/.test(v)) return Math.min(Number(v), 86_400)
  const at = Date.parse(v)
  return Number.isFinite(at) ? Math.min(Math.max(0, Math.ceil((at - nowMs) / 1000)), 86_400) : undefined
}

/** order.* fields (documented nesting), with the earlier top-level keys as a fallback; DB formats only. */
function orderInfoOf(b: unknown): MaaleOrderInfo {
  if (!isObj(b)) return {}
  const o = isObj(b.order) ? b.order : null
  return prune({
    providerOrderId: idOf(o?.id) ?? idOf(b.order_id) ?? idOf(b.id),
    providerStatus: statusOf(o?.status) ?? statusOf(b.status),
    zone: zoneOf(o?.zone),
    deliveryFeeAgorot: agorotOf(o?.delivery_fee_agorot),
  })
}

const isQuoteBody = (b: unknown): boolean => isObj(b) && (b.dry_run === true || isObj(b.would_create))

/** Non-success statuses shared by real sends and quotes. */
function classifyFailure(status: number, body: unknown, retryAfter?: string | null): Extract<MaaleSendResult, { ok: false }> {
  const b = isObj(body) ? body : {}
  const providerCode = codeOf(b.code)
  const fail = (errorCode: MaaleErrorCode, retryable: boolean, extra: Record<string, unknown> = {}) =>
    prune({ ok: false as const, retryable, errorCode, status, ...extra }) as Extract<MaaleSendResult, { ok: false }>
  if (status === 400) {
    if (b.dispatch_closed === true) return fail('dispatch_closed', false)
    if (providerCode === 'zone_unknown' || providerCode === 'out_of_area' || providerCode === 'amount_too_high') return fail(providerCode, false)
    return fail('validation_error', false, { providerCode })
  }
  if (status === 401 || status === 403) return fail('unauthorized', false)
  if (status === 402) return fail('blocked', false, { providerOrderId: idOf(b.order_id) ?? orderInfoOf(b).providerOrderId, providerCode })
  // Any 409: the external_order_id was already used with different details. Final — never a new id automatically.
  if (status === 409) return fail('idempotency_mismatch', false, { providerCode })
  if (status === 429) return fail('rate_limited', true, { retryAfterSec: parseRetryAfter(retryAfter), providerCode })
  if (status === 408) return fail('timeout', true, { ambiguous: true })
  if (status >= 500 && status <= 599) return fail('provider_5xx', true, { ambiguous: true })
  // Other 2xx: undocumented — not trusted as success; may have created the order → retry only with the same id.
  if (status >= 200 && status <= 299) return fail('invalid_response', true, { ambiguous: true })
  return fail('provider_rejected', false, { providerCode }) // other 4xx / unexpected
}

/** Pure classification of a REAL send's HTTP status + (possibly unparsable) body. */
export function classifyMaaleResponse(status: number, body: unknown, retryAfter?: string | null): MaaleSendResult {
  if (status === 201) return { ok: true, kind: 'created', status, ...orderInfoOf(body) }
  if (status === 200) {
    // A quote-shaped answer to a real send is NOT a dispatch: final, nothing marked as sent.
    if (isQuoteBody(body)) return { ok: false, retryable: false, errorCode: 'unexpected_quote_response', status }
    return { ok: true, kind: 'duplicate', status, ...orderInfoOf(body) } // same external_order_id + same details
  }
  return classifyFailure(status, body, retryAfter)
}

/** Pure classification of a QUOTE (dry_run) answer. Only "200 + ok: true + would_create" is a quote. */
export function classifyMaaleQuoteResponse(status: number, body: unknown, retryAfter?: string | null): MaaleQuoteResult {
  if (status === 201) {
    // The provider created a real order although dry_run was sent: surface loudly, never as a quote.
    return prune({ ok: false as const, retryable: false, errorCode: 'quote_created_real_order' as const, status, providerOrderId: orderInfoOf(body).providerOrderId })
  }
  if (status === 200) {
    const b = isObj(body) ? body : null
    const wc = b && isObj(b.would_create) ? b.would_create : null
    if (!b || b.ok !== true || !wc) return { ok: false, retryable: false, errorCode: 'invalid_response', status }
    return prune({
      ok: true as const, kind: 'quote' as const, status: 200 as const,
      zone: zoneOf(wc.zone),
      deliveryFeeAgorot: agorotOf(wc.delivery_fee_agorot),
      chargedFromWalletAgorot: agorotOf(wc.charged_from_wallet_agorot),
      courierCollectsFromCustomerAgorot: agorotOf(wc.courier_collects_from_customer_agorot),
      courierPaysMerchantAgorot: agorotOf(wc.courier_pays_merchant_agorot),
      warnings: Array.isArray(b.warnings)
        ? b.warnings.map(w => codeOf(w) ?? (isObj(w) ? codeOf(w.code) : undefined)).filter((w): w is string => !!w).slice(0, 10)
        : [],
    })
  }
  return classifyFailure(status, body, retryAfter)
}

/* ─── Network (one attempt per call) ─── */

async function postOnce(body: string, apiKey: string, fetchImpl: FetchLike, timeoutMs: number):
  Promise<{ status: number; body: unknown; retryAfter: string | null } | { error: 'timeout' | 'network_error' }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let res: Awaited<ReturnType<FetchLike>>
  try {
    res = await fetchImpl(MAALE_ORDERS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
      body,
      cache: 'no-store',
      signal: controller.signal,
    })
  } catch {
    clearTimeout(timer)
    return { error: controller.signal.aborted ? 'timeout' : 'network_error' }
  }
  let parsed: unknown = null
  try { parsed = await res.json() } catch { parsed = null } // malformed / empty / aborted body → classified by status
  finally { clearTimeout(timer) }                           // the timeout also bounds reading the body
  return { status: res.status, body: parsed, retryAfter: res.headers?.get?.('retry-after') ?? null }
}

/** REAL order: sends exactly the lib/maalePayload body. A body carrying dry_run is refused (use quoteMaaleOrder). */
export async function sendMaaleOrder(
  payload: MaaleOrderPayload,
  opts: { config: MaaleConfig; fetchImpl: FetchLike; timeoutMs?: number },
): Promise<MaaleSendResult> {
  // Absolutely no network unless explicitly enabled and configured.
  if (opts.config.status !== 'ready') return { ok: false, retryable: false, errorCode: 'maale_not_configured' }
  if (Object.prototype.hasOwnProperty.call(payload, 'dry_run')) return { ok: false, retryable: false, errorCode: 'dry_run_not_allowed' }
  const r = await postOnce(JSON.stringify(payload), opts.config.apiKey, opts.fetchImpl, opts.timeoutMs ?? MAALE_TIMEOUT_MS)
  if ('error' in r) return { ok: false, retryable: true, errorCode: r.error, ambiguous: true }
  return classifyMaaleResponse(r.status, r.body, r.retryAfter)
}

/** Dedicated id for a quotation, never an orders.id (provider idempotency is per external_order_id). */
export const QUOTE_ID_PREFIX = 'q-'
export const newQuoteExternalId = (): string => `${QUOTE_ID_PREFIX}${globalThis.crypto.randomUUID()}`
const QUOTE_ID = /^q-[A-Za-z0-9_-]{1,78}$/ // provider rule: [A-Za-z0-9_-], ≤ 80

/** QUOTATION: the same validated payload with "dry_run": true. Creates nothing; touches no dispatch state. */
export async function quoteMaaleOrder(
  payload: MaaleOrderPayload,
  opts: { config: MaaleConfig; fetchImpl: FetchLike; timeoutMs?: number },
): Promise<MaaleQuoteResult> {
  if (opts.config.status !== 'ready') return { ok: false, retryable: false, errorCode: 'maale_not_configured' }
  if (!QUOTE_ID.test(payload.external_order_id)) return { ok: false, retryable: false, errorCode: 'quote_id_required' }
  const body = JSON.stringify({ ...payload, dry_run: true }) // JSON boolean, added only on this path
  const r = await postOnce(body, opts.config.apiKey, opts.fetchImpl, opts.timeoutMs ?? MAALE_TIMEOUT_MS)
  if ('error' in r) return { ok: false, retryable: true, errorCode: r.error, ambiguous: true }
  return classifyMaaleQuoteResponse(r.status, r.body, r.retryAfter)
}
