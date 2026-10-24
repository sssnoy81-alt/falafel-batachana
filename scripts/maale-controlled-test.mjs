// LOCAL-ONLY controlled Maale Express test runner (FALAFEL-SN-08D13).
//
//   node scripts/maale-controlled-test.mjs readiness <ORDER_UUID>
//   node scripts/maale-controlled-test.mjs dispatch  <ORDER_UUID> --confirm-test
//
// NOT part of the app: nothing under app/ or lib/ imports this file, it is not a route, and it is never deployed.
// readiness → read-only report (no writes, no HTTP).
// dispatch  → refuses without --confirm-test; re-runs readiness; refuses on ANY blocker; then calls
//             dispatchOrderToMaale(orderId, defaultDispatchDeps(), { testMode: { orderId } }) ONCE. Test mode bypasses
//             nothing (03F): it only adds the "🧪 בדיקה" marker and order-id match on top of every normal gate.
//             Readiness includes the global 401 stop (S4-03T); an unknown auth state still refuses (fail closed).
// After an attempt it prints a sanitized summary (result, external / provider order id, provider status, dispatch state,
// manual reconciliation YES/NO); anything it cannot verify is printed as UNKNOWN.
// Output is operational only: no keys, no customer name / phone / address / notes, no raw provider response.
// Env (read, never printed): .env.local → SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_KEY,
// MAALE_EXPRESS_ENABLED=true, MAALE_EXPRESS_API_KEY.

import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LIB = join(ROOT, 'lib')
const require = createRequire(import.meta.url)

/** Loads lib/*.ts by transpiling in memory (same loader as the verify scripts). */
const cache = new Map()
export function loadLib(name) {
  const ts = require('typescript')
  const file = join(LIB, name.replace(/^\.\//, '') + '.ts')
  if (cache.has(file)) return cache.get(file).exports
  const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  })
  const mod = { exports: {} }
  cache.set(file, mod)
  new Function('exports', 'require', 'module', outputText)(mod.exports, p => (p.startsWith('./') ? loadLib(p) : require(p)), mod)
  return mod.exports
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const BRANCH_LABEL = 'Mishor Adumim'
const yn = b => (b ? 'YES' : 'NO')
const pf = b => (b ? 'PASS' : 'FAIL')

/** Safe, operational report lines — never names, phone, address, notes, keys or provider bodies. */
export function formatReadiness(r) {
  const lines = [
    ['Order', r.orderId],
    ['Order status', r.orderStatus ?? 'not found'],
    ['Delivery', yn(r.isDelivery)],
    ['Branch', r.branchOk ? BRANCH_LABEL : 'WRONG BRANCH'],
    ['Test marker', pf(r.hasTestMarker)],
    ['Payment method', r.paymentMethodAllowed ? r.paymentMethod : 'NOT ALLOWED (delivery needs cash or credit)'],
    ['HYP required', r.paymentMethodAllowed ? yn(r.hypRequired) : 'n/a'],
    ['Address', r.addressComplete ? 'complete' : 'INCOMPLETE'],
    ['Coordinates', r.coordinatesPrecise ? 'precise' : 'NOT precise'],
    ['Payload', r.payloadValid ? 'valid' : `INVALID (${r.payloadErrors.join(', ')})`],
    ['Dispatch state', r.sendingState ? `${r.dispatchState} (${r.sendingState})` : r.dispatchState],
    ['Maale enabled', yn(r.maaleEnabled)],
    ['Maale key configured', yn(r.maaleKeyConfigured)],
    ['HYP verified', r.hypRequired ? yn(r.hypVerified) : 'n/a (cash)'],
    ['Area ready', r.areaReady ? 'YES' : `NO${r.areaReadiness ? ` (${r.areaReadiness})` : ''}`],
    ['Controlled-test overrides required', `payment = ${yn(r.requiresPaymentOverride)}, area = ${yn(r.requiresAreaOverride)}`],
    ['Blockers', r.blockers.length ? r.blockers.join(', ') : 'none'],
    ['Result', r.safeForControlledTest ? 'READY FOR CONTROLLED TEST' : `NOT READY (${r.result})`],
  ]
  return lines.map(([k, v]) => `${k}: ${v}`)
}

/** Minimal .env.local reader: fills only unset keys; never prints anything. */
export function loadEnvLocal(file = join(ROOT, '.env.local'), env = process.env) {
  if (!existsSync(file)) return
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = raw.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (!m || env[m[1]] !== undefined) continue
    env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
  }
}

