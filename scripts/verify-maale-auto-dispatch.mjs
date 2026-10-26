// Local checks for the automatic Maale Express courier request (S4-MAALE-03). Fake network (global fetch throws),
// in-memory queue that mirrors the s4_05 database guard (compare-and-set claim, closed transitions, final states), fake
// Supabase / session for the routes. No DB, no env file, no provider call. The real SQL is exercised by
// scripts/pgtest-s4-05-auto-dispatch-queue.mjs (Docker).   Run: node scripts/verify-maale-auto-dispatch.mjs
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

let liveFetch = 0
globalThis.fetch = async () => { liveFetch++; throw new Error('LIVE NETWORK CALL ATTEMPTED') }

const require = createRequire(import.meta.url)
const ts = require('typescript')
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/* ─── module loader with stubs for the I/O modules of the routes ─── */
const stub = { session: null, sessionCalls: 0, sweepScopes: [], sweepResult: { processed: 0, finished: 0 } }
const fakeKitchenUsers = { async getKitchenSession() { stub.sessionCalls++; return stub.session ?? { ok: false, status: 401, error: 'unauthorized' } } }
const fakeAutoServer = { productionAutoDispatchDeps: () => ({ __fake: true }) }
const cache = new Map()
function loadFile(file, overrides = {}) {
  if (cache.has(file)) return cache.get(file).exports
  const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX } })
  const mod = { exports: {} }; cache.set(file, mod)
  const req = p => {
    const name = p.startsWith('@/lib/') ? p.slice(6) : p.startsWith('./') && file.includes(join(ROOT, 'lib')) ? p.slice(2) : null
    if (name && overrides[name]) return overrides[name]
    if (name === 'kitchenUsers') return fakeKitchenUsers
    if (name === 'kitchenAutoDispatchServer') return fakeAutoServer
    if (name === 'supabaseServer') return { ServerConfigError: class extends Error {}, getServerSupabase() { throw new Error('no DB in this test') } }
    if (name) return loadFile(join(ROOT, 'lib', name + '.ts'))
    return require(p)
  }
  new Function('exports', 'require', 'module', outputText)(mod.exports, req, mod)
  return mod.exports
}
const lib = n => loadFile(join(ROOT, 'lib', n + '.ts'))
const src = f => readFileSync(join(ROOT, f), 'utf8').replace(/\r\n/g, '\n')
const A = lib('kitchenAutoDispatch'), D = lib('maaleDispatch'), client = lib('maaleClient'), cfg = lib('orderConfig')
const UI = lib('kitchenDispatchUi'), KO = lib('kitchenOrders')

let passed = 0
const test = async (name, fn) => { await fn(); passed++; console.log('  ✓', name) }

const ORDER = '11111111-2222-4333-8444-555555555555'
const B1 = cfg.DELIVERY_BRANCH_IDS[0]
const NOW = Date.parse('2026-10-25T12:00:00.000Z')
const iso = ms => new Date(ms).toISOString()

/* ─── in-memory queue (mirrors the s4_05 guard) + worker deps ─── */
function world({ task = {}, order = {}, dispatch, block = null, blockThrows = false, loadThrows = false, repair } = {}) {
  const st = { now: NOW, dispatchCalls: 0, logs: [], scopes: [], repairs: [],
    task: task === null ? null : { order_id: ORDER, branch_id: B1, state: 'queued', reason_code: null, attempts: 0, enqueued_at: iso(NOW - 60_000), claimed_at: null, ...task },
    order: order === null ? null : { id: ORDER, branch_id: B1, status: 'confirmed', type: 'delivery', delivery_fee: 20, ...order } }
  const FINAL = ['dispatched', 'manual', 'investigate', 'skipped']
  const tick = () => new Promise(r => setTimeout(r, 1))
  const deps = {
    async loadTask(id) { await tick(); return id === ORDER && st.task ? { ...st.task } : null },
    async claim(t, nowIso) {
      await tick()
      const r = st.task
      if (!r || r.state !== t.state || r.attempts !== t.attempts) return false                 // compare-and-set
      if (r.state === 'processing' && Date.parse(r.claimed_at) > st.now - 120_000) return false   // guard: not stale
      if (FINAL.includes(r.state)) return false
      Object.assign(r, { state: 'processing', attempts: r.attempts + 1, claimed_at: nowIso }); return true
    },
    async finish(id, from, to, reason) {
      await tick()
      const r = st.task
      if (!r || r.state !== from || FINAL.includes(r.state)) return false
      if (from === 'queued' && to !== 'skipped' && to !== 'processing') throw new Error('guard: invalid transition')
      Object.assign(r, { state: to, reason_code: reason }); return true
    },
    async listDue(scope, staleBefore, limit) {
      st.scopes.push(scope)
      const r = st.task
      const due = r && (r.state === 'queued' || (r.state === 'processing' && r.claimed_at < staleBefore)) && (!scope || scope.includes(r.branch_id))
      return due ? [{ ...r }].slice(0, limit) : []
    },
    async loadOrder() { if (loadThrows) throw new Error('db'); return st.order ? { ...st.order } : null },
    ...(block !== undefined ? { async dispatchBlockingRecord() { if (blockThrows) throw new Error('ledger'); return block } } : {}),
    async dispatch() { st.dispatchCalls++; await tick(); if (typeof dispatch === 'function') return dispatch(); return dispatch ?? { ok: true, outcome: 'sent', kind: 'created' } },
    // S4-MAALE-02 repair, mirroring enqueue_missing_maale_auto_dispatch: check-and-insert without an await between
    // (= PK + ON CONFLICT DO NOTHING); the task is dated with the order's created_at
    ...(repair ? { async repairMissing(scope) {
      st.repairs.push(scope); await tick()
      if (repair.throws) throw new Error('db')
      const o = st.order
      if (st.task || !o || o.type !== 'delivery' || !['confirmed', 'preparing'].includes(o.status) || (scope && !scope.includes(o.branch_id))) return 0
      st.task = { order_id: ORDER, branch_id: o.branch_id, state: 'queued', reason_code: 'repaired', attempts: 0, enqueued_at: iso(repair.createdAt ?? NOW - 60_000), claimed_at: null }
      return 1
    } } : {}),
    now: () => st.now,
    log: c => st.logs.push(c),
  }
  return { st, deps, run: () => A.runAutoDispatch(deps, ORDER), sweep: scope => A.sweepAutoDispatch(deps, scope ?? null),
           afterConfirm: scope => A.runAutoDispatchAfterConfirmation(deps, ORDER, scope ?? null) }
}

