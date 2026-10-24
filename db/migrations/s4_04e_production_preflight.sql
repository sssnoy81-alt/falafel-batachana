-- FALAFEL BATACHANA — s4_04e_production_preflight.sql (S4-INTEGRATIONS-04E1/04E2) — READ-ONLY, ONE SELECT.
-- Run BEFORE s4_04e_courier_coordination.sql (and only after 04B + 04D are installed and verified).
-- Catalog + row COUNTs only: no customer data, no writes. Expected: every row PASS (rows 10–11 INFO).
-- Row 12 (04F2): PostgreSQL >= 16 is required — FAIL means DO NOT install (the migration would refuse anyway).
-- Columns: check_id | check_name | result | detail
WITH
me AS (SELECT r.rolname, r.rolsuper, r.rolbypassrls, r.rolcreaterole FROM pg_roles r WHERE r.rolname = current_user),
checks (check_id, check_name, ok, detail) AS (
  SELECT '01', 'S4-04B installed (maale_dispatch_requests + consume_maale_quote_slot)',
         to_regclass('public.maale_dispatch_requests') IS NOT NULL AND to_regprocedure('public.consume_maale_quote_slot(uuid, uuid, text)') IS NOT NULL, ''
  UNION ALL
  SELECT '02', 'S4-04D installed (maale_dispatch_reconciliations with UNIQUE request_id)',
         to_regclass('public.maale_dispatch_reconciliations') IS NOT NULL
         AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.maale_dispatch_reconciliations')
                       AND conname = 'maale_dispatch_reconciliations_request_id_key' AND contype = 'u'), ''
  UNION ALL
  SELECT '03', 'delivery_dispatches has the 7 columns the claim uses',
         (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'delivery_dispatches'
           AND column_name IN ('order_id', 'status', 'attempts', 'last_attempt_at', 'error_code', 'provider_order_id', 'updated_at')) = 7, ''
  UNION ALL
  SELECT '04', 'delivery_dispatches.order_id is UNIQUE; status CHECK covers the 5 reviewed statuses',
         EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
                  WHERE c.conrelid = to_regclass('public.delivery_dispatches') AND c.contype = 'u' AND array_length(c.conkey, 1) = 1 AND a.attname = 'order_id')
         AND EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = to_regclass('public.delivery_dispatches') AND c.conname = 'delivery_dispatches_status_check'
                  AND pg_get_constraintdef(c.oid) LIKE '%pending%sending%sent%failed_retryable%failed_final%'), ''
  UNION ALL
  SELECT '05', 'no S4-04E function, trigger or coordinator role exists yet',
         NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
                      AND p.proname IN ('claim_maale_dispatch', 'record_maale_reconciliation_event', 'delivery_dispatches_coordination_guard'))
         AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('public.delivery_dispatches') AND tgname = 'delivery_dispatches_coordination_guard')
         AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'maale_dispatch_coordinator'), ''
  UNION ALL
  SELECT '06', 'installing role can create the NOLOGIN BYPASSRLS coordinator role (CREATEROLE + BYPASSRLS, or superuser)',
         (SELECT (rolsuper OR rolcreaterole) AND (rolsuper OR rolbypassrls) FROM me),
         current_user || ' (super=' || (SELECT rolsuper FROM me)::text || ', createrole=' || (SELECT rolcreaterole FROM me)::text
           || ', bypassrls=' || (SELECT rolbypassrls FROM me)::text || ')'
  UNION ALL
  SELECT '07', 'service_role is not a superuser and has no CREATEROLE (cannot make itself a coordinator)',
         EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role' AND NOT rolsuper AND NOT rolcreaterole), ''
  UNION ALL
  -- OID form (to_regclass): a missing table yields NULL → FAIL row, never an error (the preflight must always run).
  SELECT '08', 'service_role has SELECT + UPDATE on delivery_dispatches (unchanged by 04E)',
         COALESCE(has_table_privilege('service_role', to_regclass('public.delivery_dispatches'), 'SELECT')
                  AND has_table_privilege('service_role', to_regclass('public.delivery_dispatches'), 'UPDATE'), false), ''
  UNION ALL
  SELECT '09', 'service_role has SELECT + INSERT on the ledger (pre-04E state; 04E removes INSERT)',
         COALESCE(has_table_privilege('service_role', to_regclass('public.maale_dispatch_reconciliations'), 'SELECT')
                  AND has_table_privilege('service_role', to_regclass('public.maale_dispatch_reconciliations'), 'INSERT'), false), ''
  UNION ALL
  SELECT '10', 'INFO other user triggers on delivery_dispatches (names only)', NULL,
         COALESCE((SELECT string_agg(tgname, ', ' ORDER BY tgname) FROM pg_trigger WHERE tgrelid = to_regclass('public.delivery_dispatches') AND NOT tgisinternal), 'none')
  UNION ALL
  SELECT '11', 'INFO delivery_dispatches rows by status (counts only; 04E changes none)', NULL,
         CASE WHEN to_regclass('public.delivery_dispatches') IS NULL THEN 'table missing'
              ELSE (xpath('/row/c/text()', query_to_xml('SELECT COALESCE(string_agg(status || ''='' || n, '', '' ORDER BY status), ''none'') AS c FROM (SELECT status, count(*) AS n FROM public.delivery_dispatches GROUP BY status) s', false, true, '')))[1]::text END
  UNION ALL
  SELECT '12', 'PostgreSQL 16 or newer (required by the coordinator role / ownership transfer)',
         current_setting('server_version_num')::integer >= 160000, current_setting('server_version')
)
SELECT check_id, check_name,
       CASE WHEN ok IS NULL THEN 'INFO' WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result,
       detail
FROM checks
ORDER BY check_id;
