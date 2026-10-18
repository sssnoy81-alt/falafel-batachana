-- FALAFEL BATACHANA — PARCEL MODULE — parcel_01b_insert_lock.sql (GATE 03G, stage S1, rebased on Production)
-- Replaces ONLY public.parcel_requests_before_write().
--
-- REVIEW ONLY — NOT EXECUTED. Separate Production approval required. Rollback: parcel_01b_rollback.sql.
--
-- Baseline = the VERIFIED Production prosrc (CSV export, hex-decoded): md5 caecf3a8dfcf97889ba246d77add0fac, length 4862,
-- CRLF line endings (it contains the explicit IF NOT ( ... OR ... ) transition check, not IF NOT CASE).
-- The body below is that exact source with ONE change: for TG_OP = 'INSERT' the order lookup is
-- SELECT ... FOR SHARE; for TG_OP = 'UPDATE' the original unlocked lookup is kept. Every validation,
-- exception message / SQLSTATE, transition rule, timestamp rule and RETURN is unchanged.
--
-- Not touched: tables, constraints, indexes, policies, grants, triggers, other functions, public.create_order,
-- public.create_order_with_parcel, last_actor handling, any data. CREATE OR REPLACE keeps OID, owner and
-- privileges, so trigger parcel_requests_before_write keeps calling this function (asserted below).
--
-- Lock impact: only on writes to public.parcel_requests (none today — the application does not write parcels yet).
-- FOR SHARE requires UPDATE privilege on public.orders for the acting role (service_role: proven by the working
-- kitchen status route; postgres: owner).
--
-- Source fingerprints (md5(prosrc), length(prosrc)):
--   BEFORE (live Production):     caecf3a8dfcf97889ba246d77add0fac / 4862   (CRLF — the only accepted value)
--   AFTER  (parcel_01b), CRLF:    9da7eec21b14950cfcbe4481ecbddf40 / 5560   (expected: same SQL channel as before)
--   AFTER  (parcel_01b), LF:      bf1d4abc4698dd2213023df069b75255 / 5397   (if the channel sends LF unchanged)

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ─── Preflight: the live function must be exactly the verified Production version ─────────────────────
DO $parcel_01b_preflight$
DECLARE
  v_count  integer;
  v_oid    oid;
  v_result text;
  v_lang   text;
  v_secdef boolean;
  v_cfg    text[];
  v_md5    text;
  v_len    integer;
BEGIN
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'parcel_requests_before_write';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'parcel_01b_preflight: expected exactly one public.parcel_requests_before_write, found %', v_count;
  END IF;

  SELECT p.oid, pg_get_function_result(p.oid), l.lanname, p.prosecdef, p.proconfig, md5(p.prosrc), length(p.prosrc)
    INTO v_oid, v_result, v_lang, v_secdef, v_cfg, v_md5, v_len
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_language l ON l.oid = p.prolang
   WHERE n.nspname = 'public' AND p.proname = 'parcel_requests_before_write';

  IF pg_get_function_identity_arguments(v_oid) <> '' OR v_result <> 'trigger' OR v_lang <> 'plpgsql' THEN
    RAISE EXCEPTION 'parcel_01b_preflight: unexpected signature / language (args=%, result=%, lang=%)',
      pg_get_function_identity_arguments(v_oid), v_result, v_lang;
  END IF;
  IF v_secdef THEN
    RAISE EXCEPTION 'parcel_01b_preflight: function is SECURITY DEFINER (expected INVOKER)';
  END IF;
  IF v_cfg IS DISTINCT FROM ARRAY['search_path=""'] THEN
    RAISE EXCEPTION 'parcel_01b_preflight: unexpected function configuration %', v_cfg;
  END IF;
  IF NOT ((v_md5 = 'caecf3a8dfcf97889ba246d77add0fac' AND v_len = 4862)) THEN
    RAISE EXCEPTION 'parcel_01b_preflight: live source is not the verified Production version - already applied or changed; re-review required (md5 %, length %)', v_md5, v_len;
  END IF;

  -- The existing trigger must keep calling this exact function, enabled, as BEFORE INSERT OR UPDATE ... FOR EACH ROW.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = to_regclass('public.parcel_requests')
       AND t.tgname = 'parcel_requests_before_write'
       AND NOT t.tgisinternal
       AND t.tgfoid = v_oid
       AND t.tgenabled <> 'D'
       AND pg_get_triggerdef(t.oid) ILIKE '%BEFORE INSERT OR UPDATE ON public.parcel_requests FOR EACH ROW%'
  ) THEN
    RAISE EXCEPTION 'parcel_01b_preflight: trigger parcel_requests_before_write is missing, disabled or not wired to this function';
  END IF;

  -- EXECUTE must not be granted to PUBLIC / anon / authenticated.
  IF EXISTS (
    SELECT 1
      FROM pg_proc p, LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) AS a
     WHERE p.oid = v_oid AND a.privilege_type = 'EXECUTE'
       AND (a.grantee = 0 OR a.grantee IN (SELECT r.oid FROM pg_roles r WHERE r.rolname IN ('anon', 'authenticated')))
  ) THEN
    RAISE EXCEPTION 'parcel_01b_preflight: EXECUTE is granted to PUBLIC / anon / authenticated';
  END IF;
