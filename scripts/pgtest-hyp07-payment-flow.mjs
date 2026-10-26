// HYP-07 — ISOLATED end-to-end test of the payment routes' service (lib/hyp/hypPaymentService.ts) against the REAL
// HYP-05 database objects, the REAL Production bodies of create_order / create_order_with_parcel (byte-exact) and the
// REAL authoritative order builder. Only two things are substituted: HYP (mock transport) and the PostgREST hop
// (the HypDb calls run the same functions / SELECTs as service_role through psql; argument names are cross-checked
// statically against the migration by scripts/verify-hyp-routes.mjs).
// Disposable Docker container with `--network none`; removed at the end. No env file, no Supabase, no HYP.
//   node scripts/pgtest-hyp07-payment-flow.mjs            (needs Docker; not part of the verify-* suite)

import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import { B1, M1, M2, installFixture } from './hyp05-fixture.mjs'

globalThis.fetch = async () => { throw new Error('LIVE NETWORK CALL ATTEMPTED') }

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const IMAGE = process.env.HYP05_PG_IMAGE || 'public.ecr.aws/supabase/postgres:17.6.1.141'
const NAME = `hyp07-pgtest-${process.pid}`
const SEP = '\x1f'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const cache = new Map()
function load(file) {
  if (cache.has(file)) return cache.get(file).exports
  const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
  const mod = { exports: {} }
  cache.set(file, mod)
  new Function('exports', 'require', 'module', outputText)(mod.exports, p => (p.startsWith('.') ? load(resolve(dirname(file), p) + '.ts') : require(p)), mod)
  return mod.exports
}
const S = load(join(ROOT, 'lib', 'hyp', 'hypPaymentService.ts'))
const RCV = load(join(ROOT, 'lib', 'hyp', 'hypStaffRecovery.ts'))
const RL = load(join(ROOT, 'lib', 'hyp', 'hypRateLimit.ts'))
const DBM = load(join(ROOT, 'lib', 'hyp', 'hypDb.ts'))

