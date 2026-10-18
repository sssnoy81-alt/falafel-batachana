-- FALAFEL BATACHANA — PARCEL MODULE — parcel_03_rollback.sql (GATE 03I / stage S3)
-- Removes ONLY the objects added by parcel_03_orders_gate.sql:
--   trigger orders_parcel_cancel_sync, trigger orders_parcel_accept_gate (on public.orders),
--   function public.orders_parcel_cancel_sync(), function public.orders_parcel_accept_gate().
--
-- REVIEW ONLY — NOT EXECUTED. Run only if parcel_03 must be undone (separate approval).
-- Refuses to run unless exactly the reviewed parcel_03 objects are installed. No IF EXISTS, no CASCADE: any
-- unexpected dependency aborts the transaction. Restores the pre-migration catalog state (public.orders without
-- user triggers, no gate functions). Touches no table, policy, grant, other function or data.
--
-- Not undone (by design): parcel rows cancelled by the sync while it was installed, and their parcel_events rows
-- (append-only history). After rollback, the S2 application gate still blocks acceptance (HTTP 409), full
-- cancellation of an order with an in-store parcel stays disabled in S2, and the S2 residual race returns.
--
-- Order of rollbacks: this file MUST run before any rollback that drops the parcel tables (parcel_01); otherwise
-- every order acceptance / cancellation would fail at runtime.

BEGIN;

SET LOCAL lock_timeout = '5s';        -- DROP TRIGGER takes ACCESS EXCLUSIVE on public.orders; never queue behind traffic
SET LOCAL statement_timeout = '60s';

-- ─── Preflight: exactly the reviewed parcel_03 objects ───────────────────────────────────────────────
DO $parcel_03_rollback_preflight$
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
    RAISE EXCEPTION 'parcel_03_rollback_preflight: parcel_03 functions not installed - nothing to roll back';
  END IF;

  FOR r IN
    SELECT p.proname, md5(p.prosrc) AS h, length(p.prosrc) AS len FROM pg_proc p WHERE p.oid IN (v_gate, v_sync)
  LOOP
    IF NOT (   (r.proname = 'orders_parcel_accept_gate' AND ((r.h = 'e3c0c90960cbbf2097583aea04b3c458' AND r.len = 1041)
                                                             OR (r.h = '5ad506d6cb4fcbf8d4ff75cc8d0429d8' AND r.len = 1071)))
            OR (r.proname = 'orders_parcel_cancel_sync' AND ((r.h = '7421fc0264202b2b571e7fe8934f32c0' AND r.len = 918)
                                                             OR (r.h = '32aa88ffc07ef9f09c6ecdd884aa4836' AND r.len = 938)))) THEN
      RAISE EXCEPTION 'parcel_03_rollback_preflight: % is not the reviewed parcel_03 version (md5 %, length %)', r.proname, r.h, r.len;
    END IF;
  END LOOP;

  IF (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid = 'public.orders'::regclass AND NOT t.tgisinternal) <> 2
     OR NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.orders'::regclass
                       AND t.tgname = 'orders_parcel_accept_gate' AND t.tgfoid = v_gate)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.orders'::regclass
                       AND t.tgname = 'orders_parcel_cancel_sync' AND t.tgfoid = v_sync) THEN
    RAISE EXCEPTION 'parcel_03_rollback_preflight: triggers on public.orders are not exactly the parcel_03 pair';
  END IF;

  -- Nothing else may use the two functions.
  IF EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgfoid IN (v_gate, v_sync)
                AND NOT (t.tgrelid = 'public.orders'::regclass
                         AND t.tgname IN ('orders_parcel_accept_gate', 'orders_parcel_cancel_sync'))) THEN
    RAISE EXCEPTION 'parcel_03_rollback_preflight: gate functions are used by another trigger';
  END IF;

  SELECT string_agg(p.proname || ':' || md5(p.prosrc), ',' ORDER BY p.proname, p.oid) INTO v_fp
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('create_order', 'create_order_with_parcel', 'parcel_requests_before_write',
                       'parcel_requests_log_event', 'parcel_events_append_only');
  PERFORM set_config('parcel_03_rollback.neighbours', v_fp, true);
END
$parcel_03_rollback_preflight$;

-- ─── Remove (triggers first, then functions; RESTRICT is the default) ─────────────────────────────────
DROP TRIGGER orders_parcel_cancel_sync ON public.orders;
DROP TRIGGER orders_parcel_accept_gate ON public.orders;
DROP FUNCTION public.orders_parcel_cancel_sync();
DROP FUNCTION public.orders_parcel_accept_gate();

-- ─── Post-check: pre-migration state ──────────────────────────────────────────────────────────────────
DO $parcel_03_rollback_postcheck$
DECLARE
  v_fp text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.orders'::regclass AND NOT t.tgisinternal) THEN
    RAISE EXCEPTION 'parcel_03_rollback_postcheck: public.orders still has user triggers';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname IN ('orders_parcel_accept_gate', 'orders_parcel_cancel_sync')) THEN
    RAISE EXCEPTION 'parcel_03_rollback_postcheck: gate functions still exist';
  END IF;
  IF (SELECT count(*) FROM pg_trigger t
       WHERE t.tgrelid = 'public.parcel_requests'::regclass AND NOT t.tgisinternal AND t.tgenabled = 'O'
         AND t.tgname IN ('parcel_requests_before_write', 'parcel_requests_log_insert', 'parcel_requests_log_status')) <> 3 THEN
    RAISE EXCEPTION 'parcel_03_rollback_postcheck: parcel_requests triggers changed';
  END IF;
  SELECT string_agg(p.proname || ':' || md5(p.prosrc), ',' ORDER BY p.proname, p.oid) INTO v_fp
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('create_order', 'create_order_with_parcel', 'parcel_requests_before_write',
                       'parcel_requests_log_event', 'parcel_events_append_only');
  IF v_fp IS DISTINCT FROM current_setting('parcel_03_rollback.neighbours', true) THEN
    RAISE EXCEPTION 'parcel_03_rollback_postcheck: a neighbouring function changed during the rollback';
  END IF;
END
$parcel_03_rollback_postcheck$;

COMMIT;
