// Local, dependency-free checks for the pure order modules (no DB, no network).
// Run: node scripts/verify-pricing.mjs
// Transpiles lib/*.ts in memory with the installed `typescript` package; writes nothing to disk.

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

const cfg = load('orderConfig')
const { computeOrderTotals } = load('pricing')
const { parseCreateOrderRequest, buildOrderFromCatalog } = load('orderRequest')
const { getBusinessStatus } = load('hours')
const { formatDeliveryAddress } = load('deliveryAddress')

let passed = 0
const test = (name, fn) => { fn(); passed++; console.log('  ✓', name) }

const CAT = {
  falafel: '02e0f987-6cce-4a1d-85c6-5ff6f97c80a4',
  meat: '82952bb4-b2b6-44a1-83e2-844ed6e3edd2',
  deals: 'b9f67c42-7ea8-4643-b70c-db49e9e23bc5',
  sides: 'a8407f94-c5b1-4adb-b452-5d60008fefad',
  drinks: 'f70b04f0-c87d-496b-b044-857a477f441d',
  unknown: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
}
const line = (categoryId, basePrice, quantity, extra = {}) => ({ categoryId, basePrice, paidAddonPrices: [], quantity, ...extra })

console.log('Pricing (lib/pricing.ts)')
test('A. pickup: subtotal 60 → total 60, no delivery charges', () => {
  const t = computeOrderTotals([line(CAT.falafel, 20, 3)], 'pickup')
  assert.equal(t.subtotal, 60); assert.equal(t.mealSurcharge, 0); assert.equal(t.deliveryFee, 0); assert.equal(t.total, 60)
})
test('B+D. delivery: subtotal 60, one line qty 3 → 3 units, surcharge 12, fee 20, total 92', () => {
  const t = computeOrderTotals([line(CAT.falafel, 20, 3)], 'delivery')
  assert.equal(t.subtotal, 60); assert.equal(t.mealQuantity, 3); assert.equal(t.mealSurcharge, 12)
  assert.equal(t.deliveryFee, 20); assert.equal(t.total, 92); assert.equal(t.discount, 0)
})
test('C. delivery, drinks only → meal qty 0, surcharge 0, fee 20', () => {
  const t = computeOrderTotals([line(CAT.drinks, 12, 2)], 'delivery')
  assert.equal(t.mealQuantity, 0); assert.equal(t.mealSurcharge, 0); assert.equal(t.deliveryFee, 20); assert.equal(t.total, 44)
})
test('E. mixed cart: meals + deal extras + paid add-ons + drinks + side', () => {
  const t = computeOrderTotals([
    line(CAT.falafel, 24, 2, { paidAddonPrices: [4, 3] }),                     // (24+7)×2 = 62, 2 units
    line(CAT.deals, 45, 1, { setDrink: 'קולה זכוכית', setAddon: 'טבעות בצל' }), // 45+3+10 = 58, 1 unit
    line(CAT.drinks, 9, 2),                                                     // 18, 0 units
    line(CAT.sides, 16, 1),                                                     // 16, 1 unit
  ], 'delivery')
  assert.equal(t.lines[0].unitPrice, 31); assert.equal(t.lines[1].unitPrice, 58) // deal extras inside unit price
  assert.equal(t.subtotal, 154); assert.equal(t.mealQuantity, 4); assert.equal(t.mealSurcharge, 16); assert.equal(t.total, 190)
})
test('F. unknown/new category never qualifies for ₪4', () => {
  const t = computeOrderTotals([line(CAT.unknown, 10, 5)], 'delivery')
  assert.equal(t.mealQuantity, 0); assert.equal(t.mealSurcharge, 0); assert.equal(t.total, 70)
})
test('free deal options add nothing; money rounding is stable', () => {
  const t = computeOrderTotals([line(CAT.deals, 45, 1, { setDrink: 'מים', setAddon: 'ציפס אישי' }), line(CAT.drinks, 0.1, 1), line(CAT.drinks, 0.2, 1)], 'pickup')
  assert.equal(t.lines[0].unitPrice, 45); assert.equal(t.subtotal, 45.3)
})

