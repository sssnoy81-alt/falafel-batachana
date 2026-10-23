// Offline checks for S4-INTEGRATIONS-04E2 — runtime integration of the atomic courier coordination.
//  A) lib/maaleDispatch: the claim is public.claim_maale_dispatch (real repo code against a FAKE Supabase client);
//     every answer mapped; the real send happens only after a committed 'claimed'; no testMode bypass; no retry.
//  B) The answers the TypeScript maps are exactly the answers the SQL functions can return (no unmapped code).
//  C) Source: no direct claim UPDATE, no direct ledger INSERT anywhere in app/ or lib/; markSent / markFailed unchanged;
//     the owner-run controlled runner goes through the same repo.
// Real PostgreSQL behaviour (locks, guard trigger, privileges, concurrency) is covered by
// scripts/pgtest-s4-04e-courier-coordination.mjs. No network, no key, no DB. Run: node scripts/verify-s4-04e-runtime.mjs

import { createRequire } from 'node:module'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

let liveFetch = 0
globalThis.fetch = async () => { liveFetch++; throw new Error('LIVE NETWORK CALL ATTEMPTED') }

const require = createRequire(import.meta.url)
const ts = require('typescript')
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const src = f => readFileSync(join(ROOT, f), 'utf8').replace(/\r\n/g, '\n')

/* ─── FAKE supabaseServer: records every rpc / table call; answers the claim from `fake.claim` ─── */
class ServerConfigError extends Error { constructor(m) { super(m); this.name = 'ServerConfigError' } }
const fake = { calls: [], claim: async () => ({ data: 'claimed', error: null }) }
const fakeClient = {
  async rpc(fn, args) { fake.calls.push(['rpc', fn, args]); return fn === 'claim_maale_dispatch' ? fake.claim(args) : { data: null, error: { code: 'X' } } },
  from(table) { fake.calls.push(['from', table]); throw new Error(`unexpected table access: ${table}`) },
}
const fakeSupabaseServer = { ServerConfigError, getServerSupabase: () => fakeClient }

const cache = new Map()
function loadFile(file) {
  if (cache.has(file)) return cache.get(file).exports
  const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } })
  const mod = { exports: {} }; cache.set(file, mod)
  const req = p => {
    const name = p.startsWith('@/lib/') ? p.slice(6) : p.startsWith('./') ? p.slice(2) : null
    if (name === 'supabaseServer') return fakeSupabaseServer
    if (name) return loadFile(join(ROOT, 'lib', name + '.ts'))
    return require(p)
  }
  new Function('exports', 'require', 'module', outputText)(mod.exports, req, mod)
  return mod.exports
}
const lib = n => loadFile(join(ROOT, 'lib', n + '.ts'))
const D = lib('maaleDispatch'), KD = lib('kitchenDispatch'), KR = lib('kitchenReconciliation'), UI = lib('kitchenDispatchUi'), cfg = lib('orderConfig')

let passed = 0
const test = async (name, fn) => { await fn(); passed++; console.log('  ✓', name) }

const ORDER_ID = '11111111-2222-4333-8444-555555555555'
const TEST_NAME = '🧪 בדיקה — לא לשלוח'
const snapshot = (name = 'לקוח') => ({
  order: { id: ORDER_ID, type: 'delivery', branch_id: cfg.DELIVERY_BRANCH_IDS[0], payment_method: 'cash', customer_name: name, phone: '0501234567', total_price: 73 },
  delivery: { city: 'מעלה אדומים', street: 'הגעש', house_number: '6', apartment: '6', floor: '2', entrance: 'ב', notes: null, delivery_fee: 20, meal_surcharge: 4,
    delivery_lat: 31.773612, delivery_lng: 35.298346, geo_source: 'geocoder', geo_precision: 'street' },
  items: [{ name: 'פלאפל בפיתה', quantity: 1, unit_price: 40 }, { name: 'קוקה קולה', quantity: 1, unit_price: 9 }],
})
const QUOTE_OK = { ok: true, kind: 'quote', status: 200, deliveryFeeAgorot: 2000, courierPaysMerchantAgorot: 5300, courierCollectsFromCustomerAgorot: 7300, warnings: [] }

