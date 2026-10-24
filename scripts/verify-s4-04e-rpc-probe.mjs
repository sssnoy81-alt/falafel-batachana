// Offline checks for scripts/s4-04e-rpc-envelope-probe.mjs (S4-INTEGRATIONS-04F2). Mocked client only — no network,
// no database, no key. Also proves from the exact SQL function bodies that every probe call is non-mutating.
// Real PostgREST + PostgreSQL envelopes: scripts/pgtest-s4-04e-postgrest-envelope.mjs (Docker, internal network).
// Run: node scripts/verify-s4-04e-rpc-probe.mjs

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

globalThis.fetch = async () => { throw new Error('LIVE NETWORK CALL ATTEMPTED') }

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PROBE = join(ROOT, 'scripts', 's4-04e-rpc-envelope-probe.mjs')
const P = await import('./s4-04e-rpc-envelope-probe.mjs')
const MIG = readFileSync(join(ROOT, 'db/migrations/s4_04e_courier_coordination.sql'), 'utf8').replace(/\r\n/g, '\n')
const body = tag => { const t = `$${tag}$`, a = MIG.indexOf(t) + t.length; return MIG.slice(a, MIG.indexOf(t, a)).replace(/--.*$/gm, '') }

let passed = 0
const test = async (name, fn) => { await fn(); passed++; console.log('  ✓', name) }

const U = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333']
const GOOD = {
  P1: { data: 'invalid_request', error: null },
  P2: { data: 'dispatch_row_missing', error: null },
  P3: { data: [{ result: 'invalid_request', event_id: null, event_created_at: null }], error: null },
}
/** Mock client: answers by call index; records every call; exposes ONLY rpc (any table access would throw). */
const mock = (answers = [GOOD.P1, GOOD.P2, GOOD.P3]) => {
  const calls = []
  return { calls, client: { rpc: async (fn, args) => { calls.push([fn, args]); const a = answers[calls.length - 1]; if (a instanceof Error) throw a; return a } } }
}
const run = async answers => { const m = mock(answers); let i = 0; const res = await P.runProbe(m.client, { uuid: () => U[i++] }); return { ...res, calls: m.calls } }

console.log('S4-04F2 RPC envelope probe (offline)')

await test('1. happy path: exactly 3 RPC calls in order with the non-mutating arguments; ALL PASS', async () => {
  const r = await run()
  assert.equal(r.ok, true); assert.equal(r.critical, false)
  assert.deepEqual(r.calls, [
    ['claim_maale_dispatch', { p_order_id: null, p_seen_attempts: 0, p_seen_last_attempt_at: null }],
    ['claim_maale_dispatch', { p_order_id: U[0], p_seen_attempts: -1, p_seen_last_attempt_at: null }],
    ['record_maale_reconciliation_event', { p_request_id: U[1], p_order_id: U[2], p_event_type: 'manual_review_opened', p_actor: 'S4-PROBE-INVALID',
      p_provider_order_id: null, p_provider_status: null, p_reason_code: null }],
  ])
  assert.ok(r.lines.at(-1).startsWith('ALL PASS'))
  for (const ok of P.P2_NONMUTATING) assert.equal((await run([GOOD.P1, { data: ok, error: null }, GOOD.P3])).ok, true, ok)
})

await test('2. wrong envelopes FAIL and STOP (no further call): object / multi-row / wrapped scalar / extra keys / non-null ids', async () => {
  const cases = [
    [[{ data: ['invalid_request'], error: null }], 1], [[{ data: { result: 'invalid_request' }, error: null }], 1], [[{ data: null, error: null }], 1],
    [[GOOD.P1, { data: 'something_new', error: null }], 2], [[GOOD.P1, { data: ['dispatch_row_missing'], error: null }], 2],
    [[GOOD.P1, GOOD.P2, { data: { result: 'invalid_request', event_id: null, event_created_at: null }, error: null }], 3],
    [[GOOD.P1, GOOD.P2, { data: [GOOD.P3.data[0], GOOD.P3.data[0]], error: null }], 3],
    [[GOOD.P1, GOOD.P2, { data: [{ ...GOOD.P3.data[0], extra: 1 }], error: null }], 3],
    [[GOOD.P1, GOOD.P2, { data: [{ ...GOOD.P3.data[0], event_id: 'x' }], error: null }], 3],
    [[GOOD.P1, GOOD.P2, { data: [{ result: 'order_not_found', event_id: null, event_created_at: null }], error: null }], 3],
  ]
  for (const [answers, n] of cases) {
    const r = await run(answers)
    assert.equal(r.ok, false, JSON.stringify(answers)); assert.equal(r.calls.length, n, 'stopped at the failing call')
    assert.ok(r.lines.at(-1).startsWith('STOPPED'))
  }
})

await test('3. "claimed" / "recorded" (impossible by construction) → CRITICAL, stop, exit code 3 path', async () => {
  let r = await run([GOOD.P1, { data: 'claimed', error: null }])
  assert.equal(r.critical, true); assert.equal(r.calls.length, 2); assert.match(r.lines.join('\n'), /CRITICAL.*DO NOT PROCEED/)
  r = await run([GOOD.P1, GOOD.P2, { data: [{ result: 'recorded', event_id: 'e', event_created_at: 't' }], error: null }])
  assert.equal(r.critical, true); assert.equal(r.calls.length, 3)
})

