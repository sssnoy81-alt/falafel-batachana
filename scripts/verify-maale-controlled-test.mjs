// Local checks for the controlled Maale test runner (FALAFEL-SN-08D13).
// Drives the runner core with an in-memory delivery_dispatches + FAKE fetch. The real global fetch is a throwing
// stub, so no live request is possible. Run: node scripts/verify-maale-controlled-test.mjs

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

globalThis.fetch = async () => { throw new Error('LIVE NETWORK CALL ATTEMPTED IN TESTS') }

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runner = await import('./maale-controlled-test.mjs')
const cfg = runner.loadLib('orderConfig')
const client = runner.loadLib('maaleClient')
const D = runner.loadLib('maaleDispatch')

let passed = 0
const test = async (name, fn) => { await fn(); passed++; console.log('  ✓', name) }

/* ─── Fixtures (FAKE) ─── */
const ORDER_ID = '11111111-2222-4333-8444-555555555555'
const KEY = 'test-maale-key-not-real'
const SERVICE_KEY = 'service-role-key-not-real'
const TEST_NAME = '🧪 בדיקה — לא לשלוח'
const PII = ['0501234567', 'הגעש', 'קוד שער 4321', 'לקוח אמיתי', 'כניסה ב']
const snapshot = (over = {}) => {
  const s = {
    order: { id: ORDER_ID, type: 'delivery', branch_id: cfg.DELIVERY_BRANCH_IDS[0], payment_method: 'credit', customer_name: TEST_NAME, phone: '0501234567', total_price: 73 },
    delivery: { city: 'מעלה אדומים', street: 'הגעש', house_number: '6', apartment: '6', floor: '2', entrance: 'ב', notes: 'קוד שער 4321', delivery_fee: 20, meal_surcharge: 4,
      delivery_lat: 31.773612, delivery_lng: 35.298346, geo_source: 'geocoder', geo_precision: 'street' },
    items: [{ name: 'פלאפל בפיתה', quantity: 1, unit_price: 40 }, { name: 'קוקה קולה', quantity: 1, unit_price: 9 }],
  }
  if (over.order) Object.assign(s.order, over.order)
  if (over.delivery) Object.assign(s.delivery, over.delivery)
  return s
}
const jsonRes = (body, status) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

function memRepo({ status = 'confirmed', row = null, orderSnapshot = snapshot() } = {}) {
  const state = { row: row ? { external_order_id: ORDER_ID, attempts: 0, last_attempt_at: null, ...row, order_id: ORDER_ID } : null, writes: 0 }
  return {
    state,
    repo: {
      async loadOrder(id) { return id === ORDER_ID ? { snapshot: orderSnapshot, status } : null },
      async getDispatch(id) { return state.row && id === ORDER_ID ? { order_id: id, external_order_id: state.row.external_order_id, status: state.row.status, attempts: state.row.attempts, last_attempt_at: state.row.last_attempt_at } : null },
      async insertPending(id) { state.writes++; if (!state.row) state.row = { order_id: id, external_order_id: id, status: 'pending', attempts: 0, last_attempt_at: null } },
      async claim(id, seen, now) {
        state.writes++
        const r = state.row
        if (!r || r.status !== seen.status || r.attempts !== seen.attempts || r.last_attempt_at !== seen.last_attempt_at) return false
        Object.assign(r, { status: 'sending', attempts: seen.attempts + 1, last_attempt_at: now }); return true
      },
      async markSent(id, v, now) { state.writes++; if (state.row.status === 'sending') Object.assign(state.row, { status: 'sent', dispatched_at: now }) },
      async markFailed(id, st, code) { state.writes++; if (state.row.status === 'sending') Object.assign(state.row, { status: st, error_code: code }) },
    },
  }
}