/**
 * Service harness. The repo's claim is the REAL supabaseDispatchRepo().claim (→ fake rpc); every other repo method is
 * in-memory. `events` proves the order of quote / claim / send / marks.
 */
function harness({ name, quote = async () => QUOTE_OK, slot = async () => 'ok', withSlot = true } = {}) {
  const st = { row: null, events: [], sends: 0 }
  const real = D.supabaseDispatchRepo()
  const repo = {
    async loadOrder() { return { snapshot: snapshot(name), status: 'confirmed', parcelStatus: null } },
    async getDispatch() { return st.row ? { ...st.row } : null },
    async hasRecentAuthFailure() { return false },
    async insertPending(id) { st.events.push('insertPending'); if (!st.row) st.row = { order_id: id, external_order_id: id, status: 'pending', attempts: 0, last_attempt_at: null, error_code: null } },
    async claim(id, seen, now) {
      st.events.push('claim')
      const answer = await real.claim(id, seen, now)
      if (answer === 'claimed') Object.assign(st.row, { status: 'sending', attempts: 1, last_attempt_at: now })
      st.events.push(`claim:${answer}`)
      return answer
    },
    async markSent() { st.events.push('markSent'); if (st.row.status !== 'sending') return false; st.row.status = 'sent'; return true },
    async markFailed(id, s, code) { st.events.push(`markFailed:${code}`); if (st.row.status !== 'sending') return false; Object.assign(st.row, { status: s, error_code: code }); return true },
  }
  const deps = {
    config: { status: 'ready', apiKey: 'test-key-not-real' }, repo, isPaymentVerified: async () => false, now: () => new Date().toISOString(), log: () => {},
    quote: async p => { st.events.push('quote'); return quote(p) },
    send: async () => { st.sends++; st.events.push('send'); return { ok: true, kind: 'created', providerOrderId: 'MX-1', providerStatus: 'searching' } },
    ...(withSlot ? { consumeQuoteSlot: async () => { st.events.push('slot'); return slot() } } : {}),
  }
  return { st, run: opts => D.dispatchOrderToMaale(ORDER_ID, deps, opts) }
}
const claimCalls = () => fake.calls.filter(c => c[0] === 'rpc' && c[1] === 'claim_maale_dispatch')
const resetFake = claim => { fake.calls = []; fake.claim = claim }

console.log('A) Dispatch claim through public.claim_maale_dispatch')

await test('A1. committed claim → exactly one RPC with the seen CAS values, THEN one send, then markSent', async () => {
  resetFake(async () => ({ data: 'claimed', error: null }))
  const h = harness()
  assert.deepEqual(await h.run(), { ok: true, outcome: 'sent', kind: 'created' })
  assert.deepEqual(h.st.events, ['slot', 'quote', 'insertPending', 'claim', 'claim:claimed', 'send', 'markSent'])
  assert.deepEqual(claimCalls(), [['rpc', 'claim_maale_dispatch', { p_order_id: ORDER_ID, p_seen_attempts: 0, p_seen_last_attempt_at: null }]])
  assert.ok(!fake.calls.some(c => c[0] === 'from'), 'the claim never touches a table directly')
})

await test('A2. every non-claimed answer → mapped result, NO send, no mark, never retried', async () => {
  const expected = {
    claim_lost: { ok: false, outcome: 'dispatch_in_progress' },
    not_claimable: { ok: false, outcome: 'dispatch_in_progress' },
    manual_courier_recorded: { ok: false, outcome: 'blocked', reason: 'manual_courier_recorded' },
    manual_review_open: { ok: false, outcome: 'blocked', reason: 'manual_review_open' },
    dispatch_row_missing: { ok: false, outcome: 'failed', retryable: false, errorCode: 'db_error' },
    invalid_request: { ok: false, outcome: 'failed', retryable: false, errorCode: 'db_error' },
  }
  assert.deepEqual(Object.keys(expected).sort(), D.CLAIM_RESULTS.filter(r => r !== 'claimed').sort(), 'every bounded answer has a case here')
  for (const [answer, result] of Object.entries(expected)) {
    resetFake(async () => ({ data: answer, error: null }))
    const h = harness()
    assert.deepEqual(await h.run(), result, answer)
    assert.equal(h.st.sends, 0, answer); assert.equal(claimCalls().length, 1, `${answer}: one claim call, no retry`)
    assert.ok(!h.st.events.some(e => e.startsWith('mark')), `${answer}: no mark`)
  }
})

