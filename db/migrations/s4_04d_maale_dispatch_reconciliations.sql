-- FALAFEL BATACHANA — MAALE EXPRESS — s4_04d_maale_dispatch_reconciliations.sql (S4-INTEGRATIONS-04D1)
-- Append-only reconciliation / cancellation AUDIT LEDGER for courier dispatches (manual operational records).
--
-- REVIEW ONLY — NOT EXECUTED. Separate Production approval required. Run manually in the Supabase SQL editor as postgres.
-- Read-only checks: s4_04d_production_preflight.sql (before), s4_04d_verify.sql (after).
-- Emergency rollback (separate approval): s4_04d_rollback.sql.
--
-- ORDER: install BEFORE deploying an application that reads or writes the ledger. The current application never does.
--
-- WHAT A ROW MEANS: an authorized kitchen ACCOUNT recorded what it learned (mostly by phone) from Maale Express or did
-- outside the app. It is an operational record, NOT independently verified provider truth, and it never changes
-- public.delivery_dispatches: a 'sent' dispatch stays 'sent' forever; "cancelled at the provider" is expressed ONLY by a
-- ledger row. Nothing here can retry, reset or re-dispatch anything.
--
-- Adds (additive only — nothing existing is altered, no data is changed):
--   public.maale_dispatch_reconciliations
--     id uuid PK · request_id uuid NOT NULL UNIQUE (S4-04D3 idempotency key, one per user-confirmed action) ·
--     order_id uuid NOT NULL → orders(id) RESTRICT · event_type (closed list, CHECK) ·
--     actor_username (kitchen account rule) · provider_order_id (safe id; required / forbidden per event) ·
--     provider_status (safe code; only for provider_status_checked) · reason_code (closed list, optional) ·
--     created_at timestamptz NOT NULL DEFAULT now()
--   No free text (no note column): a bounded reason code can never carry a name, phone, address or provider body.
--   No dispatch_id: delivery_dispatches.order_id is UNIQUE and rows are never replaced, so order_id already identifies the
--   dispatch (and the ledger does not depend on a table created outside these migrations). Manual-courier rows need no
--   dispatch row at all.
--   RLS on, no policies. service_role SELECT + INSERT only (no UPDATE / DELETE / TRUNCATE → append-only for the app);
--   nothing for PUBLIC / anon / authenticated. No triggers, no functions.
--
-- NOT changed: public.delivery_dispatches, public.orders, public.maale_dispatch_requests, any row, trigger, policy, grant.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ─── Preflight (read-only assertions; abort on any surprise) ──────────────────────────────────────────────────────
DO $s4_04d_preflight$
BEGIN
  IF to_regclass('public.orders') IS NULL THEN
    RAISE EXCEPTION 's4_04d_preflight: public.orders missing';
  END IF;
  IF (SELECT data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'id') IS DISTINCT FROM 'uuid' THEN
    RAISE EXCEPTION 's4_04d_preflight: orders.id is not uuid';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = 'public.orders'::regclass AND c.contype IN ('p', 'u')
                  AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'public.orders'::regclass AND attname = 'id')]::int2[]) THEN
    RAISE EXCEPTION 's4_04d_preflight: orders(id) is not a primary key or unique key';
  END IF;
  IF to_regclass('public.maale_dispatch_reconciliations') IS NOT NULL THEN
    RAISE EXCEPTION 's4_04d_preflight: public.maale_dispatch_reconciliations already exists (no silent re-apply)';
  END IF;
  IF (SELECT count(*) FROM pg_roles WHERE rolname IN ('service_role', 'anon', 'authenticated')) <> 3 THEN
    RAISE EXCEPTION 's4_04d_preflight: expected roles service_role / anon / authenticated';
  END IF;
END
$s4_04d_preflight$;

