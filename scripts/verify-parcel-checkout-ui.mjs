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
  for (const t of ['AB', 'RR123:456', 'עברית1234', '#### A'])
    assert.equal(F.parcelFormError(st({ trackingRef: t })), F.PARCEL_FORM_MESSAGES.trackingInvalid, t)
  for (const c of ['http://x.com', 'www.x.com', 'a\u0007b'])
    assert.equal(F.parcelFormError(st({ carrier: c })), F.PARCEL_FORM_MESSAGES.carrierInvalid, c)
  assert.equal(F.buildParcelWire(st({ carrier: 'http://x' })), undefined)
})
await test('tracking length 39 / 40 valid; 41 / 45 / 60 / 100 → "too long" message, nothing sent, server rejects', () => {
  const ref = n => ('RR' + '1234567890'.repeat(10)).slice(0, n - 2) + 'IL'
  for (const n of [39, 40, 41, 45, 60, 100]) {
    const t = ref(n), wire = F.buildParcelWire(st({ trackingRef: t }))
    assert.equal(t.length, n)
    if (n <= 40) { assert.equal(F.parcelFormError(st({ trackingRef: t })), null, n); assert.equal(wire.trackingRef, t) }
    else {
      assert.equal(F.parcelFormError(st({ trackingRef: t })), F.PARCEL_FORM_MESSAGES.trackingTooLong, n)
      assert.equal(wire, undefined, n)
      const body = { branchId: '8fed141d-0e7c-46c1-803b-88d3d811c1f8', type: 'delivery', customerName: 'ישראל', phone: '0501234567',
        paymentMethod: 'cash', items: [{ itemId: '11111111-1111-4111-8111-111111111111', quantity: 1 }],
        delivery: { city: 'מעלה אדומים', street: 'הדקל', houseNumber: '12' }, parcel: { trackingRef: t, carrier: null } }
      assert.equal(OR.parseCreateOrderRequest(body, { parcelCheckoutEnabled: true }).code, 'invalid_parcel', n)  // rule unchanged
    }
  }
  // length is judged after the parser's own normalization (trim + single spaces), so padding never triggers it
  assert.equal(F.parcelFormError(st({ trackingRef: '   ' + ref(40) + '   ' })), null)
  assert.equal(F.parcelFormError(st({ trackingRef: 'RR12  34567890' })), null)
  assert.match(F.PARCEL_FORM_MESSAGES.trackingTooLong, /40/)
})
await test('carrier length 40 valid; 41 / 100 → "too long" message, nothing sent', () => {
  assert.equal(F.parcelFormError(st({ carrier: 'x'.repeat(40) })), null)
  for (const n of [41, 100]) {
    assert.equal(F.parcelFormError(st({ carrier: 'x'.repeat(n) })), F.PARCEL_FORM_MESSAGES.carrierTooLong, n)
    assert.equal(F.buildParcelWire(st({ carrier: 'x'.repeat(n) })), undefined, n)
  }
  assert.equal(F.parcelFormError(st({ carrier: 'http://' + 'x'.repeat(40) })), F.PARCEL_FORM_MESSAGES.carrierTooLong) // either message blocks
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
  // HYP-DELIVERY-02: methodFor(type) = resolvePaymentMethod(type, paymentMethod) unless telephone credit is retired (verify-hyp-ui)
  // S4-HYP-PREFILL-03: customerName = joinCustomerName(first, last) (the full name, as before)
  for (const k of ['customerName,', 'phone: normalizePhone(orderPhone)', 'paymentMethod: methodFor(type)', 'items,', "delivery: type === 'delivery' ?"])
    assert.ok(m[0].includes(k), k)
})
await test('parcel UI is rendered only when parcelSectionVisible (flag on + delivery); checkbox text as specified', () => {
  assert.match(PAGE, /\{parcelSectionVisible && \(/)
  assert.match(PAGE, /📦 יש לי חבילה לצרף למשלוח/)
  assert.match(PAGE, /const parcelSectionVisible = isParcelSectionVisible\(parcelForm\)/)
})
await test('switching to pickup / leaving delivery / flag off clears the parcel; unticking clears the inputs; success clears', () => {
  assert.match(PAGE, /useEffect\(\(\) => \{\n\s*if \(!parcelSectionVisible\) clearParcelForm\(\)\n\s*\}, \[parcelSectionVisible\]\)/)
  assert.match(PAGE, /if \(!e\.target\.checked\) \{ setParcelTrackingRef\(''\); setParcelCarrier\(''\); setParcelRecipientName\(''\) \}/)
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
await test('tracking input is LTR, no autocomplete / spellcheck; inputs never cut at 40 (no silent truncation on paste)', () => {
  assert.match(PAGE, /value=\{parcelTrackingRef\} maxLength=\{PARCEL_INPUT_MAX_LENGTH\} dir="ltr" inputMode="text" autoComplete="off"/)
  assert.match(PAGE, /spellCheck=\{false\}/)
  assert.match(PAGE, /value=\{parcelCarrier\} maxLength=\{PARCEL_INPUT_MAX_LENGTH\} dir="rtl" autoComplete="off"/)
  assert.equal(F.PARCEL_INPUT_MAX_LENGTH, 200)              // far above the 40 rule; = the parser's raw-input bound
  assert.doesNotMatch(PAGE, /maxLength=\{40\}/)
})
/* ═══ 4. Entry options (S4-UX-04): איסוף עצמי / משלוח / משלוח אוכל + חבילה ═══ */
console.log('Entry options (static guarantees + state logic)')
const BRANCH_SCREEN = PAGE.slice(PAGE.indexOf("if (screen === 'branch') return ("), PAGE.indexOf("if (screen === 'tracking') {"))
const ORDER_SCREEN = PAGE.slice(PAGE.indexOf("if (screen === 'order') return ("))
const PARCEL_ENTRY = /\{orderTypeChoice !== 'pickup' && parcelCheckoutEnabled && deliveryBranch && \(\n\s*<button onClick=\{\(\) => selectBranch\(deliveryBranch, 'delivery', true\)\}/
await test('entry screen shows three options: pickup, delivery (both unchanged) and "📦 משלוח אוכל + חבילה" with its copy', () => {
  assert.match(BRANCH_SCREEN, /<button onClick=\{\(\) => setOrderTypeChoice\('pickup'\)\}/)
  assert.match(BRANCH_SCREEN, /<button onClick=\{\(\) => selectBranch\(deliveryBranch, 'delivery'\)\}/)   // food-only delivery: no parcel
  assert.match(BRANCH_SCREEN, PARCEL_ENTRY)
  assert.match(BRANCH_SCREEN, /📦 משלוח אוכל \+ חבילה/)
  assert.match(BRANCH_SCREEN, /מזמינים אוכל ומצרפים חבילה שממתינה בסניף\./)
  assert.equal((PAGE.match(/setParcelSelected\(true\)/g) || []).length, 1, 'only the entry option pre-selects a parcel')
})
await test('entry labels: "משלוח אוכל" on the entry delivery button; menu / checkout switches removed (S4-UX-11)', () => {
  assert.match(BRANCH_SCREEN, /<span style=\{\{ fontWeight: 900, fontSize: 19, color: C\.gold \}\}>משלוח אוכל<\/span>/)
  assert.doesNotMatch(PAGE, /\['delivery', '🛵', 'משלוח', DELIVERY_FEE_LABEL\]/)    // checkout switch gone
  assert.doesNotMatch(PAGE, /\{v === 'pickup' \? '🏃 איסוף' : '🛵 משלוח'\}/)        // menu switch gone
})
await test('parcel card pricing wording: no parcel fee, regular delivery fee applies — from the existing fee source', () => {
  assert.match(BRANCH_SCREEN, /צירוף החבילה ללא תוספת תשלום\. דמי משלוח רגילים חלים\./)
  assert.doesNotMatch(BRANCH_SCREEN, /— ללא תוספת תשלום/)                          // old ambiguous wording gone
  const card = BRANCH_SCREEN.slice(BRANCH_SCREEN.indexOf('📦 משלוח אוכל + חבילה'))
  assert.match(card.slice(0, 600), /\{DELIVERY_FEE_LABEL\}/)                      // same label as the delivery button
  assert.doesNotMatch(card.slice(0, 600), /₪\s?\d/)                              // no hard-coded price on the card
  assert.match(PAGE, /const DELIVERY_FEE_LABEL = `דמי משלוח ₪\$\{DELIVERY_FEE_RANGE\.min\}–₪\$\{DELIVERY_FEE_RANGE\.max\} לפי יישוב`/)
})
await test('parcel entry option only with the flag ON (config fails closed) and a delivery branch, in step 1 only', () => {
  assert.match(PAGE, /setParcelCheckoutEnabled\(j\?\.parcelCheckout === true\)/)
  assert.match(PAGE, /\.catch\(\(\) => \{ if \(!cancelled\) setParcelCheckoutEnabled\(false\) \}\)/)
  assert.match(PAGE, /const \[parcelCheckoutEnabled, setParcelCheckoutEnabled\] = useState\(false\)/)
  // the same guard as the pickup/delivery grid (step 1) plus the flag and the delivery branch
  assert.match(PAGE, PARCEL_ENTRY)
})
await test('selection survives branch selection + menu loading: selectBranch sets branch and delivery before its first await', () => {
  const fn = PAGE.slice(PAGE.indexOf('async function selectBranch('), PAGE.indexOf('// ── תמחור'))
  const firstAwait = fn.indexOf('await ')
  assert.ok(fn.indexOf('setSelectedBranch(branch)') < firstAwait && fn.indexOf("setOrderTypeChoice(type === 'delivery'") < firstAwait)
  // same handler, parcel first → one batched render with delivery → the section is visible → the clearing effect keeps it
  const st2 = { enabled: true, orderType: 'delivery', selected: true, trackingRef: '', carrier: '' }
  assert.equal(F.isParcelSectionVisible(st2), true)
  assert.equal(F.isParcelActive(st2), true)
  assert.equal(F.parcelFormError(st2), F.PARCEL_FORM_MESSAGES.trackingRequired)       // order blocked until a number is entered
  assert.equal(F.buildParcelWire(st2), undefined)
})
await test('switching to pickup clears the parcel; back to delivery does not restore it (re-select at checkout)', () => {
  assert.match(PAGE, /useEffect\(\(\) => \{\n\s*if \(!parcelSectionVisible\) clearParcelForm\(\)\n\s*\}, \[parcelSectionVisible\]\)/)
  assert.match(PAGE, /function clearParcelForm\(\) \{\n\s*setParcelSelected\(EMPTY_PARCEL_FORM\.selected\); setParcelTrackingRef\(EMPTY_PARCEL_FORM\.trackingRef\); setParcelCarrier\(EMPTY_PARCEL_FORM\.carrier\)/)
  assert.equal(F.isParcelSectionVisible({ enabled: true, orderType: 'pickup' }), false)   // pickup → effect clears
  assert.equal(F.buildParcelWire({ enabled: true, orderType: 'pickup', selected: true, trackingRef: REF, carrier: '' }), undefined)
  assert.equal(F.isParcelSectionVisible({ enabled: false, orderType: 'delivery' }), false) // flag off → cleared, nothing sent
  // nothing restores the selection: the entry option is the only setParcelSelected(true); the checkbox stays at checkout
  assert.match(ORDER_SCREEN, /<input type="checkbox" checked=\{parcelSelected\}/)
})
await test('tracking + carrier inputs stay near final checkout (order screen, after the address, before name / submit)', () => {
  const tracking = PAGE.indexOf('value={parcelTrackingRef}'), carrier = PAGE.indexOf('value={parcelCarrier}')
  // HYP-08: the submit button routes to the online-payment start only when that option is selected (flag on)
  const orderStart = PAGE.indexOf("if (screen === 'order') return ("), submit = PAGE.indexOf('<button onClick={payOnline ? startOnlinePayment : placeOrder}')
  assert.ok(orderStart > 0 && tracking > orderStart && carrier > tracking && submit > carrier)
  assert.ok(tracking > PAGE.indexOf('📍 כתובת למשלוח') && tracking < PAGE.indexOf('👤 שם מלא'))
  assert.ok(!BRANCH_SCREEN.includes('parcelTrackingRef') && !BRANCH_SCREEN.includes('parcelCarrier'))
  assert.equal((PAGE.match(/value=\{parcelTrackingRef\}/g) || []).length, 1, 'single tracking input — no duplicated form state')
})
await test('checkout shows an entry-selected parcel as already attached (same checkbox = edit / remove control)', () => {
  assert.match(ORDER_SCREEN, /\{parcelSelected \? '📦 חבילה מצורפת למשלוח' : '📦 יש לי חבילה לצרף למשלוח'\}/)
  assert.match(ORDER_SCREEN, /להסרת החבילה מההזמנה — יש לבטל את הסימון/)
  assert.match(ORDER_SCREEN, /if \(!e\.target\.checked\) \{ setParcelTrackingRef\(''\); setParcelCarrier\(''\); setParcelRecipientName\(''\) \}/)
})
await test('S4-C2-B truncation fix intact: inputs maxLength 200, rule 4–40, "too long" blocks the order', () => {
  assert.equal(F.PARCEL_INPUT_MAX_LENGTH, 200)
  assert.doesNotMatch(PAGE, /maxLength=\{40\}/)
  assert.equal(F.parcelFormError(st({ trackingRef: 'RR' + '1'.repeat(37) + 'IL' })), F.PARCEL_FORM_MESSAGES.trackingTooLong)
  assert.match(PAGE, /&& orderTypeReady && parcelError === null && !placingOrder/)
})

/* ═══ 5. Order type only on the entry screen; back keeps the cart; branch change confirms (S4-UX-11) ═══ */
console.log('Entry-only order type, back navigation, cart preservation')
const ORDER_START = PAGE.indexOf("if (screen === 'order') return (")
const MENU_START = PAGE.indexOf('\n  return (\n', ORDER_START)
const ORDER_ONLY = PAGE.slice(ORDER_START, MENU_START), MENU_SCREEN = PAGE.slice(MENU_START)
// Runs the real selectBranch / backToEntry source from page.tsx with recording stubs (no React, no network).
function pageFn(startMarker, endMarker, env) {
  const fnSrc = PAGE.slice(PAGE.indexOf(startMarker), PAGE.indexOf(endMarker))
  const js = ts.transpileModule(fnSrc, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText
  const name = /function (\w+)\(/.exec(fnSrc)[1]
  return new Function(...Object.keys(env), `${js}\nreturn ${name}`)(...Object.values(env))
}
const DELIVERY_BR = { id: '8fed141d-0e7c-46c1-803b-88d3d811c1f8', name: 'מעלה אדומים' }, OTHER_BR = { id: 'b2', name: 'אחר' }
function selectBranchHarness({ selected, cart, answer }) {
  const calls = []
  const rec = n => v => calls.push([n, v])
  const query = t => { const q = { select: () => q, order: () => q, eq: () => q, then: (ok) => ok({ data: [] }) }; calls.push(['load', t]); return q }
  const env = {
    selectedBranch: selected, cart, BRANCH_CHANGE_CONFIRM: 'החלפת סניף תרוקן את סל הקניות',
    window: { confirm: m => { calls.push(['confirm', m]); return answer } },
    isDeliveryBranch: id => id === DELIVERY_BR.id, getBrowserSupabase: () => ({ from: query }),
  }
  for (const s of ['setCart', 'setParcelSelected', 'setSelectedBranch', 'setLoading', 'setOrderTypeChoice', 'setOrderError',
    'setCategories', 'setMenuItems', 'setToppings', 'setActiveCategory', 'setScreen']) env[s] = rec(s)
  return { fn: pageFn('  async function selectBranch(', '  // Back to the entry screen', env), calls }
}
const names = calls => calls.map(c => c[0])
await test('no interactive order-type switch in the menu or checkout; read-only label instead', () => {
  assert.doesNotMatch(MENU_SCREEN, /setOrderTypeChoice/); assert.doesNotMatch(ORDER_ONLY, /setOrderTypeChoice/)
  assert.match(MENU_SCREEN, /whiteSpace: 'nowrap' \}\}>\{menuOrderTypeLabel\}<\/div>/)       // menu: short label
  assert.match(ORDER_ONLY, /\{orderTypeLabel\}/); assert.doesNotMatch(ORDER_ONLY, /menuOrderTypeLabel/)  // checkout: full label
  assert.match(PAGE, /const isParcelOrder = effectiveOrderType === 'delivery' && parcelSectionVisible && parcelSelected/)
  assert.match(PAGE, /const orderTypeLabel = effectiveOrderType === 'delivery' \? \(isParcelOrder \? '📦 משלוח אוכל \+ חבילה' : '🛵 משלוח אוכל'\)\n\s*: effectiveOrderType === 'pickup' \? '🏃 איסוף עצמי' : 'לא נבחר סוג הזמנה'/)
  assert.match(PAGE, /const menuOrderTypeLabel = isParcelOrder \? '📦 משלוח \+ חבילה' : orderTypeLabel/)
  assert.match(BRANCH_SCREEN, /📦 משלוח אוכל \+ חבילה/)                                           // entry card text unchanged
  // setOrderTypeChoice remains only on the entry screen, in selectBranch / backToEntry, session restore and resets
  assert.equal((PAGE.match(/setOrderTypeChoice\(/g) || []).length, 7)
})
await test('menu back arrow and checkout "שינוי סוג הזמנה" both call backToEntry; checkout → menu unchanged', () => {
  assert.match(MENU_SCREEN, /<button onClick=\{backToEntry\}\n\s*style=\{\{ background: C\.border[^\n]*>→<\/button>/)
  assert.match(ORDER_ONLY, /<button onClick=\{backToEntry\}[\s\S]{0,400}שינוי סוג הזמנה/)
  assert.match(ORDER_ONLY, /<button onClick=\{\(\) => setScreen\('menu'\)\}/)
  assert.doesNotMatch(MENU_SCREEN, /localStorage\.removeItem\('falafel_session'\); setOrderTypeChoice\(null\); setScreen\('branch'\); setCart\(\[\]\)/)
})
await test('backToEntry: clears the session + order type, goes to entry, does NOT touch the cart', () => {
  const calls = []
  const fn = pageFn('  function backToEntry()', '  // ── תמחור', { localStorage: { removeItem: k => calls.push(['removeItem', k]) },
    setOrderTypeChoice: v => calls.push(['setOrderTypeChoice', v]), setOrderError: v => calls.push(['setOrderError', v]),
    setScreen: v => calls.push(['setScreen', v]), setCart: v => calls.push(['setCart', v]), setParcelSelected: v => calls.push(['setParcelSelected', v]) })
  fn()
  assert.deepEqual(calls, [['removeItem', 'falafel_session'], ['setOrderTypeChoice', null], ['setOrderError', ''], ['setScreen', 'branch']])
  // order type null → parcel section hidden → the existing effect clears parcel selection + fields
  assert.equal(F.isParcelSectionVisible({ enabled: true, orderType: null }), false)
})
await test('same branch (e.g. delivery → back → pickup at the delivery branch): cart kept, no confirm, menu reloads', async () => {
  const h = selectBranchHarness({ selected: DELIVERY_BR, cart: [{ q: 2 }], answer: false })
  await h.fn(DELIVERY_BR, 'pickup')
  assert.ok(!names(h.calls).includes('confirm') && !names(h.calls).includes('setCart'))
  assert.deepEqual(h.calls.find(c => c[0] === 'setOrderTypeChoice'), ['setOrderTypeChoice', 'pickup'])
  assert.deepEqual(h.calls.at(-1), ['setScreen', 'menu'])
})
await test('different branch, empty cart (or first visit): no confirm, no cart change', async () => {
  for (const selected of [DELIVERY_BR, null]) {
    const h = selectBranchHarness({ selected, cart: [], answer: false })
    await h.fn(OTHER_BR, 'pickup')
    assert.ok(!names(h.calls).includes('confirm') && !names(h.calls).includes('setCart'))
    assert.deepEqual(h.calls.at(-1), ['setScreen', 'menu'])
  }
})
await test('different branch + items → confirm; CANCEL changes nothing (no branch / cart / parcel / menu load / screen)', async () => {
  for (const withParcel of [false, true]) {
    const h = selectBranchHarness({ selected: OTHER_BR, cart: [{ q: 1 }], answer: false })
    await h.fn(DELIVERY_BR, 'delivery', withParcel)
    assert.deepEqual(names(h.calls), ['confirm'], `withParcel=${withParcel}`)
    assert.match(h.calls[0][1], /החלפת סניף תרוקן את סל הקניות/)
  }
  assert.match(PAGE, /const BRANCH_CHANGE_CONFIRM = 'החלפת סניף תרוקן את סל הקניות, מכיוון שהתפריטים עשויים להיות שונים\. להמשיך\?'/)
})
await test('different branch + items → CONFIRM clears the cart exactly once, before the new branch and menu load', async () => {
  const h = selectBranchHarness({ selected: OTHER_BR, cart: [{ q: 1 }], answer: true })
  await h.fn(DELIVERY_BR, 'delivery')
  const n = names(h.calls)
  assert.equal(n.filter(x => x === 'setCart').length, 1); assert.deepEqual(h.calls.find(c => c[0] === 'setCart'), ['setCart', []])
  assert.ok(n.indexOf('setCart') < n.indexOf('setSelectedBranch') && n.indexOf('setSelectedBranch') < n.indexOf('load'))
  assert.deepEqual(h.calls.find(c => c[0] === 'setOrderTypeChoice'), ['setOrderTypeChoice', 'delivery'])
  assert.deepEqual(h.calls.at(-1), ['setScreen', 'menu'])
})
await test('parcel entry: parcel set only after the guard, before the branch / order type and the first await', async () => {
  const h = selectBranchHarness({ selected: DELIVERY_BR, cart: [{ q: 1 }], answer: false })
  await h.fn(DELIVERY_BR, 'delivery', true)
  const n = names(h.calls)
  assert.deepEqual(h.calls.find(c => c[0] === 'setParcelSelected'), ['setParcelSelected', true])
  assert.ok(n.indexOf('setParcelSelected') < n.indexOf('setSelectedBranch') && n.indexOf('setOrderTypeChoice') < n.indexOf('load'))
  // food-only delivery never sets a parcel (no restore of a cleared one)
  const f = selectBranchHarness({ selected: DELIVERY_BR, cart: [], answer: false })
  await f.fn(DELIVERY_BR, 'delivery'); assert.ok(!names(f.calls).includes('setParcelSelected'))
})
await test('new-order resets still clear the cart (unchanged); parcel checkbox + tracking stay in checkout', () => {
  assert.match(PAGE, /<button onClick=\{\(\) => \{ setCart\(\[\]\); setOrderTypeChoice\(null\); setScreen\('branch'\) \}\}/)
  assert.match(PAGE, /setOrderId\(null\); setCart\(\[\]\); setOrderCart\(\[\]\); setOrderTypeChoice\(null\); setScreen\('branch'\)/)
  assert.match(ORDER_ONLY, /<input type="checkbox" checked=\{parcelSelected\}/)
  assert.match(ORDER_ONLY, /value=\{parcelTrackingRef\} maxLength=\{PARCEL_INPUT_MAX_LENGTH\}/)
})

await test('no pricing / Maale / HYP code in the new modules', () => {
  for (const f of ['lib/parcelCheckoutForm.ts', 'app/api/checkout/config/route.ts'])
    assert.ok(!/pricing|DELIVERY_FEES|maale|hyp|supabase/i.test(src(f).replace(/\/\/.*$/gm, '')), f)
})

/* ═══ 6. Optional parcel recipient name (S4-PARCEL-30B) ═══ */
console.log('Parcel recipient name (checkout)')
const RECIPIENT_BLOCK = PAGE.slice(PAGE.indexOf('{/* Optional parcel recipient (S4-PARCEL-30B)'), PAGE.indexOf('{parcelError && (parcelTrackingRef.length > 0'))
await test('field is inside the parcel details, always shown with them (no extra checkbox), exact label + helper, RTL, no silent truncation', () => {
  assert.ok(RECIPIENT_BLOCK.length > 0)
  assert.ok(PAGE.indexOf('value={parcelCarrier}') < PAGE.indexOf('value={parcelRecipientName}'))
  assert.ok(PAGE.indexOf('value={parcelRecipientName}') < PAGE.indexOf('👤 שם מלא'))
  assert.match(RECIPIENT_BLOCK, /<label style=\{labelStyle\}>שם הנמען על החבילה<\/label>/)
  assert.match(RECIPIENT_BLOCK, />אם השדה ריק, נשתמש בשם מזמין האוכל לזיהוי החבילה\.<\/div>/)
  assert.match(RECIPIENT_BLOCK, /value=\{parcelRecipientName\} maxLength=\{PARCEL_INPUT_MAX_LENGTH\} dir="rtl" autoComplete="off"/)
  assert.doesNotMatch(RECIPIENT_BLOCK, /type="checkbox"|required|\*<\/label>/)                      // optional, no extra checkbox
  assert.equal(F.PARCEL_INPUT_MAX_LENGTH, 200)                                                     // 60 is enforced by validation
  // shown exactly when the tracking / carrier inputs are shown (same parcelSelected block)
  const detailsBlock = PAGE.slice(PAGE.indexOf('{parcelSelected && (\n              <div style={{ marginTop: 14 }}>'), PAGE.indexOf('👤 שם מלא'))
  assert.ok(detailsBlock.includes('value={parcelTrackingRef}') && detailsBlock.includes('value={parcelRecipientName}'))
})
await test('A/B/C: empty, whitespace-only or untouched → no recipientName key in the wire (payload exactly as before)', () => {
  for (const r of [undefined, '', '   ']) {
    const w = F.buildParcelWire(st({ recipientName: r }))
    assert.deepEqual(Object.keys(w).sort(), ['carrier', 'trackingRef'], JSON.stringify(r))
    assert.equal(F.parcelFormError(st({ recipientName: r })), null)
  }
})
await test('D/F: entered name → trimmed recipientName in the wire; G/J/L invalid → Hebrew message, order blocked, nothing sent', () => {
  assert.deepEqual(F.buildParcelWire(st({ recipientName: '  נריה נוימן ' })), { trackingRef: REF, carrier: null, recipientName: 'נריה נוימן' })
  for (const bad of ['נ', 'א'.repeat(61), 'נריה\u0007']) {
    assert.equal(F.parcelFormError(st({ recipientName: bad })), F.PARCEL_FORM_MESSAGES.recipientInvalid, JSON.stringify(bad))
    assert.equal(F.buildParcelWire(st({ recipientName: bad })), undefined)
  }
  assert.match(F.PARCEL_FORM_MESSAGES.recipientInvalid, /2–60/)
  assert.match(PAGE, /&& orderTypeReady && parcelError === null && !placingOrder/)                 // invalid parcel blocks the order
  assert.match(PAGE, /\{parcelError && \(parcelTrackingRef\.length > 0 \|\| parcelCarrier\.length > 0 \|\| parcelRecipientName\.length > 0\) && \(/)
})
await test('tracking errors still win over the recipient (tracking validation unchanged); M: pickup / flag off → no parcel at all', () => {
  assert.equal(F.parcelFormError(st({ trackingRef: '', recipientName: 'נ' })), F.PARCEL_FORM_MESSAGES.trackingRequired)
  assert.equal(F.parcelFormError(st({ trackingRef: 'AB', recipientName: 'נריה נוימן' })), F.PARCEL_FORM_MESSAGES.trackingInvalid)
  assert.equal(F.buildParcelWire(st({ orderType: 'pickup', recipientName: 'נריה נוימן' })), undefined)
  assert.equal(F.buildParcelWire(st({ enabled: false, recipientName: 'נריה נוימן' })), undefined)
  assert.equal(F.buildParcelWire(st({ selected: false, recipientName: 'נריה נוימן' })), undefined)
})
await test('reset with the other parcel fields (untick, leave delivery / back to entry, success); kept on checkout ↔ menu', () => {
  assert.deepEqual(F.EMPTY_PARCEL_FORM, { selected: false, trackingRef: '', carrier: '', recipientName: '' })
  assert.match(PAGE, /function clearParcelForm\(\) \{[^}]*setParcelRecipientName\(EMPTY_PARCEL_FORM\.recipientName\)\n\s*\}/)
  // only clearParcelForm, the untick handler and the input itself write it — no other navigation path touches it
  assert.equal((PAGE.match(/setParcelRecipientName\(/g) || []).length, 3)
  assert.match(PAGE, /<button onClick=\{\(\) => setScreen\('menu'\)\}/)                              // checkout → menu keeps parcel state
  assert.match(PAGE, /recipientName: parcelRecipientName,\n\s*\}/)
})
await test('Q/R: customer name / pricing / payment code paths never reference the recipient', () => {
  for (const line of PAGE.split('\n').filter(l => /customerName|computeDisplayTotals|deliveryFee|paymentOptions|resolvePaymentMethod|setPaymentMethod/.test(l)))
    assert.ok(!/recipient/i.test(line), line.trim())
  assert.ok(!/localStorage[^\n]*recipient|recipient[^\n]*localStorage/i.test(PAGE), 'never persisted')
  assert.ok(!/console\.[a-z]+\([^)]*recipient/i.test(PAGE), 'never logged')
})

console.log(`\nAll ${passed} parcel-checkout UI checks passed.`)
