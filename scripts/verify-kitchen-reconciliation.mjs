// Offline checks for S4-INTEGRATIONS-04D2 — manager-only courier reconciliation records in the Kitchen Orders app.
//  A) Shared rules (lib/kitchenReconciliationUi) mirror the 04D1 CHECK constraints; summary derived from ALL events.
//  B) REAL route POST /api/kitchen/orders/[id]/reconciliation + REAL orders / session routes with a FAKE supabaseServer
//     that records every table touched and every write; global fetch throws (no provider call is possible).
//     S4-04E2: the fake emulates public.record_maale_reconciliation_event (atomic per call like the per-order lock:
//     idempotent request_id → dispatch consistency → manual-courier gating → INSERT); there is no direct INSERT path.
//  C) Read model + dispatch hint; D) Kitchen UI source.
// No network, no key, no DB. Run: node scripts/verify-kitchen-reconciliation.mjs

import { createRequire } from 'node:module'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import assert from 'node:assert/strict'

let liveFetch = 0
globalThis.fetch = async () => { liveFetch++; throw new Error('LIVE NETWORK CALL ATTEMPTED') }

const require = createRequire(import.meta.url)
const ts = require('typescript')
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/* ─── FAKE supabaseServer ─── */
class ServerConfigError extends Error { constructor(m) { super(m); this.name = 'ServerConfigError' } }
const db = { users: [], order: null, dispatch: null, ledger: [], touched: [], writes: [], selects: [], insertError: null, ledgerReadError: null, seq: 0, clock: Date.parse('2026-10-22T12:00:00Z'),
  recordCalls: [], recordAnswer: null }
const tick = () => new Promise(r => setTimeout(r, 1)) // lets concurrent requests interleave inside the fake
function from(table) {
  db.touched.push(table)
  const q = { filters: [], insert: null, single: false, gte: null }
  const match = r => q.filters.every(([op, c, v]) => (op === 'eq' || op === 'is') ? r[c] === v : true) && (q.gte === null || String(r.created_at) >= q.gte)
  const run = async () => {
    if (table === 'kitchen_users') return { data: db.users.filter(match), error: null }
    if (table === 'orders') return { data: db.order && match(db.order) ? [db.order] : [], error: null }
    if (table === 'delivery_dispatches') return { data: db.dispatch && match({ order_id: db.order?.id, ...db.dispatch }) ? [{ ...db.dispatch }] : [], error: null }
    if (table === 'maale_dispatch_reconciliations') {
      await tick()
      if (q.insert) {
        db.writes.push({ table, op: 'insert', row: { ...q.insert } })
        if (db.insertError) return { data: null, error: db.insertError }
        // Like Postgres UNIQUE (request_id): a second row with the same key is refused with 23505.
        if (db.ledger.some(r => r.request_id === q.insert.request_id)) return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "maale_dispatch_reconciliations_request_id_key"' } }
        const row = { id: `00000000-0000-4000-8000-${String(++db.seq).padStart(12, '0')}`, created_at: new Date(db.clock).toISOString(), ...q.insert }
        db.ledger.push(row); return { data: { id: row.id, created_at: row.created_at }, error: null }
      }
      if (db.ledgerReadError) return { data: null, error: db.ledgerReadError }
      return { data: db.ledger.filter(match).sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).map(r => ({ ...r })), error: null }
    }
    return { data: [], error: null }
  }
  const write = op => () => { db.writes.push({ table, op }); return b }
  const b = {
    select(c) { if (table === 'orders') db.selects.push(c); return b }, eq(c, v) { q.filters.push(['eq', c, v]); return b }, is(c, v) { q.filters.push(['is', c, v]); return b },
    gte(c, v) { q.gte = v; return b }, lt() { return b }, in() { return b }, order() { return b }, limit() { return b },
    insert(row) { q.insert = row; return b }, update: write('update'), delete: write('delete'), upsert: write('upsert'),
    async single() { const r = await run(); return { data: r.data, error: r.error } },
    async maybeSingle() { const r = await run(); return { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error } },
    then(ok, ko) { return run().then(ok, ko) },
  }
  return b
}
/* Fake of public.record_maale_reconciliation_event — same order of checks as the SQL function (s4_04e). The body runs
   without an await after the first tick, so concurrent calls are serialized exactly like the per-order advisory lock. */
const DEFINITIVE = ['zone_unknown', 'out_of_area', 'amount_too_high', 'dispatch_closed', 'validation_error', 'provider_rejected', 'blocked', 'unauthorized']
const NEEDS_DISPATCH = ['confirmed_sent', 'cancelled_at_provider', 'not_received', 'provider_status_checked']
async function recordRpc(a) {
  db.touched.push('rpc:record'); db.recordCalls.push({ ...a })
  await tick()
  const answer = (result, ex = null) => ({ data: [{ result, event_id: ex?.id ?? null, event_created_at: ex?.created_at ?? null }], error: null })
  if (db.recordAnswer) return db.recordAnswer
  if (!db.order || db.order.id !== a.p_order_id) return answer('order_not_found')
  const row = { request_id: a.p_request_id, order_id: a.p_order_id, event_type: a.p_event_type, actor_username: a.p_actor,
    provider_order_id: a.p_provider_order_id, provider_status: a.p_provider_status, reason_code: a.p_reason_code }
  const ex = db.ledger.find(r => r.request_id === row.request_id)
  if (ex) return Object.keys(row).every(k => (ex[k] ?? null) === (row[k] ?? null)) ? answer('already_recorded', ex) : answer('request_id_conflict')
  const d = db.dispatch
  if (NEEDS_DISPATCH.includes(row.event_type) || row.provider_order_id !== null) {
    if (!d) return answer('no_dispatch_record')
    if (d.status === 'pending' && (d.attempts ?? 0) === 0) return answer('no_dispatch_attempt')
  }
  if (row.provider_order_id !== null && d?.provider_order_id && d.provider_order_id !== row.provider_order_id) return answer('provider_order_mismatch')
  if (row.event_type === 'manual_courier' && d) {
    if (d.status === 'sending' || d.status === 'sent') return answer('dispatch_active')
    if (!((d.status === 'pending' && (d.attempts ?? 0) === 0) || (d.status === 'failed_final' && DEFINITIVE.includes(d.error_code)))) return answer('dispatch_outcome_unknown')
  }
  db.writes.push({ table: 'maale_dispatch_reconciliations', op: 'insert', row: { ...row } })
  if (db.insertError) return { data: null, error: db.insertError }
  const stored = { id: `00000000-0000-4000-8000-${String(++db.seq).padStart(12, '0')}`, created_at: new Date(db.clock).toISOString(), ...row }
  db.ledger.push(stored)
  return answer('recorded', stored)
}
const rpc = async (fn, args) => {
  if (fn === 'record_maale_reconciliation_event') return recordRpc(args)
  db.touched.push('rpc'); return { data: null, error: { code: 'X' } } // quote slot etc.: unavailable in this suite
}
const fakeSupabaseServer = { ServerConfigError, getServerSupabase() { return { from, rpc } } }

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
const K = lib('kitchenAuth'), KR = lib('kitchenReconciliation'), UIR = lib('kitchenReconciliationUi'), UI = lib('kitchenDispatchUi'), R = lib('kitchenOrders'), cfg = lib('orderConfig')
const route = loadFile(join(ROOT, 'app/api/kitchen/orders/[id]/reconciliation/route.ts'))
const dispatchRoute = loadFile(join(ROOT, 'app/api/kitchen/orders/[id]/dispatch/route.ts'))
const KD = lib('kitchenDispatch'), D = lib('maaleDispatch'), client = lib('maaleClient')
const ordersRoute = loadFile(join(ROOT, 'app/api/kitchen/orders/route.ts'))
const sessionRoute = loadFile(join(ROOT, 'app/api/kitchen/session/route.ts'))
const { NextRequest } = require('next/server')

