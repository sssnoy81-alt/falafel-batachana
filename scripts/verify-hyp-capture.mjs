// Local checks for the original-bytes callback capture (HYP-32): api/hyp-return.js + lib/hyp/hypCapture.ts + the
// envelope branch of handleHypReturn. Fake DB and fake Hyp transport (no network, no DB); global fetch throws.
// Run: node scripts/verify-hyp-capture.mjs
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'

globalThis.fetch = async () => { throw new Error('LIVE NETWORK CALL ATTEMPTED') }
const require = createRequire(import.meta.url)
const ts = require('typescript')
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cache = new Map()
function load(file) {
  if (cache.has(file)) return cache.get(file).exports
  const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } })
  const mod = { exports: {} }; cache.set(file, mod)
  const req = p => p.startsWith('./') || p.startsWith('../') ? load(resolve(dirname(file), p) + '.ts') : p.startsWith('@/') ? load(join(ROOT, p.slice(2)) + '.ts') : require(p)
  new Function('exports', 'require', 'module', outputText)(mod.exports, req, mod)
  return mod.exports
}
const src = f => readFileSync(join(ROOT, f), 'utf8').replace(/\r\n/g, '\n')
const CAP = load(join(ROOT, 'lib', 'hyp', 'hypCapture.ts'))
const FN = require(join(ROOT, 'api', 'hyp-return.js'))   // CommonJS Vercel Function
const S = load(join(ROOT, 'lib', 'hyp', 'hypPaymentService.ts'))
const P = load(join(ROOT, 'lib', 'hyp', 'hypProtocol.ts'))

let passed = 0
const test = async (name, fn) => { await fn(); passed++; console.log('  ✓', name) }

