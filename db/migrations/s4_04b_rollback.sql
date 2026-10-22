-- FALAFEL BATACHANA — MAALE EXPRESS — s4_04b_rollback.sql (S4-INTEGRATIONS-04B1)
-- EMERGENCY SCRIPT — MANUAL ONLY, NEVER RUN WITHOUT SEPARATE EXPLICIT OWNER APPROVAL.
--
-- PRIMARY ROLLBACK PLAN IS THE APPLICATION, NOT THIS SCRIPT: roll the app back (Vercel Instant Rollback). An application
-- that does not call consume_maale_quote_slot ignores the 04B schema completely; nothing in the database must be undone.
-- An application that DOES call it fails closed when it is missing (no quote, no dispatch) — so run this ONLY after the
-- application no longer calls the function.
--
-- What it does (only when exactly the reviewed 04B objects are installed):
--   1. DROP FUNCTION public.consume_maale_quote_slot(uuid, uuid, text)
--   2. DROP TABLE public.maale_dispatch_requests — DESTROYS the request ledger (account names + timestamps; no customer
--      data). Export it first if the history must be kept.
-- It never touches public.orders, public.branches, public.delivery_dispatches or any other object.
--
-- Extra guard: refuses unless the session explicitly confirms, in the SAME session, immediately before running:
--   SET s4_04b.confirm_rollback = 'DROP-QUOTE-LEDGER';

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $s4_04b_rollback_guard$
BEGIN
  IF current_setting('s4_04b.confirm_rollback', true) IS DISTINCT FROM 'DROP-QUOTE-LEDGER' THEN
    RAISE EXCEPTION 's4_04b_rollback: not confirmed (SET s4_04b.confirm_rollback = ''DROP-QUOTE-LEDGER'' first)';
  END IF;
  IF to_regclass('public.maale_dispatch_requests') IS NULL THEN
    RAISE EXCEPTION 's4_04b_rollback: public.maale_dispatch_requests not installed — nothing to roll back';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'consume_maale_quote_slot') <> 1
     OR to_regprocedure('public.consume_maale_quote_slot(uuid, uuid, text)') IS NULL THEN
    RAISE EXCEPTION 's4_04b_rollback: expected exactly the reviewed consume_maale_quote_slot(uuid, uuid, text)';
  END IF;
  -- Nothing else may depend on the ledger (e.g. a later migration's FK or view).
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE confrelid = 'public.maale_dispatch_requests'::regclass)
     OR EXISTS (SELECT 1 FROM pg_depend d JOIN pg_rewrite r ON r.oid = d.objid
                 WHERE d.refobjid = 'public.maale_dispatch_requests'::regclass AND r.ev_class <> 'public.maale_dispatch_requests'::regclass) THEN
    RAISE EXCEPTION 's4_04b_rollback: another object depends on maale_dispatch_requests — review before dropping';
  END IF;
END
$s4_04b_rollback_guard$;

DROP FUNCTION public.consume_maale_quote_slot(uuid, uuid, text);  -- no CASCADE
DROP TABLE public.maale_dispatch_requests;                          -- no CASCADE

DO $s4_04b_rollback_postcheck$
BEGIN
  IF to_regclass('public.maale_dispatch_requests') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'public' AND p.proname = 'consume_maale_quote_slot') THEN
    RAISE EXCEPTION 's4_04b_rollback_postcheck: objects still present';
  END IF;
END
$s4_04b_rollback_postcheck$;

COMMIT;
