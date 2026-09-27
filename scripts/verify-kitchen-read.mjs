// Local checks for the kitchen READ model (FALAFEL-SN-06C): branch scoping, minimal select,
// normalization, data minimization and the Asia/Jerusalem day window. Pure — no DB, no network.
// Run: node scripts/verify-kitchen-read.mjs

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
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  })
  const mod = { exports: {} }
  cache.set(file, mod)
  new Function('exports', 'require', 'module', outputText)(mod.exports, p => (p.startsWith('./') ? load(p) : require(p)), mod)
  return mod.exports
}

const R = load('kitchenOrders')
const H = load('hours')
let passed = 0
const test = (name, fn) => { fn(); passed++; console.log('  ✓', name) }

const ADUMIM = '8fed141d-0e7c-46c1-803b-88d3d811c1f8'
const MIKHMAS = '3ab15ad1-e835-492b-bae5-11b202ee2314'
const branchUser = { role: 'branch', branchId: ADUMIM }
const admin = { role: 'admin', branchId: null }

console.log('Branch scope')
test('3. branch user is forced to its own branch (no param or own id)', () => {
  assert.deepEqual(R.resolveBranchScope(branchUser, null), { ok: true, branchIds: [ADUMIM] })
  assert.deepEqual(R.resolveBranchScope(branchUser, ''), { ok: true, branchIds: [ADUMIM] })
  assert.deepEqual(R.resolveBranchScope(branchUser, ADUMIM), { ok: true, branchIds: [ADUMIM] })
})
test('3b. branch user asking for another branch or "all" → 403 (never widened)', () => {
  assert.deepEqual(R.resolveBranchScope(branchUser, MIKHMAS), { ok: false, status: 403, error: 'forbidden' })
  assert.deepEqual(R.resolveBranchScope(branchUser, 'all'), { ok: false, status: 403, error: 'forbidden' })
})
test('4. admin: no param / "all" → all known branches', () => {
  assert.deepEqual(R.resolveBranchScope(admin, null), { ok: true, branchIds: [ADUMIM, MIKHMAS] })
  assert.deepEqual(R.resolveBranchScope(admin, 'all'), { ok: true, branchIds: [ADUMIM, MIKHMAS] })
})
test('5. admin: a known branch → that branch only', () => {
  assert.deepEqual(R.resolveBranchScope(admin, MIKHMAS), { ok: true, branchIds: [MIKHMAS] })
})
test('6. admin: unknown UUID / malformed value → 400', () => {
  for (const bad of ['11111111-1111-4111-8111-111111111111', 'ALL', 'x', "'; drop", ADUMIM.toUpperCase(), ADUMIM + ',' + MIKHMAS])
    assert.deepEqual(R.resolveBranchScope(admin, bad), { ok: false, status: 400, error: 'invalid_request' }, bad)
})
test('6b. malformed param is 400 for branch users too (validated before authorization)', () => {
  assert.equal(R.resolveBranchScope(branchUser, 'not-a-uuid').status, 400)
})

