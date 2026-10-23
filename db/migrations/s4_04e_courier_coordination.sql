-- FALAFEL BATACHANA — MAALE EXPRESS — s4_04e_courier_coordination.sql (S4-INTEGRATIONS-04E1, hardened in 04E2)
-- ATOMIC COURIER COORDINATION between (A) a Maale Express dispatch claim and (B) a manually booked courier record.
--
-- REVIEW ONLY — NOT EXECUTED. Separate Production approval required. Run manually in the Supabase SQL editor as postgres.
-- REQUIRES (installed + verified first): s4_04b_maale_quote_rate_limit.sql, s4_04d_maale_dispatch_reconciliations.sql.
-- Read-only checks: s4_04e_production_preflight.sql (before), s4_04e_verify.sql + s4_04_combined_verify.sql (after).
-- Emergency rollback (separate approval): s4_04e_rollback.sql.
--
-- ORDER: install together with the application change that calls these functions (S4-04E2). After this migration a
-- direct ledger write and a direct UPDATE of a pending dispatch row by service_role are REFUSED (fail closed).
--
-- AUTHORIZATION BOUNDARY (04E2): a dedicated NOLOGIN role public.maale_dispatch_coordinator owns both functions
-- (SECURITY DEFINER) and alone holds the writes the protocol needs. The guard trigger accepts a transition OUT OF
-- 'pending' only when current_user = maale_dispatch_coordinator — i.e. only inside claim_maale_dispatch. service_role can
-- EXECUTE the functions but is not a member of the role and cannot SET ROLE to it, so it cannot forge that identity.
-- (04E1 used a writable transaction setting as the marker; that is NOT an authorization boundary and was removed.)
--
-- PROTOCOL (both operations, same lock):
--   pg_advisory_xact_lock(1296122189, hashtext(order_id::text)) — transaction-scoped, released at COMMIT / ROLLBACK.
--   Each function is ONE short PostgREST transaction; no lock or transaction is held across the provider HTTP call: the
--   committed 'sending' state is what coordinates with later manual records.
--   Linearization points: claim → its UPDATE to 'sending' (commit); manual courier → its INSERT (commit).
--
-- Adds:
--   0. ROLE maale_dispatch_coordinator NOLOGIN NOINHERIT BYPASSRLS (no other attribute, member of nothing). Grants:
--      COLUMN-level only (04E3): delivery_dispatches SELECT (6 claim / consistency columns) + UPDATE (5 claim columns);
--      ledger SELECT + INSERT (7 payload columns); orders SELECT (id). BYPASSRLS is needed because these three tables
--      have RLS on and NO policies (04D verifies "no policies"); its reach is limited to what the role is granted.
--      USAGE on schema public (CREATE only transiently, for the ownership transfer; revoked before COMMIT).
--   1. public.claim_maale_dispatch(uuid, integer, timestamptz) → text                     DEFINER (coordinator)
--   2. public.record_maale_reconciliation_event(uuid, uuid, text, text, text, text, text)
--        → TABLE(result text, event_id uuid, event_created_at timestamptz)                 DEFINER (coordinator)
--   3. public.delivery_dispatches_coordination_guard() + BEFORE INSERT OR UPDATE trigger: new rows pending / 0 only;
--      a 'sent' row is immutable; leaving 'pending' only as the coordinator.
--   4. REVOKE INSERT ON public.maale_dispatch_reconciliations FROM service_role.
-- NOT changed: any table definition, constraint, existing row (incl. sent dispatches), the 04B limiter, orders,
-- service_role's privileges on delivery_dispatches (markSent / markFailed keep working: sending → sent / failed_*).

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ─── Preflight (read-only assertions; abort on any surprise) ──────────────────────────────────────────────────────
DO $s4_04e_preflight$
DECLARE
  v_me text := current_user;
