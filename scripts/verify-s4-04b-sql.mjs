// Static checks for S4-INTEGRATIONS-04B1 — durable quote rate limiter (db/migrations/s4_04b_*.sql).
// Pure — no DB, no network. Behaviour on a disposable PostgreSQL (--network none) is tested separately by
// scripts/pgtest-s4-04b-quote-rate-limit.mjs (needs Docker). Run: node scripts/verify-s4-04b-sql.mjs

import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = rel => readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
const md5 = s => createHash('md5').update(s, 'utf8').digest('hex')
const MIG = read('db/migrations/s4_04b_maale_quote_rate_limit.sql')
const PRE = read('db/migrations/s4_04b_production_preflight.sql')
const VER = read('db/migrations/s4_04b_verify.sql')
const RB = read('db/migrations/s4_04b_rollback.sql')
const code = s => s.replace(/--.*$/gm, '') // SQL without line comments

let passed = 0
const test = (name, fn) => { fn(); passed++; console.log('  ✓', name) }
console.log('S4-04B quote rate limiter — SQL files')

test('1. migration is manual, review-only, one transaction with timeouts, preflight and post-check', () => {
  assert.match(MIG, /REVIEW ONLY — NOT EXECUTED/)
  const c = code(MIG)
  assert.match(c, /^BEGIN;/m); assert.match(c, /^COMMIT;\s*$/m)
  assert.ok(c.includes("SET LOCAL lock_timeout = '5s';") && c.includes("SET LOCAL statement_timeout = '60s';"))
  assert.ok(c.indexOf('$s4_04b_preflight$') < c.indexOf('CREATE TABLE') && c.indexOf('$s4_04b_postcheck$') > c.indexOf('CREATE FUNCTION'))
  assert.match(c, /already exists \(no silent re-apply\)/)
})

test('2. additive only: no ALTER / DROP / UPDATE / DELETE / TRUNCATE of existing objects; delivery_dispatches untouched', () => {
  const c = code(MIG)
  // Statements only (privilege names inside has_table_privilege(...) are not statements).
  assert.ok(!/^\s*(DROP|TRUNCATE|DELETE|UPDATE)\b/im.test(c), 'no destructive / data-changing statement')
  assert.deepEqual([...c.matchAll(/ALTER TABLE ([\w.]+)/g)].map(m => m[1]), ['public.maale_dispatch_requests'])
  const stmts = c.replace(/'(?:[^']|'')*'/g, "''") // string literals (e.g. COMMENT ON text) may name the table it never touches
  assert.ok(!/delivery_dispatches/.test(stmts), 'no reference to delivery_dispatches in executable SQL')
  assert.ok(!/INSERT INTO public\.(orders|branches)/.test(c))
})

test('3. ledger: exact columns, FKs RESTRICT, kitchen-username CHECK, no customer-data columns', () => {
  const t = code(MIG).slice(code(MIG).indexOf('CREATE TABLE public.maale_dispatch_requests'), code(MIG).indexOf('CREATE INDEX'))
  for (const col of ['id             uuid        NOT NULL DEFAULT gen_random_uuid()', 'order_id       uuid        NOT NULL',
    'branch_id      uuid        NOT NULL', 'actor_username text        NOT NULL', 'created_at     timestamptz NOT NULL DEFAULT now()'])
    assert.ok(t.includes(col), col)
  assert.ok(t.includes('REFERENCES public.orders (id) ON UPDATE RESTRICT ON DELETE RESTRICT'))
  assert.ok(t.includes('REFERENCES public.branches (id) ON UPDATE RESTRICT ON DELETE RESTRICT'))
  assert.ok(t.includes("CHECK (actor_username ~ '^[a-z0-9_-]{2,32}$')"))
  assert.ok(!/phone|customer|address|name_he|total|price|payload|provider/i.test(t.replace(/actor_username/g, '')))
  // Same rule as the kitchen login (lib/kitchenAuth USERNAME_REGEX).
  assert.ok(read('lib/kitchenAuth.ts').includes('const USERNAME_REGEX = /^[a-z0-9_-]{2,32}$/'))
})

