// Local checks for stale-'sending' recovery, controlled test mode and test readiness (FALAFEL-SN-08D11).
// FAKE fetch + in-memory delivery_dispatches only; the real global fetch is a throwing stub.
// Run: node scripts/verify-maale-recovery.mjs

import { createRequire } from 'node:module'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

globalThis.fetch = async () => { throw new Error('LIVE NETWORK CALL ATTEMPTED IN TESTS') }

const require = createRequire(import.meta.url)
const ts = require('typescript')
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LIB = join(ROOT, 'lib')
const cache = new Map()
function load(name) {
  const file = join(LIB, name.replace(/^\.\//, '') + '.ts')
  if (cache.has(file)) return cache.get(file).exports
  const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  })
  const mod = { exports: {} }
  cache.set(file, mod)
  new Function('exports', 'require', 'module', outputText)(mod.exports, p => (p.startsWith('./') ? load(p) : require(p)), mod)
  return mod.exports
}

const cfg = load('orderConfig')
const areas = load('deliveryAreasGeo')
const client = load('maaleClient')
const D = load('maaleDispatch')

let passed = 0
const test = async (name, fn) => { await fn(); passed++; console.log('  ✓', name) }

/* ─── Fixtures (FAKE) ─── */
const ORDER_ID = '11111111-2222-4333-8444-555555555555'
const KEY = 'test-maale-key-not-real'
const MA = 'מעלה אדומים'
const NOW = '2026-09-30T10:00:00.000Z'
const STALE = '2026-09-30T09:50:00.000Z'  // 10 min old
const FRESH = '2026-09-30T09:58:00.000Z'  //  2 min old
const TEST_NAME = '🧪 בדיקה — לא לשלוח'
const snapshot = (customer_name = 'לקוח אמיתי') => ({
  order: { id: ORDER_ID, type: 'delivery', branch_id: cfg.DELIVERY_BRANCH_IDS[0], payment_method: 'credit', customer_name, phone: '0500000000', total_price: 73 },
  delivery: { city: MA, street: 'הגעש', house_number: '6', apartment: '6', floor: '2', entrance: 'ב׳', notes: null, delivery_fee: 20, meal_surcharge: 4,
    delivery_lat: 31.773612, delivery_lng: 35.298346, geo_source: 'geocoder', geo_precision: 'street' },
  items: [{ name: 'פלאפל בפיתה', quantity: 1, unit_price: 40 }, { name: 'קוקה קולה', quantity: 1, unit_price: 9 }],
})
const AREA_FIX = { ...areas.DELIVERY_AREA_GEO, [MA]: { city: MA, center: { lat: 31.773612, lng: 35.298346 }, radiusMeters: 3000, approvedForDispatch: true, source: 'TEST FIXTURE' } }
const jsonRes = (body, status) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
const tick = () => new Promise(r => setTimeout(r, 1))

function memRepo({ status = 'confirmed', row = null, orderSnapshot = snapshot() } = {}) {
  const state = { row: row ? { external_order_id: ORDER_ID, attempts: 0, last_attempt_at: null, provider_order_id: null, provider_status: null, error_code: null, dispatched_at: null, ...row, order_id: ORDER_ID } : null, writes: 0 }
  return {
    state,
    repo: {
      async loadOrder(id) { return id === ORDER_ID ? { snapshot: orderSnapshot, status } : null },
      async getDispatch(id) { return state.row && id === ORDER_ID ? { order_id: id, external_order_id: state.row.external_order_id, status: state.row.status, attempts: state.row.attempts, last_attempt_at: state.row.last_attempt_at } : null },
      async insertPending(id) { state.writes++; if (!state.row) state.row = { order_id: id, external_order_id: id, status: 'pending', attempts: 0, last_attempt_at: null, provider_order_id: null, provider_status: null, error_code: null, dispatched_at: null } },
      async claim(id, seen, now) {
        state.writes++; await tick()
        const r = state.row
        if (!r || r.status !== seen.status || r.attempts !== seen.attempts || r.last_attempt_at !== seen.last_attempt_at) return false
        Object.assign(r, { status: 'sending', attempts: seen.attempts + 1, last_attempt_at: now, error_code: null }); return true
      },
      async markSent(id, v, now) { state.writes++; if (state.row.status === 'sending') Object.assign(state.row, { status: 'sent', dispatched_at: now, provider_order_id: v.providerOrderId ?? null, provider_status: v.providerStatus ?? null }) },
      async markFailed(id, st, code, now) { state.writes++; if (state.row.status === 'sending') Object.assign(state.row, { status: st, error_code: code, updated_at: now }) },
    },
  }
}