let passed = 0
const test = async (name, fn) => { await fn(); passed++; console.log('  ✓', name) }

const MISHOR = cfg.DELIVERY_BRANCH_IDS[0]
const OTHER = K.KITCHEN_BRANCH_IDS.find(b => b !== MISHOR)
const ORDER_ID = '11111111-2222-4333-8444-555555555555'
const ENV_KEYS = ['MAALE_KITCHEN_RECONCILIATION_ENABLED', 'MAALE_KITCHEN_RECONCILIATION_USERS', 'MAALE_KITCHEN_DISPATCH_ENABLED', 'MAALE_KITCHEN_DISPATCH_USERS', 'MAALE_EXPRESS_ENABLED', 'MAALE_EXPRESS_API_KEY']
const setEnv = (o = {}) => { for (const k of ENV_KEYS) delete process.env[k]; for (const [k, v] of Object.entries(o)) process.env[k] = v }
setEnv()
const ON = { MAALE_KITCHEN_RECONCILIATION_ENABLED: 'true', MAALE_KITCHEN_RECONCILIATION_USERS: 'boss' }

console.log('A) Shared rules and summary')

await test('A1. event / reason lists and id / status shapes mirror the 04D1 CHECK constraints exactly', () => {
  const mig = src('db/migrations/s4_04d_maale_dispatch_reconciliations.sql').replace(/--.*$/gm, '')
  const list = (from, to) => [...mig.slice(mig.indexOf(from), mig.indexOf(to, mig.indexOf(from))).matchAll(/'([a-z_]+)'/g)].map(m => m[1])
  assert.deepEqual([...UIR.RECONCILIATION_EVENT_TYPES], list('event_type IN (', ')),'))
  assert.deepEqual([...UIR.RECONCILIATION_REASON_CODES], list('reason_code IN (', '))'))
  assert.ok(mig.includes(`'${UIR.PROVIDER_ORDER_ID_RULE.source}'`) && mig.includes(`'${UIR.PROVIDER_STATUS_RULE.source}'`))
  assert.ok(mig.includes("event_type IN ('confirmed_sent', 'cancelled_at_provider') AND provider_order_id IS NOT NULL"))
  assert.deepEqual([...UIR.EVENTS_REQUIRING_PROVIDER_ID], ['confirmed_sent', 'cancelled_at_provider'])
  assert.deepEqual([...UIR.EVENTS_FORBIDDING_PROVIDER_ID], ['not_received', 'manual_courier'])
  for (const t of UIR.RECONCILIATION_EVENT_TYPES) assert.ok(/[א-ת]/.test(UIR.RECONCILIATION_EVENT_LABELS[t]), t)
  assert.ok(!Object.values(UIR.RECONCILIATION_EVENT_LABELS).some(l => /אוטומטי|מאומת/.test(l)), 'no label claims automatic / verified')
})

await test('A2. validateReconciliationInput: every rule, including the explicit cancellation confirmation', () => {
  const v = o => UIR.validateReconciliationInput({ providerOrderId: null, providerStatus: null, reasonCode: null, confirmCancellation: false, ...o })
  assert.deepEqual(v({ eventType: 'auto_cancelled' }), { ok: false, code: 'invalid_event_type' })
  assert.deepEqual(v({ eventType: 'confirmed_sent' }), { ok: false, code: 'provider_order_id_required' })
  assert.deepEqual(v({ eventType: 'cancelled_at_provider', providerOrderId: '284' }), { ok: false, code: 'confirmation_required' })
  assert.deepEqual(v({ eventType: 'cancelled_at_provider', providerOrderId: '284', confirmCancellation: true }), { ok: true })
  assert.deepEqual(v({ eventType: 'not_received', providerOrderId: '284' }), { ok: false, code: 'provider_order_id_forbidden' })
  assert.deepEqual(v({ eventType: 'manual_courier', providerOrderId: '284' }), { ok: false, code: 'provider_order_id_forbidden' })
  assert.deepEqual(v({ eventType: 'provider_status_checked' }), { ok: false, code: 'provider_status_required' })
  assert.deepEqual(v({ eventType: 'manual_review_opened', providerStatus: 'searching' }), { ok: false, code: 'provider_status_forbidden' })
  assert.deepEqual(v({ eventType: 'provider_status_checked', providerStatus: 'Searching' }), { ok: false, code: 'invalid_provider_status' })
  assert.deepEqual(v({ eventType: 'confirmed_sent', providerOrderId: '28 4' }), { ok: false, code: 'invalid_provider_order_id' })
  assert.deepEqual(v({ eventType: 'manual_courier', reasonCode: 'free text' }), { ok: false, code: 'invalid_reason_code' })
  assert.deepEqual(v({ eventType: 'manual_courier', reasonCode: 'courier_booked_by_phone' }), { ok: true })
})

const ev = (eventType, createdAt, id, extra = {}) => ({ id, eventType, actor: 'boss', providerOrderId: null, providerStatus: null, reasonCode: null, createdAt, ...extra })
await test('A3. summary is derived from ALL events: confirmed → cancelled → review resolved keeps the cancellation', () => {
  const t = i => `2026-10-22T10:0${i}:00.000Z`
  const events = [ev('manual_review_opened', t(0), 'a1'), ev('confirmed_sent', t(1), 'a2', { providerOrderId: '284' }),
    ev('cancelled_at_provider', t(2), 'a3', { providerOrderId: '284' }), ev('manual_review_resolved', t(3), 'a4')]
  const s = UIR.summarizeReconciliation(events)
  assert.equal(s.cancelledAtProvider, true); assert.equal(s.confirmedSent, true)
  assert.equal(s.reviewOpen, false); assert.equal(s.reviewResolved, true)
  assert.equal(UIR.summarizeReconciliation(events.slice(0, 3)).reviewOpen, true)
  assert.equal(UIR.sortEventsNewestFirst(events)[0].eventType, 'manual_review_resolved', 'the latest event alone would hide the cancellation')
})

