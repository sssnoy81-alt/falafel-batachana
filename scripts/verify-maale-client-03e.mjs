// Offline checks for the Maale Express client + payload corrections (S4-INTEGRATIONS-03E): response handling per the
// provider doc of 21 Oct 2026, the separate dry_run quotation, the ₪600 cash cap, drop_description fitting and
// prep_minutes. FAKE fetch only — the real global fetch is replaced by a throwing stub. No key, no DB, no network.
// Run: node scripts/verify-maale-client-03e.mjs

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'

globalThis.fetch = async () => { throw new Error('LIVE NETWORK CALL ATTEMPTED') }

const require = createRequire(import.meta.url)
const ts = require('typescript')
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cache = new Map()
function load(name) {
  const file = join(ROOT, 'lib', name.replace(/^\.\//, '') + '.ts')
  if (cache.has(file)) return cache.get(file).exports
  const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  })
  const mod = { exports: {} }
  cache.set(file, mod)
  new Function('exports', 'require', 'module', outputText)(mod.exports, p => (p.startsWith('./') ? load(p) : require(p)), mod)
  return mod.exports
}
const src = f => readFileSync(join(ROOT, f), 'utf8')

const C = load('maaleClient')
const M = load('maalePayload')
const cfg = load('orderConfig')

let passed = 0
const test = async (name, fn) => { await fn(); passed++; console.log('  ✓', name) }

const KEY = 'test-key-not-real'
const READY = { status: 'ready', apiKey: KEY }
const jsonRes = (body, status = 200, headers = {}) => ({
  ok: status >= 200 && status < 300, status, json: async () => body, headers: { get: h => headers[h.toLowerCase()] ?? null },
})
function fake(respond) {
  const calls = []
  return { calls, fetchImpl: async (url, init) => { calls.push({ url, init }); return respond(url, init) } }
}
const send = (respond, payload = PAYLOAD) => { const f = fake(respond); return C.sendMaaleOrder(payload, { config: READY, fetchImpl: f.fetchImpl, timeoutMs: 40 }).then(r => ({ r, calls: f.calls })) }

/* ─── FAKE order snapshot (same shape as verify-maale-payload) ─── */
const ORDER_ID = '11111111-2222-4333-8444-555555555555'
const snap = ({ order = {}, delivery = {}, items } = {}) => ({
  order: { id: ORDER_ID, type: 'delivery', branch_id: cfg.DELIVERY_BRANCH_IDS[0], payment_method: 'cash', customer_name: 'לקוח בדיקה', phone: '0500000000', total_price: 73, ...order },
  delivery: { city: 'מעלה אדומים', street: 'הגעש', house_number: '6', apartment: '6', floor: '2', entrance: 'ב׳', notes: 'קוד 1234',
    delivery_fee: 20, meal_surcharge: 4, delivery_lat: 31.773612, delivery_lng: 35.298346, geo_source: 'geocoder', geo_precision: 'street', ...delivery },
  items: items ?? [{ name: 'פלאפל בפיתה', quantity: 1, unit_price: 40 }, { name: 'קוקה קולה', quantity: 1, unit_price: 9 }],
})
const PAYLOAD = M.buildMaaleOrderPayload(snap()).payload
const quotePayload = () => ({ ...PAYLOAD, external_order_id: C.newQuoteExternalId() })

console.log('Maale client (S4-INTEGRATIONS-03E, fake network)')

await test('C1. real 201 → created; nested order.id / order.status / order.zone / fee parsed; legacy top-level fallback', async () => {
  const { r } = await send(() => jsonRes({ order: { id: 'MX-9', status: 'searching', zone: 'mishor', delivery_fee_agorot: 2500 } }, 201))
  assert.deepEqual(r, { ok: true, kind: 'created', status: 201, providerOrderId: 'MX-9', providerStatus: 'searching', zone: 'mishor', deliveryFeeAgorot: 2500 })
  assert.deepEqual(C.classifyMaaleResponse(201, { order: { id: 4711 } }), { ok: true, kind: 'created', status: 201, providerOrderId: '4711' })
  assert.deepEqual(C.classifyMaaleResponse(201, { order_id: 'MX-1', status: 'searching' }), { ok: true, kind: 'created', status: 201, providerOrderId: 'MX-1', providerStatus: 'searching' })
  // values that do not fit the DB CHECKs are dropped, never stored
  assert.deepEqual(C.classifyMaaleResponse(201, { order: { id: 'x'.repeat(101), status: 'Bad Value!', zone: 'a b', delivery_fee_agorot: -5 } }), { ok: true, kind: 'created', status: 201 })
  assert.deepEqual(C.classifyMaaleResponse(201, null), { ok: true, kind: 'created', status: 201 })
})

