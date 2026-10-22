// Offline checks for the hardened Maale dispatch orchestration (S4-INTEGRATIONS-03F): cash-only eligibility, parcel and
// location gates, the dry_run quote check, global 401 stop, 429 timing, ambiguous outcomes → manual review, and exact-row
// persistence. FAKE fetch + FAKE quote + in-memory delivery_dispatches only; the real global fetch is a throwing stub.
// Run: node scripts/verify-maale-dispatch-03f.mjs

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
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

const cfg = load('orderConfig')
const client = load('maaleClient')
const D = load('maaleDispatch')

let passed = 0
const test = async (name, fn) => { await fn(); passed++; console.log('  ✓', name) }

/* ─── FAKE fixtures ─── */
const ORDER_ID = '11111111-2222-4333-8444-555555555555'
const KEY = 'test-maale-key-not-real'
const NOW = '2026-10-22T10:00:00.000Z'
const at = (sec) => new Date(Date.parse(NOW) + sec * 1000).toISOString()
const PII = ['לקוח בדיקה', '0500000000', 'הגעש', 'קוד 1234']
const snapshot = ({ order = {}, delivery = {}, items } = {}) => ({
  order: { id: ORDER_ID, type: 'delivery', branch_id: cfg.DELIVERY_BRANCH_IDS[0], payment_method: 'cash', customer_name: 'לקוח בדיקה', phone: '0500000000', total_price: 73, ...order },
  delivery: { city: 'מעלה אדומים', street: 'הגעש', house_number: '6', apartment: '6', floor: '2', entrance: 'ב׳', notes: 'קוד 1234', delivery_fee: 20, meal_surcharge: 4,
    delivery_lat: 31.773612, delivery_lng: 35.298346, geo_source: 'geocoder', geo_precision: 'street', ...delivery },
  items: items ?? [{ name: 'פלאפל בפיתה', quantity: 1, unit_price: 40 }, { name: 'קוקה קולה', quantity: 1, unit_price: 9 }],
})
// food 49 + 4 = ₪53 → 5300; fee ₪20 → 2000; courier collects 7300 in cash
const okQuote = (over = {}) => ({ ok: true, kind: 'quote', status: 200, zone: 'mishor', deliveryFeeAgorot: 2000,
  courierPaysMerchantAgorot: 5300, courierCollectsFromCustomerAgorot: 7300, warnings: [], ...over })
const jsonRes = (body, status, headers = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body, headers: { get: h => headers[h.toLowerCase()] ?? null } })
const tick = () => new Promise(r => setTimeout(r, 1))

/** In-memory delivery_dispatches with the SQL guarantees (unique order_id, CAS claim, exact-row marks). */
function memRepo({ status = 'confirmed', row = null, orderSnapshot = snapshot(), parcelStatus = null, otherAuthFailureAt = null, marks = true } = {}) {
  const state = { row: row ? { external_order_id: ORDER_ID, attempts: 0, last_attempt_at: null, error_code: null, provider_order_id: null, provider_status: null, dispatched_at: null, updated_at: null, ...row, order_id: ORDER_ID } : null,
    writes: 0, reads: 0, orderSnapshot }
  const repo = {
    async loadOrder(id) {
      state.reads++
      if (id !== ORDER_ID) return null
      return parcelStatus === 'omit' ? { snapshot: state.orderSnapshot, status } : { snapshot: state.orderSnapshot, status, parcelStatus } // 'omit' = not loaded
    },
    async getDispatch(id) {
      state.reads++
      const r = state.row
      return r && id === ORDER_ID ? { order_id: id, external_order_id: r.external_order_id, status: r.status, attempts: r.attempts, last_attempt_at: r.last_attempt_at, error_code: r.error_code } : null
    },
    async hasRecentAuthFailure(since) {
      state.reads++
      const mine = state.row && state.row.error_code === 'unauthorized' && state.row.updated_at >= since
      return !!mine || (otherAuthFailureAt !== null && otherAuthFailureAt >= since)
    },
    async insertPending(id) { state.writes++; if (!state.row) state.row = { order_id: id, external_order_id: id, status: 'pending', attempts: 0, last_attempt_at: null, error_code: null, provider_order_id: null, provider_status: null, dispatched_at: null, updated_at: NOW } },
    async claim(id, seen, now) {
      state.writes++; await tick()
      const r = state.row
      if (!r || r.status !== seen.status || r.attempts !== seen.attempts || r.last_attempt_at !== seen.last_attempt_at) return false
      if (seen.attempts + 1 > 20) throw new Error('attempts_check')
      Object.assign(r, { status: 'sending', attempts: seen.attempts + 1, last_attempt_at: now, error_code: null, updated_at: now }); return true
    },
    async markSent(id, v, now) {
      state.writes++
      if (marks === 'throw') throw new Error('db down')
      if (!marks || state.row?.status !== 'sending') return false
      Object.assign(state.row, { status: 'sent', dispatched_at: now, provider_order_id: v.providerOrderId ?? null, provider_status: v.providerStatus ?? null, error_code: null, updated_at: now }); return true
    },
    async markFailed(id, st, code, now, v) {
      state.writes++
      if (marks === 'throw') throw new Error('db down')
      if (!marks || state.row?.status !== 'sending') return false
      Object.assign(state.row, { status: st, error_code: code, updated_at: now, ...(v?.providerOrderId ? { provider_order_id: v.providerOrderId } : {}) }); return true
    },
  }
  return { state, repo }
}

