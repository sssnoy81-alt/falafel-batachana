-- FALAFEL BATACHANA — SEC-2 — sec2_01_verify.sql (GATE SEC-2A)
-- READ-ONLY. ONE statement (WITH … SELECT), ONE table: check_id | check_name | result (PASS / FAIL / INFO) | detail
-- Before sec2_01: rows 01–05 FAIL (public access present). After sec2_01: every non-INFO row PASS.
-- Prints no customer data: privilege names, role / policy / object names and counts only.

WITH
t AS (
  SELECT c.oid, c.relname, c.relrowsecurity AS rls, c.relacl, c.relowner
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname IN ('orders', 'order_items', 'push_subscriptions')
),
privs(p) AS (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')),
held AS (   -- effective privileges (incl. PUBLIC and role membership) of anon / authenticated on the three tables
  SELECT r.rolname, t.relname, privs.p
    FROM t, privs, pg_roles r
   WHERE r.rolname IN ('anon', 'authenticated') AND has_table_privilege(r.oid, t.oid, privs.p)
),
public_acl AS (
  SELECT t.relname, a.privilege_type FROM t, LATERAL aclexplode(coalesce(t.relacl, acldefault('r', t.relowner))) AS a WHERE a.grantee = 0
),
pol AS (
  SELECT c.relname, p.polname, p.polcmd::text AS cmd, p.polpermissive,
         CASE WHEN 0 = ANY (p.polroles) THEN 'PUBLIC'
              ELSE (SELECT string_agg(r.rolname, '+' ORDER BY r.rolname) FROM pg_roles r WHERE r.oid = ANY (p.polroles)) END AS roles,
         coalesce(pg_get_expr(p.polqual, p.polrelid), '-') AS using_expr,
         coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '-') AS check_expr
    FROM pg_policy p JOIN t c ON c.oid = p.polrelid
),
views_dep AS (
  SELECT DISTINCT v.oid::regclass::text AS v
    FROM pg_rewrite rw
    JOIN pg_depend d ON d.classid = 'pg_rewrite'::regclass AND d.objid = rw.oid
    JOIN pg_class v ON v.oid = rw.ev_class
   WHERE d.refobjid IN (SELECT oid FROM t) AND v.oid NOT IN (SELECT oid FROM t) AND v.relkind IN ('v', 'm')
),
definer_fns AS (
  SELECT p.oid::regprocedure::text AS f
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE p.prosecdef
     AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'auth', 'storage', 'realtime', 'extensions', 'graphql',
                           'graphql_public', 'vault', 'pgsodium', 'pgsodium_masks', 'supabase_functions', 'net', 'cron',
                           'pgbouncer', 'supabase_migrations', '_realtime', '_analytics')
     AND n.nspname !~ '^pg_'
     AND p.prosrc ~* '\m(orders|order_items|push_subscriptions)\M'
     AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))
),
menu AS (
  SELECT x.tbl, to_regclass('public.' || x.tbl) AS oid
    FROM (VALUES ('menu_categories'), ('menu_items'), ('toppings'), ('branch_prices'), ('branches')) AS x(tbl)
),
checks(check_id, check_name, ok, detail) AS (
  SELECT '01', 'anon: no privilege on public.orders',
         NOT EXISTS (SELECT 1 FROM held WHERE rolname = 'anon' AND relname = 'orders'),
         coalesce((SELECT string_agg(p, ',' ORDER BY p) FROM held WHERE rolname = 'anon' AND relname = 'orders'), 'none')
  UNION ALL
  SELECT '02', 'anon: no privilege on public.order_items',
         NOT EXISTS (SELECT 1 FROM held WHERE rolname = 'anon' AND relname = 'order_items'),
         coalesce((SELECT string_agg(p, ',' ORDER BY p) FROM held WHERE rolname = 'anon' AND relname = 'order_items'), 'none')
  UNION ALL
  SELECT '03', 'anon: no privilege on public.push_subscriptions',
         NOT EXISTS (SELECT 1 FROM held WHERE rolname = 'anon' AND relname = 'push_subscriptions'),
         coalesce((SELECT string_agg(p, ',' ORDER BY p) FROM held WHERE rolname = 'anon' AND relname = 'push_subscriptions'), 'none')
  UNION ALL
  SELECT '04', 'authenticated: no privilege on the three tables',
         NOT EXISTS (SELECT 1 FROM held WHERE rolname = 'authenticated'),
         coalesce((SELECT string_agg(relname || ':' || p, ',' ORDER BY relname, p) FROM held WHERE rolname = 'authenticated'), 'none')
  UNION ALL
  SELECT '05', 'PUBLIC: no ACL entry on the three tables',
         NOT EXISTS (SELECT 1 FROM public_acl),
         coalesce((SELECT string_agg(relname || ':' || privilege_type, ',') FROM public_acl), 'none')
  UNION ALL
  SELECT '06', 'service_role keeps what the server needs (orders/order_items SELECT+INSERT+UPDATE, push_subscriptions SELECT+INSERT+DELETE)',
         EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role' AND rolbypassrls)
           AND has_table_privilege('service_role', 'public.orders', 'SELECT') AND has_table_privilege('service_role', 'public.orders', 'INSERT')
           AND has_table_privilege('service_role', 'public.orders', 'UPDATE')
           AND has_table_privilege('service_role', 'public.order_items', 'SELECT') AND has_table_privilege('service_role', 'public.order_items', 'INSERT')
           AND has_table_privilege('service_role', 'public.order_items', 'UPDATE')
           AND has_table_privilege('service_role', 'public.push_subscriptions', 'SELECT') AND has_table_privilege('service_role', 'public.push_subscriptions', 'INSERT')
           AND has_table_privilege('service_role', 'public.push_subscriptions', 'DELETE'),
         'service_role'
  UNION ALL
  SELECT '07', 'RLS enabled on the three tables',
         (SELECT count(*) FROM t WHERE rls) = 3, (SELECT string_agg(relname || '=' || rls, ', ' ORDER BY relname) FROM t)
  UNION ALL
  SELECT '08', 'policies on the three tables (info)', NULL,
         coalesce((SELECT string_agg(relname || '.' || polname || ' ' || cmd || ' ' || CASE WHEN polpermissive THEN 'perm' ELSE 'restr' END
                                     || ' ' || roles || ' USING(' || using_expr || ') CHECK(' || check_expr || ')', '; ' ORDER BY relname, polname) FROM pol), 'none')
  UNION ALL
  SELECT '09', 'USING(true) / WITH CHECK(true) policies still present (info: inert without privileges; optional cleanup)', NULL,
         coalesce((SELECT string_agg(relname || '.' || polname, ', ' ORDER BY relname, polname) FROM pol
                    WHERE using_expr = 'true' OR check_expr = 'true'), 'none')
  UNION ALL
  SELECT '10', 'no view depends on the three tables',
         NOT EXISTS (SELECT 1 FROM views_dep), coalesce((SELECT string_agg(v, ', ') FROM views_dep), 'none')
  UNION ALL
  SELECT '11', 'no SECURITY DEFINER function callable by anon/authenticated references the tables',
         NOT EXISTS (SELECT 1 FROM definer_fns), coalesce((SELECT string_agg(f, ', ') FROM definer_fns), 'none')
  UNION ALL
  SELECT '12', 'menu tables still readable by anon (customer menu must keep working)',
         (SELECT bool_and(oid IS NOT NULL AND has_table_privilege('anon', oid, 'SELECT')) FROM menu),
         (SELECT string_agg(tbl || '=' || coalesce(has_table_privilege('anon', oid, 'SELECT')::text, 'missing'), ', ' ORDER BY tbl) FROM menu)
  UNION ALL
  SELECT '13', 'deliveries / parcel tables: no anon privilege (unchanged lock-down)',
         NOT EXISTS (SELECT 1 FROM (VALUES ('deliveries'), ('parcel_requests'), ('parcel_events')) AS x(tbl), privs
                      WHERE to_regclass('public.' || x.tbl) IS NOT NULL AND has_table_privilege('anon', to_regclass('public.' || x.tbl), privs.p)),
         'deliveries, parcel_requests, parcel_events'
  UNION ALL
  SELECT '14', 'create_order / create_order_with_parcel: no EXECUTE for anon / authenticated',
         NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                      WHERE n.nspname = 'public' AND p.proname IN ('create_order', 'create_order_with_parcel')
                        AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))),
         'public.create_order*'
  UNION ALL
  SELECT '15', 'realtime publication membership of the three tables (info)', NULL,
         coalesce((SELECT string_agg(pt.pubname || ':' || pt.tablename, ', ') FROM pg_publication_tables pt
                    WHERE pt.schemaname = 'public' AND pt.tablename IN ('orders', 'order_items', 'push_subscriptions')), 'none')
  UNION ALL
  SELECT '16', 'privilege snapshot for rollback (info)', NULL,
         CASE WHEN to_regclass('sec2_backup.acl_snapshot') IS NULL THEN 'not present (sec2_01 not applied, or rolled back)'
              ELSE 'present' END
)
SELECT check_id, check_name,
       CASE WHEN ok IS NULL THEN 'INFO' WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result,
       detail
  FROM checks
 ORDER BY check_id;
