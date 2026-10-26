// Offline checks for the Hyp Pay client (HYP-06): lib/hyp/hypConfig.ts, hypProtocol.ts, hypClient.ts.
// INJECTED mock transport only — the real global fetch is replaced by a recording stub that never reaches a network,
// and every URL the client produced is asserted to target pay.hyp.co.il. Fake credentials, no env, no DB, no HYP.
// Run: node scripts/verify-hyp-client.mjs

import { createRequire } from 'node:module'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import assert from 'node:assert/strict'

const fetchCalls = []
globalThis.fetch = async (url, init) => { fetchCalls.push({ url: String(url), init }); throw new Error('LIVE NETWORK CALL ATTEMPTED') }

const require = createRequire(import.meta.url)
const ts = require('typescript')
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cache = new Map()
function load(file) {
  if (cache.has(file)) return cache.get(file).exports
  const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  })
  const mod = { exports: {} }
  cache.set(file, mod)
  new Function('exports', 'require', 'module', outputText)(mod.exports, p => (p.startsWith('./') ? load(join(dirname(file), p.slice(2) + '.ts')) : require(p)), mod)
  return mod.exports
}
const HYP = join(ROOT, 'lib', 'hyp')
const Cfg = load(join(HYP, 'hypConfig.ts'))
const P = load(join(HYP, 'hypProtocol.ts'))
const C = load(join(HYP, 'hypClient.ts'))
const src = f => readFileSync(join(ROOT, f), 'utf8').replace(/\r\n/g, '\n')   // working copies may be CRLF (core.autocrlf)

let passed = 0, failed = 0
const test = async (name, fn) => {
  try { await fn(); passed++; console.log('  ✓', name) }
  catch (e) { failed++; console.log('  ✗', name, '\n     ', e.message.split('\n')[0]) }
}

/* ─── fixtures (fake, never real) ─── */
const API_KEY = 'fakeKEY-7f3a9c11'
const PASSP = 'fakePassP-42b8'
const TEST_ENV = { HYP_TERMINAL: '0010000001', HYP_API_KEY: API_KEY, HYP_PASSP: PASSP, HYP_TERMINAL_KIND: 'test' }
const config = Cfg.resolveHypConfig(TEST_ENV).config
const REF = 'A1B2C3D4E5F60718293A4B5C6D7E8F90'
const REQ = { orderRef: REF, amountAgorot: 4000, description: 'Falafel BaTachana' }
const signedBody = (o = {}) => {
  const p = { action: 'pay', Masof: config.terminal, Amount: '40.00', Coin: '1', Tash: '1', Order: REF, Info: 'Falafel%20BaTachana', PageLang: 'HEB', Sign: 'True', signature: 'a9f00c1b77e2d4', ...o }
  return Object.entries(p).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`).join('&')
}
const returnRaw = (o = {}) => {
  const p = { Id: '50012345', CCode: '0', Amount: '40.00', ACode: '0012345', Order: REF, Fild1: '', Fild2: '', Fild3: '', Sign: 'f'.repeat(32), ...o }
  return Object.entries(p).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`).join('&')
}
const RID = '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b'

// Mock transport: scripted answers; records every URL (credentials included — they stay in this process).
const seen = []
function mock(...answers) {
  const calls = []
  const transport = async (url, init) => {
    calls.push({ url, init }); seen.push(url)
    const a = answers[Math.min(calls.length - 1, answers.length - 1)]
    if (a === 'timeout') return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))))
    if (a === 'network') throw new TypeError('fetch failed')
    return { status: a.status ?? 200, text: async () => a.body }
  }
  return { transport, calls }
}
const results = []   // every result object produced, for the redaction sweep
const keep = r => { results.push(r); return r }
const verify = (raw, answers, o = {}) => { const m = mock(...answers); return C.verifyHypReturn(config, { rawQuery: raw, expectedOrderRef: o.ref ?? REF, expectedAmountAgorot: o.amount ?? 4000 }, { transport: m.transport, timeoutMs: o.timeoutMs ?? 50 }).then(r => ({ r: keep(r), calls: m.calls })) }

