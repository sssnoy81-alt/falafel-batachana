// Local checks for the Maale Express HTTP client + dispatch service (FALAFEL-SN-08D10).
// FAKE fetch + in-memory delivery_dispatches only. The real global fetch is replaced by a throwing stub, so no
// live network call is possible. Run: node scripts/verify-maale-dispatch.mjs

import { createRequire } from 'node:module'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

globalThis.fetch = async () => { throw new Error('LIVE NETWORK CALL ATTEMPTED IN TESTS') } // test 30 guard

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
const dispatch = load('maaleDispatch')
const { MAALE_ORDERS_URL } = load('maalePayload')

let passed = 0
const test = async (name, fn) => { await fn(); passed++; console.log('  ✓', name) }

/* ─── Fixtures (FAKE) ─── */
const ORDER_ID = '11111111-2222-4333-8444-555555555555'
const KEY = 'test-maale-key-not-real'
const MA = 'מעלה אדומים'
const PII = ['לקוח בדיקה', '0500000000', 'הגעש', 'קוד 1234']
const snapshot = () => ({
  order: { id: ORDER_ID, type: 'delivery', branch_id: cfg.DELIVERY_BRANCH_IDS[0], payment_method: 'credit', customer_name: 'לקוח בדיקה', phone: '0500000000', total_price: 73 },
  delivery: { city: MA, street: 'הגעש', house_number: '6', apartment: '6', floor: '2', entrance: 'ב׳', notes: 'קוד 1234', delivery_fee: 20, meal_surcharge: 4,
    delivery_lat: 31.773612, delivery_lng: 35.298346, geo_source: 'geocoder', geo_precision: 'street' },
  items: [{ name: 'פלאפל בפיתה', quantity: 1, unit_price: 40 }, { name: 'קוקה קולה', quantity: 1, unit_price: 9 }],
})
// TEST-ONLY approved area (synthetic); the real DELIVERY_AREA_GEO stays unapproved.
const AREA_FIX = { ...areas.DELIVERY_AREA_GEO, [MA]: { city: MA, center: { lat: 31.773612, lng: 35.298346 }, radiusMeters: 3000, approvedForDispatch: true, source: 'TEST FIXTURE' } }
const jsonRes = (body, status) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
const tick = () => new Promise(r => setTimeout(r, 1))

/** In-memory delivery_dispatches with the same guarantees as the SQL (unique order_id, CAS claim, from-'sending' marks). */
function memRepo({ status = 'confirmed', row = null, orderSnapshot = snapshot() } = {}) {
  const state = { row: row ? { external_order_id: ORDER_ID, attempts: 0, provider_order_id: null, provider_status: null, error_code: null, dispatched_at: null, last_attempt_at: null, ...row, order_id: ORDER_ID } : null, reads: 0, writes: 0 }
  return {
    state,
    repo: {
      async loadOrder(id) { state.reads++; return id === ORDER_ID ? { snapshot: orderSnapshot, status } : null },
      async getDispatch(id) { state.reads++; return state.row && id === ORDER_ID ? { order_id: id, external_order_id: state.row.external_order_id, status: state.row.status, attempts: state.row.attempts, last_attempt_at: state.row.last_attempt_at } : null },
      async insertPending(id) { state.writes++; if (!state.row) state.row = { order_id: id, external_order_id: id, status: 'pending', attempts: 0, provider_order_id: null, provider_status: null, error_code: null, dispatched_at: null, last_attempt_at: null } },
      async claim(id, seen, now) {
        state.writes++; await tick()
        if (!state.row || state.row.status !== seen.status || state.row.attempts !== seen.attempts || state.row.last_attempt_at !== seen.last_attempt_at) return false
        Object.assign(state.row, { status: 'sending', attempts: seen.attempts + 1, last_attempt_at: now, error_code: null }); return true
      },
      async markSent(id, v, now) { state.writes++; if (state.row.status === 'sending') Object.assign(state.row, { status: 'sent', dispatched_at: now, provider_order_id: v.providerOrderId ?? null, provider_status: v.providerStatus ?? null, error_code: null }) },
      async markFailed(id, st, code, now) { state.writes++; if (state.row.status === 'sending') Object.assign(state.row, { status: st, error_code: code, updated_at: now }) },
    },
  }
}