function setup({ respond = () => jsonRes({ order: { id: 'MX-1', status: 'searching', zone: 'mishor' } }, 201), quote = okQuote(), now = NOW, config = { status: 'ready', apiKey: KEY }, noQuote = false, ...repoOpts } = {}) {
  const mem = memRepo(repoOpts)
  const sends = [], quotes = [], logs = []
  let clock = now
  const fetchImpl = async (url, init) => { sends.push(JSON.parse(init.body)); await tick(); return respond(url, init) }
  const deps = {
    config, repo: mem.repo,
    send: p => client.sendMaaleOrder(p, { config, fetchImpl, timeoutMs: 40 }),
    ...(noQuote ? {} : { quote: async p => { quotes.push(p); await tick(); return typeof quote === 'function' ? quote(p) : quote } }),
    isPaymentVerified: async () => true, // must never matter in 03F
    consumeQuoteSlot: async () => 'ok', // S4-04C: required for ordinary calls (the kitchen route always injects it)
    now: () => clock, log: c => logs.push(c),
  }
  return { mem, sends, quotes, logs, deps, setNow: t => { clock = t }, run: opts => D.dispatchOrderToMaale(ORDER_ID, deps, opts) }
}
const noEffects = (s, label) => { assert.equal(s.sends.length, 0, `${label}: no real send`); assert.equal(s.mem.state.writes, 0, `${label}: no DB write`) }

console.log('Maale dispatch hardening (S4-INTEGRATIONS-03F, fake network)')

await test('D1. allowed cash dispatch: one quote (q- id) then one real send (orders.id); nested provider ids persisted', async () => {
  const s = setup()
  assert.deepEqual(await s.run(), { ok: true, outcome: 'sent', kind: 'created' })
  assert.equal(s.quotes.length, 1); assert.match(s.quotes[0].external_order_id, /^q-[0-9a-f-]{36}$/)
  assert.equal(s.sends.length, 1); assert.equal(s.sends[0].external_order_id, ORDER_ID)
  assert.ok(!('dry_run' in s.sends[0]) && !('dry_run' in s.quotes[0]), 'dry_run is added only inside quoteMaaleOrder')
  assert.deepEqual({ ...s.quotes[0], external_order_id: 'x' }, { ...s.sends[0], external_order_id: 'x' }, 'quote and send use the same body')
  const r = s.mem.state.row
  assert.deepEqual([r.status, r.attempts, r.provider_order_id, r.provider_status, r.external_order_id], ['sent', 1, 'MX-1', 'searching', ORDER_ID])
  assert.ok(r.dispatched_at && r.last_attempt_at)
})

await test('D2. credit is never auto-dispatched (even if a payment check says true); no quote, no write, no network', async () => {
  const s = setup({ orderSnapshot: snapshot({ order: { payment_method: 'credit' } }) })
  assert.deepEqual(await s.run(), { ok: false, outcome: 'blocked', reason: 'credit_dispatch_disabled' })
  noEffects(s, 'credit'); assert.equal(s.quotes.length, 0)
  const t = setup({ orderSnapshot: snapshot({ order: { payment_method: 'credit', customer_name: '🧪 בדיקה — לא לשלוח' } }) })
  assert.equal((await t.run({ testMode: { orderId: ORDER_ID, bypassPaymentGate: true, bypassAreaGate: true } })).reason, 'credit_dispatch_disabled', 'test mode bypasses nothing')
  assert.ok(src('lib/maaleDispatch.ts').includes('isPaymentVerified: async () => false'))
})

