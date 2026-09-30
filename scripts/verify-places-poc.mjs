// Local checks for the Google Places address POC client (FALAFEL-SN-08D7). Mocked fetch only: no network, no key.
// Run: node scripts/verify-places-poc.mjs

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

const gp = load('googlePlaces')
let passed = 0
const test = async (name, fn) => { await fn(); passed++; console.log('  ✓', name) }

const KEY = 'test-key-not-real'
const TOKEN = '123e4567-e89b-42d3-a456-426614174000'
const MA = 'מעלה אדומים', MY = 'מצפה יריחו'
const jsonRes = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

console.log('Google Places POC client')

await test('P1. gate: enabled only with ADDRESS_POC_ENABLED=true and never on Vercel Production', async () => {
  assert.equal(gp.isAddressPocEnabled({}), false)
  assert.equal(gp.isAddressPocEnabled({ ADDRESS_POC_ENABLED: 'true' }), true) // local
  assert.equal(gp.isAddressPocEnabled({ ADDRESS_POC_ENABLED: 'true', VERCEL_ENV: 'preview' }), true)
  assert.equal(gp.isAddressPocEnabled({ ADDRESS_POC_ENABLED: 'true', VERCEL_ENV: 'production' }), false)
  assert.equal(gp.isAddressPocEnabled({ ADDRESS_POC_ENABLED: '1' }), false)
  assert.equal(gp.placesApiKey({}), null); assert.equal(gp.placesApiKey({ NEXT_PUBLIC_GOOGLE_PLACES_API_KEY: KEY }), null)
})

await test('P2. input validation (length, supported area, session token UUID, place id charset)', async () => {
  assert.deepEqual(gp.parseAutocompleteInput({ input: ' הגעש 6 ', city: MA, sessionToken: TOKEN }), { input: 'הגעש 6', city: MA, sessionToken: TOKEN })
  for (const b of [{ input: 'x', city: MA, sessionToken: TOKEN }, { input: 'הגעש 6', city: 'ירושלים', sessionToken: TOKEN },
    { input: 'הגעש 6', city: MA, sessionToken: 'nope' }, { input: 'a'.repeat(121), city: MA, sessionToken: TOKEN }, null])
    assert.equal(gp.parseAutocompleteInput(b), null)
  assert.ok(gp.parseDetailsInput({ placeId: 'ChIJ_abc-123', city: MY, sessionToken: TOKEN }))
  assert.equal(gp.parseDetailsInput({ placeId: '../x?y', city: MY, sessionToken: TOKEN }), null)
})

await test('P3. autocomplete request: Places API (New), key only in header, Israel-restricted, Hebrew, region bias, session token', async () => {
  const seen = []
  const f = async (url, init) => { seen.push({ url, init }); return jsonRes({ suggestions: [] }) }
  await gp.autocompletePlaces({ input: 'הגעש 6', city: MA, sessionToken: TOKEN }, KEY, f)
  assert.equal(seen[0].url, 'https://places.googleapis.com/v1/places:autocomplete'); assert.equal(seen[0].init.method, 'POST')
  assert.equal(seen[0].init.headers['X-Goog-Api-Key'], KEY); assert.ok(!seen[0].url.includes(KEY))
  const b = JSON.parse(seen[0].init.body)
  assert.equal(b.input, `הגעש 6, ${MA}`); assert.equal(b.languageCode, 'he'); assert.equal(b.regionCode, 'il')
  assert.deepEqual(b.includedRegionCodes, ['il']); assert.equal(b.sessionToken, TOKEN)
  assert.equal(b.locationBias.circle.radius, 30000)
  assert.ok(!seen[0].init.body.includes(KEY))
})