function setup({ respond = () => jsonRes({ order_id: 'MX-1' }, 201), config = { status: 'ready', apiKey: KEY }, paid = true, realAreas = false, ...repoOpts } = {}) {
  const mem = memRepo(repoOpts)
  const calls = []
  const logs = []
  const fetchImpl = async (url, init) => { calls.push({ url, init }); await tick(); return respond(url, init) }
  const deps = {
    config, repo: mem.repo, areaGeoConfig: realAreas ? undefined : AREA_FIX, isPaymentVerified: async () => paid,
    send: p => client.sendMaaleOrder(p, { config, fetchImpl, timeoutMs: 40 }), now: () => NOW, log: c => logs.push(c),
  }
  return { mem, calls, logs, deps, run: opts => D.dispatchOrderToMaale(ORDER_ID, deps, opts) }
}

console.log('Stale-sending recovery')

await test('1. fresh sending row → not reclaimed, no network (dispatch_in_progress)', async () => {
  assert.equal(D.classifySendingRow({ attempts: 1, last_attempt_at: FRESH }, Date.parse(NOW)), 'sending_not_stale')
  const s = setup({ row: { status: 'sending', attempts: 1, last_attempt_at: FRESH } })
  assert.deepEqual(await s.run(), { ok: false, outcome: 'dispatch_in_progress' }); assert.equal(s.calls.length, 0)
  assert.equal(D.MAALE_SENDING_STALE_MS, 5 * 60 * 1000)
  assert.equal(D.classifySendingRow({ attempts: 1, last_attempt_at: '2026-09-30T09:55:00.000Z' }, Date.parse(NOW)), 'sending_not_stale', 'exactly 5 min is not stale')
})

await test('2–5 + 8. stale sending row reclaimed: same external_order_id, attempts 1→2, last_attempt_at updated, 201 → sent', async () => {
  assert.equal(D.classifySendingRow({ attempts: 1, last_attempt_at: STALE }, Date.parse(NOW)), 'sending_reclaimable')
  const s = setup({ row: { status: 'sending', attempts: 1, last_attempt_at: STALE } })
  assert.deepEqual(await s.run(), { ok: true, outcome: 'sent', kind: 'created', reclaimed: true })
  assert.equal(s.calls.length, 1); assert.equal(JSON.parse(s.calls[0].init.body).external_order_id, ORDER_ID)
  assert.deepEqual([s.mem.state.row.attempts, s.mem.state.row.last_attempt_at, s.mem.state.row.status, s.mem.state.row.external_order_id], [2, NOW, 'sent', ORDER_ID])
  assert.ok(s.logs.includes('maale_dispatch_reclaimed_stale_sending'))
})

await test('6. two simultaneous stale reclaims → exactly one network call', async () => {
  const s = setup({ row: { status: 'sending', attempts: 3, last_attempt_at: STALE } })
  const [a, b] = await Promise.all([s.run(), s.run()])
  assert.equal(s.calls.length, 1); assert.deepEqual([a.outcome, b.outcome].sort(), ['dispatch_in_progress', 'sent']); assert.equal(s.mem.state.row.attempts, 4)
})

await test('7. stale retry + 200 duplicate (first request had reached Maale) → sent', async () => {
  const s = setup({ row: { status: 'sending', attempts: 1, last_attempt_at: STALE }, respond: () => jsonRes({ order_id: 'MX-1' }, 200) })
  assert.deepEqual(await s.run(), { ok: true, outcome: 'sent', kind: 'duplicate', reclaimed: true }); assert.equal(s.mem.state.row.status, 'sent')
})

