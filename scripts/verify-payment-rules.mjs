// Local checks for the delivery payment rules (FALAFEL-SN-07A, updated 08D14: delivery = cash | credit). No DB, no network.
// Run: node scripts/verify-payment-rules.mjs

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LIB = join(ROOT, 'lib')
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

const cfg = load('orderConfig')
const { computeOrderTotals, computeDisplayTotals } = load('pricing')
const { parseCreateOrderRequest, buildOrderFromCatalog } = load('orderRequest')

let passed = 0
const test = (name, fn) => { fn(); passed++; console.log('  ✓', name) }

const BRANCH = cfg.DELIVERY_BRANCH_IDS[0]
const FALAFEL_CAT = '02e0f987-6cce-4a1d-85c6-5ff6f97c80a4'
const ITEM = 'aaaaaaaa-0000-4000-8000-000000000001'
const catalog = {
  items: new Map([[ITEM, { id: ITEM, category_id: FALAFEL_CAT, is_active: true }]]),
  prices: new Map([[ITEM, { item_id: ITEM, price: 20, is_available: true }]]),
  toppings: new Map(),
}
const address = { city: 'מעלה אדומים', street: 'הדקל', houseNumber: '12' }
const req = (type, paymentMethod) => ({
  branchId: BRANCH, type, customerName: 'ישראל ישראלי', phone: '0501234567', paymentMethod,
  items: [{ itemId: ITEM, quantity: 3 }], ...(type === 'delivery' ? { delivery: address } : {}),
})
const run = body => { const p = parseCreateOrderRequest(body); return p.ok ? buildOrderFromCatalog(p.value, catalog) : p }

console.log('Server rule (parseCreateOrderRequest → buildOrderFromCatalog) — 08D14: delivery = cash | credit')
for (const [n, pm] of [[17, 'cash'], [18, 'credit'], [19, 'cibus'], [20, 'bit']]) {
  test(`${n}. pickup + ${pm} → allowed (total 60)`, () => {
    const r = run(req('pickup', pm))
    assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.value.rpcArgs.p_order.payment_method, pm)
    assert.equal(r.value.rpcArgs.p_order.total_price, 60)
  })
}
for (const [n, pm] of [[13, 'cash'], [14, 'credit']]) {
  test(`${n}. delivery + ${pm} → allowed (total 60 + 12 + 25 = 97)`, () => {
    const r = run(req('delivery', pm))
    assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.value.rpcArgs.p_order.payment_method, pm)
    assert.equal(r.value.rpcArgs.p_order.total_price, 97)
  })
}
for (const [n, pm] of [[15, 'cibus'], [16, 'bit']]) {
  test(`${n}. delivery + ${pm} → rejected (400 payment_method_not_allowed, before any catalog/DB step)`, () => {
    assert.deepEqual(parseCreateOrderRequest(req('delivery', pm)), { ok: false, code: 'payment_method_not_allowed', detail: undefined })
  })
}
test('delivery + null / empty / missing → rejected (invalid_payment_method)', () => {
  for (const pm of [null, '', undefined]) {
    const r = parseCreateOrderRequest(req('delivery', pm))
    assert.equal(r.ok, false); assert.equal(r.code, 'invalid_payment_method')
  }
})
test('delivery + unknown value (hyp / CREDIT / CASH / credit_card / 1) → rejected', () => {
  for (const pm of ['hyp', 'CREDIT', 'CASH', 'credit_card', ' credit', 1, {}])
    assert.equal(parseCreateOrderRequest(req('delivery', pm)).code, 'invalid_payment_method', String(pm))
})
test('defensive invariant: buildOrderFromCatalog rejects delivery + cibus/bit even if parse is bypassed', () => {
  for (const pm of ['cibus', 'bit']) {
    const bypass = { ...parseCreateOrderRequest(req('delivery', 'credit')).value, paymentMethod: pm }
    assert.equal(buildOrderFromCatalog(bypass, catalog).code, 'payment_method_not_allowed', pm)
  }
  const cash = { ...parseCreateOrderRequest(req('delivery', 'credit')).value, paymentMethod: 'cash' }
  assert.equal(buildOrderFromCatalog(cash, catalog).ok, true)
})
test('route rejects before any DB access (parse runs before getServerSupabase)', () => {
  const src = readFileSync(join(ROOT, 'app', 'api', 'orders', 'route.ts'), 'utf8')
  const parseAt = src.indexOf('parseCreateOrderRequest(body)'), rejectAt = src.indexOf('if (!parsed.ok) return errorResponse(400')
  const dbAt = src.indexOf('getServerSupabase()')
  assert.ok(parseAt > 0 && rejectAt > parseAt && dbAt > rejectAt)
})

