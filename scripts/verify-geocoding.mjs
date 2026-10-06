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
const loc = load('deliveryLocation')
const areas = load('deliveryAreasGeo')

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

const STREET_HIT = { lat: 31.77361234, lng: 35.29831299, localities: [CITY], level: 'street', partial: false }

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
  for (const localities of [['ירושלים'], ['כפר אדומים'], ['Jerusalem'], [], ['']]) assert.equal(await reasonFor({ ...STREET_HIT, localities }), 'locality_mismatch', String(localities))
  const r = await placeOrder(body('delivery'), withProvider(providerReturning({ ...STREET_HIT, localities: ['ירושלים'] })))
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
  assert.equal(prov.resolveGeocodingProvider({ GEOCODING_PROVIDER: 'mapbox' }, f).status, 'not_configured')
  assert.equal(prov.resolveGeocodingProvider({ GEOCODING_PROVIDER: 'mapbox', GEOCODING_API_KEY: '  ' }, f).status, 'not_configured')
  assert.equal(prov.resolveGeocodingProvider({ GEOCODING_PROVIDER: 'google', GEOCODING_API_KEY: 'k' }, f).status, 'not_configured', 'google is deliberately unsupported')
  assert.equal(prov.resolveGeocodingProvider({ GEOCODING_PROVIDER: 'Mapbox', GEOCODING_API_KEY: 'k' }, f).status, 'ready')
  assert.equal(prov.resolveGeocodingProvider({ NEXT_PUBLIC_GEOCODING_API_KEY: 'k', GEOCODING_PROVIDER: 'mapbox' }, f).status, 'not_configured')
  for (const env of [{}, { GEOCODING_PROVIDER: 'mapbox' }, { GEOCODING_PROVIDER: 'google', GEOCODING_API_KEY: 'k' }]) {
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
  assert.equal(ok.rpcArgs.p_order.total_price, 97)
  assert.deepEqual([ok.rpcArgs.p_delivery.delivery_fee, ok.rpcArgs.p_delivery.meal_surcharge, ok.rpcArgs.p_delivery.meal_quantity], [25, 12, 3])
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
  const r = await placeOrder(body('delivery'), withProvider(providerReturning({ ...STREET_HIT, localities: ['ירושלים'] })))
  assert.deepEqual(r.calls.logs, ['geocode_locality_mismatch'])
  for (const l of r.calls.logs) assert.match(l, /^geocode_[a-z_]+$/)
})

/* ─── Mapbox Geocoding v6 adapter (fixtures + mocked fetch; NOT enabled) ─── */
console.log('Mapbox v6 adapter (fixtures only)')

const TOKEN = 'pk.test-token-not-real'
const ADDR = { city: CITY, street: 'הדקל', houseNumber: '12' }
const mbFeature = (over = {}) => {
  const base = {
    feature_type: 'address', name: 'הדקל 12', full_address: `הדקל 12, ${CITY}, ישראל`,
    coordinates: { longitude: 35.29831299, latitude: 31.77361234, accuracy: 'rooftop' },
    context: {
      address: { name: 'הדקל 12', address_number: '12', street_name: 'הדקל' },
      street: { name: 'הדקל' }, place: { name: CITY }, country: { name: 'ישראל', country_code: 'IL' },
    },
    match_code: { address_number: 'matched', street: 'matched', place: 'matched', country: 'matched', confidence: 'exact' },
  }
  return { type: 'Feature', geometry: { type: 'Point', coordinates: [35.29831299, 31.77361234] }, properties: { ...base, ...over } }
}
const fc = (...features) => ({ type: 'FeatureCollection', features, attribution: 'test' })
const jsonRes = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

/** Runs the real adapter through the domain entry point with a fake fetch; records requested URLs. */
async function mapboxRun(respond, timeoutMs) {
  const urls = []
  const fakeFetch = async (url, init) => { urls.push(url); return respond(url, init) }
  const resolution = prov.resolveGeocodingProvider({ GEOCODING_PROVIDER: 'mapbox', GEOCODING_API_KEY: TOKEN }, fakeFetch)
  assert.equal(resolution.status, 'ready')
  const result = await geo.geocodeDeliveryAddress(ADDR, { resolution, timeoutMs })
  return { result, urls }
}

await test('M1. exact address success → ok, street precision, coordinates from properties (rounded)', async () => {
  const { result } = await mapboxRun(() => jsonRes(fc(mbFeature())))
  assert.deepEqual(result, { ok: true, lat: 31.773612, lng: 35.298313, precision: 'street', source: 'geocoder' })
})

await test('M2. street precision only for a confirmed house-level match; weaker address matches → locality', async () => {
  assert.equal((await mapboxRun(() => jsonRes(fc(mbFeature({ coordinates: { longitude: 35.2983, latitude: 31.7736, accuracy: 'interpolated' } }))))).result.precision, 'street')
  const weaker = [
    { coordinates: { longitude: 35.2983, latitude: 31.7736, accuracy: 'approximate' } },
    { coordinates: { longitude: 35.2983, latitude: 31.7736 } },
    { match_code: { address_number: 'unmatched', street: 'matched', confidence: 'medium' } },
    { match_code: { address_number: 'inferred', street: 'matched', confidence: 'high' } },
    { match_code: { address_number: 'matched', street: 'unmatched', confidence: 'high' } },
    { match_code: { address_number: 'matched', street: 'matched', confidence: 'low' } },
    { feature_type: 'street', name: 'הדקל' },
  ]
  for (const over of weaker) assert.equal((await mapboxRun(() => jsonRes(fc(mbFeature(over))))).result.precision, 'locality', JSON.stringify(over))
})

