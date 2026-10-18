// Static checks for parcel_03 (GATE 03I / S3): migration, rollback and read-only verification query, and their
// consistency with the S2 application rules. Pure — no DB, no network. Behaviour and two-session lock tests run
// separately against a throwaway local PostgreSQL (see the GATE 03I review); they are not part of this script.
// Run: node scripts/verify-parcel-03-sql.mjs

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = p => readFileSync(join(ROOT, p), 'utf8')
function loadTs(rel) {
  const { outputText } = ts.transpileModule(read(rel), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } })
  const mod = { exports: {} }
  new Function('exports', 'require', 'module', outputText)(mod.exports, require, mod)
  return mod.exports
}

const MIG = read('db/migrations/parcel_03_orders_gate.sql')
const RB = read('db/migrations/parcel_03_rollback.sql')
const VER = read('db/migrations/parcel_03_verify.sql')
const P01 = read('db/migrations/parcel_01_tables.sql')
const ROUTE = read('app/api/kitchen/orders/[id]/status/route.ts')
const PR = loadTs('lib/parcelRequest.ts')

let passed = 0
const test = (name, fn) => { fn(); passed++; console.log('  ✓', name) }
const md5 = s => createHash('md5').update(s, 'utf8').digest('hex')
const sha256 = s => createHash('sha256').update(s, 'utf8').digest('hex')
/** SQL with comments and string literals removed (dollar-quoted bodies kept) — for keyword scans. */
const code = s => s.replace(/--[^\n]*/g, '').replace(/'(?:[^']|'')*'/g, "''")
const bodies = [...MIG.matchAll(/\$fn\$([\s\S]*?)\$fn\$/g)].map(m => m[1])
const [GATE, SYNC] = bodies
const fpr = b => ({ lf: [md5(b), [...b].length], crlf: [md5(b.replace(/\n/g, '\r\n')), [...b.replace(/\n/g, '\r\n')].length] })

