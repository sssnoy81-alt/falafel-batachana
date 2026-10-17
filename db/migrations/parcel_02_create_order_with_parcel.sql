-- FALAFEL BATACHANA — PARCEL MODULE — parcel_02_create_order_with_parcel.sql (GATE 03B)
-- Atomic wrapper: public.create_order(...) + one public.parcel_requests row in the SAME transaction.
--
-- REVIEW ONLY — NOT EXECUTED. Requires parcel_01_tables.sql. Does NOT modify public.create_order.
--
-- Verified live evidence this file relies on (GATE 02A / 03A, owner-run catalog queries):
--   * public.create_order(p_order jsonb, p_items jsonb, p_delivery jsonb)  — p_delivery has DEFAULT NULL
--     RETURNS TABLE(created_order_id uuid, created_order_number integer, created_daily_number integer)
--     SECURITY INVOKER, search_path='', EXECUTE: service_role only
--   * md5(prosrc) = db92e75f8bfdadb6d78be035da855996, length 6416 — byte-identical (CRLF) to the reviewed copy:
--     plpgsql, no EXCEPTION handler, all failures RAISE (SQLSTATE 22023), no dynamic SQL, no notify / HTTP /
--     dblink, transaction-scoped advisory lock, writes orders + order_items (+ deliveries for delivery),
--     RETURN QUERY of exactly one row.
-- The preflight below re-checks all of this and aborts if create_order has changed since the review.
--
-- Atomicity: the wrapper has no EXCEPTION block, so any error (create_order validation, parcel CHECK,
-- active-duplicate unique index, missing order) aborts the single RPC statement and PostgREST's request
-- transaction → nothing is kept. Known non-transactional effect inherited from create_order: a consumed
-- orders.order_number sequence value is NOT returned on rollback (gap in order_number; daily_number is
-- MAX+1 and unaffected). order_number is not the customer-facing ticket number.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ─── Preflight ────────────────────────────────────────────────────────────────────────────────────────
DO $preflight$
DECLARE
  v_count  integer;
  v_args   text;
  v_result text;
  v_secdef boolean;
  v_cfg    text[];
  v_md5    text;
BEGIN
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'create_order';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'parcel_02 preflight: expected exactly one public.create_order, found %', v_count;
  END IF;

  SELECT pg_get_function_identity_arguments(p.oid), pg_get_function_result(p.oid), p.prosecdef, p.proconfig, md5(p.prosrc)
    INTO v_args, v_result, v_secdef, v_cfg, v_md5
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'create_order';

  IF v_args IS DISTINCT FROM 'p_order jsonb, p_items jsonb, p_delivery jsonb' THEN
    RAISE EXCEPTION 'parcel_02 preflight: unexpected create_order arguments: %', v_args;
  END IF;
  IF v_result IS DISTINCT FROM 'TABLE(created_order_id uuid, created_order_number integer, created_daily_number integer)' THEN
    RAISE EXCEPTION 'parcel_02 preflight: unexpected create_order result: %', v_result;
  END IF;
  IF v_secdef THEN
    RAISE EXCEPTION 'parcel_02 preflight: create_order is SECURITY DEFINER (expected INVOKER)';
  END IF;
  IF v_md5 IS DISTINCT FROM 'db92e75f8bfdadb6d78be035da855996' THEN
    RAISE EXCEPTION 'parcel_02 preflight: create_order source changed since review (md5 %) — re-review required', v_md5;
  END IF;

  IF to_regclass('public.parcel_requests') IS NULL THEN
    RAISE EXCEPTION 'parcel_02 preflight: run parcel_01_tables.sql first';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'create_order_with_parcel') THEN
    RAISE EXCEPTION 'parcel_02 preflight: create_order_with_parcel already exists (no silent re-apply)';
  END IF;
END
$preflight$;

-- ─── Wrapper ──────────────────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION public.create_order_with_parcel(
  p_order    jsonb,
  p_items    jsonb,
  p_delivery jsonb,
  p_parcel   jsonb
)
RETURNS TABLE(created_order_id uuid, created_order_number integer, created_daily_number integer)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_order_id     uuid;
  v_order_number integer;
  v_daily_number integer;
  v_tracking_ref text;
  v_carrier      text;
BEGIN
  -- Structural checks BEFORE any order is created. Value rules (format, length, duplicates) are enforced by
  -- public.parcel_requests constraints; any violation aborts this whole call (no EXCEPTION handler here).
  IF p_parcel IS NULL OR jsonb_typeof(p_parcel) <> 'object' THEN
    RAISE EXCEPTION 'create_order_with_parcel: parcel details required' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_parcel) AS k(key) WHERE k.key NOT IN ('tracking_ref', 'carrier')) THEN
    RAISE EXCEPTION 'create_order_with_parcel: unexpected parcel field' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_parcel -> 'tracking_ref') IS DISTINCT FROM 'string'
     OR (p_parcel ? 'carrier' AND jsonb_typeof(p_parcel -> 'carrier') NOT IN ('string', 'null')) THEN
    RAISE EXCEPTION 'create_order_with_parcel: invalid parcel field type' USING ERRCODE = '22023';
  END IF;
  IF (p_order ->> 'type') IS DISTINCT FROM 'delivery' THEN
    RAISE EXCEPTION 'create_order_with_parcel: parcel requires a delivery order' USING ERRCODE = '22023';
  END IF;
  IF p_delivery IS NULL OR jsonb_typeof(p_delivery) <> 'object' THEN
    RAISE EXCEPTION 'create_order_with_parcel: delivery details required' USING ERRCODE = '22023';
  END IF;

  v_tracking_ref := btrim(p_parcel ->> 'tracking_ref');
  v_carrier      := NULLIF(btrim(p_parcel ->> 'carrier'), '');

  -- 1) The existing, unchanged order creation — all three arguments passed explicitly.
  SELECT c.created_order_id, c.created_order_number, c.created_daily_number
    INTO STRICT v_order_id, v_order_number, v_daily_number
    FROM public.create_order(p_order, p_items, p_delivery) AS c;

  -- 2) The parcel row, branch taken from the SAVED order (the BEFORE INSERT trigger re-derives and validates it).
  INSERT INTO public.parcel_requests (order_id, branch_id, tracking_ref, carrier, last_actor)
  SELECT o.id, o.branch_id, v_tracking_ref, v_carrier, 'customer_checkout'
    FROM public.orders AS o
   WHERE o.id = v_order_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'create_order_with_parcel: created order not visible' USING ERRCODE = 'P0002';
  END IF;

  -- 3) Same return shape as public.create_order.
  RETURN QUERY SELECT v_order_id, v_order_number, v_daily_number;
END
$fn$;

COMMENT ON FUNCTION public.create_order_with_parcel(jsonb, jsonb, jsonb, jsonb) IS
  'Parcel module (GATE 03B): public.create_order + one parcel_requests row, atomically. service_role only. '
  'Errors always propagate (no EXCEPTION handler). Does not modify create_order.';

-- Supabase default privileges grant EXECUTE on new functions → revoke, then allow service_role only.
REVOKE ALL ON FUNCTION public.create_order_with_parcel(jsonb, jsonb, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_order_with_parcel(jsonb, jsonb, jsonb, jsonb) TO service_role;

COMMIT;
