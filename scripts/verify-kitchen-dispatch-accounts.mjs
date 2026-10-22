// Offline checks for S4-INTEGRATIONS-04C1 — authorized kitchen dispatch accounts + mandatory quote limiter.
//  A) MAALE_KITCHEN_DISPATCH_USERS parsing / exact matching (lib/kitchenDispatch).
//  B) REAL routes (dispatch POST, session GET, orders GET) with a FAKE supabaseServer that counts every table touched
//     and a FAKE Maale endpoint: unauthorized requests do no order / dispatch / limiter / provider work.
//  C) lib/maaleDispatch: the limiter is REQUIRED for every ordinary call; only the marker-checked testMode is exempt.
//  D) Source: the protected kitchen route is the only production dispatch entry point; no automatic triggers.
// No network, no key, no DB, no provider. Run: node scripts/verify-kitchen-dispatch-accounts.mjs

import { createRequire } from 'node:module'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import assert from 'node:assert/strict'

const MAALE_URL = 'https://express.maalehamishlohim.co.il/api/v1/express/integrations/orders'
const maale = { calls: [] }
let foreignFetch = 0
globalThis.fetch = async (url, init = {}) => {
  if (String(url) !== MAALE_URL) { foreignFetch++; throw new Error('LIVE NETWORK CALL ATTEMPTED') }
  const body = JSON.parse(String(init.body))
  maale.calls.push(body.dry_run === true ? 'quote' : 'send')
  return body.dry_run === true
    ? jsonRes({ ok: true, would_create: { zone: 'mishor', delivery_fee_agorot: 2000, courier_pays_merchant_agorot: 5300, courier_collects_from_customer_agorot: 7300 }, warnings: [] }, 200)
    : jsonRes({ order: { id: 'MX-88', status: 'searching' } }, 201)
}
const jsonRes = (body, status) => ({ ok: status >= 200 && status < 300, status, json: async () => body, headers: { get: () => null } })

const require = createRequire(import.meta.url)
const ts = require('typescript')
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/* ─── FAKE supabaseServer (counts tables touched) ─── */
class ServerConfigError extends Error { constructor(m) { super(m); this.name = 'ServerConfigError' } }
const db = { users: [], order: null, dispatches: [], touched: [], rpcCalls: [], selects: [] }
function from(table) {
  db.touched.push(table)
  const q = { filters: [], patch: null, upsert: null, wantRows: false }
  const match = r => q.filters.every(([op, c, v]) => op === 'eq' || op === 'is' ? r[c] === v : op === 'gte' ? String(r[c] ?? '') >= v : true)
  const run = async () => {
    if (table === 'kitchen_users') return { data: db.users.filter(match), error: null }
    if (table === 'orders') return { data: db.order && match(db.order) ? [db.order] : [], error: null }
    if (table === 'branches') return { data: [], error: null }
    if (table === 'delivery_dispatches') {
      if (q.upsert) { if (!db.dispatches.some(r => r.order_id === q.upsert.order_id)) db.dispatches.push({ attempts: 0, last_attempt_at: null, error_code: null, provider_order_id: null, provider_status: null, ...q.upsert }); return { data: null, error: null } }
      const hits = db.dispatches.filter(match)
      if (q.patch) { for (const r of hits) Object.assign(r, q.patch); return { data: q.wantRows ? hits.map(r => ({ order_id: r.order_id })) : null, error: null } }
      return { data: hits.map(r => ({ ...r })), error: null }
    }
    return { data: [], error: null }
  }
  const b = {
    select(c) { q.wantRows = true; if (table === 'orders') db.selects.push(c); return b }, eq(c, v) { q.filters.push(['eq', c, v]); return b },
    is(c, v) { q.filters.push(['is', c, v]); return b }, gte(c, v) { q.filters.push(['gte', c, v]); return b }, lt() { return b },
    limit() { return b }, in() { return b }, order() { return b }, update(p) { q.patch = p; q.wantRows = false; return b }, upsert(o) { q.upsert = o; return b },
    async maybeSingle() { const r = await run(); return { data: (r.data ?? [])[0] ?? null, error: r.error } },
    then(ok, ko) { return run().then(ok, ko) },
  }
  return b
}
const fakeSupabaseServer = { ServerConfigError, getServerSupabase() { return { from, async rpc(fn, args) { db.touched.push('rpc'); db.rpcCalls.push(args); return { data: 'ok', error: null } } } } }

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
const K = lib('kitchenAuth'), KD = lib('kitchenDispatch'), D = lib('maaleDispatch'), client = lib('maaleClient'), cfg = lib('orderConfig'), R = lib('kitchenOrders')
const dispatchRoute = loadFile(join(ROOT, 'app/api/kitchen/orders/[id]/dispatch/route.ts'))
const sessionRoute = loadFile(join(ROOT, 'app/api/kitchen/session/route.ts'))
const ordersRoute = loadFile(join(ROOT, 'app/api/kitchen/orders/route.ts'))
const { NextRequest } = require('next/server')

