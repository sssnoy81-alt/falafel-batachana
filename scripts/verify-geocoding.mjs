// Local checks for server-side delivery geocoding (FALAFEL-SN-08C). Mocked provider / fetch only:
// no network, no DB, no env. Run: node scripts/verify-geocoding.mjs

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
const geo = load('geocoding')
const prov = load('geocodingProvider')
const { parseCreateOrderRequest, buildOrderFromCatalog } = load('orderRequest')
const { attachDeliveryGeo } = load('orderGeo')

let passed = 0
const test = async (name, fn) => { await fn(); passed++; console.log('  ✓', name) }

/* ─── Fixtures ─── */

const BRANCH = cfg.DELIVERY_BRANCH_IDS[0]
const FALAFEL_CAT = '02e0f987-6cce-4a1d-85c6-5ff6f97c80a4'
const ITEM = 'aaaaaaaa-0000-4000-8000-000000000001'
const catalog = {
  items: new Map([[ITEM, { id: ITEM, category_id: FALAFEL_CAT, is_active: true }]]),
  prices: new Map([[ITEM, { item_id: ITEM, price: 20, is_available: true }]]),
  toppings: new Map(),
}
const CITY = 'מעלה אדומים'
const PRIVATE = { name: 'ישראל ישראלי', phone: '0501234567', apartment: '8', floor: '3', entrance: 'ב', notes: 'קוד שער 1234' }
const body = (type, extra = {}, deliveryExtra = {}) => ({
  branchId: BRANCH, type, customerName: PRIVATE.name, phone: PRIVATE.phone,
  paymentMethod: 'credit', items: [{ itemId: ITEM, quantity: 3 }],
  ...(type === 'delivery'
    ? { delivery: { city: CITY, street: 'הדקל', houseNumber: '12', apartment: PRIVATE.apartment, floor: PRIVATE.floor,
        entrance: PRIVATE.entrance, courierNotes: PRIVATE.notes, ...deliveryExtra } }
    : {}),
  ...extra,
})

const STREET_HIT = { lat: 31.77361234, lng: 35.29831299, locality: CITY, level: 'street', partial: false }

/** Mirrors deliveries_geo_* CHECK constraints (08B migration). */
function dbGeoCheck(d) {
  const { delivery_lat: lat, delivery_lng: lng, geo_source: src, geo_precision: prec } = d
  const inRange = (lat === null || (lat >= 29 && lat <= 34)) && (lng === null || (lng >= 34 && lng <= 36))
  const consistent =
    (prec === null && src === null && lat === null && lng === null) ||
    (prec === 'unresolved' && src === 'none' && lat === null && lng === null) ||
    (['street', 'locality'].includes(prec) && ['geocoder', 'manual'].includes(src) && lat !== null && lng !== null)
  return inRange && consistent
}

/** parse → build → attachDeliveryGeo → fake createOrderAtomic (captures the exact RPC args). */
async function placeOrder(reqBody, geocode) {
  const calls = { geocode: 0, logs: [], queries: [] }
  const parsed = parseCreateOrderRequest(reqBody)
  if (!parsed.ok) return { parsed, calls }
  const built = buildOrderFromCatalog(parsed.value, catalog)
  assert.ok(built.ok, JSON.stringify(built))
  const toCreate = await attachDeliveryGeo(parsed.value, built.value, {
    geocode: async input => { calls.geocode++; calls.queries.push(input); return geocode(input) },
    log: code => calls.logs.push(code),
  })
  let rpcArgs = null
  const fakeCreateOrderAtomic = async args => {
    rpcArgs = JSON.parse(JSON.stringify(args)) // what PostgREST would receive
    if (args.p_delivery) assert.ok(dbGeoCheck(args.p_delivery), 'would violate deliveries geo CHECKs')
    return { orderId: 'o1', orderNumber: 1, dailyNumber: 1 }
  }
  const created = await fakeCreateOrderAtomic(toCreate.rpcArgs)
  return { parsed, built, rpcArgs, created, calls }
}

const withProvider = (provider, timeoutMs = 2500) => input =>
  geo.geocodeDeliveryAddress(input, { resolution: { status: 'ready', provider }, timeoutMs })
const providerReturning = r => async () => r
const UNRESOLVED = { delivery_lat: null, delivery_lng: null, geo_source: 'none', geo_precision: 'unresolved' }
const geoOf = d => ({ delivery_lat: d.delivery_lat, delivery_lng: d.delivery_lng, geo_source: d.geo_source, geo_precision: d.geo_precision })

