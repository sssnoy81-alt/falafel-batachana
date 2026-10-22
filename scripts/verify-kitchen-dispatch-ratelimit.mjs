// Offline checks for the S4-INTEGRATIONS-04B2 durable quote rate limit in the kitchen dispatch flow.
//  A) lib/kitchenDispatch.requestKitchenDispatch + the REAL lib/maaleDispatch + the REAL consumeQuoteSlotRpc helper over
//     an in-memory delivery_dispatches, a FAKE limiter RPC and FAKE provider quote / send. An event log proves the order.
//  B) the REAL route POST /api/kitchen/orders/[id]/dispatch end to end with a FAKE supabaseServer (kitchen_users, orders,
//     delivery_dispatches, rpc) and a FAKE Maale endpoint (only the exact orders URL answers; everything else throws).
// No network, no key, no DB, no provider. Run: node scripts/verify-kitchen-dispatch-ratelimit.mjs

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import assert from 'node:assert/strict'

const MAALE_URL = 'https://express.maalehamishlohim.co.il/api/v1/express/integrations/orders'
const maale = { calls: [], respond: null }
let foreignFetch = 0
globalThis.fetch = async (url, init = {}) => {
  if (String(url) !== MAALE_URL) { foreignFetch++; throw new Error('LIVE NETWORK CALL ATTEMPTED') }
  const body = JSON.parse(String(init.body))
  maale.calls.push(body.dry_run === true ? 'quote' : 'send')
  events.push(body.dry_run === true ? 'quote' : 'send')
  return maale.respond(body, init)
}

const require = createRequire(import.meta.url)
const ts = require('typescript')
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const events = []

/* ─── FAKE supabaseServer for part B ─── */
class ServerConfigError extends Error { constructor(m) { super(m); this.name = 'ServerConfigError' } }
const db = { users: [], order: null, dispatches: [], queries: 0, rpcCalls: [], rpc: null }
function from(table) {
  db.queries++
  const q = { table, filters: [], patch: null, upsert: null, wantRows: false }
  const match = r => q.filters.every(([op, c, v]) => op === 'eq' ? r[c] === v : op === 'is' ? r[c] === v : op === 'gte' ? String(r[c] ?? '') >= v : true)
  const run = async () => {
    if (table === 'kitchen_users') return { data: db.users.filter(match), error: null }
    if (table === 'orders') return { data: db.order && match(db.order) ? [db.order] : [], error: null }
    if (table === 'delivery_dispatches') {
      if (q.upsert) { if (!db.dispatches.some(r => r.order_id === q.upsert.order_id)) db.dispatches.push({ attempts: 0, last_attempt_at: null, error_code: null, provider_order_id: null, provider_status: null, updated_at: null, ...q.upsert }); return { data: null, error: null } }
      const hits = db.dispatches.filter(match)
      if (q.patch) { for (const r of hits) Object.assign(r, q.patch); return { data: q.wantRows ? hits.map(r => ({ order_id: r.order_id })) : null, error: null } }
      return { data: hits.map(r => ({ ...r })), error: null }
    }
    return { data: [], error: null }
  }
  const b = {
    select() { q.wantRows = true; return b }, eq(c, v) { q.filters.push(['eq', c, v]); return b }, is(c, v) { q.filters.push(['is', c, v]); return b },
    gte(c, v) { q.filters.push(['gte', c, v]); return b }, limit() { return b }, in() { return b }, order() { return b },
    update(p) { q.patch = p; q.wantRows = false; return b }, upsert(o) { q.upsert = o; return b },
    async maybeSingle() { const r = await run(); return { data: (r.data ?? [])[0] ?? null, error: r.error } },
    then(ok, ko) { return run().then(ok, ko) },
  }
  return b
}
const fakeSupabase = {
  from,
  async rpc(fn, args) { db.queries++; db.rpcCalls.push({ fn, args }); events.push('rpc'); return db.rpc(args) },
}
const fakeSupabaseServer = { ServerConfigError, getServerSupabase() { return fakeSupabase } }

