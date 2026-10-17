// Local checks for the customer parcel checkout UI (GATE S4-B): feature gating (GET /api/checkout/config, fail
// closed), the pure form logic in lib/parcelCheckoutForm.ts (what is shown / validated / sent), the exact food-only
// payload, and static guarantees on app/order/page.tsx. No network, no DB, no browser.
// Run: node scripts/verify-parcel-checkout-ui.mjs

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const src = p => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n') // working copies may be CRLF (core.autocrlf)
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
    if (name) return loadFile(join(ROOT, 'lib', name + '.ts'))
    return require(p)
  }
  new Function('exports', 'require', 'module', outputText)(mod.exports, req, mod)
  return mod.exports
}
const F = loadFile(join(ROOT, 'lib', 'parcelCheckoutForm.ts'))
const OR = loadFile(join(ROOT, 'lib', 'orderRequest.ts'))
const configRoute = loadFile(join(ROOT, 'app', 'api', 'checkout', 'config', 'route.ts'))
const PAGE = src('app/order/page.tsx')

let passed = 0
const test = async (name, fn) => { await fn(); passed++; console.log('  ✓', name) }
const REF = 'RR123456789IL'
const st = (o = {}) => ({ enabled: true, orderType: 'delivery', selected: true, trackingRef: REF, carrier: '', ...o })

/* ═══ 1. Feature gating ═══ */
console.log('Feature gating (GET /api/checkout/config)')
async function getConfig(value) {
  const saved = process.env.PARCEL_CHECKOUT_ENABLED
  if (value === undefined) delete process.env.PARCEL_CHECKOUT_ENABLED; else process.env.PARCEL_CHECKOUT_ENABLED = value
  try { const r = await configRoute.GET(); return { status: r.status, cache: r.headers.get('cache-control'), body: await r.json() } }
  finally { if (saved === undefined) delete process.env.PARCEL_CHECKOUT_ENABLED; else process.env.PARCEL_CHECKOUT_ENABLED = saved }
}
await test('config endpoint: absent / any non-"true" value → parcelCheckout false; exact "true" → true; no-store; boolean only', async () => {
  for (const v of [undefined, '', 'false', 'TRUE', '1', 'yes', ' true']) {
    const r = await getConfig(v)
    assert.deepEqual([r.status, r.body], [200, { parcelCheckout: false }], String(v)); assert.equal(r.cache, 'no-store')
  }
  assert.deepEqual((await getConfig('true')).body, { parcelCheckout: true })
  assert.deepEqual(Object.keys((await getConfig('true')).body), ['parcelCheckout'])   // never the raw value or other config
})
await test('config endpoint uses the SAME server function as POST /api/orders (single source of truth); not cached', () => {
  const r = src('app/api/checkout/config/route.ts')
  assert.match(r, /isParcelCheckoutEnabled\(process\.env\)/)
  assert.match(r, /export const dynamic = 'force-dynamic'/)
  assert.match(src('app/api/orders/route.ts'), /isParcelCheckoutEnabled\(process\.env\)/)
})
await test('page fails closed: starts disabled; only parcelCheckout === true enables; any error / non-200 → disabled', () => {
  assert.match(PAGE, /const \[parcelCheckoutEnabled, setParcelCheckoutEnabled\] = useState\(false\)/)
  assert.match(PAGE, /fetch\('\/api\/checkout\/config', \{ cache: 'no-store' \}\)/)
  assert.match(PAGE, /\.then\(r => \(r\.ok \? r\.json\(\) : null\)\)/)
  assert.match(PAGE, /setParcelCheckoutEnabled\(j\?\.parcelCheckout === true\)/)
  assert.match(PAGE, /\.catch\(\(\) => \{ if \(!cancelled\) setParcelCheckoutEnabled\(false\) \}\)/)
  assert.ok(!/NEXT_PUBLIC_PARCEL|PARCEL_CHECKOUT_ENABLED/.test(PAGE), 'no public env flag in the client')
})
await test('server stays authoritative: a parcel_checkout_disabled answer turns the section off in the UI', () => {
  assert.match(PAGE, /if \(code === 'parcel_checkout_disabled'\) setParcelCheckoutEnabled\(false\)/)
})