console.log('Migration structure')
test('one transaction, lock_timeout + statement_timeout, LF file, no CR', () => {
  assert.equal((MIG.match(/^BEGIN;$/gm) || []).length, 1); assert.equal((MIG.match(/^COMMIT;$/gm) || []).length, 1)
  assert.match(MIG, /SET LOCAL lock_timeout = '5s';/); assert.match(MIG, /SET LOCAL statement_timeout = '60s';/)
  assert.ok(!MIG.includes('\r'))
})
test('creates exactly the two functions and two triggers, nothing else', () => {
  const c = code(MIG)
  assert.deepEqual([...c.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([\w.]+)/gi)].map(m => m[1]),
    ['public.orders_parcel_accept_gate', 'public.orders_parcel_cancel_sync'])
  assert.deepEqual([...c.matchAll(/CREATE\s+TRIGGER\s+(\w+)/gi)].map(m => m[1]), ['orders_parcel_accept_gate', 'orders_parcel_cancel_sync'])
  assert.ok(!/CREATE\s+OR\s+REPLACE/i.test(c), 'no CREATE OR REPLACE (never touches 01 / 01b / 02 functions)')
  for (const kw of [/\bDROP\b/i, /\bALTER\b/i, /\bTRUNCATE\b/i, /\bDELETE\b/i, /\bINSERT\b/i, /\bGRANT\b/i, /\bCASCADE\b/i,
    /SECURITY\s+DEFINER/i, /\bEXECUTE\s+format/i, /\bEXECUTE\s+'/i, /\bCOPY\b/i, /\bdblink\b/i, /pg_notify/i])
    assert.ok(!kw.test(c), String(kw))
})
test('the only data-modifying statement is the sync UPDATE inside its function body', () => {
  const outside = code(MIG.replace(/\$fn\$[\s\S]*?\$fn\$/g, ''))
  assert.ok(!/\bUPDATE\s+public\./i.test(outside))
  assert.equal((code(SYNC).match(/\bUPDATE\b/gi) || []).length, 1)
  assert.ok(!/\bUPDATE\b|\bINSERT\b|\bDELETE\b/i.test(code(GATE)))
})
test('both functions: SECURITY INVOKER, search_path \'\', plpgsql, RETURNS trigger; EXECUTE revoked incl. service_role', () => {
  for (const name of ['orders_parcel_accept_gate', 'orders_parcel_cancel_sync']) {
    assert.match(MIG, new RegExp(`CREATE FUNCTION public\\.${name}\\(\\)\\nRETURNS trigger\\nLANGUAGE plpgsql\\nSECURITY INVOKER\\nSET search_path = ''\\nAS \\$fn\\$`))
    assert.match(MIG, new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\(\\) FROM PUBLIC, anon, authenticated, service_role;`))
  }
})
test('gate trigger: BEFORE UPDATE, row-level, no column list, every non-cancel exit from received', () => {
  assert.match(MIG, /CREATE TRIGGER orders_parcel_accept_gate\n  BEFORE UPDATE ON public\.orders\n  FOR EACH ROW\n  WHEN \(OLD\.status = 'received' AND NEW\.status IS DISTINCT FROM 'received' AND NEW\.status IS DISTINCT FROM 'cancelled'\)\n  EXECUTE FUNCTION public\.orders_parcel_accept_gate\(\);/)
  assert.ok(!/UPDATE OF/i.test(code(MIG)))
})
test('sync trigger: AFTER UPDATE, row-level, on entering cancelled only', () => {
  assert.match(MIG, /CREATE TRIGGER orders_parcel_cancel_sync\n  AFTER UPDATE ON public\.orders\n  FOR EACH ROW\n  WHEN \(NEW\.status = 'cancelled' AND OLD\.status IS DISTINCT FROM 'cancelled'\)\n  EXECUTE FUNCTION public\.orders_parcel_cancel_sync\(\);/)
})
test('gate body: parcel row FOR SHARE, food-only passes, found/cancelled pass, everything else (incl. NULL) → P0001 parcel_not_ready', () => {
  assert.match(GATE, /FROM public\.parcel_requests AS pr\n   WHERE pr\.order_id = OLD\.id\n     FOR SHARE;/)
  assert.match(GATE, /IF NOT FOUND THEN\n    RETURN NEW;/)
  assert.match(GATE, /IF v_parcel_status IS NULL OR v_parcel_status NOT IN \('found', 'cancelled'\) THEN\n[^\n]*\n    RAISE EXCEPTION 'parcel_not_ready' USING ERRCODE = 'P0001';/)
  assert.equal((GATE.match(/RAISE EXCEPTION/g) || []).length, 1)
})
test('sync body: only in-store parcels, order_cancelled, system actor, conditional on current status', () => {
  assert.match(SYNC, /SET status       = 'cancelled',\n         close_reason = 'order_cancelled',\n         last_actor   = 'system:order_cancelled'\n   WHERE pr\.order_id = OLD\.id\n     AND pr\.status IN \('awaiting_search', 'not_found', 'found'\);/)
  assert.match(SYNC, /RETURN NULL;   -- AFTER trigger/)
})
test('no tracking data and no customer columns referenced by migration / rollback', () => {
  for (const s of [MIG, RB]) for (const col of ['tracking_ref', 'tracking_key', 'carrier', 'phone', 'customer_name', 'address'])
    assert.ok(!new RegExp(`\\b${col}\\b`).test(code(s)), col)
})

console.log('Fingerprints (one reviewed source everywhere)')
const F = { gate: fpr(GATE), sync: fpr(SYNC) }
test('post-check, rollback preflight and verify query all embed the same LF + CRLF fingerprints of the two bodies', () => {
  for (const [k, f] of Object.entries(F)) for (const v of ['lf', 'crlf']) {
    const [h, len] = f[v]
    for (const [name, s] of [['migration', MIG], ['rollback', RB]]) assert.ok(s.includes(`r.h = '${h}' AND r.len = ${len}`), `${name} ${k} ${v}`)
    assert.ok(VER.includes(`.h = '${h}' AND `) && VER.includes(`.len = ${len}`), `verify ${k} ${v}`)
  }
})
test('preflight pins the installed baseline (01b CRLF/LF, log_event, append_only, wrapper)', () => {
  for (const s of ["'9da7eec21b14950cfcbe4481ecbddf40' AND v_len = 5560", "'bf1d4abc4698dd2213023df069b75255' AND v_len = 5397",
    "'08de848cf7badf72b426972a12590957' OR v_len <> 281", "'c098c15fc3a0b898f7f148f4b2cc9dea' OR v_len <> 86",
    "'7d491c097bf60b7e17beae25890b1238' OR v_len <> 2474"]) assert.ok(MIG.includes(s), s)
  assert.ok(MIG.includes("set_config('parcel_03.neighbours', v_fp, true)") && MIG.includes("current_setting('parcel_03.neighbours', true)"))
})

console.log('Rollback')
test('rollback: one transaction, drops exactly the four parcel_03 objects, triggers first, no IF EXISTS / CASCADE', () => {
  const c = code(RB)
  assert.equal((RB.match(/^BEGIN;$/gm) || []).length, 1); assert.equal((RB.match(/^COMMIT;$/gm) || []).length, 1)
  assert.deepEqual([...c.matchAll(/^DROP [^\n]*;$/gm)].map(m => m[0]), [
    'DROP TRIGGER orders_parcel_cancel_sync ON public.orders;', 'DROP TRIGGER orders_parcel_accept_gate ON public.orders;',
    'DROP FUNCTION public.orders_parcel_cancel_sync();', 'DROP FUNCTION public.orders_parcel_accept_gate();'])
  for (const kw of [/\bDROP\s+\w+\s+IF\s+EXISTS/i, /\bCASCADE\b/i, /\bCREATE\b/i, /\bALTER\b/i, /\bGRANT\b/i, /\bREVOKE\b/i, /\bUPDATE\s+public/i, /\bINSERT\b/i, /\bDELETE\b/i])
    assert.ok(!kw.test(c), String(kw))
  assert.match(RB, /parcel_03_rollback_postcheck: public\.orders still has user triggers/)
})

console.log('Verification query')
test('single read-only statement: no DDL / DML, no function bodies, no tracking data', () => {
  const c = code(VER)
  assert.equal((c.match(/;/g) || []).length, 1); assert.match(c.trim(), /;$/)
  assert.match(c, /^\s*WITH\b/m)
  for (const kw of [/\bINSERT\b/i, /\bUPDATE\s+public/i, /\bDELETE\b/i, /\bCREATE\b/i, /\bDROP\b/i, /\bALTER\b/i, /\bGRANT\b/i,
    /\bREVOKE\b/i, /\bTRUNCATE\b/i, /set_config/i, /\bDO\b\s*\$/i, /pg_get_functiondef/i])
    assert.ok(!kw.test(c), String(kw))
  assert.ok(!/(?<!md5\(|length\()p\.prosrc/.test(c), 'prosrc only inside md5() / length()')
  for (const col of ['tracking_ref', 'tracking_key', 'carrier', 'phone', 'customer_name', 'address']) assert.ok(!new RegExp(`\\b${col}\\b`).test(c), col)
})
test('verify query: 21 checks with stable ids and PASS / FAIL / INFO output', () => {
  const ids = [...VER.matchAll(/SELECT '(\d\d)', '/g)].map(m => m[1])
  assert.deepEqual(ids, Array.from({ length: 21 }, (_, i) => String(i + 1).padStart(2, '0')))
  assert.match(VER, /CASE WHEN ok IS NULL THEN 'INFO' WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result/)
})

console.log('Food-only safety + Production preflight query')
const PRE = read('db/migrations/parcel_03_production_preflight.sql')
test('migration preflight aborts if any role that can update orders rows cannot run both triggers', () => {
  assert.match(MIG, /has_table_privilege\(r\.oid, o\.oid, 'UPDATE'\)\n     AND \(r\.rolbypassrls OR NOT o\.relrowsecurity\n          OR \(pg_has_role\(r\.oid, o\.relowner, 'USAGE'\) AND NOT o\.relforcerowsecurity\)/)
  assert.match(MIG, /AND NOT \(has_table_privilege\(r\.oid, pr\.oid, 'SELECT'\) AND has_table_privilege\(r\.oid, pr\.oid, 'UPDATE'\)\n              AND has_table_privilege\(r\.oid, 'public\.parcel_events'::regclass, 'INSERT'\)\n              AND \(r\.rolbypassrls OR pg_has_role\(r\.oid, pr\.relowner, 'USAGE'\)\)\);/)
  assert.ok(MIG.includes("'parcel_03_preflight: role(s) can update orders but cannot run the parcel triggers: %'"))
})
test('RLS reach: an UPDATE policy counts only if it can admit a row (permissive USING + permissive check, no restrictive false)', () => {
  // migration preflight: three policy clauses, only the constant false is treated as denying
  assert.equal((MIG.match(/AND pol\.polcmd IN \('w', '\*'\) AND pol\.polpermissive\n/g) || []).length, 2)
  assert.equal((MIG.match(/AND pol\.polcmd IN \('w', '\*'\) AND NOT pol\.polpermissive\n/g) || []).length, 1)
  assert.ok(MIG.includes("AND coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') <> 'false')"))
  assert.ok(MIG.includes("AND coalesce(pg_get_expr(coalesce(pol.polwithcheck, pol.polqual), pol.polrelid), '') <> 'false')"))
  assert.ok(MIG.includes("AND (pg_get_expr(pol.polqual, pol.polrelid) = 'false'\n                                      OR pg_get_expr(coalesce(pol.polwithcheck, pol.polqual), pol.polrelid) = 'false')"))
  // production preflight + verify query use the same rule
  for (const s of [PRE, VER]) {
    assert.ok(s.includes("coalesce(pg_get_expr(p.polqual, p.polrelid), '') = 'false' AS using_false"))
    assert.ok(s.includes("coalesce(pg_get_expr(coalesce(p.polwithcheck, p.polqual), p.polrelid), '') = 'false' AS check_false"))
    assert.match(s, /up\.permissive AND NOT up\.using_false\)[\s\S]*up\.permissive AND NOT up\.check_false\)[\s\S]*NOT up\.permissive AND \(up\.using_false OR up\.check_false\)\)/)
  }
  assert.match(PRE, /SELECT '16', 'orders: anon \/ authenticated cannot UPDATE rows/)
  assert.match(VER, /SELECT '16', 'orders: no UPDATE \/ ALL policy can admit a row for anon \/ authenticated'/)
})
test('production preflight query: single read-only statement, 27 checks, GO / NO-GO / INFO, no bodies or tracking data', () => {
  const c = code(PRE)
  assert.equal((c.match(/;/g) || []).length, 1); assert.match(c, /^\s*WITH\b/m)
  for (const kw of [/\bINSERT\b/i, /\bUPDATE\s+public/i, /\bDELETE\b/i, /\bCREATE\b/i, /\bDROP\b/i, /\bALTER\b/i, /\bGRANT\b/i,
    /\bREVOKE\b/i, /\bTRUNCATE\b/i, /set_config/i, /\bDO\b\s*\$/i, /pg_get_functiondef/i, /\bFOR\s+(SHARE|UPDATE)\b/i])
    assert.ok(!kw.test(c), String(kw))
  assert.ok(!/(?<!md5\(|length\()p\.prosrc/.test(c))
  for (const col of ['tracking_ref', 'tracking_key', 'carrier', 'phone', 'customer_name', 'address']) assert.ok(!new RegExp(`\\b${col}\\b`).test(c), col)
  assert.deepEqual([...PRE.matchAll(/SELECT '(\d\d)', '/g)].map(m => m[1]), Array.from({ length: 27 }, (_, i) => String(i + 1).padStart(2, '0')))
  assert.match(PRE, /CASE WHEN ok IS NULL THEN 'INFO' WHEN ok THEN 'GO' ELSE 'NO-GO' END AS verdict/)
})
test('production preflight query pins the same baseline fingerprints as the migration', () => {
  for (const h of ['9da7eec21b14950cfcbe4481ecbddf40', 'bf1d4abc4698dd2213023df069b75255', '08de848cf7badf72b426972a12590957',
    'c098c15fc3a0b898f7f148f4b2cc9dea', '7d491c097bf60b7e17beae25890b1238']) { assert.ok(PRE.includes(h), h); assert.ok(MIG.includes(h), h) }
  assert.ok(PRE.includes('db92e75f8bfdadb6d78be035da855996'))
})

console.log('Consistency with S2 (application) and parcel_01 rules')
test('route maps exactly the gate error (P0001 + parcel_not_ready) to ParcelNotReadyError → 409', () => {
  assert.ok(ROUTE.includes("error.code === 'P0001' && error.message === 'parcel_not_ready'"))
})
test('gate ready-set == S2 isParcelReadyForAcceptance (every parcel status, null, malformed)', () => {
  const dbReady = s => s === null || s === 'found' || s === 'cancelled'   // NOT FOUND → pass; IN ('found','cancelled')
  for (const s of [null, ...PR.PARCEL_STATUSES, 'invalid', '', 'FOUND'])
    assert.equal(PR.isParcelReadyForAcceptance(s), dbReady(s), String(s))
})
test('sync status list == S2 PARCEL_STATUSES_REQUIRING_CANCEL_SYNC; full cancellation enabled in S2b (relies on this sync)', () => {
  assert.deepEqual([...PR.PARCEL_STATUSES_REQUIRING_CANCEL_SYNC].sort(), ['awaiting_search', 'found', 'not_found'])
  const sqlScope = SYNC.match(/AND pr\.status IN \(([^)]*)\)/)[1].match(/'([a-z_]+)'/g).map(s => s.slice(1, -1)).sort()
  assert.deepEqual(sqlScope, [...PR.PARCEL_STATUSES_REQUIRING_CANCEL_SYNC].sort())   // app scope == trigger scope
  assert.equal(PR.PARCEL_ORDER_CANCEL_ENABLED, true)
})
test('gate condition matrix (6×6 order transitions × parcel states) == S2 application gate', () => {
  const S = ['received', 'confirmed', 'preparing', 'ready', 'delivered', 'cancelled']
  const dbBlocks = (from, to, ps) => from === 'received' && to !== 'received' && to !== 'cancelled' && !(ps === null || ps === 'found' || ps === 'cancelled')
  let n = 0
  for (const from of S) for (const to of S) for (const ps of [null, ...PR.PARCEL_STATUSES, 'invalid']) {
    if (from === to) continue
    const appBlocks = from === 'received' && to !== 'cancelled' && !PR.isParcelReadyForAcceptance(ps)
    assert.equal(dbBlocks(from, to, ps), appBlocks, `${from}>${to} ${ps}`); n++
  }
  assert.equal(n, 30 * 10)
})
test('sync values satisfy parcel_01 constraints (last_actor format, close_reason list) and the 01b order_cancelled rule', () => {
  const actorRe = new RegExp(P01.match(/last_actor ~ '([^']+)'/)[1])
  assert.ok(actorRe.test('system:order_cancelled'))
  assert.match(P01, /close_reason IN \('order_cancelled', 'food_only', 'customer_request', 'duplicate', 'other'\)/)
  const b01 = read('db/migrations/parcel_01b_insert_lock.sql')
  assert.match(b01, /IF NEW\.close_reason = 'order_cancelled'\n       AND v_order_status IS DISTINCT FROM 'cancelled' THEN/)
  for (const s of ['awaiting_search', 'not_found', 'found']) assert.ok(PR.PARCEL_TRANSITIONS[s].includes('cancelled'), s)
})
test('01b and its rollback are unchanged (reviewed SHA-256)', () => {
  assert.match(sha256(read('db/migrations/parcel_01b_insert_lock.sql')), /^10e99e64[0-9a-f]+77eee6$/)
  assert.match(sha256(read('db/migrations/parcel_01b_rollback.sql')), /^1c5a557b[0-9a-f]+985f1d2$/)
})

console.log(`\nAll ${passed} parcel-03 SQL checks passed.`)