await test('P4. autocomplete mapping: placePrediction fields only, max 5, bad place ids dropped', async () => {
  const mk = (id, t) => ({ placePrediction: { placeId: id, text: { text: t }, structuredFormat: { mainText: { text: 'הגעש 6' }, secondaryText: { text: MA } }, types: ['street_address'] } })
  const r = gp.mapAutocompleteResponse({ suggestions: [mk('A1', 'x'), mk('bad id!', 'y'), { queryPrediction: {} }, ...Array.from({ length: 6 }, (_, i) => mk('B' + i, 'z'))] })
  assert.equal(r.length, 5); assert.deepEqual(r[0], { placeId: 'A1', text: 'x', mainText: 'הגעש 6', secondaryText: MA, types: ['street_address'] })
  assert.deepEqual(gp.mapAutocompleteResponse({}), [])
  assert.throws(() => gp.mapAutocompleteResponse('nope'), /places_bad_body/)
})

await test('P5. details request: minimal field mask, session token + he/il in query, key only in header', async () => {
  const seen = []
  const f = async (url, init) => { seen.push({ url, init }); return jsonRes({ id: 'A1' }) }
  await gp.getPlaceDetails({ placeId: 'A1', city: MA, sessionToken: TOKEN }, KEY, f)
  const u = new URL(seen[0].url)
  assert.equal(u.origin + u.pathname, 'https://places.googleapis.com/v1/places/A1')
  assert.equal(u.searchParams.get('sessionToken'), TOKEN); assert.equal(u.searchParams.get('languageCode'), 'he'); assert.equal(u.searchParams.get('regionCode'), 'il')
  assert.equal(seen[0].init.headers['X-Goog-FieldMask'], 'id,formattedAddress,location,addressComponents,types')
  assert.equal(seen[0].init.headers['X-Goog-Api-Key'], KEY); assert.ok(!seen[0].url.includes(KEY))
})

await test('P6. details mapping: street / house number / locality / coordinates / city match (exact aliases only)', async () => {
  const body = {
    id: 'A1', formattedAddress: `הגעש 6, ${MA}, ישראל`, location: { latitude: 31.77, longitude: 35.3 }, types: ['street_address'],
    addressComponents: [
      { longText: '6', types: ['street_number'] }, { longText: 'הגעש', types: ['route'] },
      { longText: MA, types: ['locality', 'political'] }, { longText: 'ישראל', types: ['country', 'political'] },
    ],
  }
  const d = gp.mapPlaceDetails(body, MA)
  assert.deepEqual(d, { placeId: 'A1', formattedAddress: `הגעש 6, ${MA}, ישראל`, lat: 31.77, lng: 35.3, street: 'הגעש', houseNumber: '6',
    locality: MA, types: ['street_address'], cityMatchesSelectedArea: true })
  assert.equal(gp.mapPlaceDetails(body, MY).cityMatchesSelectedArea, false)
  const noLoc = gp.mapPlaceDetails({ id: 'A2' }, MA)
  assert.deepEqual([noLoc.lat, noLoc.lng, noLoc.locality, noLoc.cityMatchesSelectedArea], [null, null, null, false])
  assert.throws(() => gp.mapPlaceDetails({}, MA), /places_bad_body/)
})

await test('P7. errors are short codes and never contain the key', async () => {
  for (const f of [async () => jsonRes({ error: { message: KEY } }, 403), async () => { throw new Error(`fail ${KEY}`) },
    async () => ({ ok: true, status: 200, json: async () => { throw new Error(KEY) } })]) {
    for (const call of [() => gp.autocompletePlaces({ input: 'הגעש 6', city: MA, sessionToken: TOKEN }, KEY, f),
      () => gp.getPlaceDetails({ placeId: 'A1', city: MA, sessionToken: TOKEN }, KEY, f)]) {
      let caught; try { await call() } catch (e) { caught = e }
      assert.ok(caught); assert.match(caught.message, /^places_[a-z0-9_]+$/); assert.ok(!caught.message.includes(KEY))
    }
  }
})

