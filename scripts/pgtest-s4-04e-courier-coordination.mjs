// S4-INTEGRATIONS-04E1/04E2 — ISOLATED PostgreSQL test of the atomic courier coordination (db/migrations/s4_04e_*.sql)
// and of the version-aware combined verify (db/migrations/s4_04_combined_verify.sql).
//
// Disposable Docker container started here with `--network none` from the Supabase Postgres image (real anon /
// authenticated / service_role roles and default privileges). Never reads .env*, never connects to Supabase, removes the
// container at the end. Installs 04B → 04D → 04E in the planned Production order; historical dispatch rows (sent,
// failed, …) are created BEFORE 04E, as they exist in Production. Concurrency uses real parallel psql sessions.
//   node scripts/pgtest-s4-04e-courier-coordination.mjs            (needs Docker; not part of the verify-* suite)

import { spawn, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MIG = join(ROOT, 'db', 'migrations')
const read = f => readFileSync(join(MIG, f), 'utf8').replace(/\r\n/g, '\n')
const IMAGE = process.env.S4_04E_PG_IMAGE || 'public.ecr.aws/supabase/postgres:17.6.1.141'
const NAME = `s4-04e-pgtest-${process.pid}`
const TRIALS = 30

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
// A REAL session of an application role (session_user = role). SET ROLE alone is not enough for role-membership probes:
// PostgreSQL authorizes SET ROLE against the session user, so the image's superuser opens the session and hands it over.
function psqlSession(sql, role) {
  const r = docker(['exec', '-i', NAME, 'psql', '-X', '-q', '-U', 'supabase_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At'], `SET SESSION AUTHORIZATION ${role};
${sql}`)
  assert.notEqual(r.code, 0, `expected an error for ${role}, got: ${r.out}`)
  return r.err
}
const psqlAsync = (sql, role) => new Promise(res => {
  const p = spawn('docker', ['exec', '-i', NAME, 'psql', '-X', '-q', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At', '-F', '|'])
  let out = '', err = ''
  p.stdout.on('data', d => { out += d }); p.stderr.on('data', d => { err += d })
  p.on('close', code => res({ code, out: out.trim(), err: err.trim(), last: out.trim().split('\n').filter(Boolean).pop() ?? '' }))
  p.stdin.end((role ? `SET ROLE ${role};\n` : '') + sql)
})
const sleep = ms => new Promise(r => setTimeout(r, ms))
let passed = 0
const test = async (name, fn) => { await fn(); passed++; console.log('  ✓', name) }

const B1 = '8fed141d-0e7c-46c1-803b-88d3d811c1f8'
const oid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const lit = s => (s === null || s === undefined ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`)
const claimSql = (o, attempts = 0, last = null) => `SELECT public.claim_maale_dispatch(${lit(o)}::uuid, ${attempts}, ${last === null ? 'NULL' : `${lit(last)}::timestamptz`});`
const recSql = ({ rid = randomUUID(), order, event, actor = 'boss', pid = null, pst = null, reason = null }) =>
  `SELECT result || '|' || COALESCE(event_id::text, '-') FROM public.record_maale_reconciliation_event(${lit(rid)}::uuid, ${lit(order)}::uuid, ${lit(event)}, ${lit(actor)}, ${lit(pid)}, ${lit(pst)}, ${lit(reason)});`
const claim = (o, a, l) => psql(claimSql(o, a, l), { role: 'service_role' })
const rec = o => psql(recSql(o), { role: 'service_role' }).split('|')[0]
const recFull = o => psql(recSql(o), { role: 'service_role' }).split('|')
const dstate = o => psql(`SELECT status || '/' || attempts FROM public.delivery_dispatches WHERE order_id = '${o}';`)
const ledgerCount = (w = 'true') => Number(psql(`SELECT count(*) FROM public.maale_dispatch_reconciliations WHERE ${w};`))
const rows = sql => psql(sql).split('\n').filter(Boolean).map(l => l.split('|'))
const fingerprint = sql => psql(`SELECT md5(COALESCE((${sql}), ''));`)
const COMBINED = () => read('s4_04_combined_verify.sql')
const allPass = (r, label) => { for (const [id, name, res, detail] of r) assert.ok(res === 'PASS' || res === 'INFO', `${label} ${id} ${name}: ${res} ${detail}`) }
const stageOf = r => r.find(x => x[0] === '01')[3]
const failIds = r => r.filter(x => x[2] === 'FAIL').map(x => x[0])
// runs the combined verify inside a transaction after a drift setup, then rolls everything back
const combinedAfter = setup => psql(`BEGIN;\n${setup}\n${COMBINED()}\nROLLBACK;`).split('\n').filter(l => /^\d\d\|/.test(l)).map(l => l.split('|'))

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

  /* ─── Fixture shaped like Production: orders, branches, delivery_dispatches per db/schema baseline ─── */
  psql(`
    CREATE TABLE public.branches (id uuid PRIMARY KEY, name text NOT NULL);
    CREATE TABLE public.orders (id uuid PRIMARY KEY, branch_id uuid NOT NULL REFERENCES public.branches(id), status text NOT NULL, customer_name text, phone text);
    CREATE TABLE public.delivery_dispatches (
      id uuid NOT NULL DEFAULT gen_random_uuid(), order_id uuid NOT NULL, external_order_id text NOT NULL,
      provider text NOT NULL DEFAULT 'maale_express', status text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
      last_attempt_at timestamptz NULL, dispatched_at timestamptz NULL, error_code text NULL, provider_order_id text NULL, provider_status text NULL,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT delivery_dispatches_pkey PRIMARY KEY (id),
      CONSTRAINT delivery_dispatches_order_id_key UNIQUE (order_id),
      CONSTRAINT delivery_dispatches_external_order_id_key UNIQUE (external_order_id),
      CONSTRAINT delivery_dispatches_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders (id),
      CONSTRAINT delivery_dispatches_external_order_id_phase1_check CHECK (external_order_id = order_id::text),
      CONSTRAINT delivery_dispatches_provider_check CHECK (provider = 'maale_express'),
      CONSTRAINT delivery_dispatches_attempts_check CHECK (attempts >= 0 AND attempts <= 20),
      CONSTRAINT delivery_dispatches_status_check CHECK (status IN ('pending', 'sending', 'sent', 'failed_retryable', 'failed_final')),
      CONSTRAINT delivery_dispatches_error_code_format_check CHECK (error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,64}$'),
      CONSTRAINT delivery_dispatches_provider_status_format_check CHECK (provider_status IS NULL OR provider_status ~ '^[a-z_]{1,40}$'),
      CONSTRAINT delivery_dispatches_provider_order_id_length_check CHECK (provider_order_id IS NULL OR char_length(provider_order_id) BETWEEN 1 AND 100),
      CONSTRAINT delivery_dispatches_sending_has_attempt_at_check CHECK (status <> 'sending' OR last_attempt_at IS NOT NULL),
      CONSTRAINT delivery_dispatches_sent_has_dispatched_at_check CHECK (status <> 'sent' OR dispatched_at IS NOT NULL));
    ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY; ALTER TABLE public.delivery_dispatches ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON public.orders, public.branches FROM PUBLIC, anon, authenticated;
    REVOKE ALL ON public.delivery_dispatches FROM PUBLIC, anon, authenticated, service_role;
    GRANT SELECT, INSERT, UPDATE ON public.delivery_dispatches TO service_role;
    INSERT INTO public.branches VALUES ('${B1}', 'mishor');
    INSERT INTO public.orders SELECT ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, '${B1}', 'confirmed', 'fixture', '0500000000' FROM generate_series(1, 120) g;
    -- pending, never attempted: 1–60 and 90–100 (unrelated rows for the no-side-effect check)
    INSERT INTO public.delivery_dispatches (order_id, external_order_id) SELECT id, id::text FROM public.orders
      WHERE id IN (SELECT ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid FROM generate_series(1, 60) g UNION ALL
                   SELECT ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid FROM generate_series(90, 100) g)
        AND id NOT IN ('${oid(7)}');  -- order 7: no dispatch row at all
    -- historical states (created before 04E, as in Production)
    INSERT INTO public.delivery_dispatches (order_id, external_order_id, status, attempts, last_attempt_at, error_code, provider_order_id, provider_status, dispatched_at) VALUES
      ('${oid(61)}', '${oid(61)}', 'pending', 2, now() - interval '1 day', NULL, NULL, NULL, NULL),
      ('${oid(62)}', '${oid(62)}', 'failed_retryable', 1, now() - interval '1 hour', 'timeout', NULL, NULL, NULL),
      ('${oid(63)}', '${oid(63)}', 'failed_final', 1, now() - interval '1 hour', 'out_of_area', NULL, NULL, NULL),
      ('${oid(64)}', '${oid(64)}', 'failed_final', 1, now() - interval '1 hour', 'unexpected_quote_response', NULL, NULL, NULL),
      ('${oid(65)}', '${oid(65)}', 'failed_final', 1, now() - interval '1 hour', 'idempotency_mismatch', NULL, NULL, NULL),
      ('${oid(66)}', '${oid(66)}', 'sending', 1, now(), NULL, NULL, NULL, NULL),
      ('${oid(67)}', '${oid(67)}', 'sent', 1, now() - interval '1 day', NULL, '284', 'searching', now() - interval '1 day');`)
  const unrelated = `SELECT string_agg(d::text, ',' ORDER BY d.order_id) FROM public.delivery_dispatches d WHERE d.order_id >= '${oid(90)}' AND d.order_id <= '${oid(100)}'`
  const unrelatedBefore = fingerprint(unrelated)
  const sentBefore = psql(`SELECT md5(d::text) FROM public.delivery_dispatches d WHERE order_id = '${oid(67)}';`)

  psql(read('s4_04b_maale_quote_rate_limit.sql'))

  await test('C0. combined verify with only 04B installed → row 01 FAILs (stage incomplete) — never a silent PASS', () => {
    const r = rows(COMBINED()); assert.equal(stageOf(r), 'incomplete'); assert.ok(failIds(r).includes('01'))
  })

  await test('T10a. missing dependency: without 04D the preflight FAILs and the migration aborts (nothing created)', () => {
    const pre = rows(read('s4_04e_production_preflight.sql'))
    assert.equal(pre.find(r => r[0] === '02')[2], 'FAIL')
    assert.match(psql(read('s4_04e_courier_coordination.sql'), { expectError: true }), /S4-04D .* is not installed/)
    assert.equal(psql("SELECT count(*) FROM pg_proc WHERE proname IN ('claim_maale_dispatch','record_maale_reconciliation_event');"), '0')
  })

  psql(read('s4_04d_maale_dispatch_reconciliations.sql'))

  await test('P1. read-only preflight: every row PASS / INFO once 04B + 04D are installed', () => {
    const r = rows(read('s4_04e_production_preflight.sql'))
    assert.equal(r.length, 12)
    for (const [id, name, res, detail] of r) assert.ok(res === 'PASS' || res === 'INFO', `${id} ${name}: ${res} ${detail}`)
  })

  await test('C1. combined verify BEFORE 04E: stage pre_04e, every row PASS (original 04D privileges expected)', () => {
    const r = rows(COMBINED()); assert.equal(r.length, 20); assert.equal(stageOf(r), 'pre_04e'); allPass(r, 'pre-04E combined')
  })

  await test('M1. 04E installs in one transaction (preflight, functions, guard trigger, revoke, post-check)', () => { psql(read('s4_04e_courier_coordination.sql')) })

  await test('M2. re-running 04E aborts in its preflight (no silent re-apply)', () => {
    assert.match(psql(read('s4_04e_courier_coordination.sql'), { expectError: true }), /already exist \(no silent re-apply\)/)
  })

  await test('V1. read-only verify: every row PASS / INFO (signatures, INVOKER / DEFINER, settings, owner, ACLs, bodies, trigger)', () => {
    for (const [id, name, res, detail] of rows(read('s4_04e_verify.sql'))) assert.ok(res === 'PASS' || res === 'INFO', `${id} ${name}: ${res} ${detail}`)
  })

  await test('T1. manual_courier first → the dispatch claim is refused; the row stays pending/0', () => {
    assert.equal(rec({ order: oid(1), event: 'manual_courier', reason: 'courier_booked_by_phone' }), 'recorded')
    assert.equal(claim(oid(1)), 'manual_courier_recorded'); assert.equal(dstate(oid(1)), 'pending/0')
  })

  await test('T2. dispatch claim first → an ordinary manual_courier is refused (dispatch_active); no ledger row', () => {
    assert.equal(claim(oid(2)), 'claimed'); assert.equal(dstate(oid(2)), 'sending/1')
    assert.equal(rec({ order: oid(2), event: 'manual_courier' }), 'dispatch_active'); assert.equal(ledgerCount(`order_id = '${oid(2)}'`), 0)
    assert.equal(claim(oid(2), 1, null), 'not_claimable', 'a sending row is never re-claimed')
  })

  await test('T4. 8 simultaneous claims on one pending row (real sessions) → exactly one winner', async () => {
    const holder = psqlAsync('SELECT pg_advisory_lock(4206, 3); SELECT pg_sleep(2); SELECT pg_advisory_unlock(4206, 3);')
    await sleep(700)
    const rs = await Promise.all(Array.from({ length: 8 }, () => psqlAsync(`BEGIN; SELECT pg_advisory_xact_lock_shared(4206, 3); ${claimSql(oid(3))} COMMIT;`, 'service_role')))
    await holder
    // The only acceptable failure is the designed fail-closed lock timeout (writes nothing).
    const failed = rs.filter(r => r.code !== 0)
    assert.ok(failed.every(r => /lock timeout/.test(r.err)), failed.map(r => r.err).join(' | '))
    const codes = rs.filter(r => r.code === 0).map(r => r.last)
    assert.ok(codes.every(c => ['claimed', 'not_claimable', 'claim_lost'].includes(c)), codes.join(','))
    const won = codes.filter(c => c === 'claimed').length
    assert.ok(won <= 1, `more than one winner: ${codes.join(',')}`)
    assert.equal(dstate(oid(3)), won === 1 ? 'sending/1' : 'pending/0')
    if (won === 0) assert.ok(failed.length > 0, 'no winner only possible if sessions timed out')
    if (failed.length) console.log(`      (${failed.length} session(s) failed closed with lock timeout under load)`)
  })

  await test(`T3. ${TRIALS} REAL concurrency trials (3 claims + 3 manual couriers released together per order) → never both`, async () => {
    const stats = { claim: 0, manual: 0, none: 0, timeouts: 0 }
    const PER_BATCH = 5
    for (let batch = 0; batch < TRIALS / PER_BATCH; batch++) {
      const key = 100 + batch
      const holder = psqlAsync(`SELECT pg_advisory_lock(4207, ${key}); SELECT pg_sleep(3); SELECT pg_advisory_unlock(4207, ${key});`)
      await sleep(900)
      const trials = Array.from({ length: PER_BATCH }, (_, i) => oid(31 + batch * PER_BATCH + i))
      const work = trials.map(o => [
        ...Array.from({ length: 3 }, () => psqlAsync(`BEGIN; SELECT pg_advisory_xact_lock_shared(4207, ${key}); ${claimSql(o)} COMMIT;`, 'service_role')),
        ...Array.from({ length: 3 }, () => psqlAsync(`BEGIN; SELECT pg_advisory_xact_lock_shared(4207, ${key}); ${recSql({ order: o, event: 'manual_courier' })} COMMIT;`, 'service_role')),
      ])
      const results = await Promise.all(work.map(w => Promise.all(w))); await holder
      for (let i = 0; i < trials.length; i++) {
        const o = trials[i], rs = results[i]
        // The only acceptable failure is the designed fail-closed lock timeout (it writes nothing).
        const failed = rs.filter(r => r.code !== 0)
        assert.ok(failed.every(r => /lock timeout/.test(r.err)), `${o}: ` + failed.map(r => r.err).join(' | '))
        stats.timeouts += failed.length
        // Inspect the FINAL committed state of this order after the trial.
        const [status, manual] = psql(`SELECT d.status || '|' || (SELECT count(*) FROM public.maale_dispatch_reconciliations r WHERE r.order_id = d.order_id AND r.event_type = 'manual_courier') FROM public.delivery_dispatches d WHERE d.order_id = '${o}';`).split('|')
        const both = ['sending', 'sent'].includes(status) && Number(manual) > 0
        assert.ok(!both, `INVARIANT VIOLATED for ${o}: dispatch ${status} AND ${manual} manual_courier`)
        // committed results must match the final state exactly
        const ok = rs.filter(r => r.code === 0).map(r => r.last.split('|')[0])
        const claims = ok.filter(c => c === 'claimed').length, recorded = ok.filter(c => c === 'recorded').length
        assert.ok(claims <= 1, `${o}: ${claims} claims`)
        assert.equal(status, claims === 1 ? 'sending' : 'pending', `${o}: claims=${claims} status=${status}`)
        assert.equal(Number(manual), recorded, `${o}: ${recorded} recorded vs ${manual} stored`)
        if (claims === 1) { stats.claim++; assert.equal(recorded, 0) } else if (recorded > 0) stats.manual++
        else { stats.none++; assert.ok(failed.length > 0, `${o}: nobody won without a timeout`) }
      }
    }
    assert.equal(stats.claim + stats.manual + stats.none, TRIALS)
    console.log(`      (winners: claim first in ${stats.claim}, manual courier first in ${stats.manual}, none ${stats.none}; ${stats.timeouts} fail-closed lock timeouts)`)
  })

  await test('T5. request_id: identical retry → the original row; different payload → conflict; 10 concurrent identical → one row', async () => {
    const rid = randomUUID()
    const first = recFull({ rid, order: oid(8), event: 'manual_review_opened', reason: 'outcome_unknown' })
    assert.equal(first[0], 'recorded')
    assert.deepEqual(recFull({ rid, order: oid(8), event: 'manual_review_opened', reason: 'outcome_unknown' }), ['already_recorded', first[1]])
    for (const o of [{ order: oid(8), event: 'manual_review_opened', reason: 'other' }, { order: oid(9), event: 'manual_review_opened', reason: 'outcome_unknown' },
      { order: oid(8), event: 'manual_review_opened', reason: 'outcome_unknown', actor: 'mishor' }])
      assert.equal(rec({ rid, ...o }), 'request_id_conflict', JSON.stringify(o))
    const rid2 = randomUUID()
    const holder = psqlAsync('SELECT pg_advisory_lock(4208, 1); SELECT pg_sleep(2); SELECT pg_advisory_unlock(4208, 1);')
    await sleep(700)
    const rs = await Promise.all(Array.from({ length: 10 }, () => psqlAsync(`BEGIN; SELECT pg_advisory_xact_lock_shared(4208, 1); ${recSql({ rid: rid2, order: oid(10), event: 'manual_courier' })} COMMIT;`, 'service_role')))
    await holder
    const failed = rs.filter(r => r.code !== 0)
    assert.ok(failed.every(r => /lock timeout/.test(r.err)), failed.map(r => r.err).join(' | '))
    const codes = rs.filter(r => r.code === 0).map(r => r.last.split('|')[0])
    const recorded = codes.filter(c => c === 'recorded').length
    assert.ok(codes.every(c => c === 'recorded' || c === 'already_recorded'), codes.join(','))
    assert.ok(recorded <= 1, codes.join(','))
    assert.equal(ledgerCount(`request_id = '${rid2}'`), recorded === 1 ? 1 : (codes.length ? 1 : 0), 'exactly one stored row for the key')
    assert.ok(recorded === 1 || failed.length > 0)
  })

  await test('T6. lock timeout (3s) while another session holds the order lock → both functions raise; nothing written', async () => {
    const o = oid(4)
    const holder = psqlAsync(`SELECT pg_advisory_lock(1296122189, hashtext('${o}')); SELECT pg_sleep(5); SELECT pg_advisory_unlock(1296122189, hashtext('${o}'));`)
    await sleep(700)
    const [c, m] = await Promise.all([psqlAsync(claimSql(o), 'service_role'), psqlAsync(recSql({ order: o, event: 'manual_courier' }), 'service_role')])
    await holder
    for (const r of [c, m]) { assert.notEqual(r.code, 0); assert.match(r.err, /lock timeout/) }
    assert.equal(dstate(o), 'pending/0'); assert.equal(ledgerCount(`order_id = '${o}'`), 0)
  })

  await test('T7. a rolled-back claim leaves the row pending; a manual courier is then allowed and blocks later claims', () => {
    const o = oid(5)
    assert.equal(psql(`BEGIN; SET LOCAL ROLE service_role; ${claimSql(o)} ROLLBACK;`), 'claimed')
    assert.equal(dstate(o), 'pending/0')
    assert.equal(rec({ order: o, event: 'manual_courier' }), 'recorded')
    assert.equal(claim(o), 'manual_courier_recorded')
  })

  await test('T8. unknown / unresolved provider outcomes block BOTH a re-claim and an ordinary manual courier', () => {
    for (const n of [62, 64, 65, 61]) { // failed_retryable timeout, failed_final unexpected_quote_response, idempotency_mismatch, pending with history
      assert.equal(claim(oid(n), n === 61 ? 2 : 1, null), 'not_claimable', String(n))
      assert.equal(rec({ order: oid(n), event: 'manual_courier' }), 'dispatch_outcome_unknown', String(n))
    }
    assert.equal(claim(oid(66), 1, null), 'not_claimable'); assert.equal(rec({ order: oid(66), event: 'manual_courier' }), 'dispatch_active')
    // definitive provider rejection: no courier exists → a manual courier is an ordinary booking; the row stays final
    assert.equal(claim(oid(63), 1, null), 'not_claimable'); assert.equal(rec({ order: oid(63), event: 'manual_courier' }), 'recorded')
    assert.equal(ledgerCount(`order_id IN ('${oid(62)}','${oid(64)}','${oid(65)}','${oid(61)}','${oid(66)}') AND event_type = 'manual_courier'`), 0)
  })

  await test('T9. historical sent dispatch: cancellation is recorded but never re-authorizes; the sent row stays immutable', () => {
    const o = oid(67)
    assert.equal(rec({ order: o, event: 'confirmed_sent', pid: '284', reason: 'provider_phone_confirmed' }), 'recorded')
    assert.equal(rec({ order: o, event: 'cancelled_at_provider', pid: '284', reason: 'kitchen_cancelled' }), 'recorded')
    assert.equal(rec({ order: o, event: 'cancelled_at_provider', pid: '999' }), 'provider_order_mismatch')
    assert.equal(claim(o, 1, null), 'not_claimable', 'cancellation never unlocks')
    assert.equal(rec({ order: o, event: 'manual_courier' }), 'dispatch_active', 'not recorded as a conflict-free booking')
    for (const role of ['service_role', undefined]) // even the owner cannot rewrite a sent row
      assert.match(psql(`UPDATE public.delivery_dispatches SET status = 'failed_final' WHERE order_id = '${o}';`, { role, expectError: true }), /a sent dispatch is immutable/)
    assert.equal(psql(`SELECT md5(d::text) FROM public.delivery_dispatches d WHERE order_id = '${o}';`), sentBefore)
  })

  await test('S1. review open blocks the claim; resolved → the claim proceeds; ledger-only order (no dispatch row) is coordinated too', () => {
    assert.equal(rec({ order: oid(6), event: 'manual_review_opened', reason: 'outcome_unknown' }), 'recorded')
    assert.equal(claim(oid(6)), 'manual_review_open')
    assert.equal(rec({ order: oid(6), event: 'manual_review_resolved' }), 'recorded')
    assert.equal(claim(oid(6)), 'claimed')
    assert.equal(claim(oid(7)), 'dispatch_row_missing')
    assert.equal(rec({ order: oid(7), event: 'manual_courier', reason: 'courier_booked_by_phone' }), 'recorded')
    assert.equal(claim(oid(7)), 'manual_courier_recorded', 'checked before the row lookup')
    assert.equal(rec({ order: oid(7), event: 'confirmed_sent', pid: 'MX-1' }), 'no_dispatch_record')
    assert.equal(rec({ order: oid(11), event: 'confirmed_sent', pid: 'MX-1' }), 'no_dispatch_attempt')
    assert.equal(claim(oid(12), 1, null), 'claim_lost', 'stale CAS view'); assert.equal(dstate(oid(12)), 'pending/0')
  })

  await test('S2. input validation: invalid values (incl. injection as data) → invalid_request / order_not_found; nothing written', () => {
    const n = ledgerCount()
    for (const o of [{ event: 'auto_cancelled' }, { event: 'manual_courier', actor: "x'); DROP TABLE public.orders; --" }, { event: 'manual_courier', pid: '1' },
      { event: 'confirmed_sent' }, { event: 'provider_status_checked', pid: 'MX-1' }, { event: 'manual_review_opened', pst: 'searching' }, { event: 'manual_courier', reason: 'free text' }])
      assert.equal(rec({ order: oid(13), ...o }), 'invalid_request', JSON.stringify(o))
    assert.equal(rec({ order: '11111111-1111-4111-8111-111111111111', event: 'manual_courier' }), 'order_not_found')
    assert.equal(psql(`SELECT public.claim_maale_dispatch(NULL, 0, NULL);`, { role: 'service_role' }), 'invalid_request')
    assert.equal(ledgerCount(), n); assert.equal(psql("SELECT to_regclass('public.orders') IS NOT NULL;"), 't')
  })

  await test('T11. privileges: no EXECUTE for anon / authenticated; service_role cannot INSERT the ledger or claim by direct UPDATE', () => {
    for (const role of ['anon', 'authenticated']) {
      assert.match(psql(claimSql(oid(14)), { role, expectError: true }), /permission denied for function claim_maale_dispatch/)
      assert.match(psql(recSql({ order: oid(14), event: 'manual_courier' }), { role, expectError: true }), /permission denied for function record_maale_reconciliation_event/)
    }
    assert.match(psql(`INSERT INTO public.maale_dispatch_reconciliations (request_id, order_id, event_type, actor_username) VALUES (gen_random_uuid(), '${oid(14)}', 'manual_courier', 'boss');`,
      { role: 'service_role', expectError: true }), /permission denied/)
    assert.match(psql(`UPDATE public.delivery_dispatches SET status = 'sending', attempts = 1, last_attempt_at = now() WHERE order_id = '${oid(14)}';`,
      { role: 'service_role', expectError: true }), /a claim must go through public.claim_maale_dispatch/)
    assert.match(psql(`INSERT INTO public.delivery_dispatches (order_id, external_order_id, status, attempts, last_attempt_at) VALUES ('${oid(110)}', '${oid(110)}', 'sending', 1, now());`,
      { role: 'service_role', expectError: true }), /new dispatch rows must be pending/)
    assert.equal(psql(`SELECT has_table_privilege('service_role','public.maale_dispatch_reconciliations','INSERT')::text || has_table_privilege('service_role','public.maale_dispatch_reconciliations','SELECT')::text;`), 'falsetrue')
    // markSent / markFailed paths (sending → sent / failed) still work for service_role
    assert.equal(claim(oid(15)), 'claimed')
    psql(`UPDATE public.delivery_dispatches SET status = 'sent', dispatched_at = now(), provider_order_id = 'MX-15' WHERE order_id = '${oid(15)}' AND status = 'sending';`, { role: 'service_role' })
    assert.equal(dstate(oid(15)), 'sent/1')
    assert.equal(psql("SELECT string_agg(r.rolname, ',' ORDER BY p.proname) FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner WHERE p.proname IN ('claim_maale_dispatch', 'record_maale_reconciliation_event');"),
      'maale_dispatch_coordinator,maale_dispatch_coordinator')
    assert.equal(dstate(oid(14)), 'pending/0')
  })

  await test('T11b. the old GUC marker grants nothing; service_role cannot become / grant / re-own the coordinator', () => {
    // 04E1's writable transaction setting is gone: setting it changes nothing (it was never a security boundary).
    assert.match(psql(`BEGIN; SELECT set_config('falafel.maale_coordinated_claim', 'on', true);
      UPDATE public.delivery_dispatches SET status = 'sending', attempts = 1, last_attempt_at = now() WHERE order_id = '${oid(16)}'; ROLLBACK;`,
      { role: 'service_role', expectError: true }), /a claim must go through public.claim_maale_dispatch/)
    // real application-role sessions (session_user = the role)
    for (const role of ['service_role', 'anon', 'authenticated'])
      assert.match(psqlSession('SET ROLE maale_dispatch_coordinator;', role), /permission denied to set role/, role)
    assert.match(psqlSession('GRANT maale_dispatch_coordinator TO service_role;', 'service_role'), /permission denied|admin option|reserved role/)
    assert.match(psqlSession('CREATE ROLE s4_probe NOLOGIN;', 'service_role'), /permission denied/)
    assert.match(psqlSession('ALTER FUNCTION public.claim_maale_dispatch(uuid, integer, timestamptz) OWNER TO service_role;', 'service_role'), /must be owner/)
    assert.match(psqlSession(`CREATE OR REPLACE FUNCTION public.claim_maale_dispatch(p_order_id uuid, p_seen_attempts integer, p_seen_last_attempt_at timestamptz)
      RETURNS text LANGUAGE sql AS $$ SELECT 'claimed' $$;`, 'service_role'), /must be owner|permission denied/)
    assert.match(psqlSession('ALTER TABLE public.delivery_dispatches DISABLE TRIGGER delivery_dispatches_coordination_guard;', 'service_role'), /must be owner/)
    assert.match(psqlSession(`UPDATE public.delivery_dispatches SET status = 'sending', attempts = 1, last_attempt_at = now() WHERE order_id = '${oid(16)}';`, 'service_role'),
      /a claim must go through public.claim_maale_dispatch/)
    assert.match(psqlSession(`INSERT INTO public.maale_dispatch_reconciliations (request_id, order_id, event_type, actor_username) VALUES (gen_random_uuid(), '${oid(16)}', 'manual_courier', 'boss');`, 'service_role'),
      /permission denied/)
    assert.equal(dstate(oid(16)), 'pending/0')
  })

  await test('T11d. 04E3 least privilege: even AS the coordinator — no customer data, no other dispatch / ledger columns, nothing else in the DB', () => {
    const asCoord = sql => psql(`BEGIN; SET LOCAL ROLE maale_dispatch_coordinator; ${sql} ROLLBACK;`, { expectError: true })
    for (const sql of ['SELECT phone FROM public.orders LIMIT 1;', 'SELECT customer_name FROM public.orders LIMIT 1;', 'SELECT * FROM public.orders LIMIT 1;',
      'SELECT name FROM public.branches LIMIT 1;', 'SELECT dispatched_at FROM public.delivery_dispatches LIMIT 1;',
      `UPDATE public.delivery_dispatches SET provider_order_id = 'X' WHERE order_id = '${oid(18)}';`,
      `UPDATE public.delivery_dispatches SET dispatched_at = now() WHERE order_id = '${oid(18)}';`,
      `INSERT INTO public.maale_dispatch_reconciliations (id, request_id, order_id, event_type, actor_username) VALUES (gen_random_uuid(), gen_random_uuid(), '${oid(18)}', 'manual_review_opened', 'boss');`,
      `INSERT INTO public.maale_dispatch_reconciliations (request_id, order_id, event_type, actor_username, created_at) VALUES (gen_random_uuid(), '${oid(18)}', 'manual_review_opened', 'boss', now() - interval '1 day');`,
      'DELETE FROM public.maale_dispatch_reconciliations;', 'SELECT count(*) FROM public.maale_dispatch_requests;', 'CREATE TABLE public.s4_probe (x int);'])
      assert.match(asCoord(sql), /permission denied/, sql)
    // the reviewed columns still suffice (the full suite above exercised both functions after this change)
    assert.equal(psql(`BEGIN; SET LOCAL ROLE maale_dispatch_coordinator; SELECT count(*) > 0 FROM public.orders WHERE id = '${oid(18)}'; ROLLBACK;`), 't')
    assert.match(psqlSession('SET ROLE maale_dispatch_coordinator;', 'authenticator'), /permission denied to set role/, 'PostgREST session user')
    assert.equal(dstate(oid(18)), 'pending/0')
  })

  await test('T11c. RESIDUAL (documented): the project owner / installer (holds SET on the coordinator) can still act as it', () => {
    // Not reachable by any application path (the app only has service_role); recorded so the report does not over-claim.
    psql(`BEGIN; SET LOCAL ROLE maale_dispatch_coordinator;
      UPDATE public.delivery_dispatches SET status = 'sending', attempts = 1, last_attempt_at = now() WHERE order_id = '${oid(16)}'; ROLLBACK;`)
    assert.equal(dstate(oid(16)), 'pending/0', 'rolled back — demonstration only')
  })

  await test('T10b. broken coordination dependency → calls fail (no claim, no record); state unchanged after rollback', () => {
    assert.match(psql(`BEGIN; ALTER TABLE public.maale_dispatch_reconciliations RENAME TO hidden_ledger; SET LOCAL ROLE service_role; ${claimSql(oid(17))} ROLLBACK;`, { expectError: true }), /does not exist/)
    assert.match(psql(`BEGIN; DROP FUNCTION public.claim_maale_dispatch(uuid, integer, timestamptz); SET LOCAL ROLE service_role; ${claimSql(oid(17))} ROLLBACK;`, { expectError: true }), /does not exist/)
    assert.equal(dstate(oid(17)), 'pending/0'); assert.equal(claim(oid(17)), 'claimed', 'intact after the rolled-back break')
  })

  await test('T12. unrelated dispatch rows byte-identical; sent row unchanged; quote ledger untouched', () => {
    assert.equal(fingerprint(unrelated), unrelatedBefore)
    assert.equal(psql(`SELECT md5(d::text) FROM public.delivery_dispatches d WHERE order_id = '${oid(67)}';`), sentBefore)
    assert.equal(psql('SELECT count(*) FROM public.maale_dispatch_requests;'), '0')
  })

  await test('X1. combined verify AFTER 04E: stage post_04e, every row PASS; 04B verify PASS; 04D verify: only row 05 (by design)', () => {
    const r = rows(COMBINED()); assert.equal(stageOf(r), 'post_04e'); allPass(r, 'post-04E combined')
    allPass(rows(read('s4_04b_verify.sql')), '04B')
    assert.deepEqual(failIds(rows(read('s4_04d_verify.sql'))), ['05'], 'only the intentional INSERT revoke differs from the 04D-only state (README)')
  })

  await test('X2. combined verify catches drift (each probe rolled back): partial 04E, direct ledger INSERT, app role in coordinator, replaced body', () => {
    let r = combinedAfter('DROP TRIGGER delivery_dispatches_coordination_guard ON public.delivery_dispatches;')
    assert.equal(stageOf(r), 'partial_04e'); assert.ok(failIds(r).includes('01'))
    r = combinedAfter('GRANT INSERT ON public.maale_dispatch_reconciliations TO service_role;')
    assert.ok(failIds(r).includes('07') && failIds(r).includes('08'), failIds(r).join(','))
    r = combinedAfter('GRANT INSERT ON public.maale_dispatch_reconciliations TO authenticated;')
    assert.ok(failIds(r).includes('07') && failIds(r).includes('08'), failIds(r).join(','))
    r = combinedAfter('GRANT maale_dispatch_coordinator TO service_role;')
    assert.ok(failIds(r).includes('15'), failIds(r).join(','))
    r = combinedAfter('GRANT maale_dispatch_coordinator TO authenticator;')
    assert.ok(failIds(r).includes('15'), 'authenticator membership: ' + failIds(r).join(','))
    for (const widen of ['GRANT SELECT ON public.orders TO maale_dispatch_coordinator;', 'GRANT UPDATE (dispatched_at) ON public.delivery_dispatches TO maale_dispatch_coordinator;',
      'GRANT INSERT ON public.maale_dispatch_reconciliations TO maale_dispatch_coordinator;', 'GRANT SELECT ON public.branches TO maale_dispatch_coordinator; ALTER TABLE public.branches ENABLE ROW LEVEL SECURITY;']) {
      r = combinedAfter(widen)
      assert.ok(failIds(r).some(i => ['07', '16'].includes(i)), `widened privilege detected (${widen}): ${failIds(r).join(',')}`)
      const v = psql(`BEGIN;\n${widen}\n${read('s4_04e_verify.sql')}\nROLLBACK;`).split('\n').filter(l => /^\d\d\|/.test(l)).map(l => l.split('|'))
      assert.ok(v.length === 16 && v.some(x => x[2] === 'FAIL'), `04E verify also FAILs: ${widen}`)
    }
    r = combinedAfter(`GRANT CREATE ON SCHEMA public TO maale_dispatch_coordinator; SET ROLE maale_dispatch_coordinator; CREATE OR REPLACE FUNCTION public.claim_maale_dispatch(p_order_id uuid, p_seen_attempts integer, p_seen_last_attempt_at timestamptz)
      RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '3s' AS $f$ BEGIN RETURN 'claimed'; END $f$; RESET ROLE;`)
    assert.ok(failIds(r).includes('11'), 'replaced claim body detected: ' + failIds(r).join(','))
    allPass(rows(COMBINED()), 'after the rolled-back drift probes')
  })

  await test('R1. rollback refuses without the explicit confirmation (nothing dropped)', () => {
    assert.match(psql(read('s4_04e_rollback.sql'), { expectError: true }), /not confirmed/)
    assert.equal(psql("SELECT count(*) FROM pg_proc WHERE proname IN ('claim_maale_dispatch','record_maale_reconciliation_event','delivery_dispatches_coordination_guard');"), '3')
  })

  await test('R2. confirmed rollback restores the exact pre-04E state; history and rows kept; reinstall works', () => {
    const ledgerBefore = fingerprint('SELECT string_agg(r::text, \',\' ORDER BY r.id) FROM public.maale_dispatch_reconciliations r')
    const dispatchBefore = fingerprint('SELECT string_agg(d::text, \',\' ORDER BY d.order_id) FROM public.delivery_dispatches d')
    psql("SET s4_04e.confirm_rollback = 'DROP-COURIER-COORDINATION';\n" + read('s4_04e_rollback.sql'))
    assert.equal(psql("SELECT count(*) FROM pg_proc WHERE proname IN ('claim_maale_dispatch','record_maale_reconciliation_event','delivery_dispatches_coordination_guard');"), '0')
    assert.equal(psql("SELECT has_table_privilege('service_role','public.maale_dispatch_reconciliations','INSERT');"), 't')
    assert.equal(psql("SELECT count(*) FROM pg_roles WHERE rolname = 'maale_dispatch_coordinator';"), '0', 'coordinator role dropped')
    const c = rows(COMBINED()); assert.equal(stageOf(c), 'pre_04e'); allPass(c, 'combined after rollback')
    for (const [id, name, res, detail] of rows(read('s4_04d_verify.sql'))) assert.ok(res === 'PASS' || res === 'INFO', `04D after rollback ${id} ${name}: ${res} ${detail}`)
    assert.equal(fingerprint('SELECT string_agg(r::text, \',\' ORDER BY r.id) FROM public.maale_dispatch_reconciliations r'), ledgerBefore)
    assert.equal(fingerprint('SELECT string_agg(d::text, \',\' ORDER BY d.order_id) FROM public.delivery_dispatches d'), dispatchBefore)
    assert.match(psql("SET s4_04e.confirm_rollback = 'DROP-COURIER-COORDINATION';\n" + read('s4_04e_rollback.sql'), { expectError: true }), /not \(all\) installed/)
    psql(read('s4_04e_courier_coordination.sql'))
    for (const [id, name, res, detail] of rows(read('s4_04e_verify.sql'))) assert.ok(res === 'PASS' || res === 'INFO', `04E reinstall ${id} ${name}: ${res} ${detail}`)
    const c2 = rows(COMBINED()); assert.equal(stageOf(c2), 'post_04e'); allPass(c2, 'combined after reinstall')
  })

  console.log(`\nAll ${passed} isolated PostgreSQL checks passed (container ${NAME}, network none).`)
} finally {
  docker(['rm', '-f', NAME])
}
