// Static checks for Migration 05 — optional parcel recipient name (GATE S4-PARCEL-30B): migration, read-only preflight /
// verify queries, the non-destructive function-only rollback, and their consistency with the application rules.
// Pure — no DB, no network. Behaviour on a throwaway local PostgreSQL is tested separately (S4-PARCEL-30B report).
// Run: node scripts/verify-parcel-05-sql.mjs

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const raw = rel => readFileSync(join(ROOT, rel), 'utf8')
const read = rel => raw(rel).replace(/\r\n/g, '\n')
const md5 = s => createHash('md5').update(s).digest('hex')
const sha256 = s => createHash('sha256').update(s).digest('hex')
function loadTs(rel, stubs = {}) {
  const { outputText } = ts.transpileModule(read(rel), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } })
  const mod = { exports: {} }
  new Function('exports', 'require', 'module', outputText)(mod.exports, p => stubs[p] ?? (p.startsWith('./') ? loadTs(`lib/${p.slice(2)}.ts`, stubs) : require(p)), mod)
  return mod.exports
}

const MIG = raw('db/migrations/parcel_05_recipient_name.sql')
const PRE = raw('db/migrations/parcel_05_production_preflight.sql')
const VER = raw('db/migrations/parcel_05_verify.sql')
const RB = raw('db/migrations/parcel_05_rollback.sql')
const BODY = MIG.match(/AS \$fn\$([\s\S]*?)\$fn\$/)[1]
const PRE05 = Buffer.from(RB.match(/decode\('([0-9a-f]+)', 'hex'\)/)[1], 'hex').toString('utf8')   // exact pre-05 Production body

let passed = 0
const test = (name, fn) => { fn(); passed++; console.log('  ✓', name) }
const code = s => s.replace(/--[^\n]*/g, '')   // SQL without comments

console.log('Migration 05 structure')
test('all Migration 05 files are LF (gitattributes eol=lf) and the migration is one transaction with lock / statement timeouts', () => {
  for (const [n, s] of [['migration', MIG], ['preflight', PRE], ['verify', VER], ['rollback', RB]]) assert.ok(!s.includes('\r'), n)
  assert.match(raw('.gitattributes'), /^db\/migrations\/\*\.sql text eol=lf$/m)
  assert.equal((MIG.match(/^BEGIN;$/gm) || []).length, 1); assert.equal((MIG.match(/^COMMIT;$/gm) || []).length, 1)
  assert.match(MIG, /SET LOCAL lock_timeout = '5s';/); assert.match(MIG, /SET LOCAL statement_timeout = '60s';/)
})
test('preflight guard: audited Production body (md5 7d491c09… / 2474), exact signature, INVOKER + search_path, no silent re-apply', () => {
  assert.match(MIG, /IF v_md5 IS DISTINCT FROM '7d491c097bf60b7e17beae25890b1238' OR v_len IS DISTINCT FROM 2474 THEN/)
  assert.match(MIG, /manual review required/)
  assert.match(MIG, /v_args IS DISTINCT FROM 'p_order jsonb, p_items jsonb, p_delivery jsonb, p_parcel jsonb'/)
  assert.match(MIG, /IF v_secdef OR v_cfg IS DISTINCT FROM ARRAY\['search_path=""'\] THEN/)
  assert.match(MIG, /recipient_name already exists \(no silent re-apply\)/)
  assert.match(MIG, /parcel_requests_recipient_name_format already exists/)
  assert.ok(MIG.indexOf('$parcel_05_preflight$;') < MIG.indexOf('ALTER TABLE public.parcel_requests ADD COLUMN'), 'guard runs first')
})
test('additive only: nullable column without default + named CHECK; no DROP / DELETE / UPDATE / TRUNCATE / data rewrite', () => {
  assert.match(MIG, /^ALTER TABLE public\.parcel_requests ADD COLUMN recipient_name text NULL;$/m)
  assert.match(MIG, /ADD CONSTRAINT parcel_requests_recipient_name_format CHECK \(\n  recipient_name IS NULL OR \(\n    char_length\(recipient_name\) BETWEEN 2 AND 60\n    AND recipient_name = btrim\(recipient_name\)\n    AND recipient_name !~ '\[\[:cntrl:\]\]'\n  \)\n\);/)
  const c = code(MIG)
  assert.ok(!/\bDROP\b|\bDELETE\b|\bTRUNCATE\b|\bUPDATE\s+public\./i.test(c), 'no destructive statements')
  assert.ok(!/ALTER TABLE (?!public\.parcel_requests ADD )/.test(c), 'only parcel_requests is altered, additively')
  assert.ok(!/ALTER COLUMN|SET DEFAULT|SET NOT NULL|ADD COLUMN recipient_name text (NOT NULL|DEFAULT)/i.test(c), 'no default / NOT NULL')
  assert.ok(!/customer_name/.test(c.replace(/COMMENT ON COLUMN[\s\S]*?;\n/, '')), 'orders.customer_name never touched (only documented)')
  assert.ok(!/\bUPDATE\b|INSERT INTO public\.orders/i.test(c), 'no write to orders')
})
test('same function identity: CREATE OR REPLACE, exact signature + result, VOLATILE, SECURITY INVOKER, search_path \'\'', () => {
  assert.match(MIG, /CREATE OR REPLACE FUNCTION public\.create_order_with_parcel\(\n  p_order    jsonb,\n  p_items    jsonb,\n  p_delivery jsonb,\n  p_parcel   jsonb\n\)\nRETURNS TABLE\(created_order_id uuid, created_order_number integer, created_daily_number integer\)\nLANGUAGE plpgsql\nVOLATILE\nSECURITY INVOKER\nSET search_path = ''\nAS \$fn\$/)
  assert.ok(!/SECURITY DEFINER/i.test(code(MIG)))
})
test('privileges never widened: only REVOKE from PUBLIC/anon/authenticated + GRANT EXECUTE to service_role', () => {
  const grants = code(MIG).match(/^(GRANT|REVOKE)[^\n]*$/gm)
  assert.deepEqual(grants, [
    'REVOKE ALL ON FUNCTION public.create_order_with_parcel(jsonb, jsonb, jsonb, jsonb) FROM PUBLIC, anon, authenticated;',
    'GRANT EXECUTE ON FUNCTION public.create_order_with_parcel(jsonb, jsonb, jsonb, jsonb) TO service_role;',
  ])
  assert.ok(!/POLICY|ROW LEVEL SECURITY|ON TABLE/i.test(code(MIG)), 'no RLS / table grant change')
})

