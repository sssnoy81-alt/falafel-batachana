-- FALAFEL BATACHANA — s4_05_production_preflight.sql (S4-MAALE-03) — READ-ONLY, ONE SELECT.
-- Run BEFORE s4_05_maale_auto_dispatch_queue.sql. Catalog + row COUNTs only: no customer data, no writes.
-- Expected: every row PASS (rows 09–11 INFO).
-- Columns: check_id | check_name | result | detail
WITH
col AS (
  SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'orders'
),
keyed AS (
  SELECT 1 FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
  WHERE c.conrelid = to_regclass('public.orders') AND c.contype IN ('p', 'u') AND array_length(c.conkey, 1) = 1 AND a.attname = 'id'
),
checks (check_id, check_name, ok, detail) AS (
  SELECT '01', 'public.orders exists', to_regclass('public.orders') IS NOT NULL, ''
  UNION ALL
  SELECT '02', 'orders.id uuid, status text, type text, branch_id uuid, created_at timestamptz',
         (SELECT count(*) FROM col WHERE (column_name, data_type) IN (('id', 'uuid'), ('status', 'text'), ('type', 'text'), ('branch_id', 'uuid'),
                                                                       ('created_at', 'timestamp with time zone'))) = 5,
         COALESCE((SELECT string_agg(column_name || ':' || data_type, ', ' ORDER BY column_name) FROM col
                    WHERE column_name IN ('id', 'status', 'type', 'branch_id', 'created_at')), 'missing')
  UNION ALL
  SELECT '03', 'orders(id) is a primary / unique key (FK target)', EXISTS (SELECT 1 FROM keyed), ''
  UNION ALL
  SELECT '04', 'public.delivery_dispatches exists (dispatch service target)', to_regclass('public.delivery_dispatches') IS NOT NULL, ''
  UNION ALL
  SELECT '05', 's4_05 tables do not exist yet',
         to_regclass('public.maale_auto_dispatch_queue') IS NULL AND to_regclass('public.maale_auto_dispatch_config') IS NULL, ''
  UNION ALL
  SELECT '06', 's4_05 functions / trigger do not exist yet',
         NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
                      AND p.proname IN ('orders_enqueue_maale_auto_dispatch', 'maale_auto_dispatch_queue_guard',
                                        'enqueue_missing_maale_auto_dispatch', 'maale_auto_dispatch_config_guard'))
         AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('public.orders') AND tgname = 'orders_enqueue_maale_auto_dispatch'), ''
  UNION ALL
  SELECT '07', 'roles service_role / anon / authenticated exist',
         (SELECT count(*) FROM pg_roles WHERE rolname IN ('service_role', 'anon', 'authenticated')) = 3, ''
  UNION ALL
  SELECT '08', 'orders.status values seen are within the kitchen status set',
         NOT EXISTS (SELECT 1 FROM public.orders WHERE status NOT IN ('received', 'confirmed', 'preparing', 'ready', 'delivered', 'cancelled')), ''
  UNION ALL
  SELECT '09', 'INFO user triggers on public.orders (names only)', NULL,
         COALESCE((SELECT string_agg(tgname, ', ' ORDER BY tgname) FROM pg_trigger WHERE tgrelid = to_regclass('public.orders') AND NOT tgisinternal), 'none')
  UNION ALL
  SELECT '10', 'INFO delivery orders currently confirmed / preparing (counts only — a task is created only by a FUTURE confirmation)', NULL,
         (SELECT count(*)::text FROM public.orders WHERE type = 'delivery' AND status IN ('confirmed', 'preparing'))
  UNION ALL
  SELECT '11', 'INFO server version', NULL, current_setting('server_version')
)
SELECT check_id, check_name,
       CASE WHEN ok IS NULL THEN 'INFO' WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result,
       detail
FROM checks
ORDER BY check_id;