console.log('P) Found parcel travels with the food (MAALE_PARCEL_DISPATCH_ENABLED)')

await test('P1. parcelGate: found → ok ONLY with allowFound; unresolved stays unresolved; handed_to_courier and later stay manual', () => {
  for (const s of [null, 'cancelled']) { assert.equal(D.parcelGate(s), 'ok'); assert.equal(D.parcelGate(s, { allowFound: true }), 'ok') }
  for (const s of [undefined, 'awaiting_search', 'not_found', 'invalid']) assert.equal(D.parcelGate(s, { allowFound: true }), 'parcel_unresolved', String(s))
  assert.equal(D.parcelGate('found'), 'parcel_manual_dispatch_required')
  assert.equal(D.parcelGate('found', { allowFound: true }), 'ok')
  for (const s of ['handed_to_courier', 'carrier_verified', 'delivery_problem', 'returned_to_store', 'weird'])
    assert.equal(D.parcelGate(s, { allowFound: true }), 'parcel_manual_dispatch_required', s)
  for (const v of [undefined, '', 'TRUE', '1', 'yes', ' true']) assert.equal(D.isParcelDispatchEnabled({ MAALE_PARCEL_DISPATCH_ENABLED: v }), false, String(v))
  assert.equal(D.isParcelDispatchEnabled({ MAALE_PARCEL_DISPATCH_ENABLED: 'true' }), true)
  assert.match(src('lib/maaleDispatch.ts'), /parcelFoundDispatch: isParcelDispatchEnabled\(process\.env\)/)
  assert.match(src('lib/maaleDispatch.ts'), /evaluate\(loaded, deps\.parcelFoundDispatch === true && !test\)/)   // controlled test runner: food only
})

const snapshot = () => ({
  order: { id: ORDER, type: 'delivery', branch_id: B1, payment_method: 'cash', customer_name: 'לקוח בדיקה', phone: '0500000000', total_price: 73 },
  delivery: { city: 'מעלה אדומים', street: 'הגעש', house_number: '6', apartment: '6', floor: '2', entrance: 'ב׳', notes: 'קוד 1234', delivery_fee: 20, meal_surcharge: 4,
    delivery_lat: 31.773612, delivery_lng: 35.298346, geo_source: 'geocoder', geo_precision: 'street' },
  items: [{ name: 'פלאפל בפיתה', quantity: 1, unit_price: 40 }, { name: 'קוקה קולה', quantity: 1, unit_price: 9 }],
})
function dispatchSetup(parcelStatus, parcelFoundDispatch) {
  const row = { status: 'pending', attempts: 0, last_attempt_at: null, error_code: null }
  const sends = [], quotes = []
  const config = { status: 'ready', apiKey: 'test-key-not-real' }
  const deps = {
    config, parcelFoundDispatch,
    repo: {
      async loadOrder() { return { snapshot: snapshot(), status: 'confirmed', parcelStatus } },
      async getDispatch() { return { order_id: ORDER, external_order_id: ORDER, ...row } },
      async hasRecentAuthFailure() { return false },
      async insertPending() {},
      async claim(id, seen, now) { if (row.status !== 'pending' || row.attempts !== seen.attempts) return 'claim_lost'; Object.assign(row, { status: 'sending', attempts: 1, last_attempt_at: now }); return 'claimed' },
      async markSent() { row.status = 'sent'; return true }, async markAuthFailure() { return false }, async markFailed() { return false },
    },
    send: p => { sends.push(p); return client.sendMaaleOrder(p, { config, fetchImpl: async () => ({ ok: true, status: 201, json: async () => ({ order: { id: 'MX-9', status: 'searching' } }), headers: { get: () => null } }) }) },
    quote: async p => { quotes.push(p); return { ok: true, kind: 'quote', status: 200, zone: 'mishor', deliveryFeeAgorot: 2000, courierPaysMerchantAgorot: 5300, courierCollectsFromCustomerAgorot: 7300, warnings: [] } },
    isPaymentVerified: async () => false, consumeQuoteSlot: async () => 'ok', now: () => iso(NOW), log: () => {},
  }
  return { sends, quotes, run: () => D.dispatchOrderToMaale(ORDER, deps) }
}
await test('P2. dispatch with a FOUND parcel: blocked when the flag is off (nothing sent); sent when on — payload identical to food only', async () => {
  const off = dispatchSetup('found', false)
  assert.deepEqual(await off.run(), { ok: false, outcome: 'blocked', reason: 'parcel_manual_dispatch_required' }); assert.equal(off.sends.length + off.quotes.length, 0)
  const on = dispatchSetup('found', true), food = dispatchSetup(null, false)
  assert.equal((await on.run()).outcome, 'sent'); assert.equal((await food.run()).outcome, 'sent')
  assert.deepEqual(on.sends[0], food.sends[0], 'no parcel field, same food total / items / collection')
  const body = JSON.stringify(on.sends[0])
  assert.ok(!/parcel|tracking|carrier|recipient|חבילה/i.test(body), 'parcel never described to the provider (item line stays disabled)')
  const handed = dispatchSetup('handed_to_courier', true)
  assert.equal((await handed.run()).reason, 'parcel_manual_dispatch_required'); assert.equal(handed.sends.length, 0)
})

