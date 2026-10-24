-- FALAFEL BATACHANA — HYP PAYMENTS — hyp05_rollback.sql (HYP-05)
-- EMERGENCY SCRIPT — MANUAL ONLY, NEVER RUN WITHOUT SEPARATE EXPLICIT OWNER APPROVAL.
--
-- PRIMARY ROLLBACK PLAN IS THE APPLICATION: turn HYP_PAYMENTS_ENABLED off / Vercel Instant Rollback. The database objects
-- can stay installed indefinitely; nothing uses them while the application flag is off.
--
-- It restores exactly the pre-HYP-05 state: drops the orders guard triggers, restores the four-value
-- orders_payment_method_check, drops the payment functions, tables and trigger functions, revokes every privilege of the
-- coordinator role and drops it. create_order / create_order_with_parcel and every existing row are untouched.
--
-- REFUSES (financial evidence is never destroyed) when ANY of these exist: an order with payment_method 'online', a
-- recorded HYP return, a recorded HYP transaction, or an intent beyond 'created' / 'not_sent' (a redirected intent may
-- hide a charge). Requires, immediately before running, in the SAME session:
--   SET hyp05.confirm_rollback = 'DROP-PAYMENT-INTENTS';

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $hyp05_rollback_guard$
BEGIN
  IF current_setting('hyp05.confirm_rollback', true) IS DISTINCT FROM 'DROP-PAYMENT-INTENTS' THEN
    RAISE EXCEPTION 'hyp05_rollback: not confirmed (SET hyp05.confirm_rollback = ''DROP-PAYMENT-INTENTS'' first)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hyp_payment_coordinator')
     OR to_regclass('public.payment_intents') IS NULL OR to_regclass('public.payment_returns') IS NULL
     OR to_regclass('public.payment_transactions') IS NULL OR to_regclass('public.payment_reversals') IS NULL
     OR to_regclass('public.payment_intent_events') IS NULL
     OR to_regprocedure('public.finalize_paid_intent(uuid, text)') IS NULL
     OR (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.orders'::regclass
          AND tgname IN ('orders_online_payment_guard_insert', 'orders_online_payment_guard_update')) <> 2 THEN
    RAISE EXCEPTION 'hyp05_rollback: the reviewed HYP-05 objects are not (all) installed — nothing safe to roll back';
  END IF;
  IF (SELECT count(*) FROM pg_proc WHERE proowner = (SELECT oid FROM pg_roles WHERE rolname = 'hyp_payment_coordinator')) <> 7
     OR EXISTS (SELECT 1 FROM pg_class WHERE relowner = (SELECT oid FROM pg_roles WHERE rolname = 'hyp_payment_coordinator')) THEN
    RAISE EXCEPTION 'hyp05_rollback: unexpected coordinator-owned objects — review before dropping';
  END IF;
  IF EXISTS (SELECT 1 FROM public.orders AS o WHERE o.payment_method = 'online')
     OR EXISTS (SELECT 1 FROM public.payment_returns)
     OR EXISTS (SELECT 1 FROM public.payment_transactions)
     OR EXISTS (SELECT 1 FROM public.payment_intents AS pi WHERE pi.status NOT IN ('created', 'not_sent')) THEN
    RAISE EXCEPTION 'hyp05_rollback: payment evidence exists (online orders, returns, transactions or redirected intents) — refused';
  END IF;
END
$hyp05_rollback_guard$;

DROP TRIGGER orders_online_payment_guard_insert ON public.orders;
DROP TRIGGER orders_online_payment_guard_update ON public.orders;
DROP FUNCTION public.orders_online_payment_guard();
ALTER TABLE public.orders
  DROP CONSTRAINT orders_payment_method_check,
  ADD CONSTRAINT orders_payment_method_check
    CHECK (payment_method = ANY (ARRAY['cash'::text, 'credit'::text, 'cibus'::text, 'bit'::text]));

DROP FUNCTION public.create_payment_intent(uuid, text, text, jsonb, integer, integer);
DROP FUNCTION public.record_hyp_sign_result(uuid, boolean);
DROP FUNCTION public.record_hyp_return(text);
DROP FUNCTION public.record_hyp_verification(uuid, text, text);
DROP FUNCTION public.finalize_paid_intent(uuid, text);
DROP FUNCTION public.sweep_expired_payment_intents(integer);
DROP FUNCTION public.resolve_payment_intent(uuid, text, text, text, text, integer, uuid, text);

ALTER TABLE public.payment_intents DROP CONSTRAINT payment_intents_paid_transaction_fk;
DROP TABLE public.payment_intent_events;
DROP TABLE public.payment_reversals;
DROP TABLE public.payment_transactions;
DROP TABLE public.payment_returns;
DROP TABLE public.payment_intents;
DROP FUNCTION public.payment_append_only();
DROP FUNCTION public.payment_intents_guard();
DROP FUNCTION public.payment_intents_audit();
DROP FUNCTION public.payment_returns_guard();

REVOKE ALL ON public.orders, public.order_items, public.deliveries, public.parcel_requests, public.parcel_events
  FROM hyp_payment_coordinator;
REVOKE ALL ON SEQUENCE public.orders_order_number_seq FROM hyp_payment_coordinator;
REVOKE ALL ON FUNCTION public.create_order(jsonb, jsonb, jsonb) FROM hyp_payment_coordinator;
REVOKE ALL ON FUNCTION public.create_order_with_parcel(jsonb, jsonb, jsonb, jsonb) FROM hyp_payment_coordinator;
REVOKE ALL ON SCHEMA public FROM hyp_payment_coordinator;
DROP ROLE hyp_payment_coordinator;

DO $hyp05_rollback_postcheck$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hyp_payment_coordinator')
     OR to_regclass('public.payment_intents') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
                 AND p.proname IN ('create_payment_intent', 'record_hyp_sign_result', 'record_hyp_return', 'record_hyp_verification',
                                   'finalize_paid_intent', 'sweep_expired_payment_intents', 'resolve_payment_intent',
                                   'orders_online_payment_guard', 'payment_intents_guard', 'payment_intents_audit',
                                   'payment_returns_guard', 'payment_append_only'))
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.orders'::regclass AND tgname LIKE 'orders_online_payment_guard%')
     OR (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c WHERE c.conrelid = 'public.orders'::regclass AND c.conname = 'orders_payment_method_check')
          IS DISTINCT FROM 'CHECK ((payment_method = ANY (ARRAY[''cash''::text, ''credit''::text, ''cibus''::text, ''bit''::text])))'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.create_order(jsonb, jsonb, jsonb)'::regprocedure)
          IS DISTINCT FROM 'db92e75f8bfdadb6d78be035da855996'
     OR NOT has_function_privilege('service_role', 'public.create_order(jsonb, jsonb, jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'hyp05_rollback_postcheck: pre-HYP-05 state not restored';
  END IF;
END
$hyp05_rollback_postcheck$;

COMMIT;
