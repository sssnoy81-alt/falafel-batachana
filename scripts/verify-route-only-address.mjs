// Local checks for the route-only Google address fallback (FALAFEL-SN-08D14D). No network, no key, no Maale call.
// Google returns a route-only place (street known, no street_number) → customer house number (strict) +
// trusted device GPS are required; the route centre is never stored, never street precision, never dispatched.
// Run: node scripts/verify-route-only-address.mjs

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
const src = f => readFileSync(join(ROOT, f), 'utf8')

// Any real network call during these checks is a failure (Google and Maale are always mocked).
let networkCalls = 0
globalThis.fetch = async () => { networkCalls++; throw new Error('network not allowed in tests') }

const gp = load('googlePlaces')
const hn = load('houseNumber')
const sel = load('deliveryAddressSelection')
const cfg = load('orderConfig')
const { parseCreateOrderRequest, buildOrderFromCatalog } = load('orderRequest')
const { attachDeliveryGeo } = load('orderGeo')
const { resolveGoogleDeliveryAddress } = load('orderAddress')
const { buildMaaleOrderPayload } = load('maalePayload')

let passed = 0
const test = async (name, fn) => { await fn(); passed++; console.log('  ✓', name) }

const MA = 'מעלה אדומים', ALON = 'אלון'
const BRANCH = cfg.DELIVERY_BRANCH_IDS[0]
const ITEM = 'aaaaaaaa-0000-4000-8000-000000000001'
const ORDER_ID = 'bbbbbbbb-0000-4000-8000-000000000001'
const catalog = {
  items: new Map([[ITEM, { id: ITEM, category_id: '02e0f987-6cce-4a1d-85c6-5ff6f97c80a4', is_active: true }]]),
  prices: new Map([[ITEM, { item_id: ITEM, price: 20, is_available: true }]]),
  toppings: new Map(),
}
// Distinctive route-centre coordinates: must never appear in anything stored or dispatched.
const ROUTE_CENTRE = { lat: 31.7111111, lng: 35.2999999 }
const GPS = { location_lat: 31.7801234, location_lng: 35.3102345, location_accuracy: 12, location_confirmed: true }

// Shapes produced by lib/googlePlaces.mapPlaceDetails (matches the real Google responses seen in 08D14C).
const fullPlace = (over = {}) => ({ placeId: 'PLACE_FULL', formattedAddress: `רחוב הגעש 6, ${MA}`, lat: 31.7736123, lng: 35.2983456,
  street: 'רחוב הגעש', houseNumber: '6', locality: MA, types: ['street_address'], cityMatchesSelectedArea: true, ...over })
const routePlace = (over = {}) => ({ placeId: 'PLACE_ROUTE', formattedAddress: `רחוב הגעש, ${MA}`, lat: ROUTE_CENTRE.lat, lng: ROUTE_CENTRE.lng,
  street: 'רחוב הגעש', houseNumber: null, locality: MA, types: ['route'], cityMatchesSelectedArea: true, ...over })

const orderBody = (city, delivery = {}, extra = {}) => ({
  branchId: BRANCH, type: 'delivery', customerName: 'בדיקה בדיקה', phone: '0501234567', paymentMethod: 'credit',
  items: [{ itemId: ITEM, quantity: 3 }],
  delivery: { city, street: 'רחוב הגעש', houseNumber: '3', ...delivery }, ...extra,
})

/** parse → server Google verification → build → geo (fake Mapbox counts calls) → captured create_order args. */
async function submit(body, lookup) {
  const calls = { lookup: 0, geocode: 0, logs: [] }
  const parsed = parseCreateOrderRequest(body)
  if (!parsed.ok) return { parsed, calls }
  const resolved = await resolveGoogleDeliveryAddress(parsed.value, {
    lookup: async (...a) => { calls.lookup++; return lookup(...a) }, log: c => calls.logs.push(c), timeoutMs: 50,
  })
  if (!resolved.ok) return { resolved, calls }
  const built = buildOrderFromCatalog(resolved.order, catalog)
  assert.ok(built.ok, JSON.stringify(built))
  const withGeo = await attachDeliveryGeo(resolved.order, built.value, {
    geocode: async () => { calls.geocode++; return { ok: true, lat: 31.7, lng: 35.3, precision: 'street', source: 'geocoder' } },
    log: c => calls.logs.push(c),
  })
  return { created: true, order: resolved.order, rpcArgs: JSON.parse(JSON.stringify(withGeo.rpcArgs)), calls }
}
const geo = d => [d.delivery_lat, d.delivery_lng, d.geo_source, d.geo_precision]
const rejected = r => (r.resolved ? { code: r.resolved.code, detail: r.resolved.detail } : { code: r.parsed.code, detail: r.parsed.detail })

