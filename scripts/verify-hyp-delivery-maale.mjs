// HYP-DELIVERY-02 offline checks — Maale side of HYP-prepaid deliveries and the refund-required flag:
// verified 'online' → ONE courier order as prepaid 'credit' (courier collects nothing); unverified / unknown → nothing
// sent; telephone credit still blocked; cash payload byte-identical to the release (924e076); prepaid quote collecting
// money → blocked; found parcel → same payload; auto-dispatch mapping; a cancelled prepaid order is FLAGGED, never refunded.
// FAKE network + in-memory repos; the real global fetch throws.   Run: node scripts/verify-hyp-delivery-maale.mjs
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

let liveFetch = 0
globalThis.fetch = async () => { liveFetch++; throw new Error('LIVE NETWORK CALL ATTEMPTED') }
const require = createRequire(import.meta.url)
const ts = require('typescript')
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RELEASE = '924e07622536cfeda13b1be7cf0e0adf4c3f7e5e'   // Production before HYP-DELIVERY-02
const lf = s => s.replace(/\r\n/g, '\n')
const src = f => lf(readFileSync(join(ROOT, f), 'utf8'))
/** Loads a lib module from the working tree, or (rev) from a git revision — both with their own module cache. */
function loader(rev) {
  const cache = new Map()
  const read = p => rev ? execFileSync('git', ['show', `${rev}:${p}`], { cwd: ROOT, encoding: 'utf8' }) : readFileSync(join(ROOT, p), 'utf8')
  const load = p => {
    if (cache.has(p)) return cache.get(p).exports
    const { outputText } = ts.transpileModule(read(p), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } })
    const mod = { exports: {} }; cache.set(p, mod)
    const req = s => s.startsWith('./') || s.startsWith('../') ? load(join(dirname(p), s).replace(/\\/g, '/') + '.ts') : s.startsWith('@/') ? load(s.slice(2) + '.ts') : require(s)
    new Function('exports', 'require', 'module', outputText)(mod.exports, req, mod)
    return mod.exports
  }
  return load
}
const L = loader(null), REL = loader(RELEASE)
const D = L('lib/maaleDispatch.ts'), P = L('lib/maalePayload.ts'), client = L('lib/maaleClient.ts'), cfg = L('lib/orderConfig.ts')
const A = L('lib/kitchenAutoDispatch.ts'), RF = L('lib/hyp/hypRefundFlag.ts')

let passed = 0
const test = async (name, fn) => { await fn(); passed++; console.log('  ✓', name) }

const ORDER_ID = '11111111-2222-4333-8444-555555555555', NOW = '2026-10-26T10:00:00.000Z', KEY = 'test-maale-key-not-real'
const snapshot = ({ order = {}, delivery = {}, items } = {}) => ({
  order: { id: ORDER_ID, type: 'delivery', branch_id: cfg.DELIVERY_BRANCH_IDS[0], payment_method: 'online', customer_name: 'לקוח בדיקה', phone: '0500000000', total_price: 73, ...order },
  delivery: { city: 'מעלה אדומים', street: 'הגעש', house_number: '6', apartment: '6', floor: '2', entrance: 'ב׳', notes: 'קוד 1234', delivery_fee: 20, meal_surcharge: 4,
    delivery_lat: 31.773612, delivery_lng: 35.298346, geo_source: 'geocoder', geo_precision: 'street', ...delivery },
  items: items ?? [{ name: 'פלאפל בפיתה', quantity: 1, unit_price: 40 }, { name: 'קוקה קולה', quantity: 1, unit_price: 9 }],
})
const prepaidQuote = (o = {}) => ({ ok: true, kind: 'quote', status: 200, zone: 'mishor', deliveryFeeAgorot: 2000, warnings: [], ...o })
const cashQuote = { ok: true, kind: 'quote', status: 200, zone: 'mishor', deliveryFeeAgorot: 2000, courierPaysMerchantAgorot: 5300, courierCollectsFromCustomerAgorot: 7300, warnings: [] }
const tick = () => new Promise(r => setTimeout(r, 1))
function setup({ snap = snapshot(), verified = true, quote = prepaidQuote(), parcelStatus = null, parcelFoundDispatch = false } = {}) {
  const st = { row: null, writes: 0, sends: [], quotes: [], checks: 0 }
  const repo = {
    async loadOrder(id) { return id === ORDER_ID ? { snapshot: snap, status: 'confirmed', parcelStatus } : null },
    async getDispatch() { const r = st.row; return r ? { ...r } : null },
    async hasRecentAuthFailure() { return false },
    async insertPending(id) { st.writes++; if (!st.row) st.row = { order_id: id, external_order_id: id, status: 'pending', attempts: 0, last_attempt_at: null, error_code: null } },
    async claim(id, seen, now) { st.writes++; await tick(); const r = st.row; if (!r || r.status !== seen.status || r.attempts !== seen.attempts) return 'claim_lost'; Object.assign(r, { status: 'sending', attempts: r.attempts + 1, last_attempt_at: now }); return 'claimed' },
    async markSent() { st.writes++; st.row.status = 'sent'; return true },
    async markAuthFailure() { return false }, async markFailed() { st.writes++; return false },
  }
  const config = { status: 'ready', apiKey: KEY }
  const deps = {
    config, repo, parcelFoundDispatch,
    send: p => { st.sends.push(p); return client.sendMaaleOrder(p, { config, fetchImpl: async () => ({ ok: true, status: 201, json: async () => ({ order: { id: 'MX-9', status: 'searching' } }), headers: { get: () => null } }) }) },
    quote: async p => { st.quotes.push(p); return typeof quote === 'function' ? quote(p) : quote },
    ...(verified === 'missing' ? {} : { isPaymentVerified: async () => { st.checks++; if (verified === 'throw') throw new Error('db down'); return verified } }),
    consumeQuoteSlot: async () => 'ok', now: () => NOW, log: () => {},
  }
  return { st, run: () => D.dispatchOrderToMaale(ORDER_ID, deps) }
}
const nothing = (s, l) => { assert.equal(s.st.sends.length, 0, `${l}: no send`); assert.equal(s.st.quotes.length, 0, `${l}: no quote`); assert.equal(s.st.writes, 0, `${l}: no write`) }

