-- FALAFEL BATACHANA — PARCEL MODULE — parcel_03_orders_gate.sql (GATE 03I / stage S3, revised)
-- Database-level acceptance gate + cancellation sync for parcel orders on public.orders.
--
-- REVIEW ONLY — NOT EXECUTED. Separate Production approval required. Rollback: parcel_03_rollback.sql.
-- Read-only verification after install: parcel_03_verify.sql.
--
-- Baseline (asserted by the preflight; aborts on any difference):
--   * parcel_01 + parcel_02 + parcel_01b installed; public.parcel_requests_before_write() is the parcel_01b source
--     (md5 9da7eec21b14950cfcbe4481ecbddf40 / 5560 CRLF, or bf1d4abc4698dd2213023df069b75255 / 5397 LF);
--   * parcel_requests_log_event 08de848cf7badf72b426972a12590957 / 281, parcel_events_append_only
--     c098c15fc3a0b898f7f148f4b2cc9dea / 86, create_order_with_parcel 7d491c097bf60b7e17beae25890b1238 / 2474;
--   * public.orders has NO user triggers; its status CHECK lists the six order statuses;
--   * service_role (BYPASSRLS) is the only non-owner grantee on public.parcel_requests; RLS enabled, not forced;
--   * every role that can actually UPDATE public.orders rows can also run both triggers (food-only safety);
--   * no existing order/parcel combination already violates the rules below.
--
-- Objects added (and nothing else — no table, column, constraint, policy, grant on tables, data or other function):
--   1) public.orders_parcel_accept_gate()  + trigger orders_parcel_accept_gate  (BEFORE UPDATE, FOR EACH ROW)
--      WHEN OLD.status = 'received' AND NEW.status IS DISTINCT FROM 'received' AND NEW.status IS DISTINCT FROM 'cancelled'
--      → EVERY non-cancellation exit from 'received' (confirmed, preparing, ready, delivered, …), not only → confirmed.
--      Parcel row locked FOR SHARE; none → food-only order, unchanged; 'found' / 'cancelled' → allowed;
--      anything else, including an unexpected value → RAISE 'parcel_not_ready' (SQLSTATE P0001). The S2 status route
--      maps exactly (code P0001, message 'parcel_not_ready') to HTTP 409 parcel_not_ready.
--   2) public.orders_parcel_cancel_sync()  + trigger orders_parcel_cancel_sync  (AFTER UPDATE, FOR EACH ROW)
--      WHEN NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM 'cancelled'
--      → a parcel still in the store (awaiting_search / not_found / found) becomes 'cancelled' with close_reason
--        'order_cancelled', last_actor 'system:order_cancelled' (validated by parcel_requests_before_write, logged by
--        parcel_requests_log_status). Parcels handed to the courier or later are never touched.
--   No column list (no "UPDATE OF status"): the WHEN clause compares OLD/NEW status, so a status change is caught
--   however the UPDATE is written. There is deliberately NO trigger on 'delivered'.
--
-- Execution identity: both functions SECURITY INVOKER, search_path ''. They run with the privileges of the role that
-- updates public.orders: service_role (kitchen route; has SELECT/UPDATE on parcel_requests, INSERT on parcel_events,
-- BYPASSRLS) or the owner (SQL editor). Any other role fails closed with a permission error (42501). anon /
-- authenticated have no UPDATE policy on orders, so they never reach these triggers. Trigger firing does not check
-- EXECUTE; EXECUTE is revoked from PUBLIC, anon, authenticated and service_role (not callable as RPC).
--
-- Locking (READ COMMITTED; proven by the local two-session tests, to be repeated on staging — see review):
--   order UPDATE (row lock on the order) → gate: parcel row FOR SHARE      | order → parcel
--   order UPDATE (row lock on the order) → sync: UPDATE parcel row          | order → parcel
--   parcel UPDATE (kitchen parcel route): parcel row lock, reads orders WITHOUT a lock (parcel_01b UPDATE branch)
--   parcel INSERT (parcel_01b): order row FOR SHARE, the new parcel row is not yet visible to anyone
--   No path locks parcel → order, so no lock-order cycle between these paths.

BEGIN;