let passed = 0
const test = async (name, fn) => { await fn(); passed++; console.log('  ✓', name) }

const MISHOR = cfg.DELIVERY_BRANCH_IDS[0]
const OTHER = K.KITCHEN_BRANCH_IDS.find(b => b !== MISHOR)
const ORDER_ID = '11111111-2222-4333-8444-555555555555'
const KEY = 'test-maale-key-not-real'
const ENV_KEYS = ['MAALE_KITCHEN_DISPATCH_ENABLED', 'MAALE_KITCHEN_DISPATCH_USERS', 'MAALE_EXPRESS_ENABLED', 'MAALE_EXPRESS_API_KEY']
const setEnv = (o = {}) => { for (const k of ENV_KEYS) delete process.env[k]; for (const [k, v] of Object.entries(o)) process.env[k] = v }
setEnv()

console.log('A) Allowlist parsing and exact matching')

await test('A1. unset / blank → valid and EMPTY (nobody); well-formed lists parse (trimmed, de-duplicated)', () => {
  for (const raw of [undefined, '', '   ']) assert.deepEqual([...KD.parseDispatchAllowlist(raw).users], [], String(raw))
  assert.deepEqual([...KD.parseDispatchAllowlist('mishor').users], ['mishor'])
  assert.deepEqual([...KD.parseDispatchAllowlist(' mishor , boss ,mishor').users].sort(), ['boss', 'mishor'])
  assert.deepEqual([...KD.parseDispatchAllowlist('a_b-1,zz').users].sort(), ['a_b-1', 'zz'])
})

await test('A2. malformed values reject the WHOLE list (fail closed): wildcard, empty item, case, spaces, separators, length, count', () => {
  const bad = ['*', 'mishor,*', 'mishor,,boss', ',mishor', 'mishor,', 'Mishor', 'MISHOR', 'mish or', 'mishor;boss', 'mishor boss', 'm',
    'a'.repeat(33), 'mishor\nboss', 'mishor|boss', '"mishor"', 'mishor%', 'mishor*', '.*', Array.from({ length: 51 }, (_, i) => `u${i}x`).join(',')]
  for (const raw of bad) assert.deepEqual(KD.parseDispatchAllowlist(raw), { ok: false }, JSON.stringify(raw))
})

await test('A3. authorization = flag exactly "true" AND exact listed account; the flag alone authorizes nobody', () => {
  const allow = (env, u) => KD.isKitchenDispatchAllowedFor(env, u)
  assert.equal(allow({ MAALE_KITCHEN_DISPATCH_ENABLED: 'true' }, 'mishor'), false, 'flag alone')
  assert.equal(allow({ MAALE_KITCHEN_DISPATCH_ENABLED: 'true', MAALE_KITCHEN_DISPATCH_USERS: '' }, 'mishor'), false, 'empty list')
  assert.equal(allow({ MAALE_KITCHEN_DISPATCH_ENABLED: 'true', MAALE_KITCHEN_DISPATCH_USERS: 'mishor,*' }, 'mishor'), false, 'malformed list')
  for (const f of [undefined, 'false', 'TRUE', '1', ' true']) assert.equal(allow({ MAALE_KITCHEN_DISPATCH_ENABLED: f, MAALE_KITCHEN_DISPATCH_USERS: 'mishor' }, 'mishor'), false, String(f))
  const env = { MAALE_KITCHEN_DISPATCH_ENABLED: 'true', MAALE_KITCHEN_DISPATCH_USERS: 'mishor,boss' }
  assert.equal(allow(env, 'mishor'), true); assert.equal(allow(env, 'boss'), true)
  for (const u of ['mish', 'mishor2', 'xmishor', 'Mishor', 'mishor ', 'other', '', null, undefined, 42, 'mishor,boss'])
    assert.equal(allow(env, u), false, `no substring / prefix / case / type match: ${JSON.stringify(u)}`)
})

