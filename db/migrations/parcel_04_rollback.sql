-- FALAFEL BATACHANA — PARCEL MODULE — parcel_04_rollback.sql (GATE M04-B)
-- Removes ONLY the objects added by parcel_04_cancel_gate.sql: trigger orders_parcel_cancel_gate (on public.orders)
-- and function public.orders_parcel_cancel_gate(). Restores the exact Migration 03 state (public.orders with the two
-- Migration 03 triggers). Touches no table, policy, grant, other function or data.
--
-- REVIEW ONLY — NOT EXECUTED. Run only if parcel_04 must be undone (separate approval).
-- Refuses to run unless exactly the reviewed parcel_04 objects are installed next to an unchanged Migration 03.
-- No IF EXISTS, no CASCADE. After rollback the received-cancellation race is open again (the S2b application check
-- still applies). Order of rollbacks: this file MUST run before parcel_03_rollback.sql (which requires exactly two
-- user triggers on public.orders and refuses otherwise).

BEGIN;

SET LOCAL lock_timeout = '5s';        -- DROP TRIGGER takes ACCESS EXCLUSIVE on public.orders; never queue behind traffic
SET LOCAL statement_timeout = '60s';

DO $parcel_04_rollback_preflight$
DECLARE
  v_cg   oid;
  v_gate oid;
  v_sync oid;
  v_md5  text;
  v_len  integer;
  v_fp   text;
BEGIN
  SELECT p.oid, md5(p.prosrc), length(p.prosrc) INTO v_cg, v_md5, v_len
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'orders_parcel_cancel_gate';
  IF v_cg IS NULL THEN
    RAISE EXCEPTION 'parcel_04_rollback_preflight: parcel_04 not installed - nothing to roll back';
  END IF;
  IF NOT ((v_md5 = '24c67346a3bec5bc84d9d2d7622094e6' AND v_len = 1048) OR (v_md5 = '08c3c845797cf65fa177a9b64f001674' AND v_len = 1076)) THEN
    RAISE EXCEPTION 'parcel_04_rollback_preflight: orders_parcel_cancel_gate is not the reviewed version (md5 %, length %)', v_md5, v_len;
  END IF;

  SELECT p.oid INTO v_gate FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'orders_parcel_accept_gate';
  SELECT p.oid INTO v_sync FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'orders_parcel_cancel_sync';
  IF (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid = 'public.orders'::regclass AND NOT t.tgisinternal) <> 3
     OR NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.orders'::regclass
                       AND t.tgname = 'orders_parcel_cancel_gate' AND t.tgfoid = v_cg)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.orders'::regclass
                       AND t.tgname = 'orders_parcel_accept_gate' AND t.tgfoid = v_gate)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.orders'::regclass
                       AND t.tgname = 'orders_parcel_cancel_sync' AND t.tgfoid = v_sync) THEN
    RAISE EXCEPTION 'parcel_04_rollback_preflight: triggers on public.orders are not exactly Migration 03 + orders_parcel_cancel_gate';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgfoid = v_cg
                AND NOT (t.tgrelid = 'public.orders'::regclass AND t.tgname = 'orders_parcel_cancel_gate')) THEN
    RAISE EXCEPTION 'parcel_04_rollback_preflight: orders_parcel_cancel_gate() is used by another trigger';
  END IF;

  SELECT string_agg(p.proname || ':' || md5(p.prosrc), ',' ORDER BY p.proname, p.oid) INTO v_fp
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('create_order', 'create_order_with_parcel', 'parcel_requests_before_write', 'parcel_requests_log_event',
                       'parcel_events_append_only', 'orders_parcel_accept_gate', 'orders_parcel_cancel_sync');
  PERFORM set_config('parcel_04_rollback.neighbours', v_fp, true);
END
$parcel_04_rollback_preflight$;

DROP TRIGGER orders_parcel_cancel_gate ON public.orders;
DROP FUNCTION public.orders_parcel_cancel_gate();

DO $parcel_04_rollback_postcheck$
DECLARE
  v_fp text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'orders_parcel_cancel_gate') THEN
    RAISE EXCEPTION 'parcel_04_rollback_postcheck: orders_parcel_cancel_gate still exists';
  END IF;
  IF (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid = 'public.orders'::regclass AND NOT t.tgisinternal) <> 2
     OR (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid = 'public.orders'::regclass AND NOT t.tgisinternal
           AND t.tgname IN ('orders_parcel_accept_gate', 'orders_parcel_cancel_sync') AND t.tgenabled = 'O') <> 2 THEN
    RAISE EXCEPTION 'parcel_04_rollback_postcheck: public.orders is not back to exactly the Migration 03 pair';
  END IF;
  SELECT string_agg(p.proname || ':' || md5(p.prosrc), ',' ORDER BY p.proname, p.oid) INTO v_fp
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('create_order', 'create_order_with_parcel', 'parcel_requests_before_write', 'parcel_requests_log_event',
                       'parcel_events_append_only', 'orders_parcel_accept_gate', 'orders_parcel_cancel_sync');
  IF v_fp IS DISTINCT FROM current_setting('parcel_04_rollback.neighbours', true) THEN
    RAISE EXCEPTION 'parcel_04_rollback_postcheck: a neighbouring function changed during the rollback';
  END IF;
END
$parcel_04_rollback_postcheck$;

COMMIT;