await test('D3. cash food total: 60000 agorot dispatches, 60001 is blocked before any quote', async () => {
  const cash = unit => snapshot({ order: { total_price: Math.round((unit + 4 + 20) * 100) / 100 }, items: [{ name: 'מגש', quantity: 1, unit_price: unit }] })
  const ok = setup({ orderSnapshot: cash(596), quote: okQuote({ courierPaysMerchantAgorot: 60000, courierCollectsFromCustomerAgorot: 62000 }) })
  assert.equal((await ok.run()).outcome, 'sent'); assert.equal(ok.sends[0].food_total_agorot, 60000)
  const over = setup({ orderSnapshot: cash(596.01) })
  const r = await over.run()
  assert.equal(r.reason, 'invalid_payload'); assert.ok(r.detail.includes('cash_amount_too_high')); noEffects(over, 'cap'); assert.equal(over.quotes.length, 0)
})

await test('D4. missing / imprecise coordinates block before any quote', async () => {
  for (const delivery of [{ delivery_lat: null, delivery_lng: null, geo_source: 'none', geo_precision: 'unresolved' }, { geo_precision: 'locality' }, { delivery_lat: 40.7 }]) {
    const s = setup({ orderSnapshot: snapshot({ delivery }) })
    assert.equal((await s.run()).reason, 'invalid_payload', JSON.stringify(delivery)); noEffects(s, 'coords'); assert.equal(s.quotes.length, 0)
  }
})

await test('D5. quote must match: fee mismatch / missing fee / cash amounts / warnings / failure / no quote dep → blocked, nothing written or sent', async () => {
  const cases = [
    [okQuote({ deliveryFeeAgorot: 2500 }), 'fee_mismatch'],
    [okQuote({ deliveryFeeAgorot: undefined }), 'quote_fee_missing'],
    [okQuote({ courierPaysMerchantAgorot: 5200 }), 'quote_amount_mismatch'],
    [okQuote({ courierCollectsFromCustomerAgorot: 7800 }), 'quote_amount_mismatch'],
    [okQuote({ warnings: ['outside_hours'] }), 'quote_warnings'],
    [{ ok: false, retryable: true, errorCode: 'timeout', ambiguous: true }, 'quote_failed'],
    [{ ok: false, retryable: false, errorCode: 'out_of_area', status: 400 }, 'quote_failed'],
    [{ ok: false, retryable: false, errorCode: 'dispatch_closed', status: 400 }, 'quote_failed'],
  ]
  for (const [quote, reason] of cases) {
    const s = setup({ quote })
    const r = await s.run()
    assert.equal(r.outcome, 'blocked'); assert.equal(r.reason, reason, JSON.stringify(quote)); noEffects(s, reason)
  }
  assert.equal((await setup({ quote: okQuote({ deliveryFeeAgorot: 2500 }) }).run()).detail, '2500!=2000')
  const none = setup({ noQuote: true })
  assert.deepEqual(await none.run(), { ok: false, outcome: 'blocked', reason: 'quote_unavailable' }); noEffects(none, 'no quote')
  // the zone label is never used as settlement proof: a "foreign" zone with the right fee passes, a matching name never rescues a wrong fee
  assert.equal((await setup({ quote: okQuote({ zone: 'kfar_adumim' }) }).run()).outcome, 'sent')
  assert.equal((await setup({ quote: okQuote({ zone: 'maale_adumim', deliveryFeeAgorot: 3500 }) }).run()).reason, 'fee_mismatch')
})

await test('D6. Kfar Adumim (Nofei Prat ambiguity) is manual-review only — no quote, no write, no network', async () => {
  const kfar = snapshot({ order: { total_price: 88 }, delivery: { city: 'כפר אדומים', delivery_fee: 35 } })
  for (const geo of [{ geo_source: 'geocoder' }, { geo_source: 'manual' }]) {
    const s = setup({ orderSnapshot: { ...kfar, delivery: { ...kfar.delivery, ...geo } }, quote: okQuote({ deliveryFeeAgorot: 3500 }) })
    assert.deepEqual(await s.run(), { ok: false, outcome: 'blocked', reason: 'location_manual_review', detail: 'kfar_adumim_nofei_prat_ambiguous' })
    noEffects(s, 'kfar'); assert.equal(s.quotes.length, 0)
  }
  for (const city of ['נופי פרת', 'מצפה יריחו']) // unavailable destinations never reach the location gate
    assert.equal((await setup({ orderSnapshot: snapshot({ delivery: { city } }) }).run()).reason, 'invalid_payload')
})

