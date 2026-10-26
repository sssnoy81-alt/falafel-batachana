// Local checks for the kitchen parcel workflow (GATE 03H / S2).
// Runs the REAL route handlers (status, parcels, kitchen orders, customer tracking) and the real kitchen session
// (lib/kitchenUsers + lib/kitchenAuth) against an in-memory fake of the service-role Supabase client. The fake
// mirrors the Production database behaviour that matters here: conditional updates, the parcel trigger's rules
// (SQLSTATE 22023 parcel_*), one parcel_events row per real status change, and — only when switched on — the
// Migration 03 acceptance gate (P0001 parcel_not_ready). No network, no real DB, no real secrets.
// Run: node scripts/verify-kitchen-parcels.mjs

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const src = f => readFileSync(join(ROOT, f), 'utf8')

/* ─── Fixtures ─── */
const ADUMIM = '8fed141d-0e7c-46c1-803b-88d3d811c1f8'
const MIKHMAS = '3ab15ad1-e835-492b-bae5-11b202ee2314'
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const ORDER_STATUSES = ['received', 'confirmed', 'preparing', 'ready', 'delivered', 'cancelled']
const PARCEL_STATUSES = ['awaiting_search', 'found', 'not_found', 'handed_to_courier', 'carrier_verified', 'delivery_problem', 'returned_to_store', 'cancelled']

/* ─── Independent reference of the Production trigger rules (parcel_requests_before_write, md5 9da7eec2…) ─── */
const REF_TRANSITIONS = {
  awaiting_search: ['found', 'not_found', 'cancelled'], not_found: ['found', 'cancelled'],
  found: ['awaiting_search', 'handed_to_courier', 'cancelled'],
  handed_to_courier: ['carrier_verified', 'delivery_problem', 'returned_to_store'],
  delivery_problem: ['carrier_verified', 'returned_to_store'],
  carrier_verified: [], returned_to_store: [], cancelled: [],
}
/** Returns null when the DB would accept the UPDATE, else the parcel_* rule it raises. */
function dbParcelRule(old, next, closeReason, orderStatus) {
  if (old === next) return 'parcel_no_status_change'
  if (!(REF_TRANSITIONS[old] ?? []).includes(next)) return 'parcel_invalid_transition'
  if (['found', 'not_found', 'awaiting_search'].includes(next) && orderStatus !== 'received') return 'parcel_search_requires_received_order'
  if (next === 'handed_to_courier' && !['confirmed', 'preparing', 'ready', 'delivered'].includes(orderStatus)) return 'parcel_handoff_requires_accepted_order'
  if (next === 'cancelled') {
    if (!closeReason) return 'parcel_cancel_requires_reason'
    if (closeReason === 'order_cancelled' && orderStatus !== 'cancelled') return 'parcel_order_not_cancelled'
    if (closeReason === 'food_only' && (old !== 'not_found' || orderStatus !== 'received')) return 'parcel_food_only_requires_not_found'
  } else if (closeReason) return 'parcel_close_reason_without_cancel'
  return null
}

/* ─── Fake service-role Supabase client ─── */
const db = { kitchen_users: [], orders: new Map(), parcels: new Map(), events: [], queries: [], dbGate: false, dbSync: true, dbCancelGate: false, syncRule: null, failUpdate: null, hooks: {} }
const IN_STORE = ['awaiting_search', 'not_found', 'found']
class ServerConfigError extends Error { constructor(m) { super(m); this.name = 'ServerConfigError' } }
const tick = () => new Promise(r => setImmediate(r))
function query(table) {
  const q = { table, ops: [], patch: null }
  db.queries.push(q)
  const eqs = () => Object.fromEntries(q.ops.filter(o => o[0] === 'eq').map(o => [o[1], o[2]]))
  const selectCols = () => q.ops.find(o => o[0] === 'select')?.[1] ?? ''
  async function run() {
    await tick() // let concurrent requests interleave like real I/O
    const w = eqs()
    if (table === 'kitchen_users') return { data: db.kitchen_users.filter(u => u.username === w.username), error: null }
    if (table === 'orders' && !q.patch) {
      const o = db.orders.get(w.id)
      if (!o) return { data: [], error: null }
      const row = { id: o.id, status: o.status, branch_id: o.branch_id, type: o.type, daily_number: o.daily_number }
      if (/parcel_requests\(/.test(selectCols())) {
        const p = db.parcels.get(o.id)
        row.parcel_requests = p ? [{ status: p.status, tracking_ref: p.tracking_ref, carrier: p.carrier }] : []
      }
      if (db.hooks.afterOrderLoad) { const h = db.hooks.afterOrderLoad; db.hooks.afterOrderLoad = null; h(o.id) }
      return { data: [row], error: null }
    }
    if (table === 'orders' && q.patch) {
      if (db.failUpdate) return { data: null, error: db.failUpdate }
      const o = db.orders.get(w.id)
      if (!o || o.status !== w.status) return { data: [], error: null }
      const p = db.parcels.get(o.id)
      // Migration 03 gate emulation (only when switched on): every exit from received except cancellation
      if (db.dbGate && o.status === 'received' && q.patch.status !== 'cancelled' && p && !['found', 'cancelled'].includes(p.status))
        return { data: null, error: { code: 'P0001', message: 'parcel_not_ready' } }
      // Migration 04 cancel-gate emulation (installed and verified in Production; switched on per test — the default
      // stays off so the S2 / S2b tests keep exercising the application logic alone): a received order may be cancelled
      // only while its parcel is not_found (or already cancelled / absent), decided at update time.
      if (db.dbCancelGate && o.status === 'received' && q.patch.status === 'cancelled' && p && !['not_found', 'cancelled'].includes(p.status))
        return { data: null, error: { code: '22023', message: 'parcel_cancel_requires_not_found' } }
      // Migration 03 cancel-sync emulation (installed in Production → on by default): same statement, same
      // transaction. A parcel still in the store becomes cancelled / order_cancelled / system actor (validated by the
      // parcel trigger rules, one event); any other parcel is untouched. A rule rejection rolls back the whole update.
      if (db.dbSync && q.patch.status === 'cancelled' && o.status !== 'cancelled' && p && IN_STORE.includes(p.status)) {
        const rule = db.syncRule ?? dbParcelRule(p.status, 'cancelled', 'order_cancelled', 'cancelled')
        if (rule) return { data: null, error: { code: '22023', message: rule } }
        const from = p.status
        Object.assign(p, { status: 'cancelled', close_reason: 'order_cancelled', last_actor: 'system:order_cancelled' })
        db.events.push({ parcel_order: o.id, from_status: from, to_status: 'cancelled', actor: 'system:order_cancelled' })
      }
      o.status = q.patch.status
      return { data: [{ id: o.id }], error: null }
    }
    if (table === 'parcel_requests' && q.patch) {
      if (db.failUpdate) return { data: null, error: db.failUpdate }
      const p = db.parcels.get(w.order_id)
      if (!p || p.status !== w.status) return { data: [], error: null } // conditional update: no row, no event
      const rule = dbParcelRule(p.status, q.patch.status, q.patch.close_reason ?? null, db.orders.get(w.order_id).status)
      if (rule) return { data: null, error: { code: '22023', message: rule } }
      const from = p.status
      Object.assign(p, q.patch)
      db.events.push({ parcel_order: w.order_id, from_status: from, to_status: p.status, actor: p.last_actor })
      return { data: [{ status: p.status }], error: null }
    }
    return { data: [], error: null }
  }
  const b = {
    select(cols) { q.ops.push(['select', cols]); return b },
    eq(col, val) { q.ops.push(['eq', col, val]); return b },
    in(col, val) { q.ops.push(['in', col, val]); return b },
    gte() { return b }, lt() { return b }, order() { return b },
    update(patch) { q.patch = patch; return b },
    async maybeSingle() { const r = await run(); return r.error ? r : { data: (r.data ?? [])[0] ?? null, error: null } },
    then(ok, ko) { return run().then(ok, ko) },
  }
  return b
}
const fakeSupabaseServer = { ServerConfigError, getServerSupabase() { return { from: query } } }

/* ─── Loader (same as verify-kitchen-db-auth): TS → CJS, supabaseServer is the fake ─── */
const cache = new Map()
function loadFile(file) {
  if (cache.has(file)) return cache.get(file).exports
  const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  })
  const mod = { exports: {} }
  cache.set(file, mod)
  const req = p => {
    const name = p.startsWith('@/lib/') ? p.slice(6) : p.startsWith('./') && file.includes(`${join(ROOT, 'lib')}`) ? p.slice(2) : null
    if (name === 'supabaseServer') return fakeSupabaseServer
    if (name) return loadFile(join(ROOT, 'lib', name + '.ts'))
    return require(p)
  }
  new Function('exports', 'require', 'module', outputText)(mod.exports, req, mod)
  return mod.exports
}
const lib = n => loadFile(join(ROOT, 'lib', n + '.ts'))
const route = p => loadFile(join(ROOT, 'app', 'api', ...p.split('/'), 'route.ts'))