await test('P8. isolation: the order flow never uses the dev POC routes / gate; no NEXT_PUBLIC key; routes gated', async () => {
  for (const f of ['app/order/page.tsx', 'app/api/orders/route.ts', 'lib/orderGeo.ts', 'lib/orderRequest.ts', 'lib/pricing.ts', 'lib/geocodingProvider.ts'])
    assert.ok(!/address-poc|api\/dev|ADDRESS_POC_ENABLED|isAddressPocEnabled/.test(readFileSync(join(ROOT, f), 'utf8')), f) // order flow never uses the dev POC
  for (const f of ['lib/googlePlaces.ts', 'app/dev/address-poc/AddressPocClient.tsx', 'app/dev/address-poc/page.tsx'])
    assert.ok(!/NEXT_PUBLIC/.test(readFileSync(join(ROOT, f), 'utf8').replace(/\/\/.*$/gm, '')), f)
  for (const f of ['app/api/dev/places/autocomplete/route.ts', 'app/api/dev/places/details/route.ts']) {
    const s = readFileSync(join(ROOT, f), 'utf8')
    assert.ok(s.indexOf('isAddressPocEnabled(process.env)') < s.indexOf('placesApiKey(') && s.includes('checkSameOriginJson(req)'), f)
    assert.ok(!/console\./.test(s), `${f}: no logging`)
  }
  assert.ok(!/console\./.test(readFileSync(join(LIB, 'googlePlaces.ts'), 'utf8')))
})

/* ─── Real order-flow integration (08D8): server-side verification, priority, UI state ─── */
console.log('Google address in the order flow (08D8)')

const cfg = load('orderConfig')
const { parseCreateOrderRequest, buildOrderFromCatalog } = load('orderRequest')
const { attachDeliveryGeo } = load('orderGeo')
const { resolveGoogleDeliveryAddress } = load('orderAddress')
const sel = load('deliveryAddressSelection')

const BRANCH = cfg.DELIVERY_BRANCH_IDS[0]
const ITEM = 'aaaaaaaa-0000-4000-8000-000000000001'
const catalog = {
  items: new Map([[ITEM, { id: ITEM, category_id: '02e0f987-6cce-4a1d-85c6-5ff6f97c80a4', is_active: true }]]),
  prices: new Map([[ITEM, { item_id: ITEM, price: 20, is_available: true }]]),
  toppings: new Map(),
}
const orderBody = (city, delivery = {}, extra = {}) => ({
  branchId: BRANCH, type: 'delivery', customerName: 'בדיקה בדיקה', phone: '0501234567', paymentMethod: 'credit',
  items: [{ itemId: ITEM, quantity: 3 }],
  delivery: { city, street: 'רחוב שהוקלד', houseNumber: '99', apartment: '8', floor: '3', ...delivery }, ...extra,
})
// Google Place Details fixtures (shape produced by lib/googlePlaces.mapPlaceDetails)
const gPlace = (city, over = {}) => ({ placeId: 'PLACE_1', formattedAddress: `הגעש 6, ${city}, ישראל`, lat: 31.7736123, lng: 35.2983456,
  street: 'הגעש', houseNumber: '6', locality: city, types: ['street_address'], cityMatchesSelectedArea: true, ...over })

/** parse → server Google verification → build → geo (fake Mapbox counts calls) → captured create_order args. */
async function submit(body, lookup, geocodeResult = null) {
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
    geocode: async () => { calls.geocode++; return geocodeResult ?? { ok: false, lat: null, lng: null, precision: 'unresolved', source: 'none', reason: 'no_result' } },
    log: c => calls.logs.push(c),
  })
  return { created: true, rpcArgs: JSON.parse(JSON.stringify(withGeo.rpcArgs)), calls }
}
const geo = d => [d.delivery_lat, d.delivery_lng, d.geo_source, d.geo_precision]

await test('G1. autocomplete query includes the selected delivery area (every area)', async () => {
  for (const a of cfg.DELIVERY_AREAS) assert.equal(gp.buildAutocompleteBody('הגעש 6', a, TOKEN).input, `הגעש 6, ${a}`)
})