await test('D7. concurrent dispatch calls → exactly one claim and one real send', async () => {
  const s = setup()
  const [a, b] = await Promise.all([s.run(), s.run()])
  assert.equal(s.sends.length, 1); assert.deepEqual([a.outcome, b.outcome].sort(), ['dispatch_in_progress', 'sent'])
  assert.equal(s.mem.state.row.attempts, 1)
})

await test('D8. repeated request after success → already_sent (no quote, no send); same id kept', async () => {
  const s = setup(); await s.run()
  assert.deepEqual(await s.run(), { ok: true, outcome: 'already_sent' })
  assert.deepEqual([s.sends.length, s.quotes.length], [1, 1]); assert.equal(s.mem.state.row.external_order_id, ORDER_ID)
})

await test('D9. HTTP 401 → failed_final + global stop for 30 min (any order); quote 401 recorded without a real send', async () => {
  const s = setup({ respond: () => jsonRes({}, 401) })
  assert.deepEqual(await s.run(), { ok: false, outcome: 'failed', retryable: false, errorCode: 'unauthorized' })
  assert.deepEqual([s.mem.state.row.status, s.mem.state.row.error_code], ['failed_final', 'unauthorized'])
  // another order while the stop is active
  const other = setup({ otherAuthFailureAt: at(-10 * 60) })
  assert.deepEqual(await other.run(), { ok: false, outcome: 'blocked', reason: 'auth_stop_active' }); noEffects(other, 'stop'); assert.equal(other.quotes.length, 0)
  const later = setup({ otherAuthFailureAt: at(-31 * 60) })
  assert.equal((await later.run()).outcome, 'sent', 'stop expires after the window')
  // 401 on the QUOTE: persisted on this order's row, never a real send
  const q = setup({ quote: { ok: false, retryable: false, errorCode: 'unauthorized', status: 401 } })
  assert.deepEqual(await q.run(), { ok: false, outcome: 'failed', retryable: false, errorCode: 'unauthorized' })
  assert.equal(q.sends.length, 0); assert.deepEqual([q.mem.state.row.status, q.mem.state.row.error_code], ['failed_final', 'unauthorized'])
  assert.equal((await q.run()).outcome, 'blocked', 'global stop now active for this repo too')
  // a repo that cannot answer the stop question fails closed
  const legacy = setup(); delete legacy.mem.repo.hasRecentAuthFailure
  assert.deepEqual(await legacy.run(), { ok: false, outcome: 'blocked', reason: 'auth_state_unknown' }); noEffects(legacy, 'unknown auth')
})

await test('D10 (03G). HTTP 429 → recorded with Retry-After; any later call (before or after the wait) → manual review, NO second send', async () => {
  let n = 0
  const s = setup({ respond: () => (++n === 1 ? jsonRes({ code: 'rate_limited' }, 429, { 'retry-after': '120' }) : jsonRes({ order: { id: 'MX-2' } }, 201)) })
  assert.deepEqual(await s.run(), { ok: false, outcome: 'failed', retryable: true, errorCode: 'rate_limited', retryAfterSec: 120 })
  assert.deepEqual([s.mem.state.row.status, s.mem.state.row.error_code, s.mem.state.row.attempts], ['failed_retryable', 'rate_limited_after_120', 1])
  const writesAfter429 = s.mem.state.writes
  for (const t of [61, 121, 24 * 3600]) { // before the wait, just after it, a day later: always the same answer
    s.setNow(at(t))
    assert.deepEqual(await s.run(), { ok: false, outcome: 'manual_review_required', reason: 'rate_limited', retryAt: at(120) }, `t+${t}s`)
  }
  assert.equal(s.sends.length, 1, 'exactly one provider submission'); assert.equal(s.quotes.length, 1, 'no new quote for a submitted order')
  assert.equal(s.mem.state.writes, writesAfter429, 'no claim / no state change'); assert.equal(s.mem.state.row.external_order_id, ORDER_ID)
  // no Retry-After → retry time shown as +60 s, still manual
  const t = setup({ row: { status: 'failed_retryable', attempts: 1, last_attempt_at: at(-30), error_code: 'rate_limited' } })
  assert.deepEqual(await t.run(), { ok: false, outcome: 'manual_review_required', reason: 'rate_limited', retryAt: at(30) }); noEffects(t, '60s')
  const u = setup({ row: { status: 'failed_retryable', attempts: 1, last_attempt_at: at(-7200), error_code: 'rate_limited' } })
  assert.deepEqual(await u.run(), { ok: false, outcome: 'manual_review_required', reason: 'rate_limited', retryAt: at(-7140) }); noEffects(u, 'long past')
  assert.equal(D.persistedErrorCode({ ok: false, retryable: true, errorCode: 'rate_limited', retryAfterSec: 999999 }), 'rate_limited_after_86400')
  assert.match(D.persistedErrorCode({ ok: false, retryable: true, errorCode: 'rate_limited', retryAfterSec: 86400 }), /^[a-z0-9_]{1,64}$/)
})

