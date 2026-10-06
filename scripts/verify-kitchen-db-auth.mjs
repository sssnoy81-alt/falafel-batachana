// Local checks for kitchen auth backed by public.kitchen_users (FALAFEL-SN-08D15).
// Runs the REAL login / session / orders route handlers and lib/kitchenUsers against a fake service-role
// Supabase client (in memory). No network, no real DB, no real secrets: passwords / secrets are random
// per run and discarded. Run: node scripts/verify-kitchen-db-auth.mjs

import { createRequire } from 'node:module'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const src = f => readFileSync(join(ROOT, f), 'utf8')

/* ─── Fake service-role Supabase client (records every query) ─── */
const db = { kitchen_users: [], orders: [], queries: [], fail: null, missingConfig: false }
class ServerConfigError extends Error { constructor(m) { super(m); this.name = 'ServerConfigError' } }
function query(table) {
  const q = { table, ops: [] }
  db.queries.push(q)
  const run = () => {
    if (db.fail) return { data: null, error: { code: db.fail, message: 'internal detail that must not leak' } }
    let rows = (db[table] ?? []).map(r => ({ ...r }))
    for (const [op, col, val] of q.ops) {
      if (op === 'eq') rows = rows.filter(r => r[col] === val)
      if (op === 'in') rows = rows.filter(r => val.includes(r[col]))
    }
    const cols = q.ops.find(o => o[0] === 'select')?.[1]
    if (cols && cols !== '*') rows = rows.map(r => Object.fromEntries(cols.split(',').map(c => c.trim()).filter(c => c in r).map(c => [c, r[c]])))
    return { data: rows, error: null }
  }
  const b = {
    select(cols) { q.ops.push(['select', cols]); return b },
    eq(col, val) { q.ops.push(['eq', col, val]); return b },
    in(col, val) { q.ops.push(['in', col, val]); return b },
    gte() { return b }, lt() { return b }, order() { return b },
    async maybeSingle() { const r = run(); return r.error ? r : { data: r.data[0] ?? null, error: null } },
    then(ok, ko) { return Promise.resolve(run()).then(ok, ko) },
  }
  return b
}
const fakeSupabaseServer = {
  ServerConfigError,
  getServerSupabase() { if (db.missingConfig) throw new ServerConfigError('missing'); return { from: query } },
}

/* ─── Loader: TS → CJS; '@/lib/x' and './x' resolve to lib/x.ts; supabaseServer is the fake ─── */
const cache = new Map()
function loadFile(file) {
  if (cache.has(file)) return cache.get(file).exports
  const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  })
  const mod = { exports: {} }
  cache.set(file, mod)
  const req = p => {
    const name = p.startsWith('@/lib/') ? p.slice(6) : p.startsWith('./') && file.includes(`${join(ROOT, 'lib')}`) ? p.slice(2) : null
    if (name === 'supabaseServer') return fakeSupabaseServer
    if (name) return loadFile(join(ROOT, 'lib', name + '.ts'))
    return require(p)
  }
  new Function('exports', 'require', 'module', outputText)(mod.exports, req, mod)
  return mod.exports
}
const lib = n => loadFile(join(ROOT, 'lib', n + '.ts'))
const route = p => loadFile(join(ROOT, 'app', 'api', ...p.split('/'), 'route.ts'))

const K = lib('kitchenAuth')
const repo = lib('kitchenUsers')
const login = route('kitchen/login')
const session = route('kitchen/session')
const orders = route('kitchen/orders')
const { NextRequest } = require('next/server')

let passed = 0
const test = async (name, fn) => { await fn(); passed++; console.log('  ✓', name) }

/* ─── Fixtures ─── */
const SECRET = randomBytes(48).toString('base64url')
const PASSWORD = randomBytes(18).toString('base64url')
const HASH = K.hashPassword(PASSWORD)
const ADUMIM = '8fed141d-0e7c-46c1-803b-88d3d811c1f8'
const MIKHMAS = '3ab15ad1-e835-492b-bae5-11b202ee2314'
const userRow = (over = {}) => ({ username: 'adumim', password_hash: HASH, role: 'branch', branch_id: ADUMIM, label: 'מישור אדומים',
  is_active: true, created_at: '2026-10-06T00:00:00Z', updated_at: '2026-10-06T00:00:00Z', ...over })
const reset = (rows = [userRow()]) => { db.kitchen_users = rows; db.queries = []; db.fail = null; db.missingConfig = false }
const kuQueries = () => db.queries.filter(q => q.table === 'kitchen_users')
process.env.KITCHEN_SESSION_SECRET = SECRET
delete process.env.KITCHEN_USERS