/* ─── Loader: TS → CJS; supabaseServer is the fake ─── */
const cache = new Map()
function loadFile(file) {
  if (cache.has(file)) return cache.get(file).exports
  const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } })
  const mod = { exports: {} }; cache.set(file, mod)
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
const K = lib('kitchenAuth'), KD = lib('kitchenDispatch'), D = lib('maaleDispatch'), client = lib('maaleClient'), cfg = lib('orderConfig'), UI = lib('kitchenDispatchUi')
const route = loadFile(join(ROOT, 'app/api/kitchen/orders/[id]/dispatch/route.ts'))
const { NextRequest } = require('next/server')

let passed = 0
const test = async (name, fn) => { await fn(); passed++; console.log('  ✓', name) }

/* ─── Fixtures (FAKE) ─── */
const MISHOR = cfg.DELIVERY_BRANCH_IDS[0]
const OTHER = K.KITCHEN_BRANCH_IDS.find(b => b !== MISHOR)
const ORDER_ID = '11111111-2222-4333-8444-555555555555'
const KEY = 'test-maale-key-not-real'
const PII = ['0501234567', 'הגעש', 'קוד 1234', 'לקוח בדיקה', KEY, 'provider-internal-secret', 'relation', 'SECRET-SQL']
const snapshot = ({ order = {}, delivery = {} } = {}) => ({
  order: { id: ORDER_ID, type: 'delivery', branch_id: MISHOR, payment_method: 'cash', customer_name: 'לקוח בדיקה', phone: '0501234567', total_price: 73, ...order },
  delivery: { city: 'מעלה אדומים', street: 'הגעש', house_number: '6', apartment: '6', floor: '2', entrance: 'ב׳', notes: 'קוד 1234', delivery_fee: 20, meal_surcharge: 4,
    delivery_lat: 31.773612, delivery_lng: 35.298346, geo_source: 'geocoder', geo_precision: 'street', ...delivery },
  items: [{ name: 'פלאפל בפיתה', quantity: 1, unit_price: 40 }, { name: 'קוקה קולה', quantity: 1, unit_price: 9 }],
})
const okQuote = { ok: true, kind: 'quote', status: 200, zone: 'mishor', deliveryFeeAgorot: 2000, courierPaysMerchantAgorot: 5300, courierCollectsFromCustomerAgorot: 7300, warnings: [] }
const jsonRes = (body, status, headers = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body, headers: { get: h => headers[h.toLowerCase()] ?? null } })
const tick = () => new Promise(r => setTimeout(r, 1))
const SESSION = { role: 'branch', branchId: MISHOR, username: 'mishor' }