await test('C2. real 200 (same id + same details) → duplicate, order fields parsed', async () => {
  const { r } = await send(() => jsonRes({ order: { id: 'MX-9', status: 'dispatch_pending', zone: 'mishor' } }, 200))
  assert.deepEqual(r, { ok: true, kind: 'duplicate', status: 200, providerOrderId: 'MX-9', providerStatus: 'dispatch_pending', zone: 'mishor' })
})

await test('C3. a quote-shaped 200 on a REAL send is never a dispatch (would_create / dry_run:true)', async () => {
  for (const body of [{ ok: true, would_create: { zone: 'mishor', delivery_fee_agorot: 2500 } }, { dry_run: true, ok: true }, { would_create: {} }]) {
    const { r } = await send(() => jsonRes(body, 200))
    assert.deepEqual(r, { ok: false, retryable: false, errorCode: 'unexpected_quote_response', status: 200 }, JSON.stringify(body))
  }
})

await test('C4. 400 variants: dispatch_closed, zone_unknown, out_of_area, amount_too_high, validation_error (+ provider code)', async () => {
  const c = (b) => C.classifyMaaleResponse(400, b)
  assert.deepEqual(c({ dispatch_closed: true, error: 'מחוץ לשעות' }), { ok: false, retryable: false, errorCode: 'dispatch_closed', status: 400 })
  for (const code of ['zone_unknown', 'out_of_area', 'amount_too_high'])
    assert.deepEqual(c({ code, error: 'x' }), { ok: false, retryable: false, errorCode: code, status: 400 })
  assert.deepEqual(c({ code: 'missing_lat', error: 'lat required' }), { ok: false, retryable: false, errorCode: 'validation_error', status: 400, providerCode: 'missing_lat' })
  assert.deepEqual(c({ code: 'DROP TABLE; --' }), { ok: false, retryable: false, errorCode: 'validation_error', status: 400 }, 'unsafe code text dropped')
  assert.deepEqual(c(null), { ok: false, retryable: false, errorCode: 'validation_error', status: 400 })
})

await test('C5. 401 / 403 → unauthorized, final (never retried automatically)', async () => {
  for (const s of [401, 403]) assert.deepEqual(C.classifyMaaleResponse(s, {}), { ok: false, retryable: false, errorCode: 'unauthorized', status: s })
})

await test('C6. 402 → blocked, final; provider order id preserved when given', async () => {
  assert.deepEqual(C.classifyMaaleResponse(402, { order_id: 'MX-77', code: 'no_balance', error: 'אין יתרה' }),
    { ok: false, retryable: false, errorCode: 'blocked', status: 402, providerOrderId: 'MX-77', providerCode: 'no_balance' })
  assert.deepEqual(C.classifyMaaleResponse(402, { order: { id: 9 } }), { ok: false, retryable: false, errorCode: 'blocked', status: 402, providerOrderId: '9' })
  assert.deepEqual(C.classifyMaaleResponse(402, {}), { ok: false, retryable: false, errorCode: 'blocked', status: 402 })
})

await test('C7. 409 → idempotency_mismatch, final; the request kept the same external_order_id (never regenerated)', async () => {
  const { r, calls } = await send(() => jsonRes({ code: 'idempotency_mismatch', error: 'x' }, 409))
  assert.deepEqual(r, { ok: false, retryable: false, errorCode: 'idempotency_mismatch', status: 409, providerCode: 'idempotency_mismatch' })
  assert.equal(JSON.parse(calls[0].init.body).external_order_id, ORDER_ID)
  assert.equal(C.classifyMaaleResponse(409, {}).errorCode, 'idempotency_mismatch')
})