/** Runs the runner core with fake deps; HYP is not verified and the REAL (unapproved) area config is used. */
async function run(argv, { respond = () => jsonRes({ order_id: 'MX-1' }, 201), config = { status: 'ready', apiKey: KEY }, ...repoOpts } = {}) {
  const mem = memRepo(repoOpts)
  const calls = []
  const out = []
  let created = 0
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return respond(url, init) }
  const createDeps = () => {
    created++
    return {
      config, repo: mem.repo, isPaymentVerified: async () => false, // HYP not integrated
      send: p => client.sendMaaleOrder(p, { config, fetchImpl, timeoutMs: 40 }),
      now: () => '2026-10-05T10:00:00.000Z', log: () => {},
    }
  }
  const code = await runner.runMaaleControlledTest(argv, { createDeps, print: l => out.push(l) })
  return { code, out, text: out.join('\n'), calls, mem, created }
}

const READY = ['readiness', ORDER_ID]
const DISPATCH = ['dispatch', ORDER_ID, '--confirm-test']

console.log('Controlled Maale test runner')

await test('1. readiness mode: zero network calls, zero writes, safe report', async () => {
  const r = await run(READY)
  assert.equal(r.calls.length, 0); assert.equal(r.mem.state.writes, 0); assert.equal(r.code, 0)
  for (const k of ['Order: ' + ORDER_ID, 'Order status: confirmed', 'Delivery: YES', 'Branch: Mishor Adumim', 'Test marker: PASS', 'Payment method: credit', 'HYP required: YES',
    'Address: complete', 'Coordinates: precise', 'Payload: valid', 'Dispatch state: none', 'Maale enabled: YES', 'Maale key configured: YES',
    'HYP verified: NO', 'Area ready: NO', 'Controlled-test overrides required: payment = YES, area = YES', 'Result: READY FOR CONTROLLED TEST'])
    assert.ok(r.text.includes(k), k)
})

await test('2. dispatch without --confirm-test refuses (no DB, no network)', async () => {
  const r = await run(['dispatch', ORDER_ID])
  assert.equal(r.code, 1); assert.match(r.text, /REFUSED: dispatch requires --confirm-test/)
  assert.equal(r.created, 0); assert.equal(r.calls.length, 0)
  const typo = await run(['dispatch', ORDER_ID, '--confirm'])
  assert.equal(typo.code, 2); assert.equal(typo.created, 0)
})

await test('3. malformed / missing order id refuses before anything is read', async () => {
  for (const argv of [['readiness', 'abc'], ['dispatch', '123', '--confirm-test'], ['dispatch'], [], ['send', ORDER_ID]]) {
    const r = await run(argv)
    assert.equal(r.code, 2, JSON.stringify(argv)); assert.equal(r.created, 0); assert.equal(r.calls.length, 0)
  }
})

const refused = async (opts, blocker) => {
  const r = await run(DISPATCH, opts)
  assert.equal(r.code, 1); assert.match(r.text, /REFUSED: readiness has blockers/)
  assert.ok(r.text.includes(blocker), `${blocker} in: ${r.text}`)
  assert.equal(r.calls.length, 0); assert.equal(r.mem.state.writes, 0)
}

await test('4. missing test marker refuses', async () => refused({ orderSnapshot: snapshot({ order: { customer_name: 'לקוח אמיתי' } }) }, 'test_order_marker_missing'))
await test('5. pickup refuses', async () => refused({ orderSnapshot: snapshot({ order: { type: 'pickup' } }) }, 'not_delivery'))
await test('6. wrong branch refuses', async () => refused({ orderSnapshot: snapshot({ order: { branch_id: '3ab15ad1-e835-492b-bae5-11b202ee2314' } }) }, 'wrong_branch'))
await test('7. invalid payload refuses (missing house number / imprecise coordinates / non-credit)', async () => {
  await refused({ orderSnapshot: snapshot({ delivery: { house_number: '' } }) }, 'address_incomplete')
  await refused({ orderSnapshot: snapshot({ delivery: { geo_precision: 'locality' } }) }, 'coordinates_not_precise')
  await refused({ orderSnapshot: snapshot({ order: { payment_method: 'cibus' } }) }, 'payment_method_not_allowed')
  await refused({ orderSnapshot: snapshot({ order: { total_price: 99 } }) }, 'invalid_payload')
})
await test('8. unconfirmed order refuses', async () => refused({ status: 'received' }, 'order_not_confirmed'))
await test('9. Maale disabled refuses', async () => refused({ config: { status: 'disabled' } }, 'maale_disabled'))
await test('10. missing key refuses', async () => refused({ config: { status: 'not_configured' } }, 'maale_not_configured'))