await test('D10b (03G). changed payload after 429 / concurrent calls on a 429 row / timeout then retry → never a second submission', async () => {
  const s = setup({ respond: () => jsonRes({}, 429, { 'retry-after': '5' }) })
  await s.run()
  s.mem.state.orderSnapshot = snapshot({ items: [{ name: 'פלאפל בפיתה (שם חדש)', quantity: 1, unit_price: 40 }, { name: 'קוקה קולה', quantity: 1, unit_price: 9 }] })
  s.setNow(at(3600))
  assert.equal((await s.run()).reason, 'rate_limited'); assert.equal(s.sends.length, 1, 'changed body is never sent')
  const [a, b] = await Promise.all([s.run(), s.run()])
  assert.deepEqual([a.outcome, b.outcome], ['manual_review_required', 'manual_review_required']); assert.equal(s.sends.length, 1, 'concurrent calls: still one submission')
  const hang = (_u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))))
  const t = setup({ respond: hang })
  assert.equal((await t.run()).errorCode, 'timeout')
  t.setNow(at(3600))
  assert.deepEqual(await t.run(), { ok: false, outcome: 'manual_review_required', reason: 'previous_outcome_ambiguous' }); assert.equal(t.sends.length, 1)
  // a never-attempted row may proceed; an inconsistent pending row (attempts > 0) may not
  assert.equal((await setup({ row: { status: 'pending', attempts: 0 } }).run()).outcome, 'sent')
  const odd = setup({ row: { status: 'pending', attempts: 1, last_attempt_at: at(-60) } })
  assert.deepEqual(await odd.run(), { ok: false, outcome: 'manual_review_required', reason: 'retry_state_invalid' }); noEffects(odd, 'pending>0')
  // nothing in the service re-claims a failed row
  const d = src('lib/maaleDispatch.ts').replace(/\/\/.*$/gm, '')
  assert.ok(!/retry_allowed|retry_not_yet|retry_scheduled/.test(d), 'no automatic-retry path left')
})

await test('D11. HTTP 409 idempotency_mismatch → failed_final; never retried, never a new external_order_id', async () => {
  const s = setup({ respond: () => jsonRes({ code: 'idempotency_mismatch' }, 409) })
  assert.deepEqual(await s.run(), { ok: false, outcome: 'failed', retryable: false, errorCode: 'idempotency_mismatch' })
  assert.deepEqual([s.mem.state.row.status, s.mem.state.row.error_code, s.mem.state.row.external_order_id], ['failed_final', 'idempotency_mismatch', ORDER_ID])
  s.setNow(at(3600))
  assert.deepEqual(await s.run(), { ok: false, outcome: 'final_failure_exists' }); assert.equal(s.sends.length, 1)
})

