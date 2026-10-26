// Offline checks for the HYP-08 customer payment UI and the staff reconciliation view.
// Pure modules + server-side rendering of the presentational components (react-dom/server) + the read-only kitchen
// handler with injected session / data + static regression checks of the two edited pages against git HEAD.
// The real global fetch is replaced by a throwing stub. No env file, no Supabase, no network, no browser.
// Run: node scripts/verify-hyp-ui.mjs

import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import assert from 'node:assert/strict'

const fetchCalls = []
globalThis.fetch = async url => { fetchCalls.push(String(url)); throw new Error('LIVE NETWORK CALL ATTEMPTED') }

const require = createRequire(import.meta.url)
const ts = require('typescript')
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cache = new Map()
const resolveTs = base => [base + '.ts', base + '.tsx', base].find(p => existsSync(p) && !p.endsWith('/')) ?? base + '.ts'
function load(file) {
  if (cache.has(file)) return cache.get(file).exports
  const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  })
  const mod = { exports: {} }
  cache.set(file, mod)
  const req = p => p.startsWith('@/') ? load(resolveTs(join(ROOT, p.slice(2)))) : p.startsWith('.') ? load(resolveTs(resolve(dirname(file), p))) : require(p)
  new Function('exports', 'require', 'module', outputText)(mod.exports, req, mod)
  return mod.exports
}
const CU = load(join(ROOT, 'lib', 'hyp', 'hypCheckoutUi.ts'))
const SU = load(join(ROOT, 'lib', 'hyp', 'hypStatusUi.ts'))
const SVC = load(join(ROOT, 'lib', 'hyp', 'hypPaymentService.ts'))
const REC = load(join(ROOT, 'lib', 'hyp', 'hypReconciliation.ts'))
const KA = load(join(ROOT, 'lib', 'kitchenAuth.ts'))
const VIEW = load(join(ROOT, 'app', 'order', 'payment', 'PaymentStatusView.tsx'))
const TAB = load(join(ROOT, 'app', 'dashboard', 'orders', 'PaymentsTab.tsx'))
// Working copies are CRLF (core.autocrlf=true), blobs are LF: compare normalized text.
const lf = s => s.replace(/\r\n/g, '\n')
const src = f => lf(readFileSync(join(ROOT, f), 'utf8'))
// Fixed pre-HYP baseline (main before the HYP release, HYP-RELEASE-02A). Comparing against HEAD would be vacuous once the
// HYP work is committed. `git diff <base>` compares the base with the WORKING TREE: committed and uncommitted changes.
const PRE_HYP_BASE = '3bfa329c2294e77204aecfac528513b792eb0c1c'
const head = f => lf(execFileSync('git', ['show', `${PRE_HYP_BASE}:${f}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 << 20 }))
const gitDiff = f => lf(execFileSync('git', ['diff', '-U0', PRE_HYP_BASE, '--', f], { cwd: ROOT, encoding: 'utf8' }))
// HYP-DELIVERY-02: the HYP-08 guards below are pinned to the released range PRE_HYP_BASE → HYP_DELIVERY_BASE (924e076,
// Production before HYP delivery); the later, flag-gated HYP-DELIVERY-02 changes are checked separately against it.
const HYP_DELIVERY_BASE = '924e07622536cfeda13b1be7cf0e0adf4c3f7e5e'
const gitDiffReleased = f => lf(execFileSync('git', ['diff', '-U0', PRE_HYP_BASE, HYP_DELIVERY_BASE, '--', f], { cwd: ROOT, encoding: 'utf8' }))
const gitDiffSinceRelease = f => lf(execFileSync('git', ['diff', '-U0', HYP_DELIVERY_BASE, '--', f], { cwd: ROOT, encoding: 'utf8' }))
const atRelease = f => lf(execFileSync('git', ['show', `${HYP_DELIVERY_BASE}:${f}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 << 20 }))
execFileSync('git', ['merge-base', '--is-ancestor', HYP_DELIVERY_BASE, 'HEAD'], { cwd: ROOT })
// Existing files only: modified / deleted / renamed / type-changed — newly ADDED HYP files are not "changes to legacy".
const changedLegacy = paths => execFileSync('git', ['diff', '--name-only', '--diff-filter=MDRT', PRE_HYP_BASE, '--', ...paths], { cwd: ROOT, encoding: 'utf8' }).trim()
execFileSync('git', ['merge-base', '--is-ancestor', PRE_HYP_BASE, 'HEAD'], { cwd: ROOT })   // throws if the baseline is not an ancestor
const html = (C, p) => renderToStaticMarkup(React.createElement(C, p))

let passed = 0, failed = 0
const test = async (name, fn) => {
  try { await fn(); passed++; console.log('  ✓', name) }
  catch (e) { failed++; console.log('  ✗', name, '\n     ', e.message.split('\n')[0]) }
}

const B1 = '8fed141d-0e7c-46c1-803b-88d3d811c1f8'
const B2 = '3ab15ad1-e835-492b-bae5-11b202ee2314'
const API_KEY = 'fakeKEY-7f3a9c11', PASSP = 'fakePassP-42b8'
const ENV = { HYP_PAYMENTS_ENABLED: 'true', HYP_TERMINAL: '0010000001', HYP_API_KEY: API_KEY, HYP_PASSP: PASSP, HYP_TERMINAL_KIND: 'test', HYP_PILOT_PHONES: '0501234567' }
const TOKEN = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const TRACK = 'f0e1d2c3-b4a5-4697-8879-6a5b4c3d2e1f'

