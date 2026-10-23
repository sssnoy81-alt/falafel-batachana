// S4-INTEGRATIONS-04F2 — ISOLATED end-to-end check of the RPC envelope probe against a REAL PostgREST + PostgreSQL.
//
// Disposable containers on a Docker `--internal` network (no route outside, no published port): the Supabase Postgres
// image (04B → 04D → 04E installed on a fixture) and the PostgREST image. The probe's REAL supabase-js client gets a
// fetch that runs `curl` INSIDE the Postgres container against PostgREST — so the exact HTTP envelopes and supabase-js
// parsing the app will see are exercised, with nothing reachable from or to the outside. Never reads .env*, never
// connects to Supabase; removes everything at the end.
//   node scripts/pgtest-s4-04e-postgrest-envelope.mjs            (needs Docker; not part of the verify-* suite)

import { spawnSync } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MIG = join(ROOT, 'db', 'migrations')
const read = f => readFileSync(join(MIG, f), 'utf8').replace(/\r\n/g, '\n')
const PG_IMAGE = process.env.S4_04E_PG_IMAGE || 'public.ecr.aws/supabase/postgres:17.6.1.141'
const PGRST_IMAGE = process.env.S4_04F2_PGRST_IMAGE || 'public.ecr.aws/supabase/postgrest:v14.5'
const ID = process.pid, NET = `s4-04f2-net-${ID}`, PG = `s4-04f2-pg-${ID}`, RST = `s4-04f2-rest-${ID}`
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
  const args = ['exec', '-i', PG, 'curl', '-s', '-D', '-', '-X', init.method || 'GET', '--max-time', '10']
  for (const [k, v] of headers) if (!['apikey', 'host', 'content-length'].includes(k.toLowerCase())) args.push('-H', `${k}: ${v}`)
  args.push('--data-binary', '@-', target)
  const r = docker(args, typeof init.body === 'string' ? init.body : '')
  assert.equal(r.code, 0, `curl failed: ${r.err}`)
  const sep = r.out.indexOf('\r\n\r\n'), head = r.out.slice(0, sep).split('\r\n'), body = r.out.slice(sep + 4)
  const status = Number(head[0].split(' ')[1])
  const h = new Headers(); for (const l of head.slice(1)) { const i = l.indexOf(':'); if (i > 0) h.append(l.slice(0, i).trim(), l.slice(i + 1).trim()) }
  calls.push({ path: u.pathname, status, contentType: h.get('content-type'), body })
  return new Response(status === 204 ? null : body, { status, headers: h })
}
const calls = []
let capturedRecordBody = null // the real TABLE envelope from E1, re-checked against the app parser in E4

