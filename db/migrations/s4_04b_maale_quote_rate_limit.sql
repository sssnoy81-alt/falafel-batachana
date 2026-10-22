-- FALAFEL BATACHANA — MAALE EXPRESS — s4_04b_maale_quote_rate_limit.sql (S4-INTEGRATIONS-04B1)
-- Durable, cross-instance rate limit for kitchen courier QUOTE requests (one dry_run quote per kitchen request).
--
-- REVIEW ONLY — NOT EXECUTED. Separate Production approval required. Run manually in the Supabase SQL editor as postgres.
-- Read-only checks: s4_04b_production_preflight.sql (before), s4_04b_verify.sql (after).
-- Emergency rollback (separate approval): s4_04b_rollback.sql.
--
-- ORDER: install this migration BEFORE deploying an application that calls consume_maale_quote_slot. The current
-- application never calls it, so installing it first changes nothing at runtime.
--
-- Adds (additive only — nothing existing is altered, no data is changed):
--   1. public.maale_dispatch_requests — append-only request ledger. One row per PERMITTED quote request:
--        id, order_id → orders(id), branch_id → branches(id), actor_username (kitchen ACCOUNT, not a person), created_at.
--      No customer data (no name / phone / address / amounts / provider payloads).
--      RLS on, no policies. Privileges: service_role SELECT + INSERT only (no UPDATE / DELETE → append-only for the app);
--      nothing for PUBLIC / anon / authenticated.
--   2. public.consume_maale_quote_slot(p_order_id uuid, p_branch_id uuid, p_actor text) RETURNS text
--      SECURITY INVOKER, search_path '', lock_timeout 3s, EXECUTE for service_role only.
--      Validates the order exists and belongs to p_branch_id, takes ONE transaction-scoped advisory lock (all callers
--      serialize, so the three counts + insert are atomic across Vercel instances / tablets), counts with database time
--      and inserts a ledger row ONLY when every limit allows it. Result is one of:
--        ok | invalid_request | order_not_found | branch_mismatch | order_limit | branch_limit | global_limit
--      Any SQL error (lock timeout, missing grant, …) raises → the caller must treat it as "not allowed" (fail closed).
--      Limits: 3 per order / 30 min, 20 per branch / 60 min, 40 globally / 60 min (sliding windows, permitted rows only).
--
-- NOT changed: public.delivery_dispatches (dispatch idempotency stays its UNIQUE row + compare-and-set claim; this
-- ledger can never authorize a dispatch), public.orders, public.branches, any existing row, trigger, policy or grant.
-- Advisory lock key: pg_advisory_xact_lock(1296122188, 1) — two-int4 form ('MAAL', 1). Two-int4 keys live in a separate
-- key class from the single-bigint form used elsewhere, so they cannot collide with create_order's lock.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ─── Preflight (read-only assertions; abort on any surprise) ──────────────────────────────────────────────────────
DO $s4_04b_preflight$
BEGIN
  IF to_regclass('public.orders') IS NULL OR to_regclass('public.branches') IS NULL THEN
    RAISE EXCEPTION 's4_04b_preflight: public.orders / public.branches missing';
  END IF;
  IF (SELECT data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'id') IS DISTINCT FROM 'uuid'
     OR (SELECT data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'branch_id') IS DISTINCT FROM 'uuid'
     OR (SELECT data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'branches' AND column_name = 'id') IS DISTINCT FROM 'uuid' THEN
    RAISE EXCEPTION 's4_04b_preflight: orders.id / orders.branch_id / branches.id are not all uuid';
  END IF;
  -- FK targets need a primary key / unique constraint on exactly (id).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = 'public.orders'::regclass AND c.contype IN ('p', 'u')
                  AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'public.orders'::regclass AND attname = 'id')]::int2[])
     OR NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = 'public.branches'::regclass AND c.contype IN ('p', 'u')
                  AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'public.branches'::regclass AND attname = 'id')]::int2[]) THEN
    RAISE EXCEPTION 's4_04b_preflight: orders(id) / branches(id) is not a primary key or unique key';
  END IF;
  IF to_regclass('public.maale_dispatch_requests') IS NOT NULL THEN
    RAISE EXCEPTION 's4_04b_preflight: public.maale_dispatch_requests already exists (no silent re-apply)';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'consume_maale_quote_slot') THEN
    RAISE EXCEPTION 's4_04b_preflight: public.consume_maale_quote_slot already exists (any overload)';
  END IF;
  IF (SELECT count(*) FROM pg_roles WHERE rolname IN ('service_role', 'anon', 'authenticated')) <> 3 THEN
    RAISE EXCEPTION 's4_04b_preflight: expected roles service_role / anon / authenticated';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.orders', 'SELECT') THEN
    RAISE EXCEPTION 's4_04b_preflight: service_role cannot SELECT public.orders (SECURITY INVOKER function needs it)';
  END IF;