console.log('Configuration')
await test('missing credentials → names reported, values never', () => {
  const r = Cfg.resolveHypConfig({ HYP_TERMINAL: '0010000001', HYP_API_KEY: API_KEY })
  assert.deepEqual(r, { ok: false, error: 'missing_credentials', missing: ['HYP_PASSP', 'HYP_TERMINAL_KIND'] })
  assert.ok(!JSON.stringify(r).includes(API_KEY))
})
await test('live terminal is blocked in Preview, development and local; allowed only with VERCEL_ENV=production', () => {
  const live = { ...TEST_ENV, HYP_TERMINAL: '0882001234', HYP_TERMINAL_KIND: 'live' }
  for (const v of [undefined, 'preview', 'development', 'Production'])
    assert.equal(Cfg.resolveHypConfig({ ...live, VERCEL_ENV: v }).error, 'live_terminal_outside_production', String(v))
  assert.equal(Cfg.resolveHypConfig({ ...live, VERCEL_ENV: 'production' }).ok, true)
  assert.equal(Cfg.resolveHypConfig({ ...TEST_ENV, VERCEL_ENV: 'preview' }).ok, true)   // test terminal: anywhere
})
await test('terminal kind must match the documented 00100 test prefix', () => {
  assert.equal(Cfg.resolveHypConfig({ ...TEST_ENV, HYP_TERMINAL: '0882001234' }).error, 'terminal_kind_mismatch')
  assert.equal(Cfg.resolveHypConfig({ ...TEST_ENV, HYP_TERMINAL_KIND: 'live', VERCEL_ENV: 'production' }).error, 'terminal_kind_mismatch')
  assert.equal(Cfg.resolveHypConfig({ ...TEST_ENV, HYP_TERMINAL_KIND: 'prod' }).error, 'invalid_terminal_kind')
  assert.equal(Cfg.resolveHypConfig({ ...TEST_ENV, HYP_TERMINAL: '00100abc' }).error, 'invalid_terminal')
  assert.equal(Cfg.resolveHypConfig({ ...TEST_ENV, HYP_PASSP: 'has space' }).error, 'invalid_credential_format')
})
await test('a NEXT_PUBLIC_ variable naming HYP or carrying a credential is refused', () => {
  assert.equal(Cfg.resolveHypConfig({ ...TEST_ENV, NEXT_PUBLIC_HYP_TERMINAL: '0010000001' }).error, 'public_exposure')
  assert.equal(Cfg.resolveHypConfig({ ...TEST_ENV, NEXT_PUBLIC_SOMETHING: PASSP }).error, 'public_exposure')
  assert.equal(Cfg.resolveHypConfig({ ...TEST_ENV, NEXT_PUBLIC_SUPABASE_URL: 'https://x.supabase.co' }).ok, true)
  assert.ok(Object.isFrozen(config))
})

console.log('Amounts (exact agorot, no floating point)')
await test('agorot → Amount text', () => {
  assert.equal(P.agorotToAmount(4000), '40.00'); assert.equal(P.agorotToAmount(1), '0.01'); assert.equal(P.agorotToAmount(1999), '19.99')
  assert.equal(P.agorotToAmount(12345), '123.45'); assert.equal(P.agorotToAmount(500000), '5000.00')
  for (const bad of [0, -1, 1.5, NaN, Infinity, 500001, 2 ** 53, '4000']) assert.throws(() => P.agorotToAmount(bad), RangeError, String(bad))
})
await test('Amount text → agorot; incorrect formats refused', () => {
  for (const [t, a] of [['40', 4000], ['40.5', 4050], ['40.05', 4005], ['0.10', 10], ['19.99', 1999], ['1.1', 110], ['040.00', 4000]]) assert.equal(P.amountToAgorot(t), a, t)
  for (const bad of ['40.123', '4e3', '-1', '', ' 40', '40,00', '1234567', '.5', '40.', '0x10']) assert.equal(P.amountToAgorot(bad), null, bad)
})
await test('round trip is exact for every amount 0.01 … 5000.00', () => {
  for (let a = 1; a <= 500000; a++) if (P.amountToAgorot(P.agorotToAmount(a)) !== a) throw new Error(`round trip failed at ${a}`)
})

