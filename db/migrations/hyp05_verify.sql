-- FALAFEL BATACHANA — hyp05_verify.sql (HYP-05) — READ-ONLY, ONE SELECT. Run AFTER hyp05_payment_intents.sql.
-- Catalog checks only: no customer data, no writes, no function is called. Expected: every row PASS (row 16 INFO).
-- Row 17 (HYP-06A): the non-capture outcome for Hyp Pay codes 600 / 700 / 800.
-- Columns: check_id | check_name | result | detail
WITH
fns(sig) AS (VALUES
  ('public.create_payment_intent(uuid, text, text, jsonb, integer, integer)'),
  ('public.record_hyp_sign_result(uuid, boolean)'),
  ('public.record_hyp_return(text)'),
  ('public.record_hyp_verification(uuid, text, text)'),
  ('public.finalize_paid_intent(uuid, text)'),
  ('public.sweep_expired_payment_intents(integer)'),
  ('public.resolve_payment_intent(uuid, text, text, text, text, integer, uuid, text)')),
tbl(rel) AS (VALUES ('public.payment_intents'), ('public.payment_returns'), ('public.payment_transactions'),
                    ('public.payment_reversals'), ('public.payment_intent_events')),
role_ok AS (SELECT r.* FROM pg_roles r WHERE r.rolname = 'hyp_payment_coordinator'),
checks (check_id, check_name, ok, detail) AS (
  SELECT '01', 'coordinator role: NOLOGIN NOINHERIT BYPASSRLS, no other attribute',
         COALESCE((SELECT NOT rolcanlogin AND NOT rolinherit AND rolbypassrls AND NOT rolsuper AND NOT rolcreatedb
                          AND NOT rolcreaterole AND NOT rolreplication FROM role_ok), false), ''
  UNION ALL
  SELECT '02', 'coordinator is a member of nothing; no application role is a member of it',
         EXISTS (SELECT 1 FROM role_ok)
         AND NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = (SELECT oid FROM role_ok))
         AND NOT EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member
                          WHERE m.roleid = (SELECT oid FROM role_ok) AND r.rolname IN ('authenticator', 'service_role', 'anon', 'authenticated')), ''
  UNION ALL
  SELECT '03', 'all 7 payment functions: SECURITY DEFINER, owner coordinator, search_path '''' + lock_timeout 3s',
         (SELECT count(*) FROM fns JOIN pg_proc p ON p.oid = to_regprocedure(fns.sig)
           WHERE p.prosecdef AND p.proowner = (SELECT oid FROM role_ok)
             AND p.proconfig = ARRAY['search_path=""', 'lock_timeout=3s']) = 7, ''
  UNION ALL
  SELECT '04', 'EXECUTE on the payment functions: service_role yes; anon / authenticated / PUBLIC no',
         (SELECT bool_and(has_function_privilege('service_role', to_regprocedure(sig), 'EXECUTE')
                          AND NOT has_function_privilege('anon', to_regprocedure(sig), 'EXECUTE')
                          AND NOT has_function_privilege('authenticated', to_regprocedure(sig), 'EXECUTE')
                          AND NOT has_function_privilege('public', to_regprocedure(sig), 'EXECUTE'))
            FROM fns WHERE to_regprocedure(sig) IS NOT NULL)
         AND (SELECT count(*) FROM fns WHERE to_regprocedure(sig) IS NOT NULL) = 7, ''
  UNION ALL
  SELECT '05', 'payment tables: RLS on, no policies',
         (SELECT count(*) FROM tbl JOIN pg_class c ON c.oid = to_regclass(tbl.rel) WHERE c.relrowsecurity
            AND NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = c.oid)) = 5, ''
  UNION ALL
  SELECT '06', 'payment tables: service_role SELECT only; anon / authenticated nothing (effective, incl. column grants)',
         (SELECT bool_and(has_table_privilege('service_role', to_regclass(rel), 'SELECT')
                          AND NOT has_any_column_privilege('service_role', to_regclass(rel), 'INSERT')
                          AND NOT has_any_column_privilege('service_role', to_regclass(rel), 'UPDATE')
                          AND NOT has_table_privilege('service_role', to_regclass(rel), 'DELETE')
                          AND NOT has_table_privilege('service_role', to_regclass(rel), 'TRUNCATE')
                          AND NOT has_table_privilege('service_role', to_regclass(rel), 'TRIGGER')
                          AND NOT has_any_column_privilege('anon', to_regclass(rel), 'SELECT')
                          AND NOT has_any_column_privilege('anon', to_regclass(rel), 'INSERT')
                          AND NOT has_any_column_privilege('authenticated', to_regclass(rel), 'SELECT')
                          AND NOT has_any_column_privilege('authenticated', to_regclass(rel), 'INSERT'))
            FROM tbl WHERE to_regclass(rel) IS NOT NULL)
         AND (SELECT count(*) FROM tbl WHERE to_regclass(rel) IS NOT NULL) = 5, ''
  UNION ALL
  SELECT '07', 'coordinator on orders: column-level only (no phone / customer_name read, UPDATE only updated_at, no DELETE)',
         EXISTS (SELECT 1 FROM role_ok)
         AND NOT has_table_privilege('hyp_payment_coordinator', 'public.orders', 'SELECT')
         AND has_column_privilege('hyp_payment_coordinator', 'public.orders', 'daily_number', 'SELECT')
         AND NOT has_column_privilege('hyp_payment_coordinator', 'public.orders', 'phone', 'SELECT')
         AND NOT has_column_privilege('hyp_payment_coordinator', 'public.orders', 'customer_name', 'SELECT')
         AND NOT has_column_privilege('hyp_payment_coordinator', 'public.orders', 'status', 'UPDATE')
         AND has_column_privilege('hyp_payment_coordinator', 'public.orders', 'updated_at', 'UPDATE')
         AND NOT has_table_privilege('hyp_payment_coordinator', 'public.orders', 'DELETE'), ''
  UNION ALL
  SELECT '08', 'coordinator reads nothing from order_items / deliveries / parcel_events; no CREATE on schema public',
         EXISTS (SELECT 1 FROM role_ok)
         AND NOT has_any_column_privilege('hyp_payment_coordinator', 'public.order_items', 'SELECT')
         AND NOT has_any_column_privilege('hyp_payment_coordinator', 'public.deliveries', 'SELECT')
         AND NOT has_any_column_privilege('hyp_payment_coordinator', 'public.parcel_events', 'SELECT')
         AND NOT has_column_privilege('hyp_payment_coordinator', 'public.parcel_requests', 'tracking_ref', 'SELECT')
         AND NOT has_schema_privilege('hyp_payment_coordinator', 'public', 'CREATE'), ''
  UNION ALL
  SELECT '09', 'create_order / create_order_with_parcel bodies unchanged; still SECURITY INVOKER',
         (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.create_order(jsonb, jsonb, jsonb)')) = 'db92e75f8bfdadb6d78be035da855996'
         AND (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.create_order_with_parcel(jsonb, jsonb, jsonb, jsonb)'))
               IN ('6ceb72f6c80929adddd7a2b7bb1a0616', 'afbe93d74b201d6bd898edd2b6e28a63')
         AND NOT (SELECT bool_or(prosecdef) FROM pg_proc WHERE oid IN (to_regprocedure('public.create_order(jsonb, jsonb, jsonb)'),
                                                                     to_regprocedure('public.create_order_with_parcel(jsonb, jsonb, jsonb, jsonb)'))), ''
  UNION ALL
  SELECT '10', 'create_order EXECUTE: service_role + coordinator only (not anon / authenticated / PUBLIC)',
         has_function_privilege('service_role', to_regprocedure('public.create_order(jsonb, jsonb, jsonb)'), 'EXECUTE')
         AND has_function_privilege('hyp_payment_coordinator', to_regprocedure('public.create_order(jsonb, jsonb, jsonb)'), 'EXECUTE')
         AND NOT has_function_privilege('anon', to_regprocedure('public.create_order(jsonb, jsonb, jsonb)'), 'EXECUTE')
         AND NOT has_function_privilege('authenticated', to_regprocedure('public.create_order(jsonb, jsonb, jsonb)'), 'EXECUTE')
         AND NOT has_function_privilege('public', to_regprocedure('public.create_order(jsonb, jsonb, jsonb)'), 'EXECUTE'), ''
  UNION ALL
  SELECT '11', 'orders_payment_method_check = cash / credit / cibus / bit / online (validated)',
         COALESCE((SELECT pg_get_constraintdef(c.oid) = 'CHECK ((payment_method = ANY (ARRAY[''cash''::text, ''credit''::text, ''cibus''::text, ''bit''::text, ''online''::text])))'
                          AND c.convalidated
                     FROM pg_constraint c WHERE c.conrelid = to_regclass('public.orders') AND c.conname = 'orders_payment_method_check'), false), ''
  UNION ALL
  SELECT '12', 'orders guard: 2 AFTER row triggers, enabled, SECURITY INVOKER function',
         (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid = to_regclass('public.orders') AND t.tgenabled = 'O'
            AND t.tgname IN ('orders_online_payment_guard_insert', 'orders_online_payment_guard_update')
            AND (t.tgtype & 2) = 0 AND (t.tgtype & 1) = 1) = 2
         AND COALESCE(NOT (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure('public.orders_online_payment_guard()')), false), ''
  UNION ALL
  SELECT '13', 'payment table triggers present and enabled (guards, audit, append-only, no-truncate)',
         (SELECT count(*) FROM pg_trigger t WHERE t.tgenabled = 'O' AND t.tgname IN ('payment_intents_guard', 'payment_intents_audit',
            'payment_returns_guard', 'payment_transactions_append_only', 'payment_reversals_append_only', 'payment_intent_events_append_only',
            'payment_intents_no_truncate', 'payment_returns_no_truncate', 'payment_transactions_no_truncate',
            'payment_reversals_no_truncate', 'payment_intent_events_no_truncate')) = 11, ''
  UNION ALL
  SELECT '14', 'idempotency / uniqueness indexes present',
         (SELECT count(*) FROM pg_class c WHERE c.relkind = 'i' AND c.relnamespace = 'public'::regnamespace AND c.relname IN (
            'payment_intents_checkout_key_key', 'payment_intents_hyp_order_ref_key', 'payment_intents_order_id_key',
            'payment_intents_open_phone_uq', 'payment_intents_open_parcel_uq', 'payment_transactions_hyp_trans_id_key',
            'payment_returns_intent_raw_key')) = 7, ''
  UNION ALL
  SELECT '15', 'payment trigger functions are not executable by application roles',
         NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
                      AND p.proname IN ('payment_append_only', 'payment_intents_guard', 'payment_intents_audit', 'payment_returns_guard', 'orders_online_payment_guard')
                      AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
                           OR has_function_privilege('service_role', p.oid, 'EXECUTE'))), ''
  UNION ALL
  SELECT '17', 'transaction outcome rule (HYP-06A): approved ⇔ CCode 0, non_capture ⇔ CCode 600 / 700 / 800, else declined',
         COALESCE((SELECT pg_get_constraintdef(c.oid) LIKE '%non_capture%' AND pg_get_constraintdef(c.oid) LIKE '%''600''%''700''%''800''%'
                     FROM pg_constraint c WHERE c.conrelid = to_regclass('public.payment_transactions')
                      AND c.conname = 'payment_transactions_outcome_check'), false), ''
  UNION ALL
  SELECT '18', 'staff recovery (HYP-09): attention flag columns + one reversal per HYP reference',
         (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'payment_intents'
           AND column_name IN ('staff_flag', 'staff_flag_note', 'staff_flag_by', 'staff_flag_at')) = 4
         AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.payment_reversals')
                      AND conname = 'payment_reversals_reference_key' AND contype = 'u'), ''
  UNION ALL
  SELECT '16', 'INFO payment intents by status (counts only)', NULL,
         CASE WHEN to_regclass('public.payment_intents') IS NULL THEN 'table missing'
              ELSE (xpath('/row/c/text()', query_to_xml('SELECT COALESCE(string_agg(status || ''='' || n, '', '' ORDER BY status), ''none'') AS c FROM (SELECT status, count(*) AS n FROM public.payment_intents GROUP BY status) s', false, true, '')))[1]::text END
)
SELECT check_id, check_name,
       CASE WHEN ok IS NULL THEN 'INFO' WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result,
       detail
FROM checks
ORDER BY check_id;
