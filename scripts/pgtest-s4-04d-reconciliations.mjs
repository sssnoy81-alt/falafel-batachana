// S4-INTEGRATIONS-04D1 — ISOLATED PostgreSQL test of the reconciliation ledger (db/migrations/s4_04d_*.sql).
//
// Runs ONLY against a disposable local Docker container started here with `--network none` (no network at all) from the
// Supabase Postgres image (real anon / authenticated / service_role roles and Supabase default privileges). It never
// reads .env*, never connects to Supabase, and removes the container at the end. The 04B ledger is installed first to
// prove both coexist without touching each other.
//   node scripts/pgtest-s4-04d-reconciliations.mjs            (needs Docker; not part of the verify-* suite)

import { spawn, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MIG = join(ROOT, 'db', 'migrations')
const read = f => readFileSync(join(MIG, f), 'utf8').replace(/\r\n/g, '\n')
const IMAGE = process.env.S4_04D_PG_IMAGE || 'public.ecr.aws/supabase/postgres:17.6.1.141'
const NAME = `s4-04d-pgtest-${process.pid}`

const docker = (args, input) => {
  const r = spawnSync('docker', args, { input, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }
}
function psql(sql, { role, expectError = false } = {}) {
  const r = docker(['exec', '-i', NAME, 'psql', '-X', '-q', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At', '-F', '|'], (role ? `SET ROLE ${role};\n` : '') + sql)
  if (expectError) { assert.notEqual(r.code, 0, `expected an error, got: ${r.out}`); return r.err }
  assert.equal(r.code, 0, `psql failed: ${r.err}\nSQL: ${sql.slice(0, 300)}`)
  return r.out
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
let passed = 0
const test = async (name, fn) => { await fn(); passed++; console.log('  ✓', name) }

const B1 = '8fed141d-0e7c-46c1-803b-88d3d811c1f8'
const oid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const PILOT = oid(3) // shaped like the real pilot: cancelled kitchen order whose dispatch row stays 'sent'
const lit = s => (s === null ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`)
// request_id: an explicit UUID literal, or (default) a fresh one per statement (a "genuinely new action").
const insert = ({ order = oid(1), event, actor = 'mishor', pid = null, pst = null, reason = null, rid = null }) =>
  `INSERT INTO public.maale_dispatch_reconciliations (request_id, order_id, event_type, actor_username, provider_order_id, provider_status, reason_code)
   VALUES (${rid === null ? 'gen_random_uuid()' : `${lit(rid)}::uuid`}, ${lit(order)}, ${lit(event)}, ${lit(actor)}, ${lit(pid)}, ${lit(pst)}, ${lit(reason)});`
/** One background psql session (for real concurrency). */
const psqlAsync = (sql, role) => new Promise(res => {
  const p = spawn('docker', ['exec', '-i', NAME, 'psql', '-X', '-q', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At', '-F', '|'])
  let out = '', err = ''
  p.stdout.on('data', d => { out += d }); p.stderr.on('data', d => { err += d })
  p.on('close', code => res({ code, out: out.trim(), err: err.trim() }))
  p.stdin.end((role ? `SET ROLE ${role};\n` : '') + sql)
})
const asService = sql => psql(sql, { role: 'service_role' })
const rejects = (sql, re, role = 'service_role') => assert.match(psql(sql, { role, expectError: true }), re)
const count = (w = 'true') => Number(psql(`SELECT count(*) FROM public.maale_dispatch_reconciliations WHERE ${w};`))
const fingerprint = () => psql(`SELECT
  md5(COALESCE((SELECT string_agg(o::text, ',' ORDER BY o.id) FROM public.orders o), '')) || ':' ||
  md5(COALESCE((SELECT string_agg(d::text, ',' ORDER BY d.order_id) FROM public.delivery_dispatches d), '')) || ':' ||
  md5(COALESCE((SELECT string_agg(r::text, ',' ORDER BY r.id) FROM public.maale_dispatch_requests r), ''));`)
const rows = sql => psql(sql).split('\n').filter(Boolean).map(l => l.split('|'))

try {
  const run = docker(['run', '-d', '--rm', '--name', NAME, '--network', 'none', '-e', 'POSTGRES_PASSWORD=local-only-not-secret', IMAGE])
  assert.equal(run.code, 0, `docker run failed: ${run.err}`)
  assert.equal(docker(['inspect', '-f', '{{.HostConfig.NetworkMode}}', NAME]).out, 'none', 'container must have no network')
  let ready = false
  for (let i = 0; i < 120 && !ready; i++) {
    await sleep(1000)
    const logs = docker(['logs', NAME])
    ready = /init process complete/i.test(logs.out + logs.err) && docker(['exec', NAME, 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-Atc',
      "SELECT count(*) FROM pg_roles WHERE rolname IN ('service_role','anon','authenticated')"]).out === '3'
  }
  assert.ok(ready, 'container did not become ready')
  console.log(`Isolated PostgreSQL (${psql('SELECT version();').split(' on ')[0]}, network: none)`)

  /* ─── Fixture shaped like Production (+ the 04B ledger installed first) ─── */
  psql(`
    CREATE TABLE public.branches (id uuid PRIMARY KEY, name text NOT NULL);
    CREATE TABLE public.orders (id uuid PRIMARY KEY, branch_id uuid NOT NULL REFERENCES public.branches(id), status text NOT NULL, customer_name text, phone text);
    CREATE TABLE public.delivery_dispatches (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL UNIQUE REFERENCES public.orders(id),
      external_order_id text NOT NULL UNIQUE, status text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
      provider_order_id text, provider_status text, dispatched_at timestamptz);
    ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY; ALTER TABLE public.delivery_dispatches ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON public.orders, public.branches, public.delivery_dispatches FROM PUBLIC, anon, authenticated;
    REVOKE ALL ON public.delivery_dispatches FROM service_role; GRANT SELECT, INSERT, UPDATE ON public.delivery_dispatches TO service_role;
    INSERT INTO public.branches VALUES ('${B1}', 'mishor');
    INSERT INTO public.orders SELECT ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, '${B1}', 'confirmed', 'fixture', '0500000000' FROM generate_series(1, 10) g;
    UPDATE public.orders SET status = 'cancelled' WHERE id = '${PILOT}';
    INSERT INTO public.delivery_dispatches (order_id, external_order_id, status, attempts, provider_order_id, provider_status, dispatched_at)
      VALUES ('${PILOT}', '${PILOT}', 'sent', 1, '284', 'searching', now());`)
  psql(read('s4_04b_maale_quote_rate_limit.sql'))
  psql(`SET ROLE service_role; SELECT public.consume_maale_quote_slot('${PILOT}', '${B1}', 'mishor');`)
  const before = fingerprint()

  await test('P1. read-only preflight: all PASS before install (writes nothing)', () => {
    const r = rows(read('s4_04d_production_preflight.sql'))
    assert.equal(r.length, 8)
    for (const [id, , res, detail] of r) assert.ok(res === 'PASS' || res === 'INFO', `${id} ${res} ${detail}`)
    assert.equal(fingerprint(), before)
  })

  await test('M1. migration applies once in one transaction (preflight + post-check)', () => { psql(read('s4_04d_maale_dispatch_reconciliations.sql')) })

  await test('M2. duplicate application fails safely in its preflight (no partial re-apply)', () => {
    assert.match(psql(read('s4_04d_maale_dispatch_reconciliations.sql'), { expectError: true }), /already exists \(no silent re-apply\)/)
    assert.equal(count(), 0)
  })

  await test('V1. read-only verify: every row PASS / INFO (columns, 10 exact constraints, indexes, RLS, grants, no triggers)', () => {
    for (const [id, name, res, detail] of rows(read('s4_04d_verify.sql'))) assert.ok(res === 'PASS' || res === 'INFO', `${id} ${name}: ${res} ${detail}`)
  })

  await test('G1. grants: anon / authenticated cannot read or write; service_role SELECT + INSERT only; nothing for PUBLIC', () => {
    for (const role of ['anon', 'authenticated']) {
      rejects('SELECT count(*) FROM public.maale_dispatch_reconciliations;', /permission denied/, role)
      rejects(insert({ event: 'manual_courier' }), /permission denied/, role)
    }
    assert.equal(psql(`SELECT has_table_privilege('service_role','public.maale_dispatch_reconciliations','UPDATE')::text
      || has_table_privilege('service_role','public.maale_dispatch_reconciliations','DELETE')::text
      || has_table_privilege('service_role','public.maale_dispatch_reconciliations','TRUNCATE')::text;`), 'falsefalsefalse')
    assert.equal(psql("SELECT count(*) FROM information_schema.role_table_grants WHERE table_name = 'maale_dispatch_reconciliations' AND grantee = 'PUBLIC';"), '0')
  })

  await test('E1. invalid event types rejected (no "automatic cancellation" state can be stored)', () => {
    for (const ev of ['cancelled_automatically', 'auto_cancelled', 'retry', 'reset', 'redispatch', 'CANCELLED_AT_PROVIDER', '', ' confirmed_sent'])
      rejects(insert({ event: ev, pid: 'MX-1' }), /maale_dispatch_reconciliations_event_type_check|violates check constraint/)
    assert.equal(count(), 0)
  })

  await test('E2. invalid actor rejected (kitchen account rule)', () => {
    for (const a of ['Mishor', 'm', 'a'.repeat(33), 'mish or', "x'; DROP TABLE public.orders; --", 'ישראל'])
      rejects(insert({ event: 'manual_courier', actor: a }), /maale_dispatch_reconciliations_actor_format/)
    assert.equal(psql("SELECT to_regclass('public.orders') IS NOT NULL;"), 't')
  })

  await test('E3. unknown order rejected (FK → orders)', () => {
    rejects(insert({ order: '11111111-1111-4111-8111-111111111111', event: 'manual_courier' }), /maale_dispatch_reconciliations_order_id_fkey/)
  })

  await test('E4. event shape rules: provider id required / forbidden; safe id / status / reason formats; no free text', () => {
    rejects(insert({ event: 'confirmed_sent' }), /provider_order_id_rule/)
    rejects(insert({ event: 'cancelled_at_provider' }), /provider_order_id_rule/)
    rejects(insert({ event: 'not_received', pid: '284' }), /provider_order_id_rule/)
    rejects(insert({ event: 'manual_courier', pid: '284' }), /provider_order_id_rule/)
    for (const pid of ['MX 1', "28'4", 'a'.repeat(101), '', '284;drop', '0501234567 Cohen'])
      rejects(insert({ event: 'confirmed_sent', pid }), /provider_order_id_format|provider_order_id_rule/)
    rejects(insert({ event: 'manual_review_opened', pst: 'searching' }), /provider_status_rule/)
    for (const pst of ['Searching', 'in-progress', 'x'.repeat(41)]) rejects(insert({ event: 'provider_status_checked', pst }), /provider_status_format/)
    for (const reason of ['customer said so', 'Other', 'phone:0501234567']) rejects(insert({ event: 'manual_courier', reason }), /reason_code_check/)
    rejects('INSERT INTO public.maale_dispatch_reconciliations (request_id, order_id, event_type, actor_username, note) VALUES (gen_random_uuid(), \'' + oid(1) + '\', \'manual_courier\', \'mishor\', \'x\');', /column "note" .* does not exist/)
    rejects('INSERT INTO public.maale_dispatch_reconciliations (order_id, event_type, actor_username) VALUES (\'' + oid(1) + '\', \'manual_courier\', \'mishor\');', /null value in column "request_id"/)
    assert.equal(count(), 0)
  })

  await test('A1. valid events of every type accepted as service_role; latest event per order is well defined', () => {
    asService(insert({ order: oid(1), event: 'manual_review_opened', reason: 'outcome_unknown' }))
    asService(insert({ order: oid(1), event: 'provider_status_checked', pid: 'MX-1', pst: 'searching', reason: 'provider_phone_confirmed' }))
    asService(insert({ order: oid(1), event: 'confirmed_sent', pid: 'MX-1', reason: 'provider_phone_confirmed' }))
    asService(insert({ order: oid(1), event: 'manual_review_resolved' }))
    asService(insert({ order: oid(2), event: 'not_received', reason: 'provider_dashboard_confirmed' }))
    assert.equal(count(), 5)
    assert.equal(psql(`SELECT event_type FROM public.maale_dispatch_reconciliations WHERE order_id = '${oid(1)}' ORDER BY created_at DESC, id DESC LIMIT 1;`), 'manual_review_resolved')
    assert.equal(psql(`SELECT count(*) FROM public.maale_dispatch_reconciliations WHERE order_id = '${oid(1)}';`, { role: 'service_role' }), '4', 'service_role can read the history')
  })

  await test('A2. append-only for the application: service_role UPDATE / DELETE / TRUNCATE denied; rows unchanged', () => {
    const snap = psql('SELECT md5(string_agg(r::text, \',\' ORDER BY id)) FROM public.maale_dispatch_reconciliations r;')
    rejects("UPDATE public.maale_dispatch_reconciliations SET event_type = 'confirmed_sent';", /permission denied/)
    rejects('DELETE FROM public.maale_dispatch_reconciliations;', /permission denied/)
    rejects('TRUNCATE public.maale_dispatch_reconciliations;', /permission denied/)
    assert.equal(psql('SELECT md5(string_agg(r::text, \',\' ORDER BY id)) FROM public.maale_dispatch_reconciliations r;'), snap)
  })

  await test('H1. pilot-shaped history: cancelled order + sent dispatch → confirmed_sent then cancelled_at_provider; dispatch row untouched', () => {
    asService(insert({ order: PILOT, event: 'confirmed_sent', pid: '284', reason: 'provider_phone_confirmed' }))
    asService(insert({ order: PILOT, event: 'cancelled_at_provider', pid: '284', reason: 'kitchen_cancelled' }))
    assert.equal(psql(`SELECT status || '|' || provider_order_id || '|' || provider_status FROM public.delivery_dispatches WHERE order_id = '${PILOT}';`), 'sent|284|searching')
    assert.equal(psql(`SELECT status FROM public.orders WHERE id = '${PILOT}';`), 'cancelled', 'cancelled orders keep their history')
    assert.equal(psql(`SELECT event_type FROM public.maale_dispatch_reconciliations WHERE order_id = '${PILOT}' ORDER BY created_at DESC, id DESC LIMIT 1;`), 'cancelled_at_provider')
    // History is protected: an order with reconciliation rows cannot be deleted (RESTRICT), even by the owner. The probe
    // runs in ONE transaction, so the refused DELETE rolls back the whole attempt (the fixture stays untouched).
    assert.match(psql(`BEGIN; DELETE FROM public.delivery_dispatches WHERE order_id = '${PILOT}'; DELETE FROM public.orders WHERE id = '${PILOT}'; COMMIT;`, { expectError: true }), /maale_dispatch_reconciliations_order_id_fkey|violates foreign key/)
    assert.equal(psql(`SELECT count(*) FROM public.delivery_dispatches WHERE order_id = '${PILOT}';`), '1', 'dispatch row still there')
  })

  await test('H2. manual courier for an order WITHOUT a dispatch row is representable (no provider id)', () => {
    asService(insert({ order: oid(5), event: 'manual_courier', reason: 'courier_booked_by_phone' }))
    assert.equal(psql(`SELECT count(*) FROM public.delivery_dispatches WHERE order_id = '${oid(5)}';`), '0')
    assert.equal(count(`order_id = '${oid(5)}' AND event_type = 'manual_courier' AND provider_order_id IS NULL`), 1)
  })

  await test('I1. same request_id twice → UNIQUE violation; the stored row is never modified (identical or different payload)', () => {
    const rid = 'aaaaaaaa-0000-4000-8000-000000000001'
    asService(insert({ order: oid(6), event: 'manual_review_opened', reason: 'outcome_unknown', rid }))
    const snap = psql(`SELECT md5(r::text) FROM public.maale_dispatch_reconciliations r WHERE request_id = '${rid}';`)
    rejects(insert({ order: oid(6), event: 'manual_review_opened', reason: 'outcome_unknown', rid }), /maale_dispatch_reconciliations_request_id_key|duplicate key/)
    rejects(insert({ order: oid(7), event: 'manual_courier', rid }), /maale_dispatch_reconciliations_request_id_key|duplicate key/)
    assert.equal(count(`request_id = '${rid}'`), 1)
    assert.equal(psql(`SELECT md5(r::text) FROM public.maale_dispatch_reconciliations r WHERE request_id = '${rid}';`), snap)
  })

  await test('I2. REAL CONCURRENCY: 10 sessions released at once insert the SAME request_id → exactly one row, nine rejected', async () => {
    const rid = 'bbbbbbbb-0000-4000-8000-000000000002'
    // Controller holds an exclusive advisory lock; every worker queues on a shared lock inside its transaction, then all
    // INSERT simultaneously when the controller releases.
    const holder = psqlAsync('SELECT pg_advisory_lock(4204, 1); SELECT pg_sleep(2); SELECT pg_advisory_unlock(4204, 1);')
    await sleep(700)
    const workers = Array.from({ length: 10 }, () => psqlAsync(`BEGIN; SELECT pg_advisory_xact_lock_shared(4204, 1); ${insert({ order: oid(8), event: 'manual_courier', reason: 'courier_booked_by_phone', rid })} COMMIT;`, 'service_role'))
    const results = await Promise.all(workers); await holder
    assert.equal(results.filter(r => r.code === 0).length, 1, results.map(r => r.err).join(' | '))
    assert.ok(results.filter(r => r.code !== 0).every(r => /request_id_key|duplicate key/.test(r.err)))
    assert.equal(count(`request_id = '${rid}'`), 1)
  })

  await test('I3. two genuinely different actions (different request_ids, identical payload) → two rows', () => {
    asService(insert({ order: oid(9), event: 'manual_review_opened' }))
    asService(insert({ order: oid(9), event: 'manual_review_opened' }))
    assert.equal(count(`order_id = '${oid(9)}'`), 2)
  })

  await test('N1. orders, delivery_dispatches and the 04B ledger are byte-identical after every test', () => {
    assert.equal(fingerprint(), before)
    for (const [id, name, res, detail] of rows(read('s4_04b_verify.sql'))) assert.ok(res === 'PASS' || res === 'INFO', `04B ${id} ${name}: ${res} ${detail}`)
  })

  await test('R1. rollback refuses without the explicit confirmation, and while history exists without the export confirmation', () => {
    assert.match(psql(read('s4_04d_rollback.sql'), { expectError: true }), /not confirmed/)
    assert.match(psql("SET s4_04d.confirm_rollback = 'DROP-RECONCILIATION-LEDGER';\n" + read('s4_04d_rollback.sql'), { expectError: true }), /export them/)
    assert.ok(count() > 0, 'history intact after refusals')
  })

  await test('R2. fully confirmed rollback drops only the ledger; everything else untouched; reinstall works', () => {
    psql("SET s4_04d.confirm_rollback = 'DROP-RECONCILIATION-LEDGER';\nSET s4_04d.confirm_history_exported = 'yes';\n" + read('s4_04d_rollback.sql'))
    assert.equal(psql("SELECT to_regclass('public.maale_dispatch_reconciliations') IS NULL;"), 't')
    assert.equal(fingerprint(), before)
    assert.match(psql("SET s4_04d.confirm_rollback = 'DROP-RECONCILIATION-LEDGER';\n" + read('s4_04d_rollback.sql'), { expectError: true }), /not installed/)
    assert.ok(rows(read('s4_04d_production_preflight.sql')).every(([, , res]) => res !== 'FAIL'))
    psql(read('s4_04d_maale_dispatch_reconciliations.sql'))
    asService(insert({ order: oid(1), event: 'manual_courier' }))
    assert.equal(count(), 1)
  })

  console.log(`\nAll ${passed} isolated PostgreSQL checks passed (container ${NAME}, network none).`)
} finally {
  docker(['rm', '-f', NAME])
}