END
$parcel_01b_preflight$;

-- ─── Replacement ──────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.parcel_requests_before_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_order_type   text;
  v_order_status text;
  v_order_branch uuid;
  v_search       boolean;
BEGIN
  -- parcel_01b (GATE 03G S1): INSERT locks the order row FOR SHARE, so a concurrent acceptance / cancellation
  -- (which holds the order row lock) either finishes first - and the status re-read below rejects the insert - or
  -- waits until this insert commits. UPDATE stays deliberately unlocked: locking public.orders while the parcel
  -- row is already locked could deadlock with the planned parcel_03 acceptance gate (order lock -> parcel FOR SHARE).
  IF TG_OP = 'INSERT' THEN
    SELECT o.type, o.status, o.branch_id
      INTO v_order_type, v_order_status, v_order_branch
      FROM public.orders AS o
     WHERE o.id = NEW.order_id
       FOR SHARE;
  ELSE
    SELECT o.type, o.status, o.branch_id
      INTO v_order_type, v_order_status, v_order_branch
      FROM public.orders AS o
     WHERE o.id = NEW.order_id;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'parcel_order_not_found' USING ERRCODE = '23503';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF v_order_type IS DISTINCT FROM 'delivery' THEN
      RAISE EXCEPTION 'parcel_requires_delivery_order' USING ERRCODE = '22023';
    END IF;

    IF v_order_status IS DISTINCT FROM 'received' THEN
      RAISE EXCEPTION 'parcel_order_not_received' USING ERRCODE = '22023';
    END IF;

    IF v_order_branch IS NULL THEN
      RAISE EXCEPTION 'parcel_order_without_branch' USING ERRCODE = '22023';
    END IF;

    IF NEW.status IS DISTINCT FROM 'awaiting_search'
       OR NEW.close_reason IS NOT NULL THEN
      RAISE EXCEPTION 'parcel_invalid_initial_state' USING ERRCODE = '22023';
    END IF;

    NEW.branch_id            := v_order_branch;
    NEW.created_at           := now();
    NEW.updated_at           := now();
    NEW.found_at             := NULL;
    NEW.not_found_at         := NULL;
    NEW.handed_to_courier_at := NULL;
    NEW.carrier_verified_at  := NULL;
    NEW.closed_at            := NULL;

    RETURN NEW;
  END IF;

  -- Immutable identity / tracking columns
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.branch_id IS DISTINCT FROM OLD.branch_id
     OR NEW.tracking_ref IS DISTINCT FROM OLD.tracking_ref
     OR NEW.carrier IS DISTINCT FROM OLD.carrier
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'parcel_immutable_column' USING ERRCODE = '22023';
  END IF;

  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'parcel_no_status_change' USING ERRCODE = '22023';
  END IF;

  -- FIX: Explicit allowed transitions instead of IF NOT CASE
  IF NOT (
       (OLD.status = 'awaiting_search'
        AND NEW.status IN ('found', 'not_found', 'cancelled'))

    OR (OLD.status = 'not_found'
        AND NEW.status IN ('found', 'cancelled'))

    OR (OLD.status = 'found'
        AND NEW.status IN ('awaiting_search', 'handed_to_courier', 'cancelled'))

    OR (OLD.status = 'handed_to_courier'
        AND NEW.status IN (
          'carrier_verified', 'delivery_problem', 'returned_to_store'
        ))

    OR (OLD.status = 'delivery_problem'
        AND NEW.status IN ('carrier_verified', 'returned_to_store'))
  ) THEN
    RAISE EXCEPTION 'parcel_invalid_transition' USING ERRCODE = '22023';
  END IF;

  -- Order-state conditions
  v_search := NEW.status IN ('found', 'not_found', 'awaiting_search');

  IF v_search AND v_order_status IS DISTINCT FROM 'received' THEN
    RAISE EXCEPTION 'parcel_search_requires_received_order' USING ERRCODE = '22023';
  END IF;

  IF NEW.status = 'handed_to_courier'
     AND NOT coalesce(
       v_order_status IN ('confirmed', 'preparing', 'ready', 'delivered'), false
     ) THEN
    RAISE EXCEPTION 'parcel_handoff_requires_accepted_order' USING ERRCODE = '22023';
  END IF;

  IF NEW.status = 'cancelled' THEN
    IF NEW.close_reason IS NULL THEN
      RAISE EXCEPTION 'parcel_cancel_requires_reason' USING ERRCODE = '22023';
    END IF;

    IF NEW.close_reason = 'order_cancelled'
       AND v_order_status IS DISTINCT FROM 'cancelled' THEN
      RAISE EXCEPTION 'parcel_order_not_cancelled' USING ERRCODE = '22023';
    END IF;

    IF NEW.close_reason = 'food_only'
       AND (
         OLD.status IS DISTINCT FROM 'not_found'
         OR v_order_status IS DISTINCT FROM 'received'
       ) THEN
      RAISE EXCEPTION 'parcel_food_only_requires_not_found' USING ERRCODE = '22023';
    END IF;

    IF NEW.close_reason IN ('customer_request', 'duplicate', 'other')
       AND v_order_status IS DISTINCT FROM 'received' THEN
      RAISE EXCEPTION 'parcel_cancel_requires_received_order' USING ERRCODE = '22023';
    END IF;

  ELSIF NEW.close_reason IS NOT NULL THEN
    RAISE EXCEPTION 'parcel_close_reason_without_cancel' USING ERRCODE = '22023';
  END IF;

  -- Operational timestamps
  NEW.updated_at := now();

  IF NEW.status = 'found' THEN
    NEW.found_at := now();

  ELSIF NEW.status = 'not_found' THEN
    NEW.not_found_at := now();

  ELSIF NEW.status = 'awaiting_search' THEN
    NEW.found_at := NULL;

  ELSIF NEW.status = 'handed_to_courier' THEN
    NEW.handed_to_courier_at := now();

  ELSIF NEW.status = 'carrier_verified' THEN
    NEW.carrier_verified_at := now();
  END IF;

  IF NEW.status IN (
    'carrier_verified', 'returned_to_store', 'cancelled'
  ) THEN
    NEW.closed_at := now();
  END IF;

  RETURN NEW;