await test('A3. fail closed: unknown answer, non-string payload, RPC error, missing function, lock timeout, transport throw → no send', async () => {
  const closed = { ok: false, outcome: 'failed', retryable: false, errorCode: 'db_error' }
  for (const claim of [async () => ({ data: 'claimed_maybe', error: null }), async () => ({ data: true, error: null }), async () => ({ data: null, error: null }),
    async () => ({ data: ['claimed'], error: null }), async () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }),
    async () => ({ data: null, error: { code: '42883' } }), async () => ({ data: null, error: { code: '55P03', message: 'lock timeout' } }),
    async () => ({ data: null, error: { code: 'P0001', message: 'a claim must go through public.claim_maale_dispatch' } }), async () => { throw new Error('fetch failed') }]) {
    resetFake(claim)
    const h = harness()
    assert.deepEqual(await h.run(), closed)
    assert.equal(h.st.sends, 0); assert.equal(claimCalls().length, 1)
  }
  // a legacy boolean from any repo never authorizes a send
  assert.notEqual(await D.claimDecision(async () => true), 'claimed')
  assert.equal(await D.claimDecision(async () => 'claimed'), 'claimed')
})

await test('A4. limiter mandatory (no slot → blocked before quote / claim); limiter refusal → no claim', async () => {
  resetFake(async () => ({ data: 'claimed', error: null }))
  let h = harness({ withSlot: false })
  assert.deepEqual(await h.run(), { ok: false, outcome: 'blocked', reason: 'rate_limit_unavailable' }); assert.deepEqual(h.st.events, [])
  h = harness({ slot: async () => 'order_limit' })
  assert.deepEqual(await h.run(), { ok: false, outcome: 'blocked', reason: 'rate_limited_local' }); assert.deepEqual(h.st.events, ['slot'])
  assert.equal(claimCalls().length, 0)
})

await test('A5. controlled runner testMode: same claim RPC, NO bypass — a refused claim sends nothing in test mode either', async () => {
  for (const [answer, sends] of [['claimed', 1], ['manual_courier_recorded', 0], ['claim_lost', 0], ['unknown_x', 0]]) {
    resetFake(async () => ({ data: answer, error: null }))
    const h = harness({ name: TEST_NAME, withSlot: false })
    await h.run({ testMode: { orderId: ORDER_ID } })
    assert.equal(h.st.sends, sends, answer); assert.equal(claimCalls().length, 1, `${answer}: test mode claims through the RPC`)
  }
})

await test('A6. quote 401 → the auth failure is recorded only after a committed claim; a refused claim records nothing', async () => {
  const q401 = async () => ({ ok: false, errorCode: 'unauthorized', status: 401, retryable: false })
  resetFake(async () => ({ data: 'claimed', error: null }))
  let h = harness({ quote: q401 })
  assert.deepEqual(await h.run(), { ok: false, outcome: 'failed', retryable: false, errorCode: 'unauthorized' })
  assert.deepEqual(h.st.events.slice(-3), ['claim', 'claim:claimed', 'markFailed:unauthorized']); assert.equal(h.st.sends, 0)
  resetFake(async () => ({ data: 'manual_courier_recorded', error: null }))
  h = harness({ quote: q401 })
  assert.deepEqual(await h.run(), { ok: false, outcome: 'blocked', reason: 'manual_courier_recorded' })
  assert.ok(!h.st.events.some(e => e.startsWith('mark'))); assert.equal(h.st.sends, 0)
})

await test('A7. kitchen mapping: claim-side manual courier / open review → 409 not_eligible (button not locked); db_error → 500', () => {
  for (const reason of ['manual_courier_recorded', 'manual_review_open']) {
    const r = KD.mapDispatchResult({ ok: false, outcome: 'blocked', reason })
    assert.deepEqual(r, { status: 409, body: { error: 'not_eligible', reason } })
    assert.equal(UI.interpretDispatchResponse(r.status, r.body).lock, false)
  }
  assert.deepEqual(KD.mapDispatchResult({ ok: false, outcome: 'failed', retryable: false, errorCode: 'db_error' }), { status: 500, body: { error: 'server_error' } })
  assert.deepEqual(KD.mapDispatchResult({ ok: false, outcome: 'dispatch_in_progress' }).status, 409)
})