await test('D12. timeout / network / 5xx / unexpected 2xx → recorded as ambiguous; never resent automatically', async () => {
  const hang = (_u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))))
  for (const [respond, code] of [[hang, 'timeout'], [() => { throw new TypeError('fetch failed') }, 'network_error'], [() => jsonRes({}, 503), 'provider_5xx'], [() => jsonRes({}, 202), 'invalid_response']]) {
    const s = setup({ respond })
    const r = await s.run()
    assert.deepEqual([r.outcome, r.retryable, r.errorCode, r.ambiguous], ['failed', true, code, true], code)
    assert.deepEqual([s.mem.state.row.status, s.mem.state.row.error_code], ['failed_retryable', code])
    s.setNow(at(24 * 3600))
    assert.deepEqual(await s.run(), { ok: false, outcome: 'manual_review_required', reason: 'previous_outcome_ambiguous' }, code)
    assert.deepEqual([s.sends.length, s.quotes.length], [1, 1], `${code}: no second quote / send`)
    assert.equal(D.dispatchView(s.mem.state.row), 'needs_manual_check')
  }
})

await test('D13. changed payload after an unknown outcome is never sent; a stale "sending" row is never resent', async () => {
  const s = setup({ respond: () => jsonRes({}, 503) })
  await s.run()
  s.mem.state.orderSnapshot = snapshot({ items: [{ name: 'פלאפל בפיתה (שם חדש)', quantity: 1, unit_price: 40 }, { name: 'קוקה קולה', quantity: 1, unit_price: 9 }] })
  s.setNow(at(600))
  assert.equal((await s.run()).outcome, 'manual_review_required'); assert.equal(s.sends.length, 1)
  const stale = setup({ row: { status: 'sending', attempts: 1, last_attempt_at: at(-10 * 60) } })
  assert.deepEqual(await stale.run(), { ok: false, outcome: 'manual_review_required', reason: 'sending_outcome_unknown' }); noEffects(stale, 'stale')
  const fresh = setup({ row: { status: 'sending', attempts: 1, last_attempt_at: at(-60) } })
  assert.deepEqual(await fresh.run(), { ok: false, outcome: 'dispatch_in_progress' }); noEffects(fresh, 'fresh')
  for (const code of [null, 'some_unknown_code']) {
    const odd = setup({ row: { status: 'failed_retryable', attempts: 1, last_attempt_at: at(-3600), error_code: code } })
    assert.equal((await odd.run()).outcome, 'manual_review_required', String(code)); noEffects(odd, 'odd')
  }
})

await test('D14. persistence must update exactly one row: zero rows / DB error → persistence_failed (never reported as sent)', async () => {
  const sent0 = setup({ marks: false })
  assert.deepEqual(await sent0.run(), { ok: false, outcome: 'persistence_failed', providerOutcome: 'created' })
  assert.ok(sent0.logs.includes('maale_dispatch_state_lost'))
  const failed0 = setup({ marks: false, respond: () => jsonRes({ code: 'zone_unknown' }, 400) })
  assert.deepEqual(await failed0.run(), { ok: false, outcome: 'persistence_failed', providerOutcome: 'failed' })
  const thrown = setup({ marks: 'throw' })
  assert.deepEqual(await thrown.run(), { ok: false, outcome: 'persistence_failed', providerOutcome: 'created' })
  // a lost update leaves the row in 'sending' → later calls report it, never resend
  thrown.setNow(at(600))
  assert.deepEqual(await thrown.run(), { ok: false, outcome: 'manual_review_required', reason: 'sending_outcome_unknown' }); assert.equal(thrown.sends.length, 1)
})

await test('D15. a dry_run quote never becomes "sent": quote touches no state; quote-shaped answer to a real send → failed_final', async () => {
  const blocked = setup({ quote: okQuote({ deliveryFeeAgorot: 1 }) }); await blocked.run()
  assert.equal(blocked.mem.state.row, null, 'a quote alone creates no dispatch row')
  const odd = setup({ respond: () => jsonRes({ ok: true, would_create: { delivery_fee_agorot: 2000 } }, 200) })
  assert.deepEqual(await odd.run(), { ok: false, outcome: 'failed', retryable: false, errorCode: 'unexpected_quote_response' })
  assert.notEqual(odd.mem.state.row.status, 'sent'); assert.equal(odd.mem.state.row.status, 'failed_final')
  assert.equal(D.dispatchView(odd.mem.state.row), 'needs_manual_check')
  const created = setup({ quote: { ok: false, retryable: false, errorCode: 'quote_created_real_order', status: 201, providerOrderId: 'MX-Q' } })
  assert.deepEqual(await created.run(), { ok: false, outcome: 'manual_review_required', reason: 'quote_created_real_order' })
  noEffects(created, 'quote 201'); assert.ok(created.logs.includes('maale_dispatch_quote_created_real_order'))
})