await test('A4. identical timestamps: stable ordering by id; summary independent of order', () => {
  const T = '2026-10-22T10:00:00.000Z'
  const events = [ev('manual_review_opened', T, 'b2'), ev('manual_review_resolved', T, 'b1'), ev('cancelled_at_provider', T, 'b3', { providerOrderId: '1' }),
    ev('provider_status_checked', T, 'b4', { providerStatus: 'searching' })]
  assert.deepEqual(UIR.sortEventsNewestFirst(events).map(e => e.id), ['b4', 'b3', 'b2', 'b1'])
  const base = JSON.stringify(UIR.summarizeReconciliation(events))
  for (const perm of [[3, 2, 1, 0], [1, 3, 0, 2], [2, 0, 3, 1]]) assert.equal(JSON.stringify(UIR.summarizeReconciliation(perm.map(i => events[i]))), base)
  assert.equal(JSON.parse(base).reviewOpen, false); assert.equal(JSON.parse(base).lastCheckedProviderStatus, 'searching')
})

console.log('B) Real route + fake DB')

const SECRET = randomBytes(48).toString('base64url')
process.env.KITCHEN_SESSION_SECRET = SECRET
const HASH = K.hashPassword(randomBytes(12).toString('base64url'))
db.users = [
  { username: 'mishor', password_hash: HASH, role: 'branch', branch_id: MISHOR, label: 'mishor', is_active: true },
  { username: 'other', password_hash: HASH, role: 'branch', branch_id: OTHER, label: 'other', is_active: true },
  { username: 'boss', password_hash: HASH, role: 'admin', branch_id: null, label: 'boss', is_active: true },
]
const ORIGIN = 'https://app.example'
const cookieFor = n => { const u = db.users.find(x => x.username === n); return `kitchen_session=${K.signSession({ username: u.username, role: u.role, branchId: u.branch_id, label: u.label }, SECRET)}` }
const reset = ({ dispatch = { status: 'sent', provider_order_id: '284' }, type = 'delivery', branch = MISHOR, status = 'cancelled' } = {}) => {
  db.ledgerReadError = null
  // created_at = now: the orders read filters by the Israel day, so a fixed date would break the day after.
  db.order = { id: ORDER_ID, type, branch_id: branch, status, created_at: new Date().toISOString(), daily_number: 3, customer_name: 'לקוח בדיקה', phone: '0501234567',
    payment_method: 'cash', total_price: '73.00', branches: { name: 'מישור' }, order_items: [], parcel_requests: [],
    deliveries: [{ address: 'מעלה אדומים, הגעש 6', notes: null, meal_quantity: 1, meal_surcharge: '4', delivery_fee: '20.00' }] }
  db.dispatch = dispatch; db.ledger = []; db.touched = []; db.writes = []; db.selects = []; db.insertError = null; db.seq = 0; db.clock = Date.now() // the route computes the duplicate window from real time
  db.recordCalls = []; db.recordAnswer = null
}
const { randomUUID } = await import('node:crypto')
/** Adds a fresh requestId (a "new action") unless the body has one or noRid is set; non-object bodies are sent as is. */
const post = async (body, { user = 'boss', id = ORDER_ID, cookie, noRid = false } = {}) => {
  const headers = { origin: ORIGIN, 'content-type': 'application/json' }
  const c = cookie !== undefined ? cookie : cookieFor(user); if (c) headers.cookie = c
  const sent = body && typeof body === 'object' && !Array.isArray(body) && !noRid && !('requestId' in body) ? { requestId: randomUUID(), ...body } : body
  const res = await route.POST(new NextRequest(`${ORIGIN}/api/kitchen/orders/${id}/reconciliation`, { method: 'POST', headers, body: JSON.stringify(sent) }), { params: Promise.resolve({ id }) })
  return { status: res.status, body: await res.json() }
}
const CANCEL = { eventType: 'cancelled_at_provider', providerOrderId: '284', reasonCode: 'provider_phone_confirmed', confirmCancellation: true }
const ledgerWrites = () => db.writes.filter(w => w.table === 'maale_dispatch_reconciliations')
const otherWrites = () => db.writes.filter(w => w.table !== 'maale_dispatch_reconciliations' || w.op !== 'insert')

await test('B1. feature off → 404 before any DB access (even for an allowlisted manager)', async () => {
  reset(); setEnv({ MAALE_KITCHEN_RECONCILIATION_USERS: 'boss' })
  assert.deepEqual(await post(CANCEL), { status: 404, body: { error: 'not_found' } }); assert.equal(db.touched.length, 0)
  for (const f of [undefined, 'TRUE', '1', 'false']) {
    setEnv(f === undefined ? { MAALE_KITCHEN_RECONCILIATION_USERS: 'boss' } : { MAALE_KITCHEN_RECONCILIATION_ENABLED: f, MAALE_KITCHEN_RECONCILIATION_USERS: 'boss' })
    assert.equal((await post(CANCEL)).status, 404, String(f))
  }
})

await test('B2. not a manager → same 404; only the session lookup ran; dispatch permission never grants write access', async () => {
  for (const env of [{ MAALE_KITCHEN_RECONCILIATION_ENABLED: 'true' }, { ...ON, MAALE_KITCHEN_RECONCILIATION_USERS: 'boss,*' },
    { ...ON, MAALE_KITCHEN_RECONCILIATION_USERS: 'boss', MAALE_KITCHEN_DISPATCH_ENABLED: 'true', MAALE_KITCHEN_DISPATCH_USERS: 'mishor' }]) {
    reset(); setEnv(env)
    const user = env.MAALE_KITCHEN_DISPATCH_USERS ? 'mishor' : 'boss'
    assert.deepEqual(await post(CANCEL, { user }), { status: 404, body: { error: 'not_found' } }, JSON.stringify(env))
    assert.deepEqual([...new Set(db.touched)], ['kitchen_users']); assert.equal(db.writes.length, 0)
  }
  reset(); setEnv(ON)
  for (const cookie of ['', 'kitchen_session=garbage']) assert.equal((await post(CANCEL, { cookie })).status, 401)
  assert.equal(db.writes.length, 0)
})

