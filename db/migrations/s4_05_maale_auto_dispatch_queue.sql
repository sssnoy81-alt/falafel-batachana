-- FALAFEL BATACHANA — MAALE EXPRESS — s4_05_maale_auto_dispatch_queue.sql (S4-MAALE-03)
-- Durable, idempotent AUTO-DISPATCH QUEUE for courier requests after a kitchen order confirmation.
--
-- REVIEW ONLY — NOT EXECUTED. Separate Production approval required.
-- Order: s4_05_production_preflight.sql (all PASS) → this file → s4_05_verify.sql (all PASS).
-- Rollback (manual, approval-only): s4_05_rollback.sql.
--
-- What it adds (and nothing else — no change to public.orders columns / rows, public.delivery_dispatches,
-- public.maale_dispatch_requests, public.maale_dispatch_reconciliations, the claim functions or any HYP object):
--   1) public.maale_auto_dispatch_config — one row, enqueue_enabled DEFAULT false (database-side switch; the owner flips
--      it in the SQL editor). RLS on, service_role SELECT only.
--   2) public.maale_auto_dispatch_queue — one task per order (order_id PK → orders RESTRICT): state, reason_code,
--      attempts, timestamps. No customer data. RLS on, service_role SELECT + column-level UPDATE only (NO INSERT, NO
--      DELETE: a task can only come from a real confirmation, through the trigger below).
--   3) BEFORE UPDATE guard on the queue: identity columns immutable, closed transition table, terminal states final,
--      attempts +1 only when a task is claimed, a stale 'processing' task re-claimable only after 2 minutes.
--   4) AFTER UPDATE OF status trigger on public.orders, WHEN received → confirmed AND type = 'delivery': if the config
--      switch is on, adds the task IN THE SAME TRANSACTION as the confirmation (ON CONFLICT DO NOTHING). Atomic: a task
--      exists if and only if the confirmation committed; a failed enqueue aborts the confirmation (the kitchen retries)
--      instead of silently losing the courier request. SECURITY DEFINER (owner = installer), search_path ''.
--
-- The queue never sends anything. The application worker (lib/kitchenAutoDispatch.ts) processes a task through the
-- existing lib/maaleDispatch service, whose atomic claim (public.claim_maale_dispatch on delivery_dispatches) remains the
-- single guarantee that a provider order is submitted at most once.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ─── Preflight (read-only assertions; abort on any surprise) ──────────────────────────────────────────────────────
DO $s4_05_preflight$
BEGIN
  IF to_regclass('public.orders') IS NULL THEN
    RAISE EXCEPTION 's4_05_preflight: public.orders missing';
  END IF;
  IF (SELECT data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'id') IS DISTINCT FROM 'uuid'
     OR (SELECT data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'status') IS DISTINCT FROM 'text'
     OR (SELECT data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'type') IS DISTINCT FROM 'text'
     OR (SELECT data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'branch_id') IS DISTINCT FROM 'uuid' THEN
    RAISE EXCEPTION 's4_05_preflight: orders.id / status / type / branch_id have unexpected types';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = 'public.orders'::regclass AND c.contype IN ('p', 'u')
                  AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'public.orders'::regclass AND attname = 'id')]::int2[]) THEN
    RAISE EXCEPTION 's4_05_preflight: orders(id) is not a primary key or unique key';
  END IF;
  IF to_regclass('public.delivery_dispatches') IS NULL THEN
    RAISE EXCEPTION 's4_05_preflight: public.delivery_dispatches missing (the dispatch service this queue feeds)';
  END IF;
  IF to_regclass('public.maale_auto_dispatch_queue') IS NOT NULL OR to_regclass('public.maale_auto_dispatch_config') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
                 AND p.proname IN ('orders_enqueue_maale_auto_dispatch', 'maale_auto_dispatch_queue_guard'))
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.orders'::regclass AND tgname = 'orders_enqueue_maale_auto_dispatch') THEN
    RAISE EXCEPTION 's4_05_preflight: s4_05 objects already exist (no silent re-apply)';
  END IF;
  IF (SELECT count(*) FROM pg_roles WHERE rolname IN ('service_role', 'anon', 'authenticated')) <> 3 THEN
    RAISE EXCEPTION 's4_05_preflight: expected roles service_role / anon / authenticated';
  END IF;
END
$s4_05_preflight$;

-- ─── 1) Database switch (default OFF) ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.maale_auto_dispatch_config (
  singleton        boolean     NOT NULL DEFAULT true,
  enqueue_enabled  boolean     NOT NULL DEFAULT false,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT maale_auto_dispatch_config_pkey PRIMARY KEY (singleton),
  CONSTRAINT maale_auto_dispatch_config_singleton_check CHECK (singleton)
);
COMMENT ON TABLE public.maale_auto_dispatch_config IS
  'S4-MAALE-03: single row. enqueue_enabled (default false) lets a kitchen confirmation create an auto-dispatch task. Owner-only switch.';
INSERT INTO public.maale_auto_dispatch_config (singleton, enqueue_enabled) VALUES (true, false);
ALTER TABLE public.maale_auto_dispatch_config ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.maale_auto_dispatch_config FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.maale_auto_dispatch_config TO service_role;

