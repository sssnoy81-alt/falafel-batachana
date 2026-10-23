// Static checks for S4-INTEGRATIONS-04D1 — courier reconciliation audit ledger (db/migrations/s4_04d_*.sql).
// Pure — no DB, no network. Behaviour on a disposable PostgreSQL (--network none) is tested separately by
// scripts/pgtest-s4-04d-reconciliations.mjs (needs Docker). Run: node scripts/verify-s4-04d-sql.mjs

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = rel => readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
const MIG = read('db/migrations/s4_04d_maale_dispatch_reconciliations.sql')
const PRE = read('db/migrations/s4_04d_production_preflight.sql')
const VER = read('db/migrations/s4_04d_verify.sql')
const RB = read('db/migrations/s4_04d_rollback.sql')
const code = s => s.replace(/--.*$/gm, '')                    // without line comments
const stmts = s => code(s).replace(/'(?:[^']|'')*'/g, "''")   // ... and without string literals
const EVENTS = ['confirmed_sent', 'cancelled_at_provider', 'not_received', 'manual_courier', 'provider_status_checked', 'manual_review_opened', 'manual_review_resolved']

let passed = 0
const test = (name, fn) => { fn(); passed++; console.log('  ✓', name) }
console.log('S4-04D reconciliation ledger — SQL files')

test('1. migration is manual, review-only, one transaction with timeouts, preflight and post-check', () => {
  assert.match(MIG, /REVIEW ONLY — NOT EXECUTED/)
  const c = code(MIG)
  assert.match(c, /^BEGIN;/m); assert.match(c, /^COMMIT;\s*$/m)
  assert.ok(c.includes("SET LOCAL lock_timeout = '5s';") && c.includes("SET LOCAL statement_timeout = '60s';"))
  assert.ok(c.indexOf('$s4_04d_preflight$') < c.indexOf('CREATE TABLE') && c.indexOf('$s4_04d_postcheck$') > c.indexOf('GRANT SELECT'))
  assert.match(c, /already exists \(no silent re-apply\)/)
})

test('2. additive only: creates one table + 2 indexes; no ALTER of existing objects, no function / trigger / policy, no DML', () => {
  const s = stmts(MIG)
  assert.ok(!/^\s*(DROP|TRUNCATE|DELETE|UPDATE|INSERT)\b/im.test(s))
  assert.deepEqual([...s.matchAll(/ALTER TABLE ([\w.]+)/g)].map(m => m[1]), ['public.maale_dispatch_reconciliations'])
  assert.ok(!/CREATE (OR REPLACE )?(FUNCTION|TRIGGER|POLICY|VIEW)/i.test(s))
  assert.equal((s.match(/CREATE TABLE/g) || []).length, 1); assert.equal((s.match(/CREATE INDEX/g) || []).length, 2)
  assert.ok(!/delivery_dispatches|maale_dispatch_requests/.test(s), 'never references the dispatch or 04B tables')
})

test('3. ledger columns: no free text, no dispatch_id, no customer data; FK to orders RESTRICT', () => {
  const t = code(MIG).slice(code(MIG).indexOf('CREATE TABLE public.maale_dispatch_reconciliations'), code(MIG).indexOf('CREATE INDEX'))
  const cols = [...t.matchAll(/^\s{2}(\w+)\s+(uuid|text|timestamptz)\b/gm)].map(m => m[1])
  assert.deepEqual(cols, ['id', 'request_id', 'order_id', 'event_type', 'actor_username', 'provider_order_id', 'provider_status', 'reason_code', 'created_at'])
  // S4-04D3: request_id is the durable idempotency key — NOT NULL + UNIQUE (the final atomic duplicate guard).
  assert.ok(t.includes('request_id        uuid        NOT NULL') && t.includes('CONSTRAINT maale_dispatch_reconciliations_request_id_key UNIQUE (request_id)'))
  // Column / constraint names only (the reason-code VALUES such as 'provider_phone_confirmed' are vocabulary, not data).
  const names = t.replace(/'(?:[^']|'')*'/g, "''").replace(/actor_username/g, '')
  assert.ok(!/\bnote\b|dispatch_id|phone|address|customer|payload|raw|body|api_key/i.test(names))
  assert.ok(t.includes('REFERENCES public.orders (id) ON UPDATE RESTRICT ON DELETE RESTRICT'))
})

test('4. closed event list (no automatic-cancellation state), strict actor, safe provider id / status, bounded reasons', () => {
  const t = code(MIG)
  const list = t.slice(t.indexOf('event_type_check CHECK (event_type IN ('), t.indexOf(')),', t.indexOf('event_type_check')))
  assert.deepEqual([...list.matchAll(/'([a-z_]+)'/g)].map(m => m[1]), EVENTS)
  assert.ok(!/auto|retry|reset|redispatch|resend/i.test(list))
  assert.ok(t.includes("CHECK (actor_username ~ '^[a-z0-9_-]{2,32}$')"))
  assert.ok(read('lib/kitchenAuth.ts').includes('const USERNAME_REGEX = /^[a-z0-9_-]{2,32}$/'), 'same rule as kitchen login')
  assert.ok(t.includes("provider_order_id ~ '^[A-Za-z0-9_-]{1,100}$'") && t.includes("provider_status ~ '^[a-z_]{1,40}$'"))
  assert.ok(read('scripts/maale-controlled-test.mjs').includes('const SAFE_PROVIDER_ID = /^[A-Za-z0-9_-]{1,100}$/'), 'same id shape as the runner')
  assert.match(t, /event_type IN \('confirmed_sent', 'cancelled_at_provider'\) AND provider_order_id IS NOT NULL/)
  assert.match(t, /event_type IN \('not_received', 'manual_courier'\) AND provider_order_id IS NULL/)
  assert.ok(t.includes("CHECK (provider_status IS NULL OR event_type = 'provider_status_checked')"))
})

