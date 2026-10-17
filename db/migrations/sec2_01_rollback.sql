-- FALAFEL BATACHANA — SEC-2 — sec2_01_rollback.sql (GATE SEC-2A)
-- Restores EXACTLY the privileges of PUBLIC / anon / authenticated on public.orders, public.order_items and
-- public.push_subscriptions that sec2_01_revoke_public_access.sql recorded in sec2_backup.acl_snapshot, then removes
-- the backup schema. WARNING: this re-opens public read / insert access to customer order data (emergency use only).
--
-- REVIEW ONLY — NOT EXECUTED. Separate approval required. Grants are generated only from the snapshot rows, with
-- identifiers quoted by format(%I) and the privilege name checked against a fixed list — no other dynamic input.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $sec2_01_rollback$
DECLARE
  r       record;
  v_n     integer;
  v_extra integer;
BEGIN
  IF to_regclass('sec2_backup.acl_snapshot') IS NULL THEN
    RAISE EXCEPTION 'sec2_01_rollback: sec2_backup.acl_snapshot missing - nothing to roll back';
  END IF;
  SELECT count(*) INTO v_n FROM sec2_backup.acl_snapshot;
  IF v_n = 0 THEN
    RAISE EXCEPTION 'sec2_01_rollback: snapshot is empty';
  END IF;
  IF EXISTS (SELECT 1 FROM sec2_backup.acl_snapshot
              WHERE table_name NOT IN ('orders', 'order_items', 'push_subscriptions')
                 OR grantee NOT IN ('PUBLIC', 'anon', 'authenticated')
                 OR privilege_type NOT IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN')) THEN
    RAISE EXCEPTION 'sec2_01_rollback: snapshot contains unexpected rows - refusing';
  END IF;
  -- The lock-down must still be in place (nothing re-granted in between).
  SELECT count(*) INTO v_extra
    FROM pg_class c, LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) AS a
   WHERE c.oid IN ('public.orders'::regclass, 'public.order_items'::regclass, 'public.push_subscriptions'::regclass)
     AND (a.grantee = 0 OR a.grantee IN (SELECT ro.oid FROM pg_roles ro WHERE ro.rolname IN ('anon', 'authenticated')));
  IF v_extra <> 0 THEN
    RAISE EXCEPTION 'sec2_01_rollback: % privilege(s) were re-granted since sec2_01 - review manually', v_extra;
  END IF;

  FOR r IN SELECT * FROM sec2_backup.acl_snapshot ORDER BY table_name, grantee, privilege_type LOOP
    EXECUTE format('GRANT %s ON TABLE public.%I TO %s%s',
                   r.privilege_type, r.table_name,
                   CASE WHEN r.grantee = 'PUBLIC' THEN 'PUBLIC' ELSE quote_ident(r.grantee) END,
                   CASE WHEN r.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
  END LOOP;

  -- Post-check: the ACL entries of PUBLIC / anon / authenticated equal the snapshot exactly.
  IF EXISTS (
    (SELECT table_name, grantee, privilege_type, is_grantable FROM sec2_backup.acl_snapshot)
    EXCEPT
    (SELECT c.relname, CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END, a.privilege_type, a.is_grantable
       FROM pg_class c, LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) AS a
      WHERE c.oid IN ('public.orders'::regclass, 'public.order_items'::regclass, 'public.push_subscriptions'::regclass)
        AND (a.grantee = 0 OR a.grantee IN (SELECT ro.oid FROM pg_roles ro WHERE ro.rolname IN ('anon', 'authenticated'))))
  ) OR EXISTS (
    (SELECT c.relname, CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END, a.privilege_type, a.is_grantable
       FROM pg_class c, LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) AS a
      WHERE c.oid IN ('public.orders'::regclass, 'public.order_items'::regclass, 'public.push_subscriptions'::regclass)
        AND (a.grantee = 0 OR a.grantee IN (SELECT ro.oid FROM pg_roles ro WHERE ro.rolname IN ('anon', 'authenticated'))))
    EXCEPT
    (SELECT table_name, grantee, privilege_type, is_grantable FROM sec2_backup.acl_snapshot)
  ) THEN
    RAISE EXCEPTION 'sec2_01_rollback: restored privileges differ from the snapshot';
  END IF;
END
$sec2_01_rollback$;

DROP TABLE sec2_backup.acl_snapshot;
DROP SCHEMA sec2_backup;

COMMIT;