SET LOCAL lock_timeout = '5s';        -- CREATE TRIGGER takes SHARE ROW EXCLUSIVE on public.orders; never queue behind traffic
SET LOCAL statement_timeout = '60s';

-- ─── Preflight ────────────────────────────────────────────────────────────────────────────────────────
DO $parcel_03_preflight$
DECLARE
  v_md5 text;
  v_len integer;
  v_n   integer;
  v_def text;
  v_fp  text;
BEGIN
  IF to_regclass('public.orders') IS NULL OR to_regclass('public.parcel_requests') IS NULL
     OR to_regclass('public.parcel_events') IS NULL THEN
    RAISE EXCEPTION 'parcel_03_preflight: public.orders / parcel_requests / parcel_events missing';
  END IF;

  -- The gate objects must not exist yet (no silent re-apply).
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname IN ('orders_parcel_accept_gate', 'orders_parcel_cancel_sync')) THEN
    RAISE EXCEPTION 'parcel_03_preflight: gate functions already exist';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.orders'::regclass AND NOT t.tgisinternal) THEN
    RAISE EXCEPTION 'parcel_03_preflight: public.orders already has user triggers - re-review interaction first';
  END IF;

  -- Exact reviewed versions of the functions these triggers interact with.
  SELECT count(*), max(md5(p.prosrc)), max(length(p.prosrc)) INTO v_n, v_md5, v_len
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'parcel_requests_before_write';
  IF v_n <> 1 OR NOT ((v_md5 = '9da7eec21b14950cfcbe4481ecbddf40' AND v_len = 5560)
                      OR (v_md5 = 'bf1d4abc4698dd2213023df069b75255' AND v_len = 5397)) THEN
    RAISE EXCEPTION 'parcel_03_preflight: parcel_requests_before_write is not the installed parcel_01b version (n %, md5 %, length %)', v_n, v_md5, v_len;
  END IF;

  SELECT count(*), max(md5(p.prosrc)), max(length(p.prosrc)) INTO v_n, v_md5, v_len
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'parcel_requests_log_event';
  IF v_n <> 1 OR v_md5 <> '08de848cf7badf72b426972a12590957' OR v_len <> 281 THEN
    RAISE EXCEPTION 'parcel_03_preflight: parcel_requests_log_event changed (n %, md5 %, length %)', v_n, v_md5, v_len;
  END IF;

  SELECT count(*), max(md5(p.prosrc)), max(length(p.prosrc)) INTO v_n, v_md5, v_len
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'parcel_events_append_only';
  IF v_n <> 1 OR v_md5 <> 'c098c15fc3a0b898f7f148f4b2cc9dea' OR v_len <> 86 THEN
    RAISE EXCEPTION 'parcel_03_preflight: parcel_events_append_only changed (n %, md5 %, length %)', v_n, v_md5, v_len;
  END IF;

  SELECT count(*), max(md5(p.prosrc)), max(length(p.prosrc)) INTO v_n, v_md5, v_len
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'create_order_with_parcel';
  IF v_n <> 1 OR v_md5 <> '7d491c097bf60b7e17beae25890b1238' OR v_len <> 2474 THEN
    RAISE EXCEPTION 'parcel_03_preflight: create_order_with_parcel changed (n %, md5 %, length %)', v_n, v_md5, v_len;
  END IF;

  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'create_order') <> 1 THEN
    RAISE EXCEPTION 'parcel_03_preflight: expected exactly one public.create_order';
  END IF;

  -- Existing parcel triggers must be in place and enabled.
  IF (SELECT count(*) FROM pg_trigger t
       WHERE t.tgrelid = 'public.parcel_requests'::regclass AND NOT t.tgisinternal AND t.tgenabled = 'O'
         AND t.tgname IN ('parcel_requests_before_write', 'parcel_requests_log_insert', 'parcel_requests_log_status')) <> 3 THEN
    RAISE EXCEPTION 'parcel_03_preflight: parcel_requests triggers missing or disabled';
  END IF;

  -- orders.status: text with a CHECK listing the six statuses.
  IF (SELECT a.atttypid FROM pg_attribute a
       WHERE a.attrelid = 'public.orders'::regclass AND a.attname = 'status' AND NOT a.attisdropped) IS DISTINCT FROM 'text'::regtype THEN
    RAISE EXCEPTION 'parcel_03_preflight: orders.status is not text';
  END IF;
  SELECT string_agg(pg_get_constraintdef(c.oid), ' ') INTO v_def
    FROM pg_constraint c WHERE c.conrelid = 'public.orders'::regclass AND c.contype = 'c';
  IF v_def IS NULL OR v_def NOT LIKE '%''received''%' OR v_def NOT LIKE '%''confirmed''%' OR v_def NOT LIKE '%''preparing''%'
     OR v_def NOT LIKE '%''ready''%' OR v_def NOT LIKE '%''delivered''%' OR v_def NOT LIKE '%''cancelled''%' THEN
    RAISE EXCEPTION 'parcel_03_preflight: orders status CHECK with the six statuses not found';
  END IF;

  -- Execution identity: service_role must be able to run both triggers; nobody else may see parcel rows through RLS.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role' AND rolbypassrls) THEN
    RAISE EXCEPTION 'parcel_03_preflight: service_role missing or without BYPASSRLS';
  END IF;
  IF NOT (has_table_privilege('service_role', 'public.parcel_requests', 'SELECT')
          AND has_table_privilege('service_role', 'public.parcel_requests', 'UPDATE')
          AND has_table_privilege('service_role', 'public.parcel_events', 'INSERT')
          AND has_table_privilege('service_role', 'public.orders', 'SELECT')
          AND has_table_privilege('service_role', 'public.orders', 'UPDATE')) THEN
    RAISE EXCEPTION 'parcel_03_preflight: service_role lacks a privilege the triggers need';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_class c, LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) AS a
     WHERE c.oid = 'public.parcel_requests'::regclass
       AND a.grantee <> c.relowner
       AND a.grantee NOT IN (SELECT r.oid FROM pg_roles r WHERE r.rolname = 'service_role')
  ) THEN
    -- A grantee subject to RLS (no policies) would see NO parcel row and pass the gate silently.
    RAISE EXCEPTION 'parcel_03_preflight: unexpected grantee on public.parcel_requests';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = 'public.parcel_requests'::regclass
                    AND c.relrowsecurity AND NOT c.relforcerowsecurity) THEN
    RAISE EXCEPTION 'parcel_03_preflight: parcel_requests RLS must be enabled and not forced';
  END IF;

  -- Food-only safety: EVERY role that can actually UPDATE rows of public.orders must be able to run both triggers
  -- (SELECT + UPDATE on parcel_requests, INSERT on parcel_events, and see parcel rows: BYPASSRLS or owner).
  -- Otherwise even food-only acceptances / cancellations by that role would fail (42501) once the triggers exist.
  -- "Can actually UPDATE rows" = UPDATE privilege AND (BYPASSRLS, RLS off, owner without FORCE RLS, or the UPDATE / ALL
  -- policies applying to the role can admit a row): PostgreSQL admits a row only if some permissive USING passes, some
  -- permissive check (WITH CHECK, else USING) passes, and no restrictive one fails. A policy expression counts as denying
  -- ONLY when it is the constant false; any other expression (or none) is assumed to admit rows (fail closed).
  -- Superusers bypass privileges; predefined pg_* roles are not login roles (their members are checked themselves).
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
              AND has_table_privilege(r.oid, 'public.parcel_events'::regclass, 'INSERT')
              AND (r.rolbypassrls OR pg_has_role(r.oid, pr.relowner, 'USAGE')));
  IF v_def IS NOT NULL THEN
    RAISE EXCEPTION 'parcel_03_preflight: role(s) can update orders but cannot run the parcel triggers: %', v_def;
  END IF;

  -- Existing data must already satisfy the rules (the migration never rewrites data). Counts only.
  SELECT count(*) INTO v_n
    FROM public.orders o JOIN public.parcel_requests pr ON pr.order_id = o.id
   WHERE (o.status NOT IN ('received', 'cancelled') AND pr.status NOT IN ('found', 'cancelled', 'handed_to_courier',
                                                                         'carrier_verified', 'delivery_problem', 'returned_to_store'))
      OR (o.status = 'cancelled' AND pr.status IN ('awaiting_search', 'not_found', 'found'));
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'parcel_03_preflight: % existing order/parcel row(s) already violate the gate - review data first', v_n;
  END IF;

  -- Fingerprint of every neighbouring function; the post-check proves none of them changed.
  SELECT string_agg(p.proname || ':' || md5(p.prosrc), ',' ORDER BY p.proname, p.oid) INTO v_fp
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('create_order', 'create_order_with_parcel', 'parcel_requests_before_write',
                       'parcel_requests_log_event', 'parcel_events_append_only');
  PERFORM set_config('parcel_03.neighbours', v_fp, true);