/* ─── Order-creation integration ─── */
console.log('Order creation (parse → build → geocode → create_order args)')

await test('1. pickup: geocoder never called, p_delivery null', async () => {
  const r = await placeOrder(body('pickup', { paymentMethod: 'cash' }), withProvider(providerReturning(STREET_HIT)))
  assert.equal(r.calls.geocode, 0); assert.equal(r.rpcArgs.p_delivery, null); assert.ok(r.created)
})

await test('2. delivery + street match → lat/lng, source=geocoder, precision=street (rounded to 6 dp)', async () => {
  const r = await placeOrder(body('delivery'), withProvider(providerReturning(STREET_HIT)))
  assert.deepEqual(geoOf(r.rpcArgs.p_delivery),
    { delivery_lat: 31.773612, delivery_lng: 35.298313, geo_source: 'geocoder', geo_precision: 'street' })
  assert.ok(geo.AUTO_DISPATCH_PRECISIONS.includes('street'))
})

await test('3. locality-only match → stored as locality (not eligible for auto dispatch)', async () => {
  const r = await placeOrder(body('delivery'), withProvider(providerReturning({ ...STREET_HIT, level: 'locality' })))
  assert.equal(r.rpcArgs.p_delivery.geo_precision, 'locality'); assert.equal(r.rpcArgs.p_delivery.geo_source, 'geocoder')
  assert.ok(!geo.AUTO_DISPATCH_PRECISIONS.includes('locality'))
})

await test('3b. partial street match is downgraded to locality (never street)', async () => {
  const r = await geo.geocodeDeliveryAddress({ city: CITY, street: 'x', houseNumber: '1' },
    { resolution: { status: 'ready', provider: providerReturning({ ...STREET_HIT, partial: true }) } })
  assert.equal(r.precision, 'locality')
})

await test('4. no result → order still created with unresolved/none', async () => {
  const r = await placeOrder(body('delivery'), withProvider(providerReturning(null)))
  assert.ok(r.created); assert.deepEqual(geoOf(r.rpcArgs.p_delivery), UNRESOLVED); assert.deepEqual(r.calls.logs, ['geocode_no_result'])
})

await test('5. timeout → order still created, unresolved, provider aborted, bounded time', async () => {
  let aborted = false
  const slow = (_q, signal) => new Promise(res => {
    signal.addEventListener('abort', () => { aborted = true })
    setTimeout(() => res(STREET_HIT), 300)
  })
  const t0 = Date.now()
  const r = await placeOrder(body('delivery'), withProvider(slow, 30))
  assert.ok(Date.now() - t0 < 250, 'must not wait for the provider')
  assert.ok(r.created); assert.deepEqual(geoOf(r.rpcArgs.p_delivery), UNRESOLVED)
  assert.ok(aborted); assert.deepEqual(r.calls.logs, ['geocode_timeout'])
  assert.equal(geo.GEOCODE_TIMEOUT_MS, 2500)
})

await test('6. provider throws → order still created (provider_error); geocode dep throwing → unresolved', async () => {
  const r = await placeOrder(body('delivery'), withProvider(async () => { throw new Error('boom') }))
  assert.ok(r.created); assert.deepEqual(geoOf(r.rpcArgs.p_delivery), UNRESOLVED); assert.deepEqual(r.calls.logs, ['geocode_provider_error'])
  const r2 = await placeOrder(body('delivery'), () => { throw new Error('bug') })
  assert.ok(r2.created); assert.deepEqual(geoOf(r2.rpcArgs.p_delivery), UNRESOLVED); assert.deepEqual(r2.calls.logs, ['geocode_internal_error'])
})

const reasonFor = async hit => (await withProvider(providerReturning(hit))({ city: CITY, street: 'הדקל', houseNumber: '12' })).reason

await test('7. invalid latitude (NaN / Infinity / string / null / out of range) → invalid_coordinates', async () => {
  for (const lat of [NaN, Infinity, '31.77', null, undefined, 40, 28.9]) assert.equal(await reasonFor({ ...STREET_HIT, lat }), 'invalid_coordinates', String(lat))
})

await test('8. invalid longitude → invalid_coordinates', async () => {
  for (const lng of [NaN, -Infinity, '35.29', null, 33.9, 36.1]) assert.equal(await reasonFor({ ...STREET_HIT, lng }), 'invalid_coordinates', String(lng))
})