/** DB snapshot as the dispatcher would read it back (deliveries row + order + item names from the DB). */
const snapshotOf = (rpc) => ({
  order: { id: ORDER_ID, type: rpc.p_order.type, branch_id: rpc.p_order.branch_id, payment_method: rpc.p_order.payment_method,
    customer_name: rpc.p_order.customer_name, phone: rpc.p_order.phone, total_price: rpc.p_order.total_price },
  delivery: { ...rpc.p_delivery },
  items: rpc.p_items.map(i => ({ name: 'פלאפל בפיתה', quantity: i.quantity, unit_price: i.unit_price })),
})

const routeSelection = (query = 'הגעש 3') => sel.withSelection({ city: MA, query, selected: null, manualHouseNumber: '' },
  { kind: 'route', placeId: 'PLACE_ROUTE', city: MA, street: 'רחוב הגעש', houseNumber: '', formattedAddress: `רחוב הגעש, ${MA}` })

console.log('Route-only Google address fallback (08D14D)')

await test('1. full Google street_address unchanged (classify === verifyDeliveryPlace; Google street/number/coords)', async () => {
  const v = gp.verifyDeliveryPlace(fullPlace(), MA)
  assert.deepEqual(gp.classifyDeliveryPlace(fullPlace(), MA), { ok: true, kind: 'address', value: v.value })
  const r = await submit(orderBody(MA, { google_place_id: 'PLACE_FULL', street: 'מוקלד', houseNumber: '99' }), async () => fullPlace())
  const d = r.rpcArgs.p_delivery
  assert.deepEqual([d.street, d.house_number, d.city], ['רחוב הגעש', '6', MA])
  assert.deepEqual(geo(d), [31.773612, 35.298346, 'geocoder', 'street'])
})

await test('2. route-only Google place identified correctly (and only a real route)', async () => {
  const c = gp.classifyDeliveryPlace(routePlace(), MA)
  assert.deepEqual(c, { ok: true, kind: 'route', value: { placeId: 'PLACE_ROUTE', city: MA, street: 'רחוב הגעש', formattedAddress: `רחוב הגעש, ${MA}`, types: ['route'] } })
  assert.ok(!('lat' in c.value) && !('lng' in c.value), 'a route classification carries no coordinates')
  assert.deepEqual(gp.verifyDeliveryPlace(routePlace(), MA), { ok: false, reason: 'missing_house_number' }, 'strict full-address rule unchanged')
  // not a route type → still missing_house_number; no street → missing_street; too long street → invalid_address
  assert.deepEqual(gp.classifyDeliveryPlace(routePlace({ types: ['establishment', 'point_of_interest'] }), MA), { ok: false, reason: 'missing_house_number' })
  assert.deepEqual(gp.classifyDeliveryPlace(routePlace({ street: null, types: ['locality', 'political'] }), MA), { ok: false, reason: 'missing_street' })
  assert.deepEqual(gp.classifyDeliveryPlace(routePlace({ street: 'א'.repeat(121) }), MA), { ok: false, reason: 'invalid_address' })
  const s = routeSelection()
  assert.equal(s.selected.kind, 'route'); assert.equal(s.query, 'רחוב הגעש'); assert.equal(s.manualHouseNumber, '3', 'typed number is a prefill')
  assert.equal(sel.selectionLabel(s.selected), `רחוב הגעש, ${MA}`)
})