/** Part A harness: real service + real RPC helper; fake limiter answer via `rpc`. */
function harness({ status = 'confirmed', snap = snapshot(), parcelStatus = null, rpc = async () => ({ data: 'ok', error: null }),
  respond = () => jsonRes({ order: { id: 'MX-1', status: 'searching' } }, 201), quote = okQuote, authFailure = false, row = null,
  kitchenFee = '20.00', branch = MISHOR, maaleConfig = { status: 'ready', apiKey: KEY } } = {}) {
  const st = { row: row ? { order_id: ORDER_ID, external_order_id: ORDER_ID, attempts: 0, last_attempt_at: null, error_code: null, provider_order_id: null, provider_status: null, ...row } : null,
    sends: 0, quotes: 0, writes: 0, rpcArgs: [], events: [] }
  const repo = {
    async loadOrder() { return { snapshot: snap, status, parcelStatus } },
    async getDispatch() { return st.row ? { ...st.row } : null },
    async hasRecentAuthFailure() { return authFailure || st.row?.error_code === 'unauthorized' },
    async insertPending(id) { st.writes++; if (!st.row) st.row = { order_id: id, external_order_id: id, status: 'pending', attempts: 0, last_attempt_at: null, error_code: null, provider_order_id: null, provider_status: null } },
    async claim(id, seen, now) { st.writes++; await tick(); const r = st.row
      if (!r || r.status !== seen.status || r.attempts !== seen.attempts || r.last_attempt_at !== seen.last_attempt_at) return false
      Object.assign(r, { status: 'sending', attempts: r.attempts + 1, last_attempt_at: now }); return true },
    async markSent(id, v) { st.writes++; if (st.row?.status !== 'sending') return false; Object.assign(st.row, { status: 'sent', provider_order_id: v.providerOrderId ?? null, provider_status: v.providerStatus ?? null }); return true },
    async markFailed(id, s, code) { st.writes++; if (st.row?.status !== 'sending') return false; Object.assign(st.row, { status: s, error_code: code }); return true },
  }
  const fakeDb = { async rpc(fn, args) { st.events.push('rpc'); st.rpcArgs.push({ fn, ...args }); await tick(); return rpc(args) } }
  const fetchImpl = async (u, init) => { st.sends++; st.events.push('send'); await tick(); return respond(u, init) }
  const dispatchDeps = {
    config: maaleConfig, repo, isPaymentVerified: async () => false,
    send: p => client.sendMaaleOrder(p, { config: maaleConfig, fetchImpl, timeoutMs: 40 }),
    quote: async () => { st.quotes++; st.events.push('quote'); await tick(); return quote },
    // Exactly what the route wires: actor bound from the session; branch supplied by the service from the DB snapshot.
    consumeQuoteSlot: (id, branchId) => KD.consumeQuoteSlotRpc(fakeDb, id, branchId, SESSION.username),
    now: () => '2026-10-22T10:00:00.000Z', log: () => {},
  }
  const deps = {
    async loadOrder(id) { return id === ORDER_ID ? { id, branch_id: branch, status, type: 'delivery', delivery_fee: kitchenFee } : null },
    async dispatch(id) { return D.dispatchOrderToMaale(id, dispatchDeps) },
    async loadDispatchRow() { return st.row ? { status: st.row.status, error_code: st.row.error_code, provider_order_id: st.row.provider_order_id, provider_status: st.row.provider_status } : null },
  }
  return { st, run: (session = SESSION, fee = 2000) => KD.requestKitchenDispatch(deps, session, ORDER_ID, fee) }
}
const noLeak = r => { const s = JSON.stringify(r); for (const p of PII) assert.ok(!s.includes(p), `leaked ${p}: ${s}`) }
const nothing = (h, label) => assert.deepEqual([h.st.rpcArgs.length, h.st.quotes, h.st.sends, h.st.writes], [0, 0, 0, 0], label)

console.log('A) Service flow: limiter position, mapping, failure safety (real dispatch service, fake provider)')

await test('A1. valid order → exactly one limiter call, BEFORE the quote; args = route UUID, DB branch, session account', async () => {
  const h = harness()
  const r = await h.run()
  assert.equal(r.status, 200); assert.equal(r.body.result, 'dispatched')
  assert.deepEqual(h.st.events, ['rpc', 'quote', 'send'])
  assert.deepEqual(h.st.rpcArgs, [{ fn: 'consume_maale_quote_slot', p_order_id: ORDER_ID, p_branch_id: MISHOR, p_actor: 'mishor' }])
  noLeak(r)
})

await test('A2. local limits (order / branch / global) → 429 rate_limited_local; nothing quoted, sent or written; UI does not lock', async () => {
  for (const answer of ['order_limit', 'branch_limit', 'global_limit']) {
    const h = harness({ rpc: async () => ({ data: answer, error: null }) })
    const r = await h.run()
    assert.deepEqual(r, { status: 429, body: { error: 'rate_limited_local' } }, answer)
    assert.deepEqual([h.st.rpcArgs.length, h.st.quotes, h.st.sends, h.st.writes, h.st.row], [1, 0, 0, 0, null], answer)
    const o = UI.interpretDispatchResponse(r.status, r.body)
    assert.equal(o.lock, false); assert.equal(o.code, 'rate_limited_local'); assert.ok(/[א-ת]/.test(o.message) && /לא נשלחה/.test(o.message))
  }
  assert.notEqual(UI.DISPATCH_MESSAGES.rate_limited_local, UI.DISPATCH_MESSAGES.rate_limited, 'distinct from the provider 429 message')
  // later, with a free slot, the same order dispatches normally (not permanently locked)
  const later = harness()
  assert.equal((await later.run()).body.result, 'dispatched')
})