await test('B3. manager outside the order branch → 404 (no oracle), nothing written', async () => {
  reset(); setEnv({ ...ON, MAALE_KITCHEN_RECONCILIATION_USERS: 'other' })
  assert.deepEqual(await post(CANCEL, { user: 'other' }), { status: 404, body: { error: 'not_found' } })
  assert.equal(db.writes.length, 0)
})

await test('B4. invalid payloads / spoofed actor, branch or order → 400 before any order read; rule violations → 400 with a reason', async () => {
  reset(); setEnv(ON)
  for (const body of [{}, null, [], 'x', { eventType: 5 }, { ...CANCEL, actor_username: 'mishor' }, { ...CANCEL, actor: 'x' }, { ...CANCEL, branchId: OTHER },
    { ...CANCEL, branch_id: OTHER }, { ...CANCEL, orderId: ORDER_ID }, { ...CANCEL, note: 'free text' }, { ...CANCEL, confirmCancellation: 'yes' }, { ...CANCEL, providerOrderId: 284 }]) {
    db.touched = []
    assert.deepEqual(await post(body), { status: 400, body: { error: 'invalid_request' } }, JSON.stringify(body))
    assert.ok(!db.touched.includes('orders'), 'rejected before any order read')
  }
  assert.equal((await post(CANCEL, { id: 'not-a-uuid' })).status, 400)
  // S4-04D3: requestId is mandatory and must be a lower-case RFC 4122 UUID
  for (const rid of [undefined, '', 'abc', 5, 'AAAAAAAA-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000'])
    assert.deepEqual(await post(rid === undefined ? CANCEL : { ...CANCEL, requestId: rid }, { noRid: rid === undefined }), { status: 400, body: { error: 'invalid_request' } }, String(rid))
  for (const [body, reason] of [[{ eventType: 'cancelled_at_provider', providerOrderId: '284' }, 'confirmation_required'], [{ eventType: 'confirmed_sent' }, 'provider_order_id_required'],
    [{ eventType: 'manual_courier', providerOrderId: '284' }, 'provider_order_id_forbidden'], [{ eventType: 'provider_status_checked', providerOrderId: '284' }, 'provider_status_required'],
    [{ eventType: 'auto_cancelled' }, 'invalid_event_type']])
    assert.deepEqual(await post(body), { status: 400, body: { error: 'invalid_request', reason } }, reason)
  assert.equal(db.writes.length, 0)
})

await test('B5. valid record → exactly ONE append-only insert; actor = session account, order = route UUID; nothing else written', async () => {
  reset(); setEnv(ON)
  const r = await post(CANCEL)
  assert.equal(r.status, 201, JSON.stringify(r)); assert.equal(r.body.result, 'recorded'); assert.equal(r.body.event.eventType, 'cancelled_at_provider')
  assert.equal(ledgerWrites().length, 1); assert.deepEqual(otherWrites(), [])
  const { request_id: storedRid, ...stored } = ledgerWrites()[0].row
  assert.match(storedRid, /^[0-9a-f-]{36}$/)
  assert.deepEqual(stored, { order_id: ORDER_ID, event_type: 'cancelled_at_provider', actor_username: 'boss', provider_order_id: '284', provider_status: null, reason_code: 'provider_phone_confirmed' })
  // S4-04E2: written through the coordination function only; the actor argument is the authenticated session account
  assert.equal(db.recordCalls.length, 1); assert.equal(db.recordCalls[0].p_actor, 'boss'); assert.equal(db.recordCalls[0].p_order_id, ORDER_ID)
  assert.deepEqual(db.dispatch, { status: 'sent', provider_order_id: '284' }, 'dispatch row unchanged (still sent)')
  assert.equal(liveFetch, 0)
  for (const leak of ['0501234567', 'הגעש', 'לקוח']) assert.ok(!JSON.stringify(r).includes(leak))
})

await test('B6. browser retry with the SAME requestId → already_recorded with the original row; still ONE row', async () => {
  reset(); setEnv(ON)
  const rid = randomUUID()
  const first = await post({ ...CANCEL, requestId: rid })
  assert.equal(first.status, 201)
  for (let i = 0; i < 3; i++) {
    const again = await post({ ...CANCEL, requestId: rid })
    assert.deepEqual(again, { status: 200, body: { result: 'already_recorded', event: first.body.event } })
  }
  assert.equal(db.ledger.length, 1)
})

await test('B6b. same requestId with a DIFFERENT payload (any field, order or account) → 409 request_id_conflict; stored row unchanged', async () => {
  reset(); setEnv({ ...ON, MAALE_KITCHEN_RECONCILIATION_USERS: 'boss,mishor' })
  const rid = randomUUID()
  assert.equal((await post({ ...CANCEL, requestId: rid })).status, 201)
  const before = JSON.stringify(db.ledger)
  for (const body of [{ ...CANCEL, reasonCode: 'kitchen_cancelled' }, { ...CANCEL, reasonCode: null }, { eventType: 'confirmed_sent', providerOrderId: '284' },
    { eventType: 'manual_review_opened' }, { eventType: 'provider_status_checked', providerOrderId: '284', providerStatus: 'searching' }])
    assert.deepEqual(await post({ ...body, requestId: rid }), { status: 409, body: { error: 'request_id_conflict' } }, JSON.stringify(body))
  // another manager account replaying the same key → actor differs → refused
  assert.deepEqual(await post({ ...CANCEL, requestId: rid }, { user: 'mishor' }), { status: 409, body: { error: 'request_id_conflict' } })
  assert.equal(JSON.stringify(db.ledger), before, 'never modified'); assert.deepEqual(otherWrites(), [])
})

await test('B6c. two genuinely different actions (new requestId each, even identical payload) → two rows', async () => {
  reset(); setEnv(ON)
  assert.equal((await post({ eventType: 'manual_review_opened' })).status, 201)
  assert.equal((await post({ eventType: 'manual_review_opened' })).status, 201)
  assert.equal(db.ledger.length, 2)
})

await test('B6d. CONCURRENT identical requests (same requestId) → exactly one row; the losers resolve to already_recorded', async () => {
  reset(); setEnv(ON)
  const rid = randomUUID()
  const rs = await Promise.all(Array.from({ length: 6 }, () => post({ ...CANCEL, requestId: rid })))
  assert.equal(db.ledger.length, 1)
  assert.equal(rs.filter(r => r.status === 201).length, 1, JSON.stringify(rs.map(r => r.status)))
  assert.ok(rs.every(r => r.status === 201 || (r.status === 200 && r.body.result === 'already_recorded')))
  assert.equal(db.recordCalls.length, 6, 'every request reached the coordination function (idempotency is decided there)')
  assert.equal(ledgerWrites().length, 1)
})

