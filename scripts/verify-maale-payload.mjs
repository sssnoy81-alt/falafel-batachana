// Local checks for the Maale Express payload contract (FALAFEL-SN-08D9). FAKE data only; no network, no DB, no key.
// Run: node scripts/verify-maale-payload.mjs

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
const M = load('maalePayload')
let passed = 0
const test = (name, fn) => { fn(); passed++; console.log('  ✓', name) }

/* ─── FAKE fixture: subtotal 49 (1 meal 40 + drink 9), +₪4 surcharge, ₪20 fee → total 73 → food 5300 agorot ─── */
const ORDER_ID = '11111111-2222-4333-8444-555555555555'
const base = () => ({
  order: {
    id: ORDER_ID, type: 'delivery', branch_id: cfg.DELIVERY_BRANCH_IDS[0], payment_method: 'credit',
    customer_name: 'לקוח בדיקה', phone: '050-000-0000', total_price: 73,
  },
  delivery: {
    city: 'מעלה אדומים', street: 'הגעש', house_number: '6', apartment: '6', floor: '2', entrance: 'ב׳', notes: 'קוד 1234',
    delivery_fee: 20, meal_surcharge: 4, delivery_lat: 31.773612, delivery_lng: 35.298346, geo_source: 'geocoder', geo_precision: 'street',
  },
  items: [{ name: 'פלאפל בפיתה', quantity: 1, unit_price: 40 }, { name: 'קוקה קולה', quantity: 1, unit_price: 9 }],
})
const withOrder = over => { const s = base(); Object.assign(s.order, over); return s }
const withDelivery = over => { const s = base(); Object.assign(s.delivery, over); return s }
const errorsOf = s => { const r = M.buildMaaleOrderPayload(s); assert.equal(r.ok, false, 'expected fail-closed'); return r.errors }

console.log('Maale Express payload contract (fake data)')

test('1. valid credit delivery → exact payload', () => {
  const r = M.buildMaaleOrderPayload(base())
  assert.ok(r.ok, JSON.stringify(r))
  assert.deepEqual(r.payload, {
    external_order_id: ORDER_ID, payment_method: 'credit', food_total_agorot: 5300,
    items: [{ name: 'פלאפל בפיתה', quantity: 1 }, { name: 'קוקה קולה', quantity: 1 }],
    customer_name: 'לקוח בדיקה', customer_phone: '0500000000', customer_address: 'הגעש 6, מעלה אדומים',
    lat: 31.773612, lng: 35.298346, drop_description: 'כניסה ב׳, קומה 2, דירה 6, קוד 1234',
  })
})

test('2–3. food_total excludes the delivery fee and includes the internal +₪4 (49 + 4 = 53 → 5300)', () => {
  const p = M.buildMaaleOrderPayload(base()).payload
  assert.equal(p.food_total_agorot, (73 - 20) * 100); assert.equal(p.food_total_agorot, (49 + 4) * 100)
  const far = withOrder({ total_price: 93 }); far.delivery.delivery_fee = 40 // ₪40 area: food total unchanged
  assert.equal(M.buildMaaleOrderPayload(far).payload.food_total_agorot, 5300)
})

test('4. wrong total cross-check fails closed (total − fee ≠ items + surcharge)', () => {
  assert.ok(errorsOf(withOrder({ total_price: 74 })).includes('food_total_mismatch'))
  assert.ok(errorsOf(withDelivery({ meal_surcharge: 0 })).includes('food_total_mismatch'))
  assert.ok(errorsOf(withDelivery({ delivery_fee: 80 })).includes('invalid_food_total'))
  for (const bad of [{ total_price: null }, { total_price: 'abc' }, { total_price: -1 }]) assert.ok(errorsOf(withOrder(bad)).includes('invalid_amounts'))
})

test('5–6. missing / invalid lat or lng fails', () => {
  for (const v of [null, '', 'x', 40, 28.5]) assert.ok(errorsOf(withDelivery({ delivery_lat: v })).includes('invalid_lat'), String(v))
  for (const v of [null, 'x', 33.9, 36.5]) assert.ok(errorsOf(withDelivery({ delivery_lng: v })).includes('invalid_lng'), String(v))
})