console.log('W) Worker: claim, outcome mapping, no retry of an uncertain send')

await test('W1. MAALE_AUTO_DISPATCH_ENABLED: only the exact string true; reserved actor matches the quote-ledger rule', () => {
  for (const v of [undefined, '', 'TRUE', '1', 'yes', 'true ']) assert.equal(A.isAutoDispatchEnabled({ MAALE_AUTO_DISPATCH_ENABLED: v }), false, String(v))
  assert.equal(A.isAutoDispatchEnabled({ MAALE_AUTO_DISPATCH_ENABLED: 'true' }), true)
  assert.match(A.AUTO_DISPATCH_ACTOR, /^[a-z0-9_-]{2,32}$/); assert.equal(A.AUTO_DISPATCH_ACTOR, 'auto-dispatch')
  assert.deepEqual([...A.AUTO_DISPATCH_STATES], ['queued', 'processing', 'dispatched', 'manual', 'investigate', 'skipped'])
  assert.ok(A.AUTO_DISPATCH_STALE_CLAIM_MS > 120_000, 'longer than the database guard (2 min)')
})
await test('W2. happy path: queued → processing (attempt 1) → one dispatch → dispatched', async () => {
  const w = world()
  assert.deepEqual(await w.run(), { result: 'finished', state: 'dispatched', reason: null })
  assert.equal(w.st.dispatchCalls, 1); assert.equal(w.st.task.state, 'dispatched'); assert.equal(w.st.task.attempts, 1)
  assert.deepEqual(await w.run(), { result: 'busy' }); assert.equal(w.st.dispatchCalls, 1, 'a finished task is never processed again')
})
await test('W3. 8 concurrent workers (after() + sweeps + tablets) → exactly ONE claim and ONE dispatch', async () => {
  const w = world()
  const r = await Promise.all(Array.from({ length: 8 }, () => w.run()))
  assert.equal(w.st.dispatchCalls, 1); assert.equal(r.filter(x => x.result === 'finished').length, 1); assert.equal(r.filter(x => x.result === 'busy').length, 7)
})
await test('W4. outcome table: every DispatchResult maps to exactly one task state', () => {
  const C = r => { const x = A.classifyDispatchResult(r); return `${x.state}:${x.reason}` }
  const cases = [
    [{ outcome: 'sent' }, 'dispatched:null'], [{ outcome: 'already_sent' }, 'dispatched:null'],
    [{ outcome: 'dispatch_in_progress' }, 'investigate:dispatch_in_progress'], [{ outcome: 'final_failure_exists' }, 'investigate:previous_failure'],
    [{ outcome: 'attempts_exhausted' }, 'investigate:attempts_exhausted'], [{ outcome: 'manual_review_required', reason: 'stale_sending' }, 'investigate:stale_sending'],
    [{ outcome: 'persistence_failed' }, 'investigate:state_not_recorded'],
    [{ outcome: 'failed', ambiguous: true, errorCode: 'timeout' }, 'investigate:timeout'], [{ outcome: 'failed', errorCode: 'rate_limited' }, 'investigate:rate_limited'],
    [{ outcome: 'failed', errorCode: 'provider_5xx' }, 'investigate:provider_5xx'], [{ outcome: 'failed', errorCode: 'invalid_response' }, 'investigate:invalid_response'],
    [{ outcome: 'failed', errorCode: 'unauthorized' }, 'investigate:unauthorized'], [{ outcome: 'failed', errorCode: 'out_of_area' }, 'manual:out_of_area'],
    [{ outcome: 'failed', ambiguous: true, errorCode: 'out_of_area' }, 'investigate:out_of_area'],
    [{ outcome: 'blocked', reason: 'quote_unavailable' }, 'queued:quote_unavailable'], [{ outcome: 'blocked', reason: 'rate_limited_local' }, 'queued:rate_limited_local'],
    [{ outcome: 'blocked', reason: 'rate_limit_unavailable' }, 'queued:rate_limit_unavailable'], [{ outcome: 'blocked', reason: 'auth_state_unknown' }, 'queued:auth_state_unknown'],
    [{ outcome: 'blocked', reason: 'quote_failed' }, 'queued:quote_failed'],
    [{ outcome: 'blocked', reason: 'order_not_confirmed' }, 'skipped:order_not_confirmed'], [{ outcome: 'blocked', reason: 'order_not_found' }, 'skipped:order_not_found'],
    [{ outcome: 'blocked', reason: 'credit_dispatch_disabled' }, 'manual:credit_dispatch_disabled'], [{ outcome: 'blocked', reason: 'location_manual_review' }, 'manual:location_manual_review'],
    [{ outcome: 'blocked', reason: 'parcel_manual_dispatch_required' }, 'manual:parcel_manual_dispatch_required'], [{ outcome: 'blocked', reason: 'fee_mismatch' }, 'manual:fee_mismatch'],
    [{ outcome: 'blocked', reason: 'auth_stop_active' }, 'manual:auth_stop_active'], [{ outcome: 'blocked', reason: 'maale_disabled' }, 'manual:maale_disabled'],
    [{ outcome: 'blocked', reason: 'manual_courier_recorded' }, 'manual:manual_courier_recorded'], [{ outcome: 'blocked', reason: 'invalid_payload' }, 'manual:invalid_payload'],
  ]
  for (const [r, want] of cases) assert.equal(C(r), want, JSON.stringify(r))
})
await test('W5. an outcome that may have reached the provider is NEVER retried: investigate, then nothing more (run / sweep)', async () => {
  for (const d of [{ ok: false, outcome: 'failed', ambiguous: true, errorCode: 'timeout' }, { ok: false, outcome: 'failed', errorCode: 'rate_limited' },
                   { ok: false, outcome: 'persistence_failed' }, { ok: false, outcome: 'dispatch_in_progress' }, () => { throw new Error('boom') }]) {
    const w = world({ dispatch: d })
    const r = await w.run(); assert.equal(r.state, 'investigate', JSON.stringify(r)); assert.equal(w.st.dispatchCalls, 1)
    w.st.now += 10 * 60_000
    assert.deepEqual(await w.run(), { result: 'busy' }); assert.deepEqual(await w.sweep(), { processed: 0, finished: 0 }); assert.equal(w.st.dispatchCalls, 1)
  }
})
await test('W6. nothing-sent transient (quote unavailable): back to queued, at most 3 attempts in total, then manual', async () => {
  const w = world({ dispatch: { ok: false, outcome: 'blocked', reason: 'quote_unavailable' } })
  assert.deepEqual(await w.run(), { result: 'finished', state: 'queued', reason: 'quote_unavailable' }); assert.equal(w.st.task.attempts, 1)
  assert.equal((await w.run()).state, 'queued'); assert.equal(w.st.task.attempts, 2)
  assert.deepEqual(await w.run(), { result: 'finished', state: 'manual', reason: 'quote_unavailable' }); assert.equal(w.st.task.attempts, 3)
  assert.deepEqual(await w.run(), { result: 'busy' }); assert.equal(w.st.dispatchCalls, 3)
})
await test('W7. a task not started within 30 minutes is skipped (stale) — no dispatch, no claim', async () => {
  const w = world({ task: { enqueued_at: iso(NOW - 31 * 60_000) } })
  assert.deepEqual(await w.run(), { result: 'finished', state: 'skipped', reason: 'stale' }); assert.equal(w.st.dispatchCalls, 0); assert.equal(w.st.task.attempts, 0)
})
await test('W8. stale processing (worker lost): re-claimed after 3 min — the dispatch service decides (in progress → investigate); fresh → busy', async () => {
  const fresh = world({ task: { state: 'processing', attempts: 1, claimed_at: iso(NOW - 60_000) } })
  assert.deepEqual(await fresh.run(), { result: 'busy' }); assert.equal(fresh.st.dispatchCalls, 0)
  const lost = world({ task: { state: 'processing', attempts: 1, claimed_at: iso(NOW - 4 * 60_000) }, dispatch: { ok: false, outcome: 'dispatch_in_progress' } })
  assert.equal((await lost.run()).state, 'investigate'); assert.equal(lost.st.task.attempts, 2); assert.equal(lost.st.dispatchCalls, 1)
  const exhausted = world({ task: { state: 'processing', attempts: 3, claimed_at: iso(NOW - 4 * 60_000) } })
  assert.deepEqual(await exhausted.run(), { result: 'finished', state: 'investigate', reason: 'stale_processing' }); assert.equal(exhausted.st.dispatchCalls, 0)
})
await test('W9. order re-read from the database: cancelled / ready → skipped; not a delivery → manual; missing → skipped; never dispatched', async () => {
  for (const [order, want] of [[{ status: 'cancelled' }, 'skipped:order_status'], [{ status: 'ready' }, 'skipped:order_status'],
    [{ type: 'pickup', delivery_fee: null }, 'manual:not_delivery'], [null, 'skipped:order_not_found']]) {
    const w = world({ order }); const r = await w.run()
    assert.equal(`${r.state}:${r.reason}`, want); assert.equal(w.st.dispatchCalls, 0)
  }
  const down = world({ loadThrows: true }); assert.equal((await down.run()).state, 'queued'); assert.equal(down.st.dispatchCalls, 0)
})
await test('W10. reconciliation: a recorded manual courier / open review → manual (no API courier); unreadable ledger → retry later', async () => {
  for (const b of ['manual_courier_recorded', 'manual_review_open']) {
    const w = world({ block: b }); assert.equal((await w.run()).reason, b); assert.equal(w.st.task.state, 'manual'); assert.equal(w.st.dispatchCalls, 0)
  }
  const w = world({ block: null, blockThrows: true }); assert.equal((await w.run()).state, 'queued'); assert.equal(w.st.dispatchCalls, 0)
})
await test('W11. sweep: only due tasks, in the caller\'s branch scope, oldest first, bounded; errors keep the task', async () => {
  const w = world()
  assert.deepEqual(await w.sweep([B1]), { processed: 1, finished: 1 }); assert.deepEqual(w.st.scopes, [[B1]])
  const other = world(); assert.deepEqual(await other.sweep(['f1e2d3c4-b5a6-4978-8a9b-0c1d2e3f4a5b']), { processed: 0, finished: 0 }); assert.equal(other.st.dispatchCalls, 0)
  const all = world(); await all.sweep(null); assert.deepEqual(all.st.scopes, [null])
  assert.equal(A.AUTO_DISPATCH_SWEEP_LIMIT, 5)
})