END
$parcel_03_preflight$;

-- ─── 1) Acceptance gate ───────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION public.orders_parcel_accept_gate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_parcel_status text;
BEGIN
  -- Same condition as the trigger WHEN clause (defensive: no effect for any other transition).
  IF OLD.status IS DISTINCT FROM 'received'
     OR NEW.status IS NOT DISTINCT FROM 'received'
     OR NEW.status IS NOT DISTINCT FROM 'cancelled' THEN
    RETURN NEW;
  END IF;

  -- The order row is already locked by this UPDATE; lock the parcel row (order -> parcel, same order as the sync).
  -- FOR SHARE blocks a concurrent parcel change until this transaction ends and returns the latest committed row.
  SELECT pr.status
    INTO v_parcel_status
    FROM public.parcel_requests AS pr
   WHERE pr.order_id = OLD.id
     FOR SHARE;

  IF NOT FOUND THEN
    RETURN NEW;   -- food-only order: unchanged behaviour
  END IF;

  IF v_parcel_status IS NULL OR v_parcel_status NOT IN ('found', 'cancelled') THEN
    -- stable code for the API layer (HTTP 409 parcel_not_ready); no tracking number or customer data
    RAISE EXCEPTION 'parcel_not_ready' USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END
$fn$;

CREATE TRIGGER orders_parcel_accept_gate
  BEFORE UPDATE ON public.orders
  FOR EACH ROW
  WHEN (OLD.status = 'received' AND NEW.status IS DISTINCT FROM 'received' AND NEW.status IS DISTINCT FROM 'cancelled')
  EXECUTE FUNCTION public.orders_parcel_accept_gate();