await test('M3. locality-only result (place feature, or locality inside the place) → locality', async () => {
  const placeOnly = mbFeature({ feature_type: 'place', name: CITY, context: { country: { name: 'ישראל' } }, match_code: undefined })
  assert.equal((await mapboxRun(() => jsonRes(fc(placeOnly)))).result.precision, 'locality')
  const loc = mbFeature({ feature_type: 'locality', name: 'שכונה', context: { place: { name: CITY } }, match_code: undefined })
  assert.equal((await mapboxRun(() => jsonRes(fc(loc)))).result.precision, 'locality')
  const region = mbFeature({ feature_type: 'region', name: 'אזור', context: { place: { name: CITY } } })
  assert.equal((await mapboxRun(() => jsonRes(fc(region)))).result.reason, 'insufficient_precision')
})

await test('M4. wrong locality (other city / other delivery area / none) → locality_mismatch', async () => {
  for (const context of [{ place: { name: 'ירושלים' } }, { place: { name: 'כפר אדומים' } }, {}, { place: { name: '' } }]) {
    const { result } = await mapboxRun(() => jsonRes(fc(mbFeature({ context }))))
    assert.equal(result.reason, 'locality_mismatch', JSON.stringify(context))
  }
  // matching via context.locality (e.g. a settlement reported as locality under another place)
  const viaLocality = mbFeature({ context: { place: { name: 'ירושלים' }, locality: { name: CITY } } })
  assert.equal((await mapboxRun(() => jsonRes(fc(viaLocality)))).result.precision, 'street')
})

await test('M5. invalid / swapped / missing coordinates → invalid_coordinates; geometry fallback works', async () => {
  const bad = [
    { coordinates: { longitude: 31.77361234, latitude: 35.29831299, accuracy: 'rooftop' } }, // swapped
    { coordinates: { longitude: '35.29', latitude: '31.77', accuracy: 'rooftop' } },
    { coordinates: { longitude: 0, latitude: 0, accuracy: 'rooftop' } },
  ]
  for (const over of bad) assert.equal((await mapboxRun(() => jsonRes(fc(mbFeature(over))))).result.reason, 'invalid_coordinates', JSON.stringify(over))
  const noCoords = mbFeature({ coordinates: undefined }); noCoords.geometry = { type: 'Point', coordinates: [] }
  assert.equal((await mapboxRun(() => jsonRes(fc(noCoords)))).result.reason, 'invalid_coordinates')
  const geometryOnly = mbFeature({ coordinates: undefined })
  const r = (await mapboxRun(() => jsonRes(fc(geometryOnly)))).result
  assert.equal(r.ok, true); assert.equal(r.lat, 31.773612); assert.equal(r.precision, 'locality', 'no accuracy → not street')
})

await test('M6. no results → no_result', async () => {
  assert.equal((await mapboxRun(() => jsonRes(fc()))).result.reason, 'no_result')
})

await test('M7. HTTP 4xx (401 / 403 / 422 / 429) → provider_error', async () => {
  for (const status of [401, 403, 422, 429]) assert.equal((await mapboxRun(() => jsonRes({ message: 'Not Authorized - Invalid Token' }, status))).result.reason, 'provider_error', String(status))
})

await test('M8. HTTP 5xx → provider_error', async () => {
  for (const status of [500, 502, 503]) assert.equal((await mapboxRun(() => jsonRes({}, status))).result.reason, 'provider_error', String(status))
})