await test('D16. parcel: none / cancelled → food dispatch; unresolved or any active parcel → manual (provider has no parcel fields)', async () => {
  for (const ps of [null, 'cancelled']) assert.equal((await setup({ parcelStatus: ps }).run()).outcome, 'sent', String(ps))
  for (const ps of ['awaiting_search', 'not_found', 'invalid', 'omit']) {
    const s = setup({ parcelStatus: ps })
    assert.equal((await s.run()).reason, 'parcel_unresolved', String(ps)); noEffects(s, 'parcel')
  }
  for (const ps of ['found', 'handed_to_courier', 'delivery_problem', 'carrier_verified', 'returned_to_store'])
    assert.equal((await setup({ parcelStatus: ps }).run()).reason, 'parcel_manual_dispatch_required', ps)
})

await test('D17. kitchen status: only confirmed / preparing; received / ready / delivered / cancelled never dispatch', async () => {
  for (const status of ['confirmed', 'preparing']) assert.equal((await setup({ status }).run()).outcome, 'sent', status)
  for (const status of ['received', 'ready', 'delivered', 'cancelled']) {
    const s = setup({ status }); assert.equal((await s.run()).reason, 'order_not_confirmed', status); noEffects(s, status)
  }
  const pickup = setup({ orderSnapshot: snapshot({ order: { type: 'pickup' } }) })
  assert.equal((await pickup.run()).reason, 'invalid_payload')
})

await test('D18. 402 blocked → failed_final with the provider id kept; 400 variants final; attempts cap', async () => {
  const s = setup({ respond: () => jsonRes({ order_id: 'MX-77', code: 'no_balance' }, 402) })
  assert.deepEqual(await s.run(), { ok: false, outcome: 'failed', retryable: false, errorCode: 'blocked' })
  assert.deepEqual([s.mem.state.row.status, s.mem.state.row.error_code, s.mem.state.row.provider_order_id], ['failed_final', 'blocked', 'MX-77'])
  for (const [body, code] of [[{ dispatch_closed: true }, 'dispatch_closed'], [{ code: 'out_of_area' }, 'out_of_area'], [{ code: 'amount_too_high' }, 'amount_too_high'], [{ code: 'zone_unknown' }, 'zone_unknown'], [{ error: 'lat' }, 'validation_error']]) {
    const t = setup({ respond: () => jsonRes(body, 400) })
    assert.equal((await t.run()).errorCode, code); assert.equal(t.mem.state.row.status, 'failed_final')
  }
  const cap = setup({ row: { status: 'failed_retryable', attempts: 20, last_attempt_at: at(-3600), error_code: 'rate_limited' } })
  assert.deepEqual(await cap.run(), { ok: false, outcome: 'attempts_exhausted' }); noEffects(cap, 'cap')
})

await test('D19. dispatchView for staff: in progress / sent / rate-limited manual check / manual check / failed', async () => {
  assert.equal(D.dispatchView(null), 'not_dispatched'); assert.equal(D.dispatchView({ status: 'pending', error_code: null }), 'not_dispatched')
  assert.equal(D.dispatchView({ status: 'sending', error_code: null }), 'in_progress')
  assert.equal(D.dispatchView({ status: 'sent', error_code: null }), 'sent')
  assert.equal(D.dispatchView({ status: 'failed_retryable', error_code: 'rate_limited_after_30' }), 'rate_limited_manual_check') // 03G: never "scheduled"
  assert.equal(D.dispatchView({ status: 'failed_retryable', error_code: 'timeout' }), 'needs_manual_check')
  assert.equal(D.dispatchView({ status: 'failed_final', error_code: 'zone_unknown' }), 'failed')
})

