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
const test = (name, fn) => { fn(); passed++; console.log('  ✓', name) }

const rnd = () => randomBytes(18).toString('base64url')
const PASSWORD = rnd()
const SECRET = randomBytes(48).toString('base64url')
const ADUMIM = '8fed141d-0e7c-46c1-803b-88d3d811c1f8'
const MIKHMAS = '3ab15ad1-e835-492b-bae5-11b202ee2314'
const HASH = K.hashPassword(PASSWORD)
const usersJson = (over = {}) => JSON.stringify({
  admin: { hash: HASH, role: 'admin', branchId: null, label: 'מנהל' },
  adumim: { hash: HASH, role: 'branch', branchId: ADUMIM, label: 'מישור אדומים' },
  mikhmas: { hash: HASH, role: 'branch', branchId: MIKHMAS, label: 'מעבר מכמש' },
  ...over,
})
const env = (over = {}) => ({ KITCHEN_USERS: usersJson(), KITCHEN_SESSION_SECRET: SECRET, ...over })
const now = Math.floor(Date.now() / 1000)
const adumimUser = { username: 'adumim', role: 'branch', branchId: ADUMIM, label: 'מישור אדומים' }

console.log('Password hashing (scrypt)')
test('1. valid password verifies against its hash', () => assert.equal(K.verifyPassword(PASSWORD, HASH), true))
test('2. wrong password fails', () => assert.equal(K.verifyPassword(PASSWORD + 'x', HASH), false))
test('hash format is scrypt$N$r$p$salt$key and salts are unique', () => {
  assert.match(HASH, /^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/)
  assert.notEqual(K.hashPassword(PASSWORD), HASH)
})
test('scripts/hash-kitchen-password.mjs output verifies in lib/kitchenAuth', () => {
  const h = scriptHashPassword(PASSWORD)
  assert.equal(K.verifyPassword(PASSWORD, h), true); assert.equal(K.verifyPassword('nope', h), false)
})
test('malformed / weak-parameter hashes are rejected', () => {
  for (const bad of ['', 'plain', 'scrypt$1024$8$1$abc$def', HASH.replace('scrypt$', 'bcrypt$'), HASH + '$x'])
    assert.equal(K.verifyPassword(PASSWORD, bad), false)
})

console.log('Sessions (HMAC-SHA256)')
const token = K.signSession(adumimUser, SECRET, now)
test('3. valid session signs and verifies', () => {
  const s = K.verifySession(token, SECRET, now + 10)
  assert.equal(s.username, 'adumim'); assert.equal(s.role, 'branch'); assert.equal(s.branchId, ADUMIM)
  assert.equal(s.exp - s.iat, 30 * 24 * 3600)
})
test('4. tampered payload fails', () => {
  const [v, body, sig] = token.split('.')
  const p = JSON.parse(Buffer.from(body, 'base64url').toString()); p.role = 'admin'; p.branchId = null
  const forged = [v, Buffer.from(JSON.stringify(p)).toString('base64url'), sig].join('.')
  assert.equal(K.verifySession(forged, SECRET, now), null)
})
test('5. tampered signature fails', () => {
  const [v, body, sig] = token.split('.')
  const flipped = sig.slice(0, -2) + (sig.slice(-2) === 'AA' ? 'AB' : 'AA')
  assert.equal(K.verifySession([v, body, flipped].join('.'), SECRET, now), null)
})
test('6. expired session fails', () => assert.equal(K.verifySession(token, SECRET, now + 30 * 24 * 3600 + 1), null))
test('7. malformed sessions fail', () => {
  for (const bad of [null, '', 'garbage', 'v1.a.b.c', 'v2.' + token.slice(3), token.replace('v1.', 'v1..'), 'x'.repeat(3000)])
    assert.equal(K.verifySession(bad, SECRET, now), null)
})
test('8. wrong secret fails; missing/short secret → safe config error', () => {
  assert.equal(K.verifySession(token, randomBytes(48).toString('base64url'), now), null)
  assert.throws(() => K.getSessionSecret(undefined), K.KitchenConfigError)
  assert.throws(() => K.getSessionSecret('short'), K.KitchenConfigError)
})
test('9. branch session without branchId rejected (signed with the real secret)', () => {
  const t = K.signSession({ ...adumimUser, branchId: null }, SECRET, now)
  assert.equal(K.verifySession(t, SECRET, now), null)
  const t2 = K.signSession({ ...adumimUser, branchId: '11111111-1111-4111-8111-111111111111' }, SECRET, now)
  assert.equal(K.verifySession(t2, SECRET, now), null) // unknown branch
})
test('10. unsupported role rejected (session + config)', () => {
  const t = K.signSession({ ...adumimUser, role: 'superuser' }, SECRET, now)
  assert.equal(K.verifySession(t, SECRET, now), null)
  assert.throws(() => K.parseKitchenUsers(usersJson({ bad: { hash: HASH, role: 'superuser', branchId: null, label: 'x' } })), K.KitchenConfigError)
})
test('admin session must have branchId null', () => {
  const t = K.signSession({ username: 'admin', role: 'admin', branchId: ADUMIM, label: 'מנהל' }, SECRET, now)
  assert.equal(K.verifySession(t, SECRET, now), null)
})

