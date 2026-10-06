// Local checks for the pure kitchen-auth primitives (no DB, no network, no real secrets).
// Run: node scripts/verify-kitchen-auth.mjs
// All passwords/secrets below are generated randomly at runtime and discarded.

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import assert from 'node:assert/strict'
import { hashPassword as scriptHashPassword } from './hash-kitchen-password.mjs'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const LIB = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'lib')
function load(name) {
  const { outputText } = ts.transpileModule(readFileSync(join(LIB, name + '.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  })
  const mod = { exports: {} }
  new Function('exports', 'require', 'module', outputText)(mod.exports, require, mod)
  return mod.exports
}

const K = load('kitchenAuth')
let passed = 0
const test = async (name, fn) => { await fn(); passed++; console.log('  ✓', name) }

const rnd = () => randomBytes(18).toString('base64url')
const PASSWORD = rnd()
const SECRET = randomBytes(48).toString('base64url')
const ADUMIM = '8fed141d-0e7c-46c1-803b-88d3d811c1f8'
const MIKHMAS = '3ab15ad1-e835-492b-bae5-11b202ee2314'
const HASH = K.hashPassword(PASSWORD)
// public.kitchen_users rows (08D15) served by an in-memory KitchenUserStore (the app uses lib/kitchenUsers).
const row = (username, role, branch_id, label, over = {}) => ({ username, password_hash: HASH, role, branch_id, label, is_active: true, ...over })
const ROWS = () => [row('admin', 'admin', null, 'מנהל'), row('adumim', 'branch', ADUMIM, 'מישור אדומים'), row('mikhmas', 'branch', MIKHMAS, 'מעבר מכמש')]
const storeOf = (rows = ROWS()) => {
  const byName = new Map(rows.map(r => [r.username, r]))
  return { async findByUsername(u) { const r = byName.get(u); return r ? K.kitchenUserFromRow(r) : null } }
}
const env = (over = {}) => ({ KITCHEN_SESSION_SECRET: SECRET, ...over })
const now = Math.floor(Date.now() / 1000)
const adumimUser = { username: 'adumim', role: 'branch', branchId: ADUMIM, label: 'מישור אדומים' }

console.log('Password hashing (scrypt)')
await test('1. valid password verifies against its hash', () => assert.equal(K.verifyPassword(PASSWORD, HASH), true))
await test('2. wrong password fails', () => assert.equal(K.verifyPassword(PASSWORD + 'x', HASH), false))
await test('hash format is scrypt$N$r$p$salt$key and salts are unique', () => {
  assert.match(HASH, /^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/)
  assert.notEqual(K.hashPassword(PASSWORD), HASH)
})
await test('scripts/hash-kitchen-password.mjs output verifies in lib/kitchenAuth', () => {
  const h = scriptHashPassword(PASSWORD)
  assert.equal(K.verifyPassword(PASSWORD, h), true); assert.equal(K.verifyPassword('nope', h), false)
})
await test('malformed / weak-parameter hashes are rejected', () => {
  for (const bad of ['', 'plain', 'scrypt$1024$8$1$abc$def', HASH.replace('scrypt$', 'bcrypt$'), HASH + '$x'])
    assert.equal(K.verifyPassword(PASSWORD, bad), false)
})

console.log('Sessions (HMAC-SHA256)')
const token = K.signSession(adumimUser, SECRET, now)
await test('3. valid session signs and verifies', () => {
  const s = K.verifySession(token, SECRET, now + 10)
  assert.equal(s.username, 'adumim'); assert.equal(s.role, 'branch'); assert.equal(s.branchId, ADUMIM)
  assert.equal(s.exp - s.iat, 30 * 24 * 3600)
})
await test('4. tampered payload fails', () => {
  const [v, body, sig] = token.split('.')
  const p = JSON.parse(Buffer.from(body, 'base64url').toString()); p.role = 'admin'; p.branchId = null
  const forged = [v, Buffer.from(JSON.stringify(p)).toString('base64url'), sig].join('.')
  assert.equal(K.verifySession(forged, SECRET, now), null)
})
await test('5. tampered signature fails', () => {
  const [v, body, sig] = token.split('.')
  const flipped = sig.slice(0, -2) + (sig.slice(-2) === 'AA' ? 'AB' : 'AA')
  assert.equal(K.verifySession([v, body, flipped].join('.'), SECRET, now), null)
})
await test('6. expired session fails', () => assert.equal(K.verifySession(token, SECRET, now + 30 * 24 * 3600 + 1), null))
await test('7. malformed sessions fail', () => {
  for (const bad of [null, '', 'garbage', 'v1.a.b.c', 'v2.' + token.slice(3), token.replace('v1.', 'v1..'), 'x'.repeat(3000)])
    assert.equal(K.verifySession(bad, SECRET, now), null)
})
await test('8. wrong secret fails; missing/short secret → safe config error', () => {
  assert.equal(K.verifySession(token, randomBytes(48).toString('base64url'), now), null)
  assert.throws(() => K.getSessionSecret(undefined), K.KitchenConfigError)
  assert.throws(() => K.getSessionSecret('short'), K.KitchenConfigError)
})
await test('9. branch session without branchId rejected (signed with the real secret)', () => {
  const t = K.signSession({ ...adumimUser, branchId: null }, SECRET, now)
  assert.equal(K.verifySession(t, SECRET, now), null)
  const t2 = K.signSession({ ...adumimUser, branchId: '11111111-1111-4111-8111-111111111111' }, SECRET, now)
  assert.equal(K.verifySession(t2, SECRET, now), null) // unknown branch
})
await test('10. unsupported role rejected (session + config)', () => {
  const t = K.signSession({ ...adumimUser, role: 'superuser' }, SECRET, now)
  assert.equal(K.verifySession(t, SECRET, now), null)
  assert.equal(K.kitchenUserFromRow(row('bad', 'superuser', null, 'x')), null)
})
await test('admin session must have branchId null', () => {
  const t = K.signSession({ username: 'admin', role: 'admin', branchId: ADUMIM, label: 'מנהל' }, SECRET, now)
  assert.equal(K.verifySession(t, SECRET, now), null)
})

console.log('kitchen_users rows + login (strict, store-backed)')
await test('valid rows map; hashes never exposed by authenticateKitchenUser()', async () => {
  for (const r of ROWS()) assert.ok(K.kitchenUserFromRow(r), r.username)
  const u = await K.authenticateKitchenUser(storeOf(), 'ADUMIM ', PASSWORD) // case/space-insensitive username
  assert.deepEqual(u, adumimUser); assert.equal('hash' in u, false); assert.equal('passwordHash' in u, false)
})
await test('authenticateKitchenUser: unknown user / wrong password / bad types → null', async () => {
  assert.equal(await K.authenticateKitchenUser(storeOf(), 'nobody', PASSWORD), null)
  assert.equal(await K.authenticateKitchenUser(storeOf(), 'admin', 'wrong-password'), null)
  assert.equal(await K.authenticateKitchenUser(storeOf(), 5, PASSWORD), null)
})
await test('malformed rows map to null (fail closed)', () => {
  const cases = [null, 'x', [], {},
    row('admin', 'admin', ADUMIM, 'x'),                                      // admin with branch
    row('adumim', 'branch', null, 'x'),                                      // branch without id
    row('adumim', 'branch', '11111111-1111-4111-8111-111111111111', 'x'),    // unknown branch
    row('adumim', 'branch', ADUMIM, 'x', { password_hash: 'plaintext' }),    // not a hash
    row('adumim', 'branch', ADUMIM, 'x', { is_active: 'yes' }),              // bad flag
    row('adumim', 'branch', ADUMIM, '   '),                                  // empty label
    row('Bad User!', 'admin', null, 'x'),
  ]
  for (const c of cases) assert.equal(K.kitchenUserFromRow(c), null, String(JSON.stringify(c)).slice(0, 60))
})

console.log('Cookies + request helpers')
await test('cookie flags: HttpOnly, SameSite=Strict, Path=/, 30-day Max-Age, Secure in production', () => {
  const c = K.sessionCookieHeader(token, true)
  for (const f of ['kitchen_session=', 'HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=2592000', 'Secure']) assert.ok(c.includes(f), f)
  assert.ok(!K.sessionCookieHeader(token, false).includes('Secure'))
  assert.ok(K.clearSessionCookieHeader(true).includes('Max-Age=0'))
})
await test('Secure is forced in production; only http://localhost in dev may be non-secure', () => {
  assert.equal(K.shouldUseSecureCookie('http://localhost:3000/x', 'production'), true)
  assert.equal(K.shouldUseSecureCookie('http://localhost:3000/x', 'development'), false)
  assert.equal(K.shouldUseSecureCookie('https://preview.example/x', 'development'), true)
  assert.equal(K.shouldUseSecureCookie('http://192.168.1.5:3000/x', 'development'), true)
})
const req = (url, headers = {}, method = 'POST') => new Request(url, { method, headers })
const U = 'https://app.example/api/kitchen/login'
await test('same-origin JSON check: accepts same origin; rejects cross-origin / missing Origin / non-JSON / cross-site fetch', () => {
  assert.equal(K.checkSameOriginJson(req(U, { origin: 'https://app.example', 'content-type': 'application/json' })), true)
  assert.equal(K.checkSameOriginJson(req(U, { origin: 'https://app.example', 'content-type': 'application/json; charset=utf-8', 'sec-fetch-site': 'same-origin' })), true)
  assert.equal(K.checkSameOriginJson(req(U, { origin: 'https://evil.example', 'content-type': 'application/json' })), false)
  assert.equal(K.checkSameOriginJson(req(U, { 'content-type': 'application/json' })), false)
  assert.equal(K.checkSameOriginJson(req(U, { origin: 'https://app.example', 'content-type': 'text/plain' })), false)
  assert.equal(K.checkSameOriginJson(req(U, { origin: 'https://app.example', 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' })), false)
})
await test('verifyKitchenRequest: valid cookie → session; none/forged → 401; bad config → 500; removed user → revoked', async () => {
  const withCookie = t => req('https://app.example/api/kitchen/session', { cookie: 'other=1; kitchen_session=' + t }, 'GET')
  const ok = await K.verifyKitchenRequest(withCookie(token), { store: storeOf(), env: env() })
  assert.equal(ok.ok, true); assert.equal(ok.session.username, 'adumim')
  assert.deepEqual(await K.verifyKitchenRequest(req('https://app.example/x', {}, 'GET'), { store: storeOf(), env: env() }), { ok: false, status: 401, error: 'unauthorized' })
  assert.equal((await K.verifyKitchenRequest(withCookie(token + 'x'), { store: storeOf(), env: env() })).status, 401)
  assert.deepEqual(await K.verifyKitchenRequest(withCookie(token), { store: storeOf(), env: env({ KITCHEN_SESSION_SECRET: undefined }) }), { ok: false, status: 500, error: 'server_config' })
  const removed = storeOf([row('admin', 'admin', null, 'מנהל')])
  assert.equal((await K.verifyKitchenRequest(withCookie(token), { store: removed, env: env() })).status, 401)
})
await test('publicUser exposes only username/role/branchId/label', () => {
  assert.deepEqual(Object.keys(K.publicUser({ ...adumimUser, iat: 1, exp: 2, hash: 'x' })).sort(), ['branchId', 'label', 'role', 'username'])
})

console.log(`\nAll ${passed} kitchen-auth checks passed.`)
