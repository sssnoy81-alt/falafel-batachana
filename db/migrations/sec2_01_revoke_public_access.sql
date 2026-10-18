-- FALAFEL BATACHANA — SEC-2 — sec2_01_revoke_public_access.sql (GATE SEC-2A)
-- Removes ALL table privileges of PUBLIC / anon / authenticated on public.orders, public.order_items and
-- public.push_subscriptions. Unauthenticated clients can then neither read nor write customer order data (42501),
-- whatever the RLS policies say. Server routes are unaffected: they use the server key (role service_role, BYPASSRLS),
-- whose grants are untouched and asserted below.
--
-- REVIEW ONLY — NOT EXECUTED. Separate Production approval required. Rollback: sec2_01_rollback.sql.
-- Read-only verification (before and after): sec2_01_verify.sql.
--
-- Evidence (GATE SEC-2A code audit of 4544cad): no browser / anon code touches these three tables. The browser client
-- (lib/supabaseBrowser.ts) is used only by app/order/page.tsx for menu_categories, menu_items, toppings, branch_prices
-- and branches — NOT changed here. Orders are created by POST /api/orders → create_order RPC (server key); tracking uses
-- GET /api/orders/[id]/status (server key); kitchen, push and Maale use the server key. Direct browser inserts ended in
-- 1804b11 (2026-09-25), direct browser order reads in cdd7926 (2026-09-27).
--
-- Exact rollback: the pre-change privileges of PUBLIC / anon / authenticated on the three tables are copied into
-- sec2_backup.acl_snapshot (schema and table readable only by the owner; contains privilege names only, no customer
-- data). The rollback re-grants exactly those rows and removes the backup schema.
--
-- Not changed: RLS settings, policies (the USING (true) policies become inert without privileges; dropping them is a
-- separate, optional step), sequences, functions, menu tables, deliveries, parcel tables, data.

BEGIN;

SET LOCAL lock_timeout = '5s';        -- REVOKE briefly locks the tables' catalog rows; never queue behind traffic
SET LOCAL statement_timeout = '60s';

-- ─── Preflight ────────────────────────────────────────────────────────────────────────────────────────
DO $sec2_01_preflight$
DECLARE
  v_t   text;
  v_n   integer;
  v_lst text;
BEGIN
  FOREACH v_t IN ARRAY ARRAY['orders', 'order_items', 'push_subscriptions'] LOOP
    IF to_regclass('public.' || v_t) IS NULL THEN
      RAISE EXCEPTION 'sec2_01_preflight: public.% missing', v_t;
    END IF;
    IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = ('public.' || v_t)::regclass) THEN
      RAISE EXCEPTION 'sec2_01_preflight: RLS is not enabled on public.%', v_t;
    END IF;
  END LOOP;

  IF to_regnamespace('sec2_backup') IS NOT NULL THEN
    RAISE EXCEPTION 'sec2_01_preflight: schema sec2_backup already exists (already applied?)';
  END IF;

  -- Something to remove (otherwise this was already applied or the baseline differs).
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c, LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) AS a
     WHERE c.oid IN ('public.orders'::regclass, 'public.order_items'::regclass, 'public.push_subscriptions'::regclass)
       AND (a.grantee = 0 OR a.grantee IN (SELECT r.oid FROM pg_roles r WHERE r.rolname IN ('anon', 'authenticated')))
  ) THEN
    RAISE EXCEPTION 'sec2_01_preflight: PUBLIC / anon / authenticated hold no privileges on the three tables - nothing to do';
  END IF;

  -- The server key's role must keep everything the server routes and create_order need.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role' AND rolbypassrls) THEN
    RAISE EXCEPTION 'sec2_01_preflight: service_role missing or without BYPASSRLS';
  END IF;
  IF NOT (    has_table_privilege('service_role', 'public.orders', 'SELECT') AND has_table_privilege('service_role', 'public.orders', 'INSERT')
          AND has_table_privilege('service_role', 'public.orders', 'UPDATE')
          AND has_table_privilege('service_role', 'public.order_items', 'SELECT') AND has_table_privilege('service_role', 'public.order_items', 'INSERT')
          AND has_table_privilege('service_role', 'public.order_items', 'UPDATE')
          AND has_table_privilege('service_role', 'public.push_subscriptions', 'SELECT') AND has_table_privilege('service_role', 'public.push_subscriptions', 'INSERT')
          AND has_table_privilege('service_role', 'public.push_subscriptions', 'DELETE')) THEN
    RAISE EXCEPTION 'sec2_01_preflight: service_role lacks a privilege the server routes need';
  END IF;
  -- (If service_role held any of these only through PUBLIC, the post-check below aborts the whole transaction.)

  -- No bypass left behind: views over these tables, or SECURITY DEFINER functions callable by anon / authenticated
  -- that reference them, would keep the data reachable (or break) — review them first.
  SELECT count(*), string_agg(DISTINCT v.oid::regclass::text, ', ') INTO v_n, v_lst
    FROM pg_rewrite rw
    JOIN pg_depend d ON d.classid = 'pg_rewrite'::regclass AND d.objid = rw.oid
    JOIN pg_class v ON v.oid = rw.ev_class
   WHERE d.refobjid IN ('public.orders'::regclass, 'public.order_items'::regclass, 'public.push_subscriptions'::regclass)
     AND v.oid NOT IN ('public.orders'::regclass, 'public.order_items'::regclass, 'public.push_subscriptions'::regclass)
     AND v.relkind IN ('v', 'm');
  IF v_n > 0 THEN
    RAISE EXCEPTION 'sec2_01_preflight: view(s) depend on the tables - review first: %', v_lst;
  END IF;
  SELECT count(*), string_agg(p.oid::regprocedure::text, ', ') INTO v_n, v_lst
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE p.prosecdef
     AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'auth', 'storage', 'realtime', 'extensions', 'graphql',
                           'graphql_public', 'vault', 'pgsodium', 'pgsodium_masks', 'supabase_functions', 'net', 'cron',
                           'pgbouncer', 'supabase_migrations', '_realtime', '_analytics')
     AND n.nspname !~ '^pg_'
     AND p.prosrc ~* '\m(orders|order_items|push_subscriptions)\M'
     AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  IF v_n > 0 THEN
    RAISE EXCEPTION 'sec2_01_preflight: SECURITY DEFINER function(s) callable by anon/authenticated reference the tables: %', v_lst;
  END IF;