console.log('KITCHEN_USERS parsing (strict)')
test('valid config loads 3 users; hashes never exposed by authenticate()', () => {
  const users = K.parseKitchenUsers(usersJson())
  assert.equal(users.size, 3)
  const u = K.authenticate(users, 'ADUMIM ', PASSWORD) // case/space-insensitive username
  assert.deepEqual(u, adumimUser); assert.equal('hash' in u, false)
})
test('authenticate: unknown user / wrong password / bad types → null', () => {
  const users = K.parseKitchenUsers(usersJson())
  assert.equal(K.authenticate(users, 'nobody', PASSWORD), null)
  assert.equal(K.authenticate(users, 'admin', 'wrong-password'), null)
  assert.equal(K.authenticate(users, 5, PASSWORD), null)
})
test('malformed configs fail safely (no values in messages)', () => {
  const cases = [undefined, '', 'not json', '[]', '{}',
    usersJson({ admin: { hash: HASH, role: 'admin', branchId: ADUMIM, label: 'x' } }),              // admin with branch
    usersJson({ adumim: { hash: HASH, role: 'branch', branchId: null, label: 'x' } }),               // branch without id
    usersJson({ adumim: { hash: HASH, role: 'branch', branchId: '11111111-1111-4111-8111-111111111111', label: 'x' } }), // unknown branch
    usersJson({ adumim: { hash: 'plaintext', role: 'branch', branchId: ADUMIM, label: 'x' } }),      // not a hash
    usersJson({ adumim: { hash: HASH, role: 'branch', branchId: ADUMIM, label: 'x', password: 'p' } }), // unknown field
    usersJson({ 'Bad User!': { hash: HASH, role: 'admin', branchId: null, label: 'x' } }),
  ]
  for (const c of cases) {
    try { K.parseKitchenUsers(c); assert.fail('should throw') } catch (e) {
      assert.ok(e instanceof K.KitchenConfigError, String(e))
      assert.ok(!e.message.includes(HASH) && !e.message.includes(SECRET))
    }
  }
})

console.log('Cookies + request helpers')
test('cookie flags: HttpOnly, SameSite=Strict, Path=/, 30-day Max-Age, Secure in production', () => {
  const c = K.sessionCookieHeader(token, true)
  for (const f of ['kitchen_session=', 'HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=2592000', 'Secure']) assert.ok(c.includes(f), f)
  assert.ok(!K.sessionCookieHeader(token, false).includes('Secure'))
  assert.ok(K.clearSessionCookieHeader(true).includes('Max-Age=0'))
})
test('Secure is forced in production; only http://localhost in dev may be non-secure', () => {
  assert.equal(K.shouldUseSecureCookie('http://localhost:3000/x', 'production'), true)
  assert.equal(K.shouldUseSecureCookie('http://localhost:3000/x', 'development'), false)
  assert.equal(K.shouldUseSecureCookie('https://preview.example/x', 'development'), true)
  assert.equal(K.shouldUseSecureCookie('http://192.168.1.5:3000/x', 'development'), true)
})
const req = (url, headers = {}, method = 'POST') => new Request(url, { method, headers })
const U = 'https://app.example/api/kitchen/login'
test('same-origin JSON check: accepts same origin; rejects cross-origin / missing Origin / non-JSON / cross-site fetch', () => {
  assert.equal(K.checkSameOriginJson(req(U, { origin: 'https://app.example', 'content-type': 'application/json' })), true)
  assert.equal(K.checkSameOriginJson(req(U, { origin: 'https://app.example', 'content-type': 'application/json; charset=utf-8', 'sec-fetch-site': 'same-origin' })), true)
  assert.equal(K.checkSameOriginJson(req(U, { origin: 'https://evil.example', 'content-type': 'application/json' })), false)
  assert.equal(K.checkSameOriginJson(req(U, { 'content-type': 'application/json' })), false)
  assert.equal(K.checkSameOriginJson(req(U, { origin: 'https://app.example', 'content-type': 'text/plain' })), false)
  assert.equal(K.checkSameOriginJson(req(U, { origin: 'https://app.example', 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' })), false)
})
test('getKitchenSession: valid cookie → session; none/forged → 401; bad config → 500; removed user → revoked', () => {
  const withCookie = t => req('https://app.example/api/kitchen/session', { cookie: `other=1; kitchen_session=${t}` }, 'GET')
  const ok = K.getKitchenSession(withCookie(token), env())
  assert.equal(ok.ok, true); assert.equal(ok.session.username, 'adumim')
  assert.deepEqual(K.getKitchenSession(req('https://app.example/x', {}, 'GET'), env()), { ok: false, status: 401, error: 'unauthorized' })
  assert.equal(K.getKitchenSession(withCookie(token + 'x'), env()).status, 401)
  assert.deepEqual(K.getKitchenSession(withCookie(token), env({ KITCHEN_SESSION_SECRET: undefined })), { ok: false, status: 500, error: 'server_config' })
  const removed = env({ KITCHEN_USERS: JSON.stringify({ admin: { hash: HASH, role: 'admin', branchId: null, label: 'מנהל' } }) })
  assert.equal(K.getKitchenSession(withCookie(token), removed).status, 401)
})
test('publicUser exposes only username/role/branchId/label', () => {
  assert.deepEqual(Object.keys(K.publicUser({ ...adumimUser, iat: 1, exp: 2, hash: 'x' })).sort(), ['branchId', 'label', 'role', 'username'])
})

console.log(`\nAll ${passed} kitchen-auth checks passed.`)