await test('M9. malformed JSON / non-FeatureCollection body / network error → provider_error', async () => {
  const badJson = { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <') } }
  assert.equal((await mapboxRun(() => badJson)).result.reason, 'provider_error')
  assert.equal((await mapboxRun(() => jsonRes({ message: 'oops' }))).result.reason, 'provider_error')
  assert.equal((await mapboxRun(() => jsonRes(fc('not-a-feature')))).result.reason, 'provider_error')
  assert.equal((await mapboxRun(() => { throw new TypeError('fetch failed') })).result.reason, 'provider_error')
})

await test('M10. timeout → timeout (request aborted, bounded)', async () => {
  let aborted = false
  const hang = (_url, init) => new Promise((_res, rej) => {
    init.signal.addEventListener('abort', () => { aborted = true; rej(new Error('aborted')) })
  })
  const t0 = Date.now()
  const { result } = await mapboxRun(hang, 30)
  assert.equal(result.reason, 'timeout'); assert.ok(aborted); assert.ok(Date.now() - t0 < 250)
})

await test('M11. access token never appears in thrown errors or order logs', async () => {
  const provider = prov.mapboxProvider(TOKEN, async url => { throw new Error(`request to ${url} failed`) })
  const failing = [
    async url => { throw new Error(`request to ${url} failed`) },
    async () => jsonRes({ message: `Invalid token ${TOKEN}` }, 401),
    async () => ({ ok: true, status: 200, json: async () => { throw new Error(`bad json ${TOKEN}`) } }),
    async () => jsonRes({ message: TOKEN }),
  ]
  for (const f of [provider, ...failing.map(ff => prov.mapboxProvider(TOKEN, ff))]) {
    let caught
    try { await f({ text: 'x', city: CITY, street: 'x', houseNumber: '1' }, new AbortController().signal) } catch (e) { caught = e }
    assert.ok(caught, 'must throw')
    const text = `${caught.name} ${caught.message} ${caught.stack ?? ''}`
    assert.ok(!text.includes(TOKEN) && !text.includes('access_token') && !text.includes('api.mapbox.com'), text.slice(0, 80))
    assert.match(caught.message, /^mapbox_[a-z0-9_]+$/)
  }
  const resolution = prov.resolveGeocodingProvider({ GEOCODING_PROVIDER: 'mapbox', GEOCODING_API_KEY: TOKEN }, async () => jsonRes({}, 401))
  const r = await placeOrder(body('delivery'), input => geo.geocodeDeliveryAddress(input, { resolution }))
  assert.deepEqual(r.calls.logs, ['geocode_provider_error'])
})

await test('M12–16. every request: permanent=true, country=il, language=he, autocomplete=false, limit=1 (not overridable)', async () => {
  const { urls } = await mapboxRun(() => jsonRes(fc(mbFeature())))
  assert.equal(urls.length, 1)
  const u = new URL(urls[0])
  assert.equal(u.origin + u.pathname, 'https://api.mapbox.com/search/geocode/v6/forward')
  assert.deepEqual(u.searchParams.getAll('permanent'), ['true'])
  assert.deepEqual(u.searchParams.getAll('country'), ['il'])
  assert.deepEqual(u.searchParams.getAll('language'), ['he'])
  assert.deepEqual(u.searchParams.getAll('autocomplete'), ['false'])
  assert.deepEqual(u.searchParams.getAll('limit'), ['1'])
  assert.equal(u.searchParams.get('access_token'), TOKEN)
  assert.ok(Object.isFrozen(prov.MAPBOX_FIXED_PARAMS))
  const evil = new URL(prov.buildMapboxForwardUrl({ text: 'x&permanent=false&country=us', city: CITY, street: 'x', houseNumber: '1' }, TOKEN))
  assert.deepEqual(evil.searchParams.getAll('permanent'), ['true']); assert.deepEqual(evil.searchParams.getAll('country'), ['il'])
  assert.equal(evil.searchParams.get('q'), 'x&permanent=false&country=us')
})

await test('M17. query contains only street / house number / city / Israel — no other PII', async () => {
  const urls = []
  const resolution = prov.resolveGeocodingProvider({ GEOCODING_PROVIDER: 'mapbox', GEOCODING_API_KEY: TOKEN },
    async url => { urls.push(url); return jsonRes(fc(mbFeature())) })
  await placeOrder(body('delivery'), input => geo.geocodeDeliveryAddress(input, { resolution }))
  const u = new URL(urls[0])
  assert.equal(u.searchParams.get('q'), `הדקל 12, ${CITY}, Israel`)
  assert.deepEqual([...u.searchParams.keys()].sort(), ['access_token', 'autocomplete', 'country', 'language', 'limit', 'permanent', 'q'])
  const decoded = decodeURIComponent(urls[0])
  for (const v of Object.values(PRIVATE)) assert.ok(!decoded.includes(v), `leaked ${v}`)
})

await test('M18. order creation stays intact: Mapbox failure → unresolved order; success → street coordinates stored', async () => {
  const mk = f => { const resolution = prov.resolveGeocodingProvider({ GEOCODING_PROVIDER: 'mapbox', GEOCODING_API_KEY: TOKEN }, f); return input => geo.geocodeDeliveryAddress(input, { resolution }) }
  for (const f of [async () => jsonRes({}, 503), async () => { throw new Error('down') }, async () => jsonRes(fc())]) {
    const r = await placeOrder(body('delivery'), mk(f))
    assert.ok(r.created); assert.deepEqual(geoOf(r.rpcArgs.p_delivery), UNRESOLVED); assert.equal(r.rpcArgs.p_order.total_price, 97)
  }
  const ok = await placeOrder(body('delivery'), mk(async () => jsonRes(fc(mbFeature()))))
  assert.deepEqual(geoOf(ok.rpcArgs.p_delivery), { delivery_lat: 31.773612, delivery_lng: 35.298313, geo_source: 'geocoder', geo_precision: 'street' })
  const pickup = await placeOrder(body('pickup', { paymentMethod: 'cash' }), mk(async () => { throw new Error('must not be called') }))
  assert.equal(pickup.calls.geocode, 0); assert.equal(pickup.rpcArgs.p_delivery, null)
})

/* ─── Customer device location (08D1) ─── */
console.log('Device location (08D1)')

// A real-looking fix far from STREET_HIT, so "which source won" is unambiguous.
const DEVICE = { location_lat: 31.80123456, location_lng: 35.33987654, location_accuracy: 18, location_confirmed: true }
const DEVICE_GEO = { delivery_lat: 31.801235, delivery_lng: 35.339877, geo_source: 'manual', geo_precision: 'street' }
const parseLoc = extra => parseCreateOrderRequest(body('delivery', {}, extra))
const rejected = r => ({ ok: r.ok, code: r.code, detail: r.detail })
const INVALID_LOCATION = { ok: false, code: 'invalid_request', detail: 'invalid_location' }

await test('DL1–2. valid confirmed device location → stored as manual / street with device coordinates', async () => {
  const r = await placeOrder(body('delivery', {}, DEVICE), withProvider(providerReturning(STREET_HIT)))
  assert.ok(r.created); assert.deepEqual(geoOf(r.rpcArgs.p_delivery), DEVICE_GEO)
  assert.ok(loc.hasPreciseCoordinates(r.rpcArgs.p_delivery))
})

await test('DL3–4. device location overrides Mapbox and the geocoder is never called', async () => {
  const r = await placeOrder(body('delivery', {}, DEVICE), withProvider(providerReturning(STREET_HIT)))
  assert.equal(r.calls.geocode, 0); assert.deepEqual(r.calls.logs, [])
  assert.notEqual(r.rpcArgs.p_delivery.delivery_lat, 31.773612)
})

await test('DL5. valid coordinates parse to the server-side deliveryLocation (address kept separately)', async () => {
  const p = parseLoc(DEVICE)
  assert.ok(p.ok); assert.deepEqual(p.value.deliveryLocation, { lat: 31.80123456, lng: 35.33987654, accuracy: 18 })
  assert.deepEqual(Object.keys(p.value.delivery).filter(k => k.startsWith('location')), [], 'parsed address carries no location keys')
  assert.equal(p.value.delivery.street, 'הדקל')
})

await test('DL6. invalid latitude rejected (out of range / NaN / Infinity / null)', async () => {
  for (const v of [40, 28.9, NaN, Infinity, null]) assert.deepEqual(rejected(parseLoc({ ...DEVICE, location_lat: v })), INVALID_LOCATION, String(v))
})

await test('DL7. invalid longitude rejected; swapped coordinates rejected', async () => {
  for (const v of [36.1, 33.9, -Infinity, NaN]) assert.deepEqual(rejected(parseLoc({ ...DEVICE, location_lng: v })), INVALID_LOCATION, String(v))
  assert.deepEqual(rejected(parseLoc({ ...DEVICE, location_lat: 35.33, location_lng: 31.80 })), INVALID_LOCATION)
})

await test('DL8. string coordinates / accuracy rejected', async () => {
  for (const over of [{ location_lat: '31.8' }, { location_lng: '35.3' }, { location_accuracy: '18' }])
    assert.deepEqual(rejected(parseLoc({ ...DEVICE, ...over })), INVALID_LOCATION, JSON.stringify(over))
})

await test('DL9–10. only latitude / only longitude rejected', async () => {
  const { location_lng, ...onlyLat } = DEVICE
  const { location_lat, ...onlyLng } = DEVICE
  assert.deepEqual(rejected(parseLoc(onlyLat)), INVALID_LOCATION); assert.deepEqual(rejected(parseLoc(onlyLng)), INVALID_LOCATION)
  assert.ok(location_lat && location_lng)
})

await test('DL11. confirmed must be exactly true (false / missing / "true" rejected)', async () => {
  const { location_confirmed, ...unconfirmed } = DEVICE
  assert.ok(location_confirmed)
  for (const d of [{ ...DEVICE, location_confirmed: false }, { ...DEVICE, location_confirmed: 'true' }, unconfirmed])
    assert.deepEqual(rejected(parseLoc(d)), INVALID_LOCATION)
})

await test('DL12. poor accuracy (> 100 m) is valid input but NOT trusted → Mapbox fallback, code-only log', async () => {
  for (const a of [100.5, 500, 5000]) {
    const r = await placeOrder(body('delivery', {}, { ...DEVICE, location_accuracy: a }), withProvider(providerReturning(STREET_HIT)))
    assert.ok(r.created); assert.equal(r.calls.geocode, 1)
    assert.equal(r.rpcArgs.p_delivery.geo_source, 'geocoder'); assert.deepEqual(r.calls.logs, ['location_low_accuracy'])
  }
  const none = await placeOrder(body('delivery', {}, { ...DEVICE, location_accuracy: 800 }), withProvider(providerReturning(null)))
  assert.ok(none.created); assert.deepEqual(geoOf(none.rpcArgs.p_delivery), UNRESOLVED)
  for (const a of [0, -5, NaN, 20000]) assert.deepEqual(rejected(parseLoc({ ...DEVICE, location_accuracy: a })), INVALID_LOCATION, String(a))
})

await test('DL13. good accuracy (≤ 100 m, boundary included) trusted', async () => {
  for (const a of [3, 50, 100]) {
    const r = await placeOrder(body('delivery', {}, { ...DEVICE, location_accuracy: a }), withProvider(providerReturning(STREET_HIT)))
    assert.equal(r.rpcArgs.p_delivery.geo_source, 'manual', String(a)); assert.equal(r.calls.geocode, 0)
  }
  assert.equal(loc.DEVICE_LOCATION_MAX_ACCURACY_M, 100)
})

await test('DL14. permission denied: client sends no location, order still created via address', async () => {
  assert.equal(loc.classifyGeolocationError(1), 'denied')
  assert.deepEqual(loc.deliveryLocationWireFields(null), {})
  const r = await placeOrder(body('delivery', {}, loc.deliveryLocationWireFields(null)), withProvider(providerReturning(STREET_HIT)))
  assert.ok(r.created); assert.equal(r.calls.geocode, 1); assert.equal(r.rpcArgs.p_delivery.geo_precision, 'street')
})

await test('DL15. unavailable / timeout / inaccurate / garbage fix: nothing sent, order still created', async () => {
  assert.equal(loc.classifyGeolocationError(2), 'unavailable'); assert.equal(loc.classifyGeolocationError(3), 'unavailable')
  assert.deepEqual(loc.evaluateDevicePosition({ latitude: 31.8, longitude: 35.34, accuracy: 900 }), { state: 'inaccurate', location: null })
  assert.deepEqual(loc.evaluateDevicePosition({ latitude: NaN, longitude: 35.34, accuracy: 10 }), { state: 'unavailable', location: null })
  assert.deepEqual(loc.evaluateDevicePosition({ latitude: 31.8, longitude: 35.34, accuracy: 12 }),
    { state: 'success', location: { lat: 31.8, lng: 35.34, accuracy: 12 } })
  const r = await placeOrder(body('delivery'), withProvider(providerReturning(null)))
  assert.ok(r.created); assert.deepEqual(geoOf(r.rpcArgs.p_delivery), UNRESOLVED)
})

await test('DL15b. client wire fields for a captured fix are exactly the four location_* keys', async () => {
  const w = loc.deliveryLocationWireFields({ lat: 31.8, lng: 35.34, accuracy: 12 })
  assert.deepEqual(w, { location_lat: 31.8, location_lng: 35.34, location_accuracy: 12, location_confirmed: true })
  assert.ok(parseLoc(w).ok)
})

await test('DL16–17. direct delivery_lat / geo_source still rejected (even alongside a valid device location)', async () => {
  for (const over of [{ delivery_lat: 31.8 }, { delivery_lng: 35.3 }, { geo_source: 'manual' }, { geo_precision: 'street' }, { lat: 31.8 }])
    assert.deepEqual(rejected(parseLoc({ ...DEVICE, ...over })), { ok: false, code: 'invalid_request', detail: 'client_geo_not_accepted' }, JSON.stringify(over))
  for (const over of [{ geo_source: 'manual' }, { dispatch_eligible: true }]) {
    const p = parseCreateOrderRequest(body('delivery', over, DEVICE))
    if (over.geo_source) assert.equal(p.detail, 'client_geo_not_accepted')
    else assert.ok(p.ok && !('dispatch_eligible' in p.value), 'unknown keys are never copied')
  }
})

await test('DL18. pickup cannot submit location (top level or via a delivery object)', async () => {
  for (const extra of [{ location_lat: 31.8, location_lng: 35.3, location_accuracy: 10, location_confirmed: true }, { location_confirmed: true }]) {
    assert.deepEqual(rejected(parseCreateOrderRequest(body('pickup', { paymentMethod: 'cash', ...extra }))),
      { ok: false, code: 'invalid_request', detail: 'client_geo_not_accepted' })
  }
  assert.deepEqual(rejected(parseCreateOrderRequest(body('delivery', DEVICE))), { ok: false, code: 'invalid_request', detail: 'client_geo_not_accepted' },
    'location_* at top level is rejected for delivery too')
  const pickupWithDelivery = parseCreateOrderRequest({ ...body('pickup', { paymentMethod: 'cash' }), delivery: { city: CITY, street: 'x', houseNumber: '1', ...DEVICE } })
  assert.equal(pickupWithDelivery.ok, false)
})

await test('DL19–21. without device location: Mapbox street = precise coords; locality / unresolved / legacy are not', async () => {
  const street = await placeOrder(body('delivery'), withProvider(providerReturning(STREET_HIT)))
  assert.equal(street.rpcArgs.p_delivery.geo_source, 'geocoder'); assert.ok(loc.hasPreciseCoordinates(street.rpcArgs.p_delivery))
  const locality = await placeOrder(body('delivery'), withProvider(providerReturning({ ...STREET_HIT, level: 'locality' })))
  assert.equal(locality.rpcArgs.p_delivery.geo_precision, 'locality'); assert.ok(!loc.hasPreciseCoordinates(locality.rpcArgs.p_delivery))
  assert.equal(loc.assessDeliveryDispatch({ type: 'delivery', address: { city: CITY, street: 'הדקל', houseNumber: '12' }, geo: locality.rpcArgs.p_delivery }).warning, 'חסר מיקום מדויק למשלוח')
  for (const g of [UNRESOLVED, { delivery_lat: null, delivery_lng: null, geo_source: null, geo_precision: null }, null,
    { ...DEVICE_GEO, geo_precision: 'locality' }, { ...DEVICE_GEO, geo_source: 'none' }, { ...DEVICE_GEO, delivery_lat: 40 }])
    assert.ok(!loc.hasPreciseCoordinates(g), JSON.stringify(g))
})

await test('DL22–23. pricing and payment rules unchanged by device location', async () => {
  const withLoc = await placeOrder(body('delivery', {}, DEVICE), withProvider(providerReturning(null)))
  const without = await placeOrder(body('delivery'), withProvider(providerReturning(null)))
  assert.deepEqual(withLoc.rpcArgs.p_order, without.rpcArgs.p_order); assert.deepEqual(withLoc.rpcArgs.p_items, without.rpcArgs.p_items)
  assert.equal(withLoc.rpcArgs.p_order.total_price, 97)
  assert.equal(rejected(parseCreateOrderRequest(body('delivery', { paymentMethod: 'cibus' }, DEVICE))).code, 'payment_method_not_allowed') // 08D14: cash allowed, cibus/bit not
  assert.equal(parseCreateOrderRequest(body('delivery', { paymentMethod: 'cash' }, DEVICE)).ok, true)
})

await test('DL24–25. no Maale call / dispatch rows; temporary Mapbox diagnostics fully removed', async () => {
  const srcs = ['lib/orderGeo.ts', 'lib/deliveryLocation.ts', 'lib/orderRequest.ts', 'lib/geocodingProvider.ts', 'lib/geocoding.ts',
    'app/api/orders/route.ts', 'app/order/page.tsx'].map(f => [f, readFileSync(join(ROOT, f), 'utf8')])
  for (const [f, s] of srcs) {
    assert.ok(!/maalehamishlohim|delivery_dispatches|express\/integrations/i.test(s), `${f}: no Maale / dispatch`)
    assert.ok(!/mapbox_geo_diagnostic|VERCEL_ENV|MapboxDiagnostic/.test(s), `${f}: no diagnostics`)
  }
})

await test('DL26. privacy: location only on explicit click, never persisted or logged', async () => {
  const page = readFileSync(join(ROOT, 'app', 'order', 'page.tsx'), 'utf8')
  assert.equal(page.split('getCurrentPosition(').length - 1, 1, 'single call site')
  assert.ok(!page.includes('watchPosition'))
  const fn = page.indexOf('function requestDeviceLocation()'), call = page.indexOf('getCurrentPosition(')
  assert.ok(fn > 0 && call > fn && call - fn < 600, 'called only inside the click handler')
  assert.ok(page.includes('onClick={requestDeviceLocation}'))
  assert.ok(!/localStorage[^\n]*(deviceLocation|location_lat)/.test(page), 'never stored in localStorage')
  assert.ok(/type DeliveryForm = \{[^}]*\}/.test(page) && !/type DeliveryForm = \{[^}]*location/.test(page), 'saved address form has no location')
  const geoSrc = readFileSync(join(LIB, 'orderGeo.ts'), 'utf8')
  const logArgs = [...geoSrc.matchAll(/deps\.log\(([^)]*)\)/g)].map(m => m[1].trim())
  assert.ok(logArgs.length >= 3)
  for (const a of logArgs) assert.match(a, /^'[a-z_]+'$|^`geocode_\$\{result\.reason\}`$/, `log argument must be a fixed code: ${a}`)
})