await test('3. route-only without a manual house number rejected (client and server)', async () => {
  const s = { ...routeSelection(), manualHouseNumber: '' }
  assert.ok(!sel.isAddressSelectionValid(s)); assert.equal(sel.selectionHouseNumber(s), '')
  assert.equal(rejected(await submit(orderBody(MA, { google_place_id: 'PLACE_ROUTE', houseNumber: '', ...GPS }), async () => routePlace())).code, 'invalid_address')
  assert.equal(rejected(await submit(orderBody(MA, { google_place_id: 'PLACE_ROUTE', houseNumber: '   ', ...GPS }), async () => routePlace())).code, 'invalid_address')
})

await test('4. route-only invalid house number rejected (exact rule)', async () => {
  for (const bad of ['0', '00', '03', 'abc', 'שלוש', '3-5', '3/5', '12אב', '12a', '12!', '#3', '12345', '1'.repeat(21), '3  א', ' ', null, 3])
    assert.equal(hn.normalizeManualHouseNumber(bad), null, String(bad))
  for (const [ok, norm] of [['3', '3'], ['12', '12'], ['12א', '12א'], [' 12 א ', '12א'], ['9999', '9999'], ['7ב', '7ב']])
    assert.equal(hn.normalizeManualHouseNumber(ok), norm, ok)
  for (const bad of ['abc', '3-5', '0'])
    assert.deepEqual(rejected(await submit(orderBody(MA, { google_place_id: 'PLACE_ROUTE', houseNumber: bad, ...GPS }), async () => routePlace())),
      { code: 'address_not_verified', detail: 'invalid_house_number' }, bad)
  assert.ok(!sel.isAddressSelectionValid({ ...routeSelection(), manualHouseNumber: '3-5' }))
})

await test('5. route-only valid house number accepted as textual address', async () => {
  const s = { ...routeSelection(), manualHouseNumber: ' 12 א ' }
  assert.ok(sel.isAddressSelectionValid(s)); assert.equal(sel.selectionHouseNumber(s), '12א')
  const r = await submit(orderBody(MA, { google_place_id: 'PLACE_ROUTE', houseNumber: '12 א', ...GPS }), async () => routePlace())
  const d = r.rpcArgs.p_delivery
  assert.deepEqual([d.street, d.house_number, d.city], ['רחוב הגעש', '12א', MA])
  assert.ok(d.address.startsWith(`${MA}, רחוב הגעש 12א`), d.address)
})

await test('6. route-only without GPS still blocks the order (UI gate + server rejection)', async () => {
  const s = routeSelection()
  assert.ok(sel.isAddressSelectionValid(s), 'textual address complete')
  assert.ok(sel.requiresPreciseLocation(s)); assert.equal(sel.isDeliveryAddressReady(s, false), false)
  const r = await submit(orderBody(MA, { google_place_id: 'PLACE_ROUTE' }), async () => routePlace())
  assert.deepEqual(rejected(r), { code: 'address_not_verified', detail: 'precise_location_required' })
  assert.equal(r.calls.geocode, 0)
  const poor = await submit(orderBody(MA, { google_place_id: 'PLACE_ROUTE', ...GPS, location_accuracy: 150 }), async () => routePlace())
  assert.deepEqual(rejected(poor), { code: 'address_not_verified', detail: 'precise_location_required' }, 'GPS > 100 m is not trusted')
  const page = src('app/order/page.tsx')
  assert.ok(page.includes('isDeliveryAddressReady({ ...addressPicker, city: deliveryForm.city }, deviceLocation !== null)'), 'button gated on trusted GPS')
})

await test('7. route-only with trusted GPS allows the order (manual / street with device coordinates)', async () => {
  assert.equal(sel.isDeliveryAddressReady(routeSelection(), true), true)
  const r = await submit(orderBody(MA, { google_place_id: 'PLACE_ROUTE', ...GPS }), async () => routePlace())
  assert.ok(r.created); assert.equal(r.order.googleAddress.status, 'route_only')
  assert.deepEqual(geo(r.rpcArgs.p_delivery), [31.780123, 35.310235, 'manual', 'street'])
  assert.deepEqual([r.calls.lookup, r.calls.geocode], [1, 0], 'no Mapbox after a Google route selection')
})