console.log('B) Real routes: unauthorized requests do no order / dispatch / limiter / provider work')

const SECRET = randomBytes(48).toString('base64url')
process.env.KITCHEN_SESSION_SECRET = SECRET
const HASH = K.hashPassword(randomBytes(12).toString('base64url'))
db.users = [
  { username: 'mishor', password_hash: HASH, role: 'branch', branch_id: MISHOR, label: 'mishor', is_active: true },
  { username: 'other', password_hash: HASH, role: 'branch', branch_id: OTHER, label: 'other', is_active: true },
  { username: 'boss', password_hash: HASH, role: 'admin', branch_id: null, label: 'boss', is_active: true },
]
const ORIGIN = 'https://app.example'
const cookieFor = name => { const u = db.users.find(x => x.username === name); return `kitchen_session=${K.signSession({ username: u.username, role: u.role, branchId: u.branch_id, label: u.label }, SECRET)}` }
const resetDb = () => {
  db.order = { id: ORDER_ID, type: 'delivery', branch_id: MISHOR, payment_method: 'cash', customer_name: 'לקוח בדיקה', phone: '0501234567', total_price: '73.00', status: 'confirmed',
    created_at: '2026-10-22T09:00:00Z', daily_number: 1, branches: { name: 'מישור' },
    deliveries: [{ city: 'מעלה אדומים', street: 'הגעש', house_number: '6', apartment: '6', floor: '2', entrance: 'ב׳', notes: null, delivery_fee: '20.00', meal_surcharge: '4.00',
      delivery_lat: 31.773612, delivery_lng: 35.298346, geo_source: 'geocoder', geo_precision: 'street', address: 'מעלה אדומים, הגעש 6' }],
    order_items: [{ id: 'i1', quantity: 1, unit_price: 40, notes: null, menu_items: { name_he: 'פלאפל בפיתה' } }, { id: 'i2', quantity: 1, unit_price: 9, notes: null, menu_items: { name_he: 'קוקה קולה' } }],
    parcel_requests: [], delivery_dispatches: [] }
  db.dispatches = []; db.touched = []; db.rpcCalls = []; db.selects = []; maale.calls = []
}
const post = async ({ user = 'mishor', cookie, id = ORDER_ID, body = { expectedFeeAgorot: 2000 } } = {}) => {
  const headers = { origin: ORIGIN, 'content-type': 'application/json' }
  const c = cookie !== undefined ? cookie : cookieFor(user)
  if (c) headers.cookie = c
  const res = await dispatchRoute.POST(new NextRequest(`${ORIGIN}/api/kitchen/orders/${id}/dispatch`, { method: 'POST', headers, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) })
  return { status: res.status, body: await res.json() }
}
const get = async (route, path, user) => {
  const res = await route.GET(new NextRequest(`${ORIGIN}${path}`, { headers: { cookie: cookieFor(user) } }))
  return { status: res.status, body: await res.json() }
}
const onlyAuth = label => assert.deepEqual([...new Set(db.touched)], ['kitchen_users'], `${label}: only the session lookup (${db.touched.join(',')})`)
const noWork = label => { assert.deepEqual([db.rpcCalls.length, maale.calls.length, db.dispatches.length], [0, 0, 0], label); assert.ok(!db.touched.includes('orders') && !db.touched.includes('delivery_dispatches'), label) }
const LIVE = { MAALE_KITCHEN_DISPATCH_ENABLED: 'true', MAALE_EXPRESS_ENABLED: 'true', MAALE_EXPRESS_API_KEY: KEY }

await test('B1. main flag off (even with an allowlist) → 404 before ANY DB access', async () => {
  resetDb(); setEnv({ MAALE_KITCHEN_DISPATCH_USERS: 'mishor', MAALE_EXPRESS_ENABLED: 'true', MAALE_EXPRESS_API_KEY: KEY })
  assert.deepEqual(await post(), { status: 404, body: { error: 'not_found' } }); assert.equal(db.touched.length, 0); noWork('flag off')
})

await test('B2. flag on + EMPTY / MALFORMED allowlist → same 404 as "off"; only the session lookup ran; no order / limiter / provider', async () => {
  for (const users of [undefined, '', 'mishor,*', 'Mishor', 'mishor,,boss']) {
    resetDb(); setEnv(users === undefined ? LIVE : { ...LIVE, MAALE_KITCHEN_DISPATCH_USERS: users })
    assert.deepEqual(await post(), { status: 404, body: { error: 'not_found' } }, String(users)); onlyAuth(String(users)); noWork(String(users))
  }
})