await test('C8. 429 → rate_limited, retryable, Retry-After seconds / HTTP date honoured, provider code kept', async () => {
  const { r } = await send(() => jsonRes({ code: 'rate_limited' }, 429, { 'retry-after': '30' }))
  assert.deepEqual(r, { ok: false, retryable: true, errorCode: 'rate_limited', status: 429, retryAfterSec: 30, providerCode: 'rate_limited' })
  assert.equal(C.classifyMaaleResponse(429, { code: 'daily_limit' }).providerCode, 'daily_limit')
  assert.equal(C.classifyMaaleResponse(429, {}).retryAfterSec, undefined)
  assert.equal(C.parseRetryAfter('Wed, 21 Oct 2026 18:00:10 GMT', Date.parse('2026-10-21T18:00:00Z')), 10)
  assert.equal(C.parseRetryAfter('9999999'), 86_400); assert.equal(C.parseRetryAfter('soon'), undefined); assert.equal(C.parseRetryAfter(null), undefined)
})

await test('C9. 5xx / 408 / timeout / network / unexpected 2xx → retryable AND ambiguous (same id only)', async () => {
  for (const s of [500, 502, 503, 504]) assert.deepEqual(C.classifyMaaleResponse(s, null), { ok: false, retryable: true, errorCode: 'provider_5xx', status: s, ambiguous: true })
  assert.deepEqual(C.classifyMaaleResponse(408, null), { ok: false, retryable: true, errorCode: 'timeout', status: 408, ambiguous: true })
  assert.deepEqual(C.classifyMaaleResponse(204, null), { ok: false, retryable: true, errorCode: 'invalid_response', status: 204, ambiguous: true })
  const hang = (_u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))))
  assert.deepEqual((await send(hang)).r, { ok: false, retryable: true, errorCode: 'timeout', ambiguous: true })
  assert.deepEqual((await send(() => { throw new TypeError('fetch failed') })).r, { ok: false, retryable: true, errorCode: 'network_error', ambiguous: true })
  const bad = { ok: false, status: 502, json: async () => { throw new SyntaxError('<html>') } }
  assert.deepEqual((await send(() => bad)).r, { ok: false, retryable: true, errorCode: 'provider_5xx', status: 502, ambiguous: true })
})

await test('C10. a real send carrying dry_run is refused before any network; disabled config never sends', async () => {
  const f = fake(() => jsonRes({}, 201))
  assert.deepEqual(await C.sendMaaleOrder({ ...PAYLOAD, dry_run: true }, { config: READY, fetchImpl: f.fetchImpl }), { ok: false, retryable: false, errorCode: 'dry_run_not_allowed' })
  assert.deepEqual(await C.sendMaaleOrder({ ...PAYLOAD, dry_run: false }, { config: READY, fetchImpl: f.fetchImpl }), { ok: false, retryable: false, errorCode: 'dry_run_not_allowed' })
  for (const config of [{ status: 'disabled' }, { status: 'not_configured' }])
    assert.deepEqual(await C.sendMaaleOrder(PAYLOAD, { config, fetchImpl: f.fetchImpl }), { ok: false, retryable: false, errorCode: 'maale_not_configured' })
  assert.equal(f.calls.length, 0)
  const ok = await send(() => jsonRes({}, 201))
  assert.ok(!('dry_run' in JSON.parse(ok.calls[0].init.body)), 'real body never contains dry_run')
  assert.deepEqual(ok.calls[0].init.headers, { 'Content-Type': 'application/json', 'X-Api-Key': KEY })
})

