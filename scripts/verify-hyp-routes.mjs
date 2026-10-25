// Offline checks for the payment routes (HYP-07): lib/hyp/hypPaymentService.ts behind app/api/payments/**.
// Fake database (records every call, injectable failures) + mock HYP transport + throwing global fetch.
// No env file, no Supabase, no network. The real HYP-05 SQL path is exercised by scripts/pgtest-hyp07-payment-flow.mjs.
// Run: node scripts/verify-hyp-routes.mjs

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

import assert from 'node:assert/strict'

const fetchCalls = []
globalThis.fetch = async url => { fetchCalls.push(String(url)); throw new Error('LIVE NETWORK CALL ATTEMPTED') }

const require = createRequire(import.meta.url)
const ts = require('typescript')
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cache = new Map()
function load(file) {
  if (cache.has(file)) return cache.get(file).exports
  const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  })
  const mod = { exports: {} }
  cache.set(file, mod)
  const req = p => (p.startsWith('.') ? load(resolve(dirname(file), p) + '.ts') : require(p))
  new Function('exports', 'require', 'module', outputText)(mod.exports, req, mod)
  return mod.exports
}
const S = load(join(ROOT, 'lib', 'hyp', 'hypPaymentService.ts'))
const RL = load(join(ROOT, 'lib', 'hyp', 'hypRateLimit.ts'))
const OR = load(join(ROOT, 'lib', 'orderRequest.ts'))
const OC = load(join(ROOT, 'lib', 'orderConfig.ts'))
const DBM = load(join(ROOT, 'lib', 'hyp', 'hypDb.ts'))
const src = f => readFileSync(join(ROOT, f), 'utf8')

let passed = 0, failed = 0
const test = async (name, fn) => {
  try { await fn(); passed++; console.log('  ✓', name) }
  catch (e) { failed++; console.log('  ✗', name, '\n     ', e.message.split('\n')[0]) }
}