-- ─── 2) Queue ──────────────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.maale_auto_dispatch_queue (
  order_id     uuid        NOT NULL,
  branch_id    uuid        NULL,
  state        text        NOT NULL DEFAULT 'queued',
  reason_code  text        NULL,
  attempts     integer     NOT NULL DEFAULT 0,
  enqueued_at  timestamptz NOT NULL DEFAULT now(),
  claimed_at   timestamptz NULL,
  finished_at  timestamptz NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT maale_auto_dispatch_queue_pkey PRIMARY KEY (order_id),
  CONSTRAINT maale_auto_dispatch_queue_order_fk FOREIGN KEY (order_id) REFERENCES public.orders (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT maale_auto_dispatch_queue_state_check
    CHECK (state IN ('queued', 'processing', 'dispatched', 'manual', 'investigate', 'skipped')),
  CONSTRAINT maale_auto_dispatch_queue_reason_format CHECK (reason_code IS NULL OR reason_code ~ '^[a-z0-9_]{1,64}$'),
  CONSTRAINT maale_auto_dispatch_queue_attempts_range CHECK (attempts BETWEEN 0 AND 5),
  CONSTRAINT maale_auto_dispatch_queue_processing_claimed CHECK (state <> 'processing' OR claimed_at IS NOT NULL),
  CONSTRAINT maale_auto_dispatch_queue_terminal_finished
    CHECK ((state IN ('dispatched', 'manual', 'investigate', 'skipped')) = (finished_at IS NOT NULL))
);
COMMENT ON TABLE public.maale_auto_dispatch_queue IS
  'S4-MAALE-03: one courier auto-dispatch task per confirmed delivery order. Created only by the orders trigger. No customer data.';
CREATE INDEX maale_auto_dispatch_queue_due_idx ON public.maale_auto_dispatch_queue (state, enqueued_at);
ALTER TABLE public.maale_auto_dispatch_queue ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.maale_auto_dispatch_queue FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.maale_auto_dispatch_queue TO service_role;
GRANT UPDATE (state, reason_code, attempts, claimed_at, finished_at, updated_at) ON public.maale_auto_dispatch_queue TO service_role;

-- ─── 3) Guard: closed transition table ─────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION public.maale_auto_dispatch_queue_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $maale_auto_dispatch_queue_guard$
BEGIN
  IF NEW.order_id IS DISTINCT FROM OLD.order_id OR NEW.branch_id IS DISTINCT FROM OLD.branch_id
     OR NEW.enqueued_at IS DISTINCT FROM OLD.enqueued_at THEN
    RAISE EXCEPTION 'auto_dispatch_identity_immutable' USING ERRCODE = '22023';
  END IF;
  IF OLD.state IN ('dispatched', 'manual', 'investigate', 'skipped') THEN
    RAISE EXCEPTION 'auto_dispatch_task_final' USING ERRCODE = '22023';
  END IF;
  IF NOT (
       (OLD.state = 'queued' AND NEW.state IN ('processing', 'skipped'))
    OR (OLD.state = 'processing' AND NEW.state IN ('queued', 'processing', 'dispatched', 'manual', 'investigate', 'skipped'))
  ) THEN
    RAISE EXCEPTION 'auto_dispatch_invalid_transition' USING ERRCODE = '22023';
  END IF;
  -- claim (→ processing) = exactly one more attempt; every other change keeps the count
  IF NEW.state = 'processing' THEN
    IF NEW.attempts IS DISTINCT FROM OLD.attempts + 1 OR NEW.claimed_at IS NULL OR NEW.claimed_at IS NOT DISTINCT FROM OLD.claimed_at THEN
      RAISE EXCEPTION 'auto_dispatch_invalid_claim' USING ERRCODE = '22023';
    END IF;
    -- a running task may only be taken over once it is stale (the dispatch claim still prevents a second send)
    IF OLD.state = 'processing' AND OLD.claimed_at > now() - interval '2 minutes' THEN
      RAISE EXCEPTION 'auto_dispatch_claim_not_stale' USING ERRCODE = '22023';
    END IF;
  ELSIF NEW.attempts IS DISTINCT FROM OLD.attempts THEN
    RAISE EXCEPTION 'auto_dispatch_invalid_attempts' USING ERRCODE = '22023';
  END IF;
  IF (NEW.state IN ('dispatched', 'manual', 'investigate', 'skipped')) AND NEW.finished_at IS NULL THEN
    NEW.finished_at := now();
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$maale_auto_dispatch_queue_guard$;
REVOKE ALL ON FUNCTION public.maale_auto_dispatch_queue_guard() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER maale_auto_dispatch_queue_guard
  BEFORE UPDATE ON public.maale_auto_dispatch_queue
  FOR EACH ROW EXECUTE FUNCTION public.maale_auto_dispatch_queue_guard();

-- ─── 4) Atomic enqueue on the confirmation ─────────────────────────────────────────────────────────────────────────
CREATE FUNCTION public.orders_enqueue_maale_auto_dispatch()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $orders_enqueue_maale_auto_dispatch$
BEGIN
  IF (SELECT c.enqueue_enabled FROM public.maale_auto_dispatch_config AS c WHERE c.singleton) IS TRUE THEN
    INSERT INTO public.maale_auto_dispatch_queue (order_id, branch_id) VALUES (NEW.id, NEW.branch_id)
      ON CONFLICT (order_id) DO NOTHING;
  END IF;
  RETURN NULL;
END
$orders_enqueue_maale_auto_dispatch$;
REVOKE ALL ON FUNCTION public.orders_enqueue_maale_auto_dispatch() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER orders_enqueue_maale_auto_dispatch
  AFTER UPDATE OF status ON public.orders
  FOR EACH ROW
  WHEN (OLD.status = 'received' AND NEW.status = 'confirmed' AND NEW.type = 'delivery')
  EXECUTE FUNCTION public.orders_enqueue_maale_auto_dispatch();

COMMIT;
