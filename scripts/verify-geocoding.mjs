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
    assert.ok(r.created); assert.deepEqual(geoOf(r.rpcArgs.p_delivery), UNRESOLVED); assert.equal(r.rpcArgs.p_order.total_price, 92)
  }
  const ok = await placeOrder(body('delivery'), mk(async () => jsonRes(fc(mbFeature()))))
  assert.deepEqual(geoOf(ok.rpcArgs.p_delivery), { delivery_lat: 31.773612, delivery_lng: 35.298313, geo_source: 'geocoder', geo_precision: 'street' })
  const pickup = await placeOrder(body('pickup', { paymentMethod: 'cash' }), mk(async () => { throw new Error('must not be called') }))
  assert.equal(pickup.calls.geocode, 0); assert.equal(pickup.rpcArgs.p_delivery, null)
})

/* ─── TEMPORARY (08C6) Preview-only precision diagnostic ─── */
console.log('Preview precision diagnostic (08C6, temporary)')

const DIAG_KEYS = ['accuracy', 'address_match', 'confidence', 'feature_type', 'final_reason', 'has_house_number', 'localities', 'place_match', 'provider_precision', 'street_match']
async function diagRun(env, feature) {
  const lines = []
  const resolution = prov.resolveGeocodingProvider({ GEOCODING_PROVIDER: 'mapbox', GEOCODING_API_KEY: TOKEN, ...env },
    async () => jsonRes(fc(feature)), line => lines.push(line))
  const result = await geo.geocodeDeliveryAddress(ADDR, { resolution })
  return { lines, result }
}
const approxAddress = mbFeature({ coordinates: { longitude: 35.311615, latitude: 31.78051, accuracy: 'approximate' },
  match_code: { address_number: 'unmatched', street: 'matched', place: 'matched', confidence: 'medium' } })