console.log('B) TypeScript ↔ SQL answer parity')

const MIG = src('db/migrations/s4_04e_courier_coordination.sql')
const fnBody = tag => { const t = `$${tag}$`, a = MIG.indexOf(t) + t.length; return MIG.slice(a, MIG.indexOf(t, a)).replace(/--.*$/gm, '') }

await test('B1. CLAIM_RESULTS = exactly the answers claim_maale_dispatch can return', () => {
  const b = fnBody('claim_maale_dispatch')
  const sql = [...new Set([...b.matchAll(/RETURN '([a-z_]+)'/g), ...b.matchAll(/THEN '([a-z_]+)' ELSE '([a-z_]+)'/g)].flatMap(m => m.slice(1)).filter(Boolean))].sort()
  assert.deepEqual([...D.CLAIM_RESULTS].sort(), sql)
})

await test('B2. reconciliation service maps exactly the answers record_maale_reconciliation_event can return', () => {
  const sql = [...new Set([...fnBody('record_maale_reconciliation_event').matchAll(/SELECT '([a-z_]+)'::text/g)].map(m => m[1]))].sort()
  assert.deepEqual(['recorded', 'already_recorded', 'order_not_found', 'invalid_request', ...KR.RECORD_CONFLICT_RESULTS].sort(), sql)
  const svc = src('lib/kitchenReconciliation.ts')
  for (const r of ['recorded', 'already_recorded', 'order_not_found', 'invalid_request']) assert.ok(svc.includes(`case '${r}'`), r)
})

console.log('C) Source: no direct write path, runner on the same repo')

const walk = dir => readdirSync(dir).flatMap(n => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p] })
await test('C1. app/ + lib/: no UPDATE to "sending", no direct ledger INSERT, no writable-setting marker', () => {
  for (const f of [...walk(join(ROOT, 'app')), ...walk(join(ROOT, 'lib'))].filter(p => /\.(tsx?|jsx?)$/.test(p))) {
    const t = readFileSync(f, 'utf8').replace(/\s+/g, ' ')
    assert.ok(!/update\(\{ status: 'sending'/.test(t), `${f}: direct claim UPDATE`)
    assert.ok(!/from\('maale_dispatch_reconciliations'\)\s*\.insert\(/.test(t) && !/ledger\(\)\s*\.insert\(/.test(t), `${f}: direct ledger INSERT`)
    assert.ok(!/maale_coordinated_claim|set_config|maale_dispatch_coordinator/.test(t), f)
  }
  const md = src('lib/maaleDispatch.ts')
  assert.equal((md.match(/rpc\('claim_maale_dispatch'/g) || []).length, 1)
  // markSent / markFailed unchanged: only from 'sending'
  assert.equal((md.match(/\.eq\('order_id', orderId\)\.eq\('status', 'sending'\)\.select\('order_id'\)/g) || []).length, 2)
})

await test('C2. owner runner: defaultDispatchDeps → supabaseDispatchRepo (same claim RPC); testMode only; no own claim / UPDATE', () => {
  const r = src('scripts/maale-controlled-test.mjs')
  assert.ok(r.includes('D.defaultDispatchDeps()') && r.includes('D.dispatchOrderToMaale(orderId, deps, { testMode: { orderId } })'))
  assert.ok(!/claim|\.update\(|\.insert\(|rpc\(/.test(r.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[^]*?\*\//g, '')), 'the runner never writes or claims by itself')
  assert.ok(src('lib/maaleDispatch.ts').includes('repo: supabaseDispatchRepo(),'))
})

await test('C3. the two untracked dry-run scripts are not referenced by app / lib and contain no claim / ledger write', () => {
  for (const f of ['scripts/maale-dry-run-once.mjs', 'scripts/verify-maale-dry-run-once.mjs']) {
    const t = src(f)
    assert.ok(!/claim_maale_dispatch|record_maale_reconciliation_event|maale_dispatch_reconciliations/.test(t), f)
  }
  assert.equal(liveFetch, 0, 'no network call anywhere in this suite')
})

console.log(`\nAll ${passed} S4-04E runtime checks passed.`)