await test('B6e. unauthorized replay of a stored requestId → 404 before any lookup (authorization first)', async () => {
  reset(); setEnv(ON)
  const rid = randomUUID()
  assert.equal((await post({ ...CANCEL, requestId: rid })).status, 201)
  db.touched = []
  assert.deepEqual(await post({ ...CANCEL, requestId: rid }, { user: 'mishor' }), { status: 404, body: { error: 'not_found' } })
  assert.deepEqual([...new Set(db.touched)], ['kitchen_users'])
})

await test('B7. provider id must match the stored dispatch; events about a submission need a real attempt → otherwise 409, nothing written', async () => {
  reset(); setEnv(ON)
  assert.deepEqual(await post({ ...CANCEL, providerOrderId: '999' }), { status: 409, body: { error: 'provider_order_mismatch' } })
  assert.deepEqual(await post({ eventType: 'provider_status_checked', providerOrderId: '999', providerStatus: 'searching' }), { status: 409, body: { error: 'provider_order_mismatch' } })
  reset({ dispatch: null }); setEnv(ON)
  for (const body of [CANCEL, { eventType: 'confirmed_sent', providerOrderId: '284' }, { eventType: 'not_received' }, { eventType: 'provider_status_checked', providerStatus: 'searching' },
    { eventType: 'manual_review_opened', providerOrderId: '284' }])
    assert.deepEqual(await post(body), { status: 409, body: { error: 'no_dispatch_record' } }, body.eventType)
  reset({ dispatch: { status: 'pending', provider_order_id: null } }); setEnv(ON)
  assert.deepEqual(await post(CANCEL), { status: 409, body: { error: 'no_dispatch_attempt' } })
  reset({ type: 'pickup' }); setEnv(ON)
  assert.deepEqual(await post({ eventType: 'manual_courier' }), { status: 409, body: { error: 'not_delivery' } })
  assert.equal(db.writes.length, 0)
  // unknown-outcome row (no provider id stored yet): staff may record the id the provider gave by phone
  reset({ dispatch: { status: 'sending', provider_order_id: null } }); setEnv(ON)
  assert.equal((await post({ eventType: 'confirmed_sent', providerOrderId: 'MX-7', reasonCode: 'provider_phone_confirmed' })).status, 201)
})

await test('B8. manual courier WITHOUT a dispatch row → recorded (no provider id); review records need no dispatch', async () => {
  reset({ dispatch: null }); setEnv(ON)
  assert.equal((await post({ eventType: 'manual_courier', reasonCode: 'courier_booked_by_phone' })).status, 201)
  assert.equal((await post({ eventType: 'manual_review_opened', reasonCode: 'outcome_unknown' })).status, 201)
  assert.equal(db.ledger.length, 2); assert.deepEqual(otherWrites(), [])
})

await test('B9. failed insert → 500 server_error (no DB text); function / ledger missing or lock timeout → 503; no other writes', async () => {
  reset(); setEnv(ON)
  db.insertError = { code: '23514', message: 'violates check constraint SECRET-DETAIL' }
  const r = await post(CANCEL)
  assert.deepEqual(r, { status: 500, body: { error: 'server_error' } }); assert.ok(!JSON.stringify(r).includes('SECRET'))
  // 04E not installed (PGRST202 / 42883), ledger missing (42P01), lock timeout (55P03): unavailable, retry with the same requestId
  for (const code of ['42P01', 'PGRST202', '42883', '55P03']) {
    db.insertError = { code, message: 'SECRET-DETAIL' }
    assert.deepEqual(await post(CANCEL), { status: 503, body: { error: 'reconciliation_unavailable' } }, code)
  }
  assert.equal(db.ledger.length, 0); assert.deepEqual(otherWrites(), [])
})

await test('B10. S4-04E2 gating: manual courier refused while a Maale request is (or may be) live; definitive rejection allows it', async () => {
  const MC = { eventType: 'manual_courier', reasonCode: 'courier_booked_by_phone' }
  for (const [dispatch, expected] of [
    [{ status: 'sending', provider_order_id: null, attempts: 1 }, 'dispatch_active'],
    [{ status: 'sent', provider_order_id: '284', attempts: 1 }, 'dispatch_active'],
    [{ status: 'failed_retryable', provider_order_id: null, attempts: 1, error_code: 'timeout' }, 'dispatch_outcome_unknown'],
    [{ status: 'failed_final', provider_order_id: null, attempts: 1, error_code: 'idempotency_mismatch' }, 'dispatch_outcome_unknown'],
    [{ status: 'pending', provider_order_id: null, attempts: 2 }, 'dispatch_outcome_unknown'],
  ]) {
    reset({ dispatch, status: 'confirmed' }); setEnv(ON)
    assert.deepEqual(await post(MC), { status: 409, body: { error: expected } }, dispatch.status)
    assert.equal(db.ledger.length, 0); assert.deepEqual(db.writes, [])
    assert.ok(UIR.RECONCILIATION_MESSAGES[expected] && /[א-ת]/.test(UIR.RECONCILIATION_MESSAGES[expected]), `Hebrew message for ${expected}`)
  }
  for (const dispatch of [{ status: 'pending', provider_order_id: null, attempts: 0 }, { status: 'failed_final', provider_order_id: null, attempts: 1, error_code: 'out_of_area' }]) {
    reset({ dispatch, status: 'confirmed' }); setEnv(ON)
    assert.equal((await post(MC)).status, 201, dispatch.status)
  }
})

await test('B11. every function answer mapped explicitly; unknown / malformed answers fail closed (500, never "recorded")', async () => {
  const cases = [
    ['order_not_found', 404, { error: 'not_found' }], ['invalid_request', 400, { error: 'invalid_request' }],
    ...KR.RECORD_CONFLICT_RESULTS.map(c => [c, 409, { error: c }]),
    ['something_new', 500, { error: 'server_error' }], ['', 500, { error: 'server_error' }],
  ]
  for (const [result, status, body] of cases) {
    reset(); setEnv(ON); db.recordAnswer = { data: [{ result, event_id: null, event_created_at: null }], error: null }
    assert.deepEqual(await post(CANCEL), { status, body }, result)
  }
  for (const data of [null, [], [{}], [{ result: 5 }], [{ result: 'recorded', event_id: null, event_created_at: null }], [{ result: 'already_recorded', event_id: 'x', event_created_at: 7 }],
    [{ result: 'recorded', event_id: 'a', event_created_at: 'b' }, { result: 'recorded', event_id: 'c', event_created_at: 'd' }]]) {
    reset(); setEnv(ON); db.recordAnswer = { data, error: null }
    assert.deepEqual(await post(CANCEL), { status: 500, body: { error: 'server_error' } }, JSON.stringify(data))
  }
  assert.deepEqual([...KR.RECORD_CONFLICT_RESULTS].sort(), ['dispatch_active', 'dispatch_outcome_unknown', 'no_dispatch_attempt', 'no_dispatch_record', 'provider_order_mismatch', 'request_id_conflict'])
  const sql = src('db/migrations/s4_04e_courier_coordination.sql')
  const fnBody = sql.slice(sql.indexOf('$record_maale_reconciliation_event$') + 1, sql.lastIndexOf('$record_maale_reconciliation_event$'))
  const sqlResults = [...new Set([...fnBody.matchAll(/SELECT '([a-z_]+)'::text/g)].map(m => m[1]))].sort()
  const mapped = ['recorded', 'already_recorded', 'order_not_found', 'invalid_request', ...KR.RECORD_CONFLICT_RESULTS].sort()
  assert.deepEqual(sqlResults, mapped, 'the service maps exactly the answers the SQL function can return')
})

