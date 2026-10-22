// Offline checks for the protected kitchen dispatch route (S4-INTEGRATIONS-03K).
//  A) the REAL route POST /api/kitchen/orders/[id]/dispatch, loaded with a FAKE supabaseServer and real NextRequests:
//     feature flag, same-origin JSON, DB-backed session, UUID / body, branch scope, stale fee, status — and that the
//     provider is never reached (MAALE_EXPRESS_ENABLED is unset here, global fetch throws).
//  B) lib/kitchenDispatch with the REAL lib/maaleDispatch over an in-memory delivery_dispatches and FAKE quote / send:
//     every eligibility gate and provider outcome, concurrency, persistence failure, sanitized responses.
// No network, no key, no DB. Run: node scripts/verify-kitchen-dispatch.mjs

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import assert from 'node:assert/strict'

let liveFetch = 0
globalThis.fetch = async () => { liveFetch++; throw new Error('LIVE NETWORK CALL ATTEMPTED') }

const require = createRequire(import.meta.url)
const ts = require('typescript')
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/* ─── FAKE supabaseServer (kitchen_users, orders + deliveries embed, delivery_dispatches) ─── */
class ServerConfigError extends Error { constructor(m) { super(m); this.name = 'ServerConfigError' } }
const db = { kitchen_users: [], orders: new Map(), queries: [] }
function query(table) {
  const q = { table, ops: [] }
  db.queries.push(q)
  const where = () => Object.fromEntries(q.ops.filter(o => o[0] === 'eq').map(o => [o[1], o[2]]))
  const run = async () => {
    const w = where()
    if (table === 'kitchen_users') return { data: db.kitchen_users.filter(u => u.username === w.username), error: null }
    if (table === 'orders') {
      const o = db.orders.get(w.id)
      return { data: o ? [{ id: o.id, branch_id: o.branch_id, status: o.status, type: o.type, deliveries: o.delivery_fee === undefined ? [] : [{ delivery_fee: o.delivery_fee }] }] : [], error: null }
    }
    return { data: [], error: null }
  }
  const b = {
    select(c) { q.ops.push(['select', c]); return b }, eq(c, v) { q.ops.push(['eq', c, v]); return b },
    is() { return b }, gte() { return b }, limit() { return b }, in() { return b }, order() { return b },
    update() { q.write = true; return b }, upsert() { q.write = true; return b },
    async maybeSingle() { const r = await run(); return { data: (r.data ?? [])[0] ?? null, error: r.error } },
    then(ok, ko) { return run().then(ok, ko) },
  }
  return b
}
const fakeSupabaseServer = { ServerConfigError, getServerSupabase() { return { from: query } } }

/* ─── Loader: TS → CJS; supabaseServer is the fake ─── */
const cache = new Map()
function loadFile(file) {
  if (cache.has(file)) return cache.get(file).exports
  const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  })
  const mod = { exports: {} }
  cache.set(file, mod)
  const req = p => {
    const name = p.startsWith('@/lib/') ? p.slice(6) : p.startsWith('./') && file.includes(join(ROOT, 'lib')) ? p.slice(2) : null
    if (name === 'supabaseServer') return fakeSupabaseServer
    if (name) return loadFile(join(ROOT, 'lib', name + '.ts'))
    return require(p)
  }
  new Function('exports', 'require', 'module', outputText)(mod.exports, req, mod)
  return mod.exports
}
const lib = n => loadFile(join(ROOT, 'lib', n + '.ts'))
const src = f => readFileSync(join(ROOT, f), 'utf8')
const ROUTE_FILE = 'app/api/kitchen/orders/[id]/dispatch/route.ts'
const route = loadFile(join(ROOT, ROUTE_FILE))
const K = lib('kitchenAuth')
const KD = lib('kitchenDispatch')
const D = lib('maaleDispatch')
const client = lib('maaleClient')
const cfg = lib('orderConfig')
const { NextRequest } = require('next/server')

let passed = 0
const test = async (name, fn) => { await fn(); passed++; console.log('  ✓', name) }

