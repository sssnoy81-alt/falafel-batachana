-- FALAFEL BATACHANA — PARCEL MODULE — parcel_04_cancel_gate.sql (GATE M04-B)
-- Closes the cancellation race "parcel not_found → found" for orders still in 'received' (GATE M04-A).
--
-- REVIEW ONLY — NOT EXECUTED. Separate Production approval required. Rollback: parcel_04_rollback.sql.
-- Read-only verification after install: parcel_04_verify.sql.
--
-- Approved rule (orders in 'received' being cancelled), decided at the database under a parcel row lock:
--   no parcel                    → allowed (food-only order, unchanged)
--   parcel not_found             → allowed (agreed not-found workflow; Migration 03 sync then cancels the parcel)
--   parcel cancelled (food_only) → allowed (the order is a food-only order by now)
--   anything else (awaiting_search, found, any unexpected value) → RAISE 'parcel_cancel_requires_not_found' (22023)
-- The application already maps 22023 + /^parcel_[a-z_]+$/ on the order update to HTTP 409 invalid_state
-- (app/api/kitchen/orders/[id]/status/route.ts → ParcelStateRejectedError), so no application change is needed.
--
-- Objects added (nothing else — Migrations 01 / 01b / 02 / 03 objects, tables, policies, grants on tables and data
-- are untouched):
--   public.orders_parcel_cancel_gate()  + trigger orders_parcel_cancel_gate (BEFORE UPDATE, FOR EACH ROW)
--   WHEN (OLD.status = 'received' AND NEW.status = 'cancelled')  — disjoint from the Migration 03 acceptance gate,
--   which excludes cancellation; confirmed / preparing cancellations never fire it.
--
-- Locking (READ COMMITTED): the order row is locked by the UPDATE, then the parcel row FOR SHARE (order → parcel,
-- the same order as the Migration 03 gate and sync). After a lock wait FOR SHARE returns the latest committed row,
-- so the decision uses the current parcel state:
--   parcel change commits first → the gate sees the new status (found → rejected; cancelled / not_found → allowed)
--   cancellation goes first     → the parcel change waits, then its conditional update finds 'cancelled' (0 rows)
-- Execution identity: SECURITY INVOKER, search_path ''. EXECUTE revoked from PUBLIC / anon / authenticated /
-- service_role (trigger firing does not check EXECUTE). FOR SHARE needs SELECT + UPDATE on parcel_requests for the
-- role that updates orders — asserted below for every role that can actually update orders rows.

BEGIN;

SET LOCAL lock_timeout = '5s';        -- CREATE TRIGGER takes SHARE ROW EXCLUSIVE on public.orders; never queue behind traffic
SET LOCAL statement_timeout = '60s';

-- ─── Preflight ────────────────────────────────────────────────────────────────────────────────────────
DO $parcel_04_preflight$
DECLARE
  v_md5  text;
  v_len  integer;
  v_n    integer;
  v_gate oid;
  v_sync oid;
  v_def  text;
  v_fp   text;
