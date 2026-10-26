-- FALAFEL BATACHANA — s4_05_verify.sql (S4-MAALE-03) — READ-ONLY, ONE SELECT. Run AFTER the migration.
-- Catalog + counts only (no customer data). Expected: every row PASS (row 13 INFO).
-- Columns: check_id | check_name | result | detail
WITH
qcols AS (
  SELECT a.attname FROM pg_attribute a WHERE a.attrelid = to_regclass('public.maale_auto_dispatch_queue') AND a.attnum > 0 AND NOT a.attisdropped
),
upd_cols AS (
  SELECT string_agg(column_name, ',' ORDER BY column_name) AS cols FROM information_schema.column_privileges
  WHERE table_schema = 'public' AND table_name = 'maale_auto_dispatch_queue' AND grantee = 'service_role' AND privilege_type = 'UPDATE'
),
checks (check_id, check_name, ok, detail) AS (
  SELECT '01', 'queue + config tables exist',
         to_regclass('public.maale_auto_dispatch_queue') IS NOT NULL AND to_regclass('public.maale_auto_dispatch_config') IS NOT NULL, ''
  UNION ALL
  SELECT '02', 'queue columns exactly as designed',
         (SELECT string_agg(attname, ',' ORDER BY attname) FROM qcols)
           = 'attempts,branch_id,claimed_at,enqueued_at,finished_at,order_id,reason_code,state,updated_at',
         COALESCE((SELECT string_agg(attname, ',' ORDER BY attname) FROM qcols), 'missing')
  UNION ALL
  SELECT '03', 'queue order_id PK + FK → orders(id) RESTRICT',
         EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.maale_auto_dispatch_queue') AND contype = 'p')
         AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.maale_auto_dispatch_queue') AND contype = 'f'
                      AND confrelid = to_regclass('public.orders') AND confdeltype = 'r' AND confupdtype = 'r'), ''
  UNION ALL
  SELECT '04', 'RLS enabled on both tables, no policies',
         (SELECT bool_and(relrowsecurity) FROM pg_class WHERE oid IN (to_regclass('public.maale_auto_dispatch_queue'), to_regclass('public.maale_auto_dispatch_config')))
         AND NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid IN (to_regclass('public.maale_auto_dispatch_queue'), to_regclass('public.maale_auto_dispatch_config'))), ''
  UNION ALL
  SELECT '05', 'anon / authenticated / PUBLIC have no privilege on either table',
         NOT EXISTS (SELECT 1 FROM information_schema.table_privileges WHERE table_schema = 'public'
                      AND table_name IN ('maale_auto_dispatch_queue', 'maale_auto_dispatch_config') AND grantee IN ('anon', 'authenticated', 'PUBLIC'))
         AND NOT EXISTS (SELECT 1 FROM information_schema.column_privileges WHERE table_schema = 'public'
                      AND table_name IN ('maale_auto_dispatch_queue', 'maale_auto_dispatch_config') AND grantee IN ('anon', 'authenticated', 'PUBLIC')), ''
  UNION ALL
  SELECT '06', 'service_role on queue: SELECT; no INSERT / DELETE / TRUNCATE / table-wide UPDATE',
         has_table_privilege('service_role', 'public.maale_auto_dispatch_queue', 'SELECT')
         AND NOT has_table_privilege('service_role', 'public.maale_auto_dispatch_queue', 'INSERT')
         AND NOT has_table_privilege('service_role', 'public.maale_auto_dispatch_queue', 'DELETE')
         AND NOT has_table_privilege('service_role', 'public.maale_auto_dispatch_queue', 'TRUNCATE')
         AND NOT has_table_privilege('service_role', 'public.maale_auto_dispatch_queue', 'UPDATE'), ''
  UNION ALL
  SELECT '07', 'service_role UPDATE columns: state, reason_code, attempts, claimed_at, finished_at, updated_at only',
         (SELECT cols FROM upd_cols) = 'attempts,claimed_at,finished_at,reason_code,state,updated_at', COALESCE((SELECT cols FROM upd_cols), 'none')
  UNION ALL
  SELECT '08', 'service_role on config: SELECT only',
         has_table_privilege('service_role', 'public.maale_auto_dispatch_config', 'SELECT')
         AND NOT has_table_privilege('service_role', 'public.maale_auto_dispatch_config', 'UPDATE')
         AND NOT has_table_privilege('service_role', 'public.maale_auto_dispatch_config', 'INSERT')
         AND NOT has_table_privilege('service_role', 'public.maale_auto_dispatch_config', 'DELETE'), ''
  UNION ALL
  SELECT '09', 'config: exactly one row',
         (SELECT count(*) FROM public.maale_auto_dispatch_config) = 1,
         'enqueue_enabled=' || COALESCE((SELECT enqueue_enabled::text FROM public.maale_auto_dispatch_config), 'missing')
  UNION ALL
  SELECT '10', 'orders trigger: AFTER UPDATE OF status, received → confirmed, delivery only, enabled',
         EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = to_regclass('public.orders') AND t.tgname = 'orders_enqueue_maale_auto_dispatch'
                  AND t.tgenabled = 'O'
                  AND pg_get_triggerdef(t.oid) = 'CREATE TRIGGER orders_enqueue_maale_auto_dispatch AFTER UPDATE OF status ON public.orders FOR EACH ROW WHEN (((old.status = ''received''::text) AND (new.status = ''confirmed''::text) AND (new.type = ''delivery''::text))) EXECUTE FUNCTION orders_enqueue_maale_auto_dispatch()'), ''
  UNION ALL
  SELECT '11', 'enqueue function: SECURITY DEFINER, search_path empty, no PUBLIC EXECUTE',
         EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.orders_enqueue_maale_auto_dispatch()') AND p.prosecdef
                  AND p.proconfig @> ARRAY['search_path=""'])
         AND NOT has_function_privilege('anon', 'public.orders_enqueue_maale_auto_dispatch()', 'EXECUTE')
         AND NOT has_function_privilege('authenticated', 'public.orders_enqueue_maale_auto_dispatch()', 'EXECUTE'), ''
  UNION ALL
  SELECT '12', 'queue guard trigger: BEFORE UPDATE, enabled',
         EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = to_regclass('public.maale_auto_dispatch_queue')
                  AND t.tgname = 'maale_auto_dispatch_queue_guard' AND t.tgenabled = 'O'
                  AND pg_get_triggerdef(t.oid) = 'CREATE TRIGGER maale_auto_dispatch_queue_guard BEFORE UPDATE ON public.maale_auto_dispatch_queue FOR EACH ROW EXECUTE FUNCTION maale_auto_dispatch_queue_guard()'), ''
  UNION ALL
  SELECT '13', 'INFO queue rows by state (counts only)', NULL,
         COALESCE((SELECT string_agg(state || '=' || n, ', ' ORDER BY state) FROM (SELECT state, count(*) AS n FROM public.maale_auto_dispatch_queue GROUP BY state) s), 'none')
)
SELECT check_id, check_name,
       CASE WHEN ok IS NULL THEN 'INFO' WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result,
       detail
FROM checks
ORDER BY check_id;
