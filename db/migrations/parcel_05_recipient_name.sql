-- FALAFEL BATACHANA — PARCEL MODULE — parcel_05_recipient_name.sql (GATE S4-PARCEL-30B)
-- Optional name printed on the parcel ("שם הנמען על החבילה") when it differs from the food customer.
--
-- REVIEW ONLY — NOT EXECUTED. Separate Production approval required. Read-only checks: parcel_05_production_preflight.sql
-- (before), parcel_05_verify.sql (after). Rollback note / function-only rollback: parcel_05_rollback.sql.
--
-- ORDER: install this migration BEFORE deploying the application that reads / sends recipient_name.
--   * The live application (81f14d1) never sends recipient_name and never selects the column → compatible with this
--     migration as soon as it commits.
--   * The new application selects parcel_requests.recipient_name in the kitchen read model and may send
--     p_parcel.recipient_name → it REQUIRES this migration (the current wrapper rejects unknown parcel keys).
--
-- Changes (additive only — no data is changed, nothing is dropped):
--   1. public.parcel_requests.recipient_name text NULL   (no default; existing rows stay NULL = "use the order's
--      customer name"). Never copied from / written to orders.customer_name.
--   2. CHECK parcel_requests_recipient_name_format: NULL, or 2–60 characters, trimmed (btrim), no control characters.
--      The name starts with parcel_requests_ so a violation (23514) maps to HTTP 400 invalid_parcel unchanged.
--   3. public.create_order_with_parcel(p_order jsonb, p_items jsonb, p_delivery jsonb, p_parcel jsonb) — CREATE OR REPLACE
--      with the EXACT existing signature / result / SECURITY INVOKER / search_path ''. The body is the verified
--      Production source (md5 7d491c097bf60b7e17beae25890b1238) with only these edits:
--        * one more allowed parcel key: recipient_name (string or JSON null);
--        * v_recipient := NULLIF(btrim(p_parcel ->> 'recipient_name'), '')  — blank → SQL NULL;
--        * recipient_name added to the parcel INSERT.
--      Everything else (validation order, create_order call, atomicity, no EXCEPTION handler, errors) is unchanged.
--   EXECUTE stays service_role only (CREATE OR REPLACE keeps the ACL; re-asserted below, never widened).
--
-- NOT changed: tables / columns other than (1), RLS, policies, table grants, triggers (parcel_requests_before_write,
-- log, append-only), the parcel state machine, Migrations 01–04 objects and all existing rows.
-- Known limitation: recipient_name is not in parcel_requests_before_write's immutable-column list (that protected
-- function is unchanged here). No application path updates it after creation (kitchen PATCH writes status /
-- close_reason / last_actor only) and only service_role can write the table.

BEGIN;

SET LOCAL lock_timeout = '5s';        -- ALTER TABLE takes a brief ACCESS EXCLUSIVE lock on parcel_requests; fail fast
SET LOCAL statement_timeout = '60s';

-- ─── Preflight (read-only assertions; abort on any surprise) ──────────────────────────────────────────────────────
DO $parcel_05_preflight$
DECLARE
  v_count  integer;
  v_args   text;
  v_result text;
  v_secdef boolean;
  v_cfg    text[];
  v_md5    text;
  v_len    integer;
  v_oid    oid;
