-- FALAFEL BATACHANA — s4_04d_production_preflight.sql (S4-INTEGRATIONS-04D1) — READ-ONLY, ONE SELECT.
-- Run BEFORE s4_04d_maale_dispatch_reconciliations.sql. Catalog + row COUNTs only: no customer data, no writes.
-- Expected: every row PASS (rows 07–08 INFO).
-- Columns: check_id | check_name | result | detail
WITH
keyed AS (
  SELECT 1 FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
  WHERE c.conrelid = to_regclass('public.orders') AND c.contype IN ('p', 'u') AND array_length(c.conkey, 1) = 1 AND a.attname = 'id'
),
checks (check_id, check_name, ok, detail) AS (
  SELECT '01', 'public.orders exists', to_regclass('public.orders') IS NOT NULL, ''
  UNION ALL
  SELECT '02', 'orders.id is uuid',
         (SELECT data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'id') = 'uuid',
         COALESCE((SELECT data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'id'), 'missing')
  UNION ALL
  SELECT '03', 'orders(id) is a primary / unique key (FK target)', EXISTS (SELECT 1 FROM keyed), ''
  UNION ALL
  SELECT '04', 'public.maale_dispatch_reconciliations does not exist yet', to_regclass('public.maale_dispatch_reconciliations') IS NULL, ''
  UNION ALL
  SELECT '05', 'roles service_role / anon / authenticated exist',
         (SELECT count(*) FROM pg_roles WHERE rolname IN ('service_role', 'anon', 'authenticated')) = 3, ''
  UNION ALL
  SELECT '06', 'gen_random_uuid() available', EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'gen_random_uuid' AND pronargs = 0), ''
  UNION ALL
  SELECT '07', 'INFO public.delivery_dispatches rows by status (counts only; untouched by 04D)', NULL,
         CASE WHEN to_regclass('public.delivery_dispatches') IS NULL THEN 'table missing'
              ELSE (xpath('/row/c/text()', query_to_xml('SELECT COALESCE(string_agg(status || ''='' || n, '', '' ORDER BY status), ''none'') AS c FROM (SELECT status, count(*) AS n FROM public.delivery_dispatches GROUP BY status) s', false, true, '')))[1]::text END
  UNION ALL
  SELECT '08', 'INFO server version', NULL, current_setting('server_version')
)
SELECT check_id, check_name,
       CASE WHEN ok IS NULL THEN 'INFO' WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result,
       detail
FROM checks
ORDER BY check_id;
