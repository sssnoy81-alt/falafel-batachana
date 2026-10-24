-- FALAFEL BATACHANA — MAALE DISPATCH READINESS — s4_03_dispatch_readiness_verify.sql (S4-INTEGRATIONS-03A / 03B)
-- READ-ONLY. ONE statement (WITH … SELECT), ONE result table:
--   check_id | check_name | result (PASS / FAIL / INFO) | detail
-- Verifies whether public.delivery_dispatches exists with the shape lib/maaleDispatch.ts expects, its uniqueness,
-- FK, RLS, policies and grants, plus related context (orders payment columns, deliveries geo constraint, orders
-- status CHECK). Prints no customer data and no function bodies: names, constraint / index definitions, flags and
-- counts only (row counts per dispatch status).
-- Safe when the table does not exist (rows 01–08 FAIL, rows 11–16 INFO "n/a"). A missing table is NOT a go-ahead
-- to create one: its DDL needs its own reviewed migration (preflight / verify / rollback).
-- Read-only: catalog reads + one count via query_to_xml (AccessShareLock only). Safe inside BEGIN READ ONLY.
-- Validated on a disposable local PostgreSQL 17.6 (Supabase image, 03B). Executed READ-ONLY in Production by the owner
-- (03D / 03E); results summarized in db/schema/delivery_dispatches.baseline.sql. Safe to re-run at any time.