console.log('SIGN + hosted redirect')
await test('valid SIGN → payment-page URL = pay.hyp.co.il/p/? + the unmodified answer', async () => {
  const m = mock({ body: signedBody() })
  const r = keep(await C.signPayment(config, REQ, { transport: m.transport }))
  assert.equal(r.ok, true); assert.equal(r.redirectUrl, `https://pay.hyp.co.il/p/?${signedBody()}`); assert.equal(r.attempts, 1)
  const u = new URL(m.calls[0].url)
  assert.equal(u.origin + u.pathname, 'https://pay.hyp.co.il/p/')
  assert.deepEqual([...u.searchParams.keys()], ['action', 'What', 'KEY', 'PassP', 'Masof', 'Amount', 'Coin', 'Tash', 'Order', 'Info', 'PageLang', 'Sign'])
  assert.equal(u.searchParams.get('What'), 'SIGN'); assert.equal(u.searchParams.get('Sign'), 'True'); assert.equal(u.searchParams.get('Amount'), '40.00')
  assert.deepEqual(m.calls[0].init.redirect, 'error'); assert.equal(m.calls[0].init.cache, 'no-store')
  assert.ok(!r.redirectUrl.includes(API_KEY) && !r.redirectUrl.includes(PASSP))
})
await test('invalid SIGN answers never produce a redirect', async () => {
  const cases = [
    ['<html>error</html>', 'invalid_sign_response'], ['', 'invalid_sign_response'], [signedBody({ signature: undefined }), 'invalid_sign_response'],
    ['CCode=901', 'sign_rejected'], [signedBody({ Masof: '0010000002' }), 'invalid_sign_response'],
    [signedBody({ Amount: '41.00' }), 'invalid_sign_response'], [signedBody({ Order: 'ZZZZZZZZZZZZ' }), 'invalid_sign_response'],
    [signedBody({ action: 'APISign' }), 'invalid_sign_response'], [`${signedBody()}&signature=x2`, 'invalid_sign_response'],
    [`${signedBody()}&KEY=${API_KEY}`, 'credential_echo'], [`${signedBody()}&x=${PASSP}`, 'credential_echo'], [`${signedBody()}&PassP=zz`, 'credential_echo'],
  ]
  for (const [body, error] of cases) {
    const r = keep(await C.signPayment(config, REQ, { transport: mock({ body }).transport }))
    assert.equal(r.ok, false, body); assert.equal(r.error, error, body); assert.equal(r.redirectUrl, undefined)
  }
  assert.equal((await C.signPayment(config, REQ, { transport: mock({ body: 'CCode=901' }).transport })).providerCode, '901')
})
await test('incorrect SIGN input is refused before any network', async () => {
  for (const req of [{ ...REQ, amountAgorot: 40.5 }, { ...REQ, amountAgorot: 0 }, { ...REQ, orderRef: 'abc' }, { ...REQ, description: '' }, { ...REQ, description: 'x\ny' }]) {
    const m = mock({ body: signedBody() })
    assert.deepEqual(keep(await C.signPayment(config, req, { transport: m.transport })), { ok: false, error: 'invalid_input', retryable: false, attempts: 0 })
    assert.equal(m.calls.length, 0)
  }
})
await test('SIGN retry: only when no answer arrived (timeout / network / 5xx); 4xx and bad answers are not retried', async () => {
  let m = mock('timeout', { body: signedBody() })
  assert.equal(keep(await C.signPayment(config, REQ, { transport: m.transport, timeoutMs: 30 })).attempts, 2)
  m = mock({ status: 503, body: '' })
  const r = keep(await C.signPayment(config, REQ, { transport: m.transport }))
  assert.equal(r.error, 'http_status'); assert.equal(r.retryable, true); assert.equal(m.calls.length, C.HYP_SIGN_ATTEMPTS)
  m = mock({ status: 403, body: 'denied' })
  assert.equal(keep(await C.signPayment(config, REQ, { transport: m.transport })).retryable, false); assert.equal(m.calls.length, 1)
  m = mock({ body: 'garbage' })
  await C.signPayment(config, REQ, { transport: m.transport }); assert.equal(m.calls.length, 1)
  m = mock('network', 'network')
  assert.equal(keep(await C.signPayment(config, REQ, { transport: m.transport })).error, 'network_error')
})