await test('A3. SQL error / missing function / unexpected answer / throw → 503 rate_limit_unavailable; no provider call', async () => {
  const answers = [
    async () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function SECRET-SQL relation' } }),
    async () => ({ data: null, error: { code: '42883', message: 'function does not exist' } }),
    async () => ({ data: null, error: { code: '55P03', message: 'canceling statement due to lock timeout' } }),
    async () => ({ data: null, error: null }), async () => ({ data: 5, error: null }), async () => ({ data: 'OK', error: null }),
    async () => ({ data: 'allowed', error: null }), async () => { throw new Error('network down SECRET-SQL') },
  ]
  for (const rpc of answers) {
    const h = harness({ rpc })
    const r = await h.run()
    assert.deepEqual(r, { status: 503, body: { error: 'rate_limit_unavailable' } })
    assert.deepEqual([h.st.quotes, h.st.sends, h.st.writes], [0, 0, 0]); noLeak(r)
    assert.equal(UI.interpretDispatchResponse(r.status, r.body).lock, false)
  }
})

await test('A4. limiter rejects the request shape (invalid / not found / branch mismatch) → 409 rate_limit_rejected; fail closed', async () => {
  for (const answer of ['invalid_request', 'order_not_found', 'branch_mismatch']) {
    const h = harness({ rpc: async () => ({ data: answer, error: null }) })
    assert.deepEqual(await h.run(), { status: 409, body: { error: 'rate_limit_rejected' } }, answer)
    assert.deepEqual([h.st.quotes, h.st.sends, h.st.writes], [0, 0, 0])
  }
  // a snapshot without a branch never reaches the RPC
  const nb = harness({ snap: snapshot({ order: { branch_id: null } }) })
  const r = await nb.run()
  assert.equal(nb.st.rpcArgs.length, 0); assert.equal(nb.st.sends + nb.st.quotes, 0); assert.ok(r.status >= 400)
})

await test('A5. no limiter call for requests blocked earlier (session scope, stale fee, status, eligibility, config, auth stop)', async () => {
  const cases = [
    ['other branch session', harness(), { role: 'branch', branchId: OTHER, username: 'other' }, 2000, 404],
    ['stale fee', harness(), SESSION, 2500, 409],
    ['status ready', harness({ status: 'ready' }), SESSION, 2000, 409],
    ['status received', harness({ status: 'received' }), SESSION, 2000, 409],
    ['credit', harness({ snap: snapshot({ order: { payment_method: 'credit' } }) }), SESSION, 2000, 409],
    ['active parcel', harness({ parcelStatus: 'found' }), SESSION, 2000, 409],
    ['unresolved parcel', harness({ parcelStatus: 'awaiting_search' }), SESSION, 2000, 409],
    ['imprecise coordinates', harness({ snap: snapshot({ delivery: { geo_precision: 'locality' } }) }), SESSION, 2000, 409],
    ['Kfar Adumim', harness({ snap: snapshot({ delivery: { city: 'כפר אדומים' } }) }), SESSION, 2000, 409],
    ['Maale disabled', harness({ maaleConfig: { status: 'disabled' } }), SESSION, 2000, 503],
    ['Maale key missing', harness({ maaleConfig: { status: 'not_configured' } }), SESSION, 2000, 503],
    ['401 global stop', harness({ authFailure: true }), SESSION, 2000, 503],
  ]
  for (const [label, h, session, fee, code] of cases) {
    const r = await h.run(session, fee)
    assert.equal(r.status, code, `${label}: ${JSON.stringify(r)}`); nothing(h, label)
  }
  const cap = harness({ snap: { ...snapshot({ order: { total_price: 625.01 } }), items: [{ name: 'מגש', quantity: 1, unit_price: 596.01 }], delivery: { ...snapshot().delivery, delivery_fee: 25 } }, kitchenFee: '25.00' })
  assert.equal((await cap.run(SESSION, 2500)).body.reason, 'cash_amount_too_high'); nothing(cap, 'cash cap')
})