const ORIGIN = 'https://app.example'
const loginReq = (username, password) => new NextRequest(`${ORIGIN}/api/kitchen/login`, {
  method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ username, password }),
})
const doLogin = async (u, p) => { const res = await login.POST(loginReq(u, p)); return { res, status: res.status, body: await res.json(), cookie: res.headers.get('set-cookie') } }
const tokenFor = (user = { username: 'adumim', role: 'branch', branchId: ADUMIM, label: 'מישור אדומים' }, now = Math.floor(Date.now() / 1000)) => K.signSession(user, SECRET, now)
const getWith = (path, token) => new NextRequest(`${ORIGIN}${path}`, { method: 'GET', headers: token ? { cookie: `kitchen_session=${token}` } : {} })
const sessionStatus = async token => { const res = await session.GET(getWith('/api/kitchen/session', token)); return { status: res.status, body: await res.json() } }

console.log('Login against public.kitchen_users (real route)')

await test('1. active user + correct password → 200, session cookie, public fields only', async () => {
  reset()
  const r = await doLogin(' ADUMIM ', PASSWORD) // normalized exactly as before (trim + lower-case)
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, { user: { username: 'adumim', role: 'branch', branchId: ADUMIM, label: 'מישור אדומים' } })
  for (const f of ['kitchen_session=v1.', 'HttpOnly', 'SameSite=Strict', 'Max-Age=2592000', 'Path=/']) assert.ok(r.cookie.includes(f), f)
  const token = r.cookie.split(';')[0].slice('kitchen_session='.length)
  const s = K.verifySession(token, SECRET)
  assert.deepEqual([s.username, s.role, s.branchId, s.exp - s.iat], ['adumim', 'branch', ADUMIM, 30 * 24 * 3600])
  const q = kuQueries()
  assert.equal(q.length, 1); assert.deepEqual(q[0].ops, [['select', 'username, password_hash, role, branch_id, label, is_active'], ['eq', 'username', 'adumim']])
})

let unauthorizedBody
await test('2. wrong password → 401 unauthorized, no cookie', async () => {
  reset()
  const r = await doLogin('adumim', PASSWORD + 'x')
  assert.deepEqual([r.status, r.body, r.cookie], [401, { error: 'unauthorized' }, null])
  unauthorizedBody = JSON.stringify(r.body)
})

await test('3. unknown username → 401, indistinguishable from a wrong password', async () => {
  reset()
  const r = await doLogin('nobody', PASSWORD)
  assert.deepEqual([r.status, JSON.stringify(r.body), r.cookie], [401, unauthorizedBody, null])
})

await test('4. inactive user → 401 (correct password does not help)', async () => {
  reset([userRow({ is_active: false })])
  const r = await doLogin('adumim', PASSWORD)
  assert.deepEqual([r.status, JSON.stringify(r.body), r.cookie], [401, unauthorizedBody, null])
})

await test('5. malformed username → 401 without any DB query', async () => {
  for (const u of ['Bad User!', 'a', 'x'.repeat(40), 'adumim;drop', 'אדומים']) {
    reset()
    const r = await doLogin(u, PASSWORD)
    assert.equal(r.status, 401, u); assert.equal(kuQueries().length, 0, `${u}: no lookup`)
  }
})

await test('6. malformed stored hash / bad row → fail closed (401); DB errors → 500, never a login', async () => {
  for (const bad of [userRow({ password_hash: PASSWORD }), userRow({ password_hash: 'scrypt$1024$8$1$abc$def' }),
    userRow({ role: 'superuser' }), userRow({ branch_id: '11111111-1111-4111-8111-111111111111' }), userRow({ branch_id: null })]) {
    reset([bad])
    const r = await doLogin('adumim', PASSWORD)
    assert.deepEqual([r.status, r.cookie], [401, null])
    assert.equal(await repo.getKitchenUserByUsername('adumim'), null)
  }
  reset(); db.fail = '42P01'
  let r = await doLogin('adumim', PASSWORD)
  assert.deepEqual([r.status, r.body, r.cookie], [500, { error: 'server_error' }, null])
  assert.ok(!JSON.stringify(r.body).includes('internal detail'))
  reset(); db.missingConfig = true
  r = await doLogin('adumim', PASSWORD)
  assert.deepEqual([r.status, r.body, r.cookie], [500, { error: 'server_config' }, null])
})

console.log('Session validation against the current kitchen_users row (real /api/kitchen/session)')

await test('7. session for the existing active same-role / same-branch user → accepted', async () => {
  reset()
  const r = await sessionStatus(tokenFor())
  assert.equal(r.status, 200); assert.deepEqual(r.body.user, { username: 'adumim', role: 'branch', branchId: ADUMIM, label: 'מישור אדומים' })
  assert.equal(kuQueries().length, 1)
})