await test('11–13. payment / area bypass only in explicit test mode, only for a marked order', async () => {
  const ok = await run(DISPATCH) // HYP false + real unapproved areas → still dispatched via testMode
  assert.equal(ok.code, 0); assert.equal(ok.calls.length, 1); assert.match(ok.text, /Result: created/)
  // Same order, normal path (no testMode): both gates still enforced.
  const m = memRepo()
  const base = { config: { status: 'ready', apiKey: KEY }, repo: m.repo, send: async () => { throw new Error('must not send') }, now: () => '2026-10-05T10:00:00.000Z' }
  assert.equal((await D.dispatchOrderToMaale(ORDER_ID, { ...base, isPaymentVerified: async () => false })).reason, 'payment_not_verified')
  assert.equal((await D.dispatchOrderToMaale(ORDER_ID, { ...base, isPaymentVerified: async () => true })).reason, 'area_not_ready')
  // Unmarked order: the runner refuses, and testMode itself refuses too.
  await refused({ orderSnapshot: snapshot({ order: { customer_name: 'לקוח אמיתי' } }) }, 'test_order_marker_missing')
  const u = memRepo({ orderSnapshot: snapshot({ order: { customer_name: 'לקוח אמיתי' } }) })
  const r = await D.dispatchOrderToMaale(ORDER_ID, { ...base, repo: u.repo, isPaymentVerified: async () => false },
    { testMode: { orderId: ORDER_ID, bypassPaymentGate: true, bypassAreaGate: true } })
  assert.equal(r.reason, 'test_order_marker_missing')
  const code = readFileSync(join(ROOT, 'scripts', 'maale-controlled-test.mjs'), 'utf8').replace(/^\s*\/\/.*$/gm, '')
  assert.equal((code.match(/bypassPaymentGate: true/g) || []).length, 1, 'exactly one bypass call site (comments excluded)')
})

await test('14. a sent order is never resent', async () => refused({ row: { status: 'sent', attempts: 1, last_attempt_at: '2026-10-05T09:00:00.000Z' } }, 'dispatch_already_sent'))

await test('15. same external_order_id on every attempt (retry after a retryable failure)', async () => {
  const first = await run(DISPATCH, { respond: () => jsonRes({}, 503) })
  assert.match(first.text, /Result: provider_5xx \(retryable\)/); assert.match(first.text, /delivery_dispatches state: failed_retryable \(attempts 1\)/)
  const second = await run(DISPATCH, { row: { status: 'failed_retryable', attempts: 1, last_attempt_at: '2026-10-05T09:59:00.000Z' } })
  assert.match(second.text, /Result: created/)
  for (const c of [...first.calls, ...second.calls]) assert.equal(JSON.parse(c.init.body).external_order_id, ORDER_ID)
})

await test('16. duplicate 200 is success → sent', async () => {
  const r = await run(DISPATCH, { respond: () => jsonRes({ order_id: 'MX-1' }, 200) })
  assert.equal(r.code, 0); assert.match(r.text, /Result: duplicate/); assert.match(r.text, /delivery_dispatches state: sent \(attempts 1\)/)
})

await test('17. no secrets printed (API key, service key, raw provider body)', async () => {
  const outs = [await run(READY), await run(DISPATCH), await run(DISPATCH, { respond: () => jsonRes({ message: `bad key ${KEY}`, secret: 'provider-internal' }, 401) })]
  for (const r of outs) {
    for (const s of [KEY, SERVICE_KEY, 'provider-internal', 'X-Api-Key', 'access_token']) assert.ok(!r.text.includes(s), s)
  }
  assert.match(outs[2].text, /Result: unauthorized \(final\)/)
  const src = readFileSync(join(ROOT, 'scripts', 'maale-controlled-test.mjs'), 'utf8')
  assert.ok(!/print\([^)]*(apiKey|process\.env|SERVICE|KEY)/.test(src), 'runner never prints env / keys')
})