const docker = (args, input) => { const r = spawnSync('docker', args, { input, encoding: 'utf8', maxBuffer: 64 << 20 }); return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() } }
function psql(sql, { user = 'postgres', expectError = false } = {}) {
  const r = docker(['exec', '-i', NAME, 'psql', '-X', '-q', '-U', user, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At', '-F', '|'], sql)
  if (expectError) { assert.notEqual(r.code, 0); return r.err }
  assert.equal(r.code, 0, `psql failed: ${r.err}\nSQL: ${sql.slice(0, 300)}`)
  return r.out
}
const val = sql => psql(sql).split('\n').filter(Boolean).pop()
const psqlAsync = sql => new Promise(res => {
  const p = spawn('docker', ['exec', '-i', NAME, 'psql', '-X', '-q', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At', '-F', SEP])
  let out = '', err = ''
  p.stdout.on('data', d => { out += d }); p.stderr.on('data', d => { err += d })
  p.on('close', code => res({ code, out: out.trim(), err: err.trim() }))
  p.stdin.end(`SET ROLE service_role;\n${sql}`)
})
const sleep = ms => new Promise(r => setTimeout(r, ms))
const lit = s => (s === null || s === undefined ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`)
const nul = v => (v === '' || v === undefined ? null : v)
const numOrNull = v => (v === '' || v === undefined ? null : Number(v))

/* ─── HypDb over psql as service_role: the same functions / SELECTs as lib/hyp/hypDb.ts ─── */
const dbFail = { op: null }
async function q(op, sql) {
  if (dbFail.op === op) { dbFail.op = null; throw new DBM.HypDbError(op, '08006') }   // injected connection loss
  const r = await psqlAsync(sql)
  if (r.code !== 0) throw new DBM.HypDbError(op, (r.err.match(/ERROR:\s+(\w+)/) ?? [])[1] ?? 'psql')
  return r.out.split('\n').filter(Boolean).map(l => l.split(SEP))
}
const CAT = 'c0c0c0c0-0000-4000-8000-000000000001'
const CATALOG = {
  items: new Map([[M1, { id: M1, category_id: CAT, is_active: true, has_lettuce: false, has_pita: false, has_egg: false }],
                  [M2, { id: M2, category_id: CAT, is_active: true, has_lettuce: false, has_pita: false, has_egg: false }]]),
  prices: new Map([[M1, { item_id: M1, price: 20, is_available: true }], [M2, { item_id: M2, price: 26, is_available: true }]]),
  toppings: new Map(),
}
const db = {
  async loadCatalog() { return CATALOG },
  async createIntent(a) {
    const [r] = await q('createIntent', `SELECT result, intent_id, public_token, hyp_order_ref, intent_status FROM public.create_payment_intent(${lit(a.checkoutKey)}::uuid, ${lit(a.terminalKind)}, ${lit(a.orderKind ?? 'plain')}, ${lit(JSON.stringify(a.snapshot))}::jsonb, ${a.amountAgorot}, ${a.ttlSeconds});`)
    return { result: r[0], intentId: nul(r[1]), publicToken: nul(r[2]), hypOrderRef: nul(r[3]), status: nul(r[4]) }
  },
  async recordSignResult(id, ok) { const [r] = await q('recordSignResult', `SELECT result, intent_status FROM public.record_hyp_sign_result(${lit(id)}::uuid, ${ok});`); return { result: r[0], status: nul(r[1]) } },
  async recordReturn(raw) {
    const [r] = await q('recordReturn', `SELECT result, return_id, intent_id, public_token, intent_status FROM public.record_hyp_return(${lit(raw)});`)
    return { result: r[0], returnId: nul(r[1]), intentId: nul(r[2]), publicToken: nul(r[3]), status: nul(r[4]) }
  },
  async recordVerification(a) {
    const [r] = await q('recordVerification', `SELECT result, intent_status FROM public.record_hyp_verification(${lit(a.p_return_id)}::uuid, ${lit(a.p_outcome)}, ${lit(a.p_verify_response)});`)
    return { result: r[0], status: nul(r[1]) }
  },
  async finalize(id) {
    const [r] = await q('finalize', `SELECT result, order_id, order_number, daily_number FROM public.finalize_paid_intent(${lit(id)}::uuid, NULL);`)
    return { result: r[0], orderId: nul(r[1]), orderNumber: numOrNull(r[2]), dailyNumber: numOrNull(r[3]) }
  },
  async getIntentForReturn(id) {
    const rows = await q('intent', `SELECT id, status, amount_agorot, hyp_order_ref, terminal_kind, public_token FROM public.payment_intents WHERE id = ${lit(id)}::uuid;`)
    if (!rows.length) return null
    const [r] = rows; return { id: r[0], status: r[1], amountAgorot: Number(r[2]), hypOrderRef: r[3], terminalKind: r[4], publicToken: r[5] }
  },
  async getReturn(id) {
    const rows = await q('return', `SELECT id, intent_id, return_raw, verify_outcome FROM public.payment_returns WHERE id = ${lit(id)}::uuid;`)
    if (!rows.length) return null
    const [r] = rows; return { id: r[0], intentId: r[1], returnRaw: r[2], verifyOutcome: nul(r[3]) }
  },
  async getPublicStatus(token) {
    const rows = await q('status', `SELECT status, order_id FROM public.payment_intents WHERE public_token = ${lit(token)}::uuid;`)
    return rows.length ? { status: rows[0][0], orderId: nul(rows[0][1]) } : null
  },
  async getOrderSummary(id) {
    const rows = await q('order', `SELECT order_number, daily_number, status, type FROM public.orders WHERE id = ${lit(id)}::uuid;`)
    return rows.length ? { orderNumber: numOrNull(rows[0][0]), dailyNumber: numOrNull(rows[0][1]), status: nul(rows[0][2]), type: nul(rows[0][3]) } : null
  },
}

/* ─── mock HYP: SIGN echoes the documented answer; VERIFY follows a per-test plan ─── */
const verifyPlan = []
let lastSignUrl = null
const transport = async (url, init) => {
  if (url.includes('What=SIGN')) {
    lastSignUrl = url
    const qs = url.split('?')[1].split('&').filter(p => !/^(What|KEY|PassP)=/.test(p)).map(p => (p === 'action=APISign' ? 'action=pay' : p))
    return { status: 200, text: async () => `${qs.join('&')}&signature=sig${Date.now()}` }
  }
  const a = verifyPlan.length ? verifyPlan.shift() : { body: 'CCode=0' }
  if (a === 'timeout') return new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))))
  // HYP-20: emulates the HYP-18B observation — VERIFY with the credentials out of the documented order (Masof, KEY,
  // PassP) answers CCode=200 (the live cause is not yet confirmed; this mock pins the documented order).
  const DOC_PREFIX = `https://pay.hyp.co.il/p/?action=APISign&What=VERIFY&Masof=${ENV.HYP_TERMINAL}&KEY=${encodeURIComponent(ENV.HYP_API_KEY)}&PassP=${encodeURIComponent(ENV.HYP_PASSP)}&`
  if (!url.startsWith(DOC_PREFIX)) return { status: 200, text: async () => 'CCode=200' }
  return { status: a.status ?? 200, text: async () => a.body }
}
const ENV = { HYP_PAYMENTS_ENABLED: 'true', HYP_TERMINAL: '0010000001', HYP_API_KEY: 'fakeKEY-7f3a9c11', HYP_PASSP: 'fakePassP-42b8', HYP_TERMINAL_KIND: 'test' }
const logs = []
const big = () => RL.createRateLimiter(10000, 60_000)
const deps = { env: ENV, db, transport, isShopOpen: () => true, limits: { start: big(), startPhone: big(), ret: big(), status: big() }, log: (e, c) => logs.push(`${e} ${c ?? ''}`) }
const ORIGIN = 'https://falafel.test'
let phoneSeq = 0
const nextPhone = () => `050${String(1000000 + ++phoneSeq).slice(-7)}`

// HYP_PILOT_PHONES is mandatory (HYP-12C): each checkout's own phone is the pilot phone unless o.pilot overrides it.
async function start(o = {}) {
  const b = { checkoutKey: o.key ?? randomUUID(), branchId: B1, type: 'pickup', customerName: 'Flow Customer', phone: o.phone ?? nextPhone(), items: o.items ?? [{ itemId: M1, quantity: 2 }] }
  const res = await S.handleHypStart(new Request(`${ORIGIN}/api/payments/hyp/start`, { method: 'POST', body: JSON.stringify(b),
    headers: { origin: ORIGIN, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' } }), { ...deps, env: { ...deps.env, HYP_PILOT_PHONES: 'pilot' in o ? o.pilot : b.phone } })
  return { status: res.status, json: await res.json(), body: b }
}
const refOf = token => val(`SELECT hyp_order_ref FROM public.payment_intents WHERE public_token = '${token}';`)
const intentOf = token => val(`SELECT status || '/' || COALESCE(hold_reason, '-') FROM public.payment_intents WHERE public_token = '${token}';`)
const ordersOf = token => Number(val(`SELECT count(*) FROM public.orders o JOIN public.payment_intents pi ON pi.order_id = o.id WHERE pi.public_token = '${token}';`))
let txSeq = 700000
const rawFor = (ref, o = {}) => `Id=${o.id ?? ++txSeq}&CCode=${o.ccode ?? '0'}&Amount=${o.amount ?? '40.00'}&ACode=${o.acode ?? '0012345'}&Order=${ref}&Fild1=&Sign=${'b2'.repeat(16)}`
async function hypReturn(raw) {
  const res = await S.handleHypReturn(new Request(`${ORIGIN}/api/payments/hyp/return?${raw}`), deps)
  return { status: res.status, location: res.headers.get('location') }
}
async function publicStatus(token) {
  const res = await S.handleIntentStatus(new Request(`${ORIGIN}/x`), token, deps)
  return res.json()
}

const results = []
async function test(id, name, fn) {
  try { await fn(); results.push([id, 'PASS']); console.log(`  PASS ${id} ${name}`) }
  catch (e) { results.push([id, 'FAIL']); console.log(`  FAIL ${id} ${name}\n       ${e.message.split('\n').slice(0, 9).join('\n       ')}`) }
}

try {
  assert.equal(docker(['run', '-d', '--rm', '--name', NAME, '--network', 'none', '-e', 'POSTGRES_PASSWORD=local-only-not-secret', IMAGE]).code, 0)
  assert.equal(docker(['inspect', '-f', '{{.HostConfig.NetworkMode}}', NAME]).out, 'none')
  let ready = false
  for (let i = 0; i < 120 && !ready; i++) {
    await sleep(1000)
    const l = docker(['logs', NAME])
    ready = /init process complete/i.test(l.out + l.err) && docker(['exec', NAME, 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-Atc', "SELECT count(*) FROM pg_roles WHERE rolname IN ('service_role','anon','authenticated')"]).out === '3'
  }
  assert.ok(ready, 'container did not become ready')
  console.log(`Isolated PostgreSQL: ${val('SELECT version();').split(' on ')[0]} (network: none)`)
  installFixture(psql, ROOT)
  psql(readFileSync(join(ROOT, 'db', 'migrations', 'hyp05_payment_intents.sql'), 'utf8'))
  console.log('HYP-05 migration installed (incl. HYP-06A)\n')

  await test('E1', 'confirmed payment end-to-end: real snapshot → intent → SIGN → return → VERIFY → one real online order', async () => {
    const s = await start({ items: [{ itemId: M1, quantity: 2 }, { itemId: M2, quantity: 1 }] })
    assert.equal(s.status, 200, JSON.stringify(s.json)); assert.ok(s.json.redirectUrl.startsWith('https://pay.hyp.co.il/p/?action=pay&'))
    assert.equal(val(`SELECT amount_agorot || '/' || (snapshot #>> '{p_order,payment_method}') || '/' || (snapshot ? 'p_delivery')::text FROM public.payment_intents WHERE public_token = '${s.json.statusToken}';`), '6600/online/false')
    assert.equal(Number(val("SELECT count(*) FROM public.orders WHERE payment_method = 'online';")), 0)   // no order before payment
    assert.deepEqual(await publicStatus(s.json.statusToken), { state: 'awaiting_payment' })
    const r = await hypReturn(rawFor(refOf(s.json.statusToken), { amount: '66.00' }))
    assert.equal(r.status, 303); assert.equal(r.location, `/order/payment/${s.json.statusToken}`)
    assert.equal(intentOf(s.json.statusToken), 'finalized/-'); assert.equal(ordersOf(s.json.statusToken), 1)
    const o = val(`SELECT o.payment_method || '/' || o.total_price || '/' || o.status || '/' || o.type FROM public.orders o JOIN public.payment_intents pi ON pi.order_id = o.id WHERE pi.public_token = '${s.json.statusToken}';`)
    assert.equal(o, 'online/66.00/received/pickup')
    const st = await publicStatus(s.json.statusToken)
    assert.equal(st.state, 'confirmed'); assert.ok(Number.isInteger(st.order.dailyNumber) && Number.isInteger(st.order.orderNumber)); assert.equal(st.order.status, 'received')
    assert.deepEqual(Object.keys(st.order).sort(), ['dailyNumber', 'orderNumber', 'status', 'trackingId'])
  })
  await test('E2', 'duplicate start and duplicate callback: no second payment page, still exactly one order', async () => {
    const key = randomUUID(), phone = nextPhone()
    const a = await start({ key, phone }); const b = await start({ key, phone })
    assert.equal(a.status, 200); assert.equal(b.status, 409); assert.deepEqual(b.json, { error: 'payment_in_progress', statusToken: a.json.statusToken })
    const other = await start({ phone })                                   // a different checkout of the same customer
    assert.equal(other.status, 409); assert.deepEqual(other.json, { error: 'payment_in_progress' })
    const raw = rawFor(refOf(a.json.statusToken))
    await hypReturn(raw); await hypReturn(raw); await hypReturn(raw)
    assert.equal(ordersOf(a.json.statusToken), 1); assert.equal(intentOf(a.json.statusToken), 'finalized/-')
  })
  await test('E3', 'non-capture 600 / 700 / 800 → outcome_unknown, no order, status in_review; a new charge stays blocked', async () => {
    for (const code of ['600', '700', '800']) {
      const phone = nextPhone(); const s = await start({ phone })
      await hypReturn(rawFor(refOf(s.json.statusToken), { ccode: code }))
      assert.equal(intentOf(s.json.statusToken), 'outcome_unknown/-', code); assert.equal(ordersOf(s.json.statusToken), 0)
      assert.deepEqual(await publicStatus(s.json.statusToken), { state: 'in_review' })
      assert.equal((await start({ phone })).status, 409)
    }
  })
  await test('E4', 'declined payment → declined, no order, status failed; the customer may try again', async () => {
    const phone = nextPhone(); const s = await start({ phone })
    await hypReturn(rawFor(refOf(s.json.statusToken), { ccode: '33', acode: '' }))
    assert.equal(intentOf(s.json.statusToken), 'declined/-'); assert.equal(ordersOf(s.json.statusToken), 0)
    assert.deepEqual(await publicStatus(s.json.statusToken), { state: 'failed' })
    assert.equal((await start({ phone })).status, 200)
  })
  await test('E5', 'amount mismatch (HYP charged 39.00 for a 40.00 intent) → paid_amount_mismatch, no order, in_review', async () => {
    const s = await start()
    await hypReturn(rawFor(refOf(s.json.statusToken), { amount: '39.00' }))
    assert.equal(intentOf(s.json.statusToken), 'paid_amount_mismatch/-'); assert.equal(ordersOf(s.json.statusToken), 0)
    assert.deepEqual(await publicStatus(s.json.statusToken), { state: 'in_review' })
  })
  await test('E6', 'VERIFY timeout → returned (processing), no order; the next return of the same parameters recovers → one order', async () => {
    const s = await start(); const raw = rawFor(refOf(s.json.statusToken))
    verifyPlan.push('timeout', 'timeout')
    await hypReturn(raw)
    assert.equal(intentOf(s.json.statusToken), 'returned/-'); assert.equal(ordersOf(s.json.statusToken), 0)
    assert.deepEqual(await publicStatus(s.json.statusToken), { state: 'processing' })
    await hypReturn(raw)
    assert.equal(intentOf(s.json.statusToken), 'finalized/-'); assert.equal(ordersOf(s.json.statusToken), 1)
  })
  await test('E7', 'DB failure after payment (connection lost while recording VERIFY) → nothing lost; a later return finalizes once', async () => {
    const s = await start(); const raw = rawFor(refOf(s.json.statusToken))
    dbFail.op = 'recordVerification'
    const r = await hypReturn(raw)
    assert.equal(r.location, `/order/payment/${s.json.statusToken}`); assert.equal(intentOf(s.json.statusToken), 'returned/-')
    assert.equal(Number(val(`SELECT count(*) FROM public.payment_returns r JOIN public.payment_intents pi ON pi.id = r.intent_id WHERE pi.public_token = '${s.json.statusToken}';`)), 1)
    await hypReturn(raw)
    assert.equal(intentOf(s.json.statusToken), 'finalized/-'); assert.equal(ordersOf(s.json.statusToken), 1)
    dbFail.op = 'finalize'                                                  // and a lost finalize call
    const s2 = await start(); const raw2 = rawFor(refOf(s2.json.statusToken))
    await hypReturn(raw2); assert.equal(intentOf(s2.json.statusToken), 'paid/-'); assert.equal(ordersOf(s2.json.statusToken), 0)
    await hypReturn(raw2); assert.equal(intentOf(s2.json.statusToken), 'finalized/-'); assert.equal(ordersOf(s2.json.statusToken), 1)
  })
  await test('E8', 'late return (after expiry) → paid_hold late_return, never a kitchen order automatically; status in_review', async () => {
    const s = await start()
    psql(`BEGIN; SET LOCAL session_replication_role = replica; UPDATE public.payment_intents SET created_at = now() - interval '3 hours', expires_at = now() - interval '2 hours' WHERE public_token = '${s.json.statusToken}'; COMMIT;`, { user: 'supabase_admin' })
    await hypReturn(rawFor(refOf(s.json.statusToken)))
    assert.equal(intentOf(s.json.statusToken), 'paid_hold/late_return'); assert.equal(ordersOf(s.json.statusToken), 0)
    assert.deepEqual(await publicStatus(s.json.statusToken), { state: 'in_review' })
  })
  await test('E9', 'concurrent finalization: 8 parallel identical returns → exactly one order', async () => {
    const s = await start(); const raw = rawFor(refOf(s.json.statusToken))
    const out = await Promise.all(Array.from({ length: 8 }, () => hypReturn(raw)))
    assert.ok(out.every(r => r.status === 303 && r.location === `/order/payment/${s.json.statusToken}`))
    assert.equal(ordersOf(s.json.statusToken), 1); assert.equal(intentOf(s.json.statusToken), 'finalized/-')
    assert.equal(Number(val(`SELECT count(*) FROM public.payment_transactions t JOIN public.payment_intents pi ON pi.id = t.intent_id WHERE pi.public_token = '${s.json.statusToken}';`)), 1)
  })
  await test('E10', 'unauthenticated (VERIFY 902) and malformed returns never create an order', async () => {
    const s = await start(); verifyPlan.push({ body: 'CCode=902' })
    await hypReturn(rawFor(refOf(s.json.statusToken)))
    assert.equal(intentOf(s.json.statusToken), 'verify_rejected/-'); assert.equal(ordersOf(s.json.statusToken), 0)
    const t = await start()
    await hypReturn(`CCode=0&Amount=40.00&Order=${refOf(t.json.statusToken)}`)   // no Id: never verified
    assert.equal(intentOf(t.json.statusToken), 'returned/-'); assert.equal(ordersOf(t.json.statusToken), 0)
  })
  await test('E11', 'legacy regression: cash / credit / cibus / bit through the unchanged create_order; online orders only via finalize', () => {
    for (const pm of ['cash', 'credit', 'cibus', 'bit']) {
      const out = psql(`SET ROLE service_role; SELECT created_order_id FROM public.create_order('{"branch_id":"${B1}","type":"pickup","phone":"0509999999","customer_name":"Legacy","payment_method":"${pm}","total_price":20}'::jsonb, '[{"item_id":"${M1}","quantity":1,"unit_price":20,"notes":null}]'::jsonb, NULL);`)
      assert.match(out, /^[0-9a-f-]{36}$/, pm)
    }
    assert.equal(val("SELECT count(*) FROM public.orders WHERE payment_method = 'online';"),
                 val("SELECT count(*) FROM public.payment_intents WHERE status = 'finalized';"))
    assert.match(psql(`SET ROLE service_role; SELECT * FROM public.create_order('{"branch_id":"${B1}","type":"pickup","phone":"0509999999","customer_name":"X","payment_method":"online","total_price":20}'::jsonb, '[{"item_id":"${M1}","quantity":1,"unit_price":20,"notes":null}]'::jsonb, NULL);`, { expectError: true }), /orders_online_payment_guard/)
  })
  /* ─── HYP-09 staff recovery through lib/hyp/hypStaffRecovery against the real functions ─── */
  const recoveryDb = {
    async findIntent(ref) {
      const rows = await q('rintent', `SELECT id, branch_id, status, COALESCE(hold_reason, ''), COALESCE(staff_flag, ''), COALESCE(duplicate_charge_at::text, ''), expires_at, COALESCE(paid_source, '') FROM public.payment_intents WHERE hyp_order_ref = ${lit(ref)};`)
      if (!rows.length) return null
      const [r] = rows; return { id: r[0], branchId: r[1], status: r[2], holdReason: nul(r[3]), staffFlag: nul(r[4]), duplicateChargeAt: nul(r[5]), expiresAt: r[6], paidSource: nul(r[7]) }
    },
    async findApprovedTransaction(intentId, hyp) {
      const rows = await q('rtx', `SELECT id FROM public.payment_transactions WHERE intent_id = ${lit(intentId)}::uuid AND hyp_trans_id = ${lit(hyp)} AND outcome = 'approved';`)
      return rows.length ? rows[0][0] : null
    },
    async sweepExpired() { await q('rsweep', 'SELECT * FROM public.sweep_expired_payment_intents(200);') },
    async resolve(a) {
      const [r] = await q('rresolve', `SELECT result, intent_status FROM public.resolve_payment_intent(${lit(a.intentId)}::uuid, ${lit(a.action)}, ${lit(a.staffUser)}, ${lit(a.note)}, ${lit(a.hypTransId)}, ${a.amountAgorot ?? 'NULL'}, ${a.transactionId ? `${lit(a.transactionId)}::uuid` : 'NULL'}, ${lit(a.reference)});`)
      return { result: r[0], status: nul(r[1]) }
    },
    async finalize(id, staff) { const [r] = await q('rfinalize', `SELECT result FROM public.finalize_paid_intent(${lit(id)}::uuid, ${lit(staff)});`); return { result: r[0] } },
  }
  const STAFF_ENV = { HYP_STAFF_RECOVERY_ENABLED: 'true', HYP_STAFF_RECOVERY_USERS: 'owner,adumim' }
  const admin = { ok: true, session: { username: 'owner', role: 'admin', branchId: null, label: 'x', exp: 0, iat: 0 } }
  async function staff(token, body, auth = admin) {
    const res = await RCV.handleStaffRecovery(new Request(`${ORIGIN}/api/kitchen/payments/x`, { method: 'POST', body: JSON.stringify({ confirm: true, ...body }),
      headers: { origin: ORIGIN, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' } }), refOf(token),
      { env: STAFF_ENV, getSession: async () => auth, db: recoveryDb, now: () => new Date(), log: (e, c) => logs.push(`${e} ${c ?? ''}`) })
    const j = await res.json(); return { status: res.status, code: j.result ?? j.error }
  }
  const eventsOf = token => psql(`SELECT string_agg(e.actor || '>' || e.to_status || COALESCE(' [' || e.detail || ']', ''), ' | ' ORDER BY e.occurred_at) FROM public.payment_intent_events e JOIN public.payment_intents pi ON pi.id = e.intent_id WHERE pi.public_token = '${token}';`)
  const expire = token => psql(`BEGIN; SET LOCAL session_replication_role = replica; UPDATE public.payment_intents SET created_at = now() - interval '3 hours', expires_at = now() - interval '2 hours' WHERE public_token = '${token}'; COMMIT;`, { user: 'supabase_admin' })

  await test('F1', 'verified payment while the flag was off → stays paid (no order) → staff finalize → exactly one order, staff in the trail', async () => {
    const s = await start(); deps.env = { ...ENV, HYP_PAYMENTS_ENABLED: 'false' }
    try { await hypReturn(rawFor(refOf(s.json.statusToken))) } finally { deps.env = ENV }
    assert.equal(intentOf(s.json.statusToken), 'paid/-'); assert.equal(ordersOf(s.json.statusToken), 0)
    assert.deepEqual(await staff(s.json.statusToken, { action: 'finalize', note: 'paid during flag-off window' }), { status: 200, code: 'finalized' })
    assert.deepEqual(await staff(s.json.statusToken, { action: 'flag_investigation', note: 'double check' }), { status: 200, code: 'recorded' })
    assert.equal(ordersOf(s.json.statusToken), 1)
    assert.match(eventsOf(s.json.statusToken), /staff:owner>paid \[note: finalize: paid during flag-off window\] \| staff:owner>finalized/)
  })
  await test('F2', 'late return and failed finalize → staff finalize once; a repeated finalize is idempotent', async () => {
    const s = await start(); expire(s.json.statusToken)
    await hypReturn(rawFor(refOf(s.json.statusToken)))
    assert.equal(intentOf(s.json.statusToken), 'paid_hold/late_return')
    assert.equal((await staff(s.json.statusToken, { action: 'finalize', note: 'customer waited at the counter' })).code, 'finalized')
    assert.equal((await staff(s.json.statusToken, { action: 'finalize', note: 'double click' })).code, 'action_not_allowed')   // finalized: no finalize offered
    assert.equal(ordersOf(s.json.statusToken), 1)
  })
  await test('F3', 'unknown outcome (customer never returned) → portal confirmation with HYP evidence → held → staff finalize', async () => {
    const s = await start(); expire(s.json.statusToken)
    const before = Number(val('SELECT count(*) FROM public.orders;'))
    const portal = { action: 'portal_paid', note: 'found charge in HYP portal', hypTransId: 'PT700001', amount: '40.00' }
    assert.deepEqual(await staff(s.json.statusToken, portal), { status: 200, code: 'recorded' })
    assert.deepEqual(await staff(s.json.statusToken, portal), { status: 409, code: 'action_not_allowed' })       // now held: no second confirmation
    assert.equal(intentOf(s.json.statusToken), 'paid_hold/manual_confirmation'); assert.equal(Number(val('SELECT count(*) FROM public.orders;')), before)
    assert.equal((await staff(s.json.statusToken, { action: 'finalize', note: 'portal-confirmed payment' })).code, 'finalized')
    assert.equal(ordersOf(s.json.statusToken), 1)
    assert.equal(val(`SELECT source || '/' || recorded_by FROM public.payment_transactions WHERE hyp_trans_id = 'PT700001';`), 'portal/staff:owner')
  })
  await test('F4', 'J5 / postponed (700 / 800) not captured → staff "no charge found" after portal check → the customer may pay again', async () => {
    for (const code of ['700', '800']) {
      const phone = nextPhone(); const s = await start({ phone })
      await hypReturn(rawFor(refOf(s.json.statusToken), { ccode: code }))
      assert.equal((await start({ phone })).status, 409, `${code}: blocked while unresolved`)
      assert.equal((await staff(s.json.statusToken, { action: 'finalize', note: 'should not be possible' })).code, 'action_not_allowed')
      assert.equal((await staff(s.json.statusToken, { action: 'no_charge_found', note: `HYP portal: ${code} released, nothing captured` })).code, 'recorded')
      assert.equal(intentOf(s.json.statusToken), 'no_charge_found/-'); assert.equal((await start({ phone })).status, 200)
    }
  })
  await test('F5', 'duplicate charge: finalize needs the ack → one order; refund marked required, then the external refund recorded once', async () => {
    // usual path: the first charge is finalized at once; a later second charge only flags the finalized intent
    const u = await start(); await hypReturn(rawFor(refOf(u.json.statusToken), { id: '870001' }))
    await hypReturn(rawFor(refOf(u.json.statusToken), { id: '870002' }))
    assert.equal(intentOf(u.json.statusToken), 'finalized/-'); assert.equal(ordersOf(u.json.statusToken), 1)
    assert.equal(val(`SELECT (duplicate_charge_at IS NOT NULL)::text FROM public.payment_intents WHERE public_token = '${u.json.statusToken}';`), 'true')
    // both charges before any order (first return during the flag-off window): finalize needs the explicit ack
    const s = await start(); deps.env = { ...ENV, HYP_PAYMENTS_ENABLED: 'false' }
    try { await hypReturn(rawFor(refOf(s.json.statusToken), { id: '880001' })) } finally { deps.env = ENV }
    await hypReturn(rawFor(refOf(s.json.statusToken), { id: '880002' }))                                 // second approved charge
    assert.equal(intentOf(s.json.statusToken), 'paid_hold/duplicate_charge')
    assert.equal((await staff(s.json.statusToken, { action: 'finalize', note: 'serve once' })).code, 'duplicate_ack_required')
    assert.equal((await staff(s.json.statusToken, { action: 'finalize', note: 'serve once', ackDuplicate: true })).code, 'finalized')
    assert.equal(ordersOf(s.json.statusToken), 1)
    assert.equal((await staff(s.json.statusToken, { action: 'flag_refund_required', note: 'refund charge 880002' })).code, 'recorded')
    assert.equal(Number(val("SELECT count(*) FROM public.payment_reversals WHERE hyp_reference = 'RF880002';")), 0)   // a marker is not a refund
    const refund = { action: 'record_refund', note: 'refunded 880002 in HYP portal', hypTransId: '880002', amount: '40.00', reference: 'RF880002' }
    assert.equal((await staff(s.json.statusToken, refund)).code, 'reversal_recorded')
    assert.equal((await staff(s.json.statusToken, refund)).code, 'already_recorded')
    assert.equal(Number(val("SELECT count(*) FROM public.payment_reversals WHERE hyp_reference = 'RF880002';")), 1)
    // the served order is untouched; the hold reason stays as history (keeps it listed as a duplicate charge)
    assert.equal(intentOf(s.json.statusToken), 'finalized/duplicate_charge')
    assert.equal((await staff(s.json.statusToken, { action: 'clear_flag', note: 'extra charge refunded' })).code, 'recorded')
  })
  await test('F6', 'external reversal of the paid charge → refunded; evidence kept; never recordable by a branch tablet', async () => {
    const s = await start(); await hypReturn(rawFor(refOf(s.json.statusToken), { id: '990001' }))
    const tablet = { ok: true, session: { username: 'adumim', role: 'branch', branchId: B1, label: 'x', exp: 0, iat: 0 } }
    const unlisted = { ok: true, session: { username: 'tablet2', role: 'branch', branchId: B1, label: 'x', exp: 0, iat: 0 } }
    assert.deepEqual(await staff(s.json.statusToken, { action: 'record_void', note: 'x x x', hypTransId: '990001', amount: '40.00', reference: 'CN990001' }, tablet), { status: 403, code: 'action_not_permitted' })
    assert.equal((await staff(s.json.statusToken, { action: 'record_void', note: 'x x x', hypTransId: '990001', amount: '40.00', reference: 'CN990001' }, unlisted)).status, 404)
    assert.equal(Number(val("SELECT count(*) FROM public.payment_reversals WHERE hyp_reference = 'CN990001';")), 0)
    assert.equal((await staff(s.json.statusToken, { action: 'record_void', note: 'cancelled same day in portal', hypTransId: '990001', amount: '40.00', reference: 'CN990001' })).code, 'reversed')
    assert.equal(val(`SELECT status FROM public.payment_intents WHERE public_token = '${s.json.statusToken}';`), 'voided')
    assert.equal(ordersOf(s.json.statusToken), 1); assert.equal(Number(val("SELECT count(*) FROM public.payment_transactions WHERE hyp_trans_id = '990001';")), 1)
    assert.deepEqual(await publicStatus(s.json.statusToken), { state: 'refunded' })
  })

  await test('F7', 'branch account adumim (HYP-12C): finalizes a VERIFY-confirmed payment; never asserts a portal payment or finalizes one', async () => {
    const adumim = { ok: true, session: { username: 'adumim', role: 'branch', branchId: B1, label: 'x', exp: 0, iat: 0 } }
    const elsewhere = { ok: true, session: { username: 'adumim', role: 'branch', branchId: 'f1e2d3c4-b5a6-4978-8a9b-0c1d2e3f4a5b', label: 'x', exp: 0, iat: 0 } }
    // a. verified while the flag was off → adumim releases it to the kitchen; the trail names adumim
    const v = await start(); deps.env = { ...ENV, HYP_PAYMENTS_ENABLED: 'false' }
    try { await hypReturn(rawFor(refOf(v.json.statusToken))) } finally { deps.env = ENV }
    assert.equal(intentOf(v.json.statusToken), 'paid/-')
    assert.equal((await staff(v.json.statusToken, { action: 'finalize', note: 'customer at the counter' }, elsewhere)).status, 404)
    assert.deepEqual(await staff(v.json.statusToken, { action: 'finalize', note: 'customer at the counter' }, adumim), { status: 200, code: 'finalized' })
    assert.equal(ordersOf(v.json.statusToken), 1)
    assert.match(eventsOf(v.json.statusToken), /staff:adumim>paid \[note: finalize: customer at the counter\] \| staff:adumim>finalized/)
    // b. unknown outcome: adumim cannot assert a portal payment (403, nothing written); admin can; adumim still cannot finalize it
    const u = await start(); expire(u.json.statusToken)
    const portal = { action: 'portal_paid', note: 'found charge in HYP portal', hypTransId: 'PT710001', amount: '40.00' }
    assert.deepEqual(await staff(u.json.statusToken, portal, adumim), { status: 403, code: 'action_not_permitted' })
    assert.equal(Number(val("SELECT count(*) FROM public.payment_transactions WHERE hyp_trans_id = 'PT710001';")), 0)
    assert.deepEqual(await staff(u.json.statusToken, portal), { status: 200, code: 'recorded' })
    assert.equal(intentOf(u.json.statusToken), 'paid_hold/manual_confirmation')
    assert.deepEqual(await staff(u.json.statusToken, { action: 'finalize', note: 'portal-confirmed payment' }, adumim), { status: 409, code: 'action_not_allowed' })
    assert.equal(ordersOf(u.json.statusToken), 0)
    assert.equal((await staff(u.json.statusToken, { action: 'finalize', note: 'portal-confirmed payment' })).code, 'finalized')
    // c. not captured (700) → adumim closes it as no charge; the customer may pay again
    const phone = nextPhone(); const n = await start({ phone })
    await hypReturn(rawFor(refOf(n.json.statusToken), { ccode: '700' }))
    assert.deepEqual(await staff(n.json.statusToken, { action: 'no_charge_found', note: 'HYP portal: J5 released' }, adumim), { status: 200, code: 'recorded' })
    assert.equal(intentOf(n.json.statusToken), 'no_charge_found/-'); assert.equal((await start({ phone })).status, 200)
    assert.deepEqual(await staff(n.json.statusToken, { action: 'clear_flag', note: 'x x x' }, adumim), { status: 403, code: 'action_not_permitted' })
  })
  await test('E13', 'pilot allowlist is mandatory: missing / empty / malformed / other phone → 404 and no intent row', async () => {
    const before = Number(val('SELECT count(*) FROM public.payment_intents;'))
    for (const pilot of [undefined, '', '   ', '050-1234567', '0509999999', '0509999999,']) {
      const r = await start({ pilot }); assert.equal(r.status, 404, String(pilot)); assert.equal(r.json.error, 'payments_disabled')
    }
    assert.equal(Number(val('SELECT count(*) FROM public.payment_intents;')), before)
  })
  await test('E12', 'no credentials or customer data in logs; HYP received the server amount and our Order only', () => {
    const blob = logs.join('\n')
    for (const s of [ENV.HYP_API_KEY, ENV.HYP_PASSP, 'Flow Customer', '050']) assert.ok(!blob.includes(s), s)
    const u = new URL(lastSignUrl); assert.equal(u.origin, 'https://pay.hyp.co.il'); assert.match(u.searchParams.get('Order'), /^[A-Z0-9]{32}$/)
  })

  /* ─── HYP-DELIVERY-02: delivery / food + parcel through the real HYP-05 ledger and the real create_order bodies ─── */
  const OGEO = load(join(ROOT, 'lib', 'orderGeo.ts')), OC = load(join(ROOT, 'lib', 'orderConfig.ts'))
  const RF = load(join(ROOT, 'lib', 'hyp', 'hypRefundFlag.ts'))
  const CITY = OC.ACTIVE_DELIVERY_AREAS[0], FEE = OC.DELIVERY_FEES_BY_AREA[CITY], GOOGLE = { lat: 31.7711, lng: 35.2981 }
  const DENV = { ...ENV, HYP_DELIVERY_ENABLED: 'true', PARCEL_CHECKOUT_ENABLED: 'true' }
  // Google verification is faked (no network); the REAL server geocode step (lib/orderGeo) applies the verified point
  const ddeps = { ...deps, resolveAddress: async order => ({ ok: true, order: { ...order, googleAddress: { status: 'verified', ...GOOGLE } } }),
                  attachGeo: (order, built) => OGEO.attachDeliveryGeo(order, built) }
  async function startDelivery(o = {}) {
    const b = { checkoutKey: o.key ?? randomUUID(), branchId: B1, type: 'delivery', customerName: 'Flow Customer', phone: o.phone ?? nextPhone(),
                items: o.items ?? [{ itemId: M1, quantity: 2 }], delivery: { city: CITY, street: 'הרצל', houseNumber: '1', apartment: '3' }, ...(o.parcel ? { parcel: o.parcel } : {}) }
    const res = await S.handleHypStart(new Request(`${ORIGIN}/api/payments/hyp/start`, { method: 'POST', body: JSON.stringify(b),
      headers: { origin: ORIGIN, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' } }), { ...ddeps, env: { ...DENV, HYP_PILOT_PHONES: b.phone, ...(o.env ?? {}) } })
    return { status: res.status, json: await res.json(), body: b }
  }
  const amountOf = token => Number(val(`SELECT amount_agorot FROM public.payment_intents WHERE public_token = '${token}';`))
  const orderRow = token => val(`SELECT o.type || '/' || o.payment_method || '/' || o.total_price || '/' || d.delivery_fee || '/' || d.geo_source FROM public.orders o JOIN public.payment_intents pi ON pi.order_id = o.id JOIN public.deliveries d ON d.order_id = o.id WHERE pi.public_token = '${token}';`)
  // the same SELECT lib/maaleDispatch isHypPaymentVerified runs (service_role)
  const verifiedRows = token => Number(val(`SET ROLE service_role; SELECT count(*) FROM public.payment_intents WHERE order_id = (SELECT order_id FROM public.payment_intents WHERE public_token = '${token}') AND status = 'finalized' AND paid_source = 'verify' AND staff_flag IS NULL;`))

  await test('D1', 'delivery food only: server-priced intent (food + fee + surcharge) → VERIFY CCode 0 → ONE real delivery order, online, verified for dispatch', async () => {
    const s = await startDelivery({ items: [{ itemId: M1, quantity: 2 }, { itemId: M2, quantity: 1 }] })
    assert.equal(s.status, 200, JSON.stringify(s.json))
    const snap = JSON.parse(val(`SELECT snapshot::text FROM public.payment_intents WHERE public_token = '${s.json.statusToken}';`))
    assert.equal(val(`SELECT order_kind FROM public.payment_intents WHERE public_token = '${s.json.statusToken}';`), 'plain')
    const total = 2 * 20 + 26 + FEE + Number(snap.p_delivery.meal_surcharge)
    assert.equal(snap.p_order.total_price, total); assert.equal(amountOf(s.json.statusToken), Math.round(total * 100))
    assert.deepEqual([snap.p_delivery.delivery_lat, snap.p_delivery.delivery_lng, snap.p_delivery.geo_source], [GOOGLE.lat, GOOGLE.lng, 'geocoder'])
    assert.equal(Number(val("SELECT count(*) FROM public.orders WHERE payment_method = 'online' AND type = 'delivery';")), 0, 'no kitchen order before VERIFY')
    await hypReturn(rawFor(refOf(s.json.statusToken), { amount: total.toFixed(2) }))
    assert.equal(intentOf(s.json.statusToken), 'finalized/-'); assert.equal(ordersOf(s.json.statusToken), 1)
    assert.equal(orderRow(s.json.statusToken), `delivery/online/${total.toFixed(2)}/${FEE.toFixed(2)}/geocoder`)
    assert.equal(verifiedRows(s.json.statusToken), 1)
  })
  await test('D2', 'delivery: VERIFY rejected (902) / wrong amount → no order, not verified; 8 parallel duplicate callbacks → exactly one order', async () => {
    const a = await startDelivery(); const ta = a.json.statusToken
    verifyPlan.push({ body: 'CCode=902' }); await hypReturn(rawFor(refOf(ta), { amount: (amountOf(ta) / 100).toFixed(2) }))
    assert.equal(ordersOf(ta), 0)
    const b = await startDelivery(); const tb = b.json.statusToken
    await hypReturn(rawFor(refOf(tb), { amount: ((amountOf(tb) - 100) / 100).toFixed(2) }))
    assert.equal(intentOf(tb), 'paid_amount_mismatch/-'); assert.equal(ordersOf(tb), 0)
    const c = await startDelivery(); const tc = c.json.statusToken; const raw = rawFor(refOf(tc), { amount: (amountOf(tc) / 100).toFixed(2) })
    await Promise.all(Array.from({ length: 8 }, () => hypReturn(raw)))
    assert.equal(ordersOf(tc), 1); assert.equal(intentOf(tc), 'finalized/-')
  })
  await test('D3', 'food + parcel: order_kind parcel → ONE order + ONE parcel request (real create_order_with_parcel); same tracking blocked while open and after', async () => {
    const tracking = 'RR' + String(Date.now()).slice(-9) + 'IL'
    const s = await startDelivery({ parcel: { trackingRef: tracking, carrier: 'דואר ישראל' } }); const t = s.json.statusToken
    assert.equal(s.status, 200, JSON.stringify(s.json)); assert.equal(val(`SELECT order_kind FROM public.payment_intents WHERE public_token = '${t}';`), 'parcel')
    const food = await startDelivery()
    assert.equal(amountOf(t), amountOf(food.json.statusToken), 'a parcel adds no charge')
    const dupOpen = await startDelivery({ parcel: { trackingRef: tracking } }); assert.deepEqual([dupOpen.status, dupOpen.json.error], [409, 'parcel_duplicate'])
    await hypReturn(rawFor(refOf(t), { amount: (amountOf(t) / 100).toFixed(2) }))
    assert.equal(intentOf(t), 'finalized/-'); assert.equal(ordersOf(t), 1)
    assert.equal(val(`SELECT count(*) || '/' || min(pr.status) FROM public.parcel_requests pr JOIN public.payment_intents pi ON pi.order_id = pr.order_id WHERE pi.public_token = '${t}';`), '1/awaiting_search')
    const dupAfter = await startDelivery({ parcel: { trackingRef: tracking } }); assert.deepEqual([dupAfter.status, dupAfter.json.error], [409, 'parcel_duplicate'])
    const noFlag = await startDelivery({ parcel: { trackingRef: 'LP99887766' }, env: { PARCEL_CHECKOUT_ENABLED: 'false' } }); assert.deepEqual([noFlag.status, noFlag.json.error], [400, 'parcel_checkout_disabled'])
  })
  await test('D4', 'cancelled prepaid delivery → refund_required flag (real resolve_payment_intent): NO refund / reversal recorded; no longer dispatchable', async () => {
    const s = await startDelivery(); const t = s.json.statusToken
    await hypReturn(rawFor(refOf(t), { amount: (amountOf(t) / 100).toFixed(2) })); assert.equal(ordersOf(t), 1)
    const orderId = val(`SELECT order_id FROM public.payment_intents WHERE public_token = '${t}';`)
    psql(`SET ROLE service_role; UPDATE public.orders SET status = 'cancelled' WHERE id = '${orderId}';`)
    const fdeps = {
      async findFinalizedIntent(oid) { return nul(val(`SET ROLE service_role; SELECT COALESCE((SELECT id::text FROM public.payment_intents WHERE order_id = '${oid}' AND status = 'finalized' LIMIT 1), '');`)) },
      async flagRefundRequired(id, staff, note) { return val(`SET ROLE service_role; SELECT result FROM public.resolve_payment_intent('${id}'::uuid, 'flag_refund_required', ${lit(staff)}, ${lit(note)});`) },
      log: () => {} }
    const reversalsBefore = Number(val('SELECT count(*) FROM public.payment_reversals;'))
    assert.equal(await RF.flagRefundForCancelledOrder(fdeps, orderId, 'adumim'), 'recorded')
    assert.equal(await RF.flagRefundForCancelledOrder(fdeps, orderId, 'adumim'), 'already_flagged')
    assert.equal(val(`SELECT status || '/' || staff_flag || '/' || staff_flag_by FROM public.payment_intents WHERE public_token = '${t}';`), 'finalized/refund_required/adumim')
    assert.equal(Number(val('SELECT count(*) FROM public.payment_reversals;')), reversalsBefore, 'no refund recorded')
    assert.equal(verifiedRows(t), 0, 'a refund-flagged payment is never dispatched')
    const cash = val("SELECT id FROM public.orders WHERE payment_method <> 'online' LIMIT 1;")
    assert.equal(await RF.flagRefundForCancelledOrder(fdeps, cash, 'adumim'), 'not_prepaid')
  })
  await test('D5', 'feature OFF: delivery start refused before any row; pickup flow with the flag ON writes the same intent as before', async () => {
    const before = Number(val('SELECT count(*) FROM public.payment_intents;'))
    const off = await startDelivery({ env: { HYP_DELIVERY_ENABLED: 'false' } }); assert.deepEqual([off.status, off.json.error], [400, 'online_payment_type_not_allowed'])
    assert.equal(Number(val('SELECT count(*) FROM public.payment_intents;')), before)
    const phone = nextPhone()
    const p = await S.handleHypStart(new Request(`${ORIGIN}/api/payments/hyp/start`, { method: 'POST', body: JSON.stringify({ checkoutKey: randomUUID(), branchId: B1, type: 'pickup', customerName: 'Flow Customer', phone, items: [{ itemId: M1, quantity: 2 }] }),
      headers: { origin: ORIGIN, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' } }), { ...ddeps, env: { ...DENV, HYP_PILOT_PHONES: phone } })
    const pj = await p.json(); assert.equal(p.status, 200)
    assert.equal(val(`SELECT order_kind || '/' || amount_agorot || '/' || (snapshot ? 'p_delivery')::text || '/' || (snapshot ? 'p_parcel')::text FROM public.payment_intents WHERE public_token = '${pj.statusToken}';`), 'plain/4000/false/false')
  })
} finally {
  docker(['rm', '-f', NAME])
}
const failedIds = results.filter(r => r[1] === 'FAIL').map(r => r[0])
console.log(`\n${results.length - failedIds.length}/${results.length} PASS${failedIds.length ? ` — FAILED: ${failedIds.join(', ')}` : ''}`)
process.exit(failedIds.length ? 1 : 0)
