// Local checks for parcel checkout — server side (GATE S4-A): feature flag, parcel validation, request parsing, the
// create_order_with_parcel adapter + error mapping, and the real POST /api/orders route against a fake service-role
// Supabase client. No network, no real DB, no real secrets.
// Run: node scripts/verify-parcel-checkout.mjs

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const src = p => readFileSync(join(ROOT, p), 'utf8')

/* ─── Fakes ─── */
const BRANCH = '8fed141d-0e7c-46c1-803b-88d3d811c1f8'   // the delivery branch (orderConfig.DELIVERY_BRANCH_IDS)
const ITEM = '11111111-1111-4111-8111-111111111111'
const CATEGORY = '22222222-2222-4222-8222-222222222222'  // not a meal / deal category → no surcharge, no set options
const db = { calls: [], rpcCalls: [], rpcResponse: null }
class ServerConfigError extends Error { constructor(m) { super(m); this.name = 'ServerConfigError' } }
function query(table) {
  db.calls.push(table)
  const b = {
    select() { return b }, eq() { return b }, in() { return b }, order() { return b },
    async maybeSingle() { return { data: table === 'branches' ? { id: BRANCH } : null, error: null } },
    then(ok, ko) {
      const data = table === 'menu_items' ? [{ id: ITEM, category_id: CATEGORY, is_active: true, has_lettuce: false, has_pita: false, has_egg: false }]
        : table === 'branch_prices' ? [{ item_id: ITEM, price: '30.00', is_available: true }]
        : []
      return Promise.resolve({ data, error: null }).then(ok, ko)
    },
  }
  return b
}
const fakeSupabaseServer = {
  ServerConfigError,
  getServerSupabase() {
    return {
      from: query,
      async rpc(name, args) {
        db.rpcCalls.push({ name, args: JSON.parse(JSON.stringify(args)) })
        await new Promise(r => setImmediate(r))
        const r = typeof db.rpcResponse === 'function' ? db.rpcResponse(name, args) : db.rpcResponse
        return r ?? { data: [{ created_order_id: '33333333-3333-4333-8333-333333333333', created_order_number: 101, created_daily_number: 7 }], error: null }
      },
    }
  },
}
const SUBS = {
  supabaseServer: fakeSupabaseServer,
  hours: { isShopOpen: () => true },
  orderGeo: { attachDeliveryGeo: async (_o, built) => built },                           // no geocoding in tests
  orderAddress: { resolveGoogleDeliveryAddress: async order => ({ ok: true, order }) },   // no Google in tests
}

/* ─── Loader: TS → CJS with the substitutions above ─── */
const cache = new Map()
function loadFile(file) {
  if (cache.has(file)) return cache.get(file).exports
  const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  })
  const mod = { exports: {} }
  cache.set(file, mod)
  const req = p => {
    const name = p.startsWith('@/lib/') ? p.slice(6) : p.startsWith('./') && file.includes(join(ROOT, 'lib')) ? p.slice(2) : null
    if (name && SUBS[name]) return SUBS[name]
    if (name) return loadFile(join(ROOT, 'lib', name + '.ts'))
    return require(p)
  }
  new Function('exports', 'require', 'module', outputText)(mod.exports, req, mod)
  return mod.exports
}
const PC = loadFile(join(ROOT, 'lib', 'parcelCheckout.ts'))
const OR = loadFile(join(ROOT, 'lib', 'orderRequest.ts'))
const CO = loadFile(join(ROOT, 'lib', 'createOrder.ts'))
const route = loadFile(join(ROOT, 'app', 'api', 'orders', 'route.ts'))
const { NextRequest } = require('next/server')

