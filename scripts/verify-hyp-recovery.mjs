// Offline checks for staff payment recovery (HYP-09): lib/hyp/hypStaffRecovery.ts (POST /api/kitchen/payments/[ref])
// and the recovery fields of lib/hyp/hypReconciliation.ts. Fake session + fake database recording every call; the
// real global fetch is a throwing stub. The real SQL path is exercised by scripts/pgtest-hyp07-payment-flow.mjs.
// Run: node scripts/verify-hyp-recovery.mjs

import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import assert from 'node:assert/strict'

const fetchCalls = []
globalThis.fetch = async url => { fetchCalls.push(String(url)); throw new Error('LIVE NETWORK CALL ATTEMPTED') }

const require = createRequire(import.meta.url)
const ts = require('typescript')
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cache = new Map()
const resolveTs = base => [base + '.ts', base + '.tsx'].find(p => existsSync(p)) ?? base + '.ts'
function load(file) {
  if (cache.has(file)) return cache.get(file).exports
  const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  })
  const mod = { exports: {} }
  cache.set(file, mod)
  const req = p => p.startsWith('@/') ? load(resolveTs(join(ROOT, p.slice(2)))) : p.startsWith('.') ? load(resolveTs(resolve(dirname(file), p))) : require(p)
  new Function('exports', 'require', 'module', outputText)(mod.exports, req, mod)
  return mod.exports
}
const R = load(join(ROOT, 'lib', 'hyp', 'hypStaffRecovery.ts'))
const REC = load(join(ROOT, 'lib', 'hyp', 'hypReconciliation.ts'))
const TAB = load(join(ROOT, 'app', 'dashboard', 'orders', 'PaymentsTab.tsx'))
const src = f => readFileSync(join(ROOT, f), 'utf8').replace(/\r\n/g, '\n')

let passed = 0, failed = 0
const test = async (name, fn) => {
  try { await fn(); passed++; console.log('  ✓', name) }
  catch (e) { failed++; console.log('  ✗', name, '\n     ', e.message.split('\n')[0]) }
}

const B1 = '8fed141d-0e7c-46c1-803b-88d3d811c1f8'
const OTHER = 'f1e2d3c4-b5a6-4978-8a9b-0c1d2e3f4a5b'
const REF = 'A1B2C3D4E5F60718293A4B5C6D7E8F90'
const ORIGIN = 'https://falafel.test'
const ENV = { HYP_STAFF_RECOVERY_ENABLED: 'true', HYP_STAFF_RECOVERY_USERS: 'owner,manager2' }
const NOW = new Date('2026-10-24T12:00:00Z')
const session = (role = 'admin', username = 'owner', branchId = null) => ({ ok: true, session: { username, role, branchId, label: 'x', exp: 0, iat: 0 } })

class FakeDb {
  constructor(intent = {}, o = {}) {
    this.calls = []; this.o = o
    this.intent = { id: 'int-1', branchId: B1, status: 'paid', holdReason: null, staffFlag: null, duplicateChargeAt: null, expiresAt: '2026-10-24T11:15:00Z', ...intent }
  }
  async findIntent(ref) { this.calls.push(['findIntent', ref]); if (this.o.fail === 'findIntent') throw new R.RecoveryDbError('57P01'); return ref === REF ? { ...this.intent } : null }
  async findApprovedTransaction(id, hyp) { this.calls.push(['findApprovedTransaction', id, hyp]); return hyp === '5001' ? 'tx-uuid-1' : null }
  async sweepExpired() { this.calls.push(['sweepExpired']) }
  async resolve(a) { this.calls.push(['resolve', a]); return this.o.resolveResult ?? { result: 'recorded', status: this.intent.status } }
  async finalize(id, staff) { this.calls.push(['finalize', id, staff]); return this.o.finalizeResult ?? { result: 'finalized' } }
}
const logs = []
const deps = (db, o = {}) => ({ env: o.env ?? ENV, getSession: async () => o.auth ?? session(), db, now: () => NOW, log: (e, c) => logs.push(`${e} ${c ?? ''}`) })
const post = (body, h = {}) => new Request(`${ORIGIN}/api/kitchen/payments/${REF}`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
  headers: { origin: ORIGIN, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...h } })
