-- FALAFEL BATACHANA — MAALE EXPRESS — s4_04e_rollback.sql (S4-INTEGRATIONS-04E1/04E2)
-- EMERGENCY SCRIPT — MANUAL ONLY, NEVER RUN WITHOUT SEPARATE EXPLICIT OWNER APPROVAL.
--
-- PRIMARY ROLLBACK PLAN IS THE APPLICATION, NOT THIS SCRIPT: roll the app back (Vercel Instant Rollback) to a version
-- that does not dispatch, THEN — only if really needed — run this script.
-- WARNING: after this script the atomic coordination is GONE. An application version that dispatches and records manual
-- couriers without it re-opens the race documented in S4-04D3 / 04D4. Keep kitchen dispatch OFF until 04E is back.
-- The 04E2 application REQUIRES these functions: with them gone it fails closed (no claim → no send; no record).
--
-- It restores exactly the pre-04E state: drops the guard trigger + its function and both coordination functions,
-- revokes the coordinator's privileges, drops the coordinator role, and re-grants INSERT on the ledger to service_role
-- (04D state). No table, constraint or row (sent dispatches, ledger history, quote ledger) is changed. Refuses unless the
-- session confirms, immediately before running, in the SAME session:
--   SET s4_04e.confirm_rollback = 'DROP-COURIER-COORDINATION';

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $s4_04e_rollback_guard$
BEGIN
  IF current_setting('s4_04e.confirm_rollback', true) IS DISTINCT FROM 'DROP-COURIER-COORDINATION' THEN
    RAISE EXCEPTION 's4_04e_rollback: not confirmed (SET s4_04e.confirm_rollback = ''DROP-COURIER-COORDINATION'' first)';
  END IF;
  IF to_regprocedure('public.claim_maale_dispatch(uuid, integer, timestamptz)') IS NULL
     OR to_regprocedure('public.record_maale_reconciliation_event(uuid, uuid, text, text, text, text, text)') IS NULL
     OR to_regprocedure('public.delivery_dispatches_coordination_guard()') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.delivery_dispatches'::regclass AND tgname = 'delivery_dispatches_coordination_guard')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'maale_dispatch_coordinator') THEN
    RAISE EXCEPTION 's4_04e_rollback: the reviewed S4-04E objects are not (all) installed — nothing safe to roll back';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
       AND p.proname IN ('claim_maale_dispatch', 'record_maale_reconciliation_event', 'delivery_dispatches_coordination_guard')) <> 3
     OR EXISTS (SELECT 1 FROM pg_class WHERE relowner = (SELECT oid FROM pg_roles WHERE rolname = 'maale_dispatch_coordinator'))
     OR (SELECT count(*) FROM pg_proc WHERE proowner = (SELECT oid FROM pg_roles WHERE rolname = 'maale_dispatch_coordinator')) <> 2 THEN
    RAISE EXCEPTION 's4_04e_rollback: unexpected overloads or coordinator-owned objects — review before dropping';
  END IF;
END
$s4_04e_rollback_guard$;

DROP TRIGGER delivery_dispatches_coordination_guard ON public.delivery_dispatches;
DROP FUNCTION public.delivery_dispatches_coordination_guard();
DROP FUNCTION public.claim_maale_dispatch(uuid, integer, timestamptz);
DROP FUNCTION public.record_maale_reconciliation_event(uuid, uuid, text, text, text, text, text);
REVOKE ALL ON public.delivery_dispatches, public.maale_dispatch_reconciliations, public.orders FROM maale_dispatch_coordinator;
REVOKE ALL ON SCHEMA public FROM maale_dispatch_coordinator;
DROP ROLE maale_dispatch_coordinator;
GRANT INSERT ON public.maale_dispatch_reconciliations TO service_role;  -- the exact 04D privilege

DO $s4_04e_rollback_postcheck$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
              AND p.proname IN ('claim_maale_dispatch', 'record_maale_reconciliation_event', 'delivery_dispatches_coordination_guard'))
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.delivery_dispatches'::regclass AND tgname = 'delivery_dispatches_coordination_guard')
     OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'maale_dispatch_coordinator')
     OR NOT has_table_privilege('service_role', 'public.maale_dispatch_reconciliations', 'INSERT') THEN
    RAISE EXCEPTION 's4_04e_rollback_postcheck: pre-04E state not restored';
  END IF;
END
$s4_04e_rollback_postcheck$;

COMMIT;