await test('9. swapped / obviously wrong coordinates → invalid_coordinates', async () => {
  assert.equal(await reasonFor({ ...STREET_HIT, lat: 35.29831299, lng: 31.77361234 }), 'invalid_coordinates')
  assert.equal(await reasonFor({ ...STREET_HIT, lat: 0, lng: 0 }), 'invalid_coordinates')
  assert.equal(await reasonFor({ ...STREET_HIT, lat: 40.7, lng: -74 }), 'invalid_coordinates')
})

await test('10. locality mismatch (other city / other delivery area / none) → unresolved', async () => {
  for (const locality of ['ירושלים', 'כפר אדומים', 'Jerusalem', null, '']) assert.equal(await reasonFor({ ...STREET_HIT, locality }), 'locality_mismatch', String(locality))
  const r = await placeOrder(body('delivery'), withProvider(providerReturning({ ...STREET_HIT, locality: 'ירושלים' })))
  assert.ok(r.created); assert.deepEqual(geoOf(r.rpcArgs.p_delivery), UNRESOLVED)
})

await test('10b. locality normalization: harmless variants only, every delivery area has aliases', async () => {
  for (const v of ["Ma'ale Adumim", 'maale-adumim', 'MA’ALE ADUMIM', 'מעלה  אדומים', 'מעלה־אדומים', ' מעלה אדומים '])
    assert.ok(geo.localityMatches(CITY, v), v)
  for (const v of ['Maale', 'Adumim', 'מעלה', 'Maale Adumim Industrial', 'מעלה אדומים 2'])
    assert.ok(!geo.localityMatches(CITY, v), v)
  assert.ok(geo.localityMatches('מצפה יריחו', 'Mitzpe Yericho')); assert.ok(geo.localityMatches('נופי פרת', 'Nofei Prat'))
  assert.ok(!geo.localityMatches('ירושלים', 'ירושלים'), 'non-delivery city never matches')
  assert.deepEqual(geo.areasWithoutAliases(), [])
})

await test('10c. coarser-than-locality result → insufficient_precision', async () => {
  assert.equal(await reasonFor({ ...STREET_HIT, level: 'other' }), 'insufficient_precision')
})

await test('11. missing / disabled / unknown provider env → unresolved, no fetch', async () => {
  let fetches = 0
  const f = async () => { fetches++; throw new Error('no network in tests') }
  assert.equal(prov.resolveGeocodingProvider({}, f).status, 'disabled')
  assert.equal(prov.resolveGeocodingProvider({ GEOCODING_PROVIDER: 'none', GEOCODING_API_KEY: 'k' }, f).status, 'disabled')
  assert.equal(prov.resolveGeocodingProvider({ GEOCODING_PROVIDER: 'google' }, f).status, 'not_configured')
  assert.equal(prov.resolveGeocodingProvider({ GEOCODING_PROVIDER: 'google', GEOCODING_API_KEY: '  ' }, f).status, 'not_configured')
  assert.equal(prov.resolveGeocodingProvider({ GEOCODING_PROVIDER: 'mapbox', GEOCODING_API_KEY: 'k' }, f).status, 'not_configured')
  assert.equal(prov.resolveGeocodingProvider({ GEOCODING_PROVIDER: 'Google', GEOCODING_API_KEY: 'k' }, f).status, 'ready')
  assert.equal(prov.resolveGeocodingProvider({ NEXT_PUBLIC_GEOCODING_API_KEY: 'k', GEOCODING_PROVIDER: 'google' }, f).status, 'not_configured')
  for (const env of [{}, { GEOCODING_PROVIDER: 'google' }]) {
    const r = await placeOrder(body('delivery'), input => geo.geocodeDeliveryAddress(input, { resolution: prov.resolveGeocodingProvider(env, f) }))
    assert.ok(r.created); assert.deepEqual(geoOf(r.rpcArgs.p_delivery), UNRESOLVED); assert.deepEqual(r.calls.logs, [], 'quiet when not enabled')
  }
  assert.equal(fetches, 0)
})