async function call(body, db = new FakeDb(), o = {}) {
  const res = await R.handleStaffRecovery(post(body, o.headers), o.ref ?? REF, deps(db, o))
  return { status: res.status, json: await res.json(), db, cc: res.headers.get('cache-control') }
}
const FIN = { action: 'finalize', note: 'customer confirmed by phone', confirm: true }

console.log('Authorization')
await test('feature flag off / not exactly true → 404 before session, body or database', async () => {
  for (const v of [undefined, 'false', 'TRUE', '1']) {
    let sessionRead = false; const db = new FakeDb()
    const res = await R.handleStaffRecovery(post(FIN), REF, { ...deps(db, { env: { ...ENV, HYP_STAFF_RECOVERY_ENABLED: v } }), getSession: async () => { sessionRead = true; return session() } })
    assert.equal(res.status, 404, String(v)); assert.equal(sessionRead, false); assert.equal(db.calls.length, 0)
  }
})
await test('cross-origin / non-JSON → 400; no session → 401; nothing read', async () => {
  for (const h of [{ origin: 'https://evil.test' }, { origin: '' }, { 'sec-fetch-site': 'cross-site' }, { 'content-type': 'text/plain' }]) {
    const r = await call(FIN, new FakeDb(), { headers: h }); assert.equal(r.status, 400, JSON.stringify(h)); assert.equal(r.db.calls.length, 0)
  }
  const r = await call(FIN, new FakeDb(), { auth: { ok: false, status: 401, error: 'unauthorized' } }); assert.equal(r.status, 401); assert.equal(r.db.calls.length, 0)
})
await test('role matrix: branch tablet, unlisted admin, malformed allowlist → 404 (same as off); listed admin only', async () => {
  for (const [auth, env] of [[session('branch', 'owner', B1), ENV], [session('admin', 'boss'), ENV], [session('admin', 'owner'), { ...ENV, HYP_STAFF_RECOVERY_USERS: 'owner,BAD NAME' }],
                             [session('admin', 'owner'), { ...ENV, HYP_STAFF_RECOVERY_USERS: '' }], [session('admin', 'Owner'), ENV]]) {
    const r = await call(FIN, new FakeDb(), { auth, env }); assert.equal(r.status, 404); assert.equal(r.db.calls.length, 0)
  }
  assert.equal((await call(FIN)).status, 200)
  assert.equal(R.isStaffRecoveryAllowedFor(ENV, { role: 'admin', username: 'manager2' }), true)
  assert.equal(R.isStaffRecoveryAllowedFor(ENV, { role: 'branch', username: 'manager2' }), false)
})
await test('branch isolation: an intent outside the session scope is indistinguishable from a missing one (404)', async () => {
  const r = await call(FIN, new FakeDb({ branchId: OTHER })); assert.equal(r.status, 404); assert.ok(!r.db.calls.some(c => c[0] === 'finalize'))
  assert.equal((await call(FIN, new FakeDb(), { ref: 'ZZZZZZZZZZZZZZZZ' })).status, 404)
  assert.equal((await call(FIN, new FakeDb(), { ref: 'not-a-ref' })).status, 400)
})