console.log('Browser return (untrusted) + VERIFY')
await test('return parsing: missing / duplicate / reserved / invalid fields refused; reordered parameters accepted', () => {
  assert.equal(C.parseHypReturn(returnRaw()).ok, true)
  assert.equal(C.parseHypReturn(`?${returnRaw()}`).raw, returnRaw())
  const shuffled = 'Order=' + REF + '&Sign=' + 'f'.repeat(32) + '&Amount=40.00&Id=50012345&CCode=0'
  const s = C.parseHypReturn(shuffled); assert.equal(s.ok, true); assert.equal(s.raw, shuffled); assert.equal(s.fields.acode, null)
  const reason = raw => { const r = C.parseHypReturn(raw); return r.ok ? 'ok' : `${r.reason}${r.field ? ':' + r.field : ''}` }
  assert.equal(reason(returnRaw({ Id: undefined })), 'missing_field:Id')
  assert.equal(reason(returnRaw({ CCode: undefined })), 'missing_field:CCode')
  assert.equal(reason(`${returnRaw()}&CCode=0`), 'duplicate_field:CCode')
  assert.equal(reason(`${returnRaw()}&Id=50012346`), 'duplicate_field:Id')
  assert.equal(reason(`${returnRaw()}&Masof=0010000009`), 'reserved_field:Masof')
  assert.equal(reason(`${returnRaw()}&KEY=x`), 'reserved_field:KEY')
  assert.equal(reason(`action=APISign&${returnRaw()}`), 'reserved_field:action')
  assert.equal(reason(returnRaw({ Amount: '40.001' })), 'invalid_field:Amount')
  assert.equal(reason(returnRaw({ Order: 'abc' })), 'invalid_field:Order')
  assert.equal(reason(returnRaw({ Id: 'id-with-dash' })), 'invalid_field:Id')
  assert.equal(reason(`${returnRaw()}&x=<b>`), 'invalid_charset')
  assert.equal(reason(`${returnRaw()}&&`), 'malformed')
  assert.equal(reason('A'.repeat(4001)), 'too_long')
  assert.equal(reason(''), 'empty')
})
await test('VERIFY request: documented order action, What, Masof, KEY, PassP, then the return query string byte-for-byte', async () => {
  const raw = 'Sign=' + 'f'.repeat(32) + '&Order=' + REF + '&CCode=0&Amount=40.00&Id=50012345&Fild1=%D7%A9'
  const { calls } = await verify(raw, [{ body: 'CCode=0' }])
  assert.equal(calls[0].url, `https://pay.hyp.co.il/p/?action=APISign&What=VERIFY&Masof=${config.terminal}&KEY=${encodeURIComponent(API_KEY)}&PassP=${encodeURIComponent(PASSP)}&${raw}`)
})
await test('HYP-20 regression: exact key order of the real callback; the text after PassP is the callback, unchanged', () => {
  // The real HYP-18B callback key order (Id, CCode, Amount, ACode, Order, Fild1-3, Sign), synthetic values.
  const raw = `Id=503699117&CCode=0&Amount=9.00&ACode=0577123&Order=${REF}&Fild1=&Fild2=&Fild3=&Sign=${'a'.repeat(64)}`
  const url = C.buildVerifyUrl(config, raw)
  const q = url.slice(url.indexOf('?') + 1)
  assert.deepEqual(q.split('&').map(p => p.split('=')[0]),
    ['action', 'What', 'Masof', 'KEY', 'PassP', 'Id', 'CCode', 'Amount', 'ACode', 'Order', 'Fild1', 'Fild2', 'Fild3', 'Sign'])
  assert.equal(q.slice(q.indexOf('&PassP=') + 1).replace(/^PassP=[^&]*&/, ''), raw)   // nothing (no Masof) between PassP and the callback
  assert.equal(new URL(url).href, url)                                                   // fetch's URL parser keeps every byte
  assert.equal((q.match(/(^|&)Masof=/g) ?? []).length, 1)
})
await test('verified payment: VERIFY CCode=0 + return CCode=0 + same Order and Amount → confirmed → record authentic (expect paid)', async () => {
  const { r } = await verify(returnRaw(), [{ body: 'CCode=0' }])
  assert.equal(r.outcome, 'confirmed'); assert.deepEqual(r.stages, { transport: 'ok', parsed: true, identityVerified: true, amountVerified: true })
  assert.equal(r.fields.transId, '50012345'); assert.equal(r.verifyCode, '0'); assert.equal(r.verifyResponse, 'CCode=0')
  const d = C.toVerificationRecord(RID, returnRaw(), r)
  assert.equal(d.action, 'record'); assert.equal(d.expectedDbResult, 'paid'); assert.ok(Object.isFrozen(d.record))
  assert.deepEqual(C.verificationRpcArgs(d.record), { p_return_id: RID, p_outcome: 'authentic', p_verify_response: 'CCode=0' })
})
await test('amount mismatch: authentic but a different amount → amount_mismatch (never confirmed)', async () => {
  const { r } = await verify(returnRaw({ Amount: '39.00' }), [{ body: 'CCode=0' }])
  assert.equal(r.outcome, 'amount_mismatch'); assert.equal(r.stages.identityVerified, true); assert.equal(r.stages.amountVerified, false)
  assert.equal(C.toVerificationRecord(RID, returnRaw({ Amount: '39.00' }), r).expectedDbResult, 'amount_mismatch')
})
await test('order reference mismatch → VERIFY not called', async () => {
  const { r, calls } = await verify(returnRaw(), [{ body: 'CCode=0' }], { ref: 'ZZZZZZZZZZZZZZZZ' })
  assert.equal(r.outcome, 'order_mismatch'); assert.equal(calls.length, 0); assert.equal(r.stages.transport, 'not_called')
  assert.equal(C.toVerificationRecord(RID, returnRaw(), r).action, 'do_not_record')
})
await test('declined: authentic return carrying a decline code → declined → record authentic (expect declined)', async () => {
  for (const code of ['4', '6', '15', '33', '447']) {
    const raw = returnRaw({ CCode: code, ACode: '' })
    const { r } = await verify(raw, [{ body: 'CCode=0' }])
    assert.equal(r.outcome, 'declined', code); assert.equal(C.toVerificationRecord(RID, raw, r).expectedDbResult, 'declined')
  }
})
await test('600 / 700 / 800 (J2 / J5 / postponed): not a capture → recorded authentic, DB result not_captured (never paid / declined)', async () => {
  for (const code of ['600', '700', '800']) {
    const { r } = await verify(returnRaw({ CCode: code }), [{ body: 'CCode=0' }])
    assert.equal(r.outcome, 'not_a_charge', code); assert.equal(r.stages.identityVerified, true)
    const d = C.toVerificationRecord(RID, returnRaw({ CCode: code }), r)
    assert.equal(d.action, 'record'); assert.equal(d.record.outcome, 'authentic'); assert.equal(d.expectedDbResult, 'not_captured')
  }
})
await test('all four documented success codes map distinctly: 0 → paid, 600 / 700 / 800 → not_captured; unknown / malformed / unauthenticated never recorded as paid', async () => {
  const map = {}
  for (const code of ['0', '600', '700', '800']) {
    const raw = returnRaw({ CCode: code })
    map[code] = C.toVerificationRecord(RID, raw, (await verify(raw, [{ body: 'CCode=0' }])).r).expectedDbResult
  }
  assert.deepEqual(map, { 0: 'paid', 600: 'not_captured', 700: 'not_captured', 800: 'not_captured' })
  for (const answers of [['timeout'], [{ status: 500, body: '' }], [{ body: 'garbage' }], [{ body: 'CCode=902' }], ['network', { body: 'CCode=902' }]]) {
    const d = C.toVerificationRecord(RID, returnRaw(), (await verify(returnRaw(), answers)).r)
    assert.ok(d.action === 'do_not_record' || (d.record.outcome === 'rejected' && d.expectedDbResult === 'rejected'), JSON.stringify(answers))
  }
})
await test('SIGN never requests J5 or Postpone (600 / 700 / 800 are not expected from our own requests)', () => {
  const u = new URL(C.buildSignUrl(config, REQ))
  for (const k of ['J5', 'J2', 'Postpone', 'MoreData', 'UserId']) assert.equal(u.searchParams.has(k), false, k)
})
await test('VERIFY refuses (902 on a clean first attempt) → verify_rejected → record rejected', async () => {
  const { r, calls } = await verify(returnRaw(), [{ body: 'CCode=902' }])
  assert.equal(r.outcome, 'verify_rejected'); assert.equal(calls.length, 1); assert.equal(r.stages.identityVerified, false)
  assert.equal(C.toVerificationRecord(RID, returnRaw(), r).record.outcome, 'rejected')
})
await test('VERIFY HTTP errors: 5xx retried then unknown (not recorded); 4xx → protocol_error, not retried', async () => {
  let x = await verify(returnRaw(), [{ status: 502, body: '' }])
  assert.equal(x.r.outcome, 'unknown'); assert.equal(x.calls.length, C.HYP_VERIFY_ATTEMPTS); assert.equal(x.r.stages.transport, 'failed')
  assert.equal(C.toVerificationRecord(RID, returnRaw(), x.r).action, 'do_not_record')
  x = await verify(returnRaw(), [{ status: 403, body: 'forbidden' }])
  assert.equal(x.r.outcome, 'protocol_error'); assert.equal(x.calls.length, 1)
})
await test('VERIFY timeout: unknown; timeout → success → confirmed; timeout → non-zero stays unknown (repeatability undocumented)', async () => {
  let x = await verify(returnRaw(), ['timeout'])
  assert.equal(x.r.outcome, 'unknown'); assert.equal(x.r.reason, 'timeout'); assert.equal(x.calls.length, 2)
  x = await verify(returnRaw(), ['timeout', { body: 'CCode=0' }])
  assert.equal(x.r.outcome, 'confirmed'); assert.equal(x.r.attempts, 2)
  x = await verify(returnRaw(), ['network', { body: 'CCode=902' }])
  assert.equal(x.r.outcome, 'unknown'); assert.equal(x.r.reason, 'non_zero_after_ambiguous_attempt')
  assert.equal(C.toVerificationRecord(RID, returnRaw(), x.r).action, 'do_not_record')
})
await test('malformed VERIFY answers → protocol_error, never confirmed', async () => {
  for (const body of ['<html>ok</html>', 'OK', '', 'CCode=0&CCode=0', 'CCode=abc', 'ccode=0', 'Result=success']) {
    const { r } = await verify(returnRaw(), [{ body }])
    assert.equal(r.outcome, 'protocol_error', JSON.stringify(body)); assert.equal(r.stages.identityVerified, false)
    assert.equal(C.toVerificationRecord(RID, returnRaw(), r).action, 'do_not_record')
  }
})
await test('browser parameters alone never confirm: unusable returns are not verified, an echoed return is not a VERIFY answer', async () => {
  for (const raw of [returnRaw({ Sign: undefined, Id: undefined }), `${returnRaw()}&CCode=0`, `Masof=0010000001&${returnRaw()}`]) {
    const { r, calls } = await verify(raw, [{ body: 'CCode=0' }])
    assert.equal(r.outcome, 'invalid_return'); assert.equal(calls.length, 0)
  }
  const { r } = await verify(returnRaw(), [{ body: returnRaw() }])      // "answer" = the browser's own parameters
  assert.equal(r.outcome, 'protocol_error'); assert.equal(r.reason, 'response_echoes_return')
  assert.equal(C.toVerificationRecord(RID, returnRaw(), r).action, 'do_not_record')
  // a forged "confirmed" result whose response is the (redacted) return is refused at the boundary too
  const forged = { ...(await verify(returnRaw(), [{ body: 'CCode=0' }])).r, verifyResponse: P.redactHypText(returnRaw()) }
  assert.equal(C.toVerificationRecord(RID, returnRaw(), forged).action, 'do_not_record')
  assert.equal(C.toVerificationRecord('not-a-uuid', returnRaw(), (await verify(returnRaw(), [{ body: 'CCode=0' }])).r).action, 'do_not_record')
})
await test('duplicate transaction identifiers: the same Id twice yields identical, idempotent records (deduplicated by HYP-05)', async () => {
  const a = await verify(returnRaw(), [{ body: 'CCode=0' }])
  const b = await verify(returnRaw({ Fild1: 'again' }), [{ body: 'CCode=0' }])
  assert.equal(a.r.fields.transId, b.r.fields.transId); assert.equal(a.r.outcome, 'confirmed'); assert.equal(b.r.outcome, 'confirmed')
  assert.equal(C.parseHypReturn(`${returnRaw()}&Id=50012345`).reason, 'duplicate_field')
})