/* ─── Delivery-area proximity (08D4) — SYNTHETIC fixture coordinates only, never production values ─── */
console.log('Area proximity (08D4, synthetic fixtures)')

const KFAR = 'כפר אדומים', NOFEI = 'נופי פרת'
// TEST-ONLY config: fake centres / radii to exercise the logic. The real DELIVERY_AREA_GEO stays unapproved.
const FIX = Object.freeze({
  ...areas.DELIVERY_AREA_GEO,
  [KFAR]: { city: KFAR, center: { lat: 31.0, lng: 35.0 }, radiusMeters: 1500, approvedForDispatch: true, source: 'TEST FIXTURE' },
  [CITY]: { city: CITY, center: { lat: 31.2, lng: 35.2 }, radiusMeters: 3000, approvedForDispatch: true, source: 'TEST FIXTURE' },
  [NOFEI]: { city: NOFEI, center: { lat: 31.4, lng: 35.4 }, radiusMeters: 2000, approvedForDispatch: false, source: 'TEST FIXTURE' },
})
const near = (a, b, tol) => Math.abs(a - b) <= tol
const gpsGeo = (lat, lng) => ({ delivery_lat: lat, delivery_lng: lng, geo_source: 'manual', geo_precision: 'street' })
const FULL = city => ({ city, street: 'הדקל', houseNumber: '12' })
const assess = (city, geo, address = FULL(city), type = 'delivery', config = FIX) => loc.assessDeliveryDispatch({ type, address, geo }, config)