console.log('Validation and evidence')
await test('confirm must be literally true; unknown keys (e.g. a browser staffUser / status) are refused', async () => {
  for (const b of [{ ...FIN, confirm: 'true' }, { ...FIN, confirm: undefined }, { ...FIN, staffUser: 'owner' }, { ...FIN, status: 'paid' }, { ...FIN, action: 'void' }, [FIN], 'nope']) {
    const r = await call(b); assert.equal(r.status, 400, JSON.stringify(b)); assert.ok(!r.db.calls.length, 'no DB access for a bad body')
  }
})
await test('evidence formats: note 3–500, HYP Id, exact ₪ amount (no float), portal reference', async () => {
  const P = (o) => R.parseRecoveryBody({ action: 'portal_paid', note: 'found in portal', confirm: true, hypTransId: '5001', amount: '40.00', ...o })
  assert.deepEqual(P({}).value, { action: 'portal_paid', note: 'found in portal', hypTransId: '5001', amountAgorot: 4000 })
  assert.equal(P({ amount: '19.99' }).value.amountAgorot, 1999)
  for (const [o, e] of [[{ amount: '40.001' }, 'invalid_amount'], [{ amount: '-1' }, 'invalid_amount'], [{ amount: 40 }, 'invalid_amount'], [{ amount: '0' }, 'invalid_amount'],
                        [{ hypTransId: '50-01' }, 'invalid_hyp_trans_id'], [{ note: 'ab' }, 'invalid_note'], [{ note: 'x'.repeat(501) }, 'invalid_note']])
    assert.equal(P(o).error, e, JSON.stringify(o))
  const V = o => R.parseRecoveryBody({ action: 'record_refund', note: 'refunded in portal', confirm: true, hypTransId: '5001', amount: '40.00', ...o })
  assert.equal(V({ reference: 'RF1' }).value.reference, 'RF1')
  assert.equal(V({}).error, 'invalid_reference'); assert.equal(V({ reference: 'RF 1' }).error, 'invalid_reference')
})
await test('allowed actions follow the HYP-05 state machine (refunds only recorded, never on unknown money)', () => {
  const A = (status, o = {}) => R.allowedRecoveryActions({ status, holdReason: null, staffFlag: null, duplicateChargeAt: null, expiresAt: '2026-10-24T11:15:00Z', ...o }, NOW).join(',')
  assert.equal(A('paid'), 'finalize,flag_refund_required,flag_investigation')
  assert.equal(A('paid_hold'), 'finalize,flag_refund_required,flag_investigation,record_void,record_refund')
  assert.equal(A('paid_amount_mismatch'), 'flag_refund_required,flag_investigation,record_void,record_refund')
  assert.equal(A('finalized'), 'flag_refund_required,flag_investigation,record_void,record_refund')
  assert.equal(A('outcome_unknown'), 'portal_paid,no_charge_found,flag_investigation')
  assert.equal(A('returned'), 'portal_paid,no_charge_found,flag_investigation')
  assert.equal(A('redirected'), 'portal_paid,no_charge_found,flag_investigation')                                   // expired
  assert.equal(A('redirected', { expiresAt: '2026-10-24T12:10:00Z' }), 'flag_investigation')                       // customer still paying
  assert.equal(A('declined'), 'portal_paid,flag_investigation'); assert.equal(A('created'), ''); assert.equal(A('not_sent'), '')
  assert.equal(A('finalized', { staffFlag: 'refund_required' }), 'flag_investigation,clear_flag,record_void,record_refund')
  for (const s of ['outcome_unknown', 'returned', 'verify_rejected', 'redirected', 'declined', 'no_charge_found'])
    assert.ok(!A(s).includes('record_') && !A(s).includes('flag_refund_required') && !A(s).includes('finalize'), s)
  assert.equal(A('voided'), 'flag_investigation')
})
await test('an action the state does not allow → 409 without any write', async () => {
  const r = await call({ action: 'no_charge_found', note: 'nothing in portal', confirm: true }, new FakeDb({ status: 'paid' }))
  assert.equal(r.status, 409); assert.equal(r.json.error, 'action_not_allowed'); assert.ok(!r.db.calls.some(c => c[0] === 'resolve' || c[0] === 'finalize'))
})

