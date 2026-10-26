-- FALAFEL BATACHANA — MAALE EXPRESS — s4_05_rollback.sql (S4-MAALE-03)
-- EMERGENCY SCRIPT — MANUAL ONLY, NEVER RUN WITHOUT SEPARATE EXPLICIT OWNER APPROVAL.
--
-- PRIMARY ROLLBACK PLAN IS NOT THIS SCRIPT: switch the feature off (MAALE_AUTO_DISPATCH_ENABLED unset → the app never
-- processes a task; UPDATE public.maale_auto_dispatch_config SET enqueue_enabled = false → no new task is created).
-- Both switches stop the feature without touching data.
--
-- This script removes the orders trigger first (confirmations stop creating tasks immediately), then the queue, the
-- config and both functions. It DESTROYS the task history (states, reason codes, timestamps — no customer data):
-- EXPORT IT FIRST. It refuses unless:
--   * SET s4_05.confirm_rollback = 'DROP-AUTO-DISPATCH-QUEUE';   (same session, immediately before)
--   * no task is still 'queued' or 'processing' (finish or switch them off first — a dropped running task could leave a
--     courier request whose outcome is only visible in delivery_dispatches);
--   * when the queue has rows: SET s4_05.confirm_history_exported = 'yes';
-- It never touches public.orders rows, public.delivery_dispatches or any other object.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $s4_05_rollback_guard$
BEGIN
  IF current_setting('s4_05.confirm_rollback', true) IS DISTINCT FROM 'DROP-AUTO-DISPATCH-QUEUE' THEN
    RAISE EXCEPTION 's4_05_rollback: not confirmed (SET s4_05.confirm_rollback = ''DROP-AUTO-DISPATCH-QUEUE'' first)';
  END IF;
  IF to_regclass('public.maale_auto_dispatch_queue') IS NULL THEN
    RAISE EXCEPTION 's4_05_rollback: public.maale_auto_dispatch_queue not installed — nothing to roll back';
  END IF;
  IF EXISTS (SELECT 1 FROM public.maale_auto_dispatch_queue WHERE state IN ('queued', 'processing')) THEN
    RAISE EXCEPTION 's4_05_rollback: tasks are still queued / processing — switch the feature off and let them finish first';
  END IF;
  IF EXISTS (SELECT 1 FROM public.maale_auto_dispatch_queue)
     AND current_setting('s4_05.confirm_history_exported', true) IS DISTINCT FROM 'yes' THEN
    RAISE EXCEPTION 's4_05_rollback: the queue has rows — export them, then SET s4_05.confirm_history_exported = ''yes''';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE confrelid IN (to_regclass('public.maale_auto_dispatch_queue'), to_regclass('public.maale_auto_dispatch_config'))) THEN
    RAISE EXCEPTION 's4_05_rollback: another object references the s4_05 tables — review before dropping';
  END IF;
END
$s4_05_rollback_guard$;

DROP TRIGGER orders_enqueue_maale_auto_dispatch ON public.orders;
DROP FUNCTION public.orders_enqueue_maale_auto_dispatch();
DROP TRIGGER maale_auto_dispatch_queue_guard ON public.maale_auto_dispatch_queue;
DROP FUNCTION public.maale_auto_dispatch_queue_guard();
DROP TABLE public.maale_auto_dispatch_queue;
DROP TABLE public.maale_auto_dispatch_config;

COMMIT;