await test('B3. authenticated but NOT allowlisted account → identical 404 for existing and non-existent orders (no probing)', async () => {
  resetDb(); setEnv({ ...LIVE, MAALE_KITCHEN_DISPATCH_USERS: 'boss' })
  const a = await post({ user: 'mishor' })
  const b = await post({ user: 'mishor', id: '99999999-2222-4333-8444-555555555555' })
  const c = await post({ user: 'other', body: { anything: 'goes' } }) // body never even parsed
  for (const r of [a, b, c]) assert.deepEqual(r, { status: 404, body: { error: 'not_found' } })
  onlyAuth('unauthorized'); noWork('unauthorized')
})

await test('B4. invalid / missing session → 401 before any order work (allowlisted name in a forged cookie does not help)', async () => {
  resetDb(); setEnv({ ...LIVE, MAALE_KITCHEN_DISPATCH_USERS: 'mishor' })
  const forged = `kitchen_session=${K.signSession({ username: 'mishor', role: 'branch', branchId: MISHOR, label: 'mishor' }, randomBytes(48).toString('base64url'))}`
  for (const cookie of ['', forged, 'kitchen_session=garbage']) assert.equal((await post({ cookie })).status, 401)
  noWork('invalid session')
})

await test('B5. allowlisted account, other branch → 404; no limiter, no provider, no dispatch row', async () => {
  resetDb(); setEnv({ ...LIVE, MAALE_KITCHEN_DISPATCH_USERS: 'mishor,other' })
  assert.deepEqual(await post({ user: 'other' }), { status: 404, body: { error: 'not_found' } })
  assert.deepEqual([db.rpcCalls.length, maale.calls.length, db.dispatches.length], [0, 0, 0])
})

await test('B6. allowlisted account (direct POST, no UI) → limiter records the SESSION account, then one quote and one send', async () => {
  resetDb(); setEnv({ ...LIVE, MAALE_KITCHEN_DISPATCH_USERS: 'other,mishor' })
  const r = await post({ user: 'mishor' })
  assert.equal(r.status, 200, JSON.stringify(r)); assert.equal(r.body.result, 'dispatched')
  assert.deepEqual(db.rpcCalls, [{ p_order_id: ORDER_ID, p_branch_id: MISHOR, p_actor: 'mishor' }])
  assert.deepEqual(maale.calls, ['quote', 'send'])
  for (const s of ['other', 'MAALE_KITCHEN_DISPATCH_USERS']) assert.ok(!JSON.stringify(r).includes(s), `response leaks ${s}`)
})

await test('B7. session endpoint: derived boolean per account only; allowlist never returned', async () => {
  setEnv({ ...LIVE, MAALE_KITCHEN_DISPATCH_USERS: 'mishor,boss' })
  const me = await get(sessionRoute, '/api/kitchen/session', 'mishor'), them = await get(sessionRoute, '/api/kitchen/session', 'other'), admin = await get(sessionRoute, '/api/kitchen/session', 'boss')
  assert.deepEqual([me.body.maaleKitchenDispatchEnabled, them.body.maaleKitchenDispatchEnabled, admin.body.maaleKitchenDispatchEnabled], [true, false, true])
  for (const r of [me, them, admin]) assert.deepEqual(Object.keys(r.body).sort(), ['branches', 'expiresAt', 'maaleKitchenDispatchEnabled', 'user'])
  assert.ok(!JSON.stringify(them.body).includes('boss') && !JSON.stringify(them.body).includes('mishor'), 'no other account names')
  assert.ok(!/MAALE_|DISPATCH_USERS/.test(JSON.stringify([me.body, them.body, admin.body])))
  for (const users of [undefined, 'mishor,*']) {
    setEnv(users === undefined ? LIVE : { ...LIVE, MAALE_KITCHEN_DISPATCH_USERS: users })
    assert.equal((await get(sessionRoute, '/api/kitchen/session', 'mishor')).body.maaleKitchenDispatchEnabled, false, String(users))
  }
  setEnv({ MAALE_KITCHEN_DISPATCH_USERS: 'mishor' })
  assert.equal((await get(sessionRoute, '/api/kitchen/session', 'mishor')).body.maaleKitchenDispatchEnabled, false, 'flag off')
})