test('5. access: RLS on, reset then service_role SELECT + INSERT only (append-only), nothing else granted', () => {
  const s = code(MIG)
  assert.ok(s.includes('ALTER TABLE public.maale_dispatch_reconciliations ENABLE ROW LEVEL SECURITY;'))
  assert.ok(s.includes('REVOKE ALL ON public.maale_dispatch_reconciliations FROM PUBLIC, anon, authenticated, service_role;'))
  assert.ok(s.includes('GRANT SELECT, INSERT ON public.maale_dispatch_reconciliations TO service_role;'))
  assert.equal((s.match(/^GRANT /gm) || []).length, 1)
  assert.ok(!/GRANT[^;]*(UPDATE|DELETE|TRUNCATE)/i.test(s))
})

test('6. verify pins exactly the 10 constraint definitions; preflight / verify are read-only single SELECTs', () => {
  for (const ev of EVENTS) assert.ok(VER.includes(`''${ev}''::text`), ev)
  assert.equal((VER.match(/\('maale_dispatch_reconciliations_\w+', '/g) || []).length, 10)
  assert.ok(VER.includes("('maale_dispatch_reconciliations_request_id_key', 'UNIQUE (request_id)')"))
  for (const [name, f, n] of [['preflight', PRE, 8], ['verify', VER, 12]]) {
    assert.ok(!/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|REVOKE|TRUNCATE|BEGIN|COMMIT)\b/i.test(stmts(f)), name)
    assert.match(f, /READ-ONLY, ONE SELECT/)
    assert.equal(new Set([...code(f).matchAll(/SELECT '(\d\d)', '/g)].map(m => m[1])).size, n, `${name}: ${n} checks`)
  }
})

test('7. rollback: manual, approval-only, explicit confirmation + export confirmation when rows exist, no CASCADE', () => {
  assert.match(RB, /MANUAL ONLY, NEVER RUN WITHOUT SEPARATE EXPLICIT OWNER APPROVAL/)
  assert.match(RB, /PRIMARY ROLLBACK PLAN IS THE APPLICATION/)
  const c = code(RB)
  assert.ok(c.includes("current_setting('s4_04d.confirm_rollback', true) IS DISTINCT FROM 'DROP-RECONCILIATION-LEDGER'"))
  assert.ok(c.includes("current_setting('s4_04d.confirm_history_exported', true) IS DISTINCT FROM 'yes'"))
  assert.deepEqual([...c.matchAll(/^DROP (\w+) ([\w.]+)/gm)].map(m => `${m[1]} ${m[2]}`), ['TABLE public.maale_dispatch_reconciliations'])
  assert.ok(!/CASCADE/i.test(c)); assert.ok(!/delivery_dispatches|maale_dispatch_requests|public\.orders/.test(stmts(RB)))
})

test('8. nothing runs these automatically; no runtime code uses the ledger yet; README lists it as prepared', () => {
  assert.ok(!/s4_04d|pgtest-s4-04d|migrations/.test(read('package.json')))
  const readme = read('db/migrations/README.md')
  assert.ok(readme.includes('s4_04d_maale_dispatch_reconciliations.sql') && readme.includes('s4_04d_rollback.sql'))
  // S4-04D2/04D3: exactly three server files reference the ledger — the read-model embed, the manager-only POST route and
  // (read-only, feature-gated) the dispatch route's manual-courier block.
  for (const f of ['app/api/kitchen/orders/route.ts', 'lib/kitchenDispatch.ts', 'lib/maaleDispatch.ts', 'app/dashboard/orders/page.tsx'])
    assert.ok(!/maale_dispatch_reconciliations/.test(read(f)), f)
  const dr = read('app/api/kitchen/orders/[id]/dispatch/route.ts')
  assert.equal((dr.match(/maale_dispatch_reconciliations/g) || []).length, 1)
  assert.ok(dr.includes("supabase.from('maale_dispatch_reconciliations').select('event_type').eq('order_id', orderId)"), 'dispatch route only reads event types')
  assert.ok(read('lib/kitchenOrders.ts').includes("'maale_dispatch_reconciliations(id, event_type, actor_username, provider_order_id, provider_status, reason_code, created_at)'"))
  // S4-04E2: the manager POST route writes ONLY through the coordination function (no direct ledger INSERT).
  const rr = read('app/api/kitchen/orders/[id]/reconciliation/route.ts')
  assert.ok(rr.includes("supabase.rpc('record_maale_reconciliation_event'") && !/\.insert\(/.test(rr))
  const pg = read('scripts/pgtest-s4-04d-reconciliations.mjs').replace(/^\s*\/\/.*$/gm, '')
  assert.ok(pg.includes("'--network', 'none'"))
  assert.ok(!/readFileSync\([^)\n]*env|['"`][^'"`\n]*\.env|loadEnvLocal|SUPABASE_|MAALE_|createClient|supabase-js/.test(pg), 'never reads .env files or credentials')
})

console.log(`\nAll ${passed} S4-04D SQL checks passed.`)
