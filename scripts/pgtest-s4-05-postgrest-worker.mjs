// S4-MAALE-03 — ISOLATED end-to-end check of the auto-dispatch worker's REAL Supabase / PostgREST queries
// (lib/kitchenAutoDispatchServer.ts) against a REAL PostgREST + PostgreSQL with migration s4_05 installed.
//
// Disposable containers on a Docker `--internal` network (no route outside, no published port). The app's real
// supabase-js client gets a fetch that runs `curl` INSIDE the Postgres container against PostgREST (same technique as
// scripts/pgtest-s4-04e-postgrest-envelope.mjs). The provider call is replaced by a counting fake: no Maale request is
// possible (global fetch throws). Never reads .env*, never connects to Supabase; removes everything at the end.
//   node scripts/pgtest-s4-05-postgrest-worker.mjs            (needs Docker; not part of the verify-* suite)
import { spawnSync } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

globalThis.fetch = async () => { throw new Error('LIVE NETWORK CALL ATTEMPTED') }

const require = createRequire(import.meta.url)
const ts = require('typescript')
const { createClient } = require('@supabase/supabase-js')
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MIG = join(ROOT, 'db', 'migrations')
const read = f => readFileSync(join(MIG, f), 'utf8').replace(/\r\n/g, '\n')
const PG_IMAGE = process.env.S4_04E_PG_IMAGE || 'public.ecr.aws/supabase/postgres:17.6.1.141'
const PGRST_IMAGE = process.env.S4_04F2_PGRST_IMAGE || 'public.ecr.aws/supabase/postgrest:v14.5'
const ID = process.pid, NET = `s4-05-net-${ID}`, PG = `s4-05-pg-${ID}`, RST = `s4-05-rest-${ID}`
const PW = randomBytes(12).toString('hex'), JWT_SECRET = randomBytes(32).toString('hex') // local-only, generated per run

const docker = (args, input) => { const r = spawnSync('docker', args, { input, encoding: 'utf8', maxBuffer: 32 << 20 }); return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() } }
const psql = (sql, user = 'postgres') => {
  const r = docker(['exec', '-i', PG, 'psql', '-X', '-q', '-U', user, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At'], sql)
  assert.equal(r.code, 0, `psql failed: ${r.err}`); return r.out
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const b64u = o => Buffer.from(JSON.stringify(o)).toString('base64url')
const jwt = role => { const h = b64u({ alg: 'HS256', typ: 'JWT' }), p = b64u({ role, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 })
  return `${h}.${p}.${createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest('base64url')}` }

/** fetch → curl inside the Postgres container → PostgREST (internal network). Returns a real Response. */
async function containerFetch(input, init = {}) {
  const u = new URL(typeof input === 'string' ? input : input.url)
  assert.ok(u.pathname.startsWith('/rest/v1/'), u.pathname)
  const target = `http://${RST}:3000/${u.pathname.slice('/rest/v1/'.length)}${u.search}`
  const headers = new Headers(init.headers)
  const args = ['exec', '-i', PG, 'curl', '-s', '-g', '-D', '-', '-X', init.method || 'GET', '--max-time', '10']
  for (const [k, v] of headers) if (!['apikey', 'host', 'content-length'].includes(k.toLowerCase())) args.push('-H', `${k}: ${v}`)
  args.push('--data-binary', '@-', target)
  const r = spawnSync('docker', args, { input: typeof init.body === 'string' ? init.body : '', encoding: 'utf8', maxBuffer: 32 << 20 })
  assert.equal(r.status, 0, `curl failed: ${r.stderr}`)
  const out = r.stdout, sep = out.indexOf('\r\n\r\n'), head = out.slice(0, sep).split('\r\n'), body = out.slice(sep + 4)
  const status = Number(head[0].split(' ')[1])
  const h = new Headers(); for (const l of head.slice(1)) { const i = l.indexOf(':'); if (i > 0) h.append(l.slice(0, i).trim(), l.slice(i + 1).trim()) }
  requests.push({ method: init.method || 'GET', path: u.pathname, search: decodeURIComponent(u.search), status })
  return new Response(status === 204 ? null : body, { status, headers: h })
}
const requests = []

/* ─── load the app modules with the REAL supabase-js client pointed at the isolated PostgREST ─── */
const serviceClient = () => createClient('http://worker.invalid', jwt('service_role'), { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: containerFetch } })
const cache = new Map()
function loadFile(file) {
  if (cache.has(file)) return cache.get(file).exports
  const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } })
  const mod = { exports: {} }; cache.set(file, mod)
  const req = p => {
    const name = p.startsWith('@/lib/') ? p.slice(6) : p.startsWith('./') && file.includes(join(ROOT, 'lib')) ? p.slice(2) : null
    if (name === 'supabaseServer') return { ServerConfigError: class extends Error {}, getServerSupabase: serviceClient }
    if (name) return loadFile(join(ROOT, 'lib', name + '.ts'))
    return require(p)
  }
  new Function('exports', 'require', 'module', outputText)(mod.exports, req, mod)
  return mod.exports
}
for (const k of ['MAALE_EXPRESS_ENABLED', 'MAALE_EXPRESS_API_KEY', 'MAALE_KITCHEN_RECONCILIATION_ENABLED', 'MAALE_AUTO_DISPATCH_ENABLED', 'MAALE_PARCEL_DISPATCH_ENABLED']) delete process.env[k]

