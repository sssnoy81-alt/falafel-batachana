-- FALAFEL BATACHANA — parcel_05_production_preflight.sql (GATE S4-PARCEL-30B) — READ-ONLY, ONE SELECT.
-- Run BEFORE Migration 05. Catalog only (plus one row COUNT): no table rows, no names, no tracking numbers, no writes.
-- Expected before installation: every row PASS (rows 14–15 INFO). Rows 09 / 10 FAIL once Migration 05 is installed
-- (that is expected — this is a pre-install check; use parcel_05_verify.sql afterwards).
-- Columns: check_id | check_name | result | detail
WITH
fn AS (
  SELECT p.oid, pg_get_function_identity_arguments(p.oid) AS args, pg_get_function_result(p.oid) AS res,
         p.prosecdef, p.proconfig, md5(p.prosrc) AS h, length(p.prosrc) AS len
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'create_order_with_parcel'
),
bw AS (
  SELECT md5(p.prosrc) AS h, length(p.prosrc) AS len
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'parcel_requests_before_write'
),
pr AS (SELECT to_regclass('public.parcel_requests') AS oid),
checks (check_id, check_name, ok, detail) AS (
  SELECT '01', 'public.parcel_requests and public.orders exist',
         (SELECT oid FROM pr) IS NOT NULL AND to_regclass('public.orders') IS NOT NULL, ''
  UNION ALL
  SELECT '02', 'exactly one public.create_order_with_parcel', (SELECT count(*) FROM fn) = 1,
         (SELECT count(*) FROM fn)::text || ' found'
  UNION ALL
  SELECT '03', 'signature unchanged (4 × jsonb → TABLE(created_order_id, created_order_number, created_daily_number))',
         EXISTS (SELECT 1 FROM fn WHERE args = 'p_order jsonb, p_items jsonb, p_delivery jsonb, p_parcel jsonb'
                   AND res = 'TABLE(created_order_id uuid, created_order_number integer, created_daily_number integer)'),
         COALESCE((SELECT args FROM fn LIMIT 1), 'missing')
  UNION ALL
  SELECT '04', 'SECURITY INVOKER, search_path ''''',
         EXISTS (SELECT 1 FROM fn WHERE NOT prosecdef AND proconfig = ARRAY['search_path=""']),
         COALESCE((SELECT CASE WHEN prosecdef THEN 'DEFINER' ELSE 'INVOKER' END || ' ' || COALESCE(array_to_string(proconfig, ','), 'no config') FROM fn LIMIT 1), 'missing')
  UNION ALL
  SELECT '05', 'body is the audited Production source (md5 7d491c09… / 2474)',
         EXISTS (SELECT 1 FROM fn WHERE h = '7d491c097bf60b7e17beae25890b1238' AND len = 2474),
         COALESCE((SELECT h || ' / ' || len FROM fn LIMIT 1), 'missing')
  UNION ALL
  SELECT '06', 'EXECUTE: service_role yes, anon / authenticated no',
         EXISTS (SELECT 1 FROM fn WHERE has_function_privilege('service_role', oid, 'EXECUTE')
                   AND NOT has_function_privilege('anon', oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', oid, 'EXECUTE')),
         ''
  UNION ALL
  SELECT '07', 'service_role can SELECT / INSERT / UPDATE parcel_requests',
         (SELECT oid FROM pr) IS NOT NULL
         AND has_table_privilege('service_role', 'public.parcel_requests', 'SELECT')
         AND has_table_privilege('service_role', 'public.parcel_requests', 'INSERT')
         AND has_table_privilege('service_role', 'public.parcel_requests', 'UPDATE'), ''
  UNION ALL
  SELECT '08', 'anon / authenticated have no privileges on parcel_requests',
         (SELECT oid FROM pr) IS NOT NULL
         AND NOT has_table_privilege('anon', 'public.parcel_requests', 'SELECT,INSERT,UPDATE,DELETE')
         AND NOT has_table_privilege('authenticated', 'public.parcel_requests', 'SELECT,INSERT,UPDATE,DELETE'), ''
  UNION ALL
  SELECT '09', 'column parcel_requests.recipient_name does not exist yet',
         NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = (SELECT oid FROM pr) AND attname = 'recipient_name' AND NOT attisdropped), ''
  UNION ALL
  SELECT '10', 'constraint parcel_requests_recipient_name_format does not exist yet',
         NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = (SELECT oid FROM pr) AND conname = 'parcel_requests_recipient_name_format'), ''
  UNION ALL
  SELECT '11', 'RLS enabled (not forced), no policies on parcel_requests',
         EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = (SELECT oid FROM pr) AND c.relrowsecurity AND NOT c.relforcerowsecurity)
         AND NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = (SELECT oid FROM pr)), ''
  UNION ALL
  SELECT '12', 'parcel_requests_before_write is the installed 01b version (unchanged by 05)',
         EXISTS (SELECT 1 FROM bw WHERE (h = '9da7eec21b14950cfcbe4481ecbddf40' AND len = 5560) OR (h = 'bf1d4abc4698dd2213023df069b75255' AND len = 5397)),
         COALESCE((SELECT h || ' / ' || len FROM bw LIMIT 1), 'missing')
  UNION ALL
  SELECT '13', 'parcel_requests triggers present and enabled (before_write, log_insert, log_status)',
         (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid = (SELECT oid FROM pr) AND NOT t.tgisinternal AND t.tgenabled = 'O'
            AND t.tgname IN ('parcel_requests_before_write', 'parcel_requests_log_insert', 'parcel_requests_log_status')) = 3, ''
  UNION ALL
  SELECT '14', 'INFO server', NULL, 'PostgreSQL ' || current_setting('server_version') || ', user ' || current_user
  UNION ALL
  SELECT '15', 'INFO parcel_requests rows (count only)', NULL,
         (SELECT count(*) FROM public.parcel_requests)::text
)
SELECT check_id, check_name,
       CASE WHEN ok IS NULL THEN 'INFO' WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result,
       detail
FROM checks
ORDER BY check_id;
