// Static checks for S4-INTEGRATIONS-04E1/04E2 — atomic courier coordination (db/migrations/s4_04e_*.sql) and the
// version-aware combined verify (db/migrations/s4_04_combined_verify.sql).
// Pure — no DB, no network. Behaviour (incl. repeated real concurrency trials) is tested on a disposable PostgreSQL
// (--network none) by scripts/pgtest-s4-04e-courier-coordination.mjs (needs Docker). Run: node scripts/verify-s4-04e-sql.mjs

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = rel => readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
const md5 = s => createHash('md5').update(s, 'utf8').digest('hex')
const MIG = read('db/migrations/s4_04e_courier_coordination.sql')
const PRE = read('db/migrations/s4_04e_production_preflight.sql')
const VER = read('db/migrations/s4_04e_verify.sql')
const RB = read('db/migrations/s4_04e_rollback.sql')
const CV = read('db/migrations/s4_04_combined_verify.sql')
const code = s => s.replace(/--.*$/gm, '')
const stmts = s => code(s).replace(/'(?:[^']|'')*'/g, "''")
const body = tag => { const t = `$${tag}$`, a = MIG.indexOf(t) + t.length; return MIG.slice(a, MIG.indexOf(t, a)) }
const head = (name, tag) => MIG.slice(MIG.indexOf(`CREATE FUNCTION public.${name}`), MIG.indexOf(`$${tag}$`))
const LOCK = 'pg_catalog.pg_advisory_xact_lock(1296122189, pg_catalog.hashtext(p_order_id::text))'
const COORD = 'maale_dispatch_coordinator'
const SIG = { claim: 'claim_maale_dispatch(uuid, integer, timestamptz)', record: 'record_maale_reconciliation_event(uuid, uuid, text, text, text, text, text)' }

let passed = 0
const test = (name, fn) => { fn(); passed++; console.log('  ✓', name) }
console.log('S4-04E courier coordination — SQL files')

test('1. migration: review-only, manual, one transaction with timeouts, preflight → objects → post-check; requires 04B + 04D', () => {
  assert.match(MIG, /REVIEW ONLY — NOT EXECUTED/)
  const c = code(MIG)
  assert.match(c, /^BEGIN;/m); assert.match(c, /^COMMIT;\s*$/m)
  assert.ok(c.includes("SET LOCAL lock_timeout = '5s';") && c.includes("SET LOCAL statement_timeout = '60s';"))
  assert.ok(c.indexOf('$s4_04e_preflight$') < c.indexOf('CREATE ROLE') && c.lastIndexOf('$s4_04e_postcheck$') > c.lastIndexOf('CREATE FUNCTION'))
  assert.ok(c.includes('S4-04B (quote rate limit) is not installed') && c.includes('S4-04D (reconciliation ledger with request_id) is not installed'))
  assert.ok(c.includes('already exist (no silent re-apply)') && c.includes('cannot create the BYPASSRLS coordinator role'))
  // 04F2: PostgreSQL >= 16 required — the FIRST preflight check, before any object is created; the PG16-only GRANT
  // options exist only inside dynamic SQL, so an older server parses the script and stops at this clear message.
  const guard = "IF pg_catalog.current_setting('server_version_num')::integer < 160000 THEN"
  assert.ok(c.indexOf(guard) > c.indexOf('$s4_04e_preflight$') && c.indexOf(guard) < c.indexOf('S4-04B (quote rate limit) is not installed') && c.indexOf(guard) < c.indexOf('CREATE ROLE'))
  assert.ok(c.includes('PostgreSQL 16 or newer is required'))
  assert.ok(!/WITH\s+(INHERIT|SET)\b/i.test(stmts(MIG)), 'no PG16-only GRANT option outside the dynamic string')
  assert.ok(PRE.includes("current_setting('server_version_num')::integer >= 160000"), 'preflight row 12 FAILs below 16')
})

