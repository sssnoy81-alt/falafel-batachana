// Local checks for kitchen mutations + ready push (FALAFEL-SN-06D).
// Uses in-memory fakes for the DB and the push service — no DB, no network, no real secrets.
// Run: node scripts/verify-kitchen-mutations.mjs

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const LIB = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'lib')
const cache = new Map()
function load(name) {
  const file = join(LIB, name.replace(/^\.\//, '') + '.ts')
  if (cache.has(file)) return cache.get(file).exports
  const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  })
  const mod = { exports: {} }
  cache.set(file, mod)
  new Function('exports', 'require', 'module', outputText)(mod.exports, p => (p.startsWith('./') ? load(p) : require(p)), mod)
  return mod.exports
}

const M = load('kitchenMutations')
const P = load('push')
let passed = 0
const tests = []
const test = (name, fn) => tests.push([name, fn])

const ADUMIM = '8fed141d-0e7c-46c1-803b-88d3d811c1f8'
const MIKHMAS = '3ab15ad1-e835-492b-bae5-11b202ee2314'
const branchUser = { role: 'branch', branchId: ADUMIM }
const admin = { role: 'admin', branchId: null }
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

// In-memory DB fake with a conditional update (WHERE id AND status)
function fakeDb(orders, { pushImpl, raceTo } = {}) {
  const store = new Map(orders.map(o => [o.id, { ...o }]))
  const calls = { push: 0, updates: 0 }
  return {
    store, calls,
    deps: {
      async loadOrder(oid) {
        const o = store.get(oid)
        const snapshot = o ? { id: o.id, status: o.status, branch_id: o.branch_id } : null
        if (o && raceTo) o.status = raceTo // simulate another tablet changing it right after our read
        return snapshot
      },
      async updateStatusIfCurrent(oid, from, to) {
        calls.updates++
        const o = store.get(oid)
        if (!o || o.status !== from) return false
        o.status = to
        return true
      },
      async sendReadyPush(oid) { calls.push++; return pushImpl ? pushImpl(oid) : { sent: 1 } },
    },
  }
}
const run = (db, session, oid, body) => M.changeOrderStatus(db.deps, session, oid, body)

/* ─── A. STATUS ─── */
test('A3. branch user on another branch\'s order → 404 (existence not revealed)', async () => {
  const db = fakeDb([{ id: id(1), status: 'received', branch_id: MIKHMAS }])
  assert.deepEqual(await run(db, branchUser, id(1), { status: 'confirmed' }), { ok: false, status: 404, error: 'not_found' })
  assert.equal(db.store.get(id(1)).status, 'received')
})
test('A3b. unknown order and order in an unknown branch → 404 (even for admin)', async () => {
  const db = fakeDb([{ id: id(2), status: 'received', branch_id: '11111111-1111-4111-8111-111111111111' }])
  assert.equal((await run(db, admin, id(2), { status: 'confirmed' })).status, 404)
  assert.equal((await run(db, admin, id(99), { status: 'confirmed' })).status, 404)
})
test('A4. admin may mutate an order in a known branch', async () => {
  const db = fakeDb([{ id: id(3), status: 'received', branch_id: MIKHMAS }])
  assert.deepEqual(await run(db, admin, id(3), { status: 'confirmed' }), { ok: true, value: { id: id(3), status: 'confirmed' } })
})
for (const [n, from, to] of [[5, 'received', 'confirmed'], [6, 'confirmed', 'preparing'], [7, 'confirmed', 'cancelled'],
  [8, 'preparing', 'ready'], [9, 'preparing', 'cancelled'], [10, 'ready', 'delivered']]) {
  test(`A${n}. ${from} → ${to} allowed`, async () => {
    const db = fakeDb([{ id: id(n), status: from, branch_id: ADUMIM }])
    const r = await run(db, branchUser, id(n), { status: to })
    assert.equal(r.ok, true); assert.equal(db.store.get(id(n)).status, to)
  })
}
test('A11. invalid transitions → 409 invalid_transition (received→ready, received→cancelled, ready→cancelled, preparing→delivered, confirmed→ready)', async () => {
  for (const [from, to] of [['received', 'ready'], ['received', 'cancelled'], ['ready', 'cancelled'], ['preparing', 'delivered'], ['confirmed', 'ready']]) {
    const db = fakeDb([{ id: id(11), status: from, branch_id: ADUMIM }])
    assert.deepEqual(await run(db, branchUser, id(11), { status: to }), { ok: false, status: 409, error: 'invalid_transition' }, `${from}->${to}`)
    assert.equal(db.store.get(id(11)).status, from); assert.equal(db.calls.updates, 0)
  }
})
test('A12. concurrent change between read and conditional update → 409 conflict, no overwrite', async () => {
  const db = fakeDb([{ id: id(12), status: 'confirmed', branch_id: ADUMIM }], { raceTo: 'cancelled' })
  assert.deepEqual(await run(db, branchUser, id(12), { status: 'preparing' }), { ok: false, status: 409, error: 'conflict' })
  assert.equal(db.store.get(id(12)).status, 'cancelled')
})
test('A12b. same status already set (double tap / other tablet) → 409 conflict', async () => {
  const db = fakeDb([{ id: id(13), status: 'preparing', branch_id: ADUMIM }])
  assert.equal((await run(db, branchUser, id(13), { status: 'preparing' })).error, 'conflict')
})
test('A13/A14. delivered and cancelled are terminal', async () => {
  for (const from of ['delivered', 'cancelled']) for (const to of ['confirmed', 'preparing', 'ready', 'delivered', 'cancelled']) {
    if (from === to) continue
    const db = fakeDb([{ id: id(14), status: from, branch_id: ADUMIM }])
    assert.equal((await run(db, branchUser, id(14), { status: to })).error, 'invalid_transition', `${from}->${to}`)
  }
})
test('A15. malformed UUID / status / extra keys → 400 invalid_request', async () => {
  const db = fakeDb([{ id: id(15), status: 'received', branch_id: ADUMIM }])
  for (const [oid, body] of [['not-a-uuid', { status: 'confirmed' }], [id(15), { status: 'bogus' }], [id(15), { status: 'received' }],
    [id(15), {}], [id(15), null], [id(15), { status: 'confirmed', branchId: MIKHMAS }], [id(15), ['confirmed']]])
    assert.deepEqual(await run(db, branchUser, oid, body), { ok: false, status: 400, error: 'invalid_request' })
})
test('A16. → ready triggers exactly one server-side push; other targets never push', async () => {
  const db = fakeDb([{ id: id(16), status: 'preparing', branch_id: ADUMIM }, { id: id(17), status: 'received', branch_id: ADUMIM }])
  assert.deepEqual(await run(db, branchUser, id(16), { status: 'ready' }), { ok: true, value: { id: id(16), status: 'ready', pushSent: true } })
  await run(db, branchUser, id(17), { status: 'confirmed' })
  assert.equal(db.calls.push, 1)
})