/** Dispatch deps with a counting fake fetch; everything else real (client, payload builder, gates). */
function setup({ respond = () => jsonRes({ order_id: 'MX-1', status: 'searching' }, 201), config = { status: 'ready', apiKey: KEY }, paid = true, areaGeoConfig = AREA_FIX, realAreas = false, ...repoOpts } = {}) {
  const mem = memRepo(repoOpts)
  const calls = []
  const logs = []
  const fetchImpl = async (url, init) => { calls.push({ url, init }); await tick(); return respond(url, init) }
  const deps = {
    config, repo: mem.repo, areaGeoConfig: realAreas ? undefined : areaGeoConfig, isPaymentVerified: async () => paid,
    send: p => client.sendMaaleOrder(p, { config, fetchImpl, timeoutMs: 40 }),
    now: () => '2026-09-30T10:00:00.000Z', log: c => logs.push(c),
  }
  return { mem, calls, logs, deps, run: () => dispatch.dispatchOrderToMaale(ORDER_ID, deps) }
}

console.log('Maale client + dispatch service (fake network)')

await test('1. feature disabled (default) → zero network calls, zero DB access', async () => {
  for (const env of [{}, { MAALE_EXPRESS_ENABLED: 'false' }, { MAALE_EXPRESS_ENABLED: 'TRUE', MAALE_EXPRESS_API_KEY: KEY }, { MAALE_EXPRESS_API_KEY: KEY }])
    assert.equal(client.resolveMaaleConfig(env).status, 'disabled', JSON.stringify(env))
  const s = setup({ config: { status: 'disabled' } })
  assert.deepEqual(await s.run(), { ok: false, outcome: 'blocked', reason: 'maale_disabled' })
  assert.equal(s.calls.length, 0); assert.deepEqual([s.mem.state.reads, s.mem.state.writes], [0, 0])
})

await test('2. enabled but key missing → maale_not_configured, zero network calls', async () => {
  assert.equal(client.resolveMaaleConfig({ MAALE_EXPRESS_ENABLED: 'true', MAALE_EXPRESS_API_KEY: '  ' }).status, 'not_configured')
  assert.equal(client.resolveMaaleConfig({ MAALE_EXPRESS_ENABLED: 'true', MAALE_EXPRESS_API_KEY: KEY }).status, 'ready')
  const s = setup({ config: { status: 'not_configured' } })
  assert.equal((await s.run()).reason, 'maale_not_configured'); assert.equal(s.calls.length, 0)
  let n = 0
  const r = await client.sendMaaleOrder({}, { config: { status: 'not_configured' }, fetchImpl: async () => { n++ } })
  assert.deepEqual(r, { ok: false, retryable: false, errorCode: 'maale_not_configured' }); assert.equal(n, 0)
})

await test('3–6. exact URL, headers (X-Api-Key), exact 08D9 payload forwarded, key not in body', async () => {
  const s = setup(); await s.run()
  assert.equal(s.calls.length, 1)
  const { url, init } = s.calls[0]
  assert.equal(url, 'https://express.maalehamishlohim.co.il/api/v1/express/integrations/orders'); assert.equal(url, MAALE_ORDERS_URL)
  assert.equal(init.method, 'POST'); assert.deepEqual(init.headers, { 'Content-Type': 'application/json', 'X-Api-Key': KEY })
  const payload = load('maalePayload').buildMaaleOrderPayload(snapshot()).payload
  assert.deepEqual(JSON.parse(init.body), payload)
  assert.ok(!init.body.includes(KEY) && !url.includes(KEY))
})

await test('7 + 25–26. 201 → created → sent; provider order id + status persisted; dispatched_at set', async () => {
  const s = setup()
  assert.deepEqual(await s.run(), { ok: true, outcome: 'sent', kind: 'created', reclaimed: false })
  assert.deepEqual([s.mem.state.row.status, s.mem.state.row.provider_order_id, s.mem.state.row.provider_status, s.mem.state.row.attempts, s.mem.state.row.error_code],
    ['sent', 'MX-1', 'searching', 1, null])
  assert.ok(s.mem.state.row.dispatched_at && s.mem.state.row.last_attempt_at)
})

