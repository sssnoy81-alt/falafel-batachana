// Offline checks for the kitchen courier-request UI (S4-INTEGRATIONS-03M):
//  A) GET /api/kitchen/session exposes maaleKitchenDispatchEnabled (default false) — REAL route, FAKE supabaseServer.
//  B) GET /api/kitchen/orders adds delivery_dispatches ONLY when the flag is on; the disabled read is unchanged.
//  C) lib/kitchenDispatchUi (client-safe): mirrored constants equal the server's, view mapping equals the server's,
//     indicative eligibility, confirmation text, Hebrew messages for every server response, transition warnings.
//  D) The kitchen page: controls gated by the session flag, one call site, no server module, no auto-cancel.
// No network, no key, no DB, no provider. Run: node scripts/verify-kitchen-dispatch-ui.mjs

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

/* ─── FAKE supabaseServer (kitchen_users, branches, orders list) ─── */
class ServerConfigError extends Error { constructor(m) { super(m); this.name = 'ServerConfigError' } }
const db = { kitchen_users: [], orderRows: [], queries: [] }
function query(table) {
  const q = { table, ops: [] }
  db.queries.push(q)
  const run = async () => {
    const eq = Object.fromEntries(q.ops.filter(o => o[0] === 'eq').map(o => [o[1], o[2]]))
    if (table === 'kitchen_users') return { data: db.kitchen_users.filter(u => u.username === eq.username), error: null }
    if (table === 'branches') return { data: [], error: null }
    if (table === 'orders') return { data: db.orderRows, error: null }
    return { data: [], error: null }
  }
  const b = {
    select(c) { q.ops.push(['select', c]); return b }, eq(c, v) { q.ops.push(['eq', c, v]); return b },
    in() { return b }, gte() { return b }, lt() { return b }, order() { return b }, limit() { return b }, is() { return b },
    update() { q.write = true; return b }, insert() { q.write = true; return b }, upsert() { q.write = true; return b },
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
const sessionRoute = loadFile(join(ROOT, 'app/api/kitchen/session/route.ts'))
const ordersRoute = loadFile(join(ROOT, 'app/api/kitchen/orders/route.ts'))
const K = lib('kitchenAuth')
const UI = lib('kitchenDispatchUi')
const R = lib('kitchenOrders')
const KD = lib('kitchenDispatch')
const D = lib('maaleDispatch')
const P = lib('maalePayload')
const PR = lib('parcelRequest')
const cfg = lib('orderConfig')
const { NextRequest } = require('next/server')

let passed = 0
const test = async (name, fn) => { await fn(); passed++; console.log('  ✓', name) }

/* ─── Fixtures (FAKE) ─── */
const MISHOR = cfg.DELIVERY_BRANCH_IDS[0]
const SECRET = randomBytes(48).toString('base64url')
process.env.KITCHEN_SESSION_SECRET = SECRET
delete process.env.MAALE_EXPRESS_ENABLED; delete process.env.MAALE_EXPRESS_API_KEY; delete process.env.MAALE_KITCHEN_DISPATCH_ENABLED
const HASH = K.hashPassword(randomBytes(12).toString('base64url'))
const SESS = {
  mishor: { username: 'mishor', role: 'branch', branchId: MISHOR, label: 'mishor' },
  admin: { username: 'boss', role: 'admin', branchId: null, label: 'boss' },
}
const ORIGIN = 'https://app.example'
db.kitchen_users = Object.values(SESS).map(s => ({ username: s.username, password_hash: HASH, role: s.role, branch_id: s.branchId, label: s.label, is_active: true }))
const get = async (route, path, session = SESS.mishor) => {
  const req = new NextRequest(`${ORIGIN}${path}`, { headers: { cookie: `kitchen_session=${K.signSession(session, SECRET)}` } })
  const res = await route.GET(req)
  return { status: res.status, body: await res.json() }
}
const setFlag = v => { if (v === undefined) delete process.env.MAALE_KITCHEN_DISPATCH_ENABLED; else process.env.MAALE_KITCHEN_DISPATCH_ENABLED = v }

const NOW = Date.parse('2026-10-22T12:00:00Z')
const ago = ms => new Date(NOW - ms).toISOString()
const baseRow = (over = {}) => ({
  id: 'o1', daily_number: 7, type: 'delivery', status: 'confirmed', created_at: '2026-10-22T10:00:00+00:00',
  customer_name: 'לקוח', phone: '0501234567', payment_method: 'cash', total_price: '92.00', branch_id: MISHOR,
  branches: { name: 'מישור אדומים' }, order_items: [],
  deliveries: [{ address: 'מעלה אדומים, הגעש 6', notes: null, meal_quantity: 0, meal_surcharge: '0', delivery_fee: '25.00' }],
  parcel_requests: [],
  ...over,
})
const DISPATCH_ROW = {
  status: 'sent', error_code: null, provider_order_id: 'MX-123', provider_status: 'new', last_attempt_at: ago(1000),
  // must never leak even if returned:
  external_order_id: 'o1', attempts: 1, order_id: 'o1', id: 'dd1',
}
const order = (over = {}) => ({
  type: 'delivery', status: 'confirmed', paymentMethod: 'cash', totalPrice: 92, parcel: null, dispatch: null,
  delivery: { address: 'מעלה אדומים, הגעש 6', courierNotes: null, mealQuantity: 0, mealSurcharge: 0, deliveryFee: 25 },
  ...over,
})

console.log('A) Session flag')

await test('U1. maaleKitchenDispatchEnabled: false unless the env value is exactly "true" (branch + admin)', async () => {
  for (const [v, want] of [[undefined, false], ['false', false], ['TRUE', false], ['1', false], [' true', false], ['true', true]]) {
    setFlag(v)
    for (const s of [SESS.mishor, SESS.admin]) {
      const r = await get(sessionRoute, '/api/kitchen/session', s)
      assert.equal(r.status, 200)
      assert.equal(r.body.maaleKitchenDispatchEnabled, want, `${v} / ${s.role}`)
      assert.equal(typeof r.body.maaleKitchenDispatchEnabled, 'boolean')
      assert.deepEqual(Object.keys(r.body).sort(), ['branches', 'expiresAt', 'maaleKitchenDispatchEnabled', 'user'])
    }
  }
  setFlag(undefined)
  const s = JSON.stringify((await get(sessionRoute, '/api/kitchen/session')).body)
  assert.ok(!/MAALE_|API_KEY|SECRET/i.test(s), 'no env names / values in the session response')
})

console.log('B) Read model')

await test('U2. flag OFF: select is exactly the pre-03M KITCHEN_ORDER_SELECT; no dispatch key in the response', async () => {
  setFlag(undefined)
  db.orderRows = [baseRow({ delivery_dispatches: [DISPATCH_ROW] })]
  db.queries = []
  const r = await get(ordersRoute, '/api/kitchen/orders')
  assert.equal(r.status, 200)
  const sel = db.queries.find(q => q.table === 'orders').ops.find(o => o[0] === 'select')[1]
  assert.equal(sel, R.KITCHEN_ORDER_SELECT)
  assert.ok(!sel.includes('delivery_dispatches'))
  assert.equal(r.body.orders.length, 1)
  assert.ok(!('dispatch' in r.body.orders[0]))
  assert.equal(JSON.stringify(r.body).includes('MX-123'), false, 'an unexpected embed is ignored when disabled')
})

await test('U3. flag ON: one-to-one delivery_dispatches embed with the 4 display columns (+ last_attempt_at for staleness)', async () => {
  setFlag('true')
  db.orderRows = [baseRow({ delivery_dispatches: [DISPATCH_ROW] }), baseRow({ id: 'o2', type: 'pickup', deliveries: [], delivery_dispatches: [DISPATCH_ROW] }), baseRow({ id: 'o3' })]
  db.queries = []
  const r = await get(ordersRoute, '/api/kitchen/orders')
  setFlag(undefined)
  const sel = db.queries.find(q => q.table === 'orders').ops.find(o => o[0] === 'select')[1]
  assert.equal(sel, `${R.KITCHEN_ORDER_SELECT}, delivery_dispatches(status, error_code, provider_order_id, provider_status, last_attempt_at)`)
  assert.ok(!/\*|attempts\b|external_order_id|dispatched_at/.test(sel.slice(R.KITCHEN_ORDER_SELECT.length)))
  const [o1, o2, o3] = r.body.orders
  assert.deepEqual(Object.keys(o1.dispatch).sort(), ['errorCode', 'providerOrderId', 'providerStatus', 'view'])
  assert.equal(o1.dispatch.view, 'sent'); assert.equal(o1.dispatch.providerOrderId, 'MX-123')
  assert.equal(o2.dispatch, null, 'pickup → null even if a row came back')
  assert.equal(o3.dispatch, null, 'no row → null')
  const s = JSON.stringify(r.body)
  for (const leak of ['external_order_id', 'attempts', 'dd1', 'last_attempt_at', 'order_id']) assert.ok(!s.includes(leak), leak)
})

await test('U4. normalization: object-shaped embed, stale "sending" → manual check; option off ≡ pre-03M output', async () => {
  const fresh = R.normalizeKitchenOrder(baseRow({ delivery_dispatches: { ...DISPATCH_ROW, status: 'sending', last_attempt_at: ago(60_000) } }), { dispatch: true, nowMs: NOW })
  assert.equal(fresh.dispatch.view, 'in_progress')
  const stale = R.normalizeKitchenOrder(baseRow({ delivery_dispatches: { ...DISPATCH_ROW, status: 'sending', last_attempt_at: ago(D.MAALE_SENDING_STALE_MS + 1) } }), { dispatch: true, nowMs: NOW })
  assert.equal(stale.dispatch.view, 'needs_manual_check')
  const rows = [baseRow({ delivery_dispatches: [DISPATCH_ROW] }), baseRow({ id: 'o2' })]
  assert.deepEqual(R.normalizeKitchenOrders(rows), R.normalizeKitchenOrders(rows, { dispatch: false }))
  assert.deepEqual(Object.keys(R.normalizeKitchenOrders(rows)[0]).sort(),
    ['branchId', 'branchName', 'createdAt', 'customerName', 'dailyNumber', 'delivery', 'id', 'items', 'parcel', 'paymentMethod', 'phone', 'status', 'totalPrice', 'type'])
})

console.log('C) Client-safe helper')

await test('U5. mirrored constants equal the server values', () => {
  assert.deepEqual([...UI.UI_DISPATCH_STATUSES], [...D.DISPATCHABLE_ORDER_STATUSES])
  assert.deepEqual([...UI.UI_DISPATCH_STATUSES], [...KD.KITCHEN_DISPATCH_STATUSES])
  assert.ok(!UI.UI_DISPATCH_STATUSES.includes('ready'), "'ready' is not enabled")
  assert.equal(UI.UI_SENDING_STALE_MS, D.MAALE_SENDING_STALE_MS)
  assert.equal(UI.UI_CASH_FOOD_CAP_AGOROT, P.MAALE_CASH_FOOD_CAP_AGOROT)
  for (const s of Object.keys(D.MANUAL_REVIEW_SETTLEMENTS)) assert.ok(UI.UI_MANUAL_SETTLEMENTS.includes(s), s)
  assert.ok(UI.UI_MANUAL_SETTLEMENTS.includes('נופי פרת'))
  // Parcel: the hint allows exactly the statuses the server's parcel gate allows.
  for (const st of [null, ...PR.PARCEL_STATUSES, 'invalid']) {
    const hint = UI.dispatchHint(order({ parcel: st === null ? null : { status: st, trackingRef: 'x', carrier: null, recipientName: null } }))
    assert.equal(hint.canRequest, D.parcelGate(st) === 'ok', String(st))
  }
})

await test('U6. view mapping equals the server mapping for every status / code (fresh rows)', () => {
  const codes = [null, 'timeout', 'network_error', 'provider_5xx', 'rate_limited', 'rate_limited_after_30', 'unexpected_quote_response', 'blocked', 'zone_unknown', 'unauthorized']
  for (const status of ['pending', 'sending', 'sent', 'failed_retryable', 'failed_final'])
    for (const error_code of codes)
      assert.equal(UI.kitchenDispatchView({ status, error_code, last_attempt_at: ago(1000) }, NOW), D.dispatchView({ status, error_code }), `${status}/${error_code}`)
  assert.equal(UI.kitchenDispatchView(null, NOW), D.dispatchView(null))
  assert.equal(UI.kitchenDispatchView({ status: 'sending', error_code: null, last_attempt_at: null }, NOW), 'needs_manual_check')
  assert.equal(UI.kitchenDispatchView({ status: 'weird', error_code: null }, NOW), 'needs_manual_check', 'unknown status fails closed')
  for (const v of ['not_dispatched', 'in_progress', 'sent', 'rate_limited_manual_check', 'needs_manual_check', 'failed']) assert.ok(/[א-ת]/.test(UI.DISPATCH_VIEW_LABELS[v]), v)
})

await test('U7. indicative eligibility: cash, confirmed/preparing, no active parcel, not Kfar Adumim / Nofei Prat, food ≤ ₪600', () => {
  const ok = o => UI.dispatchHint(order(o)).canRequest
  assert.equal(ok({}), true)
  assert.equal(ok({ status: 'preparing' }), true)
  for (const status of ['received', 'ready', 'delivered', 'cancelled']) assert.equal(ok({ status }), false, status)
  for (const paymentMethod of ['credit', 'bit', '']) assert.equal(ok({ paymentMethod }), false, paymentMethod)
  assert.equal(ok({ type: 'pickup' }), false); assert.equal(ok({ delivery: null }), false)
  for (const city of ['כפר אדומים', 'נופי פרת']) assert.equal(ok({ delivery: { ...order().delivery, address: `${city}, הדקל 1` } }), false, city)
  assert.equal(ok({ delivery: { ...order().delivery, address: 'מעלה אדומים, כפר אדומים 3' } }), true, 'only the settlement prefix counts')
  assert.equal(ok({ totalPrice: 625 }), true, 'food exactly ₪600 (+₪25 fee)')
  assert.equal(ok({ totalPrice: 625.01 }), false, 'food above ₪600')
  for (const view of ['in_progress', 'sent', 'rate_limited_manual_check', 'needs_manual_check', 'failed'])
    assert.equal(ok({ dispatch: { view, errorCode: null, providerOrderId: null, providerStatus: null } }), false, view)
  const no = UI.dispatchHint(order({ paymentMethod: 'credit' }))
  assert.ok(/[א-ת]/.test(no.reason))
})

await test('U8. confirmation: address, stored fee and cash to collect (food + fee); fee sent in agorot', () => {
  const t = UI.dispatchConfirmText(order({ totalPrice: 92 }), '0007')
  assert.ok(t.includes('#0007') && t.includes('מעלה אדומים, הגעש 6') && t.includes('דמי משלוח: ₪25') && t.includes('גבייה במזומן מהלקוח: ₪92'), t)
  assert.ok(!/0501234567|phone/.test(t))
  assert.equal(UI.expectedFeeAgorot(order()), 2500)
  assert.equal(UI.expectedFeeAgorot({ delivery: { ...order().delivery, deliveryFee: 17.5 } }), 1750)
  assert.equal(UI.expectedFeeAgorot({ delivery: { ...order().delivery, deliveryFee: 0.1 + 0.2 } }), 30)
  assert.equal(UI.expectedFeeAgorot({ delivery: null }), null)
  assert.deepEqual(KD.parseDispatchBody({ expectedFeeAgorot: UI.expectedFeeAgorot(order()) }), { expectedFeeAgorot: 2500 }, 'accepted by the route parser')
})

await test('U9. every server response maps to a Hebrew message; unknown outcomes lock further attempts', () => {
  const required = ['dispatched', 'already_dispatched', 'dispatch_in_progress', 'not_eligible', 'stale_confirmation', 'quote_mismatch', 'manual_review_required',
    'rate_limited', 'provider_auth_failed', 'provider_auth_stopped', 'provider_blocked', 'provider_conflict', 'outcome_unknown', 'state_not_recorded']
  for (const c of required) assert.ok(/[א-ת]/.test(UI.DISPATCH_MESSAGES[c] ?? ''), c)
  // Every response the real route mapping can produce:
  const results = [
    { outcome: 'sent' }, { outcome: 'already_sent' }, { outcome: 'dispatch_in_progress' }, { outcome: 'final_failure_exists' },
    { outcome: 'attempts_exhausted' }, { outcome: 'manual_review_required', reason: 'x' }, { outcome: 'persistence_failed' },
    ...['maale_disabled', 'auth_stop_active', 'order_not_found', 'order_not_confirmed', 'credit_dispatch_disabled', 'parcel_unresolved',
      'parcel_manual_dispatch_required', 'location_manual_review', 'quote_failed', 'fee_mismatch', 'whatever'].map(reason => ({ outcome: 'blocked', reason })),
    { outcome: 'blocked', reason: 'invalid_payload', detail: ['cash_amount_too_high'] }, { outcome: 'blocked', reason: 'invalid_payload', detail: ['invalid_lat'] },
    { outcome: 'failed', ambiguous: true, errorCode: 'timeout' },
    ...['unauthorized', 'blocked', 'idempotency_mismatch', 'rate_limited', 'network_error', 'out_of_area', 'db_error'].map(errorCode => ({ outcome: 'failed', errorCode })),
  ]
  for (const r of results) {
    const m = KD.mapDispatchResult(r)
    const o = UI.interpretDispatchResponse(m.status, m.body)
    assert.ok(/[א-ת]/.test(o.message), JSON.stringify(r))
    assert.ok(!/[a-z]{4,}_[a-z]/.test(o.message), `no raw code in the message: ${o.message}`)
  }
  const lockOf = (status, body) => UI.interpretDispatchResponse(status, body)
  assert.deepEqual(lockOf(200, { result: 'dispatched' }), { ok: true, code: 'dispatched', message: UI.DISPATCH_MESSAGES.dispatched, lock: false, refresh: true })
  assert.equal(lockOf(502, { error: 'manual_review_required', reason: 'outcome_unknown' }).code, 'outcome_unknown')
  assert.equal(lockOf(502, { error: 'manual_review_required', reason: 'outcome_unknown' }).lock, true)
  assert.equal(lockOf(500, { error: 'manual_review_required', reason: 'state_not_recorded' }).code, 'state_not_recorded')
  assert.equal(lockOf(500, { error: 'manual_review_required', reason: 'state_not_recorded' }).lock, true)
  assert.equal(lockOf(429, { error: 'rate_limited' }).lock, true)
  assert.equal(lockOf(409, { error: 'stale_confirmation' }).lock, false, 'stale screen: refresh, may confirm again')
  assert.equal(lockOf(409, { error: 'stale_confirmation' }).refresh, true)
  assert.equal(lockOf(409, { error: 'not_eligible', reason: 'cash_amount_too_high' }).message, 'סכום מזומן מעל ₪600 — יש לתאם טלפונית')
  // Unknown / malformed responses fail closed and never echo the body.
  for (const [s, b] of [[500, null], [502, 'oops'], [418, { error: 'SECRET-provider-body <html>', reason: 'apikey=abc' }], [200, { result: 'maybe' }]]) {
    const o = lockOf(s, b)
    assert.equal(o.ok, false); assert.equal(o.lock, true, JSON.stringify(b))
    assert.ok(!/SECRET|html|apikey|oops/.test(o.message))
  }
  assert.equal(UI.NETWORK_OUTCOME.lock, true); assert.equal(UI.NETWORK_OUTCOME.message, UI.DISPATCH_MESSAGES.outcome_unknown)
})

await test('U10. transition warnings: preparing → ready without a courier; cancel after a (possible) courier request', () => {
  assert.equal(UI.READY_WITHOUT_COURIER_WARNING, 'ההזמנה עדיין ללא שליח. להמשיך למצב מוכנה?')
  assert.equal(UI.CANCEL_AFTER_DISPATCH_WARNING, 'כבר הוזמן שליח. יש ליצור קשר עם מעלה אקספרס לביטול.')
  const d = view => ({ view, errorCode: null, providerOrderId: null, providerStatus: null })
  assert.equal(UI.needsReadyWarning(order({ status: 'preparing' }), 'ready', false), true)
  assert.equal(UI.needsReadyWarning(order({ status: 'preparing', dispatch: d('failed') }), 'ready', false), false, '03O: not eligible in-app any more')
  assert.equal(UI.needsReadyWarning(order({ status: 'preparing', dispatch: d('sent') }), 'ready', false), false)
  assert.equal(UI.needsReadyWarning(order({ status: 'confirmed' }), 'preparing', false), false)
  assert.equal(UI.needsReadyWarning(order({ status: 'preparing', type: 'pickup' }), 'ready', false), false)
  assert.equal(UI.cancelDispatchWarning(order({ dispatch: d('sent') }), false), UI.CANCEL_AFTER_DISPATCH_WARNING)
  for (const v of ['in_progress', 'needs_manual_check', 'rate_limited_manual_check']) assert.equal(UI.cancelDispatchWarning(order({ dispatch: d(v) }), false), UI.CANCEL_MAYBE_DISPATCHED_WARNING, v)
  assert.equal(UI.cancelDispatchWarning(order(), true), UI.CANCEL_MAYBE_DISPATCHED_WARNING, 'locked locally (unknown outcome)')
  assert.equal(UI.cancelDispatchWarning(order(), false), null)
  assert.equal(UI.cancelDispatchWarning(order({ dispatch: d('failed') }), false), null)
  assert.equal(UI.cancelDispatchWarning(order({ type: 'pickup', dispatch: d('sent') }), false), null)
})

await test('U11. helper is client-safe: type-only imports, no env, no DB, no network, no server module', () => {
  const s = src('lib/kitchenDispatchUi.ts')
  const imports = s.match(/^import .*$/gm) ?? []
  assert.ok(imports.every(l => l.startsWith('import type ')), imports.join('\n'))
  assert.ok(!/process\.env|supabase|fetch\(|node:|maale(Client|Payload|Dispatch)|kitchenAuth|kitchenUsers/.test(s))
  assert.ok(!/^import [^t]/m.test(src('lib/kitchenTypes.ts')), 'kitchenTypes stays import-free')
})

console.log('D) Kitchen page')

await test('U12. page: controls only when the session flag is true; one POST with the confirmed fee; warnings; no auto-cancel', () => {
  const p = src('app/dashboard/orders/page.tsx')
  assert.ok(p.includes('dispatchEnabled={session.maaleKitchenDispatchEnabled === true}'))
  assert.ok(p.includes('{dispatchEnabled && onDispatch && isDeliveryOrder(order) && <DispatchPanel'), 'panel gated by the flag')
  assert.ok(/if \(dispatchEnabled\) \{[^}]*?needsReadyWarning\(order, nextStatus, locked\) && !confirm\(READY_WITHOUT_COURIER_WARNING\)/.test(p), 'ready warning only when enabled')
  assert.ok(p.includes('if (dispatchInFlight.current || dispatchBusyId || isDispatchLocked(order)) return'), 'one request at a time; locked orders never resent')
  assert.ok(p.includes('if (!canConfirmDispatch(acknowledged) || isDispatchLocked(order)) return'), 'acknowledgment required before sending')
  assert.ok(p.includes('<button disabled={busy}'), 'button disabled while pending')
  assert.ok(p.includes('outcome = NETWORK_OUTCOME'), 'no answer → unknown outcome, locked')
  assert.equal(p.split('/dispatch`').length - 1, 1)
  assert.ok(!/maaleClient|maalePayload|maaleDispatch|MAALE_|NEXT_PUBLIC_MAALE|providerStatus\}/.test(p), 'no server module, env name or raw provider status in the page')
  assert.ok(!/cancel[^\n]*\/dispatch|DELETE[^\n]*dispatch/i.test(p), 'never cancels at the provider')
  assert.ok(/try \{[^]*?localStorage\.getItem\(DISPATCH_LOCKS_KEY\)[^]*?\} catch/.test(p), 'storage access guarded')
})

console.log('E) S4-03O UX safety refinements')

await test('U14. manual-courier acknowledgment: shown in the confirmation; only strict true allows the final confirm', () => {
  assert.equal(UI.MANUAL_COURIER_CHECK, 'יש לוודא שלא הוזמן כבר שליח טלפונית להזמנה זו.')
  const lines = UI.dispatchConfirmLines(order(), '0007')
  assert.equal(lines.at(-1), UI.MANUAL_COURIER_CHECK)
  assert.ok(UI.dispatchConfirmText(order(), '0007').includes(UI.MANUAL_COURIER_CHECK))
  for (const v of [false, undefined, null, 'true', 1, {}, []]) assert.equal(UI.canConfirmDispatch(v), false, String(v))
  assert.equal(UI.canConfirmDispatch(true), true)
  const p = src('app/dashboard/orders/page.tsx')
  assert.ok(p.includes('const [acknowledged, setAcknowledged] = useState(false)'), 'unticked by default (fresh per order via key)')
  assert.ok(p.includes('const allowed = canConfirmDispatch(acknowledged) && !busy'))
  assert.ok(p.includes('<button type="button" disabled={!allowed} onClick={() => { if (allowed) onConfirm(acknowledged) }}'), 'final button disabled until ticked')
  assert.ok(p.includes('<DispatchConfirmModal key={confirmDispatchOrder.id}'))
  assert.ok(!p.includes('confirm(dispatchConfirmText'), 'no bypassing native confirm left')
  // The panel button only OPENS the confirmation; the POST lives behind submitDispatch.
  assert.ok(/const handleDispatch = \(order: Order\) => \{[^}]*setConfirmDispatchId\(order\.id\)\s*\}/.test(p))
  const submit = p.slice(p.indexOf('const submitDispatch'), p.indexOf('// A server-confirmed'))
  assert.ok(submit.indexOf('canConfirmDispatch(acknowledged)') < submit.indexOf('kitchenPost('), 'acknowledgment checked before the request')
})

await test('U15. submission without acknowledgment never reaches the network (flow model with the real helpers)', async () => {
  let posts = 0
  const flag = { current: false }
  const submit = ack => UI.runExclusive(flag, async () => { if (!UI.canConfirmDispatch(ack)) return 'blocked'; posts++; await new Promise(r => setTimeout(r, 5)); return 'sent' })
  assert.equal(await submit(false), 'blocked'); assert.equal(await submit(undefined), 'blocked'); assert.equal(posts, 0)
  assert.equal(await submit(true), 'sent'); assert.equal(posts, 1)
})

await test('U16. double-click: the synchronous guard runs one submission at a time; released after success and after errors', async () => {
  const flag = { current: false }
  let runs = 0
  const slow = () => UI.runExclusive(flag, async () => { runs++; await new Promise(r => setTimeout(r, 10)); return runs })
  const results = await Promise.all([slow(), slow(), slow()]) // same tick, before any state update
  assert.deepEqual(results, [1, undefined, undefined]); assert.equal(runs, 1); assert.equal(flag.current, false)
  await assert.rejects(UI.runExclusive(flag, async () => { throw new Error('boom') }))
  assert.equal(flag.current, false, 'released after an error')
  assert.equal(await slow(), 2)
  const p = src('app/dashboard/orders/page.tsx')
  assert.ok(p.includes('const dispatchInFlight = useRef(false)'))
  assert.ok(p.includes('const submitDispatch = (order: Order, acknowledged: boolean) => runExclusive(dispatchInFlight, async () => {'))
  assert.ok(p.includes('busy={dispatchBusyId !== null}'), 'modal confirm disabled while a request is pending')
})

await test('U17. ready warning only for in-app-eligible orders with no courier request (never ineligible / failed / ambiguous)', () => {
  const d = view => ({ view, errorCode: null, providerOrderId: null, providerStatus: null })
  const prep = o => order({ status: 'preparing', ...o })
  assert.equal(UI.needsReadyWarning(prep({}), 'ready', false), true)
  const never = [
    ['credit', prep({ paymentMethod: 'credit' })],
    ['active parcel', prep({ parcel: { status: 'found', trackingRef: 'x', carrier: null, recipientName: null } })],
    ['unresolved parcel', prep({ parcel: { status: 'awaiting_search', trackingRef: 'x', carrier: null, recipientName: null } })],
    ['Kfar Adumim', prep({ delivery: { ...order().delivery, address: 'כפר אדומים, הדקל 1' } })],
    ['Nofei Prat', prep({ delivery: { ...order().delivery, address: 'נופי פרת, הדקל 1' } })],
    ['cash cap', prep({ totalPrice: 700 })],
    ['pickup', prep({ type: 'pickup' })],
    ...['in_progress', 'sent', 'rate_limited_manual_check', 'needs_manual_check', 'failed'].map(v => [v, prep({ dispatch: d(v) })]),
  ]
  for (const [name, o] of never) assert.equal(UI.needsReadyWarning(o, 'ready', false), false, name)
  assert.equal(UI.needsReadyWarning(prep({}), 'ready', true), false, 'locally locked (unknown outcome)')
  for (const next of ['delivered', 'cancelled', 'confirmed']) assert.equal(UI.needsReadyWarning(prep({}), next, false), false, next)
  assert.equal(UI.needsReadyWarning(order({ status: 'ready' }), 'delivered', false), false)
  assert.ok(!UI.UI_DISPATCH_STATUSES.includes('ready'), 'dispatch from ready still not enabled')
})

await test('U18. ONE cancellation confirmation: courier notice + phone note when dispatched / uncertain; unchanged otherwise', () => {
  const d = view => ({ view, errorCode: null, providerOrderId: null, providerStatus: null })
  const base = 'לבטל הזמנה #0007?'
  const sent = UI.combinedCancelConfirmText(base, order({ dispatch: d('sent') }), false, true)
  assert.ok(sent.startsWith(base) && sent.includes(UI.CANCEL_AFTER_DISPATCH_WARNING) && sent.includes(UI.CANCEL_PHONE_NOTE))
  for (const v of ['in_progress', 'needs_manual_check', 'rate_limited_manual_check']) {
    const t = UI.combinedCancelConfirmText(base, order({ dispatch: d(v) }), false, true)
    assert.ok(t.includes(UI.CANCEL_MAYBE_DISPATCHED_WARNING) && t.includes(UI.CANCEL_PHONE_NOTE), v)
  }
  assert.ok(UI.combinedCancelConfirmText(base, order(), true, true).includes(UI.CANCEL_MAYBE_DISPATCHED_WARNING), 'local lock')
  assert.equal(UI.combinedCancelConfirmText(base, order(), false, true), base, 'nothing attempted → old text')
  assert.equal(UI.combinedCancelConfirmText(base, order({ dispatch: d('failed') }), false, true), base)
  assert.equal(UI.combinedCancelConfirmText(base, order({ dispatch: d('sent') }), true, false), base, 'flag off → old text')
  assert.ok(/מעלה אקספרס/.test(UI.CANCEL_PHONE_NOTE) && /טלפון/.test(UI.CANCEL_PHONE_NOTE))
  const p = src('app/dashboard/orders/page.tsx')
  assert.ok(p.includes('if(confirm(withCourierNotice(cancelConfirmText(order, num)))) onAdvance(order.id, \'cancelled\')'))
  // Parcel full-cancel: only for 'received' orders (parcel not found) — dispatch needs confirmed / preparing, so no notice.
  assert.ok(/onAction && order\.status === 'received' && p\.status === 'not_found' && \(/.test(p))
  assert.ok(!UI.UI_DISPATCH_STATUSES.includes('received'))
  const adv = p.slice(p.indexOf('const handleAdvance'), p.indexOf('setActionError(\'\')\n    setKitchenOrder'))
  assert.equal((adv.match(/confirm\(/g) ?? []).length, 1, 'handleAdvance has only the ready confirm (no 2nd cancel dialog)')
  assert.ok(!/cancelDispatchWarning/.test(adv))
  assert.equal((p.match(/onAdvance\(order\.id, 'cancelled'\)/g) ?? []).length, 2, 'both cancel paths are the confirmed ones')
})

await test('U19. server "sent" overrides a stale local lock; ambiguous states stay locked across refresh; retention never unlocks', () => {
  const d = view => ({ view, errorCode: null, providerOrderId: 'MX-1', providerStatus: null })
  const lock = { message: UI.DISPATCH_MESSAGES.state_not_recorded, ok: false, locked: true }
  // sent → lock ignored for display and dropped from storage
  assert.equal(UI.effectiveDispatchNote('sent', lock), undefined)
  const notes = { o1: lock, o2: lock }
  const rec = UI.reconcileDispatchNotes(notes, [{ id: 'o1', dispatch: d('sent') }, { id: 'o2', dispatch: d('needs_manual_check') }])
  assert.deepEqual(Object.keys(rec), ['o2'])
  assert.ok(!UI.isDispatchButtonVisible(order({ dispatch: d('sent') }), UI.effectiveDispatchNote('sent', lock)), 'sent: never a button')
  assert.equal(UI.reconcileDispatchNotes(notes, [{ id: 'o1', dispatch: null }]), notes, 'unchanged → same object (no re-render loop)')
  // ambiguous / unknown → lock kept
  for (const v of ['not_dispatched', 'in_progress', 'needs_manual_check', 'rate_limited_manual_check', 'failed'])
    assert.equal(UI.effectiveDispatchNote(v, lock), lock, v)
  assert.equal(UI.isDispatchButtonVisible(order(), lock), false, 'server shows nothing attempted, local lock still wins')
  assert.equal(UI.isDispatchButtonVisible(order(), undefined), true)
  // refresh round trip
  const t0 = Date.parse('2026-10-22T10:00:00Z')
  const raw = UI.serializeDispatchLocks({ o2: lock, ok1: { message: 'x', ok: true, locked: false } }, null, t0)
  assert.deepEqual(UI.parseDispatchLocks(raw, t0 + 1000), { o2: lock }, 'only locked notes persist')
  assert.deepEqual(JSON.parse(UI.serializeDispatchLocks({ o2: lock }, raw, t0 + 5000)).o2.at, t0, 'first lock time kept')
  // retention: 24 h / 48 h later still locked; only after 7 days (order no longer on the board) is it collected
  for (const h of [24, 48, 6 * 24]) assert.equal(UI.parseDispatchLocks(raw, t0 + h * 3600_000).o2?.locked, true, `${h}h`)
  assert.deepEqual(UI.parseDispatchLocks(raw, t0 + UI.DISPATCH_LOCK_RETENTION_MS), {})
  assert.ok(UI.DISPATCH_LOCK_RETENTION_MS >= 7 * 24 * 3600_000)
  for (const bad of [null, '', 'not json', '[]', '5', '{"a":{"message":5,"at":1}}', '{"a":{"message":"m","at":"1"}}']) assert.deepEqual(UI.parseDispatchLocks(bad, t0), {}, String(bad))
  const p = src('app/dashboard/orders/page.tsx')
  assert.ok(p.includes('const note = effectiveDispatchNote(view, localNote)'), 'panel uses the reconciled note')
  assert.ok(/useEffect\(\(\) => \{\s*setDispatchNotes\(prev => \{\s*const next = reconcileDispatchNotes\(prev, orders\)/.test(p), 'storage cleaned when the server shows sent')
  assert.ok(p.includes('{isDispatchButtonVisible(order, note) && ('))
  assert.ok(!/DISPATCH_LOCK_TTL_MS/.test(p), 'old 24 h expiry removed')
})

await test('U20. flag off preserves the old UI: no panel, no modal, no ready warning, old cancel text', () => {
  const p = src('app/dashboard/orders/page.tsx')
  assert.ok(p.includes('{dispatchEnabled && onDispatch && isDeliveryOrder(order) && <DispatchPanel'))
  assert.ok(p.includes('const confirmDispatchOpen = dispatchEnabled && confirmDispatchOrder !== null'))
  assert.ok(p.includes('combinedCancelConfirmText(text, order, dispatchLocked, dispatchEnabled === true)'))
  assert.ok(/if \(dispatchEnabled\) \{[^}]*needsReadyWarning/.test(p))
  const d = { view: 'sent', errorCode: null, providerOrderId: null, providerStatus: null }
  assert.equal(UI.combinedCancelConfirmText('X', order({ dispatch: d }), true, false), 'X')
  // flag off: the read model has no dispatch key → panel inputs are absent
  assert.ok(!('dispatch' in R.normalizeKitchenOrder(baseRow({ delivery_dispatches: [DISPATCH_ROW] }))))
})

await test('U13. no live network call anywhere in this suite', () => {
  assert.equal(liveFetch, 0)
})

console.log(`\nAll ${passed} kitchen dispatch UI checks passed.`)