await test('8. route centre coordinates are never persisted (nor as street precision)', async () => {
  const r = await submit(orderBody(MA, { google_place_id: 'PLACE_ROUTE', ...GPS }), async () => routePlace())
  const stored = JSON.stringify(r.rpcArgs) + JSON.stringify(r.order)
  for (const n of ['31.711111', '35.3', '35.299999', '31.7111111', '35.2999999']) assert.ok(!stored.includes(`:${n},`) && !stored.includes(`:${n}}`), n)
  // defensive geo step: a route_only order that somehow lacks trusted GPS → unresolved, never route centre / Mapbox
  const parsed = parseCreateOrderRequest(orderBody(MA, { google_place_id: 'PLACE_ROUTE' }))
  const order = { ...parsed.value, googleAddress: { status: 'route_only' } }
  let geocodeCalls = 0
  const built = buildOrderFromCatalog(order, catalog)
  const g = await attachDeliveryGeo(order, built.value, { geocode: async () => { geocodeCalls++; return { ok: true, lat: 1, lng: 1, precision: 'street', source: 'geocoder' } }, log: () => {} })
  assert.deepEqual(geo(g.rpcArgs.p_delivery), [null, null, 'none', 'unresolved']); assert.equal(geocodeCalls, 0)
  const withPoorGps = { ...order, deliveryLocation: { lat: 31.78, lng: 35.31, accuracy: 400 } }
  const g2 = await attachDeliveryGeo(withPoorGps, built.value, { geocode: async () => { geocodeCalls++; return null }, log: () => {} })
  assert.deepEqual(geo(g2.rpcArgs.p_delivery), [null, null, 'none', 'unresolved']); assert.equal(geocodeCalls, 0)
})

await test('9. route centre coordinates are never used in a Maale payload', async () => {
  // A deliveries row holding route-centre coords without a precise source fails closed.
  const r = await submit(orderBody(MA, { google_place_id: 'PLACE_ROUTE', ...GPS }), async () => routePlace())
  const snap = snapshotOf(r.rpcArgs)
  for (const [src, prec] of [['none', 'unresolved'], ['geocoder', 'locality'], ['manual', 'locality']]) {
    const bad = { ...snap, delivery: { ...snap.delivery, delivery_lat: ROUTE_CENTRE.lat, delivery_lng: ROUTE_CENTRE.lng, geo_source: src, geo_precision: prec } }
    const p = buildMaaleOrderPayload(bad)
    assert.equal(p.ok, false); assert.ok(p.errors.includes('coordinates_not_precise'), `${src}/${prec}`)
  }
  const ok = buildMaaleOrderPayload(snap)
  assert.ok(ok.ok, JSON.stringify(ok)); assert.notEqual(ok.payload.lat, ROUTE_CENTRE.lat); assert.notEqual(ok.payload.lng, ROUTE_CENTRE.lng)
})

await test('10. city mismatch still rejected (route-only and full)', async () => {
  assert.deepEqual(gp.classifyDeliveryPlace(routePlace({ locality: 'ירושלים' }), MA), { ok: false, reason: 'city_mismatch' })
  for (const place of [routePlace({ locality: 'ירושלים' }), fullPlace({ locality: 'ירושלים' })])
    assert.deepEqual(rejected(await submit(orderBody(MA, { google_place_id: 'P', ...GPS }), async () => place)), { code: 'address_not_verified', detail: 'city_mismatch' })
  assert.deepEqual(rejected(await submit(orderBody(ALON, { google_place_id: 'P', ...GPS }), async () => routePlace())),
    { code: 'address_not_verified', detail: 'city_mismatch' }, "a Ma'ale Adumim street cannot be ordered as אלון")
})

await test('11. editing the route text invalidates the selection and the manual house number', async () => {
  const s = { ...routeSelection(), manualHouseNumber: '3' }
  assert.equal(sel.withQuery(s, 'רחוב הגעש'), s, 'unchanged text keeps it')
  const s1 = sel.withQuery(s, 'רחוב הגעש 5')
  assert.deepEqual([s1.selected, s1.manualHouseNumber], [null, '']); assert.ok(!sel.isAddressSelectionValid(s1)); assert.ok(!sel.requiresPreciseLocation(s1))
  assert.equal(sel.withManualHouseNumber(s1, '7'), s1, 'manual number ignored without a route selection')
  const full = sel.withSelection({ city: MA, query: 'הגעש 6', selected: null, manualHouseNumber: '' }, { kind: 'address', placeId: 'F', city: MA, street: 'רחוב הגעש', houseNumber: '6', formattedAddress: null })
  assert.equal(sel.withManualHouseNumber(full, '7'), full, 'a full address never takes a manual number')
  assert.equal(sel.selectionHouseNumber(full), '6')
})