console.log('Writes')
await test('finalize: the reason is written to the audit trail first, then finalize with the SESSION username', async () => {
  const r = await call(FIN, new FakeDb({ status: 'paid_hold', holdReason: 'late_return' }))
  assert.equal(r.status, 200); assert.deepEqual(r.json, { result: 'finalized' }); assert.equal(r.cc, 'no-store, max-age=0')
  const ops = r.db.calls.filter(c => c[0] !== 'findIntent')
  assert.equal(ops[0][0], 'resolve'); assert.equal(ops[0][1].action, 'note'); assert.equal(ops[0][1].note, 'finalize: customer confirmed by phone'); assert.equal(ops[0][1].staffUser, 'owner')
  assert.deepEqual(ops[1], ['finalize', 'int-1', 'owner'])
})
await test('duplicate charge: finalize needs the explicit duplicate acknowledgement', async () => {
  const dup = { status: 'paid_hold', holdReason: 'duplicate_charge' }
  let r = await call(FIN, new FakeDb(dup)); assert.equal(r.status, 400); assert.equal(r.json.error, 'duplicate_ack_required'); assert.ok(!r.db.calls.some(c => c[0] === 'finalize'))
  r = await call({ ...FIN, ackDuplicate: true }, new FakeDb(dup)); assert.equal(r.status, 200)
})
await test('portal confirmation: HYP Id + exact agorot + note go to resolve(portal_paid); repeat answers stay 200', async () => {
  const body = { action: 'portal_paid', note: 'found in HYP portal', confirm: true, hypTransId: '700123', amount: '40.00' }
  let r = await call(body, new FakeDb({ status: 'outcome_unknown' }))
  const a = r.db.calls.find(c => c[0] === 'resolve')[1]
  assert.deepEqual({ ...a, intentId: undefined }, { intentId: undefined, action: 'portal_paid', staffUser: 'owner', note: 'found in HYP portal', hypTransId: '700123', amountAgorot: 4000, transactionId: null, reference: null })
  r = await call(body, new FakeDb({ status: 'outcome_unknown' }, { resolveResult: { result: 'already_recorded', status: 'paid_hold' } })); assert.equal(r.status, 200)
  r = await call(body, new FakeDb({ status: 'outcome_unknown' }, { resolveResult: { result: 'trans_id_conflict', status: 'outcome_unknown' } })); assert.equal(r.status, 409); assert.equal(r.json.error, 'trans_id_conflict')
})
await test('recorded void / refund: resolves the approved charge first; unknown charge → 409; reference + amount forwarded', async () => {
  const body = { action: 'record_refund', note: 'refunded in portal', confirm: true, hypTransId: '5001', amount: '40.00', reference: 'RF900001' }
  let r = await call(body, new FakeDb({ status: 'finalized' }))
  const a = r.db.calls.find(c => c[0] === 'resolve')[1]
  assert.equal(a.action, 'refund'); assert.equal(a.transactionId, 'tx-uuid-1'); assert.equal(a.reference, 'RF900001'); assert.equal(a.amountAgorot, 4000)
  r = await call({ ...body, hypTransId: '9999' }, new FakeDb({ status: 'finalized' })); assert.equal(r.status, 409); assert.equal(r.json.error, 'transaction_not_found')
  r = await call({ ...body, action: 'record_void' }, new FakeDb({ status: 'paid_hold' })); assert.equal(r.db.calls.find(c => c[0] === 'resolve')[1].action, 'void')
})
await test('no_charge_found on an expired redirect sweeps first (redirected → outcome_unknown), never otherwise', async () => {
  let r = await call({ action: 'no_charge_found', note: 'nothing in portal', confirm: true }, new FakeDb({ status: 'redirected' }))
  assert.deepEqual(r.db.calls.map(c => c[0]), ['findIntent', 'sweepExpired', 'resolve'])
  r = await call({ action: 'no_charge_found', note: 'nothing in portal', confirm: true }, new FakeDb({ status: 'outcome_unknown' }))
  assert.ok(!r.db.calls.some(c => c[0] === 'sweepExpired'))
})
await test('database failure → 503 with a code-only log; nothing claims success', async () => {
  logs.length = 0
  const r = await call(FIN, new FakeDb({}, { fail: 'findIntent' })); assert.equal(r.status, 503); assert.deepEqual(logs, ['staff_recovery_db 57P01'])
})

console.log('Staff list (GET /api/kitchen/payments) and tab')
const row = o => ({ hyp_order_ref: o.ref, status: o.status, hold_reason: o.hold ?? null, amount_agorot: 4000, branch_id: B1, created_at: '2026-10-24T11:00:00Z',
  expires_at: '2026-10-24T11:15:00Z', updated_at: '2026-10-24T11:20:00Z', last_error: o.err ?? null, duplicate_charge_at: o.dup ?? null, finalize_attempts: 0,
  staff_flag: o.flag ?? null, staff_flag_note: o.flag ? 'customer cancelled' : null, staff_flag_by: o.flag ? 'owner' : null, staff_flag_at: o.flag ? '2026-10-24T11:40:00Z' : null,
  customer_name: 'Dana', phone: '0501234567', orders: null,
  payment_transactions: [{ hyp_trans_id: '5001', source: 'verify', ccode: '0', outcome: 'approved', amount_agorot: 4000, recorded_at: 'x' }],
  payment_returns: [], payment_reversals: o.revs ?? [] })