await test('8. 200 → duplicate → idempotent success (sent)', async () => {
  const s = setup({ respond: () => jsonRes({ id: 777 }, 200) })
  assert.deepEqual(await s.run(), { ok: true, outcome: 'sent', kind: 'duplicate', reclaimed: false })
  assert.deepEqual([s.mem.state.row.status, s.mem.state.row.provider_order_id, s.mem.state.row.provider_status], ['sent', '777', null])
})

const finalCase = async (respond, code) => {
  const s = setup({ respond })
  assert.deepEqual(await s.run(), { ok: false, outcome: 'failed', retryable: false, errorCode: code })
  assert.deepEqual([s.mem.state.row.status, s.mem.state.row.error_code], ['failed_final', code])
}
await test('9. 400 code=zone_unknown → failed_final', async () => finalCase(() => jsonRes({ code: 'zone_unknown' }, 400), 'zone_unknown'))
await test('10. 400 dispatch_closed=true → failed_final', async () => finalCase(() => jsonRes({ dispatch_closed: true }, 400), 'dispatch_closed'))
await test('11. generic 400 → failed_final (provider_rejected)', async () => finalCase(() => jsonRes({ error: 'lat required' }, 400), 'provider_rejected'))
await test('12. 401 → unauthorized, final', async () => finalCase(() => jsonRes({}, 401), 'unauthorized'))