test('4. privileges: RLS on, reset then service_role SELECT+INSERT only; function EXECUTE service_role only', () => {
  const c = code(MIG)
  assert.ok(c.includes('ALTER TABLE public.maale_dispatch_requests ENABLE ROW LEVEL SECURITY;'))
  assert.ok(!/CREATE POLICY/i.test(c))
  assert.ok(c.includes('REVOKE ALL ON public.maale_dispatch_requests FROM PUBLIC, anon, authenticated, service_role;'))
  assert.ok(c.includes('GRANT SELECT, INSERT ON public.maale_dispatch_requests TO service_role;'))
  assert.equal((c.match(/^GRANT /gm) || []).length, 2, 'exactly two GRANTs')
  assert.ok(c.includes('REVOKE ALL ON FUNCTION public.consume_maale_quote_slot(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;'))
  assert.ok(c.includes('GRANT EXECUTE ON FUNCTION public.consume_maale_quote_slot(uuid, uuid, text) TO service_role;'))
})

test('5. function: INVOKER, search_path \'\', lock_timeout 3s, no dynamic SQL, one xact advisory lock, DB time, bounded results', () => {
  const tag = '$consume_maale_quote_slot$'
  const head = MIG.slice(MIG.indexOf('CREATE FUNCTION public.consume_maale_quote_slot'), MIG.indexOf(tag))
  for (const s of ['RETURNS text', 'LANGUAGE plpgsql', 'VOLATILE', 'SECURITY INVOKER', "SET search_path = ''", "SET lock_timeout = '3s'"]) assert.ok(head.includes(s), s)
  assert.ok(!/SECURITY DEFINER/.test(code(MIG)))
  const body = code(MIG.slice(MIG.indexOf(tag) + tag.length, MIG.lastIndexOf(tag)))
  assert.ok(!/EXECUTE\s|format\(|quote_|dblink|COPY\s/i.test(body), 'no dynamic SQL')
  assert.equal((body.match(/pg_advisory_xact_lock\(1296122188, 1\)/g) || []).length, 1)
  assert.ok(!/pg_advisory_lock\(|pg_try_advisory/.test(body), 'transaction-scoped only (no session lock leaks)')
  assert.ok(body.indexOf('pg_advisory_xact_lock') < body.indexOf('clock_timestamp()'), 'time read after the lock')
  assert.ok(body.indexOf('branch_mismatch') < body.indexOf('pg_advisory_xact_lock'), 'order / branch validated before the lock')
  const results = [...body.matchAll(/RETURN '([a-z_]+)'/g)].map(m => m[1]).sort()
  assert.deepEqual(results, ['branch_limit', 'branch_mismatch', 'global_limit', 'invalid_request', 'ok', 'order_limit', 'order_not_found'])
  assert.ok(body.includes("interval '30 minutes') >= 3") && body.includes("interval '60 minutes') >= 20") && (body.match(/interval '60 minutes'\) >= 40/g) || []).length === 1)
  assert.equal((body.match(/INSERT INTO public\.maale_dispatch_requests/g) || []).length, 1)
  assert.ok(body.lastIndexOf('INSERT INTO') > body.lastIndexOf("RETURN 'global_limit'"), 'insert only after every limit passed')
  assert.ok(!/UPDATE|DELETE|orders\s+SET|delivery_dispatches|http|fetch/i.test(body))
})

test('6. verify row 11 pins the exact function body (LF and CRLF forms) — kept in sync with the migration file', () => {
  const tag = '$consume_maale_quote_slot$'
  const lf = MIG.slice(MIG.indexOf(tag) + tag.length, MIG.indexOf(tag, MIG.indexOf(tag) + tag.length))
  const crlf = lf.replace(/\n/g, '\r\n')
  assert.ok(VER.includes(`h = '${md5(lf)}' AND len = ${[...lf].length}`), `LF ${md5(lf)} / ${[...lf].length}`)
  assert.ok(VER.includes(`h = '${md5(crlf)}' AND len = ${[...crlf].length}`), `CRLF ${md5(crlf)} / ${[...crlf].length}`)
})

test('7. preflight and verify are read-only single SELECTs with PASS / FAIL / INFO rows', () => {
  for (const [name, f, rows] of [['preflight', PRE, 10], ['verify', VER, 14]]) {
    const c = code(f)
    const stmts = c.replace(/'(?:[^']|'')*'/g, "''") // privilege names / expected definitions are compared as strings
    assert.ok(!/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|REVOKE|TRUNCATE|BEGIN|COMMIT)\b/i.test(stmts), name)
    assert.match(f, /READ-ONLY, ONE SELECT/)
    assert.equal(new Set([...c.matchAll(/SELECT '(\d\d)', '/g)].map(m => m[1])).size, rows, `${name}: ${rows} checks`)
    assert.ok(c.includes("CASE WHEN ok IS NULL THEN 'INFO' WHEN ok THEN 'PASS' ELSE 'FAIL' END"))
  }
  assert.ok(!/customer_name|phone|actor_username\s*,|order_id\s*,\s*actor/.test(code(VER).replace(/attname = '\w+'/g, '')), 'verify prints no ids / names')
})

test('8. rollback: manual, approval-only, explicit confirmation, exact objects only, no CASCADE, post-check', () => {
  assert.match(RB, /MANUAL ONLY, NEVER RUN WITHOUT SEPARATE EXPLICIT OWNER APPROVAL/)
  assert.match(RB, /PRIMARY ROLLBACK PLAN IS THE APPLICATION/)
  const c = code(RB)
  assert.ok(c.includes("current_setting('s4_04b.confirm_rollback', true) IS DISTINCT FROM 'DROP-QUOTE-LEDGER'"))
  assert.ok(c.indexOf('$s4_04b_rollback_guard$') < c.indexOf('DROP FUNCTION'))
  assert.deepEqual([...c.matchAll(/^DROP (\w+) ([\w.]+)/gm)].map(m => `${m[1]} ${m[2]}`), ['FUNCTION public.consume_maale_quote_slot', 'TABLE public.maale_dispatch_requests'])
  assert.ok(!/CASCADE/i.test(c)); assert.ok(!/orders|branches|delivery_dispatches/.test(c.replace(/to_regclass\('public\.maale_dispatch_requests'\)/g, '')))
  assert.ok(c.includes('$s4_04b_rollback_postcheck$'))
})

test('9. nothing runs these files automatically (no package script, no app import); README lists them as prepared', () => {
  const pkg = read('package.json')
  assert.ok(!/s4_04b|pgtest-s4-04b|migrations/.test(pkg), 'no npm script runs migrations or the Docker test')
  const readme = read('db/migrations/README.md')
  assert.ok(readme.includes('s4_04b_maale_quote_rate_limit.sql') && readme.includes('s4_04b_rollback.sql'))
  const pg = read('scripts/pgtest-s4-04b-quote-rate-limit.mjs').replace(/^\s*\/\/.*$/gm, '') // code only
  assert.ok(pg.includes("'--network', 'none'"), 'Docker test container has no network')
  assert.ok(!/readFileSync\([^)\n]*env|['"`][^'"`\n]*\.env|loadEnvLocal|SUPABASE_|MAALE_|createClient|supabase-js/.test(pg), 'never reads .env files or credentials')
  assert.deepEqual([...pg.matchAll(/process\.env\.(\w+)/g)].map(m => m[1]), ['S4_04B_PG_IMAGE'], 'only the optional, non-secret image override')
})

console.log(`\nAll ${passed} S4-04B SQL checks passed.`)
