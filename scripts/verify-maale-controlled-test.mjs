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
      async loadOrder(id) { return id === ORDER_ID ? { snapshot: orderSnapshot, status, parcelStatus: null } : null }, // like the real repo: no parcel
      async getDispatch(id) { return state.row && id === ORDER_ID ? { order_id: id, external_order_id: state.row.external_order_id, status: state.row.status, attempts: state.row.attempts, last_attempt_at: state.row.last_attempt_at } : null },
      async insertPending(id) { state.writes++; if (!state.row) state.row = { order_id: id, external_order_id: id, status: 'pending', attempts: 0, last_attempt_at: null } },
      async claim(id, seen, now) {
        state.writes++
        const r = state.row
        if (!r || r.status !== seen.status || r.attempts !== seen.attempts || r.last_attempt_at !== seen.last_attempt_at) return 'claim_lost'
        Object.assign(r, { status: 'sending', attempts: seen.attempts + 1, last_attempt_at: now }); return 'claimed'
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

// 03F/03T: the fake repo below (memRepo) has NO hasRecentAuthFailure, like a legacy repo. Since S4-03T the runner passes
// the method through when the repo has it (see section 03T); without it readiness still fails closed (auth_state_unknown).
await test('1 (03F). readiness mode: zero network calls, zero writes, safe report; fails closed on unknown auth state', async () => {
  const r = await run(READY)
  assert.equal(r.calls.length, 0); assert.equal(r.mem.state.writes, 0); assert.equal(r.code, 1)
  for (const k of ['Order: ' + ORDER_ID, 'Order status: confirmed', 'Delivery: YES', 'Branch: Mishor Adumim', 'Test marker: PASS', 'Payment method: credit', 'HYP required: NO',
    'Address: complete', 'Coordinates: precise', 'Payload: valid', 'Dispatch state: none', 'Maale enabled: YES', 'Maale key configured: YES',
    'Area ready: YES', 'Controlled-test overrides required: payment = NO, area = NO', 'credit_dispatch_disabled', 'auth_state_unknown', 'Result: NOT READY (credit_dispatch_disabled)'])
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

await test('11–13 (03F). test mode bypasses nothing: credit stays blocked; the runner refuses (no network, no writes)', async () => {
  const blocked = await run(DISPATCH)
  assert.equal(blocked.code, 1); assert.equal(blocked.calls.length, 0); assert.equal(blocked.mem.state.writes, 0)
  assert.match(blocked.text, /REFUSED: readiness has blockers/)
  // Same order, direct service call: credit is blocked whether or not a payment check says "verified".
  const m = memRepo()
  const base = { config: { status: 'ready', apiKey: KEY }, repo: m.repo, send: async () => { throw new Error('must not send') }, now: () => '2026-10-05T10:00:00.000Z' }
  assert.equal((await D.dispatchOrderToMaale(ORDER_ID, { ...base, isPaymentVerified: async () => false })).reason, 'credit_dispatch_disabled')
  assert.equal((await D.dispatchOrderToMaale(ORDER_ID, { ...base, isPaymentVerified: async () => true },
    { testMode: { orderId: ORDER_ID, bypassPaymentGate: true, bypassAreaGate: true } })).reason, 'credit_dispatch_disabled')
  // Unmarked order: the runner refuses, and testMode itself refuses too.
  await refused({ orderSnapshot: snapshot({ order: { customer_name: 'לקוח אמיתי' } }) }, 'test_order_marker_missing')
  const u = memRepo({ orderSnapshot: snapshot({ order: { customer_name: 'לקוח אמיתי' } }) })
  const r = await D.dispatchOrderToMaale(ORDER_ID, { ...base, repo: u.repo, isPaymentVerified: async () => false },
    { testMode: { orderId: ORDER_ID, bypassPaymentGate: true, bypassAreaGate: true } })
  assert.equal(r.reason, 'test_order_marker_missing')
  const code = readFileSync(join(ROOT, 'scripts', 'maale-controlled-test.mjs'), 'utf8').replace(/^\s*\/\/.*$/gm, '')
  assert.ok(!/bypassPaymentGate|bypassAreaGate/.test(code), 'S4-03T: the runner passes no bypass flags at all (comments excluded)')
  assert.equal((code.match(/dispatchOrderToMaale\(/g) || []).length, 1, 'exactly one dispatch call site')
  assert.ok(code.includes('testMode: { orderId } }'))
})

await test('14. a sent order is never resent', async () => refused({ row: { status: 'sent', attempts: 1, last_attempt_at: '2026-10-05T09:00:00.000Z' } }, 'dispatch_already_sent'))

await test('15–16 (03F). a previously failed row is reported, never resent by the runner (ambiguous → manual review)', async () => {
  const cash = { orderSnapshot: snapshot({ order: { payment_method: 'cash' } }) }
  const r = await run(DISPATCH, { ...cash, row: { status: 'failed_retryable', attempts: 1, last_attempt_at: '2026-10-05T09:59:00.000Z', error_code: 'provider_5xx' } })
  assert.equal(r.code, 1); assert.equal(r.calls.length, 0); assert.equal(r.mem.state.writes, 0)
  assert.match(r.text, /Dispatch state: failed_retryable/)
})

await test('17. no secrets printed (API key, service key, raw provider body)', async () => {
  const outs = [await run(READY), await run(DISPATCH), await run(DISPATCH, { respond: () => jsonRes({ message: `bad key ${KEY}`, secret: 'provider-internal' }, 401) })]
  for (const r of outs) {
    for (const s of [KEY, SERVICE_KEY, 'provider-internal', 'X-Api-Key', 'access_token']) assert.ok(!r.text.includes(s), s)
    assert.equal(r.calls.length, 0, 'fail closed: nothing sent')
  }
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

await test('08D14 · 31 (03F). test-mode CASH order: no override required; a repo without the auth lookup still fails closed', async () => {
  const cashOrder = { orderSnapshot: snapshot({ order: { payment_method: 'cash' } }) }
  const r = await run(READY, cashOrder)
  for (const k of ['Payment method: cash', 'HYP required: NO', 'HYP verified: n/a (cash)', 'Controlled-test overrides required: payment = NO, area = NO', 'Result: NOT READY (auth_state_unknown)'])
    assert.ok(r.text.includes(k), k)
  const d = await run(DISPATCH, cashOrder)
  assert.equal(d.code, 1); assert.equal(d.calls.length, 0); assert.equal(d.mem.state.writes, 0)
})

await test('08D14 · 32 (03F). test-mode CREDIT order: blocked outright (no payment override exists)', async () => {
  const r = await run(READY)
  for (const k of ['Payment method: credit', 'HYP required: NO', 'Controlled-test overrides required: payment = NO, area = NO', 'credit_dispatch_disabled'])
    assert.ok(r.text.includes(k), k)
  const d = await run(DISPATCH)
  assert.equal(d.code, 1); assert.equal(d.calls.length, 0)
})

await test('08D14 · 33 (03F). normal service behavior: credit blocked; cash with a legacy repo (no auth check) fails closed', async () => {
  const base = { config: { status: 'ready', apiKey: KEY }, send: async () => { throw new Error('must not send') }, now: () => '2026-10-05T10:00:00.000Z',
    isPaymentVerified: async () => false }
  assert.equal((await D.dispatchOrderToMaale(ORDER_ID, { ...base, repo: memRepo().repo })).reason, 'credit_dispatch_disabled')
  const cash = memRepo({ orderSnapshot: snapshot({ order: { payment_method: 'cash' } }) })
  assert.equal((await D.dispatchOrderToMaale(ORDER_ID, { ...base, repo: cash.repo })).reason, 'auth_state_unknown')
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

/* ─── S4-03T: auth-stop wiring + sanitized post-attempt summary (FAKE repo with the full contract, FAKE quote) ─── */
console.log('S4-03T runner fix (fake DB, fake provider)')

const okQuote = { ok: true, kind: 'quote', status: 200, zone: 'mishor', deliveryFeeAgorot: 2000, courierPaysMerchantAgorot: 5300, courierCollectsFromCustomerAgorot: 7300, warnings: [] }
const CASH = snapshot({ order: { payment_method: 'cash' } })

/** Full read+write contract incl. hasRecentAuthFailure and provider fields; auth: 'clear' | 'active' | 'throws'. */
function fullRepo({ auth = 'clear', status = 'confirmed', row = null, orderSnapshot = CASH, markSentOk = true } = {}) {
  const st = { row: row ? { external_order_id: ORDER_ID, attempts: 0, last_attempt_at: null, error_code: null, provider_order_id: null, provider_status: null, ...row, order_id: ORDER_ID } : null,
    writes: 0, authCalls: 0 }
  const view = r => r && { order_id: r.order_id, external_order_id: r.external_order_id, status: r.status, attempts: r.attempts, last_attempt_at: r.last_attempt_at, error_code: r.error_code }
  return {
    st,
    repo: {
      async loadOrder(id) { return id === ORDER_ID ? { snapshot: orderSnapshot, status, parcelStatus: null } : null },
      async getDispatch(id) { return id === ORDER_ID ? view(st.row) : null },
      async hasRecentAuthFailure() { st.authCalls++; if (auth === 'throws') throw new Error('db down'); return auth === 'active' },
      async insertPending(id) { st.writes++; if (!st.row) st.row = { order_id: id, external_order_id: id, status: 'pending', attempts: 0, last_attempt_at: null, error_code: null, provider_order_id: null, provider_status: null } },
      async claim(id, seen, now) {
        st.writes++; const r = st.row
        if (!r || r.status !== seen.status || r.attempts !== seen.attempts || r.last_attempt_at !== seen.last_attempt_at) return 'claim_lost'
        Object.assign(r, { status: 'sending', attempts: r.attempts + 1, last_attempt_at: now }); return 'claimed'
      },
      async markSent(id, v) { st.writes++; if (!markSentOk || st.row?.status !== 'sending') return false; Object.assign(st.row, { status: 'sent', provider_order_id: v.providerOrderId ?? null, provider_status: v.providerStatus ?? null }); return true },
      async markFailed(id, s, code) { st.writes++; if (st.row?.status !== 'sending') return false; Object.assign(st.row, { status: s, error_code: code }); return true },
    },
  }
}

async function run3(argv, { respond = () => jsonRes({ order: { id: 'MX-123', status: 'searching' } }, 201), quote = okQuote, summary = 'row', ...repoOpts } = {}) {
  const mem = fullRepo(repoOpts)
  const calls = [], out = []
  let quotes = 0, created = 0
  const config = { status: 'ready', apiKey: KEY }
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return respond(url, init) }
  const createDeps = () => {
    created++
    return {
      config, repo: mem.repo, isPaymentVerified: async () => false,
      send: p => client.sendMaaleOrder(p, { config, fetchImpl, timeoutMs: 40 }),
      quote: async () => { quotes++; return quote },
      now: () => '2026-10-05T10:00:00.000Z', log: () => {},
      ...(summary === 'row' ? { readDispatchSummary: async () => (mem.st.row ? { ...mem.st.row } : null) }
        : summary === 'throws' ? { readDispatchSummary: async () => { throw new Error('read failed') } } : {}),
    }
  }
  const code = await runner.runMaaleControlledTest(argv, { createDeps, print: l => out.push(l) })
  return { code, out, text: out.join('\n'), sends: calls.length, quotes, mem, created }
}

await test('T1. hasRecentAuthFailure is wired into readiness: clean auth → READY (one lookup, no network, no writes)', async () => {
  const r = await run3(READY)
  assert.equal(r.code, 0, r.text); assert.equal(r.mem.st.authCalls, 1)
  assert.ok(r.text.includes('Blockers: none') && r.text.includes('Result: READY FOR CONTROLLED TEST'))
  assert.equal(r.sends + r.quotes + r.mem.st.writes, 0)
})

await test('T2. clean auth: one quote, one submission, provider id + status shown, reconciliation NO, exit 0', async () => {
  const r = await run3(DISPATCH)
  assert.equal(r.code, 0, r.text); assert.equal(r.quotes, 1); assert.equal(r.sends, 1)
  assert.ok(r.mem.st.authCalls >= 2, 'auth stop checked in readiness AND again inside the dispatch service')
  for (const k of ['── Dispatch summary ──', 'Result: created', `External order ID: ${ORDER_ID}`, 'Provider order ID: MX-123', 'Provider status: searching',
    'Dispatch state: sent (attempts 1)', 'Manual reconciliation required: NO']) assert.ok(r.text.includes(k), `${k}\n${r.text}`)
})

await test('T3. recent auth failure → auth_stop_active blocker; nothing quoted, sent or written', async () => {
  const r = await run3(DISPATCH, { auth: 'active' })
  assert.equal(r.code, 1); assert.ok(r.text.includes('auth_stop_active')); assert.match(r.text, /REFUSED: readiness has blockers/)
  assert.equal(r.sends + r.quotes + r.mem.st.writes, 0)
})

await test('T4. unknown auth state (lookup throws / method missing) → auth_state_unknown; refused', async () => {
  const r = await run3(DISPATCH, { auth: 'throws' })
  assert.equal(r.code, 1); assert.ok(r.text.includes('auth_state_unknown')); assert.equal(r.sends + r.quotes + r.mem.st.writes, 0)
  const legacy = await run(DISPATCH, { orderSnapshot: CASH }) // memRepo: no hasRecentAuthFailure
  assert.equal(legacy.code, 1); assert.ok(legacy.text.includes('auth_state_unknown')); assert.equal(legacy.calls.length, 0)
})

await test('T5. persistence failure after the provider accepted → never shown as success; reconciliation YES; exit 1', async () => {
  const r = await run3(DISPATCH, { markSentOk: false })
  assert.equal(r.code, 1); assert.equal(r.sends, 1)
  assert.ok(r.text.includes('Result: persistence_failed (provider outcome: created) — NOT CONFIRMED'), r.text)
  assert.ok(!/Result: created/.test(r.text)); assert.ok(r.text.includes('Dispatch state: sending (attempts 1)'))
  assert.ok(r.text.includes('Provider order ID: UNKNOWN'))
  assert.match(r.text, /Manual reconciliation required: YES — do NOT re-run/)
  const again = await run3(DISPATCH, { row: { ...r.mem.st.row } }) // operator re-runs anyway
  assert.equal(again.sends + again.quotes, 0, 'a sending row is never resubmitted'); assert.equal(again.code, 1)
})

await test('T6. sanitized output: unsafe provider id / status, raw body, key and PII never printed', async () => {
  const r = await run3(DISPATCH, { respond: () => jsonRes({ order: { id: `0501234567 ${KEY}`, status: 'Searching <b>' }, message: 'provider-internal', echo: 'הגעש 6' }, 201) })
  for (const s of [KEY, SERVICE_KEY, 'provider-internal', 'Searching', '<b>', 'X-Api-Key', ...PII, TEST_NAME]) assert.ok(!r.text.includes(s), s)
  assert.ok(r.text.includes('Provider order ID: UNKNOWN') && r.text.includes('Provider status: UNKNOWN'))
  const fmt = runner.formatDispatchSummary(ORDER_ID, { ok: true, outcome: 'sent', kind: 'created' },
    { external_order_id: ORDER_ID, status: 'sent', attempts: 1, provider_order_id: 'bad id;drop', provider_status: 'OK!', error_code: 'Not Valid' })
  assert.deepEqual(fmt, ['Result: created', `External order ID: ${ORDER_ID}`, 'Provider order ID: UNKNOWN', 'Provider status: UNKNOWN',
    'Dispatch state: sent (attempts 1)', 'Manual reconciliation required: NO'])
})

await test('T7. unverifiable result → UNKNOWN + reconciliation YES (summary unreadable / row mismatch / duplicate)', async () => {
  const unreadable = await run3(DISPATCH, { summary: 'throws' })
  assert.equal(unreadable.sends, 1); assert.equal(unreadable.code, 1)
  for (const k of ['Result: created', 'External order ID: UNKNOWN', 'Provider order ID: UNKNOWN', 'Dispatch state: UNKNOWN']) assert.ok(unreadable.text.includes(k), k)
  assert.match(unreadable.text, /Manual reconciliation required: YES/)
  const f = (res, row) => runner.formatDispatchSummary(ORDER_ID, res, row).at(-1)
  assert.match(f({ ok: true, outcome: 'sent', kind: 'created' }, { external_order_id: 'other', status: 'sent', attempts: 1 }), /YES/)
  assert.match(f({ ok: true, outcome: 'sent', kind: 'created' }, { external_order_id: ORDER_ID, status: 'sending', attempts: 1 }), /YES/)
  assert.match(f({ ok: true, outcome: 'sent', kind: 'duplicate' }, { external_order_id: ORDER_ID, status: 'sent', attempts: 1 }), /YES/, 'duplicate needs a check')
  assert.match(f({ ok: false, outcome: 'failed', retryable: true, errorCode: 'timeout', ambiguous: true }, { external_order_id: ORDER_ID, status: 'failed_retryable', attempts: 1 }), /YES/)
  assert.ok(runner.formatDispatchSummary(ORDER_ID, { ok: true, outcome: 'sent', kind: 'created' }, { external_order_id: ORDER_ID, status: 'weird' }).includes('Dispatch state: UNKNOWN'))
})

await test('T8. timeout → one submission only, no retry; reconciliation YES; a re-run is refused', async () => {
  const hang = (_u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))))
  const r = await run3(DISPATCH, { respond: hang })
  assert.equal(r.sends, 1); assert.equal(r.quotes, 1); assert.equal(r.code, 1)
  assert.ok(r.text.includes('Result: timeout (retryable)') && r.text.includes('Dispatch state: failed_retryable (attempts 1) [timeout]'), r.text)
  const again = await run3(DISPATCH, { row: { ...r.mem.st.row } })
  assert.equal(again.sends + again.quotes + again.mem.st.writes, 0); assert.match(again.text, /REFUSED: readiness has blockers/)
})

await test('T9. no submission without --confirm-test, with a wrong / unknown UUID, or without the test marker (clean auth)', async () => {
  for (const argv of [['dispatch', ORDER_ID], ['dispatch', ORDER_ID, '--confirm'], ['dispatch', 'not-a-uuid', '--confirm-test']]) {
    const r = await run3(argv)
    assert.equal(r.created, 0, JSON.stringify(argv)); assert.equal(r.sends + r.quotes, 0)
  }
  const unknown = await run3(['dispatch', '99999999-2222-4333-8444-555555555555', '--confirm-test'])
  assert.ok(unknown.text.includes('order_not_found')); assert.equal(unknown.sends + unknown.quotes + unknown.mem.st.writes, 0); assert.equal(unknown.code, 1)
  const unmarked = await run3(DISPATCH, { orderSnapshot: snapshot({ order: { payment_method: 'cash', customer_name: 'לקוח אמיתי' } }) })
  assert.ok(unmarked.text.includes('test_order_marker_missing')); assert.equal(unmarked.sends + unmarked.quotes + unmarked.mem.st.writes, 0)
  assert.ok(!unmarked.text.includes('לקוח אמיתי'))
})

await test('T10. existing dispatch record → no new submission and no reset (sent / sending / failed / non-zero pending)', async () => {
  const rows = [
    { status: 'sent', attempts: 1, last_attempt_at: '2026-10-05T09:00:00.000Z', provider_order_id: 'MX-9' },
    { status: 'sending', attempts: 1, last_attempt_at: '2026-10-05T09:59:00.000Z' },
    { status: 'sending', attempts: 1, last_attempt_at: '2026-10-05T08:00:00.000Z' },
    { status: 'failed_retryable', attempts: 1, last_attempt_at: '2026-10-05T09:00:00.000Z', error_code: 'rate_limited' },
    { status: 'failed_final', attempts: 1, last_attempt_at: '2026-10-05T09:00:00.000Z', error_code: 'out_of_area' },
    { status: 'pending', attempts: 1, last_attempt_at: null },
  ]
  for (const row of rows) {
    const r = await run3(DISPATCH, { row })
    assert.equal(r.code, 1, row.status); assert.equal(r.sends + r.quotes + r.mem.st.writes, 0, JSON.stringify(row))
    assert.equal(r.mem.st.row.status, row.status, 'row untouched'); assert.match(r.text, /REFUSED: readiness has blockers/)
  }
  const src = readFileSync(join(ROOT, 'scripts', 'maale-controlled-test.mjs'), 'utf8').replace(/^\s*\/\/.*$/gm, '')
  assert.ok(!/\.(update|delete|upsert|insert)\(/.test(src), 'runner itself never writes the DB (only the service claims / marks)')
  assert.ok(!/for \(|while \(|retry/i.test(src.slice(src.indexOf('dispatchOrderToMaale('), src.indexOf('── Dispatch summary'))), 'no loop / retry around the call')
})

await test('T11. realDeps adds only a read-only summary query; no network in this suite', async () => {
  const src = readFileSync(join(ROOT, 'scripts', 'maale-controlled-test.mjs'), 'utf8')
  assert.ok(src.includes(".select('external_order_id, status, attempts, error_code, provider_order_id, provider_status').eq('order_id', orderId).maybeSingle()"))
  assert.ok(!/select\('\*'\)|customer|phone|address/.test(src.slice(src.indexOf('async function readDispatchSummaryFromDb'), src.indexOf('/* ─── Sanitized'))))
  await assert.rejects(() => globalThis.fetch('https://example.invalid'), /LIVE NETWORK CALL ATTEMPTED/)
})

console.log(`\nAll ${passed} controlled-test-runner checks passed.`)