BEGIN
  IF to_regclass('public.parcel_requests') IS NULL OR to_regclass('public.orders') IS NULL THEN
    RAISE EXCEPTION 'parcel_05_preflight: public.parcel_requests / public.orders missing';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.parcel_requests'::regclass
              AND attname = 'recipient_name' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'parcel_05_preflight: parcel_requests.recipient_name already exists (no silent re-apply)';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.parcel_requests'::regclass
              AND conname = 'parcel_requests_recipient_name_format') THEN
    RAISE EXCEPTION 'parcel_05_preflight: constraint parcel_requests_recipient_name_format already exists';
  END IF;

  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'create_order_with_parcel';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'parcel_05_preflight: expected exactly one public.create_order_with_parcel, found %', v_count;
  END IF;
  SELECT p.oid, pg_get_function_identity_arguments(p.oid), pg_get_function_result(p.oid), p.prosecdef, p.proconfig,
         md5(p.prosrc), length(p.prosrc)
    INTO v_oid, v_args, v_result, v_secdef, v_cfg, v_md5, v_len
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'create_order_with_parcel';
  IF v_args IS DISTINCT FROM 'p_order jsonb, p_items jsonb, p_delivery jsonb, p_parcel jsonb'
     OR v_result IS DISTINCT FROM 'TABLE(created_order_id uuid, created_order_number integer, created_daily_number integer)' THEN
    RAISE EXCEPTION 'parcel_05_preflight: unexpected create_order_with_parcel signature (args %, result %)', v_args, v_result;
  END IF;
  IF v_secdef OR v_cfg IS DISTINCT FROM ARRAY['search_path=""'] THEN
    RAISE EXCEPTION 'parcel_05_preflight: create_order_with_parcel is not SECURITY INVOKER with search_path '''' (config %)', v_cfg;
  END IF;
  -- The audited Production source. Anything else → STOP for manual review (do not replace an unknown body).
  IF v_md5 IS DISTINCT FROM '7d491c097bf60b7e17beae25890b1238' OR v_len IS DISTINCT FROM 2474 THEN
    RAISE EXCEPTION 'parcel_05_preflight: create_order_with_parcel is not the audited Production source (md5 %, length %) — manual review required', v_md5, v_len;
  END IF;
  IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE')
     OR has_function_privilege('anon', v_oid, 'EXECUTE')
     OR has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'parcel_05_preflight: create_order_with_parcel EXECUTE is not service_role-only';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.parcel_requests', 'INSERT') THEN
    RAISE EXCEPTION 'parcel_05_preflight: service_role cannot INSERT into parcel_requests';
  END IF;
END
$parcel_05_preflight$;

-- ─── 1 + 2: nullable column and its format rule (existing rows: NULL, untouched) ──────────────────────────────────
ALTER TABLE public.parcel_requests ADD COLUMN recipient_name text NULL;

ALTER TABLE public.parcel_requests ADD CONSTRAINT parcel_requests_recipient_name_format CHECK (
  recipient_name IS NULL OR (
    char_length(recipient_name) BETWEEN 2 AND 60
    AND recipient_name = btrim(recipient_name)
    AND recipient_name !~ '[[:cntrl:]]'
  )
);

COMMENT ON COLUMN public.parcel_requests.recipient_name IS
  'Name printed on the parcel when it differs from the food customer (S4-PARCEL-30B). NULL = identify the parcel by '
  'orders.customer_name. Staff-only; never returned by public APIs or logged.';

-- ─── 3: wrapper — exact Production source + recipient_name (same signature, same identity) ────────────────────────
CREATE OR REPLACE FUNCTION public.create_order_with_parcel(
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
  v_recipient    text;
BEGIN
  -- Validate parcel payload before creating the order.

  IF p_parcel IS NULL
     OR jsonb_typeof(p_parcel) <> 'object'
  THEN
    RAISE EXCEPTION
      'create_order_with_parcel: parcel details required'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_object_keys(p_parcel) AS k(key)
    WHERE k.key NOT IN ('tracking_ref', 'carrier', 'recipient_name')
  ) THEN
    RAISE EXCEPTION
      'create_order_with_parcel: unexpected parcel field'
      USING ERRCODE = '22023';
  END IF;

  IF jsonb_typeof(p_parcel -> 'tracking_ref')
       IS DISTINCT FROM 'string'
     OR (
       p_parcel ? 'carrier'
       AND jsonb_typeof(p_parcel -> 'carrier')
           NOT IN ('string', 'null')
     )
     OR (
       p_parcel ? 'recipient_name'
       AND jsonb_typeof(p_parcel -> 'recipient_name')
           NOT IN ('string', 'null')
     )
  THEN
    RAISE EXCEPTION
      'create_order_with_parcel: invalid parcel field type'
      USING ERRCODE = '22023';
  END IF;

  IF (p_order ->> 'type') IS DISTINCT FROM 'delivery' THEN
    RAISE EXCEPTION
      'create_order_with_parcel: parcel requires a delivery order'
      USING ERRCODE = '22023';
  END IF;

  IF p_delivery IS NULL
     OR jsonb_typeof(p_delivery) <> 'object'
  THEN
    RAISE EXCEPTION
      'create_order_with_parcel: delivery details required'
      USING ERRCODE = '22023';
  END IF;

  v_tracking_ref := btrim(p_parcel ->> 'tracking_ref');
  v_carrier := NULLIF(btrim(p_parcel ->> 'carrier'), '');
  v_recipient := NULLIF(btrim(p_parcel ->> 'recipient_name'), '');

  -- Step 1: Create food order using existing function.

  SELECT
    c.created_order_id,
    c.created_order_number,
    c.created_daily_number
  INTO STRICT
    v_order_id,
    v_order_number,
    v_daily_number
  FROM public.create_order(
    p_order,
    p_items,
    p_delivery
  ) AS c;

  -- Step 2: Attach parcel to the newly saved order.

  INSERT INTO public.parcel_requests (
    order_id,
    branch_id,
    tracking_ref,
    carrier,
    recipient_name,
    last_actor
  )
  SELECT
    o.id,
    o.branch_id,
    v_tracking_ref,
    v_carrier,
    v_recipient,
    'customer_checkout'
  FROM public.orders AS o
  WHERE o.id = v_order_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'create_order_with_parcel: created order not visible'
      USING ERRCODE = 'P0002';
  END IF;

  -- Step 3: Preserve the original return shape.

  RETURN QUERY
  SELECT
    v_order_id,
    v_order_number,
    v_daily_number;
END
$fn$;

-- Same identity as before: never callable by PUBLIC / anon / authenticated (idempotent re-assertion, no widening).
REVOKE ALL ON FUNCTION public.create_order_with_parcel(jsonb, jsonb, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_order_with_parcel(jsonb, jsonb, jsonb, jsonb) TO service_role;

-- ─── Post-check (same transaction: any mismatch rolls the whole migration back) ───────────────────────────────────
DO $parcel_05_postcheck$
DECLARE
  v_args   text;
  v_result text;
  v_secdef boolean;
  v_cfg    text[];
  v_md5    text;
  v_len    integer;
  v_oid    oid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.parcel_requests'::regclass
                  AND attname = 'recipient_name' AND NOT attisdropped AND NOT attnotnull
                  AND atttypid = 'text'::regtype AND NOT atthasdef) THEN
    RAISE EXCEPTION 'parcel_05_postcheck: recipient_name is not a nullable text column without default';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.parcel_requests'::regclass
                  AND conname = 'parcel_requests_recipient_name_format' AND contype = 'c' AND convalidated) THEN
    RAISE EXCEPTION 'parcel_05_postcheck: parcel_requests_recipient_name_format missing or not validated';
  END IF;
  IF EXISTS (SELECT 1 FROM public.parcel_requests WHERE recipient_name IS NOT NULL) THEN
    RAISE EXCEPTION 'parcel_05_postcheck: existing rows unexpectedly have a recipient_name';
  END IF;
  SELECT p.oid, pg_get_function_identity_arguments(p.oid), pg_get_function_result(p.oid), p.prosecdef, p.proconfig,
         md5(p.prosrc), length(p.prosrc)
    INTO v_oid, v_args, v_result, v_secdef, v_cfg, v_md5, v_len
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'create_order_with_parcel';
  IF v_args IS DISTINCT FROM 'p_order jsonb, p_items jsonb, p_delivery jsonb, p_parcel jsonb'
     OR v_result IS DISTINCT FROM 'TABLE(created_order_id uuid, created_order_number integer, created_daily_number integer)'
     OR v_secdef OR v_cfg IS DISTINCT FROM ARRAY['search_path=""'] THEN
    RAISE EXCEPTION 'parcel_05_postcheck: create_order_with_parcel identity changed (args %, result %, secdef %, config %)',
      v_args, v_result, v_secdef, v_cfg;
  END IF;
  -- LF (file as committed) or CRLF (pasted on Windows) — both are this reviewed body.
  IF NOT ((v_md5 = 'afbe93d74b201d6bd898edd2b6e28a63' AND v_len = 2656)
       OR (v_md5 = '6ceb72f6c80929adddd7a2b7bb1a0616' AND v_len = 2771)) THEN
    RAISE EXCEPTION 'parcel_05_postcheck: installed body is not the reviewed parcel_05 version (md5 %, length %)', v_md5, v_len;
  END IF;
  IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE')
     OR has_function_privilege('anon', v_oid, 'EXECUTE')
     OR has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'parcel_05_postcheck: create_order_with_parcel EXECUTE is not service_role-only';
  END IF;
END
$parcel_05_postcheck$;

COMMIT;