/** Production wiring for the runner — created lazily, only after the arguments are valid. */
export function realDeps() {
  const D = loadLib('maaleDispatch')
  const deps = D.defaultDispatchDeps() // reads MAALE_EXPRESS_* + server Supabase env; HYP gate is hard-false
  return { ...deps, readDispatchSummary: readDispatchSummaryFromDb }
}

/** READ-ONLY: the persisted dispatch row incl. the provider's order id / status (not part of the dispatch repo). */
async function readDispatchSummaryFromDb(orderId) {
  const { data, error } = await loadLib('supabaseServer').getServerSupabase().from('delivery_dispatches')
    .select('external_order_id, status, attempts, error_code, provider_order_id, provider_status').eq('order_id', orderId).maybeSingle()
  if (error) throw new Error('dispatch summary read failed')
  return data ?? null
}

/* ─── Sanitized post-attempt summary ─── */

const SAFE_PROVIDER_ID = /^[A-Za-z0-9_-]{1,100}$/
const SAFE_STATUS = /^[a-z_]{1,40}$/
const SAFE_CODE = /^[a-z0-9_]{1,64}$/
const DISPATCH_STATUSES = ['pending', 'sending', 'sent', 'failed_retryable', 'failed_final']

/**
 * Lines printed after a dispatch attempt. Only validated short values are shown; everything else is UNKNOWN.
 * "Manual reconciliation required: NO" only when the provider reported a NEW order AND the database row confirms it
 * (status sent, same external order id). Anything else — duplicate, failure, persistence failure, unreadable row — is YES.
 */
export function formatDispatchSummary(orderId, res, row) {
  const ok = v => (typeof v === 'string' && v ? v : null)
  const result = res.outcome === 'sent' ? res.kind
    : res.outcome === 'failed' ? `${res.errorCode}${res.retryable ? ' (retryable)' : ' (final)'}`
      : res.outcome === 'blocked' ? `blocked: ${res.reason}`
        : res.outcome === 'persistence_failed' ? `persistence_failed (provider outcome: ${res.providerOutcome}) — NOT CONFIRMED`
          : res.outcome
  const ext = ok(row?.external_order_id)
  const status = DISPATCH_STATUSES.includes(row?.status) ? row.status : null
  const attempts = Number.isInteger(row?.attempts) ? row.attempts : null
  const providerId = ok(row?.provider_order_id)
  const providerStatus = ok(row?.provider_status)
  const errorCode = ok(row?.error_code)
  const confirmed = res.ok === true && res.outcome === 'sent' && res.kind === 'created' && status === 'sent' && ext === orderId
  return [
    `Result: ${SAFE_CODE.test(String(result).split(/[ :]/)[0]) ? result : 'UNKNOWN'}`,
    `External order ID: ${ext && ext === orderId ? ext : ext ? 'UNKNOWN (mismatch)' : 'UNKNOWN'}`,
    `Provider order ID: ${providerId && SAFE_PROVIDER_ID.test(providerId) ? providerId : 'UNKNOWN'}`,
    `Provider status: ${providerStatus && SAFE_STATUS.test(providerStatus) ? providerStatus : 'UNKNOWN'}`,
    `Dispatch state: ${status ? `${status}${attempts !== null ? ` (attempts ${attempts})` : ''}${errorCode && SAFE_CODE.test(errorCode) ? ` [${errorCode}]` : ''}` : 'UNKNOWN'}`,
    `Manual reconciliation required: ${confirmed ? 'NO' : 'YES — do NOT re-run; contact Maale Express with the external order ID'}`,
  ]
}