console.log('Server request validation + building (lib/orderRequest.ts)')
const DELIVERY_BRANCH = cfg.DELIVERY_BRANCH_IDS[0]
const OTHER_BRANCH = '11111111-1111-4111-8111-111111111111'
const HIDDEN_BRANCH = cfg.CUSTOMER_HIDDEN_BRANCH_IDS[0]
const ITEM = { falafel: 'aaaaaaaa-0000-4000-8000-000000000001', drink: 'aaaaaaaa-0000-4000-8000-000000000002', deal: 'aaaaaaaa-0000-4000-8000-000000000003' }
const TOP = { tahini: 'bbbbbbbb-0000-4000-8000-000000000001', egg: 'bbbbbbbb-0000-4000-8000-000000000002', nullPrice: 'bbbbbbbb-0000-4000-8000-000000000003' }
const catalog = {
  items: new Map([
    [ITEM.falafel, { id: ITEM.falafel, category_id: CAT.falafel, is_active: true, has_egg: true }],
    [ITEM.drink, { id: ITEM.drink, category_id: CAT.drinks, is_active: true }],
    [ITEM.deal, { id: ITEM.deal, category_id: CAT.deals, is_active: true, has_egg: false }],
  ]),
  prices: new Map([
    [ITEM.falafel, { item_id: ITEM.falafel, price: 20, is_available: true }],
    [ITEM.drink, { item_id: ITEM.drink, price: 9, is_available: true }],
    [ITEM.deal, { item_id: ITEM.deal, price: 45, is_available: true }],
  ]),
  toppings: new Map([
    [TOP.tahini, { id: TOP.tahini, name_he: 'טחינה', type: 'spread', price: 4 }],
    [TOP.egg, { id: TOP.egg, name_he: 'ביצה קשה', type: 'paid_addon', price: 4 }],
    [TOP.nullPrice, { id: TOP.nullPrice, name_he: 'משהו', type: 'paid_addon', price: null }],
  ]),
}
const baseReq = (over = {}) => ({
  branchId: DELIVERY_BRANCH, type: 'pickup', customerName: 'ישראל ישראלי', phone: '050-1234567', paymentMethod: 'cash',
  items: [{ itemId: ITEM.falafel, quantity: 3, sauceIds: [TOP.tahini] }], ...over,
})
const address = { city: 'מעלה אדומים', street: 'הדקל', houseNumber: '12', floor: '3', apartment: '8', entrance: 'ב', courierNotes: 'לצלצל' }
const build = body => {
  const p = parseCreateOrderRequest(body)
  if (!p.ok) return p
  return buildOrderFromCatalog(p.value, catalog)
}

