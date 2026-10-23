// S4-INTEGRATIONS-04F2 — MANUAL, OWNER-RUN PostgREST envelope probe for the two S4-04E functions.
// NEVER run automatically. Only after 04B + 04D + 04E are installed and verified, with separate owner approval:
//
//   node --env-file=.env.local scripts/s4-04e-rpc-envelope-probe.mjs --confirm=READ-ONLY-RPC-ENVELOPE-PROBE
//
// Uses the SAME client as the app (supabase-js, SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_KEY /
// SUPABASE_SERVICE_ROLE_KEY, read from the environment only). Prints neither the URL nor the key, no customer data, no
// provider data. No Maale call, no table access, no SQL text — exactly three RPC calls, in order, each ONCE; it stops at
// the first unexpected answer (no retry). Every call is NON-MUTATING by construction (proof: the function bodies in
// db/migrations/s4_04e_courier_coordination.sql, checked by scripts/verify-s4-04e-rpc-probe.mjs):
//   P1 claim_maale_dispatch(NULL, 0, NULL)            → first statement returns 'invalid_request' (before the lock / any read)
//   P2 claim_maale_dispatch(<random uuid>, -1, NULL)  → the UPDATE needs attempts = 0 AND p_seen_attempts = attempts;
//                                                       -1 never matches, so it is unreachable for ANY order id
//   P3 record_maale_reconciliation_event(…, actor 'S4-PROBE-INVALID', …)
//                                                     → first IF returns 'invalid_request' (actor fails ^[a-z0-9_-]{2,32}$)
//                                                       before any table access, for ANY ids
// Verifies the envelopes the application relies on: P1/P2 a JSON scalar string; P3 an array of exactly ONE row
// { result, event_id, event_created_at }.

import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

export const CONFIRM = '--confirm=READ-ONLY-RPC-ENVELOPE-PROBE'
export const PROBE_ACTOR = 'S4-PROBE-INVALID' // deliberately INVALID (upper case): rejected before any table access
export const PROBE_SEEN_ATTEMPTS = -1          // deliberately impossible: the claim UPDATE can never be reached
/** Answers P2 may legitimately return — all of them exit before the UPDATE. 'claimed' is impossible. */
export const P2_NONMUTATING = ['dispatch_row_missing', 'claim_lost', 'not_claimable', 'manual_courier_recorded', 'manual_review_open']

const SAFE_CODE = /^[A-Z0-9]{1,8}$/
const errCode = e => (e && typeof e.code === 'string' && SAFE_CODE.test(e.code) ? e.code : 'unknown')
const shape = d => (Array.isArray(d) ? `array(${d.length})` : d === null ? 'null' : typeof d)
const HINTS = {
  PGRST202: 'function not visible to PostgREST — 04E not installed, or the schema cache is not refreshed yet',
  '42501': 'permission denied — the key is not service_role, or EXECUTE is missing',
  '42883': 'function does not exist with this signature',
}

/**
 * Runs the three probes with an injected client ({ rpc(fn, args) }). Returns { ok, critical, lines }.
 * Stops at the first failure; never retries; never touches anything but the two RPCs.
 */
export async function runProbe(client, { uuid = randomUUID } = {}) {
  const lines = []
  const say = l => lines.push(l)
  const call = async (fn, args) => {
    try { return await client.rpc(fn, args) } catch { return { data: null, error: { code: 'transport' } } }
  }
  const stop = (id, why, critical = false) => { say(`${id} FAIL — ${why}`); say('STOPPED: no further calls, no retry.'); return { ok: false, critical, lines } }
  const rpcError = (id, error) => stop(id, `RPC error ${errCode(error)}${HINTS[errCode(error)] ? ` (${HINTS[errCode(error)]})` : ''}`)

  // P1 — scalar text envelope, earliest possible exit
  let r = await call('claim_maale_dispatch', { p_order_id: null, p_seen_attempts: 0, p_seen_last_attempt_at: null })
  if (r.error) return rpcError('P1', r.error)
  if (r.data !== 'invalid_request') return stop('P1', `expected the scalar string "invalid_request", got ${shape(r.data)}`)
  say('P1 PASS — claim_maale_dispatch returns a JSON scalar string ("invalid_request")')

  // P2 — scalar text envelope through the lock + lookups; the UPDATE is unreachable (p_seen_attempts = -1)
  r = await call('claim_maale_dispatch', { p_order_id: uuid(), p_seen_attempts: PROBE_SEEN_ATTEMPTS, p_seen_last_attempt_at: null })
  if (r.error) return rpcError('P2', r.error)
  if (r.data === 'claimed') return stop('P2', 'CRITICAL: "claimed" must be impossible with p_seen_attempts = -1 — DO NOT PROCEED, report to the owner', true)
  if (typeof r.data !== 'string' || !P2_NONMUTATING.includes(r.data)) return stop('P2', `expected one of ${P2_NONMUTATING.join(' / ')}, got ${shape(r.data)}`)
  say(`P2 PASS — claim_maale_dispatch returns a JSON scalar string ("${r.data}"; no write possible)`)

  // P3 — TABLE envelope, rejected at the first input check
  r = await call('record_maale_reconciliation_event', {
    p_request_id: uuid(), p_order_id: uuid(), p_event_type: 'manual_review_opened', p_actor: PROBE_ACTOR,
    p_provider_order_id: null, p_provider_status: null, p_reason_code: null,
  })
  if (r.error) return rpcError('P3', r.error)
  const row = Array.isArray(r.data) && r.data.length === 1 ? r.data[0] : null
  if (row && row.result === 'recorded') return stop('P3', 'CRITICAL: "recorded" must be impossible with an invalid actor — DO NOT PROCEED, report to the owner', true)
  const keys = row && typeof row === 'object' ? Object.keys(row).sort().join(',') : ''
  if (!row || keys !== 'event_created_at,event_id,result' || row.result !== 'invalid_request' || row.event_id !== null || row.event_created_at !== null)
    return stop('P3', `expected [ { result: "invalid_request", event_id: null, event_created_at: null } ], got ${shape(r.data)}${keys ? ` with keys ${keys}` : ''}`)
  say('P3 PASS — record_maale_reconciliation_event returns an array of ONE row { result, event_id, event_created_at }')
  say('ALL PASS — both envelopes match what lib/maaleDispatch.ts and the reconciliation route accept. Nothing was written.')
  return { ok: true, critical: false, lines }
}

async function main(argv, env) {
  if (!argv.includes(CONFIRM)) {
    console.log(`Refusing to run: this probe needs the explicit owner confirmation argument ${CONFIRM}`)
    return 2
  }
  const url = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL
  const key = env.SUPABASE_SERVICE_KEY || env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) { console.log('Refusing to run: server Supabase URL / service key not set in the environment (values are never printed)'); return 2 }
  const { createClient } = createRequire(import.meta.url)('@supabase/supabase-js')
  // same options as lib/supabaseServer.ts; one bounded attempt per call (10 s), redirects refused
  const fetchOnce = (input, init = {}) => fetch(input, { ...init, redirect: 'error', signal: AbortSignal.timeout(10_000) })
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: fetchOnce } })
  console.log('S4-04E RPC envelope probe — target: configured server Supabase project (URL and key not shown)')
  const res = await runProbe(client)
  for (const l of res.lines) console.log(l)
  return res.ok ? 0 : res.critical ? 3 : 1
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2), process.env).then(code => { process.exitCode = code })
}