let passed = 0
const test = async (name, fn) => { await fn(); passed++; console.log('  ✓', name) }

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

  /* fixture (as in pgtest-s4-04e-courier-coordination.mjs, minimal) + 04B → 04D → 04E */
  psql(`CREATE TABLE public.branches (id uuid PRIMARY KEY, name text NOT NULL);
    CREATE TABLE public.orders (id uuid PRIMARY KEY, branch_id uuid NOT NULL REFERENCES public.branches(id), status text NOT NULL, customer_name text, phone text);
    CREATE TABLE public.delivery_dispatches (id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY, order_id uuid NOT NULL UNIQUE REFERENCES public.orders(id),
      external_order_id text NOT NULL UNIQUE, provider text NOT NULL DEFAULT 'maale_express', status text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
      last_attempt_at timestamptz, dispatched_at timestamptz, error_code text, provider_order_id text, provider_status text,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT delivery_dispatches_status_check CHECK (status IN ('pending','sending','sent','failed_retryable','failed_final')));
    ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY; ALTER TABLE public.delivery_dispatches ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON public.orders, public.branches FROM PUBLIC, anon, authenticated;
    REVOKE ALL ON public.delivery_dispatches FROM PUBLIC, anon, authenticated, service_role;
    GRANT SELECT, INSERT, UPDATE ON public.delivery_dispatches TO service_role;
    INSERT INTO public.branches VALUES ('8fed141d-0e7c-46c1-803b-88d3d811c1f8', 'b');
    INSERT INTO public.orders VALUES ('00000000-0000-4000-8000-000000000001', '8fed141d-0e7c-46c1-803b-88d3d811c1f8', 'confirmed', 'fixture', '0500000000'),
                                     ('00000000-0000-4000-8000-000000000002', '8fed141d-0e7c-46c1-803b-88d3d811c1f8', 'confirmed', 'fixture', '0500000000');
    INSERT INTO public.delivery_dispatches (order_id, external_order_id) VALUES ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001');
    INSERT INTO public.delivery_dispatches (order_id, external_order_id, status, attempts, last_attempt_at, provider_order_id, dispatched_at)
      VALUES ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000002', 'sent', 1, now(), '284', now());`)
  for (const f of ['s4_04b_maale_quote_rate_limit.sql', 's4_04d_maale_dispatch_reconciliations.sql', 's4_04e_courier_coordination.sql']) psql(read(f))
  for (const [id, , res] of psql(read('s4_04_combined_verify.sql')).split('\n').map(l => l.split('|'))) assert.ok(res === 'PASS' || res === 'INFO', `combined ${id}`)
  psql(`ALTER ROLE authenticator WITH LOGIN PASSWORD '${PW}';`, 'supabase_admin')

  assert.equal(docker(['run', '-d', '--rm', '--name', RST, '--network', NET,
    '-e', `PGRST_DB_URI=postgres://authenticator:${PW}@${PG}:5432/postgres`, '-e', 'PGRST_DB_SCHEMAS=public', '-e', 'PGRST_DB_ANON_ROLE=anon',
    '-e', `PGRST_JWT_SECRET=${JWT_SECRET}`, PGRST_IMAGE]).code, 0, 'postgrest run failed')
  let up = false
  for (let i = 0; i < 60 && !up; i++) { await sleep(1000); up = docker(['exec', PG, 'curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', `http://${RST}:3000/`]).out === '200' }
  assert.ok(up, 'postgrest not ready')
  console.log(`Isolated PostgREST (${PGRST_IMAGE.split('/').pop()}) + PostgreSQL (${psql('SHOW server_version;')}), internal network, no egress`)

  const { createClient } = createRequire(import.meta.url)('@supabase/supabase-js')
  const client = role => createClient('http://probe.invalid', jwt(role), { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: containerFetch } })
  const P = await import('./s4-04e-rpc-envelope-probe.mjs')
  const fp = () => psql(`SELECT md5(COALESCE((SELECT string_agg(d::text, ',' ORDER BY d.order_id) FROM public.delivery_dispatches d), '') || '|' ||
    COALESCE((SELECT string_agg(r::text, ',' ORDER BY r.id) FROM public.maale_dispatch_reconciliations r), '') || '|' ||
    COALESCE((SELECT string_agg(q::text, ',' ORDER BY q.id) FROM public.maale_dispatch_requests q), '') || '|' ||
    COALESCE((SELECT string_agg(o::text, ',' ORDER BY o.id) FROM public.orders o), ''));`)

  await test('E1. the probe against REAL PostgREST + supabase-js → ALL PASS; database byte-identical afterwards', async () => {
    const before = fp(); calls.length = 0
    const r = await P.runProbe(client('service_role'))
    assert.equal(r.ok, true, r.lines.join('\n')); assert.equal(fp(), before, 'nothing written')
    assert.equal(calls.length, 3)
    // the raw envelopes PostgREST really sends
    assert.deepEqual(calls.map(c => [c.path, c.status, c.body]), [
      ['/rest/v1/rpc/claim_maale_dispatch', 200, '"invalid_request"'],
      ['/rest/v1/rpc/claim_maale_dispatch', 200, '"dispatch_row_missing"'],
      ['/rest/v1/rpc/record_maale_reconciliation_event', 200, '[{"result":"invalid_request","event_id":null,"event_created_at":null}]'],
    ])
    for (const c of calls) assert.match(c.contentType, /application\/json/)
    capturedRecordBody = calls[2].body
    for (const l of r.lines) console.log('      ' + l)
  })

  await test('E2. collision case: P2 / P3 aimed at a REAL pending / sent order → still non-mutating (claim_lost / not_claimable, invalid_request)', async () => {
    for (const target of ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002']) {
      const before = fp(); calls.length = 0
      const r = await P.runProbe(client('service_role'), { uuid: () => target })
      assert.equal(r.ok, true, r.lines.join('\n')); assert.equal(fp(), before, `nothing written for ${target}`)
      assert.equal(JSON.parse(calls[1].body), target.endsWith('1') ? 'claim_lost' : 'not_claimable')
    }
  })

  await test('E3. anon key → permission denied (42501) at P1, stopped; a missing function → PGRST202 (the code the app maps to "unavailable")', async () => {
    const before = fp(); calls.length = 0
    const r = await P.runProbe(client('anon'))
    assert.equal(r.ok, false); assert.equal(calls.length, 1); assert.match(r.lines[0], /RPC error 42501/); assert.equal(fp(), before)
    const m = await client('service_role').rpc('claim_maale_dispatch_missing', { p_order_id: null })
    assert.equal(m.error?.code, 'PGRST202')
    const app = readFileSync(join(ROOT, 'app/api/kitchen/orders/[id]/reconciliation/route.ts'), 'utf8')
    assert.ok(app.includes("'PGRST202'"), 'the reconciliation route maps PGRST202 to 503 reconciliation_unavailable')
  })

  await test('E4. the app parsers accept exactly these envelopes (claim: string; record: array of one row with the 3 keys)', () => {
    const md = readFileSync(join(ROOT, 'lib/maaleDispatch.ts'), 'utf8'), rt = readFileSync(join(ROOT, 'app/api/kitchen/orders/[id]/reconciliation/route.ts'), 'utf8')
    assert.ok(md.includes("if (typeof data !== 'string') throw new Error('maale_dispatch: claim unexpected payload')"))
    assert.ok(rt.includes('Array.isArray(data) && data.length === 1 ? data[0] : null'))
    const rec = JSON.parse(capturedRecordBody)
    assert.ok(Array.isArray(rec) && rec.length === 1); assert.deepEqual(Object.keys(rec[0]).sort(), ['event_created_at', 'event_id', 'result'])
  })

  console.log(`\nAll ${passed} isolated PostgREST envelope checks passed (internal network ${NET}).`)
} finally {
  docker(['rm', '-f', RST]); docker(['rm', '-f', PG]); docker(['network', 'rm', NET])
}