await test('9. stale retry + 5xx → failed_retryable', async () => {
  const s = setup({ row: { status: 'sending', attempts: 1, last_attempt_at: STALE }, respond: () => jsonRes({}, 503) })
  assert.deepEqual(await s.run(), { ok: false, outcome: 'failed', retryable: true, errorCode: 'provider_5xx' })
  assert.deepEqual([s.mem.state.row.status, s.mem.state.row.attempts], ['failed_retryable', 2])
})

await test('10. attempts = 20 → never reclaimed (no network)', async () => {
  assert.equal(D.classifySendingRow({ attempts: 20, last_attempt_at: STALE }, Date.parse(NOW)), 'attempts_exhausted')
  const s = setup({ row: { status: 'sending', attempts: 20, last_attempt_at: STALE } })
  assert.deepEqual(await s.run(), { ok: false, outcome: 'attempts_exhausted' }); assert.equal(s.calls.length, 0)
})

await test('11. sending with null / invalid last_attempt_at → fail closed (no network, no claim)', async () => {
  for (const last of [null, 'not-a-date']) {
    const s = setup({ row: { status: 'sending', attempts: 1, last_attempt_at: last } })
    assert.deepEqual(await s.run(), { ok: false, outcome: 'sending_state_invalid' }); assert.equal(s.calls.length, 0)
    assert.equal(s.mem.state.row.status, 'sending')
  }
})

await test('12–13. sent / failed_final rows are never reclaimed (even if old)', async () => {
  const sent = setup({ row: { status: 'sent', attempts: 1, last_attempt_at: STALE } })
  assert.deepEqual(await sent.run(), { ok: true, outcome: 'already_sent' }); assert.equal(sent.calls.length, 0)
  const fin = setup({ row: { status: 'failed_final', attempts: 1, last_attempt_at: STALE } })
  assert.deepEqual(await fin.run(), { ok: false, outcome: 'final_failure_exists' }); assert.equal(fin.calls.length, 0)
})

console.log('Controlled test mode')

const testOrder = () => snapshot(TEST_NAME)

await test('14. test mode requires the explicit order id (mismatch / missing → blocked before any DB access)', async () => {
  for (const orderId of ['99999999-2222-4333-8444-555555555555', undefined, '']) {
    const s = setup({ orderSnapshot: testOrder(), paid: false, realAreas: true })
    const r = await s.run({ testMode: { orderId, bypassPaymentGate: true, bypassAreaGate: true } })
    assert.deepEqual(r, { ok: false, outcome: 'blocked', reason: 'test_order_id_mismatch' }); assert.equal(s.calls.length, 0)
  }
})

await test('15. test mode requires customer name starting with 🧪 בדיקה; with it + explicit bypasses → one dispatch', async () => {
  assert.equal(D.TEST_ORDER_MARKER, '🧪 בדיקה'); assert.ok(D.hasTestMarker(TEST_NAME)); assert.ok(!D.hasTestMarker('בדיקה 🧪')); assert.ok(!D.hasTestMarker(null))
  const s = setup({ orderSnapshot: testOrder(), paid: false, realAreas: true })
  const r = await s.run({ testMode: { orderId: ORDER_ID, bypassPaymentGate: true, bypassAreaGate: true } })
  assert.deepEqual(r, { ok: true, outcome: 'sent', kind: 'created', reclaimed: false }); assert.equal(s.calls.length, 1)
  assert.equal(JSON.parse(s.calls[0].init.body).customer_name, TEST_NAME, 'name is sent unchanged')
})

await test('16. a normal order can never use the test override (marker missing → blocked, even with bypass flags)', async () => {
  const s = setup({ paid: false, realAreas: true })
  const r = await s.run({ testMode: { orderId: ORDER_ID, bypassPaymentGate: true, bypassAreaGate: true } })
  assert.deepEqual(r, { ok: false, outcome: 'blocked', reason: 'test_order_marker_missing' }); assert.equal(s.calls.length, 0); assert.equal(s.mem.state.writes, 0)
})