await test('C11. quoteMaaleOrder: "dry_run": true (boolean), dedicated q- id, would_create parsed; never a dispatch result', async () => {
  const f = fake(() => jsonRes({ dry_run: true, ok: true, warnings: ['outside_hours', { code: 'no_balance' }, 'Bad Text'], would_create: {
    zone: 'mishor', payment_method: 'cash', delivery_fee_agorot: 2500, charged_from_wallet_agorot: 826,
    courier_collects_from_customer_agorot: 7300, courier_pays_merchant_agorot: 4800, address: 'הגעש 6, מעלה אדומים' } }, 200))
  const p = quotePayload()
  const q = await C.quoteMaaleOrder(p, { config: READY, fetchImpl: f.fetchImpl })
  assert.deepEqual(q, { ok: true, kind: 'quote', status: 200, zone: 'mishor', deliveryFeeAgorot: 2500, chargedFromWalletAgorot: 826,
    courierCollectsFromCustomerAgorot: 7300, courierPaysMerchantAgorot: 4800, warnings: ['outside_hours', 'no_balance'] })
  const sent = JSON.parse(f.calls[0].init.body)
  assert.equal(sent.dry_run, true); assert.match(f.calls[0].init.body, /"dry_run":true/); assert.match(sent.external_order_id, /^q-[0-9a-f-]{36}$/)
  assert.deepEqual({ ...sent, dry_run: undefined, external_order_id: undefined }, { ...p, dry_run: undefined, external_order_id: undefined }, 'same validated body otherwise')
  assert.ok(!('dry_run' in p), 'the caller payload object is not mutated')
  assert.notEqual(q.kind, 'created'); assert.notEqual(q.kind, 'duplicate')
  assert.ok(C.newQuoteExternalId() !== C.newQuoteExternalId()); assert.ok(C.newQuoteExternalId().length <= 80)
})

await test('C12. quote guards: orders.id refused (no network); 201 → quote_created_real_order (critical); bad 200; errors mapped', async () => {
  const f = fake(() => jsonRes({}, 200))
  for (const id of [ORDER_ID, 'Q-abc', 'q-', 'q-has space', 'q-' + 'a'.repeat(79)])
    assert.deepEqual(await C.quoteMaaleOrder({ ...PAYLOAD, external_order_id: id }, { config: READY, fetchImpl: f.fetchImpl }), { ok: false, retryable: false, errorCode: 'quote_id_required' }, id)
  assert.deepEqual(await C.quoteMaaleOrder(quotePayload(), { config: { status: 'disabled' }, fetchImpl: f.fetchImpl }), { ok: false, retryable: false, errorCode: 'maale_not_configured' })
  assert.equal(f.calls.length, 0)
  assert.deepEqual(C.classifyMaaleQuoteResponse(201, { order: { id: 'MX-5' } }), { ok: false, retryable: false, errorCode: 'quote_created_real_order', status: 201, providerOrderId: 'MX-5' })
  for (const body of [{ ok: true }, { ok: false, would_create: {} }, null, { order: { id: 'MX-1' } }])
    assert.deepEqual(C.classifyMaaleQuoteResponse(200, body), { ok: false, retryable: false, errorCode: 'invalid_response', status: 200 }, JSON.stringify(body))
  assert.equal(C.classifyMaaleQuoteResponse(400, { code: 'out_of_area' }).errorCode, 'out_of_area')
  assert.equal(C.classifyMaaleQuoteResponse(400, { dispatch_closed: true }).errorCode, 'dispatch_closed')
  assert.equal(C.classifyMaaleQuoteResponse(429, {}, '5').retryAfterSec, 5)
  const hang = (_u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))))
  assert.deepEqual(await C.quoteMaaleOrder(quotePayload(), { config: READY, fetchImpl: hang, timeoutMs: 30 }), { ok: false, retryable: true, errorCode: 'timeout', ambiguous: true })
})