-- ─── 2) Cancellation sync ─────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION public.orders_parcel_cancel_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  -- Same condition as the trigger WHEN clause (defensive).
  IF NEW.status IS DISTINCT FROM 'cancelled' OR OLD.status IS NOT DISTINCT FROM 'cancelled' THEN
    RETURN NULL;
  END IF;

  -- Only a parcel still in the store. Conditional on its current status: a concurrent handoff that commits first
  -- is re-checked (READ COMMITTED) and left untouched; parcel_requests_before_write validates the change
  -- (order_cancelled requires the order to be cancelled - visible here, same transaction) and the
  -- parcel_requests_log_status trigger writes the parcel_events row with actor 'system:order_cancelled'.
  UPDATE public.parcel_requests AS pr
     SET status       = 'cancelled',
         close_reason = 'order_cancelled',
         last_actor   = 'system:order_cancelled'
   WHERE pr.order_id = OLD.id
     AND pr.status IN ('awaiting_search', 'not_found', 'found');

  RETURN NULL;   -- AFTER trigger
END
$fn$;

CREATE TRIGGER orders_parcel_cancel_sync
  AFTER UPDATE ON public.orders
  FOR EACH ROW
  WHEN (NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM 'cancelled')
  EXECUTE FUNCTION public.orders_parcel_cancel_sync();

-- Trigger functions are never callable as API functions (firing does not check EXECUTE).
REVOKE ALL ON FUNCTION public.orders_parcel_accept_gate() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.orders_parcel_cancel_sync() FROM PUBLIC, anon, authenticated, service_role;

-- ─── Post-check (same transaction) ────────────────────────────────────────────────────────────────────
DO $parcel_03_postcheck$
DECLARE
  v_gate oid;
  v_sync oid;
  v_fp   text;
  r      record;