await test('AP1. Haversine: identical point = 0 m', async () => {
  assert.equal(areas.distanceMetersBetweenCoordinates(31.5, 35.2, 31.5, 35.2), 0)
})

await test('AP2. Haversine: synthetic known distances (0.01° lat ≈ 1111.95 m; 0.01° lng at 31° ≈ 953.1 m)', async () => {
  assert.ok(near(areas.distanceMetersBetweenCoordinates(31.0, 35.0, 31.01, 35.0), 1111.95, 0.5))
  assert.ok(near(areas.distanceMetersBetweenCoordinates(31.0, 35.0, 31.0, 35.01), 1111.95 * Math.cos(31 * Math.PI / 180), 0.5))
  assert.equal(areas.distanceMetersBetweenCoordinates(31.0, 35.0, 31.01, 35.0), areas.distanceMetersBetweenCoordinates(31.01, 35.0, 31.0, 35.0))
})

await test('AP3. point clearly inside radius → matched', async () => {
  const r = areas.checkDeliveryAreaProximity(KFAR, 31.0045, 35.0, FIX)
  assert.deepEqual([r.checked, r.matched, r.reason, r.radiusMeters], [true, true, 'matched', 1500]); assert.ok(near(r.distanceMeters, 500.4, 1))
})

await test('AP4. point clearly outside radius → outside_area', async () => {
  const r = areas.checkDeliveryAreaProximity(KFAR, 31.02, 35.0, FIX)
  assert.deepEqual([r.checked, r.matched, r.reason], [true, false, 'outside_area']); assert.ok(r.distanceMeters > 2000)
})