test('7 + 25. locality-only / unresolved / legacy geo fails', () => {
  assert.ok(errorsOf(withDelivery({ geo_precision: 'locality' })).includes('coordinates_not_precise'))
  assert.ok(errorsOf(withDelivery({ geo_source: 'none', geo_precision: 'unresolved', delivery_lat: null, delivery_lng: null })).includes('coordinates_not_precise'))
  assert.ok(errorsOf(withDelivery({ geo_source: null, geo_precision: null })).includes('coordinates_not_precise'))
})

test('8–9. missing street / missing house number fails', () => {
  assert.ok(errorsOf(withDelivery({ street: '  ' })).includes('missing_street'))
  assert.ok(errorsOf(withDelivery({ house_number: null })).includes('missing_house_number'))
  assert.ok(errorsOf(withDelivery({ city: 'ירושלים' })).includes('invalid_city'))
  assert.ok(errorsOf({ ...base(), delivery: null }).includes('missing_delivery'))
})

test('10–11. empty items / non-positive or non-integer quantity fails', () => {
  assert.ok(errorsOf({ ...base(), items: [] }).includes('empty_items'))
  for (const q of [0, -1, 1.5, null, 'x']) {
    const s = base(); s.items[0].quantity = q
    assert.ok(errorsOf(s).includes('invalid_item_quantity'), String(q))
  }
})

test('12. item names come only from server data (snapshot rows); missing name fails', () => {
  const s = base(); s.items[0].name = null
  assert.ok(errorsOf(s).includes('invalid_item_name'))
  const row = {
    id: ORDER_ID, type: 'delivery', branch_id: cfg.DELIVERY_BRANCH_IDS[0], payment_method: 'credit', customer_name: 'לקוח בדיקה',
    phone: '0500000000', total_price: '73.00', notes: 'IGNORED', browser_items: [{ name: 'INJECTED' }],
    deliveries: [{ city: 'מעלה אדומים', street: 'הגעש', house_number: '6', apartment: null, floor: null, entrance: null, notes: null,
      delivery_fee: '20.00', meal_surcharge: '4.00', delivery_lat: '31.773612', delivery_lng: '35.298346', geo_source: 'geocoder', geo_precision: 'street' }],
    order_items: [{ quantity: 1, unit_price: '40.00', menu_items: { name_he: 'פלאפל בפיתה' } }, { quantity: 1, unit_price: '9.00', menu_items: [{ name_he: 'קוקה קולה' }] }],
  }
  const snap = M.snapshotFromOrderRow(row)
  const r = M.buildMaaleOrderPayload(snap)
  assert.ok(r.ok, JSON.stringify(r)); assert.deepEqual(r.payload.items.map(i => i.name), ['פלאפל בפיתה', 'קוקה קולה'])
  assert.ok(!JSON.stringify(r.payload).includes('INJECTED')); assert.equal(r.payload.food_total_agorot, 5300)
  assert.equal(r.payload.drop_description, undefined)
  assert.ok(M.MAALE_ORDER_SELECT.includes('menu_items(name_he)'))
})

test('13–14. external_order_id === orders.id, identical on every retry (deterministic builder)', () => {
  const a = M.buildMaaleOrderPayload(base()).payload, b = M.buildMaaleOrderPayload(base()).payload
  assert.equal(a.external_order_id, ORDER_ID); assert.deepEqual(a, b)
  assert.ok(errorsOf(withOrder({ id: 'not-a-uuid' })).includes('invalid_order_id'))
})