BEGIN
  SELECT p.oid INTO v_gate FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'orders_parcel_accept_gate';
  SELECT p.oid INTO v_sync FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'orders_parcel_cancel_sync';
  IF v_gate IS NULL OR v_sync IS NULL THEN
    RAISE EXCEPTION 'parcel_03_postcheck: gate functions missing';
  END IF;

  FOR r IN
    SELECT p.oid, p.proname, p.prosecdef, p.proconfig, l.lanname, md5(p.prosrc) AS h, length(p.prosrc) AS len,
           pg_get_function_identity_arguments(p.oid) AS args, pg_get_function_result(p.oid) AS res
      FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
     WHERE p.oid IN (v_gate, v_sync)
  LOOP
    IF r.prosecdef OR r.lanname <> 'plpgsql' OR r.args <> '' OR r.res <> 'trigger'
       OR r.proconfig IS DISTINCT FROM ARRAY['search_path=""'] THEN
      RAISE EXCEPTION 'parcel_03_postcheck: % has unexpected attributes', r.proname;
    END IF;
    IF NOT (   (r.proname = 'orders_parcel_accept_gate' AND ((r.h = 'e3c0c90960cbbf2097583aea04b3c458' AND r.len = 1041)
                                                             OR (r.h = '5ad506d6cb4fcbf8d4ff75cc8d0429d8' AND r.len = 1071)))
            OR (r.proname = 'orders_parcel_cancel_sync' AND ((r.h = '7421fc0264202b2b571e7fe8934f32c0' AND r.len = 918)
                                                             OR (r.h = '32aa88ffc07ef9f09c6ecdd884aa4836' AND r.len = 938)))) THEN
      RAISE EXCEPTION 'parcel_03_postcheck: % source is not the reviewed version (md5 %, length %)', r.proname, r.h, r.len;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_proc p2, LATERAL aclexplode(coalesce(p2.proacl, acldefault('f', p2.proowner))) AS a
                WHERE p2.oid = r.oid AND a.privilege_type = 'EXECUTE'
                  AND (a.grantee = 0 OR a.grantee IN (SELECT ro.oid FROM pg_roles ro
                                                       WHERE ro.rolname IN ('anon', 'authenticated', 'service_role')))) THEN
      RAISE EXCEPTION 'parcel_03_postcheck: EXECUTE on % granted to PUBLIC / anon / authenticated / service_role', r.proname;
    END IF;
  END LOOP;

  -- Exactly the two triggers on public.orders, enabled, row-level, no column list, wired to the right function.
  -- tgtype bits: ROW 1, BEFORE 2, UPDATE 16 → gate 19 (BEFORE UPDATE ROW), sync 17 (AFTER UPDATE ROW).
  IF (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid = 'public.orders'::regclass AND NOT t.tgisinternal) <> 2
     OR NOT EXISTS (SELECT 1 FROM pg_trigger t
                     WHERE t.tgrelid = 'public.orders'::regclass AND t.tgname = 'orders_parcel_accept_gate'
                       AND t.tgfoid = v_gate AND t.tgenabled = 'O' AND t.tgtype = 19 AND t.tgattr::text = ''
                       AND pg_get_triggerdef(t.oid) ~ $re$WHEN \(\(\(old\.status = 'received'::text\) AND \(new\.status IS DISTINCT FROM 'received'::text\) AND \(new\.status IS DISTINCT FROM 'cancelled'::text\)\)\)$re$)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger t
                     WHERE t.tgrelid = 'public.orders'::regclass AND t.tgname = 'orders_parcel_cancel_sync'
                       AND t.tgfoid = v_sync AND t.tgenabled = 'O' AND t.tgtype = 17 AND t.tgattr::text = ''
                       AND pg_get_triggerdef(t.oid) ~ $re$WHEN \(\(\(new\.status = 'cancelled'::text\) AND \(old\.status IS DISTINCT FROM 'cancelled'::text\)\)\)$re$) THEN
    RAISE EXCEPTION 'parcel_03_postcheck: triggers on public.orders are not exactly the reviewed definitions';
  END IF;

  -- No neighbouring function changed.
  SELECT string_agg(p.proname || ':' || md5(p.prosrc), ',' ORDER BY p.proname, p.oid) INTO v_fp
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('create_order', 'create_order_with_parcel', 'parcel_requests_before_write',
                       'parcel_requests_log_event', 'parcel_events_append_only');
  IF v_fp IS DISTINCT FROM current_setting('parcel_03.neighbours', true) THEN
    RAISE EXCEPTION 'parcel_03_postcheck: a neighbouring function changed during the migration';
  END IF;
END
$parcel_03_postcheck$;

COMMIT;
