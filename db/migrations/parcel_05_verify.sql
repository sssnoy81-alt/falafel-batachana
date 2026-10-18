-- FALAFEL BATACHANA — parcel_05_verify.sql (GATE S4-PARCEL-30B) — READ-ONLY, ONE SELECT.
-- Run AFTER Migration 05. Catalog only (plus row COUNTs): no names, no tracking numbers, no writes.
-- Expected: every row PASS (rows 13–14 INFO).
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
col AS (
  SELECT a.attnotnull, a.atthasdef, format_type(a.atttypid, a.atttypmod) AS ty
  FROM pg_attribute a WHERE a.attrelid = (SELECT oid FROM pr) AND a.attname = 'recipient_name' AND NOT a.attisdropped
),
con AS (
  SELECT c.convalidated, pg_get_constraintdef(c.oid) AS def
  FROM pg_constraint c WHERE c.conrelid = (SELECT oid FROM pr) AND c.conname = 'parcel_requests_recipient_name_format'
),
checks (check_id, check_name, ok, detail) AS (
  SELECT '01', 'recipient_name: text, NULL allowed, no default',
         EXISTS (SELECT 1 FROM col WHERE ty = 'text' AND NOT attnotnull AND NOT atthasdef),
         COALESCE((SELECT ty || CASE WHEN attnotnull THEN ' NOT NULL' ELSE ' NULL' END || CASE WHEN atthasdef THEN ' DEFAULT' ELSE '' END FROM col), 'missing')
  UNION ALL
  SELECT '02', 'parcel_requests_recipient_name_format: exact definition, validated',
         EXISTS (SELECT 1 FROM con WHERE convalidated AND def = 'CHECK (((recipient_name IS NULL) OR (((char_length(recipient_name) >= 2) AND (char_length(recipient_name) <= 60)) AND (recipient_name = btrim(recipient_name)) AND (recipient_name !~ ''[[:cntrl:]]''::text))))'),
         COALESCE((SELECT def FROM con), 'missing')
  UNION ALL
  SELECT '03', 'create_order_with_parcel: exactly one, signature unchanged',
         (SELECT count(*) FROM fn) = 1
         AND EXISTS (SELECT 1 FROM fn WHERE args = 'p_order jsonb, p_items jsonb, p_delivery jsonb, p_parcel jsonb'
                       AND res = 'TABLE(created_order_id uuid, created_order_number integer, created_daily_number integer)'),
         COALESCE((SELECT count(*) FROM fn)::text || ' found', '')
  UNION ALL
  SELECT '04', 'create_order_with_parcel: SECURITY INVOKER, search_path ''''',
         EXISTS (SELECT 1 FROM fn WHERE NOT prosecdef AND proconfig = ARRAY['search_path=""']), ''
  UNION ALL
  SELECT '05', 'create_order_with_parcel: reviewed parcel_05 body (LF afbe93d7… / 2656 or CRLF 6ceb72f6… / 2771)',
         EXISTS (SELECT 1 FROM fn WHERE (h = 'afbe93d74b201d6bd898edd2b6e28a63' AND len = 2656) OR (h = '6ceb72f6c80929adddd7a2b7bb1a0616' AND len = 2771)),
         COALESCE((SELECT h || ' / ' || len FROM fn LIMIT 1), 'missing')
  UNION ALL
  SELECT '06', 'EXECUTE unchanged: service_role yes, anon / authenticated no',
         EXISTS (SELECT 1 FROM fn WHERE has_function_privilege('service_role', oid, 'EXECUTE')
                   AND NOT has_function_privilege('anon', oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', oid, 'EXECUTE')), ''
  UNION ALL
  SELECT '07', 'table privileges unchanged (service_role S/I/U; anon / authenticated none)',
         has_table_privilege('service_role', 'public.parcel_requests', 'SELECT')
         AND has_table_privilege('service_role', 'public.parcel_requests', 'INSERT')
         AND has_table_privilege('service_role', 'public.parcel_requests', 'UPDATE')
         AND NOT has_table_privilege('service_role', 'public.parcel_requests', 'DELETE')
         AND NOT has_table_privilege('anon', 'public.parcel_requests', 'SELECT,INSERT,UPDATE,DELETE')
         AND NOT has_table_privilege('authenticated', 'public.parcel_requests', 'SELECT,INSERT,UPDATE,DELETE'), ''
  UNION ALL
  SELECT '08', 'RLS enabled (not forced), no policies — unchanged',
         EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = (SELECT oid FROM pr) AND c.relrowsecurity AND NOT c.relforcerowsecurity)
         AND NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = (SELECT oid FROM pr)), ''
  UNION ALL
  SELECT '09', 'parcel_requests_before_write unchanged (01b version)',
         EXISTS (SELECT 1 FROM bw WHERE (h = '9da7eec21b14950cfcbe4481ecbddf40' AND len = 5560) OR (h = 'bf1d4abc4698dd2213023df069b75255' AND len = 5397)),
         COALESCE((SELECT h || ' / ' || len FROM bw LIMIT 1), 'missing')
  UNION ALL
  SELECT '10', 'parcel_requests triggers unchanged and enabled',
         (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid = (SELECT oid FROM pr) AND NOT t.tgisinternal AND t.tgenabled = 'O'
            AND t.tgname IN ('parcel_requests_before_write', 'parcel_requests_log_insert', 'parcel_requests_log_status')) = 3, ''
  UNION ALL
  SELECT '11', 'no unexpected NOT NULL column without default on parcel_requests (wrapper INSERT stays valid)',
         NOT EXISTS (SELECT 1 FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                      WHERE a.attrelid = (SELECT oid FROM pr) AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
                        AND d.adbin IS NULL AND a.attgenerated = '' AND a.attname NOT IN ('order_id', 'branch_id', 'tracking_ref')), ''
  UNION ALL
  SELECT '12', 'all stored recipient names satisfy the rule (constraint validated)',
         EXISTS (SELECT 1 FROM con WHERE convalidated), ''
  UNION ALL
  SELECT '13', 'INFO parcel_requests rows (count only)', NULL, (SELECT count(*) FROM public.parcel_requests)::text
  UNION ALL
  SELECT '14', 'INFO rows with a recipient_name (count only)', NULL,
         (SELECT count(*) FROM public.parcel_requests WHERE recipient_name IS NOT NULL)::text
)
SELECT check_id, check_name,
       CASE WHEN ok IS NULL THEN 'INFO' WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result,
       detail
FROM checks
ORDER BY check_id;