test('2. dedicated role: NOLOGIN NOINHERIT BYPASSRLS, nothing else; least-privilege grants; transient CREATE revoked; no app role member', () => {
  const s = stmts(MIG)
  assert.ok(s.includes(`CREATE ROLE ${COORD} NOLOGIN NOINHERIT BYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;`))
  // the installer only (dynamic name: the literal CURRENT_USER role spec crashes the Supabase image), SET without INHERIT
  assert.ok(code(MIG).includes(`EXECUTE format('GRANT ${COORD} TO %I WITH INHERIT FALSE, SET TRUE', current_user);`))
  assert.ok(!/GRANT\s+maale_dispatch_coordinator\s+TO\s+(service_role|anon|authenticated|PUBLIC|CURRENT_USER)/i.test(code(MIG)))
  // 04E3: column-level least privilege (no customer column of orders; no id / created_at / dispatched_at / provider writes)
  assert.deepEqual([...s.matchAll(/^GRANT ([^;]+);/gm)].map(m => m[1].replace(/\s+/g, ' ')), [
    `SELECT (order_id, status, attempts, last_attempt_at, error_code, provider_order_id), UPDATE (status, attempts, last_attempt_at, error_code, updated_at) ON public.delivery_dispatches TO ${COORD}`,
    `SELECT ON public.maale_dispatch_reconciliations TO ${COORD}`,
    `INSERT (request_id, order_id, event_type, actor_username, provider_order_id, provider_status, reason_code) ON public.maale_dispatch_reconciliations TO ${COORD}`,
    `SELECT (id) ON public.orders TO ${COORD}`,
    `USAGE ON SCHEMA public TO ${COORD}`,
    `CREATE ON SCHEMA public TO ${COORD}`,
    `EXECUTE ON FUNCTION public.${SIG.claim} TO service_role`,
    `EXECUTE ON FUNCTION public.${SIG.record} TO service_role`])
  const i = t => { const n = s.indexOf(t); assert.ok(n > 0, t); return n }
  // CREATE is held only around the two ownership transfers
  assert.ok(i(`GRANT CREATE ON SCHEMA public TO ${COORD};`) < i(`ALTER FUNCTION public.${SIG.claim} OWNER TO ${COORD};`)
    && i(`ALTER FUNCTION public.${SIG.record} OWNER TO ${COORD};`) < i(`REVOKE CREATE ON SCHEMA public FROM ${COORD};`))
  // ACL is set while the installer still owns the function; ownership moves last
  for (const f of [SIG.claim, SIG.record])
    assert.ok(i(`REVOKE ALL ON FUNCTION public.${f} FROM PUBLIC, anon, authenticated, service_role;`) < i(`GRANT EXECUTE ON FUNCTION public.${f} TO service_role;`)
      && i(`GRANT EXECUTE ON FUNCTION public.${f} TO service_role;`) < i(`ALTER FUNCTION public.${f} OWNER TO ${COORD};`), f)
  assert.ok(code(MIG).includes("has_schema_privilege('maale_dispatch_coordinator', 'public', 'CREATE')"), 'post-check: no CREATE left')
  assert.ok(code(MIG).includes("pg_has_role('service_role', 'maale_dispatch_coordinator', 'MEMBER')"), 'post-check: no app-role membership')
  assert.ok(code(MIG).includes("r.rolname IN ('authenticator', 'service_role', 'anon', 'authenticated')"), 'post-check: authenticator never a member')
  assert.ok(code(MIG).includes("has_column_privilege('maale_dispatch_coordinator', 'public.orders', 'phone', 'SELECT')"), 'post-check: no customer columns')
  // the column lists cover exactly what the function bodies use (the bodies are pinned below)
  const used = b => [...new Set([...code(body(b)).matchAll(/\bd\.(\w+)/g)].map(m => m[1]))].sort()
  assert.deepEqual([...new Set([...used('claim_maale_dispatch'), ...used('record_maale_reconciliation_event')])].sort(),
    ['attempts', 'error_code', 'last_attempt_at', 'order_id', 'provider_order_id', 'status'])
})

test('3. additive: 3 functions, 1 trigger, 1 role; no table / constraint / row change; no DML outside function bodies', () => {
  const s = stmts(MIG)
  assert.equal((s.match(/^CREATE FUNCTION/gm) || []).length, 3); assert.equal((s.match(/^CREATE TRIGGER/gm) || []).length, 1)
  assert.equal((s.match(/^CREATE ROLE/gm) || []).length, 1)
  assert.ok(!/^\s*(ALTER TABLE|DROP|TRUNCATE|DELETE|CREATE TABLE|CREATE INDEX|ALTER ROLE)\b/im.test(s))
  assert.deepEqual([...s.matchAll(/^ALTER (\w+) ([^ ]+)/gm)].map(m => `${m[1]} ${m[2]}`), [`FUNCTION public.${SIG.claim.split('(')[0]}(uuid,`, `FUNCTION public.${SIG.record.split('(')[0]}(uuid,`])
  assert.ok(!/^\s*(INSERT|UPDATE)\b/im.test(s.replace(/^GRANT [^;]+;/gm, '').replace(new RegExp(`\\$(claim_maale_dispatch|record_maale_reconciliation_event)\\$[^]*?\\$\\1\\$`, 'g'), '')), 'DML only inside the function bodies')
  assert.ok(s.includes('REVOKE INSERT ON public.maale_dispatch_reconciliations FROM service_role;'))
  assert.ok(s.includes('REVOKE ALL ON FUNCTION public.delivery_dispatches_coordination_guard() FROM PUBLIC, anon, authenticated, service_role;'))
  assert.ok(!/set_config|maale_coordinated_claim/.test(code(MIG)), 'no writable-setting marker (04E1 residual removed)')
})