await test('12. browser-sent coordinates are rejected (top level and inside delivery), server values cannot be overridden', async () => {
  const cases = [
    body('delivery', {}, { lat: 31.7, lng: 35.3 }),
    body('delivery', {}, { delivery_lat: 31.7 }),
    body('delivery', {}, { geo_precision: 'street' }),
    body('delivery', {}, { geoSource: 'manual' }),
    body('delivery', { delivery_lat: 31.7, delivery_lng: 35.3 }),
    body('delivery', { coordinates: [35.3, 31.7] }),
    body('pickup', { paymentMethod: 'cash', latitude: 31.7 }),
  ]
  for (const b of cases) {
    const p = parseCreateOrderRequest(b)
    assert.deepEqual({ ok: p.ok, code: p.code, detail: p.detail }, { ok: false, code: 'invalid_request', detail: 'client_geo_not_accepted' })
  }
  // Without browser keys, the built order carries the explicit unresolved default until the server geocodes.
  const built = buildOrderFromCatalog(parseCreateOrderRequest(body('delivery')).value, catalog)
  assert.deepEqual(geoOf(built.value.rpcArgs.p_delivery), UNRESOLVED)
})

await test('13. pricing unchanged by geocoding outcome (success vs failure identical money + address fields)', async () => {
  const ok = await placeOrder(body('delivery'), withProvider(providerReturning(STREET_HIT)))
  const bad = await placeOrder(body('delivery'), withProvider(providerReturning(null)))
  const GEO_KEYS = ['delivery_lat', 'delivery_lng', 'geo_source', 'geo_precision']
  const strip = d => Object.fromEntries(Object.entries(d).filter(([k]) => !GEO_KEYS.includes(k)))
  assert.deepEqual(strip(ok.rpcArgs.p_delivery), strip(bad.rpcArgs.p_delivery))
  assert.deepEqual(ok.rpcArgs.p_order, bad.rpcArgs.p_order); assert.deepEqual(ok.rpcArgs.p_items, bad.rpcArgs.p_items)
  assert.equal(ok.rpcArgs.p_order.total_price, 92)
  assert.deepEqual([ok.rpcArgs.p_delivery.delivery_fee, ok.rpcArgs.p_delivery.meal_surcharge, ok.rpcArgs.p_delivery.meal_quantity], [20, 12, 3])
})

/* ─── create_order input (Part O) ─── */
console.log('create_order input')

await test('O1. success sends delivery_lat / delivery_lng / geo_source / geo_precision as JSON values', async () => {
  const r = await placeOrder(body('delivery'), withProvider(providerReturning(STREET_HIT)))
  const d = r.rpcArgs.p_delivery
  for (const k of ['delivery_lat', 'delivery_lng', 'geo_source', 'geo_precision']) assert.ok(k in d, k)
  assert.equal(typeof d.delivery_lat, 'number'); assert.equal(typeof d.delivery_lng, 'number')
})

await test('O2. failure sends explicit null / null / none / unresolved (keys present, JSON null)', async () => {
  const r = await placeOrder(body('delivery'), withProvider(providerReturning(null)))
  const json = JSON.stringify(r.rpcArgs.p_delivery)
  assert.ok(json.includes('"delivery_lat":null') && json.includes('"delivery_lng":null'))
  assert.ok(json.includes('"geo_source":"none"') && json.includes('"geo_precision":"unresolved"'))
})

/* ─── Privacy ─── */
console.log('Privacy')

await test('P1. geocoder input is only city / street / house number (no name, phone, apartment, floor, entrance, notes)', async () => {
  const seen = []
  await placeOrder(body('delivery'), withProvider(async q => { seen.push(q); return STREET_HIT }))
  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0], { text: `הדקל 12, ${CITY}, Israel`, city: CITY, street: 'הדקל', houseNumber: '12' })
  const all = JSON.stringify(seen[0])
  for (const v of Object.values(PRIVATE)) assert.ok(!all.includes(v), `leaked ${v}`)
})

await test('P2. logs carry codes only (no address / name / phone)', async () => {
  const r = await placeOrder(body('delivery'), withProvider(providerReturning({ ...STREET_HIT, locality: 'ירושלים' })))
  assert.deepEqual(r.calls.logs, ['geocode_locality_mismatch'])
  for (const l of r.calls.logs) assert.match(l, /^geocode_[a-z_]+$/)
})

/* ─── Google adapter (fixtures + mocked fetch; NOT enabled) ─── */
console.log('Google adapter (fixtures only)')

const gResult = (over = {}) => ({
  types: ['street_address'], partial_match: undefined,
  geometry: { location: { lat: 31.7736, lng: 35.2983 }, location_type: 'ROOFTOP' },
  address_components: [{ long_name: '12', types: ['street_number'] }, { long_name: CITY, types: ['locality', 'political'] }],
  ...over,
})