console.log('Minimal select + normalization')
test('select string is explicit: no *, no deliveries(*), no forbidden columns', () => {
  const s = R.KITCHEN_ORDER_SELECT
  assert.ok(!s.includes('*'))
  for (const f of ['order_number', 'updated_at', 'unit_price', 'item_id', 'city', 'street', 'house_number', 'apartment', 'floor', 'entrance', 'push_subscriptions'])
    assert.ok(!new RegExp(`\\b${f}\\b`).test(s), f)
  assert.match(s, /deliveries\(address, notes, meal_quantity, meal_surcharge, delivery_fee\)/)
})
const deliveryRow = {
  id: 'o1', daily_number: 7, type: 'delivery', status: 'received', created_at: '2026-09-27T06:00:00+00:00',
  customer_name: 'לקוח', phone: '0501234567', payment_method: 'cash', total_price: '92.00', branch_id: ADUMIM,
  // fields that must NEVER leak even if the DB returned them:
  order_number: 999, updated_at: 'x', notes: 'internal', secret: 'nope',
  branches: { name: 'מישור אדומים', id: ADUMIM, phone: 'x' },
  order_items: [{ id: 'i1', quantity: 3, notes: 'רטבים: טחינה', item_id: 'm1', unit_price: 20, menu_items: { name_he: 'פלאפל בפיתה', id: 'm1' } }],
  deliveries: [{ address: 'מעלה אדומים, הדקל 12', notes: 'לצלצל', meal_quantity: 3, meal_surcharge: '12.00', delivery_fee: '20.00',
    phone: '0500000000', city: 'מעלה אדומים', street: 'הדקל', house_number: '12', id: 'd1', order_id: 'o1' }],
}
test('8. delivery mapping (array-shaped embed, numeric strings → numbers)', () => {
  const o = R.normalizeKitchenOrder(deliveryRow)
  assert.equal(o.type, 'delivery'); assert.equal(o.totalPrice, 92); assert.equal(o.branchName, 'מישור אדומים')
  assert.deepEqual(o.delivery, { address: 'מעלה אדומים, הדקל 12', courierNotes: 'לצלצל', mealQuantity: 3, mealSurcharge: 12, deliveryFee: 20 })
  assert.deepEqual(o.items, [{ id: 'i1', name: 'פלאפל בפיתה', quantity: 3, notes: 'רטבים: טחינה' }])
})
test('8b. object-shaped delivery embed also works', () => {
  assert.equal(R.normalizeKitchenOrder({ ...deliveryRow, deliveries: deliveryRow.deliveries[0] }).delivery.deliveryFee, 20)
})
test('7. type NULL (legacy) → pickup; missing/unknown type → pickup', () => {
  assert.equal(R.normalizeKitchenOrder({ ...deliveryRow, type: null }).type, 'pickup')
  assert.equal(R.normalizeKitchenOrder({ ...deliveryRow, type: undefined }).type, 'pickup')
  assert.equal(R.normalizeKitchenOrder({ ...deliveryRow, type: 'weird' }).type, 'pickup')
})
test('9. pickup → delivery = null even if a deliveries row came back; delivery w/o row → null (no crash)', () => {
  assert.equal(R.normalizeKitchenOrder({ ...deliveryRow, type: 'pickup' }).delivery, null)
  assert.equal(R.normalizeKitchenOrder({ ...deliveryRow, deliveries: null }).delivery, null)
  assert.equal(R.normalizeKitchenOrder({ ...deliveryRow, deliveries: [] }).delivery, null)
})
test('10. no extra/sensitive fields in output (exact key sets)', () => {
  const o = R.normalizeKitchenOrder(deliveryRow)
  assert.deepEqual(Object.keys(o).sort(), ['branchId', 'branchName', 'createdAt', 'customerName', 'dailyNumber', 'delivery', 'id', 'items', 'paymentMethod', 'phone', 'status', 'totalPrice', 'type'])
  assert.deepEqual(Object.keys(o.items[0]).sort(), ['id', 'name', 'notes', 'quantity'])
  assert.deepEqual(Object.keys(o.delivery).sort(), ['address', 'courierNotes', 'deliveryFee', 'mealQuantity', 'mealSurcharge'])
  const s = JSON.stringify(o)
  for (const leak of ['order_number', '999', 'internal', 'nope', 'unit_price', 'item_id', '0500000000', 'house_number', 'order_id'])
    assert.ok(!s.includes(leak), leak)
})
test('nullable fields and odd shapes are handled defensively', () => {
  const o = R.normalizeKitchenOrder({ ...deliveryRow, type: null, daily_number: null, customer_name: null, branches: null,
    order_items: [{ id: 'i2', quantity: null, notes: null, menu_items: null }, 'junk', { quantity: 1 }] })
  assert.equal(o.dailyNumber, null); assert.equal(o.customerName, null); assert.equal(o.branchName, null)
  assert.deepEqual(o.items, [{ id: 'i2', name: 'פריט', quantity: 1, notes: null }])
  assert.equal(R.normalizeKitchenOrder(null), null); assert.equal(R.normalizeKitchenOrder({ id: 'x' }), null)
  assert.deepEqual(R.normalizeKitchenOrders('not-an-array'), [])
  assert.equal(R.normalizeKitchenOrders([deliveryRow, null, { id: 'x' }]).length, 1)
})

console.log('Israel-day window (Asia/Jerusalem, DST-safe)')
const iso = d => d.toISOString()
test('11. summer day (IDT, UTC+3): 00:00–24:00 Israel', () => {
  const b = H.israelDayBounds(new Date('2026-09-27T10:00:00Z'))
  assert.equal(iso(b.start), '2026-09-26T21:00:00.000Z'); assert.equal(iso(b.end), '2026-09-27T21:00:00.000Z')
})
test('11b. late evening Israel time still maps to the same Israel day (not the UTC day)', () => {
  const b = H.israelDayBounds(new Date('2026-09-27T20:59:00Z')) // 23:59 IDT
  assert.equal(iso(b.start), '2026-09-26T21:00:00.000Z')
  const b2 = H.israelDayBounds(new Date('2026-09-27T21:00:00Z')) // 00:00 IDT next day
  assert.equal(iso(b2.start), '2026-09-27T21:00:00.000Z')
})
test('11c. winter day (IST, UTC+2)', () => {
  const b = H.israelDayBounds(new Date('2026-12-07T12:00:00Z'))
  assert.equal(iso(b.start), '2026-12-06T22:00:00.000Z'); assert.equal(iso(b.end), '2026-12-07T22:00:00.000Z')
})
test('11d. DST start day (Fri 2026-03-27) is 23h; DST end day (Sun 2026-10-25) is 25h', () => {
  const s = H.israelDayBounds(new Date('2026-03-27T12:00:00Z'))
  assert.equal(iso(s.start), '2026-03-26T22:00:00.000Z'); assert.equal(iso(s.end), '2026-03-27T21:00:00.000Z')
  const e = H.israelDayBounds(new Date('2026-10-25T12:00:00Z'))
  assert.equal(iso(e.start), '2026-10-24T21:00:00.000Z'); assert.equal(iso(e.end), '2026-10-25T22:00:00.000Z')
})
test('11e. month/year boundary', () => {
  const b = H.israelDayBounds(new Date('2026-12-31T21:30:00Z')) // 23:30 IST Dec 31
  assert.equal(iso(b.start), '2026-12-30T22:00:00.000Z'); assert.equal(iso(b.end), '2026-12-31T22:00:00.000Z')
})

console.log(`\nAll ${passed} kitchen-read checks passed.`)