await test('C13. separation + formats: every error code fits error_code CHECK; client never touches DB / logs / env', async () => {
  const codes = new Set()
  for (const s of [200, 201, 202, 204, 400, 401, 402, 403, 404, 408, 409, 418, 429, 500, 503])
    for (const b of [null, {}, { code: 'out_of_area' }, { code: 'zone_unknown' }, { code: 'amount_too_high' }, { dispatch_closed: true }, { would_create: {} }]) {
      for (const r of [C.classifyMaaleResponse(s, b), C.classifyMaaleQuoteResponse(s, b)]) if (!r.ok) codes.add(r.errorCode)
    }
  for (const c of [...codes, 'dry_run_not_allowed', 'quote_id_required', 'maale_not_configured', 'timeout', 'network_error'])
    assert.match(c, /^[a-z0-9_]{1,64}$/, c)
  for (const st of ['searching', 'confirmed', 'dispatch_pending', 'started', 'accepted', 'picked', 'completed', 'rejected', 'blocked', 'cancelled'])
    assert.equal(C.classifyMaaleResponse(201, { order: { status: st } }).providerStatus, st)
  const s = src('lib/maaleClient.ts').replace(/\/\/.*$/gm, '')
  assert.ok(!/supabase|delivery_dispatches|getServerSupabase|console\.|process\.env/.test(s.replace('resolveMaaleConfig(env: EnvLike)', '')), 'no DB / logging / ambient env in the client')
  assert.equal((s.match(/dry_run: true/g) || []).length, 1, 'dry_run is added in exactly one place (the quote path)')
})

console.log('Maale payload (S4-INTEGRATIONS-03E)')

const cashFood = (unit) => snap({ order: { payment_method: 'cash', total_price: Math.round((unit + 4 + 25) * 100) / 100 },
  delivery: { delivery_fee: 25 }, items: [{ name: 'מגש אירוח', quantity: 1, unit_price: unit }] })

await test('P1. cash food total ≤ 60000 agorot accepted, 60001 rejected; credit has no cap; +₪4 stays in the food total', async () => {
  const at = M.buildMaaleOrderPayload(cashFood(596)) // 596 + 4 = ₪600.00
  assert.ok(at.ok, JSON.stringify(at)); assert.equal(at.payload.food_total_agorot, 60000)
  const over = M.buildMaaleOrderPayload(cashFood(596.01)) // ₪600.01
  assert.equal(over.ok, false); assert.ok(over.errors.includes('cash_amount_too_high'))
  const credit = M.buildMaaleOrderPayload({ ...cashFood(596.01), order: { ...cashFood(596.01).order, payment_method: 'credit' } })
  assert.ok(credit.ok); assert.equal(credit.payload.food_total_agorot, 60001)
  assert.equal(M.MAALE_CASH_FOOD_CAP_AGOROT, 60000)
  assert.equal(M.buildMaaleOrderPayload(snap()).payload.food_total_agorot, (73 - 20) * 100, 'fee excluded, +₪4 included (49 + 4)')
})

await test('P2. drop_description always ≤ 280 (300 minus a reserve for the provider label); only the note is shortened', async () => {
  assert.equal(M.MAALE_DROP_DESCRIPTION_BUDGET, 280); assert.ok(M.MAALE_DROP_DESCRIPTION_BUDGET + 'הערת לקוח: '.length <= 300)
  const short = M.buildMaaleOrderPayload(snap())
  assert.equal(short.payload.drop_description, 'כניסה ב׳, קומה 2, דירה 6, קוד 1234'); assert.equal(short.warnings, undefined)
  const long = 'קוד שער 4321 ' + 'א'.repeat(290)
  const full = M.buildMaaleOrderPayload(snap({ delivery: { entrance: 'א'.repeat(20), floor: 'ב'.repeat(20), apartment: 'ג'.repeat(20), notes: long } }))
  assert.ok(full.ok); const d = full.payload.drop_description
  assert.ok([...d].length <= 280, String([...d].length)); assert.ok(d.endsWith('…'))
  assert.ok(d.startsWith(`כניסה ${'א'.repeat(20)}, קומה ${'ב'.repeat(20)}, דירה ${'ג'.repeat(20)}, קוד שער 4321`), 'structured parts + start of note kept')
  assert.deepEqual(full.warnings, ['drop_description_truncated'])
  // exactly at the budget: untouched
  const exact = 'ד'.repeat(280)
  const e = M.fitDropDescription({ entrance: null, floor: null, apartment: null, notes: exact })
  assert.deepEqual(e, { text: exact, truncated: false })
  assert.deepEqual(M.fitDropDescription({ entrance: null, floor: null, apartment: null, notes: exact + 'ה' }).truncated, true)
  // emoji / surrogate pairs counted as one character and never split
  const emo = M.fitDropDescription({ entrance: null, floor: null, apartment: null, notes: '🔔'.repeat(400) })
  assert.ok([...emo.text].length <= 280); assert.ok(!/[\uD800-\uDBFF]$/.test(emo.text.slice(0, -1)))
})