/**
 * Core (exported for tests). Returns an exit code: 0 ok, 1 refused / not ready / failed, 2 usage.
 * deps: { createDeps: () => DispatchDeps, print: (line) => void }
 */
export async function runMaaleControlledTest(argv, { createDeps = realDeps, print = console.log } = {}) {
  const D = loadLib('maaleDispatch')
  const [mode, orderId, ...flags] = argv
  if (mode !== 'readiness' && mode !== 'dispatch') {
    print('Usage: maale-controlled-test.mjs readiness <ORDER_UUID> | dispatch <ORDER_UUID> --confirm-test')
    return 2
  }
  if (typeof orderId !== 'string' || !UUID.test(orderId)) { print('REFUSED: a valid order UUID is required.'); return 2 }
  const unknown = flags.filter(f => f !== '--confirm-test')
  if (unknown.length) { print(`REFUSED: unknown option(s): ${unknown.join(' ')}`); return 2 }
  if (mode === 'dispatch' && !flags.includes('--confirm-test')) {
    print('REFUSED: dispatch requires --confirm-test (nothing was read or sent).')
    return 1
  }

  let deps
  try {
    deps = createDeps()
  } catch (e) {
    print(`REFUSED: server configuration missing (${e && e.name === 'ServerConfigError' ? 'Supabase server env' : 'setup error'}).`)
    return 1
  }

  // Read-only repo for readiness. hasRecentAuthFailure is passed through (S4-03T) so the global 401 stop is evaluated;
  // when the repo lacks it or the lookup fails, readiness reports auth_state_unknown and the runner refuses.
  const repo = deps.repo
  const readinessDeps = {
    config: deps.config,
    repo: {
      loadOrder: id => repo.loadOrder(id),
      getDispatch: id => repo.getDispatch(id),
      ...(typeof repo.hasRecentAuthFailure === 'function' ? { hasRecentAuthFailure: since => repo.hasRecentAuthFailure(since) } : {}),
    },
    isPaymentVerified: deps.isPaymentVerified, areaGeoConfig: deps.areaGeoConfig, now: deps.now,
  }

  print(mode === 'dispatch' ? '── Pre-flight readiness ──' : '── Readiness (read only) ──')
  const r = await D.assessMaaleTestReadiness(orderId, readinessDeps)
  for (const l of formatReadiness(r)) print(l)
  if (mode === 'readiness') return r.safeForControlledTest ? 0 : 1

  // Any blocker refuses. assessMaaleTestReadiness never lists payment / area as blockers — those are the only
  // two gates the controlled test may bypass (reported as overrides).
  if (!r.safeForControlledTest) { print('REFUSED: readiness has blockers — nothing was sent.'); return 1 }

  // Exactly one call; no retry, no reset of an existing row (the service refuses any non-pending row itself).
  print('── Controlled test dispatch (testMode) ──')
  const res = await D.dispatchOrderToMaale(orderId, deps, { testMode: { orderId } })

  // Sanitized summary from the persisted row (read-only). Unreadable → UNKNOWN, never assumed.
  let row = null
  try {
    row = typeof deps.readDispatchSummary === 'function' ? await deps.readDispatchSummary(orderId) : await repo.getDispatch(orderId)
  } catch { row = null }
  print('── Dispatch summary ──')
  const lines = formatDispatchSummary(orderId, res, row)
  for (const l of lines) print(l)
  return lines.at(-1) === 'Manual reconciliation required: NO' ? 0 : 1
}

// Run only when executed directly (tests import the core without running it).
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  loadEnvLocal()
  runMaaleControlledTest(process.argv.slice(2))
    .then(code => { process.exitCode = code })
    .catch(e => { console.log(`ERROR: ${e && e.name ? e.name : 'unexpected'}`); process.exitCode = 1 })
}
