-- FALAFEL BATACHANA — PARCEL MODULE — parcel_03_verify.sql (GATE 03I / stage S3)
-- READ-ONLY verification after parcel_03_orders_gate.sql. ONE statement (WITH … SELECT), ONE result table:
--   check_id | check_name | result (PASS / FAIL / INFO) | detail
-- Expected after install: every row PASS (INFO rows are counts only). Before install, rows 01–06 FAIL by design.
-- Prints no function bodies, no tracking numbers and no customer data (fingerprints, flags and counts only).
-- Supersedes the parcel_03 rows of parcel_99_verify.sql (those expect the old received→confirmed-only WHEN clause).
-- NOT EXECUTED YET.

WITH
fn AS (
  SELECT p.oid, p.proname, p.prosecdef, p.proconfig, l.lanname, p.proacl, p.proowner,
         md5(p.prosrc) AS h, length(p.prosrc) AS len,
         pg_get_function_identity_arguments(p.oid) AS args, pg_get_function_result(p.oid) AS res
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_language l ON l.oid = p.prolang
   WHERE n.nspname = 'public'
     AND p.proname IN ('orders_parcel_accept_gate', 'orders_parcel_cancel_sync', 'parcel_requests_before_write',
                       'parcel_requests_log_event', 'parcel_events_append_only', 'create_order_with_parcel', 'create_order')
),
tr AS (
  SELECT t.tgname, t.tgfoid, t.tgenabled, t.tgtype, t.tgattr::text AS attrs, pg_get_triggerdef(t.oid) AS def
    FROM pg_trigger t
   WHERE t.tgrelid = to_regclass('public.orders') AND NOT t.tgisinternal
),
gate_fn AS (
  SELECT * FROM fn WHERE proname = 'orders_parcel_accept_gate'
),
sync_fn AS (
  SELECT * FROM fn WHERE proname = 'orders_parcel_cancel_sync'
),
exec_leak AS (
  SELECT f.proname
    FROM fn f, LATERAL aclexplode(coalesce(f.proacl, acldefault('f', f.proowner))) AS a
   WHERE f.proname IN ('orders_parcel_accept_gate', 'orders_parcel_cancel_sync')
     AND a.privilege_type = 'EXECUTE'
     AND (a.grantee = 0 OR a.grantee IN (SELECT r.oid FROM pg_roles r WHERE r.rolname IN ('anon', 'authenticated', 'service_role')))
),
pr_grantees AS (
  SELECT DISTINCT a.grantee
    FROM pg_class c, LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) AS a
   WHERE c.oid = to_regclass('public.parcel_requests')
     AND a.grantee <> c.relowner
     AND a.grantee NOT IN (SELECT r.oid FROM pg_roles r WHERE r.rolname = 'service_role')
),
-- UPDATE / ALL policies on orders applying to anon / authenticated (PUBLIC or membership). Only the constant false
-- counts as denying; PostgreSQL admits a row only if some permissive USING and some permissive check (WITH CHECK, else
-- USING) pass and no restrictive one fails.
upd_pol AS (
  SELECT r.rolname, p.polpermissive AS permissive,
         coalesce(pg_get_expr(p.polqual, p.polrelid), '') = 'false' AS using_false,
         coalesce(pg_get_expr(coalesce(p.polwithcheck, p.polqual), p.polrelid), '') = 'false' AS check_false
    FROM pg_roles r, pg_policy p
   WHERE r.rolname IN ('anon', 'authenticated')
     AND p.polrelid = to_regclass('public.orders') AND p.polcmd IN ('w', '*')
     AND (0 = ANY (p.polroles) OR EXISTS (SELECT 1 FROM unnest(p.polroles) AS u(x) WHERE pg_has_role(r.oid, u.x, 'USAGE')))
),
orders_update_policies AS (   -- anon / authenticated roles whose UPDATE policies can admit a row
  SELECT r.rolname
    FROM pg_roles r
   WHERE r.rolname IN ('anon', 'authenticated')
     AND EXISTS (SELECT 1 FROM upd_pol up WHERE up.rolname = r.rolname AND up.permissive AND NOT up.using_false)
     AND EXISTS (SELECT 1 FROM upd_pol up WHERE up.rolname = r.rolname AND up.permissive AND NOT up.check_false)
     AND NOT EXISTS (SELECT 1 FROM upd_pol up WHERE up.rolname = r.rolname AND NOT up.permissive AND (up.using_false OR up.check_false))
),
data_counts AS (
  SELECT
    (SELECT count(*) FROM public.parcel_requests) AS parcels,
    (SELECT count(*) FROM public.parcel_events) AS events,
    (SELECT count(*) FROM public.orders o JOIN public.parcel_requests pr ON pr.order_id = o.id
      WHERE o.status NOT IN ('received', 'cancelled') AND pr.status IN ('awaiting_search', 'not_found')) AS accepted_not_ready,
    (SELECT count(*) FROM public.orders o JOIN public.parcel_requests pr ON pr.order_id = o.id
      WHERE o.status = 'cancelled' AND pr.status IN ('awaiting_search', 'not_found', 'found')) AS cancelled_in_store,
    (SELECT count(*) FROM public.parcel_requests pr
      WHERE pr.status = 'cancelled' AND pr.close_reason = 'order_cancelled') AS synced_cancellations,
    (SELECT count(*) FROM public.parcel_requests pr
      WHERE pr.status = 'cancelled' AND pr.close_reason = 'order_cancelled'
        AND NOT EXISTS (SELECT 1 FROM public.parcel_events e
                         WHERE e.parcel_id = pr.id AND e.to_status = 'cancelled')) AS synced_without_event
),
checks(check_id, check_name, ok, detail) AS (
  SELECT '01', 'gate function: INVOKER, plpgsql, search_path='''', reviewed source',
         EXISTS (SELECT 1 FROM gate_fn g WHERE NOT g.prosecdef AND g.lanname = 'plpgsql' AND g.args = '' AND g.res = 'trigger'
                   AND g.proconfig = ARRAY['search_path=""']
                   AND ((g.h = 'e3c0c90960cbbf2097583aea04b3c458' AND g.len = 1041)
                        OR (g.h = '5ad506d6cb4fcbf8d4ff75cc8d0429d8' AND g.len = 1071)))
           AND (SELECT count(*) FROM gate_fn) = 1,
         coalesce((SELECT 'md5 ' || g.h || ' / ' || g.len || CASE WHEN g.prosecdef THEN ' DEFINER' ELSE ' INVOKER' END FROM gate_fn g LIMIT 1), 'not installed')
  UNION ALL
  SELECT '02', 'cancel-sync function: INVOKER, plpgsql, search_path='''', reviewed source',
         EXISTS (SELECT 1 FROM sync_fn s WHERE NOT s.prosecdef AND s.lanname = 'plpgsql' AND s.args = '' AND s.res = 'trigger'
                   AND s.proconfig = ARRAY['search_path=""']
                   AND ((s.h = '7421fc0264202b2b571e7fe8934f32c0' AND s.len = 918)
                        OR (s.h = '32aa88ffc07ef9f09c6ecdd884aa4836' AND s.len = 938)))
           AND (SELECT count(*) FROM sync_fn) = 1,
         coalesce((SELECT 'md5 ' || s.h || ' / ' || s.len || CASE WHEN s.prosecdef THEN ' DEFINER' ELSE ' INVOKER' END FROM sync_fn s LIMIT 1), 'not installed')
  UNION ALL
  SELECT '03', 'gate trigger: BEFORE UPDATE ROW, enabled, all non-cancel exits from received',
         EXISTS (SELECT 1 FROM tr t JOIN gate_fn g ON g.oid = t.tgfoid
                  WHERE t.tgname = 'orders_parcel_accept_gate' AND t.tgenabled = 'O' AND t.tgtype = 19 AND t.attrs = ''
                    AND t.def ~ $re$WHEN \(\(\(old\.status = 'received'::text\) AND \(new\.status IS DISTINCT FROM 'received'::text\) AND \(new\.status IS DISTINCT FROM 'cancelled'::text\)\)\)$re$),
         coalesce((SELECT 'tgtype ' || t.tgtype || ', enabled ' || t.tgenabled::text FROM tr t WHERE t.tgname = 'orders_parcel_accept_gate'), 'not installed')
  UNION ALL
  SELECT '04', 'cancel-sync trigger: AFTER UPDATE ROW, enabled, on entering cancelled',
         EXISTS (SELECT 1 FROM tr t JOIN sync_fn s ON s.oid = t.tgfoid
                  WHERE t.tgname = 'orders_parcel_cancel_sync' AND t.tgenabled = 'O' AND t.tgtype = 17 AND t.attrs = ''
                    AND t.def ~ $re$WHEN \(\(\(new\.status = 'cancelled'::text\) AND \(old\.status IS DISTINCT FROM 'cancelled'::text\)\)\)$re$),
         coalesce((SELECT 'tgtype ' || t.tgtype || ', enabled ' || t.tgenabled::text FROM tr t WHERE t.tgname = 'orders_parcel_cancel_sync'), 'not installed')
  UNION ALL
  SELECT '05', 'public.orders has exactly the two parcel_03 user triggers',
         (SELECT count(*) FROM tr) = 2
           AND NOT EXISTS (SELECT 1 FROM tr WHERE tgname NOT IN ('orders_parcel_accept_gate', 'orders_parcel_cancel_sync')),
         (SELECT count(*) FROM tr)::text || ' user trigger(s)'
  UNION ALL
  SELECT '06', 'gate functions: EXECUTE not granted to PUBLIC / anon / authenticated / service_role',
         (SELECT count(*) FROM gate_fn) = 1 AND (SELECT count(*) FROM sync_fn) = 1 AND NOT EXISTS (SELECT 1 FROM exec_leak),
         coalesce((SELECT string_agg(DISTINCT proname, ', ') FROM exec_leak), 'no leak')
  UNION ALL
  SELECT '07', 'parcel_requests_before_write = parcel_01b (unchanged)',
         EXISTS (SELECT 1 FROM fn f WHERE f.proname = 'parcel_requests_before_write'
                   AND ((f.h = '9da7eec21b14950cfcbe4481ecbddf40' AND f.len = 5560) OR (f.h = 'bf1d4abc4698dd2213023df069b75255' AND f.len = 5397))),
         coalesce((SELECT 'md5 ' || f.h || ' / ' || f.len FROM fn f WHERE f.proname = 'parcel_requests_before_write' LIMIT 1), 'missing')
  UNION ALL
  SELECT '08', 'parcel_requests_log_event unchanged',
         EXISTS (SELECT 1 FROM fn f WHERE f.proname = 'parcel_requests_log_event' AND f.h = '08de848cf7badf72b426972a12590957' AND f.len = 281),
         coalesce((SELECT 'md5 ' || f.h || ' / ' || f.len FROM fn f WHERE f.proname = 'parcel_requests_log_event' LIMIT 1), 'missing')
  UNION ALL
  SELECT '09', 'parcel_events_append_only unchanged',
         EXISTS (SELECT 1 FROM fn f WHERE f.proname = 'parcel_events_append_only' AND f.h = 'c098c15fc3a0b898f7f148f4b2cc9dea' AND f.len = 86),
         coalesce((SELECT 'md5 ' || f.h || ' / ' || f.len FROM fn f WHERE f.proname = 'parcel_events_append_only' LIMIT 1), 'missing')
  UNION ALL
  SELECT '10', 'create_order_with_parcel unchanged',
         EXISTS (SELECT 1 FROM fn f WHERE f.proname = 'create_order_with_parcel' AND f.h = '7d491c097bf60b7e17beae25890b1238' AND f.len = 2474),
         coalesce((SELECT 'md5 ' || f.h || ' / ' || f.len FROM fn f WHERE f.proname = 'create_order_with_parcel' LIMIT 1), 'missing')
  UNION ALL
  SELECT '11', 'original create_order unchanged',
         (SELECT count(*) FROM fn f WHERE f.proname = 'create_order') = 1
           AND EXISTS (SELECT 1 FROM fn f WHERE f.proname = 'create_order' AND f.h = 'db92e75f8bfdadb6d78be035da855996' AND f.len = 6416),
         coalesce((SELECT 'md5 ' || f.h || ' / ' || f.len FROM fn f WHERE f.proname = 'create_order' LIMIT 1), 'missing')
  UNION ALL
  SELECT '12', 'parcel_requests triggers present and enabled',
         (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid = to_regclass('public.parcel_requests') AND NOT t.tgisinternal AND t.tgenabled = 'O'
            AND t.tgname IN ('parcel_requests_before_write', 'parcel_requests_log_insert', 'parcel_requests_log_status')) = 3,
         (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid = to_regclass('public.parcel_requests') AND NOT t.tgisinternal)::text || ' user trigger(s)'
  UNION ALL
  SELECT '13', 'service_role: BYPASSRLS + privileges the triggers need',
         EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role' AND rolbypassrls)
           AND has_table_privilege('service_role', 'public.parcel_requests', 'SELECT')
           AND has_table_privilege('service_role', 'public.parcel_requests', 'UPDATE')
           AND has_table_privilege('service_role', 'public.parcel_events', 'INSERT')
           AND has_table_privilege('service_role', 'public.orders', 'SELECT')
           AND has_table_privilege('service_role', 'public.orders', 'UPDATE'),
         'SELECT/UPDATE parcel_requests, INSERT parcel_events, SELECT/UPDATE orders'
  UNION ALL
  SELECT '14', 'parcel_requests: no grantee besides owner and service_role',
         NOT EXISTS (SELECT 1 FROM pr_grantees),
         (SELECT count(*) FROM pr_grantees)::text || ' unexpected grantee(s)'
  UNION ALL
  SELECT '15', 'parcel tables: RLS enabled, not forced',
         (SELECT count(*) FROM pg_class c WHERE c.oid IN (to_regclass('public.parcel_requests'), to_regclass('public.parcel_events'))
            AND c.relrowsecurity AND NOT c.relforcerowsecurity) = 2,
         'parcel_requests + parcel_events'
  UNION ALL
  SELECT '16', 'orders: no UPDATE / ALL policy can admit a row for anon / authenticated',
         NOT EXISTS (SELECT 1 FROM orders_update_policies),
         coalesce('can update: ' || (SELECT string_agg(rolname, ', ' ORDER BY rolname) FROM orders_update_policies), 'none')
  UNION ALL
  SELECT '17', 'orders.status CHECK lists the six statuses',
         EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = to_regclass('public.orders') AND c.contype = 'c'
                   AND pg_get_constraintdef(c.oid) LIKE '%''received''%' AND pg_get_constraintdef(c.oid) LIKE '%''confirmed''%'
                   AND pg_get_constraintdef(c.oid) LIKE '%''preparing''%' AND pg_get_constraintdef(c.oid) LIKE '%''ready''%'
                   AND pg_get_constraintdef(c.oid) LIKE '%''delivered''%' AND pg_get_constraintdef(c.oid) LIKE '%''cancelled''%'),
         'CHECK on public.orders'
  UNION ALL
  SELECT '18', 'data: no accepted order with a parcel still awaiting_search / not_found',
         (SELECT accepted_not_ready FROM data_counts) = 0, (SELECT accepted_not_ready FROM data_counts)::text || ' row(s)'
  UNION ALL
  SELECT '19', 'data: no cancelled order with a parcel still in the store',
         (SELECT cancelled_in_store FROM data_counts) = 0, (SELECT cancelled_in_store FROM data_counts)::text || ' row(s)'
  UNION ALL
  SELECT '20', 'data: every order_cancelled parcel has its cancellation event',
         (SELECT synced_without_event FROM data_counts) = 0, (SELECT synced_without_event FROM data_counts)::text || ' row(s)'
  UNION ALL
  SELECT '21', 'counts (info)', NULL,
         (SELECT parcels || ' parcel(s), ' || events || ' event(s), ' || synced_cancellations || ' order_cancelled' FROM data_counts)
)
SELECT check_id, check_name,
       CASE WHEN ok IS NULL THEN 'INFO' WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result,
       detail
  FROM checks
 ORDER BY check_id;