await test('P3. prep_minutes only when requested: absent by default; 0 / 240 accepted; 241 / -1 / 1.5 rejected', async () => {
  assert.ok(!('prep_minutes' in M.buildMaaleOrderPayload(snap()).payload))
  for (const v of [0, 20, 240]) assert.equal(M.buildMaaleOrderPayload(snap(), { prepMinutes: v }).payload.prep_minutes, v)
  for (const v of [241, -1, 1.5, NaN]) assert.ok(M.buildMaaleOrderPayload(snap(), { prepMinutes: v }).errors.includes('invalid_prep_minutes'), String(v))
  assert.deepEqual([...M.MAALE_OPTIONAL_PAYLOAD_KEYS], ['prep_minutes'])
})

await test('P4. dry_run is never part of a built payload (any option); default key set unchanged', async () => {
  for (const opts of [undefined, {}, { prepMinutes: 20 }, { dry_run: true }]) {
    const p = M.buildMaaleOrderPayload(snap(), opts).payload
    assert.ok(!('dry_run' in p))
    assert.ok(Object.keys(p).every(k => [...M.MAALE_PAYLOAD_KEYS, ...M.MAALE_OPTIONAL_PAYLOAD_KEYS].includes(k)))
  }
  assert.deepEqual(Object.keys(M.buildMaaleOrderPayload(snap()).payload).sort(), [...M.MAALE_PAYLOAD_KEYS].sort())
  assert.ok(!/dry_run\s*:/.test(src('lib/maalePayload.ts').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')))
})

await test('P5. explicit limits: > 100 item lines and an address > 300 characters fail closed', async () => {
  const many = Array.from({ length: 101 }, () => ({ name: 'פלאפל', quantity: 1, unit_price: 1 }))
  const r = M.buildMaaleOrderPayload(snap({ order: { total_price: 101 + 4 + 20 }, items: many }))
  assert.ok(r.errors.includes('too_many_items'))
  const a = M.buildMaaleOrderPayload(snap({ delivery: { street: 'ר'.repeat(300) } }))
  assert.ok(a.errors.includes('address_too_long'))
  assert.ok(M.buildMaaleOrderPayload(snap({ order: { total_price: 100 + 4 + 20 }, items: many.slice(0, 100) })).ok, '100 lines are allowed')
})

await test('P6. dispatch compatibility: lib/maaleDispatch.ts untouched; its default call produces the same body as before', async () => {
  const diff = execFileSync('git', ['diff', '--name-only', '6db8a32042f060da31471db4c19e263f86fbc285', '--', 'lib/maaleDispatch.ts'], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(diff.trim(), '', 'maaleDispatch.ts must not change in 03E')
  assert.ok(src('lib/maaleDispatch.ts').includes('payload: buildMaaleOrderPayload(loaded.snapshot),'), 'dispatch still calls the builder without options')
  assert.deepEqual(M.buildMaaleOrderPayload(snap({ order: { payment_method: 'credit' } })).payload, {
    external_order_id: ORDER_ID, payment_method: 'credit', food_total_agorot: 5300,
    items: [{ name: 'פלאפל בפיתה', quantity: 1 }, { name: 'קוקה קולה', quantity: 1 }],
    customer_name: 'לקוח בדיקה', customer_phone: '0500000000', customer_address: 'הגעש 6, מעלה אדומים',
    lat: 31.773612, lng: 35.298346, drop_description: 'כניסה ב׳, קומה 2, דירה 6, קוד 1234',
  })
})

console.log(`\nAll ${passed} Maale 03E checks passed.`)