-- ─── Ledger ────────────────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.maale_dispatch_reconciliations (
  id                uuid        NOT NULL DEFAULT gen_random_uuid(),
  request_id        uuid        NOT NULL,  -- S4-04D3: one per user-confirmed action (browser retries reuse it)
  order_id          uuid        NOT NULL,
  event_type        text        NOT NULL,
  actor_username    text        NOT NULL,
  provider_order_id text        NULL,
  provider_status   text        NULL,
  reason_code       text        NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT maale_dispatch_reconciliations_pkey PRIMARY KEY (id),
  -- S4-04D3: the FINAL atomic guard against duplicate records — concurrent identical requests insert at most one row;
  -- the application resolves a conflict by comparing the stored row (same payload → already recorded, else refused).
  CONSTRAINT maale_dispatch_reconciliations_request_id_key UNIQUE (request_id),
  CONSTRAINT maale_dispatch_reconciliations_order_id_fkey
    FOREIGN KEY (order_id) REFERENCES public.orders (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- Closed list. None of these means "the app cancelled at the provider": cancellation is always a manual phone action.
  CONSTRAINT maale_dispatch_reconciliations_event_type_check CHECK (event_type IN (
    'confirmed_sent', 'cancelled_at_provider', 'not_received', 'manual_courier',
    'provider_status_checked', 'manual_review_opened', 'manual_review_resolved')),
  -- Same rule as kitchen_users.username / lib/kitchenAuth USERNAME_REGEX (an ACCOUNT, not a verified person).
  CONSTRAINT maale_dispatch_reconciliations_actor_format CHECK (actor_username ~ '^[a-z0-9_-]{2,32}$'),
  -- Provider ids / statuses: the same safe shapes the controlled runner prints (no raw provider text).
  CONSTRAINT maale_dispatch_reconciliations_provider_order_id_format
    CHECK (provider_order_id IS NULL OR provider_order_id ~ '^[A-Za-z0-9_-]{1,100}$'),
  CONSTRAINT maale_dispatch_reconciliations_provider_status_format
    CHECK (provider_status IS NULL OR provider_status ~ '^[a-z_]{1,40}$'),
  -- Event-specific shape: what the provider confirmed must name its order; what the provider never had must not.
  CONSTRAINT maale_dispatch_reconciliations_provider_order_id_rule CHECK (
    (event_type IN ('confirmed_sent', 'cancelled_at_provider') AND provider_order_id IS NOT NULL)
    OR (event_type IN ('not_received', 'manual_courier') AND provider_order_id IS NULL)
    OR event_type IN ('provider_status_checked', 'manual_review_opened', 'manual_review_resolved')),
  CONSTRAINT maale_dispatch_reconciliations_provider_status_rule
    CHECK (provider_status IS NULL OR event_type = 'provider_status_checked'),
  -- Optional bounded reason (no free text, so no personal data can be typed in).
  CONSTRAINT maale_dispatch_reconciliations_reason_code_check CHECK (reason_code IS NULL OR reason_code IN (
    'provider_phone_confirmed', 'provider_dashboard_confirmed', 'customer_cancelled', 'kitchen_cancelled',
    'outcome_unknown', 'persistence_failed', 'duplicate_suspected', 'courier_booked_by_phone', 'other'))
);

CREATE INDEX maale_dispatch_reconciliations_order_created_at_idx
  ON public.maale_dispatch_reconciliations (order_id, created_at DESC, id DESC);  -- latest event per order
CREATE INDEX maale_dispatch_reconciliations_created_at_idx
  ON public.maale_dispatch_reconciliations (created_at);                          -- daily review / retention

COMMENT ON TABLE public.maale_dispatch_reconciliations IS
  'S4-04D: append-only manual reconciliation / cancellation records for courier dispatches. An operational record by a '
  'kitchen ACCOUNT, not verified provider truth. Never changes delivery_dispatches; never retries or re-dispatches. '
  'No customer data, no free text, no provider bodies.';

ALTER TABLE public.maale_dispatch_reconciliations ENABLE ROW LEVEL SECURITY;  -- no policies
-- Supabase default privileges grant ALL on new public tables to anon / authenticated / service_role → reset, then grant.
REVOKE ALL ON public.maale_dispatch_reconciliations FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.maale_dispatch_reconciliations TO service_role;

-- ─── Post-check (same transaction; any mismatch rolls everything back) ────────────────────────────────────────────
DO $s4_04d_postcheck$
DECLARE
  t regclass := 'public.maale_dispatch_reconciliations'::regclass;
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = t) OR EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = t) THEN
    RAISE EXCEPTION 's4_04d_postcheck: RLS must be on with no policies';
  END IF;
  IF NOT (has_table_privilege('service_role', t, 'SELECT') AND has_table_privilege('service_role', t, 'INSERT'))
     OR has_table_privilege('service_role', t, 'UPDATE') OR has_table_privilege('service_role', t, 'DELETE')
     OR has_table_privilege('service_role', t, 'TRUNCATE')
     OR has_table_privilege('anon', t, 'SELECT,INSERT,UPDATE,DELETE')
     OR has_table_privilege('authenticated', t, 'SELECT,INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 's4_04d_postcheck: unexpected table privileges';
  END IF;
  IF (SELECT count(*) FROM pg_constraint WHERE conrelid = t) <> 10 THEN
    RAISE EXCEPTION 's4_04d_postcheck: expected exactly 10 constraints';
  END IF;
END
$s4_04d_postcheck$;

COMMIT;
