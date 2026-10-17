-- FALAFEL BATACHANA — PARCEL MODULE — parcel_03_production_preflight.sql (GATE 03I-F)
-- READ-ONLY Production compatibility check BEFORE parcel_03_orders_gate.sql. ONE statement (WITH … SELECT):
--   check_id | check_name | verdict (GO / NO-GO / INFO) | detail
-- Run manually in the Supabase SQL editor (as postgres). Every non-INFO row must be GO before requesting install.
-- Prints no function bodies, tracking numbers or customer data — fingerprints, role / policy / trigger names and counts.
-- Writes nothing; takes only the ordinary AccessShare locks of a SELECT.

WITH
cfg AS (
  SELECT current_setting('server_version_num')::int AS vnum, current_setting('server_version') AS vtxt, current_user AS me
),
fn AS (
  SELECT p.oid, p.proname, md5(p.prosrc) AS h, length(p.prosrc) AS len, p.prosecdef, p.proacl, p.proowner,
         pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('parcel_requests_before_write', 'parcel_requests_log_event', 'parcel_events_append_only',
                       'create_order_with_parcel', 'create_order')
),
rel AS (
  SELECT c.oid, c.relname, c.relowner, pg_get_userbyid(c.relowner) AS owner, c.relrowsecurity AS rls, c.relforcerowsecurity AS force_rls
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname IN ('orders', 'parcel_requests', 'parcel_events')
),
trg AS (
  SELECT c.relname, t.tgname, t.tgenabled::text AS en
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname IN ('orders', 'parcel_requests', 'parcel_events') AND NOT t.tgisinternal
),
pol AS (
  SELECT p.polname, p.polcmd::text AS cmd, p.polroles, p.polpermissive,
         CASE WHEN 0 = ANY (p.polroles) THEN 'PUBLIC'
              ELSE (SELECT string_agg(r.rolname, '+' ORDER BY r.rolname) FROM pg_roles r WHERE r.oid = ANY (p.polroles)) END AS roles,
         coalesce(pg_get_expr(p.polqual, p.polrelid), '-') AS using_expr,
         coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '-') AS check_expr
    FROM pg_policy p WHERE p.polrelid = to_regclass('public.orders')
),
-- UPDATE / ALL policies on orders per role they apply to (PUBLIC or membership with inherited privileges), with
-- "provably denies" flags: ONLY the constant false counts as denying; any other expression (or none) may admit rows.
upd_pol AS (
  SELECT r.oid AS rid, p.polpermissive AS permissive,
         coalesce(pg_get_expr(p.polqual, p.polrelid), '') = 'false' AS using_false,
         coalesce(pg_get_expr(coalesce(p.polwithcheck, p.polqual), p.polrelid), '') = 'false' AS check_false
    FROM pg_roles r, pg_policy p
   WHERE p.polrelid = to_regclass('public.orders') AND p.polcmd IN ('w', '*')
     AND (0 = ANY (p.polroles) OR EXISTS (SELECT 1 FROM unnest(p.polroles) AS u(x) WHERE pg_has_role(r.oid, u.x, 'USAGE')))
),
-- Roles that can actually UPDATE rows of public.orders. PostgreSQL admits a row only if some permissive USING passes,
-- some permissive check (WITH CHECK, else USING) passes and no restrictive one fails. Superusers excluded (bypass all).
reach AS (
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
-- …of those, roles that could NOT run the parcel_03 triggers (would break food-only acceptance / cancellation).
reach_bad AS (
  SELECT rc.rolname
    FROM reach rc, rel pr
   WHERE pr.relname = 'parcel_requests'
     AND NOT (has_table_privilege(rc.oid, pr.oid, 'SELECT') AND has_table_privilege(rc.oid, pr.oid, 'UPDATE')
              AND has_table_privilege(rc.oid, to_regclass('public.parcel_events'), 'INSERT')
              AND (rc.rolbypassrls OR pg_has_role(rc.oid, pr.relowner, 'USAGE')))
),
acl AS (
  SELECT c.relname, CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee,
         a.grantee AS grantee_oid, c.relowner, a.privilege_type
    FROM rel c, LATERAL aclexplode(coalesce((SELECT k.relacl FROM pg_class k WHERE k.oid = c.oid), acldefault('r', c.relowner))) AS a
   WHERE c.relname IN ('parcel_requests', 'parcel_events')
),
wrapper_exec AS (
  SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee
    FROM fn f, LATERAL aclexplode(coalesce(f.proacl, acldefault('f', f.proowner))) AS a
   WHERE f.proname = 'create_order_with_parcel' AND a.privilege_type = 'EXECUTE' AND a.grantee <> f.proowner
),
counts AS (
  SELECT (SELECT count(*) FROM public.parcel_requests) AS parcels,
         (SELECT count(*) FROM public.parcel_events) AS events,
         (SELECT coalesce(string_agg(s.status || '=' || s.n, ', ' ORDER BY s.status), 'none')
            FROM (SELECT status, count(*) AS n FROM public.parcel_requests GROUP BY status) s) AS by_status,
         (SELECT count(*) FROM public.orders o JOIN public.parcel_requests pr ON pr.order_id = o.id
           WHERE (o.status NOT IN ('received', 'cancelled') AND pr.status IN ('awaiting_search', 'not_found'))
              OR (o.status = 'cancelled' AND pr.status IN ('awaiting_search', 'not_found', 'found'))) AS violations
),
checks(check_id, check_name, ok, detail) AS (
  SELECT '01', 'PostgreSQL server version (local tests: 17.5; post-check trigger format stable 14–18)',
         (SELECT vnum BETWEEN 140000 AND 189999 FROM cfg), (SELECT vtxt FROM cfg)
  UNION ALL
  SELECT '02', 'running role can create the triggers (TRIGGER on orders, CREATE on schema public)',
         (SELECT has_table_privilege(me, 'public.orders', 'TRIGGER') AND has_schema_privilege(me, 'public', 'CREATE') FROM cfg),
         (SELECT 'current_user ' || me FROM cfg)
  UNION ALL
  SELECT '03', '01b: parcel_requests_before_write fingerprint',
         EXISTS (SELECT 1 FROM fn WHERE proname = 'parcel_requests_before_write'
                   AND ((h = '9da7eec21b14950cfcbe4481ecbddf40' AND len = 5560) OR (h = 'bf1d4abc4698dd2213023df069b75255' AND len = 5397)))
           AND (SELECT count(*) FROM fn WHERE proname = 'parcel_requests_before_write') = 1,
         coalesce((SELECT string_agg(h || ' / ' || len, '; ') FROM fn WHERE proname = 'parcel_requests_before_write'), 'missing')
  UNION ALL
  SELECT '04', '01: parcel_requests_log_event fingerprint',
         EXISTS (SELECT 1 FROM fn WHERE proname = 'parcel_requests_log_event' AND h = '08de848cf7badf72b426972a12590957' AND len = 281)
           AND (SELECT count(*) FROM fn WHERE proname = 'parcel_requests_log_event') = 1,
         coalesce((SELECT string_agg(h || ' / ' || len, '; ') FROM fn WHERE proname = 'parcel_requests_log_event'), 'missing')
  UNION ALL
  SELECT '05', '01: parcel_events_append_only fingerprint',
         EXISTS (SELECT 1 FROM fn WHERE proname = 'parcel_events_append_only' AND h = 'c098c15fc3a0b898f7f148f4b2cc9dea' AND len = 86)
           AND (SELECT count(*) FROM fn WHERE proname = 'parcel_events_append_only') = 1,
         coalesce((SELECT string_agg(h || ' / ' || len, '; ') FROM fn WHERE proname = 'parcel_events_append_only'), 'missing')
  UNION ALL
  SELECT '06', '02: create_order_with_parcel fingerprint',
         EXISTS (SELECT 1 FROM fn WHERE proname = 'create_order_with_parcel' AND h = '7d491c097bf60b7e17beae25890b1238' AND len = 2474)
           AND (SELECT count(*) FROM fn WHERE proname = 'create_order_with_parcel') = 1,
         coalesce((SELECT string_agg(h || ' / ' || len, '; ') FROM fn WHERE proname = 'create_order_with_parcel'), 'missing')
  UNION ALL
  SELECT '07', '02: create_order_with_parcel EXECUTE only for service_role (+ owner)',
         NOT EXISTS (SELECT 1 FROM wrapper_exec WHERE grantee <> 'service_role') AND EXISTS (SELECT 1 FROM wrapper_exec WHERE grantee = 'service_role'),
         coalesce((SELECT string_agg(grantee, ', ' ORDER BY grantee) FROM wrapper_exec), 'none')
  UNION ALL
  SELECT '08', 'original create_order unchanged',
         EXISTS (SELECT 1 FROM fn WHERE proname = 'create_order' AND h = 'db92e75f8bfdadb6d78be035da855996' AND len = 6416)
           AND (SELECT count(*) FROM fn WHERE proname = 'create_order') = 1,
         coalesce((SELECT string_agg(h || ' / ' || len, '; ') FROM fn WHERE proname = 'create_order'), 'missing')
  UNION ALL
  SELECT '09', 'triggers on orders: none (parcel_03 adds the first two)',
         NOT EXISTS (SELECT 1 FROM trg WHERE relname = 'orders'),
         coalesce((SELECT string_agg(tgname || ' [' || en || ']', ', ' ORDER BY tgname) FROM trg WHERE relname = 'orders'), 'none')
  UNION ALL
  SELECT '10', 'triggers on parcel_requests: exactly before_write + log_insert + log_status, enabled',
         (SELECT count(*) FROM trg WHERE relname = 'parcel_requests') = 3
           AND (SELECT count(*) FROM trg WHERE relname = 'parcel_requests' AND en = 'O'
                  AND tgname IN ('parcel_requests_before_write', 'parcel_requests_log_insert', 'parcel_requests_log_status')) = 3,
         coalesce((SELECT string_agg(tgname || ' [' || en || ']', ', ' ORDER BY tgname) FROM trg WHERE relname = 'parcel_requests'), 'none')
  UNION ALL
  SELECT '11', 'triggers on parcel_events: append-only pair, enabled',
         (SELECT count(*) FROM trg WHERE relname = 'parcel_events' AND en = 'O'
            AND tgname IN ('parcel_events_no_update_delete', 'parcel_events_no_truncate')) = 2,
         coalesce((SELECT string_agg(tgname || ' [' || en || ']', ', ' ORDER BY tgname) FROM trg WHERE relname = 'parcel_events'), 'none')
  UNION ALL
  SELECT '12', 'RLS: parcel_requests + parcel_events enabled, NOT forced',
         (SELECT count(*) FROM rel WHERE relname IN ('parcel_requests', 'parcel_events') AND rls AND NOT force_rls) = 2,
         (SELECT string_agg(relname || ' rls=' || rls || ' force=' || force_rls, '; ' ORDER BY relname) FROM rel WHERE relname <> 'orders')
  UNION ALL
  SELECT '13', 'RLS on orders (info)', NULL,
         (SELECT 'rls=' || rls || ' force=' || force_rls || ' owner=' || owner FROM rel WHERE relname = 'orders')
  UNION ALL
  SELECT '14', 'orders.status is text with a CHECK listing the six statuses',
         (SELECT a.atttypid = 'text'::regtype FROM pg_attribute a
           WHERE a.attrelid = to_regclass('public.orders') AND a.attname = 'status' AND NOT a.attisdropped)
           AND EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = to_regclass('public.orders') AND c.contype = 'c'
                         AND pg_get_constraintdef(c.oid) LIKE '%''received''%' AND pg_get_constraintdef(c.oid) LIKE '%''confirmed''%'
                         AND pg_get_constraintdef(c.oid) LIKE '%''preparing''%' AND pg_get_constraintdef(c.oid) LIKE '%''ready''%'
                         AND pg_get_constraintdef(c.oid) LIKE '%''delivered''%' AND pg_get_constraintdef(c.oid) LIKE '%''cancelled''%'),
         'public.orders.status'
  UNION ALL
  SELECT '15', 'orders policies (info: name cmd permissive|restrictive roles USING CHECK)', NULL,
         coalesce((SELECT string_agg(polname || ' ' || cmd || ' ' || CASE WHEN polpermissive THEN 'permissive' ELSE 'restrictive' END
                                     || ' ' || roles || ' USING(' || using_expr || ') CHECK(' || check_expr || ')', '; ' ORDER BY polname) FROM pol), 'none')
  UNION ALL
  SELECT '16', 'orders: anon / authenticated cannot UPDATE rows (no UPDATE / ALL policy can admit a row for them)',
         NOT EXISTS (SELECT 1 FROM reach WHERE rolname IN ('anon', 'authenticated')),
         coalesce('can update: ' || (SELECT string_agg(rolname, ', ' ORDER BY rolname) FROM reach WHERE rolname IN ('anon', 'authenticated')),
                  coalesce((SELECT string_agg(polname || ' USING(' || using_expr || ')', ', ' ORDER BY polname) FROM pol WHERE cmd IN ('w', '*')), 'no UPDATE/ALL policies'))
  UNION ALL
  SELECT '17', 'roles that can effectively UPDATE orders rows (info; superusers excluded)', NULL,
         coalesce((SELECT string_agg(rolname || CASE WHEN rolbypassrls THEN ' (bypassrls)' ELSE '' END, ', ' ORDER BY rolname) FROM reach), 'none')
  UNION ALL
  SELECT '18', 'FOOD-ONLY SAFETY: every such role can run both parcel_03 triggers',
         NOT EXISTS (SELECT 1 FROM reach_bad),
         coalesce('cannot: ' || (SELECT string_agg(rolname, ', ' ORDER BY rolname) FROM reach_bad), 'all can')
  UNION ALL
  SELECT '19', 'service_role: BYPASSRLS + SELECT/UPDATE parcel_requests, INSERT parcel_events, SELECT/UPDATE orders',
         EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role' AND rolbypassrls)
           AND has_table_privilege('service_role', 'public.parcel_requests', 'SELECT')
           AND has_table_privilege('service_role', 'public.parcel_requests', 'UPDATE')
           AND has_table_privilege('service_role', 'public.parcel_events', 'INSERT')
           AND has_table_privilege('service_role', 'public.orders', 'SELECT')
           AND has_table_privilege('service_role', 'public.orders', 'UPDATE'),
         'service_role'
  UNION ALL
  SELECT '20', 'parcel_requests: grantees only owner + service_role',
         NOT EXISTS (SELECT 1 FROM acl WHERE relname = 'parcel_requests' AND grantee_oid <> relowner AND grantee <> 'service_role'),
         (SELECT string_agg(grantee || ':' || privs, '; ' ORDER BY grantee)
            FROM (SELECT grantee, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privs FROM acl
                   WHERE relname = 'parcel_requests' AND grantee_oid <> relowner GROUP BY grantee) x)
  UNION ALL
  SELECT '21', 'parcel_events: grantees only owner + service_role (no UPDATE / DELETE)',
         NOT EXISTS (SELECT 1 FROM acl WHERE relname = 'parcel_events' AND grantee_oid <> relowner
                       AND (grantee <> 'service_role' OR privilege_type NOT IN ('SELECT', 'INSERT'))),
         (SELECT string_agg(grantee || ':' || privs, '; ' ORDER BY grantee)
            FROM (SELECT grantee, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privs FROM acl
                   WHERE relname = 'parcel_events' AND grantee_oid <> relowner GROUP BY grantee) x)
  UNION ALL
  SELECT '22', 'gate lookup index: UNIQUE valid index on parcel_requests(order_id)',
         EXISTS (SELECT 1 FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
                  WHERE i.indrelid = to_regclass('public.parcel_requests') AND i.indisunique AND i.indisvalid
                    AND i.indnatts = 1 AND i.indpred IS NULL AND a.attname = 'order_id'),
         'parcel_requests_order_uq'
  UNION ALL
  SELECT '23', 'no conflicting objects (functions or triggers named orders_parcel_*)',
         NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.proname IN ('orders_parcel_accept_gate', 'orders_parcel_cancel_sync'))
           AND NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgname IN ('orders_parcel_accept_gate', 'orders_parcel_cancel_sync')),
         coalesce((SELECT string_agg(p.oid::regprocedure::text, ', ') FROM pg_proc p
                    WHERE p.proname IN ('orders_parcel_accept_gate', 'orders_parcel_cancel_sync')), 'none')
  UNION ALL
  SELECT '24', 'existing data already satisfies the gate (counts only)',
         (SELECT violations = 0 FROM counts), (SELECT violations || ' violating row(s)' FROM counts)
  UNION ALL
  SELECT '25', 'parcel / event counts (info)', NULL,
         (SELECT parcels || ' parcel(s) [' || by_status || '], ' || events || ' event(s)' FROM counts)
  UNION ALL
  SELECT '26', 'other sessions holding locks on orders right now (info; install uses lock_timeout 5s)', NULL,
         (SELECT count(DISTINCT l.pid)::text FROM pg_locks l WHERE l.relation = to_regclass('public.orders') AND l.pid <> pg_backend_pid())
  UNION ALL
  SELECT '27', 'enabled event triggers (info; fire on CREATE FUNCTION / TRIGGER)', NULL,
         coalesce((SELECT string_agg(evtname || ' (' || evtevent || ')', ', ' ORDER BY evtname) FROM pg_event_trigger WHERE evtenabled <> 'D'), 'none')
)
SELECT check_id, check_name,
       CASE WHEN ok IS NULL THEN 'INFO' WHEN ok THEN 'GO' ELSE 'NO-GO' END AS verdict,
       detail
  FROM checks
 ORDER BY check_id;