/* ─── Fixtures (FAKE) ─── */
const MISHOR = cfg.DELIVERY_BRANCH_IDS[0]
const OTHER = K.KITCHEN_BRANCH_IDS.find(b => b !== MISHOR)
const ORDER_ID = '11111111-2222-4333-8444-555555555555'
const KEY = 'test-maale-key-not-real'
const SECRET = randomBytes(48).toString('base64url')
process.env.KITCHEN_SESSION_SECRET = SECRET
delete process.env.MAALE_EXPRESS_ENABLED; delete process.env.MAALE_EXPRESS_API_KEY; delete process.env.MAALE_KITCHEN_DISPATCH_ENABLED
const HASH = K.hashPassword(randomBytes(12).toString('base64url'))
const SESS = {
  mishor: { username: 'mishor', role: 'branch', branchId: MISHOR, label: 'mishor' },
  other: { username: 'other', role: 'branch', branchId: OTHER, label: 'other' },
  admin: { username: 'boss', role: 'admin', branchId: null, label: 'boss' },
}
const ORIGIN = 'https://app.example'
function reset(orders = []) {
  db.kitchen_users = Object.values(SESS).map(s => ({ username: s.username, password_hash: HASH, role: s.role, branch_id: s.branchId, label: s.label, is_active: true }))
  db.orders = new Map(orders.map(o => [o.id, { type: 'delivery', branch_id: MISHOR, status: 'confirmed', delivery_fee: '20.00', ...o }]))
  db.queries = []
}
const post = async (orderId, body, { session = SESS.mishor, origin = ORIGIN, contentType = 'application/json', raw } = {}) => {
  const req = new NextRequest(`${ORIGIN}/api/kitchen/orders/${orderId}/dispatch`, {
    method: 'POST',
    headers: { ...(origin ? { origin } : {}), 'content-type': contentType, ...(session ? { cookie: `kitchen_session=${K.signSession(session, SECRET)}` } : {}) },
    body: raw ?? JSON.stringify(body),
  })
  const res = await route.POST(req, { params: Promise.resolve({ id: orderId }) })
  return { status: res.status, body: await res.json(), cache: res.headers.get('cache-control') }
}
const withFlag = async (fn) => { process.env.MAALE_KITCHEN_DISPATCH_ENABLED = 'true'; try { return await fn() } finally { delete process.env.MAALE_KITCHEN_DISPATCH_ENABLED } }

console.log('Kitchen dispatch route (real route, fake DB, provider unreachable)')

await test('R1. flag OFF (unset / "false" / "TRUE" / "1") → 404 before any session or DB access; no provider', async () => {
  for (const v of [undefined, 'false', 'TRUE', '1', 'yes', ' true']) {
    if (v === undefined) delete process.env.MAALE_KITCHEN_DISPATCH_ENABLED; else process.env.MAALE_KITCHEN_DISPATCH_ENABLED = v
    reset([{ id: ORDER_ID }])
    const r = await post(ORDER_ID, { expectedFeeAgorot: 2000 })
    assert.deepEqual([r.status, r.body], [404, { error: 'not_found' }], String(v)); assert.equal(db.queries.length, 0, 'no DB access at all')
  }
  delete process.env.MAALE_KITCHEN_DISPATCH_ENABLED
  assert.equal(KD.isKitchenDispatchEnabled({ MAALE_KITCHEN_DISPATCH_ENABLED: 'true' }), true)
  assert.equal(liveFetch, 0)
})

await test('R2. flag ON: bad Origin / content type / cross-site → 400; no session → 401; all before reading orders', async () => withFlag(async () => {
  for (const opts of [{ origin: 'https://evil.example' }, { origin: null }, { contentType: 'text/plain' }]) {
    reset([{ id: ORDER_ID }])
    const r = await post(ORDER_ID, { expectedFeeAgorot: 2000 }, opts)
    assert.equal(r.status, 400, JSON.stringify(opts)); assert.equal(db.queries.length, 0)
  }
  reset([{ id: ORDER_ID }])
  const r = await post(ORDER_ID, { expectedFeeAgorot: 2000 }, { session: null })
  assert.equal(r.status, 401); assert.equal(db.queries.some(q => q.table === 'orders'), false)
}))