WITH
dd AS (SELECT to_regclass('public.delivery_dispatches') AS rel),
cols AS (
  SELECT c.column_name, c.data_type, c.is_nullable, c.column_default
    FROM information_schema.columns c
   WHERE c.table_schema = 'public' AND c.table_name = 'delivery_dispatches'
),
expected(col) AS (
  VALUES ('order_id'), ('external_order_id'), ('provider'), ('status'), ('attempts'), ('last_attempt_at'),
         ('error_code'), ('updated_at'), ('dispatched_at'), ('provider_order_id'), ('provider_status')
),
missing AS (SELECT e.col FROM expected e WHERE e.col NOT IN (SELECT column_name FROM cols)),
cons AS (
  SELECT con.conname, con.contype, pg_get_constraintdef(con.oid) AS def
    FROM pg_constraint con, dd
   WHERE con.conrelid = dd.rel
),
idx AS (
  SELECT i.indexname, i.indexdef FROM pg_indexes i
   WHERE i.schemaname = 'public' AND i.tablename = 'delivery_dispatches'
),
grants AS (
  SELECT g.grantee, string_agg(g.privilege_type, ',' ORDER BY g.privilege_type) AS privs
    FROM information_schema.role_table_grants g
   WHERE g.table_schema = 'public' AND g.table_name = 'delivery_dispatches'
   GROUP BY g.grantee
),
pol AS (
  SELECT p.policyname, p.cmd FROM pg_policies p
   WHERE p.schemaname = 'public' AND p.tablename = 'delivery_dispatches'
),
checks(check_id, check_name, ok, detail) AS (
  SELECT '01', 'delivery_dispatches exists',
         (SELECT rel IS NOT NULL FROM dd), coalesce((SELECT rel::text FROM dd), 'missing')
  UNION ALL
  SELECT '02', 'expected columns present (lib/maaleDispatch.ts)',
         NOT EXISTS (SELECT 1 FROM missing),
         coalesce((SELECT 'missing: ' || string_agg(col, ', ') FROM missing), 'all 11 present')
  UNION ALL
  SELECT '03', 'column (info)', NULL,
         column_name || ' ' || data_type || CASE WHEN is_nullable = 'NO' THEN ' NOT NULL' ELSE '' END
           || coalesce(' DEFAULT ' || column_default, '')
    FROM cols
  UNION ALL
  SELECT '04', 'unique on order_id',
         EXISTS (SELECT 1 FROM idx WHERE indexdef ILIKE '%UNIQUE%' AND indexdef ~ '\(order_id\)'),
         coalesce((SELECT string_agg(indexname, ', ') FROM idx WHERE indexdef ILIKE '%UNIQUE%' AND indexdef ~ '\(order_id\)'),
                  'no unique index on (order_id)')
  UNION ALL
  SELECT '05', 'unique on external_order_id',
         EXISTS (SELECT 1 FROM idx WHERE indexdef ILIKE '%UNIQUE%' AND indexdef ~ '\(external_order_id\)'),
         CASE WHEN EXISTS (SELECT 1 FROM idx WHERE indexdef ILIKE '%UNIQUE%' AND indexdef ~ '\(external_order_id\)')
              THEN 'unique index present' ELSE 'no unique index on (external_order_id)' END
  UNION ALL
  SELECT '06', 'FK order_id → orders(id)',
         EXISTS (SELECT 1 FROM cons WHERE contype = 'f' AND def ~ 'REFERENCES (public\.)?orders\(id\)'),
         coalesce((SELECT string_agg(conname || ': ' || def, ' | ') FROM cons WHERE contype = 'f'), 'no foreign key')
  UNION ALL
  SELECT '07', 'status CHECK has the 5 code states',
         EXISTS (SELECT 1 FROM cons WHERE contype = 'c' AND def LIKE '%''pending''%' AND def LIKE '%''sending''%'
                   AND def LIKE '%''sent''%' AND def LIKE '%''failed_retryable''%' AND def LIKE '%''failed_final''%'),
         coalesce((SELECT string_agg(conname, ', ') FROM cons WHERE contype = 'c'), 'no CHECK constraints')
  UNION ALL
  SELECT '08', 'attempts CHECK present (delivery_dispatches_attempts_check)',
         EXISTS (SELECT 1 FROM cons WHERE conname = 'delivery_dispatches_attempts_check'),
         coalesce((SELECT def FROM cons WHERE conname = 'delivery_dispatches_attempts_check'), 'constraint not found')
  UNION ALL
  SELECT '09', 'constraint (info)', NULL, conname || ': ' || def FROM cons
  UNION ALL
  SELECT '10', 'index (info)', NULL, indexname || ': ' || indexdef FROM idx
  UNION ALL
  SELECT '11', 'RLS enabled',
         (SELECT c.relrowsecurity FROM pg_class c, dd WHERE c.oid = dd.rel),
         coalesce((SELECT 'rls=' || c.relrowsecurity::text || ' force=' || c.relforcerowsecurity::text
                     FROM pg_class c, dd WHERE c.oid = dd.rel), 'n/a')
  UNION ALL
  SELECT '12', 'no RLS policies (server-only table)',
         CASE WHEN (SELECT rel FROM dd) IS NULL THEN NULL ELSE NOT EXISTS (SELECT 1 FROM pol) END,
         CASE WHEN (SELECT rel FROM dd) IS NULL THEN 'n/a (table missing)'
              ELSE coalesce((SELECT string_agg(policyname || ' ' || cmd, ', ') FROM pol), 'none') END
  UNION ALL
  SELECT '13', 'no PUBLIC / anon / authenticated privileges',
         CASE WHEN (SELECT rel FROM dd) IS NULL THEN NULL
              ELSE NOT EXISTS (SELECT 1 FROM grants WHERE grantee IN ('PUBLIC', 'anon', 'authenticated')) END,
         CASE WHEN (SELECT rel FROM dd) IS NULL THEN 'n/a (table missing)'
              ELSE coalesce((SELECT string_agg(grantee || '=' || privs, '; ' ORDER BY grantee) FROM grants), 'no grants') END
  UNION ALL
  SELECT '14', 'service_role has SELECT, INSERT, UPDATE',
         CASE WHEN (SELECT rel FROM dd) IS NULL THEN NULL
              ELSE EXISTS (SELECT 1 FROM grants WHERE grantee = 'service_role'
                             AND privs LIKE '%SELECT%' AND privs LIKE '%INSERT%' AND privs LIKE '%UPDATE%') END,
         CASE WHEN (SELECT rel FROM dd) IS NULL THEN 'n/a (table missing)'
              ELSE coalesce((SELECT privs FROM grants WHERE grantee = 'service_role'), 'no service_role grants') END
  UNION ALL
  SELECT '15', 'trigger (info)', NULL, t.tgname || ' enabled=' || t.tgenabled::text
    FROM pg_trigger t, dd WHERE t.tgrelid = dd.rel AND NOT t.tgisinternal
  UNION ALL
  SELECT '16', 'rows per dispatch status (info)', NULL,
         CASE WHEN (SELECT rel FROM dd) IS NULL THEN 'n/a (table missing)'
              ELSE (xpath('/row/c/text()', query_to_xml(
                     $q$SELECT coalesce(string_agg(status || '=' || n::text, ', '), 'empty') AS c
                          FROM (SELECT status, count(*) AS n FROM public.delivery_dispatches GROUP BY status) s$q$,
                     false, true, '')))[1]::text
         END
  UNION ALL
  SELECT '17', 'public functions mentioning delivery_dispatches (info, names only)', NULL,
         coalesce((SELECT string_agg(p.proname, ', ' ORDER BY p.proname) FROM pg_proc p
                     JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.prosrc ILIKE '%delivery_dispatches%'), 'none')
  UNION ALL
  SELECT '18', 'orders payment-related columns (info)', NULL,
         coalesce((SELECT string_agg(column_name || ' ' || data_type, ', ' ORDER BY column_name)
                     FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'orders'
                      AND (column_name ILIKE '%pay%' OR column_name ILIKE '%paid%')), 'none')
  UNION ALL
  SELECT '19', 'deliveries geo constraint (info)', NULL,
         coalesce((SELECT string_agg(con.conname || ': ' || pg_get_constraintdef(con.oid), ' | ')
                     FROM pg_constraint con
                    WHERE con.conrelid = to_regclass('public.deliveries') AND con.conname ILIKE '%geo%'), 'none')
  UNION ALL
  SELECT '20', 'orders.status CHECK (info)', NULL,
         coalesce((SELECT string_agg(con.conname || ': ' || pg_get_constraintdef(con.oid), ' | ')
                     FROM pg_constraint con
                    WHERE con.conrelid = to_regclass('public.orders') AND con.contype = 'c'), 'none')
)
SELECT check_id, check_name,
       CASE WHEN ok IS NULL THEN 'INFO' WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result,
       detail
  FROM checks
 ORDER BY check_id, detail;
