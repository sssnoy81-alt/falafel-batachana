-- FALAFEL BATACHANA — parcel_04_production_preflight.sql (GATE M04-C1)
-- READ-ONLY Production preflight BEFORE parcel_04_cancel_gate.sql. ONE statement (WITH … SELECT), ONE result table:
--   check_id | check_name | result (PASS / FAIL / INFO) | detail
-- Run manually in the Supabase SQL editor (as postgres). Every non-INFO row must be PASS before requesting install.
-- No writes, no DDL, no explicit locks (only the AccessShare locks of a plain SELECT). Prints no function bodies,
-- tracking numbers or customer data — fingerprints, names, flags and counts only.

WITH
cfg AS (SELECT current_setting('server_version_num')::int AS vnum, current_setting('server_version') AS vtxt, current_user AS me),
fn AS (
  SELECT p.oid, p.proname, p.prosecdef, p.proconfig, md5(p.prosrc) AS h, length(p.prosrc) AS len
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('parcel_requests_before_write', 'parcel_requests_log_event', 'parcel_events_append_only',
                       'create_order_with_parcel', 'create_order', 'orders_parcel_accept_gate', 'orders_parcel_cancel_sync')
),
rel AS (
  SELECT c.oid, c.relname, c.relowner, c.relrowsecurity AS rls, c.relforcerowsecurity AS force_rls
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname IN ('orders', 'parcel_requests', 'parcel_events')
),
otr AS (
  SELECT t.tgname, t.tgfoid, t.tgenabled::text AS en, t.tgtype, pg_get_triggerdef(t.oid) AS def
    FROM pg_trigger t WHERE t.tgrelid = to_regclass('public.orders') AND NOT t.tgisinternal
),
ptr AS (
  SELECT t.tgname, t.tgenabled::text AS en FROM pg_trigger t WHERE t.tgrelid = to_regclass('public.parcel_requests') AND NOT t.tgisinternal
),
pol AS (
  SELECT p.polname, p.polcmd::text AS cmd, p.polpermissive,
         CASE WHEN 0 = ANY (p.polroles) THEN 'PUBLIC'
              ELSE (SELECT string_agg(r.rolname, '+' ORDER BY r.rolname) FROM pg_roles r WHERE r.oid = ANY (p.polroles)) END AS roles,
         coalesce(pg_get_expr(p.polqual, p.polrelid), '-') AS using_expr,
         coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '-') AS check_expr
    FROM pg_policy p WHERE p.polrelid = to_regclass('public.orders')
),
upd_pol AS (
  SELECT r.oid AS rid, p.polpermissive AS permissive,
         coalesce(pg_get_expr(p.polqual, p.polrelid), '') = 'false' AS using_false,
         coalesce(pg_get_expr(coalesce(p.polwithcheck, p.polqual), p.polrelid), '') = 'false' AS check_false
    FROM pg_roles r, pg_policy p
   WHERE p.polrelid = to_regclass('public.orders') AND p.polcmd IN ('w', '*')
     AND (0 = ANY (p.polroles) OR EXISTS (SELECT 1 FROM unnest(p.polroles) AS u(x) WHERE pg_has_role(r.oid, u.x, 'USAGE')))
),
reach AS (   -- roles that can actually UPDATE rows of public.orders (superusers excluded)
  SELECT r.oid, r.rolname, r.rolbypassrls
    FROM pg_roles r, rel o
   WHERE o.relname = 'orders' AND r.rolname !~ '^pg_' AND NOT r.rolsuper
     AND has_table_privilege(r.oid, o.oid, 'UPDATE')
     AND (r.rolbypassrls OR NOT o.rls
          OR (pg_has_role(r.oid, o.relowner, 'USAGE') AND NOT o.force_rls)
          OR (    EXISTS (SELECT 1 FROM upd_pol up WHERE up.rid = r.oid AND up.permissive AND NOT up.using_false)
              AND EXISTS (SELECT 1 FROM upd_pol up WHERE up.rid = r.oid AND up.permissive AND NOT up.check_false)
              AND NOT EXISTS (SELECT 1 FROM upd_pol up WHERE up.rid = r.oid AND NOT up.permissive AND (up.using_false OR up.check_false))))
),
reach_bad AS (   -- …of those, roles that could NOT run the parcel_04 cancel gate (FOR SHARE on parcel_requests)
  SELECT rc.rolname FROM reach rc, rel pr
   WHERE pr.relname = 'parcel_requests'
     AND NOT (has_table_privilege(rc.oid, pr.oid, 'SELECT') AND has_table_privilege(rc.oid, pr.oid, 'UPDATE')
              AND (rc.rolbypassrls OR pg_has_role(rc.oid, pr.relowner, 'USAGE')))
),
checks(check_id, check_name, ok, detail) AS (
  SELECT '01', 'PostgreSQL version (local tests: 17.5)', (SELECT vnum BETWEEN 140000 AND 189999 FROM cfg), (SELECT vtxt FROM cfg)
  UNION ALL
  SELECT '02', 'running role can create the trigger (TRIGGER on orders, CREATE on schema public)',
         (SELECT has_table_privilege(me, 'public.orders', 'TRIGGER') AND has_schema_privilege(me, 'public', 'CREATE') FROM cfg),
         (SELECT 'current_user ' || me FROM cfg)
  UNION ALL
  SELECT '03', 'parcel_requests_before_write = parcel_01b',
         (SELECT count(*) FROM fn WHERE proname = 'parcel_requests_before_write') = 1
           AND EXISTS (SELECT 1 FROM fn WHERE proname = 'parcel_requests_before_write'
                         AND ((h = '9da7eec21b14950cfcbe4481ecbddf40' AND len = 5560) OR (h = 'bf1d4abc4698dd2213023df069b75255' AND len = 5397))),
         coalesce((SELECT string_agg(h || ' / ' || len, '; ') FROM fn WHERE proname = 'parcel_requests_before_write'), 'missing')
  UNION ALL
  SELECT '04', 'parcel_requests_log_event + parcel_events_append_only unchanged',
         EXISTS (SELECT 1 FROM fn WHERE proname = 'parcel_requests_log_event' AND h = '08de848cf7badf72b426972a12590957' AND len = 281)
           AND EXISTS (SELECT 1 FROM fn WHERE proname = 'parcel_events_append_only' AND h = 'c098c15fc3a0b898f7f148f4b2cc9dea' AND len = 86),
         'log_event / append_only'
  UNION ALL
  SELECT '05', 'create_order_with_parcel unchanged',
         EXISTS (SELECT 1 FROM fn WHERE proname = 'create_order_with_parcel' AND h = '7d491c097bf60b7e17beae25890b1238' AND len = 2474),
         coalesce((SELECT string_agg(h || ' / ' || len, '; ') FROM fn WHERE proname = 'create_order_with_parcel'), 'missing')
  UNION ALL
  SELECT '06', 'original create_order unchanged',
         (SELECT count(*) FROM fn WHERE proname = 'create_order') = 1
           AND EXISTS (SELECT 1 FROM fn WHERE proname = 'create_order' AND h = 'db92e75f8bfdadb6d78be035da855996' AND len = 6416),
         coalesce((SELECT string_agg(h || ' / ' || len, '; ') FROM fn WHERE proname = 'create_order'), 'missing')
  UNION ALL
  SELECT '07', 'Migration 03 acceptance gate function: reviewed source, INVOKER, search_path=''''',
         EXISTS (SELECT 1 FROM fn WHERE proname = 'orders_parcel_accept_gate' AND NOT prosecdef AND proconfig = ARRAY['search_path=""']
                   AND ((h = 'e3c0c90960cbbf2097583aea04b3c458' AND len = 1041) OR (h = '5ad506d6cb4fcbf8d4ff75cc8d0429d8' AND len = 1071))),
         coalesce((SELECT h || ' / ' || len FROM fn WHERE proname = 'orders_parcel_accept_gate'), 'missing')
  UNION ALL
  SELECT '08', 'Migration 03 cancel sync function: reviewed source, INVOKER, search_path=''''',
         EXISTS (SELECT 1 FROM fn WHERE proname = 'orders_parcel_cancel_sync' AND NOT prosecdef AND proconfig = ARRAY['search_path=""']
                   AND ((h = '7421fc0264202b2b571e7fe8934f32c0' AND len = 918) OR (h = '32aa88ffc07ef9f09c6ecdd884aa4836' AND len = 938))),
         coalesce((SELECT h || ' / ' || len FROM fn WHERE proname = 'orders_parcel_cancel_sync'), 'missing')
  UNION ALL
  SELECT '09', 'triggers on orders: exactly the Migration 03 pair, enabled, reviewed definitions',
         (SELECT count(*) FROM otr) = 2
           AND EXISTS (SELECT 1 FROM otr t JOIN fn f ON f.oid = t.tgfoid
                        WHERE t.tgname = 'orders_parcel_accept_gate' AND f.proname = 'orders_parcel_accept_gate' AND t.en = 'O' AND t.tgtype = 19
                          AND t.def ~ $re$WHEN \(\(\(old\.status = 'received'::text\) AND \(new\.status IS DISTINCT FROM 'received'::text\) AND \(new\.status IS DISTINCT FROM 'cancelled'::text\)\)\)$re$)
           AND EXISTS (SELECT 1 FROM otr t JOIN fn f ON f.oid = t.tgfoid
                        WHERE t.tgname = 'orders_parcel_cancel_sync' AND f.proname = 'orders_parcel_cancel_sync' AND t.en = 'O' AND t.tgtype = 17
                          AND t.def ~ $re$WHEN \(\(\(new\.status = 'cancelled'::text\) AND \(old\.status IS DISTINCT FROM 'cancelled'::text\)\)\)$re$),
         coalesce((SELECT string_agg(tgname || ' [' || en || ']', ', ' ORDER BY tgname) FROM otr), 'none')
  UNION ALL
  SELECT '10', 'triggers on parcel_requests: before_write + log_insert + log_status, enabled',
         (SELECT count(*) FROM ptr) = 3
           AND (SELECT count(*) FROM ptr WHERE en = 'O' AND tgname IN ('parcel_requests_before_write', 'parcel_requests_log_insert', 'parcel_requests_log_status')) = 3,
         coalesce((SELECT string_agg(tgname || ' [' || en || ']', ', ' ORDER BY tgname) FROM ptr), 'none')
  UNION ALL
  SELECT '11', 'RLS: parcel_requests + parcel_events enabled, NOT forced',
         (SELECT count(*) FROM rel WHERE relname IN ('parcel_requests', 'parcel_events') AND rls AND NOT force_rls) = 2,
         (SELECT string_agg(relname || ' rls=' || rls || ' force=' || force_rls, '; ' ORDER BY relname) FROM rel WHERE relname <> 'orders')
  UNION ALL
  SELECT '12', 'parcel_requests: grantees only owner + service_role',
         NOT EXISTS (SELECT 1 FROM rel c, LATERAL aclexplode(coalesce((SELECT k.relacl FROM pg_class k WHERE k.oid = c.oid), acldefault('r', c.relowner))) AS a
                      WHERE c.relname = 'parcel_requests' AND a.grantee <> c.relowner
                        AND a.grantee NOT IN (SELECT r.oid FROM pg_roles r WHERE r.rolname = 'service_role')),
         'parcel_requests'
  UNION ALL
  SELECT '13', 'service_role: BYPASSRLS + SELECT/UPDATE parcel_requests + INSERT parcel_events + SELECT/UPDATE orders',
         EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role' AND rolbypassrls)
           AND has_table_privilege('service_role', 'public.parcel_requests', 'SELECT') AND has_table_privilege('service_role', 'public.parcel_requests', 'UPDATE')
           AND has_table_privilege('service_role', 'public.parcel_events', 'INSERT')
           AND has_table_privilege('service_role', 'public.orders', 'SELECT') AND has_table_privilege('service_role', 'public.orders', 'UPDATE'),
         'service_role'
  UNION ALL
  SELECT '14', 'orders policies (info: name cmd permissive|restrictive roles USING CHECK)', NULL,
         coalesce((SELECT string_agg(polname || ' ' || cmd || ' ' || CASE WHEN polpermissive THEN 'permissive' ELSE 'restrictive' END
                                     || ' ' || roles || ' USING(' || using_expr || ') CHECK(' || check_expr || ')', '; ' ORDER BY polname) FROM pol), 'none')
  UNION ALL
  SELECT '15', 'anon / authenticated cannot UPDATE orders rows',
         NOT EXISTS (SELECT 1 FROM reach WHERE rolname IN ('anon', 'authenticated')),
         coalesce('can update: ' || (SELECT string_agg(rolname, ', ') FROM reach WHERE rolname IN ('anon', 'authenticated')), 'none')
  UNION ALL
  SELECT '16', 'roles that can effectively UPDATE orders rows (info; superusers excluded)', NULL,
         coalesce((SELECT string_agg(rolname || CASE WHEN rolbypassrls THEN ' (bypassrls)' ELSE '' END, ', ' ORDER BY rolname) FROM reach), 'none')
  UNION ALL
  SELECT '17', 'FOOD-ONLY SAFETY: every such role can run the parcel_04 cancel gate',
         NOT EXISTS (SELECT 1 FROM reach_bad), coalesce('cannot: ' || (SELECT string_agg(rolname, ', ' ORDER BY rolname) FROM reach_bad), 'all can')
  UNION ALL
  SELECT '18', 'Migration 04 objects do not exist yet (function / trigger orders_parcel_cancel_gate)',
         NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'orders_parcel_cancel_gate')
           AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'orders_parcel_cancel_gate'),
         coalesce((SELECT string_agg(oid::regprocedure::text, ', ') FROM pg_proc WHERE proname = 'orders_parcel_cancel_gate'), 'none')
  UNION ALL
  SELECT '19', 'data: no cancelled order with a parcel still in the store (counts only)',
         (SELECT count(*) FROM public.orders o JOIN public.parcel_requests pr ON pr.order_id = o.id
           WHERE o.status = 'cancelled' AND pr.status IN ('awaiting_search', 'not_found', 'found')) = 0,
         (SELECT count(*) FROM public.orders o JOIN public.parcel_requests pr ON pr.order_id = o.id
           WHERE o.status = 'cancelled' AND pr.status IN ('awaiting_search', 'not_found', 'found'))::text || ' row(s)'
  UNION ALL
  SELECT '20', 'parcels (info): total, by status, and received orders whose cancel M04 would block', NULL,
         (SELECT count(*) FROM public.parcel_requests)::text || ' parcel(s) ['
           || coalesce((SELECT string_agg(s.status || '=' || s.n, ', ' ORDER BY s.status) FROM (SELECT status, count(*) n FROM public.parcel_requests GROUP BY status) s), 'none')
           || '], received+awaiting/found: '
           || (SELECT count(*) FROM public.orders o JOIN public.parcel_requests pr ON pr.order_id = o.id
                WHERE o.status = 'received' AND pr.status IN ('awaiting_search', 'found'))::text
  UNION ALL
  SELECT '21', 'other sessions holding locks on orders right now (info; install uses lock_timeout 5s)', NULL,
         (SELECT count(DISTINCT l.pid)::text FROM pg_locks l WHERE l.relation = to_regclass('public.orders') AND l.pid <> pg_backend_pid())
)
SELECT check_id, check_name,
       CASE WHEN ok IS NULL THEN 'INFO' WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result,
       detail
  FROM checks
 ORDER BY check_id;
