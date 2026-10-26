// S4-MAALE-03 — ISOLATED PostgreSQL test of the auto-dispatch queue migration (db/migrations/s4_05_*.sql).
//
// Disposable Docker container started here with `--network none` from the Supabase Postgres image (real anon /
// authenticated / service_role roles). Never reads .env*, never connects to Supabase, removes the container at the end.
// Fixture shaped like Production (orders with type / status / branch_id, delivery_dispatches, a parcel accept gate that
// raises parcel_not_ready like Migration 03). Concurrency uses real parallel psql sessions.
//   node scripts/pgtest-s4-05-auto-dispatch-queue.mjs            (needs Docker; not part of the verify-* suite)
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MIG = join(ROOT, 'db', 'migrations')
const read = f => readFileSync(join(MIG, f), 'utf8').replace(/\r\n/g, '\n')
const IMAGE = process.env.S4_04E_PG_IMAGE || 'public.ecr.aws/supabase/postgres:17.6.1.141'
const NAME = `s4-05-pgtest-${process.pid}`

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

const B1 = '8fed141d-0e7c-46c1-803b-88d3d811c1f8'
const oid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const rows = sql => psql(sql).split('\n').filter(Boolean).map(l => l.split('|'))
const allPass = (r, label) => { for (const [id, name, res, detail] of r) assert.ok(res === 'PASS' || res === 'INFO', `${label} ${id} ${name}: ${res} ${detail}`) }
const fingerprint = sql => psql(`SELECT md5(COALESCE((${sql}), ''));`)
const task = o => psql(`SELECT state || '/' || attempts || '/' || COALESCE(reason_code, '-') FROM public.maale_auto_dispatch_queue WHERE order_id = '${o}';`)
const tasks = () => Number(psql('SELECT count(*) FROM public.maale_auto_dispatch_queue;'))
const ostatus = o => psql(`SELECT status FROM public.orders WHERE id = '${o}';`)
const confirm = (o, opts) => psql(`UPDATE public.orders SET status = 'confirmed' WHERE id = '${o}' AND status = 'received';`, { role: 'service_role', ...opts })
const enable = on => psql(`UPDATE public.maale_auto_dispatch_config SET enqueue_enabled = ${on}, updated_at = now();`)
const as = (sql, role = 'service_role') => psql(sql, { role, expectError: true })

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

  /* ─── Fixture shaped like Production ─── */
  psql(`
    CREATE TABLE public.branches (id uuid PRIMARY KEY, name text NOT NULL);
    CREATE TABLE public.orders (id uuid PRIMARY KEY, branch_id uuid NOT NULL REFERENCES public.branches(id), type text NOT NULL,
      status text NOT NULL DEFAULT 'received', payment_method text NOT NULL DEFAULT 'cash', parcel_ready boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT orders_status_check CHECK (status IN ('received', 'confirmed', 'preparing', 'ready', 'delivered', 'cancelled')));
    CREATE TABLE public.delivery_dispatches (order_id uuid PRIMARY KEY REFERENCES public.orders(id), external_order_id text NOT NULL,
      status text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0);
    -- stand-in for Migration 03 orders_parcel_accept_gate: leaving 'received' needs the parcel found / cancelled
    CREATE FUNCTION public.fixture_parcel_gate() RETURNS trigger LANGUAGE plpgsql AS $f$
    BEGIN
      IF OLD.status = 'received' AND NEW.status NOT IN ('received', 'cancelled') AND NOT NEW.parcel_ready THEN
        RAISE EXCEPTION 'parcel_not_ready' USING ERRCODE = 'P0001';
      END IF;
      RETURN NEW;
    END $f$;
    CREATE TRIGGER orders_parcel_accept_gate BEFORE UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION public.fixture_parcel_gate();
    ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY; ALTER TABLE public.delivery_dispatches ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON public.orders, public.branches, public.delivery_dispatches FROM PUBLIC, anon, authenticated;
    GRANT SELECT, UPDATE ON public.orders TO service_role;
    GRANT SELECT, INSERT, UPDATE ON public.delivery_dispatches TO service_role;
    INSERT INTO public.branches VALUES ('${B1}', 'mishor');
    INSERT INTO public.orders (id, branch_id, type) SELECT ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, '${B1}',
      CASE WHEN g % 10 = 0 THEN 'pickup' ELSE 'delivery' END FROM generate_series(1, 80) g;
    UPDATE public.orders SET status = 'confirmed' WHERE id IN ('${oid(70)}', '${oid(71)}');           -- confirmed BEFORE install
    INSERT INTO public.delivery_dispatches (order_id, external_order_id) VALUES ('${oid(75)}', '${oid(75)}');`)
  const unrelated = 'SELECT string_agg(d::text, \',\' ORDER BY d.order_id) FROM public.delivery_dispatches d'
  const dispatchBefore = fingerprint(unrelated)

  await test('P1. preflight: every row PASS before the install (INFO rows: triggers, in-flight confirmed deliveries, version)', () => {
    const r = rows(read('s4_05_production_preflight.sql')); allPass(r, 'preflight'); assert.equal(r.length, 11)
    assert.equal(r.find(x => x[0] === '10')[3], '1')                       // 71 (delivery); 70 is a pickup order
  })
  await test('P2. install + verify: every row PASS; config starts OFF; nothing enqueued for orders confirmed before install', () => {
    psql(read('s4_05_maale_auto_dispatch_queue.sql'))
    const v = rows(read('s4_05_verify.sql')); allPass(v, 'verify'); assert.equal(v.length, 16)
    assert.equal(v.find(x => x[0] === '09')[3], 'enqueue_enabled=false')
    assert.equal(tasks(), 0)
  })
  await test('P3. re-install is refused (no silent re-apply); preflight now FAILs rows 05 / 06', () => {
    assert.match(psql(read('s4_05_maale_auto_dispatch_queue.sql'), { expectError: true }), /already exist/)
    const fails = rows(read('s4_05_production_preflight.sql')).filter(x => x[2] === 'FAIL').map(x => x[0]); assert.deepEqual(fails, ['05', '06'])
  })

  await test('Q1. switch OFF (default): a delivery confirmation commits and creates NO task', () => {
    confirm(oid(1)); assert.equal(ostatus(oid(1)), 'confirmed'); assert.equal(tasks(), 0)
  })
  await test('Q2. switch ON: received → confirmed (delivery) creates exactly one queued task with the branch, in the same transaction', () => {
    enable(true); confirm(oid(2))
    assert.equal(task(oid(2)), 'queued/0/-'); assert.equal(psql(`SELECT branch_id FROM public.maale_auto_dispatch_queue WHERE order_id = '${oid(2)}';`), B1)
    // inside one transaction: rolled-back confirmation → no task
    psql(`BEGIN; SET LOCAL ROLE service_role; UPDATE public.orders SET status = 'confirmed' WHERE id = '${oid(3)}'; ROLLBACK;`)
    assert.equal(ostatus(oid(3)), 'received'); assert.equal(task(oid(3)), '')
  })
  await test('Q3. only received → confirmed of a DELIVERY: pickup, later transitions, cancellation and no-op updates create nothing', () => {
    const before = tasks()
    confirm(oid(10))                                                                                       // pickup
    psql(`UPDATE public.orders SET status = 'preparing' WHERE id = '${oid(2)}';`, { role: 'service_role' })   // later step
    psql(`UPDATE public.orders SET status = 'cancelled' WHERE id = '${oid(4)}';`, { role: 'service_role' })   // cancel from received
    psql(`UPDATE public.orders SET payment_method = 'cash' WHERE id = '${oid(5)}';`)                          // non-status update
    psql(`UPDATE public.orders SET status = 'confirmed' WHERE id = '${oid(70)}';`)                            // confirmed → confirmed
    assert.equal(tasks(), before)
  })
  await test('Q4. parcel gate still decides first: parcel_not_ready aborts the confirmation and no task exists', () => {
    psql(`UPDATE public.orders SET parcel_ready = false WHERE id = '${oid(6)}';`)
    assert.match(confirm(oid(6), { expectError: true }), /parcel_not_ready/)
    assert.equal(ostatus(oid(6)), 'received'); assert.equal(task(oid(6)), '')
    psql(`UPDATE public.orders SET parcel_ready = true WHERE id = '${oid(6)}';`); confirm(oid(6)); assert.equal(task(oid(6)), 'queued/0/-')
  })
  await test('Q5. S4-MAALE-02: when the task cannot be written, the confirmation STILL commits (no reconfirmation); the repair covers it (E2–E5)', () => {
    psql('ALTER TABLE public.maale_auto_dispatch_queue ADD CONSTRAINT fixture_block CHECK (false) NOT VALID;')
    confirm(oid(7))
    assert.equal(ostatus(oid(7)), 'confirmed'); assert.equal(task(oid(7)), '')
    psql('ALTER TABLE public.maale_auto_dispatch_queue DROP CONSTRAINT fixture_block;')
    psql(`UPDATE public.orders SET status = 'received' WHERE id = '${oid(7)}';`); confirm(oid(7)); assert.equal(task(oid(7)), 'queued/0/-')
  })
  await test('Q6. idempotent: a second confirmation of the same order (back to received by the owner) never duplicates the task', () => {
    psql(`UPDATE public.orders SET status = 'received' WHERE id = '${oid(7)}';`); confirm(oid(7))
    assert.equal(Number(psql(`SELECT count(*) FROM public.maale_auto_dispatch_queue WHERE order_id = '${oid(7)}';`)), 1)
  })
  await test('Q7. 8 concurrent confirmations of different orders → 8 tasks; 8 concurrent confirmations of ONE order → 1 task', async () => {
    const ids = [11, 12, 13, 14, 15, 16, 17, 18].map(oid)
    await Promise.all(ids.map(o => psqlAsync(`UPDATE public.orders SET status = 'confirmed' WHERE id = '${o}' AND status = 'received';`, 'service_role')))
    for (const o of ids) assert.equal(task(o), 'queued/0/-')
    const r = await Promise.all(Array.from({ length: 8 }, () => psqlAsync(`UPDATE public.orders SET status = 'confirmed' WHERE id = '${oid(19)}' AND status = 'received';`, 'service_role')))
    assert.ok(r.every(x => x.code === 0)); assert.equal(Number(psql(`SELECT count(*) FROM public.maale_auto_dispatch_queue WHERE order_id = '${oid(19)}';`)), 1)
  })

  const claimSql = (o, attempts) => `UPDATE public.maale_auto_dispatch_queue SET state = 'processing', attempts = ${attempts + 1}, claimed_at = clock_timestamp(), updated_at = now()
    WHERE order_id = '${o}' AND state = 'queued' AND attempts = ${attempts} RETURNING order_id;`
  await test('G1. claim is a compare-and-set: 8 parallel workers → exactly ONE claims the task (attempts 0 → 1)', async () => {
    const r = await Promise.all(Array.from({ length: 8 }, () => psqlAsync(claimSql(oid(11), 0), 'service_role')))
    assert.equal(r.filter(x => x.code === 0 && x.out.includes(oid(11))).length, 1); assert.equal(task(oid(11)), 'processing/1/-')
  })
  await test('G2. guard: closed transition table, final states, attempts only +1 on a claim, identity immutable', () => {
    const upd = (o, set) => as(`UPDATE public.maale_auto_dispatch_queue SET ${set} WHERE order_id = '${o}';`)
    assert.match(upd(oid(12), "state = 'dispatched'"), /auto_dispatch_invalid_transition/)                    // queued → dispatched
    assert.match(upd(oid(12), "state = 'manual'"), /auto_dispatch_invalid_transition/)                        // queued → manual
    assert.match(upd(oid(12), "state = 'processing', attempts = 3, claimed_at = now()"), /auto_dispatch_invalid_claim/)
    assert.match(upd(oid(12), "state = 'processing', attempts = 1"), /auto_dispatch_invalid_claim/)           // no claimed_at
    assert.match(upd(oid(12), 'attempts = 1'), /auto_dispatch_invalid_transition/)                         // queued → queued
    assert.match(upd(oid(11), "state = 'dispatched', attempts = 5"), /auto_dispatch_invalid_attempts/)        // finish must keep the count
    assert.match(upd(oid(11), "state = 'processing', attempts = 2, claimed_at = clock_timestamp()"), /auto_dispatch_claim_not_stale/)
    psql(`UPDATE public.maale_auto_dispatch_queue SET state = 'dispatched' WHERE order_id = '${oid(11)}';`, { role: 'service_role' })
    assert.match(psql(`SELECT finished_at IS NOT NULL FROM public.maale_auto_dispatch_queue WHERE order_id = '${oid(11)}';`), /t/)
    for (const s of ["state = 'queued'", "state = 'processing', attempts = 2, claimed_at = now()", "reason_code = 'x'"])
      assert.match(upd(oid(11), s), /auto_dispatch_task_final/)
    assert.match(psql(`UPDATE public.maale_auto_dispatch_queue SET enqueued_at = now() WHERE order_id = '${oid(12)}';`, { expectError: true }), /auto_dispatch_identity_immutable/)
    assert.match(upd(oid(12), "state = 'skipped', reason_code = 'Bad Reason'"), /reason_format/)             // valid transition, bad code
  })
  await test('G3. processing → queued (transient, nothing sent) keeps attempts; a stale processing task can be re-claimed', () => {
    psql(claimSql(oid(13), 0), { role: 'service_role' })
    psql(`UPDATE public.maale_auto_dispatch_queue SET state = 'queued', reason_code = 'quote_unavailable' WHERE order_id = '${oid(13)}';`, { role: 'service_role' })
    assert.equal(task(oid(13)), 'queued/1/quote_unavailable')
    psql(claimSql(oid(14), 0), { role: 'service_role' })
    psql(`ALTER TABLE public.maale_auto_dispatch_queue DISABLE TRIGGER maale_auto_dispatch_queue_guard;
          UPDATE public.maale_auto_dispatch_queue SET claimed_at = now() - interval '3 minutes' WHERE order_id = '${oid(14)}';
          ALTER TABLE public.maale_auto_dispatch_queue ENABLE TRIGGER maale_auto_dispatch_queue_guard;`)
    psql(`UPDATE public.maale_auto_dispatch_queue SET state = 'processing', attempts = 2, claimed_at = clock_timestamp() WHERE order_id = '${oid(14)}' AND state = 'processing';`, { role: 'service_role' })
    assert.equal(task(oid(14)), 'processing/2/-')
    for (const s of ['investigate', 'manual', 'skipped']) {
      const o = oid(15 + ['investigate', 'manual', 'skipped'].indexOf(s)); psql(claimSql(o, 0), { role: 'service_role' })
      psql(`UPDATE public.maale_auto_dispatch_queue SET state = '${s}', reason_code = 'fixture' WHERE order_id = '${o}';`, { role: 'service_role' })
      assert.equal(task(o), `${s}/1/fixture`)
    }
    psql(`UPDATE public.maale_auto_dispatch_queue SET state = 'skipped', reason_code = 'stale' WHERE order_id = '${oid(18)}';`, { role: 'service_role' })   // queued → skipped
    assert.equal(task(oid(18)), 'skipped/0/stale')
  })
  await test('S1. privileges: anon / authenticated see nothing; service_role cannot INSERT, DELETE, touch identity or the switch', () => {
    for (const role of ['anon', 'authenticated']) {
      assert.match(as('SELECT * FROM public.maale_auto_dispatch_queue;', role), /permission denied/)
      assert.match(as('SELECT * FROM public.maale_auto_dispatch_config;', role), /permission denied/)
    }
    assert.match(as(`INSERT INTO public.maale_auto_dispatch_queue (order_id) VALUES ('${oid(20)}');`), /permission denied/)
    assert.match(as(`DELETE FROM public.maale_auto_dispatch_queue WHERE order_id = '${oid(12)}';`), /permission denied/)
    assert.match(as(`UPDATE public.maale_auto_dispatch_queue SET order_id = '${oid(20)}' WHERE order_id = '${oid(12)}';`), /permission denied/)
    assert.match(as('UPDATE public.maale_auto_dispatch_config SET enqueue_enabled = false;'), /permission denied/)
    assert.equal(psql('SELECT enqueue_enabled FROM public.maale_auto_dispatch_config;', { role: 'service_role' }), 't')
  })
  await test('S2. nothing else changed: delivery_dispatches untouched; orders FK RESTRICT protects task history', () => {
    assert.equal(fingerprint(unrelated), dispatchBefore)
    assert.match(psql(`DELETE FROM public.orders WHERE id = '${oid(2)}';`, { expectError: true }), /maale_auto_dispatch_queue_order_fk/)
  })
  /* ─── S4-MAALE-02: an enqueue failure never costs a confirmation; the repair re-creates the task ─── */
  const B2 = 'b2b2b2b2-0000-4000-8000-000000000002'
  const ordersFp = () => fingerprint('SELECT string_agg(o::text, \',\' ORDER BY o.id) FROM public.orders o')
  const newOrder = (n, { type = 'delivery', branch = B1, status = 'received' } = {}) =>
    psql(`INSERT INTO public.orders (id, branch_id, type, status, created_at) VALUES ('${oid(n)}', '${branch}', '${type}', '${status}', now());`)
  const repair = (scope = 'NULL', role = 'service_role') => psql(`SELECT public.enqueue_missing_maale_auto_dispatch(${scope});`, { role })
  const cfgRow = () => psql("SELECT enqueue_enabled || '/' || (enabled_at IS NOT NULL) FROM public.maale_auto_dispatch_config;")

  await test('E1. config guard: enabled_at set when turned on, NULL while off, kept on a repeated "on"; singleton immutable', () => {
    enable(false); assert.equal(cfgRow(), 'false/false')
    enable(true); assert.equal(cfgRow(), 'true/true')
    const at = psql('SELECT enabled_at FROM public.maale_auto_dispatch_config;')
    enable(true); assert.equal(psql('SELECT enabled_at FROM public.maale_auto_dispatch_config;'), at, 'a repeated "on" keeps the original moment')
    assert.match(psql('UPDATE public.maale_auto_dispatch_config SET singleton = false;', { expectError: true }), /singleton/)
  })
  await test('E2. enqueue failure (forced) → the kitchen confirmation STILL commits; no task; a code-only WARNING', () => {
    newOrder(81)
    psql('ALTER TABLE public.maale_auto_dispatch_queue ADD CONSTRAINT s4_05_test_force_fail CHECK (order_id IS NULL) NOT VALID;')
    const r = docker(['exec', '-i', NAME, 'psql', '-X', '-q', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At'],
      `SET ROLE service_role;\nUPDATE public.orders SET status = 'confirmed' WHERE id = '${oid(81)}' AND status = 'received';`)
    assert.equal(r.code, 0, r.err); assert.match(r.err, /maale_auto_dispatch_enqueue_failed sqlstate=23514/)
    assert.ok(!r.err.includes(oid(81)), 'the warning carries no order data')
    psql('ALTER TABLE public.maale_auto_dispatch_queue DROP CONSTRAINT s4_05_test_force_fail;')
    assert.equal(ostatus(oid(81)), 'confirmed'); assert.equal(task(oid(81)), '')
  })
  await test('E3. repair re-creates exactly that task (queued, reason repaired, enqueued_at = order created_at); idempotent', () => {
    assert.equal(repair(), '1')
    assert.equal(task(oid(81)), 'queued/0/repaired')
    assert.equal(psql(`SELECT q.enqueued_at = o.created_at FROM public.maale_auto_dispatch_queue q JOIN public.orders o ON o.id = q.order_id WHERE q.order_id = '${oid(81)}';`), 't')
    assert.equal(repair(), '0'); assert.equal(repair(), '0')
  })
  await test('E4. repair never reaches: orders created before the switch, a courier-owned order, pickup, received / ready, another branch, switch off', () => {
    psql(`INSERT INTO public.branches VALUES ('${B2}', 'other');`)
    // delivery orders confirmed earlier (before install / while off) — created before enabled_at
    assert.equal(task(oid(71)), ''); assert.equal(task(oid(1)), '')
    // courier already requested (delivery_dispatches row) — confirmed while off, then re-dated after enabled_at
    enable(false); psql(`UPDATE public.orders SET status = 'confirmed' WHERE id = '${oid(75)}';`); enable(true)
    psql(`UPDATE public.orders SET created_at = now() WHERE id = '${oid(75)}';`)
    newOrder(82, { type: 'pickup', status: 'confirmed' }); newOrder(83, { status: 'received' }); newOrder(84, { status: 'ready' })
    newOrder(85, { status: 'confirmed', branch: B2 })
    assert.equal(repair(`ARRAY['${B1}']::uuid[]`), '0', 'own branch: nothing eligible')
    for (const n of [71, 1, 75, 82, 83, 84, 85]) assert.equal(task(oid(n)), '', String(n))
    enable(false); assert.equal(repair(), '0', 'switch off → never')
    enable(true); assert.equal(repair(`ARRAY['${B2}']::uuid[]`), '0', 're-enabling moves enabled_at: the order (created before it) is no longer covered')
    psql(`UPDATE public.orders SET created_at = now() WHERE id = '${oid(85)}';`)
    assert.equal(repair(`ARRAY['${B1}']::uuid[]`), '0'); assert.equal(repair(`ARRAY['${B2}']::uuid[]`), '1'); assert.equal(task(oid(85)), 'queued/0/repaired')
    assert.equal(repair("ARRAY[]::uuid[]"), '0')
  })
  await test('E5. CONCURRENCY: 8 simultaneous repairs (sweeps / after()) over 5 missing tasks → exactly 5 tasks, no error', async () => {
    enable(false); for (const n of [86, 87, 88, 89, 90]) newOrder(n, { status: 'confirmed' }); enable(true)
    psql(`UPDATE public.orders SET created_at = now() WHERE id IN (${[86, 87, 88, 89, 90].map(n => `'${oid(n)}'`).join(',')});`)
    const before = tasks()
    const rs = await Promise.all(Array.from({ length: 8 }, () => psqlAsync('SELECT public.enqueue_missing_maale_auto_dispatch(NULL);', 'service_role')))
    for (const r of rs) assert.equal(r.code, 0, r.err)
    assert.equal(rs.reduce((n, r) => n + Number(r.out), 0), 5); assert.equal(tasks(), before + 5)
    for (const n of [86, 87, 88, 89, 90]) assert.equal(task(oid(n)), 'queued/0/repaired')
  })
  await test('E6. repair: service_role only; never changes an order or a delivery_dispatches row', () => {
    for (const role of ['anon', 'authenticated']) assert.match(as('SELECT public.enqueue_missing_maale_auto_dispatch(NULL);', role), /permission denied/)
    const o = ordersFp(); assert.equal(repair(), '0'); assert.equal(ordersFp(), o); assert.equal(fingerprint(unrelated), dispatchBefore)
  })

  await test('R1. rollback refuses without confirmation, while tasks are queued / processing, and without the export confirmation', () => {
    assert.match(psql(read('s4_05_rollback.sql'), { expectError: true }), /not confirmed/)
    assert.match(psql("SET s4_05.confirm_rollback = 'DROP-AUTO-DISPATCH-QUEUE';\n" + read('s4_05_rollback.sql'), { expectError: true }), /still queued \/ processing/)
    psql(`ALTER TABLE public.maale_auto_dispatch_queue DISABLE TRIGGER maale_auto_dispatch_queue_guard;
          UPDATE public.maale_auto_dispatch_queue SET state = 'skipped', finished_at = now() WHERE state IN ('queued', 'processing');
          ALTER TABLE public.maale_auto_dispatch_queue ENABLE TRIGGER maale_auto_dispatch_queue_guard;`)
    assert.match(psql("SET s4_05.confirm_rollback = 'DROP-AUTO-DISPATCH-QUEUE';\n" + read('s4_05_rollback.sql'), { expectError: true }), /export them/)
  })
  await test('R2. confirmed rollback removes every s4_05 object; confirmations keep working; orders / dispatch rows unchanged', () => {
    const ordersBefore = fingerprint('SELECT string_agg(o::text, \',\' ORDER BY o.id) FROM public.orders o')
    psql("SET s4_05.confirm_rollback = 'DROP-AUTO-DISPATCH-QUEUE';\nSET s4_05.confirm_history_exported = 'yes';\n" + read('s4_05_rollback.sql'))
    assert.equal(psql("SELECT count(*) FROM pg_class WHERE relname IN ('maale_auto_dispatch_queue', 'maale_auto_dispatch_config');"), '0')
    assert.equal(psql("SELECT count(*) FROM pg_proc WHERE proname IN ('orders_enqueue_maale_auto_dispatch', 'maale_auto_dispatch_queue_guard', 'enqueue_missing_maale_auto_dispatch', 'maale_auto_dispatch_config_guard');"), '0')
    assert.equal(psql("SELECT count(*) FROM pg_trigger WHERE tgname = 'orders_enqueue_maale_auto_dispatch';"), '0')
    assert.equal(fingerprint('SELECT string_agg(o::text, \',\' ORDER BY o.id) FROM public.orders o'), ordersBefore)
    assert.equal(fingerprint(unrelated), dispatchBefore)
    confirm(oid(30)); assert.equal(ostatus(oid(30)), 'confirmed')
    allPass(rows(read('s4_05_production_preflight.sql')), 'preflight after rollback')
    psql(read('s4_05_maale_auto_dispatch_queue.sql')); allPass(rows(read('s4_05_verify.sql')), 'verify after reinstall')
  })

  console.log(`\nAll ${passed} isolated PostgreSQL checks passed (container ${NAME}, network none).`)
} finally {
  docker(['rm', '-f', NAME])
}
