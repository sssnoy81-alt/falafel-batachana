// S4-INTEGRATIONS-04B1 — ISOLATED PostgreSQL test of the quote rate limiter (db/migrations/s4_04b_*.sql).
//
// Runs ONLY against a disposable local Docker container started here with `--network none` (no network at all) from the
// Supabase Postgres image (real anon / authenticated / service_role roles and Supabase default privileges). It never
// reads .env*, never connects to Supabase, and removes the container at the end.
//   node scripts/pgtest-s4-04b-quote-rate-limit.mjs            (needs Docker; not part of the verify-* suite)
// Concurrency is tested with real parallel psql sessions, not mocks.

import { spawn, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MIG = join(ROOT, 'db', 'migrations')
const read = f => readFileSync(join(MIG, f), 'utf8').replace(/\r\n/g, '\n')
const IMAGE = process.env.S4_04B_PG_IMAGE || 'public.ecr.aws/supabase/postgres:17.6.1.141'
const NAME = `s4-04b-pgtest-${process.pid}`

const docker = (args, input) => {
  const r = spawnSync('docker', args, { input, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }
}
/** psql as postgres (the Supabase SQL-editor role). Optional SET ROLE inside the same session. */
function psql(sql, { role, expectError = false } = {}) {
  const body = (role ? `SET ROLE ${role};\n` : '') + sql
  const r = docker(['exec', '-i', NAME, 'psql', '-X', '-q', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At', '-F', '|'], body)
  if (expectError) { assert.notEqual(r.code, 0, `expected an error, got: ${r.out}`); return r.err }
  assert.equal(r.code, 0, `psql failed: ${r.err}\nSQL: ${sql.slice(0, 300)}`)
  return r.out
}
/** Starts one psql session in the background; resolves with its output. */
const psqlAsync = (sql, role) => new Promise(res => {
  const p = spawn('docker', ['exec', '-i', NAME, 'psql', '-X', '-q', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At', '-F', '|'])
  let out = '', err = ''
  p.stdout.on('data', d => { out += d }); p.stderr.on('data', d => { err += d })
  p.on('close', code => res({ code, out: out.trim(), err: err.trim() }))
  p.stdin.end((role ? `SET ROLE ${role};\n` : '') + sql)
})
const sleep = ms => new Promise(r => setTimeout(r, ms))

let passed = 0
const test = async (name, fn) => { await fn(); passed++; console.log('  ✓', name) }

const B1 = '8fed141d-0e7c-46c1-803b-88d3d811c1f8', B2 = '3ab15ad1-e835-492b-bae5-11b202ee2314'
const oid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
// Values are passed as properly quoted SQL literals (like a parameterized RPC call), so hostile input reaches the
// function as DATA — the test is whether the function itself is injection-safe.
const lit = s => `'${String(s).replace(/'/g, "''")}'`
const call = (o, b, a = 'mishor') => `SELECT public.consume_maale_quote_slot(${lit(o)}::uuid, ${lit(b)}::uuid, ${lit(a)});`
const slot = (o, b, a) => psql(call(o, b, a), { role: 'service_role' })
const reset = () => psql('TRUNCATE public.maale_dispatch_requests;')
const ledger = (where = 'true') => Number(psql(`SELECT count(*) FROM public.maale_dispatch_requests WHERE ${where};`))
const backfill = (o, b, n, ago) => psql(`INSERT INTO public.maale_dispatch_requests (order_id, branch_id, actor_username, created_at)
  SELECT '${o}', '${b}', 'seed', clock_timestamp() - interval '${ago}' FROM generate_series(1, ${n});`)
const fingerprint = () => psql(`SELECT md5(COALESCE((SELECT string_agg(o::text, ',' ORDER BY o.id) FROM public.orders o), '')) || ':' ||
  md5(COALESCE((SELECT string_agg(d::text, ',' ORDER BY d.order_id) FROM public.delivery_dispatches d), ''));`)
const rows = sql => psql(sql).split('\n').filter(Boolean).map(l => l.split('|'))

try {
  /* ─── Disposable container ─── */
  const run = docker(['run', '-d', '--rm', '--name', NAME, '--network', 'none', '-e', 'POSTGRES_PASSWORD=local-only-not-secret', IMAGE])
  assert.equal(run.code, 0, `docker run failed: ${run.err}`)
  assert.equal(docker(['inspect', '-f', '{{.HostConfig.NetworkMode}}', NAME]).out, 'none', 'container must have no network')
  // The image runs its init scripts on a temporary server, then restarts: wait for the final start, then for a connection.
  let ready = false
  for (let i = 0; i < 120 && !ready; i++) {
    await sleep(1000)
    const logs = docker(['logs', NAME])
    const initDone = /init process complete/i.test(logs.out + logs.err)
    ready = initDone && docker(['exec', NAME, 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-Atc',
      "SELECT count(*) FROM pg_roles WHERE rolname IN ('service_role','anon','authenticated')"]).out === '3'
  }
  assert.ok(ready, 'container did not become ready')

  console.log(`Isolated PostgreSQL (${psql('SELECT version();').split(' on ')[0]}, network: none)`)

  /* ─── Minimal fixture shaped like Production (orders / branches / delivery_dispatches) ─── */
  psql(`
    CREATE TABLE public.branches (id uuid PRIMARY KEY, name text NOT NULL);
    CREATE TABLE public.orders (id uuid PRIMARY KEY, branch_id uuid NOT NULL REFERENCES public.branches(id), status text NOT NULL,
                                customer_name text, phone text);
    CREATE TABLE public.delivery_dispatches (order_id uuid NOT NULL UNIQUE REFERENCES public.orders(id), external_order_id text NOT NULL UNIQUE,
                                             status text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0);
    ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.delivery_dispatches ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON public.orders, public.branches, public.delivery_dispatches FROM PUBLIC, anon, authenticated;
    REVOKE ALL ON public.delivery_dispatches FROM service_role;
    GRANT SELECT, INSERT, UPDATE ON public.delivery_dispatches TO service_role;
    INSERT INTO public.branches VALUES ('${B1}', 'mishor'), ('${B2}', 'mikhmas');
    INSERT INTO public.orders SELECT ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid,
      CASE WHEN g <= 60 THEN '${B1}'::uuid ELSE '${B2}'::uuid END, 'confirmed', 'fixture', '0500000000' FROM generate_series(1, 100) g;
    INSERT INTO public.delivery_dispatches (order_id, external_order_id, status, attempts) VALUES ('${oid(99)}', '${oid(99)}', 'sent', 1);`)
  const before = fingerprint()

  await test('P1. read-only preflight: all PASS before install (writes nothing)', () => {
    const r = rows(read('s4_04b_production_preflight.sql'))
    assert.equal(r.length, 10)
    for (const [id, , res, detail] of r) assert.ok(res === 'PASS' || res === 'INFO', `${id} ${res} ${detail}`)
    assert.equal(fingerprint(), before)
  })

  await test('M1. migration installs in one transaction (syntax, preflight, post-check)', () => {
    psql(read('s4_04b_maale_quote_rate_limit.sql'))
  })

  await test('M2. re-running the migration aborts in its preflight (no silent re-apply)', () => {
    assert.match(psql(read('s4_04b_maale_quote_rate_limit.sql'), { expectError: true }), /already exists/)
  })

  await test('V1. read-only verify: every row PASS/INFO (exact columns, FKs, indexes, RLS, grants, attributes, body)', () => {
    const fp = psql("SELECT md5(prosrc) || '|' || length(prosrc) FROM pg_proc WHERE proname = 'consume_maale_quote_slot';")
    const [h, len] = fp.split('|')
    const ver = read('s4_04b_verify.sql')
    const pinned = ver.includes(`h = '${h}' AND len = ${len}`)
    assert.ok(pinned, `verify row 11 must pin the installed body ${h} / ${len}`)
    for (const [id, name, res, detail] of rows(ver)) assert.ok(res === 'PASS' || res === 'INFO', `${id} ${name}: ${res} ${detail}`)
  })

  await test('G1. grants: service_role SELECT+INSERT only; anon / authenticated cannot read, write or EXECUTE', () => {
    assert.equal(psql(`SELECT has_table_privilege('service_role','public.maale_dispatch_requests','UPDATE')::text || has_table_privilege('service_role','public.maale_dispatch_requests','DELETE')::text;`), 'falsefalse')
    for (const role of ['anon', 'authenticated']) {
      assert.match(psql(call(oid(1), B1), { role, expectError: true }), /permission denied for function consume_maale_quote_slot/)
      assert.match(psql('SELECT count(*) FROM public.maale_dispatch_requests;', { role, expectError: true }), /permission denied/)
      assert.match(psql(`INSERT INTO public.maale_dispatch_requests (order_id, branch_id, actor_username) VALUES ('${oid(1)}','${B1}','x1');`, { role, expectError: true }), /permission denied/)
    }
    assert.match(psql('DELETE FROM public.maale_dispatch_requests;', { role: 'service_role', expectError: true }), /permission denied/)
    assert.match(psql('UPDATE public.maale_dispatch_requests SET actor_username = actor_username;', { role: 'service_role', expectError: true }), /permission denied/)
    assert.equal(psql("SELECT count(*) FROM information_schema.routine_privileges WHERE routine_name = 'consume_maale_quote_slot' AND grantee = 'PUBLIC';"), '0')
  })

  await test('F1. first slot → ok, exactly one ledger row with the account name and database time', () => {
    reset()
    assert.equal(slot(oid(1), B1, 'mishor'), 'ok')
    assert.equal(ledger(), 1)
    assert.equal(psql(`SELECT actor_username || '|' || (now() - created_at < interval '1 minute') FROM public.maale_dispatch_requests;`), 'mishor|true')
  })

  await test('F2. per-order limit: 3 per 30 min; rejected calls insert nothing; slots expire after 30 min', () => {
    reset()
    assert.deepEqual([1, 2, 3, 4, 5].map(() => slot(oid(2), B1)), ['ok', 'ok', 'ok', 'order_limit', 'order_limit'])
    assert.equal(ledger(), 3, 'rejections never consume a slot')
    assert.equal(slot(oid(3), B1), 'ok', 'another order is independent')
    reset(); backfill(oid(2), B1, 3, '31 minutes')
    assert.equal(slot(oid(2), B1), 'ok', 'rows older than 30 min no longer count')
    reset(); backfill(oid(2), B1, 3, '29 minutes')
    assert.equal(slot(oid(2), B1), 'order_limit')
  })

  await test('F3. per-branch limit: 20 per 60 min (other branch unaffected; window expiry)', () => {
    reset()
    for (let i = 0; i < 10; i++) backfill(oid(10 + i), B1, 2, '10 minutes') // 20 rows over 10 orders
    assert.equal(slot(oid(30), B1), 'branch_limit')
    assert.equal(ledger(), 20)
    assert.equal(slot(oid(61), B2), 'ok', 'the other branch has its own budget')
    reset(); backfill(oid(10), B1, 20, '61 minutes')
    assert.equal(slot(oid(30), B1), 'ok')
  })

  await test('F4. global limit: 40 per 60 min across branches', () => {
    reset()
    for (let i = 0; i < 19; i++) backfill(oid(10 + i), B1, 1, '5 minutes')  // 19 in B1 (below its 20)
    for (let i = 0; i < 21; i++) backfill(oid(61 + i), B2, 1, '5 minutes')  // 21 in B2 → total 40
    assert.equal(slot(oid(40), B1), 'global_limit')
    assert.equal(ledger(), 40)
  })

  await test('F5. unknown order / branch mismatch / bad input → bounded codes, nothing inserted', () => {
    reset()
    assert.equal(slot('11111111-1111-4111-8111-111111111111', B1), 'order_not_found')
    assert.equal(slot(oid(1), B2), 'branch_mismatch')
    assert.equal(slot(oid(1), '22222222-2222-4222-8222-222222222222'), 'branch_mismatch')
    assert.equal(slot(oid(1), B1, 'Bad Name'), 'invalid_request')
    assert.equal(slot(oid(1), B1, "x'); DROP TABLE public.orders; --"), 'invalid_request')
    assert.equal(psql(`SELECT public.consume_maale_quote_slot(NULL, '${B1}', 'mishor');`, { role: 'service_role' }), 'invalid_request')
    assert.equal(ledger(), 0)
    assert.equal(psql("SELECT to_regclass('public.orders') IS NOT NULL;"), 't')
  })

  await test('C1. CONCURRENCY: 8 real sessions race for the last per-order slot → exactly one ok', async () => {
    reset(); backfill(oid(5), B1, 2, '1 minute')
    // Controller holds the function's lock so all 8 sessions queue on it, then releases them at once.
    const holder = psqlAsync('SELECT pg_advisory_lock(1296122188, 1); SELECT pg_sleep(2); SELECT pg_advisory_unlock(1296122188, 1);')
    await sleep(700)
    const workers = Array.from({ length: 8 }, () => psqlAsync(call(oid(5), B1), 'service_role'))
    const results = await Promise.all(workers); await holder
    const codes = results.map(r => r.out.split('\n').pop()).sort()
    assert.deepEqual(codes, ['ok', ...Array(7).fill('order_limit')].sort(), JSON.stringify(results))
    assert.equal(ledger(`order_id = '${oid(5)}'`), 3)
  })

  await test('C2. CONCURRENCY: 12 sessions on 12 different orders race for the last 2 GLOBAL slots → exactly two ok', async () => {
    reset()
    for (let i = 0; i < 15; i++) backfill(oid(10 + i), B1, 1, '5 minutes')  // B1: 15 (room 5 in its branch budget)
    for (let i = 0; i < 23; i++) backfill(oid(61 + i), B2, 1, '5 minutes')  // B2: 23 (seeded directly) → 38 total
    const holder = psqlAsync('SELECT pg_advisory_lock(1296122188, 1); SELECT pg_sleep(2); SELECT pg_advisory_unlock(1296122188, 1);')
    await sleep(700)
    // All racers are B1 orders: only the GLOBAL limit (2 left) can stop them.
    const workers = Array.from({ length: 12 }, (_, i) => psqlAsync(call(oid(30 + i), B1), 'service_role'))
    const codes = (await Promise.all(workers)).map(r => r.out.split('\n').pop()); await holder
    assert.equal(codes.filter(c => c === 'ok').length, 2, codes.join(','))
    assert.ok(codes.every(c => c === 'ok' || c === 'global_limit'), codes.join(','))
    assert.equal(ledger(), 40, 'never above the global limit')
  })

  await test('E1. SQL failure blocks: lock timeout (3s) raises and inserts nothing', async () => {
    reset()
    const holder = psqlAsync('SELECT pg_advisory_lock(1296122188, 1); SELECT pg_sleep(5); SELECT pg_advisory_unlock(1296122188, 1);')
    await sleep(700)
    const r = await psqlAsync(call(oid(6), B1), 'service_role'); await holder
    assert.notEqual(r.code, 0); assert.match(r.err, /lock timeout|canceling statement due to lock timeout/)
    assert.equal(ledger(), 0)
  })

  await test('E2. SQL failure blocks: missing privilege (service_role without SELECT on orders) raises, inserts nothing', () => {
    reset()
    const err = psql(`BEGIN; REVOKE SELECT ON public.orders FROM service_role; SET LOCAL ROLE service_role; ${call(oid(7), B1)} COMMIT;`, { expectError: true })
    assert.match(err, /permission denied for table orders/)
    assert.equal(ledger(), 0)
    assert.equal(psql("SELECT has_table_privilege('service_role','public.orders','SELECT');"), 't', 'REVOKE rolled back with the failed transaction')
  })

  await test('E3. the slot is lost when the caller transaction rolls back (no partial state)', () => {
    reset()
    psql(`BEGIN; SET LOCAL ROLE service_role; ${call(oid(8), B1)} ROLLBACK;`)
    assert.equal(ledger(), 0)
  })

  await test('N1. orders and delivery_dispatches are byte-identical after every test (never modified)', () => {
    assert.equal(fingerprint(), before)
    assert.equal(psql(`SELECT status || '|' || attempts FROM public.delivery_dispatches;`), 'sent|1')
  })

  await test('R1. rollback refuses without the explicit confirmation (and changes nothing)', () => {
    assert.match(psql(read('s4_04b_rollback.sql'), { expectError: true }), /not confirmed/)
    assert.equal(psql("SELECT to_regclass('public.maale_dispatch_requests') IS NOT NULL;"), 't')
  })

  await test('R2. confirmed rollback drops exactly the 04B objects; orders / delivery_dispatches untouched; reinstall works', () => {
    psql("SET s4_04b.confirm_rollback = 'DROP-QUOTE-LEDGER';\n" + read('s4_04b_rollback.sql'))
    assert.equal(psql("SELECT (to_regclass('public.maale_dispatch_requests') IS NULL)::text || (to_regprocedure('public.consume_maale_quote_slot(uuid,uuid,text)') IS NULL)::text;"), 'truetrue')
    assert.equal(fingerprint(), before)
    assert.match(psql("SET s4_04b.confirm_rollback = 'DROP-QUOTE-LEDGER';\n" + read('s4_04b_rollback.sql'), { expectError: true }), /not installed/)
    const pre = rows(read('s4_04b_production_preflight.sql'))
    assert.ok(pre.every(([, , res]) => res !== 'FAIL'), 'preflight passes again after rollback')
    psql(read('s4_04b_maale_quote_rate_limit.sql'))
    assert.equal(slot(oid(1), B1), 'ok')
  })

  console.log(`\nAll ${passed} isolated PostgreSQL checks passed (container ${NAME}, network none).`)
} finally {
  docker(['rm', '-f', NAME])
}
