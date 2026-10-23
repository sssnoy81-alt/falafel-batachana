-- FALAFEL BATACHANA — MAALE EXPRESS — s4_04d_rollback.sql (S4-INTEGRATIONS-04D1)
-- EMERGENCY SCRIPT — MANUAL ONLY, NEVER RUN WITHOUT SEPARATE EXPLICIT OWNER APPROVAL.
--
-- PRIMARY ROLLBACK PLAN IS THE APPLICATION, NOT THIS SCRIPT: roll the app back (Vercel Instant Rollback). An application
-- that does not use public.maale_dispatch_reconciliations ignores it completely; nothing must be undone in the database.
--
-- This script DROPS the ledger and DESTROYS the reconciliation history (event types, account names, provider ids,
-- timestamps — no customer data). That history is the record of manual provider confirmations / cancellations:
-- EXPORT IT FIRST. It refuses unless:
--   * the session explicitly confirms, immediately before running, in the SAME session:
--       SET s4_04d.confirm_rollback = 'DROP-RECONCILIATION-LEDGER';
--   * and, when the ledger has rows, the session ALSO confirms that it was exported:
--       SET s4_04d.confirm_history_exported = 'yes';
-- It never touches public.orders, public.delivery_dispatches, public.maale_dispatch_requests or any other object.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $s4_04d_rollback_guard$
BEGIN
  IF current_setting('s4_04d.confirm_rollback', true) IS DISTINCT FROM 'DROP-RECONCILIATION-LEDGER' THEN
    RAISE EXCEPTION 's4_04d_rollback: not confirmed (SET s4_04d.confirm_rollback = ''DROP-RECONCILIATION-LEDGER'' first)';
  END IF;
  IF to_regclass('public.maale_dispatch_reconciliations') IS NULL THEN
    RAISE EXCEPTION 's4_04d_rollback: public.maale_dispatch_reconciliations not installed — nothing to roll back';
  END IF;
  IF EXISTS (SELECT 1 FROM public.maale_dispatch_reconciliations)
     AND current_setting('s4_04d.confirm_history_exported', true) IS DISTINCT FROM 'yes' THEN
    RAISE EXCEPTION 's4_04d_rollback: the ledger has rows — export them, then SET s4_04d.confirm_history_exported = ''yes''';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE confrelid = 'public.maale_dispatch_reconciliations'::regclass)
     OR EXISTS (SELECT 1 FROM pg_depend d JOIN pg_rewrite r ON r.oid = d.objid
                 WHERE d.refobjid = 'public.maale_dispatch_reconciliations'::regclass AND r.ev_class <> 'public.maale_dispatch_reconciliations'::regclass) THEN
    RAISE EXCEPTION 's4_04d_rollback: another object depends on maale_dispatch_reconciliations — review before dropping';
  END IF;
END
$s4_04d_rollback_guard$;

DROP TABLE public.maale_dispatch_reconciliations;  -- no CASCADE

DO $s4_04d_rollback_postcheck$
BEGIN
  IF to_regclass('public.maale_dispatch_reconciliations') IS NOT NULL THEN
    RAISE EXCEPTION 's4_04d_rollback_postcheck: table still present';
  END IF;
END
$s4_04d_rollback_postcheck$;

COMMIT;