console.log('M) HYP-prepaid delivery → Maale')
await test('M1. verified HYP payment → ONE courier order, payment_method credit (courier collects nothing); repeat sends nothing more', async () => {
  const s = setup(); const r = await s.run()
  assert.equal(r.outcome, 'sent', JSON.stringify(r)); assert.equal(s.st.sends.length, 1); assert.equal(s.st.checks, 1)
  assert.equal(s.st.sends[0].payment_method, 'credit'); assert.equal(s.st.sends[0].food_total_agorot, 5300)
  assert.equal((await s.run()).outcome, 'already_sent'); assert.equal(s.st.sends.length, 1)
})
await test('M2. NOT verified / check unavailable / no checker → nothing sent, no quote, no write (manual or retry later)', async () => {
  const a = setup({ verified: false }); assert.deepEqual(await a.run(), { ok: false, outcome: 'blocked', reason: 'payment_not_verified' }); nothing(a, 'unverified')
  const b = setup({ verified: 'throw' }); assert.deepEqual(await b.run(), { ok: false, outcome: 'blocked', reason: 'payment_state_unknown' }); nothing(b, 'unknown')
  const c = setup({ verified: 'missing' }); assert.equal((await c.run()).reason, 'payment_not_verified'); nothing(c, 'missing')
  const d = setup({ verified: 'yes' }); assert.equal((await d.run()).reason, 'payment_not_verified', 'only a literal true verifies'); nothing(d, 'truthy')
})
await test('M3. telephone credit stays blocked even when a payment check says true (credit_dispatch_disabled)', async () => {
  const s = setup({ snap: snapshot({ order: { payment_method: 'credit' } }), verified: true })
  assert.deepEqual(await s.run(), { ok: false, outcome: 'blocked', reason: 'credit_dispatch_disabled' }); nothing(s, 'credit'); assert.equal(s.st.checks, 0)
})
await test('M4. prepaid quote that would COLLECT from the customer → blocked (quote_amount_mismatch), nothing sent; 0 / absent → sent', async () => {
  const bad = setup({ quote: prepaidQuote({ courierCollectsFromCustomerAgorot: 7300 }) })
  const r = await bad.run(); assert.equal(r.outcome, 'blocked'); assert.equal(r.reason, 'quote_amount_mismatch'); assert.equal(bad.st.sends.length, 0)
  assert.equal((await setup({ quote: prepaidQuote({ courierCollectsFromCustomerAgorot: 0 }) }).run()).outcome, 'sent')
  assert.equal((await setup({ quote: prepaidQuote() }).run()).outcome, 'sent')
  assert.deepEqual(D.checkQuote(prepaidQuote({ courierCollectsFromCustomerAgorot: 1 }), { payment_method: 'credit', food_total_agorot: 5300 }, 20),
                   { ok: false, reason: 'quote_amount_mismatch', detail: 'prepaid_collects_from_customer' })
})
await test('M5. food + FOUND parcel (MAALE_PARCEL_DISPATCH_ENABLED) → the SAME standard prepaid payload as food only; flag off → manual', async () => {
  const food = setup(); await food.run()
  const parcel = setup({ parcelStatus: 'found', parcelFoundDispatch: true }); assert.equal((await parcel.run()).outcome, 'sent')
  assert.deepEqual(parcel.st.sends[0], food.st.sends[0])
  assert.ok(!/parcel|tracking|carrier|recipient|חבילה/i.test(JSON.stringify(parcel.st.sends[0])))
  const off = setup({ parcelStatus: 'found', parcelFoundDispatch: false }); assert.equal((await off.run()).reason, 'parcel_manual_dispatch_required'); assert.equal(off.st.sends.length, 0)
  const nf = setup({ parcelStatus: 'not_found', parcelFoundDispatch: true }); assert.equal((await nf.run()).outcome, 'blocked'); assert.equal(nf.st.sends.length, 0)
})
await test('M6. CASH payload byte-identical to the release (924e076) for every cash order shape; cash quote checks unchanged', async () => {
  const Prel = REL('lib/maalePayload.ts')
  const shapes = [snapshot({ order: { payment_method: 'cash' } }), snapshot({ order: { payment_method: 'cash', total_price: 680 }, items: [{ name: 'מגש', quantity: 1, unit_price: 656 }] }),
    snapshot({ order: { payment_method: 'cash' }, delivery: { apartment: null, floor: null, entrance: null, notes: null } }),
    snapshot({ order: { payment_method: 'cash' }, delivery: { delivery_lat: null } }), snapshot({ order: { payment_method: 'bit' } }), snapshot({ order: { payment_method: 'credit' } })]
  for (const s of shapes) assert.deepEqual(P.buildMaaleOrderPayload(s), Prel.buildMaaleOrderPayload(s), JSON.stringify(s.order))
  const Drel = REL('lib/maaleDispatch.ts')
  const cashPayload = P.buildMaaleOrderPayload(snapshot({ order: { payment_method: 'cash' } })).payload
  for (const q of [cashQuote, { ...cashQuote, courierCollectsFromCustomerAgorot: 1 }, { ...cashQuote, courierPaysMerchantAgorot: 1 }, { ...cashQuote, deliveryFeeAgorot: 1 }])
    assert.deepEqual(D.checkQuote(q, cashPayload, 20), Drel.checkQuote(q, cashPayload, 20))
})
await test('M7. prepaid has no ₪600 cash cap (the provider limit is cash only); online payload otherwise equals the credit one', async () => {
  const big = snapshot({ order: { total_price: 700 }, items: [{ name: 'מגש', quantity: 1, unit_price: 676 }] })
  assert.equal(P.buildMaaleOrderPayload(big).ok, true)
  assert.equal(P.buildMaaleOrderPayload({ ...big, order: { ...big.order, payment_method: 'cash' } }).ok, false)
  assert.deepEqual(P.buildMaaleOrderPayload(snapshot()), P.buildMaaleOrderPayload(snapshot({ order: { payment_method: 'credit' } })))
})
await test('M8. auto-dispatch: not verified → manual (staff decide); check unavailable → queued (retry, nothing sent); kitchen route mapping', () => {
  assert.deepEqual(A.classifyDispatchResult({ ok: false, outcome: 'blocked', reason: 'payment_not_verified' }), { state: 'manual', reason: 'payment_not_verified' })
  assert.deepEqual(A.classifyDispatchResult({ ok: false, outcome: 'blocked', reason: 'payment_state_unknown' }), { state: 'queued', reason: 'payment_state_unknown' })
  const k = src('lib/kitchenDispatch.ts')
  assert.ok(k.includes("case 'payment_not_verified': return reply(409, { error: 'not_eligible', reason: 'payment_not_verified' })"))
  assert.ok(k.includes("case 'payment_state_unknown': return reply(503, { error: 'dispatch_unavailable' })"))
  const UI = L('lib/kitchenDispatchUi.ts')
  assert.match(UI.autoDispatchLine({ state: 'manual', reason: 'payment_not_verified' }).text, /התשלום המקוון לא אומת/)
})
await test('M9. controlled-test readiness: an unverified online order is never "safe"', async () => {
  const repo = { async loadOrder() { return { snapshot: snapshot({ order: { customer_name: '🧪 בדיקה — לא לשלוח' } }), status: 'confirmed', parcelStatus: null } },
                 async getDispatch() { return null }, async hasRecentAuthFailure() { return false } }
  const r = await D.assessMaaleTestReadiness(ORDER_ID, { config: { status: 'ready', apiKey: KEY }, repo, now: () => NOW })
  assert.ok(r.blockers.includes('payment_not_verified')); assert.equal(r.safeForControlledTest, false)
  const ok = await D.assessMaaleTestReadiness(ORDER_ID, { config: { status: 'ready', apiKey: KEY }, repo, isPaymentVerified: async () => true, now: () => NOW })
  assert.ok(!ok.blockers.includes('payment_not_verified'))
})