/* ═══ 2. Visibility / validation / wire ═══ */
console.log('Form logic (lib/parcelCheckoutForm)')
await test('section visible ONLY with the flag on AND a delivery order (never pickup, never before a choice)', () => {
  assert.equal(F.isParcelSectionVisible({ enabled: true, orderType: 'delivery' }), true)
  for (const s of [{ enabled: false, orderType: 'delivery' }, { enabled: true, orderType: 'pickup' }, { enabled: true, orderType: null }, { enabled: 'true', orderType: 'delivery' }])
    assert.equal(F.isParcelSectionVisible(s), false, JSON.stringify(s))
})
await test('feature OFF: no parcel is ever produced, whatever the inputs; no validation error blocks the order', () => {
  for (const s of [st({ enabled: false }), st({ enabled: false, trackingRef: 'bad!' })]) {
    assert.equal(F.buildParcelWire(s), undefined); assert.equal(F.parcelFormError(s), null)
  }
})
await test('checkbox not ticked: no parcel, no error (food-only order exactly as before)', () => {
  assert.equal(F.buildParcelWire(st({ selected: false })), undefined)
  assert.equal(F.parcelFormError(st({ selected: false, trackingRef: '' })), null)
})
await test('pickup: no parcel and no error even if stale parcel fields remain in state', () => {
  assert.equal(F.buildParcelWire(st({ orderType: 'pickup' })), undefined)
  assert.equal(F.parcelFormError(st({ orderType: 'pickup', trackingRef: 'bad' })), null)
})
await test('ticked: tracking number is required (Hebrew message); order blocked until valid', () => {
  for (const t of ['', '   ']) {
    assert.equal(F.parcelFormError(st({ trackingRef: t })), F.PARCEL_FORM_MESSAGES.trackingRequired)
    assert.equal(F.buildParcelWire(st({ trackingRef: t })), undefined)
  }
})
await test('invalid tracking number / carrier → Hebrew message, nothing sent (same rules as the server)', () => {
  for (const t of ['AB', 'RR123:456', 'עברית1234', 'A'.repeat(41), '#### A'])
    assert.equal(F.parcelFormError(st({ trackingRef: t })), F.PARCEL_FORM_MESSAGES.trackingInvalid, t)
  for (const c of ['http://x.com', 'www.x.com', 'x'.repeat(41), 'a\u0007b'])
    assert.equal(F.parcelFormError(st({ carrier: c })), F.PARCEL_FORM_MESSAGES.carrierInvalid, c)
  assert.equal(F.buildParcelWire(st({ carrier: 'http://x' })), undefined)
})
await test('valid: wire is exactly the S4-A contract { trackingRef, carrier } — normalized, carrier null when empty', () => {
  assert.deepEqual(F.buildParcelWire(st({ trackingRef: '  ' + REF + ' ' })), { trackingRef: REF, carrier: null })
  assert.deepEqual(F.buildParcelWire(st({ carrier: '  דואר ישראל ' })), { trackingRef: REF, carrier: 'דואר ישראל' })
  assert.deepEqual(Object.keys(F.buildParcelWire(st())).sort(), ['carrier', 'trackingRef'])
})
await test('whatever the UI sends is accepted by the S4-A server parser (flag on), and rejected with the flag off', () => {
  const body = { branchId: '8fed141d-0e7c-46c1-803b-88d3d811c1f8', type: 'delivery', customerName: 'ישראל', phone: '0501234567',
    paymentMethod: 'cash', items: [{ itemId: '11111111-1111-4111-8111-111111111111', quantity: 1 }],
    delivery: { city: 'מעלה אדומים', street: 'הדקל', houseNumber: '12' }, parcel: F.buildParcelWire(st({ carrier: 'DHL' })) }
  const on = OR.parseCreateOrderRequest(body, { parcelCheckoutEnabled: true })
  assert.equal(on.ok, true); assert.deepEqual(on.value.parcel, { trackingRef: REF, carrier: 'DHL' })
  assert.equal(OR.parseCreateOrderRequest(body).code, 'parcel_checkout_disabled')
})
await test('server error codes have friendly Hebrew messages (no raw DB text)', () => {
  for (const k of ['parcel_checkout_disabled', 'invalid_parcel', 'parcel_duplicate']) {
    assert.ok(typeof F.PARCEL_ORDER_ERROR_MESSAGES[k] === 'string' && /[֐-׿]/.test(F.PARCEL_ORDER_ERROR_MESSAGES[k]), k)
    assert.ok(!/23505|constraint|parcel_requests|SQL|PGRST/i.test(F.PARCEL_ORDER_ERROR_MESSAGES[k]), k)
  }
  assert.match(PAGE, /\.\.\.PARCEL_ORDER_ERROR_MESSAGES,/)                      // merged into the existing map
  assert.match(PAGE, /\(code && ORDER_ERROR_MESSAGES\[code\]\) \|\| GENERIC_ORDER_ERROR/)  // unknown codes → generic text
})