await test('AP5. exact radius boundary matches; just beyond does not', async () => {
  const d = areas.distanceMetersBetweenCoordinates(31.0, 35.0, 31.01, 35.0)
  const at = { ...FIX, [KFAR]: { ...FIX[KFAR], radiusMeters: d } }
  assert.equal(areas.checkDeliveryAreaProximity(KFAR, 31.01, 35.0, at).reason, 'matched')
  const below = { ...FIX, [KFAR]: { ...FIX[KFAR], radiusMeters: d - 0.001 } }
  assert.equal(areas.checkDeliveryAreaProximity(KFAR, 31.01, 35.0, below).reason, 'outside_area')
})

await test('AP6. invalid latitude → invalid_coordinates (Haversine returns null)', async () => {
  for (const v of [NaN, Infinity, '31.0', null, undefined, 95]) {
    assert.equal(areas.checkDeliveryAreaProximity(KFAR, v, 35.0, FIX).reason, 'invalid_coordinates', String(v))
    assert.equal(areas.distanceMetersBetweenCoordinates(v, 35.0, 31.0, 35.0), null)
  }
})

await test('AP7. invalid longitude → invalid_coordinates', async () => {
  for (const v of [NaN, -Infinity, '35', null, 181]) assert.equal(areas.checkDeliveryAreaProximity(KFAR, 31.0, v, FIX).reason, 'invalid_coordinates', String(v))
})