await test('D20. readiness is read-only (no write, no quote, no network) and reports every 03F blocker', async () => {
  const ro = (opts = {}) => { const m = memRepo(opts); return { m, deps: { config: { status: 'ready', apiKey: KEY }, repo: m.repo, now: () => NOW } } }
  const marked = { order: { customer_name: '🧪 בדיקה — לא לשלוח' } }
  const ok = ro({ orderSnapshot: snapshot(marked) })
  const r = await D.assessMaaleTestReadiness(ORDER_ID, ok.deps)
  assert.deepEqual([r.result, r.quoteRequired, r.requiresPaymentOverride, r.requiresAreaOverride, r.areaReady], ['ready_for_controlled_test', true, false, false, true])
  assert.equal(ok.m.state.writes, 0)
  const cases = [
    [{ orderSnapshot: snapshot({ order: { ...marked.order, payment_method: 'credit' } }) }, 'credit_dispatch_disabled'],
    [{ orderSnapshot: snapshot({ ...marked, order: { ...marked.order, total_price: 88 }, delivery: { city: 'כפר אדומים', delivery_fee: 35 } }) }, 'location_manual_review'],
    [{ orderSnapshot: snapshot(marked), parcelStatus: 'awaiting_search' }, 'parcel_unresolved'],
    [{ orderSnapshot: snapshot(marked), otherAuthFailureAt: at(-60) }, 'auth_stop_active'],
    [{ orderSnapshot: snapshot(marked), row: { status: 'failed_retryable', attempts: 1, last_attempt_at: at(-3600), error_code: 'timeout' } }, 'previous_outcome_ambiguous'],
    [{ orderSnapshot: snapshot(marked), row: { status: 'sending', attempts: 1, last_attempt_at: at(-3600) } }, 'sending_outcome_unknown'],
    [{ orderSnapshot: snapshot(marked), row: { status: 'failed_retryable', attempts: 1, last_attempt_at: at(-10), error_code: 'rate_limited' } }, 'rate_limited'],
    [{ orderSnapshot: snapshot(marked), row: { status: 'sent', attempts: 1, last_attempt_at: at(-10) } }, 'dispatch_already_sent'],
  ]
  for (const [opts, blocker] of cases) {
    const x = ro(opts)
    const res = await D.assessMaaleTestReadiness(ORDER_ID, x.deps)
    assert.ok(res.blockers.includes(blocker), `${blocker} in ${res.blockers}`); assert.equal(res.safeForControlledTest, false); assert.equal(x.m.state.writes, 0)
  }
  const legacy = ro({ orderSnapshot: snapshot(marked) })
  const lr = await D.assessMaaleTestReadiness(ORDER_ID, { ...legacy.deps, repo: { loadOrder: legacy.m.repo.loadOrder, getDispatch: legacy.m.repo.getDispatch } })
  assert.ok(lr.blockers.includes('auth_state_unknown'), 'a read-only repo without the stop check fails closed')
})

await test('D21. logs are short codes only; real repo checks exact-row updates; nothing in app/ calls dispatch', async () => {
  const logs = []
  for (const opts of [{}, { respond: () => jsonRes({ code: 'zone_unknown' }, 400) }, { respond: () => jsonRes({}, 503) }, { quote: okQuote({ deliveryFeeAgorot: 1 }) }, { marks: false }]) {
    const s = setup(opts); await s.run(); logs.push(...s.logs)
  }
  assert.ok(logs.length >= 5)
  for (const l of logs) { assert.match(l, /^maale_dispatch_[a-z0-9_]+$/); assert.ok(!l.includes(KEY) && !PII.some(p => l.includes(p)), l) }
  const d = src('lib/maaleDispatch.ts')
  for (const fn of ['markSent', 'markFailed', 'claim']) assert.match(d, new RegExp(`async ${fn}\\([^)]*\\)[^]*?\\.select\\('order_id'\\)[^]*?return one\\(data\\)`), fn)
  assert.ok(d.includes("select('order_id, external_order_id, status, attempts, last_attempt_at, error_code')"))
  assert.ok(d.includes('parcel_requests(status)'))
  assert.ok(!/^let\s|^var\s/m.test(d), 'no mutable module state')
  const walk = (dir) => require('node:fs').readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])
  const ALLOWED = join(ROOT, 'app', 'api', 'kitchen', 'orders', '[id]', 'dispatch', 'route.ts') // S4-03K: flag-gated manual route only
  for (const f of walk(join(ROOT, 'app')).filter(p => /\.(tsx?|jsx?)$/.test(p))) {
    const s = readFileSync(f, 'utf8')
    assert.ok(!/quoteMaaleOrder|testMode/.test(s), f)
    if (f !== ALLOWED) assert.ok(!/maaleDispatch|dispatchOrderToMaale/.test(s), f)
  }
})

console.log(`\nAll ${passed} Maale 03F dispatch checks passed.`)