await test("G2. valid Ma'ale Adumim street_address accepted; typed street/house replaced by Google's", async () => {
  const r = await submit(orderBody(MA, { google_place_id: 'PLACE_1' }), async () => gPlace(MA))
  assert.ok(r.created); const d = r.rpcArgs.p_delivery
  assert.deepEqual([d.city, d.street, d.house_number], [MA, 'הגעש', '6'])
  assert.ok(d.address.startsWith(`${MA}, הגעש 6`), d.address)
  assert.deepEqual(geo(d), [31.773612, 35.298346, 'geocoder', 'street'])
})

await test('G3. valid Mitzpe Yericho street_address accepted', async () => {
  const r = await submit(orderBody(MY, { google_place_id: 'PLACE_2' }), async () => gPlace(MY, { placeId: 'PLACE_2', street: 'היהלום', houseNumber: '3', lat: 31.85, lng: 35.41 }))
  const d = r.rpcArgs.p_delivery
  assert.deepEqual([d.street, d.house_number, d.geo_precision], ['היהלום', '3', 'street'])
})

await test('G4–6. locality-only / missing house number / city mismatch / bad coordinates rejected (400)', async () => {
  const cases = [
    [gPlace(MA, { street: null, houseNumber: null, types: ['locality', 'political'] }), 'missing_street'],
    [gPlace(MA, { houseNumber: null, types: ['route'] }), 'missing_house_number'],
    [gPlace(MA, { locality: 'ירושלים' }), 'city_mismatch'],
    [gPlace(MA, { lat: null }), 'invalid_coordinates'],
  ]
  for (const [place, reason] of cases) {
    assert.deepEqual(gp.verifyDeliveryPlace(place, MA), { ok: false, reason })
    const r = await submit(orderBody(MA, { google_place_id: 'PLACE_1' }), async () => place)
    assert.deepEqual({ ok: r.resolved.ok, code: r.resolved.code, detail: r.resolved.detail }, { ok: false, code: 'address_not_verified', detail: reason })
  }
})

await test('G7. changing the delivery area clears the selection, the query and captured GPS', async () => {
  const s0 = sel.withSelection({ city: MA, query: 'הגעש 6', selected: null }, { placeId: 'P', city: MA, street: 'הגעש', houseNumber: '6', formattedAddress: null })
  assert.ok(sel.isAddressSelectionValid(s0)); assert.equal(sel.selectionLabel(s0.selected), `הגעש 6, ${MA}`)
  const s1 = sel.withCity(s0, MY)
  assert.deepEqual(s1, { city: MY, query: '', selected: null }); assert.ok(!sel.isAddressSelectionValid(s1))
  assert.ok(!sel.isAddressSelectionValid({ ...s0, city: MY }), 'a selection for another area is never valid')
  const page = readFileSync(join(ROOT, 'app', 'order', 'page.tsx'), 'utf8')
  assert.ok(/setAddressPicker\(p => withCity\(p, city\)\)[^\n]*\n\s*resetDeviceLocation\(\)/.test(page), 'city change also clears GPS')
})

await test('G8. editing the text after a selection invalidates it (unchanged text keeps it)', async () => {
  const s0 = sel.withSelection({ city: MA, query: '', selected: null }, { placeId: 'P', city: MA, street: 'הגעש', houseNumber: '6', formattedAddress: null })
  assert.equal(sel.withQuery(s0, 'הגעש 6'), s0)
  const s1 = sel.withQuery(s0, 'הגעש 7'); assert.equal(s1.selected, null); assert.ok(!sel.isAddressSelectionValid(s1))
  assert.equal(sel.withSelection({ city: MY, query: '', selected: null }, s0.selected).selected, null, 'selection for another area rejected')
})

await test('G9. valid Google address alone (no device GPS) allows the order', async () => {
  const r = await submit(orderBody(MA, { google_place_id: 'PLACE_1' }), async () => gPlace(MA))
  assert.ok(r.created); assert.equal(r.rpcArgs.p_delivery.geo_source, 'geocoder')
})