await test('AP8. unknown delivery area → unknown_area', async () => {
  assert.equal(areas.checkDeliveryAreaProximity('ירושלים', 31.0, 35.0, FIX).reason, 'unknown_area')
})

await test('AP9. configured but NOT approved → area_not_approved (no distance check)', async () => {
  const r = areas.checkDeliveryAreaProximity(NOFEI, 31.4, 35.4, FIX)
  assert.deepEqual([r.checked, r.matched, r.reason], [false, false, 'area_not_approved'])
})

await test('AP10. no config / real config: every area unconfigured + unapproved; bad radius rejected', async () => {
  assert.deepEqual(areas.areasWithoutGeoConfig(), [])
  assert.ok(Object.isFrozen(areas.DELIVERY_AREA_GEO))
  for (const a of cfg.DELIVERY_AREAS) {
    const c = areas.DELIVERY_AREA_GEO[a]
    assert.deepEqual([c.center, c.radiusMeters, c.approvedForDispatch], [null, null, false], a)
    assert.equal(areas.checkDeliveryAreaProximity(a, 31.0, 35.0).reason, 'area_not_configured', a)
  }
  const { [KFAR]: _omit, ...missing } = FIX
  assert.equal(areas.checkDeliveryAreaProximity(KFAR, 31.0, 35.0, missing).reason, 'area_not_configured'); assert.ok(_omit)
  for (const radiusMeters of [0, -5, NaN, 50_000]) {
    const bad = { ...FIX, [KFAR]: { ...FIX[KFAR], radiusMeters } }
    assert.equal(areas.checkDeliveryAreaProximity(KFAR, 31.0, 35.0, bad).reason, 'area_not_configured', String(radiusMeters))
  }
})

await test('AP11. trusted GPS + full address + area match → ready / eligible (A)', async () => {
  const r = await placeOrder(body('delivery', {}, { city: KFAR, location_lat: 31.004, location_lng: 35.001, location_accuracy: 15, location_confirmed: true }),
    withProvider(providerReturning(STREET_HIT)))
  const a = assess(KFAR, r.rpcArgs.p_delivery)
  assert.deepEqual([a.readiness, a.eligible, a.warning], ['ready', true, null]); assert.equal(a.proximity.reason, 'matched')
})

await test('AP12 + AP20–21. trusted GPS in ANOTHER area → mismatch (B); order still created; Mapbox not called; GPS kept', async () => {
  const r = await placeOrder(body('delivery', {}, { city: KFAR, location_lat: 31.2, location_lng: 35.2, location_accuracy: 15, location_confirmed: true }),
    withProvider(providerReturning(STREET_HIT)))
  assert.ok(r.created); assert.equal(r.calls.geocode, 0)
  assert.deepEqual(geoOf(r.rpcArgs.p_delivery), gpsGeo(31.2, 35.2)); assert.equal(r.rpcArgs.p_order.total_price, 107) // 60 + 12 + כפר אדומים ₪35
  const a = assess(KFAR, r.rpcArgs.p_delivery)
  assert.deepEqual([a.readiness, a.eligible, a.warning], ['location_area_mismatch', false, 'מיקום המשלוח אינו תואם לאזור שנבחר'])
})