const ROWS = [row({ ref: 'R1', status: 'paid' }), row({ ref: 'R2', status: 'outcome_unknown' }), row({ ref: 'R3', status: 'outcome_unknown', err: 'non_capture_ccode_700' }),
  row({ ref: 'R4', status: 'finalized', flag: 'refund_required' }), row({ ref: 'R5', status: 'refunded', flag: 'investigation', revs: [{ kind: 'refund', amount_agorot: 4000, hyp_reference: 'RF1', staff_user: 'owner', created_at: 'x' }] })]
async function list(canRecover, auth = session()) {
  const res = await REC.handleKitchenPayments(new Request(`${ORIGIN}/api/kitchen/payments`), { getSession: async () => auth, fetchIntents: async () => ({ data: ROWS, error: null }),
    canRecover: () => canRecover, now: () => NOW, log: () => {} })
  return res.json()
}
await test('money states are kept apart: confirmed / unknown / not captured / refund required / refunded externally', async () => {
  const b = await list(false)
  assert.deepEqual(Object.fromEntries(b.items.map(i => [i.ref, i.moneyState])),
    { R1: 'confirmed', R2: 'unknown', R3: 'not_captured', R4: 'refund_required', R5: 'refunded_externally' })
  assert.equal(b.items.find(i => i.ref === 'R4').category, 'flagged')
})
await test('actions are listed only for an authorized account; read-only accounts get none and see no controls', async () => {
  const ro = await list(false); assert.equal(ro.canRecover, false); assert.ok(ro.items.every(i => i.actions.length === 0))
  const m = renderToStaticMarkup(React.createElement(TAB.PaymentsReconciliationList, { items: ro.items, available: true, error: '', canRecover: false }))
  assert.ok(!/<button|<select|<form|<details/i.test(m)); assert.match(m, /לקריאה בלבד/)
  const rw = await list(true); assert.equal(rw.canRecover, true)
  assert.deepEqual(rw.items.find(i => i.ref === 'R1').actions, ['finalize', 'flag_refund_required', 'flag_investigation'])
  const m2 = renderToStaticMarkup(React.createElement(TAB.PaymentsReconciliationList, { items: rw.items, available: true, error: '', canRecover: true, onAction: async () => ({ ok: true, message: '' }) }))
  assert.match(m2, /<details/); assert.match(m2, /פעולות צוות/); assert.match(m2, /dir="rtl"/)
  assert.match(m2, /נדרש זיכוי — טרם בוצע/); assert.match(m2, /זיכוי \/ ביטול בוצע בפורטל/); assert.match(m2, /אסמכתא <span[^>]*>RF1<\/span>/)
})
await test('every action has an explicit confirmation text; refunds are only ever "already performed in the portal"', () => {
  for (const a of R.RECOVERY_ACTIONS) assert.ok(TAB.ACTION_UI[a]?.confirm.length > 10, a)
  assert.match(TAB.ACTION_UI.record_refund.confirm, /כבר בוצע בפורטל HYP/); assert.match(TAB.ACTION_UI.flag_refund_required.confirm, /סימון בלבד/)
})

console.log('Static guarantees')
await test('writes only through the two HYP-05 functions (+ sweep); no direct table writes, no HYP call, no flag coupling', () => {
  const code = src('lib/hyp/hypStaffRecovery.ts') + src('app/api/kitchen/payments/[ref]/route.ts')
  assert.deepEqual([...new Set([...code.matchAll(/\.rpc\('([a-z_]+)'/g)].map(m => m[1]))].sort(), ['finalize_paid_intent', 'resolve_payment_intent', 'sweep_expired_payment_intents'])
  assert.ok(!/\.(insert|update|upsert|delete)\(/.test(code)); assert.ok(!/pay\.hyp\.co\.il|hypClient|signPayment|verifyHypReturn/.test(code))
  assert.ok(!/HYP_PAYMENTS_ENABLED|isHypPaymentsEnabled/.test(code.replace(/^\s*\/\/.*$/gm, '')))
  assert.match(src('app/api/kitchen/payments/[ref]/route.ts'), /getSession: async r => await getKitchenSession\(r\)/)
  assert.match(src('lib/hyp/hypStaffRecovery.ts'), /const staffUser = auth\.session\.username/)
})
await test('no live request: the global fetch was never called', () => assert.equal(fetchCalls.length, 0))

console.log(`\n${passed}/${passed + failed} PASS${failed ? ` — ${failed} FAILED` : ''}`)
process.exit(failed ? 1 : 0)