const K = lib('kitchenAuth')
const P = lib('parcelRequest')
const M = lib('kitchenMutations')
const R = lib('kitchenOrders')
const statusRoute = route('kitchen/orders/[id]/status')
const parcelRoute = route('kitchen/parcels/[orderId]')
const publicStatusRoute = route('orders/[id]/status')
const { NextRequest } = require('next/server')

let passed = 0
const test = async (name, fn) => { await fn(); passed++; console.log('  ✓', name) }

const SECRET = randomBytes(48).toString('base64url')
process.env.KITCHEN_SESSION_SECRET = SECRET
const HASH = K.hashPassword(randomBytes(12).toString('base64url'))
const userRow = (username, role, branch_id) => ({ username, password_hash: HASH, role, branch_id, label: username, is_active: true })
const SESS = {
  adumim: { username: 'adumim', role: 'branch', branchId: ADUMIM, label: 'adumim' },
  mikhmas: { username: 'mikhmas', role: 'branch', branchId: MIKHMAS, label: 'mikhmas' },
  admin: { username: 'boss', role: 'admin', branchId: null, label: 'boss' },
}
const token = s => K.signSession(s, SECRET)
const ORIGIN = 'https://app.example'

function reset({ orders = [], parcels = [] } = {}) {
  db.kitchen_users = [userRow('adumim', 'branch', ADUMIM), userRow('mikhmas', 'branch', MIKHMAS), userRow('boss', 'admin', null)]
  db.orders = new Map(orders.map(o => [o.id, { type: 'delivery', branch_id: ADUMIM, daily_number: 1, ...o }]))
  db.parcels = new Map(parcels.map(p => [p.order_id, { tracking_ref: 'RR123456789IL', carrier: 'דואר ישראל', last_actor: 'customer_checkout', ...p }]))
  db.events = []; db.queries = []; db.dbGate = false; db.dbSync = true; db.dbCancelGate = false; db.syncRule = null; db.failUpdate = null; db.hooks = {}
}
const patchReq = (path, body, { session = SESS.adumim, origin = ORIGIN, contentType = 'application/json' } = {}) =>
  new NextRequest(`${ORIGIN}${path}`, {
    method: 'PATCH',
    headers: { ...(origin ? { origin } : {}), 'content-type': contentType, ...(session ? { cookie: `kitchen_session=${token(session)}` } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
async function setStatus(orderId, status, opts) {
  const res = await statusRoute.PATCH(patchReq(`/api/kitchen/orders/${orderId}/status`, { status }, opts), { params: Promise.resolve({ id: orderId }) })
  return { status: res.status, body: await res.json() }
}
async function parcelAction(orderId, action, opts, rawBody) {
  const res = await parcelRoute.PATCH(patchReq(`/api/kitchen/parcels/${orderId}`, rawBody ?? { action }, opts), { params: Promise.resolve({ orderId }) })
  return { status: res.status, body: await res.json() }
}
const parcelUpdates = () => db.queries.filter(q => q.table === 'parcel_requests' && q.patch)
const orderUpdates = () => db.queries.filter(q => q.table === 'orders' && q.patch)

/* ═══ 1. Pure rules ═══ */
console.log('Parcel rules (pure, mirrors the Production trigger)')

await test('transition table equals the Production trigger rules', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(P.PARCEL_TRANSITIONS).map(([k, v]) => [k, [...v]])), REF_TRANSITIONS)
  assert.deepEqual([...P.PARCEL_STATUSES].sort(), [...PARCEL_STATUSES].sort())
})

await test('checkParcelAction == DB rule for every action × parcel status × order status (incl. junk)', () => {
  const target = { found: 'found', not_found: 'not_found', reset: 'awaiting_search', food_only: 'cancelled',
    handed_to_courier: 'handed_to_courier', carrier_verified: 'carrier_verified', delivery_problem: 'delivery_problem', returned_to_store: 'returned_to_store' }
  let n = 0
  for (const action of P.PARCEL_ACTIONS) for (const ps of [...PARCEL_STATUSES, 'invalid', '', null]) for (const os of [...ORDER_STATUSES, 'weird']) {
    const app = P.checkParcelAction(action, ps, os)
    const dbOk = P.isParcelStatus(ps) && dbParcelRule(ps, target[action], action === 'food_only' ? 'food_only' : null, os) === null
    assert.equal(app.ok, dbOk, `${action} ${ps} ${os}`)
    if (app.ok) assert.deepEqual(app, { ok: true, from: ps, to: target[action], closeReason: action === 'food_only' ? 'food_only' : null })
    n++
  }
  assert.equal(n, 8 * 11 * 7)
})

await test('isParcelReadyForAcceptance: null / found / cancelled only — everything else fails closed', () => {
  for (const s of [null, 'found', 'cancelled']) assert.equal(P.isParcelReadyForAcceptance(s), true, String(s))
  for (const s of ['awaiting_search', 'not_found', 'handed_to_courier', 'carrier_verified', 'delivery_problem', 'returned_to_store',
    'invalid', 'FOUND', '', undefined, 0, {}, []]) assert.equal(P.isParcelReadyForAcceptance(s), false, JSON.stringify(s))
})

await test('parcelStatusFromEmbed: none → null; one row → status; malformed / duplicate → invalid', () => {
  assert.equal(P.parcelStatusFromEmbed(null), null); assert.equal(P.parcelStatusFromEmbed(undefined), null); assert.equal(P.parcelStatusFromEmbed([]), null)
  assert.equal(P.parcelStatusFromEmbed([{ status: 'found' }]), 'found'); assert.equal(P.parcelStatusFromEmbed({ status: 'not_found' }), 'not_found')
  for (const bad of [[{ status: 'nope' }], [{}], ['x'], [{ status: 'found' }, { status: 'found' }], { status: 7 }])
    assert.equal(P.parcelStatusFromEmbed(bad), 'invalid', JSON.stringify(bad))
})

await test('S2b: full order cancellation flag is ON (Migration 03 installed); sync scope == exactly the in-store states', () => {
  assert.equal(P.PARCEL_ORDER_CANCEL_ENABLED, true)
  assert.deepEqual([...P.PARCEL_STATUSES_REQUIRING_CANCEL_SYNC], ['awaiting_search', 'found', 'not_found']) // = parcel_03 cancel-sync scope
  for (const s of [null, ...PARCEL_STATUSES, 'invalid']) assert.equal(P.isOrderCancellationAllowedForParcel(s), true, String(s))
  for (const s of PARCEL_STATUSES) assert.equal(P.isParcelSyncedOnCancel(s), IN_STORE.includes(s), s)
  assert.equal(P.isParcelSyncedOnCancel(null), false)
  assert.match(src('db/migrations/parcel_03_orders_gate.sql'), /AND pr\.status IN \('awaiting_search', 'not_found', 'found'\)/)
})

/* ═══ 2. Food-only orders unchanged (real status route) ═══ */
console.log('Food-only orders — behaviour unchanged')

await test('every food-only transition behaves exactly as before (allowed / invalid / conflict)', async () => {
  for (const from of ORDER_STATUSES) for (const to of ORDER_STATUSES.filter(s => s !== 'received')) {
    reset({ orders: [{ id: id(1), status: from, type: 'pickup' }] })
    const r = await setStatus(id(1), to)
    const expected = from === to ? [409, 'conflict'] : M.ALLOWED_TRANSITIONS[from].includes(to) ? [200, null] : [409, 'invalid_transition']
    assert.equal(r.status, expected[0], `${from}→${to}`)
    if (expected[1]) assert.equal(r.body.error, expected[1], `${from}→${to}`)
    else assert.equal(db.orders.get(id(1)).status, to)
  }
  // ALLOWED_TRANSITIONS itself is untouched: received → confirmed only
  assert.deepEqual([...M.ALLOWED_TRANSITIONS.received], ['confirmed'])
})

await test('food-only delivery order (no parcel row) is confirmed without any parcel interaction', async () => {
  reset({ orders: [{ id: id(2), status: 'received', type: 'delivery' }] })
  const r = await setStatus(id(2), 'confirmed')
  assert.deepEqual([r.status, r.body.status], [200, 'confirmed'])
  assert.equal(parcelUpdates().length, 0)
})

await test('food-only: received → cancelled is still an invalid kitchen transition (unchanged)', async () => {
  reset({ orders: [{ id: id(3), status: 'received' }] })
  assert.deepEqual(await setStatus(id(3), 'cancelled'), { status: 409, body: { error: 'invalid_transition' } })
})

/* ═══ 3. Server-side acceptance gate ═══ */
console.log('Server-side acceptance gate (status route)')

await test('parcel awaiting_search / not_found / malformed → 409 parcel_not_ready, order untouched, no UPDATE sent', async () => {
  for (const ps of ['awaiting_search', 'not_found', 'handed_to_courier', 'weird']) {
    reset({ orders: [{ id: id(4), status: 'received' }], parcels: [{ order_id: id(4), status: ps }] })
    assert.deepEqual(await setStatus(id(4), 'confirmed'), { status: 409, body: { error: 'parcel_not_ready' } }, ps)
    assert.equal(db.orders.get(id(4)).status, 'received'); assert.equal(orderUpdates().length, 0)
  }
})

await test('parcel found → confirm allowed; parcel cancelled (food only) → confirm allowed', async () => {
  for (const ps of ['found', 'cancelled']) {
    reset({ orders: [{ id: id(5), status: 'received' }], parcels: [{ order_id: id(5), status: ps }] })
    const r = await setStatus(id(5), 'confirmed')
    assert.deepEqual([r.status, r.body.status], [200, 'confirmed'], ps)
  }
})

await test('every non-cancellation exit from received is gated (also direct jumps like received → ready)', async () => {
  for (const to of ['confirmed', 'preparing', 'ready', 'delivered']) {
    reset({ orders: [{ id: id(6), status: 'received' }], parcels: [{ order_id: id(6), status: 'awaiting_search' }] })
    assert.equal((await setStatus(id(6), to)).body.error, 'parcel_not_ready', to)
  }
})

await test('later transitions are not gated by the parcel (confirmed → preparing → ready → delivered, parcel in any state)', async () => {
  for (const ps of ['found', 'handed_to_courier', 'delivery_problem']) {
    reset({ orders: [{ id: id(7), status: 'confirmed' }], parcels: [{ order_id: id(7), status: ps }] })
    for (const to of ['preparing', 'ready', 'delivered']) assert.equal((await setStatus(id(7), to)).status, 200, `${ps} → ${to}`)
  }
})

await test('branch isolation comes first: another branch\'s parcel order → 404 (not parcel_not_ready)', async () => {
  reset({ orders: [{ id: id(8), status: 'received', branch_id: MIKHMAS }], parcels: [{ order_id: id(8), status: 'awaiting_search' }] })
  assert.deepEqual(await setStatus(id(8), 'confirmed'), { status: 404, body: { error: 'not_found' } })
  // admin is in scope but still gated
  assert.deepEqual(await setStatus(id(8), 'confirmed', { session: SESS.admin }), { status: 409, body: { error: 'parcel_not_ready' } })
})

await test('database gate refusal (P0001 parcel_not_ready, Migration 03) → HTTP 409 parcel_not_ready', async () => {
  // snapshot says "found", but the parcel is reset right after the load → only the DB gate can catch it
  reset({ orders: [{ id: id(9), status: 'received' }], parcels: [{ order_id: id(9), status: 'found' }] })
  db.dbGate = true
  db.hooks.afterOrderLoad = oid => { db.parcels.get(oid).status = 'awaiting_search' }
  assert.deepEqual(await setStatus(id(9), 'confirmed'), { status: 409, body: { error: 'parcel_not_ready' } })
  assert.equal(db.orders.get(id(9)).status, 'received')
})

await test('KNOWN residual race until Migration 03: parcel reset between load and update is not caught by the app alone', async () => {
  reset({ orders: [{ id: id(10), status: 'received' }], parcels: [{ order_id: id(10), status: 'found' }] })
  db.hooks.afterOrderLoad = oid => { db.parcels.get(oid).status = 'awaiting_search' }
  const r = await setStatus(id(10), 'confirmed')
  assert.equal(r.status, 200) // documented: closed only by the parcel_03 database gate (previous test)
})

await test('other DB errors on the order update stay generic 500 (no detail leak)', async () => {
  reset({ orders: [{ id: id(11), status: 'received' }], parcels: [{ order_id: id(11), status: 'found' }] })
  db.failUpdate = { code: 'XX000', message: 'internal detail' }
  const r = await setStatus(id(11), 'confirmed')
  assert.deepEqual(r, { status: 500, body: { error: 'server_error' } })
})

/* ═══ 4. Cancellation workflow ═══ */
console.log('Cancellation workflow (S2b): food only / full cancellation via the Migration 03 sync')

const expectSynced = (oid, from) => {
  assert.deepEqual({ ...db.parcels.get(oid), tracking_ref: undefined, carrier: undefined, order_id: undefined },
    { status: 'cancelled', close_reason: 'order_cancelled', last_actor: 'system:order_cancelled', tracking_ref: undefined, carrier: undefined, order_id: undefined })
  assert.deepEqual(db.events, [{ parcel_order: oid, from_status: from, to_status: 'cancelled', actor: 'system:order_cancelled' }])
  assert.equal(parcelUpdates().length, 0)   // the application never writes the parcel — only the DB trigger does
  assert.equal(orderUpdates().length, 1)
}

await test('received + not_found → full cancellation 200; parcel cancelled atomically by the DB sync (order_cancelled, system actor, one event)', async () => {
  reset({ orders: [{ id: id(12), status: 'received' }], parcels: [{ order_id: id(12), status: 'not_found' }] })
  assert.deepEqual(await setStatus(id(12), 'cancelled'), { status: 200, body: { id: id(12), status: 'cancelled' } })
  assert.equal(db.orders.get(id(12)).status, 'cancelled')
  expectSynced(id(12), 'not_found')
})

await test('received + awaiting_search / found → still 409 invalid_transition (agreed workflow: cancel from received only when not found)', async () => {
  for (const ps of ['awaiting_search', 'found']) {
    reset({ orders: [{ id: id(30), status: 'received' }], parcels: [{ order_id: id(30), status: ps }] })
    assert.deepEqual(await setStatus(id(30), 'cancelled'), { status: 409, body: { error: 'invalid_transition' } }, ps)
    assert.deepEqual([db.orders.get(id(30)).status, db.parcels.get(id(30)).status], ['received', ps])
    assert.equal(orderUpdates().length + db.events.length, 0)
  }
})

await test('confirmed / preparing × every in-store parcel state → 200; parcel synced to cancelled in the same statement', async () => {
  for (const os of ['confirmed', 'preparing']) for (const ps of IN_STORE) {
    reset({ orders: [{ id: id(33), status: os }], parcels: [{ order_id: id(33), status: ps }] })
    assert.equal((await setStatus(id(33), 'cancelled')).status, 200, `${os}/${ps}`)
    assert.equal(db.orders.get(id(33)).status, 'cancelled')
    expectSynced(id(33), ps)
  }
})

await test('ready / delivered orders still cannot be cancelled by the kitchen (transition table unchanged), parcel untouched', async () => {
  for (const os of ['ready', 'delivered']) for (const ps of ['found', 'handed_to_courier']) {
    reset({ orders: [{ id: id(34), status: os }], parcels: [{ order_id: id(34), status: ps }] })
    assert.deepEqual(await setStatus(id(34), 'cancelled'), { status: 409, body: { error: 'invalid_transition' } }, `${os}/${ps}`)
    assert.deepEqual([db.orders.get(id(34)).status, db.parcels.get(id(34)).status], [os, ps])
  }
})

await test('DB parcel rule rejecting the sync (22023 parcel_*) → 409 invalid_state; order unchanged; no tracking number in logs', async () => {
  reset({ orders: [{ id: id(35), status: 'confirmed' }], parcels: [{ order_id: id(35), status: 'found' }] })
  db.syncRule = 'parcel_order_not_cancelled'
  const logged = []; const orig = console.error; console.error = (...a) => logged.push(a.join(' '))
  try { assert.deepEqual(await setStatus(id(35), 'cancelled'), { status: 409, body: { error: 'invalid_state' } }) } finally { console.error = orig }
  assert.deepEqual([db.orders.get(id(35)).status, db.parcels.get(id(35)).status], ['confirmed', 'found'])
  assert.equal(db.events.length, 0)
  assert.ok(!logged.join('\n').includes('RR123456789IL'))
  // a non-parcel 22023 / other code stays a generic 500 without details
  reset({ orders: [{ id: id(35), status: 'confirmed' }], parcels: [{ order_id: id(35), status: 'found' }] })
  db.failUpdate = { code: '22023', message: 'something else' }
  assert.deepEqual(await setStatus(id(35), 'cancelled'), { status: 500, body: { error: 'server_error' } })
})

await test('race: parcel handed to the courier between load and cancel → order cancelled, parcel NOT touched (no event)', async () => {
  reset({ orders: [{ id: id(36), status: 'confirmed' }], parcels: [{ order_id: id(36), status: 'found' }] })
  db.hooks.afterOrderLoad = oid => { Object.assign(db.parcels.get(oid), { status: 'handed_to_courier' }) }
  assert.equal((await setStatus(id(36), 'cancelled')).status, 200)
  assert.deepEqual([db.orders.get(id(36)).status, db.parcels.get(id(36)).status], ['cancelled', 'handed_to_courier'])
  assert.equal(db.events.length, 0)
})

await test('race: concurrent cancel and handoff on the same order → never "cancelled order + active in-store parcel"', async () => {
  for (let i = 0; i < 6; i++) {
    reset({ orders: [{ id: id(37), status: 'confirmed' }], parcels: [{ order_id: id(37), status: 'found' }] })
    const [c, h] = await Promise.all([setStatus(id(37), 'cancelled'), parcelAction(id(37), 'handed_to_courier')])
    const o = db.orders.get(id(37)).status, p = db.parcels.get(id(37)).status
    assert.ok(!(o === 'cancelled' && IN_STORE.includes(p)), `${o}/${p}`)
    assert.ok([200].includes(c.status) && [200, 409].includes(h.status), `${c.status}/${h.status}`)
    if (h.status === 409) assert.deepEqual([o, p], ['cancelled', 'cancelled'])           // cancel won → handoff refused
    else assert.deepEqual([o, p], ['cancelled', 'handed_to_courier'])                   // handoff won → parcel untouched
  }
})

await test('race: concurrent cancel and "found" on received + not_found → consistent, at most one cancellation event', async () => {
  for (let i = 0; i < 6; i++) {
    reset({ orders: [{ id: id(38), status: 'received' }], parcels: [{ order_id: id(38), status: 'not_found' }] })
    await Promise.all([setStatus(id(38), 'cancelled'), parcelAction(id(38), 'found')])
    const o = db.orders.get(id(38)).status, p = db.parcels.get(id(38)).status
    assert.ok(!(o === 'cancelled' && IN_STORE.includes(p)), `${o}/${p}`)
    assert.ok(db.events.filter(e => e.to_status === 'cancelled').length <= 1)
  }
})

await test('M04: race "not_found → found" between load and cancel → DB gate rejects → HTTP 409 invalid_state; order + parcel unchanged', async () => {
  reset({ orders: [{ id: id(41), status: 'received' }], parcels: [{ order_id: id(41), status: 'not_found' }] })
  db.dbCancelGate = true
  db.hooks.afterOrderLoad = oid => { db.parcels.get(oid).status = 'found' }   // tablet B marks found after A's load
  assert.deepEqual(await setStatus(id(41), 'cancelled'), { status: 409, body: { error: 'invalid_state' } })
  assert.deepEqual([db.orders.get(id(41)).status, db.parcels.get(id(41)).status, db.events.length], ['received', 'found', 0])
})
await test('M04: without the database gate (app logic alone, as before Migration 04) the same race cancels the found parcel', async () => {
  reset({ orders: [{ id: id(42), status: 'received' }], parcels: [{ order_id: id(42), status: 'not_found' }] })
  db.hooks.afterOrderLoad = oid => { db.parcels.get(oid).status = 'found' }
  assert.equal((await setStatus(id(42), 'cancelled')).status, 200)
  assert.deepEqual([db.orders.get(id(42)).status, db.parcels.get(id(42)).close_reason], ['cancelled', 'order_cancelled'])
})
await test('M04 gate on: received + not_found cancel still 200 (synced); confirmed / preparing / food-only cancellations unchanged', async () => {
  reset({ orders: [{ id: id(43), status: 'received' }], parcels: [{ order_id: id(43), status: 'not_found' }] }); db.dbCancelGate = true
  assert.equal((await setStatus(id(43), 'cancelled')).status, 200); assert.equal(db.parcels.get(id(43)).close_reason, 'order_cancelled')
  for (const os of ['confirmed', 'preparing']) {
    reset({ orders: [{ id: id(44), status: os }], parcels: [{ order_id: id(44), status: 'found' }] }); db.dbCancelGate = true
    assert.equal((await setStatus(id(44), 'cancelled')).status, 200, os)
    reset({ orders: [{ id: id(45), status: os }] }); db.dbCancelGate = true
    assert.equal((await setStatus(id(45), 'cancelled')).status, 200, `food-only ${os}`)
  }
})
await test('two tablets cancel the same parcel order at once → one 200, one 409 conflict, exactly one sync event', async () => {
  reset({ orders: [{ id: id(39), status: 'preparing' }], parcels: [{ order_id: id(39), status: 'found' }] })
  const both = await Promise.all([setStatus(id(39), 'cancelled'), setStatus(id(39), 'cancelled')])
  assert.deepEqual(both.map(r => r.status).sort(), [200, 409])
  assert.equal(db.events.length, 1)
})

await test('cancel path keeps auth: CSRF 400, no session 401, other branch 404 (nothing changes), admin allowed', async () => {
  const fresh = () => reset({ orders: [{ id: id(40), status: 'confirmed' }], parcels: [{ order_id: id(40), status: 'found' }] })
  fresh(); assert.equal((await setStatus(id(40), 'cancelled', { origin: 'https://evil.example' })).status, 400)
  fresh(); assert.equal((await setStatus(id(40), 'cancelled', { session: null })).status, 401)
  fresh(); assert.deepEqual(await setStatus(id(40), 'cancelled', { session: SESS.mikhmas }), { status: 404, body: { error: 'not_found' } })
  assert.deepEqual([db.orders.get(id(40)).status, db.parcels.get(id(40)).status, db.events.length], ['confirmed', 'found', 0])
  fresh(); assert.equal((await setStatus(id(40), 'cancelled', { session: SESS.admin })).status, 200)
  assert.equal(db.parcels.get(id(40)).status, 'cancelled')
})

await test('cancellation stays as before when the parcel is out of the store or closed, and for food-only orders', async () => {
  for (const ps of ['handed_to_courier', 'delivery_problem', 'cancelled', 'carrier_verified', 'returned_to_store']) {
    reset({ orders: [{ id: id(31), status: 'confirmed' }], parcels: [{ order_id: id(31), status: ps }] })
    assert.equal((await setStatus(id(31), 'cancelled')).status, 200, ps)
    assert.equal(db.parcels.get(id(31)).status, ps) // parcel row never touched by an order cancellation
  }
  for (const os of ['confirmed', 'preparing']) {
    reset({ orders: [{ id: id(32), status: os }] })
    assert.equal((await setStatus(id(32), 'cancelled')).status, 200, `food-only ${os}`)
  }
})

await test('food only: not_found → cancelled (close_reason food_only, actor = kitchen account), then the order can be confirmed', async () => {
  reset({ orders: [{ id: id(13), status: 'received' }], parcels: [{ order_id: id(13), status: 'not_found' }] })
  const r = await parcelAction(id(13), 'food_only')
  assert.deepEqual(r, { status: 200, body: { orderId: id(13), parcelStatus: 'cancelled' } })
  assert.deepEqual(parcelUpdates()[0].patch, { status: 'cancelled', last_actor: 'adumim', close_reason: 'food_only' })
  assert.deepEqual(db.events, [{ parcel_order: id(13), from_status: 'not_found', to_status: 'cancelled', actor: 'adumim' }])
  assert.equal((await setStatus(id(13), 'confirmed')).status, 200)
})

await test('food only is refused unless the parcel is not_found and the order still received', async () => {
  for (const [ps, os] of [['awaiting_search', 'received'], ['found', 'received'], ['not_found', 'confirmed']]) {
    reset({ orders: [{ id: id(14), status: os }], parcels: [{ order_id: id(14), status: ps }] })
    const r = await parcelAction(id(14), 'food_only')
    assert.equal(r.status, 409, `${ps}/${os}`); assert.equal(parcelUpdates().length, 0)
  }
})

/* ═══ 5. Parcel API: protection and transitions ═══ */
console.log('Parcel API (real route)')

await test('CSRF / session / input validation: 400, 401, 400, 400', async () => {
  reset({ orders: [{ id: id(15), status: 'received' }], parcels: [{ order_id: id(15), status: 'awaiting_search' }] })
  assert.equal((await parcelAction(id(15), 'found', { origin: null })).status, 400)                       // no Origin
  assert.equal((await parcelAction(id(15), 'found', { origin: 'https://evil.example' })).status, 400)     // cross-origin
  assert.equal((await parcelAction(id(15), 'found', { contentType: 'text/plain' })).status, 400)          // not JSON
  assert.equal((await parcelAction(id(15), 'found', { session: null })).status, 401)                       // no session
  assert.equal((await parcelAction('not-a-uuid', 'found')).status, 400)
  for (const body of [{ action: 'explode' }, { action: 'found', extra: 1 }, { status: 'found' }, [], 'x'])
    assert.equal((await parcelAction(id(15), null, undefined, body)).status, 400, JSON.stringify(body))
  assert.equal(parcelUpdates().length, 0); assert.equal(db.parcels.get(id(15)).status, 'awaiting_search')
})

await test('branch scope: other branch → 404; admin → allowed; order without parcel → 404', async () => {
  reset({ orders: [{ id: id(16), status: 'received', branch_id: MIKHMAS }, { id: id(17), status: 'received' }],
    parcels: [{ order_id: id(16), status: 'awaiting_search' }] })
  assert.deepEqual(await parcelAction(id(16), 'found'), { status: 404, body: { error: 'not_found' } })
  assert.equal((await parcelAction(id(16), 'found', { session: SESS.admin })).status, 200)
  assert.equal(db.events.at(-1).actor, 'boss')
  assert.deepEqual(await parcelAction(id(17), 'found'), { status: 404, body: { error: 'not_found' } })
  assert.deepEqual(await parcelAction(id(99), 'found'), { status: 404, body: { error: 'not_found' } })
})

await test('full lifecycle: found → (accept) → handed_to_courier → delivery_problem → carrier_verified', async () => {
  reset({ orders: [{ id: id(18), status: 'received' }], parcels: [{ order_id: id(18), status: 'awaiting_search' }] })
  assert.equal((await parcelAction(id(18), 'found')).body.parcelStatus, 'found')
  assert.equal((await parcelAction(id(18), 'handed_to_courier')).status, 409) // food order not accepted yet
  assert.equal((await setStatus(id(18), 'confirmed')).status, 200)
  assert.equal((await parcelAction(id(18), 'reset')).status, 409)              // search actions locked after acceptance
  assert.equal((await parcelAction(id(18), 'handed_to_courier')).body.parcelStatus, 'handed_to_courier')
  assert.equal((await parcelAction(id(18), 'delivery_problem')).body.parcelStatus, 'delivery_problem')
  assert.equal((await parcelAction(id(18), 'carrier_verified')).body.parcelStatus, 'carrier_verified')
  assert.equal((await parcelAction(id(18), 'returned_to_store')).status, 409)  // terminal
  assert.deepEqual(db.events.map(e => e.to_status), ['found', 'handed_to_courier', 'delivery_problem', 'carrier_verified'])
})

await test('reset corrects a mistaken "found" while the order is still received', async () => {
  reset({ orders: [{ id: id(19), status: 'received' }], parcels: [{ order_id: id(19), status: 'found' }] })
  assert.equal((await parcelAction(id(19), 'reset')).body.parcelStatus, 'awaiting_search')
  assert.equal((await setStatus(id(19), 'confirmed')).body.error, 'parcel_not_ready')
})

await test('food "delivered" never changes the parcel (no automatic handoff)', async () => {
  reset({ orders: [{ id: id(20), status: 'ready' }], parcels: [{ order_id: id(20), status: 'found' }] })
  assert.equal((await setStatus(id(20), 'delivered')).status, 200)
  assert.equal(db.parcels.get(id(20)).status, 'found'); assert.equal(parcelUpdates().length, 0)
})

await test('database trigger rejection (22023 parcel_*) → 409 invalid_state; other DB errors → 500 without details', async () => {
  reset({ orders: [{ id: id(21), status: 'received' }], parcels: [{ order_id: id(21), status: 'awaiting_search' }] })
  db.failUpdate = { code: '22023', message: 'parcel_search_requires_received_order' }
  assert.deepEqual(await parcelAction(id(21), 'found'), { status: 409, body: { error: 'invalid_state' } })
  db.failUpdate = { code: 'XX000', message: 'internal detail' }
  assert.deepEqual(await parcelAction(id(21), 'found'), { status: 500, body: { error: 'server_error' } })
})

/* ═══ 6. Concurrency + retries ═══ */
console.log('Concurrency and retries')

await test('two simultaneous parcel updates (found vs not_found) → exactly one wins, the other 409 conflict, one event', async () => {
  reset({ orders: [{ id: id(22), status: 'received' }], parcels: [{ order_id: id(22), status: 'awaiting_search' }] })
  const [a, b] = await Promise.all([parcelAction(id(22), 'found'), parcelAction(id(22), 'not_found')])
  assert.deepEqual([a.status, b.status].sort(), [200, 409])
  assert.equal([a, b].find(x => x.status === 409).body.error, 'conflict')
  assert.equal(db.events.length, 1)
  assert.equal(db.parcels.get(id(22)).status, [a, b].find(x => x.status === 200).body.parcelStatus)
})

await test('retries never duplicate events (same action twice, sequential and concurrent)', async () => {
  reset({ orders: [{ id: id(23), status: 'received' }], parcels: [{ order_id: id(23), status: 'awaiting_search' }] })
  assert.equal((await parcelAction(id(23), 'found')).status, 200)
  assert.equal((await parcelAction(id(23), 'found')).status, 409)
  assert.equal(db.events.length, 1)
  reset({ orders: [{ id: id(24), status: 'received' }], parcels: [{ order_id: id(24), status: 'awaiting_search' }] })
  const both = await Promise.all([parcelAction(id(24), 'found'), parcelAction(id(24), 'found')])
  assert.deepEqual(both.map(x => x.status).sort(), [200, 409]); assert.equal(db.events.length, 1)
})

await test('order confirmation racing a parcel change: both requests interleave; state stays consistent', async () => {
  // parcel found; tablet A confirms the order while tablet B marks the parcel not_found
  reset({ orders: [{ id: id(25), status: 'received' }], parcels: [{ order_id: id(25), status: 'found' }] })
  const [conf, nf] = await Promise.all([setStatus(id(25), 'confirmed'), parcelAction(id(25), 'not_found')])
  const order = db.orders.get(id(25)).status, parcel = db.parcels.get(id(25)).status
  // Acceptable outcomes: (confirmed, found) with B refused, or (received, not_found) with A refused,
  // or — without the Migration 03 gate — the documented residual (confirmed, not_found).
  const outcome = `${order}/${parcel}`
  assert.ok(['confirmed/found', 'received/not_found', 'confirmed/not_found'].includes(outcome), outcome)
  console.log(`      interleaving result without DB gate: order=${order}, parcel=${parcel} (A=${conf.status}, B=${nf.status})`)
  // With the gate on, a confirmed order never ends up with an un-found parcel through this path
  reset({ orders: [{ id: id(26), status: 'received' }], parcels: [{ order_id: id(26), status: 'found' }] })
  db.dbGate = true
  db.hooks.afterOrderLoad = oid => { db.parcels.get(oid).status = 'not_found' }
  const r = await setStatus(id(26), 'confirmed')
  assert.equal(r.body.error, 'parcel_not_ready'); assert.equal(db.orders.get(id(26)).status, 'received')
})

/* ═══ 7. Read model + no public leakage ═══ */
console.log('Kitchen read model / public responses')

await test('kitchen orders API returns the parcel (status, tracking, carrier) to the authorized kitchen only', async () => {
  const row = { id: id(27), daily_number: 3, type: 'delivery', status: 'received', created_at: '2026-10-16T08:00:00Z', customer_name: 'x', phone: '0501111111',
    payment_method: 'cash', total_price: 50, branch_id: ADUMIM, branches: { name: 'מישור אדומים' }, order_items: [], deliveries: [{ address: 'a' }],
    parcel_requests: [{ status: 'awaiting_search', tracking_ref: 'RR123456789IL', carrier: 'דואר ישראל', id: 'secret-id', last_actor: 'x' }] }
  const o = R.normalizeKitchenOrder(row)
  assert.deepEqual(o.parcel, { status: 'awaiting_search', trackingRef: 'RR123456789IL', carrier: 'דואר ישראל', recipientName: null }) // no recipient → null (historical rows)
  assert.deepEqual(Object.keys(o.parcel).sort(), ['carrier', 'recipientName', 'status', 'trackingRef'])
  assert.equal(R.normalizeKitchenOrder({ ...row, type: 'pickup' }).parcel, null)            // pickup never shows a parcel
  assert.equal(R.normalizeKitchenOrder({ ...row, parcel_requests: [] }).parcel, null)
  assert.equal(R.normalizeKitchenOrder({ ...row, parcel_requests: [{}] }).parcel.status, 'invalid') // malformed stays visible
  assert.match(R.KITCHEN_ORDER_SELECT, /parcel_requests\(status, tracking_ref, carrier, recipient_name\)/)
  assert.ok(!/close_reason|last_actor|tracking_key/.test(R.KITCHEN_ORDER_SELECT))
})

await test('customer tracking API never selects or returns parcel / tracking data', async () => {
  const s = src('app/api/orders/[id]/status/route.ts')
  assert.ok(!/parcel|tracking|carrier/i.test(s.replace(/\/\/.*$/gm, '')))
  reset({ orders: [{ id: id(28), status: 'received' }], parcels: [{ order_id: id(28), status: 'found' }] })
  const res = await publicStatusRoute.GET(new NextRequest(`${ORIGIN}/api/orders/${id(28)}/status`), { params: Promise.resolve({ id: id(28) }) })
  const body = JSON.stringify(await res.json())
  for (const leak of ['RR123456789IL', 'tracking', 'parcel', 'דואר ישראל']) assert.ok(!body.includes(leak), leak)
})

await test('parcel route response and errors never contain tracking numbers', async () => {
  reset({ orders: [{ id: id(29), status: 'received' }], parcels: [{ order_id: id(29), status: 'awaiting_search' }] })
  const ok = await parcelAction(id(29), 'found'), bad = await parcelAction(id(29), 'food_only')
  for (const r of [ok, bad]) assert.ok(!JSON.stringify(r.body).includes('RR123456789IL'))
})

/* ═══ 8. Static guarantees ═══ */
console.log('Static guarantees')

await test('no courier dispatch, no signing links, no orders.status writes from the parcel path', () => {
  for (const f of ['lib/parcelRequest.ts', 'lib/kitchenParcels.ts', 'app/api/kitchen/parcels/[orderId]/route.ts']) {
    const s = src(f).replace(/\/\/.*$/gm, '')
    assert.ok(!/maale|dispatch|delivery_dispatches|sms|sign(ing)?_?(url|link)/i.test(s), f)
    assert.ok(!/from\('orders'\)\.update|\.from\('orders'\)[\s\S]{0,40}\.update\(/.test(s), `${f}: never updates orders`)
  }
  assert.ok(/from\('parcel_requests'\)\.update\(patch\)\s*\.eq\('order_id', id\)\.eq\('status', from\)/.test(src('app/api/kitchen/parcels/[orderId]/route.ts')),
    'conditional parcel update (order_id AND current status)')
})

await test('status route maps the DB gate and the cancel-sync rule; UI offers full cancellation only behind the flag, with a confirm', () => {
  const s = src('app/api/kitchen/orders/[id]/status/route.ts')
  assert.match(s, /select\('id, status, branch_id, (payment_method, )?parcel_requests\(status\)'\)/)
  assert.match(s, /error\.code === 'P0001' && error\.message === 'parcel_not_ready'/)
  assert.match(s, /error\.code === '22023' && \/\^parcel_\[a-z_\]\+\$\/\.test\(error\.message\)\) throw new ParcelStateRejectedError\(\)/)
  assert.ok(!/from\('parcel_requests'\)/.test(s), 'status route never writes parcels itself (DB trigger only)')
  const ui = src('app/dashboard/orders/page.tsx')
  assert.match(ui, /\{PARCEL_ORDER_CANCEL_ENABLED && onCancelOrder && \(/)
  assert.match(ui, /confirm\('ביטול הזמנה מלא: ההזמנה והחבילה יבוטלו יחד\. להמשיך\?'\)/)
  assert.match(ui, /onCancelOrder=\{\(\) => onAdvance\(order\.id, 'cancelled'\)\}/)
  assert.match(ui, /confirm\(withCourierNotice\(cancelConfirmText\(order, num\)\)\)/) // S4-03O: one dialog incl. courier notice (no-op when no dispatch)
  assert.match(ui, /החבילה כבר יצאה מהחנות ולא תבוטל אוטומטית/)
  assert.match(ui, /if \(nextStatus === 'cancelled'\) fetchOrders\(\)/)
  assert.match(ui, /disabled title="יש לאתר את החבילה לפני אישור ההזמנה"/)
})

/* ─── Carrier delivery verification confirm (S4-PARCEL-26A) — runs the real ParcelPanel run() handler ─── */
console.log('Carrier verification confirmation (kitchen UI)')
const DASH = src('app/dashboard/orders/page.tsx').replace(/\r\n/g, '\n')
const CARRIER_MSG = 'האם התקבל אישור מפורש ממעלה אקספרס שהחבילה נמסרה בפועל ללקוח? פעולה זו סופית ולא ניתן לבטל אותה דרך המערכת.'
function parcelRun({ busy = false, answer = true } = {}) {
  const start = DASH.indexOf('  const run = (e: React.MouseEvent, action: ParcelAction) => {')
  const fnSrc = DASH.slice(start, DASH.indexOf('\n  }\n', start) + 4)
  const constLine = DASH.split('\n').find(l => l.startsWith('const CARRIER_VERIFIED_CONFIRM = '))
  const js = ts.transpileModule(`${constLine}\n${fnSrc}`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText
  const calls = { confirm: [], onAction: [] }
  const fn = new Function('order', 'busy', 'onAction', 'confirm', `${js}\nreturn run`)(
    { id: 'order-1' }, busy, (...a) => calls.onAction.push(a), m => { calls.confirm.push(m); return answer })
  return { run: action => fn({ stopPropagation() {} }, action), calls }
}
await test('carrier_verified: explicit confirm with the approved text; CANCEL → no request; CONFIRM → exactly one request', () => {
  const c = parcelRun({ answer: false }); c.run('carrier_verified')
  assert.deepEqual(c.calls.confirm, [CARRIER_MSG]); assert.equal(c.calls.onAction.length, 0)   // no API call, no state change
  const ok = parcelRun({ answer: true }); ok.run('carrier_verified')
  assert.deepEqual(ok.calls.confirm, [CARRIER_MSG]); assert.deepEqual(ok.calls.onAction, [['order-1', 'carrier_verified']])
})
await test('no duplicate submission: while busy neither the confirm nor a request; the handler also guards (one parcel request at a time)', () => {
  const b = parcelRun({ busy: true }); b.run('carrier_verified')
  assert.equal(b.calls.confirm.length, 0); assert.equal(b.calls.onAction.length, 0)
  assert.match(DASH, /const handleParcelAction = async \(orderId: string, action: ParcelAction\) => \{\n\s*if \(parcelBusyId\) return/)
  assert.match(DASH, /<button key=\{a\} type="button" disabled=\{busy\} onClick=\{e => run\(e, a\)\}/)
})
await test('other parcel actions unchanged: no new confirm; food_only / returned_to_store keep their existing confirms', () => {
  for (const a of ['found', 'not_found', 'reset', 'handed_to_courier', 'delivery_problem']) {
    const r = parcelRun({ answer: false }); r.run(a)
    assert.equal(r.calls.confirm.length, 0, a); assert.deepEqual(r.calls.onAction, [['order-1', a]], a)
  }
  const f = parcelRun({ answer: false }); f.run('food_only')
  assert.deepEqual(f.calls.confirm, ['אוכל בלבד: החבילה תבוטל וההזמנה תמשיך כהזמנת אוכל רגילה. להמשיך?']); assert.equal(f.calls.onAction.length, 0)
  const r = parcelRun({ answer: false }); r.run('returned_to_store')
  assert.deepEqual(r.calls.confirm, ['לסמן שהחבילה הוחזרה לחנות?']); assert.equal(r.calls.onAction.length, 0)
})
await test('every kitchen entry point is covered: run() is the only onAction caller; expanded view has no parcel actions; one PATCH path', () => {
  assert.equal((DASH.match(/onAction\(order\.id, /g) || []).length, 1, 'single call site, inside run()')
  assert.match(DASH, /\{order\.parcel && <ParcelPanel order=\{order\} large \/>\}/)                  // KitchenModal: no onAction → no buttons
  assert.equal((DASH.match(/<ParcelPanel [^>]*onAction=/g) || []).length, 1, 'only the order card wires actions')
  assert.equal((DASH.match(/\/api\/kitchen\/parcels\//g) || []).length, 1, 'the only parcel request is in handleParcelAction')
})
await test('handoff is not delivery: carrier_verified only after the handoff; transitions unchanged', () => {
  assert.deepEqual([...P.PARCEL_TRANSITIONS.handed_to_courier], ['carrier_verified', 'delivery_problem', 'returned_to_store'])
  assert.deepEqual([...P.PARCEL_TRANSITIONS.found], ['awaiting_search', 'handed_to_courier', 'cancelled'])   // never found → carrier_verified
  assert.deepEqual([...P.PARCEL_TRANSITIONS.carrier_verified], [])                                          // terminal
})

/* ─── Parcel recipient name in the kitchen (S4-PARCEL-30B) ─── */
console.log('Parcel recipient name (kitchen)')
const recipientRow = (recipient_name) => ({ id: id(61), daily_number: 4, type: 'delivery', status: 'received', created_at: '2026-10-18T08:00:00Z',
  customer_name: 'שלמה נוימן', phone: '0501111111', payment_method: 'cash', total_price: 50, branch_id: ADUMIM, order_items: [], deliveries: [{ address: 'a' }],
  parcel_requests: [{ status: 'awaiting_search', tracking_ref: 'RR123456789IL', carrier: null, ...(recipient_name === undefined ? {} : { recipient_name }) }] })
await test('P/N/Q: read model maps recipient_name; historical rows (no value / column absent) → null; customerName untouched', () => {
  const explicit = R.normalizeKitchenOrder(recipientRow('נריה נוימן'))
  assert.equal(explicit.parcel.recipientName, 'נריה נוימן'); assert.equal(explicit.customerName, 'שלמה נוימן')
  assert.equal(R.normalizeKitchenOrder(recipientRow(null)).parcel.recipientName, null)
  assert.equal(R.normalizeKitchenOrder(recipientRow(undefined)).parcel.recipientName, null)
  assert.equal(R.normalizeKitchenOrder(recipientRow('')).parcel.recipientName, null)
  assert.ok(!/recipient/.test(R.KITCHEN_ORDER_SELECT.replace('recipient_name', '')), 'only parcel_requests.recipient_name is selected')
})
await test('O/P: ParcelPanel shows the effective name below the tracking number; fallback marked "(שם המזמין)"', () => {
  const panel = DASH.slice(DASH.indexOf('function ParcelPanel('), DASH.indexOf('function csvDeliveryFields('))
  const tracking = panel.indexOf('{p.trackingRef || \'—\'}'), name = panel.indexOf('📦 שם על החבילה:')
  assert.ok(tracking > 0 && name > tracking, 'name line comes right after the tracking number')
  assert.match(panel, /📦 שם על החבילה: \{p\.recipientName \?\? order\.customerName \?\? '—'\}/)
  assert.match(panel, /\{!p\.recipientName && order\.customerName && <span[^>]*> \(שם המזמין\)<\/span>\}/)
  assert.ok(!/dangerouslySetInnerHTML/.test(DASH), 'names rendered as React text (escaped)')
})
await test('same panel in the order card and the expanded view; customer name + phone row unchanged; no new action entry point (W)', () => {
  assert.equal((DASH.match(/<ParcelPanel /g) || []).length, 2)
  assert.equal((DASH.match(/<ParcelPanel [^>]*onAction=/g) || []).length, 1)
  assert.match(DASH, /\{order\.customerName && <div style=\{\{ color: '#fff', fontSize: 13, fontWeight: 700 \}\}>👤 \{order\.customerName\}<\/div>\}/)
  assert.equal((DASH.match(/onAction\(order\.id, /g) || []).length, 1)
})
await test('CSV export unchanged (no recipient); recipient never logged; parcel PATCH never writes recipient_name', () => {
  const csv = DASH.slice(DASH.indexOf('function csvDeliveryFields('), DASH.indexOf('function formatTime('))
  assert.ok(!/recipient/i.test(csv))
  assert.ok(!/'שם על החבילה'|recipientName[^\n]*csv|csv[^\n]*recipient/i.test(DASH))
  assert.ok(!/console\.[a-z]+\([^)]*recipient/i.test(DASH + src('lib/kitchenOrders.ts')))
  assert.ok(!/recipient/i.test(src('app/api/kitchen/parcels/[orderId]/route.ts')))
})

console.log(`\nAll ${passed} kitchen-parcel checks passed.`)
