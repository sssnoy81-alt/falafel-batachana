-- FALAFEL BATACHANA — HYP PAYMENTS — hyp05_payment_intents.sql (HYP-05, architecture HYP-03S)
-- PAYMENT INTENT LEDGER + ATOMIC, AUTHORIZED FINALIZATION OF ONLINE-PAID ORDERS.
--
-- REVIEW ONLY — NOT EXECUTED. Separate Production approval required. Run manually in the Supabase SQL editor as postgres.
-- Read-only checks: hyp05_production_preflight.sql (before), hyp05_verify.sql (after).
-- Emergency rollback (separate approval): hyp05_rollback.sql.
-- Isolated test: node scripts/pgtest-hyp05-payment-intents.mjs (Docker, --network none, real Production function bodies).
--
-- NOTHING CALLS THESE FUNCTIONS YET: the application (HYP-07) is not written; POST /api/orders, cash / credit / cibus /
-- bit, parcels, the kitchen and Maale Express are unchanged. Installing this alone has no customer-visible effect.
--
-- AUTHORIZATION BOUNDARY (HYP-03S): a dedicated NOLOGIN role hyp_payment_coordinator owns every payment function
-- (SECURITY DEFINER) and alone holds the writes the protocol needs. An online order (payment_method = 'online') can be
-- INSERTed only while current_user = hyp_payment_coordinator, i.e. only inside public.finalize_paid_intent, which reads
-- the immutable snapshot itself and links the created order to exactly one paid intent in the same transaction.
-- service_role can EXECUTE the functions but is not a member of the role and cannot SET ROLE to it.
-- The guard is an AFTER row trigger on purpose: service_role holds TRIGGER on public.orders (Production Q1), so it could
-- add a BEFORE trigger that runs after a BEFORE guard and rewrites the row; an AFTER trigger sees the final row.
-- No transaction-setting marker (set_config) and no xid marker is used: neither is an authorization boundary.
--
-- TRUST ROOT (documented residual, HYP-03S §5): the database cannot perform HYP's server-to-server VERIFY. Server code
-- holding service_role asserts the VERIFY outcome (record_hyp_verification). The payment fields (Id, CCode, Amount,
-- ACode, Order) are never taken from that caller: they are parsed here from the stored return query string. A forged
-- assertion is detectable only by the mandatory daily reconciliation against the HYP report.
--
-- Adds:
--   0. ROLE hyp_payment_coordinator NOLOGIN NOINHERIT BYPASSRLS (member of nothing). BYPASSRLS is REQUIRED: orders /
--      order_items / deliveries / parcel_requests have RLS on, and create_order's MAX(daily_number) + 1 must see every
--      row. Its reach is limited to COLUMN-level grants derived from the Production bodies of create_order (db92e75f…),
--      create_order_with_parcel (post-05) and the parcel triggers that fire on its INSERTs:
--        orders            SELECT (9 columns), INSERT (the 8 columns create_order writes), UPDATE (updated_at) — the
--                          UPDATE grant exists only because parcel_requests_before_write locks the order row FOR SHARE
--                          (PostgreSQL requires UPDATE on at least one column for row locks); no function updates orders.
--        orders_order_number_seq USAGE (column default nextval)
--        order_items / deliveries   INSERT (the columns create_order writes)
--        parcel_requests   INSERT (the 6 wrapper columns), SELECT (branch_id, tracking_key, status) for the pre-check
--        parcel_events     INSERT (the 5 columns parcel_requests_log_event writes)
--        create_order / create_order_with_parcel  EXECUTE (bodies, signatures, SECURITY INVOKER unchanged)
--   1. Tables payment_intents, payment_returns, payment_transactions, payment_reversals, payment_intent_events
--      (RLS on, no policies; service_role SELECT only; writes only through the functions; DELETE / TRUNCATE refused).
--   2. orders_payment_method_check extended with 'online'; AFTER guard triggers on public.orders (online rows only).
--   3. DEFINER functions (EXECUTE: service_role only): create_payment_intent, record_hyp_sign_result, record_hyp_return,
--      record_hyp_verification, finalize_paid_intent, sweep_expired_payment_intents, resolve_payment_intent.
-- NOT changed: the bodies of create_order / create_order_with_parcel / any existing trigger function, any existing row,
-- service_role's privileges on existing tables, RLS policies, parcel or courier behaviour.

BEGIN;

SET LOCAL lock_timeout = '5s';        -- the CHECK replacement briefly locks public.orders; never queue behind traffic
SET LOCAL statement_timeout = '60s';