console.log('R) Cancelled prepaid order → refund REQUIRED flag (never a refund)')
function flagDeps({ intent = 'int-1', lookupThrows = false, answers = ['recorded'] } = {}) {
  const st = { lookups: 0, flags: [], logs: [] }; let i = 0
  return { st, deps: {
    async findFinalizedIntent(orderId) { st.lookups++; if (lookupThrows) throw new Error('db'); return intent },
    async flagRefundRequired(id, staff, note) { st.flags.push({ id, staff, note }); const a = answers[Math.min(i++, answers.length - 1)]; if (a === 'throw') throw new Error('db'); return a },
    log: c => st.logs.push(c) } }
}
await test('R1. finalized HYP payment of a cancelled order → flag_refund_required once (staff = kitchen account, fixed note); not prepaid → nothing', async () => {
  const a = flagDeps(); assert.equal(await RF.flagRefundForCancelledOrder(a.deps, ORDER_ID, 'adumim'), 'recorded')
  assert.deepEqual(a.st.flags, [{ id: 'int-1', staff: 'adumim', note: RF.REFUND_FLAG_NOTE }])
  const b = flagDeps({ intent: null }); assert.equal(await RF.flagRefundForCancelledOrder(b.deps, ORDER_ID, 'adumim'), 'not_prepaid'); assert.equal(b.st.flags.length, 0)
  const c = flagDeps({ answers: ['already_flagged'] }); assert.equal(await RF.flagRefundForCancelledOrder(c.deps, ORDER_ID, 'adumim'), 'already_flagged')
})
await test('R2. failures are bounded: lookup error → no flag call; one retry on a transient error; refusal codes reported, never retried', async () => {
  const a = flagDeps({ lookupThrows: true }); assert.equal(await RF.flagRefundForCancelledOrder(a.deps, ORDER_ID, 'adumim'), 'failed'); assert.equal(a.st.flags.length, 0)
  const b = flagDeps({ answers: ['throw', 'recorded'] }); assert.equal(await RF.flagRefundForCancelledOrder(b.deps, ORDER_ID, 'adumim'), 'recorded'); assert.equal(b.st.flags.length, 2)
  const c = flagDeps({ answers: ['throw'] }); assert.equal(await RF.flagRefundForCancelledOrder(c.deps, ORDER_ID, 'adumim'), 'failed'); assert.equal(c.st.flags.length, 2)
  const d = flagDeps({ answers: ['invalid_state'] }); assert.equal(await RF.flagRefundForCancelledOrder(d.deps, ORDER_ID, 'adumim'), 'refused'); assert.equal(d.st.flags.length, 1)
  const e = flagDeps(); assert.equal(await RF.flagRefundForCancelledOrder(e.deps, ORDER_ID, 'Bad Actor!'), 'refused'); assert.equal(e.st.lookups, 0)
})
await test('R3. the kitchen status route: flag ONLY after a successful cancel of an ONLINE order, after the response, action flag_refund_required only — never a refund', () => {
  const s = src('app/api/kitchen/orders/[id]/status/route.ts')
  assert.match(s, /select\('id, status, branch_id, payment_method, parcel_requests\(status\)'\)/)
  assert.match(s, /if \(result\.value\.status === 'cancelled' && paymentMethod === 'online'\) \{/)
  assert.ok(s.indexOf("if (!result.ok) return json({ error: result.error }, result.status)") < s.indexOf("result.value.status === 'cancelled'"))
  assert.match(s, /after\(async \(\) => \{\n\s+try \{\n\s+await flagRefundForCancelledOrder\(/)
  assert.match(s, /p_action: 'flag_refund_required'/)
  assert.ok(!/p_action: '(refund|void|record_refund|clear_flag|portal_paid)'/.test(s), 'no refund / void / clear action')
  const m = src('lib/hyp/hypRefundFlag.ts').replace(/^\s*\/\/.*$/gm, '')
  assert.ok(!/rpc\(|fetch\(|record_refund|'refund'/.test(m), 'the module only calls its injected flag function')
  assert.equal((s.match(/return json\(result\.value\)/g) || []).length, 1, 'response unchanged')
})
await test('R4. production payment check: finalized + paid_source verify + no staff flag (a refund-flagged payment is never dispatched)', () => {
  const md = src('lib/maaleDispatch.ts')
  assert.match(md, /\.eq\('order_id', orderId\)\.eq\('status', 'finalized'\)\.eq\('paid_source', 'verify'\)\.is\('staff_flag', null\)\.limit\(2\)/)
  assert.ok(md.includes('isPaymentVerified: orderId => isHypPaymentVerified(orderId),'))
  assert.equal(liveFetch, 0)
})

console.log(`\nAll ${passed} HYP-DELIVERY-02 Maale / refund-flag checks passed (no network).`)