await test('D1. Preview + locality-classified result → exactly one diagnostic with allow-listed fields only', async () => {
  const { lines, result } = await diagRun({ VERCEL_ENV: 'preview' }, approxAddress)
  assert.equal(result.precision, 'locality')
  assert.equal(lines.length, 1); assert.match(lines[0], /^mapbox_geo_diagnostic \{/)
  const d = JSON.parse(lines[0].slice('mapbox_geo_diagnostic '.length))
  assert.deepEqual(Object.keys(d).sort(), DIAG_KEYS)
  assert.deepEqual(d, { feature_type: 'address', accuracy: 'approximate', confidence: 'medium', address_match: 'unmatched',
    street_match: 'matched', place_match: 'matched', has_house_number: true, localities: [CITY], provider_precision: 'street_partial', final_reason: 'locality' })
})

await test('D2. diagnostic never contains token, URL, street, house number, full address, coordinates or customer data', async () => {
  const { lines } = await diagRun({ VERCEL_ENV: 'preview' }, approxAddress)
  const forbidden = [TOKEN, 'access_token', 'api.mapbox.com', 'הדקל', '12,', 'full_address', '31.78', '35.31', 'Israel', ...Object.values(PRIVATE)]
  for (const f of forbidden) assert.ok(!lines[0].includes(f), `leaked ${f}`)
  const weird = mbFeature({ feature_type: 'הדקל 12', coordinates: { longitude: 35.3, latitude: 31.78, accuracy: 'Rooftop near הדקל 12' },
    match_code: { address_number: 12, street: { x: 1 }, confidence: 'LOW!' } })
  const w = await diagRun({ VERCEL_ENV: 'preview' }, weird)
  const d = JSON.parse(w.lines[0].slice('mapbox_geo_diagnostic '.length))
  assert.deepEqual([d.feature_type, d.accuracy, d.address_match, d.street_match, d.confidence], ['other', 'other', 'other', 'other', 'other'])
  assert.ok(!w.lines[0].includes('הדקל'))
})

await test('D3. no diagnostic on Production / unset VERCEL_ENV / confirmed street results', async () => {
  for (const env of [{ VERCEL_ENV: 'production' }, {}, { VERCEL_ENV: 'development' }]) assert.deepEqual((await diagRun(env, approxAddress)).lines, [])
  const street = await diagRun({ VERCEL_ENV: 'preview' }, mbFeature())
  assert.equal(street.result.precision, 'street'); assert.deepEqual(street.lines, [])
})

await test('D4. diagnostic does not change results and a failing logger is ignored', async () => {
  for (const feature of [approxAddress, mbFeature({ feature_type: 'place', name: CITY, context: {}, match_code: undefined }), mbFeature()]) {
    const off = (await diagRun({}, feature)).result
    const on = (await diagRun({ VERCEL_ENV: 'preview' }, feature)).result
    assert.deepEqual(on, off)
  }
  const resolution = prov.resolveGeocodingProvider({ GEOCODING_PROVIDER: 'mapbox', GEOCODING_API_KEY: TOKEN, VERCEL_ENV: 'preview' },
    async () => jsonRes(fc(approxAddress)), () => { throw new Error('logger down') })
  assert.equal((await geo.geocodeDeliveryAddress(ADDR, { resolution })).precision, 'locality')
})

// Street-level address whose settlement is NOT the selected area (the real-world Preview failure shape).
const streetOtherPlace = mbFeature({ context: {
  address: { name: 'הדקל 12', address_number: '12', street_name: 'הדקל' }, street: { name: 'הדקל' },
  place: { name: 'ירושלים' }, locality: { name: 'שכונה לדוגמה' }, country: { name: 'ישראל', country_code: 'IL' },
} })
const parseDiag = line => JSON.parse(line.slice('mapbox_geo_diagnostic '.length))

await test('L1. Preview + locality_mismatch (street-level result) → exactly one diagnostic, final_reason=locality_mismatch', async () => {
  const { lines, result } = await diagRun({ VERCEL_ENV: 'preview' }, streetOtherPlace)
  assert.equal(result.reason, 'locality_mismatch')
  assert.equal(lines.length, 1)
  const d = parseDiag(lines[0])
  assert.deepEqual(Object.keys(d).sort(), DIAG_KEYS)
  assert.equal(d.final_reason, 'locality_mismatch'); assert.equal(d.provider_precision, 'street'); assert.equal(d.feature_type, 'address')
})

await test('L2. returned settlement names are visible (place + locality)', async () => {
  const d = parseDiag((await diagRun({ VERCEL_ENV: 'preview' }, streetOtherPlace)).lines[0])
  assert.deepEqual(d.localities, ['ירושלים', 'שכונה לדוגמה'])
  const settlementMismatch = mbFeature({ feature_type: 'place', name: 'ירושלים', context: {}, match_code: undefined })
  const d2 = parseDiag((await diagRun({ VERCEL_ENV: 'preview' }, settlementMismatch)).lines[0])
  assert.deepEqual([d2.final_reason, d2.provider_precision, d2.localities], ['locality_mismatch', 'locality', ['ירושלים']])
})

await test('L3. mismatch diagnostic leaks no street / house number / address / coordinates / token / customer data', async () => {
  const line = (await diagRun({ VERCEL_ENV: 'preview' }, streetOtherPlace)).lines[0]
  const forbidden = [TOKEN, 'access_token', 'api.mapbox.com', 'הדקל', '"12"', '12,', 'full_address', 'address_number', 'street_name',
    '31.77', '35.29', 'Israel', ...Object.values(PRIVATE)]
  for (const f of forbidden) assert.ok(!line.includes(f), `leaked ${f}`)
})

await test('L4. Production / unset VERCEL_ENV emit nothing on mismatch', async () => {
  for (const env of [{ VERCEL_ENV: 'production' }, {}]) assert.deepEqual((await diagRun(env, streetOtherPlace)).lines, [])
})

await test('L5. classifier + matching unchanged with the diagnostic on; confirmed matching street still emits nothing', async () => {
  for (const feature of [streetOtherPlace, mbFeature(), approxAddress]) {
    assert.deepEqual((await diagRun({ VERCEL_ENV: 'preview' }, feature)).result, (await diagRun({}, feature)).result)
  }
  assert.deepEqual((await diagRun({ VERCEL_ENV: 'preview' }, mbFeature())).lines, [])
})

await test('L6. locality_mismatch still stores unresolved and the order is created; logger failure ignored', async () => {
  const mk = log => {
    const resolution = prov.resolveGeocodingProvider({ GEOCODING_PROVIDER: 'mapbox', GEOCODING_API_KEY: TOKEN, VERCEL_ENV: 'preview' },
      async () => jsonRes(fc(streetOtherPlace)), log)
    return input => geo.geocodeDeliveryAddress(input, { resolution })
  }
  const lines = []
  const r = await placeOrder(body('delivery'), mk(l => lines.push(l)))
  assert.ok(r.created); assert.deepEqual(geoOf(r.rpcArgs.p_delivery), UNRESOLVED)
  assert.deepEqual(r.calls.logs, ['geocode_locality_mismatch']); assert.equal(lines.length, 1)
  const r2 = await placeOrder(body('delivery'), mk(() => { throw new Error('logger down') }))
  assert.ok(r2.created); assert.deepEqual(geoOf(r2.rpcArgs.p_delivery), UNRESOLVED)
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