console.log('Security')
await test('redaction: credentials, signatures, card and customer data removed from any text', () => {
  const url = C.buildSignUrl(config, REQ)
  const red = P.redactHypText(`${url}&UserId=890108558&L4digit=5452&cell=0501234567&ClientName=Dana&signature=abc`, [API_KEY, PASSP])
  for (const secret of [API_KEY, PASSP, '890108558', '5452', '0501234567', 'Dana', 'abc']) assert.ok(!red.includes(secret), secret)
  assert.ok(red.includes('Masof=0010000001') && red.includes('Order=' + REF) && red.includes('Amount=40.00'))
  assert.equal(P.redactHypText(`x ${encodeURIComponent('p@ss w')} y`, ['p@ss w']), 'x [redacted] y')
})
await test('no credential appears in any result, error or VERIFY response produced in this suite', async () => {
  const echo = await verify(returnRaw(), [{ body: `CCode=0&KEY=${API_KEY}&x=${PASSP}` }])
  assert.ok(!echo.r.verifyResponse.includes(API_KEY) && !echo.r.verifyResponse.includes(PASSP))
  const all = JSON.stringify(results)
  assert.ok(results.length > 40, `results collected: ${results.length}`)
  assert.ok(!all.includes(API_KEY) && !all.includes(PASSP) && !all.includes(encodeURIComponent(PASSP)))
})
await test('no network to real hosts: every request went to the injected transport, all to pay.hyp.co.il; the default transport is fetch (stubbed)', async () => {
  assert.ok(seen.length > 20)
  for (const u of seen) assert.equal(new URL(u).origin, 'https://pay.hyp.co.il')
  assert.equal(fetchCalls.length, 0, 'the global fetch must not have been used by injected calls')
  const r = await C.signPayment(config, REQ, { timeoutMs: 50 })     // no transport → default → stubbed fetch
  assert.equal(r.error, 'network_error'); assert.equal(fetchCalls.length, 2)
  assert.equal(new URL(fetchCalls[0].url).origin, 'https://pay.hyp.co.il'); assert.equal(fetchCalls[0].init.redirect, 'error')
})
await test('server-only modules: window guard present, no NEXT_PUBLIC usage, not imported by any browser code', () => {
  for (const f of ['lib/hyp/hypConfig.ts', 'lib/hyp/hypClient.ts']) assert.match(src(f), /if \(typeof window !== 'undefined'\) \{\n\s+throw new Error/, f)
  for (const f of ['lib/hyp/hypConfig.ts', 'lib/hyp/hypProtocol.ts', 'lib/hyp/hypClient.ts']) assert.ok(!/process\.env|NEXT_PUBLIC_[A-Z]/.test(src(f).replace(/^\s*\/\/.*$/gm, '')), f)
  const walk = d => readdirSync(join(ROOT, d)).flatMap(n => { const p = join(d, n); return statSync(join(ROOT, p)).isDirectory() ? walk(p) : [p] })
  const importers = ['app', 'lib'].flatMap(walk).filter(f => /\.(ts|tsx)$/.test(f) && !f.replace(/\\/g, '/').startsWith('lib/hyp/') && /hyp\/hyp(Client|Config|Protocol)/.test(src(f)))
  assert.deepEqual(importers, [], 'nothing imports lib/hyp yet (HYP-07 routes are not implemented)')
  assert.ok(!/HYP_/.test(src('next.config.ts')))
})
await test('formats equal the HYP-05 database rules (accepted here ⇔ accepted there)', () => {
  const sql = src('db/migrations/hyp05_payment_intents.sql')
  // exact SQL pattern text present in the migration, and the JS rule agrees with it on a corpus
  const pairs = [[P.HYP_ORDER_REF_RE, '^[A-Z0-9]{8,32}$'], [P.HYP_TRANS_ID_RE, '^[0-9A-Za-z]{1,40}$'], [P.HYP_CCODE_RE, '^[0-9]{1,6}$'],
                 [P.HYP_ACODE_RE, '^[0-9A-Za-z]{1,20}$'], [P.HYP_AMOUNT_RE, '^[0-9]{1,6}(\\.[0-9]{1,2})?$'], [P.HYP_RETURN_RAW_RE, '^[A-Za-z0-9._~%=&+*:,/-]+$']]
  const corpus = ['', '0', '40', '40.5', '40.05', '40.123', '1234567', 'ABCDEFGH', 'abcdefgh', 'A'.repeat(32), 'A'.repeat(33), '50012345', 'x-y',
                  'Id=1&Order=AB', '<b>', 'a b', '.5', '40.', '%D7%A9', REF, '0012345', '9'.repeat(20), '9'.repeat(21), '9'.repeat(40), '9'.repeat(41)]
  for (const [re, sqlPattern] of pairs) {
    assert.ok(sql.includes(`'${sqlPattern}'`), `migration lacks ${sqlPattern}`)
    const pg = new RegExp(sqlPattern)
    for (const s of corpus) assert.equal(re.test(s), pg.test(s), `${sqlPattern} vs ${re.source} on ${JSON.stringify(s)}`)
  }
  assert.match(sql, /char_length\(return_raw\) BETWEEN 1 AND 4000/); assert.equal(P.HYP_RETURN_RAW_MAX, 4000)
  assert.match(sql, /char_length\(verify_response\) BETWEEN 1 AND 2000/); assert.equal(P.HYP_VERIFY_RESPONSE_MAX, 2000)
  assert.match(sql, /amount_agorot BETWEEN 1 AND 500000/); assert.equal(P.HYP_MAX_AMOUNT_AGOROT, 500000)
  assert.match(sql, /FUNCTION public\.record_hyp_verification\(p_return_id uuid, p_outcome text, p_verify_response text\)/)
  assert.match(sql, /p_outcome NOT IN \('authentic', 'rejected'\)/)
  // HYP-06A contract: the same non-capture code set on both sides, and the DB answers not_captured for it
  assert.match(sql, /\(outcome = 'non_capture'\) = \(ccode IN \('600', '700', '800'\)\)/)
  assert.match(sql, /IF v_ccode IN \('600', '700', '800'\) THEN/); assert.match(sql, /'not_captured'::text/)
  assert.match(src('lib/hyp/hypClient.ts'), /const NON_CAPTURE_CODES = new Set\(\['600', '700', '800'\]\)/)
})

console.log(`\n${passed}/${passed + failed} PASS${failed ? ` — ${failed} FAILED` : ''}`)
process.exit(failed ? 1 : 0)