test('4. claim: DEFINER, search_path \'\', lock_timeout 3s; lock first; ledger checks; only pending/0; CAS UPDATE', () => {
  const h = head('claim_maale_dispatch', 'claim_maale_dispatch'), b = code(body('claim_maale_dispatch'))
  for (const x of ['RETURNS text', 'LANGUAGE plpgsql', 'VOLATILE', 'SECURITY DEFINER', "SET search_path = ''", "SET lock_timeout = '3s'"]) assert.ok(h.includes(x), x)
  assert.ok(!/EXECUTE\s|format\(|quote_|dblink/i.test(b), 'no dynamic SQL')
  for (const m of b.matchAll(/(?<!DISTINCT )\b(?:FROM|INTO|UPDATE|JOIN)\s+([a-z_][\w.]*)/gi)) {
    if (/^[vp]_/.test(m[1])) continue
    assert.ok(m[1].startsWith('public.'), `unqualified relation: ${m[1]}`)
  }
  const i = t => { const n = b.indexOf(t); assert.ok(n > 0, t); return n }
  assert.ok(i(LOCK) < i("r.event_type = 'manual_courier'") && i("r.event_type = 'manual_courier'") < i("'manual_review_opened'") && i("'manual_review_opened'") < i('FOR UPDATE'))
  assert.ok(b.includes("IF v_status IS DISTINCT FROM 'pending' OR v_attempts IS DISTINCT FROM 0 OR v_last IS NOT NULL THEN"))
  assert.ok(b.includes('AND d.last_attempt_at IS NOT DISTINCT FROM p_seen_last_attempt_at') && b.includes("WHERE d.order_id = p_order_id AND d.status = 'pending' AND d.attempts = p_seen_attempts"))
  const results = [...new Set([...b.matchAll(/RETURN '([a-z_]+)'/g), ...b.matchAll(/THEN '([a-z_]+)' ELSE '([a-z_]+)'/g)].flatMap(m => m.slice(1)).filter(Boolean))].sort()
  assert.deepEqual(results, ['claim_lost', 'claimed', 'dispatch_row_missing', 'invalid_request', 'manual_courier_recorded', 'manual_review_open', 'not_claimable'])
  assert.ok(!/DELETE|INSERT|maale_dispatch_requests|http/i.test(b))
})

test('5. record: DEFINER, search_path \'\', fully qualified, same lock before idempotency; manual courier gating', () => {
  const h = head('record_maale_reconciliation_event', 'record_maale_reconciliation_event'), b = code(body('record_maale_reconciliation_event'))
  for (const x of ['RETURNS TABLE (result text, event_id uuid, event_created_at timestamptz)', 'SECURITY DEFINER', "SET search_path = ''", "SET lock_timeout = '3s'"]) assert.ok(h.includes(x), x)
  assert.ok(!/EXECUTE\s|format\(|quote_|dblink/i.test(b))
  for (const m of b.matchAll(/(?<!DISTINCT )\b(?:FROM|INTO|UPDATE|JOIN)\s+([a-z_][\w.]*)/gi)) {
    if (/^[vp]_/.test(m[1])) continue // plpgsql variables (SELECT … INTO v_x) and parameters
    assert.ok(m[1].startsWith('public.'), `unqualified relation: ${m[1]}`)
  }
  const i = t => { const n = b.indexOf(t); assert.ok(n > 0, t); return n }
  assert.ok(i(LOCK) < i('WHERE r.request_id = p_request_id') && i('WHERE r.request_id = p_request_id') < i('INSERT INTO public.maale_dispatch_reconciliations'))
  assert.ok(i("RETURN QUERY SELECT 'invalid_request'") < i(LOCK), 'input validated before the lock')
  assert.ok(b.includes("IF v_status IN ('sending', 'sent') THEN") && b.includes("'dispatch_active'") && b.includes("'dispatch_outcome_unknown'"))
  assert.ok(b.includes("'zone_unknown', 'out_of_area', 'amount_too_high', 'dispatch_closed',") && !/'idempotency_mismatch'|'unexpected_quote_response'|'timeout'/.test(b), 'only definitive rejections allow a manual courier')
  assert.ok(!/\bUPDATE\b|\bDELETE\b/i.test(b), 'never updates / deletes ledger entries')
  assert.ok(b.includes('EXCEPTION WHEN unique_violation THEN'))
  const results = [...new Set([...b.matchAll(/SELECT '([a-z_]+)'::text/g)].map(m => m[1]))].sort()
  assert.deepEqual(results, ['already_recorded', 'dispatch_active', 'dispatch_outcome_unknown', 'invalid_request', 'no_dispatch_attempt', 'no_dispatch_record', 'order_not_found', 'provider_order_mismatch', 'recorded', 'request_id_conflict'])
})

test('6. guard trigger: INVOKER; pending-only inserts, sent immutable, leaving pending only as the coordinator (current_user)', () => {
  const h = MIG.slice(MIG.indexOf('CREATE FUNCTION public.delivery_dispatches_coordination_guard'), MIG.indexOf('$delivery_dispatches_coordination_guard$'))
  assert.ok(h.includes('SECURITY INVOKER') && h.includes("SET search_path = ''"))
  const b = code(body('delivery_dispatches_coordination_guard'))
  assert.ok(b.includes("IF NEW.status IS DISTINCT FROM 'pending' OR NEW.attempts IS DISTINCT FROM 0 THEN"))
  assert.ok(b.includes("IF OLD.status = 'sent' THEN"))
  assert.ok(b.includes("AND current_user IS DISTINCT FROM 'maale_dispatch_coordinator' THEN") && !/current_setting|session_user/.test(b))
  assert.ok(code(MIG).includes('BEFORE INSERT OR UPDATE ON public.delivery_dispatches\n  FOR EACH ROW EXECUTE FUNCTION public.delivery_dispatches_coordination_guard();'))
})

test('7. verify + combined verify pin all three function bodies (LF and CRLF) — kept in sync with the migration file', () => {
  for (const tag of ['claim_maale_dispatch', 'record_maale_reconciliation_event', 'delivery_dispatches_coordination_guard']) {
    const lf = body(tag), crlf = lf.replace(/\n/g, '\r\n')
    for (const [name, f] of [['verify', VER], ['combined', CV]]) {
      assert.ok(f.includes(`h = '${md5(lf)}' AND len = ${[...lf].length}`), `${name} ${tag} LF ${md5(lf)}/${[...lf].length}`)
      assert.ok(f.includes(`h = '${md5(crlf)}' AND len = ${[...crlf].length}`), `${name} ${tag} CRLF`)
    }
  }
  const b4 = read('db/migrations/s4_04b_verify.sql').match(/h = '([0-9a-f]{32})' AND len = (\d+)\) OR \(h = '([0-9a-f]{32})' AND len = (\d+)/)
  assert.ok(b4 && CV.includes(`(h = '${b4[1]}' AND len = ${b4[2]}) OR (h = '${b4[3]}' AND len = ${b4[4]})`), 'combined uses the 04B verify fingerprints')
})

test('8. preflight / verify / combined: read-only single SELECTs; survive missing objects (OID-form / guarded checks)', () => {
  for (const [name, f, n] of [['preflight', PRE, 12], ['verify', VER, 16], ['combined', CV, 20]]) {
    assert.ok(!/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|REVOKE|TRUNCATE|BEGIN|COMMIT)\b/i.test(stmts(f)), name)
    assert.match(f, /READ-ONLY, ONE SELECT/)
    assert.equal(new Set([...code(f).matchAll(/SELECT '(\d\d)', '/g)].map(m => m[1])).size, n, `${name}: ${n} checks`)
  }
  for (const [name, f] of [['preflight', PRE], ['combined', CV]]) {
    assert.ok(!/has_table_privilege\('\w+', 'public\./.test(f), `${name}: no text-form privilege check that would error on a missing table`)
    assert.ok(!/pg_has_role\('\w+', 'maale_dispatch_coordinator'/.test(f), `${name}: no role-name lookup that errors when the role is missing`)
  }
  // every data query in the combined verify is guarded by a to_regclass CASE
  assert.equal((code(CV).match(/query_to_xml\(/g) || []).length, (code(CV).match(/ELSE \(xpath\('\/row\/c\/text\(\)', query_to_xml\(/g) || []).length)
  assert.ok(VER.includes("t.tgenabled = 'O'") && VER.includes("prosecdef AND proconfig = ARRAY['search_path=\"\"', 'lock_timeout=3s']"))
})

test('9. combined verify: version-aware (pre / post / partial / incomplete), stage-specific ACLs, no ignored rows', () => {
  const c = code(CV)
  assert.ok(c.includes("WHEN e_objects = 0 THEN 'pre_04e' WHEN e_objects = 5 THEN 'post_04e' ELSE 'partial_04e' END"))
  assert.ok(c.includes("(SELECT s FROM stage) IN ('pre_04e', 'post_04e')"))
  assert.ok(c.includes("'maale_dispatch_coordinator:SELECT,service_role:SELECT'") && c.includes("ELSE 'service_role:INSERT,service_role:SELECT' END"))
  assert.ok(c.includes("has_any_column_privilege('authenticated', to_regclass('public.maale_dispatch_reconciliations'), 'INSERT')"), 'no direct routine INSERT (table- or column-level) for any app role')
  assert.match(c, /CASE WHEN ok IS NULL THEN 'INFO' WHEN ok THEN 'PASS' ELSE 'FAIL' END/)
  assert.equal((c.match(/, NULL,\n/g) || []).length, 1, 'only row 20 is INFO')
  assert.ok(!/s4_04d_verify|ignore/i.test(c), 'does not reference / ignore the per-migration verifies')
})

test('10. rollback: manual, approval-only, exact objects, drops the role cleanly, restores the 04D INSERT grant, never drops data', () => {
  assert.match(RB, /MANUAL ONLY, NEVER RUN WITHOUT SEPARATE EXPLICIT OWNER APPROVAL/); assert.match(RB, /PRIMARY ROLLBACK PLAN IS THE APPLICATION/)
  const c = code(RB)
  assert.ok(c.includes("current_setting('s4_04e.confirm_rollback', true) IS DISTINCT FROM 'DROP-COURIER-COORDINATION'"))
  assert.deepEqual([...c.matchAll(/^DROP (\w+) ([\w.]+)/gm)].map(m => `${m[1]} ${m[2]}`),
    ['TRIGGER delivery_dispatches_coordination_guard', 'FUNCTION public.delivery_dispatches_coordination_guard', 'FUNCTION public.claim_maale_dispatch',
      'FUNCTION public.record_maale_reconciliation_event', `ROLE ${COORD}`])
  assert.ok(c.indexOf(`REVOKE ALL ON SCHEMA public FROM ${COORD};`) < c.indexOf(`DROP ROLE ${COORD};`))
  assert.ok(c.indexOf(`REVOKE ALL ON public.delivery_dispatches, public.maale_dispatch_reconciliations, public.orders FROM ${COORD};`) < c.indexOf(`DROP ROLE ${COORD};`))
  assert.ok(c.includes('GRANT INSERT ON public.maale_dispatch_reconciliations TO service_role;'))
  assert.ok(c.includes('coordinator-owned objects') && !/CASCADE|DROP TABLE|DELETE|TRUNCATE|REASSIGN|DROP OWNED/i.test(c))
})

const walk = dir => readdirSync(dir).flatMap(n => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p] })
test('11. not auto-run; README lists 04E + combined verify; runtime calls only the two RPCs; no marker; test is isolated', () => {
  assert.ok(!/s4_04e|s4_04_combined|pgtest-s4-04e|migrations/.test(read('package.json')))
  const readme = read('db/migrations/README.md')
  for (const f of ['s4_04e_courier_coordination.sql', 's4_04e_rollback.sql', 's4_04_combined_verify.sql', 'maale_dispatch_coordinator']) assert.ok(readme.includes(f), f)
  const src = [...walk(join(ROOT, 'app')), ...walk(join(ROOT, 'lib'))].filter(p => /\.(tsx?|jsx?)$/.test(p)).map(p => [p, readFileSync(p, 'utf8')])
  for (const [p, t] of src) {
    assert.ok(!/maale_coordinated_claim|maale_dispatch_coordinator|set_config/.test(t), p)
    assert.ok(!/from\(\s*['"]maale_dispatch_reconciliations['"]\s*\)\s*\.insert/.test(t.replace(/\s+/g, ' ')), `${p}: direct ledger insert`)
  }
  const all = src.map(x => x[1]).join('\n')
  assert.ok(/rpc\(\s*['"]claim_maale_dispatch['"]/.test(all) && /rpc\(\s*['"]record_maale_reconciliation_event['"]/.test(all))
  const pg = read('scripts/pgtest-s4-04e-courier-coordination.mjs').replace(/^\s*\/\/.*$/gm, '')
  assert.ok(pg.includes("'--network', 'none'"))
  assert.ok(!/readFileSync\([^)\n]*env|['"`][^'"`\n]*\.env|loadEnvLocal|SUPABASE_|MAALE_|createClient|supabase-js/.test(pg))
})

console.log(`\nAll ${passed} S4-04E SQL checks passed.`)