await test('A6. existing dispatch record (sent / sending / failed / non-zero pending) → no limiter call, no submission', async () => {
  const rows = [
    { status: 'sent', attempts: 1, last_attempt_at: '2026-10-22T09:00:00.000Z', provider_order_id: 'MX-9' },
    { status: 'sending', attempts: 1, last_attempt_at: '2026-10-22T09:59:30.000Z' },
    { status: 'sending', attempts: 1, last_attempt_at: '2026-10-22T08:00:00.000Z' },
    { status: 'failed_retryable', attempts: 1, last_attempt_at: '2026-10-22T09:00:00.000Z', error_code: 'timeout' },
    { status: 'failed_retryable', attempts: 1, last_attempt_at: '2026-10-22T09:00:00.000Z', error_code: 'rate_limited_after_30' },
    { status: 'failed_final', attempts: 1, last_attempt_at: '2026-10-22T09:00:00.000Z', error_code: 'out_of_area' },
    { status: 'pending', attempts: 1, last_attempt_at: null },
  ]
  for (const row of rows) {
    const h = harness({ row })
    const before = JSON.stringify(h.st.row)
    const r = await h.run()
    nothing(h, row.status); assert.equal(JSON.stringify(h.st.row), before, 'row untouched')
    assert.ok(r.status === 200 ? r.body.result === 'already_dispatched' : r.status === 409, JSON.stringify(r))
  }
})

await test('A7. provider 429 (after a granted slot) stays manual review; a later request uses no slot and sends nothing', async () => {
  const h = harness({ respond: () => jsonRes({ message: 'slow down' }, 429, { 'retry-after': '30' }) })
  const r = await h.run()
  assert.deepEqual(r, { status: 429, body: { error: 'rate_limited', reason: 'manual_review_required', view: 'rate_limited_manual_check' } })
  assert.deepEqual([h.st.rpcArgs.length, h.st.quotes, h.st.sends, h.st.row.status], [1, 1, 1, 'failed_retryable'])
  assert.equal(UI.interpretDispatchResponse(r.status, r.body).lock, true, 'provider 429 still locks (outcome unknown)')
  const again = await h.run()
  assert.equal(again.body.error, 'manual_review_required'); assert.equal(h.st.rpcArgs.length, 1); assert.equal(h.st.sends, 1)
})

await test('A8. timeout after a granted slot → outcome unknown, never resent; later requests consume no slot', async () => {
  const hang = (_u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))))
  const h = harness({ respond: hang })
  const r = await h.run()
  assert.deepEqual([r.status, r.body.error, r.body.reason], [502, 'manual_review_required', 'outcome_unknown'])
  for (let i = 0; i < 3; i++) assert.equal((await h.run()).body.error, 'manual_review_required')
  assert.deepEqual([h.st.rpcArgs.length, h.st.sends], [1, 1])
})

await test('A9. concurrency: 4 simultaneous requests (all slots granted) → exactly ONE provider submission', async () => {
  const h = harness()
  const rs = await Promise.all([h.run(), h.run(), h.run(), h.run()])
  assert.equal(h.st.sends, 1); assert.equal(rs.filter(r => r.status === 200).length >= 1, true)
  assert.ok(rs.every(r => r.status === 200 || r.body.error === 'dispatch_in_progress'), JSON.stringify(rs.map(r => r.body)))
  assert.ok(h.st.rpcArgs.length >= 1 && h.st.rpcArgs.length <= 4)
  const later = await h.run(); assert.equal(later.body.result, 'already_dispatched'); assert.equal(h.st.sends, 1)
  assert.ok(h.st.rpcArgs.length <= 4, 'the already-sent order consumes no further slot')
})

await test('A10. quoteSlotDecision is fail-closed and bounded; the owner runner path (no limiter) is unchanged', async () => {
  const dec = a => D.quoteSlotDecision(async () => a, ORDER_ID, MISHOR)
  assert.equal(await dec('ok'), 'ok')
  for (const a of ['order_limit', 'branch_limit', 'global_limit']) assert.equal(await dec(a), 'rate_limited_local')
  for (const a of ['invalid_request', 'order_not_found', 'branch_mismatch']) assert.equal(await dec(a), 'rate_limit_rejected')
  for (const a of [null, undefined, '', 'OK', 'ok ', 1, {}, 'rate_limited']) assert.equal(await dec(a), 'rate_limit_unavailable', String(a))
  assert.equal(await D.quoteSlotDecision(async () => { throw new Error('x') }, ORDER_ID, MISHOR), 'rate_limit_unavailable')
  let called = 0
  assert.equal(await D.quoteSlotDecision(async () => { called++; return 'ok' }, ORDER_ID, null), 'rate_limit_rejected'); assert.equal(called, 0)
  await assert.rejects(KD.consumeQuoteSlotRpc({ rpc: async () => ({ data: 'ok', error: null }) }, ORDER_ID, MISHOR, 'Bad Actor'), /quote_slot_invalid_actor/)
  await assert.rejects(KD.consumeQuoteSlotRpc({ rpc: async () => ({ data: null, error: { code: 'x;drop', message: 'SECRET' } }) }, ORDER_ID, MISHOR, 'mishor'), e => e.message === 'quote_slot_rpc_error')
})