console.log('E) Enqueue failure never costs a confirmation (S4-MAALE-02)')

await test('W12. confirmation committed without a task (enqueue failed) → after(): repair in the session scope, then ONE dispatch', async () => {
  const w = world({ task: null, repair: {} })
  assert.deepEqual(await w.afterConfirm([B1]), { result: 'finished', state: 'dispatched', reason: null })
  assert.deepEqual(w.st.repairs, [[B1]]); assert.equal(w.st.dispatchCalls, 1); assert.equal(w.st.task.attempts, 1)
  assert.ok(w.st.logs.includes('auto_dispatch_repaired'))
  const queued = world({ repair: {} }); await queued.afterConfirm([B1]); assert.deepEqual(queued.st.repairs, [], 'a normal enqueue needs no repair')
})
await test('W13. repair unavailable → nothing sent, task stays missing for the next sweep; the sweep still processes due tasks', async () => {
  const w = world({ task: null, repair: { throws: true } })
  assert.deepEqual(await w.afterConfirm([B1]), { result: 'not_queued' }); assert.equal(w.st.dispatchCalls, 0); assert.ok(w.st.logs.includes('auto_dispatch_repair_failed'))
  const s = world({ repair: { throws: true } }); assert.deepEqual(await s.sweep([B1]), { processed: 1, finished: 1 }); assert.equal(s.st.dispatchCalls, 1)
  const fix = world({ task: null, repair: {} }); assert.deepEqual(await fix.sweep([B1]), { processed: 1, finished: 1 }); assert.equal(fix.st.dispatchCalls, 1)
})
await test('W14. repaired task of an OLD order (created 40 min ago) → skipped:stale, no courier; the kitchen sees a warning + manual button', async () => {
  const w = world({ task: null, repair: { createdAt: NOW - 40 * 60_000 } })
  assert.deepEqual(await w.afterConfirm([B1]), { result: 'finished', state: 'skipped', reason: 'stale' }); assert.equal(w.st.dispatchCalls, 0)
  const line = UI.autoDispatchLine({ state: 'skipped', reason: 'stale' })
  assert.deepEqual(line, { text: 'לא הוזמן שליח אוטומטית (עבר זמן רב מאישור ההזמנה)', tone: 'warn' })
  const order = { type: 'delivery', status: 'confirmed', paymentMethod: 'cash', totalPrice: 73, parcel: null, dispatch: null,
    delivery: { address: 'מעלה אדומים, הגעש 6', courierNotes: null, mealQuantity: 1, mealSurcharge: 4, deliveryFee: 20 } }
  assert.equal(UI.isDispatchButtonVisible({ ...order, autoDispatch: { state: 'skipped', reason: 'stale' } }, undefined), true)
})
await test('W15. missing task + 8 concurrent paths (after() + sweeps from several tablets) → ONE task, ONE dispatch', async () => {
  const w = world({ task: null, repair: {} })
  await Promise.all([w.afterConfirm([B1]), ...Array.from({ length: 7 }, () => w.sweep([B1]))])
  assert.equal(w.st.dispatchCalls, 1); assert.equal(w.st.task.state, 'dispatched')
  const scoped = world({ task: null, repair: {} }); await scoped.sweep(['f1e2d3c4-b5a6-4978-8a9b-0c1d2e3f4a5b'])
  assert.equal(scoped.st.task, null, 'another branch never repairs this order'); assert.equal(scoped.st.dispatchCalls, 0)
})