BEGIN
  IF to_regclass('public.orders') IS NULL OR to_regclass('public.parcel_requests') IS NULL
     OR to_regclass('public.parcel_events') IS NULL THEN
    RAISE EXCEPTION 'parcel_04_preflight: public.orders / parcel_requests / parcel_events missing';
  END IF;

  -- Migration 04 objects must not exist yet (no silent re-apply).
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'orders_parcel_cancel_gate')
     OR EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgname = 'orders_parcel_cancel_gate') THEN
    RAISE EXCEPTION 'parcel_04_preflight: orders_parcel_cancel_gate already exists';
  END IF;

  -- Migration 03 must be installed exactly as reviewed (functions by fingerprint, triggers by definition).
  SELECT p.oid, md5(p.prosrc), length(p.prosrc) INTO v_gate, v_md5, v_len
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'orders_parcel_accept_gate';
  IF v_gate IS NULL OR NOT ((v_md5 = 'e3c0c90960cbbf2097583aea04b3c458' AND v_len = 1041)
                            OR (v_md5 = '5ad506d6cb4fcbf8d4ff75cc8d0429d8' AND v_len = 1071)) THEN
    RAISE EXCEPTION 'parcel_04_preflight: Migration 03 acceptance gate missing or changed (md5 %, length %)', v_md5, v_len;
  END IF;
  SELECT p.oid, md5(p.prosrc), length(p.prosrc) INTO v_sync, v_md5, v_len
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'orders_parcel_cancel_sync';
  IF v_sync IS NULL OR NOT ((v_md5 = '7421fc0264202b2b571e7fe8934f32c0' AND v_len = 918)
                            OR (v_md5 = '32aa88ffc07ef9f09c6ecdd884aa4836' AND v_len = 938)) THEN
    RAISE EXCEPTION 'parcel_04_preflight: Migration 03 cancel sync missing or changed (md5 %, length %)', v_md5, v_len;
  END IF;
  IF (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid = 'public.orders'::regclass AND NOT t.tgisinternal) <> 2
     OR NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.orders'::regclass
                       AND t.tgname = 'orders_parcel_accept_gate' AND t.tgfoid = v_gate AND t.tgenabled = 'O' AND t.tgtype = 19)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.orders'::regclass
                       AND t.tgname = 'orders_parcel_cancel_sync' AND t.tgfoid = v_sync AND t.tgenabled = 'O' AND t.tgtype = 17) THEN
    RAISE EXCEPTION 'parcel_04_preflight: public.orders user triggers are not exactly the Migration 03 pair';
  END IF;

  -- Parcel trigger function (01b) unchanged: it validates the Migration 03 sync after this gate allows a cancel.
  SELECT count(*), max(md5(p.prosrc)), max(length(p.prosrc)) INTO v_n, v_md5, v_len
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'parcel_requests_before_write';
  IF v_n <> 1 OR NOT ((v_md5 = '9da7eec21b14950cfcbe4481ecbddf40' AND v_len = 5560)
                      OR (v_md5 = 'bf1d4abc4698dd2213023df069b75255' AND v_len = 5397)) THEN
    RAISE EXCEPTION 'parcel_04_preflight: parcel_requests_before_write is not the installed parcel_01b version (n %, md5 %, length %)', v_n, v_md5, v_len;
  END IF;

  -- Execution identity: nobody else may see parcel rows through RLS; service_role can run the trigger.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role' AND rolbypassrls)
     OR NOT (has_table_privilege('service_role', 'public.parcel_requests', 'SELECT')
             AND has_table_privilege('service_role', 'public.parcel_requests', 'UPDATE')) THEN
    RAISE EXCEPTION 'parcel_04_preflight: service_role missing BYPASSRLS or SELECT / UPDATE on parcel_requests';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c, LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) AS a
              WHERE c.oid = 'public.parcel_requests'::regclass AND a.grantee <> c.relowner
                AND a.grantee NOT IN (SELECT r.oid FROM pg_roles r WHERE r.rolname = 'service_role'))
     OR NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = 'public.parcel_requests'::regclass
                       AND c.relrowsecurity AND NOT c.relforcerowsecurity) THEN
    RAISE EXCEPTION 'parcel_04_preflight: unexpected grantee on parcel_requests, or RLS not enabled / forced';
  END IF;

  -- Food-only safety (same rule as Migration 03): every role that can actually UPDATE public.orders rows must be able
  -- to run this trigger (SELECT + UPDATE on parcel_requests and see parcel rows: BYPASSRLS or owner). Only the constant
  -- false counts as a denying policy expression; anything else is assumed to admit rows (fail closed).
  SELECT string_agg(r.rolname, ', ' ORDER BY r.rolname) INTO v_def
    FROM pg_roles r, pg_class o, pg_class pr
   WHERE o.oid = 'public.orders'::regclass AND pr.oid = 'public.parcel_requests'::regclass
     AND r.rolname !~ '^pg_' AND NOT r.rolsuper
     AND has_table_privilege(r.oid, o.oid, 'UPDATE')
     AND (r.rolbypassrls OR NOT o.relrowsecurity
          OR (pg_has_role(r.oid, o.relowner, 'USAGE') AND NOT o.relforcerowsecurity)
          OR (    EXISTS (SELECT 1 FROM pg_policy pol
                           WHERE pol.polrelid = o.oid AND pol.polcmd IN ('w', '*') AND pol.polpermissive
                             AND (0 = ANY (pol.polroles)
                                  OR EXISTS (SELECT 1 FROM unnest(pol.polroles) AS u(rid) WHERE pg_has_role(r.oid, u.rid, 'USAGE')))
                             AND coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') <> 'false')
              AND EXISTS (SELECT 1 FROM pg_policy pol
                           WHERE pol.polrelid = o.oid AND pol.polcmd IN ('w', '*') AND pol.polpermissive
                             AND (0 = ANY (pol.polroles)
                                  OR EXISTS (SELECT 1 FROM unnest(pol.polroles) AS u(rid) WHERE pg_has_role(r.oid, u.rid, 'USAGE')))
                             AND coalesce(pg_get_expr(coalesce(pol.polwithcheck, pol.polqual), pol.polrelid), '') <> 'false')
              AND NOT EXISTS (SELECT 1 FROM pg_policy pol
                               WHERE pol.polrelid = o.oid AND pol.polcmd IN ('w', '*') AND NOT pol.polpermissive
                                 AND (0 = ANY (pol.polroles)
                                      OR EXISTS (SELECT 1 FROM unnest(pol.polroles) AS u(rid) WHERE pg_has_role(r.oid, u.rid, 'USAGE')))
                                 AND (pg_get_expr(pol.polqual, pol.polrelid) = 'false'
                                      OR pg_get_expr(coalesce(pol.polwithcheck, pol.polqual), pol.polrelid) = 'false'))))
     AND NOT (has_table_privilege(r.oid, pr.oid, 'SELECT') AND has_table_privilege(r.oid, pr.oid, 'UPDATE')
              AND (r.rolbypassrls OR pg_has_role(r.oid, pr.relowner, 'USAGE')));
  IF v_def IS NOT NULL THEN
    RAISE EXCEPTION 'parcel_04_preflight: role(s) can update orders but cannot run the parcel cancel gate: %', v_def;
  END IF;

  -- Fingerprint of every neighbouring function (incl. Migration 03); the post-check proves none of them changed.
  SELECT string_agg(p.proname || ':' || md5(p.prosrc), ',' ORDER BY p.proname, p.oid) INTO v_fp
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('create_order', 'create_order_with_parcel', 'parcel_requests_before_write', 'parcel_requests_log_event',
                       'parcel_events_append_only', 'orders_parcel_accept_gate', 'orders_parcel_cancel_sync');
  PERFORM set_config('parcel_04.neighbours', v_fp, true);
END
$parcel_04_preflight$;

-- ─── Cancellation gate ────────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION public.orders_parcel_cancel_gate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_parcel_status text;
BEGIN
  -- Same condition as the trigger WHEN clause (defensive: no effect for any other transition).
  IF OLD.status IS DISTINCT FROM 'received' OR NEW.status IS DISTINCT FROM 'cancelled' THEN
    RETURN NEW;
  END IF;

  -- The order row is already locked by this UPDATE; lock the parcel row (order -> parcel). After a wait, FOR SHARE
  -- returns the latest committed row, so the decision below uses the current parcel state, not a stale UI snapshot.
  SELECT pr.status
    INTO v_parcel_status
    FROM public.parcel_requests AS pr
   WHERE pr.order_id = OLD.id
     FOR SHARE;

  IF NOT FOUND THEN
    RETURN NEW;   -- food-only order: unchanged behaviour
  END IF;

  IF v_parcel_status IN ('not_found', 'cancelled') THEN
    RETURN NEW;   -- agreed not-found workflow / parcel already closed as food only
  END IF;

  -- awaiting_search, found, or anything unexpected (incl. NULL): fail closed. Stable code, no tracking data.
  RAISE EXCEPTION 'parcel_cancel_requires_not_found' USING ERRCODE = '22023';
END
$fn$;

CREATE TRIGGER orders_parcel_cancel_gate
  BEFORE UPDATE ON public.orders
  FOR EACH ROW
  WHEN (OLD.status = 'received' AND NEW.status = 'cancelled')
  EXECUTE FUNCTION public.orders_parcel_cancel_gate();

-- Trigger functions are never callable as API functions (firing does not check EXECUTE).
REVOKE ALL ON FUNCTION public.orders_parcel_cancel_gate() FROM PUBLIC, anon, authenticated, service_role;

-- ─── Post-check (same transaction) ────────────────────────────────────────────────────────────────────
DO $parcel_04_postcheck$
DECLARE
  v_cg   oid;
  v_gate oid;
  v_sync oid;
  v_fp   text;
  r      record;
BEGIN
  SELECT p.oid INTO v_cg FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'orders_parcel_cancel_gate';
  SELECT p.oid INTO v_gate FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'orders_parcel_accept_gate';
  SELECT p.oid INTO v_sync FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'orders_parcel_cancel_sync';
  IF v_cg IS NULL THEN
    RAISE EXCEPTION 'parcel_04_postcheck: orders_parcel_cancel_gate missing';
  END IF;

  SELECT p.prosecdef, p.proconfig, l.lanname, md5(p.prosrc) AS h, length(p.prosrc) AS len,
         pg_get_function_identity_arguments(p.oid) AS args, pg_get_function_result(p.oid) AS res
    INTO r FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang WHERE p.oid = v_cg;
  IF r.prosecdef OR r.lanname <> 'plpgsql' OR r.args <> '' OR r.res <> 'trigger'
     OR r.proconfig IS DISTINCT FROM ARRAY['search_path=""'] THEN
    RAISE EXCEPTION 'parcel_04_postcheck: orders_parcel_cancel_gate has unexpected attributes';
  END IF;
  IF NOT ((r.h = '24c67346a3bec5bc84d9d2d7622094e6' AND r.len = 1048) OR (r.h = '08c3c845797cf65fa177a9b64f001674' AND r.len = 1076)) THEN
    RAISE EXCEPTION 'parcel_04_postcheck: orders_parcel_cancel_gate source is not the reviewed version (md5 %, length %)', r.h, r.len;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p2, LATERAL aclexplode(coalesce(p2.proacl, acldefault('f', p2.proowner))) AS a
              WHERE p2.oid = v_cg AND a.privilege_type = 'EXECUTE'
                AND (a.grantee = 0 OR a.grantee IN (SELECT ro.oid FROM pg_roles ro
                                                     WHERE ro.rolname IN ('anon', 'authenticated', 'service_role')))) THEN
    RAISE EXCEPTION 'parcel_04_postcheck: EXECUTE on orders_parcel_cancel_gate granted to PUBLIC / anon / authenticated / service_role';
  END IF;

  -- Exactly three user triggers on public.orders: the unchanged Migration 03 pair + this gate.
  -- tgtype bits: ROW 1, BEFORE 2, UPDATE 16 → BEFORE UPDATE ROW = 19, AFTER UPDATE ROW = 17.
  IF (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid = 'public.orders'::regclass AND NOT t.tgisinternal) <> 3
     OR NOT EXISTS (SELECT 1 FROM pg_trigger t
                     WHERE t.tgrelid = 'public.orders'::regclass AND t.tgname = 'orders_parcel_cancel_gate'
                       AND t.tgfoid = v_cg AND t.tgenabled = 'O' AND t.tgtype = 19 AND t.tgattr::text = ''
                       AND pg_get_triggerdef(t.oid) ~ $re$WHEN \(\(\(old\.status = 'received'::text\) AND \(new\.status = 'cancelled'::text\)\)\)$re$)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.orders'::regclass
                       AND t.tgname = 'orders_parcel_accept_gate' AND t.tgfoid = v_gate AND t.tgenabled = 'O' AND t.tgtype = 19)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.orders'::regclass
                       AND t.tgname = 'orders_parcel_cancel_sync' AND t.tgfoid = v_sync AND t.tgenabled = 'O' AND t.tgtype = 17) THEN
    RAISE EXCEPTION 'parcel_04_postcheck: triggers on public.orders are not exactly Migration 03 + orders_parcel_cancel_gate';
  END IF;

  -- No neighbouring function changed (incl. Migration 03).
  SELECT string_agg(p.proname || ':' || md5(p.prosrc), ',' ORDER BY p.proname, p.oid) INTO v_fp
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('create_order', 'create_order_with_parcel', 'parcel_requests_before_write', 'parcel_requests_log_event',
                       'parcel_events_append_only', 'orders_parcel_accept_gate', 'orders_parcel_cancel_sync');
  IF v_fp IS DISTINCT FROM current_setting('parcel_04.neighbours', true) THEN
    RAISE EXCEPTION 'parcel_04_postcheck: a neighbouring function changed during the migration';
  END IF;
END
$parcel_04_postcheck$;

COMMIT;