await test('G10–11. trusted device GPS overrides navigation coordinates only; textual Google address unchanged', async () => {
  const gps = { location_lat: 31.7801, location_lng: 35.3102, location_accuracy: 12, location_confirmed: true }
  const r = await submit(orderBody(MA, { google_place_id: 'PLACE_1', ...gps }), async () => gPlace(MA))
  const d = r.rpcArgs.p_delivery
  assert.deepEqual(geo(d), [31.7801, 35.3102, 'manual', 'street'])
  assert.deepEqual([d.street, d.house_number, d.city], ['הגעש', '6', MA]); assert.ok(d.address.includes('הגעש 6'))
  const poor = await submit(orderBody(MA, { google_place_id: 'PLACE_1', ...gps, location_accuracy: 400 }), async () => gPlace(MA))
  assert.deepEqual(geo(poor.rpcArgs.p_delivery), [31.773612, 35.298346, 'geocoder', 'street'], 'untrusted GPS → Google coordinates')
})

await test('G12. Mapbox never called after a Google selection (verified, unavailable, timeout); bogus place rejected', async () => {
  const ok = await submit(orderBody(MA, { google_place_id: 'PLACE_1' }), async () => gPlace(MA))
  assert.equal(ok.calls.geocode, 0)
  for (const err of [new gp.PlacesError('places_network'), new gp.PlacesError('places_not_configured'), new gp.PlacesError('places_http_503')]) {
    const r = await submit(orderBody(MA, { google_place_id: 'PLACE_1' }), async () => { throw err })
    assert.ok(r.created, 'a Google outage never blocks the food order'); assert.equal(r.calls.geocode, 0)
    assert.deepEqual(geo(r.rpcArgs.p_delivery), [null, null, 'none', 'unresolved'])
    assert.deepEqual([r.rpcArgs.p_delivery.street, r.rpcArgs.p_delivery.house_number], ['רחוב שהוקלד', '99'])
    assert.deepEqual(r.calls.logs, ['google_verify_unavailable'])
  }
  const slow = await submit(orderBody(MA, { google_place_id: 'PLACE_1' }),
    (_id, _c, signal) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(new gp.PlacesError('places_network')))))
  assert.ok(slow.created); assert.deepEqual(slow.calls.logs, ['google_verify_timeout']); assert.equal(slow.calls.geocode, 0)
  const notFound = await submit(orderBody(MA, { google_place_id: 'BOGUS' }), async () => { throw new gp.PlacesError('places_http_404') })
  assert.deepEqual([notFound.resolved.code, notFound.resolved.detail], ['address_not_verified', 'place_not_found'])
})

await test('G13. legacy request without place id still uses the existing Mapbox fallback', async () => {
  const hit = { ok: true, lat: 31.77, lng: 35.29, precision: 'street', source: 'geocoder' }
  const r = await submit(orderBody(MA), async () => { throw new Error('must not be called') }, hit)
  assert.equal(r.calls.lookup, 0); assert.equal(r.calls.geocode, 1)
  assert.deepEqual([r.rpcArgs.p_delivery.street, r.rpcArgs.p_delivery.geo_source], ['רחוב שהוקלד', 'geocoder'])
})