await test('8. deleted user → session rejected', async () => {
  reset([])
  assert.deepEqual(await sessionStatus(tokenFor()), { status: 401, body: { error: 'unauthorized' } })
})

await test('9. inactive user → session rejected', async () => {
  reset([userRow({ is_active: false })])
  assert.equal((await sessionStatus(tokenFor())).status, 401)
})

await test('10. changed role → session rejected', async () => {
  reset([userRow({ role: 'admin', branch_id: null })])
  assert.equal((await sessionStatus(tokenFor())).status, 401)
})

await test('11. changed branch → session rejected', async () => {
  reset([userRow({ branch_id: MIKHMAS })])
  assert.equal((await sessionStatus(tokenFor())).status, 401)
})

await test('12. expired session → rejected (no DB lookup)', async () => {
  reset()
  const old = Math.floor(Date.now() / 1000) - 30 * 24 * 3600 - 5
  assert.equal((await sessionStatus(tokenFor(undefined, old))).status, 401); assert.equal(kuQueries().length, 0)
})

await test('13. invalid signature / forged / missing cookie → rejected (no DB lookup)', async () => {
  reset()
  const t = tokenFor()
  const forged = K.signSession({ username: 'adumim', role: 'admin', branchId: null, label: 'x' }, randomBytes(48).toString('base64url'))
  for (const bad of [t.slice(0, -3) + 'AAA', forged, 'garbage', null]) assert.equal((await sessionStatus(bad)).status, 401)
  assert.equal(kuQueries().length, 0)
  reset(); db.fail = 'XX000'
  assert.deepEqual(await sessionStatus(tokenFor()), { status: 500, body: { error: 'server_error' } }, 'DB failure never authorizes')
})

console.log('Exposure, isolation, branch enforcement, config')

await test('14. password hash never returned to the client (login, session, repository select)', async () => {
  reset()
  const r = await doLogin('adumim', PASSWORD)
  const s = await sessionStatus(tokenFor())
  const out = JSON.stringify(r.body) + r.cookie + JSON.stringify(s.body)
  for (const needle of [HASH, HASH.split('$')[5], 'password_hash', 'passwordHash', PASSWORD]) assert.ok(!out.includes(needle), needle.slice(0, 12))
  assert.deepEqual(Object.keys(K.publicUser({ ...(await repo.getActiveKitchenUser('adumim')), iat: 1, exp: 2 })).sort(), ['branchId', 'label', 'role', 'username'])
  for (const f of ['app/api/kitchen/login/route.ts', 'app/api/kitchen/session/route.ts'])
    assert.ok(!/passwordHash|password_hash/.test(src(f)), `${f} never touches the hash`)
})

await test('15. anon / browser cannot query kitchen_users (migration lock-down + no client path)', async () => {
  const sql = src('db/migrations/20261006_08d15_kitchen_users.sql').replace(/--.*$/gm, '')
  assert.match(sql, /alter table public\.kitchen_users enable row level security;/)
  assert.ok(!/create policy/i.test(sql), 'no policies at all')
  assert.match(sql, /revoke all on table public\.kitchen_users from public, anon, authenticated;/)
  assert.match(sql, /grant select, insert, update, delete on table public\.kitchen_users to service_role;/)
  assert.ok(!/grant[^;]*kitchen_users[^;]*to (anon|authenticated|public)/i.test(sql))
  // no browser code path: client components, the browser client and pages never name the table or the repository
  const clientFiles = ['lib/supabaseBrowser.ts', 'app/page.tsx', 'app/order/page.tsx', 'app/order/DeliveryAddressPicker.tsx',
    'app/dashboard/orders/page.tsx', 'app/dashboard/page.tsx', 'app/dev/address-poc/AddressPocClient.tsx']
  for (const f of clientFiles) assert.ok(!/kitchen_users|kitchenUsers/.test(src(f)), f)
  const ku = src('lib/kitchenUsers.ts')
  assert.ok(/from '\.\/supabaseServer'/.test(ku) && !/supabaseBrowser|NEXT_PUBLIC|createClient/.test(ku), 'service-role client only')
  assert.ok(ku.includes("throw new Error('lib/kitchenUsers is server-only')"))
})

await test('16. customer order flow unaffected (no kitchen auth / kitchen_users in the order path)', async () => {
  for (const f of ['app/api/orders/route.ts', 'lib/orderRequest.ts', 'lib/pricing.ts', 'lib/orderGeo.ts', 'lib/orderAddress.ts', 'lib/createOrder.ts', 'app/order/page.tsx'])
    assert.ok(!/kitchenUsers|kitchen_users|getKitchenSession|authenticateKitchenUser/.test(src(f)), f)
})