await test('R3. invalid UUID / malformed body → 400 with no order read', async () => withFlag(async () => {
  for (const [id, body, raw] of [['abc', { expectedFeeAgorot: 2000 }], [ORDER_ID, {}], [ORDER_ID, { expectedFeeAgorot: '2000' }], [ORDER_ID, { expectedFeeAgorot: 20.5 }],
    [ORDER_ID, { expectedFeeAgorot: -1 }], [ORDER_ID, { expectedFeeAgorot: 2000, status: 'confirmed' }], [ORDER_ID, null, '{not json']]) {
    reset([{ id: ORDER_ID }])
    const r = await post(id, body, raw ? { raw } : {})
    assert.equal(r.status, 400, JSON.stringify(body)); assert.equal(db.queries.some(q => q.table === 'orders'), false)
  }
}))

await test('R4. wrong branch and missing order → identical 404 (no existence oracle); admin may act; nothing written', async () => withFlag(async () => {
  reset([{ id: ORDER_ID }])
  const wrong = await post(ORDER_ID, { expectedFeeAgorot: 2000 }, { session: SESS.other })
  reset([])
  const missing = await post(ORDER_ID, { expectedFeeAgorot: 2000 })
  assert.deepEqual([wrong.status, wrong.body], [404, { error: 'not_found' }]); assert.deepEqual([missing.status, missing.body], [wrong.status, wrong.body])
  reset([{ id: ORDER_ID }])
  const admin = await post(ORDER_ID, { expectedFeeAgorot: 2000 }, { session: SESS.admin })
  assert.equal(admin.status, 503, 'admin passes scope; provider disabled here')
  assert.equal(db.queries.some(q => q.write), false)
}))

await test('R5. stale fee → 409 stale_confirmation; non-delivery → 409; ready / other statuses → 409 — dispatch never invoked', async () => withFlag(async () => {
  reset([{ id: ORDER_ID }])
  assert.deepEqual((await post(ORDER_ID, { expectedFeeAgorot: 2500 })).body, { error: 'stale_confirmation' })
  reset([{ id: ORDER_ID, type: 'pickup', delivery_fee: undefined }])
  assert.deepEqual((await post(ORDER_ID, { expectedFeeAgorot: 0 })).body, { error: 'not_eligible', reason: 'not_delivery' })
  for (const status of ['received', 'ready', 'delivered', 'cancelled']) {
    reset([{ id: ORDER_ID, status }])
    const r = await post(ORDER_ID, { expectedFeeAgorot: 2000 })
    assert.deepEqual([r.status, r.body], [409, { error: 'not_eligible', reason: 'order_status' }], status)
    assert.equal(db.queries.some(q => q.table === 'delivery_dispatches'), false, `${status}: dispatch not reached`)
  }
  assert.ok(!KD.KITCHEN_DISPATCH_STATUSES.includes('ready'))
}))

await test('R6. eligible request with MAALE_EXPRESS_ENABLED unset → 503 dispatch_unavailable; no provider call, no write; no-store', async () => withFlag(async () => {
  for (const status of ['confirmed', 'preparing']) {
    reset([{ id: ORDER_ID, status }])
    const r = await post(ORDER_ID, { expectedFeeAgorot: 2000 })
    assert.deepEqual([r.status, r.body], [503, { error: 'dispatch_unavailable' }], status); assert.equal(r.cache, 'no-store')
    assert.equal(db.queries.some(q => q.write), false)
  }
  assert.equal(liveFetch, 0, 'no live network')
}))