console.log('Visibility (server config + client gating)')
await test('GET /api/payments/config: null unless the flag is exactly true AND the terminal configuration AND the pilot phone list are valid', async () => {
  for (const env of [{}, { ...ENV, HYP_PAYMENTS_ENABLED: 'false' }, { ...ENV, HYP_PAYMENTS_ENABLED: 'TRUE' }, { ...ENV, HYP_PASSP: '' },
                     { ...ENV, HYP_TERMINAL: '0882001234', HYP_TERMINAL_KIND: 'live', VERCEL_ENV: 'preview' },
                     { ...ENV, HYP_PILOT_PHONES: undefined }, { ...ENV, HYP_PILOT_PHONES: '' }, { ...ENV, HYP_PILOT_PHONES: '  ' }, { ...ENV, HYP_PILOT_PHONES: '050-1234567' },
                     { ...ENV, HYP_PILOT_PHONES: '0501234567,' }]) {
    const res = SVC.handlePaymentsConfig(env)
    assert.deepEqual(await res.json(), { hypPayments: null }); assert.equal(res.headers.get('cache-control'), 'no-store, max-age=0')
  }
  const on = await SVC.handlePaymentsConfig(ENV).text()
  assert.deepEqual(JSON.parse(on), { hypPayments: { branchIds: [B1], orderTypes: ['pickup'] } })
  assert.ok(!on.includes(API_KEY) && !on.includes(PASSP) && !on.includes('0010000001') && !on.includes('0501234567'))
  assert.match(src('app/api/payments/config/route.ts'), /return handlePaymentsConfig\(process\.env\)/)
})
await test('HYP-46 config: HYP_PAYMENTS_AUDIENCE=all shows the option without a pilot list — same branch / pickup scope; flag + terminal still required', async () => {
  const OPEN = { ...ENV, HYP_PILOT_PHONES: undefined, HYP_PAYMENTS_AUDIENCE: 'all' }
  assert.deepEqual(await SVC.handlePaymentsConfig(OPEN).json(), { hypPayments: { branchIds: [B1], orderTypes: ['pickup'] } })
  for (const env of [{ ...OPEN, HYP_PAYMENTS_AUDIENCE: 'ALL' }, { ...OPEN, HYP_PAYMENTS_AUDIENCE: 'true' }, { ...OPEN, HYP_PAYMENTS_ENABLED: 'false' },
                     { ...OPEN, HYP_PASSP: '' }, { ...OPEN, HYP_TERMINAL: '0882001234', HYP_TERMINAL_KIND: 'live', VERCEL_ENV: 'preview' }])
    assert.deepEqual(await SVC.handlePaymentsConfig(env).json(), { hypPayments: null }, JSON.stringify(env.HYP_PAYMENTS_AUDIENCE))
})
await test('client parsing fails closed; only pickup / delivery as the SERVER advertises them (HYP-DELIVERY-02); credit retirement exact true only', () => {
  for (const bad of [null, {}, { hypPayments: null }, { hypPayments: true }, { hypPayments: { branchIds: 'x', orderTypes: ['pickup'] } },
                     { hypPayments: { branchIds: [B1], orderTypes: ['parcel', 'online'] } }, { hypPayments: { branchIds: ['nope'], orderTypes: ['pickup'] } }])
    assert.equal(CU.parsePaymentsConfig(bad), null, JSON.stringify(bad))
  assert.deepEqual(CU.parsePaymentsConfig({ hypPayments: { branchIds: [B1], orderTypes: ['pickup'] } }), { branchIds: [B1], orderTypes: ['pickup'] })
  assert.deepEqual(CU.parsePaymentsConfig({ hypPayments: { branchIds: [B1], orderTypes: ['pickup', 'delivery', 'x'] } }), { branchIds: [B1], orderTypes: ['pickup', 'delivery'] })
  for (const v of [undefined, false, 'true', 1, {}]) assert.equal(CU.parseDeliveryCreditRetired({ deliveryCreditRetired: v }), false, String(v))
  assert.equal(CU.parseDeliveryCreditRetired({ deliveryCreditRetired: true }), true); assert.equal(CU.parseDeliveryCreditRetired(null), false)
  // availability: delivery and delivery + parcel only when advertised; pickup never with a parcel
  const pick = { branchIds: [B1], orderTypes: ['pickup'] }, both = { branchIds: [B1], orderTypes: ['pickup', 'delivery'] }
  assert.equal(CU.isOnlinePaymentAvailable(pick, B1, 'delivery', false), false); assert.equal(CU.isOnlinePaymentAvailable(pick, B1, 'delivery', true), false)
  assert.equal(CU.isOnlinePaymentAvailable(both, B1, 'delivery', false), true); assert.equal(CU.isOnlinePaymentAvailable(both, B1, 'delivery', true), true)
  assert.equal(CU.isOnlinePaymentAvailable(both, B1, 'pickup', true), false); assert.equal(CU.isOnlinePaymentAvailable(both, B1, null, false), false)
  // start body: pickup exactly the five fields as before; delivery adds the address and (only when attached) the parcel
  const req = { branchId: B1, type: 'pickup', customerName: 'x', phone: '0501234567', paymentMethod: 'cash', items: [], delivery: { city: 'c' }, parcel: { trackingRef: 'RR1' } }
  assert.deepEqual(Object.keys(CU.buildHypStartBody(req, 'k')), ['checkoutKey', 'branchId', 'type', 'customerName', 'phone', 'items'])
  assert.deepEqual(Object.keys(CU.buildHypStartBody({ ...req, type: 'delivery' }, 'k')), ['checkoutKey', 'branchId', 'type', 'customerName', 'phone', 'items', 'delivery', 'parcel'])
  assert.ok(!('parcel' in CU.buildHypStartBody({ ...req, type: 'delivery', parcel: undefined }, 'k')))
  assert.ok(!('paymentMethod' in CU.buildHypStartBody({ ...req, type: 'delivery' }, 'k')), 'never a payment method')
})
await test('branch / order type / parcel gating: adumim pickup only', () => {
  const cfg = { branchIds: [B1], orderTypes: ['pickup'] }
  assert.equal(CU.isOnlinePaymentAvailable(cfg, B1, 'pickup', false), true)
  assert.equal(CU.isOnlinePaymentAvailable(cfg, B1, 'delivery', false), false)
  assert.equal(CU.isOnlinePaymentAvailable(cfg, B1, 'pickup', true), false)
  assert.equal(CU.isOnlinePaymentAvailable(cfg, B2, 'pickup', false), false)
  assert.equal(CU.isOnlinePaymentAvailable(cfg, B1, null, false), false)
  assert.equal(CU.isOnlinePaymentAvailable(null, B1, 'pickup', false), false)
})