await test('G1. response mapping: street / approximate / locality / country / partial / zero / error', async () => {
  const m = prov.mapGoogleGeocodeResponse
  assert.equal(m({ status: 'OK', results: [gResult()] }).level, 'street')
  assert.equal(m({ status: 'OK', results: [gResult({ geometry: { location: { lat: 31.77, lng: 35.29 }, location_type: 'APPROXIMATE' } })] }).level, 'locality')
  assert.equal(m({ status: 'OK', results: [gResult({ types: ['locality', 'political'], geometry: { location: { lat: 31.77, lng: 35.29 }, location_type: 'APPROXIMATE' } })] }).level, 'locality')
  assert.equal(m({ status: 'OK', results: [gResult({ types: ['country', 'political'], address_components: [] })] }).level, 'other')
  assert.equal(m({ status: 'OK', results: [gResult({ partial_match: true })] }).partial, true)
  assert.equal(m({ status: 'OK', results: [gResult()] }).locality, CITY)
  assert.equal(m({ status: 'ZERO_RESULTS', results: [] }), null)
  assert.throws(() => m({ status: 'REQUEST_DENIED', error_message: 'secret detail' }), /google_status_not_ok/)
  assert.throws(() => m('nope'), /google_bad_body/)
})

await test('G2. request built server-side: Israel-restricted, Hebrew, key only in the outgoing URL, abort signal passed', async () => {
  const seen = []
  const fakeFetch = async (url, init) => { seen.push({ url, init }); return { ok: true, status: 200, json: async () => ({ status: 'OK', results: [gResult()] }) } }
  const resolution = prov.resolveGeocodingProvider({ GEOCODING_PROVIDER: 'google', GEOCODING_API_KEY: 'test-key-not-real' }, fakeFetch)
  const r = await geo.geocodeDeliveryAddress({ city: CITY, street: 'הדקל', houseNumber: '12' }, { resolution })
  assert.equal(r.ok, true); assert.equal(r.precision, 'street')
  const u = new URL(seen[0].url)
  assert.equal(u.origin + u.pathname, 'https://maps.googleapis.com/maps/api/geocode/json')
  assert.equal(u.searchParams.get('address'), `הדקל 12, ${CITY}, Israel`)
  assert.equal(u.searchParams.get('components'), 'country:IL'); assert.equal(u.searchParams.get('language'), 'he')
  assert.equal(u.searchParams.get('key'), 'test-key-not-real')
  assert.ok(seen[0].init.signal instanceof AbortSignal); assert.equal(seen[0].init.cache, 'no-store')
})

await test('G3. HTTP error / REQUEST_DENIED → provider_error (soft), error text carries no key or URL', async () => {
  const key = 'test-key-not-real'
  for (const res of [{ ok: false, status: 500, json: async () => ({}) }, { ok: true, status: 200, json: async () => ({ status: 'REQUEST_DENIED' }) }]) {
    let caught
    const provider = prov.googleProvider(key, async () => res)
    try { await provider({ text: 'x', city: CITY, street: 'x', houseNumber: '1' }, new AbortController().signal) } catch (e) { caught = e }
    assert.ok(caught && !String(caught.message).includes(key) && !String(caught.message).includes('http'.concat('s://')))
    const r = await geo.geocodeDeliveryAddress({ city: CITY, street: 'x', houseNumber: '1' }, { resolution: { status: 'ready', provider } })
    assert.equal(r.reason, 'provider_error')
  }
})

/* ─── Static guards ─── */
console.log('Static guards')

await test('S1. no NEXT_PUBLIC geocoding key; provider module not imported by client code', async () => {
  const provSrc = readFileSync(join(LIB, 'geocodingProvider.ts'), 'utf8')
  assert.ok(!/NEXT_PUBLIC/.test(provSrc.replace(/\/\/.*$/gm, '')))
  for (const f of ['app/order/page.tsx', 'app/dashboard/orders/page.tsx', 'lib/geocoding.ts', 'lib/orderRequest.ts']) {
    const src = readFileSync(join(ROOT, f), 'utf8')
    assert.ok(!/from\s+['"][^'"]*(geocodingProvider|orderGeo)['"]/.test(src), f)
  }
  const route = readFileSync(join(ROOT, 'app', 'api', 'orders', 'route.ts'), 'utf8')
  const geoAt = route.indexOf('attachDeliveryGeo(order'), createAt = route.indexOf('createOrderAtomic(toCreate.rpcArgs)')
  assert.ok(geoAt > 0 && createAt > geoAt, 'route geocodes before create_order and creates with the geocoded args')
})

console.log(`\nAll ${passed} geocoding checks passed.`)