let passed = 0
const test = async (name, fn) => { await fn(); passed++; console.log('  ✓', name) }
const B1 = '8fed141d-0e7c-46c1-803b-88d3d811c1f8', B2 = 'f1e2d3c4-b5a6-4978-8a9b-0c1d2e3f4a5b'
const oid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const task = o => psql(`SELECT state || '/' || attempts || '/' || COALESCE(reason_code, '-') FROM public.maale_auto_dispatch_queue WHERE order_id = '${o}';`)

try {
  assert.equal(docker(['network', 'create', '--internal', NET]).code, 0, 'network create failed')
  assert.equal(docker(['network', 'inspect', '-f', '{{.Internal}}', NET]).out, 'true', 'network must be internal (no egress)')
  assert.equal(docker(['run', '-d', '--rm', '--name', PG, '--network', NET, '-e', `POSTGRES_PASSWORD=${PW}`, PG_IMAGE]).code, 0, 'pg run failed')
  let ready = false
  for (let i = 0; i < 120 && !ready; i++) {
    await sleep(1000)
    const l = docker(['logs', PG])
    ready = /init process complete/i.test(l.out + l.err) && docker(['exec', PG, 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-Atc', 'SELECT 1']).out === '1'
  }
  assert.ok(ready, 'postgres not ready')

  /* fixture shaped like Production (orders.type, deliveries one-to-one, delivery_dispatches) + s4_05 */
  psql(`CREATE TABLE public.branches (id uuid PRIMARY KEY, name text NOT NULL);
    CREATE TABLE public.orders (id uuid PRIMARY KEY, branch_id uuid NOT NULL REFERENCES public.branches(id), type text NOT NULL, status text NOT NULL DEFAULT 'received',
      customer_name text, phone text);
    CREATE TABLE public.deliveries (order_id uuid PRIMARY KEY REFERENCES public.orders(id), delivery_fee numeric(10,2) NOT NULL, address text);
    CREATE TABLE public.delivery_dispatches (order_id uuid PRIMARY KEY REFERENCES public.orders(id), external_order_id text NOT NULL, status text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0);
    ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY; ALTER TABLE public.deliveries ENABLE ROW LEVEL SECURITY; ALTER TABLE public.delivery_dispatches ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON public.orders, public.branches, public.deliveries, public.delivery_dispatches FROM PUBLIC, anon, authenticated;
    GRANT SELECT, UPDATE ON public.orders TO service_role; GRANT SELECT ON public.deliveries, public.branches TO service_role;
    INSERT INTO public.branches VALUES ('${B1}', 'mishor'), ('${B2}', 'other');
    INSERT INTO public.orders (id, branch_id, type, customer_name, phone) SELECT ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid,
      CASE WHEN g > 40 THEN '${B2}' ELSE '${B1}' END::uuid, 'delivery', 'fixture', '0500000000' FROM generate_series(1, 50) g;
    INSERT INTO public.deliveries (order_id, delivery_fee, address) SELECT id, 20, 'x' FROM public.orders;`)
  psql(read('s4_05_maale_auto_dispatch_queue.sql'))
  for (const [id, name, res, detail] of psql(read('s4_05_verify.sql')).split('\n').map(l => l.split('|'))) assert.ok(res === 'PASS' || res === 'INFO', `verify ${id} ${name}: ${res} ${detail}`)
  psql('UPDATE public.maale_auto_dispatch_config SET enqueue_enabled = true;')
  psql(`SET ROLE service_role; UPDATE public.orders SET status = 'confirmed' WHERE id IN (${[1, 2, 3, 4, 5, 6, 7, 8, 41].map(n => `'${oid(n)}'`).join(',')});`)
  psql(`ALTER ROLE authenticator WITH LOGIN PASSWORD '${PW}';`, 'supabase_admin')
  assert.equal(docker(['run', '-d', '--rm', '--name', RST, '--network', NET,
    '-e', `PGRST_DB_URI=postgres://authenticator:${PW}@${PG}:5432/postgres`, '-e', 'PGRST_DB_SCHEMAS=public', '-e', 'PGRST_DB_ANON_ROLE=anon',
    '-e', `PGRST_JWT_SECRET=${JWT_SECRET}`, PGRST_IMAGE]).code, 0, 'postgrest run failed')
  let up = false
  for (let i = 0; i < 60 && !up; i++) { await sleep(1000); up = docker(['exec', PG, 'curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', `http://${RST}:3000/`]).out === '200' }
  assert.ok(up, 'postgrest not ready')
  console.log(`Isolated PostgREST (${PGRST_IMAGE.split('/').pop()}) + PostgreSQL (${psql('SHOW server_version;')}), internal network, no egress`)

  const S = loadFile(join(ROOT, 'lib', 'kitchenAutoDispatchServer.ts'))
  const A = loadFile(join(ROOT, 'lib', 'kitchenAutoDispatch.ts'))
  const KO = loadFile(join(ROOT, 'lib', 'kitchenOrders.ts'))
  let dispatchCalls = 0
  const deps = (over = {}) => ({ ...S.productionAutoDispatchDeps(), dispatch: async () => { dispatchCalls++; return { ok: true, outcome: 'sent', kind: 'created' } }, log: () => {}, ...over })

  await test('Q1. loadTask / loadOrder: real select + one-to-one deliveries embed through PostgREST', async () => {
    const d = deps()
    const t = await d.loadTask(oid(1)); assert.equal(t.state, 'queued'); assert.equal(t.attempts, 0); assert.equal(t.branch_id, B1); assert.ok(Date.parse(t.enqueued_at) > 0)
    assert.equal(await d.loadTask(oid(30)), null)
    assert.deepEqual(await d.loadOrder(oid(1)), { id: oid(1), branch_id: B1, status: 'confirmed', type: 'delivery', delivery_fee: 20 })
  })
  await test('Q2. claim: conditional UPDATE (state + attempts) returns the row exactly once; a second identical claim gets nothing', async () => {
    const d = deps(); const t = await d.loadTask(oid(2))
    assert.equal(await d.claim(t, new Date().toISOString()), true); assert.equal(task(oid(2)), 'processing/1/-')
    assert.equal(await d.claim(t, new Date().toISOString()), false); assert.equal(task(oid(2)), 'processing/1/-')
  })
  await test('Q3. 8 concurrent claims through PostgREST (real parallel HTTP) → exactly one true', async () => {
    const d = deps(); const t = await d.loadTask(oid(3))
    const r = await Promise.all(Array.from({ length: 8 }, () => d.claim(t, new Date().toISOString())))
    assert.equal(r.filter(Boolean).length, 1); assert.equal(task(oid(3)), 'processing/1/-')
  })
  await test('Q4. finish: from processing only; the database guard refuses a second finish (final state) → false, no change', async () => {
    const d = deps()
    assert.equal(await d.finish(oid(3), 'processing', 'manual', 'credit_dispatch_disabled', new Date().toISOString()), true)
    assert.equal(task(oid(3)), 'manual/1/credit_dispatch_disabled')
    assert.equal(await d.finish(oid(3), 'processing', 'dispatched', null, new Date().toISOString()), false)
    assert.equal(await d.finish(oid(3), 'manual', 'dispatched', null, new Date().toISOString()), false)          // guard: task final (22023)
    assert.equal(task(oid(3)), 'manual/1/credit_dispatch_disabled')
  })
  await test('Q5. listDue: or(queued, stale processing) with an ISO timestamp, branch filter, oldest first, limit', async () => {
    const d = deps()
    psql(`ALTER TABLE public.maale_auto_dispatch_queue DISABLE TRIGGER maale_auto_dispatch_queue_guard;
          UPDATE public.maale_auto_dispatch_queue SET enqueued_at = now() - (interval '1 second' * (100 - right(order_id::text, 2)::int));
          UPDATE public.maale_auto_dispatch_queue SET claimed_at = now() - interval '10 minutes' WHERE order_id = '${oid(2)}';
          ALTER TABLE public.maale_auto_dispatch_queue ENABLE TRIGGER maale_auto_dispatch_queue_guard;`)
    const staleBefore = new Date(Date.now() - A.AUTO_DISPATCH_STALE_CLAIM_MS).toISOString()
    const b1 = (await d.listDue([B1], staleBefore, 50)).map(t => t.order_id)
    assert.deepEqual(b1, [1, 2, 4, 5, 6, 7, 8].map(oid), 'queued + stale processing (2), not final (3); oldest first')
    assert.deepEqual((await d.listDue([B2], staleBefore, 50)).map(t => t.order_id), [oid(41)])
    assert.equal((await d.listDue(null, staleBefore, 3)).length, 3)
    const fresh = new Date(Date.now() - 60 * 60_000).toISOString()   // nothing claimed before an hour ago → 2 not due
    assert.ok(!(await d.listDue([B1], fresh, 50)).some(t => t.order_id === oid(2)))
    const q = requests.filter(r => r.search.includes('or=')).pop()
    assert.match(q.search, /or=\(state\.eq\.queued,and\(state\.eq\.processing,claimed_at\.lt\.\d{4}-\d\d-\d\dT[\d:.]+Z\)\)/)
  })
  await test('Q6. stale re-claim through PostgREST is accepted by the database guard (attempts + 1)', async () => {
    const d = deps(); const t = await d.loadTask(oid(2))
    assert.equal(await d.claim(t, new Date().toISOString()), true); assert.equal(task(oid(2)), 'processing/2/-')
  })
  await test('Q7. runAutoDispatch end to end on the real queue: queued → dispatched with one provider call; repeat = busy', async () => {
    dispatchCalls = 0
    assert.deepEqual(await A.runAutoDispatch(deps(), oid(4)), { result: 'finished', state: 'dispatched', reason: null })
    assert.equal(task(oid(4)), 'dispatched/1/-'); assert.equal(dispatchCalls, 1)
    assert.deepEqual(await A.runAutoDispatch(deps(), oid(4)), { result: 'busy' }); assert.equal(dispatchCalls, 1)
  })
  await test('Q8. 6 concurrent runs (after() + sweeps + tablets) on one real task → ONE provider call', async () => {
    dispatchCalls = 0
    const r = await Promise.all(Array.from({ length: 6 }, () => A.runAutoDispatch(deps(), oid(5))))
    assert.equal(dispatchCalls, 1); assert.equal(r.filter(x => x.result === 'finished').length, 1); assert.equal(task(oid(5)), 'dispatched/1/-')
  })
  await test('Q9. uncertain outcome → investigate, never processed again by run or sweep; transient → queued then manual after 3', async () => {
    dispatchCalls = 0
    const unsure = deps({ dispatch: async () => { dispatchCalls++; return { ok: false, outcome: 'manual_review_required', reason: 'sending_outcome_unknown' } } })
    assert.equal((await A.runAutoDispatch(unsure, oid(6))).state, 'investigate'); assert.equal(task(oid(6)), 'investigate/1/sending_outcome_unknown')
    // never due again (so no sweep can pick it up) and a direct run is refused — checked without sweeping other tasks
    const dueNow = await unsure.listDue([B1], new Date(Date.now() + 60_000).toISOString(), 50)
    assert.ok(!dueNow.some(t => t.order_id === oid(6)), 'an investigate task is never due')
    assert.deepEqual(await A.runAutoDispatch(unsure, oid(6)), { result: 'busy' }); assert.equal(dispatchCalls, 1)
    assert.equal(task(oid(6)), 'investigate/1/sending_outcome_unknown')
    let n = 0
    const transient = deps({ dispatch: async () => { n++; return { ok: false, outcome: 'blocked', reason: 'quote_unavailable' } } })
    for (let i = 0; i < 4; i++) await A.runAutoDispatch(transient, oid(7))
    assert.equal(task(oid(7)), 'manual/3/quote_unavailable'); assert.equal(n, 3)
  })
  await test('Q10. the real production deps with Maale disabled (default env) → manual:maale_disabled, no network', async () => {
    const d = { ...S.productionAutoDispatchDeps(), log: () => {} }
    assert.deepEqual(await A.runAutoDispatch(d, oid(8)), { result: 'finished', state: 'manual', reason: 'maale_disabled' })
    assert.equal(task(oid(8)), 'manual/1/maale_disabled')
  })
  await test('Q11. kitchen read model embed through PostgREST: orders + maale_auto_dispatch_queue(state, reason_code)', async () => {
    const { data, error } = await serviceClient().from('orders').select('id, maale_auto_dispatch_queue(state, reason_code)').in('id', [oid(4), oid(30)]).order('id')
    assert.equal(error, null)
    assert.deepEqual(data.map(r => KO.normalizeAutoDispatch(r.maale_auto_dispatch_queue)), [{ state: 'dispatched', reason: null }, null])
  })
  await test('Q12. PostgREST as service_role cannot create or delete a task, nor flip the switch', async () => {
    const c = serviceClient()
    assert.equal((await c.from('maale_auto_dispatch_queue').insert({ order_id: oid(30) })).error?.code, '42501')
    assert.equal((await c.from('maale_auto_dispatch_queue').delete().eq('order_id', oid(1))).error?.code, '42501')
    assert.equal((await c.from('maale_auto_dispatch_config').update({ enqueue_enabled: false }).eq('singleton', true)).error?.code, '42501')
    const anon = createClient('http://worker.invalid', jwt('anon'), { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: containerFetch } })
    assert.equal((await anon.from('maale_auto_dispatch_queue').select('order_id')).error?.code, '42501')
  })

  console.log(`\nAll ${passed} isolated PostgREST worker checks passed (internal network ${NET}).`)
} finally {
  docker(['rm', '-f', RST]); docker(['rm', '-f', PG]); docker(['network', 'rm', NET])
}