test('15–16. drop_description combines fields cleanly; no empty fragments or stray commas', () => {
  assert.equal(M.buildDropDescription({ entrance: 'ב׳', floor: '2', apartment: '6', notes: 'קוד 1234' }), 'כניסה ב׳, קומה 2, דירה 6, קוד 1234')
  assert.equal(M.buildDropDescription({ entrance: '', floor: '  ', apartment: '6', notes: null }), 'דירה 6')
  assert.equal(M.buildDropDescription({ entrance: null, floor: null, apartment: null, notes: '  להתקשר   בהגעה ' }), 'להתקשר בהגעה')
  assert.equal(M.buildDropDescription({ entrance: null, floor: null, apartment: null, notes: '' }), undefined)
  const p = M.buildMaaleOrderPayload(withDelivery({ entrance: null, floor: null, apartment: null, notes: null })).payload
  assert.ok(!('drop_description' in p))
  for (const d of [{ entrance: 'א', floor: null, apartment: '', notes: ' ' }, { entrance: null, floor: '3', apartment: null, notes: 'x' }]) {
    const s = M.buildDropDescription(d)
    assert.ok(!/^,|,\s*,|,\s*$/.test(s) && !s.includes('  '), s)
  }
})

test('17–19 + contract. no delivery_fee / delivery_area / price / API key / extra fields in the payload', () => {
  const p = M.buildMaaleOrderPayload(base()).payload
  assert.deepEqual(Object.keys(p).sort(), [...M.MAALE_PAYLOAD_KEYS].sort())
  const json = JSON.stringify(p)
  for (const k of ['delivery_fee', 'delivery_area', 'delivery_price', 'meal_surcharge', 'api_key', 'X-Api-Key', 'no_house_number', 'prep_minutes', 'total_price'])
    assert.ok(!json.includes(k), k)
  const src = readFileSync(join(LIB, 'maalePayload.ts'), 'utf8').replace(/\/\/.*$/gm, '')
  assert.ok(!/process\.env|fetch\(|X-Api-Key|MAALE_EXPRESS_KEY|console\./.test(src), 'no env / network / key / logging in the builder')
})

test('20–22. pickup, wrong branch and non-credit delivery rejected', () => {
  assert.ok(errorsOf(withOrder({ type: 'pickup' })).includes('not_delivery'))
  assert.ok(errorsOf(withOrder({ branch_id: '3ab15ad1-e835-492b-bae5-11b202ee2314' })).includes('wrong_branch'))
  for (const pm of ['cash', 'cibus', 'bit', null]) assert.ok(errorsOf(withOrder({ payment_method: pm })).includes('payment_method_not_allowed'), String(pm))
})

test('23–24. verified Google (geocoder/street) and trusted GPS (manual/street) coordinates accepted', () => {
  assert.ok(M.buildMaaleOrderPayload(base()).ok)
  const gps = M.buildMaaleOrderPayload(withDelivery({ geo_source: 'manual', geo_precision: 'street', delivery_lat: 31.7801, delivery_lng: 35.3102 }))
  assert.ok(gps.ok); assert.deepEqual([gps.payload.lat, gps.payload.lng], [31.7801, 35.3102])
  assert.equal(gps.payload.customer_address, 'הגעש 6, מעלה אדומים', 'GPS never changes the textual address')
})

test('customer fields: name / phone validated with the existing order rules', () => {
  assert.ok(errorsOf(withOrder({ customer_name: 'א' })).includes('invalid_customer_name'))
  assert.ok(errorsOf(withOrder({ phone: '0212345678' })).includes('invalid_phone'))
  assert.ok(errorsOf(withOrder({ phone: null })).includes('invalid_phone'))
})

test('no Maale call / dispatch / key anywhere in the app yet', () => {
  for (const f of ['app/api/orders/route.ts', 'lib/orderGeo.ts', 'lib/orderAddress.ts', 'lib/maalePayload.ts']) {
    const s = readFileSync(join(ROOT, f), 'utf8')
    assert.ok(!/buildMaaleOrderPayload\(|MAALE_EXPRESS_KEY|delivery_dispatches/.test(f === 'lib/maalePayload.ts' ? '' : s), f)
    assert.ok(!/fetch\(\s*MAALE_ORDERS_URL/.test(s), `${f}: no request to Maale`)
  }
})

console.log(`\nAll ${passed} maale-payload checks passed.`)
console.log('\nDry-run example (FAKE data):')
console.log(JSON.stringify(M.buildMaaleOrderPayload(base()).payload, null, 2))