await test('17. override is per call only: fails closed by default and never leaks to other / later calls', async () => {
  const noFlags = setup({ orderSnapshot: testOrder(), paid: false, realAreas: true })
  assert.equal((await noFlags.run({ testMode: { orderId: ORDER_ID } })).reason, 'payment_not_verified', 'no bypass unless explicitly passed')
  assert.equal((await noFlags.run({ testMode: { orderId: ORDER_ID, bypassPaymentGate: true } })).reason, 'area_not_ready', 'bypasses are independent')
  const s = setup({ orderSnapshot: testOrder(), paid: false, realAreas: true })
  assert.equal((await s.run({ testMode: { orderId: ORDER_ID, bypassPaymentGate: true, bypassAreaGate: true } })).outcome, 'sent')
  const later = setup({ orderSnapshot: testOrder(), paid: false, realAreas: true })
  assert.equal((await later.run()).reason, 'payment_not_verified', 'a later normal call is unaffected')
  const src = readFileSync(join(LIB, 'maaleDispatch.ts'), 'utf8').replace(/\/\/.*$/gm, '')
  assert.ok(!/process\.env\.[A-Z_]*(BYPASS|TEST|OVERRIDE)/.test(src), 'no env-based bypass')
  assert.ok(!/^let\s|^var\s/m.test(src), 'no mutable module state')
})

await test('18–19. normal dispatch still requires HYP and area-ready (test-marked order without test mode too)', async () => {
  assert.equal((await setup({ paid: false }).run()).reason, 'payment_not_verified')
  assert.equal((await setup({ realAreas: true }).run()).reason, 'area_not_ready')
  assert.equal((await setup({ orderSnapshot: testOrder(), paid: false }).run()).reason, 'payment_not_verified')
})

console.log('Controlled-test readiness (read-only)')

const readiness = async (opts = {}) => {
  const s = setup(opts)
  let reads = 0
  const ro = { loadOrder: async id => { reads++; return s.deps.repo.loadOrder(id) }, getDispatch: async id => { reads++; return s.deps.repo.getDispatch(id) } }
  const r = await D.assessMaaleTestReadiness(ORDER_ID, { config: s.deps.config, repo: ro, isPaymentVerified: s.deps.isPaymentVerified, areaGeoConfig: s.deps.areaGeoConfig, now: () => NOW })
  return { r, s, reads }
}

await test('20–21. readiness performs zero writes and zero network calls', async () => {
  for (const opts of [{ orderSnapshot: testOrder(), paid: false, realAreas: true }, { row: { status: 'sending', attempts: 1, last_attempt_at: STALE } }, {}]) {
    const { s, reads } = await readiness(opts)
    assert.equal(s.mem.state.writes, 0); assert.equal(s.calls.length, 0); assert.ok(reads >= 1)
  }
})

await test('22–23. readiness reports required HYP / area overrides', async () => {
  const blocked = (await readiness({ orderSnapshot: testOrder(), paid: false, realAreas: true })).r
  assert.deepEqual([blocked.hypVerified, blocked.requiresPaymentOverride, blocked.areaReady, blocked.requiresAreaOverride, blocked.areaReadiness],
    [false, true, false, true, 'area_not_approved'])
  assert.deepEqual([blocked.safeForControlledTest, blocked.result, blocked.blockers], [true, 'test_override_required', []])
  const ready = (await readiness({ orderSnapshot: testOrder() })).r
  assert.deepEqual([ready.requiresPaymentOverride, ready.requiresAreaOverride, ready.result], [false, false, 'ready_for_controlled_test'])
})

await test('24. readiness reports Maale config state (disabled / no key / ready)', async () => {
  const off = (await readiness({ orderSnapshot: testOrder(), config: { status: 'disabled' } })).r
  assert.deepEqual([off.maaleEnabled, off.maaleKeyConfigured, off.result, off.safeForControlledTest], [false, false, 'maale_disabled', false])
  const noKey = (await readiness({ orderSnapshot: testOrder(), config: { status: 'not_configured' } })).r
  assert.deepEqual([noKey.maaleEnabled, noKey.maaleKeyConfigured, noKey.result], [true, false, 'maale_not_configured'])
  const on = (await readiness({ orderSnapshot: testOrder() })).r
  assert.deepEqual([on.maaleEnabled, on.maaleKeyConfigured], [true, true])
})