console.log('Checkout start (client side)')
await test('start body: order intent only — no payment method, amount, delivery or parcel', () => {
  const req = { branchId: B1, type: 'pickup', customerName: 'Dana', phone: '0501234567', paymentMethod: 'cash', items: [{ itemId: 'x', quantity: 2 }], delivery: { city: 'x' }, parcel: { trackingRef: 'y' } }
  const b = CU.buildHypStartBody(req, TOKEN)
  assert.deepEqual(Object.keys(b).sort(), ['branchId', 'checkoutKey', 'customerName', 'items', 'phone', 'type'])
  assert.equal(b.checkoutKey, TOKEN)
})
await test('duplicate click / retry: the same cart reuses the checkout key; a changed cart gets a new one', () => {
  const store = new Map(); const storage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) }
  let n = 0; const gen = () => `0000000${++n}-0000-4000-8000-000000000000`
  const a = CU.checkoutKeyFor(storage, 'cart-A', gen), b = CU.checkoutKeyFor(storage, 'cart-A', gen), c = CU.checkoutKeyFor(storage, 'cart-B', gen)
  assert.equal(a, b); assert.notEqual(a, c)
  store.set(CU.HYP_CHECKOUT_KEY, '{corrupt'); assert.notEqual(CU.checkoutKeyFor(storage, 'cart-B', gen), c)
  assert.notEqual(CU.checkoutKeyFor(null, 'cart-A', gen), CU.checkoutKeyFor(null, 'cart-A', gen))
})
await test('safe redirect: only the Hyp Pay payment page (action=pay, no credentials) is ever navigated to', () => {
  assert.equal(CU.isSafeHypRedirect('https://pay.hyp.co.il/p/?action=pay&Masof=0010000001&Amount=40.00&signature=x'), true)
  for (const bad of ['http://pay.hyp.co.il/p/?action=pay', 'https://pay.hyp.co.il.evil.test/p/?action=pay', 'https://evil.test/?u=https://pay.hyp.co.il/p/?action=pay',
                     'https://user:pw@pay.hyp.co.il/p/?action=pay', 'https://pay.hyp.co.il/p/?action=pay&KEY=k', 'https://pay.hyp.co.il/p/?action=APISign',
                     'https://pay.hyp.co.il/x/?action=pay', 'javascript:alert(1)', '/order/payment', null, 42])
    assert.equal(CU.isSafeHypRedirect(bad), false, String(bad))
})
await test('start responses → redirect / existing status page / clear error; never a second payment for an open one', () => {
  const ok = 'https://pay.hyp.co.il/p/?action=pay&Order=A1B2C3D4&signature=x'
  assert.deepEqual(CU.interpretStartResponse(200, { redirectUrl: ok, statusToken: TOKEN }), { kind: 'redirect', url: ok, token: TOKEN })
  assert.equal(CU.interpretStartResponse(200, { redirectUrl: 'https://evil.test', statusToken: TOKEN }).kind, 'error')
  assert.deepEqual(CU.interpretStartResponse(409, { error: 'payment_in_progress', statusToken: TOKEN }), { kind: 'status', token: TOKEN })
  assert.equal(CU.interpretStartResponse(409, { error: 'payment_in_progress' }).message, CU.HYP_START_MESSAGES.inProgress)
  assert.equal(CU.interpretStartResponse(404, { error: 'payments_disabled' }).disableOnline, true)
  assert.equal(CU.interpretStartResponse(409, { error: 'checkout_expired', statusToken: TOKEN }).resetKey, true)
  assert.equal(CU.interpretStartResponse(409, { error: 'checkout_key_reused' }).resetKey, true)
  assert.equal(CU.interpretStartResponse(429, { error: 'rate_limited' }).message, CU.HYP_START_MESSAGES.rateLimited)
  assert.equal(CU.interpretStartResponse(502, { error: 'payment_provider_unavailable' }).message, CU.HYP_START_MESSAGES.unavailable)
  assert.equal(CU.interpretStartResponse(500, null).message, CU.HYP_START_MESSAGES.generic)
})