BEGIN
  -- 04F2: PostgreSQL >= 16 is REQUIRED (GRANT … WITH INHERIT / SET options and the PG16 role-membership rules the
  -- ownership transfer relies on). Checked first, before anything is created. The PG16-only GRANT below is dynamic SQL
  -- (a string), so an older server parses this whole script and stops HERE with this clear message.
  IF pg_catalog.current_setting('server_version_num')::integer < 160000 THEN
    RAISE EXCEPTION 's4_04e_preflight: PostgreSQL 16 or newer is required (this server: %) — nothing was installed',
      pg_catalog.current_setting('server_version');
  END IF;
  IF to_regclass('public.maale_dispatch_requests') IS NULL
     OR to_regprocedure('public.consume_maale_quote_slot(uuid, uuid, text)') IS NULL THEN
    RAISE EXCEPTION 's4_04e_preflight: S4-04B (quote rate limit) is not installed';
  END IF;
  -- (two separate checks: a ::regclass cast would be resolved at plan time and error before the OR could short-circuit)
  IF to_regclass('public.maale_dispatch_reconciliations') IS NULL THEN
    RAISE EXCEPTION 's4_04e_preflight: S4-04D (reconciliation ledger with request_id) is not installed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.maale_dispatch_reconciliations')
                  AND conname = 'maale_dispatch_reconciliations_request_id_key' AND contype = 'u') THEN
    RAISE EXCEPTION 's4_04e_preflight: S4-04D (reconciliation ledger with request_id) is not installed';
  END IF;
  IF to_regclass('public.delivery_dispatches') IS NULL OR to_regclass('public.orders') IS NULL THEN
    RAISE EXCEPTION 's4_04e_preflight: public.delivery_dispatches / public.orders missing';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'delivery_dispatches'
       AND column_name IN ('order_id', 'status', 'attempts', 'last_attempt_at', 'error_code', 'provider_order_id', 'updated_at')) <> 7 THEN
    RAISE EXCEPTION 's4_04e_preflight: delivery_dispatches columns differ from the reviewed baseline';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.delivery_dispatches'::regclass AND contype = 'u'
                  AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'public.delivery_dispatches'::regclass AND attname = 'order_id')]::int2[]) THEN
    RAISE EXCEPTION 's4_04e_preflight: delivery_dispatches.order_id is not UNIQUE';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
              AND p.proname IN ('claim_maale_dispatch', 'record_maale_reconciliation_event', 'delivery_dispatches_coordination_guard'))
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.delivery_dispatches'::regclass AND tgname = 'delivery_dispatches_coordination_guard')
     OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'maale_dispatch_coordinator') THEN
    RAISE EXCEPTION 's4_04e_preflight: S4-04E objects already exist (no silent re-apply)';
  END IF;
  -- Creating a BYPASSRLS role needs CREATEROLE + (superuser or BYPASSRLS) on the installing role (Supabase postgres has both).
  IF NOT (SELECT (rolsuper OR rolcreaterole) AND (rolsuper OR rolbypassrls) FROM pg_roles WHERE rolname = v_me) THEN
    RAISE EXCEPTION 's4_04e_preflight: role % cannot create the BYPASSRLS coordinator role', v_me;
  END IF;
  IF NOT has_table_privilege('service_role', 'public.delivery_dispatches', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.delivery_dispatches', 'UPDATE')
     OR NOT has_table_privilege('service_role', 'public.maale_dispatch_reconciliations', 'SELECT') THEN
    RAISE EXCEPTION 's4_04e_preflight: service_role lacks SELECT/UPDATE on delivery_dispatches or SELECT on the ledger';
  END IF;
END
$s4_04e_preflight$;

-- ─── 0. Dedicated coordinator role (the only identity allowed to leave 'pending' / write the ledger) ──────────────────
CREATE ROLE maale_dispatch_coordinator NOLOGIN NOINHERIT BYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
-- The installing role needs SET on the new role to transfer function ownership to it (PostgreSQL 16+ rule).
-- Named via format(%I) on purpose: the literal role spec `TO CURRENT_USER` crashes the Supabase Postgres 17.6.1.141
-- image (backend SIGSEGV, reproduced in the isolated test container) — the dynamic form is equivalent and safe.
DO $s4_04e_installer_grant$
BEGIN
  EXECUTE format('GRANT maale_dispatch_coordinator TO %I WITH INHERIT FALSE, SET TRUE', current_user);
END
$s4_04e_installer_grant$;
-- 04E3 least privilege: COLUMN-level grants — exactly the columns the two function bodies read / write.
-- (orders: only id, no customer data; dispatches: the claim columns only; ledger: SELECT for the idempotency row
-- comparison, INSERT of the 7 payload columns only — id / created_at always come from their defaults.)
GRANT SELECT (order_id, status, attempts, last_attempt_at, error_code, provider_order_id),
      UPDATE (status, attempts, last_attempt_at, error_code, updated_at) ON public.delivery_dispatches TO maale_dispatch_coordinator;
GRANT SELECT ON public.maale_dispatch_reconciliations TO maale_dispatch_coordinator;
GRANT INSERT (request_id, order_id, event_type, actor_username, provider_order_id, provider_status, reason_code)
  ON public.maale_dispatch_reconciliations TO maale_dispatch_coordinator;
GRANT SELECT (id) ON public.orders TO maale_dispatch_coordinator;
-- USAGE: the DEFINER functions resolve public.* as the coordinator. CREATE: required ONLY while ownership is transferred
-- (PostgreSQL checks the new owner's CREATE on the schema at ALTER … OWNER); revoked again in section 4 below.
GRANT USAGE ON SCHEMA public TO maale_dispatch_coordinator;
GRANT CREATE ON SCHEMA public TO maale_dispatch_coordinator;

-- ─── 1. Coordination guard on delivery_dispatches ──────────────────────────────────────────────────────────────────
CREATE FUNCTION public.delivery_dispatches_coordination_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $delivery_dispatches_coordination_guard$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- insertPending only ever creates a never-attempted row; nothing may be inserted already claimed / sent.
    IF NEW.status IS DISTINCT FROM 'pending' OR NEW.attempts IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION 'delivery_dispatches_guard: new dispatch rows must be pending with 0 attempts';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'sent' THEN
    RAISE EXCEPTION 'delivery_dispatches_guard: a sent dispatch is immutable';
  END IF;
  -- Leaving 'pending' (the claim) or entering 'sending' is allowed only for the coordinator identity, i.e. inside
  -- claim_maale_dispatch (SECURITY DEFINER). current_user cannot be forged by service_role (not a member of the role).
  IF ((OLD.status = 'pending' AND NEW.status IS DISTINCT FROM 'pending')
      OR (NEW.status = 'sending' AND OLD.status IS DISTINCT FROM 'sending'))
     AND current_user IS DISTINCT FROM 'maale_dispatch_coordinator' THEN
    RAISE EXCEPTION 'delivery_dispatches_guard: a claim must go through public.claim_maale_dispatch';
  END IF;
  RETURN NEW;
END
$delivery_dispatches_coordination_guard$;

REVOKE ALL ON FUNCTION public.delivery_dispatches_coordination_guard() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER delivery_dispatches_coordination_guard
  BEFORE INSERT OR UPDATE ON public.delivery_dispatches
  FOR EACH ROW EXECUTE FUNCTION public.delivery_dispatches_coordination_guard();

-- ─── 2. Atomic dispatch claim ──────────────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION public.claim_maale_dispatch(p_order_id uuid, p_seen_attempts integer, p_seen_last_attempt_at timestamptz)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '3s'
AS $claim_maale_dispatch$
DECLARE
  v_status   text;
  v_attempts integer;
  v_last     timestamptz;
  v_opened   integer;
  v_resolved integer;
  v_rows     integer;
BEGIN
  IF p_order_id IS NULL OR p_seen_attempts IS NULL THEN
    RETURN 'invalid_request';
  END IF;

  -- Same lock as record_maale_reconciliation_event: the checks below and the UPDATE are one atomic decision.
  PERFORM pg_catalog.pg_advisory_xact_lock(1296122189, pg_catalog.hashtext(p_order_id::text));

  -- A manually booked courier (ever) or an open manual review forbids a new claim. Nothing later ever lifts it.
  IF EXISTS (SELECT 1 FROM public.maale_dispatch_reconciliations AS r WHERE r.order_id = p_order_id AND r.event_type = 'manual_courier') THEN
    RETURN 'manual_courier_recorded';
  END IF;
  SELECT pg_catalog.count(*) FILTER (WHERE r.event_type = 'manual_review_opened'),
         pg_catalog.count(*) FILTER (WHERE r.event_type = 'manual_review_resolved')
    INTO v_opened, v_resolved
    FROM public.maale_dispatch_reconciliations AS r WHERE r.order_id = p_order_id;
  IF v_opened > v_resolved THEN
    RETURN 'manual_review_open';
  END IF;

  SELECT d.status, d.attempts, d.last_attempt_at INTO v_status, v_attempts, v_last
    FROM public.delivery_dispatches AS d WHERE d.order_id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'dispatch_row_missing';
  END IF;
  -- Only a never-attempted pending row may be claimed (pending with historical attempts, sending, sent, failed_* and
  -- any unknown status are refused — fail closed; nothing is ever re-claimed or retried here).
  IF v_status IS DISTINCT FROM 'pending' OR v_attempts IS DISTINCT FROM 0 OR v_last IS NOT NULL THEN
    RETURN 'not_claimable';
  END IF;
  -- Compare-and-set on what the caller saw (unchanged 03F semantics).
  IF p_seen_attempts IS DISTINCT FROM v_attempts OR p_seen_last_attempt_at IS DISTINCT FROM v_last THEN
    RETURN 'claim_lost';
  END IF;

  UPDATE public.delivery_dispatches AS d
     SET status = 'sending', attempts = d.attempts + 1, last_attempt_at = pg_catalog.clock_timestamp(),
         error_code = NULL, updated_at = pg_catalog.clock_timestamp()
   WHERE d.order_id = p_order_id AND d.status = 'pending' AND d.attempts = p_seen_attempts
     AND d.last_attempt_at IS NOT DISTINCT FROM p_seen_last_attempt_at;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN CASE WHEN v_rows = 1 THEN 'claimed' ELSE 'claim_lost' END;
END
$claim_maale_dispatch$;

REVOKE ALL ON FUNCTION public.claim_maale_dispatch(uuid, integer, timestamptz) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_maale_dispatch(uuid, integer, timestamptz) TO service_role;
-- ownership last: the installer loses control of the ACL once the coordinator owns it (grantor is rewritten).
ALTER FUNCTION public.claim_maale_dispatch(uuid, integer, timestamptz) OWNER TO maale_dispatch_coordinator;

-- ─── 3. Atomic reconciliation record ───────────────────────────────────────────────────────────────────────────────
-- SECURITY DEFINER (owner: the coordinator) so service_role loses its direct INSERT on the ledger: EVERY record goes
-- through this lock + validation. It writes only one validated ledger row, reads only orders / delivery_dispatches /
-- the ledger, has no dynamic SQL, fully qualified names, search_path '' and EXECUTE for service_role only.
CREATE FUNCTION public.record_maale_reconciliation_event(
  p_request_id uuid, p_order_id uuid, p_event_type text, p_actor text,
  p_provider_order_id text, p_provider_status text, p_reason_code text)
RETURNS TABLE (result text, event_id uuid, event_created_at timestamptz)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '3s'
AS $record_maale_reconciliation_event$
DECLARE
  v_existing     public.maale_dispatch_reconciliations%ROWTYPE;
  v_has_dispatch boolean;
  v_status       text;
  v_attempts     integer;
  v_error        text;
  v_stored_pid   text;
  v_id           uuid;
  v_at           timestamptz;
BEGIN
  -- Input (same rules as the 04D CHECK constraints + the application: status_checked needs a status).
  IF p_request_id IS NULL OR p_order_id IS NULL OR p_actor IS NULL OR p_actor !~ '^[a-z0-9_-]{2,32}$'
     OR p_event_type IS NULL OR p_event_type NOT IN ('confirmed_sent', 'cancelled_at_provider', 'not_received', 'manual_courier',
                                                     'provider_status_checked', 'manual_review_opened', 'manual_review_resolved')
     OR (p_provider_order_id IS NOT NULL AND p_provider_order_id !~ '^[A-Za-z0-9_-]{1,100}$')
     OR (p_provider_status IS NOT NULL AND p_provider_status !~ '^[a-z_]{1,40}$')
     OR (p_reason_code IS NOT NULL AND p_reason_code NOT IN ('provider_phone_confirmed', 'provider_dashboard_confirmed', 'customer_cancelled',
           'kitchen_cancelled', 'outcome_unknown', 'persistence_failed', 'duplicate_suspected', 'courier_booked_by_phone', 'other'))
     OR (p_event_type IN ('confirmed_sent', 'cancelled_at_provider') AND p_provider_order_id IS NULL)
     OR (p_event_type IN ('not_received', 'manual_courier') AND p_provider_order_id IS NOT NULL)
     OR (p_event_type = 'provider_status_checked' AND p_provider_status IS NULL)
     OR (p_event_type <> 'provider_status_checked' AND p_provider_status IS NOT NULL) THEN
    RETURN QUERY SELECT 'invalid_request'::text, NULL::uuid, NULL::timestamptz; RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.orders AS o WHERE o.id = p_order_id) THEN
    RETURN QUERY SELECT 'order_not_found'::text, NULL::uuid, NULL::timestamptz; RETURN;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(1296122189, pg_catalog.hashtext(p_order_id::text));

  -- Idempotency under the lock: same request_id + identical payload → the original row; anything else → refused.
  SELECT r.* INTO v_existing FROM public.maale_dispatch_reconciliations AS r WHERE r.request_id = p_request_id;
  IF FOUND THEN
    IF v_existing.order_id = p_order_id AND v_existing.event_type = p_event_type AND v_existing.actor_username = p_actor
       AND v_existing.provider_order_id IS NOT DISTINCT FROM p_provider_order_id
       AND v_existing.provider_status IS NOT DISTINCT FROM p_provider_status
       AND v_existing.reason_code IS NOT DISTINCT FROM p_reason_code THEN
      RETURN QUERY SELECT 'already_recorded'::text, v_existing.id, v_existing.created_at; RETURN;
    END IF;
    RETURN QUERY SELECT 'request_id_conflict'::text, NULL::uuid, NULL::timestamptz; RETURN;
  END IF;

  -- Consistency with the dispatch record, read under the same lock.
  SELECT d.status, d.attempts, d.error_code, d.provider_order_id INTO v_status, v_attempts, v_error, v_stored_pid
    FROM public.delivery_dispatches AS d WHERE d.order_id = p_order_id;
  v_has_dispatch := FOUND;
  IF p_event_type IN ('confirmed_sent', 'cancelled_at_provider', 'not_received', 'provider_status_checked') OR p_provider_order_id IS NOT NULL THEN
    IF NOT v_has_dispatch THEN
      RETURN QUERY SELECT 'no_dispatch_record'::text, NULL::uuid, NULL::timestamptz; RETURN;
    END IF;
    IF v_status = 'pending' THEN
      RETURN QUERY SELECT 'no_dispatch_attempt'::text, NULL::uuid, NULL::timestamptz; RETURN;
    END IF;
  END IF;
  IF p_provider_order_id IS NOT NULL AND v_stored_pid IS NOT NULL AND v_stored_pid <> p_provider_order_id THEN
    RETURN QUERY SELECT 'provider_order_mismatch'::text, NULL::uuid, NULL::timestamptz; RETURN;
  END IF;
  -- An ordinary manual courier is refused while an in-app courier exists or MAY exist (fail closed). Allowed only with
  -- no dispatch row, a never-attempted pending row, or a definitive provider rejection.
  IF p_event_type = 'manual_courier' AND v_has_dispatch THEN
    IF v_status IN ('sending', 'sent') THEN
      RETURN QUERY SELECT 'dispatch_active'::text, NULL::uuid, NULL::timestamptz; RETURN;
    END IF;
    IF NOT ((v_status = 'pending' AND v_attempts = 0)
            OR (v_status = 'failed_final' AND v_error IN ('zone_unknown', 'out_of_area', 'amount_too_high', 'dispatch_closed',
                                                          'validation_error', 'provider_rejected', 'blocked', 'unauthorized'))) THEN
      RETURN QUERY SELECT 'dispatch_outcome_unknown'::text, NULL::uuid, NULL::timestamptz; RETURN;
    END IF;
  END IF;

  BEGIN
    INSERT INTO public.maale_dispatch_reconciliations
      (request_id, order_id, event_type, actor_username, provider_order_id, provider_status, reason_code)
    VALUES (p_request_id, p_order_id, p_event_type, p_actor, p_provider_order_id, p_provider_status, p_reason_code)
    RETURNING public.maale_dispatch_reconciliations.id, public.maale_dispatch_reconciliations.created_at INTO v_id, v_at;
  EXCEPTION WHEN unique_violation THEN
    -- The same request_id was stored concurrently for ANOTHER order (a different lock key): never merged → refused.
    RETURN QUERY SELECT 'request_id_conflict'::text, NULL::uuid, NULL::timestamptz; RETURN;
  END;
  RETURN QUERY SELECT 'recorded'::text, v_id, v_at;
END
$record_maale_reconciliation_event$;

REVOKE ALL ON FUNCTION public.record_maale_reconciliation_event(uuid, uuid, text, text, text, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_maale_reconciliation_event(uuid, uuid, text, text, text, text, text) TO service_role;
-- ownership last: the installer loses control of the ACL once the coordinator owns it (grantor is rewritten).
ALTER FUNCTION public.record_maale_reconciliation_event(uuid, uuid, text, text, text, text, text) OWNER TO maale_dispatch_coordinator;

-- ─── 4. Ledger writes only through the coordination function ─────────────────────────────────────────────────────
REVOKE INSERT ON public.maale_dispatch_reconciliations FROM service_role;
REVOKE CREATE ON SCHEMA public FROM maale_dispatch_coordinator;  -- only needed for the two ALTER … OWNER above

-- ─── Post-check (same transaction; any mismatch rolls everything back) ────────────────────────────────────────────
DO $s4_04e_postcheck$
DECLARE
  v_claim  oid := 'public.claim_maale_dispatch(uuid, integer, timestamptz)'::regprocedure;
  v_record oid := 'public.record_maale_reconciliation_event(uuid, uuid, text, text, text, text, text)'::regprocedure;
BEGIN
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_claim) OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_record)
     OR (SELECT proowner::regrole::text FROM pg_proc WHERE oid = v_claim) IS DISTINCT FROM 'maale_dispatch_coordinator'
     OR (SELECT proowner::regrole::text FROM pg_proc WHERE oid = v_record) IS DISTINCT FROM 'maale_dispatch_coordinator' THEN
    RAISE EXCEPTION 's4_04e_postcheck: both functions must be SECURITY DEFINER owned by maale_dispatch_coordinator';
  END IF;
  IF (SELECT proconfig FROM pg_proc WHERE oid = v_claim) IS DISTINCT FROM ARRAY['search_path=""', 'lock_timeout=3s']
     OR (SELECT proconfig FROM pg_proc WHERE oid = v_record) IS DISTINCT FROM ARRAY['search_path=""', 'lock_timeout=3s'] THEN
    RAISE EXCEPTION 's4_04e_postcheck: unexpected function settings';
  END IF;
  IF NOT has_function_privilege('service_role', v_claim, 'EXECUTE') OR NOT has_function_privilege('service_role', v_record, 'EXECUTE')
     OR has_function_privilege('anon', v_claim, 'EXECUTE') OR has_function_privilege('authenticated', v_claim, 'EXECUTE')
     OR has_function_privilege('anon', v_record, 'EXECUTE') OR has_function_privilege('authenticated', v_record, 'EXECUTE') THEN
    RAISE EXCEPTION 's4_04e_postcheck: unexpected EXECUTE privileges';
  END IF;
  IF has_any_column_privilege('service_role', 'public.maale_dispatch_reconciliations', 'INSERT')
     OR has_any_column_privilege('anon', 'public.maale_dispatch_reconciliations', 'INSERT')
     OR has_any_column_privilege('authenticated', 'public.maale_dispatch_reconciliations', 'INSERT')
     OR NOT has_table_privilege('service_role', 'public.maale_dispatch_reconciliations', 'SELECT') THEN
    RAISE EXCEPTION 's4_04e_postcheck: service_role must keep SELECT and no application role may write the ledger directly';
  END IF;
  IF has_table_privilege('maale_dispatch_coordinator', 'public.orders', 'SELECT')
     OR has_table_privilege('maale_dispatch_coordinator', 'public.delivery_dispatches', 'SELECT')
     OR has_table_privilege('maale_dispatch_coordinator', 'public.delivery_dispatches', 'UPDATE')
     OR has_table_privilege('maale_dispatch_coordinator', 'public.maale_dispatch_reconciliations', 'INSERT')
     OR NOT has_column_privilege('maale_dispatch_coordinator', 'public.orders', 'id', 'SELECT')
     OR has_column_privilege('maale_dispatch_coordinator', 'public.orders', 'phone', 'SELECT') THEN
    RAISE EXCEPTION 's4_04e_postcheck: the coordinator must hold column-level privileges only';
  END IF;
  -- authenticator = PostgREST's session user (it can SET ROLE to its own members only)
  IF pg_has_role('service_role', 'maale_dispatch_coordinator', 'MEMBER') OR pg_has_role('anon', 'maale_dispatch_coordinator', 'MEMBER')
     OR pg_has_role('authenticated', 'maale_dispatch_coordinator', 'MEMBER')
     OR EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member
                 WHERE m.roleid = 'maale_dispatch_coordinator'::regrole AND r.rolname IN ('authenticator', 'service_role', 'anon', 'authenticated')) THEN
    RAISE EXCEPTION 's4_04e_postcheck: an application role must not be a member of the coordinator role';
  END IF;
  IF has_schema_privilege('maale_dispatch_coordinator', 'public', 'CREATE') OR NOT has_schema_privilege('maale_dispatch_coordinator', 'public', 'USAGE') THEN
    RAISE EXCEPTION 's4_04e_postcheck: the coordinator must have USAGE and no CREATE on schema public';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.delivery_dispatches'::regclass
                  AND tgname = 'delivery_dispatches_coordination_guard' AND tgenabled = 'O') THEN
    RAISE EXCEPTION 's4_04e_postcheck: guard trigger missing or disabled';
  END IF;
END
$s4_04e_postcheck$;

COMMIT;