await test('readiness: full field report + blockers (normal name, pickup, locality geo, dispatch state, missing order)', async () => {
  const normal = (await readiness()).r
  assert.ok(normal.blockers.includes('test_order_marker_missing')); assert.equal(normal.hasTestMarker, false)
  const pickup = (await readiness({ orderSnapshot: { ...testOrder(), order: { ...testOrder().order, type: 'pickup' } } })).r
  assert.ok(pickup.blockers.includes('not_delivery')); assert.equal(pickup.isDelivery, false); assert.equal(pickup.payloadValid, false)
  const coarse = (await readiness({ orderSnapshot: { ...testOrder(), delivery: { ...testOrder().delivery, geo_precision: 'locality' } } })).r
  assert.equal(coarse.coordinatesPrecise, false); assert.ok(coarse.blockers.includes('coordinates_not_precise'))
  const inFlight = (await readiness({ orderSnapshot: testOrder(), row: { status: 'sending', attempts: 1, last_attempt_at: FRESH } })).r
  assert.deepEqual([inFlight.dispatchState, inFlight.sendingState, inFlight.blockers], ['sending', 'sending_not_stale', ['sending_not_stale']])
  const stale = (await readiness({ orderSnapshot: testOrder(), row: { status: 'sending', attempts: 1, last_attempt_at: STALE } })).r
  assert.deepEqual([stale.sendingState, stale.result], ['sending_reclaimable', 'ready_for_controlled_test'])
  const sent = (await readiness({ orderSnapshot: testOrder(), row: { status: 'sent', attempts: 1, last_attempt_at: STALE } })).r
  assert.ok(sent.blockers.includes('dispatch_already_sent'))
  const unconfirmed = (await readiness({ orderSnapshot: testOrder(), status: 'received' })).r
  assert.ok(unconfirmed.blockers.includes('order_not_confirmed'))
  const missing = await D.assessMaaleTestReadiness('99999999-2222-4333-8444-555555555555', {
    config: { status: 'ready', apiKey: KEY }, repo: { loadOrder: async () => null, getDispatch: async () => null }, isPaymentVerified: async () => false })
  assert.deepEqual([missing.orderExists, missing.result], [false, 'order_not_found'])
  const keys = Object.keys(normal)
  for (const k of ['orderExists', 'isDelivery', 'branchOk', 'hasTestMarker', 'paymentMethod', 'paymentMethodAllowed', 'hypRequired', 'addressComplete', 'coordinatesPrecise', 'payloadValid',
    'dispatchState', 'maaleEnabled', 'maaleKeyConfigured', 'areaReady', 'hypVerified', 'requiresPaymentOverride', 'requiresAreaOverride', 'safeForControlledTest', 'result'])
    assert.ok(keys.includes(k), k)
})

const walk = dir => readdirSync(dir).flatMap(n => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p] })
await test('25. no browser/public route imports the dispatch / test helpers', async () => {
  for (const f of walk(join(ROOT, 'app')).filter(p => /\.(tsx?|jsx?)$/.test(p)))
    assert.ok(!/maaleDispatch|maaleClient|assessMaaleTestReadiness|ControlledTestOptions|testMode/.test(readFileSync(f, 'utf8')), f)
  for (const f of walk(LIB).filter(p => p.endsWith('.ts') && !/maale(Dispatch|Client|Payload)\.ts$/.test(p)))
    assert.ok(!/dispatchOrderToMaale|assessMaaleTestReadiness/.test(readFileSync(f, 'utf8')), f)
})

await test('26. no live Maale request in tests (global fetch is a throwing stub)', async () => {
  await assert.rejects(() => globalThis.fetch('https://example.invalid'), /LIVE NETWORK CALL ATTEMPTED/)
})

console.log(`\nAll ${passed} maale-recovery checks passed.`)
