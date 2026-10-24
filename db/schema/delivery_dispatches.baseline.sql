DO $$
BEGIN
  RAISE EXCEPTION 'Documentation only — do not execute against Production';
END $$;

-- FALAFEL BATACHANA — public.delivery_dispatches — SCHEMA BASELINE (S4-INTEGRATIONS-03J / 03J2)
--
-- DOCUMENTATION ONLY. THIS IS NOT A MIGRATION.
--   * The table ALREADY EXISTS in Production (created outside this repository; no migration file ever recorded it —
--     see db/migrations/README.md, "Schema documented outside migrations").
--   * Never apply this file to Production or to any database that has the table. The DO block above aborts on purpose.
--   * A fresh environment needs its own reviewed migration (preflight / verify / rollback), not this file.
--   * Changes to the Production table (e.g. a future request_sha256 / next_attempt_at column) need their own additive
--     migration with preflight / verify / rollback and separate approval.
--
-- SOURCE OF TRUTH: the owner's read-only Production verification with db/migrations/s4_03_dispatch_readiness_verify.sql
-- (INFO 03 columns, INFO 09 constraints, INFO 10 indexes, rows 11–14 security), transcribed in S4-INTEGRATIONS-03J2.
-- Everything below is that evidence unless marked UNVERIFIED or INFERRED. Contains no customer data and no credentials.

CREATE TABLE public.delivery_dispatches (
  id                uuid        NOT NULL DEFAULT gen_random_uuid(),
  order_id          uuid        NOT NULL,
  external_order_id text        NOT NULL,
  provider          text        NOT NULL DEFAULT 'maale_express',
  status            text        NOT NULL DEFAULT 'pending',
  attempts          integer     NOT NULL DEFAULT 0,
  last_attempt_at   timestamptz NULL,
  dispatched_at     timestamptz NULL,
  error_code        text        NULL,
  provider_order_id text        NULL,
  provider_status   text        NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  -- Column ORDER above is for readability; the physical column order in Production is UNVERIFIED (not needed by the app).

  CONSTRAINT delivery_dispatches_pkey PRIMARY KEY (id),
  CONSTRAINT delivery_dispatches_order_id_key UNIQUE (order_id),
  CONSTRAINT delivery_dispatches_external_order_id_key UNIQUE (external_order_id),
  -- Verified definition text: "FOREIGN KEY (order_id) REFERENCES orders(id)". INFERRED: pg_get_constraintdef prints
  -- ON DELETE / ON UPDATE / MATCH / DEFERRABLE only when they differ from the defaults, so the actions are
  -- NO ACTION / NO ACTION, MATCH SIMPLE, NOT DEFERRABLE.
  CONSTRAINT delivery_dispatches_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders (id),
  -- Phase 1 rule: the provider idempotency key is the order id itself (lib/maaleDispatch.ts never regenerates it).
  CONSTRAINT delivery_dispatches_external_order_id_phase1_check CHECK (external_order_id = order_id::text),
  CONSTRAINT delivery_dispatches_provider_check CHECK (provider = 'maale_express'),
  CONSTRAINT delivery_dispatches_attempts_check CHECK (attempts >= 0 AND attempts <= 20),
  -- Verified as "status belongs to the five states"; the exact Production text (IN (…) vs = ANY (ARRAY[…])) is UNVERIFIED
  -- and semantically equivalent.
  CONSTRAINT delivery_dispatches_status_check
    CHECK (status IN ('pending', 'sending', 'sent', 'failed_retryable', 'failed_final')),
  -- Verified as "matches"; the regex operator spelling (~) is the standard form, exact Production text UNVERIFIED.
  CONSTRAINT delivery_dispatches_error_code_format_check
    CHECK (error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,64}$'),
  CONSTRAINT delivery_dispatches_provider_status_format_check
    CHECK (provider_status IS NULL OR provider_status ~ '^[a-z_]{1,40}$'),
  CONSTRAINT delivery_dispatches_provider_order_id_length_check
    CHECK (provider_order_id IS NULL OR char_length(provider_order_id) BETWEEN 1 AND 100),
  CONSTRAINT delivery_dispatches_sending_has_attempt_at_check
    CHECK (status <> 'sending' OR last_attempt_at IS NOT NULL),
  CONSTRAINT delivery_dispatches_sent_has_dispatched_at_check
    CHECK (status <> 'sent' OR dispatched_at IS NOT NULL)
);

-- Indexes (verified, INFO 10) — exactly the three created by the constraints above; no other index exists:
--   delivery_dispatches_pkey                  UNIQUE btree (id)
--   delivery_dispatches_order_id_key          UNIQUE btree (order_id)
--   delivery_dispatches_external_order_id_key UNIQUE btree (external_order_id)

-- Row level security and privileges (verified, rows 11–14).
ALTER TABLE public.delivery_dispatches ENABLE ROW LEVEL SECURITY;   -- FORCE ROW LEVEL SECURITY: false (not forced)
-- No policies exist (row 12): with RLS on and no policy, only roles that bypass RLS (service_role, postgres) can read
-- or write rows.
-- service_role is included in the REVOKE because Supabase default privileges grant it ALL on new tables; Production
-- holds exactly SELECT, INSERT, UPDATE (verified).
REVOKE ALL ON public.delivery_dispatches FROM PUBLIC, anon, authenticated, service_role;  -- verified: none for PUBLIC / anon / authenticated
GRANT SELECT, INSERT, UPDATE ON public.delivery_dispatches TO service_role;               -- verified: exactly these three
-- postgres was listed as the owner / privileged role with broader (owner) privileges. INFERRED: postgres owns the
-- table; the exact owner name and its privilege list are not reproduced here.

-- Triggers: none were reported in the verification summary (row 15 is INFO-only) — UNVERIFIED that none exist.
-- Table / column comments, tablespace, storage parameters: UNVERIFIED (not part of the verification).

-- How the application uses this table (lib/maaleDispatch.ts, S4-03F/03G — not wired to any app route):
--   It never reads or writes id or created_at (both filled by their defaults).
--   insertPending → INSERT (order_id, external_order_id = order_id, provider 'maale_express', status 'pending')
--                   ON CONFLICT (order_id) DO NOTHING                     [satisfies the phase1 and provider checks]
--   claim         → UPDATE … status 'sending', attempts + 1, last_attempt_at, updated_at WHERE status / attempts /
--                   last_attempt_at unchanged (compare-and-set; exactly one row)  [sending_has_attempt_at, attempts ≤ 20]
--   markSent      → UPDATE … status 'sent', dispatched_at, provider_order_id, provider_status, updated_at
--                   WHERE status = 'sending'                               [sent_has_dispatched_at, format checks]
--   markFailed    → UPDATE … status 'failed_retryable' | 'failed_final', error_code, updated_at WHERE status = 'sending'
--                   [error_code format: every client code and "rate_limited_after_<sec>" fit ^[a-z0-9_]{1,64}$]
--   A row that was ever submitted is never resent automatically (manual review); service_role has no DELETE and the
--   application never deletes or truncates rows.