/* ─── B. NOTES ─── */
function fakeItems(items) {
  const store = new Map(items.map(i => [i.id, { ...i }]))
  return {
    store,
    deps: {
      async loadItem(iid) { const i = store.get(iid); return i ? { id: i.id, orderBranchId: i.branch, orderStatus: i.orderStatus } : null },
      async updateNotes(iid, notes) { const i = store.get(iid); if (!i) return false; i.notes = notes; return true },
    },
  }
}
const note = (db, session, iid, body) => M.editItemNotes(db.deps, session, iid, body)
test('B17. item of another branch → 404', async () => {
  const db = fakeItems([{ id: id(20), branch: MIKHMAS, orderStatus: 'confirmed', notes: 'x' }])
  assert.deepEqual(await note(db, branchUser, id(20), { notes: 'y' }), { ok: false, status: 404, error: 'not_found' })
  assert.equal(db.store.get(id(20)).notes, 'x')
})
test('B18/B19. confirmed and preparing allow edits', async () => {
  for (const s of ['confirmed', 'preparing']) {
    const db = fakeItems([{ id: id(21), branch: ADUMIM, orderStatus: s, notes: 'x' }])
    assert.deepEqual(await note(db, branchUser, id(21), { notes: '  בלי חריף  ' }), { ok: true, value: { id: id(21), notes: 'בלי חריף' } })
  }
})
test('B20–B23. received / ready / delivered / cancelled → 409 invalid_state', async () => {
  for (const s of ['received', 'ready', 'delivered', 'cancelled', null]) {
    const db = fakeItems([{ id: id(22), branch: ADUMIM, orderStatus: s, notes: 'x' }])
    assert.deepEqual(await note(db, admin, id(22), { notes: 'y' }), { ok: false, status: 409, error: 'invalid_state' }, String(s))
    assert.equal(db.store.get(id(22)).notes, 'x')
  }
})
test('B24. > 500 chars rejected; exactly 500 accepted', async () => {
  const db = fakeItems([{ id: id(23), branch: ADUMIM, orderStatus: 'preparing', notes: 'x' }])
  assert.equal((await note(db, branchUser, id(23), { notes: 'a'.repeat(501) })).status, 400)
  assert.equal((await note(db, branchUser, id(23), { notes: 'a'.repeat(500) })).ok, true)
})
test('B25. empty / whitespace → null; explicit null allowed; bad shapes → 400', async () => {
  const db = fakeItems([{ id: id(24), branch: ADUMIM, orderStatus: 'confirmed', notes: 'x' }])
  assert.deepEqual((await note(db, branchUser, id(24), { notes: '   ' })).value, { id: id(24), notes: null })
  assert.deepEqual((await note(db, branchUser, id(24), { notes: null })).value, { id: id(24), notes: null })
  for (const b of [{}, { notes: 5 }, { notes: 'a', extra: 1 }, null, 'str'])
    assert.equal((await note(db, branchUser, id(24), b)).status, 400)
  assert.equal((await note(db, branchUser, 'bad-id', { notes: 'a' })).status, 400)
})