await test('4. RPC errors / transport failure → code-only report with a hint, stop, NEVER retried; no message text printed', async () => {
  for (const [err, hint] of [[{ code: 'PGRST202', message: 'SECRET-HINT' }, /schema cache/], [{ code: '42501', message: 'SECRET' }, /permission denied/],
    [{ code: '55P03', message: 'SECRET' }, /RPC error 55P03/], [{ code: 'x;drop', message: 'SECRET' }, /RPC error unknown/]]) {
    for (let at = 0; at < 3; at++) {
      const answers = [GOOD.P1, GOOD.P2, GOOD.P3]; answers[at] = { data: null, error: err }
      const r = await run(answers)
      assert.equal(r.ok, false); assert.equal(r.calls.length, at + 1, 'no retry, no further call')
      assert.match(r.lines.join('\n'), hint); assert.ok(!r.lines.join('\n').includes('SECRET'))
    }
  }
  const r = await run([new Error('fetch failed SECRET')])
  assert.equal(r.calls.length, 1); assert.match(r.lines[0], /RPC error unknown|transport/); assert.ok(!r.lines.join('\n').includes('SECRET'))
})

await test('5. PROOF from the exact SQL: P1 / P3 return before any lock or table access; P2 can never reach the UPDATE', () => {
  const claim = body('claim_maale_dispatch'), rec = body('record_maale_reconciliation_event')
  const at = (s, t) => { const i = s.indexOf(t); assert.ok(i >= 0, t); return i }
  // P1: NULL order id → the very first statement
  assert.ok(at(claim, "IF p_order_id IS NULL OR p_seen_attempts IS NULL THEN\n    RETURN 'invalid_request';") < at(claim, 'pg_advisory_xact_lock'))
  // P2: every path to the UPDATE passes "attempts = 0" and "p_seen_attempts = attempts"; -1 ≠ 0 → returns earlier
  const upd = at(claim, 'UPDATE public.delivery_dispatches')
  assert.ok(at(claim, "IF v_status IS DISTINCT FROM 'pending' OR v_attempts IS DISTINCT FROM 0 OR v_last IS NOT NULL THEN\n    RETURN 'not_claimable';") < upd)
  assert.ok(at(claim, "IF p_seen_attempts IS DISTINCT FROM v_attempts OR p_seen_last_attempt_at IS DISTINCT FROM v_last THEN\n    RETURN 'claim_lost';") < upd)
  // (SELECT … FOR UPDATE is a transaction-scoped row lock — it changes no data; it only exists if the random id matched)
  assert.equal((claim.replace(/\bFOR UPDATE\b/g, '').match(/\b(UPDATE|INSERT|DELETE)\b/g) || []).length, 1, 'the only data write in the claim is that UPDATE')
  assert.ok(P.PROBE_SEEN_ATTEMPTS < 0)
  // P3: the actor check is in the first IF, which returns before ANY relation is read or written
  const first = rec.slice(0, at(rec, "RETURN QUERY SELECT 'invalid_request'::text"))
  assert.ok(first.includes("p_actor !~ '^[a-z0-9_-]{2,32}$'") && !/\bFROM\b|\bINSERT\b|pg_advisory/.test(first))
  assert.equal(new RegExp('^[a-z0-9_-]{2,32}$').test(P.PROBE_ACTOR), false, 'the probe actor is invalid by the function rule')
})

await test('6. main: refuses without the confirmation argument / without env; never prints URL or key; no network in tests', () => {
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }
  let r = spawnSync(process.execPath, [PROBE], { env: { ...env, SUPABASE_URL: 'https://secret-project.example', SUPABASE_SERVICE_KEY: 'sb_secret_TESTKEY' }, encoding: 'utf8' })
  assert.equal(r.status, 2); assert.match(r.stdout, /Refusing to run: .*--confirm=READ-ONLY-RPC-ENVELOPE-PROBE/)
  r = spawnSync(process.execPath, [PROBE, P.CONFIRM], { env, encoding: 'utf8' })
  assert.equal(r.status, 2); assert.match(r.stdout, /not set in the environment/)
  // confirmed run with a network that is blocked (preloaded guard) → fails closed after ONE call, prints no secret
  r = spawnSync(process.execPath, ['--import', 'data:text/javascript,globalThis.fetch=async()=>{throw new Error("blocked")}', PROBE, P.CONFIRM],
    { env: { ...env, SUPABASE_URL: 'https://secret-project.example', SUPABASE_SERVICE_KEY: 'sb_secret_TESTKEY' }, encoding: 'utf8' })
  assert.equal(r.status, 1, r.stdout + r.stderr); assert.match(r.stdout, /P1 FAIL/); assert.match(r.stdout, /STOPPED/)
  for (const s of ['secret-project', 'sb_secret_TESTKEY', 'example']) assert.ok(!(r.stdout + r.stderr).includes(s), s)
})

await test('7. source: only rpc() on the two functions; no from() / insert / update / delete / Maale client / .env reading', () => {
  const s = readFileSync(PROBE, 'utf8').replace(/^\s*\/\/.*$/gm, '')
  assert.deepEqual([...new Set([...s.matchAll(/(?:call|rpc)\('([a-z_]+)'/g)].map(m => m[1]))].sort(), ['claim_maale_dispatch', 'record_maale_reconciliation_event'])
  assert.ok(!/\.from\(|\.insert\(|\.update\(|\.delete\(|\.upsert\(|maaleClient|maale\.co|readFileSync|\.env\.local'|loadEnv/.test(s))
  assert.ok(!/console\.log\([^\n]*(\$\{\s*(url|key)\s*\}|[(,+]\s*(url|key)\s*[,)+])/.test(s), 'never logs the url / key variables')
  assert.ok(!/package\.json/.test(s) && !readFileSync(join(ROOT, 'package.json'), 'utf8').includes('rpc-envelope-probe'), 'not wired into npm scripts')
})

console.log(`\nAll ${passed} S4-04F2 RPC probe checks passed.`)
