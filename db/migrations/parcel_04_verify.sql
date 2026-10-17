-- FALAFEL BATACHANA — PARCEL MODULE — parcel_04_verify.sql (GATE M04-B)
-- READ-ONLY verification after parcel_04_cancel_gate.sql. ONE statement (WITH … SELECT), ONE result table:
--   check_id | check_name | result (PASS / FAIL / INFO) | detail
-- Expected after install: every non-INFO row PASS. Before install, rows 01–04 FAIL by design.
-- Also re-checks Migration 03 next to it: parcel_03_verify.sql row 05 ("exactly two triggers") is expected to FAIL
-- once parcel_04 is installed — this query replaces that check.
-- Prints no function bodies, tracking numbers or customer data (fingerprints, flags, names and counts only).
-- NOT EXECUTED YET.

WITH
fn AS (
  SELECT p.oid, p.proname, p.prosecdef, p.proconfig, l.lanname, p.proacl, p.proowner,
         md5(p.prosrc) AS h, length(p.prosrc) AS len,
         pg_get_function_identity_arguments(p.oid) AS args, pg_get_function_result(p.oid) AS res
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang
   WHERE n.nspname = 'public'
     AND p.proname IN ('orders_parcel_cancel_gate', 'orders_parcel_accept_gate', 'orders_parcel_cancel_sync',
                       'parcel_requests_before_write', 'parcel_requests_log_event', 'parcel_events_append_only',
                       'create_order_with_parcel', 'create_order')
),
tr AS (
  SELECT t.tgname, t.tgfoid, t.tgenabled::text AS en, t.tgtype, t.tgattr::text AS attrs, pg_get_triggerdef(t.oid) AS def
    FROM pg_trigger t WHERE t.tgrelid = to_regclass('public.orders') AND NOT t.tgisinternal
),
cg AS (SELECT * FROM fn WHERE proname = 'orders_parcel_cancel_gate'),
exec_leak AS (
  SELECT f.proname FROM fn f, LATERAL aclexplode(coalesce(f.proacl, acldefault('f', f.proowner))) AS a
   WHERE f.proname = 'orders_parcel_cancel_gate' AND a.privilege_type = 'EXECUTE'
     AND (a.grantee = 0 OR a.grantee IN (SELECT r.oid FROM pg_roles r WHERE r.rolname IN ('anon', 'authenticated', 'service_role')))
),
upd_pol AS (
  SELECT r.oid AS rid, p.polpermissive AS permissive,
         coalesce(pg_get_expr(p.polqual, p.polrelid), '') = 'false' AS using_false,
         coalesce(pg_get_expr(coalesce(p.polwithcheck, p.polqual), p.polrelid), '') = 'false' AS check_false
    FROM pg_roles r, pg_policy p
   WHERE p.polrelid = to_regclass('public.orders') AND p.polcmd IN ('w', '*')
     AND (0 = ANY (p.polroles) OR EXISTS (SELECT 1 FROM unnest(p.polroles) AS u(x) WHERE pg_has_role(r.oid, u.x, 'USAGE')))
),
reach_bad AS (   -- roles that can actually update orders rows but could not run the cancel gate
  SELECT r.rolname
    FROM pg_roles r, pg_class o, pg_class pr
   WHERE o.oid = to_regclass('public.orders') AND pr.oid = to_regclass('public.parcel_requests')
     AND r.rolname !~ '^pg_' AND NOT r.rolsuper
     AND has_table_privilege(r.oid, o.oid, 'UPDATE')
     AND (r.rolbypassrls OR NOT o.relrowsecurity
          OR (pg_has_role(r.oid, o.relowner, 'USAGE') AND NOT o.relforcerowsecurity)
          OR (    EXISTS (SELECT 1 FROM upd_pol up WHERE up.rid = r.oid AND up.permissive AND NOT up.using_false)
              AND EXISTS (SELECT 1 FROM upd_pol up WHERE up.rid = r.oid AND up.permissive AND NOT up.check_false)
              AND NOT EXISTS (SELECT 1 FROM upd_pol up WHERE up.rid = r.oid AND NOT up.permissive AND (up.using_false OR up.check_false))))
     AND NOT (has_table_privilege(r.oid, pr.oid, 'SELECT') AND has_table_privilege(r.oid, pr.oid, 'UPDATE')
              AND (r.rolbypassrls OR pg_has_role(r.oid, pr.relowner, 'USAGE')))
),
checks(check_id, check_name, ok, detail) AS (
  SELECT '01', 'cancel gate function: INVOKER, plpgsql, search_path='''', reviewed source',
         (SELECT count(*) FROM cg) = 1
           AND EXISTS (SELECT 1 FROM cg WHERE NOT prosecdef AND lanname = 'plpgsql' AND args = '' AND res = 'trigger'
                         AND proconfig = ARRAY['search_path=""']
                         AND ((h = '24c67346a3bec5bc84d9d2d7622094e6' AND len = 1048) OR (h = '08c3c845797cf65fa177a9b64f001674' AND len = 1076))),
         coalesce((SELECT 'md5 ' || h || ' / ' || len FROM cg LIMIT 1), 'not installed')
  UNION ALL
  SELECT '02', 'cancel gate trigger: BEFORE UPDATE ROW, enabled, received → cancelled only',
         EXISTS (SELECT 1 FROM tr t JOIN cg ON cg.oid = t.tgfoid
                  WHERE t.tgname = 'orders_parcel_cancel_gate' AND t.en = 'O' AND t.tgtype = 19 AND t.attrs = ''
                    AND t.def ~ $re$WHEN \(\(\(old\.status = 'received'::text\) AND \(new\.status = 'cancelled'::text\)\)\)$re$),
         coalesce((SELECT 'tgtype ' || tgtype || ', enabled ' || en FROM tr WHERE tgname = 'orders_parcel_cancel_gate'), 'not installed')
  UNION ALL
  SELECT '03', 'cancel gate: EXECUTE not granted to PUBLIC / anon / authenticated / service_role',
         (SELECT count(*) FROM cg) = 1 AND NOT EXISTS (SELECT 1 FROM exec_leak),
         coalesce((SELECT string_agg(proname, ', ') FROM exec_leak), 'no leak')
  UNION ALL
  SELECT '04', 'public.orders has exactly three user triggers (Migration 03 pair + cancel gate)',
         (SELECT count(*) FROM tr) = 3
           AND NOT EXISTS (SELECT 1 FROM tr WHERE tgname NOT IN ('orders_parcel_accept_gate', 'orders_parcel_cancel_sync', 'orders_parcel_cancel_gate')),
         (SELECT count(*) FROM tr)::text || ' user trigger(s)'
  UNION ALL
  SELECT '05', 'Migration 03 acceptance gate unchanged (function + trigger)',
         EXISTS (SELECT 1 FROM fn f JOIN tr t ON t.tgfoid = f.oid
                  WHERE f.proname = 'orders_parcel_accept_gate' AND t.tgname = 'orders_parcel_accept_gate' AND t.en = 'O' AND t.tgtype = 19
                    AND ((f.h = 'e3c0c90960cbbf2097583aea04b3c458' AND f.len = 1041) OR (f.h = '5ad506d6cb4fcbf8d4ff75cc8d0429d8' AND f.len = 1071))
                    AND t.def ~ $re$WHEN \(\(\(old\.status = 'received'::text\) AND \(new\.status IS DISTINCT FROM 'received'::text\) AND \(new\.status IS DISTINCT FROM 'cancelled'::text\)\)\)$re$),
         coalesce((SELECT 'md5 ' || h || ' / ' || len FROM fn WHERE proname = 'orders_parcel_accept_gate'), 'missing')
  UNION ALL
  SELECT '06', 'Migration 03 cancel sync unchanged (function + trigger)',
         EXISTS (SELECT 1 FROM fn f JOIN tr t ON t.tgfoid = f.oid
                  WHERE f.proname = 'orders_parcel_cancel_sync' AND t.tgname = 'orders_parcel_cancel_sync' AND t.en = 'O' AND t.tgtype = 17
                    AND ((f.h = '7421fc0264202b2b571e7fe8934f32c0' AND f.len = 918) OR (f.h = '32aa88ffc07ef9f09c6ecdd884aa4836' AND f.len = 938))
                    AND t.def ~ $re$WHEN \(\(\(new\.status = 'cancelled'::text\) AND \(old\.status IS DISTINCT FROM 'cancelled'::text\)\)\)$re$),
         coalesce((SELECT 'md5 ' || h || ' / ' || len FROM fn WHERE proname = 'orders_parcel_cancel_sync'), 'missing')
  UNION ALL
  SELECT '07', 'parcel_requests_before_write = parcel_01b (unchanged)',
         EXISTS (SELECT 1 FROM fn WHERE proname = 'parcel_requests_before_write'
                   AND ((h = '9da7eec21b14950cfcbe4481ecbddf40' AND len = 5560) OR (h = 'bf1d4abc4698dd2213023df069b75255' AND len = 5397))),
         coalesce((SELECT 'md5 ' || h || ' / ' || len FROM fn WHERE proname = 'parcel_requests_before_write'), 'missing')
  UNION ALL
  SELECT '08', 'log_event / append_only / create_order_with_parcel / create_order unchanged',
         EXISTS (SELECT 1 FROM fn WHERE proname = 'parcel_requests_log_event' AND h = '08de848cf7badf72b426972a12590957' AND len = 281)
           AND EXISTS (SELECT 1 FROM fn WHERE proname = 'parcel_events_append_only' AND h = 'c098c15fc3a0b898f7f148f4b2cc9dea' AND len = 86)
           AND EXISTS (SELECT 1 FROM fn WHERE proname = 'create_order_with_parcel' AND h = '7d491c097bf60b7e17beae25890b1238' AND len = 2474)
           AND EXISTS (SELECT 1 FROM fn WHERE proname = 'create_order' AND h = 'db92e75f8bfdadb6d78be035da855996' AND len = 6416),
         'fingerprints'
  UNION ALL
  SELECT '09', 'service_role: BYPASSRLS + SELECT / UPDATE on parcel_requests (needed by FOR SHARE)',
         EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role' AND rolbypassrls)
           AND has_table_privilege('service_role', 'public.parcel_requests', 'SELECT')
           AND has_table_privilege('service_role', 'public.parcel_requests', 'UPDATE'),
         'service_role'
  UNION ALL
  SELECT '10', 'FOOD-ONLY SAFETY: every role that can update orders rows can run the cancel gate',
         NOT EXISTS (SELECT 1 FROM reach_bad),
         coalesce('cannot: ' || (SELECT string_agg(rolname, ', ' ORDER BY rolname) FROM reach_bad), 'all can')
  UNION ALL
  SELECT '11', 'parcel_requests: no grantee besides owner and service_role; RLS enabled, not forced',
         NOT EXISTS (SELECT 1 FROM pg_class c, LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) AS a
                      WHERE c.oid = to_regclass('public.parcel_requests') AND a.grantee <> c.relowner
                        AND a.grantee NOT IN (SELECT r.oid FROM pg_roles r WHERE r.rolname = 'service_role'))
           AND EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = to_regclass('public.parcel_requests') AND c.relrowsecurity AND NOT c.relforcerowsecurity),
         'parcel_requests'
  UNION ALL
  SELECT '12', 'data: no cancelled order with a parcel still in the store (counts only)',
         (SELECT count(*) FROM public.orders o JOIN public.parcel_requests pr ON pr.order_id = o.id
           WHERE o.status = 'cancelled' AND pr.status IN ('awaiting_search', 'not_found', 'found')) = 0,
         (SELECT count(*) FROM public.orders o JOIN public.parcel_requests pr ON pr.order_id = o.id
           WHERE o.status = 'cancelled' AND pr.status IN ('awaiting_search', 'not_found', 'found'))::text || ' row(s)'
  UNION ALL
  SELECT '13', 'counts (info)', NULL,
         (SELECT count(*) FROM public.parcel_requests)::text || ' parcel(s), ' || (SELECT count(*) FROM public.parcel_events)::text || ' event(s)'
)
SELECT check_id, check_name,
       CASE WHEN ok IS NULL THEN 'INFO' WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result,
       detail
  FROM checks
 ORDER BY check_id;