test('valid pickup → total from catalog (3 × 20 = 60), no p_delivery, no ₪4 on sauces', () => {
  const r = build(baseReq())
  assert.ok(r.ok, JSON.stringify(r)); assert.equal(r.value.rpcArgs.p_order.total_price, 60)
  assert.equal(r.value.rpcArgs.p_order.type, 'pickup'); assert.equal(r.value.rpcArgs.p_delivery, null)
  assert.equal(r.value.rpcArgs.p_order.phone, '0501234567'); assert.equal(r.value.rpcArgs.p_items[0].notes, 'רטבים: טחינה')
})
test('valid delivery → 60 + 12 + 20 = 92 and a full deliveries payload', () => {
  const r = build(baseReq({ type: 'delivery', delivery: address }))
  assert.ok(r.ok, JSON.stringify(r)); const d = r.value.rpcArgs.p_delivery
  assert.equal(r.value.rpcArgs.p_order.total_price, 92)
  assert.equal(d.meal_quantity, 3); assert.equal(d.meal_surcharge, 12); assert.equal(d.delivery_fee, 20)
  assert.equal(d.address, 'מעלה אדומים, הדקל 12, כניסה ב, קומה 3, דירה 8'); assert.equal(d.notes, 'לצלצל')
  // p_items unit prices exclude order-level delivery charges
  const itemsSum = r.value.rpcArgs.p_items.reduce((s, i) => s + i.unit_price * i.quantity, 0)
  assert.equal(itemsSum + d.meal_surcharge + d.delivery_fee, r.value.rpcArgs.p_order.total_price)
})
test('deal line: unit_price includes deal extras; kitchen note format kept', () => {
  const r = build(baseReq({ items: [{ itemId: ITEM.deal, quantity: 1, setDrink: 'פיוז טי', setAddon: 'ציפס גדול' }] }))
  assert.ok(r.ok, JSON.stringify(r)); assert.equal(r.value.rpcArgs.p_items[0].unit_price, 55)
  assert.equal(r.value.rpcArgs.p_items[0].notes, 'שתייה: פיוז טי (+₪3) | תוספת עסקית: ציפס גדול (+₪7)')
})
test('G. payment method never changes the price (cash / credit / cibus / bit)', () => {
  const totals = cfg.PAYMENT_METHODS.map(pm => build(baseReq({ type: 'delivery', delivery: address, paymentMethod: pm })).value.rpcArgs.p_order.total_price)
  assert.deepEqual(totals, [92, 92, 92, 92])
})
test('H. invalid locality rejected', () => {
  assert.equal(build(baseReq({ type: 'delivery', delivery: { ...address, city: 'ירושלים' } })).code, 'invalid_delivery_area')
})
test('H2. missing street / house number rejected', () => {
  assert.equal(build(baseReq({ type: 'delivery', delivery: { ...address, street: '  ' } })).code, 'invalid_address')
  assert.equal(build(baseReq({ type: 'delivery', delivery: { ...address, houseNumber: '' } })).code, 'invalid_address')
})
test('I. delivery from a non-delivery branch rejected; hidden branch rejected', () => {
  assert.equal(build(baseReq({ branchId: OTHER_BRANCH, type: 'delivery', delivery: address })).code, 'delivery_not_available')
  assert.equal(build(baseReq({ branchId: HIDDEN_BRANCH })).code, 'invalid_branch')
})
test('J. client price tampering rejected (order-level and item-level money fields)', () => {
  assert.equal(build(baseReq({ total: 1 })).code, 'client_prices_not_accepted')
  assert.equal(build(baseReq({ deliveryFee: 0, type: 'delivery', delivery: address })).code, 'client_prices_not_accepted')
  assert.equal(build(baseReq({ items: [{ itemId: ITEM.falafel, quantity: 3, unitPrice: 1 }] })).code, 'client_prices_not_accepted')
})
test('pickup carrying delivery info rejected', () => {
  assert.equal(build(baseReq({ delivery: address })).code, 'invalid_request')
})
test('unknown option ID rejected; paid add-on without price rejected (no ₪4 fallback)', () => {
  assert.equal(build(baseReq({ items: [{ itemId: ITEM.falafel, quantity: 1, paidAddonIds: ['cccccccc-0000-4000-8000-000000000009'] }] })).code, 'invalid_option')
  assert.equal(build(baseReq({ items: [{ itemId: ITEM.falafel, quantity: 1, paidAddonIds: [TOP.nullPrice] }] })).code, 'invalid_option')
})
test('menu rules enforced server-side (egg not allowed on has_egg=false; deal options only on deals; no sauces on drinks)', () => {
  assert.equal(build(baseReq({ items: [{ itemId: ITEM.deal, quantity: 1, paidAddonIds: [TOP.egg] }] })).code, 'invalid_option')
  assert.equal(build(baseReq({ items: [{ itemId: ITEM.falafel, quantity: 1, setDrink: 'מים' }] })).code, 'invalid_option')
  assert.equal(build(baseReq({ items: [{ itemId: ITEM.drink, quantity: 1, sauceIds: [TOP.tahini] }] })).code, 'invalid_option')
})
test('quantity bounds (1..20) and unknown item', () => {
  assert.equal(build(baseReq({ items: [{ itemId: ITEM.falafel, quantity: 0 }] })).code, 'invalid_quantity')
  assert.equal(build(baseReq({ items: [{ itemId: ITEM.falafel, quantity: 21 }] })).code, 'invalid_quantity')
  assert.equal(build(baseReq({ items: [{ itemId: 'dddddddd-0000-4000-8000-000000000001', quantity: 1 }] })).code, 'item_unavailable')
})
test('phone / name / payment method validation', () => {
  assert.equal(build(baseReq({ phone: '0721234567' })).code, 'invalid_phone')
  assert.equal(build(baseReq({ customerName: 'א' })).code, 'invalid_name')
  assert.equal(build(baseReq({ paymentMethod: 'hyp' })).code, 'invalid_payment_method')
})
test('UI-aligned limits: name ≤ 60, item notes ≤ 200 (match input maxLength)', () => {
  assert.equal(build(baseReq({ customerName: 'א'.repeat(61) })).code, 'invalid_name')
  assert.ok(build(baseReq({ customerName: 'א'.repeat(60) })).ok)
  assert.equal(build(baseReq({ items: [{ itemId: ITEM.falafel, quantity: 1, notes: 'x'.repeat(201) }] })).code, 'invalid_request')
  assert.ok(build(baseReq({ items: [{ itemId: ITEM.falafel, quantity: 1, notes: 'x'.repeat(200) }] })).ok)
})

console.log('Opening hours in Asia/Jerusalem (lib/hours.ts)')
test('Thu 2026-09-24 08:30 IDT → open', () => assert.equal(getBusinessStatus(new Date('2026-09-24T05:30:00Z')).isOpen, true))
test('Thu 19:45 IDT → closed, next open Sunday', () => {
  const s = getBusinessStatus(new Date('2026-09-24T16:45:00Z')); assert.equal(s.isOpen, false); assert.match(s.nextOpen, /^ראשון/)
})
test('Sun 07:59 IDT → closed, opens today 08:00', () => {
  const s = getBusinessStatus(new Date('2026-09-27T04:59:00Z')); assert.equal(s.isOpen, false); assert.equal(s.nextOpen, 'היום בשעה 08:00')
})
test('Fri 12:00 IDT → closed', () => assert.equal(getBusinessStatus(new Date('2026-09-25T09:00:00Z')).isOpen, false))
test('winter time: Mon 2026-12-07 19:29 IST → open; 19:30 → closed', () => {
  assert.equal(getBusinessStatus(new Date('2026-12-07T17:29:00Z')).isOpen, true)
  assert.equal(getBusinessStatus(new Date('2026-12-07T17:30:00Z')).isOpen, false)
})

console.log('Address formatter (lib/deliveryAddress.ts)')
test('skips empty optional parts', () => {
  assert.equal(formatDeliveryAddress({ city: 'אלון', street: 'הגפן', houseNumber: '5' }), 'אלון, הגפן 5')
})

console.log(`\nAll ${passed} checks passed.`)
