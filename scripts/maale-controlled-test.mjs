// LOCAL-ONLY controlled Maale Express test runner (FALAFEL-SN-08D13).
//
//   node scripts/maale-controlled-test.mjs readiness <ORDER_UUID>
//   node scripts/maale-controlled-test.mjs dispatch  <ORDER_UUID> --confirm-test
//
// NOT part of the app: nothing under app/ or lib/ imports this file, it is not a route, and it is never deployed.
// readiness → read-only report (no writes, no HTTP).
// dispatch  → refuses without --confirm-test; re-runs readiness; refuses on ANY blocker; then calls
//             dispatchOrderToMaale(orderId, defaultDispatchDeps(), { testMode: { orderId, bypassPaymentGate: true,
//             bypassAreaGate: true } }). Only the HYP-payment and approved-area gates can be bypassed, and only
//             because this is an explicit, marker-checked ("🧪 בדיקה") test of ONE named order.
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
  return D.defaultDispatchDeps() // reads MAALE_EXPRESS_* + server Supabase env; HYP gate is hard-false
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

  const readinessDeps = { config: deps.config, repo: { loadOrder: deps.repo.loadOrder, getDispatch: deps.repo.getDispatch },
    isPaymentVerified: deps.isPaymentVerified, areaGeoConfig: deps.areaGeoConfig, now: deps.now }

  print(mode === 'dispatch' ? '── Pre-flight readiness ──' : '── Readiness (read only) ──')
  const r = await D.assessMaaleTestReadiness(orderId, readinessDeps)
  for (const l of formatReadiness(r)) print(l)
  if (mode === 'readiness') return r.safeForControlledTest ? 0 : 1

  // Any blocker refuses. assessMaaleTestReadiness never lists payment / area as blockers — those are the only
  // two gates the controlled test may bypass (reported as overrides).
  if (!r.safeForControlledTest) { print('REFUSED: readiness has blockers — nothing was sent.'); return 1 }

  print('── Controlled test dispatch (testMode) ──')
  const res = await D.dispatchOrderToMaale(orderId, deps, {
    testMode: { orderId, bypassPaymentGate: true, bypassAreaGate: true },
  })
  const label = res.outcome === 'sent' ? res.kind
    : res.outcome === 'failed' ? res.errorCode
      : res.outcome === 'blocked' ? `blocked: ${res.reason}`
        : res.outcome
  print(`Result: ${label}${res.outcome === 'failed' ? (res.retryable ? ' (retryable)' : ' (final)') : ''}`)
  const row = await deps.repo.getDispatch(orderId)
  print(`delivery_dispatches state: ${row ? `${row.status} (attempts ${row.attempts})` : 'none'}`)
  return res.ok ? 0 : 1
}

// Run only when executed directly (tests import the core without running it).
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  loadEnvLocal()
  runMaaleControlledTest(process.argv.slice(2))
    .then(code => { process.exitCode = code })
    .catch(e => { console.log(`ERROR: ${e && e.name ? e.name : 'unexpected'}`); process.exitCode = 1 })
}
