-- FALAFEL BATACHANA — s4_04b_production_preflight.sql (S4-INTEGRATIONS-04B1) — READ-ONLY, ONE SELECT.
-- Run BEFORE s4_04b_maale_quote_rate_limit.sql. Catalog only: no customer data, no writes.
-- Expected: every row PASS (rows 09–10 INFO).
-- Columns: check_id | check_name | result | detail
WITH
col AS (
  SELECT table_name, column_name, data_type FROM information_schema.columns
  WHERE table_schema = 'public' AND ((table_name = 'orders' AND column_name IN ('id', 'branch_id')) OR (table_name = 'branches' AND column_name = 'id'))
),
keyed AS (
  SELECT c.conrelid::regclass::text AS rel
  FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
  WHERE c.contype IN ('p', 'u') AND array_length(c.conkey, 1) = 1 AND a.attname = 'id'
    AND c.conrelid IN (to_regclass('public.orders'), to_regclass('public.branches'))
),
checks (check_id, check_name, ok, detail) AS (
  SELECT '01', 'public.orders and public.branches exist',
         to_regclass('public.orders') IS NOT NULL AND to_regclass('public.branches') IS NOT NULL, ''
  UNION ALL
  SELECT '02', 'orders.id, orders.branch_id, branches.id are uuid',
         (SELECT count(*) FROM col WHERE data_type = 'uuid') = 3,
         (SELECT string_agg(table_name || '.' || column_name || '=' || data_type, ', ' ORDER BY table_name, column_name) FROM col)
  UNION ALL
  SELECT '03', 'orders(id) and branches(id) are primary / unique keys (FK targets)',
         (SELECT count(DISTINCT rel) FROM keyed) = 2, COALESCE((SELECT string_agg(DISTINCT rel, ', ') FROM keyed), 'none')
  UNION ALL
  SELECT '04', 'public.maale_dispatch_requests does not exist yet',
         to_regclass('public.maale_dispatch_requests') IS NULL, ''
  UNION ALL
  SELECT '05', 'public.consume_maale_quote_slot does not exist yet (any overload)',
         NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                      WHERE n.nspname = 'public' AND p.proname = 'consume_maale_quote_slot'), ''
  UNION ALL
  SELECT '06', 'roles service_role / anon / authenticated exist',
         (SELECT count(*) FROM pg_roles WHERE rolname IN ('service_role', 'anon', 'authenticated')) = 3, ''
  UNION ALL
  SELECT '07', 'service_role can SELECT public.orders (needed by the SECURITY INVOKER function)',
         has_table_privilege('service_role', 'public.orders', 'SELECT'), ''
  UNION ALL
  SELECT '08', 'gen_random_uuid() available',
         EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'gen_random_uuid' AND pronargs = 0), ''
  UNION ALL
  SELECT '09', 'INFO public.delivery_dispatches rows (count only; untouched by 04B)', NULL,
         CASE WHEN to_regclass('public.delivery_dispatches') IS NULL THEN 'table missing'
              ELSE (xpath('/row/c/text()', query_to_xml('SELECT count(*) AS c FROM public.delivery_dispatches', false, true, '')))[1]::text END
  UNION ALL
  SELECT '10', 'INFO server version', NULL, current_setting('server_version')
)
SELECT check_id, check_name,
       CASE WHEN ok IS NULL THEN 'INFO' WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result,
       detail
FROM checks
ORDER BY check_id;