await test('R7. route source: only POST; flag → origin → awaited session → body → UUID, before any DB access; no test mode', async () => {
  assert.deepEqual(Object.keys(route).filter(k => typeof route[k] === 'function'), ['POST'])
  const s = src(ROUTE_FILE)
  const at = t => { const i = s.indexOf(t); assert.ok(i > 0, t); return i }
  const order = [at('isKitchenDispatchEnabled(process.env)'), at('checkSameOriginJson(req)'), at('await getKitchenSession(req)'), at('await req.json()'),
    at('!isUuid(id) || !parsed'), at('getServerSupabase()'), at('requestKitchenDispatch(')]
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'checks happen in this order')
  assert.ok(!/testMode|bypass|ControlledTestOptions|assessMaaleTestReadiness/.test(s))
  assert.ok(!/MAALE_EXPRESS_API_KEY|NEXT_PUBLIC_/.test(s), 'no key / public env in the route')
  // S4-03M: the kitchen UI calls this route once, with the confirmed fee only, and never imports server modules.
  const page = src('app/dashboard/orders/page.tsx')
  assert.equal(page.split('/dispatch`').length - 1, 1, 'exactly one call site')
  assert.ok(page.includes('/dispatch`, { expectedFeeAgorot: fee })'), 'body is { expectedFeeAgorot }')
  assert.ok(!/from '@\/lib\/(kitchenDispatch|kitchenOrders|kitchenAuth|kitchenUsers|supabaseServer)'/.test(page), 'no server module in the client page')
})

/* ─── B) lib/kitchenDispatch + REAL lib/maaleDispatch over an in-memory delivery_dispatches ─── */
console.log('Kitchen dispatch rules (real dispatch service, fake provider)')

const snapshot = ({ order = {}, delivery = {} } = {}) => ({
  order: { id: ORDER_ID, type: 'delivery', branch_id: MISHOR, payment_method: 'cash', customer_name: 'לקוח בדיקה', phone: '0501234567', total_price: 73, ...order },
  delivery: { city: 'מעלה אדומים', street: 'הגעש', house_number: '6', apartment: '6', floor: '2', entrance: 'ב׳', notes: 'קוד 1234', delivery_fee: 20, meal_surcharge: 4,
    delivery_lat: 31.773612, delivery_lng: 35.298346, geo_source: 'geocoder', geo_precision: 'street', ...delivery },
  items: [{ name: 'פלאפל בפיתה', quantity: 1, unit_price: 40 }, { name: 'קוקה קולה', quantity: 1, unit_price: 9 }],
})
const PII = ['0501234567', 'הגעש', 'קוד 1234', 'לקוח בדיקה', KEY, 'provider-internal-secret']
const okQuote = (over = {}) => ({ ok: true, kind: 'quote', status: 200, zone: 'mishor', deliveryFeeAgorot: 2000, courierPaysMerchantAgorot: 5300, courierCollectsFromCustomerAgorot: 7300, warnings: [], ...over })
const jsonRes = (body, status, headers = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body, headers: { get: h => headers[h.toLowerCase()] ?? null } })
const tick = () => new Promise(r => setTimeout(r, 1))

function harness({ status = 'confirmed', snap = snapshot(), parcelStatus = null, respond = () => jsonRes({ order: { id: 'MX-1', status: 'searching' }, message: 'provider-internal-secret' }, 201),
  quote = okQuote(), authFailure = false, marks = true, kitchenFee = '20.00', branch = MISHOR } = {}) {
  const st = { row: null, sends: 0, quotes: 0, dispatchCalls: 0, writes: 0 }
  const repo = {
    async loadOrder() { return { snapshot: snap, status, parcelStatus } },
    async getDispatch() { return st.row ? { ...st.row } : null },
    async hasRecentAuthFailure() { return authFailure || st.row?.error_code === 'unauthorized' },
    async insertPending(id) { st.writes++; if (!st.row) st.row = { order_id: id, external_order_id: id, status: 'pending', attempts: 0, last_attempt_at: null, error_code: null, provider_order_id: null, provider_status: null } },
    async claim(id, seen, now) {
      st.writes++; await tick()
      const r = st.row
      if (!r || r.status !== seen.status || r.attempts !== seen.attempts || r.last_attempt_at !== seen.last_attempt_at) return false
      Object.assign(r, { status: 'sending', attempts: r.attempts + 1, last_attempt_at: now }); return true
    },
    async markSent(id, v) { st.writes++; if (!marks || st.row?.status !== 'sending') return false; Object.assign(st.row, { status: 'sent', provider_order_id: v.providerOrderId ?? null, provider_status: v.providerStatus ?? null }); return true },
    async markFailed(id, s, code, now, v) { st.writes++; if (!marks || st.row?.status !== 'sending') return false; Object.assign(st.row, { status: s, error_code: code, ...(v?.providerOrderId ? { provider_order_id: v.providerOrderId } : {}) }); return true },
  }
  const config = { status: 'ready', apiKey: KEY }
  const fetchImpl = async (u, init) => { st.sends++; await tick(); return respond(u, init) }
  const dispatchDeps = {
    config, repo, isPaymentVerified: async () => true,
    send: p => client.sendMaaleOrder(p, { config, fetchImpl, timeoutMs: 40 }),
    quote: async () => { st.quotes++; await tick(); return quote }, now: () => '2026-10-22T10:00:00.000Z', log: () => {},
  }
  const deps = {
    async loadOrder(id) { return id === ORDER_ID ? { id, branch_id: branch, status, type: 'delivery', delivery_fee: kitchenFee } : null },
    async dispatch(id) { st.dispatchCalls++; return D.dispatchOrderToMaale(id, dispatchDeps) },
    async loadDispatchRow() { return st.row ? { status: st.row.status, error_code: st.row.error_code, provider_order_id: st.row.provider_order_id, provider_status: st.row.provider_status } : null },
  }
  return { st, run: (session = SESS.mishor, fee = 2000) => KD.requestKitchenDispatch(deps, session, ORDER_ID, fee) }
}
const noLeak = (r) => { const s = JSON.stringify(r); for (const p of PII) assert.ok(!s.includes(p), `leaked ${p}: ${s}`) }