console.log('New wrapper body = exact pre-05 Production body + approved edits only')
test('the rollback\'s embedded pre-05 body is the audited Production source (md5 7d491c09… / 2474)', () => {
  assert.equal(md5(PRE05), '7d491c097bf60b7e17beae25890b1238'); assert.equal(PRE05.length, 2474)
})
test('line diff pre-05 → 05 is exactly: +1 variable, key list, type check for recipient_name, NULLIF normalization, INSERT column', () => {
  const a = PRE05.replace(/\r\n/g, '\n').split('\n'), b = BODY.split('\n')
  const removed = a.filter(l => !b.includes(l)), added = b.filter(l => !a.includes(l))
  assert.deepEqual(removed, ["    WHERE k.key NOT IN ('tracking_ref', 'carrier')"])
  assert.deepEqual(added, [
    '  v_recipient    text;',
    "    WHERE k.key NOT IN ('tracking_ref', 'carrier', 'recipient_name')",
    "       p_parcel ? 'recipient_name'",
    "       AND jsonb_typeof(p_parcel -> 'recipient_name')",
    "  v_recipient := NULLIF(btrim(p_parcel ->> 'recipient_name'), '');",
    '    recipient_name,',
    '    v_recipient,',
  ])
  // net +9: variable (1) + "OR ( … recipient_name … NOT IN ('string', 'null') )" block (5) + NULLIF (1) + INSERT column / value (2)
  assert.equal(b.length - a.length, 9, 'only the approved lines were added')
  // atomicity preserved: still no exception handler, still one create_order call + one INSERT, P0002 unchanged
  assert.ok(!/EXCEPTION\s+WHEN/i.test(BODY))
  assert.equal((BODY.match(/FROM public\.create_order\(/g) || []).length, 1)
  assert.equal((BODY.match(/INSERT INTO public\.parcel_requests/g) || []).length, 1)
  assert.match(BODY, /'create_order_with_parcel: created order not visible'\n      USING ERRCODE = 'P0002';/)
})
test('post-check fingerprints are the real md5 / length of this body (LF as committed, CRLF if pasted on Windows)', () => {
  const lf = BODY, crlf = BODY.replace(/\n/g, '\r\n')
  assert.match(MIG, new RegExp(`v_md5 = '${md5(lf)}' AND v_len = ${lf.length}`))
  assert.match(MIG, new RegExp(`v_md5 = '${md5(crlf)}' AND v_len = ${crlf.length}`))
  for (const f of [VER, RB]) { assert.ok(f.includes(md5(lf)) && f.includes(String(lf.length))); assert.ok(f.includes(md5(crlf)) && f.includes(String(crlf.length))) }
})

console.log('Read-only preflight / verify')
test('preflight + verify are single read-only SELECTs (no writes, no DDL, no grants)', () => {
  for (const [n, s] of [['preflight', PRE], ['verify', VER]]) {
    const c = code(s).replace(/'(?:[^']|'')*'/g, "''")   // keywords only — string literals (privilege names, labels) removed
    assert.ok(!/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP|GRANT|REVOKE|COMMENT)\b/i.test(c), n)
    assert.equal((c.match(/;/g) || []).length, 1, `${n}: one statement`)
    assert.match(c, /^WITH\b/m)
    assert.ok(!/\b(tracking_ref|customer_name|phone|carrier)\b/i.test(c), `${n}: no personal data columns read`)
    assert.ok(!/SELECT\s+recipient_name|recipient_name\s*,/i.test(c), `${n}: never returns recipient names (counts only)`)
  }
  assert.match(PRE, /'7d491c097bf60b7e17beae25890b1238' AND len = 2474/)
  assert.match(VER, /convalidated AND def = 'CHECK \(\(\(recipient_name IS NULL\) OR \(\(\(char_length\(recipient_name\) >= 2\) AND \(char_length\(recipient_name\) <= 60\)\)/)
})