END
$s4_04b_preflight$;

-- ─── 1. Ledger ─────────────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.maale_dispatch_requests (
  id             uuid        NOT NULL DEFAULT gen_random_uuid(),
  order_id       uuid        NOT NULL,
  branch_id      uuid        NOT NULL,
  actor_username text        NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT maale_dispatch_requests_pkey PRIMARY KEY (id),
  CONSTRAINT maale_dispatch_requests_order_id_fkey
    FOREIGN KEY (order_id) REFERENCES public.orders (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT maale_dispatch_requests_branch_id_fkey
    FOREIGN KEY (branch_id) REFERENCES public.branches (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- Same rule as kitchen_users.username / lib/kitchenAuth USERNAME_REGEX.
  CONSTRAINT maale_dispatch_requests_actor_format CHECK (actor_username ~ '^[a-z0-9_-]{2,32}$')
);

CREATE INDEX maale_dispatch_requests_created_at_idx        ON public.maale_dispatch_requests (created_at);
CREATE INDEX maale_dispatch_requests_order_created_at_idx  ON public.maale_dispatch_requests (order_id, created_at);
CREATE INDEX maale_dispatch_requests_branch_created_at_idx ON public.maale_dispatch_requests (branch_id, created_at);

COMMENT ON TABLE public.maale_dispatch_requests IS
  'S4-04B: append-only ledger of PERMITTED kitchen courier quote requests (rate limit + account attribution). '
  'No customer data. actor_username is a kitchen ACCOUNT, not necessarily one person. Never authorizes a dispatch.';

ALTER TABLE public.maale_dispatch_requests ENABLE ROW LEVEL SECURITY;  -- no policies: only RLS-bypassing roles read it
-- Supabase default privileges grant ALL on new public tables to anon / authenticated / service_role → reset, then grant.
REVOKE ALL ON public.maale_dispatch_requests FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.maale_dispatch_requests TO service_role;

-- ─── 2. Atomic slot function ─────────────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION public.consume_maale_quote_slot(p_order_id uuid, p_branch_id uuid, p_actor text)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
SET lock_timeout = '3s'
AS $consume_maale_quote_slot$
DECLARE
  v_branch uuid;
  v_now    timestamptz;
BEGIN
  -- Input shape (no dynamic SQL anywhere; parameters are only compared / inserted).
  IF p_order_id IS NULL OR p_branch_id IS NULL OR p_actor IS NULL OR p_actor !~ '^[a-z0-9_-]{2,32}$' THEN
    RETURN 'invalid_request';
  END IF;

  -- The order must exist and belong to the claimed branch (the branch is never taken on trust).
  SELECT o.branch_id INTO v_branch FROM public.orders AS o WHERE o.id = p_order_id;
  IF NOT FOUND THEN
    RETURN 'order_not_found';
  END IF;
  IF v_branch IS DISTINCT FROM p_branch_id THEN
    RETURN 'branch_mismatch';
  END IF;

  -- One transaction-scoped lock for every caller: the global limit needs all requests serialized anyway, the volume
  -- is tiny (≤ 40 / hour) and the lock is released at COMMIT / ROLLBACK (no session leak through pooled connections).
  -- After the lock, each statement's snapshot includes every row committed by the previous holder (READ COMMITTED).
  PERFORM pg_catalog.pg_advisory_xact_lock(1296122188, 1);
  v_now := pg_catalog.clock_timestamp();  -- database time, read after the lock

  IF (SELECT pg_catalog.count(*) FROM public.maale_dispatch_requests AS r
       WHERE r.order_id = p_order_id AND r.created_at > v_now - interval '30 minutes') >= 3 THEN
    RETURN 'order_limit';
  END IF;
  IF (SELECT pg_catalog.count(*) FROM public.maale_dispatch_requests AS r
       WHERE r.branch_id = p_branch_id AND r.created_at > v_now - interval '60 minutes') >= 20 THEN
    RETURN 'branch_limit';
  END IF;
  IF (SELECT pg_catalog.count(*) FROM public.maale_dispatch_requests AS r
       WHERE r.created_at > v_now - interval '60 minutes') >= 40 THEN
    RETURN 'global_limit';
  END IF;

  INSERT INTO public.maale_dispatch_requests (order_id, branch_id, actor_username, created_at)
  VALUES (p_order_id, p_branch_id, p_actor, v_now);
  RETURN 'ok';
END
$consume_maale_quote_slot$;

COMMENT ON FUNCTION public.consume_maale_quote_slot(uuid, uuid, text) IS
  'S4-04B: atomically consumes one kitchen quote slot (3/order/30min, 20/branch/60min, 40/global/60min). '
  'Returns ok | invalid_request | order_not_found | branch_mismatch | order_limit | branch_limit | global_limit; '
  'raises on any SQL error (callers fail closed). Never contacts a provider; never touches orders or delivery_dispatches.';

-- Postgres grants EXECUTE to PUBLIC by default and Supabase adds anon / authenticated / service_role → reset, then grant.
REVOKE ALL ON FUNCTION public.consume_maale_quote_slot(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.consume_maale_quote_slot(uuid, uuid, text) TO service_role;

-- ─── Post-check (same transaction; any mismatch rolls everything back) ────────────────────────────────────────────
DO $s4_04b_postcheck$
DECLARE
  v_fn oid := 'public.consume_maale_quote_slot(uuid, uuid, text)'::regprocedure;
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.maale_dispatch_requests'::regclass) THEN
    RAISE EXCEPTION 's4_04b_postcheck: RLS not enabled';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.maale_dispatch_requests'::regclass) THEN
    RAISE EXCEPTION 's4_04b_postcheck: unexpected policy';
  END IF;
  IF NOT (has_table_privilege('service_role', 'public.maale_dispatch_requests', 'SELECT')
          AND has_table_privilege('service_role', 'public.maale_dispatch_requests', 'INSERT'))
     OR has_table_privilege('service_role', 'public.maale_dispatch_requests', 'UPDATE')
     OR has_table_privilege('service_role', 'public.maale_dispatch_requests', 'DELETE')
     OR has_table_privilege('service_role', 'public.maale_dispatch_requests', 'TRUNCATE')
     OR has_table_privilege('anon', 'public.maale_dispatch_requests', 'SELECT,INSERT,UPDATE,DELETE')
     OR has_table_privilege('authenticated', 'public.maale_dispatch_requests', 'SELECT,INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 's4_04b_postcheck: unexpected table privileges';
  END IF;
  IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE')
     OR has_function_privilege('anon', v_fn, 'EXECUTE')
     OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 's4_04b_postcheck: unexpected function EXECUTE privileges';
  END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE oid = v_fn)
     OR (SELECT proconfig FROM pg_proc WHERE oid = v_fn) IS DISTINCT FROM ARRAY['search_path=""', 'lock_timeout=3s'] THEN
    RAISE EXCEPTION 's4_04b_postcheck: function must be SECURITY INVOKER with search_path '''' and lock_timeout 3s';
  END IF;
END
$s4_04b_postcheck$;

COMMIT;