console.log('C) The two delivery flows end to end: queue → worker → real dispatch service (every gate) → fake Maale')

await test('C1. food only: received → confirmed → task → ONE Maale order (cash collection, stored fee, food items); repeat / sweep = nothing more', async () => {
  const m = dispatchSetup(null, false)
  const w = world({ dispatch: () => m.run() })
  assert.deepEqual(await w.run(), { result: 'finished', state: 'dispatched', reason: null })
  assert.equal(m.quotes.length, 1); assert.equal(m.sends.length, 1)
  const p = m.sends[0]
  assert.equal(p.payment_method, 'cash'); assert.equal(p.external_order_id, ORDER)
  assert.ok(Array.isArray(p.items) && p.items.length === 2)
  assert.deepEqual(await w.run(), { result: 'busy' }); await w.sweep([B1]); assert.equal(m.sends.length, 1, 'never a second Maale order')
})
await test('C2. food + FOUND parcel: with MAALE_PARCEL_DISPATCH_ENABLED → ONE Maale order (same food payload); flag OFF → manual, nothing sent', async () => {
  const on = dispatchSetup('found', true), w = world({ dispatch: () => on.run() })
  assert.deepEqual(await w.run(), { result: 'finished', state: 'dispatched', reason: null }); assert.equal(on.sends.length, 1)
  const food = dispatchSetup(null, false); await food.run()
  assert.deepEqual(on.sends[0], food.sends[0], 'same food payload as a food-only order (no parcel line — item line not implemented)')
  const off = dispatchSetup('found', false), w2 = world({ dispatch: () => off.run() })
  assert.deepEqual(await w2.run(), { result: 'finished', state: 'manual', reason: 'parcel_manual_dispatch_required' })
  assert.equal(off.sends.length + off.quotes.length, 0)
  assert.equal(UI.autoDispatchLine({ state: 'manual', reason: 'parcel_manual_dispatch_required' }).text, 'לא הוזמן אוטומטית — יש להזמין שליח ידנית (יש חבילה בהזמנה)')
  const unresolved = dispatchSetup('awaiting_search', true), w3 = world({ dispatch: () => unresolved.run() })
  assert.equal((await w3.run()).state, 'manual'); assert.equal(unresolved.sends.length, 0, 'a parcel not yet found is never dispatched')
})