await test('18. no phone / customer PII printed (name, street, notes)', async () => {
  for (const r of [await run(READY), await run(DISPATCH)]) for (const p of [...PII, TEST_NAME]) assert.ok(!r.text.includes(p), p)
  const unmarked = await run(READY, { orderSnapshot: snapshot({ order: { customer_name: 'לקוח אמיתי' } }) })
  assert.ok(!unmarked.text.includes('לקוח אמיתי'))
})

const walk = dir => readdirSync(dir).flatMap(n => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p] })
await test('19. the runner is not imported by app/ or lib/ (never a route, never deployed functionality)', async () => {
  for (const f of [...walk(join(ROOT, 'app')), ...walk(join(ROOT, 'lib'))].filter(p => /\.(tsx?|jsx?|mjs)$/.test(p)))
    assert.ok(!/maale-controlled-test|runMaaleControlledTest/.test(readFileSync(f, 'utf8')), f)
})

await test('20. no real network call in tests (global fetch is a throwing stub)', async () => {
  await assert.rejects(() => globalThis.fetch('https://example.invalid'), /LIVE NETWORK CALL ATTEMPTED/)
})

await test('08D14 · 31. test-mode CASH order: no payment override required (only area), dispatches as cash', async () => {
  const cashOrder = { orderSnapshot: snapshot({ order: { payment_method: 'cash' } }) }
  const r = await run(READY, cashOrder)
  for (const k of ['Payment method: cash', 'HYP required: NO', 'HYP verified: n/a (cash)', 'Controlled-test overrides required: payment = NO, area = YES', 'Result: READY FOR CONTROLLED TEST'])
    assert.ok(r.text.includes(k), k)
  const d = await run(DISPATCH, cashOrder)
  assert.equal(d.code, 0); assert.equal(JSON.parse(d.calls[0].init.body).payment_method, 'cash')
})

await test('08D14 · 32. test-mode CREDIT order: payment override still required until HYP exists', async () => {
  const r = await run(READY)
  for (const k of ['Payment method: credit', 'HYP required: YES', 'HYP verified: NO', 'Controlled-test overrides required: payment = YES, area = YES'])
    assert.ok(r.text.includes(k), k)
  const d = await run(DISPATCH)
  assert.equal(d.code, 0); assert.equal(JSON.parse(d.calls[0].init.body).payment_method, 'credit')
})

await test('08D14 · 33. normal (non-test) behavior is unaffected by the runner: credit still blocked by HYP, cash by area', async () => {
  const base = { config: { status: 'ready', apiKey: KEY }, send: async () => { throw new Error('must not send') }, now: () => '2026-10-05T10:00:00.000Z',
    isPaymentVerified: async () => false }
  assert.equal((await D.dispatchOrderToMaale(ORDER_ID, { ...base, repo: memRepo().repo })).reason, 'payment_not_verified')
  const cash = memRepo({ orderSnapshot: snapshot({ order: { payment_method: 'cash' } }) })
  assert.equal((await D.dispatchOrderToMaale(ORDER_ID, { ...base, repo: cash.repo })).reason, 'area_not_ready')
})

await test('extra: .env.local loader fills only unset keys and prints nothing', async () => {
  const { writeFileSync, mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(join(tmpdir(), 'maale-env-'))
  const f = join(dir, '.env.local')
  writeFileSync(f, 'MAALE_EXPRESS_ENABLED=true\nMAALE_EXPRESS_API_KEY="abc"\n# comment\nEXISTING=new\n')
  const env = { EXISTING: 'old' }
  const logs = []
  const orig = console.log; console.log = (...a) => logs.push(a.join(' '))
  try { runner.loadEnvLocal(f, env) } finally { console.log = orig }
  assert.deepEqual(env, { EXISTING: 'old', MAALE_EXPRESS_ENABLED: 'true', MAALE_EXPRESS_API_KEY: 'abc' }); assert.equal(logs.length, 0)
})

console.log(`\nAll ${passed} controlled-test-runner checks passed.`)