await test('12. changing area clears route selection + manual house number + GPS', async () => {
  const s = sel.withCity({ ...routeSelection(), manualHouseNumber: '3' }, ALON)
  assert.deepEqual(s, { city: ALON, query: '', selected: null, manualHouseNumber: '' })
  assert.ok(!sel.requiresPreciseLocation({ ...routeSelection(), city: ALON }), 'a route selection for another area is ignored')
  assert.ok(/setAddressPicker\(p => withCity\(p, city\)\)[^\n]*\r?\n\s*resetDeviceLocation\(\)/.test(src('app/order/page.tsx')), 'city change also clears GPS')
})

await test('13. browser cannot spoof street / city for a route-only place', async () => {
  const r = await submit(orderBody(MA, { google_place_id: 'PLACE_ROUTE', street: 'רחוב מזויף', ...GPS }), async () => routePlace())
  assert.deepEqual([r.rpcArgs.p_delivery.street, r.rpcArgs.p_delivery.city], ['רחוב הגעש', MA], "street is Google's, not the browser's")
  assert.ok(!JSON.stringify(r.rpcArgs).includes('מזויף'))
  const d = await submit(orderBody('ירושלים', { google_place_id: 'PLACE_ROUTE', ...GPS }), async () => routePlace())
  assert.equal(d.parsed.code, 'invalid_delivery_area')
  // route-only status cannot be injected by the client
  assert.equal(parseCreateOrderRequest(orderBody(MA, {}, { googleAddress: { status: 'route_only' } })).detail, 'client_geo_not_accepted')
  const nested = parseCreateOrderRequest(orderBody(MA, { google_place_id: 'P', googleAddress: { status: 'route_only' } }))
  assert.ok(nested.ok && !('googleAddress' in nested.value))
})

await test('14. browser cannot spoof precise coordinates', async () => {
  for (const extra of [{ delivery_lat: 31.78 }, { lat: 31.78 }, { geo_precision: 'street' }, { geo_source: 'manual' }])
    assert.equal(parseCreateOrderRequest(orderBody(MA, { google_place_id: 'PLACE_ROUTE', ...GPS, ...extra })).detail, 'client_geo_not_accepted')
  assert.equal(parseCreateOrderRequest(orderBody(MA, { google_place_id: 'PLACE_ROUTE', ...GPS, location_confirmed: false })).detail, 'invalid_location')
  assert.equal(parseCreateOrderRequest(orderBody(MA, { google_place_id: 'PLACE_ROUTE', ...GPS, location_lat: 40.7 })).detail, 'invalid_location', 'outside Israel')
  // the only coordinates a route-only order can carry are the trusted, confirmed device fix
  const r = await submit(orderBody(MA, { google_place_id: 'PLACE_ROUTE', ...GPS }), async () => routePlace())
  assert.deepEqual(geo(r.rpcArgs.p_delivery).slice(0, 2), [31.780123, 35.310235])
})

await test('15. full Google address still does not require GPS', async () => {
  const full = sel.withSelection({ city: MA, query: 'הגעש 6', selected: null, manualHouseNumber: '' }, { kind: 'address', placeId: 'F', city: MA, street: 'רחוב הגעש', houseNumber: '6', formattedAddress: null })
  assert.equal(sel.requiresPreciseLocation(full), false); assert.equal(sel.isDeliveryAddressReady(full, false), true)
  const r = await submit(orderBody(MA, { google_place_id: 'PLACE_FULL' }), async () => fullPlace())
  assert.ok(r.created); assert.deepEqual(geo(r.rpcArgs.p_delivery), [31.773612, 35.298346, 'geocoder', 'street'])
})