/* ─── B) Real route, end to end ─── */
console.log('B) Real route end to end (fake Supabase + fake Maale endpoint; nothing else reachable)')

const SECRET = randomBytes(48).toString('base64url')
process.env.KITCHEN_SESSION_SECRET = SECRET
const HASH = K.hashPassword(randomBytes(12).toString('base64url'))
db.users = [
  { username: 'mishor', password_hash: HASH, role: 'branch', branch_id: MISHOR, label: 'mishor', is_active: true },
  { username: 'other', password_hash: HASH, role: 'branch', branch_id: OTHER, label: 'other', is_active: true },
]
const ORIGIN = 'https://app.example'
const s = snapshot()
const resetDb = (over = {}) => {
  db.order = { id: ORDER_ID, type: 'delivery', branch_id: MISHOR, payment_method: 'cash', customer_name: s.order.customer_name, phone: s.order.phone, total_price: '73.00',
    status: 'confirmed', deliveries: [{ ...s.delivery, delivery_fee: '20.00', meal_surcharge: '4.00' }],
    order_items: s.items.map(i => ({ quantity: i.quantity, unit_price: i.unit_price, menu_items: { name_he: i.name } })), parcel_requests: [], ...over }
  db.dispatches = []; db.queries = 0; db.rpcCalls = []; db.rpc = async () => ({ data: 'ok', error: null })
  maale.calls = []; events.length = 0
  maale.respond = body => body.dry_run === true
    ? jsonRes({ ok: true, would_create: { zone: 'mishor', delivery_fee_agorot: 2000, courier_pays_merchant_agorot: 5300, courier_collects_from_customer_agorot: 7300 }, warnings: [] }, 200)
    : jsonRes({ order: { id: 'MX-77', status: 'searching' } }, 201)
}
const post = async (body = { expectedFeeAgorot: 2000 }, user = 'mishor') => {
  const sess = db.users.find(u => u.username === user)
  const req = new NextRequest(`${ORIGIN}/api/kitchen/orders/${ORDER_ID}/dispatch`, {
    method: 'POST', body: JSON.stringify(body),
    headers: { origin: ORIGIN, 'content-type': 'application/json', cookie: `kitchen_session=${K.signSession({ username: sess.username, role: sess.role, branchId: sess.branch_id, label: sess.label }, SECRET)}` },
  })
  const res = await route.POST(req, { params: Promise.resolve({ id: ORDER_ID }) })
  return { status: res.status, body: await res.json() }
}
const env = on => {
  for (const k of ['MAALE_KITCHEN_DISPATCH_ENABLED', 'MAALE_KITCHEN_DISPATCH_USERS', 'MAALE_EXPRESS_ENABLED', 'MAALE_EXPRESS_API_KEY']) delete process.env[k]
  // S4-04C: the flag alone authorizes nobody — both fixture accounts are allowlisted for the enabled-path tests.
  if (on.kitchen) { process.env.MAALE_KITCHEN_DISPATCH_ENABLED = 'true'; process.env.MAALE_KITCHEN_DISPATCH_USERS = 'mishor,other' }
  if (on.maale) { process.env.MAALE_EXPRESS_ENABLED = 'true'; process.env.MAALE_EXPRESS_API_KEY = KEY }
}

await test('B1. feature flag off → 404 before any DB access: no query, no RPC, no provider call', async () => {
  resetDb(); env({ maale: true })
  assert.deepEqual(await post(), { status: 404, body: { error: 'not_found' } })
  assert.deepEqual([db.queries, db.rpcCalls.length, maale.calls.length], [0, 0, 0])
})