console.log('UI rule (allowedPaymentMethods / resolvePaymentMethod)')
test('delivery shows exactly 💵 מזומן + 💳 אשראי; pickup shows cash, credit, cibus, bit', () => {
  assert.deepEqual([...cfg.allowedPaymentMethods('delivery')], ['cash', 'credit'])
  assert.deepEqual(cfg.allowedPaymentMethods('delivery').map(m => cfg.PAYMENT_METHOD_LABELS[m]), ['💵 מזומן', '💳 אשראי'])
  assert.deepEqual([...cfg.allowedPaymentMethods('pickup')], ['cash', 'credit', 'cibus', 'bit'])
})
test('pickup cash / credit → delivery keeps the same method (no surprising change)', () => {
  assert.equal(cfg.resolvePaymentMethod('delivery', 'cash'), 'cash')
  assert.equal(cfg.resolvePaymentMethod('delivery', 'credit'), 'credit')
})
test('21–22. pickup cibus / bit → delivery falls back safely to credit', () => {
  assert.equal(cfg.DELIVERY_FALLBACK_PAYMENT_METHOD, 'credit')
  for (const chosen of ['cibus', 'bit']) assert.equal(cfg.resolvePaymentMethod('delivery', chosen), 'credit', chosen)
})
test('switching delivery → pickup restores the earlier pickup selection (choice is never overwritten)', () => {
  let chosen = 'bit' // customer picked Bit while on pickup
  assert.equal(cfg.resolvePaymentMethod('pickup', chosen), 'bit')
  assert.equal(cfg.resolvePaymentMethod('delivery', chosen), 'credit') // → delivery
  assert.equal(cfg.resolvePaymentMethod('pickup', chosen), 'bit')      // → back to pickup
  chosen = 'cash' // customer tapped cash while on delivery
  assert.equal(cfg.resolvePaymentMethod('pickup', chosen), 'cash')
  assert.equal(cfg.allowedPaymentMethods('pickup').length, 4)
})
test('a stale method can never reach a delivery submit (resolved value is always allowed)', () => {
  for (const chosen of cfg.PAYMENT_METHODS)
    assert.ok(cfg.isPaymentMethodAllowed('delivery', cfg.resolvePaymentMethod('delivery', chosen)))
})

console.log('Pricing independence')
test('pricing is unchanged by payment method (functions take no payment input; server totals equal)', () => {
  assert.equal(computeOrderTotals.length, 3); assert.equal(computeDisplayTotals.length, 3) // (lines, type, deliveryCity) — no payment input
  const pickupTotals = cfg.PAYMENT_METHODS.map(pm => run(req('pickup', pm)).value.breakdown)
  for (const b of pickupTotals) assert.deepEqual(b, pickupTotals[0])
  const [cash, credit] = ['cash', 'credit'].map(pm => run(req('delivery', pm)).value.breakdown)
  assert.deepEqual(cash, credit)
  assert.deepEqual({ subtotal: credit.subtotal, mealSurcharge: credit.mealSurcharge, deliveryFee: credit.deliveryFee, total: credit.total },
    { subtotal: 60, mealSurcharge: 12, deliveryFee: 25, total: 97 })
})

console.log(`\nAll ${passed} payment-rule checks passed.`)