await test('K1. valid cash order → exactly one dispatch invocation, one quote, one send; provider id shown; nothing sensitive', async () => {
  const h = harness()
  const r = await h.run()
  assert.deepEqual(r, { status: 200, body: { result: 'dispatched', providerOrderId: 'MX-1', providerStatus: 'searching', view: 'sent' } })
  assert.deepEqual([h.st.dispatchCalls, h.st.quotes, h.st.sends], [1, 1, 1]); noLeak(r)
})

await test('K2. double-click / two tablets → one submission; the other gets dispatch_in_progress; then already_dispatched', async () => {
  const h = harness()
  const [a, b] = await Promise.all([h.run(), h.run()])
  assert.equal(h.st.sends, 1)
  assert.deepEqual([a.status, b.status].sort(), [200, 409])
  assert.ok([a, b].some(r => r.body.error === 'dispatch_in_progress'))
  const again = await h.run()
  assert.deepEqual(again, { status: 200, body: { result: 'already_dispatched', providerOrderId: 'MX-1', providerStatus: 'searching', view: 'sent' } }); assert.equal(h.st.sends, 1)
})

await test('K3. ineligible: credit / unverified coordinates / active or unresolved parcel / cash cap → 409, no quote, no send', async () => {
  const cases = [
    [harness({ snap: snapshot({ order: { payment_method: 'credit' } }) }), { error: 'not_eligible', reason: 'credit_not_supported' }],
    [harness({ snap: snapshot({ delivery: { geo_precision: 'locality' } }) }), { error: 'not_eligible', reason: 'location_unverified' }],
    [harness({ snap: snapshot({ delivery: { delivery_lat: null, delivery_lng: null, geo_source: 'none', geo_precision: 'unresolved' } }) }), { error: 'not_eligible', reason: 'location_unverified' }],
    [harness({ parcelStatus: 'found' }), { error: 'not_eligible', reason: 'parcel_manual_dispatch_required' }],
    [harness({ parcelStatus: 'awaiting_search' }), { error: 'not_eligible', reason: 'parcel_unresolved' }],
    [harness({ snap: { ...snapshot({ order: { total_price: 625.01 } }), items: [{ name: 'מגש', quantity: 1, unit_price: 596.01 }], delivery: { ...snapshot().delivery, delivery_fee: 25 } }, kitchenFee: '25.00' }),
      { error: 'not_eligible', reason: 'cash_amount_too_high' }],
  ]
  for (const [h, body] of cases) {
    const fee = body.reason === 'cash_amount_too_high' ? 2500 : 2000
    const r = await h.run(SESS.mishor, fee)
    assert.deepEqual(r, { status: 409, body }, JSON.stringify(body)); assert.deepEqual([h.st.quotes, h.st.sends, h.st.writes], [0, 0, 0]); noLeak(r)
  }
})

