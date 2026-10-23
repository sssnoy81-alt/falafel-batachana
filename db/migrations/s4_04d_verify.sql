-- FALAFEL BATACHANA — s4_04d_verify.sql (S4-INTEGRATIONS-04D1) — READ-ONLY, ONE SELECT.
-- Run AFTER s4_04d_maale_dispatch_reconciliations.sql. Catalog + row COUNTs only: no order ids, no names, no writes.
-- Expected: every row PASS (rows 11–12 INFO).
-- Columns: check_id | check_name | result | detail
WITH
t AS (SELECT to_regclass('public.maale_dispatch_reconciliations') AS oid),
cols AS (
  SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS ty, a.attnotnull, pg_get_expr(d.adbin, d.adrelid) AS def
  FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE a.attrelid = (SELECT oid FROM t) AND a.attnum > 0 AND NOT a.attisdropped
),
cons AS (SELECT c.conname, c.convalidated, pg_get_constraintdef(c.oid) AS def FROM pg_constraint c WHERE c.conrelid = (SELECT oid FROM t)),
idx AS (SELECT i.relname, pg_get_indexdef(i.oid) AS def FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid WHERE x.indrelid = (SELECT oid FROM t)),
tacl AS (
  SELECT a.grantee, a.privilege_type
  FROM pg_class c, LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
  WHERE c.oid = (SELECT oid FROM t) AND a.grantee <> c.relowner
),
expected (conname, def) AS (VALUES
  ('maale_dispatch_reconciliations_pkey', 'PRIMARY KEY (id)'),
  ('maale_dispatch_reconciliations_request_id_key', 'UNIQUE (request_id)'),
  ('maale_dispatch_reconciliations_order_id_fkey', 'FOREIGN KEY (order_id) REFERENCES orders(id) ON UPDATE RESTRICT ON DELETE RESTRICT'),
  ('maale_dispatch_reconciliations_event_type_check', 'CHECK ((event_type = ANY (ARRAY[''confirmed_sent''::text, ''cancelled_at_provider''::text, ''not_received''::text, ''manual_courier''::text, ''provider_status_checked''::text, ''manual_review_opened''::text, ''manual_review_resolved''::text])))'),
  ('maale_dispatch_reconciliations_actor_format', 'CHECK ((actor_username ~ ''^[a-z0-9_-]{2,32}$''::text))'),
  ('maale_dispatch_reconciliations_provider_order_id_format', 'CHECK (((provider_order_id IS NULL) OR (provider_order_id ~ ''^[A-Za-z0-9_-]{1,100}$''::text)))'),
  ('maale_dispatch_reconciliations_provider_status_format', 'CHECK (((provider_status IS NULL) OR (provider_status ~ ''^[a-z_]{1,40}$''::text)))'),
  ('maale_dispatch_reconciliations_provider_order_id_rule', 'CHECK ((((event_type = ANY (ARRAY[''confirmed_sent''::text, ''cancelled_at_provider''::text])) AND (provider_order_id IS NOT NULL)) OR ((event_type = ANY (ARRAY[''not_received''::text, ''manual_courier''::text])) AND (provider_order_id IS NULL)) OR (event_type = ANY (ARRAY[''provider_status_checked''::text, ''manual_review_opened''::text, ''manual_review_resolved''::text]))))'),
  ('maale_dispatch_reconciliations_provider_status_rule', 'CHECK (((provider_status IS NULL) OR (event_type = ''provider_status_checked''::text)))'),
  ('maale_dispatch_reconciliations_reason_code_check', 'CHECK (((reason_code IS NULL) OR (reason_code = ANY (ARRAY[''provider_phone_confirmed''::text, ''provider_dashboard_confirmed''::text, ''customer_cancelled''::text, ''kitchen_cancelled''::text, ''outcome_unknown''::text, ''persistence_failed''::text, ''duplicate_suspected''::text, ''courier_booked_by_phone''::text, ''other''::text]))))')
),
checks (check_id, check_name, ok, detail) AS (
  SELECT '01', 'maale_dispatch_reconciliations: exactly the 9 reviewed columns (no free-text column)',
         (SELECT count(*) FROM cols) = 9
         AND EXISTS (SELECT 1 FROM cols WHERE attname = 'id' AND ty = 'uuid' AND attnotnull AND def = 'gen_random_uuid()')
         AND EXISTS (SELECT 1 FROM cols WHERE attname = 'request_id' AND ty = 'uuid' AND attnotnull AND def IS NULL)
         AND EXISTS (SELECT 1 FROM cols WHERE attname = 'order_id' AND ty = 'uuid' AND attnotnull AND def IS NULL)
         AND EXISTS (SELECT 1 FROM cols WHERE attname = 'event_type' AND ty = 'text' AND attnotnull AND def IS NULL)
         AND EXISTS (SELECT 1 FROM cols WHERE attname = 'actor_username' AND ty = 'text' AND attnotnull AND def IS NULL)
         AND EXISTS (SELECT 1 FROM cols WHERE attname = 'provider_order_id' AND ty = 'text' AND NOT attnotnull AND def IS NULL)
         AND EXISTS (SELECT 1 FROM cols WHERE attname = 'provider_status' AND ty = 'text' AND NOT attnotnull AND def IS NULL)
         AND EXISTS (SELECT 1 FROM cols WHERE attname = 'reason_code' AND ty = 'text' AND NOT attnotnull AND def IS NULL)
         AND EXISTS (SELECT 1 FROM cols WHERE attname = 'created_at' AND ty = 'timestamp with time zone' AND attnotnull AND def = 'now()'),
         COALESCE((SELECT string_agg(attname || ':' || ty, ', ' ORDER BY attname) FROM cols), 'table missing')
  UNION ALL
  SELECT '02', 'exactly the 10 reviewed constraints with their exact definitions, all validated',
         (SELECT count(*) FROM cons) = 10
         AND NOT EXISTS (SELECT 1 FROM expected e WHERE NOT EXISTS (SELECT 1 FROM cons c WHERE c.conname = e.conname AND c.def = e.def AND c.convalidated)),
         COALESCE((SELECT string_agg(e.conname, ', ') FROM expected e WHERE NOT EXISTS (SELECT 1 FROM cons c WHERE c.conname = e.conname AND c.def = e.def)), 'all match')
  UNION ALL
  SELECT '03', 'exactly 4 indexes: pkey, UNIQUE (request_id), (order_id, created_at DESC, id DESC), (created_at)',
         (SELECT count(*) FROM idx) = 4
         AND EXISTS (SELECT 1 FROM idx WHERE relname = 'maale_dispatch_reconciliations_request_id_key' AND def LIKE 'CREATE UNIQUE INDEX%USING btree (request_id)')
         AND EXISTS (SELECT 1 FROM idx WHERE relname = 'maale_dispatch_reconciliations_order_created_at_idx' AND def LIKE '%USING btree (order_id, created_at DESC, id DESC)')
         AND EXISTS (SELECT 1 FROM idx WHERE relname = 'maale_dispatch_reconciliations_created_at_idx' AND def LIKE '%USING btree (created_at)'),
         (SELECT count(*) FROM idx)::text || ' indexes'
  UNION ALL
  SELECT '04', 'RLS enabled (not forced), no policies, no triggers',
         EXISTS (SELECT 1 FROM pg_class WHERE oid = (SELECT oid FROM t) AND relrowsecurity AND NOT relforcerowsecurity)
         AND NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = (SELECT oid FROM t))
         AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = (SELECT oid FROM t) AND NOT tgisinternal), ''
  UNION ALL
  SELECT '05', 'table privileges: exactly service_role SELECT + INSERT (no UPDATE / DELETE; nothing for PUBLIC / anon / authenticated)',
         (SELECT count(*) FROM tacl) = 2
         AND EXISTS (SELECT 1 FROM tacl WHERE grantee = 'service_role'::regrole AND privilege_type = 'SELECT')
         AND EXISTS (SELECT 1 FROM tacl WHERE grantee = 'service_role'::regrole AND privilege_type = 'INSERT'),
         COALESCE((SELECT string_agg(CASE WHEN grantee = 0 THEN 'PUBLIC' ELSE grantee::regrole::text END || ':' || privilege_type, ', ' ORDER BY 1) FROM tacl), 'none')
  UNION ALL
  SELECT '06', 'no function / trigger / view in public refers to the ledger (manual records only)',
         NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.refobjid = (SELECT oid FROM t) AND d.classid IN ('pg_rewrite'::regclass, 'pg_trigger'::regclass)
                       AND d.objid NOT IN (SELECT oid FROM pg_rewrite WHERE ev_class = (SELECT oid FROM t))), ''
  UNION ALL
  SELECT '07', 'nothing references the ledger by FK (it never constrains dispatch / order tables)',
         NOT EXISTS (SELECT 1 FROM pg_constraint WHERE confrelid = (SELECT oid FROM t)), ''
  UNION ALL
  SELECT '08', 'public.delivery_dispatches has no constraint pointing at the ledger (dispatch rows unchanged in shape)',
         to_regclass('public.delivery_dispatches') IS NULL
         OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.delivery_dispatches') AND confrelid = (SELECT oid FROM t)), ''
  UNION ALL
  SELECT '09', 'every stored row satisfies the rules (constraints validated)',
         NOT EXISTS (SELECT 1 FROM cons WHERE NOT convalidated), ''
  UNION ALL
  SELECT '10', 'ledger owner is not anon / authenticated / service_role',
         EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = (SELECT oid FROM t) AND c.relowner::regrole::text NOT IN ('anon', 'authenticated', 'service_role')), ''
  UNION ALL
  SELECT '11', 'INFO ledger rows by event_type (counts only)', NULL,
         CASE WHEN (SELECT oid FROM t) IS NULL THEN 'table missing'
              ELSE (xpath('/row/c/text()', query_to_xml('SELECT COALESCE(string_agg(event_type || ''='' || n, '', '' ORDER BY event_type), ''none'') AS c FROM (SELECT event_type, count(*) AS n FROM public.maale_dispatch_reconciliations GROUP BY event_type) s', false, true, '')))[1]::text END
  UNION ALL
  SELECT '12', 'INFO public.delivery_dispatches rows by status (counts only; never changed by 04D)', NULL,
         CASE WHEN to_regclass('public.delivery_dispatches') IS NULL THEN 'table missing'
              ELSE (xpath('/row/c/text()', query_to_xml('SELECT COALESCE(string_agg(status || ''='' || n, '', '' ORDER BY status), ''none'') AS c FROM (SELECT status, count(*) AS n FROM public.delivery_dispatches GROUP BY status) s', false, true, '')))[1]::text END
)
SELECT check_id, check_name,
       CASE WHEN ok IS NULL THEN 'INFO' WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result,
       detail
FROM checks
ORDER BY check_id;