END
$fn$;

-- ─── Post-check (same transaction): new source installed, identity / config / trigger / ACL intact ─────
DO $parcel_01b_postcheck$
DECLARE
  v_count  integer;
  v_oid    oid;
  v_result text;
  v_lang   text;
  v_secdef boolean;
  v_cfg    text[];
  v_md5    text;
  v_len    integer;
BEGIN
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'parcel_requests_before_write';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'parcel_01b_postcheck: expected exactly one public.parcel_requests_before_write, found %', v_count;
  END IF;

  SELECT p.oid, pg_get_function_result(p.oid), l.lanname, p.prosecdef, p.proconfig, md5(p.prosrc), length(p.prosrc)
    INTO v_oid, v_result, v_lang, v_secdef, v_cfg, v_md5, v_len
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_language l ON l.oid = p.prolang
   WHERE n.nspname = 'public' AND p.proname = 'parcel_requests_before_write';

  IF pg_get_function_identity_arguments(v_oid) <> '' OR v_result <> 'trigger' OR v_lang <> 'plpgsql' THEN
    RAISE EXCEPTION 'parcel_01b_postcheck: unexpected signature / language (args=%, result=%, lang=%)',
      pg_get_function_identity_arguments(v_oid), v_result, v_lang;
  END IF;
  IF v_secdef THEN
    RAISE EXCEPTION 'parcel_01b_postcheck: function is SECURITY DEFINER (expected INVOKER)';
  END IF;
  IF v_cfg IS DISTINCT FROM ARRAY['search_path=""'] THEN
    RAISE EXCEPTION 'parcel_01b_postcheck: unexpected function configuration %', v_cfg;
  END IF;
  IF NOT ((v_md5 = '9da7eec21b14950cfcbe4481ecbddf40' AND v_len = 5560)
          OR (v_md5 = 'bf1d4abc4698dd2213023df069b75255' AND v_len = 5397)) THEN
    RAISE EXCEPTION 'parcel_01b_postcheck: replacement source does not match the reviewed parcel_01b version (md5 %, length %)', v_md5, v_len;
  END IF;

  -- The existing trigger must keep calling this exact function, enabled, as BEFORE INSERT OR UPDATE ... FOR EACH ROW.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = to_regclass('public.parcel_requests')
       AND t.tgname = 'parcel_requests_before_write'
       AND NOT t.tgisinternal
       AND t.tgfoid = v_oid
       AND t.tgenabled <> 'D'
       AND pg_get_triggerdef(t.oid) ILIKE '%BEFORE INSERT OR UPDATE ON public.parcel_requests FOR EACH ROW%'
  ) THEN
    RAISE EXCEPTION 'parcel_01b_postcheck: trigger parcel_requests_before_write is missing, disabled or not wired to this function';
  END IF;

  -- EXECUTE must not be granted to PUBLIC / anon / authenticated.
  IF EXISTS (
    SELECT 1
      FROM pg_proc p, LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) AS a
     WHERE p.oid = v_oid AND a.privilege_type = 'EXECUTE'
       AND (a.grantee = 0 OR a.grantee IN (SELECT r.oid FROM pg_roles r WHERE r.rolname IN ('anon', 'authenticated')))
  ) THEN
    RAISE EXCEPTION 'parcel_01b_postcheck: EXECUTE is granted to PUBLIC / anon / authenticated';
  END IF;
END
$parcel_01b_postcheck$;

COMMIT;
