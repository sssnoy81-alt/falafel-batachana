// HYP-05 — ISOLATED PostgreSQL test of the payment-intent ledger and authorized finalization
// (db/migrations/hyp05_*.sql), test matrix T1–T20 of HYP-03S plus state-machine / recovery checks.
//
// Disposable Docker container started here with `--network none` from the Supabase Postgres image (real anon /
// authenticated / service_role / authenticator roles and default privileges). Never reads .env*, never connects to
// Supabase or HYP, removes the container at the end.
// Production fidelity: tables, constraints, indexes, triggers, RLS, policies and grants follow the Production Q1 export
// (HYP-02, 2026-10-24); create_order, create_order_with_parcel and every trigger function on the order / parcel tables
// are installed BYTE-EXACT from the Production Q6 export db/schema/hyp05_production_function_sources.csv and their md5 is
// asserted against Production before any test runs. parcel_events follows db/migrations/parcel_01_tables.sql.
//   node scripts/pgtest-hyp05-payment-intents.mjs            (needs Docker; not part of the verify-* suite)

import { spawn, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import { B1, B2, M1, M2, PROD, installFixture } from './hyp05-fixture.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MIG = join(ROOT, 'db', 'migrations')
const read = f => readFileSync(join(MIG, f), 'utf8')
const IMAGE = process.env.HYP05_PG_IMAGE || 'public.ecr.aws/supabase/postgres:17.6.1.141'
const NAME = `hyp05-pgtest-${process.pid}`

const docker = (args, input) => {
  const r = spawnSync('docker', args, { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }
}
const exec = (user, sql) => docker(['exec', '-i', NAME, 'psql', '-X', '-q', '-U', user, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At', '-F', '|'], sql)
function psql(sql, { role, expectError = false, user = 'postgres' } = {}) {
  const r = exec(user, (role ? `SET ROLE ${role};\n` : '') + sql)
  if (expectError) { assert.notEqual(r.code, 0, `expected an error, got: ${r.out}`); return r.err }
  assert.equal(r.code, 0, `psql failed: ${r.err}\nSQL: ${sql.slice(0, 400)}`)
  return r.out
}
const admin = (sql, opts = {}) => psql(sql, { ...opts, user: 'supabase_admin' })
const sr = (sql, opts = {}) => psql(sql, { ...opts, role: 'service_role' })
const psqlAsync = (sql, role) => new Promise(res => {
  const p = spawn('docker', ['exec', '-i', NAME, 'psql', '-X', '-q', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At', '-F', '|'])
  let out = '', err = ''
  p.stdout.on('data', d => { out += d }); p.stderr.on('data', d => { err += d })
  p.on('close', code => res({ code, out: out.trim(), err: err.trim() }))
  p.stdin.end((role ? `SET ROLE ${role};\n` : '') + sql)
})
const sleep = ms => new Promise(r => setTimeout(r, ms))
const lit = s => (s === null || s === undefined ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`)
const one = out => out.split('\n').filter(Boolean).pop().split('|')
const rows = out => out.split('\n').filter(Boolean).map(l => l.split('|'))
const val = sql => psql(sql).split('\n').filter(Boolean).pop()

const results = []
async function test(id, name, fn) {
  try { await fn(); results.push([id, 'PASS', name]); console.log(`  PASS ${id} ${name}`) }
  catch (e) { results.push([id, 'FAIL', name, e.message.split('\n')[0]]); console.log(`  FAIL ${id} ${name}\n       ${e.message.split('\n').slice(0, 3).join('\n       ')}`) }
}

/* ─── Production-shaped fixture (Q1): scripts/hyp05-fixture.mjs ─── */
/* ─── order snapshots (exactly what lib/orderRequest.ts builds, payment_method online) ─── */
const ITEM = (id, quantity, unit_price, notes = null) => ({ item_id: id, quantity, unit_price, notes })
function snap({ type = 'pickup', branch = B1, phone = '050-1234567', items = [ITEM(M1, 2, 20)], fee = 15, total = null, parcel = null, pm = 'online' } = {}) {
  const sum = items.reduce((s, i) => s + i.quantity * i.unit_price, 0)
  const s = { p_order: { branch_id: branch, type, phone, customer_name: 'Fixture Customer', payment_method: pm, total_price: total ?? (type === 'delivery' ? sum + fee : sum) }, p_items: items }
  if (type === 'delivery') s.p_delivery = { address: 'הרצל 1, מעלה אדומים', city: 'מעלה אדומים', street: 'הרצל', house_number: '1', apartment: null, floor: null, entrance: null, notes: null, delivery_fee: fee, meal_surcharge: 0, meal_quantity: 0, delivery_lat: null, delivery_lng: null, geo_source: 'none', geo_precision: 'unresolved' }
  if (parcel) s.p_parcel = { tracking_ref: parcel, carrier: null, recipient_name: null }
  return s
}
const sqlj = o => `${lit(JSON.stringify(o))}::jsonb`
const agorot = s => Math.round(s.p_order.total_price * 100)
let phoneSeq = 100, txSeq = 900000
const nextPhone = () => `05${String(++phoneSeq).padStart(8, '0')}`

function createIntent(s, { key = randomUUID(), kind = s.p_parcel ? 'parcel' : 'plain', amount = agorot(s), term = 'test', ttl = 900 } = {}) {
  const [result, id, token, ref, status] = one(sr(`SELECT result, intent_id, public_token, hyp_order_ref, intent_status FROM public.create_payment_intent(${lit(key)}::uuid, ${lit(term)}, ${lit(kind)}, ${sqlj(s)}, ${amount}, ${ttl});`))
  return { result, id, token, ref, status, key }
}
const sign = (id, ok = true) => one(sr(`SELECT result, intent_status FROM public.record_hyp_sign_result('${id}', ${ok});`))
const ret = raw => { const [result, rid, iid, token, status] = one(sr(`SELECT result, return_id, intent_id, public_token, intent_status FROM public.record_hyp_return(${lit(raw)});`)); return { result, rid, iid, token, status } }
const verify = (rid, outcome = 'authentic', resp = 'CCode=0&Verified=1') => one(sr(`SELECT result, intent_status FROM public.record_hyp_verification('${rid}', ${lit(outcome)}, ${lit(resp)});`))
const finalize = (id, staff = null) => one(sr(`SELECT result, COALESCE(order_id::text, ''), COALESCE(order_number::text, ''), COALESCE(daily_number::text, '') FROM public.finalize_paid_intent('${id}', ${lit(staff)});`))
const resolveI = (id, action, { staff = 'boss', note = 'checked in HYP portal', tx = null, amount = null, txid = null, ref = null } = {}) =>
  one(sr(`SELECT result, intent_status FROM public.resolve_payment_intent('${id}', ${lit(action)}, ${lit(staff)}, ${lit(note)}, ${lit(tx)}, ${amount ?? 'NULL'}, ${txid ? `'${txid}'::uuid` : 'NULL'}, ${lit(ref)});`))
const rawFor = (ref, { id = String(++txSeq), ccode = '0', amount = '40.00', acode = '0012345', extra = '' } = {}) =>
  `Id=${id}&CCode=${ccode}&Amount=${amount}&ACode=${acode}&Order=${ref}&Fild1=x${extra}&Sign=${'a1'.repeat(16)}`
const status = id => val(`SELECT status || '/' || COALESCE(hold_reason, '-') FROM public.payment_intents WHERE id = '${id}';`)
const count = (t, w = 'true') => Number(val(`SELECT count(*) FROM ${t} WHERE ${w};`))
const timeTravel = (id, set) => admin(`BEGIN; SET LOCAL session_replication_role = replica; UPDATE public.payment_intents SET ${set} WHERE id = '${id}'; COMMIT;`)
function paidIntent(s, opts = {}) {
  const i = createIntent(s, opts); assert.equal(i.result, 'created', `create: ${i.result}`)
  assert.equal(sign(i.id)[0], 'recorded')
  const r = ret(rawFor(i.ref, { amount: (agorot(s) / 100).toFixed(2) })); assert.equal(r.result, 'recorded')
  assert.equal(verify(r.rid)[0], 'paid')
  return i
}
const verifyRows = () => rows(psql(read('hyp05_verify.sql'))).filter(r => /^\d\d$/.test(r[0]))
const preflightRows = () => rows(psql(read('hyp05_production_preflight.sql'))).filter(r => /^\d\d$/.test(r[0]))
const allPass = (r, label) => { for (const [id, name, res, detail] of r) assert.ok(res === 'PASS' || res === 'INFO', `${label} ${id} ${name}: ${res} ${detail ?? ''}`) }

// The Supabase SQL editor fails with 42P01 on the text "insert into <word>" even inside literals / comments (S4-04G).
for (const f of ['hyp05_production_preflight.sql', 'hyp05_payment_intents.sql', 'hyp05_verify.sql', 'hyp05_rollback.sql', 'hyp05_privilege_audit.sql'])
  assert.ok(!/insert\s+into\s+(?!public\.)/i.test(read(f)), `${f} contains an SQL-editor-sensitive phrase`)

try {
  const run = docker(['run', '-d', '--rm', '--name', NAME, '--network', 'none', '-e', 'POSTGRES_PASSWORD=local-only-not-secret', IMAGE])
  assert.equal(run.code, 0, `docker run failed: ${run.err}`)
  assert.equal(docker(['inspect', '-f', '{{.HostConfig.NetworkMode}}', NAME]).out, 'none', 'container must have no network')
  let ready = false
  for (let i = 0; i < 120 && !ready; i++) {
    await sleep(1000)
    const logs = docker(['logs', NAME])
    ready = /init process complete/i.test(logs.out + logs.err) && docker(['exec', NAME, 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-Atc',
      "SELECT count(*) FROM pg_roles WHERE rolname IN ('service_role','anon','authenticated','authenticator')"]).out === '4'
  }
  assert.ok(ready, 'container did not become ready')
  console.log(`Isolated PostgreSQL: ${val('SELECT version();')}  (image ${IMAGE}, network: none)`)
  console.log(`installer role postgres: ${val("SELECT 'super=' || rolsuper || ' createrole=' || rolcreaterole || ' bypassrls=' || rolbypassrls FROM pg_roles WHERE rolname = 'postgres';")}`)

  /* ─── fixture + byte-exact Production function bodies ─── */
  const { sources } = installFixture(psql, ROOT)
  // push_subscriptions (customer data, covered by SEC-2 in Production) for the privilege audit; same grant shape.
  psql(`CREATE TABLE public.push_subscriptions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), phone text, endpoint text);
        ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;
        REVOKE ALL ON public.push_subscriptions FROM PUBLIC, anon, authenticated, service_role;
        GRANT SELECT, INSERT, DELETE ON public.push_subscriptions TO service_role;`)

  // Pre-existing Production-like business: cash / credit orders created through the real create_order (as POST /api/orders).
  const cashOrder = (pm = 'cash', type = 'pickup', extra = {}) => one(sr(`SELECT created_order_id, created_daily_number FROM public.create_order(${sqlj(snap({ pm, type, phone: nextPhone(), ...extra }).p_order)}, ${sqlj(snap().p_items)}, ${type === 'delivery' ? sqlj(snap({ type: 'delivery' }).p_delivery) : 'NULL'});`))
  for (const pm of ['cash', 'credit', 'cibus', 'bit']) cashOrder(pm)
  const fpBefore = psql(`SELECT string_agg(proname || '=' || md5(prosrc), ',' ORDER BY proname) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = ANY (ARRAY[${Object.keys(sources).map(lit).join(',')}]);`)

  console.log('\nT19a / T20a — preflight, install, rollback, reinstall')
  await test('T20a', 'production preflight before install: every row PASS', () => allPass(preflightRows(), 'preflight'))
  const auditRows = (pre = '') => rows(psql(`${pre}${read('hyp05_privilege_audit.sql')}`)).filter(r => /^\d\d$/.test(r[0]))
  await test('T20q', 'privilege audit (Q4) before install: customer tables PASS for anon / authenticated / PUBLIC, payment tables INFO', () => {
    const r = auditRows()
    assert.equal(r.length, 33); allPass(r, 'audit')
    assert.equal(r.filter(x => x[2] === 'INFO').length, 15); assert.ok(r.filter(x => x[2] === 'INFO').every(x => x[1].startsWith('public.payment_')))
    const neg = rows(psql(`BEGIN;\nGRANT SELECT (address) ON public.deliveries TO anon;\n${read('hyp05_privilege_audit.sql')}\nROLLBACK;`)).filter(x => /^\d\d$/.test(x[0]))
    // the detail column itself contains " | " separators → rejoin it
    const bad = neg.filter(x => x[2] === 'FAIL'); assert.equal(bad.length, 1); assert.match(bad[0][1], /public\.deliveries — no privilege for anon/)
    assert.match(bad[0].slice(3).join('|'), /table: none \| columns: SELECT \| rls: true/)
  })
  psql(read('hyp05_payment_intents.sql'))
  await test('T20b', 'verify after install: every row PASS', () => allPass(verifyRows(), 'verify'))
  await test('T20r', 'privilege audit (Q4) after install: all 33 rows PASS (payment tables unreachable by public roles)', () => {
    const r = auditRows(); assert.equal(r.length, 33); assert.ok(r.every(x => x[2] === 'PASS'), r.filter(x => x[2] !== 'PASS').map(x => x.join(' ')).join('; '))
  })
  await test('T19a', 'rollback refuses without the confirmation setting', () => {
    assert.match(psql(read('hyp05_rollback.sql'), { expectError: true }), /not confirmed/)
    assert.equal(val("SELECT count(*) FROM pg_roles WHERE rolname = 'hyp_payment_coordinator';"), '1')
  })
  await test('T19b', 'confirmed rollback on an evidence-free ledger restores the exact pre-HYP-05 state (preflight all PASS again)', () => {
    psql(`SET hyp05.confirm_rollback = 'DROP-PAYMENT-INTENTS';\n${read('hyp05_rollback.sql')}`)
    allPass(preflightRows(), 'preflight after rollback')
    assert.equal(psql(`SELECT string_agg(proname || '=' || md5(prosrc), ',' ORDER BY proname) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = ANY (ARRAY[${Object.keys(sources).map(lit).join(',')}]);`), fpBefore)
    assert.equal(val("SELECT count(*) FROM pg_roles WHERE rolname = 'hyp_payment_coordinator';"), '0')
    assert.equal(val("SELECT has_function_privilege('service_role', 'public.create_order(jsonb, jsonb, jsonb)', 'EXECUTE')::text;"), 'true')
  })
  psql(read('hyp05_payment_intents.sql'))
  await test('T20c', 're-install after rollback succeeds; verify every row PASS', () => allPass(verifyRows(), 'verify'))
  await test('T19c', 'a second install is refused (no silent re-apply)', () => {
    assert.match(psql(read('hyp05_payment_intents.sql'), { expectError: true }), /already exist/)
  })

  console.log('\nT1–T8 — authorization / bypass attempts (every one must be refused)')
  await test('T1', 'service_role calling create_order with payment_method online → 42501, no order', () => {
    const before = count('public.orders')
    const s = snap({ phone: nextPhone() })
    assert.match(sr(`SELECT * FROM public.create_order(${sqlj(s.p_order)}, ${sqlj(s.p_items)}, NULL);`, { expectError: true }), /orders_online_payment_guard/)
    const sp = snap({ type: 'delivery', phone: nextPhone(), parcel: 'RR123456789IL' })
    assert.match(sr(`SELECT * FROM public.create_order_with_parcel(${sqlj(sp.p_order)}, ${sqlj(sp.p_items)}, ${sqlj(sp.p_delivery)}, ${sqlj(sp.p_parcel)});`, { expectError: true }), /orders_online_payment_guard/)
    assert.equal(count('public.orders'), before)
  })
  await test('T2', 'direct INSERT of an online order: service_role → 42501; anon / authenticated → permission denied', () => {
    const ins = `INSERT INTO public.orders (branch_id, type, payment_method, status, total_price, daily_number) VALUES ('${B1}', 'pickup', 'online', 'received', 40, 999);`
    assert.match(sr(ins, { expectError: true }), /orders_online_payment_guard/)
    assert.match(psql(ins, { role: 'anon', expectError: true }), /permission denied/)
    assert.match(psql(ins, { role: 'authenticated', expectError: true }), /permission denied/)
    assert.equal(count('public.orders', "payment_method = 'online'"), 0)
  })
  const iT3 = paidIntent(snap({ phone: nextPhone() }))
  const oT3 = finalize(iT3.id)
  await test('T3', 'cash→online, online→cash, total / branch / type of an online order → 42501; kitchen status UPDATE works', () => {
    assert.equal(oT3[0], 'finalized')
    const [cashId] = cashOrder('cash')
    assert.match(sr(`UPDATE public.orders SET payment_method = 'online' WHERE id = '${cashId}';`, { expectError: true }), /orders_online_payment_guard/)
    for (const set of ["payment_method = 'cash'", 'total_price = 1', `branch_id = '${B2}'`, "type = 'delivery'"])
      assert.match(sr(`UPDATE public.orders SET ${set} WHERE id = '${oT3[1]}';`, { expectError: true }), /orders_online_payment_guard/, set)
    // the exact kitchen call (app/api/kitchen/orders/[id]/status): update({ status }).eq('id').eq('status', from)
    for (const [from, to] of [['received', 'confirmed'], ['confirmed', 'preparing'], ['preparing', 'ready'], ['ready', 'delivered']])
      assert.equal(sr(`UPDATE public.orders SET status = '${to}' WHERE id = '${oT3[1]}' AND status = '${from}' RETURNING id;`), oT3[1])
    assert.equal(val(`SELECT payment_method || '/' || total_price FROM public.orders WHERE id = '${oT3[1]}';`), 'online/40.00')
  })
  await test('T4', 'service_role and authenticator cannot SET ROLE hyp_payment_coordinator (real sessions)', () => {
    for (const who of ['service_role', 'authenticator', 'anon', 'authenticated']) {
      const r = exec('supabase_admin', `SET SESSION AUTHORIZATION ${who};\nSET ROLE hyp_payment_coordinator;`)
      assert.notEqual(r.code, 0, `${who} could become the coordinator`); assert.match(r.err, /permission denied to set role/)
    }
    assert.equal(exec('supabase_admin', 'SET SESSION AUTHORIZATION authenticator;\nSET ROLE service_role;\nSELECT current_user;').out, 'service_role', 'sanity: authenticator → service_role works')
  })
  await test('T5', "service_role's own DEFINER function, and a service_role BEFORE trigger rewriting the row, cannot create an online order", () => {
    const cr = exec('postgres', `SET ROLE service_role;\nCREATE FUNCTION public.zz_sr_insert_online() RETURNS void LANGUAGE sql SECURITY DEFINER AS $f$ INSERT INTO public.orders (branch_id, type, payment_method, status, total_price, daily_number) VALUES ('${B1}', 'pickup', 'online', 'received', 40, 998) $f$;`)
    if (cr.code === 0) {
      assert.match(sr('SELECT public.zz_sr_insert_online();', { expectError: true }), /orders_online_payment_guard/)
      psql('DROP FUNCTION public.zz_sr_insert_online();')
    } else assert.match(cr.err, /permission denied/)
    // Worst case: service_role holds TRIGGER on orders (Production Q1). Give it a row-rewriting function and let it
    // attach BEFORE triggers that fire after every other BEFORE trigger (name order).
    psql(`CREATE FUNCTION public.zz_attack_flip() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN NEW.payment_method := 'online'; RETURN NEW; END $f$;
          GRANT EXECUTE ON FUNCTION public.zz_attack_flip() TO service_role;`)
    sr(`CREATE TRIGGER zzzz_attack_ins BEFORE INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION public.zz_attack_flip();
        CREATE TRIGGER zzzz_attack_upd BEFORE UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION public.zz_attack_flip();`)
    const s = snap({ pm: 'cash', phone: nextPhone() })
    assert.match(sr(`SELECT * FROM public.create_order(${sqlj(s.p_order)}, ${sqlj(s.p_items)}, NULL);`, { expectError: true }), /orders_online_payment_guard/)
    psql('DROP TRIGGER zzzz_attack_ins ON public.orders;')
    const [cashId] = cashOrder('cash')
    assert.match(sr(`UPDATE public.orders SET status = 'confirmed' WHERE id = '${cashId}';`, { expectError: true }), /orders_online_payment_guard/)
    psql('DROP TRIGGER zzzz_attack_upd ON public.orders; DROP FUNCTION public.zz_attack_flip();')
    assert.equal(count('public.orders', "payment_method = 'online'"), 1)   // only the finalized T3 order
  })
  await test('T6', 'service_role cannot disable or drop the guard triggers (not the table owner)', () => {
    assert.match(sr('ALTER TABLE public.orders DISABLE TRIGGER orders_online_payment_guard_insert;', { expectError: true }), /must be owner/)
    assert.match(sr('DROP TRIGGER orders_online_payment_guard_insert ON public.orders;', { expectError: true }), /must be owner/)
    assert.match(sr('ALTER TABLE public.orders DROP CONSTRAINT orders_payment_method_check;', { expectError: true }), /must be owner/)
    assert.match(sr('TRUNCATE public.orders;', { expectError: true }), /payment_intents|truncate a table referenced/i)
  })
  await test('T7', 'direct writes to the payment ledger: service_role denied; even the owner cannot skip a transition or delete evidence', () => {
    assert.match(sr(`UPDATE public.payment_intents SET status = 'paid' WHERE id = '${iT3.id}';`, { expectError: true }), /permission denied/)
    assert.match(sr(`DELETE FROM public.payment_intents WHERE id = '${iT3.id}';`, { expectError: true }), /permission denied/)
    assert.match(sr(`INSERT INTO public.payment_transactions (intent_id, hyp_trans_id, source, ccode, amount_agorot, outcome, recorded_by) VALUES ('${iT3.id}', 'X1', 'portal', '0', 4000, 'approved', 'staff:boss');`, { expectError: true }), /permission denied/)
    const fresh = createIntent(snap({ phone: nextPhone() }))
    assert.match(psql(`UPDATE public.payment_intents SET status = 'finalized' WHERE id = '${fresh.id}';`, { expectError: true }), /transition created → finalized/)
    assert.match(psql(`UPDATE public.payment_intents SET snapshot = '{}'::jsonb WHERE id = '${fresh.id}';`, { expectError: true }), /immutable/)
    assert.match(psql(`DELETE FROM public.payment_intents WHERE id = '${fresh.id}';`, { expectError: true }), /never deleted/)
    assert.match(psql('UPDATE public.payment_transactions SET amount_agorot = 1;', { expectError: true }), /payment_append_only/)
    assert.match(psql('DELETE FROM public.payment_intent_events;', { expectError: true }), /payment_append_only/)
    assert.match(psql('TRUNCATE public.payment_transactions CASCADE;', { expectError: true }), /payment_append_only/)
    sign(fresh.id, false)
  })
  await test('T8', 'anon / authenticated: no EXECUTE on payment functions, no SELECT on payment tables', () => {
    for (const role of ['anon', 'authenticated']) {
      assert.match(psql(`SELECT * FROM public.finalize_paid_intent('${iT3.id}', NULL);`, { role, expectError: true }), /permission denied/)
      assert.match(psql("SELECT * FROM public.record_hyp_return('Id=1&Order=ABCDEFGH');", { role, expectError: true }), /permission denied/)
      assert.match(psql(`SELECT * FROM public.create_payment_intent(gen_random_uuid(), 'test', 'plain', '{}'::jsonb, 1, 900);`, { role, expectError: true }), /permission denied/)
      for (const t of ['payment_intents', 'payment_returns', 'payment_transactions', 'payment_reversals', 'payment_intent_events'])
        assert.match(psql(`SELECT 1 FROM public.${t} LIMIT 1;`, { role, expectError: true }), /permission denied/)
    }
  })

  console.log('\nT9–T16 — correctness, atomicity, concurrency, recovery')
  await test('T9', 'finalize refused (no order) in every non-paid state; a browser return alone never pays', () => {
    const before = count('public.orders')
    const a = createIntent(snap({ phone: nextPhone() }))
    assert.equal(finalize(a.id)[0], 'not_finalizable:created')
    sign(a.id)
    assert.equal(finalize(a.id)[0], 'not_finalizable:redirected')
    const r = ret(rawFor(a.ref))                      // approved-looking browser parameters, not yet verified
    assert.equal(r.status, 'returned'); assert.equal(finalize(a.id)[0], 'not_finalizable:returned')
    assert.equal(verify(r.rid, 'rejected', 'CCode=902')[0], 'rejected')
    assert.equal(finalize(a.id)[0], 'not_finalizable:verify_rejected')
    const d = createIntent(snap({ phone: nextPhone() })); sign(d.id)
    assert.equal(verify(ret(rawFor(d.ref, { ccode: '33', acode: '' })).rid)[0], 'declined')
    assert.equal(finalize(d.id)[0], 'not_finalizable:declined')
    const u = createIntent(snap({ phone: nextPhone() })); sign(u.id)
    timeTravel(u.id, "created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'")
    assert.deepEqual(one(sr('SELECT string_agg(result || \'=\' || intents, \',\') FROM public.sweep_expired_payment_intents(50);')), ['not_sent=0,outcome_unknown=1'])
    assert.equal(finalize(u.id)[0], 'not_finalizable:outcome_unknown')
    assert.equal(count('public.orders'), before)
  })
  await test('T10', 'finalize twice in sequence → already_finalized, exactly one order', () => {
    const i = paidIntent(snap({ phone: nextPhone() }))
    const f1 = finalize(i.id); const f2 = finalize(i.id)
    assert.equal(f1[0], 'finalized'); assert.equal(f2[0], 'already_finalized'); assert.equal(f2[1], f1[1]); assert.equal(f2[3], f1[3])
    assert.equal(count('public.payment_intents', `order_id = '${f1[1]}'`), 1)
    assert.equal(count('public.orders', `id = '${f1[1]}'`), 1)
  })
  await test('T11', 'concurrent finalize: lock holder + waiter, and 12 parallel calls → exactly one order each', async () => {
    const i = paidIntent(snap({ phone: nextPhone() }))
    const before = count('public.orders')
    const a = psqlAsync(`BEGIN;\nSELECT result FROM public.finalize_paid_intent('${i.id}', NULL);\nSELECT pg_sleep(2);\nCOMMIT;`, 'service_role')
    await sleep(600)
    const b = await psqlAsync(`SELECT result FROM public.finalize_paid_intent('${i.id}', NULL);`, 'service_role')
    const ra = await a
    assert.equal(ra.code, 0, ra.err); assert.equal(b.code, 0, b.err)
    assert.equal(ra.out.split('\n')[0], 'finalized'); assert.equal(b.out, 'already_finalized')
    assert.equal(count('public.orders'), before + 1)
    const j = paidIntent(snap({ phone: nextPhone() }))
    const par = await Promise.all(Array.from({ length: 12 }, () => psqlAsync(`SELECT result FROM public.finalize_paid_intent('${j.id}', NULL);`, 'service_role')))
    const outs = par.map(p => { assert.equal(p.code, 0, p.err); return p.out })
    assert.equal(outs.filter(o => o === 'finalized').length, 1); assert.equal(outs.filter(o => o === 'already_finalized').length, 11)
    assert.equal(count('public.orders'), before + 2)
  })
  await test('T12', 'create_order failure inside finalize → paid_hold finalize_error, zero rows written; staff retry cannot double', () => {
    const before = [count('public.orders'), count('public.order_items'), count('public.deliveries')]
    // items sum 40 + fee 15 = 55, but total says 60 (amount matches total): create_order's money guard raises 22023
    const s = snap({ type: 'delivery', phone: nextPhone(), total: 60 })
    const i = paidIntent(s)
    assert.equal(finalize(i.id)[0], 'held:finalize_error')
    assert.equal(status(i.id), 'paid_hold/finalize_error')
    assert.match(val(`SELECT last_error FROM public.payment_intents WHERE id = '${i.id}';`), /^22023: create_order: total mismatch/)
    assert.deepEqual([count('public.orders'), count('public.order_items'), count('public.deliveries')], before)
    assert.equal(finalize(i.id)[0], 'not_finalizable:paid_hold')           // no automatic retry from a hold
    assert.equal(finalize(i.id, 'boss')[0], 'held:finalize_error')         // staff retry: same snapshot, still one hold
    assert.deepEqual([count('public.orders'), count('public.order_items'), count('public.deliveries')], before)
    assert.equal(val(`SELECT finalize_attempts FROM public.payment_intents WHERE id = '${i.id}';`), '2')
  })
  await test('T13', 'daily_number continues the shared counter under the coordinator; BYPASSRLS is required (payment ledger and deliveries)', () => {
    const max = Number(val("SELECT max(daily_number) FROM public.orders WHERE created_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Jerusalem') AT TIME ZONE 'Asia/Jerusalem');"))
    const f = finalize(paidIntent(snap({ phone: nextPhone() })).id)
    assert.equal(Number(f[3]), max + 1)
    const [, cashDaily] = cashOrder('cash'); assert.equal(Number(cashDaily), max + 2)
    const d = paidIntent(snap({ type: 'delivery', phone: nextPhone() }))
    // Without BYPASSRLS (inside a rolled-back transaction): (a) the coordinator cannot see its own RLS-protected ledger;
    // (b) create_order run as the coordinator cannot insert into deliveries (RLS on, no policies, Production Q1).
    const a = psql(`BEGIN;\nALTER ROLE hyp_payment_coordinator NOBYPASSRLS;\nSET ROLE service_role;\nSELECT result FROM public.finalize_paid_intent('${d.id}', NULL);\nROLLBACK;`)
    assert.equal(a, 'not_found')
    const c = snap({ type: 'delivery', pm: 'cash', phone: nextPhone() })
    const b = exec('postgres', `BEGIN;\nALTER ROLE hyp_payment_coordinator NOBYPASSRLS;\nSET ROLE hyp_payment_coordinator;\nSELECT * FROM public.create_order(${sqlj(c.p_order)}, ${sqlj(c.p_items)}, ${sqlj(c.p_delivery)});\nROLLBACK;`)
    assert.notEqual(b.code, 0); assert.match(b.err, /new row violates row-level security policy for table "deliveries"/)
    assert.equal(val("SELECT rolbypassrls::text FROM pg_roles WHERE rolname = 'hyp_payment_coordinator';"), 'true')
    assert.equal(finalize(d.id)[0], 'finalized')
  })
  await test('T14', 'parcel: wrapper path creates order + parcel_request + parcel_event as the coordinator; conflicts are held, never lost', () => {
    const s = snap({ type: 'delivery', phone: nextPhone(), parcel: 'RR 123 456 789 IL' })
    const i = paidIntent(s)
    const f = finalize(i.id); assert.equal(f[0], 'finalized')
    assert.equal(val(`SELECT status || '/' || last_actor || '/' || tracking_key FROM public.parcel_requests WHERE order_id = '${f[1]}';`), 'awaiting_search/customer_checkout/RR123456789IL')
    assert.equal(count('public.parcel_events', `order_id = '${f[1]}' AND to_status = 'awaiting_search' AND from_status IS NULL`), 1)
    // the same tracking number is now active → a new intent for it is refused before any payment
    assert.equal(createIntent(snap({ type: 'delivery', phone: nextPhone(), parcel: 'RR123456789IL' })).result, 'parcel_active')
    // reservation: two intents for one new tracking number → the second is refused
    const k = paidIntent(snap({ type: 'delivery', phone: nextPhone(), parcel: 'CX987654321IL' }))
    assert.equal(createIntent(snap({ type: 'delivery', phone: nextPhone(), parcel: 'CX-987654321-IL' })).result, 'parcel_reserved')
    // residual race with the unchanged cash path: a cash order takes the number after payment → held as parcel_conflict
    const c = snap({ type: 'delivery', pm: 'cash', phone: nextPhone(), parcel: 'CX987654321IL' })
    sr(`SELECT * FROM public.create_order_with_parcel(${sqlj(c.p_order)}, ${sqlj(c.p_items)}, ${sqlj(c.p_delivery)}, ${sqlj(c.p_parcel)});`)
    const before = count('public.orders')
    assert.equal(finalize(k.id)[0], 'held:parcel_conflict'); assert.equal(count('public.orders'), before)
    // the UPDATE (updated_at) grant is what lets parcel_requests_before_write lock the order FOR SHARE
    const p = paidIntent(snap({ type: 'delivery', phone: nextPhone(), parcel: 'LP00112233' }))
    const out = psql(`BEGIN;\nREVOKE UPDATE (updated_at) ON public.orders FROM hyp_payment_coordinator;\nSET ROLE service_role;\nSELECT result FROM public.finalize_paid_intent('${p.id}', NULL);\nRESET ROLE;\nSELECT last_error FROM public.payment_intents WHERE id = '${p.id}';\nROLLBACK;`)
    assert.match(out, /held:finalize_error/); assert.match(out, /42501: permission denied for table orders/)
    assert.equal(finalize(p.id)[0], 'finalized')
  })
  await test('T15', 'stored order content is exactly the paid snapshot (items, delivery, totals)', () => {
    const s = snap({ type: 'delivery', phone: nextPhone(), fee: 12, items: [ITEM(M1, 3, 18.5, 'בלי חריף'), ITEM(M2, 1, 26)] })
    const f = finalize(paidIntent(s).id); assert.equal(f[0], 'finalized')
    assert.equal(val(`SELECT type || '/' || payment_method || '/' || total_price || '/' || status || '/' || phone FROM public.orders WHERE id = '${f[1]}';`), `delivery/online/93.50/received/${s.p_order.phone}`)
    assert.equal(psql(`SELECT string_agg(item_id || ':' || quantity || ':' || unit_price || ':' || COALESCE(notes, '-'), ',' ORDER BY unit_price) FROM public.order_items WHERE order_id = '${f[1]}';`),
      `${M1}:3:18.50:בלי חריף,${M2}:1:26.00:-`)
    assert.equal(val(`SELECT city || '/' || street || '/' || house_number || '/' || delivery_fee || '/' || geo_precision FROM public.deliveries WHERE order_id = '${f[1]}';`), 'מעלה אדומים/הרצל/1/12.00/unresolved')
  })
  await test('T16', 'VERIFY recording: payment fields only from the stored return; mismatch / unparseable / duplicates / conflicts never pay', () => {
    const s = snap({ phone: nextPhone() })
    const a = createIntent(s); sign(a.id)
    const r1 = ret(rawFor(a.ref, { amount: '39.00' }))                                  // HYP charged a different amount
    assert.equal(verify(r1.rid)[0], 'amount_mismatch'); assert.equal(status(a.id), 'paid_amount_mismatch/-')
    assert.equal(finalize(a.id)[0], 'not_finalizable:paid_amount_mismatch')
    const b = createIntent(snap({ phone: nextPhone() })); sign(b.id)
    const rb = ret(`CCode=0&Amount=40.00&Order=${b.ref}`)                                // no Id → unparseable
    assert.equal(verify(rb.rid)[0], 'unparseable'); assert.equal(status(b.id), 'verify_rejected/-')
    const r2 = ret(rawFor(b.ref, { id: '777001' }))
    assert.equal(r2.status, 'returned')
    assert.equal(verify(r2.rid, 'authentic', `Id=777001&CCode=0&Amount=40.00&ACode=0012345&Order=${b.ref}&Fild1=x&Sign=${'a1'.repeat(16)}`)[0], 'verify_response_is_return')
    assert.equal(verify(r2.rid)[0], 'paid')
    assert.equal(verify(r2.rid)[0], 'already_verified')
    assert.equal(ret(rawFor(b.ref, { id: '777001' })).result, 'duplicate_return')   // same browser return again
    const r3 = ret(rawFor(b.ref, { id: '777001', extra: '&Fild2=y' }))                // same HYP Id, other query string
    assert.equal(verify(r3.rid)[0], 'already_recorded')
    const c = createIntent(snap({ phone: nextPhone() })); sign(c.id)
    assert.equal(verify(ret(rawFor(c.ref, { id: '777001' })).rid)[0], 'trans_id_conflict')   // Id of another intent
    assert.equal(status(c.id), 'returned/-')
    const r4 = ret(rawFor(b.ref, { id: '777002' }))                                    // second approved charge
    assert.equal(verify(r4.rid)[0], 'duplicate_charge'); assert.equal(status(b.id), 'paid_hold/duplicate_charge')
    assert.equal(count('public.payment_transactions', `intent_id = '${b.id}'`), 2)
    assert.equal(ret('Id=1&CCode=0&Amount=1.00&Order=NOSUCHORDER1').result, 'unknown_order')
    assert.equal(ret("Id=1&Order=ABCDEFGH&x=<script>").result, 'invalid_request')
  })

  console.log('\nHYP-06A — authenticated non-capture codes (600 J2 / 700 J5 / 800 postponed)')
  await test('N1', 'all four documented codes: 0 → paid; 600 / 700 / 800 → not_captured → outcome_unknown (never paid, never declined); decline code → declined', () => {
    const got = {}
    for (const code of ['0', '600', '700', '800', '33']) {
      const i = createIntent(snap({ phone: nextPhone() })); sign(i.id)
      const [res, st] = verify(ret(rawFor(i.ref, { ccode: code, acode: code === '33' ? '' : '0012345' })).rid)
      got[code] = `${res}/${st}`
      if (['600', '700', '800'].includes(code)) {
        assert.equal(status(i.id), 'outcome_unknown/-')
        assert.equal(val(`SELECT outcome FROM public.payment_transactions WHERE intent_id = '${i.id}';`), 'non_capture')
        assert.equal(val(`SELECT last_error FROM public.payment_intents WHERE id = '${i.id}';`), `non_capture_ccode_${code}`)
        assert.equal(val(`SELECT detail FROM public.payment_intent_events WHERE intent_id = '${i.id}' AND to_status = 'outcome_unknown';`), `non_capture_ccode_${code}`)
        assert.equal(finalize(i.id)[0], 'not_finalizable:outcome_unknown')
      }
    }
    assert.deepEqual(got, { 0: 'paid/paid', 600: 'not_captured/outcome_unknown', 700: 'not_captured/outcome_unknown',
                            800: 'not_captured/outcome_unknown', 33: 'declined/declined' })
  })
  await test('N2', 'a J5 hold blocks a second charge for the same customer; staff resolve it (no_charge_found after release, or portal_paid → held)', () => {
    const phone = nextPhone()
    const i = createIntent(snap({ phone })); sign(i.id)
    assert.equal(verify(ret(rawFor(i.ref, { ccode: '700' })).rid)[0], 'not_captured')
    assert.equal(createIntent(snap({ phone })).result, 'open_payment_exists')        // declined would have released this
    const before = count('public.orders')
    assert.equal(resolveI(i.id, 'no_charge_found', { note: 'J5 hold released at HYP; no capture' })[0], 'recorded')
    assert.equal(createIntent(snap({ phone })).result, 'created')
    const j = createIntent(snap({ phone: nextPhone() })); sign(j.id)
    assert.equal(verify(ret(rawFor(j.ref, { ccode: '800' })).rid)[0], 'not_captured')
    assert.equal(resolveI(j.id, 'portal_paid', { tx: String(++txSeq), amount: 4000, note: 'committed in HYP portal' })[0], 'recorded')
    assert.equal(status(j.id), 'paid_hold/manual_confirmation'); assert.equal(count('public.orders'), before)
  })
  await test('N3', 'a non-capture return after the intent is already paid changes nothing (recorded as evidence only)', () => {
    const i = paidIntent(snap({ phone: nextPhone() }))
    assert.equal(verify(ret(rawFor(i.ref, { ccode: '700' })).rid)[0], 'not_captured_ignored')
    assert.equal(status(i.id), 'paid/-'); assert.equal(count('public.payment_transactions', `intent_id = '${i.id}' AND outcome = 'non_capture'`), 1)
    assert.equal(finalize(i.id)[0], 'finalized')
  })
  await test('N4', 'duplicate callbacks of a non-capture return: duplicate_return, already_verified, already_recorded — one transaction', () => {
    const i = createIntent(snap({ phone: nextPhone() })); sign(i.id)
    const raw = rawFor(i.ref, { ccode: '600', id: 'NC600A' })
    const r = ret(raw); assert.equal(verify(r.rid)[0], 'not_captured')
    assert.equal(ret(raw).result, 'duplicate_return'); assert.equal(verify(r.rid)[0], 'already_verified')
    const again = ret(rawFor(i.ref, { ccode: '600', id: 'NC600A', extra: '&Fild2=z' }))
    assert.equal(again.status, 'returned')                                          // outcome_unknown → returned by the new return
    assert.equal(verify(again.rid)[0], 'already_recorded'); assert.equal(count('public.payment_transactions', `intent_id = '${i.id}'`), 1)
  })
  await test('N5', 'the outcome rule is enforced by the table itself (0 ⇔ approved, 600/700/800 ⇔ non_capture)', () => {
    const i = createIntent(snap({ phone: nextPhone() }))
    for (const [ccode, outcome] of [['700', 'declined'], ['0', 'non_capture'], ['33', 'non_capture'], ['600', 'approved']])
      assert.match(psql(`INSERT INTO public.payment_transactions (intent_id, hyp_trans_id, source, ccode, amount_agorot, outcome, recorded_by) VALUES ('${i.id}', 'CHK${ccode}${outcome.length}', 'portal', '${ccode}', 4000, '${outcome}', 'staff:boss');`, { expectError: true }), /payment_transactions_outcome_check/, `${ccode}/${outcome}`)
    sign(i.id, false)
  })
  await test('N6', 'unauthenticated or malformed returns of any code never reach paid / finalized / an order', () => {
    const before = count('public.orders')
    for (const code of ['0', '700']) {
      const a = createIntent(snap({ phone: nextPhone() })); sign(a.id)
      assert.equal(verify(ret(rawFor(a.ref, { ccode: code })).rid, 'rejected', 'CCode=902')[0], 'rejected')
      assert.equal(finalize(a.id)[0], 'not_finalizable:verify_rejected')
      const b = createIntent(snap({ phone: nextPhone() })); sign(b.id)
      assert.equal(verify(ret(`CCode=${code}&Amount=40.00&Order=${b.ref}`).rid)[0], 'unparseable')
      assert.equal(finalize(b.id)[0], 'not_finalizable:verify_rejected')
    }
    assert.equal(count('public.orders'), before)
  })

  console.log('\nRecovery / state machine / audit (HYP-03R §4–§5)')
  await test('R1', 'late return: verified payment after expiry is held, never sent to the kitchen automatically; staff can finalize', () => {
    const i = createIntent(snap({ phone: nextPhone() })); sign(i.id)
    timeTravel(i.id, "created_at = now() - interval '3 hours', expires_at = now() - interval '2 hours'")
    assert.equal(verify(ret(rawFor(i.ref)).rid)[0], 'paid')
    const before = count('public.orders')
    assert.equal(finalize(i.id)[0], 'held:late_return'); assert.equal(count('public.orders'), before)
    assert.equal(finalize(i.id, 'boss')[0], 'finalized'); assert.equal(count('public.orders'), before + 1)
  })
  await test('R2', 'unknown outcome is never closed by time; portal confirmation → held; no_charge_found needs a staff attestation', () => {
    const i = createIntent(snap({ phone: nextPhone() })); sign(i.id)
    timeTravel(i.id, "created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'")
    sr('SELECT * FROM public.sweep_expired_payment_intents(100);'); sr('SELECT * FROM public.sweep_expired_payment_intents(100);')
    assert.equal(status(i.id), 'outcome_unknown/-')
    assert.equal(resolveI(i.id, 'no_charge_found', { note: 'x' })[0], 'invalid_request')        // note too short
    assert.equal(resolveI(i.id, 'portal_paid', { tx: '880001', amount: 4000 })[0], 'recorded')
    assert.equal(status(i.id), 'paid_hold/manual_confirmation')
    assert.equal(finalize(i.id)[0], 'not_finalizable:paid_hold')
    assert.equal(finalize(i.id, 'boss')[0], 'finalized')
    const n = createIntent(snap({ phone: nextPhone() })); sign(n.id)
    timeTravel(n.id, "created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'")
    sr('SELECT * FROM public.sweep_expired_payment_intents(100);')
    assert.equal(resolveI(n.id, 'no_charge_found')[0], 'recorded')
    assert.equal(val(`SELECT status || '/' || staff_user || '/' || (portal_checked_at IS NOT NULL) FROM public.payment_intents WHERE id = '${n.id}';`), 'no_charge_found/boss/true')
    // a genuine late return after "no charge found" is still captured, never lost
    assert.equal(verify(ret(rawFor(n.ref)).rid)[0], 'paid')
  })
  await test('R3', 'ambiguity guard: no second intent for the same customer while one is open; allowed again after a definite outcome', () => {
    const phone = nextPhone()
    const i = createIntent(snap({ phone })); sign(i.id)
    assert.equal(createIntent(snap({ phone })).result, 'open_payment_exists')
    assert.equal(createIntent(snap({ phone, branch: B2 })).result, 'created')          // other branch: independent
    assert.equal(verify(ret(rawFor(i.ref, { ccode: '6', acode: '' })).rid)[0], 'declined')
    assert.equal(createIntent(snap({ phone })).result, 'created')
  })
  await test('R4', 'checkout_key idempotency; invalid snapshots refused; SIGN failure / expiry never redirects', () => {
    const s = snap({ phone: nextPhone() }); const key = randomUUID()
    const a = createIntent(s, { key }); const b = createIntent(s, { key })
    assert.equal(a.result, 'created'); assert.equal(b.result, 'existing'); assert.equal(b.id, a.id)
    assert.equal(createIntent(snap({ phone: s.p_order.phone, items: [ITEM(M2, 1, 26)] }), { key }).result, 'checkout_key_reused')
    assert.equal(createIntent(snap({ phone: nextPhone() }), { amount: 3999 }).result, 'invalid_snapshot')
    assert.equal(createIntent(snap({ phone: nextPhone(), pm: 'cash' })).result, 'invalid_snapshot')
    assert.equal(createIntent({ ...snap({ phone: nextPhone() }), p_extra: 1 }).result, 'invalid_snapshot')
    assert.equal(sign(a.id, false)[1], 'not_sent')
    const e = createIntent(snap({ phone: nextPhone() }))
    timeTravel(e.id, "created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'")
    assert.deepEqual(sign(e.id), ['expired', 'not_sent'])
  })
  await test('R5', 'void / refund keep evidence; the order stays linked; over-refund refused', () => {
    const i = paidIntent(snap({ phone: nextPhone() })); const f = finalize(i.id)
    const tx = val(`SELECT paid_transaction_id FROM public.payment_intents WHERE id = '${i.id}';`)
    assert.equal(resolveI(i.id, 'refund', { txid: tx, amount: 4001, ref: 'Z1' })[0], 'amount_exceeds_charge')
    assert.equal(resolveI(i.id, 'refund', { txid: tx, amount: 1000, ref: 'Z1' })[0], 'reversal_recorded')   // partial
    assert.equal(resolveI(i.id, 'void', { txid: tx, amount: 3000, ref: 'C1' })[0], 'reversed')
    assert.equal(val(`SELECT status || '/' || order_id FROM public.payment_intents WHERE id = '${i.id}';`), `voided/${f[1]}`)
    assert.equal(count('public.payment_transactions', `intent_id = '${i.id}'`), 1); assert.equal(count('public.payment_reversals', `intent_id = '${i.id}'`), 2)
    assert.equal(finalize(i.id)[0], 'not_finalizable:voided')
  })
  await test('R6', 'audit trail: every state change is an event with its actor; events are append-only', () => {
    const i = paidIntent(snap({ phone: nextPhone() })); finalize(i.id)
    assert.equal(psql(`SELECT string_agg(COALESCE(from_status, '-') || '>' || to_status || '@' || actor, ',' ORDER BY occurred_at) FROM public.payment_intent_events WHERE intent_id = '${i.id}';`),
      '->created@system:start,created>redirected@system:start,redirected>returned@system:return,returned>paid@system:verify,paid>finalized@system:finalize')
  })
  await test('R7', 'triggers run with the expected current_user (coordinator inside finalize, service_role on the cash path)', () => {
    psql(`CREATE FUNCTION public.zz_probe() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE NOTICE 'probe:%:%', TG_TABLE_NAME, current_user; RETURN NULL; END $f$;
          CREATE TRIGGER zz_probe AFTER INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION public.zz_probe();
          CREATE TRIGGER zz_probe AFTER INSERT ON public.order_items FOR EACH ROW EXECUTE FUNCTION public.zz_probe();
          CREATE TRIGGER zz_probe AFTER INSERT ON public.deliveries FOR EACH ROW EXECUTE FUNCTION public.zz_probe();
          CREATE TRIGGER zz_probe AFTER INSERT ON public.parcel_requests FOR EACH ROW EXECUTE FUNCTION public.zz_probe();
          CREATE TRIGGER zz_probe AFTER INSERT ON public.parcel_events FOR EACH ROW EXECUTE FUNCTION public.zz_probe();`)
    try {
      const i = paidIntent(snap({ type: 'delivery', phone: nextPhone(), parcel: 'PB55667788' }))
      const r = exec('postgres', `SET ROLE service_role;\nSELECT result FROM public.finalize_paid_intent('${i.id}', NULL);`)
      assert.equal(r.code, 0, r.err)
      const probes = [...r.err.matchAll(/probe:(\w+):(\w+)/g)].map(m => `${m[1]}:${m[2]}`)
      assert.deepEqual([...new Set(probes)].sort(), ['deliveries:hyp_payment_coordinator', 'order_items:hyp_payment_coordinator', 'orders:hyp_payment_coordinator',
        'parcel_events:hyp_payment_coordinator', 'parcel_requests:hyp_payment_coordinator'])
      const c = snap({ type: 'delivery', pm: 'cash', phone: nextPhone() })
      const rc = exec('postgres', `SET ROLE service_role;\nSELECT 1 FROM public.create_order(${sqlj(c.p_order)}, ${sqlj(c.p_items)}, ${sqlj(c.p_delivery)});`)
      assert.deepEqual([...new Set([...rc.err.matchAll(/probe:(\w+):(\w+)/g)].map(m => m[2]))], ['service_role'])
    } finally {
      psql(`DROP TRIGGER zz_probe ON public.orders; DROP TRIGGER zz_probe ON public.order_items; DROP TRIGGER zz_probe ON public.deliveries;
            DROP TRIGGER zz_probe ON public.parcel_requests; DROP TRIGGER zz_probe ON public.parcel_events; DROP FUNCTION public.zz_probe();`)
    }
  })
  await test('R8', 'documented residual: service_role asserting a forged VERIFY can create a paid order (trust root; detectable only by reconciliation)', () => {
    const i = createIntent(snap({ phone: nextPhone() })); sign(i.id)
    assert.equal(verify(ret(rawFor(i.ref, { id: 'FORGED1' })).rid, 'authentic', 'forged-by-server-code')[0], 'paid')
    assert.equal(finalize(i.id)[0], 'finalized')
    assert.equal(val(`SELECT t.hyp_trans_id || '/' || t.source || '/' || r.verify_response FROM public.payment_transactions t JOIN public.payment_returns r ON r.id = t.return_id WHERE t.intent_id = '${i.id}';`), 'FORGED1/verify/forged-by-server-code')
  })

  console.log('\nHYP-09 — staff recovery primitives')
  const events = id => psql(`SELECT string_agg(COALESCE(detail, '-'), ' | ' ORDER BY occurred_at) FROM public.payment_intent_events WHERE intent_id = '${id}';`)
  await test('S1', 'attention flags: refund_required only on confirmed money, investigation on any started intent; never a status change or refund record', () => {
    const f = paidIntent(snap({ phone: nextPhone() })); finalize(f.id)
    const u = createIntent(snap({ phone: nextPhone() })); sign(u.id)
    timeTravel(u.id, "created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'"); sr('SELECT * FROM public.sweep_expired_payment_intents(100);')
    assert.equal(resolveI(u.id, 'flag_refund_required', { note: 'unknown money cannot be refunded' })[0], 'invalid_state')
    assert.deepEqual(resolveI(u.id, 'flag_investigation', { note: 'check HYP portal' }), ['recorded', 'outcome_unknown'])
    assert.deepEqual(resolveI(u.id, 'flag_investigation', { note: 'again' }), ['already_flagged', 'outcome_unknown'])
    assert.deepEqual(resolveI(f.id, 'flag_refund_required', { note: 'customer cancelled; refund at HYP' }), ['recorded', 'finalized'])
    assert.equal(val(`SELECT status || '/' || staff_flag || '/' || staff_flag_by FROM public.payment_intents WHERE id = '${f.id}';`), 'finalized/refund_required/boss')
    assert.equal(count('public.payment_reversals', `intent_id = '${f.id}'`), 0)               // a marker is never a refund
    assert.deepEqual(resolveI(f.id, 'clear_flag', { note: 'handled by phone' }), ['recorded', 'finalized'])
    assert.deepEqual(resolveI(f.id, 'clear_flag', { note: 'again' }), ['not_flagged', 'finalized'])
    assert.match(events(f.id), /flag:refund_required customer cancelled; refund at HYP \| flag:cleared handled by phone/)
    const n = createIntent(snap({ phone: nextPhone() }))
    assert.equal(resolveI(n.id, 'flag_investigation', { note: 'nothing started' })[0], 'invalid_state'); sign(n.id, false)
  })
  await test('S2', 'external refund recorded once per HYP reference: retry → already_recorded, other data / intent → reference_conflict', () => {
    const i = paidIntent(snap({ phone: nextPhone() })); finalize(i.id)
    const tx = val(`SELECT paid_transaction_id FROM public.payment_intents WHERE id = '${i.id}';`)
    assert.deepEqual(resolveI(i.id, 'refund', { txid: tx, amount: 4000, ref: 'RF900001', note: 'refunded in HYP portal' }), ['reversed', 'refunded'])
    assert.deepEqual(resolveI(i.id, 'refund', { txid: tx, amount: 4000, ref: 'RF900001', note: 'double click' }), ['already_recorded', 'refunded'])
    assert.equal(resolveI(i.id, 'refund', { txid: tx, amount: 1000, ref: 'RF900001', note: 'different amount' })[0], 'reference_conflict')
    const j = paidIntent(snap({ phone: nextPhone() })); finalize(j.id)
    const tj = val(`SELECT paid_transaction_id FROM public.payment_intents WHERE id = '${j.id}';`)
    assert.equal(resolveI(j.id, 'refund', { txid: tj, amount: 4000, ref: 'RF900001', note: 'reused reference' })[0], 'reference_conflict')
    assert.equal(count('public.payment_reversals', "hyp_reference = 'RF900001'"), 1)
    assert.equal(val(`SELECT status FROM public.payment_intents WHERE id = '${j.id}';`), 'finalized')
  })
  await test('S3', 'portal confirmation is idempotent; a conflicting Id or amount is refused; it never finalizes by itself', () => {
    const i = createIntent(snap({ phone: nextPhone() })); sign(i.id)
    timeTravel(i.id, "created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'"); sr('SELECT * FROM public.sweep_expired_payment_intents(100);')
    const before = count('public.orders')
    assert.deepEqual(resolveI(i.id, 'portal_paid', { tx: 'PT500001', amount: 4000, note: 'found in HYP portal' }), ['recorded', 'paid_hold'])
    assert.deepEqual(resolveI(i.id, 'portal_paid', { tx: 'PT500001', amount: 4000, note: 'retry' }), ['already_recorded', 'paid_hold'])
    assert.equal(resolveI(i.id, 'portal_paid', { tx: 'PT500001', amount: 3900, note: 'other amount' })[0], 'invalid_state')
    const k = createIntent(snap({ phone: nextPhone() })); sign(k.id)
    assert.equal(resolveI(k.id, 'portal_paid', { tx: 'PT500001', amount: 4000, note: 'Id of another intent' })[0], 'trans_id_conflict')
    assert.equal(count('public.orders'), before); assert.equal(count('public.payment_transactions', "hyp_trans_id = 'PT500001'"), 1)
    assert.match(events(i.id), /note: found in HYP portal/)
  })
  await test('S4', 'staff finalize covers every confirmed-money hold exactly once (flag-off paid, late, failed retry, duplicate, manual)', () => {
    const run = (setup, label) => {
      const i = setup(); const before = count('public.orders')
      assert.equal(finalize(i.id)[0].startsWith('finalized') || finalize(i.id)[0] === 'already_finalized', false, `${label}: no automatic finalize`)
      const f1 = finalize(i.id, 'boss'); const f2 = finalize(i.id, 'boss')
      assert.equal(f1[0], 'finalized', label); assert.equal(f2[0], 'already_finalized', label); assert.equal(count('public.orders'), before + 1, label)
      assert.match(psql(`SELECT string_agg(actor, ',') FROM public.payment_intent_events WHERE intent_id = '${i.id}' AND to_status = 'finalized';`), /^staff:boss$/, label)
    }
    run(() => {   // paid while the flag was off: stays paid (never finalized automatically by the return route)
      const i = paidIntent(snap({ phone: nextPhone() })); resolveI(i.id, 'hold', { note: 'flag off, staff decides' }); return i }, 'paid → hold → staff')
    run(() => {
      const i = createIntent(snap({ phone: nextPhone() })); sign(i.id)
      timeTravel(i.id, "created_at = now() - interval '3 hours', expires_at = now() - interval '2 hours'")
      verify(ret(rawFor(i.ref)).rid); finalize(i.id); return i }, 'late_return')
    run(() => {
      const i = paidIntent(snap({ phone: nextPhone() }))
      const cols = '(order_id, item_id, quantity, unit_price, notes)'
      psql(`REVOKE INSERT ${cols} ON public.order_items FROM hyp_payment_coordinator;`)   // a transient failure inside create_order
      try { assert.equal(finalize(i.id)[0], 'held:finalize_error') } finally { psql(`GRANT INSERT ${cols} ON public.order_items TO hyp_payment_coordinator;`) }
      assert.equal(status(i.id), 'paid_hold/finalize_error'); return i }, 'finalize_error retry')
    run(() => {
      const i = paidIntent(snap({ phone: nextPhone() })); verify(ret(rawFor(i.ref, { id: String(++txSeq) })).rid)
      assert.equal(status(i.id), 'paid_hold/duplicate_charge'); return i }, 'duplicate_charge')
  })

  console.log('\nT17–T20 — regression, fingerprints, rollback with evidence, privileges')
  await test('T17', 'existing workflows unchanged: cash / credit / cibus / bit pickup + delivery, parcel gates, cancellation', () => {
    for (const pm of ['cash', 'credit', 'cibus', 'bit']) cashOrder(pm, 'pickup')
    for (const pm of ['cash', 'credit']) cashOrder(pm, 'delivery')
    const c = snap({ type: 'delivery', pm: 'cash', phone: nextPhone(), parcel: 'GT11223344' })
    const [oid] = one(sr(`SELECT created_order_id FROM public.create_order_with_parcel(${sqlj(c.p_order)}, ${sqlj(c.p_items)}, ${sqlj(c.p_delivery)}, ${sqlj(c.p_parcel)});`))
    assert.match(sr(`UPDATE public.orders SET status = 'confirmed' WHERE id = '${oid}';`, { expectError: true }), /parcel_not_ready/)
    assert.match(sr(`UPDATE public.orders SET status = 'cancelled' WHERE id = '${oid}';`, { expectError: true }), /parcel_cancel_requires_not_found/)
    sr(`UPDATE public.parcel_requests SET status = 'found', last_actor = 'kitchen:boss' WHERE order_id = '${oid}';`)
    assert.equal(sr(`UPDATE public.orders SET status = 'confirmed' WHERE id = '${oid}' AND status = 'received' RETURNING status;`), 'confirmed')
    const [x] = cashOrder('cash')
    assert.equal(sr(`UPDATE public.orders SET status = 'cancelled' WHERE id = '${x}' RETURNING status;`), 'cancelled')
    // an online order can be cancelled by the kitchen (status only); its payment stays on record for a refund
    const f = finalize(paidIntent(snap({ phone: nextPhone() })).id)
    assert.equal(sr(`UPDATE public.orders SET status = 'cancelled' WHERE id = '${f[1]}' RETURNING status;`), 'cancelled')
    assert.equal(sr("SELECT count(*) FROM public.orders WHERE payment_method IN ('cash','credit','cibus','bit');") > 0, true)
  })
  await test('T18', 'all 8 Production function bodies unchanged after install and use', () => {
    assert.equal(psql(`SELECT string_agg(proname || '=' || md5(prosrc), ',' ORDER BY proname) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = ANY (ARRAY[${Object.keys(sources).map(lit).join(',')}]);`), fpBefore)
    assert.equal(val("SELECT md5(prosrc) || '/' || length(prosrc) FROM pg_proc WHERE oid = 'public.create_order(jsonb, jsonb, jsonb)'::regprocedure;"), PROD.create_order)
  })
  await test('T19d', 'rollback with payment evidence present is refused; nothing changes', () => {
    const n = count('public.payment_transactions')
    assert.match(psql(`SET hyp05.confirm_rollback = 'DROP-PAYMENT-INTENTS';\n${read('hyp05_rollback.sql')}`, { expectError: true }), /payment evidence exists/)
    assert.equal(count('public.payment_transactions'), n); allPass(verifyRows(), 'verify')
  })
  await test('T20d', 'coordinator privileges are exactly the derived column set (no table-level grant on existing tables)', () => {
    const got = psql(`SELECT string_agg(table_name || '.' || privilege_type || '(' || cols || ')', ' ' ORDER BY table_name, privilege_type) FROM (
      SELECT table_name, privilege_type, string_agg(column_name, ',' ORDER BY column_name) AS cols FROM information_schema.column_privileges
       WHERE grantee = 'hyp_payment_coordinator' AND table_name IN ('orders', 'order_items', 'deliveries', 'parcel_requests', 'parcel_events')
       GROUP BY 1, 2) s;`)
    assert.equal(got, [
      'deliveries.INSERT(address,apartment,city,delivery_fee,delivery_lat,delivery_lng,entrance,floor,geo_precision,geo_source,house_number,meal_quantity,meal_surcharge,notes,order_id,street)',
      'order_items.INSERT(item_id,notes,order_id,quantity,unit_price)',
      'orders.INSERT(branch_id,customer_name,daily_number,payment_method,phone,status,total_price,type)',
      'orders.SELECT(branch_id,created_at,daily_number,id,order_number,payment_method,status,total_price,type)',
      'orders.UPDATE(updated_at)',
      'parcel_events.INSERT(actor,from_status,order_id,parcel_id,to_status)',
      'parcel_requests.INSERT(branch_id,carrier,last_actor,order_id,recipient_name,tracking_ref)',
      'parcel_requests.SELECT(branch_id,status,tracking_key)'].join(' '))
    assert.equal(val("SELECT count(*) FROM information_schema.table_privileges WHERE grantee = 'hyp_payment_coordinator' AND table_name IN ('orders', 'order_items', 'deliveries', 'parcel_requests', 'parcel_events');"), '0')
    assert.equal(val("SELECT string_agg(p.proname, ',' ORDER BY p.proname) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND has_function_privilege('hyp_payment_coordinator', p.oid, 'EXECUTE') AND p.proname IN ('create_order', 'create_order_with_parcel', 'claim_maale_dispatch');"), 'create_order,create_order_with_parcel')
  })
} finally {
  docker(['rm', '-f', NAME])
}

const failed = results.filter(r => r[1] === 'FAIL')
console.log(`\n${results.length - failed.length}/${results.length} PASS${failed.length ? ` — FAILED: ${failed.map(r => r[0]).join(', ')}` : ''}`)
process.exit(failed.length ? 1 : 0)