await test('K4. Kfar Adumim → manual review (location_ambiguous); quote mismatch → quote_mismatch; neither sends', async () => {
  const kfar = harness({ snap: snapshot({ order: { total_price: 88 }, delivery: { city: 'כפר אדומים', delivery_fee: 35 } }), kitchenFee: '35.00', quote: okQuote({ deliveryFeeAgorot: 3500 }) })
  assert.deepEqual(await kfar.run(SESS.mishor, 3500), { status: 409, body: { error: 'manual_review_required', reason: 'location_ambiguous', view: 'needs_manual_check' } })
  assert.equal(kfar.st.sends + kfar.st.quotes, 0)
  for (const [quote, reason] of [[okQuote({ deliveryFeeAgorot: 2500 }), 'fee_mismatch'], [okQuote({ warnings: ['outside_hours'] }), 'quote_warnings'],
    [{ ok: false, retryable: true, errorCode: 'timeout', ambiguous: true }, 'quote_failed']]) {
    const h = harness({ quote })
    assert.deepEqual(await h.run(), { status: 409, body: { error: 'quote_mismatch', reason } }); assert.equal(h.st.sends, 0)
  }
})

await test('K5. 401 → provider_auth_failed, then global stop for every order (no second call)', async () => {
  const h = harness({ respond: () => jsonRes({ message: `bad key ${KEY}` }, 401) })
  const r = await h.run()
  assert.deepEqual(r, { status: 502, body: { error: 'provider_auth_failed' } }); noLeak(r)
  assert.deepEqual(await h.run(), { status: 503, body: { error: 'provider_auth_stopped' } }); assert.equal(h.st.sends, 1)
  const other = harness({ authFailure: true })
  assert.deepEqual(await other.run(), { status: 503, body: { error: 'provider_auth_stopped' } }); assert.equal(other.st.sends + other.st.quotes, 0)
})

await test('K6. 402 blocked / 409 conflict / 429 rate limit / 400 variants → final, never resent', async () => {
  for (const [respond, expected] of [
    [() => jsonRes({ order_id: 'MX-77', code: 'no_balance' }, 402), { status: 409, body: { error: 'provider_blocked', view: 'failed' } }],
    [() => jsonRes({ code: 'idempotency_mismatch' }, 409), { status: 409, body: { error: 'provider_conflict', view: 'failed' } }],
    [() => jsonRes({ code: 'rate_limited' }, 429, { 'retry-after': '60' }), { status: 429, body: { error: 'rate_limited', reason: 'manual_review_required', view: 'rate_limited_manual_check' } }],
    [() => jsonRes({ dispatch_closed: true }, 400), { status: 409, body: { error: 'provider_rejected', reason: 'dispatch_closed', view: 'failed' } }],
    [() => jsonRes({ code: 'out_of_area' }, 400), { status: 409, body: { error: 'provider_rejected', reason: 'out_of_area', view: 'failed' } }],
  ]) {
    const h = harness({ respond })
    assert.deepEqual(await h.run(), expected)
    const second = await h.run()
    assert.equal(second.status === 200, false); assert.equal(h.st.sends, 1, 'never a second submission')
  }
})

await test('K7. timeout / 5xx → manual_review_required (outcome_unknown); a later request never resubmits', async () => {
  const hang = (_u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))))
  for (const respond of [hang, () => jsonRes({}, 503), () => { throw new TypeError('fetch failed') }]) {
    const h = harness({ respond })
    assert.deepEqual(await h.run(), { status: 502, body: { error: 'manual_review_required', reason: 'outcome_unknown', view: 'needs_manual_check' } })
    assert.deepEqual(await h.run(), { status: 409, body: { error: 'manual_review_required', reason: 'previous_outcome_ambiguous', view: 'needs_manual_check' } })
    assert.equal(h.st.sends, 1)
  }
})