console.log('Rollback: function only, non-destructive, separately authorized')
test('rollback restores only the function body; never drops / updates the column, the rule or stored names', () => {
  const c = code(RB)
  assert.ok(!/\bDROP\b|\bDELETE\b|\bTRUNCATE\b|\bUPDATE\b|ALTER TABLE/i.test(c))
  assert.match(RB, /never run without separate explicit approval/)
  assert.match(RB, /PRIMARY ROLLBACK PLAN IS THE APPLICATION/)
  assert.match(RB, /PREREQUISITE: the application must already be rolled back/)
  assert.match(RB, /installed create_order_with_parcel is not the parcel_05 version/)   // refuses an unknown body
  assert.match(RB, /recipient_name column unexpectedly missing \(this script never drops it\)/)
  assert.match(RB, /SECURITY INVOKER SET search_path = %L AS %L', '', v_src\)/)
})

console.log('Consistency with the application')
test('app rules = DB rule (2–60, trimmed, no control chars); wire key recipient_name = whitelisted key; violation → invalid_parcel', () => {
  const PC = loadTs('lib/parcelCheckout.ts')
  assert.equal(PC.MIN_PARCEL_RECIPIENT_NAME, 2); assert.equal(PC.MAX_PARCEL_RECIPIENT_NAME, 60)
  assert.match(read('lib/createOrder.ts'), /\{ recipient_name: parcel\.recipientName \}/)
  assert.match(BODY, /WHERE k\.key NOT IN \('tracking_ref', 'carrier', 'recipient_name'\)/)
  const CO = loadTs('lib/createOrder.ts', { './supabaseServer': { getServerSupabase() {} } })
  assert.deepEqual(CO.classifyParcelRpcError({ code: '23514', message: 'new row for relation "parcel_requests" violates check constraint "parcel_requests_recipient_name_format"' }),
    { kind: 'rejected', reason: 'parcel_requests_recipient_name_format' })
  assert.equal(CO.classifyParcelRpcError({ code: '22023', message: 'create_order_with_parcel: invalid parcel field type' }).kind, 'rejected')
})
test('historical migrations untouched (byte-identical to their recorded SHA-256); their old wrapper pins documented', () => {
  const pinned = {
    'parcel_01_tables.sql': 'ffe7bb37d9ede6705ce44734bb1ed1a5bb872c0f9d33b5290187b463da7bfde7',
    'parcel_01b_insert_lock.sql': '10e99e64ed9f6c94ed8737d43a84bee935939e78f7c04e77d51fc9e07b77eee6',
    'parcel_01b_rollback.sql': '1c5a557bc6ee4184cd5ad6d13e4e459d4a5df2886e66b66140d05a46a985f1d2',
    'parcel_03_orders_gate.sql': 'fb5e99dee525d45a285a885f8c3ca7cadf472f215b31905df40af1fdd28f7ab4',
    'parcel_04_cancel_gate.sql': '5d3fa41bf2a4128e36cee69d63930155d498b1734fb13692447aaca83e092fd0',
    'parcel_04_verify.sql': 'f1e137257e4481f97a6b418d9244b37abcfc333d6c29a82689ed165dd7d0d41e',
    'parcel_04_rollback.sql': '7e09e49f91bc8f5524bcf1078c37fd96606bed7b950b99b783dc6f88e0eaf9e4',
    'parcel_04_production_preflight.sql': '64e595ac63f4636d3775a19f81b4589aa7b08186347dae5e23ae4526c6436573',
  }
  for (const [f, h] of Object.entries(pinned)) assert.equal(sha256(raw(`db/migrations/${f}`)), h, f)
  const readme = read('db/migrations/README.md')
  for (const f of ['parcel_03_production_preflight.sql', 'parcel_03_verify.sql', 'parcel_04_production_preflight.sql', 'parcel_04_verify.sql'])
    assert.ok(raw(`db/migrations/${f}`).includes('7d491c097bf60b7e17beae25890b1238') && readme.includes(f), f)
  assert.match(readme, /parcel_05_recipient_name\.sql/)
})

console.log(`\nAll ${passed} parcel-05 SQL checks passed.`)