/* ═══ 3. Page: exact food-only payload, clearing, no persistence, no logging ═══ */
console.log('Page (static guarantees)')
await test('order request: the parcel is added only via parcelWireFor() → {} unless a valid delivery parcel (no `parcel` key otherwise)', () => {
  assert.match(PAGE, /\.\.\.parcelWireFor\(type\), \/\/ \{\} unless a valid parcel/)
  assert.match(PAGE, /const parcel = buildParcelWire\(\{ \.\.\.parcelForm, orderType: type \}\)\n\s*return parcel \? \{ parcel \} : \{\}/)
  assert.equal((PAGE.match(/parcel:/g) || []).length, 0, 'no other place builds a parcel field')
})
await test('food-only request keys are unchanged (same object shape as before S4-B, plus nothing)', () => {
  const m = /return \{\n\s*branchId, type,\n[\s\S]*?\.\.\.parcelWireFor\(type\)/.exec(PAGE)
  assert.ok(m, 'request builder found')
  for (const k of ['customerName: customerName.trim()', 'phone: normalizePhone(orderPhone)', 'paymentMethod: resolvePaymentMethod(type, paymentMethod)', 'items,', "delivery: type === 'delivery' ?"])
    assert.ok(m[0].includes(k), k)
})
await test('parcel UI is rendered only when parcelSectionVisible (flag on + delivery); checkbox text as specified', () => {
  assert.match(PAGE, /\{parcelSectionVisible && \(/)
  assert.match(PAGE, /📦 יש לי חבילה לצרף למשלוח/)
  assert.match(PAGE, /const parcelSectionVisible = isParcelSectionVisible\(parcelForm\)/)
})
await test('switching to pickup / leaving delivery / flag off clears the parcel; unticking clears the inputs; success clears', () => {
  assert.match(PAGE, /useEffect\(\(\) => \{\n\s*if \(!parcelSectionVisible\) clearParcelForm\(\)\n\s*\}, \[parcelSectionVisible\]\)/)
  assert.match(PAGE, /if \(!e\.target\.checked\) \{ setParcelTrackingRef\(''\); setParcelCarrier\(''\) \}/)
  assert.match(PAGE, /setCart\(\[\]\); clearParcelForm\(\); setPlacingOrder\(false\)/)
})
await test('invalid parcel blocks submission and explains why; valid parcel does not change price / fee / payment UI', () => {
  assert.match(PAGE, /&& orderTypeReady && parcelError === null && !placingOrder/)
  assert.match(PAGE, /: parcelError !== null \? '📦 נא להשלים את פרטי החבילה'/)
  // pricing / fee / payment code paths do not reference the parcel
  for (const line of PAGE.split('\n').filter(l => /computeDisplayTotals|deliveryFee|getDeliveryFeeForArea|paymentOptions|resolvePaymentMethod/.test(l)))
    assert.ok(!/parcel/i.test(line), line.trim())
})
await test('tracking number is never persisted or logged by the page', () => {
  for (const line of PAGE.split('\n').filter(l => /localStorage\.setItem|sessionStorage|console\./.test(l)))
    assert.ok(!/parcel|tracking/i.test(line), line.trim())
  assert.ok(!/parcel/i.test(/localStorage\.setItem\('falafel_session', JSON\.stringify\(\{[\s\S]*?\}\)\)/.exec(PAGE.slice(PAGE.indexOf('async function placeOrder')))?.[0] ?? ''))
  assert.ok(!/console\./.test(src('lib/parcelCheckoutForm.ts').replace(/\/\/.*$/gm, '')))
})
await test('tracking input is LTR, ≤ 40 chars, no autocomplete / spellcheck; carrier ≤ 40 chars', () => {
  assert.match(PAGE, /value=\{parcelTrackingRef\} maxLength=\{40\} dir="ltr" inputMode="text" autoComplete="off"/)
  assert.match(PAGE, /spellCheck=\{false\}/)
  assert.match(PAGE, /value=\{parcelCarrier\} maxLength=\{40\} dir="rtl" autoComplete="off"/)
})
await test('no pricing / Maale / HYP code in the new modules', () => {
  for (const f of ['lib/parcelCheckoutForm.ts', 'app/api/checkout/config/route.ts'])
    assert.ok(!/pricing|DELIVERY_FEES|maale|hyp|supabase/i.test(src(f).replace(/\/\/.*$/gm, '')), f)
})

console.log(`\nAll ${passed} parcel-checkout UI checks passed.`)