console.log('R) Routes, read model and kitchen display')

const { NextRequest } = require('next/server')
const ORIGIN = 'https://falafel.test'
const sweepRoute = loadFile(join(ROOT, 'app/api/kitchen/dispatch/sweep/route.ts'))
const post = (h = {}) => sweepRoute.POST(new NextRequest(`${ORIGIN}/api/kitchen/dispatch/sweep`, { method: 'POST', body: '{}',
  headers: { origin: ORIGIN, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...h } }))
await test('R1. sweep route: flag off → 404 before session or DB; CSRF → 400; no session → 401; branch session → own branch only', async () => {
  delete process.env.MAALE_AUTO_DISPATCH_ENABLED; stub.sessionCalls = 0
  let r = await post(); assert.equal(r.status, 404); assert.equal(stub.sessionCalls, 0)
  process.env.MAALE_AUTO_DISPATCH_ENABLED = 'TRUE'; r = await post(); assert.equal(r.status, 404); assert.equal(stub.sessionCalls, 0)
  process.env.MAALE_AUTO_DISPATCH_ENABLED = 'true'
  for (const h of [{ origin: 'https://evil.test' }, { 'sec-fetch-site': 'cross-site' }, { 'content-type': 'text/plain' }]) {
    r = await post(h); assert.equal(r.status, 400, JSON.stringify(h)); assert.equal(stub.sessionCalls, 0)
  }
  stub.session = null; r = await post(); assert.equal(r.status, 401)
  const s = src('app/api/kitchen/dispatch/sweep/route.ts')
  assert.ok(s.indexOf('isAutoDispatchEnabled(process.env)') < s.indexOf('checkSameOriginJson(req)') && s.indexOf('checkSameOriginJson(req)') < s.indexOf('await getKitchenSession(req)'))
  assert.match(s, /auth\.session\.role === 'admin' \? null/); assert.match(s, /\[auth\.session\.branchId\]/)
  assert.ok(!/insert|upsert|delete\(/i.test(s.replace(/^\s*\/\/.*$/gm, '')), 'the route never creates a task')
  delete process.env.MAALE_AUTO_DISPATCH_ENABLED
})
await test('R2. status route: worker scheduled with after() ONLY for a successful → confirmed with the flag; response unchanged', () => {
  const s = src('app/api/kitchen/orders/[id]/status/route.ts')
  assert.match(s, /if \(result\.value\.status === 'confirmed' && isAutoDispatchEnabled\(process\.env\)\) \{\n[^\n]*\n\s+const scope = auth\.session\.role === 'admin' \? null : auth\.session\.branchId \? \[auth\.session\.branchId\] : \[\]\n\s+after\(async \(\) => \{/)
  assert.ok(s.indexOf("if (!result.ok) return json({ error: result.error }, result.status)") < s.indexOf('after(async'), 'only after a successful transition')
  assert.match(s, /\}\n\s+return json\(result\.value\)/)
  assert.equal((s.match(/runAutoDispatchAfterConfirmation\(productionAutoDispatchDeps\(\), id, scope\)/g) || []).length, 1)
  assert.equal((s.match(/runAutoDispatch\(/g) || []).length, 0, 'only the repair-aware run')
  assert.ok(!/maale_auto_dispatch_queue/.test(s), 'the route never writes the queue — the database trigger enqueues atomically')
})
await test('R3. read model: queue embed only with the flag; normalization is field-by-field and fails closed', () => {
  assert.ok(!KO.kitchenOrderSelect(true, true).includes('maale_auto_dispatch_queue'))
  assert.ok(KO.kitchenOrderSelect(true, true, true).endsWith('maale_auto_dispatch_queue(state, reason_code)'))
  assert.deepEqual(KO.normalizeAutoDispatch({ state: 'queued', reason_code: null, extra: 'x' }), { state: 'queued', reason: null })
  assert.deepEqual(KO.normalizeAutoDispatch([{ state: 'manual', reason_code: 'credit_dispatch_disabled' }]), { state: 'manual', reason: 'credit_dispatch_disabled' })
  assert.deepEqual(KO.normalizeAutoDispatch({ state: 'weird', reason_code: 'Bad Code!' }), { state: 'investigate', reason: null })
  for (const v of [null, undefined, [], 'x']) assert.equal(KO.normalizeAutoDispatch(v), null)
  const o = KO.normalizeKitchenOrders([{ id: ORDER, type: 'delivery', status: 'confirmed', branch_id: B1, created_at: 'x', phone: '050', payment_method: 'cash', total_price: 1, order_items: [], maale_auto_dispatch_queue: { state: 'dispatched' } }], { autoDispatch: true })
  assert.deepEqual(o[0].autoDispatch, { state: 'dispatched', reason: null })
  assert.ok(!('autoDispatch' in KO.normalizeKitchenOrders([{ id: ORDER, type: 'delivery', status: 'confirmed', branch_id: B1, created_at: 'x', phone: '050', payment_method: 'cash', total_price: 1, order_items: [] }])[0]))
  const r = src('app/api/kitchen/orders/route.ts')
  assert.match(r, /kitchenOrderSelect\(dispatchEnabled, reconciliationVisible, autoDispatch\)/); assert.match(r, /const autoDispatch = isAutoDispatchEnabled\(process\.env\)/)
})
await test('R4. kitchen display: statuses queued / sending / sent / manual / investigate; manual button only for exceptions; sweep only while waiting', () => {
  assert.equal(UI.autoDispatchLine({ state: 'queued', reason: null }).text, 'שליח יוזמן אוטומטית…')
  assert.equal(UI.autoDispatchLine({ state: 'processing', reason: null }).tone, 'info')
  assert.deepEqual(UI.autoDispatchLine({ state: 'dispatched', reason: null }), { text: 'השליח הוזמן אוטומטית ✓', tone: 'ok' })
  assert.deepEqual(UI.autoDispatchLine({ state: 'manual', reason: 'credit_dispatch_disabled' }), { text: 'לא הוזמן אוטומטית — יש להזמין שליח ידנית (תשלום באשראי)', tone: 'warn' })
  assert.equal(UI.autoDispatchLine({ state: 'investigate', reason: 'timeout' }).tone, 'alert')
  assert.equal(UI.autoDispatchLine(null), null)
  const order = { type: 'delivery', status: 'confirmed', paymentMethod: 'cash', totalPrice: 73, parcel: null, dispatch: null,
    delivery: { address: 'מעלה אדומים, הגעש 6', courierNotes: null, mealQuantity: 1, mealSurcharge: 4, deliveryFee: 20 } }
  assert.equal(UI.isDispatchButtonVisible(order, undefined), true)
  for (const s of ['queued', 'processing', 'dispatched', 'investigate']) assert.equal(UI.isDispatchButtonVisible({ ...order, autoDispatch: { state: s, reason: null } }, undefined), false, s)
  for (const s of ['manual', 'skipped']) assert.equal(UI.isDispatchButtonVisible({ ...order, autoDispatch: { state: s, reason: 'x' } }, undefined), true, s)
  assert.equal(UI.needsAutoDispatchSweep([{ autoDispatch: { state: 'dispatched' } }, {}]), false)
  assert.equal(UI.needsAutoDispatchSweep([{ autoDispatch: { state: 'queued' } }]), true)
  // S4-MAALE-02: a confirmed / preparing delivery with neither task nor courier record → sweep (its repair) runs
  for (const status of ['confirmed', 'preparing']) assert.equal(UI.needsAutoDispatchSweep([{ type: 'delivery', status, dispatch: null, autoDispatch: null }]), true, status)
  for (const o of [{ type: 'delivery', status: 'confirmed', dispatch: { status: 'sent' }, autoDispatch: null },     // courier exists
                   { type: 'delivery', status: 'confirmed', dispatch: null },                                     // feature off: key absent
                   { type: 'delivery', status: 'received', dispatch: null, autoDispatch: null },
                   { type: 'delivery', status: 'ready', dispatch: null, autoDispatch: null },
                   { type: 'pickup', status: 'confirmed', dispatch: null, autoDispatch: null }])
    assert.equal(UI.needsAutoDispatchSweep([o]), false, JSON.stringify(o))
  const page = src('app/dashboard/orders/page.tsx')
  assert.match(page, /kitchenPost\('\/api\/kitchen\/dispatch\/sweep', \{\}\)/); assert.match(page, /res\.status === 404\) \{ sweepOff\.current = true/)
})
await test('R6. logs carry short codes only: no tracking reference, phone, name, address, recipient or provider body', async () => {
  const files = ['lib/kitchenAutoDispatch.ts', 'lib/kitchenAutoDispatchServer.ts', 'app/api/kitchen/dispatch/sweep/route.ts', 'app/api/kitchen/orders/[id]/status/route.ts']
  const SENSITIVE = /tracking|phone|customer|recipient|address|carrier|delivery_fee|body|payload|snapshot|street|city/i
  for (const f of files) {
    const logLines = src(f).split('\n').filter(l => /\b(log|deps\.log|console\.(warn|error|log|info))\(/.test(l))
    for (const l of logLines) assert.ok(!SENSITIVE.test(l.replace(/\/\/.*$/, '')), `${f}: ${l.trim()}`)
  }
  // every logged reason passes the same bounded code rule as the queue's reason_code CHECK
  const w = world({ dispatch: { ok: false, outcome: 'failed', errorCode: 'Some Provider Text: 0501234567' } })
  await w.run()
  assert.equal(w.st.task.reason_code, 'unspecified'); assert.ok(w.st.logs.every(c => /^[a-z0-9_:]+$/.test(c)), w.st.logs.join(','))
  // the server wiring's error messages are codes only (never e.message of a provider / DB text)
  assert.ok(!/e\.message|error\.message|details|hint/.test(src('lib/kitchenAutoDispatchServer.ts')))
})
await test('R7. defaults: every new switch is OFF — env flags exact "true" only; the database switch row starts false', () => {
  assert.equal(A.isAutoDispatchEnabled({}), false); assert.equal(D.isParcelDispatchEnabled({}), false)
  const sql = readFileSync(join(ROOT, 'db/migrations/s4_05_maale_auto_dispatch_queue.sql'), 'utf8')
  assert.match(sql, /enqueue_enabled  boolean     NOT NULL DEFAULT false/)
  assert.match(sql, /VALUES \(true, false\);/)
  assert.ok(!/MAALE_AUTO_DISPATCH_ENABLED|MAALE_PARCEL_DISPATCH_ENABLED/.test(src('next.config.ts')), 'no build-time default')
})
await test('R5. HYP untouched; parcel item line not implemented; no live network call', () => {
  // Canonical baseline = the released code (origin/main), not a local `main` that may lag behind it (S4-MAALE-02).
  const base = execFileSync('git', ['merge-base', 'HEAD', 'origin/main'], { cwd: ROOT, encoding: 'utf8' }).trim()
  // HYP capture / VERIFY / the payment ledger are never touched; HYP-DELIVERY-02 may change ONLY its reviewed HYP files
  assert.equal(execFileSync('git', ['diff', '--name-only', base, '--', 'api/hyp-return.js', 'lib/hyp/hypCapture.ts', 'lib/hyp/hypClient.ts', 'lib/hyp/hypProtocol.ts', 'lib/hyp/hypConfig.ts', 'db/migrations/hyp05_payment_intents.sql', 'app/api/payments'], { cwd: ROOT, encoding: 'utf8' }).trim(), '')
  const HYP_DELIVERY_FILES = ['app/order/page.tsx', 'lib/hyp/hypCheckoutUi.ts', 'lib/hyp/hypDb.ts', 'lib/hyp/hypDeps.ts', 'lib/hyp/hypFlags.ts', 'lib/hyp/hypPaymentService.ts', 'lib/hyp/hypRefundFlag.ts']
  for (const f of execFileSync('git', ['diff', '--name-only', base, '--', 'lib/hyp', 'app/order'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean))
    assert.ok(HYP_DELIVERY_FILES.includes(f), `unexpected HYP change: ${f}`)
  for (const f of execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', 'lib/hyp', 'app/order'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean))
    assert.ok(HYP_DELIVERY_FILES.includes(f), `unexpected new HYP file: ${f}`)
  assert.ok(!/MAALE_PARCEL_ITEM_LINE_ENABLED|parcelLine/.test(src('lib/maalePayload.ts') + src('lib/maaleDispatch.ts')))
  assert.equal(liveFetch, 0)
})

console.log(`\nAll ${passed} maale auto-dispatch checks passed.`)
