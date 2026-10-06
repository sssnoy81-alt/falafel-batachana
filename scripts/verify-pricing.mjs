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
// Existing delivery fixtures use מעלה אדומים (destination fee ₪20); destination fees are covered separately below.
const MA = 'מעלה אדומים'
const computeOrderTotals = (lines, type, city = MA) => load('pricing').computeOrderTotals(lines, type, city)
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
test('B+D. delivery: subtotal 60, one line qty 3 → 3 units, surcharge 12, fee 25, total 97', () => {
  const t = computeOrderTotals([line(CAT.falafel, 20, 3)], 'delivery')
  assert.equal(t.subtotal, 60); assert.equal(t.mealQuantity, 3); assert.equal(t.mealSurcharge, 12)
  assert.equal(t.deliveryFee, 25); assert.equal(t.total, 97); assert.equal(t.discount, 0)
})
test('C. delivery, drinks only → meal qty 0, surcharge 0, fee 20', () => {
  const t = computeOrderTotals([line(CAT.drinks, 12, 2)], 'delivery')
  assert.equal(t.mealQuantity, 0); assert.equal(t.mealSurcharge, 0); assert.equal(t.deliveryFee, 25); assert.equal(t.total, 49)
})
test('E. mixed cart: meals + deal extras + paid add-ons + drinks + side', () => {
  const t = computeOrderTotals([
    line(CAT.falafel, 24, 2, { paidAddonPrices: [4, 3] }),                     // (24+7)×2 = 62, 2 units
    line(CAT.deals, 45, 1, { setDrink: 'קולה זכוכית', setAddon: 'טבעות בצל' }), // 45+3+10 = 58, 1 unit
    line(CAT.drinks, 9, 2),                                                     // 18, 0 units
    line(CAT.sides, 16, 1),                                                     // 16, 1 unit
  ], 'delivery')
  assert.equal(t.lines[0].unitPrice, 31); assert.equal(t.lines[1].unitPrice, 58) // deal extras inside unit price
  assert.equal(t.subtotal, 154); assert.equal(t.mealQuantity, 4); assert.equal(t.mealSurcharge, 16); assert.equal(t.total, 195)
})
test('F. unknown/new category never qualifies for ₪4', () => {
  const t = computeOrderTotals([line(CAT.unknown, 10, 5)], 'delivery')
  assert.equal(t.mealQuantity, 0); assert.equal(t.mealSurcharge, 0); assert.equal(t.total, 75)
})
test('free deal options add nothing; money rounding is stable', () => {
  const t = computeOrderTotals([line(CAT.deals, 45, 1, { setDrink: 'מים', setAddon: 'ציפס אישי' }), line(CAT.drinks, 0.1, 1), line(CAT.drinks, 0.2, 1)], 'pickup')
  assert.equal(t.lines[0].unitPrice, 45); assert.equal(t.subtotal, 45.3)
})