let passed = 0
const test = async (name, fn) => { await fn(); passed++; console.log('  ✓', name) }
const REF = 'RR123456789IL'
const baseOrder = (extra = {}) => ({
  branchId: BRANCH, type: 'delivery', customerName: 'ישראל ישראלי', phone: '050-123-4567', paymentMethod: 'cash',
  items: [{ itemId: ITEM, quantity: 2 }],
  delivery: { city: 'מעלה אדומים', street: 'הדקל', houseNumber: '12' },
  ...extra,
})
async function post(body, env = {}) {
  const saved = process.env.PARCEL_CHECKOUT_ENABLED
  if (env.PARCEL_CHECKOUT_ENABLED === undefined) delete process.env.PARCEL_CHECKOUT_ENABLED
  else process.env.PARCEL_CHECKOUT_ENABLED = env.PARCEL_CHECKOUT_ENABLED
  const logs = []; const origErr = console.error; console.error = (...a) => logs.push(a.map(String).join(' '))
  try {
    const res = await route.POST(new NextRequest('https://app.example/api/orders', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
    return { status: res.status, body: await res.json(), logs }
  } finally {
    console.error = origErr
    if (saved === undefined) delete process.env.PARCEL_CHECKOUT_ENABLED; else process.env.PARCEL_CHECKOUT_ENABLED = saved
  }
}
const reset = () => { db.calls = []; db.rpcCalls = []; db.rpcResponse = null }
const ON = { PARCEL_CHECKOUT_ENABLED: 'true' }

/* ═══ 1. Feature flag ═══ */
console.log('Feature flag')
await test('PARCEL_CHECKOUT_ENABLED: only the exact string "true" enables; default / anything else is OFF', () => {
  assert.equal(PC.isParcelCheckoutEnabled({}), false)
  for (const v of ['false', 'TRUE', 'True', '1', 'yes', ' true', 'true ', '']) assert.equal(PC.isParcelCheckoutEnabled({ PARCEL_CHECKOUT_ENABLED: v }), false, v)
  assert.equal(PC.isParcelCheckoutEnabled({ PARCEL_CHECKOUT_ENABLED: 'true' }), true)
})
await test('flag is server-only: not NEXT_PUBLIC, read by the route from process.env, absent from client code', () => {
  assert.match(src('app/api/orders/route.ts'), /isParcelCheckoutEnabled\(process\.env\)/)
  for (const f of ['lib/parcelCheckout.ts', 'lib/orderRequest.ts'])                        // shared modules: no env access
    assert.ok(!/process\.env/.test(src(f).replace(/\/\/.*$/gm, '')), f)
  for (const f of ['app/order/page.tsx', 'lib/parcelCheckout.ts', 'lib/orderRequest.ts', 'app/api/orders/route.ts'])
    assert.ok(!/NEXT_PUBLIC_PARCEL|PARCEL_CHECKOUT_ENABLED\s*\)?\s*\|\|/.test(src(f)), f)    // never public, never defaulted on
  assert.ok(!/PARCEL_CHECKOUT_ENABLED/.test(src('app/order/page.tsx')))
})

/* ═══ 2. Parcel validation (mirrors the DB constraints) ═══ */
console.log('Parcel validation')
await test('valid tracking references are accepted and normalized (trim, single spaces); carrier optional', () => {
  assert.deepEqual(PC.parseParcelCheckout({ trackingRef: REF }), { ok: true, value: { trackingRef: REF, carrier: null } })
  assert.deepEqual(PC.parseParcelCheckout({ trackingRef: '  LP 0012  3456 ', carrier: '  דואר ישראל ' }),
    { ok: true, value: { trackingRef: 'LP 0012 3456', carrier: 'דואר ישראל' } })
  for (const ok of ['ABCD', 'a.b_c/d#e-f12', '1234567890'.repeat(4)]) assert.equal(PC.parseParcelCheckout({ trackingRef: ok }).ok, true, ok)
  for (const c of [undefined, null, '', '   ']) assert.equal(PC.parseParcelCheckout({ trackingRef: REF, carrier: c }).value.carrier, null)
})
await test('invalid tracking references are rejected (characters, length, key length, type, size)', () => {
  const bad = ['', 'ABC', 'A'.repeat(41), 'RR12345\t678', 'RR123:456', 'https://x.y/abc', 'RR12345678<script>', 'עברית1234',
    '#### ', '-._/#', 'AB C', 123, null, undefined, ['RR123456789IL'], { x: 1 }, 'R'.repeat(201)]
  for (const t of bad) assert.deepEqual(PC.parseParcelCheckout({ trackingRef: t }), { ok: false, detail: 'invalid_tracking_ref' }, JSON.stringify(t))
})
await test('carrier rules: ≤ 40 chars, no control characters, no URL-like text, string only', () => {
  for (const c of ['x'.repeat(41), 'abc\u0000', 'DHL\u0085', 'http://evil', 'www.carrier.com', 'a//b', 12, ['DHL'], { n: 1 }])
    assert.deepEqual(PC.parseParcelCheckout({ trackingRef: REF, carrier: c }), { ok: false, detail: 'invalid_carrier' }, JSON.stringify(c))
  assert.equal(PC.parseParcelCheckout({ trackingRef: REF, carrier: 'x'.repeat(40) }).ok, true)
})
await test('malformed parcel objects are rejected (shape, unknown fields, raw RPC field names)', () => {
  for (const p of ['RR123456789IL', 42, [], true]) assert.equal(PC.parseParcelCheckout(p).detail, 'invalid_parcel_shape')
  for (const p of [{ trackingRef: REF, extra: 1 }, { tracking_ref: REF }, { trackingRef: REF, branch_id: BRANCH }])
    assert.equal(PC.parseParcelCheckout(p).detail, 'unexpected_parcel_field')
})
await test('tracking key mirrors the DB generated column: upper(alphanumerics only)', () => {
  assert.equal(PC.parcelTrackingKey('lp-0012 3456/il'), 'LP00123456IL')
})

/* ═══ 3. Request parsing ═══ */
console.log('Request parsing')
await test('flag OFF (default): any parcel → parcel_checkout_disabled (checked before everything else); parcel:null = food-only', () => {
  for (const p of [{ trackingRef: REF }, 'junk', {}, [], 0, false])
    assert.deepEqual(OR.parseCreateOrderRequest(baseOrder({ parcel: p })), { ok: false, code: 'parcel_checkout_disabled', detail: undefined }, JSON.stringify(p))
  assert.equal(OR.parseCreateOrderRequest({ parcel: { trackingRef: REF } }).code, 'parcel_checkout_disabled') // even with no other fields
  assert.equal(OR.parseCreateOrderRequest(baseOrder({ parcel: null })).ok, true)
  assert.equal(OR.parseCreateOrderRequest(baseOrder({ parcel: null })).value.parcel, undefined)
})
await test('flag OFF: food-only parsing is byte-for-byte unchanged (incl. loose top-level keys still ignored)', () => {
  const a = OR.parseCreateOrderRequest(baseOrder()), b = OR.parseCreateOrderRequest(baseOrder(), {})
  assert.deepEqual(a, b)
  assert.equal(OR.parseCreateOrderRequest(baseOrder({ carrier: 'x' })).ok, true)
  assert.equal(OR.parseCreateOrderRequest(baseOrder({ type: 'pickup', delivery: undefined })).ok, true)
})
await test('flag ON: valid delivery parcel → normalized parcel in the parsed request; food-only identical to flag OFF', () => {
  const r = OR.parseCreateOrderRequest(baseOrder({ parcel: { trackingRef: ' ' + REF + ' ', carrier: 'DHL' } }), { parcelCheckoutEnabled: true })
  assert.equal(r.ok, true); assert.deepEqual(r.value.parcel, { trackingRef: REF, carrier: 'DHL' })
  assert.deepEqual(OR.parseCreateOrderRequest(baseOrder(), { parcelCheckoutEnabled: true }), OR.parseCreateOrderRequest(baseOrder()))
})
await test('flag ON: parcel on a pickup order → invalid_parcel (parcel_requires_delivery)', () => {
  const r = OR.parseCreateOrderRequest(baseOrder({ type: 'pickup', delivery: undefined, parcel: { trackingRef: REF } }), { parcelCheckoutEnabled: true })
  assert.deepEqual(r, { ok: false, code: 'invalid_parcel', detail: 'parcel_requires_delivery' })
})
await test('flag ON: invalid parcel → invalid_parcel with a safe detail (never the value); loose parcel fields rejected', () => {
  const r = OR.parseCreateOrderRequest(baseOrder({ parcel: { trackingRef: 'bad:ref!' } }), { parcelCheckoutEnabled: true })
  assert.deepEqual(r, { ok: false, code: 'invalid_parcel', detail: 'invalid_tracking_ref' })
  for (const k of ['p_parcel', 'tracking_ref', 'trackingRef', 'tracking_key', 'carrier'])
    assert.deepEqual(OR.parseCreateOrderRequest(baseOrder({ [k]: REF }), { parcelCheckoutEnabled: true }),
      { ok: false, code: 'invalid_request', detail: 'parcel_fields_outside_parcel' }, k)
})

/* ═══ 4. Adapter: create_order_with_parcel + error mapping ═══ */
console.log('Adapter: create_order_with_parcel')
await test('error classification uses SQLSTATE + constraint / rule name only', () => {
  const C = CO.classifyParcelRpcError
  assert.deepEqual(C({ code: '23505', message: 'duplicate key value violates unique constraint "parcel_requests_active_key_uq"' }), { kind: 'duplicate' })
  assert.deepEqual(C({ code: '23505', message: 'duplicate key value violates unique constraint "orders_pkey"' }), { kind: 'other' })
  assert.deepEqual(C({ code: '23514', message: 'new row for relation "parcel_requests" violates check constraint "parcel_requests_tracking_key_len"' }),
    { kind: 'rejected', reason: 'parcel_requests_tracking_key_len' })
  assert.deepEqual(C({ code: '23514', message: 'new row violates check constraint "orders_status_check"' }), { kind: 'other' })
  assert.deepEqual(C({ code: '22023', message: 'parcel_requires_delivery_order' }), { kind: 'rejected', reason: 'parcel_requires_delivery_order' })
  assert.deepEqual(C({ code: '22023', message: 'create_order_with_parcel: parcel requires a delivery order' }), { kind: 'rejected', reason: 'wrapper_validation' })
  assert.deepEqual(C({ code: '22023', message: 'create_order: total mismatch' }), { kind: 'other' })   // create_order's own validation → 500 as today
  for (const code of ['PGRST202', '42883']) assert.deepEqual(C({ code, message: 'x' }), { kind: 'unavailable' })
  assert.deepEqual(C({ code: 'XX000', message: 'boom' }), { kind: 'other' })
})
await test('adapter sends exactly the food payload + p_parcel {tracking_ref, carrier} to create_order_with_parcel', async () => {
  reset()
  const args = { p_order: { a: 1 }, p_items: [{ b: 2 }], p_delivery: { c: 3 } }
  const r = await CO.createOrderWithParcelAtomic(args, { trackingRef: REF, carrier: null })
  assert.deepEqual(r, { orderId: '33333333-3333-4333-8333-333333333333', orderNumber: 101, dailyNumber: 7 })
  assert.deepEqual(db.rpcCalls, [{ name: 'create_order_with_parcel', args: { ...args, p_parcel: { tracking_ref: REF, carrier: null } } }])
})
await test('adapter errors: duplicate / rejected / unavailable / other (thrown message never contains input)', async () => {
  const cases = [
    [{ code: '23505', message: 'duplicate key value violates unique constraint "parcel_requests_active_key_uq"', details: `Key (branch_id, tracking_key)=(x, ${REF})` }, 'ParcelDuplicateError'],
    [{ code: '23514', message: 'violates check constraint "parcel_requests_tracking_ref_format"' }, 'ParcelRejectedError'],
    [{ code: 'PGRST202', message: 'not found' }, 'OrderCreationUnavailableError'],
    [{ code: 'XX000', message: `internal ${REF}`, details: REF }, 'Error'],
  ]
  for (const [error, name] of cases) {
    reset(); db.rpcResponse = { data: null, error }
    await assert.rejects(CO.createOrderWithParcelAtomic({ p_order: {}, p_items: [], p_delivery: {} }, { trackingRef: REF, carrier: null }), e => {
      assert.equal(e.name, name); assert.ok(!String(e.message).includes(REF)); assert.ok(!String(e.reason ?? '').includes(REF)); return true
    })
  }
})
await test('food-only adapter (create_order) is unchanged', async () => {
  reset()
  await CO.createOrderAtomic({ p_order: { a: 1 }, p_items: [], p_delivery: null })
  assert.deepEqual(db.rpcCalls, [{ name: 'create_order', args: { p_order: { a: 1 }, p_items: [], p_delivery: null } }])
})

/* ═══ 5. Real route POST /api/orders ═══ */
console.log('Route POST /api/orders (real route, fake DB)')
let foodArgsOff
await test('flag OFF: food-only delivery order → 201 via create_order (unchanged path)', async () => {
  reset()
  const r = await post(baseOrder())
  assert.equal(r.status, 201); assert.equal(r.body.dailyNumber, 7)
  assert.deepEqual(db.rpcCalls.map(c => c.name), ['create_order'])
  foodArgsOff = db.rpcCalls[0].args
})
await test('flag OFF: order WITH parcel → 400 parcel_checkout_disabled, no catalog read, no RPC, nothing created', async () => {
  reset()
  const r = await post(baseOrder({ parcel: { trackingRef: REF } }))
  assert.deepEqual([r.status, r.body], [400, { error: 'parcel_checkout_disabled' }])
  assert.deepEqual([db.calls.length, db.rpcCalls.length], [0, 0])
  for (const v of ['false', 'TRUE', '1']) { reset(); assert.equal((await post(baseOrder({ parcel: { trackingRef: REF } }), { PARCEL_CHECKOUT_ENABLED: v })).body.error, 'parcel_checkout_disabled', v) }
})
await test('flag ON: food-only order still uses create_order with byte-identical arguments', async () => {
  reset()
  const r = await post(baseOrder(), ON)
  assert.equal(r.status, 201)
  assert.deepEqual(db.rpcCalls, [{ name: 'create_order', args: foodArgsOff }])
})
await test('flag ON: valid parcel → 201 via ONE create_order_with_parcel call; same server-priced payload + p_parcel', async () => {
  reset()
  const r = await post(baseOrder({ parcel: { trackingRef: ' ' + REF + ' ', carrier: 'דואר ישראל' } }), ON)
  assert.equal(r.status, 201)
  assert.deepEqual(db.rpcCalls.map(c => c.name), ['create_order_with_parcel'])
  const { p_parcel, ...food } = db.rpcCalls[0].args
  assert.deepEqual(food, foodArgsOff)                                   // pricing / delivery fee unchanged
  assert.deepEqual(p_parcel, { tracking_ref: REF, carrier: 'דואר ישראל' })
  assert.equal(food.p_order.type, 'delivery'); assert.ok(food.p_delivery)
  assert.ok(!JSON.stringify(r.body).includes(REF), 'response never echoes the tracking number')
  assert.deepEqual(Object.keys(r.body).sort(), ['breakdown', 'dailyNumber', 'id', 'lines', 'total', 'type'])  // response shape unchanged
})
await test('flag ON: parcel on pickup → 400 invalid_parcel; invalid tracking / carrier → 400 invalid_parcel; no RPC', async () => {
  for (const body of [baseOrder({ type: 'pickup', delivery: undefined, parcel: { trackingRef: REF } }),
    baseOrder({ parcel: { trackingRef: 'AB' } }), baseOrder({ parcel: { trackingRef: REF, carrier: 'https://x' } })]) {
    reset()
    const r = await post(body, ON)
    assert.equal(r.status, 400); assert.equal(r.body.error, 'invalid_parcel')
    assert.equal(db.rpcCalls.length, 0)
  }
})
await test('flag ON: duplicate active tracking number → 409 parcel_duplicate; logs and response never contain it', async () => {
  reset()
  db.rpcResponse = { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "parcel_requests_active_key_uq"', details: `Key (branch_id, tracking_key)=(${BRANCH}, ${REF})` } }
  const r = await post(baseOrder({ parcel: { trackingRef: REF } }), ON)
  assert.deepEqual([r.status, r.body], [409, { error: 'parcel_duplicate' }])
  assert.ok(!r.logs.join('\n').includes(REF))
})
await test('flag ON: DB rule rejection → 400 invalid_parcel; other DB error → 500 server_error; never the number in logs', async () => {
  for (const [error, status, code] of [
    [{ code: '23514', message: 'new row for relation "parcel_requests" violates check constraint "parcel_requests_tracking_key_len"', details: REF }, 400, 'invalid_parcel'],
    [{ code: '22023', message: 'parcel_order_not_received' }, 400, 'invalid_parcel'],
    [{ code: '22023', message: 'create_order: total mismatch' }, 500, 'server_error'],
    [{ code: 'XX000', message: `boom ${REF}`, details: REF }, 500, 'server_error'],
  ]) {
    reset(); db.rpcResponse = { data: null, error }
    const r = await post(baseOrder({ parcel: { trackingRef: REF } }), ON)
    assert.deepEqual([r.status, r.body], [status, { error: code }], error.message)
    assert.ok(!r.logs.join('\n').includes(REF), `log leak for ${error.code}`)
  }
})
await test('flag ON: concurrent orders with the same tracking number → exactly one 201, the other 409 (DB unique index)', async () => {
  reset()
  let first = true
  db.rpcResponse = () => {
    if (first) { first = false; return null }
    return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "parcel_requests_active_key_uq"' } }
  }
  const rs = await Promise.all([post(baseOrder({ parcel: { trackingRef: REF } }), ON), post(baseOrder({ parcel: { trackingRef: REF.toLowerCase() } }), ON)])
  assert.deepEqual(rs.map(r => r.status).sort(), [201, 409])
})

/* ═══ 6. Static guarantees ═══ */
console.log('Static guarantees')
await test('atomic only: no direct parcel insert / multi-write; one RPC per order; no fallback to food-only on parcel errors', () => {
  for (const f of ['app/api/orders/route.ts', 'lib/createOrder.ts', 'lib/orderRequest.ts', 'lib/parcelCheckout.ts']) {
    const s = src(f).replace(/\/\/.*$/gm, '')
    assert.ok(!/from\('parcel_requests'\)|from\("parcel_requests"\)|parcel_events/.test(s), f)
  }
  const r = src('app/api/orders/route.ts')
  assert.match(r, /order\.parcel\s*\?\s*await createOrderWithParcelAtomic\(toCreate\.rpcArgs, order\.parcel\)\s*:\s*await createOrderAtomic\(toCreate\.rpcArgs\)/)
})
await test('no tracking number / carrier in any log statement; no customer UI change; no Maale / HYP / pricing change', () => {
  for (const f of ['app/api/orders/route.ts', 'lib/createOrder.ts', 'lib/parcelCheckout.ts']) {
    for (const line of src(f).split('\n').filter(l => /console\./.test(l)))
      assert.ok(!/trackingRef|tracking_ref|carrier|parcel\.|p_parcel|details/.test(line), `${f}: ${line.trim()}`)
  }
  // Customer UI (S4-B) may offer a parcel, but only through the S4-A contract: never a raw RPC payload, never the flag
  const page = src('app/order/page.tsx')
  assert.ok(!/p_parcel|tracking_ref|PARCEL_CHECKOUT_ENABLED|create_order_with_parcel/.test(page), 'page uses only the public `parcel` contract')
  const code = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  for (const f of ['lib/parcelCheckout.ts', 'lib/createOrder.ts']) assert.ok(!/maale|hyp|pricing|DELIVERY_FEES/i.test(code(src(f))), f)
})

console.log(`\nAll ${passed} parcel-checkout checks passed.`)