await test('B8. orders read: dispatch embed only for an authorized account; unauthorized → the unchanged pre-03M select, no dispatch key', async () => {
  setEnv({ ...LIVE, MAALE_KITCHEN_DISPATCH_USERS: 'mishor' })
  resetDb(); const ok = await get(ordersRoute, '/api/kitchen/orders', 'mishor')
  assert.equal(db.selects.at(-1), R.kitchenOrderSelect(true)); assert.ok('dispatch' in ok.body.orders[0])
  resetDb(); db.order.branch_id = OTHER; const no = await get(ordersRoute, '/api/kitchen/orders', 'other')
  assert.equal(db.selects.at(-1), R.KITCHEN_ORDER_SELECT); assert.ok(!('dispatch' in no.body.orders[0]))
  assert.ok(!db.touched.includes('delivery_dispatches'))
})

console.log('C) Mandatory limiter in the dispatch service')

const snap = name => ({
  order: { id: ORDER_ID, type: 'delivery', branch_id: MISHOR, payment_method: 'cash', customer_name: name, phone: '0501234567', total_price: 73 },
  delivery: { city: 'מעלה אדומים', street: 'הגעש', house_number: '6', apartment: '6', floor: '2', entrance: 'ב׳', notes: null, delivery_fee: 20, meal_surcharge: 4,
    delivery_lat: 31.773612, delivery_lng: 35.298346, geo_source: 'geocoder', geo_precision: 'street' },
  items: [{ name: 'פלאפל בפיתה', quantity: 1, unit_price: 40 }, { name: 'קוקה קולה', quantity: 1, unit_price: 9 }],
})
function svc({ name = 'לקוח', gate } = {}) {
  const st = { row: null, sends: 0, quotes: 0, writes: 0 }
  const repo = {
    async loadOrder() { return { snapshot: snap(name), status: 'confirmed', parcelStatus: null } },
    async getDispatch() { return st.row ? { ...st.row } : null }, async hasRecentAuthFailure() { return false },
    async insertPending(id) { st.writes++; st.row = { order_id: id, external_order_id: id, status: 'pending', attempts: 0, last_attempt_at: null, error_code: null } },
    async claim(id, seen, now) { st.writes++; if (st.row.status !== seen.status) return false; Object.assign(st.row, { status: 'sending', attempts: 1, last_attempt_at: now }); return true },
    async markSent() { st.writes++; st.row.status = 'sent'; return true }, async markFailed() { st.writes++; return true },
  }
  const config = { status: 'ready', apiKey: KEY }
  const deps = { config, repo, isPaymentVerified: async () => false, now: () => '2026-10-22T10:00:00.000Z', log: () => {},
    quote: async () => { st.quotes++; return { ok: true, kind: 'quote', status: 200, deliveryFeeAgorot: 2000, courierPaysMerchantAgorot: 5300, courierCollectsFromCustomerAgorot: 7300, warnings: [] } },
    send: p => { st.sends++; return client.sendMaaleOrder(p, { config, fetchImpl: async () => jsonRes({ order: { id: 'MX-1', status: 'searching' } }, 201), timeoutMs: 40 }) },
    ...(gate ? { consumeQuoteSlot: gate } : {}) }
  return { st, run: opts => D.dispatchOrderToMaale(ORDER_ID, deps, opts) }
}

await test('C1. ordinary call WITHOUT consumeQuoteSlot → blocked rate_limit_unavailable before any quote / send / write', async () => {
  const s = svc()
  assert.deepEqual(await s.run(), { ok: false, outcome: 'blocked', reason: 'rate_limit_unavailable' })
  assert.deepEqual([s.st.quotes, s.st.sends, s.st.writes], [0, 0, 0])
  assert.deepEqual(KD.mapDispatchResult(await svc().run()), { status: 503, body: { error: 'rate_limit_unavailable' } })
})

await test('C2. with the limiter → proceeds (one quote, one send)', async () => {
  const s = svc({ gate: async () => 'ok' })
  assert.equal((await s.run()).outcome, 'sent'); assert.deepEqual([s.st.quotes, s.st.sends], [1, 1])
})