const retryCase = async (respond, code) => {
  const s = setup({ respond })
  assert.deepEqual(await s.run(), { ok: false, outcome: 'failed', retryable: true, errorCode: code })
  assert.deepEqual([s.mem.state.row.status, s.mem.state.row.error_code], ['failed_retryable', code])
}
await test('13. 500 → retryable', async () => retryCase(() => jsonRes({}, 500), 'provider_5xx'))
await test('14. 503 → retryable', async () => retryCase(() => jsonRes({}, 503), 'provider_5xx'))
await test('15. timeout → retryable', async () => retryCase((_u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted')))), 'timeout'))
await test('16. network error → retryable', async () => retryCase(() => { throw new TypeError('fetch failed') }, 'network_error'))

await test('17. malformed JSON handled safely (201 still success without ids; 400/500 classified by status)', async () => {
  const bad = status => ({ ok: status < 300, status, json: async () => { throw new SyntaxError('Unexpected token <') } })
  const s = setup({ respond: () => bad(201) })
  assert.deepEqual(await s.run(), { ok: true, outcome: 'sent', kind: 'created', reclaimed: false }); assert.equal(s.mem.state.row.provider_order_id, null)
  assert.deepEqual(client.classifyMaaleResponse(400, null), { ok: false, retryable: false, errorCode: 'provider_rejected', status: 400 })
  assert.deepEqual(client.classifyMaaleResponse(502, 'x'), { ok: false, retryable: true, errorCode: 'provider_5xx', status: 502 })
  assert.deepEqual(client.classifyMaaleResponse(202, {}), { ok: false, retryable: true, errorCode: 'invalid_response', status: 202 })
  assert.equal(client.classifyMaaleResponse(429, {}).retryable, true); assert.equal(client.classifyMaaleResponse(404, {}).retryable, false)
  assert.equal(client.classifyMaaleResponse(201, { status: 'Bad Value!', order_id: 'x'.repeat(101) }).providerStatus, undefined)
})

await test('18. already sent → no network call', async () => {
  const s = setup({ row: { status: 'sent', attempts: 1 } })
  assert.deepEqual(await s.run(), { ok: true, outcome: 'already_sent' }); assert.equal(s.calls.length, 0)
})

await test('19. sending → no second request; two simultaneous calls → exactly one network call', async () => {
  const s = setup({ row: { status: 'sending', attempts: 1, last_attempt_at: '2026-09-30T09:59:00.000Z' } }) // 1 min old: fresh
  assert.deepEqual(await s.run(), { ok: false, outcome: 'dispatch_in_progress' }); assert.equal(s.calls.length, 0)
  const race = setup()
  const [a, b] = await Promise.all([race.run(), race.run()])
  assert.equal(race.calls.length, 1, 'only one provider delivery')
  assert.deepEqual([a.outcome, b.outcome].sort(), ['dispatch_in_progress', 'sent']); assert.equal(race.mem.state.row.attempts, 1)
})

await test('20. failed_final → no automatic retry (no network)', async () => {
  const s = setup({ row: { status: 'failed_final', attempts: 1, error_code: 'zone_unknown' } })
  assert.deepEqual(await s.run(), { ok: false, outcome: 'final_failure_exists' }); assert.equal(s.calls.length, 0)
})

await test('21–24. failed_retryable may be retried manually: same external_order_id, attempts 1→2, success → sent', async () => {
  let n = 0
  const s = setup({ respond: () => (++n === 1 ? jsonRes({}, 503) : jsonRes({ order_id: 'MX-9' }, 201)) })
  assert.equal((await s.run()).outcome, 'failed'); assert.deepEqual([s.mem.state.row.status, s.mem.state.row.attempts], ['failed_retryable', 1])
  assert.deepEqual(await s.run(), { ok: true, outcome: 'sent', kind: 'created', reclaimed: false })
  assert.deepEqual([s.mem.state.row.status, s.mem.state.row.attempts, s.mem.state.row.provider_order_id], ['sent', 2, 'MX-9'])
  const ids = s.calls.map(c => JSON.parse(c.init.body).external_order_id)
  assert.deepEqual(ids, [ORDER_ID, ORDER_ID]); assert.equal(s.mem.state.row.external_order_id, ORDER_ID)
  const cap = setup({ row: { status: 'failed_retryable', attempts: 20 } })
  assert.deepEqual(await cap.run(), { ok: false, outcome: 'attempts_exhausted' }); assert.equal(cap.calls.length, 0)
})

await test('gates: HYP payment not verified / area not approved / order not confirmed / invalid payload → blocked, no DB writes, no network', async () => {
  const cases = [
    [setup({ paid: false }), 'payment_not_verified'],
    [setup({ realAreas: true }), 'area_not_ready'],                     // REAL config: no area approved
    [setup({ status: 'received' }), 'order_not_confirmed'],
    [setup({ status: 'cancelled' }), 'order_not_confirmed'],
    [setup({ orderSnapshot: { ...snapshot(), order: { ...snapshot().order, type: 'pickup' } } }), 'invalid_payload'],
    [setup({ orderSnapshot: { ...snapshot(), delivery: { ...snapshot().delivery, geo_precision: 'locality' } } }), 'invalid_payload'],
  ]
  for (const [s, reason] of cases) {
    const r = await s.run()
    assert.equal(r.outcome, 'blocked'); assert.equal(r.reason, reason)
    assert.equal(s.calls.length, 0); assert.equal(s.mem.state.writes, 0)
  }
  const far = setup({ orderSnapshot: { ...snapshot(), delivery: { ...snapshot().delivery, delivery_lat: 31.9 } } })
  const r = await far.run(); assert.deepEqual([r.reason, r.detail], ['area_not_ready', 'location_area_mismatch'])
})

await test('08D14 · 26. normal CREDIT dispatch is blocked without HYP verification (no DB write, no network)', async () => {
  let asked = 0
  const s = setup({ paid: false }); const orig = s.deps.isPaymentVerified
  s.deps.isPaymentVerified = async id => { asked++; return orig(id) }
  const r = await s.run()
  assert.equal(r.reason, 'payment_not_verified'); assert.equal(asked, 1); assert.equal(s.calls.length, 0); assert.equal(s.mem.state.writes, 0)
})

await test('08D14 · 27. normal CREDIT dispatch passes the payment gate when HYP is verified', async () => {
  const s = setup({ paid: true })
  assert.deepEqual(await s.run(), { ok: true, outcome: 'sent', kind: 'created', reclaimed: false })
  assert.equal(JSON.parse(s.calls[0].init.body).payment_method, 'credit')
})

const cashSnapshot = () => ({ ...snapshot(), order: { ...snapshot().order, payment_method: 'cash' } })

await test('08D14 · 28. normal CASH dispatch does not require HYP (never asked) and sends payment_method "cash"', async () => {
  let asked = 0
  const s = setup({ paid: false, orderSnapshot: cashSnapshot() })
  s.deps.isPaymentVerified = async () => { asked++; return false }
  assert.deepEqual(await s.run(), { ok: true, outcome: 'sent', kind: 'created', reclaimed: false })
  assert.equal(asked, 0, 'no HYP check for cash'); assert.equal(JSON.parse(s.calls[0].init.body).payment_method, 'cash')
})

await test('08D14 · 29–30. cash AND credit still require area-ready (real config: no area approved)', async () => {
  for (const [orderSnapshot, paid] of [[cashSnapshot(), false], [snapshot(), true]]) {
    const s = setup({ orderSnapshot, paid, realAreas: true })
    const r = await s.run()
    assert.equal(r.reason, 'area_not_ready'); assert.equal(s.calls.length, 0); assert.equal(s.mem.state.writes, 0)
  }
})

await test('08D14. cash and credit both still need every other gate (confirmed status, valid payload, Maale config)', async () => {
  for (const orderSnapshot of [cashSnapshot(), snapshot()]) {
    assert.equal((await setup({ orderSnapshot, status: 'received' }).run()).reason, 'order_not_confirmed')
    assert.equal((await setup({ orderSnapshot: { ...orderSnapshot, delivery: { ...orderSnapshot.delivery, house_number: '' } } }).run()).reason, 'invalid_payload')
    assert.equal((await setup({ orderSnapshot, config: { status: 'disabled' } }).run()).reason, 'maale_disabled')
  }
  const cibus = setup({ orderSnapshot: { ...snapshot(), order: { ...snapshot().order, payment_method: 'cibus' } } })
  assert.equal((await cibus.run()).reason, 'invalid_payload'); assert.equal(cibus.calls.length, 0)
})

await test('27–28. logs are short codes only: no API key, no customer PII', async () => {
  const all = []
  for (const respond of [() => jsonRes({}, 201), () => jsonRes({ code: 'zone_unknown' }, 400), () => jsonRes({}, 500)]) {
    const s = setup({ respond }); await s.run(); all.push(...s.logs)
  }
  assert.ok(all.length >= 3)
  for (const l of all) {
    assert.match(l, /^maale_dispatch_[a-z0-9_]+$/)
    assert.ok(!l.includes(KEY) && !PII.some(p => l.includes(p)), l)
  }
  for (const f of ['maaleClient.ts', 'maalePayload.ts']) assert.ok(!/console\./.test(readFileSync(join(LIB, f), 'utf8')), `${f}: no logging`)
  const dsrc = readFileSync(join(LIB, 'maaleDispatch.ts'), 'utf8')
  assert.equal((dsrc.match(/console\./g) || []).length, 1); assert.ok(dsrc.includes("log: code => console.warn('maale:', code)"))
})

const walk = dir => readdirSync(dir).flatMap(n => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p] })
await test('29. no browser/client import of the Maale modules; nothing in the app calls dispatch yet', async () => {
  for (const f of walk(join(ROOT, 'app')).filter(p => /\.(tsx?|jsx?)$/.test(p))) {
    const s = readFileSync(f, 'utf8')
    assert.ok(!/maaleClient|maaleDispatch|maalePayload/.test(s), `${f} must not import Maale modules (no trigger yet)`)
  }
  for (const f of walk(LIB).filter(p => p.endsWith('.ts') && !/maale(Dispatch|Client|Payload)\.ts$/.test(p)))
    assert.ok(!/dispatchOrderToMaale|sendMaaleOrder/.test(readFileSync(f, 'utf8')), f)
  assert.ok(readFileSync(join(LIB, 'maaleDispatch.ts'), 'utf8').includes('isPaymentVerified: async () => false'), 'production wiring: HYP gate hard-false')
  for (const f of ['maaleClient.ts', 'maaleDispatch.ts']) assert.ok(!/NEXT_PUBLIC/.test(readFileSync(join(LIB, f), 'utf8')))
})

await test('30. no live Maale call in tests (global fetch is a throwing stub; all traffic went to fakes)', async () => {
  await assert.rejects(() => globalThis.fetch('https://example.invalid'), /LIVE NETWORK CALL ATTEMPTED/)
})

console.log(`\nAll ${passed} maale-dispatch checks passed.`)