/* ─── C. PUSH ─── */
function fakePush(order, subs, sendImpl) {
  const log = { sent: [], deleted: 0 }
  return {
    log,
    deps: {
      async loadOrder() { return order },
      async loadSubscriptions() { return subs },
      async deleteSubscriptions() { log.deleted++ },
      async send(sub, payload) { if (sendImpl) return sendImpl(sub, payload); log.sent.push(JSON.parse(payload)) },
    },
  }
}
test('C28. ready pickup wording (and legacy NULL type)', async () => {
  for (const type of ['pickup', null]) {
    const f = fakePush({ status: 'ready', type, daily_number: 7 }, [{}])
    assert.deepEqual(await P.sendReadyPushWith(f.deps, id(30)), { outcome: 'sent', sent: 1 })
    assert.deepEqual(f.log.sent[0], { title: '🔔 ההזמנה שלך מוכנה!', body: '🔔 הזמנה #0007 מוכנה לאיסוף' })
  }
})
test('C29. ready delivery wording', async () => {
  const f = fakePush({ status: 'ready', type: 'delivery', daily_number: 12 }, [{}])
  await P.sendReadyPushWith(f.deps, id(31))
  assert.deepEqual(f.log.sent[0], { title: '🛵 ההזמנה שלך בדרך!', body: '🛵 הזמנה #0012 מוכנה ויוצאת למשלוח' })
})
test('C30. non-ready order never sends (any other status); missing order → not_found', async () => {
  for (const status of ['received', 'confirmed', 'preparing', 'delivered', 'cancelled']) {
    const f = fakePush({ status, type: 'pickup', daily_number: 1 }, [{}])
    assert.deepEqual(await P.sendReadyPushWith(f.deps, id(32)), { outcome: 'not_ready', sent: 0 })
    assert.equal(f.log.sent.length, 0)
  }
  assert.equal((await P.sendReadyPushWith(fakePush(null, [{}]).deps, id(32))).outcome, 'not_found')
  assert.equal((await P.sendReadyPushWith(fakePush({ status: 'ready', type: null, daily_number: 1 }, []).deps, id(32))).outcome, 'no_subscription')
})
test('C31. expired subscriptions (404/410) are cleaned up', async () => {
  const f = fakePush({ status: 'ready', type: 'pickup', daily_number: 1 }, [{}, {}], async () => { throw Object.assign(new Error('gone'), { statusCode: 410 }) })
  assert.deepEqual(await P.sendReadyPushWith(f.deps, id(33)), { outcome: 'expired', sent: 0 })
  assert.equal(f.log.deleted, 1)
  const g = fakePush({ status: 'ready', type: 'pickup', daily_number: 1 }, [{}], async () => { throw Object.assign(new Error('x'), { statusCode: 500 }) })
  assert.deepEqual(await P.sendReadyPushWith(g.deps, id(33)), { outcome: 'failed', sent: 0 })
  assert.equal(g.log.deleted, 0) // non-expiry failures keep the subscription
})
test('C32. push failure (throws) does NOT undo the status change', async () => {
  const db = fakeDb([{ id: id(34), status: 'preparing', branch_id: ADUMIM }], { pushImpl: async () => { throw new Error('push down') } })
  const r = await run(db, branchUser, id(34), { status: 'ready' })
  assert.deepEqual(r, { ok: true, value: { id: id(34), status: 'ready', pushSent: false } })
  assert.equal(db.store.get(id(34)).status, 'ready')
})
test('C27. wrong-branch caller cannot trigger push via the status path (404 before any push)', async () => {
  const db = fakeDb([{ id: id(35), status: 'preparing', branch_id: MIKHMAS }])
  assert.equal((await run(db, branchUser, id(35), { status: 'ready' })).status, 404)
  assert.equal(db.calls.push, 0)
  assert.equal(M.isBranchInScope(branchUser, MIKHMAS), false) // same guard used by /api/push/send
  assert.equal(M.isBranchInScope(admin, MIKHMAS), true)
  assert.equal(M.isBranchInScope(admin, '11111111-1111-4111-8111-111111111111'), false)
})

for (const [name, fn] of tests) { await fn(); passed++; console.log('  ✓', name) }
console.log(`\nAll ${passed} kitchen-mutation/push checks passed.`)