await test('17. kitchen read route still enforces the branch (real /api/kitchen/orders)', async () => {
  reset()
  const forbidden = await orders.GET(getWith('/api/kitchen/orders?branch=all', tokenFor()))
  assert.equal(forbidden.status, 403)
  reset()
  db.orders = [{ id: 'o1', branch_id: ADUMIM }, { id: 'o2', branch_id: MIKHMAS }]
  const own = await orders.GET(getWith('/api/kitchen/orders', tokenFor()))
  assert.equal(own.status, 200)
  const oq = db.queries.find(q => q.table === 'orders')
  assert.deepEqual(oq.ops.find(o => o[0] === 'in'), ['in', 'branch_id', [ADUMIM]])
  reset([])
  const revoked = await orders.GET(getWith('/api/kitchen/orders', tokenFor()))
  assert.equal(revoked.status, 401); assert.equal(db.queries.some(q => q.table === 'orders'), false, 'no order read without a live user')
})

await test('18. kitchen mutation routes await the DB-backed session before any body / data access', async () => {
  for (const f of ['app/api/kitchen/orders/[id]/status/route.ts', 'app/api/kitchen/order-items/[id]/notes/route.ts', 'app/api/push/send/route.ts']) {
    const s = src(f)
    assert.ok(s.includes("import { getKitchenSession } from '@/lib/kitchenUsers'"), f)
    const authAt = s.indexOf('const auth = await getKitchenSession(req)')
    assert.ok(authAt > 0, `${f}: awaited`)
    assert.ok(authAt < s.indexOf('if (!auth.ok) return json({ error: auth.error }, auth.status)'), f)
    assert.ok(authAt < s.indexOf('await req.json()') && authAt < s.indexOf('getServerSupabase()'), `${f}: auth before body/DB`)
    assert.ok(/auth\.session/.test(s), `${f}: branch scope from the session`)
  }
})

await test('19. no KITCHEN_USERS runtime dependency (and no silent env fallback)', async () => {
  const walk = d => readdirSync(d).flatMap(n => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p] })
  for (const f of [...walk(join(ROOT, 'app')), ...walk(join(ROOT, 'lib'))].filter(f => /\.(ts|tsx|js)$/.test(f)))
    assert.ok(!readFileSync(f, 'utf8').includes('KITCHEN_USERS'), relative(ROOT, f))
  for (const gone of ['parseKitchenUsers', 'loadKitchenConfig', 'authenticate', 'getKitchenSession']) assert.equal(K[gone], undefined, gone)
  // a legacy env user is NOT accepted when the table does not have it
  const legacyPw = randomBytes(12).toString('base64url')
  process.env.KITCHEN_USERS = JSON.stringify({ legacy: { hash: K.hashPassword(legacyPw), role: 'admin', branchId: null, label: 'x' } })
  reset()
  assert.equal((await doLogin('legacy', legacyPw)).status, 401)
  delete process.env.KITCHEN_USERS
})

await test('20. KITCHEN_SESSION_SECRET remains required (missing / short → 500, no DB lookup, no cookie)', async () => {
  for (const v of [undefined, 'short']) {
    if (v === undefined) delete process.env.KITCHEN_SESSION_SECRET; else process.env.KITCHEN_SESSION_SECRET = v
    reset()
    const r = await doLogin('adumim', PASSWORD)
    assert.deepEqual([r.status, r.body, r.cookie], [500, { error: 'server_config' }, null])
    assert.deepEqual(await sessionStatus(tokenFor()), { status: 500, body: { error: 'server_config' } })
    assert.equal(kuQueries().length, 0)
  }
  process.env.KITCHEN_SESSION_SECRET = SECRET
  reset(); assert.equal((await doLogin('adumim', PASSWORD)).status, 200)
})

await test('every route that uses the session awaits it (no un-awaited authorization anywhere)', async () => {
  const walk = d => readdirSync(d).flatMap(n => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p] })
  const users = walk(join(ROOT, 'app')).filter(f => /\.tsx?$/.test(f) && readFileSync(f, 'utf8').includes('getKitchenSession('))
  assert.equal(users.length, 5, users.map(f => relative(ROOT, f)).join(', '))
  for (const f of users) {
    const s = readFileSync(f, 'utf8')
    assert.equal((s.match(/getKitchenSession\(/g) || []).length, (s.match(/await getKitchenSession\(/g) || []).length, relative(ROOT, f))
  }
})

console.log(`\nAll ${passed} kitchen DB-auth checks passed.`)