await test('16. Maale payload for route-only + GPS: Google street + manual number + city, device coordinates', async () => {
  const r = await submit(orderBody(MA, { google_place_id: 'PLACE_ROUTE', ...GPS }, { paymentMethod: 'cash' }), async () => routePlace())
  const p = buildMaaleOrderPayload(snapshotOf(r.rpcArgs))
  assert.ok(p.ok, JSON.stringify(p))
  assert.equal(p.payload.customer_address, `רחוב הגעש 3, ${MA}`) // Google's route longText includes "רחוב"
  assert.deepEqual([p.payload.lat, p.payload.lng], [31.780123, 35.310235])
  assert.equal(p.payload.payment_method, 'cash')
  assert.deepEqual([r.rpcArgs.p_delivery.geo_source, r.rpcArgs.p_delivery.geo_precision], ['manual', 'street'])
})

await test('17. Google key remains server-only (client modules never touch Google or the key)', async () => {
  for (const f of ['app/order/page.tsx', 'app/order/DeliveryAddressPicker.tsx', 'lib/deliveryAddressSelection.ts', 'lib/houseNumber.ts']) {
    const s = src(f)
    assert.ok(!/GOOGLE_PLACES_API_KEY|NEXT_PUBLIC_GOOGLE|places\.googleapis|X-Goog-Api-Key/.test(s), f)
    assert.ok(!/process\.env\.(?!NEXT_PUBLIC_VAPID_PUBLIC_KEY\b)/.test(s), `${f}: no server env (only the existing public push key)`)
    // type-only imports are erased at compile time (no runtime code reaches the browser)
    const runtimeImports = s.split('\n').filter(l => /^import\s/.test(l) && !/^import\s+type\s/.test(l)).join('\n')
    assert.ok(!/(googlePlaces|orderAddress)['"]/.test(runtimeImports), `${f}: no runtime server Google module import`)
  }
  assert.ok(!/^import /m.test(src('lib/houseNumber.ts')), 'houseNumber has no imports')
  assert.ok(!/console\./.test(src('lib/houseNumber.ts') + src('lib/orderAddress.ts').replace(/console\.warn\('orders: address', code\)/, '')), 'no new logging')
})

await test('18. pricing unchanged by the route-only path', async () => {
  const route = await submit(orderBody(MA, { google_place_id: 'PLACE_ROUTE', ...GPS }), async () => routePlace())
  const full = await submit(orderBody(MA, { google_place_id: 'PLACE_FULL' }), async () => fullPlace())
  assert.equal(route.rpcArgs.p_order.total_price, full.rpcArgs.p_order.total_price)
  assert.equal(route.rpcArgs.p_order.total_price, 60 + 12 + 25)
  assert.deepEqual([route.rpcArgs.p_delivery.delivery_fee, route.rpcArgs.p_delivery.meal_surcharge], [25, 12])
})

await test('19. cash / credit behaviour unchanged', async () => {
  for (const pm of ['cash', 'credit']) {
    const r = await submit(orderBody(MA, { google_place_id: 'PLACE_ROUTE', ...GPS }, { paymentMethod: pm }), async () => routePlace())
    assert.equal(r.rpcArgs.p_order.payment_method, pm)
  }
  for (const pm of ['bit', 'cibus'])
    assert.equal(parseCreateOrderRequest(orderBody(MA, { google_place_id: 'PLACE_ROUTE', ...GPS }, { paymentMethod: pm })).code, 'payment_method_not_allowed')
})

await test('20. no Maale network call (and no network at all) on the route-only path', async () => {
  assert.equal(networkCalls, 0)
  for (const f of ['lib/houseNumber.ts', 'lib/googlePlaces.ts', 'lib/orderAddress.ts', 'lib/orderGeo.ts', 'lib/deliveryAddressSelection.ts',
    'app/order/DeliveryAddressPicker.tsx', 'app/api/places/details/route.ts'])
    assert.ok(!/maalehamishlohim|delivery_dispatches|express\/integrations|maaleClient|maaleDispatch/i.test(src(f)), f)
})

console.log(`\nAll ${passed} route-only address checks passed.`)