const REF = 'AB12CD34EF56AB12CD34EF56AB12CD34', SIGN = 'a84b11187377554427f267a9139ad4fd7daf7fb661dd668a9b954cf41cd25904'
const CB = {
  hebrew_space_plus: `Id=503699117&CCode=0&Amount=12.00&ACode=0577123&Order=${REF}&Fild1=%D7%A9%D7%9D%20%D7%91+x%2By&Fild2=a.b%40example.co.il&Fild3=&Sign=${SIGN}`,
  lowercase_hex:     `Id=503699118&CCode=0&Amount=9.00&ACode=0577124&Order=${REF}&Fild1=%d7%a9%20%d7%9d&Fild2=x%40y.co&Fild3=&Sign=${SIGN}`,
  empty_filds:       `Id=503699119&CCode=0&Amount=10&ACode=0577125&Order=${REF}&Fild1=&Fild2=&Fild3=&Sign=${SIGN}`,
  official_doc:      `Id=408941655&CCode=0&Amount=10&ACode=0505293&Order=${REF}&Fild1=Jenny%20Parkington&Fild2=jennyp%40example.co.il&Fild3=&Sign=${SIGN}`,
}
const env = { HYP_PAYMENTS_ENABLED: 'true', HYP_TERMINAL: '0010000001', HYP_API_KEY: 'fakeKEY-1', HYP_PASSP: 'fakePASS-1', HYP_TERMINAL_KIND: 'test' }
function world({ intentStatus = 'returned', verifyAnswer = 'CCode=0' } = {}) {
  const st = { recorded: [], verifyUrls: [], finalized: 0, logs: [], returns: new Map() }
  const db = {
    async recordReturn(raw) {
      st.recorded.push(raw)
      const h = createHash('md5').update(raw).digest('hex')                        // like the DB's md5(return_raw) dedupe key
      const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`
      const dup = st.returns.has(id); st.returns.set(id, raw)
      return { result: dup ? 'duplicate_return' : 'recorded', returnId: id, intentId: 'int-1', publicToken: '11111111-2222-4333-8444-555555555555', intentStatus }
    },
    async getIntentForReturn() { return { id: 'int-1', status: intentStatus, amountAgorot: 1200, hypOrderRef: REF, terminalKind: 'test', publicToken: '11111111-2222-4333-8444-555555555555' } },
    async getReturn(id) { return { id, intentId: 'int-1', returnRaw: st.returns.get(id), verifyOutcome: null } },
    // mirrors record_hyp_verification: only an authentic VERIFY moves the intent to 'paid'
    async recordVerification(a) { st.verifyOutcomes = [...(st.verifyOutcomes ?? []), a.p_outcome]; return a.p_outcome === 'authentic' ? { result: 'paid', status: 'paid' } : { result: 'rejected', status: 'verify_rejected' } },
    async finalize() { st.finalized++; return { result: 'finalized', orderId: 'o1', orderNumber: 1, dailyNumber: 1 } },
  }
  const deps = { env, db, isShopOpen: () => true, log: (e, c) => st.logs.push(`${e} ${c ?? ''}`),
    transport: async url => { st.verifyUrls.push(String(url)); return { status: 200, text: async () => verifyAnswer } },
    limits: { start: { hit: () => true }, startPhone: { hit: () => true }, ret: { hit: () => true }, status: { hit: () => true } } }
  return { st, run: q => S.handleHypReturn(new Request(`https://falafel.test/api/payments/hyp/return?${q}`), deps) }
}
const capture = (raw, method = 'GET') => FN.captureLocation(method, `https://falafel.test/api/hyp-return?${raw}`)
const envelopeOf = loc => loc.slice(loc.indexOf('?') + 1)

console.log('A) Capture function (outside Next.js)')
await test('A1. exact bytes: the envelope decodes to the request target query, for every realistic callback', () => {
  for (const [name, raw] of Object.entries(CB)) {
    const r = capture(raw); assert.equal(r.status, 303); assert.ok(r.location.startsWith('/api/payments/hyp/return?r='), name)
    const d = CAP.decodeCaptureEnvelope(envelopeOf(r.location)); assert.equal(d.kind, 'envelope', name); assert.equal(d.raw, raw, name)
    assert.equal(r.location, `/api/payments/hyp/return?r=${CAP.encodeCaptureEnvelope(raw)}`, `${name}: function and lib encode identically`)
  }
})
await test('A2. fixed, relative destination only — no host, scheme or value taken from the request', () => {
  for (const raw of [...Object.values(CB), 'next=https://evil.test', 'x=//evil.test']) {
    const r = capture(raw); assert.match(r.location, /^\/(api\/payments\/hyp\/return\?r=[A-Za-z0-9_-]+|order\/payment)$/)
  }
  const s = src('api/hyp-return.js')
  // no env, no logging, no outgoing call, no DB, no module loaded at all (CommonJS require or ESM import)
  assert.ok(!/process\.env|console\.|fetch\(|https?\.request|supabase|require\(|import[\s(]/.test(s.replace(/^\s*\/\/.*$/gm, '')), 'no env, logging, network, DB or imports')
})
await test('A3. method, size and content bounds: non-GET → 405; empty / too long / non-ASCII / control chars → generic page', () => {
  for (const m of ['POST', 'PUT', 'HEAD', 'DELETE']) assert.deepEqual(capture(CB.empty_filds, m), { status: 405 })
  assert.deepEqual(FN.captureLocation('GET', 'https://falafel.test/api/hyp-return'), { status: 303, location: '/order/payment' })
  assert.deepEqual(capture(''), { status: 303, location: '/order/payment' })
  assert.deepEqual(capture('a='.padEnd(4001, 'x')), { status: 303, location: '/order/payment' })
  assert.equal(capture('a='.padEnd(4000, 'x')).location.startsWith('/api/payments/hyp/return?r='), true)
  for (const bad of ['a=b c', 'a=ש', 'a=\x01', 'a=b\tc']) assert.deepEqual(capture(bad), { status: 303, location: '/order/payment' }, JSON.stringify(bad))
  assert.equal(CAP.decodeCaptureEnvelope(envelopeOf(capture('a=1#frag').location)).raw, 'a=1', 'a fragment is never part of the query')
})
await test('A4. Node (req, res) handler: raw IncomingMessage.url; 303 no-store / no-referrer, empty body; 405 Allow: GET', () => {
  const fakeRes = () => { const r = { headers: {}, statusCode: 0, body: null, setHeader(k, v) { this.headers[k.toLowerCase()] = v }, end(b) { this.body = b ?? '' } }; r.setHeader = r.setHeader.bind(r); r.end = r.end.bind(r); return r }
  const ok = fakeRes(); FN({ method: 'GET', url: `/api/hyp-return?${CB.official_doc}` }, ok)   // Node gives the raw request target
  assert.equal(ok.statusCode, 303); assert.equal(ok.headers['cache-control'], 'no-store, max-age=0'); assert.equal(ok.headers['referrer-policy'], 'no-referrer')
  assert.equal(CAP.decodeCaptureEnvelope(envelopeOf(ok.headers.location)).raw, CB.official_doc); assert.equal(ok.body, '')
  const no = fakeRes(); FN({ method: 'POST', url: '/api/hyp-return?a=1' }, no); assert.equal(no.statusCode, 405); assert.equal(no.headers.allow, 'GET')
})

console.log('B) Envelope decoding (lib/hyp/hypCapture.ts)')
await test('B1. strict canonical base64url only: padding, foreign chars, non-canonical tail, empty, oversize → invalid', () => {
  const R = s => CAP.decodeCaptureEnvelope(s)
  assert.deepEqual(R('r=QQ'), { kind: 'envelope', raw: 'A' })
  for (const [s, why] of [['r=QQ==', 'envelope_malformed'], ['r=Q+Q', 'envelope_malformed'], ['r=Q/Q', 'envelope_malformed'], ['r=QR', 'envelope_not_canonical'],
                          ['r=', 'envelope_malformed'], ['r=' + 'Q'.repeat(5400), 'envelope_too_long'], ['r=QQ&r=QQ', 'envelope_malformed'], ['r=QQ&Id=1', 'envelope_malformed'],
                          ['Id=1&r=QQ', 'envelope_malformed'], ['r=QQ%3D', 'envelope_malformed']])
    assert.deepEqual(R(s), { kind: 'invalid', reason: why }, s)
  for (const s of Object.values(CB)) assert.deepEqual(R(s), { kind: 'legacy' })
  assert.equal(R(`r=${CAP.encodeCaptureEnvelope('x'.repeat(4000))}`).kind, 'envelope')
  assert.deepEqual(R(`r=${CAP.encodeCaptureEnvelope('x'.repeat(4001))}`), { kind: 'invalid', reason: 'envelope_too_long' })
})
await test('B2. base64url passes Next.js-style re-serialization unchanged (URLSearchParams round trip)', () => {
  for (const raw of Object.values(CB)) {
    const u = new URL(`https://falafel.test/x?r=${CAP.encodeCaptureEnvelope(raw)}`); u.searchParams.delete('_rsc')
    assert.equal(CAP.decodeCaptureEnvelope(u.search).raw, raw)
  }
})

console.log('C) Return route with the envelope (handleHypReturn)')
await test('C1. the ORIGINAL bytes reach record_hyp_return and VERIFY (byte for byte, after the documented credentials)', async () => {
  for (const [name, raw] of Object.entries(CB)) {
    const w = world(); const res = await w.run(envelopeOf(capture(raw).location))
    assert.equal(res.status, 303, name); assert.deepEqual(w.st.recorded, [raw], `${name}: stored exactly`)
    assert.equal(w.st.verifyUrls.length, 1); const v = w.st.verifyUrls[0]
    assert.ok(v.startsWith('https://pay.hyp.co.il/p/?action=APISign&What=VERIFY&Masof=0010000001&KEY=') && v.endsWith(`&PassP=fakePASS-1&${raw}`), `${name}: VERIFY appends the original`)
    assert.equal(w.st.finalized, 1, `${name}: finalized only because the (fake) VERIFY said CCode=0`)
  }
})
await test('C2. VERIFY rejection still never finalizes — the envelope adds no trust', async () => {
  for (const ans of ['CCode=200', 'CCode=902']) {
    const w = world({ verifyAnswer: ans }); await w.run(envelopeOf(capture(CB.official_doc).location)); assert.equal(w.st.finalized, 0, ans)
  }
})
await test('C3. a malformed envelope is refused BEFORE any DB access (code-only log, generic page)', async () => {
  for (const q of ['r=QR', 'r=QQ==', 'r=QQ&Id=1', 'r=']) {
    const w = world(); const res = await w.run(q)
    assert.equal(res.status, 303); assert.equal(res.headers.get('location'), '/order/payment'); assert.equal(w.st.recorded.length, 0, q)
    assert.ok(w.st.logs.some(l => l.startsWith('hyp_return_envelope envelope_')), q)
  }
})
await test('C4. one callback arriving twice (replay / double redirect) → identical bytes = identical dedupe key (one order: pgtest-hyp07 E2 / E9)', async () => {
  const w = world(); const q = envelopeOf(capture(CB.hebrew_space_plus).location)
  await w.run(q); await w.run(q)
  assert.equal(w.st.recorded[0], w.st.recorded[1]); assert.equal(new Set(w.st.recorded).size, 1)
})
await test('C5. decoded callbacks are still validated by the unchanged parser: duplicate Order, reserved key, foreign charset', async () => {
  for (const raw of [`Id=1&CCode=0&Amount=1&Order=${REF}&Order=${REF}&Sign=${SIGN}`, `Id=1&CCode=0&Amount=1&Order=${REF}&KEY=x&Sign=${SIGN}`, `Id=1&CCode=0&Amount=1&Order=${REF}&Fild1=a!b&Sign=${SIGN}`]) {
    const w = world(); await w.run(envelopeOf(capture(raw).location))
    assert.equal(w.st.finalized, 0, raw.slice(0, 40)); assert.equal(w.st.verifyUrls.length, 0, 'never verified')
  }
})
await test('C6. the legacy callback form (no envelope) behaves exactly as before', async () => {
  const w = world(); await w.run(CB.empty_filds)
  assert.deepEqual(w.st.recorded, [CB.empty_filds]); assert.equal(w.st.finalized, 1)
})
await test('C7. a raw "@" (if Hyp ever sends one unencoded) is preserved by the capture but refused by the current charset — fail closed', async () => {
  const raw = `Id=1&CCode=0&Amount=1&Order=${REF}&Fild2=a@b.co&Sign=${SIGN}`
  assert.equal(CAP.decodeCaptureEnvelope(envelopeOf(capture(raw).location)).raw, raw)
  assert.equal(P.HYP_RETURN_RAW_RE.test(raw), false)
})

console.log('D) Static guarantees')
await test('D1. SIGN, VERIFY building and finalize are untouched; the route change is the envelope branch only', () => {
  const s = src('lib/hyp/hypPaymentService.ts')
  assert.equal((s.match(/decodeCaptureEnvelope\(/g) || []).length, 1)
  assert.ok(s.indexOf('decodeCaptureEnvelope(raw)') < s.indexOf('deps.db.recordReturn(raw)'), 'decoded before the first DB call')
  assert.match(src('lib/hyp/hypClient.ts'), /action=APISign&What=VERIFY&Masof=\$\{enc\(config\.terminal\)\}&KEY=\$\{enc\(config\.apiKey\)\}&PassP=\$\{enc\(config\.passP\)\}&\$\{raw\}/)
  for (const f of ['api/hyp-return.js', 'lib/hyp/hypCapture.ts']) assert.ok(!/console\.|deps\.log\([^)]*raw/.test(src(f)), `${f}: never logs the query`)
  assert.equal(src('api/hyp-return.js').includes("const RAW_MAX = 4000"), true); assert.equal(CAP.HYP_CAPTURE_RAW_MAX, 4000)
  assert.equal(P.HYP_RETURN_RAW_MAX ?? 4000, 4000)
})

console.log(`\n${passed} hyp-capture checks passed.`)