END
$sec2_01_preflight$;

-- ─── Snapshot of the exact pre-change privileges (for an exact rollback) ─────────────────────────────────
CREATE SCHEMA sec2_backup;
REVOKE ALL ON SCHEMA sec2_backup FROM PUBLIC;

CREATE TABLE sec2_backup.acl_snapshot (
  table_name     text    NOT NULL,
  grantee        text    NOT NULL,      -- 'PUBLIC', 'anon' or 'authenticated'
  privilege_type text    NOT NULL,
  is_grantable   boolean NOT NULL,
  taken_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (table_name, grantee, privilege_type)
);
REVOKE ALL ON TABLE sec2_backup.acl_snapshot FROM PUBLIC;
DO $sec2_01_revoke_api_roles$
BEGIN
  -- the backup must never be reachable through the API roles (defensive; the schema is not exposed by PostgREST)
  EXECUTE 'REVOKE ALL ON SCHEMA sec2_backup FROM anon, authenticated, service_role';
  EXECUTE 'REVOKE ALL ON TABLE sec2_backup.acl_snapshot FROM anon, authenticated, service_role';
END
$sec2_01_revoke_api_roles$;

INSERT INTO sec2_backup.acl_snapshot (table_name, grantee, privilege_type, is_grantable)
SELECT c.relname,
       CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
       a.privilege_type,
       a.is_grantable
  FROM pg_class c, LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) AS a
 WHERE c.oid IN ('public.orders'::regclass, 'public.order_items'::regclass, 'public.push_subscriptions'::regclass)
   AND (a.grantee = 0 OR a.grantee IN (SELECT r.oid FROM pg_roles r WHERE r.rolname IN ('anon', 'authenticated')));

-- ─── The change ───────────────────────────────────────────────────────────────────────────────────────
REVOKE ALL ON TABLE public.orders, public.order_items, public.push_subscriptions FROM PUBLIC, anon, authenticated;

-- ─── Post-check (same transaction) ────────────────────────────────────────────────────────────────────
DO $sec2_01_postcheck$
DECLARE
  v_t    text;
  v_role text;
  v_priv text;
BEGIN
  FOREACH v_t IN ARRAY ARRAY['orders', 'order_items', 'push_subscriptions'] LOOP
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
        IF has_table_privilege(v_role, 'public.' || v_t, v_priv) THEN
          RAISE EXCEPTION 'sec2_01_postcheck: % still has % on public.% (inherited or via membership?)', v_role, v_priv, v_t;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_class c, LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) AS a
              WHERE c.oid IN ('public.orders'::regclass, 'public.order_items'::regclass, 'public.push_subscriptions'::regclass)
                AND (a.grantee = 0 OR a.grantee IN (SELECT r.oid FROM pg_roles r WHERE r.rolname IN ('anon', 'authenticated')))) THEN
    RAISE EXCEPTION 'sec2_01_postcheck: PUBLIC / anon / authenticated still appear in the table ACLs';
  END IF;

  IF NOT (    has_table_privilege('service_role', 'public.orders', 'SELECT') AND has_table_privilege('service_role', 'public.orders', 'INSERT')
          AND has_table_privilege('service_role', 'public.orders', 'UPDATE')
          AND has_table_privilege('service_role', 'public.order_items', 'SELECT') AND has_table_privilege('service_role', 'public.order_items', 'INSERT')
          AND has_table_privilege('service_role', 'public.order_items', 'UPDATE')
          AND has_table_privilege('service_role', 'public.push_subscriptions', 'SELECT') AND has_table_privilege('service_role', 'public.push_subscriptions', 'INSERT')
          AND has_table_privilege('service_role', 'public.push_subscriptions', 'DELETE')) THEN
    RAISE EXCEPTION 'sec2_01_postcheck: service_role lost a privilege the server routes need';
  END IF;

  IF (SELECT count(*) FROM sec2_backup.acl_snapshot) = 0 THEN
    RAISE EXCEPTION 'sec2_01_postcheck: empty privilege snapshot - rollback would not be exact';
  END IF;
END
$sec2_01_postcheck$;

COMMIT;