await test('B2. enabled + valid → one RPC (route UUID, DB branch, session account) strictly before the quote, then one send', async () => {
  resetDb(); env({ kitchen: true, maale: true })
  const r = await post()
  assert.equal(r.status, 200, JSON.stringify(r)); assert.equal(r.body.result, 'dispatched'); assert.equal(r.body.providerOrderId, 'MX-77')
  assert.deepEqual(events, ['rpc', 'quote', 'send'])
  assert.deepEqual(db.rpcCalls, [{ fn: 'consume_maale_quote_slot', args: { p_order_id: ORDER_ID, p_branch_id: MISHOR, p_actor: 'mishor' } }])
  assert.deepEqual(db.dispatches.map(d => [d.status, d.attempts]), [['sent', 1]]); noLeak(r)
})

await test('B3. branch / actor can never come from the browser: extra body fields → 400, no RPC', async () => {
  resetDb(); env({ kitchen: true, maale: true })
  for (const body of [{ expectedFeeAgorot: 2000, branchId: OTHER }, { expectedFeeAgorot: 2000, actor: 'admin' }, { expectedFeeAgorot: 2000, p_actor: 'x' }]) {
    assert.deepEqual(await post(body), { status: 400, body: { error: 'invalid_request' } })
  }
  assert.deepEqual([db.rpcCalls.length, maale.calls.length], [0, 0])
})

await test('B4. migration absent (function missing) → 503 rate_limit_unavailable before Maale; no dispatch row; no fallback', async () => {
  resetDb(); env({ kitchen: true, maale: true })
  db.rpc = async () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.consume_maale_quote_slot SECRET-SQL' } })
  const r = await post()
  assert.deepEqual(r, { status: 503, body: { error: 'rate_limit_unavailable' } })
  assert.deepEqual([db.rpcCalls.length, maale.calls.length, db.dispatches.length], [1, 0, 0]); noLeak(r)
  db.rpc = async () => { throw new Error('fetch failed') } // transport error to the DB
  assert.deepEqual(await post(), { status: 503, body: { error: 'rate_limit_unavailable' } }); assert.equal(maale.calls.length, 0)
})

await test('B5. local limit through the route → 429 rate_limited_local, no provider call, no dispatch row', async () => {
  resetDb(); env({ kitchen: true, maale: true })
  db.rpc = async () => ({ data: 'branch_limit', error: null })
  assert.deepEqual(await post(), { status: 429, body: { error: 'rate_limited_local' } })
  assert.deepEqual([maale.calls.length, db.dispatches.length], [0, 0])
})

await test('B6. another branch account → 404 (no existence oracle), no RPC; Maale disabled → 503, no RPC', async () => {
  resetDb(); env({ kitchen: true, maale: true })
  assert.deepEqual(await post(undefined, 'other'), { status: 404, body: { error: 'not_found' } })
  assert.equal(db.rpcCalls.length, 0)
  resetDb(); env({ kitchen: true })
  assert.deepEqual(await post(), { status: 503, body: { error: 'dispatch_unavailable' } })
  assert.deepEqual([db.rpcCalls.length, maale.calls.length], [0, 0])
})

await test('B7. route wiring in source: limiter always passed with the session account; no browser-supplied branch / actor', async () => {
  const r = src('app/api/kitchen/orders/[id]/dispatch/route.ts')
  assert.ok(r.includes('consumeQuoteSlot: (id, branchId) => consumeQuoteSlotRpc(supabase, id, branchId, auth.session.username)'))
  assert.equal((r.match(/dispatchOrderToMaale\(/g) || []).length, 1)
  assert.ok(!/body\.(branch|actor)|parsed\.(branch|actor)/.test(r))
  const d = src('lib/maaleDispatch.ts')
  const i = d.indexOf('5a) S4-04B'), q = d.indexOf('const q = checkQuote(await deps.quote(')
  assert.ok(i > 0 && i < q, 'limiter immediately before the quote')
  assert.ok(d.indexOf('const early = stateDecision(row') < i && d.indexOf("if (!deps.quote) return blocked('quote_unavailable')") < i, 'after state check and quote availability')
  assert.equal(foreignFetch, 0, 'no fetch to any other host')
})

for (const k of ['MAALE_KITCHEN_DISPATCH_ENABLED', 'MAALE_EXPRESS_ENABLED', 'MAALE_EXPRESS_API_KEY']) delete process.env[k]
console.log(`\nAll ${passed} kitchen dispatch rate-limit checks passed.`)