await test('G14. Google key never reaches the browser; UI routes return no coordinates', async () => {
  for (const f of ['app/order/page.tsx', 'app/order/DeliveryAddressPicker.tsx', 'lib/deliveryAddressSelection.ts']) {
    const s = readFileSync(join(ROOT, f), 'utf8')
    assert.ok(!/GOOGLE_PLACES_API_KEY|NEXT_PUBLIC_GOOGLE|places\.googleapis|X-Goog-Api-Key/.test(s), f)
    assert.ok(!/from\s+['"]@\/lib\/(googlePlaces|orderAddress)['"]/.test(s), `${f} must not import server Google modules`)
  }
  const details = readFileSync(join(ROOT, 'app', 'api', 'places', 'details', 'route.ts'), 'utf8')
  assert.ok(details.includes('place: { placeId, city, street, houseNumber, formattedAddress }'), 'details route returns no coordinates')
})

await test('G15. client cannot inject coordinates / verification state / a malformed place id', async () => {
  const bad = [orderBody(MA, { google_place_id: 'P', delivery_lat: 31.7 }), orderBody(MA, { google_place_id: 'P', geo_source: 'geocoder' }),
    orderBody(MA, {}, { googleAddress: { status: 'verified', lat: 31.7, lng: 35.3 } }), orderBody(MA, {}, { google_place_id: 'P' }),
    orderBody(MA, {}, { verifiedPlace: { lat: 1 } })]
  for (const b of bad) assert.equal(parseCreateOrderRequest(b).detail, 'client_geo_not_accepted', JSON.stringify(b).slice(0, 80))
  for (const id of ['../x', 'a b', '', 5, 'x'.repeat(301)]) assert.equal(parseCreateOrderRequest(orderBody(MA, { google_place_id: id })).detail, 'invalid_place_id', String(id))
  const nested = parseCreateOrderRequest(orderBody(MA, { google_place_id: 'P', googleAddress: { status: 'verified', lat: 1, lng: 1 } }))
  assert.ok(nested.ok && !('googleAddress' in nested.value), 'nested verification state is never copied')
})

await test("G16. client cannot spoof city / locality (server compares Google's locality with the selected area)", async () => {
  const r1 = await submit(orderBody(MA, { google_place_id: 'P' }), async () => gPlace('ירושלים'))
  assert.equal(r1.resolved.detail, 'city_mismatch')
  const r2 = await submit(orderBody(MY, { google_place_id: 'P' }), async () => gPlace(MA))
  assert.equal(r2.resolved.detail, 'city_mismatch', "a Ma'ale Adumim place cannot be ordered as מצפה יריחו")
})

await test('G17. pickup unchanged (no Google lookup, no geocoder, cannot carry a place id)', async () => {
  const pickup = { branchId: BRANCH, type: 'pickup', customerName: 'בדיקה בדיקה', phone: '0501234567', paymentMethod: 'cash', items: [{ itemId: ITEM, quantity: 1 }] }
  const r = await submit(pickup, async () => { throw new Error('no') })
  assert.ok(r.created); assert.equal(r.rpcArgs.p_delivery, null); assert.deepEqual([r.calls.lookup, r.calls.geocode], [0, 0])
  assert.equal(parseCreateOrderRequest({ ...pickup, google_place_id: 'P' }).detail, 'client_geo_not_accepted')
})

await test('G18–19. pricing and payment unchanged by the Google path', async () => {
  const g = await submit(orderBody(MY, { google_place_id: 'P' }), async () => gPlace(MY))
  const legacy = await submit(orderBody(MY), async () => null)
  assert.equal(g.rpcArgs.p_order.total_price, legacy.rpcArgs.p_order.total_price); assert.equal(g.rpcArgs.p_order.total_price, 60 + 12 + 40)
  assert.equal(g.rpcArgs.p_delivery.delivery_fee, 40)
  assert.equal(parseCreateOrderRequest(orderBody(MY, { google_place_id: 'P' }, { paymentMethod: 'cash' })).code, 'payment_method_not_allowed')
})

await test('G20. no Maale call / dispatch rows in any Google-path module', async () => {
  for (const f of ['lib/googlePlaces.ts', 'lib/orderAddress.ts', 'lib/deliveryAddressSelection.ts', 'app/order/DeliveryAddressPicker.tsx',
    'app/api/places/autocomplete/route.ts', 'app/api/places/details/route.ts'])
    assert.ok(!/maalehamishlohim|delivery_dispatches|express\/integrations/i.test(readFileSync(join(ROOT, f), 'utf8')), f)
})

console.log(`\nAll ${passed} places-POC checks passed.`)