/* ─── fixtures (fake) ─── */
const ORIGIN = 'https://falafel.test'
const API_KEY = 'fakeKEY-7f3a9c11', PASSP = 'fakePassP-42b8'
const ENV = { HYP_PAYMENTS_ENABLED: 'true', HYP_TERMINAL: '0010000001', HYP_API_KEY: API_KEY, HYP_PASSP: PASSP, HYP_TERMINAL_KIND: 'test', HYP_PILOT_PHONES: '0501234567' }
const B1 = '8fed141d-0e7c-46c1-803b-88d3d811c1f8'
const M1 = '11111111-1111-4111-8111-111111111111', M2 = '22222222-2222-4222-8222-222222222222'
const CAT = 'c0c0c0c0-0000-4000-8000-000000000001'
const CATALOG = {
  items: new Map([[M1, { id: M1, category_id: CAT, is_active: true, has_lettuce: false, has_pita: false, has_egg: false }],
                  [M2, { id: M2, category_id: CAT, is_active: true, has_lettuce: false, has_pita: false, has_egg: false }]]),
  prices: new Map([[M1, { item_id: M1, price: 20, is_available: true }], [M2, { item_id: M2, price: 26, is_available: true }]]),
  toppings: new Map(),
}
const REF = 'A1B2C3D4E5F60718293A4B5C6D7E8F90'
const NAME = 'Dana Fixture', PHONE = '050-1234567', PHONE_N = '0501234567'
const body = (o = {}) => ({ checkoutKey: randomUUID(), branchId: B1, type: 'pickup', customerName: NAME, phone: PHONE, items: [{ itemId: M1, quantity: 2 }], ...o })
const startReq = (b, h = {}) => new Request(`${ORIGIN}/api/payments/hyp/start`, { method: 'POST', body: typeof b === 'string' ? b : JSON.stringify(b),
  headers: { origin: ORIGIN, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', 'x-real-ip': '203.0.113.7', ...h } })
const returnRaw = (o = {}) => Object.entries({ Id: '50012345', CCode: '0', Amount: '40.00', ACode: '0012345', Order: REF, Fild1: '', Sign: 'f'.repeat(32), ...o })
  .filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`).join('&')
const returnReq = raw => new Request(`${ORIGIN}/api/payments/hyp/return?${raw}`, { headers: { 'x-real-ip': '203.0.113.8' } })
const signedBody = `action=pay&Masof=0010000001&Amount=40.00&Coin=1&Tash=1&Order=${REF}&Info=Falafel%20BaTachana&PageLang=HEB&Sign=True&signature=a9f00c1b77`

class FakeDb {
  constructor(o = {}) {
    this.calls = []; this.failOn = o.failOn ?? null; this.o = o
    this.intent = { id: 'int-1', status: o.intentStatus ?? 'created', amountAgorot: 4000, hypOrderRef: o.ref ?? REF, terminalKind: 'test', publicToken: 'tok-1' }
    this.returns = new Map(); this.orders = 0; this.verifyFinalStatus = null
  }
  rec(op, args) { this.calls.push({ op, args }); if (this.failOn === op) throw new DBM.HypDbError(op, '57P01') }
  ops() { return this.calls.map(c => c.op) }
  async loadCatalog(order) { this.rec('loadCatalog', order); return CATALOG }
  async createIntent(a) { this.rec('createIntent', a); return this.o.createResult ?? { result: 'created', intentId: 'int-1', publicToken: 'tok-1', hypOrderRef: REF, status: 'created' } }
  async recordSignResult(id, ok) { this.rec('recordSignResult', { id, ok }); return this.o.signResult ?? { result: 'recorded', status: ok ? 'redirected' : 'not_sent' } }
  async recordReturn(raw) {
    this.rec('recordReturn', raw)
    const order = /(?:^|&)Order=([^&]*)/.exec(raw)?.[1]
    if (order !== REF) return { result: 'unknown_order', returnId: null, intentId: null, publicToken: null, status: null }
    const dup = [...this.returns.values()].find(r => r.returnRaw === raw)
    if (dup) return { result: 'duplicate_return', returnId: dup.id, intentId: 'int-1', publicToken: 'tok-1', status: this.intent.status }
    const id = randomUUID(); this.returns.set(id, { id, intentId: 'int-1', returnRaw: raw, verifyOutcome: null })
    if (['redirected', 'outcome_unknown', 'verify_rejected', 'declined'].includes(this.intent.status)) this.intent.status = 'returned'
    return { result: 'recorded', returnId: id, intentId: 'int-1', publicToken: 'tok-1', status: this.intent.status }
  }
  async getIntentForReturn(id) { this.rec('getIntentForReturn', id); return { ...this.intent } }
  async getReturn(id) { this.rec('getReturn', id); const r = this.returns.get(id); return r ? { ...r } : null }
  async recordVerification(a) {   // the HYP-05 decision rules, minimal (full SQL behaviour: pgtest-hyp07 / pgtest-hyp05)
    this.rec('recordVerification', a)
    const r = this.returns.get(a.p_return_id); r.verifyOutcome = a.p_outcome
    const g = k => new RegExp(`(?:^|&)${k}=([^&]*)`).exec(r.returnRaw)?.[1]
    let result, status
    if (a.p_outcome === 'rejected') [result, status] = ['rejected', 'verify_rejected']
    else if (g('CCode') === '0') [result, status] = Math.round(Number(g('Amount')) * 100) === this.intent.amountAgorot ? ['paid', 'paid'] : ['amount_mismatch', 'paid_amount_mismatch']
    else if (['600', '700', '800'].includes(g('CCode'))) [result, status] = ['not_captured', 'outcome_unknown']
    else [result, status] = ['declined', 'declined']
    this.intent.status = status
    return { result, status }
  }
  async finalize(id) {
    this.rec('finalize', id)
    if (this.o.finalizeResult) return this.o.finalizeResult
    if (this.intent.status === 'finalized') return { result: 'already_finalized', orderId: 'ord-1', orderNumber: 7, dailyNumber: 3 }
    if (this.intent.status !== 'paid') return { result: `not_finalizable:${this.intent.status}`, orderId: null, orderNumber: null, dailyNumber: null }
    this.intent.status = 'finalized'; this.orders++
    return { result: 'finalized', orderId: 'ord-1', orderNumber: 7, dailyNumber: 3 }
  }
  async getPublicStatus(t) { this.rec('getPublicStatus', t); return this.o.publicStatus === undefined ? { status: this.intent.status, orderId: this.intent.status === 'finalized' ? 'f0e1d2c3-b4a5-4697-8879-6a5b4c3d2e1f' : null } : this.o.publicStatus }
  async getOrderSummary(id) { this.rec('getOrderSummary', id); return { orderNumber: 7, dailyNumber: 3, status: 'received', type: 'pickup' } }
}

const logs = []
const responses = []
function deps(db, o = {}) {
  const transportCalls = []
  const answers = o.answers ?? [{ body: signedBody }]
  const transport = async (url, init) => {
    transportCalls.push(url)
    const a = answers[Math.min(transportCalls.length - 1, answers.length - 1)]
    if (a === 'timeout') return new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))))
    if (a === 'sign_echo') {   // documented SIGN answer: the request parameters in order, action=pay, credentials not echoed, signature added
      const q = url.split('?')[1].split('&').filter(p => !/^(What|KEY|PassP)=/.test(p)).map(p => (p === 'action=APISign' ? 'action=pay' : p))
      return { status: 200, text: async () => `${q.join('&')}&signature=a9f00c1b77` }
    }
    return { status: a.status ?? 200, text: async () => a.body }
  }
  const big = () => RL.createRateLimiter(1000, 60_000)
  return {
    d: { env: o.env ?? ENV, db, transport, isShopOpen: () => o.open ?? true,
         limits: { start: o.startLimiter ?? big(), startPhone: big(), ret: big(), status: big() },
         log: (e, c) => logs.push(`${e} ${c ?? ''}`) },
    transportCalls,
  }
}
async function call(fn, ...args) {
  const res = await fn(...args)
  const text = res.status === 303 ? '' : await res.clone().text()
  responses.push({ status: res.status, text, headers: Object.fromEntries(res.headers) })
  return { res, status: res.status, json: text ? JSON.parse(text) : null, location: res.headers.get('location') }
}
console.log('Feature flag + request guards (start)')
await test('flag missing / false / TRUE / 1 / yes → 404; nothing touched (fail closed)', async () => {
  for (const v of [undefined, 'false', 'TRUE', '1', 'yes', ' true']) {
    const db = new FakeDb(); const { d, transportCalls } = deps(db, { env: { ...ENV, HYP_PAYMENTS_ENABLED: v } })
    const r = await call(S.handleHypStart, startReq(body()), d)
    assert.equal(r.status, 404, String(v)); assert.equal(r.json.error, 'payments_disabled'); assert.equal(db.calls.length, 0); assert.equal(transportCalls.length, 0)
  }
})
await test('same-origin JSON required: missing / foreign Origin, cross-site fetch, non-JSON content type → 403', async () => {
  for (const h of [{ origin: '' }, { origin: 'https://evil.test' }, { 'sec-fetch-site': 'cross-site' }, { 'content-type': 'text/plain' }]) {
    const db = new FakeDb(); const r = await call(S.handleHypStart, startReq(body(), h), deps(db).d)
    assert.equal(r.status, 403, JSON.stringify(h)); assert.equal(db.calls.length, 0)
  }
})
await test('request size limits: declared or actual body over 16 KiB → 413', async () => {
  let r = await call(S.handleHypStart, startReq(body(), { 'content-length': '20000' }), deps(new FakeDb()).d); assert.equal(r.status, 413)
  r = await call(S.handleHypStart, startReq(JSON.stringify({ ...body(), pad: 'x'.repeat(17000) })), deps(new FakeDb()).d); assert.equal(r.status, 413)
})
await test('rate limiting: the 11th start from one address in a minute → 429', async () => {
  const limiter = RL.createRateLimiter(10, 60_000, () => 1000)
  const statuses = []
  for (let i = 0; i < 11; i++) statuses.push((await call(S.handleHypStart, startReq(body()), deps(new FakeDb(), { startLimiter: limiter }).d)).status)
  assert.deepEqual(statuses.slice(-2), [200, 429])
})
await test('missing / malformed credentials or a live terminal outside Production → 503, nothing created', async () => {
  for (const env of [{ ...ENV, HYP_PASSP: '' }, { ...ENV, HYP_TERMINAL: 'abc' }, { ...ENV, HYP_TERMINAL: '0882001234', HYP_TERMINAL_KIND: 'live', VERCEL_ENV: 'preview' }]) {
    const db = new FakeDb(); const r = await call(S.handleHypStart, startReq(body()), deps(db, { env }).d)
    assert.equal(r.status, 503); assert.equal(r.json.error, 'payments_unavailable'); assert.equal(db.calls.length, 0)
  }
})

await test('pilot allowlist HYP_PILOT_PHONES: only listed phones may start; missing / empty / malformed list blocks everyone', async () => {
  for (const [list, phone, expected] of [['0501234567', PHONE, 200], ['0509999999', PHONE, 404], ['0509999999, 0501234567', PHONE, 200],
                                         [' 0501234567 ', PHONE, 200], ['050-1234567', PHONE, 404], ['+972501234567', PHONE, 404],
                                         ['0501234567,', PHONE, 404], ['0501234567,,0509999999', PHONE, 404], ['0501234567;0509999999', PHONE, 404],
                                         ['501234567', PHONE, 404], [Array.from({ length: 21 }, (_, i) => `05${String(i).padStart(8, '0')}`).concat('0501234567').join(','), PHONE, 404],
                                         ['', PHONE, 404], ['   ', PHONE, 404], [undefined, PHONE, 404]]) {
    const db = new FakeDb(); const r = await call(S.handleHypStart, startReq(body({ phone })), deps(db, { env: { ...ENV, HYP_PILOT_PHONES: list }, answers: ['sign_echo'] }).d)
    assert.equal(r.status, expected, `${list}`)
    if (expected === 404) { assert.equal(r.json.error, 'payments_disabled'); assert.ok(!db.ops().includes('createIntent')) }
  }
})

console.log('Checkout validation (start)')
await test('the client cannot supply amount, payment method, terminal, status, intent fields or redirect targets', async () => {
  for (const k of ['paymentMethod', 'payment_method', 'amount', 'amountAgorot', 'terminal', 'terminalKind', 'Masof', 'status', 'publicToken', 'hypOrderRef', 'snapshot', 'p_order', 'redirectUrl', 'returnUrl']) {
    const db = new FakeDb(); const r = await call(S.handleHypStart, startReq(body({ [k]: k === 'paymentMethod' ? 'cash' : 1 })), deps(db).d)
    assert.equal(r.status, 400, k); assert.equal(r.json.error, 'client_payment_fields_not_accepted', k); assert.equal(db.calls.length, 0)
  }
})
await test('price tampering is rejected by the authoritative parser (top-level and per-item money keys)', async () => {
  for (const b of [body({ total: 1 }), body({ total_price: 1 }), body({ items: [{ itemId: M1, quantity: 2, price: 0.01 }] }), body({ items: [{ itemId: M1, quantity: 2, unitPrice: 1 }] })]) {
    const r = await call(S.handleHypStart, startReq(b), deps(new FakeDb()).d)
    assert.equal(r.status, 400); assert.equal(r.json.error, 'client_prices_not_accepted')
  }
})
await test('pilot scope: other branch, delivery, parcel → refused before the catalog; closed shop → 409', async () => {
  const other = await call(S.handleHypStart, startReq(body({ branchId: 'f1e2d3c4-b5a6-4978-8a9b-0c1d2e3f4a5b' })), deps(new FakeDb()).d)
  assert.equal(other.json.error, 'online_payment_branch_not_allowed')
  const hidden = await call(S.handleHypStart, startReq(body({ branchId: OC.CUSTOMER_HIDDEN_BRANCH_IDS[0] })), deps(new FakeDb()).d)
  assert.equal(hidden.json.error, 'invalid_branch')
  const delivery = await call(S.handleHypStart, startReq(body({ type: 'delivery', delivery: { city: OC.ACTIVE_DELIVERY_AREAS[0], street: 'הרצל', houseNumber: '1' } })), deps(new FakeDb()).d)
  assert.equal(delivery.json.error, 'online_payment_type_not_allowed')
  const parcel = await call(S.handleHypStart, startReq(body({ parcel: { trackingRef: 'RR123456789IL' } })), deps(new FakeDb()).d)
  assert.equal(parcel.json.error, 'parcel_checkout_disabled')
  const db = new FakeDb(); const closed = await call(S.handleHypStart, startReq(body()), deps(db, { open: false }).d)
  assert.equal(closed.status, 409); assert.equal(closed.json.error, 'closed'); assert.equal(db.calls.length, 0)
  assert.equal((await call(S.handleHypStart, startReq(body({ checkoutKey: 'nope' })), deps(new FakeDb()).d)).json.error, 'invalid_checkout_key')
})
await test('valid start: server-priced snapshot (online, no p_delivery key), exact agorot, test terminal, SIGN → redirect; no order', async () => {
  const db = new FakeDb(); const { d, transportCalls } = deps(db, { answers: ['sign_echo'] })
  const r = await call(S.handleHypStart, startReq(body({ items: [{ itemId: M1, quantity: 2 }, { itemId: M2, quantity: 1, notes: 'בלי חריף' }] })), d)
  assert.equal(r.status, 200); assert.deepEqual(Object.keys(r.json).sort(), ['redirectUrl', 'statusToken'])
  assert.ok(r.json.redirectUrl.startsWith('https://pay.hyp.co.il/p/?action=pay&'))
  const c = db.calls.find(x => x.op === 'createIntent').args
  assert.equal(c.amountAgorot, 6600); assert.equal(c.terminalKind, 'test'); assert.equal(c.ttlSeconds, 900)
  assert.deepEqual(Object.keys(c.snapshot).sort(), ['p_items', 'p_order'])
  assert.deepEqual(c.snapshot.p_order, { branch_id: B1, type: 'pickup', phone: PHONE_N, customer_name: NAME, payment_method: 'online', total_price: 66 })
  assert.deepEqual(c.snapshot.p_items.map(i => [i.item_id, i.quantity, i.unit_price]), [[M1, 2, 20], [M2, 1, 26]])
  const sign = new URL(transportCalls[0]); assert.equal(sign.searchParams.get('Amount'), '66.00'); assert.equal(sign.searchParams.get('Order'), REF)
  assert.deepEqual(db.ops(), ['loadCatalog', 'createIntent', 'recordSignResult']); assert.equal(db.calls[2].args.ok, true)
  assert.ok(!r.json.redirectUrl.includes(API_KEY) && !r.json.redirectUrl.includes(PASSP))
})
await test('duplicate start never opens a second payment page', async () => {
  // same checkout already redirected → 409 + token, no SIGN
  let db = new FakeDb({ createResult: { result: 'existing', intentId: 'int-1', publicToken: 'tok-1', hypOrderRef: REF, status: 'redirected' } })
  let x = deps(db); let r = await call(S.handleHypStart, startReq(body()), x.d)
  assert.equal(r.status, 409); assert.deepEqual(r.json, { error: 'payment_in_progress', statusToken: 'tok-1' }); assert.equal(x.transportCalls.length, 0)
  // concurrent double-click: SIGN succeeded but the other request already recorded the redirect → no URL handed out
  db = new FakeDb({ signResult: { result: 'already_redirected', status: 'redirected' } }); x = deps(db); r = await call(S.handleHypStart, startReq(body()), x.d)
  assert.equal(r.status, 409); assert.equal(r.json.redirectUrl, undefined)
  // a crashed earlier attempt (still 'created', nothing handed out) may sign again
  db = new FakeDb({ createResult: { result: 'existing', intentId: 'int-1', publicToken: 'tok-1', hypOrderRef: REF, status: 'created' } }); x = deps(db)
  assert.equal((await call(S.handleHypStart, startReq(body()), x.d)).status, 200)
  for (const [result, err] of [['checkout_key_reused', 'checkout_key_reused'], ['open_payment_exists', 'payment_in_progress']]) {
    r = await call(S.handleHypStart, startReq(body()), deps(new FakeDb({ createResult: { result, intentId: null, publicToken: null, hypOrderRef: null, status: null } })).d)
    assert.equal(r.status, 409); assert.deepEqual(r.json, { error: err })
  }
})
await test('SIGN failure → 502, the intent is recorded not_sent (no URL was handed out)', async () => {
  const db = new FakeDb(); const r = await call(S.handleHypStart, startReq(body()), deps(db, { answers: [{ body: 'CCode=901' }] }).d)
  assert.equal(r.status, 502); assert.deepEqual(db.calls.at(-1), { op: 'recordSignResult', args: { id: 'int-1', ok: false } })
})

console.log('Return handling')
const flow = async (raw, o = {}) => {
  const db = o.db ?? new FakeDb({ intentStatus: 'redirected', ...o.dbo })
  const x = deps(db, { answers: o.answers ?? [{ body: 'CCode=0' }], env: o.env })
  const r = await call(S.handleHypReturn, returnReq(raw), x.d)
  return { r, db, verifyCalls: x.transportCalls }
}
await test('confirmed payment: stored first, VERIFY, recorded authentic, finalized once → 303 to the fixed status page', async () => {
  const { r, db, verifyCalls } = await flow(returnRaw())
  assert.equal(r.status, 303); assert.equal(r.location, '/order/payment/tok-1')
  assert.deepEqual(db.ops(), ['recordReturn', 'getIntentForReturn', 'getReturn', 'recordVerification', 'finalize'])
  assert.equal(db.calls[3].args.p_outcome, 'authentic'); assert.equal(db.orders, 1); assert.equal(verifyCalls.length, 1)
  assert.ok(verifyCalls[0].includes('What=VERIFY') && verifyCalls[0].endsWith(`&${returnRaw()}`))
  assert.equal(r.res.headers.get('cache-control'), 'no-store, max-age=0'); assert.equal(r.res.headers.get('referrer-policy'), 'no-referrer')
})
await test('duplicate callback: no second VERIFY, finalize is idempotent, still one order', async () => {
  const db = new FakeDb({ intentStatus: 'redirected' })
  await flow(returnRaw(), { db }); const second = await flow(returnRaw(), { db })
  assert.equal(second.verifyCalls.length, 0); assert.equal(db.orders, 1); assert.equal(second.r.location, '/order/payment/tok-1')
  assert.equal(db.calls.filter(c => c.op === 'finalize').length, 1)            // already finalized → not even attempted
  // a duplicate callback while still 'paid' (earlier finalize failed) retries finalize — idempotent in HYP-05
  const held = new FakeDb({ intentStatus: 'redirected', failOn: 'finalize' })
  await flow(returnRaw(), { db: held }); held.failOn = null
  const retry = await flow(returnRaw(), { db: held })
  assert.equal(retry.verifyCalls.length, 0); assert.equal(held.orders, 1); assert.equal(held.intent.status, 'finalized')
})
await test('non-capture 600 / 700 / 800: recorded authentic → outcome_unknown, never finalized', async () => {
  for (const code of ['600', '700', '800']) {
    const { r, db } = await flow(returnRaw({ CCode: code }))
    assert.equal(db.intent.status, 'outcome_unknown', code); assert.ok(!db.ops().includes('finalize')); assert.equal(r.location, '/order/payment/tok-1')
  }
})
await test('declined and amount-mismatch payments are recorded, never finalized', async () => {
  let x = await flow(returnRaw({ CCode: '33', ACode: '' })); assert.equal(x.db.intent.status, 'declined'); assert.ok(!x.db.ops().includes('finalize'))
  x = await flow(returnRaw({ Amount: '39.00' })); assert.equal(x.db.intent.status, 'paid_amount_mismatch'); assert.ok(!x.db.ops().includes('finalize'))
})
await test('order reference mismatch: VERIFY not called, nothing recorded, no order', async () => {
  const { db, verifyCalls } = await flow(returnRaw(), { dbo: { ref: 'ZZZZZZZZZZZZZZZZ' } })
  assert.equal(verifyCalls.length, 0); assert.ok(!db.ops().includes('recordVerification')); assert.equal(db.orders, 0)
})
await test('VERIFY timeout / 5xx / malformed / 902: outcome not recorded as paid, no order; stays for reconciliation', async () => {
  for (const answers of [['timeout'], [{ status: 503, body: '' }], [{ body: '<html>' }]]) {
    const { r, db } = await flow(returnRaw(), { answers })
    assert.ok(!db.ops().includes('recordVerification') && !db.ops().includes('finalize')); assert.equal(db.intent.status, 'returned'); assert.equal(r.status, 303)
  }
  const rej = await flow(returnRaw(), { answers: [{ body: 'CCode=902' }] })
  assert.equal(rej.db.calls.find(c => c.op === 'recordVerification').args.p_outcome, 'rejected'); assert.ok(!rej.db.ops().includes('finalize'))
}, )
await test('DB failure after payment: verification / finalize errors → 303 to the status page, no crash, codes-only log', async () => {
  for (const failOn of ['recordVerification', 'finalize', 'getReturn']) {
    logs.length = 0
    const { r, db } = await flow(returnRaw(), { dbo: { failOn } })
    assert.equal(r.status, 303); assert.equal(r.location, '/order/payment/tok-1'); assert.equal(db.orders, 0)
    assert.ok(logs.some(l => l.startsWith('hyp_return_db') && l.includes('57P01')), logs.join(';'))
  }
  const early = await flow(returnRaw(), { dbo: { failOn: 'recordReturn' } }); assert.equal(early.r.location, '/order/payment'); assert.equal(early.verifyCalls.length, 0)
})
await test('late return: finalize answers held:late_return → no order, customer sent to the status page', async () => {
  const { r, db } = await flow(returnRaw(), { dbo: { finalizeResult: { result: 'held:late_return', orderId: null, orderNumber: null, dailyNumber: null } } })
  assert.equal(r.location, '/order/payment/tok-1'); assert.equal(db.orders, 0); assert.ok(logs.some(l => l.includes('held:late_return')))
})
await test('unknown Order / empty / malformed return → generic page; nothing verified; no redirect to request data', async () => {
  for (const raw of [returnRaw({ Order: 'NOSUCHORDER1' }), '', 'next=https://evil.test']) {
    const { r, verifyCalls } = await flow(raw)
    assert.equal(r.location, '/order/payment'); assert.equal(verifyCalls.length, 0)
  }
})
await test('flag off on return: evidence still stored and verified, but no kitchen order', async () => {
  const { db } = await flow(returnRaw(), { env: { ...ENV, HYP_PAYMENTS_ENABLED: 'false' } })
  assert.ok(db.ops().includes('recordVerification')); assert.ok(!db.ops().includes('finalize')); assert.equal(db.intent.status, 'paid')
})
await test('credentials missing / terminal kind changed on return → no VERIFY, intent stays returned', async () => {
  for (const env of [{ ...ENV, HYP_API_KEY: '' }, { ...ENV, HYP_TERMINAL: '0882001234', HYP_TERMINAL_KIND: 'live', VERCEL_ENV: 'production' }]) {
    const { db, verifyCalls } = await flow(returnRaw(), { env })
    assert.equal(verifyCalls.length, 0); assert.equal(db.intent.status, 'returned')
  }
})
await test('concurrent duplicate returns (service level) end with one order', async () => {
  const db = new FakeDb({ intentStatus: 'redirected' })
  await Promise.all(Array.from({ length: 6 }, () => flow(returnRaw(), { db })))
  assert.equal(db.orders, 1)
})

console.log('Public status')
await test('sanitized state for every HYP-05 status; order numbers + tracking reference only once finalized', async () => {
  const states = ['created', 'not_sent', 'redirected', 'returned', 'paid', 'paid_amount_mismatch', 'declined', 'verify_rejected', 'outcome_unknown', 'paid_hold', 'finalized', 'no_charge_found', 'voided', 'refunded']
  const got = {}
  for (const s of states) {
    const r = await call(S.handleIntentStatus, new Request(`${ORIGIN}/x`), 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', deps(new FakeDb({ intentStatus: s })).d)
    got[s] = r.json.state
    if (s === 'finalized') assert.deepEqual(r.json.order, { orderNumber: 7, dailyNumber: 3, status: 'received', trackingId: 'f0e1d2c3-b4a5-4697-8879-6a5b4c3d2e1f' })
    else assert.deepEqual(Object.keys(r.json), ['state'])
    assert.equal(r.res.headers.get('cache-control'), 'no-store, max-age=0'); assert.equal(r.res.headers.get('x-content-type-options'), 'nosniff')
  }
  assert.deepEqual(got, { created: 'awaiting_payment', not_sent: 'failed', redirected: 'awaiting_payment', returned: 'processing', paid: 'processing',
    paid_amount_mismatch: 'in_review', declined: 'failed', verify_rejected: 'in_review', outcome_unknown: 'in_review', paid_hold: 'in_review',
    finalized: 'confirmed', no_charge_found: 'not_charged', voided: 'refunded', refunded: 'refunded' })
  assert.equal((await call(S.handleIntentStatus, new Request(`${ORIGIN}/x`), 'not-a-token', deps(new FakeDb()).d)).status, 400)
  assert.equal((await call(S.handleIntentStatus, new Request(`${ORIGIN}/x`), 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', deps(new FakeDb({ publicStatus: null })).d)).status, 404)
})

console.log('Leakage, isolation, regression')
await test('no response or log contains credentials, customer data, HYP signature / transaction id or internal ids', async () => {
  // The payment-page URL itself must carry Order / Amount for HYP; every other byte is checked.
  const scrub = r => ({ ...r, text: r.text.replace(/"redirectUrl":"https:\/\/pay\.hyp\.co\.il\/p\/\?[^"]*"/, '"redirectUrl":"<payment page>"') })
  const blob = JSON.stringify({ responses: responses.map(scrub), logs })
  for (const secret of [API_KEY, PASSP, NAME, PHONE_N, PHONE, 'f'.repeat(32), '50012345', 'int-1', REF]) assert.ok(!blob.includes(secret), secret)
  const pages = responses.filter(r => r.text.includes('redirectUrl')).map(r => JSON.parse(r.text).redirectUrl)
  assert.ok(pages.length > 0 && pages.every(u => !u.includes(API_KEY) && !u.includes(PASSP) && !u.includes(PHONE_N) && !u.includes('Dana')))
  assert.ok(responses.length > 60, `responses: ${responses.length}`)
  for (const r of responses.filter(x => x.status === 303)) assert.ok(/^\/order\/payment(\/tok-1)?$/.test(r.headers.location), r.headers.location)
})
await test('no real network: every provider call went to the injected transport; global fetch never used', () => {
  assert.equal(fetchCalls.length, 0)
})
await test('route files only wire the service + production deps; flag / scope enforced server-side', () => {
  for (const [f, fn] of [['app/api/payments/hyp/start/route.ts', 'handleHypStart'], ['app/api/payments/hyp/return/route.ts', 'handleHypReturn'], ['app/api/payments/intents/[token]/route.ts', 'handleIntentStatus']]) {
    const s = src(f)
    assert.match(s, new RegExp(`return ${fn}\\(req, (token, )?productionHypDeps\\(\\)\\)`), f)
    assert.deepEqual([...s.matchAll(/^import .* from '([^']+)'/gm)].map(m => m[1]).sort(), ['@/lib/hyp/hypDeps', '@/lib/hyp/hypPaymentService'], f)
  }
  const svc = src('lib/hyp/hypPaymentService.ts')
  assert.ok(!/resolve_payment_intent|sweep_expired/.test(svc + src('lib/hyp/hypDb.ts')), 'no staff / sweeper action reachable from public routes')
  assert.ok(!/\.from\('payment_[a-z_]+'\)\.(insert|update|upsert|delete)/.test(src('lib/hyp/hypDb.ts')), 'no direct ledger writes')
})
await test('HYP-05 contract: RPC names and argument names used by lib/hyp/hypDb equal the migration signatures', () => {
  const sql = src('db/migrations/hyp05_payment_intents.sql'); const db = src('lib/hyp/hypDb.ts')
  const sigs = { create_payment_intent: ['p_checkout_key', 'p_terminal_kind', 'p_order_kind', 'p_snapshot', 'p_amount_agorot', 'p_ttl_seconds'],
                 record_hyp_sign_result: ['p_intent_id', 'p_redirected'], record_hyp_return: ['p_return_raw'],
                 record_hyp_verification: ['p_return_id', 'p_outcome', 'p_verify_response'], finalize_paid_intent: ['p_intent_id', 'p_staff_user'] }
  for (const [fn, args] of Object.entries(sigs)) {
    const m = new RegExp(`CREATE FUNCTION public\\.${fn}\\(([^)]*)\\)`).exec(sql); assert.ok(m, fn)
    assert.deepEqual(m[1].split(',').map(a => a.trim().split(/\s+/)[0]).filter(Boolean), args, fn)
    assert.ok(db.includes(`'${fn}'`), fn)
    for (const a of args.filter(a => a !== 'p_return_id' && a !== 'p_outcome' && a !== 'p_verify_response')) assert.ok(db.includes(a), `${fn}.${a}`)
  }
  for (const col of ['intent_id', 'public_token', 'hyp_order_ref', 'intent_status', 'return_id', 'order_id', 'order_number', 'daily_number']) assert.ok(db.includes(`r.${col}`), col)
})
await test('legacy checkout untouched: POST /api/orders unchanged in git, the parser still refuses online, four methods unchanged', () => {
  // app/order/page.tsx is changed by HYP-08 (gated on the online option; verified by scripts/verify-hyp-ui.mjs).
  // Fixed pre-HYP baseline (HYP-RELEASE-02A): HEAD would be vacuous once HYP is committed. Compared with the working tree
  // (committed + uncommitted); existing files only (M/D/R/T) — the newly added HYP kitchen routes are not legacy changes.
  const PRE_HYP_BASE = '3bfa329c2294e77204aecfac528513b792eb0c1c'
  execFileSync('git', ['merge-base', '--is-ancestor', PRE_HYP_BASE, 'HEAD'], { cwd: ROOT })
  const diff = execFileSync('git', ['diff', '--name-only', '--diff-filter=MDRT', PRE_HYP_BASE, '--', 'app/api/orders', 'lib/orderRequest.ts', 'lib/orderConfig.ts', 'lib/createOrder.ts', 'lib/maaleDispatch.ts', 'lib/maalePayload.ts', 'app/api/kitchen', 'app/order/DeliveryAddressPicker.tsx'], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(diff.trim(), '')
  assert.deepEqual([...OC.PAYMENT_METHODS], ['cash', 'credit', 'cibus', 'bit'])
  const p = OR.parseCreateOrderRequest({ branchId: B1, type: 'pickup', customerName: NAME, phone: PHONE, paymentMethod: 'online', items: [{ itemId: M1, quantity: 1 }] })
  assert.equal(p.ok, false); assert.equal(p.code, 'invalid_payment_method')
  for (const pm of ['cash', 'credit', 'cibus', 'bit']) assert.equal(OR.parseCreateOrderRequest({ branchId: B1, type: 'pickup', customerName: NAME, phone: PHONE, paymentMethod: pm, items: [{ itemId: M1, quantity: 1 }] }).ok, true, pm)
})

console.log(`\n${passed}/${passed + failed} PASS${failed ? ` — ${failed} FAILED` : ''}`)
process.exit(failed ? 1 : 0)