console.log('C) Read model, session and dispatch hint')

const orderRow = (events = []) => ({ ...db.order, delivery_dispatches: [{ status: 'sent', error_code: null, provider_order_id: '284', provider_status: 'searching', last_attempt_at: '2026-10-22T09:01:00Z' }],
  maale_dispatch_reconciliations: events })
const get = async (r, path, user) => { const res = await r.GET(new NextRequest(`${ORIGIN}${path}`, { headers: { cookie: cookieFor(user) } })); return { status: res.status, body: await res.json() } }

await test('C1. orders read: feature off → the unchanged select, no reconciliation key; manager / dispatch account → embed', async () => {
  reset(); setEnv({ MAALE_KITCHEN_RECONCILIATION_USERS: 'boss' })
  let r = await get(ordersRoute, '/api/kitchen/orders', 'boss')
  assert.equal(db.selects.at(-1), R.KITCHEN_ORDER_SELECT); assert.ok(!('reconciliation' in r.body.orders[0]) && !('dispatch' in r.body.orders[0]))
  setEnv(ON); db.order = orderRow([{ id: 'e1', event_type: 'cancelled_at_provider', actor_username: 'boss', provider_order_id: '284', provider_status: null, reason_code: 'kitchen_cancelled', created_at: '2026-10-22T10:00:00Z' }])
  r = await get(ordersRoute, '/api/kitchen/orders', 'boss')
  assert.equal(db.selects.at(-1), R.kitchenOrderSelect(true, true))
  assert.equal(r.body.orders[0].reconciliation.summary.cancelledAtProvider, true); assert.equal(r.body.orders[0].dispatch.view, 'sent')
  setEnv({ ...ON, MAALE_KITCHEN_DISPATCH_ENABLED: 'true', MAALE_KITCHEN_DISPATCH_USERS: 'mishor' })
  r = await get(ordersRoute, '/api/kitchen/orders', 'mishor')
  assert.ok('reconciliation' in r.body.orders[0], 'dispatch accounts see recorded cancellations (read only)')
  setEnv(ON); r = await get(ordersRoute, '/api/kitchen/orders', 'mishor')
  assert.equal(db.selects.at(-1), R.KITCHEN_ORDER_SELECT, 'a plain kitchen account gets the old select'); assert.ok(!('reconciliation' in r.body.orders[0]))
})

await test('C2. normalization drops malformed rows and never returns unknown fields', () => {
  const o = R.normalizeKitchenOrder(orderRow([
    { id: 'e1', event_type: 'confirmed_sent', actor_username: 'boss', provider_order_id: '284', provider_status: null, reason_code: null, created_at: '2026-10-22T10:00:00Z', secret: 'x' },
    { id: 'e2', event_type: 'hacked', actor_username: 'boss', created_at: '2026-10-22T10:01:00Z' },
    { id: 'e3', event_type: 'manual_courier', actor_username: 'Bad Actor', created_at: '2026-10-22T10:02:00Z' },
    { id: 'e4', event_type: 'provider_status_checked', actor_username: 'boss', provider_status: 'Not Safe', reason_code: 'free', created_at: '2026-10-22T10:03:00Z' },
  ]), { dispatch: true, reconciliation: true })
  assert.deepEqual(o.reconciliation.events.map(e => e.id), ['e4', 'e1'])
  assert.deepEqual(Object.keys(o.reconciliation.events[0]).sort(), ['actor', 'createdAt', 'eventType', 'id', 'providerOrderId', 'providerStatus', 'reasonCode'])
  assert.equal(o.reconciliation.events[0].providerStatus, null); assert.equal(o.reconciliation.events[0].reasonCode, null)
  assert.ok(!JSON.stringify(o.reconciliation).includes('secret'))
  const many = Array.from({ length: 14 }, (_, i) => ({ id: `m${String(i).padStart(2, '0')}`, event_type: 'manual_review_opened', actor_username: 'boss', created_at: `2026-10-22T10:${String(i).padStart(2, '0')}:00Z` }))
  const big = R.normalizeKitchenOrder(orderRow(many), { reconciliation: true })
  assert.equal(big.reconciliation.events.length, 10); assert.equal(big.reconciliation.summary.reviewOpen, true)
  assert.equal(R.normalizeKitchenOrder({ ...orderRow(many), type: 'pickup' }, { reconciliation: true }).reconciliation, null)
})

await test('C3. session: manager flag only for allowlisted accounts; allowlist never returned', async () => {
  setEnv({ ...ON, MAALE_KITCHEN_RECONCILIATION_USERS: 'boss,other' })
  const boss = await get(sessionRoute, '/api/kitchen/session', 'boss'), mishor = await get(sessionRoute, '/api/kitchen/session', 'mishor')
  assert.equal(boss.body.maaleKitchenReconciliationEnabled, true); assert.equal(mishor.body.maaleKitchenReconciliationEnabled, false)
  assert.ok(!JSON.stringify(mishor.body).includes('other') && !/RECONCILIATION_USERS/.test(JSON.stringify(boss.body)))
  setEnv({ MAALE_KITCHEN_RECONCILIATION_USERS: 'boss' })
  assert.equal((await get(sessionRoute, '/api/kitchen/session', 'boss')).body.maaleKitchenReconciliationEnabled, false)
})

await test('C4. a recorded manual courier hides the in-app courier button (no second courier)', () => {
  const order = { type: 'delivery', status: 'confirmed', paymentMethod: 'cash', totalPrice: 73, parcel: null, dispatch: null,
    delivery: { address: 'מעלה אדומים, הגעש 6', courierNotes: null, mealQuantity: 0, mealSurcharge: 0, deliveryFee: 20 } }
  assert.equal(UI.dispatchHint(order).canRequest, true)
  const withManual = { ...order, reconciliation: { summary: { manualCourier: true } } }
  assert.equal(UI.dispatchHint(withManual).canRequest, false); assert.equal(UI.isDispatchButtonVisible(withManual, undefined), false)
})