await test('AP13. trusted GPS + incomplete address → not eligible (E)', async () => {
  for (const address of [{ ...FULL(KFAR), street: '' }, { ...FULL(KFAR), houseNumber: '  ' }, { ...FULL(KFAR), city: 'ירושלים' }, { city: KFAR }]) {
    const a = assess(KFAR, gpsGeo(31.004, 35.001), address)
    assert.deepEqual([a.readiness, a.eligible, a.warning], ['incomplete_address', false, 'כתובת המשלוח אינה מלאה'], JSON.stringify(address))
  }
})

await test('AP14. GPS only (no address) → not eligible', async () => {
  assert.equal(assess(KFAR, gpsGeo(31.004, 35.001), null).eligible, false)
})

await test('AP15. address only (no precise location) → missing precise location (C)', async () => {
  const a = assess(KFAR, UNRESOLVED)
  assert.deepEqual([a.readiness, a.eligible, a.warning], ['missing_precise_location', false, 'חסר מיקום מדויק למשלוח'])
})

await test('AP16. Mapbox street + correct locality + approved area + in radius → ready', async () => {
  const r = await placeOrder(body('delivery'), withProvider(providerReturning({ lat: 31.2005, lng: 35.2, localities: [CITY], level: 'street', partial: false })))
  assert.equal(r.rpcArgs.p_delivery.geo_source, 'geocoder')
  assert.equal(assess(CITY, r.rpcArgs.p_delivery).readiness, 'ready')
  const far = { ...r.rpcArgs.p_delivery, delivery_lat: 31.3 } // same source, outside the fixture radius
  assert.equal(assess(CITY, far).readiness, 'location_area_mismatch')
})

await test('AP17–18. Mapbox locality / unresolved / legacy NULL → not eligible', async () => {
  const locality = await placeOrder(body('delivery'), withProvider(providerReturning({ lat: 31.2, lng: 35.2, localities: [CITY], level: 'locality', partial: false })))
  assert.equal(assess(CITY, locality.rpcArgs.p_delivery).readiness, 'missing_precise_location')
  for (const g of [UNRESOLVED, { delivery_lat: null, delivery_lng: null, geo_source: null, geo_precision: null }, null])
    assert.equal(assess(CITY, g).eligible, false)
})

await test('AP19. pickup → never eligible, no warning', async () => {
  const a = assess(KFAR, gpsGeo(31.004, 35.001), FULL(KFAR), 'pickup')
  assert.deepEqual([a.readiness, a.eligible, a.warning], ['not_delivery', false, null])
})

await test('AP-D. REAL config today: precise GPS in any area → area_not_approved (D), never eligible', async () => {
  for (const a of cfg.DELIVERY_AREAS) {
    const r = loc.assessDeliveryDispatch({ type: 'delivery', address: FULL(a), geo: gpsGeo(31.8, 35.3) })
    assert.deepEqual([r.readiness, r.eligible, r.warning], ['area_not_approved', false, 'אזור המשלוח עדיין לא מאומת לשליחה אוטומטית'], a)
  }
})

await test('AP22–24. no Maale call / dispatch rows; no logging or coordinates output in the new modules', async () => {
  for (const f of ['lib/deliveryAreasGeo.ts', 'lib/deliveryLocation.ts']) {
    const src = readFileSync(join(ROOT, f), 'utf8')
    assert.ok(!/maalehamishlohim|delivery_dispatches|express\/integrations|fetch\(/i.test(src), `${f}: no Maale / dispatch / network`)
    assert.ok(!/console\.|\.log\(/.test(src), `${f}: no logging`)
  }
})

/* ─── Static guards ─── */
console.log('Static guards')

await test('S1. no NEXT_PUBLIC geocoding key; provider module not imported by client code', async () => {
  const provSrc = readFileSync(join(LIB, 'geocodingProvider.ts'), 'utf8')
  const provCode = provSrc.replace(/\/\/.*$/gm, '')
  assert.ok(!/NEXT_PUBLIC/.test(provCode))
  assert.ok(!/googleapis|google\w*Provider|mapGoogle/i.test(provCode), 'no Google adapter code')
  assert.ok(/permanent:\s*'true'/.test(provCode), 'permanent=true is part of the fixed request policy')
  for (const f of ['app/order/page.tsx', 'app/dashboard/orders/page.tsx', 'lib/geocoding.ts', 'lib/orderRequest.ts']) {
    const src = readFileSync(join(ROOT, f), 'utf8')
    assert.ok(!/from\s+['"][^'"]*(geocodingProvider|orderGeo)['"]/.test(src), f)
  }
  const route = readFileSync(join(ROOT, 'app', 'api', 'orders', 'route.ts'), 'utf8')
  const geoAt = route.indexOf('attachDeliveryGeo(order'), createAt = route.indexOf('createOrderAtomic(toCreate.rpcArgs)')
  assert.ok(geoAt > 0 && createAt > geoAt, 'route geocodes before create_order and creates with the geocoded args')
})

console.log(`\nAll ${passed} geocoding checks passed.`)