console.log('Payment status page')
await test('public status parsing: the seven states; anything unexpected is not shown as confirmed', () => {
  for (const s of SU.HYP_PUBLIC_STATES.filter(x => x !== 'confirmed')) assert.deepEqual(SU.parsePublicStatus({ state: s }), { state: s })
  assert.deepEqual(SU.parsePublicStatus({ state: 'confirmed', order: { orderNumber: 7, dailyNumber: 3, status: 'received', trackingId: TRACK } }),
    { state: 'confirmed', order: { orderNumber: 7, dailyNumber: 3, status: 'received', trackingId: TRACK } })
  assert.deepEqual(SU.parsePublicStatus({ state: 'confirmed' }), { state: 'in_review' })
  assert.deepEqual(SU.parsePublicStatus({ state: 'confirmed', order: { trackingId: 'x' } }), { state: 'in_review' })
  for (const bad of [null, {}, { state: 'paid' }, { state: 'finalized' }, 'confirmed']) assert.equal(SU.parsePublicStatus(bad), null)
})
await test('bounded polling: 3 s → 10 s after 2 min → stop at 15 min; terminal states stop; review 30 s; errors 10 s', () => {
  assert.equal(SU.nextPollDelayMs('awaiting_payment', 0), 3000); assert.equal(SU.nextPollDelayMs('processing', 119_000), 3000)
  assert.equal(SU.nextPollDelayMs('processing', 121_000), 10_000); assert.equal(SU.nextPollDelayMs('processing', 15 * 60_000), null)
  for (const s of ['confirmed', 'failed', 'not_charged', 'refunded']) assert.equal(SU.nextPollDelayMs(s, 0), null, s)
  assert.equal(SU.nextPollDelayMs('in_review', 0), 30_000); assert.equal(SU.nextPollDelayMs(null, 0), 10_000); assert.equal(SU.nextPollDelayMs(null, 16 * 60_000), null)
})
const V = VIEW.PaymentStatusView
await test('all seven display states render in Hebrew RTL, as an accessible live region, mobile-width', () => {
  for (const state of SU.HYP_PUBLIC_STATES) {
    const status = state === 'confirmed' ? { state, order: { orderNumber: 41, dailyNumber: 12, status: 'received', trackingId: TRACK } } : { state }
    const m = html(V, { status, phase: 'ready', onTrack: () => {}, onRefresh: () => {} })
    assert.match(m, /^<main dir="rtl" lang="he"/, state)
    assert.match(m, /role="status" aria-live="polite" aria-atomic="true"/, state)
    assert.ok(m.includes(SU.STATE_VIEW[state].title), state)
    assert.match(m, /max-width:480px/); assert.match(m, /width:100%/); assert.match(m, /box-sizing:border-box/)
    for (const btn of m.match(/<(button|a) [^>]*min-height:[0-9]+px/g) ?? []) assert.match(btn, /min-height:48px/)
  }
})
await test('confirmed shows order + daily number and a tracking action; no payment / personal / internal data', () => {
  const m = html(V, { status: { state: 'confirmed', order: { orderNumber: 41, dailyNumber: 12, status: 'received', trackingId: TRACK } }, phase: 'ready', onTrack: () => {} })
  assert.ok(m.includes('>12<') && m.includes('>41<') && m.includes('למעקב אחרי ההזמנה'))
  for (const s of [TRACK, TOKEN, 'CCode', 'Id=', 'hyp', 'HYP', '₪', 'Dana', '050']) assert.ok(!m.includes(s), s)
})
await test('no new-payment offer for an ambiguous outcome; only after a certain non-charge', () => {
  const offer = s => html(V, { status: { state: s }, phase: 'ready' }).includes('href="/order"')
  assert.deepEqual(Object.fromEntries(SU.HYP_PUBLIC_STATES.filter(s => s !== 'confirmed').map(s => [s, offer(s)])),
    { awaiting_payment: false, processing: false, failed: true, in_review: false, not_charged: true, refunded: false })
  assert.match(html(V, { status: { state: 'in_review' }, phase: 'ready' }), /href="tel:0585505014"/)
  assert.match(html(V, { status: null, phase: 'not_found' }), /לא מצאנו את התשלום/)
  assert.match(html(V, { status: { state: 'processing' }, phase: 'stopped', onRefresh: () => {} }), /בדיקת מצב מחדש/)
})
await test('status page: GET-only, no-store, bounded + cancelled polling; a refresh never starts a payment', () => {
  const p = src('app/order/payment/[token]/page.tsx')
  assert.deepEqual([...p.matchAll(/fetch\(`([^`$]+)/g)].map(m => m[1]), ['/api/payments/intents/'])
  assert.ok(!/payments\/hyp\/start|method: 'POST'|placeOrder/.test(p))
  assert.match(p, /cache: 'no-store', signal: controller\.signal/); assert.match(p, /nextPollDelayMs\(/)
  assert.match(p, /return \(\) => \{ cancelled = true; controller\.abort\(\); if \(timer\) clearTimeout\(timer\) \}/)
  const f = src('app/order/payment/page.tsx'); assert.ok(!/fetch\(/.test(f), 'fallback page makes no request')
})
await test('tracking hand-off: only the order capability, the pilot branch and the daily number', () => {
  const t = SU.trackingSessionFor({ orderNumber: 41, dailyNumber: 12, status: 'received', trackingId: TRACK }, B1, 1000)
  assert.deepEqual(Object.keys(t).sort(), ['branchId', 'expires', 'orderDailyNumber', 'orderId', 'orderPaymentMethod'])
  assert.equal(t.orderId, TRACK); assert.equal(t.expires, 1000 + 6 * 3600 * 1000)
})

console.log('Checkout page integration (app/order/page.tsx)')
const page = src('app/order/page.tsx'), pageHead = head('app/order/page.tsx')
const fn = (s, name) => { const i = s.indexOf(`  async function ${name}(`); const j = s.indexOf('\n  }\n', i); return i >= 0 && j > i ? s.slice(i, j) : null }
const fnSync = (s, name) => { const i = s.indexOf(`  function ${name}(`); const j = s.indexOf('\n  }\n', i); return i >= 0 && j > i ? s.slice(i, j) : null }
await test('legacy order path byte-identical to the pre-HYP baseline: placeOrder, buildOrderRequest, POST /api/orders, tracking poll', () => {
  assert.ok(fn(pageHead, 'placeOrder')); assert.equal(fn(page, 'placeOrder'), fn(pageHead, 'placeOrder'))
  // HYP-DELIVERY-02: exactly one line differs — the payment method through methodFor(), which equals
  // resolvePaymentMethod() unless telephone credit is retired for a delivery (checked below)
  assert.equal(fnSync(page, 'buildOrderRequest').replace('      paymentMethod: methodFor(type),', '      paymentMethod: resolvePaymentMethod(type, paymentMethod),')
    .replace('      customerName,', '      customerName: customerName.trim(),'),   // S4-HYP-PREFILL-03: the full name from the two fields
    fnSync(pageHead, 'buildOrderRequest'))
  const poll = s => s.slice(s.indexOf("    if (screen !== 'tracking' || !orderId) return"), s.indexOf('    const id = setInterval(poll, 10000)'))
  assert.equal(poll(page), poll(pageHead))
  assert.equal((page.match(/fetch\('\/api\/orders'/g) ?? []).length, 1)
})
await test('every changed line of the checkout is gated on the online option (flag off ⇒ identical behaviour)', () => {
  const diff = gitDiffReleased('app/order/page.tsx')
  const removed = diff.split('\n').filter(l => l.startsWith('-') && !l.startsWith('---'))
  const added = diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'))
  // the only removed lines are the 5 payment-section / submit lines that gained a `payOnline` condition
  assert.equal(removed.length, 5, removed.join('\n'))
  for (const l of removed) {
    const replacement = added.find(a => a.slice(1).replace(/!payOnline && /g, '').replace(/; setOnlineSelected\(false\) \}/, '').replace(/\{ setPaymentMethod\(v\)/, 'setPaymentMethod(v)')
                                        .replace(/payOnline \? startOnlinePayment : placeOrder/, 'placeOrder')
                                        .replace(/\(payOnline \? '⏳ מעביר לתשלום מאובטח\.\.\.' : '⏳ שולח הזמנה\.\.\.'\)/, "'⏳ שולח הזמנה...'") === l.slice(1))
    assert.ok(replacement, `ungated change: ${l}`)
  }
  assert.match(page, /\{onlineAvailable && \(\n\s+<button type="button" onClick=\{\(\) => setOnlineSelected\(true\)\} aria-pressed=\{payOnline\}/)
  assert.match(page, /: payOnline \? \(cartDisplay\.total === null \? '🔒 המשך לתשלום מאובטח' : `🔒 המשך לתשלום מאובטח • \$\{fmt\(cartDisplay\.total\)\}`\)\n\s+: cartDisplay\.total === null \? '✅ שלח הזמנה'/)
  assert.match(page, /const payOnline = onlineAvailable && onlineSelected/)
  assert.match(page, /isOnlinePaymentAvailable\(hypConfig, selectedBranch\?\.id, effectiveOrderType, isParcelOrder\)/)
})
await test('start path: server-priced, guarded against double click, navigates only to a validated target', () => {
  const s = fn(page, 'startOnlinePayment')
  // HYP-DELIVERY-02: any order type the server permits (onlineAvailable is derived from its config)
  assert.match(s, /if \(!selectedBranch \|\| !effectiveOrderType \|\| !canPlaceOrder \|\| !payOnline\) return/)
  assert.match(s, /const request = buildOrderRequest\(selectedBranch\.id, effectiveOrderType\)/)
  assert.match(s, /setPlacingOrder\(true\)/)
  const success = s.slice(s.indexOf('try { localStorage.setItem(HYP_PENDING_PAYMENT_KEY'))
  assert.ok(success.includes('window.location.assign') && !success.includes('setPlacingOrder(false)'), 'the button stays locked while navigating')
  assert.match(s, /body: JSON\.stringify\(buildHypStartBody\(request, key, names\)\)/)   // S4-HYP-PREFILL-03: + first / last name
  assert.match(s, /window\.location\.assign\(outcome\.kind === 'redirect' \? outcome\.url : `\/order\/payment\/\$\{outcome\.token\}`\)/)
  assert.ok(!/total|amount|price/i.test(s.replace(/HYP_START_MESSAGES|Storage/g, '')), 'no amount sent from the browser')
  assert.match(page, /const canPlaceOrder = isOpen && [^;]*&& !placingOrder\n/)
})

console.log('Staff reconciliation (GET /api/kitchen/payments)')
const session = (role, branchId) => ({ ok: true, session: { username: 'boss', role, branchId, label: 'x', exp: 0, iat: 0 } })
function recDeps(auth, rows = [], err = null) {
  const calls = []; const logs = []
  return { calls, logs, deps: { getSession: async () => auth, fetchIntents: async ids => { calls.push(ids); return { data: rows, error: err } }, recoveryTier: () => null, now: () => new Date('2026-10-24T12:00:00Z'), log: (e, c) => logs.push(`${e} ${c ?? ''}`) } }
}
const recReq = q => new Request(`https://falafel.test/api/kitchen/payments${q ?? ''}`)
await test('unauthorized: no / invalid kitchen session → 401 and no data read', async () => {
  const d = recDeps({ ok: false, status: 401, error: 'unauthorized' })
  const r = await REC.handleKitchenPayments(recReq(), d.deps)
  assert.equal(r.status, 401); assert.equal(d.calls.length, 0)
})
await test('branch isolation: a branch account sees only its branch; other / all → 403; admin all or one; bad value → 400', async () => {
  let d = recDeps(session('branch', B1)); assert.equal((await REC.handleKitchenPayments(recReq(), d.deps)).status, 200); assert.deepEqual(d.calls, [[B1]])
  for (const q of [`?branch=${B2}`, '?branch=all']) { d = recDeps(session('branch', B1)); assert.equal((await REC.handleKitchenPayments(recReq(q), d.deps)).status, 403); assert.equal(d.calls.length, 0) }
  d = recDeps(session('admin', null)); await REC.handleKitchenPayments(recReq('?branch=all'), d.deps); assert.deepEqual(d.calls, [[...KA.KITCHEN_BRANCH_IDS]])
  d = recDeps(session('admin', null)); await REC.handleKitchenPayments(recReq(`?branch=${B1}`), d.deps); assert.deepEqual(d.calls, [[B1]])
  d = recDeps(session('admin', null)); assert.equal((await REC.handleKitchenPayments(recReq('?branch=x'), d.deps)).status, 400)
})
const row = (o) => ({ hyp_order_ref: o.ref, status: o.status, hold_reason: o.hold ?? null, amount_agorot: 4000, branch_id: B1, created_at: o.created ?? '2026-10-24T11:00:00Z',
  expires_at: o.expires ?? '2026-10-24T11:15:00Z', returned_at: null, paid_at: null, finalized_at: null, updated_at: '2026-10-24T11:20:00Z',
  last_error: o.err ?? null, duplicate_charge_at: o.dup ?? null, finalize_attempts: 0, customer_name: 'Dana', phone: '0501234567',
  orders: o.daily ? { daily_number: o.daily } : null, payment_transactions: o.tx ?? [], payment_returns: o.rets ?? [] })
const ROWS = [
  row({ ref: 'R01', status: 'redirected', expires: '2026-10-24T12:10:00Z' }), row({ ref: 'R02', status: 'redirected' }),
  row({ ref: 'R03', status: 'returned', rets: [{ received_at: 'x', verify_outcome: null }] }), row({ ref: 'R04', status: 'verify_rejected' }),
  row({ ref: 'R05', status: 'outcome_unknown', err: 'non_capture_ccode_700', tx: [{ hyp_trans_id: '5001', source: 'verify', ccode: '700', outcome: 'non_capture', amount_agorot: 4000, recorded_at: 'x' }] }),
  row({ ref: 'R06', status: 'outcome_unknown' }), row({ ref: 'R07', status: 'paid' }), row({ ref: 'R08', status: 'paid_hold', hold: 'late_return' }),
  row({ ref: 'R09', status: 'paid_hold', hold: 'finalize_error', err: '22023: create_order: total mismatch' }), row({ ref: 'R10', status: 'paid_hold', hold: 'parcel_conflict' }),
  row({ ref: 'R11', status: 'paid_hold', hold: 'duplicate_charge' }), row({ ref: 'R12', status: 'paid_hold', hold: 'manual_confirmation' }),
  row({ ref: 'R13', status: 'paid_amount_mismatch' }), row({ ref: 'R14', status: 'finalized', dup: '2026-10-24T11:30:00Z', daily: 9 }), row({ ref: 'R15', status: 'finalized' }),
]
await test('every unresolved situation is categorized; urgent money-received cases first; settled intents excluded', async () => {
  const d = recDeps(session('admin', null), ROWS)
  const body = await (await REC.handleKitchenPayments(recReq(), d.deps)).json()
  assert.equal(body.available, true)
  assert.deepEqual(body.items.map(i => `${i.ref}:${i.category}`), ['R07:paid_no_order', 'R09:finalize_failed', 'R10:finalize_failed', 'R08:late_return',
    'R11:duplicate_charge', 'R14:duplicate_charge', 'R13:amount_mismatch', 'R05:non_capture', 'R04:verify_rejected', 'R03:returned_unverified',
    'R02:no_return', 'R06:no_return', 'R12:manual_hold', 'R01:awaiting_customer'])
  const r09 = body.items.find(i => i.ref === 'R09'); assert.equal(r09.errorCode, '22023'); assert.equal(body.items.find(i => i.ref === 'R05').errorCode, 'non_capture_ccode_700')
  assert.equal(body.items.find(i => i.ref === 'R14').dailyNumber, 9); assert.equal(body.items.find(i => i.ref === 'R03').unverifiedReturns, 1)
  assert.equal(REC.sanitizeErrorCode('Dana 0501234567'), null)
})
await test('the staff read never selects raw returns, VERIFY answers, snapshot items or public tokens; no RPC, no writes', () => {
  for (const s of ['return_raw', 'verify_response', 'public_token', 'p_items', 'snapshot,', 'snapshot)']) assert.ok(!REC.RECONCILIATION_SELECT.includes(s), s)
  const code = src('lib/hyp/hypReconciliation.ts') + src('app/api/kitchen/payments/route.ts')
  assert.ok(!/\.rpc\(|\.insert\(|\.update\(|\.upsert\(|\.delete\(|resolve_payment_intent|finalize_paid_intent|sweep_expired/.test(code))
  assert.ok(!/isHypPaymentsEnabled|HYP_PAYMENTS_ENABLED/.test(code.replace(/^\s*\/\/.*$/gm, '')), 'works with the flag off')
  assert.match(src('app/api/kitchen/payments/route.ts'), /getSession: async r => await getKitchenSession\(r\)/)
})
await test('migration not installed → explicit "not available" (no failure); other errors → 500 with a code-only log', async () => {
  let d = recDeps(session('admin', null), null, { code: '42P01' })
  assert.deepEqual(await (await REC.handleKitchenPayments(recReq(), d.deps)).json(), { available: false, items: [] })
  d = recDeps(session('admin', null), null, { code: '57P01' })
  const r = await REC.handleKitchenPayments(recReq(), d.deps); assert.equal(r.status, 500); assert.deepEqual(d.logs, ['kitchen_payments_query 57P01'])
})
await test('staff view renders read-only (no action controls at all), RTL, with the not-yet-available note', async () => {
  const d = recDeps(session('admin', null), ROWS)
  const items = (await (await REC.handleKitchenPayments(recReq(), d.deps)).json()).items
  const m = html(TAB.PaymentsReconciliationList, { items, available: true, error: '' })
  assert.ok(!/<button|<form|<input|onclick/i.test(m), 'no buttons / forms'); assert.match(m, /dir="rtl"/); assert.match(m, /לקריאה בלבד/)
  assert.ok(m.includes('R07') && m.includes(TAB.CATEGORY_LABELS.paid_no_order.label) && m.includes('5001'))
  assert.match(html(TAB.PaymentsReconciliationList, { items: [], available: true, error: '' }), /אין תשלומים שדורשים טיפול/)
  assert.match(html(TAB.PaymentsReconciliationList, { items: [], available: false, error: '' }), /אינו מותקן/)
  for (const c of REC.CATEGORY_ORDER) assert.ok(TAB.CATEGORY_LABELS[c], c)
})
await test('dashboard integration: payments tab, admin-only branch filter, online orders labelled as paid', () => {
  const d = src('app/dashboard/orders/page.tsx')
  assert.match(d, /\['payments', '💳 תשלומים'\]/); assert.match(d, /<PaymentsTab branch=\{user\.role === 'admin' \? filterBranch : null\} onUnauthorized=\{onUnauthorized\} \/>/)
  assert.match(d, /const kitchenPaymentText = \(v: string \| null \| undefined\) => \(v === 'online' \? ONLINE_PAID_LABEL : paymentMethodText\(v\)\)/)
  const removed = gitDiffReleased('app/dashboard/orders/page.tsx').split('\n').filter(l => l.startsWith('-') && !l.startsWith('---'))
  assert.equal(removed.length, 5, removed.join('\n'))
})
await test('HYP-DELIVERY-02 kitchen label: only an ONLINE DELIVERY gets the prepaid / no-collection label; everything else as before', () => {
  const d = src('app/dashboard/orders/page.tsx')
  const removed = gitDiffSinceRelease('app/dashboard/orders/page.tsx').split('\n').filter(l => l.startsWith('-') && !l.startsWith('---'))
  assert.deepEqual(removed, ['-            {paymentLabel(order.paymentMethod)}'], removed.join('\n'))
  assert.match(d, /const PREPAID_DELIVERY_LABEL = 'שולם מראש ב-HYP ✓ · השליח לא גובה'/)
  assert.match(d, /const orderPaymentLabel = \(o: \{ paymentMethod: string; type: string \}\) =>\n\s+o\.paymentMethod === 'online' && o\.type === 'delivery' \? PREPAID_DELIVERY_LABEL : paymentLabel\(o\.paymentMethod\)/)
  assert.match(d, /\{orderPaymentLabel\(order\)\}/)
})
await test('HYP-DELIVERY-02 checkout: every change since the release is gated on the server flags (both off ⇒ identical behaviour)', () => {
  const diff = gitDiffSinceRelease('app/order/page.tsx')
  const removed = diff.split('\n').filter(l => l.startsWith('-') && !l.startsWith('---'))
  const added = diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'))
  const allowedRemoved = [
    "-  interpretStartResponse, isOnlinePaymentAvailable, parsePaymentsConfig, type HypCheckoutConfig, type HypStartOutcome,",
    "-      .then(j => { if (!cancelled) setHypConfig(parsePaymentsConfig(j)) }) // anything else → off",
    "-  const paymentOptions = allowedPaymentMethods(displayType)",
    "-  const effectivePaymentMethod = resolvePaymentMethod(displayType, paymentMethod)",
    "-  // Online payment: pilot branch + pickup only, never delivery / parcel (derived, so a mode switch never keeps it).",
    "-      paymentMethod: resolvePaymentMethod(type, paymentMethod),",
    "-    if (!selectedBranch || effectiveOrderType !== 'pickup' || !canPlaceOrder || !payOnline) return",
    "-    const request = buildOrderRequest(selectedBranch.id, 'pickup')",
    "-          {/* HYP-08: online card payment — rendered only when the server permits it for this branch + pickup */}",
  ]
  // S4-HYP-PREFILL-03 (owner request): the single name field became first name + last name; downstream the same full name
  const prefill03Removed = [
    "-  ACTIVE_DELIVERY_AREAS, DELIVERY_FEE_RANGE, DELIVERY_FIELD_LIMITS, DELIVERY_MEAL_SURCHARGE, MAX_CUSTOMER_NAME, MAX_ITEM_NOTES, MAX_LINE_QUANTITY, PAYMENT_METHOD_LABELS, PHONE_REGEX, getDeliveryFeeForArea,",
    "-  const [customerName, setCustomerName] = useState(() => {",
    "-    if (typeof window === 'undefined') return ''",
    "-    return localStorage.getItem('falafel_customer_name') || ''",
    "-  const canPlaceOrder = isOpen && isValidPhone(orderPhone) && cart.length > 0 && customerName.trim().length >= 2",
    "-      customerName: customerName.trim(),",
    "-    const key = checkoutKeyFor(storage, JSON.stringify(buildHypStartBody(request, '')), () => crypto.randomUUID())",
    "-        body: JSON.stringify(buildHypStartBody(request, key)),",
    "-          <input type=\"text\" value={customerName} maxLength={MAX_CUSTOMER_NAME} onChange={e => setCustomerName(e.target.value)} placeholder=\"שם ושם משפחה\" dir=\"rtl\"",
    "-            style={{ width: '100%', padding: 14, border: `1px solid ${customerName.trim().length >= 2 ? C.green : C.border}`, borderRadius: 12, fontSize: 17, fontFamily: 'Heebo, sans-serif', outline: 'none', boxSizing: 'border-box', background: C.bg, color: C.white }} />",
    "-          {customerName.length > 0 && customerName.trim().length < 2 && <div style={{ color: C.red, fontSize: 12, marginTop: 6 }}>נא להזין שם מלא</div>}",
  ]
  // S4-OPERATING-HOURS-01: new hours + one-off closure note in the closed popup (lib/hours, verify-pricing)
  const hours01Removed = [
    "-import { getBusinessStatus } from '@/lib/hours'",
    "-  const { isOpen, nextOpen } = getBusinessStatus()",
    "-            <h2 style={{ color: C.white, fontSize: 20, fontWeight: 900, marginBottom: 8 }}>אנחנו סגורים כרגע</h2>",
    "-              <strong style={{ color: C.white }}>ראשון–חמישי | 08:00–19:30</strong><br />",
  ]
  assert.deepEqual([...removed].sort(), [...allowedRemoved, ...prefill03Removed, ...hours01Removed].sort(), removed.join('\n'))
  assert.match(page, /const customerName = namesValid \? joinCustomerName\(firstName, lastName\) : ''/)
  assert.match(page, /cart\.length > 0 && namesValid/)
  // with deliveryCreditRetired false (default, server flag off) methodFor() is resolvePaymentMethod() and the options are unchanged
  assert.match(page, /const \[deliveryCreditRetired, setDeliveryCreditRetired\] = useState\(false\)/)
  assert.match(page, /return t === 'delivery' && deliveryCreditRetired && m === 'credit' \? 'cash' : m/)
  assert.match(page, /const paymentOptions = displayType === 'delivery' && deliveryCreditRetired\n\s+\? allowedPaymentMethods\('delivery'\)\.filter\(m => m !== 'credit'\) : allowedPaymentMethods\(displayType\)/)
  assert.match(page, /setDeliveryCreditRetired\(parseDeliveryCreditRetired\(j\)\)/)
  for (const l of added) assert.ok(!/fetch\('\/api\/orders'|total_price|amountAgorot|deliveryFee/.test(l), `no price / order path change: ${l}`)
  // the regular order path and the tracking poll are byte-identical to the release
  const rel = atRelease('app/order/page.tsx')
  assert.equal(fn(page, 'placeOrder'), fn(rel, 'placeOrder'))
  const poll = x => x.slice(x.indexOf("    if (screen !== 'tracking' || !orderId) return"), x.indexOf('    const id = setInterval(poll, 10000)'))
  assert.equal(poll(page), poll(rel))
})

console.log('Isolation')
await test('no live request: the global fetch was never called', () => assert.equal(fetchCalls.length, 0))
await test('legacy modules untouched by the HYP releases (orders API, parser, config, Maale, parcels, kitchen APIs)', () => {
  // Range PRE_HYP_BASE → HYP_RELEASED (last HYP release, 258a338): the HYP work itself. Later, separately reviewed features
  // (S4-MAALE-03 automatic courier request) may change Maale / kitchen files without weakening this HYP scope proof.
  const HYP_RELEASED = '258a33878ce068c0bed7f70aea9d333d062dda84'
  execFileSync('git', ['merge-base', '--is-ancestor', HYP_RELEASED, 'HEAD'], { cwd: ROOT })
  const inHyp = (filter, paths) => execFileSync('git', ['diff', '--name-only', `--diff-filter=${filter}`, PRE_HYP_BASE, HYP_RELEASED, '--', ...paths], { cwd: ROOT, encoding: 'utf8' }).trim()
  assert.equal(inHyp('MDRT', ['app/api/orders', 'app/api/checkout', 'app/api/kitchen', 'lib/orderRequest.ts',
    'lib/orderConfig.ts', 'lib/createOrder.ts', 'lib/maaleDispatch.ts', 'lib/maalePayload.ts', 'lib/maaleClient.ts', 'lib/parcelCheckout.ts', 'lib/kitchenAuth.ts', 'lib/kitchenOrders.ts']), '')
  // the only new files under those paths are the two HYP staff routes (an added file elsewhere would be a scope change)
  const added = inHyp('A', ['app/api/orders', 'app/api/checkout', 'app/api/kitchen', 'lib/order*', 'lib/maale*', 'lib/kitchen*', 'lib/parcel*']).split('\n').filter(Boolean)
  assert.deepEqual(added, ['app/api/kitchen/payments/[ref]/route.ts', 'app/api/kitchen/payments/route.ts'])
})

console.log(`\n${passed}/${passed + failed} PASS${failed ? ` — ${failed} FAILED` : ''}`)
process.exit(failed ? 1 : 0)