await test('C3. only the explicit testMode of the owner runner is exempt — and only for the named, marker-carrying order', async () => {
  const ok = svc({ name: '🧪 בדיקה — לא לשלוח' })
  assert.equal((await ok.run({ testMode: { orderId: ORDER_ID } })).outcome, 'sent')
  const wrongId = svc({ name: '🧪 בדיקה' })
  assert.equal((await wrongId.run({ testMode: { orderId: '99999999-2222-4333-8444-555555555555' } })).reason, 'test_order_id_mismatch')
  const unmarked = svc({ name: 'לקוח אמיתי' })
  assert.equal((await unmarked.run({ testMode: { orderId: ORDER_ID } })).reason, 'test_order_marker_missing')
  for (const s of [wrongId, unmarked]) assert.deepEqual([s.st.quotes, s.st.sends, s.st.writes], [0, 0, 0])
  const r = src('scripts/maale-controlled-test.mjs').replace(/^\s*\/\/.*$/gm, '')
  assert.ok(r.includes("flags.includes('--confirm-test')") && r.includes('UUID.test(orderId)') && r.includes('testMode: { orderId } }'))
  assert.equal((r.match(/dispatchOrderToMaale\(/g) || []).length, 1)
})

console.log('D) Single kitchen entry point, no automatic triggers, no allowlist in the browser')

const walk = dir => readdirSync(dir).flatMap(n => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p] })
await test('D1. app/ + lib/: dispatchOrderToMaale is called only by the protected kitchen route (ordinary mode, limiter injected)', () => {
  const callers = [...walk(join(ROOT, 'app')), ...walk(join(ROOT, 'lib'))].filter(p => /\.(tsx?|jsx?)$/.test(p))
    .filter(p => /dispatchOrderToMaale\(/.test(readFileSync(p, 'utf8').replace(/^\s*(\/\/|\*).*$/gm, '')))
    .map(p => p.slice(ROOT.length + 1).replace(/\\/g, '/'))
  assert.deepEqual(callers.sort(), ['app/api/kitchen/orders/[id]/dispatch/route.ts', 'lib/maaleDispatch.ts'])
  const route = src('app/api/kitchen/orders/[id]/dispatch/route.ts')
  assert.ok(!/testMode/.test(route)); assert.ok(route.includes('consumeQuoteSlot: (id, branchId) => consumeQuoteSlotRpc('))
  const at = t => route.indexOf(t)
  assert.ok(at('isKitchenDispatchEnabled(process.env)') < at('await getKitchenSession(req)') && at('await getKitchenSession(req)') < at('isKitchenDispatchAllowedFor(process.env, auth.session.username)')
    && at('isKitchenDispatchAllowedFor(process.env, auth.session.username)') < at('await req.json()'), 'flag → session → allowlist → body')
})

await test('D2. dispatch UI only in the Kitchen Orders app; checkout / order / status / parcel / push never trigger dispatch', () => {
  const ui = walk(join(ROOT, 'app')).filter(p => /\.(tsx|jsx)$/.test(p) && /\/dispatch`|kitchenDispatchUi|DispatchPanel/.test(readFileSync(p, 'utf8')))
    .map(p => p.slice(ROOT.length + 1).replace(/\\/g, '/'))
  assert.deepEqual(ui, ['app/dashboard/orders/page.tsx'])
  for (const f of ['app/api/orders/route.ts', 'app/api/orders/[id]/status/route.ts', 'app/api/kitchen/orders/[id]/status/route.ts', 'app/api/kitchen/parcels/[orderId]/route.ts',
    'app/api/push/send/route.ts', 'app/order/page.tsx', 'app/dashboard/page.tsx'])
    assert.ok(!/maaleDispatch|kitchenDispatch|consume_maale_quote_slot|\/dispatch`/.test(src(f)), f)
})

await test('D3. MAALE_KITCHEN_DISPATCH_USERS is read only server-side in lib/kitchenDispatch; never in client code', () => {
  const readers = [...walk(join(ROOT, 'app')), ...walk(join(ROOT, 'lib'))].filter(p => /\.(tsx?|jsx?)$/.test(p) && /MAALE_KITCHEN_DISPATCH_USERS/.test(readFileSync(p, 'utf8').replace(/^\s*(\/\/|\*).*$/gm, '')))
    .map(p => p.slice(ROOT.length + 1).replace(/\\/g, '/'))
  assert.deepEqual(readers, ['lib/kitchenDispatch.ts'])
  for (const f of ['app/dashboard/orders/page.tsx', 'lib/kitchenDispatchUi.ts', 'lib/kitchenTypes.ts']) assert.ok(!/DISPATCH_USERS|process\.env/.test(src(f).replace(/^\s*(\/\/|\*).*$/gm, '')), f)
  assert.equal(foreignFetch, 0, 'no fetch to any other host')
})

setEnv()
console.log(`\nAll ${passed} kitchen dispatch account checks passed.`)