await test('K8. persistence failure → 500 manual_review_required (state_not_recorded); never reported as dispatched', async () => {
  const h = harness({ marks: false })
  const r = await h.run()
  assert.deepEqual(r, { status: 500, body: { error: 'manual_review_required', reason: 'state_not_recorded', view: 'needs_manual_check' } })
  // the row stays 'sending' (same clock here → within the 5-min window → in progress; later → manual review): never resent
  assert.deepEqual(await h.run(), { status: 409, body: { error: 'dispatch_in_progress', view: 'in_progress' } })
  assert.equal(h.st.sends, 1)
})

await test('K9. scope + stale fee + status are enforced before the dispatch service is touched', async () => {
  const wrong = harness()
  assert.deepEqual(await wrong.run(SESS.other), { status: 404, body: { error: 'not_found' } }); assert.equal(wrong.st.dispatchCalls, 0)
  const stale = harness()
  assert.deepEqual(await stale.run(SESS.mishor, 1999), { status: 409, body: { error: 'stale_confirmation' } }); assert.equal(stale.st.dispatchCalls, 0)
  for (const status of ['ready', 'received', 'delivered', 'cancelled']) {
    const h = harness({ status })
    assert.deepEqual(await h.run(), { status: 409, body: { error: 'not_eligible', reason: 'order_status' } }, status); assert.equal(h.st.dispatchCalls, 0)
  }
})

await test('K10. every mapped response is code-only (no phone / address / name / key / provider text); mapping is total', async () => {
  const outcomes = [
    { ok: true, outcome: 'sent', kind: 'created' }, { ok: true, outcome: 'already_sent' }, { ok: false, outcome: 'dispatch_in_progress' },
    { ok: false, outcome: 'final_failure_exists' }, { ok: false, outcome: 'attempts_exhausted' },
    { ok: false, outcome: 'manual_review_required', reason: 'rate_limited', retryAt: '2026-10-22T10:01:00.000Z' },
    { ok: false, outcome: 'persistence_failed', providerOutcome: 'created' },
    ...['maale_disabled', 'maale_not_configured', 'auth_state_unknown', 'auth_stop_active', 'order_not_found', 'order_not_confirmed', 'credit_dispatch_disabled',
      'parcel_unresolved', 'parcel_manual_dispatch_required', 'location_manual_review', 'invalid_payload', 'quote_unavailable', 'quote_failed', 'quote_fee_missing',
      'fee_mismatch', 'quote_amount_mismatch', 'quote_warnings', 'test_order_id_mismatch'].map(reason => ({ ok: false, outcome: 'blocked', reason, detail: ['invalid_phone'] })),
    ...['unauthorized', 'blocked', 'idempotency_mismatch', 'rate_limited', 'timeout', 'network_error', 'provider_5xx', 'invalid_response', 'unexpected_quote_response',
      'zone_unknown', 'out_of_area', 'amount_too_high', 'dispatch_closed', 'validation_error', 'provider_rejected', 'db_error'].map(errorCode => ({ ok: false, outcome: 'failed', retryable: false, errorCode })),
  ]
  for (const o of outcomes) {
    const m = KD.mapDispatchResult(o)
    assert.ok(Number.isInteger(m.status) && m.status >= 200 && m.status < 600, JSON.stringify(o))
    for (const v of Object.values(m.body)) if (typeof v === 'string') assert.match(v, /^[a-z0-9_:.TZ-]+$/i, `${JSON.stringify(o)} → ${v}`)
    if (o.outcome !== 'sent' && o.outcome !== 'already_sent') assert.ok('error' in m.body)
  }
  const s = src('lib/kitchenDispatch.ts').replace(/\/\/.*$/gm, '')
  assert.ok(!/console\.|process\.env|fetch\(|getServerSupabase/.test(s), 'helper: no logging / env / network / DB of its own')
})

await test('K11. no live network anywhere in this suite', async () => {
  assert.equal(liveFetch, 0)
  await assert.rejects(() => globalThis.fetch('https://example.invalid'), /LIVE NETWORK CALL ATTEMPTED/); liveFetch--
})

console.log(`\nAll ${passed} kitchen-dispatch checks passed.`)
