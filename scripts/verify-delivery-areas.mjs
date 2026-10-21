// Local checks for delivery destinations, fees and address safeguards (S4-INTEGRATIONS-02A, aligned in 02D:
// נופי פרת / מצפה יריחו unavailable with their future fees kept). Mocked Google lookups only: no network, no key, no DB.
// Run: node scripts/verify-delivery-areas.mjs

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

globalThis.fetch = async () => { throw new Error('NETWORK FORBIDDEN IN TESTS') }

const require = createRequire(import.meta.url)
const ts = require('typescript')
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cache = new Map()
function load(name) {
  const file = join(ROOT, 'lib', name.replace(/^\.\//, '') + '.ts')
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

const cfg = load('orderConfig')
const P = load('pricing')
const gp = load('googlePlaces')
const { parseCreateOrderRequest, buildOrderFromCatalog } = load('orderRequest')
const { attachDeliveryGeo } = load('orderGeo')
const { resolveGoogleDeliveryAddress } = load('orderAddress')
const sel = load('deliveryAddressSelection')
const M = load('maalePayload')

let passed = 0
const test = async (name, fn) => { await fn(); passed++; console.log('  ✓', name) }

const MA = 'מעלה אדומים', MISHOR = 'מישור אדומים', KFAR = 'כפר אדומים', NOFEI = 'נופי פרת', ALON = 'אלון', MY = 'מצפה יריחו'
const ACTIVE = { [MA]: 25, [MISHOR]: 25, [KFAR]: 35, [ALON]: 40 }
const FUTURE = { [NOFEI]: 40, [MY]: 45 }
const BRANCH = cfg.DELIVERY_BRANCH_IDS[0]
const MEAL = 'aaaaaaaa-0000-4000-8000-000000000001', DRINK = 'aaaaaaaa-0000-4000-8000-000000000002'
const CAT_FALAFEL = '02e0f987-6cce-4a1d-85c6-5ff6f97c80a4', CAT_DRINKS = 'f70b04f0-c87d-496b-b044-857a477f441d'
const catalog = {
  items: new Map([[MEAL, { id: MEAL, category_id: CAT_FALAFEL, is_active: true }], [DRINK, { id: DRINK, category_id: CAT_DRINKS, is_active: true }]]),
  prices: new Map([[MEAL, { item_id: MEAL, price: 20, is_available: true }], [DRINK, { item_id: DRINK, price: 8, is_available: true }]]),
  toppings: new Map(),
}
const GPS = { location_lat: 31.7801, location_lng: 35.3102, location_accuracy: 12, location_confirmed: true }
const body = (city, delivery = {}, extra = {}) => ({
  branchId: BRANCH, type: 'delivery', customerName: 'בדיקה בדיקה', phone: '0501234567', paymentMethod: 'cash',
  items: [{ itemId: MEAL, quantity: 2 }, { itemId: DRINK, quantity: 1 }],
  delivery: { city, street: 'רחוב שהוקלד', houseNumber: '9', ...delivery }, ...extra,
})
// Google Place Details fixtures (shape of lib/googlePlaces.mapPlaceDetails) — synthetic, no real coordinates.
const place = (locality, over = {}) => ({ placeId: 'P1', formattedAddress: `הדקל 5, ${locality}`, lat: 31.8, lng: 35.35,
  street: 'הדקל', houseNumber: '5', locality, subLocalities: [], types: ['street_address'], cityMatchesSelectedArea: true, ...over })
const route = (locality, over = {}) => place(locality, { houseNumber: null, types: ['route'], ...over })
const lookupDeps = (lookup, calls = { lookup: 0 }) => ({ lookup: async (...a) => { calls.lookup++; return lookup(...a) }, log: () => {}, timeoutMs: 50 })

/** parse → server Google verification (mock) → build → geo → captured create_order args (or the rejection). */
async function submit(b, lookup, opts = {}) {
  const calls = { lookup: 0, geocode: 0 }
  const parsed = parseCreateOrderRequest(b, opts)
  if (!parsed.ok) return { parsed, calls }
  const resolved = await resolveGoogleDeliveryAddress(parsed.value, lookupDeps(lookup, calls))
  if (!resolved.ok) return { resolved, calls }
  const built = buildOrderFromCatalog(resolved.order, catalog)
  assert.ok(built.ok, JSON.stringify(built))
  const withGeo = await attachDeliveryGeo(resolved.order, built.value, {
    geocode: async () => { calls.geocode++; return { ok: false, lat: null, lng: null, precision: 'unresolved', source: 'none', reason: 'no_result' } },
    log: () => {},
  })
  return { created: true, order: resolved.order, rpcArgs: JSON.parse(JSON.stringify(withGeo.rpcArgs)), calls }
}
const rejected = r => ({ code: r.resolved?.code ?? r.parsed?.code, detail: r.resolved?.detail ?? r.parsed?.detail })
const geo = d => [d.delivery_lat, d.delivery_lng, d.geo_source, d.geo_precision]

console.log('Delivery areas & pricing (S4-INTEGRATIONS-02A / 02D)')

await test('1. the four active settlements: config fee, server-stored fee and total (Google-verified address)', async () => {
  for (const [city, fee] of Object.entries(ACTIVE)) {
    assert.equal(cfg.getDeliveryFeeForArea(city), fee, city)
    const r = await submit(body(city, { google_place_id: 'P1' }), async () => place(city))
    assert.ok(r.created, `${city}: ${JSON.stringify(r.resolved ?? r.parsed)}`)
    assert.equal(r.rpcArgs.p_delivery.delivery_fee, fee, city)
    assert.equal(r.rpcArgs.p_order.total_price, 2 * 20 + 8 + 2 * 4 + fee, city) // 48 food + ₪8 surcharge + fee
  }
})

await test('2. totals with and without the ₪4 food surcharge; display total === server total; fee separate from items', async () => {
  for (const [city, fee] of Object.entries(ACTIVE)) {
    const meals = [{ categoryId: CAT_FALAFEL, basePrice: 20, paidAddonPrices: [], quantity: 3 }]
    const drinks = [{ categoryId: CAT_DRINKS, basePrice: 8, paidAddonPrices: [], quantity: 2 }]
    const tm = P.computeOrderTotals(meals, 'delivery', city), td = P.computeOrderTotals(drinks, 'delivery', city)
    assert.deepEqual([tm.subtotal, tm.mealSurcharge, tm.deliveryFee, tm.total], [60, 12, fee, 72 + fee], city)
    assert.deepEqual([td.subtotal, td.mealSurcharge, td.deliveryFee, td.total], [16, 0, fee, 16 + fee], `${city}: drinks never surcharged`)
    for (const lines of [meals, drinks, [...meals, ...drinks]]) {
      const d = P.computeDisplayTotals(lines, 'delivery', city), a = P.computeOrderTotals(lines, 'delivery', city)
      assert.equal(d.total, a.total, city); assert.equal(d.deliveryFee, fee); assert.equal(P.roundMoney(d.itemsTotal + d.deliveryFee), a.total)
    }
    assert.equal(P.foodTotalAgorot(tm), 7200) // Maale food total = total − fee: the fee never leaks into food
  }
})

await test('3. נופי פרת / מצפה יריחו unavailable: future fees kept, rejected by server before any Google lookup, hidden in UI', async () => {
  assert.deepEqual({ ...cfg.DELIVERY_FEES_BY_AREA }, { ...ACTIVE, ...FUTURE }, 'future fees 40 / 45 stay configured')
  assert.deepEqual([...cfg.UNAVAILABLE_DELIVERY_AREAS], [NOFEI, MY])
  assert.deepEqual([...cfg.ACTIVE_DELIVERY_AREAS], [MA, MISHOR, KFAR, ALON])
  assert.deepEqual({ ...cfg.DELIVERY_FEE_RANGE }, { min: 25, max: 40 })
  for (const city of [NOFEI, MY]) {
    assert.equal(cfg.getDeliveryFeeForArea(city), null, city)
    assert.equal(P.computeDisplayTotals([{ categoryId: CAT_FALAFEL, basePrice: 20, paidAddonPrices: [], quantity: 1 }], 'delivery', city).total, null, 'client never shows a total')
    for (const delivery of [{}, { google_place_id: 'P1' }, { google_place_id: 'P1', ...GPS }]) {
      const r = await submit(body(city, delivery), async () => place(city))
      assert.deepEqual(rejected(r), { code: 'delivery_area_unavailable', detail: undefined }, city); assert.equal(r.calls.lookup, 0)
    }
    assert.ok(M.buildMaaleOrderPayload({
      order: { id: '11111111-2222-4333-8444-555555555555', type: 'delivery', branch_id: BRANCH, payment_method: 'cash', customer_name: 'בדיקה בדיקה', phone: '0501234567', total_price: 96 },
      delivery: { city, street: 'הדקל', house_number: '5', apartment: null, floor: null, entrance: null, notes: null, delivery_fee: 40, meal_surcharge: 8, delivery_lat: 31.8, delivery_lng: 35.35, geo_source: 'geocoder', geo_precision: 'street' },
      items: [{ name: 'פלאפל', quantity: 2, unit_price: 20 }, { name: 'שתייה', quantity: 1, unit_price: 8 }],
    }).errors.includes('invalid_city'), `${city}: no Maale payload`)
  }
  const page = src('app/order/page.tsx')
  assert.ok(page.includes('{ACTIVE_DELIVERY_AREAS.map(a => <option key={a} value={a}>{a} · משלוח ₪{getDeliveryFeeForArea(a)}</option>)}'), 'selector = active only')
  assert.ok(page.includes('ACTIVE_DELIVERY_AREAS.includes(str(s.city))') && page.includes('ACTIVE_DELIVERY_AREAS.includes(deliveryForm.city)'), 'remembered / form city = active only')
  assert.ok(src('app/delivery-policy/page.tsx').includes('ACTIVE_DELIVERY_AREAS.map(a => `${a} — דמי משלוח: ${getDeliveryFeeForArea(a)} ₪`)'))
})

await test('4. address ↔ settlement mismatches among active areas are rejected, never re-priced', async () => {
  for (const [selected, actual] of [[ALON, MA], [MA, ALON], [KFAR, MA], [MISHOR, KFAR]]) {
    const r = await submit(body(selected, { google_place_id: 'P1' }), async () => place(actual))
    assert.deepEqual(rejected(r), { code: 'address_not_verified', detail: 'city_mismatch' }, `${selected} ← ${actual}`)
  }
  const c = await submit(body(MA, { google_place_id: 'P1' }), async () => place(MA, { subLocalities: [NOFEI] }))
  assert.deepEqual(rejected(c), { code: 'address_not_verified', detail: 'settlement_conflict' })
  assert.ok((await submit(body(MA, { google_place_id: 'P1' }), async () => place(MA, { subLocalities: ['מצפה נבו'] }))).created, 'unrelated neighbourhood ignored')
})

await test('4b. (02F) neighbourhood conflict only when the price would differ; equal ACTIVE fees never reject on name alone', async () => {
  const ok = { ok: true }, conflict = { ok: false, reason: 'settlement_conflict' }, mismatch = { ok: false, reason: 'city_mismatch' }
  // A / B: מעלה אדומים ↔ מישור אדומים (both active, ₪25) — no rejection solely because of the names.
  assert.deepEqual(gp.placeAreaCheck({ locality: MA, subLocalities: [MISHOR] }, MA), ok)
  assert.deepEqual(gp.placeAreaCheck({ locality: MISHOR, subLocalities: [MA] }, MISHOR), ok)
  assert.deepEqual(gp.placeAreaCheck({ locality: MA, subLocalities: ['Mishor Adumim'] }, MA), ok, 'aliases too')
  const a = await submit(body(MA, { google_place_id: 'P1' }), async () => place(MA, { subLocalities: [MISHOR] }))
  assert.ok(a.created); assert.equal(a.rpcArgs.p_delivery.delivery_fee, 25)
  const b = await submit(body(MISHOR, { google_place_id: 'P1' }), async () => place(MISHOR, { subLocalities: [MA] }))
  assert.ok(b.created); assert.equal(b.rpcArgs.p_delivery.delivery_fee, 25)
  // …the relaxation is ONLY for the neighbourhood condition: the locality must still be the selected area.
  assert.deepEqual(gp.placeAreaCheck({ locality: MISHOR, subLocalities: [MISHOR] }, MA), mismatch)
  assert.deepEqual(rejected(await submit(body(MA, { google_place_id: 'P1' }), async () => place(MISHOR, { subLocalities: [MA] }))),
    { code: 'address_not_verified', detail: 'city_mismatch' })
  // C: כפר אדומים (₪35) with neighbourhood נופי פרת (₪40, unavailable) — still rejected.
  assert.deepEqual(gp.placeAreaCheck({ locality: KFAR, subLocalities: [NOFEI] }, KFAR), conflict)
  assert.deepEqual(rejected(await submit(body(KFAR, { google_place_id: 'P1' }), async () => place(KFAR, { subLocalities: [NOFEI] }))),
    { code: 'address_not_verified', detail: 'settlement_conflict' })
  // Different active fees still conflict (e.g. ₪25 vs ₪35, ₪25 vs ₪40).
  assert.deepEqual(gp.placeAreaCheck({ locality: MA, subLocalities: [KFAR] }, MA), conflict)
  assert.deepEqual(gp.placeAreaCheck({ locality: KFAR, subLocalities: [MA] }, KFAR), conflict)
  assert.deepEqual(gp.placeAreaCheck({ locality: ALON, subLocalities: [MISHOR] }, ALON), conflict)
  // F: a future fee of an unavailable area is NOT an equal price — אלון ₪40 vs נופי פרת (future ₪40) still conflicts.
  assert.equal(cfg.DELIVERY_FEES_BY_AREA[ALON], cfg.DELIVERY_FEES_BY_AREA[NOFEI], 'precondition: same table value')
  assert.deepEqual(gp.placeAreaCheck({ locality: ALON, subLocalities: [NOFEI] }, ALON), conflict)
  // F: an unknown neighbourhood is neither a conflict nor evidence for any area — the locality rule decides alone.
  assert.deepEqual(gp.placeAreaCheck({ locality: MA, subLocalities: ['מצפה נבו', 'שכונה לא ידועה'] }, MA), ok)
  assert.deepEqual(gp.placeAreaCheck({ locality: 'ירושלים', subLocalities: ['מצפה נבו'] }, MA), mismatch)
  // D / E: suspended destinations stay unavailable whatever their future fee or the Google data says.
  for (const city of [NOFEI, MY]) {
    for (const p of [place(city), place(ALON, { subLocalities: [city] }), place(MA, { subLocalities: [MISHOR] })]) {
      const r = await submit(body(city, { google_place_id: 'P1' }), async () => p)
      assert.deepEqual(rejected(r), { code: 'delivery_area_unavailable', detail: undefined }, city); assert.equal(r.calls.lookup, 0)
    }
    assert.equal(cfg.getDeliveryFeeForArea(city), null)
  }
  // The selected inactive area is never relaxed into a match (details route path, which accepts any known area name).
  assert.deepEqual(gp.placeAreaCheck({ locality: ALON, subLocalities: [NOFEI] }, NOFEI), mismatch)
  assert.deepEqual(gp.placeAreaCheck({ locality: MA, subLocalities: [MY] }, MY), mismatch)
})

await test('5. כפר אדומים vs נופי פרת: explicit Nofei Prat evidence blocks ₪35; the real 02B Google shape is a KNOWN, UNRESOLVED risk', async () => {
  // Google names נופי פרת explicitly while כפר אדומים is selected → contradiction → no ₪35 price.
  const c = await submit(body(KFAR, { google_place_id: 'P1' }), async () => place(KFAR, { subLocalities: [NOFEI] }))
  assert.deepEqual(rejected(c), { code: 'address_not_verified', detail: 'settlement_conflict' })
  // KNOWN RISK (02B, real data): Google returns Nofei Prat streets as route-only under locality "כפר אדומים" with NO
  // neighbourhood. Nothing in the data distinguishes them, so with trusted GPS the order is accepted at ₪35. Gating
  // נופי פרת does NOT prevent this; this assertion documents today's behaviour so a future safeguard must change it.
  const real = route(KFAR, { street: 'דרך נחל קדם', formattedAddress: 'דרך נחל קדם, כפר אדומים', lat: 31.8223123, lng: 35.3206398 })
  const risk = await submit(body(KFAR, { google_place_id: 'P1', houseNumber: '213', ...GPS }), async () => real)
  assert.ok(risk.created); assert.equal(risk.rpcArgs.p_delivery.delivery_fee, 35)
  const typed = await submit(body(KFAR, { street: 'דרך נחל קדם', houseNumber: '213' }), async () => real)
  assert.ok(typed.created); assert.equal(typed.rpcArgs.p_delivery.delivery_fee, 35, 'typed address: same known risk')
  // Nested-area rule kept for reactivation (function level): a Kfar locality alone never proves Nofei Prat.
  assert.deepEqual(gp.placeAreaCheck({ locality: KFAR, subLocalities: [] }, NOFEI), { ok: false, reason: 'city_mismatch' })
  assert.deepEqual(gp.placeAreaCheck({ locality: KFAR, subLocalities: ['Nofei Prat'] }, NOFEI), { ok: true })
  assert.deepEqual(gp.placeAreaCheck({ locality: NOFEI, subLocalities: [] }, KFAR), { ok: false, reason: 'city_mismatch' })
  assert.deepEqual(load('geocoding').NESTED_DELIVERY_AREAS, { [NOFEI]: KFAR })
  const d = gp.mapPlaceDetails({ id: 'X', location: { latitude: 31.8, longitude: 35.35 }, types: ['street_address'], addressComponents: [
    { longText: '5', types: ['street_number'] }, { longText: 'הדקל', types: ['route'] },
    { longText: NOFEI, types: ['neighborhood', 'political'] }, { longText: KFAR, types: ['locality', 'political'] },
  ] }, NOFEI)
  assert.deepEqual([d.locality, d.subLocalities], [KFAR, [NOFEI]])
})

await test('6. strict address rule (ready for reactivation) and unchanged behaviour of the active areas', async () => {
  // The order route rejects unavailable areas at parse time, so the strict rule is exercised directly here.
  const base = parseCreateOrderRequest(body(MA)).value
  const as = (city, delivery = {}, extra = {}) => ({ ...base, ...extra, delivery: { ...base.delivery, city, ...delivery } })
  const unavailable = async () => { throw new gp.PlacesError('places_http_503') }
  for (const city of [NOFEI, MY]) {
    assert.deepEqual(await resolveGoogleDeliveryAddress(as(city), lookupDeps(async () => place(city))), { ok: false, code: 'address_not_verified', detail: 'verified_address_required' })
    assert.deepEqual(await resolveGoogleDeliveryAddress(as(city, {}, { googlePlaceId: 'P1' }), lookupDeps(unavailable)), { ok: false, code: 'address_not_verified', detail: 'verification_unavailable' })
    assert.deepEqual(await resolveGoogleDeliveryAddress(as(city, {}, { googlePlaceId: 'P1', deliveryLocation: { lat: 31.78, lng: 35.31, accuracy: 10 } }), lookupDeps(async () => route(city))),
      { ok: false, code: 'address_not_verified', detail: 'house_address_required' })
    assert.equal((await resolveGoogleDeliveryAddress(as(city, {}, { googlePlaceId: 'P1' }), lookupDeps(async () => place(city)))).ok, true)
  }
  // Active areas keep today's behaviour: typed address, Google outage and route-only + GPS are still accepted.
  for (const city of Object.keys(ACTIVE)) {
    const typed = await submit(body(city), async () => place(city))
    assert.ok(typed.created, city); assert.equal(typed.calls.lookup, 0)
    const down = await submit(body(city, { google_place_id: 'P1' }), unavailable)
    assert.ok(down.created, city); assert.deepEqual(geo(down.rpcArgs.p_delivery), [null, null, 'none', 'unresolved'])
    const rg = await submit(body(city, { google_place_id: 'P1', ...GPS }), async () => route(city))
    assert.ok(rg.created, city); assert.deepEqual(geo(rg.rpcArgs.p_delivery), [31.7801, 35.3102, 'manual', 'street'])
    assert.equal(rg.rpcArgs.p_delivery.delivery_fee, ACTIVE[city])
  }
  for (const r of ['house_address_required', 'verified_address_required', 'verification_unavailable', 'settlement_conflict'])
    assert.ok(typeof sel.ADDRESS_REJECTION_MESSAGES[r] === 'string' && /[֐-׿]/.test(sel.ADDRESS_REJECTION_MESSAGES[r]), r)
  const page = src('app/order/page.tsx')
  assert.ok(page.includes("(addressMode === 'manual' ? !verifiedAddressRequired : isDeliveryAddressReady("))
  assert.ok(page.includes('SPECIFIC_ADDRESS_DETAILS.includes(detail)'))
  assert.ok(/if \(requiresVerifiedHouseAddress\(q\.city\)\) return json\(\{ error: 'address_not_verified', reason: 'house_address_required' \}, 422\)/.test(src('app/api/places/details/route.ts')))
})

await test('7. coordinate precedence: verified Google > device GPS; GPS used only without verified house coordinates', async () => {
  for (const city of Object.keys(ACTIVE)) {
    const v = await submit(body(city, { google_place_id: 'P1', ...GPS }), async () => place(city))
    assert.deepEqual(geo(v.rpcArgs.p_delivery), [31.8, 35.35, 'geocoder', 'street'], `${city}: GPS never replaces verified coordinates`)
    const legacy = await submit(body(city, GPS), async () => null)
    assert.deepEqual(geo(legacy.rpcArgs.p_delivery), [31.7801, 35.3102, 'manual', 'street'], `${city}: GPS only after the customer's explicit confirmation`)
    const none = await submit(body(city), async () => null)
    assert.notEqual(none.rpcArgs.p_delivery.geo_source, 'manual', 'no confirmed location → never a device fix')
  }
  // Device location is only ever sent after the customer's explicit "send my location" action (location_confirmed).
  assert.equal(parseCreateOrderRequest(body(MA, { ...GPS, location_confirmed: false })).detail, 'invalid_location')
})

await test('8. pickup pricing unchanged (no fee, no surcharge, no Google lookup) for any city argument', async () => {
  const pickup = { branchId: BRANCH, type: 'pickup', customerName: 'בדיקה בדיקה', phone: '0501234567', paymentMethod: 'bit', items: [{ itemId: MEAL, quantity: 2 }, { itemId: DRINK, quantity: 1 }] }
  const r = await submit(pickup, async () => { throw new Error('no lookup for pickup') })
  assert.ok(r.created); assert.equal(r.rpcArgs.p_delivery, null); assert.equal(r.rpcArgs.p_order.total_price, 48); assert.equal(r.calls.lookup, 0)
  for (const city of [undefined, ...Object.keys(ACTIVE), NOFEI, MY]) {
    const t = P.computeOrderTotals([{ categoryId: CAT_FALAFEL, basePrice: 20, paidAddonPrices: [], quantity: 2 }], 'pickup', city)
    assert.deepEqual([t.deliveryFee, t.mealSurcharge, t.total], [0, 0, 40])
  }
})

await test('9. parcel handling unchanged: a parcel rides along at the same price; parcel rules untouched', async () => {
  const parcel = { trackingRef: 'RR123456789IL', carrier: 'דואר ישראל' }
  for (const city of [MA, KFAR, ALON]) {
    const withParcel = await submit(body(city, { google_place_id: 'P1' }, { parcel }), async () => place(city), { parcelCheckoutEnabled: true })
    const without = await submit(body(city, { google_place_id: 'P1' }), async () => place(city), { parcelCheckoutEnabled: true })
    assert.ok(withParcel.created && without.created, city)
    assert.deepEqual(withParcel.order.parcel, { trackingRef: 'RR123456789IL', carrier: 'דואר ישראל' })
    assert.deepEqual(withParcel.rpcArgs, without.rpcArgs, `${city}: parcel adds no charge and changes no field`)
  }
  assert.equal(parseCreateOrderRequest(body(MA, {}, { parcel })).code, 'parcel_checkout_disabled', 'flag gate unchanged')
  assert.equal(parseCreateOrderRequest(body(NOFEI, {}, { parcel }), { parcelCheckoutEnabled: true }).code, 'delivery_area_unavailable')
  for (const f of ['lib/parcelCheckout.ts', 'lib/parcelRequest.ts', 'lib/createOrder.ts', 'lib/kitchenParcels.ts', 'lib/kitchenMutations.ts'])
    assert.ok(!/DELIVERY_FEES_BY_AREA|requiresVerifiedHouseAddress|NESTED_DELIVERY_AREAS|UNAVAILABLE_DELIVERY_AREAS/.test(src(f)), f)
})

console.log(`\nAll ${passed} delivery-area checks passed.`)