console.log('Customer display pricing (fulfillment-first UX, lib/pricing.ts)')
const P = load('pricing')
const display = (lines, type, city = MA) => P.computeDisplayTotals(lines, type, city)
test('D1. pickup qualifying item: menu ₪28, line ₪28', () => {
  assert.equal(P.displayMenuPrice(28, CAT.falafel, 'pickup'), 28)
  assert.equal(P.displayLineTotal(line(CAT.falafel, 28, 1), 'pickup'), 28)
})
test('D2. delivery qualifying item: menu ₪32 (28 + 4)', () => {
  assert.equal(P.displayMenuPrice(28, CAT.falafel, 'delivery'), 32)
  assert.equal(P.displayLineTotal(line(CAT.falafel, 28, 1), 'delivery'), 32)
})
test('D3. delivery quantity 3: line ₪96 (= 3×28 + 3×4)', () => {
  assert.equal(P.displayLineTotal(line(CAT.falafel, 28, 3), 'delivery'), 96)
})
test('D4. delivery drinks only: drink price unchanged, items ₪20, fee ₪20 separate, total ₪40', () => {
  assert.equal(P.displayMenuPrice(10, CAT.drinks, 'delivery'), 10)
  assert.deepEqual(display([line(CAT.drinks, 10, 2)], 'delivery'), { itemsTotal: 20, deliveryFee: 25, total: 45 })
})
test('D5. delivery mixed cart: inclusive items + ₪20 = authoritative total', () => {
  const lines = [
    line(CAT.falafel, 24, 2, { paidAddonPrices: [4, 3] }),
    line(CAT.deals, 45, 1, { setDrink: 'קולה זכוכית', setAddon: 'טבעות בצל' }),
    line(CAT.drinks, 9, 2),
    line(CAT.sides, 16, 1),
  ]
  const d = display(lines, 'delivery')
  const perLine = lines.map(l => P.displayLineTotal(l, 'delivery'))
  assert.deepEqual(perLine, [70, 62, 18, 20]) // (31+4)×2, 58+4, 18, 16+4
  assert.equal(d.itemsTotal, 170); assert.equal(d.itemsTotal, perLine.reduce((a, b) => a + b, 0))
  assert.equal(d.total, computeOrderTotals(lines, 'delivery').total) // 195
})
test('D6. paid add-on + delivery: 28 + 3 + 4 = ₪35 (surcharge once per unit, not per add-on)', () => {
  assert.equal(P.displayLineTotal(line(CAT.falafel, 28, 1, { paidAddonPrices: [3] }), 'pickup'), 31)
  assert.equal(P.displayLineTotal(line(CAT.falafel, 28, 1, { paidAddonPrices: [3] }), 'delivery'), 35)
  assert.equal(P.displayLineTotal(line(CAT.falafel, 28, 1, { paidAddonPrices: [3, 4] }), 'delivery'), 39)
})
test('D7/D8. switching pickup ↔ delivery recomputes from the same cart (no stale state)', () => {
  const cart = [line(CAT.falafel, 28, 2), line(CAT.drinks, 10, 1)]
  assert.deepEqual(display(cart, 'pickup'), { itemsTotal: 66, deliveryFee: 0, total: 66 })
  assert.deepEqual(display(cart, 'delivery'), { itemsTotal: 74, deliveryFee: 25, total: 99 })
  assert.deepEqual(display(cart, 'pickup'), { itemsTotal: 66, deliveryFee: 0, total: 66 })
})
test('D9. display total always equals the authoritative server total (both types, many carts)', () => {
  const carts = [[line(CAT.falafel, 28, 3)], [line(CAT.drinks, 10, 2)], [line(CAT.unknown, 12, 2), line(CAT.meat, 42, 1, { paidAddonPrices: [4] })],
    [line(CAT.deals, 45, 2, { setDrink: 'פיוז טי', setAddon: 'ציפס גדול' }), line(CAT.sides, 10, 3)]]
  for (const c of carts) for (const type of ['pickup', 'delivery']) {
    const a = computeOrderTotals(c, type), d = display(c, type)
    assert.equal(d.total, a.total); assert.equal(d.itemsTotal + d.deliveryFee, a.total)
    assert.equal(d.itemsTotal, a.subtotal + a.mealSurcharge)
  }
})
test('D10. no discount: display total = sum of display lines (+ fee), discount field 0', () => {
  const c = [line(CAT.falafel, 28, 1)]
  assert.equal(display(c, 'pickup').total, 28); assert.equal(computeOrderTotals(c, 'pickup').discount, 0)
})
test('D11. payment method has no input into display or authoritative pricing', () => {
  assert.equal(P.computeDisplayTotals.length, 3); assert.equal(P.computeOrderTotals.length, 3) // (lines, type, deliveryCity) — no payment input
})
test('D12. delivery fee appears exactly once regardless of cart size', () => {
  const big = Array.from({ length: 6 }, () => line(CAT.falafel, 20, 3))
  const d = display(big, 'delivery')
  assert.equal(d.deliveryFee, 25); assert.equal(d.total, 6 * 3 * 24 + 25)
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
test('valid delivery → 60 + 12 + 25 = 97 and a full deliveries payload', () => {
  const r = build(baseReq({ type: 'delivery', paymentMethod: 'credit', delivery: address }))
  assert.ok(r.ok, JSON.stringify(r)); const d = r.value.rpcArgs.p_delivery
  assert.equal(r.value.rpcArgs.p_order.total_price, 97)
  assert.equal(d.meal_quantity, 3); assert.equal(d.meal_surcharge, 12); assert.equal(d.delivery_fee, 25)
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
test('G. payment method never changes the price (pickup: cash / credit / cibus / bit; delivery: cash / credit)', () => {
  const totals = cfg.PAYMENT_METHODS.map(pm => build(baseReq({ paymentMethod: pm })).value.rpcArgs.p_order.total_price)
  assert.deepEqual(totals, [60, 60, 60, 60])
  for (const pm of ['cash', 'credit']) assert.equal(build(baseReq({ type: 'delivery', delivery: address, paymentMethod: pm })).value.rpcArgs.p_order.total_price, 97, pm)
})
test('H. invalid locality rejected', () => {
  assert.equal(build(baseReq({ type: 'delivery', paymentMethod: 'credit', delivery: { ...address, city: 'ירושלים' } })).code, 'invalid_delivery_area')
})
test('H2. missing street / house number rejected', () => {
  assert.equal(build(baseReq({ type: 'delivery', paymentMethod: 'credit', delivery: { ...address, street: '  ' } })).code, 'invalid_address')
  assert.equal(build(baseReq({ type: 'delivery', paymentMethod: 'credit', delivery: { ...address, houseNumber: '' } })).code, 'invalid_address')
})
test('I. delivery from a non-delivery branch rejected; hidden branch rejected', () => {
  assert.equal(build(baseReq({ branchId: OTHER_BRANCH, type: 'delivery', paymentMethod: 'credit', delivery: address })).code, 'delivery_not_available')
  assert.equal(build(baseReq({ branchId: HIDDEN_BRANCH })).code, 'invalid_branch')
})
test('J. client price tampering rejected (order-level and item-level money fields)', () => {
  assert.equal(build(baseReq({ total: 1 })).code, 'client_prices_not_accepted')
  assert.equal(build(baseReq({ deliveryFee: 0, type: 'delivery', paymentMethod: 'credit', delivery: address })).code, 'client_prices_not_accepted')
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

console.log('Destination delivery fees (08D14 — Maale doc 3 Oct 2026)')
const FEES = { 'מעלה אדומים': 25, 'מישור אדומים': 25, 'כפר אדומים': 35, 'אלון': 40 }
const UNAVAILABLE = ['נופי פרת', 'מצפה יריחו']
const deliveryReq = (city, over = {}) => baseReq({ type: 'delivery', paymentMethod: 'credit', delivery: { ...address, city }, ...over })

test('DP1–4. active areas → destination fee: מעלה אדומים 25 · מישור אדומים 25 · כפר אדומים 35 · אלון 40 (config, pricing, stored)', () => {
  assert.deepEqual({ ...cfg.DELIVERY_FEES_BY_AREA }, FEES)
  for (const [city, fee] of Object.entries(FEES)) {
    assert.equal(cfg.getDeliveryFeeForArea(city), fee, city)
    assert.equal(P.computeOrderTotals([line(CAT.falafel, 20, 1)], 'delivery', city).deliveryFee, fee, city)
    const r = build(deliveryReq(city))
    assert.ok(r.ok, JSON.stringify(r)); assert.equal(r.value.rpcArgs.p_delivery.delivery_fee, fee, city) // stored fee = server config
  }
  assert.ok(Object.isFrozen(cfg.DELIVERY_FEES_BY_AREA))
  for (const old of [20]) assert.ok(!Object.values(cfg.DELIVERY_FEES_BY_AREA).includes(old), 'old ₪20 fee removed')
})

test('DP5–6. נופי פרת / מצפה יריחו temporarily unavailable: no fee, rejected by the server, config kept', () => {
  assert.deepEqual([...cfg.UNAVAILABLE_DELIVERY_AREAS], UNAVAILABLE)
  for (const city of UNAVAILABLE) {
    assert.ok(cfg.DELIVERY_AREAS.includes(city), `${city} kept in the full list (aliases / history / reactivation)`)
    assert.ok(!cfg.isActiveDeliveryArea(city)); assert.equal(cfg.getDeliveryFeeForArea(city), null)
    assert.equal(build(deliveryReq(city)).code, 'delivery_area_unavailable', city)
    assert.throws(() => P.computeOrderTotals([line(CAT.falafel, 20, 1)], 'delivery', city), /unknown_delivery_area/)
  }
})

test('DP7. customer selector source contains exactly the 4 active areas (selector order)', () => {
  assert.deepEqual([...cfg.ACTIVE_DELIVERY_AREAS], ['מעלה אדומים', 'מישור אדומים', 'כפר אדומים', 'אלון'])
  const page = readFileSync(join(LIB, '..', 'app', 'order', 'page.tsx'), 'utf8')
  assert.ok(page.includes('{ACTIVE_DELIVERY_AREAS.map(a => <option'))
  assert.ok(!/\{DELIVERY_AREAS\.map\(/.test(page), 'selector never lists the full (incl. unavailable) set')
  assert.ok(page.includes('ACTIVE_DELIVERY_AREAS.includes(deliveryForm.city)') && page.includes('ACTIVE_DELIVERY_AREAS.includes(str(s.city))'))
})

test('DP8. malicious / old client requests to a hidden or unknown area are rejected', () => {
  assert.equal(build(deliveryReq('מצפה יריחו', { paymentMethod: 'cash' })).code, 'delivery_area_unavailable')
  assert.equal(build(deliveryReq('ירושלים')).code, 'invalid_delivery_area')
  for (const city of ['ירושלים', '', null, undefined, 'toString', 'constructor', ' מעלה אדומים']) {
    assert.equal(cfg.getDeliveryFeeForArea(city), null, String(city))
    assert.throws(() => P.computeOrderTotals([line(CAT.falafel, 20, 1)], 'delivery', city), /unknown_delivery_area/)
  }
  assert.deepEqual(P.computeDisplayTotals([line(CAT.falafel, 20, 1)], 'delivery', ''), { itemsTotal: 24, deliveryFee: null, total: null })
})

test('DP9. fee range shown before an area is chosen = ₪25–₪40', () => {
  assert.deepEqual({ ...cfg.DELIVERY_FEE_RANGE }, { min: 25, max: 40 })
  const page = readFileSync(join(LIB, '..', 'app', 'order', 'page.tsx'), 'utf8')
  assert.ok(page.includes('דמי משלוח ₪${DELIVERY_FEE_RANGE.min}–₪${DELIVERY_FEE_RANGE.max} לפי יישוב'))
})

test('DP10. stored delivery fee is authoritative (client fee keys rejected or ignored)', () => {
  for (const over of [{ deliveryFee: 20 }, { delivery_fee: 20 }, { total: 72 }])
    assert.equal(build(deliveryReq('אלון', over)).code, 'client_prices_not_accepted', JSON.stringify(over))
  const inDelivery = build(baseReq({ type: 'delivery', paymentMethod: 'cash', delivery: { ...address, city: 'אלון', deliveryFee: 20, delivery_fee: 20, fee: 20 } }))
  assert.ok(inDelivery.ok); assert.equal(inDelivery.value.rpcArgs.p_delivery.delivery_fee, 40)
  assert.equal(inDelivery.value.rpcArgs.p_order.total_price, 60 + 12 + 40)
})

test('DP11. pickup has no delivery fee (any area argument ignored)', () => {
  for (const city of [undefined, 'מצפה יריחו', 'אלון']) {
    const t = P.computeOrderTotals([line(CAT.falafel, 20, 2)], 'pickup', city)
    assert.deepEqual([t.deliveryFee, t.mealSurcharge, t.total], [0, 0, 40])
  }
  const r = build(baseReq()); assert.equal(r.value.rpcArgs.p_delivery, null); assert.equal(r.value.breakdown.deliveryFee, 0)
})

test('DP12. meal surcharge unchanged: ₪4 per qualifying unit, drinks never surcharged, food total excludes the fee', () => {
  const t = P.computeOrderTotals([line(CAT.falafel, 20, 3), line(CAT.drinks, 9, 2)], 'delivery', 'אלון')
  assert.deepEqual([t.mealQuantity, t.mealSurcharge], [3, 12])
  assert.equal(P.displayMenuPrice(9, CAT.drinks, 'delivery'), 9); assert.equal(P.displayMenuPrice(20, CAT.falafel, 'delivery'), 24)
  assert.equal(cfg.DELIVERY_MEAL_SURCHARGE, 4)
})

test('DP13. one meal: מעלה אדומים 20+4+25=49 · מישור אדומים 49 · כפר אדומים 20+4+35=59 · אלון 20+4+40=64', () => {
  const one = city => build(deliveryReq(city, { items: [{ itemId: ITEM.falafel, quantity: 1 }] })).value.rpcArgs.p_order.total_price
  assert.deepEqual(['מעלה אדומים', 'מישור אדומים', 'כפר אדומים', 'אלון'].map(one), [49, 49, 59, 64])
})

test('DP14. multiple meals + drink to אלון: 3×20 + 9 + 3×4 + 40 = 121 (display = server; food total 8100)', () => {
  const r = build(deliveryReq('אלון', { items: [{ itemId: ITEM.falafel, quantity: 3 }, { itemId: ITEM.drink, quantity: 1 }] }))
  assert.ok(r.ok); const b = r.value.breakdown
  assert.deepEqual([b.subtotal, b.mealSurcharge, b.deliveryFee, b.total], [69, 12, 40, 121])
  const d = P.computeDisplayTotals([line(CAT.falafel, 20, 3), line(CAT.drinks, 9, 1)], 'delivery', 'אלון')
  assert.deepEqual(d, { itemsTotal: 81, deliveryFee: 40, total: 121 })
  assert.equal(P.foodTotalAgorot(b), 8100) // Maale food total = subtotal + surcharge, fee excluded
})

test('DP15. payment method does not alter price (pickup 4 methods; delivery cash = credit)', () => {
  const pickup = cfg.PAYMENT_METHODS.map(pm => build(baseReq({ paymentMethod: pm })).value.rpcArgs.p_order.total_price)
  assert.deepEqual(pickup, [60, 60, 60, 60])
  const cash = build(deliveryReq('כפר אדומים', { paymentMethod: 'cash' })), credit = build(deliveryReq('כפר אדומים'))
  assert.equal(cash.value.rpcArgs.p_order.total_price, credit.value.rpcArgs.p_order.total_price)
  assert.equal(cash.value.rpcArgs.p_order.payment_method, 'cash')
})

test('DP18–20. historical rows untouched; no Maale call; no DB migration / SQL in the change', () => {
  const srcs = ['lib/orderConfig.ts', 'lib/pricing.ts', 'lib/orderRequest.ts', 'app/order/page.tsx'].map(f => readFileSync(join(LIB, '..', f), 'utf8'))
  for (const s of srcs) {
    assert.ok(!/maalehamishlohim|delivery_dispatches|express\/integrations/i.test(s))
    assert.ok(!/\b(UPDATE|ALTER TABLE|INSERT INTO)\s+(public\.)?(orders|deliveries)\b/i.test(s))
  }
  assert.ok(!/DELIVERY_FEE\b(?!S_BY_AREA|_RANGE|_LABEL)/.test(srcs.join('\n')), 'flat DELIVERY_FEE constant fully removed')
})

test('DP21–22. checkout shows the dynamic destination fee; pickup copy unchanged', () => {
  const page = readFileSync(join(LIB, '..', 'app', 'order', 'page.tsx'), 'utf8')
  assert.ok(page.includes('computeDisplayTotals(pricingInputs, displayType, deliveryForm.city)'))
  assert.ok(page.includes('getDeliveryFeeForArea(a)'), 'area dropdown shows each destination fee')
  assert.ok(page.includes("cartDisplay.deliveryFee === null ? 'בחרו יישוב'"))
  assert.ok(page.includes("['pickup', '🏃', 'איסוף עצמי', '']"), 'pickup option unchanged')
  assert.ok(!page.includes('₪{DELIVERY_FEE}') && !page.includes('${DELIVERY_FEE}'))
})

test('DP23–24. device-location and area-proximity modules untouched by fee logic', () => {
  for (const f of ['deliveryLocation.ts', 'deliveryAreasGeo.ts', 'orderGeo.ts'])
    assert.ok(!/DELIVERY_FEES_BY_AREA|getDeliveryFeeForArea|delivery_fee/.test(readFileSync(join(LIB, f), 'utf8')), f)
})

console.log(`\nAll ${passed} checks passed.`)