-- ─── Preflight (read-only assertions; abort on any surprise) ──────────────────────────────────────────────────────
DO $hyp05_preflight$
DECLARE
  v_me text := current_user;
  v_co oid  := to_regprocedure('public.create_order(jsonb, jsonb, jsonb)');
  v_cp oid  := to_regprocedure('public.create_order_with_parcel(jsonb, jsonb, jsonb, jsonb)');
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer < 160000 THEN
    RAISE EXCEPTION 'hyp05_preflight: PostgreSQL 16 or newer is required (this server: %) — nothing was installed',
      pg_catalog.current_setting('server_version');
  END IF;
  -- First, so a repeated run reports the real reason (the CHECK below is already extended after an install).
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hyp_payment_coordinator')
     OR to_regclass('public.payment_intents') IS NOT NULL OR to_regclass('public.payment_returns') IS NOT NULL
     OR to_regclass('public.payment_transactions') IS NOT NULL OR to_regclass('public.payment_reversals') IS NOT NULL
     OR to_regclass('public.payment_intent_events') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
                 AND p.proname IN ('create_payment_intent', 'record_hyp_sign_result', 'record_hyp_return', 'record_hyp_verification',
                                   'finalize_paid_intent', 'sweep_expired_payment_intents', 'resolve_payment_intent',
                                   'orders_online_payment_guard', 'payment_intents_guard', 'payment_intents_audit',
                                   'payment_returns_guard', 'payment_append_only')) THEN
    RAISE EXCEPTION 'hyp05_preflight: HYP-05 objects already exist (no silent re-apply)';
  END IF;
  IF v_co IS NULL OR v_cp IS NULL THEN
    RAISE EXCEPTION 'hyp05_preflight: create_order / create_order_with_parcel missing';
  END IF;
  IF (SELECT md5(prosrc) || '/' || length(prosrc) FROM pg_proc WHERE oid = v_co) IS DISTINCT FROM 'db92e75f8bfdadb6d78be035da855996/6416' THEN
    RAISE EXCEPTION 'hyp05_preflight: create_order body differs from the reviewed Production body db92e75f… / 6416';
  END IF;
  IF (SELECT md5(prosrc) || '/' || length(prosrc) FROM pg_proc WHERE oid = v_cp)
       NOT IN ('6ceb72f6c80929adddd7a2b7bb1a0616/2771', 'afbe93d74b201d6bd898edd2b6e28a63/2656') THEN
    RAISE EXCEPTION 'hyp05_preflight: create_order_with_parcel is not the reviewed post-05 body';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid IN (v_co, v_cp) AND (prosecdef OR proconfig IS DISTINCT FROM ARRAY['search_path=""'])) THEN
    RAISE EXCEPTION 'hyp05_preflight: create_order / wrapper are not SECURITY INVOKER with search_path ''''';
  END IF;
  IF to_regclass('public.orders') IS NULL OR to_regclass('public.order_items') IS NULL OR to_regclass('public.deliveries') IS NULL
     OR to_regclass('public.parcel_requests') IS NULL OR to_regclass('public.parcel_events') IS NULL
     OR to_regclass('public.branches') IS NULL OR to_regclass('public.orders_order_number_seq') IS NULL THEN
    RAISE EXCEPTION 'hyp05_preflight: an order / parcel table or orders_order_number_seq is missing';
  END IF;
  IF (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
       WHERE c.conrelid = 'public.orders'::regclass AND c.conname = 'orders_payment_method_check')
     IS DISTINCT FROM 'CHECK ((payment_method = ANY (ARRAY[''cash''::text, ''credit''::text, ''cibus''::text, ''bit''::text])))' THEN
    RAISE EXCEPTION 'hyp05_preflight: orders_payment_method_check differs from the reviewed four-value definition';
  END IF;
  IF EXISTS (SELECT 1 FROM public.orders AS o WHERE o.payment_method = 'online') THEN
    RAISE EXCEPTION 'hyp05_preflight: orders with payment_method online already exist';
  END IF;
  IF NOT (SELECT (rolsuper OR rolcreaterole) AND (rolsuper OR rolbypassrls) FROM pg_roles WHERE rolname = v_me) THEN
    RAISE EXCEPTION 'hyp05_preflight: role % cannot create the BYPASSRLS coordinator role', v_me;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role' AND rolbypassrls)
     OR NOT has_function_privilege('service_role', v_co, 'EXECUTE')
     OR NOT has_table_privilege('service_role', 'public.orders', 'INSERT') THEN
    RAISE EXCEPTION 'hyp05_preflight: service_role is not the expected BYPASSRLS server role';
  END IF;
END
$hyp05_preflight$;

-- ─── 0. Dedicated coordinator role ─────────────────────────────────────────────────────────────────────────────────
CREATE ROLE hyp_payment_coordinator NOLOGIN NOINHERIT BYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
-- PostgreSQL 16+: the installer needs SET on the role to transfer ownership. Dynamic on purpose: the literal
-- `TO CURRENT_USER` crashes the Supabase Postgres 17.6.1.141 image (same workaround as S4-04E).
DO $hyp05_installer_grant$
BEGIN
  EXECUTE format('GRANT hyp_payment_coordinator TO %I WITH INHERIT FALSE, SET TRUE', current_user);
END
$hyp05_installer_grant$;
GRANT USAGE ON SCHEMA public TO hyp_payment_coordinator;
GRANT CREATE ON SCHEMA public TO hyp_payment_coordinator;   -- only for ALTER … OWNER below; revoked before COMMIT

-- Exactly what create_order / create_order_with_parcel / the parcel triggers need when they run as the coordinator.
GRANT SELECT (id, order_number, daily_number, created_at, branch_id, type, status, payment_method, total_price),
      INSERT (branch_id, type, phone, customer_name, payment_method, status, total_price, daily_number),
      UPDATE (updated_at) ON public.orders TO hyp_payment_coordinator;
GRANT USAGE ON SEQUENCE public.orders_order_number_seq TO hyp_payment_coordinator;
GRANT INSERT (order_id, item_id, quantity, unit_price, notes) ON public.order_items TO hyp_payment_coordinator;
GRANT INSERT (order_id, address, city, street, house_number, apartment, floor, entrance, notes, delivery_fee,
              meal_surcharge, meal_quantity, delivery_lat, delivery_lng, geo_source, geo_precision)
  ON public.deliveries TO hyp_payment_coordinator;
GRANT INSERT (order_id, branch_id, tracking_ref, carrier, recipient_name, last_actor),
      SELECT (branch_id, tracking_key, status) ON public.parcel_requests TO hyp_payment_coordinator;
GRANT INSERT (parcel_id, order_id, from_status, to_status, actor) ON public.parcel_events TO hyp_payment_coordinator;
GRANT EXECUTE ON FUNCTION public.create_order(jsonb, jsonb, jsonb) TO hyp_payment_coordinator;
GRANT EXECUTE ON FUNCTION public.create_order_with_parcel(jsonb, jsonb, jsonb, jsonb) TO hyp_payment_coordinator;

-- ─── 1. Tables ─────────────────────────────────────────────────────────────────────────────────────────────────────
-- Status vocabulary (HYP-03R §4). Evidence: confirmed = paid, paid_amount_mismatch, paid_hold, finalized, voided,
-- refunded; unknown = redirected, returned, verify_rejected, outcome_unknown; not paid = not_sent (the redirect URL was
-- never handed out), declined (VERIFY authenticated a decline), no_charge_found (staff checked the HYP portal).
-- Nothing ever becomes no_charge_found by a timeout: the sweeper moves redirected → outcome_unknown only.
CREATE TABLE public.payment_intents (
  id                    uuid        NOT NULL DEFAULT gen_random_uuid(),
  checkout_key          uuid        NOT NULL,
  public_token          uuid        NOT NULL DEFAULT gen_random_uuid(),
  hyp_order_ref         text        NOT NULL DEFAULT upper(replace(gen_random_uuid()::text, '-', '')),
  terminal_kind         text        NOT NULL,
  branch_id             uuid        NOT NULL,
  order_kind            text        NOT NULL,
  snapshot              jsonb       NOT NULL,
  amount_agorot         integer     NOT NULL,
  currency              text        NOT NULL DEFAULT 'ILS',
  phone_key             text        GENERATED ALWAYS AS (regexp_replace(snapshot #>> '{p_order,phone}', '[^0-9]', '', 'g')) STORED,
  parcel_tracking_key   text        GENERATED ALWAYS AS (CASE WHEN snapshot ? 'p_parcel'
                                      THEN upper(regexp_replace(snapshot #>> '{p_parcel,tracking_ref}', '[^A-Za-z0-9]', '', 'g')) END) STORED,
  status                text        NOT NULL DEFAULT 'created',
  hold_reason           text        NULL,
  paid_source           text        NULL,
  paid_transaction_id   uuid        NULL,
  paid_at               timestamptz NULL,
  duplicate_charge_at   timestamptz NULL,
  order_id              uuid        NULL,
  finalize_attempts     integer     NOT NULL DEFAULT 0,
  last_error            text        NULL,
  last_actor            text        NOT NULL DEFAULT 'system',
  staff_user            text        NULL,
  staff_note            text        NULL,
  portal_checked_at     timestamptz NULL,
  -- HYP-09: staff attention marker. 'refund_required' = money must be returned at HYP (NOT a recorded refund);
  -- 'investigation' = needs a portal / customer check. Never changes the payment status.
  staff_flag            text        NULL,
  staff_flag_note       text        NULL,
  staff_flag_by         text        NULL,
  staff_flag_at         timestamptz NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  expires_at            timestamptz NOT NULL,
  redirected_at         timestamptz NULL,
  returned_at           timestamptz NULL,
  finalized_at          timestamptz NULL,
  resolved_at           timestamptz NULL,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_intents_pkey PRIMARY KEY (id),
  CONSTRAINT payment_intents_checkout_key_key UNIQUE (checkout_key),
  CONSTRAINT payment_intents_public_token_key UNIQUE (public_token),
  CONSTRAINT payment_intents_hyp_order_ref_key UNIQUE (hyp_order_ref),
  CONSTRAINT payment_intents_order_id_key UNIQUE (order_id),
  CONSTRAINT payment_intents_branch_fk FOREIGN KEY (branch_id) REFERENCES public.branches (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT payment_intents_order_fk FOREIGN KEY (order_id) REFERENCES public.orders (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT payment_intents_hyp_order_ref_format CHECK (hyp_order_ref ~ '^[A-Z0-9]{8,32}$'),
  CONSTRAINT payment_intents_terminal_kind_check CHECK (terminal_kind IN ('test', 'live')),
  CONSTRAINT payment_intents_order_kind_check CHECK (order_kind IN ('plain', 'parcel')),
  CONSTRAINT payment_intents_currency_check CHECK (currency = 'ILS'),
  -- The snapshot is exactly the create_order / create_order_with_parcel argument set the server built (no other keys).
  CONSTRAINT payment_intents_snapshot_shape CHECK (
    jsonb_typeof(snapshot) = 'object'
    AND (snapshot - ARRAY['p_order', 'p_items', 'p_delivery', 'p_parcel']) = '{}'::jsonb
    AND jsonb_typeof(snapshot -> 'p_order') = 'object'
    AND jsonb_typeof(snapshot -> 'p_items') = 'array'
    AND (NOT (snapshot ? 'p_delivery') OR jsonb_typeof(snapshot -> 'p_delivery') = 'object')
    AND snapshot #>> '{p_order,payment_method}' = 'online'
    AND snapshot #>> '{p_order,type}' IN ('pickup', 'delivery')
    AND snapshot #>> '{p_order,branch_id}' = branch_id::text
    AND (order_kind = 'parcel') = (snapshot ? 'p_parcel')
    AND (NOT (snapshot ? 'p_parcel') OR (jsonb_typeof(snapshot -> 'p_parcel') = 'object'
                                         AND snapshot #>> '{p_order,type}' = 'delivery'))),
  CONSTRAINT payment_intents_amount_matches_snapshot CHECK (
    amount_agorot BETWEEN 1 AND 500000
    AND jsonb_typeof(snapshot #> '{p_order,total_price}') = 'number'
    AND (snapshot #>> '{p_order,total_price}')::numeric * 100 = amount_agorot),
  CONSTRAINT payment_intents_phone_key_format CHECK (phone_key ~ '^[0-9]{9,15}$'),
  CONSTRAINT payment_intents_status_check CHECK (status IN ('created', 'not_sent', 'redirected', 'returned', 'paid',
    'paid_amount_mismatch', 'declined', 'verify_rejected', 'outcome_unknown', 'paid_hold', 'finalized', 'no_charge_found',
    'voided', 'refunded')),
  CONSTRAINT payment_intents_hold_reason_check CHECK (hold_reason IS NULL OR hold_reason IN ('late_return', 'finalize_error',
    'duplicate_charge', 'parcel_conflict', 'manual_confirmation', 'manual')),
  CONSTRAINT payment_intents_hold_has_reason CHECK (status <> 'paid_hold' OR hold_reason IS NOT NULL),
  CONSTRAINT payment_intents_paid_source_check CHECK (paid_source IS NULL OR paid_source IN ('verify', 'portal')),
  CONSTRAINT payment_intents_paid_evidence CHECK ((paid_at IS NULL) = (paid_source IS NULL)
                                                  AND (paid_at IS NULL) = (paid_transaction_id IS NULL)),
  CONSTRAINT payment_intents_paid_states CHECK (status NOT IN ('paid', 'paid_amount_mismatch', 'paid_hold', 'finalized',
                                                                'voided', 'refunded') OR paid_at IS NOT NULL),
  CONSTRAINT payment_intents_finalized_has_order CHECK (status <> 'finalized' OR (order_id IS NOT NULL AND finalized_at IS NOT NULL)),
  CONSTRAINT payment_intents_order_only_when_finalized CHECK (order_id IS NULL OR status IN ('finalized', 'voided', 'refunded')),
  CONSTRAINT payment_intents_no_charge_attested CHECK (status <> 'no_charge_found'
                                                       OR (staff_user IS NOT NULL AND staff_note IS NOT NULL AND portal_checked_at IS NOT NULL)),
  CONSTRAINT payment_intents_reversal_attested CHECK (status NOT IN ('voided', 'refunded')
                                                      OR (staff_user IS NOT NULL AND resolved_at IS NOT NULL)),
  CONSTRAINT payment_intents_staff_user_format CHECK (staff_user IS NULL OR staff_user ~ '^[a-z0-9_-]{2,32}$'),
  CONSTRAINT payment_intents_staff_note_length CHECK (staff_note IS NULL OR char_length(staff_note) BETWEEN 3 AND 500),
  CONSTRAINT payment_intents_last_actor_format CHECK (last_actor ~ '^(system(:[a-z_]{2,32})?|staff:[a-z0-9_-]{2,32})$'),
  CONSTRAINT payment_intents_last_error_length CHECK (last_error IS NULL OR char_length(last_error) <= 400),
  CONSTRAINT payment_intents_attempts_range CHECK (finalize_attempts BETWEEN 0 AND 100),
  CONSTRAINT payment_intents_staff_flag_check CHECK (staff_flag IS NULL OR staff_flag IN ('refund_required', 'investigation')),
  CONSTRAINT payment_intents_staff_flag_attested CHECK (staff_flag IS NULL
                                                        OR (staff_flag_note IS NOT NULL AND staff_flag_by IS NOT NULL AND staff_flag_at IS NOT NULL)),
  CONSTRAINT payment_intents_staff_flag_by_format CHECK (staff_flag_by IS NULL OR staff_flag_by ~ '^[a-z0-9_-]{2,32}$'),
  CONSTRAINT payment_intents_staff_flag_note_length CHECK (staff_flag_note IS NULL OR char_length(staff_flag_note) BETWEEN 3 AND 500),
  CONSTRAINT payment_intents_expiry_after_creation CHECK (expires_at > created_at)
);
-- Ambiguity guard (HYP-03R layer B): one open / unresolved intent per customer phone and branch. A new charge is
-- impossible while an earlier payment of the same customer is still unknown or held.
CREATE UNIQUE INDEX payment_intents_open_phone_uq ON public.payment_intents (branch_id, phone_key)
  WHERE status IN ('created', 'redirected', 'returned', 'verify_rejected', 'outcome_unknown', 'paid', 'paid_hold', 'paid_amount_mismatch');
-- Parcel tracking-number reservation while the order does not exist yet (HYP-03R §6).
CREATE UNIQUE INDEX payment_intents_open_parcel_uq ON public.payment_intents (branch_id, parcel_tracking_key)
  WHERE parcel_tracking_key IS NOT NULL
    AND status IN ('created', 'redirected', 'returned', 'verify_rejected', 'outcome_unknown', 'paid', 'paid_hold', 'paid_amount_mismatch');
CREATE INDEX payment_intents_status_created_idx ON public.payment_intents (status, created_at);

-- Every browser return as received (needed verbatim for VERIFY). Several returns per intent are possible.
CREATE TABLE public.payment_returns (
  id               uuid        NOT NULL DEFAULT gen_random_uuid(),
  intent_id        uuid        NOT NULL,
  return_raw       text        NOT NULL,
  return_md5       text        GENERATED ALWAYS AS (md5(return_raw)) STORED,
  received_at      timestamptz NOT NULL DEFAULT now(),
  verify_outcome   text        NULL,
  verify_response  text        NULL,
  verified_at      timestamptz NULL,
  CONSTRAINT payment_returns_pkey PRIMARY KEY (id),
  CONSTRAINT payment_returns_intent_fk FOREIGN KEY (intent_id) REFERENCES public.payment_intents (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT payment_returns_intent_raw_key UNIQUE (intent_id, return_md5),
  CONSTRAINT payment_returns_raw_length CHECK (char_length(return_raw) BETWEEN 1 AND 4000),
  CONSTRAINT payment_returns_outcome_check CHECK (verify_outcome IS NULL OR verify_outcome IN ('authentic', 'rejected', 'unparseable')),
  CONSTRAINT payment_returns_verified_consistency CHECK ((verify_outcome IS NULL) = (verified_at IS NULL)
                                                         AND (verify_outcome IS NULL) = (verify_response IS NULL)),
  CONSTRAINT payment_returns_response_length CHECK (verify_response IS NULL OR char_length(verify_response) BETWEEN 1 AND 2000)
);

-- One row per HYP transaction Id ever observed (VERIFY-authenticated return, or staff-confirmed from the HYP portal).
CREATE TABLE public.payment_transactions (
  id             uuid        NOT NULL DEFAULT gen_random_uuid(),
  intent_id      uuid        NOT NULL,
  return_id      uuid        NULL,
  hyp_trans_id   text        NOT NULL,
  source         text        NOT NULL,
  ccode          text        NOT NULL,
  acode          text        NULL,
  amount_agorot  integer     NOT NULL,
  outcome        text        NOT NULL,
  recorded_by    text        NOT NULL,
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_transactions_pkey PRIMARY KEY (id),
  CONSTRAINT payment_transactions_hyp_trans_id_key UNIQUE (hyp_trans_id),
  CONSTRAINT payment_transactions_intent_fk FOREIGN KEY (intent_id) REFERENCES public.payment_intents (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT payment_transactions_return_fk FOREIGN KEY (return_id) REFERENCES public.payment_returns (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT payment_transactions_trans_id_format CHECK (hyp_trans_id ~ '^[0-9A-Za-z]{1,40}$'),
  CONSTRAINT payment_transactions_source_check CHECK (source IN ('verify', 'portal')),
  CONSTRAINT payment_transactions_source_return CHECK ((source = 'verify') = (return_id IS NOT NULL)),
  CONSTRAINT payment_transactions_ccode_format CHECK (ccode ~ '^[0-9]{1,6}$'),
  CONSTRAINT payment_transactions_acode_format CHECK (acode IS NULL OR acode ~ '^[0-9A-Za-z]{1,20}$'),
  CONSTRAINT payment_transactions_amount_range CHECK (amount_agorot BETWEEN 1 AND 99999999),
  -- HYP-06A: Hyp Pay status codes — 0 approved (captured); 600 J2 (card checked, no charge), 700 J5 (funds held,
  -- not captured), 800 postponed (charged only after commitTrans) = authenticated but NOT a capture; anything else declined.
  CONSTRAINT payment_transactions_outcome_check CHECK (outcome IN ('approved', 'declined', 'non_capture')
                                                       AND (outcome = 'approved') = (ccode = '0')
                                                       AND (outcome = 'non_capture') = (ccode IN ('600', '700', '800'))),
  CONSTRAINT payment_transactions_recorded_by_format CHECK (recorded_by ~ '^(system|staff:[a-z0-9_-]{2,32})$'
                                                            AND (source = 'verify' OR recorded_by LIKE 'staff:%'))
);
CREATE INDEX payment_transactions_intent_idx ON public.payment_transactions (intent_id);
ALTER TABLE public.payment_intents ADD CONSTRAINT payment_intents_paid_transaction_fk
  FOREIGN KEY (paid_transaction_id) REFERENCES public.payment_transactions (id) ON UPDATE RESTRICT ON DELETE RESTRICT;

-- Void (CancelTrans) / refund (zikoyAPI or portal) performed at HYP and recorded by staff. Never deletes evidence.
CREATE TABLE public.payment_reversals (
  id              uuid        NOT NULL DEFAULT gen_random_uuid(),
  intent_id       uuid        NOT NULL,
  transaction_id  uuid        NOT NULL,
  kind            text        NOT NULL,
  amount_agorot   integer     NOT NULL,
  hyp_reference   text        NOT NULL,
  staff_user      text        NOT NULL,
  note            text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_reversals_pkey PRIMARY KEY (id),
  CONSTRAINT payment_reversals_intent_fk FOREIGN KEY (intent_id) REFERENCES public.payment_intents (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT payment_reversals_transaction_fk FOREIGN KEY (transaction_id) REFERENCES public.payment_transactions (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT payment_reversals_kind_check CHECK (kind IN ('void', 'refund')),
  CONSTRAINT payment_reversals_amount_range CHECK (amount_agorot BETWEEN 1 AND 99999999),
  CONSTRAINT payment_reversals_reference_format CHECK (hyp_reference ~ '^[0-9A-Za-z_-]{1,40}$'),
  CONSTRAINT payment_reversals_staff_user_format CHECK (staff_user ~ '^[a-z0-9_-]{2,32}$'),
  CONSTRAINT payment_reversals_note_length CHECK (char_length(note) BETWEEN 3 AND 500),
  -- HYP-09: one HYP cancel / refund reference is recorded once (a double submit can never record a refund twice).
  CONSTRAINT payment_reversals_reference_key UNIQUE (hyp_reference)
);
CREATE INDEX payment_reversals_intent_idx ON public.payment_reversals (intent_id);

-- Append-only audit trail of every intent state change (written by a trigger, never by the application).
CREATE TABLE public.payment_intent_events (
  id           uuid        NOT NULL DEFAULT gen_random_uuid(),
  intent_id    uuid        NOT NULL,
  occurred_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  from_status  text        NULL,
  to_status    text        NOT NULL,
  actor        text        NOT NULL,
  hold_reason  text        NULL,
  detail       text        NULL,
  CONSTRAINT payment_intent_events_pkey PRIMARY KEY (id),
  CONSTRAINT payment_intent_events_intent_fk FOREIGN KEY (intent_id) REFERENCES public.payment_intents (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT payment_intent_events_detail_length CHECK (detail IS NULL OR char_length(detail) <= 400)
);
CREATE INDEX payment_intent_events_intent_idx ON public.payment_intent_events (intent_id, occurred_at);

-- Supabase default privileges grant ALL on new public tables to anon / authenticated / service_role → reset, then grant.
ALTER TABLE public.payment_intents       ENABLE ROW LEVEL SECURITY;   -- no policies: only RLS-bypassing roles read them
ALTER TABLE public.payment_returns       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_transactions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_reversals     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_intent_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.payment_intents, public.payment_returns, public.payment_transactions, public.payment_reversals,
              public.payment_intent_events FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.payment_intents, public.payment_returns, public.payment_transactions, public.payment_reversals,
                public.payment_intent_events TO service_role;
GRANT SELECT ON public.payment_intents, public.payment_returns, public.payment_transactions, public.payment_reversals
  TO hyp_payment_coordinator;
GRANT INSERT (checkout_key, terminal_kind, branch_id, order_kind, snapshot, amount_agorot, expires_at, last_actor),
      UPDATE (status, hold_reason, paid_source, paid_transaction_id, paid_at, duplicate_charge_at, order_id, finalize_attempts,
              last_error, last_actor, staff_user, staff_note, portal_checked_at, redirected_at, returned_at, finalized_at,
              resolved_at, updated_at, staff_flag, staff_flag_note, staff_flag_by, staff_flag_at)
  ON public.payment_intents TO hyp_payment_coordinator;
GRANT INSERT (intent_id, return_raw), UPDATE (verify_outcome, verify_response, verified_at)
  ON public.payment_returns TO hyp_payment_coordinator;
GRANT INSERT (intent_id, return_id, hyp_trans_id, source, ccode, acode, amount_agorot, outcome, recorded_by)
  ON public.payment_transactions TO hyp_payment_coordinator;
GRANT INSERT (intent_id, transaction_id, kind, amount_agorot, hyp_reference, staff_user, note)
  ON public.payment_reversals TO hyp_payment_coordinator;
GRANT INSERT (intent_id, from_status, to_status, actor, hold_reason, detail)
  ON public.payment_intent_events TO hyp_payment_coordinator;

-- ─── 1b. Integrity triggers on the payment tables ─────────────────────────────────────────────────────────────────
CREATE FUNCTION public.payment_append_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $payment_append_only$
BEGIN
  RAISE EXCEPTION 'payment_append_only: % on % is not allowed (financial evidence)', TG_OP, TG_TABLE_NAME USING ERRCODE = '42501';
END
$payment_append_only$;

CREATE FUNCTION public.payment_intents_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $payment_intents_guard$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payment_intents_guard: payment intents are never deleted' USING ERRCODE = '42501';
  END IF;
  -- The snapshot and everything the customer was charged for are immutable.
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.checkout_key IS DISTINCT FROM OLD.checkout_key
     OR NEW.public_token IS DISTINCT FROM OLD.public_token OR NEW.hyp_order_ref IS DISTINCT FROM OLD.hyp_order_ref
     OR NEW.terminal_kind IS DISTINCT FROM OLD.terminal_kind OR NEW.branch_id IS DISTINCT FROM OLD.branch_id
     OR NEW.order_kind IS DISTINCT FROM OLD.order_kind OR NEW.snapshot IS DISTINCT FROM OLD.snapshot
     OR NEW.amount_agorot IS DISTINCT FROM OLD.amount_agorot OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'payment_intents_guard: immutable column changed' USING ERRCODE = '42501';
  END IF;
  -- Payment evidence and the order link, once set, never change.
  IF (OLD.paid_transaction_id IS NOT NULL AND (NEW.paid_transaction_id IS DISTINCT FROM OLD.paid_transaction_id
                                                OR NEW.paid_at IS DISTINCT FROM OLD.paid_at
                                                OR NEW.paid_source IS DISTINCT FROM OLD.paid_source))
     OR (OLD.order_id IS NOT NULL AND NEW.order_id IS DISTINCT FROM OLD.order_id)
     OR (OLD.duplicate_charge_at IS NOT NULL AND NEW.duplicate_charge_at IS DISTINCT FROM OLD.duplicate_charge_at) THEN
    RAISE EXCEPTION 'payment_intents_guard: payment evidence is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT ((OLD.status || '>' || NEW.status) = ANY (ARRAY[
       'created>redirected', 'created>not_sent', 'created>returned',
       'not_sent>returned',
       'redirected>returned', 'redirected>outcome_unknown', 'redirected>paid', 'redirected>paid_amount_mismatch',
       'returned>paid', 'returned>paid_amount_mismatch', 'returned>declined', 'returned>verify_rejected', 'returned>no_charge_found',
       'returned>outcome_unknown',   -- HYP-06A: authenticated non-capture code (600 / 700 / 800) → staff reconciliation
       'verify_rejected>returned', 'verify_rejected>paid', 'verify_rejected>paid_amount_mismatch', 'verify_rejected>no_charge_found',
       'outcome_unknown>returned', 'outcome_unknown>paid', 'outcome_unknown>paid_amount_mismatch', 'outcome_unknown>no_charge_found',
       'declined>returned', 'declined>paid', 'declined>paid_amount_mismatch',
       'no_charge_found>returned', 'no_charge_found>paid', 'no_charge_found>paid_amount_mismatch',
       'paid>finalized', 'paid>paid_hold',
       'paid_amount_mismatch>paid_hold', 'paid_amount_mismatch>voided', 'paid_amount_mismatch>refunded',
       'paid_hold>finalized', 'paid_hold>voided', 'paid_hold>refunded',
       'finalized>voided', 'finalized>refunded'])) THEN
    RAISE EXCEPTION 'payment_intents_guard: transition % → % is not allowed', OLD.status, NEW.status USING ERRCODE = '42501';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$payment_intents_guard$;

CREATE FUNCTION public.payment_intents_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $payment_intents_audit$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status OR NEW.hold_reason IS DISTINCT FROM OLD.hold_reason
     OR NEW.duplicate_charge_at IS DISTINCT FROM OLD.duplicate_charge_at OR NEW.finalize_attempts IS DISTINCT FROM OLD.finalize_attempts
     OR NEW.staff_flag_at IS DISTINCT FROM OLD.staff_flag_at OR NEW.staff_note IS DISTINCT FROM OLD.staff_note THEN
    -- HYP-09: staff notes / flags are copied into the append-only trail (the intent columns hold only the latest).
    INSERT INTO public.payment_intent_events (intent_id, from_status, to_status, actor, hold_reason, detail)
    VALUES (NEW.id, CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.status END, NEW.status, NEW.last_actor, NEW.hold_reason,
            CASE WHEN TG_OP = 'UPDATE' AND NEW.duplicate_charge_at IS DISTINCT FROM OLD.duplicate_charge_at THEN 'duplicate_charge'
                 WHEN TG_OP = 'UPDATE' AND NEW.staff_flag_at IS DISTINCT FROM OLD.staff_flag_at
                   THEN left('flag:' || COALESCE(NEW.staff_flag, 'cleared') || ' ' || COALESCE(NEW.staff_flag_note, ''), 400)
                 WHEN TG_OP = 'UPDATE' AND NEW.staff_note IS DISTINCT FROM OLD.staff_note THEN left('note: ' || NEW.staff_note, 400)
                 WHEN TG_OP = 'UPDATE' AND NEW.last_error IS DISTINCT FROM OLD.last_error THEN NEW.last_error END);
  END IF;
  RETURN NULL;
END
$payment_intents_audit$;

CREATE FUNCTION public.payment_returns_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $payment_returns_guard$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payment_returns_guard: returns are never deleted' USING ERRCODE = '42501';
  END IF;
  -- Only the one-time VERIFY result may be added; the received query string never changes.
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.intent_id IS DISTINCT FROM OLD.intent_id OR NEW.return_raw IS DISTINCT FROM OLD.return_raw
     OR NEW.received_at IS DISTINCT FROM OLD.received_at OR OLD.verify_outcome IS NOT NULL THEN
    RAISE EXCEPTION 'payment_returns_guard: a return is immutable once recorded / verified' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$payment_returns_guard$;

CREATE TRIGGER payment_intents_guard BEFORE UPDATE OR DELETE ON public.payment_intents
  FOR EACH ROW EXECUTE FUNCTION public.payment_intents_guard();
CREATE TRIGGER payment_intents_audit AFTER INSERT OR UPDATE ON public.payment_intents
  FOR EACH ROW EXECUTE FUNCTION public.payment_intents_audit();
CREATE TRIGGER payment_returns_guard BEFORE UPDATE OR DELETE ON public.payment_returns
  FOR EACH ROW EXECUTE FUNCTION public.payment_returns_guard();
CREATE TRIGGER payment_transactions_append_only BEFORE UPDATE OR DELETE ON public.payment_transactions
  FOR EACH ROW EXECUTE FUNCTION public.payment_append_only();
CREATE TRIGGER payment_reversals_append_only BEFORE UPDATE OR DELETE ON public.payment_reversals
  FOR EACH ROW EXECUTE FUNCTION public.payment_append_only();
CREATE TRIGGER payment_intent_events_append_only BEFORE UPDATE OR DELETE ON public.payment_intent_events
  FOR EACH ROW EXECUTE FUNCTION public.payment_append_only();
CREATE TRIGGER payment_intents_no_truncate BEFORE TRUNCATE ON public.payment_intents
  FOR EACH STATEMENT EXECUTE FUNCTION public.payment_append_only();
CREATE TRIGGER payment_returns_no_truncate BEFORE TRUNCATE ON public.payment_returns
  FOR EACH STATEMENT EXECUTE FUNCTION public.payment_append_only();
CREATE TRIGGER payment_transactions_no_truncate BEFORE TRUNCATE ON public.payment_transactions
  FOR EACH STATEMENT EXECUTE FUNCTION public.payment_append_only();
CREATE TRIGGER payment_reversals_no_truncate BEFORE TRUNCATE ON public.payment_reversals
  FOR EACH STATEMENT EXECUTE FUNCTION public.payment_append_only();
CREATE TRIGGER payment_intent_events_no_truncate BEFORE TRUNCATE ON public.payment_intent_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.payment_append_only();

-- ─── 2. Orders: allow the 'online' value, but only through the coordinator ─────────────────────────────────────────
ALTER TABLE public.orders
  DROP CONSTRAINT orders_payment_method_check,
  ADD CONSTRAINT orders_payment_method_check
    CHECK (payment_method = ANY (ARRAY['cash'::text, 'credit'::text, 'cibus'::text, 'bit'::text, 'online'::text]));

-- SECURITY INVOKER on purpose: current_user is then the role that really wrote the row (the coordinator only inside
-- the DEFINER finalize; service_role / anon otherwise). AFTER on purpose: no BEFORE trigger can rewrite the row later.
CREATE FUNCTION public.orders_online_payment_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $orders_online_payment_guard$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.payment_method = 'online' AND current_user IS DISTINCT FROM 'hyp_payment_coordinator' THEN
      RAISE EXCEPTION 'orders_online_payment_guard: online-paid orders are created only by public.finalize_paid_intent'
        USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.payment_method IS DISTINCT FROM OLD.payment_method OR NEW.total_price IS DISTINCT FROM OLD.total_price
        OR NEW.branch_id IS DISTINCT FROM OLD.branch_id OR NEW.type IS DISTINCT FROM OLD.type OR NEW.id IS DISTINCT FROM OLD.id THEN
    -- Applies to every role (the coordinator never updates orders): the payment fields of an online order are final.
    RAISE EXCEPTION 'orders_online_payment_guard: payment fields of an online-paid order are immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NULL;
END
$orders_online_payment_guard$;

CREATE TRIGGER orders_online_payment_guard_insert AFTER INSERT ON public.orders
  FOR EACH ROW WHEN (NEW.payment_method = 'online') EXECUTE FUNCTION public.orders_online_payment_guard();
CREATE TRIGGER orders_online_payment_guard_update AFTER UPDATE ON public.orders
  FOR EACH ROW WHEN (OLD.payment_method = 'online' OR NEW.payment_method = 'online') EXECUTE FUNCTION public.orders_online_payment_guard();

REVOKE ALL ON FUNCTION public.payment_append_only(), public.payment_intents_guard(), public.payment_intents_audit(),
                       public.payment_returns_guard(), public.orders_online_payment_guard()
  FROM PUBLIC, anon, authenticated, service_role;

-- ─── 3. Payment functions (SECURITY DEFINER, owner: the coordinator) ──────────────────────────────────────────────
-- Common rules: search_path '', fully qualified names, no dynamic SQL, intent row locked FOR UPDATE before any change
-- (lock order everywhere: payment_intents row → payment_returns row → create_order's advisory lock).

-- 3.1 Start: persist the server-built snapshot BEFORE any contact with HYP. Idempotent per checkout_key.
CREATE FUNCTION public.create_payment_intent(p_checkout_key uuid, p_terminal_kind text, p_order_kind text,
                                             p_snapshot jsonb, p_amount_agorot integer, p_ttl_seconds integer)
RETURNS TABLE (result text, intent_id uuid, public_token uuid, hyp_order_ref text, intent_status text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '3s'
AS $create_payment_intent$
#variable_conflict use_column
DECLARE
  v_row    public.payment_intents%ROWTYPE;
  v_branch text := p_snapshot #>> '{p_order,branch_id}';
  v_phone  text := regexp_replace(p_snapshot #>> '{p_order,phone}', '[^0-9]', '', 'g');
  v_key    text;
  v_con    text;
  c_open   text[] := ARRAY['created', 'redirected', 'returned', 'verify_rejected', 'outcome_unknown', 'paid', 'paid_hold', 'paid_amount_mismatch'];
BEGIN
  IF p_checkout_key IS NULL OR p_terminal_kind IS NULL OR p_order_kind IS NULL OR p_snapshot IS NULL
     OR p_amount_agorot IS NULL OR p_ttl_seconds IS NULL OR p_ttl_seconds NOT BETWEEN 300 AND 3600
     OR jsonb_typeof(p_snapshot) IS DISTINCT FROM 'object'
     OR v_branch IS NULL OR v_branch !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN QUERY SELECT 'invalid_request'::text, NULL::uuid, NULL::uuid, NULL::text, NULL::text; RETURN;
  END IF;

  -- Layer A: a repeated request with the same checkout key returns the same intent; a different cart is refused.
  SELECT pi.* INTO v_row FROM public.payment_intents AS pi WHERE pi.checkout_key = p_checkout_key;
  IF FOUND THEN
    IF v_row.snapshot = p_snapshot AND v_row.amount_agorot = p_amount_agorot
       AND v_row.order_kind = p_order_kind AND v_row.terminal_kind = p_terminal_kind THEN
      RETURN QUERY SELECT 'existing'::text, v_row.id, v_row.public_token, v_row.hyp_order_ref, v_row.status; RETURN;
    END IF;
    RETURN QUERY SELECT 'checkout_key_reused'::text, NULL::uuid, NULL::uuid, NULL::text, NULL::text; RETURN;
  END IF;

  -- Layer B: no second charge while an earlier payment of this customer is open or unresolved (token not disclosed).
  IF EXISTS (SELECT 1 FROM public.payment_intents AS pi
              WHERE pi.branch_id = v_branch::uuid AND pi.phone_key = v_phone AND pi.status = ANY (c_open)) THEN
    RETURN QUERY SELECT 'open_payment_exists'::text, NULL::uuid, NULL::uuid, NULL::text, NULL::text; RETURN;
  END IF;

  IF p_order_kind = 'parcel' THEN
    v_key := upper(regexp_replace(p_snapshot #>> '{p_parcel,tracking_ref}', '[^A-Za-z0-9]', '', 'g'));
    IF EXISTS (SELECT 1 FROM public.parcel_requests AS pr
                WHERE pr.branch_id = v_branch::uuid AND pr.tracking_key = v_key
                  AND pr.status IN ('awaiting_search', 'found', 'not_found', 'handed_to_courier', 'delivery_problem')) THEN
      RETURN QUERY SELECT 'parcel_active'::text, NULL::uuid, NULL::uuid, NULL::text, NULL::text; RETURN;
    END IF;
    IF EXISTS (SELECT 1 FROM public.payment_intents AS pi
                WHERE pi.branch_id = v_branch::uuid AND pi.parcel_tracking_key = v_key AND pi.status = ANY (c_open)) THEN
      RETURN QUERY SELECT 'parcel_reserved'::text, NULL::uuid, NULL::uuid, NULL::text, NULL::text; RETURN;
    END IF;
  END IF;

  BEGIN
    INSERT INTO public.payment_intents (checkout_key, terminal_kind, branch_id, order_kind, snapshot, amount_agorot, expires_at, last_actor)
    VALUES (p_checkout_key, p_terminal_kind, v_branch::uuid, p_order_kind, p_snapshot, p_amount_agorot,
            now() + make_interval(secs => p_ttl_seconds), 'system:start')
    RETURNING * INTO v_row;
  EXCEPTION
    WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_con = CONSTRAINT_NAME;
      RETURN QUERY SELECT CASE v_con WHEN 'payment_intents_open_phone_uq' THEN 'open_payment_exists'
                                     WHEN 'payment_intents_open_parcel_uq' THEN 'parcel_reserved'
                                     WHEN 'payment_intents_checkout_key_key' THEN 'retry'
                                     ELSE 'conflict' END::text, NULL::uuid, NULL::uuid, NULL::text, NULL::text;
      RETURN;
    WHEN check_violation OR not_null_violation OR foreign_key_violation OR data_exception THEN
      RETURN QUERY SELECT 'invalid_snapshot'::text, NULL::uuid, NULL::uuid, NULL::text, NULL::text; RETURN;
  END;
  RETURN QUERY SELECT 'created'::text, v_row.id, v_row.public_token, v_row.hyp_order_ref, v_row.status;
END
$create_payment_intent$;

-- 3.2 SIGN outcome. The application hands the redirect URL to the browser ONLY after 'recorded' + 'redirected'.
CREATE FUNCTION public.record_hyp_sign_result(p_intent_id uuid, p_redirected boolean)
RETURNS TABLE (result text, intent_status text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '3s'
AS $record_hyp_sign_result$
#variable_conflict use_column
DECLARE
  v public.payment_intents%ROWTYPE;
BEGIN
  IF p_intent_id IS NULL OR p_redirected IS NULL THEN
    RETURN QUERY SELECT 'invalid_request'::text, NULL::text; RETURN;
  END IF;
  SELECT pi.* INTO v FROM public.payment_intents AS pi WHERE pi.id = p_intent_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text; RETURN;
  END IF;
  IF v.status = 'redirected' AND p_redirected THEN
    RETURN QUERY SELECT 'already_redirected'::text, v.status; RETURN;
  END IF;
  IF v.status <> 'created' THEN
    RETURN QUERY SELECT 'invalid_state'::text, v.status; RETURN;
  END IF;
  IF NOT p_redirected OR now() >= v.expires_at THEN
    UPDATE public.payment_intents AS pi SET status = 'not_sent', last_actor = 'system:start' WHERE pi.id = v.id;
    RETURN QUERY SELECT CASE WHEN p_redirected THEN 'expired' ELSE 'recorded' END::text, 'not_sent'::text; RETURN;
  END IF;
  UPDATE public.payment_intents AS pi SET status = 'redirected', redirected_at = now(), last_actor = 'system:start' WHERE pi.id = v.id;
  RETURN QUERY SELECT 'recorded'::text, 'redirected'::text;
END
$record_hyp_sign_result$;

-- 3.3 Browser return: stored verbatim (VERIFY needs every parameter in its original order) BEFORE VERIFY is called.
-- Does not mark anything paid. Unknown Order → nothing stored.
CREATE FUNCTION public.record_hyp_return(p_return_raw text)
RETURNS TABLE (result text, return_id uuid, intent_id uuid, public_token uuid, intent_status text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '3s'
AS $record_hyp_return$
#variable_conflict use_column
DECLARE
  v      public.payment_intents%ROWTYPE;
  v_ref  text;
  v_rid  uuid;
  v_new  text;
BEGIN
  IF p_return_raw IS NULL OR char_length(p_return_raw) NOT BETWEEN 1 AND 4000
     OR p_return_raw !~ '^[A-Za-z0-9._~%=&+*:,/-]+$' OR regexp_count(p_return_raw, '(^|&)Order=') <> 1 THEN
    RETURN QUERY SELECT 'invalid_request'::text, NULL::uuid, NULL::uuid, NULL::uuid, NULL::text; RETURN;
  END IF;
  v_ref := (regexp_match(p_return_raw, '(?:^|&)Order=([^&]*)'))[1];
  IF v_ref IS NULL OR v_ref !~ '^[A-Z0-9]{8,32}$' THEN
    RETURN QUERY SELECT 'unknown_order'::text, NULL::uuid, NULL::uuid, NULL::uuid, NULL::text; RETURN;
  END IF;
  SELECT pi.* INTO v FROM public.payment_intents AS pi WHERE pi.hyp_order_ref = v_ref FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'unknown_order'::text, NULL::uuid, NULL::uuid, NULL::uuid, NULL::text; RETURN;
  END IF;
  SELECT r.id INTO v_rid FROM public.payment_returns AS r WHERE r.intent_id = v.id AND r.return_md5 = md5(p_return_raw);
  IF FOUND THEN
    RETURN QUERY SELECT 'duplicate_return'::text, v_rid, v.id, v.public_token, v.status; RETURN;
  END IF;
  INSERT INTO public.payment_returns (intent_id, return_raw) VALUES (v.id, p_return_raw) RETURNING id INTO v_rid;
  v_new := v.status;
  IF v.status IN ('created', 'not_sent', 'redirected', 'outcome_unknown', 'verify_rejected', 'declined', 'no_charge_found') THEN
    UPDATE public.payment_intents AS pi SET status = 'returned', returned_at = now(), last_actor = 'system:return' WHERE pi.id = v.id;
    v_new := 'returned';
  END IF;
  RETURN QUERY SELECT 'recorded'::text, v_rid, v.id, v.public_token, v_new;
END
$record_hyp_return$;

-- 3.4 VERIFY outcome for one stored return. p_outcome is the server's assertion of HYP's server-to-server VERIFY result
-- (trust root). Id / CCode / Amount / ACode / Order come ONLY from the stored return, never from this caller.
CREATE FUNCTION public.record_hyp_verification(p_return_id uuid, p_outcome text, p_verify_response text)
RETURNS TABLE (result text, intent_id uuid, intent_status text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '3s'
AS $record_hyp_verification$
#variable_conflict use_column
DECLARE
  v          public.payment_intents%ROWTYPE;
  r          public.payment_returns%ROWTYPE;
  v_tx       public.payment_transactions%ROWTYPE;
  v_intent   uuid;
  v_txid     uuid;
  v_id       text;
  v_ccode    text;
  v_amount   text;
  v_acode    text;
  v_order    text;
  v_agorot   integer;
  v_pending  boolean;
BEGIN
  IF p_return_id IS NULL OR p_outcome IS NULL OR p_outcome NOT IN ('authentic', 'rejected')
     OR p_verify_response IS NULL OR char_length(p_verify_response) NOT BETWEEN 1 AND 2000 THEN
    RETURN QUERY SELECT 'invalid_request'::text, NULL::uuid, NULL::text; RETURN;
  END IF;
  SELECT x.intent_id INTO v_intent FROM public.payment_returns AS x WHERE x.id = p_return_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::text; RETURN;
  END IF;
  SELECT pi.* INTO v FROM public.payment_intents AS pi WHERE pi.id = v_intent FOR UPDATE;
  SELECT x.* INTO r FROM public.payment_returns AS x WHERE x.id = p_return_id FOR UPDATE;
  IF r.verify_outcome IS NOT NULL THEN
    RETURN QUERY SELECT 'already_verified'::text, v.id, v.status; RETURN;
  END IF;
  -- Implementation-bug guard: the browser's own query string is not a VERIFY response.
  IF p_verify_response = r.return_raw THEN
    RETURN QUERY SELECT 'verify_response_is_return'::text, v.id, v.status; RETURN;
  END IF;
  v_pending := EXISTS (SELECT 1 FROM public.payment_returns AS x
                        WHERE x.intent_id = v.id AND x.id <> r.id AND x.verify_outcome IS NULL);

  IF p_outcome = 'rejected' THEN
    UPDATE public.payment_returns AS x SET verify_outcome = 'rejected', verify_response = p_verify_response, verified_at = now()
     WHERE x.id = r.id;
    IF v.status = 'returned' AND NOT v_pending THEN
      UPDATE public.payment_intents AS pi SET status = 'verify_rejected', last_actor = 'system:verify' WHERE pi.id = v.id;
      v.status := 'verify_rejected';
    END IF;
    RETURN QUERY SELECT 'rejected'::text, v.id, v.status; RETURN;
  END IF;

  -- Authentic: every payment field from the stored return, each exactly once and well-formed.
  v_id     := (regexp_match(r.return_raw, '(?:^|&)Id=([^&]*)'))[1];
  v_ccode  := (regexp_match(r.return_raw, '(?:^|&)CCode=([^&]*)'))[1];
  v_amount := (regexp_match(r.return_raw, '(?:^|&)Amount=([^&]*)'))[1];
  v_acode  := NULLIF((regexp_match(r.return_raw, '(?:^|&)ACode=([^&]*)'))[1], '');
  v_order  := (regexp_match(r.return_raw, '(?:^|&)Order=([^&]*)'))[1];
  IF regexp_count(r.return_raw, '(^|&)Id=') <> 1 OR regexp_count(r.return_raw, '(^|&)CCode=') <> 1
     OR regexp_count(r.return_raw, '(^|&)Amount=') <> 1 OR regexp_count(r.return_raw, '(^|&)ACode=') > 1
     OR v_id IS NULL OR v_id !~ '^[0-9A-Za-z]{1,40}$' OR v_ccode IS NULL OR v_ccode !~ '^[0-9]{1,6}$'
     OR v_amount IS NULL OR v_amount !~ '^[0-9]{1,6}(\.[0-9]{1,2})?$'
     OR (v_acode IS NOT NULL AND v_acode !~ '^[0-9A-Za-z]{1,20}$') OR v_order IS DISTINCT FROM v.hyp_order_ref THEN
    UPDATE public.payment_returns AS x SET verify_outcome = 'unparseable', verify_response = p_verify_response, verified_at = now()
     WHERE x.id = r.id;
    IF v.status = 'returned' AND NOT v_pending THEN
      UPDATE public.payment_intents AS pi SET status = 'verify_rejected', last_actor = 'system:verify' WHERE pi.id = v.id;
      v.status := 'verify_rejected';
    END IF;
    RETURN QUERY SELECT 'unparseable'::text, v.id, v.status; RETURN;
  END IF;
  v_agorot := (v_amount::numeric * 100)::integer;
  UPDATE public.payment_returns AS x SET verify_outcome = 'authentic', verify_response = p_verify_response, verified_at = now()
   WHERE x.id = r.id;

  -- Layer D: the same HYP transaction seen again is a no-op; an Id already bound to another intent is never merged.
  SELECT t.* INTO v_tx FROM public.payment_transactions AS t WHERE t.hyp_trans_id = v_id;
  IF FOUND THEN
    RETURN QUERY SELECT CASE WHEN v_tx.intent_id = v.id THEN 'already_recorded' ELSE 'trans_id_conflict' END::text, v.id, v.status;
    RETURN;
  END IF;
  INSERT INTO public.payment_transactions (intent_id, return_id, hyp_trans_id, source, ccode, acode, amount_agorot, outcome, recorded_by)
  VALUES (v.id, r.id, v_id, 'verify', v_ccode, v_acode, v_agorot,
          CASE WHEN v_ccode = '0' THEN 'approved' WHEN v_ccode IN ('600', '700', '800') THEN 'non_capture' ELSE 'declined' END, 'system')
  RETURNING id INTO v_txid;

  -- HYP-06A: J2 / J5 / postponed is neither paid nor declined (J5 funds may be held). The intent stays in the
  -- ambiguity-blocking outcome_unknown state (no new charge, no finalize) until staff resolve it against the HYP portal.
  IF v_ccode IN ('600', '700', '800') THEN
    IF v.status = 'returned' AND NOT v_pending THEN
      UPDATE public.payment_intents AS pi
         SET status = 'outcome_unknown', last_error = 'non_capture_ccode_' || v_ccode, last_actor = 'system:verify'
       WHERE pi.id = v.id;
      RETURN QUERY SELECT 'not_captured'::text, v.id, 'outcome_unknown'::text; RETURN;
    END IF;
    RETURN QUERY SELECT 'not_captured_ignored'::text, v.id, v.status; RETURN;
  END IF;

  IF v_ccode <> '0' THEN
    IF v.status = 'returned' AND NOT v_pending THEN
      UPDATE public.payment_intents AS pi SET status = 'declined', last_actor = 'system:verify' WHERE pi.id = v.id;
      RETURN QUERY SELECT 'declined'::text, v.id, 'declined'::text; RETURN;
    END IF;
    RETURN QUERY SELECT 'declined_ignored'::text, v.id, v.status; RETURN;
  END IF;

  IF v.status = 'returned' THEN
    UPDATE public.payment_intents AS pi
       SET status = CASE WHEN v_agorot = v.amount_agorot THEN 'paid' ELSE 'paid_amount_mismatch' END,
           paid_source = 'verify', paid_transaction_id = v_txid, paid_at = now(), last_actor = 'system:verify'
     WHERE pi.id = v.id;
    RETURN QUERY SELECT CASE WHEN v_agorot = v.amount_agorot THEN 'paid' ELSE 'amount_mismatch' END::text, v.id,
                        CASE WHEN v_agorot = v.amount_agorot THEN 'paid' ELSE 'paid_amount_mismatch' END::text;
    RETURN;
  END IF;
  -- Layer C (detection only): a second approved charge for an intent that is already paid.
  UPDATE public.payment_intents AS pi
     SET duplicate_charge_at = now(),
         status = CASE WHEN v.status = 'paid' THEN 'paid_hold' ELSE pi.status END,
         hold_reason = CASE WHEN v.status = 'paid' THEN 'duplicate_charge' ELSE pi.hold_reason END,
         last_actor = 'system:verify'
   WHERE pi.id = v.id;
  RETURN QUERY SELECT 'duplicate_charge'::text, v.id, CASE WHEN v.status = 'paid' THEN 'paid_hold' ELSE v.status END::text;
END
$record_hyp_verification$;

-- 3.5 Atomic finalization: one paid intent → exactly one order, created from the stored snapshot, in ONE transaction.
-- The caller passes only the intent id (and a staff user for a held intent); nothing about the order.
CREATE FUNCTION public.finalize_paid_intent(p_intent_id uuid, p_staff_user text DEFAULT NULL)
RETURNS TABLE (result text, order_id uuid, order_number integer, daily_number integer)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '3s'
AS $finalize_paid_intent$
#variable_conflict use_column
DECLARE
  v        public.payment_intents%ROWTYPE;
  v_oid    uuid;
  v_ono    integer;
  v_dno    integer;
  v_state  text;
  v_msg    text;
  v_con    text;
  v_reason text;
  v_actor  text;
BEGIN
  IF p_intent_id IS NULL OR (p_staff_user IS NOT NULL AND p_staff_user !~ '^[a-z0-9_-]{2,32}$') THEN
    RETURN QUERY SELECT 'invalid_request'::text, NULL::uuid, NULL::integer, NULL::integer; RETURN;
  END IF;
  v_actor := CASE WHEN p_staff_user IS NULL THEN 'system:finalize' ELSE 'staff:' || p_staff_user END;
  SELECT pi.* INTO v FROM public.payment_intents AS pi WHERE pi.id = p_intent_id FOR UPDATE;   -- serializes finalizers
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::integer, NULL::integer; RETURN;
  END IF;
  IF v.status = 'finalized' THEN
    RETURN QUERY SELECT 'already_finalized'::text, o.id, o.order_number, o.daily_number FROM public.orders AS o WHERE o.id = v.order_id;
    RETURN;
  END IF;
  -- A late return never reaches the kitchen automatically.
  IF v.status = 'paid' AND p_staff_user IS NULL AND v.paid_at > v.expires_at + interval '30 minutes' THEN
    UPDATE public.payment_intents AS pi SET status = 'paid_hold', hold_reason = 'late_return', last_actor = v_actor WHERE pi.id = v.id;
    RETURN QUERY SELECT 'held:late_return'::text, NULL::uuid, NULL::integer, NULL::integer; RETURN;
  END IF;
  IF NOT (v.status = 'paid' OR (v.status = 'paid_hold' AND p_staff_user IS NOT NULL)) THEN
    RETURN QUERY SELECT ('not_finalizable:' || v.status)::text, NULL::uuid, NULL::integer, NULL::integer; RETURN;
  END IF;

  BEGIN   -- subtransaction: the order, its items / delivery / parcel and the link commit together or not at all
    IF v.order_kind = 'parcel' THEN
      SELECT c.created_order_id, c.created_order_number, c.created_daily_number INTO STRICT v_oid, v_ono, v_dno
        FROM public.create_order_with_parcel(v.snapshot -> 'p_order', v.snapshot -> 'p_items',
                                             v.snapshot -> 'p_delivery', v.snapshot -> 'p_parcel') AS c;
    ELSE
      SELECT c.created_order_id, c.created_order_number, c.created_daily_number INTO STRICT v_oid, v_ono, v_dno
        FROM public.create_order(v.snapshot -> 'p_order', v.snapshot -> 'p_items', v.snapshot -> 'p_delivery') AS c;
    END IF;
    -- Defensive cross-check of what was stored against what was paid.
    IF NOT EXISTS (SELECT 1 FROM public.orders AS o
                    WHERE o.id = v_oid AND o.payment_method = 'online' AND o.branch_id = v.branch_id
                      AND o.total_price * 100 = v.amount_agorot AND o.status = 'received') THEN
      RAISE EXCEPTION 'finalize_order_mismatch' USING ERRCODE = 'P0001';
    END IF;
    UPDATE public.payment_intents AS pi
       SET status = 'finalized', order_id = v_oid, finalized_at = now(), finalize_attempts = pi.finalize_attempts + 1,
           last_error = NULL, staff_user = COALESCE(p_staff_user, pi.staff_user), last_actor = v_actor
     WHERE pi.id = v.id;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT, v_con = CONSTRAINT_NAME;
    v_reason := CASE WHEN v_state = '23505' AND v_con = 'parcel_requests_active_key_uq' THEN 'parcel_conflict' ELSE 'finalize_error' END;
    UPDATE public.payment_intents AS pi
       SET status = 'paid_hold', hold_reason = v_reason, finalize_attempts = pi.finalize_attempts + 1,
           last_error = left(v_state || ': ' || v_msg, 400), last_actor = v_actor
     WHERE pi.id = v.id;
    RETURN QUERY SELECT ('held:' || v_reason)::text, NULL::uuid, NULL::integer, NULL::integer; RETURN;
  END;
  RETURN QUERY SELECT 'finalized'::text, v_oid, v_ono, v_dno;
END
$finalize_paid_intent$;

-- 3.6 Expiry sweeper. created → not_sent (the redirect URL was never handed out); redirected → outcome_unknown.
-- Never decides that no charge happened.
CREATE FUNCTION public.sweep_expired_payment_intents(p_limit integer DEFAULT 200)
RETURNS TABLE (result text, intents integer)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '3s'
AS $sweep_expired_payment_intents$
#variable_conflict use_column
DECLARE
  v_n1 integer;
  v_n2 integer;
  v_lim integer := LEAST(GREATEST(COALESCE(p_limit, 200), 1), 1000);
BEGIN
  WITH due AS (SELECT pi.id FROM public.payment_intents AS pi WHERE pi.status = 'created' AND pi.expires_at <= now()
                ORDER BY pi.created_at LIMIT v_lim FOR UPDATE SKIP LOCKED)
  UPDATE public.payment_intents AS pi SET status = 'not_sent', last_actor = 'system:sweeper' FROM due WHERE pi.id = due.id;
  GET DIAGNOSTICS v_n1 = ROW_COUNT;
  WITH due AS (SELECT pi.id FROM public.payment_intents AS pi WHERE pi.status = 'redirected' AND pi.expires_at <= now()
                ORDER BY pi.created_at LIMIT v_lim FOR UPDATE SKIP LOCKED)
  UPDATE public.payment_intents AS pi SET status = 'outcome_unknown', last_actor = 'system:sweeper' FROM due WHERE pi.id = due.id;
  GET DIAGNOSTICS v_n2 = ROW_COUNT;
  RETURN QUERY VALUES ('not_sent'::text, v_n1), ('outcome_unknown'::text, v_n2);
END
$sweep_expired_payment_intents$;

-- 3.7 Staff reconciliation (called only by an authenticated kitchen-admin route). Every action is attributed.
--   portal_paid      unknown / rejected / declined / no_charge_found → paid (+ paid_hold manual_confirmation) or
--                    paid_amount_mismatch; records the HYP portal transaction. Never finalizes by itself.
--   no_charge_found  unknown / rejected → no_charge_found (portal checked; note required)
--   hold             paid → paid_hold (manual)
--   void / refund    held / mismatch / finalized → records a reversal ALREADY PERFORMED at HYP (its reference is the
--                    evidence; one record per reference); the intent becomes voided / refunded only when the primary
--                    charge is fully reversed (an extra / duplicate charge leaves the status unchanged).
--   flag_refund_required / flag_investigation / clear_flag (HYP-09) — attention markers only: no status change and
--                    never a refund record ('refund_required' means money still has to be returned at HYP).
CREATE FUNCTION public.resolve_payment_intent(p_intent_id uuid, p_action text, p_staff_user text, p_note text,
                                              p_hyp_trans_id text DEFAULT NULL, p_amount_agorot integer DEFAULT NULL,
                                              p_transaction_id uuid DEFAULT NULL, p_reference text DEFAULT NULL)
RETURNS TABLE (result text, intent_status text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '3s'
AS $resolve_payment_intent$
#variable_conflict use_column
DECLARE
  v        public.payment_intents%ROWTYPE;
  v_tx     public.payment_transactions%ROWTYPE;
  v_txid   uuid;
  v_actor  text;
  v_done   bigint;
BEGIN
  IF p_intent_id IS NULL OR p_staff_user IS NULL OR p_staff_user !~ '^[a-z0-9_-]{2,32}$'
     OR p_note IS NULL OR char_length(p_note) NOT BETWEEN 3 AND 500
     OR p_action IS NULL OR p_action NOT IN ('portal_paid', 'no_charge_found', 'hold', 'void', 'refund',
                                             'flag_refund_required', 'flag_investigation', 'clear_flag', 'note') THEN
    RETURN QUERY SELECT 'invalid_request'::text, NULL::text; RETURN;
  END IF;
  v_actor := 'staff:' || p_staff_user;
  SELECT pi.* INTO v FROM public.payment_intents AS pi WHERE pi.id = p_intent_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text; RETURN;
  END IF;

  IF p_action = 'portal_paid' THEN
    -- HYP-09 idempotency: the same portal confirmation again (same intent, HYP Id, amount) → already_recorded.
    IF EXISTS (SELECT 1 FROM public.payment_transactions AS t WHERE t.hyp_trans_id = p_hyp_trans_id AND t.intent_id = v.id
                AND t.source = 'portal' AND t.amount_agorot = p_amount_agorot) THEN
      RETURN QUERY SELECT 'already_recorded'::text, v.status; RETURN;
    END IF;
    IF v.status NOT IN ('redirected', 'returned', 'verify_rejected', 'outcome_unknown', 'declined', 'no_charge_found') THEN
      RETURN QUERY SELECT 'invalid_state'::text, v.status; RETURN;
    END IF;
    IF p_hyp_trans_id IS NULL OR p_hyp_trans_id !~ '^[0-9A-Za-z]{1,40}$' OR p_amount_agorot IS NULL OR p_amount_agorot NOT BETWEEN 1 AND 99999999 THEN
      RETURN QUERY SELECT 'invalid_request'::text, v.status; RETURN;
    END IF;
    IF EXISTS (SELECT 1 FROM public.payment_transactions AS t WHERE t.hyp_trans_id = p_hyp_trans_id) THEN
      RETURN QUERY SELECT 'trans_id_conflict'::text, v.status; RETURN;
    END IF;
    INSERT INTO public.payment_transactions (intent_id, return_id, hyp_trans_id, source, ccode, acode, amount_agorot, outcome, recorded_by)
    VALUES (v.id, NULL, p_hyp_trans_id, 'portal', '0', NULL, p_amount_agorot, 'approved', v_actor)
    RETURNING id INTO v_txid;
    IF p_amount_agorot <> v.amount_agorot THEN
      UPDATE public.payment_intents AS pi
         SET status = 'paid_amount_mismatch', paid_source = 'portal', paid_transaction_id = v_txid, paid_at = now(),
             staff_user = p_staff_user, staff_note = p_note, portal_checked_at = now(), last_actor = v_actor
       WHERE pi.id = v.id;
      RETURN QUERY SELECT 'amount_mismatch'::text, 'paid_amount_mismatch'::text; RETURN;
    END IF;
    UPDATE public.payment_intents AS pi
       SET status = 'paid', paid_source = 'portal', paid_transaction_id = v_txid, paid_at = now(),
           staff_user = p_staff_user, staff_note = p_note, portal_checked_at = now(), last_actor = v_actor
     WHERE pi.id = v.id;
    UPDATE public.payment_intents AS pi SET status = 'paid_hold', hold_reason = 'manual_confirmation', last_actor = v_actor
     WHERE pi.id = v.id;
    RETURN QUERY SELECT 'recorded'::text, 'paid_hold'::text; RETURN;
  END IF;

  IF p_action = 'no_charge_found' THEN
    IF v.status NOT IN ('returned', 'verify_rejected', 'outcome_unknown') THEN
      RETURN QUERY SELECT 'invalid_state'::text, v.status; RETURN;
    END IF;
    UPDATE public.payment_intents AS pi
       SET status = 'no_charge_found', staff_user = p_staff_user, staff_note = p_note, portal_checked_at = now(),
           resolved_at = now(), last_actor = v_actor
     WHERE pi.id = v.id;
    RETURN QUERY SELECT 'recorded'::text, 'no_charge_found'::text; RETURN;
  END IF;

  IF p_action = 'hold' THEN
    IF v.status <> 'paid' THEN
      RETURN QUERY SELECT 'invalid_state'::text, v.status; RETURN;
    END IF;
    UPDATE public.payment_intents AS pi
       SET status = 'paid_hold', hold_reason = 'manual', staff_user = p_staff_user, staff_note = p_note, last_actor = v_actor
     WHERE pi.id = v.id;
    RETURN QUERY SELECT 'recorded'::text, 'paid_hold'::text; RETURN;
  END IF;

  -- HYP-09: attention markers — never a refund record, never a status change.
  IF p_action IN ('flag_refund_required', 'flag_investigation') THEN
    IF (p_action = 'flag_refund_required' AND v.status NOT IN ('paid', 'paid_hold', 'paid_amount_mismatch', 'finalized'))
       OR v.status IN ('created', 'not_sent') THEN
      RETURN QUERY SELECT 'invalid_state'::text, v.status; RETURN;
    END IF;
    IF v.staff_flag IS NOT DISTINCT FROM (CASE WHEN p_action = 'flag_refund_required' THEN 'refund_required' ELSE 'investigation' END) THEN
      RETURN QUERY SELECT 'already_flagged'::text, v.status; RETURN;
    END IF;
    UPDATE public.payment_intents AS pi
       SET staff_flag = CASE WHEN p_action = 'flag_refund_required' THEN 'refund_required' ELSE 'investigation' END,
           staff_flag_note = p_note, staff_flag_by = p_staff_user, staff_flag_at = now(), last_actor = v_actor
     WHERE pi.id = v.id;
    RETURN QUERY SELECT 'recorded'::text, v.status; RETURN;
  END IF;
  -- HYP-09: a staff note into the append-only trail (e.g. the reason recorded before a staff finalize).
  IF p_action = 'note' THEN
    IF v.status IN ('created', 'not_sent') THEN
      RETURN QUERY SELECT 'invalid_state'::text, v.status; RETURN;
    END IF;
    UPDATE public.payment_intents AS pi SET staff_user = p_staff_user, staff_note = p_note, last_actor = v_actor WHERE pi.id = v.id;
    RETURN QUERY SELECT 'recorded'::text, v.status; RETURN;
  END IF;
  IF p_action = 'clear_flag' THEN
    IF v.staff_flag IS NULL THEN
      RETURN QUERY SELECT 'not_flagged'::text, v.status; RETURN;
    END IF;
    UPDATE public.payment_intents AS pi
       SET staff_flag = NULL, staff_flag_note = p_note, staff_flag_by = p_staff_user, staff_flag_at = now(), last_actor = v_actor
     WHERE pi.id = v.id;
    RETURN QUERY SELECT 'recorded'::text, v.status; RETURN;
  END IF;

  -- void / refund: records a reversal ALREADY PERFORMED at HYP (reference required). Idempotent per HYP reference.
  IF p_reference IS NOT NULL AND EXISTS (SELECT 1 FROM public.payment_reversals AS rv WHERE rv.hyp_reference = p_reference) THEN
    RETURN QUERY SELECT CASE WHEN EXISTS (SELECT 1 FROM public.payment_reversals AS rv WHERE rv.hyp_reference = p_reference
                                            AND rv.intent_id = v.id AND rv.transaction_id IS NOT DISTINCT FROM p_transaction_id
                                            AND rv.kind = p_action AND rv.amount_agorot = p_amount_agorot)
                             THEN 'already_recorded' ELSE 'reference_conflict' END::text, v.status;
    RETURN;
  END IF;
  IF v.status NOT IN ('paid_hold', 'paid_amount_mismatch', 'finalized') THEN
    RETURN QUERY SELECT 'invalid_state'::text, v.status; RETURN;
  END IF;
  IF p_transaction_id IS NULL OR p_amount_agorot IS NULL OR p_reference IS NULL OR p_reference !~ '^[0-9A-Za-z_-]{1,40}$' THEN
    RETURN QUERY SELECT 'invalid_request'::text, v.status; RETURN;
  END IF;
  SELECT t.* INTO v_tx FROM public.payment_transactions AS t
   WHERE t.id = p_transaction_id AND t.intent_id = v.id AND t.outcome = 'approved';
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'transaction_not_found'::text, v.status; RETURN;
  END IF;
  SELECT COALESCE(sum(rv.amount_agorot), 0) INTO v_done FROM public.payment_reversals AS rv WHERE rv.transaction_id = v_tx.id;
  IF p_amount_agorot < 1 OR v_done + p_amount_agorot > v_tx.amount_agorot THEN
    RETURN QUERY SELECT 'amount_exceeds_charge'::text, v.status; RETURN;
  END IF;
  BEGIN
    INSERT INTO public.payment_reversals (intent_id, transaction_id, kind, amount_agorot, hyp_reference, staff_user, note)
    VALUES (v.id, v_tx.id, p_action, p_amount_agorot, p_reference, p_staff_user, p_note);
  EXCEPTION WHEN unique_violation THEN
    -- the same HYP reference was recorded concurrently for another intent: never merged
    RETURN QUERY SELECT 'reference_conflict'::text, v.status; RETURN;
  END;
  IF v_tx.id = v.paid_transaction_id AND v_done + p_amount_agorot = v_tx.amount_agorot THEN
    UPDATE public.payment_intents AS pi
       SET status = CASE WHEN p_action = 'void' THEN 'voided' ELSE 'refunded' END, staff_user = p_staff_user,
           staff_note = p_note, resolved_at = now(), last_actor = v_actor
     WHERE pi.id = v.id;
    RETURN QUERY SELECT 'reversed'::text, CASE WHEN p_action = 'void' THEN 'voided' ELSE 'refunded' END::text; RETURN;
  END IF;
  RETURN QUERY SELECT 'reversal_recorded'::text, v.status;
END
$resolve_payment_intent$;

REVOKE ALL ON FUNCTION public.create_payment_intent(uuid, text, text, jsonb, integer, integer),
                       public.record_hyp_sign_result(uuid, boolean),
                       public.record_hyp_return(text),
                       public.record_hyp_verification(uuid, text, text),
                       public.finalize_paid_intent(uuid, text),
                       public.sweep_expired_payment_intents(integer),
                       public.resolve_payment_intent(uuid, text, text, text, text, integer, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_payment_intent(uuid, text, text, jsonb, integer, integer),
                          public.record_hyp_sign_result(uuid, boolean),
                          public.record_hyp_return(text),
                          public.record_hyp_verification(uuid, text, text),
                          public.finalize_paid_intent(uuid, text),
                          public.sweep_expired_payment_intents(integer),
                          public.resolve_payment_intent(uuid, text, text, text, text, integer, uuid, text)
  TO service_role;
-- ownership last: the installer loses control of the ACL once the coordinator owns them (grantor is rewritten).
ALTER FUNCTION public.create_payment_intent(uuid, text, text, jsonb, integer, integer) OWNER TO hyp_payment_coordinator;
ALTER FUNCTION public.record_hyp_sign_result(uuid, boolean) OWNER TO hyp_payment_coordinator;
ALTER FUNCTION public.record_hyp_return(text) OWNER TO hyp_payment_coordinator;
ALTER FUNCTION public.record_hyp_verification(uuid, text, text) OWNER TO hyp_payment_coordinator;
ALTER FUNCTION public.finalize_paid_intent(uuid, text) OWNER TO hyp_payment_coordinator;
ALTER FUNCTION public.sweep_expired_payment_intents(integer) OWNER TO hyp_payment_coordinator;
ALTER FUNCTION public.resolve_payment_intent(uuid, text, text, text, text, integer, uuid, text) OWNER TO hyp_payment_coordinator;

REVOKE CREATE ON SCHEMA public FROM hyp_payment_coordinator;   -- only needed for the ALTER … OWNER above

-- ─── Post-check (same transaction; any mismatch rolls everything back) ────────────────────────────────────────────
DO $hyp05_postcheck$
DECLARE
  v_fn  text[] := ARRAY['public.create_payment_intent(uuid, text, text, jsonb, integer, integer)',
                        'public.record_hyp_sign_result(uuid, boolean)', 'public.record_hyp_return(text)',
                        'public.record_hyp_verification(uuid, text, text)', 'public.finalize_paid_intent(uuid, text)',
                        'public.sweep_expired_payment_intents(integer)',
                        'public.resolve_payment_intent(uuid, text, text, text, text, integer, uuid, text)'];
  v_f   text;
  v_oid oid;
  v_t   text;
BEGIN
  FOREACH v_f IN ARRAY v_fn LOOP
    v_oid := to_regprocedure(v_f);
    IF v_oid IS NULL OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_oid)
       OR (SELECT proowner::regrole::text FROM pg_proc WHERE oid = v_oid) IS DISTINCT FROM 'hyp_payment_coordinator'
       OR (SELECT proconfig FROM pg_proc WHERE oid = v_oid) IS DISTINCT FROM ARRAY['search_path=""', 'lock_timeout=3s']
       OR NOT has_function_privilege('service_role', v_oid, 'EXECUTE')
       OR has_function_privilege('anon', v_oid, 'EXECUTE') OR has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'hyp05_postcheck: % is not a service_role-only SECURITY DEFINER function owned by the coordinator', v_f;
    END IF;
  END LOOP;
  FOREACH v_t IN ARRAY ARRAY['payment_intents', 'payment_returns', 'payment_transactions', 'payment_reversals', 'payment_intent_events'] LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || v_t)::regclass)
       OR EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = ('public.' || v_t)::regclass)
       OR has_any_column_privilege('anon', 'public.' || v_t, 'SELECT') OR has_any_column_privilege('authenticated', 'public.' || v_t, 'SELECT')
       OR has_any_column_privilege('service_role', 'public.' || v_t, 'INSERT') OR has_any_column_privilege('service_role', 'public.' || v_t, 'UPDATE')
       OR has_table_privilege('service_role', 'public.' || v_t, 'DELETE') OR has_table_privilege('service_role', 'public.' || v_t, 'TRUNCATE')
       OR NOT has_table_privilege('service_role', 'public.' || v_t, 'SELECT') THEN
      RAISE EXCEPTION 'hyp05_postcheck: unexpected RLS / privileges on public.%', v_t;
    END IF;
  END LOOP;
  IF has_table_privilege('hyp_payment_coordinator', 'public.orders', 'SELECT')
     OR has_column_privilege('hyp_payment_coordinator', 'public.orders', 'phone', 'SELECT')
     OR has_column_privilege('hyp_payment_coordinator', 'public.orders', 'customer_name', 'SELECT')
     OR has_column_privilege('hyp_payment_coordinator', 'public.orders', 'status', 'UPDATE')
     OR has_table_privilege('hyp_payment_coordinator', 'public.orders', 'DELETE')
     OR has_any_column_privilege('hyp_payment_coordinator', 'public.deliveries', 'SELECT')
     OR has_any_column_privilege('hyp_payment_coordinator', 'public.order_items', 'SELECT') THEN
    RAISE EXCEPTION 'hyp05_postcheck: the coordinator must hold column-level privileges only';
  END IF;
  IF pg_has_role('service_role', 'hyp_payment_coordinator', 'MEMBER') OR pg_has_role('anon', 'hyp_payment_coordinator', 'MEMBER')
     OR pg_has_role('authenticated', 'hyp_payment_coordinator', 'MEMBER')
     OR EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member
                 WHERE m.roleid = 'hyp_payment_coordinator'::regrole AND r.rolname IN ('authenticator', 'service_role', 'anon', 'authenticated'))
     OR EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = 'hyp_payment_coordinator'::regrole) THEN
    RAISE EXCEPTION 'hyp05_postcheck: unexpected role membership of the coordinator';
  END IF;
  IF has_schema_privilege('hyp_payment_coordinator', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'hyp05_postcheck: the coordinator must not have CREATE on schema public';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.orders'::regclass AND tgenabled = 'O'
       AND tgname IN ('orders_online_payment_guard_insert', 'orders_online_payment_guard_update')) <> 2 THEN
    RAISE EXCEPTION 'hyp05_postcheck: orders guard triggers missing or disabled';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.create_order(jsonb, jsonb, jsonb)'::regprocedure)
       IS DISTINCT FROM 'db92e75f8bfdadb6d78be035da855996' THEN
    RAISE EXCEPTION 'hyp05_postcheck: create_order body changed';
  END IF;
END
$hyp05_postcheck$;

COMMIT;
