-- FALAFEL BATACHANA — hyp05_production_preflight.sql (HYP-05) — READ-ONLY, ONE SELECT.
-- Run BEFORE hyp05_payment_intents.sql. Catalog + row COUNTs only: no customer data, no writes.
-- Expected: every row PASS (rows 13–14 INFO). Any FAIL means DO NOT install (the migration would refuse anyway).
-- Columns: check_id | check_name | result | detail
WITH
me AS (SELECT r.rolname, r.rolsuper, r.rolbypassrls, r.rolcreaterole FROM pg_roles r WHERE r.rolname = current_user),
fp AS (
  SELECT p.oid, p.proname, md5(p.prosrc) || '/' || length(p.prosrc) AS print, p.prosecdef, p.proconfig
  FROM pg_proc p
  WHERE p.oid IN (to_regprocedure('public.create_order(jsonb, jsonb, jsonb)'),
                  to_regprocedure('public.create_order_with_parcel(jsonb, jsonb, jsonb, jsonb)'))
),
checks (check_id, check_name, ok, detail) AS (
  SELECT '01', 'PostgreSQL 16 or newer (coordinator role / ownership transfer)',
         current_setting('server_version_num')::integer >= 160000, current_setting('server_version')
  UNION ALL
  SELECT '02', 'create_order is the reviewed Production body db92e75f… / 6416',
         COALESCE((SELECT print FROM fp WHERE proname = 'create_order') = 'db92e75f8bfdadb6d78be035da855996/6416', false),
         COALESCE((SELECT print FROM fp WHERE proname = 'create_order'), 'missing')
  UNION ALL
  SELECT '03', 'create_order_with_parcel is the reviewed post-05 body (CRLF 6ceb72f6… or LF afbe93d7…)',
         COALESCE((SELECT print FROM fp WHERE proname = 'create_order_with_parcel')
                    IN ('6ceb72f6c80929adddd7a2b7bb1a0616/2771', 'afbe93d74b201d6bd898edd2b6e28a63/2656'), false),
         COALESCE((SELECT print FROM fp WHERE proname = 'create_order_with_parcel'), 'missing')
  UNION ALL
  SELECT '04', 'both are SECURITY INVOKER with search_path ''''',
         (SELECT count(*) FROM fp WHERE NOT prosecdef AND proconfig = ARRAY['search_path=""']) = 2, ''
  UNION ALL
  SELECT '05', 'order / parcel tables, branches and orders_order_number_seq exist',
         to_regclass('public.orders') IS NOT NULL AND to_regclass('public.order_items') IS NOT NULL
         AND to_regclass('public.deliveries') IS NOT NULL AND to_regclass('public.parcel_requests') IS NOT NULL
         AND to_regclass('public.parcel_events') IS NOT NULL AND to_regclass('public.branches') IS NOT NULL
         AND to_regclass('public.orders_order_number_seq') IS NOT NULL, ''
  UNION ALL
  SELECT '06', 'orders_payment_method_check is exactly cash / credit / cibus / bit',
         COALESCE((SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
                    WHERE c.conrelid = to_regclass('public.orders') AND c.conname = 'orders_payment_method_check')
                  = 'CHECK ((payment_method = ANY (ARRAY[''cash''::text, ''credit''::text, ''cibus''::text, ''bit''::text])))', false), ''
  UNION ALL
  -- query_to_xml: a missing table yields a FAIL row, never an error (the preflight must always run).
  SELECT '07', 'no order uses payment_method online yet (count)',
         CASE WHEN to_regclass('public.orders') IS NULL THEN false
              ELSE (xpath('/row/n/text()', query_to_xml('SELECT count(*) AS n FROM public.orders WHERE payment_method = ''online''', false, true, '')))[1]::text = '0' END,
         ''
  UNION ALL
  SELECT '08', 'no HYP-05 role, table or function exists yet',
         NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hyp_payment_coordinator')
         AND to_regclass('public.payment_intents') IS NULL AND to_regclass('public.payment_returns') IS NULL
         AND to_regclass('public.payment_transactions') IS NULL AND to_regclass('public.payment_reversals') IS NULL
         AND to_regclass('public.payment_intent_events') IS NULL
         AND NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
                          AND p.proname IN ('create_payment_intent', 'record_hyp_sign_result', 'record_hyp_return', 'record_hyp_verification',
                                            'finalize_paid_intent', 'sweep_expired_payment_intents', 'resolve_payment_intent',
                                            'orders_online_payment_guard', 'payment_intents_guard', 'payment_intents_audit',
                                            'payment_returns_guard', 'payment_append_only')), ''
  UNION ALL
  SELECT '09', 'installing role can create the NOLOGIN BYPASSRLS coordinator role',
         (SELECT (rolsuper OR rolcreaterole) AND (rolsuper OR rolbypassrls) FROM me),
         current_user || ' (super=' || (SELECT rolsuper FROM me)::text || ', createrole=' || (SELECT rolcreaterole FROM me)::text
           || ', bypassrls=' || (SELECT rolbypassrls FROM me)::text || ')'
  UNION ALL
  SELECT '10', 'service_role: BYPASSRLS, not superuser, no CREATEROLE',
         EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role' AND rolbypassrls AND NOT rolsuper AND NOT rolcreaterole), ''
  UNION ALL
  SELECT '11', 'service_role can EXECUTE create_order and holds the INSERT privilege on orders (unchanged by HYP-05)',
         COALESCE(has_function_privilege('service_role', to_regprocedure('public.create_order(jsonb, jsonb, jsonb)'), 'EXECUTE')
                  AND has_table_privilege('service_role', to_regclass('public.orders'), 'INSERT'), false), ''
  UNION ALL
  SELECT '12', 'anon / authenticated hold no privilege on orders, order_items, deliveries (effective, incl. PUBLIC and column grants)',
         NOT EXISTS (SELECT 1 FROM (VALUES ('anon'), ('authenticated')) AS r(role),
                                   (VALUES ('public.orders'), ('public.order_items'), ('public.deliveries')) AS t(rel),
                                   (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')) AS p(priv)
                      WHERE to_regclass(t.rel) IS NOT NULL AND has_any_column_privilege(r.role, to_regclass(t.rel), p.priv)), ''
  UNION ALL
  SELECT '13', 'INFO user triggers on orders (names only)', NULL,
         COALESCE((SELECT string_agg(tgname, ', ' ORDER BY tgname) FROM pg_trigger WHERE tgrelid = to_regclass('public.orders') AND NOT tgisinternal), 'none')
  UNION ALL
  SELECT '14', 'INFO orders by payment_method (counts only)', NULL,
         CASE WHEN to_regclass('public.orders') IS NULL THEN 'table missing'
              ELSE (xpath('/row/c/text()', query_to_xml('SELECT COALESCE(string_agg(m || ''='' || n, '', '' ORDER BY m), ''none'') AS c FROM (SELECT COALESCE(payment_method, ''(null)'') AS m, count(*) AS n FROM public.orders GROUP BY 1) s', false, true, '')))[1]::text END
)
SELECT check_id, check_name,
       CASE WHEN ok IS NULL THEN 'INFO' WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result,
       detail
FROM checks
ORDER BY check_id;