console.log('D) Kitchen UI source and scope')

const walk = dir => readdirSync(dir).flatMap(n => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p] })
await test('D1. UI only in the Kitchen Orders app: one POST site, ref guard, cancellation checkbox, no actor / branch sent', () => {
  const p = src('app/dashboard/orders/page.tsx')
  assert.equal(p.split('/reconciliation`').length - 1, 1, 'exactly one call site')
  assert.ok(p.includes('const submitReconciliation = (order: Order, input: ReconciliationInput, requestId: string) => runExclusive(reconciliationInFlight, async () => {'))
  // S4-04D3: a NEW requestId per confirmed modal action; the SAME one only for the explicit retry of that action.
  assert.ok(p.includes('onSubmit={input => { void submitReconciliation(reconciliationOrder, input, newReconciliationRequestId()) }}'))
  assert.ok(p.includes('if (retry) void submitReconciliation(order, retry.input, retry.requestId) // same payload, same requestId'))
  assert.ok(p.includes("{ ...input, requestId })") && p.includes('const newReconciliationRequestId = (): string => crypto.randomUUID()'))
  assert.equal((p.match(/newReconciliationRequestId\(\)/g) || []).length, 1, 'generated in exactly one place (the modal confirmation)')
  assert.ok(p.includes('const reconciliationInFlight = useRef(false)'))
  assert.ok(p.includes("eventType === 'cancelled_at_provider' && (") && p.includes('{CANCELLATION_CONFIRM_LABEL}') && p.includes('{CANCELLATION_RECORD_WARNING}'))
  assert.ok(p.includes('disabled={!allowed} onClick={() => { if (allowed) onSubmit(input) }}'))
  assert.ok(p.includes('RECONCILIATION_MESSAGES.network_error'), 'lost answer → "unknown, check history"')
  assert.ok(p.includes('reconciliationEnabled={session.maaleKitchenReconciliationEnabled === true}'))
  const body = p.slice(p.indexOf('const input: ReconciliationInput = {'), p.indexOf('const allowed = validateReconciliationInput'))
  assert.ok(!/^\s*(actor\w*|branch\w*|orderId|order_id)\s*[:,]/im.test(body), 'the form never sends actor / branch / order')
  assert.deepEqual([...body.matchAll(/^\s{4}(\w+)[:,]/gm)].map(m => m[1]), ['eventType', 'providerOrderId', 'providerStatus', 'reasonCode', 'confirmCancellation'])
  assert.ok(p.includes('{REPORTED_NOT_VERIFIED_NOTE}'), 'never shown as a live / verified provider status')
  const users = walk(join(ROOT, 'app')).filter(f => /\.(tsx|jsx)$/.test(f) && /\/reconciliation`|ReconciliationPanel|kitchenReconciliationUi/.test(readFileSync(f, 'utf8')))
    .map(f => f.slice(ROOT.length + 1).replace(/\\/g, '/'))
  assert.deepEqual(users, ['app/dashboard/orders/page.tsx'])
  for (const f of ['app/order/page.tsx', 'app/api/orders/route.ts', 'app/dashboard/page.tsx', 'app/api/kitchen/orders/[id]/status/route.ts', 'app/api/kitchen/parcels/[orderId]/route.ts'])
    assert.ok(!/reconciliation/i.test(src(f)), f)
})

await test('D2. route: flag → origin → session → manager → body → UUID → DB; never calls the provider or touches dispatch writes', () => {
  const r = src('app/api/kitchen/orders/[id]/reconciliation/route.ts')
  const at = t => { const i = r.indexOf(t); assert.ok(i > 0, t); return i }
  const order = [at('isReconciliationEnabled(process.env)'), at('checkSameOriginJson(req)'), at('await getKitchenSession(req)'),
    at('isReconciliationAllowedFor(process.env, auth.session.username)'), at('await req.json()'), at('!isUuid(id) || !input'), at('getServerSupabase()')]
  assert.deepEqual([...order].sort((a, b) => a - b), order)
  assert.ok(!/maaleClient|maaleDispatch|maalePayload|fetch\(|\.update\(|\.delete\(|\.upsert\(|testMode/.test(r))
  // S4-04E2: no direct INSERT; exactly one call of the coordination function, actor from the session
  assert.equal((r.match(/\.insert\(/g) || []).length, 0)
  assert.equal((r.match(/rpc\('record_maale_reconciliation_event'/g) || []).length, 1)
  assert.ok(r.includes('p_actor: row.actor_username') && src('lib/kitchenReconciliation.ts').includes('actor_username: session.username'))
  assert.ok(!/MAALE_KITCHEN_RECONCILIATION_USERS/.test(src('app/dashboard/orders/page.tsx') + src('lib/kitchenReconciliationUi.ts') + src('lib/kitchenTypes.ts')))
  assert.equal(liveFetch, 0, 'no provider / network call anywhere in this suite')
})

console.log('E) Server-side dispatch block (S4-04D3)')

const DISPATCH_ON = { ...ON, MAALE_KITCHEN_DISPATCH_ENABLED: 'true', MAALE_KITCHEN_DISPATCH_USERS: 'mishor' } // Maale itself stays OFF
const postDispatch = async (user = 'mishor') => {
  const res = await dispatchRoute.POST(new NextRequest(`${ORIGIN}/api/kitchen/orders/${ORDER_ID}/dispatch`, {
    method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json', cookie: cookieFor(user) }, body: JSON.stringify({ expectedFeeAgorot: 2000 }) }),
  { params: Promise.resolve({ id: ORDER_ID }) })
  return { status: res.status, body: await res.json() }
}
const ledgerRead = () => db.touched.includes('maale_dispatch_reconciliations')
// An order that passes every local gate ends at 503 dispatch_unavailable (Maale disabled) — proof the new gate let it through.
const PASSED_GATE = { status: 503, body: { error: 'dispatch_unavailable' } }

await test('E1. manual_courier recorded (real POST) → direct dispatch POST refused 409 BEFORE any limiter / quote / claim / send', async () => {
  reset({ dispatch: null, status: 'confirmed' }); setEnv(DISPATCH_ON)
  assert.equal((await post({ eventType: 'manual_courier', reasonCode: 'courier_booked_by_phone' })).status, 201)
  db.touched = []; db.writes = []
  assert.deepEqual(await postDispatch(), { status: 409, body: { error: 'not_eligible', reason: 'manual_courier_recorded' } })
  assert.ok(!db.touched.includes('rpc'), 'no quote slot consumed'); assert.equal(db.writes.length, 0, 'no dispatch row / claim'); assert.equal(liveFetch, 0)
  assert.equal(UI.interpretDispatchResponse(409, { error: 'not_eligible', reason: 'manual_courier_recorded' }).lock, false)
})

await test('E2. open manual review blocks; once resolved the gate passes (to the normal next checks)', async () => {
  reset({ dispatch: null, status: 'confirmed' }); setEnv(DISPATCH_ON)
  assert.equal((await post({ eventType: 'manual_review_opened', reasonCode: 'outcome_unknown' })).status, 201)
  assert.deepEqual(await postDispatch(), { status: 409, body: { error: 'not_eligible', reason: 'manual_review_open' } })
  assert.equal((await post({ eventType: 'manual_review_resolved' })).status, 201)
  assert.deepEqual(await postDispatch(), PASSED_GATE)
})

await test('E3. ledger missing / unreadable while the reconciliation feature is ON → 503 reconciliation_unavailable (fail closed)', async () => {
  for (const err of [{ code: '42P01', message: 'relation does not exist' }, { code: 'PGRST205', message: 'not found' }, { code: '57014', message: 'timeout' }]) {
    reset({ dispatch: null, status: 'confirmed' }); setEnv(DISPATCH_ON); db.ledgerReadError = err
    db.touched = []
    const r = await postDispatch()
    assert.deepEqual(r, { status: 503, body: { error: 'reconciliation_unavailable' } }); assert.ok(!db.touched.includes('rpc'))
    assert.ok(!JSON.stringify(r).includes(err.message))
    assert.equal(UI.interpretDispatchResponse(r.status, r.body).lock, false)
  }
})

await test('E4. feature-off regression: reconciliation flag off → ledger never read; dispatch behaves exactly as before', async () => {
  reset({ dispatch: null, status: 'confirmed' }); setEnv({ ...DISPATCH_ON, MAALE_KITCHEN_RECONCILIATION_ENABLED: 'false' })
  db.ledger.push({ id: 'x1', request_id: randomUUID(), order_id: ORDER_ID, event_type: 'manual_courier', actor_username: 'boss', provider_order_id: null, provider_status: null, reason_code: null, created_at: new Date().toISOString() })
  db.touched = []
  assert.deepEqual(await postDispatch(), PASSED_GATE)
  assert.equal(ledgerRead(), false, 'no ledger read when the feature is off (documented activation-order gap)')
})

await test('E5. a cancellation (or any record) never unlocks: a sent dispatch stays authoritative → already_dispatched, no send', async () => {
  const snap = { order: { id: ORDER_ID, type: 'delivery', branch_id: MISHOR, payment_method: 'cash', customer_name: 'לקוח', phone: '0501234567', total_price: 73 },
    delivery: { city: 'מעלה אדומים', street: 'הגעש', house_number: '6', apartment: '6', floor: '2', entrance: 'ב׳', notes: null, delivery_fee: 20, meal_surcharge: 4,
      delivery_lat: 31.773612, delivery_lng: 35.298346, geo_source: 'geocoder', geo_precision: 'street' },
    items: [{ name: 'פלאפל בפיתה', quantity: 1, unit_price: 40 }, { name: 'קוקה קולה', quantity: 1, unit_price: 9 }] }
  let sends = 0, quotes = 0, slots = 0
  const row = { order_id: ORDER_ID, external_order_id: ORDER_ID, status: 'sent', attempts: 1, last_attempt_at: '2026-10-22T09:00:00.000Z', error_code: null }
  const config = { status: 'ready', apiKey: 'test-key-not-real' }
  const serviceDeps = {
    config, isPaymentVerified: async () => false, now: () => '2026-10-22T10:00:00.000Z', log: () => {},
    repo: { async loadOrder() { return { snapshot: snap, status: 'confirmed', parcelStatus: null } }, async getDispatch() { return { ...row } }, async hasRecentAuthFailure() { return false },
      async insertPending() { throw new Error('must not write') }, async claim() { throw new Error('must not claim') }, async markSent() { throw new Error('x') }, async markFailed() { throw new Error('x') } },
    quote: async () => { quotes++; throw new Error('must not quote') }, send: async () => { sends++; throw new Error('must not send') },
    consumeQuoteSlot: async () => { slots++; return 'ok' },
  }
  for (const events of [['confirmed_sent', 'cancelled_at_provider'], ['cancelled_at_provider', 'manual_review_opened', 'manual_review_resolved'], ['not_received']]) {
    const r = await KD.requestKitchenDispatch({
      async loadOrder() { return { id: ORDER_ID, branch_id: MISHOR, status: 'confirmed', type: 'delivery', delivery_fee: '20.00' } },
      dispatch: id => D.dispatchOrderToMaale(id, serviceDeps),
      async loadDispatchRow() { return { status: 'sent', error_code: null, provider_order_id: '284', provider_status: 'searching' } },
      dispatchBlockingRecord: async () => UIR.dispatchBlockReason(events),
    }, { role: 'branch', branchId: MISHOR }, ORDER_ID, 2000)
    assert.equal(r.status, 200, JSON.stringify(r)); assert.equal(r.body.result, 'already_dispatched', events.join(','))
  }
  assert.deepEqual([sends, quotes, slots], [0, 0, 0])
  assert.equal(UIR.dispatchBlockReason(['confirmed_sent', 'cancelled_at_provider']), null, 'no record unlocks; none of these blocks either — the sent row does')
  assert.equal(UIR.dispatchBlockReason(['manual_courier', 'cancelled_at_provider', 'manual_review_resolved']), 'manual_courier_recorded', 'later records never lift a manual courier')
})

await test('E6. source: the block runs after branch / fee / status, before the dispatch service; wired only with the feature on', () => {
  const k = src('lib/kitchenDispatch.ts')
  const at = t => { const i = k.indexOf(t); assert.ok(i > 0, t); return i }
  assert.ok(at("reason: 'order_status' })") < at('if (deps.dispatchBlockingRecord) {') && at('if (deps.dispatchBlockingRecord) {') < at('const result = await deps.dispatch(orderId)'))
  assert.ok(k.includes("return reply(503, { error: 'reconciliation_unavailable' })"))
  const r = src('app/api/kitchen/orders/[id]/dispatch/route.ts')
  assert.ok(r.includes('...(isReconciliationEnabled(process.env) ? {') && r.includes("supabase.from('maale_dispatch_reconciliations').select('event_type').eq('order_id', orderId)"))
  assert.ok(!/\.insert\(|\.update\(|\.delete\(/.test(r.slice(r.indexOf('async dispatchBlockingRecord'), r.indexOf('log: code =>'))), 'read-only lookup')
})

setEnv()
console.log(`\nAll ${passed} kitchen reconciliation checks passed.`)
