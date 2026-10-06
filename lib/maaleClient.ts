// SERVER-ONLY Maale Express HTTP client (FALAFEL-SN-08D10). DISABLED unless MAALE_EXPRESS_ENABLED === 'true'.
// Sends exactly the payload produced by lib/maalePayload (never rebuilds it). One attempt per call — retry policy
// belongs to the dispatch service. Never logs; the API key is only placed in the X-Api-Key header; provider raw
// responses are reduced to a normalized result here and never returned to browser callers.

import { MAALE_ORDERS_URL, type MaaleOrderPayload } from './maalePayload'

type FetchLike = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string; cache: 'no-store'; signal: AbortSignal }) =>
  Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>
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

/* ─── Normalized result ─── */

export type MaaleErrorCode =
  | 'zone_unknown' | 'dispatch_closed' | 'unauthorized' | 'provider_5xx' | 'rate_limited'
  | 'timeout' | 'network_error' | 'invalid_response' | 'provider_rejected' | 'maale_not_configured'

export type MaaleSendResult =
  | { ok: true; kind: 'created' | 'duplicate'; status: 200 | 201; providerOrderId?: string; providerStatus?: string }
  | { ok: false; retryable: boolean; errorCode: MaaleErrorCode; status?: number }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

// Response fields are NOT documented in detail yet: only take values that fit our DB CHECK formats, otherwise ignore.
const providerOrderIdOf = (b: unknown): string | undefined => {
  if (!isObj(b)) return undefined
  for (const k of ['order_id', 'id']) {
    const v = b[k]
    const s = typeof v === 'number' && Number.isFinite(v) ? String(v) : typeof v === 'string' ? v.trim() : ''
    if (s && s.length <= 100) return s
  }
  return undefined
}
const providerStatusOf = (b: unknown): string | undefined =>
  isObj(b) && typeof b.status === 'string' && /^[a-z_]{1,40}$/.test(b.status) ? b.status : undefined

/** Pure classification of an HTTP status + (possibly unparsable) body. */
export function classifyMaaleResponse(status: number, body: unknown): MaaleSendResult {
  if (status === 201 || status === 200) {
    const providerOrderId = providerOrderIdOf(body)
    const providerStatus = providerStatusOf(body)
    return {
      ok: true, kind: status === 201 ? 'created' : 'duplicate', status,
      ...(providerOrderId ? { providerOrderId } : {}), ...(providerStatus ? { providerStatus } : {}),
    }
  }
  if (status === 400) {
    if (isObj(body) && body.code === 'zone_unknown') return { ok: false, retryable: false, errorCode: 'zone_unknown', status }
    if (isObj(body) && body.dispatch_closed === true) return { ok: false, retryable: false, errorCode: 'dispatch_closed', status }
    return { ok: false, retryable: false, errorCode: 'provider_rejected', status }
  }
  if (status === 401 || status === 403) return { ok: false, retryable: false, errorCode: 'unauthorized', status }
  if (status >= 500 && status <= 599) return { ok: false, retryable: true, errorCode: 'provider_5xx', status }
  if (status === 408 || status === 429) return { ok: false, retryable: true, errorCode: 'rate_limited', status }
  // Other 2xx: undocumented — not trusted as success; retrying is safe (same external_order_id is idempotent).
  if (status >= 200 && status <= 299) return { ok: false, retryable: true, errorCode: 'invalid_response', status }
  return { ok: false, retryable: false, errorCode: 'provider_rejected', status } // other 4xx / unexpected
}

/* ─── Send (one attempt) ─── */

export async function sendMaaleOrder(
  payload: MaaleOrderPayload,
  opts: { config: MaaleConfig; fetchImpl: FetchLike; timeoutMs?: number },
): Promise<MaaleSendResult> {
  // Absolutely no network unless explicitly enabled and configured.
  if (opts.config.status !== 'ready') return { ok: false, retryable: false, errorCode: 'maale_not_configured' }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? MAALE_TIMEOUT_MS)
  let res: Awaited<ReturnType<FetchLike>>
  try {
    res = await opts.fetchImpl(MAALE_ORDERS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': opts.config.apiKey },
      body: JSON.stringify(payload),
      cache: 'no-store',
      signal: controller.signal,
    })
  } catch {
    clearTimeout(timer)
    return { ok: false, retryable: true, errorCode: controller.signal.aborted ? 'timeout' : 'network_error' }
  }
  let body: unknown = null
  try { body = await res.json() } catch { body = null } // malformed / empty / aborted body → classified by status
  finally { clearTimeout(timer) }                       // the timeout also bounds reading the body
  return classifyMaaleResponse(res.status, body)
}
