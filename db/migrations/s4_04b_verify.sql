-- FALAFEL BATACHANA — s4_04b_verify.sql (S4-INTEGRATIONS-04B1) — READ-ONLY, ONE SELECT.
-- Run AFTER s4_04b_maale_quote_rate_limit.sql. Catalog + row COUNTs only: no order ids, no usernames, no writes.
-- Expected: every row PASS (rows 13–14 INFO).
-- Columns: check_id | check_name | result | detail
WITH
t AS (SELECT to_regclass('public.maale_dispatch_requests') AS oid),
cols AS (
  SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS ty, a.attnotnull, pg_get_expr(d.adbin, d.adrelid) AS def
  FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE a.attrelid = (SELECT oid FROM t) AND a.attnum > 0 AND NOT a.attisdropped
),
cons AS (
  SELECT c.conname, c.contype, c.convalidated, pg_get_constraintdef(c.oid) AS def
  FROM pg_constraint c WHERE c.conrelid = (SELECT oid FROM t)
),
idx AS (
  SELECT i.relname, pg_get_indexdef(i.oid) AS def
  FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid WHERE x.indrelid = (SELECT oid FROM t)
),
tacl AS (
  SELECT a.grantee, a.privilege_type
  FROM pg_class c, LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
  WHERE c.oid = (SELECT oid FROM t) AND a.grantee <> c.relowner
),
fn AS (
  SELECT p.oid, pg_get_function_identity_arguments(p.oid) AS args, pg_get_function_result(p.oid) AS res, p.prosecdef,
         p.proconfig, p.provolatile, l.lanname, p.proacl, p.proowner, md5(p.prosrc) AS h, length(p.prosrc) AS len
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang
  WHERE n.nspname = 'public' AND p.proname = 'consume_maale_quote_slot'
),
facl AS (
  SELECT a.grantee, a.privilege_type
  FROM fn, LATERAL aclexplode(COALESCE(fn.proacl, acldefault('f', fn.proowner))) a
  WHERE a.grantee <> fn.proowner
),
checks (check_id, check_name, ok, detail) AS (
  SELECT '01', 'maale_dispatch_requests: exactly the 5 reviewed columns',
         (SELECT count(*) FROM cols) = 5
         AND EXISTS (SELECT 1 FROM cols WHERE attname = 'id' AND ty = 'uuid' AND attnotnull AND def = 'gen_random_uuid()')
         AND EXISTS (SELECT 1 FROM cols WHERE attname = 'order_id' AND ty = 'uuid' AND attnotnull AND def IS NULL)
         AND EXISTS (SELECT 1 FROM cols WHERE attname = 'branch_id' AND ty = 'uuid' AND attnotnull AND def IS NULL)
         AND EXISTS (SELECT 1 FROM cols WHERE attname = 'actor_username' AND ty = 'text' AND attnotnull AND def IS NULL)
         AND EXISTS (SELECT 1 FROM cols WHERE attname = 'created_at' AND ty = 'timestamp with time zone' AND attnotnull AND def = 'now()'),
         COALESCE((SELECT string_agg(attname || ':' || ty, ', ' ORDER BY attname) FROM cols), 'table missing')
  UNION ALL
  SELECT '02', 'primary key on (id)',
         EXISTS (SELECT 1 FROM cons WHERE conname = 'maale_dispatch_requests_pkey' AND contype = 'p' AND def = 'PRIMARY KEY (id)'), ''
  UNION ALL
  SELECT '03', 'FK order_id → orders(id) and branch_id → branches(id), both ON UPDATE / ON DELETE RESTRICT',
         EXISTS (SELECT 1 FROM cons WHERE conname = 'maale_dispatch_requests_order_id_fkey' AND convalidated
                   AND def = 'FOREIGN KEY (order_id) REFERENCES orders(id) ON UPDATE RESTRICT ON DELETE RESTRICT')
         AND EXISTS (SELECT 1 FROM cons WHERE conname = 'maale_dispatch_requests_branch_id_fkey' AND convalidated
                   AND def = 'FOREIGN KEY (branch_id) REFERENCES branches(id) ON UPDATE RESTRICT ON DELETE RESTRICT'),
         COALESCE((SELECT string_agg(def, ' | ' ORDER BY conname) FROM cons WHERE contype = 'f'), 'none')
  UNION ALL
  SELECT '04', 'actor_username CHECK = kitchen username rule ^[a-z0-9_-]{2,32}$',
         EXISTS (SELECT 1 FROM cons WHERE conname = 'maale_dispatch_requests_actor_format' AND contype = 'c' AND convalidated
                   AND def = 'CHECK ((actor_username ~ ''^[a-z0-9_-]{2,32}$''::text))'),
         COALESCE((SELECT def FROM cons WHERE conname = 'maale_dispatch_requests_actor_format'), 'missing')
  UNION ALL
  SELECT '05', 'exactly 4 constraints (pk, 2 fk, 1 check) and 4 indexes (pk + created_at, order/created_at, branch/created_at)',
         (SELECT count(*) FROM cons) = 4
         AND (SELECT count(*) FROM idx) = 4
         AND EXISTS (SELECT 1 FROM idx WHERE relname = 'maale_dispatch_requests_created_at_idx' AND def LIKE '%USING btree (created_at)')
         AND EXISTS (SELECT 1 FROM idx WHERE relname = 'maale_dispatch_requests_order_created_at_idx' AND def LIKE '%USING btree (order_id, created_at)')
         AND EXISTS (SELECT 1 FROM idx WHERE relname = 'maale_dispatch_requests_branch_created_at_idx' AND def LIKE '%USING btree (branch_id, created_at)'),
         (SELECT count(*) FROM cons)::text || ' constraints, ' || (SELECT count(*) FROM idx)::text || ' indexes'
  UNION ALL
  SELECT '06', 'RLS enabled (not forced), no policies, no triggers',
         EXISTS (SELECT 1 FROM pg_class WHERE oid = (SELECT oid FROM t) AND relrowsecurity AND NOT relforcerowsecurity)
         AND NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = (SELECT oid FROM t))
         AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = (SELECT oid FROM t) AND NOT tgisinternal), ''
  UNION ALL
  SELECT '07', 'table privileges: exactly service_role SELECT + INSERT (nothing for PUBLIC / anon / authenticated)',
         (SELECT count(*) FROM tacl) = 2
         AND EXISTS (SELECT 1 FROM tacl WHERE grantee = 'service_role'::regrole AND privilege_type = 'SELECT')
         AND EXISTS (SELECT 1 FROM tacl WHERE grantee = 'service_role'::regrole AND privilege_type = 'INSERT'),
         COALESCE((SELECT string_agg(CASE WHEN grantee = 0 THEN 'PUBLIC' ELSE grantee::regrole::text END || ':' || privilege_type, ', ' ORDER BY 1) FROM tacl), 'none')
  UNION ALL
  SELECT '08', 'consume_maale_quote_slot: exactly one, (p_order_id uuid, p_branch_id uuid, p_actor text) → text',
         (SELECT count(*) FROM fn) = 1
         AND EXISTS (SELECT 1 FROM fn WHERE args = 'p_order_id uuid, p_branch_id uuid, p_actor text' AND res = 'text'),
         (SELECT count(*) FROM fn)::text || ' found'
  UNION ALL
  SELECT '09', 'function: plpgsql, VOLATILE, SECURITY INVOKER, search_path '''', lock_timeout 3s',
         EXISTS (SELECT 1 FROM fn WHERE lanname = 'plpgsql' AND provolatile = 'v' AND NOT prosecdef
                   AND proconfig = ARRAY['search_path=""', 'lock_timeout=3s']),
         COALESCE((SELECT array_to_string(proconfig, ', ') FROM fn), '')
  UNION ALL
  SELECT '10', 'function EXECUTE: exactly service_role (not PUBLIC / anon / authenticated)',
         (SELECT count(*) FROM facl) = 1
         AND EXISTS (SELECT 1 FROM facl WHERE grantee = 'service_role'::regrole AND privilege_type = 'EXECUTE'),
         COALESCE((SELECT string_agg(CASE WHEN grantee = 0 THEN 'PUBLIC' ELSE grantee::regrole::text END || ':' || privilege_type, ', ') FROM facl), 'none')
  UNION ALL
  SELECT '11', 'function body = reviewed s4_04b body (LF 9fd1a1a1… / 1877 or CRLF 71581e48… / 1919)',
         EXISTS (SELECT 1 FROM fn WHERE (h = '9fd1a1a1e717a57d3efad05cfb7eaa49' AND len = 1877) OR (h = '71581e48e039ea3dadeb34ad04930afa' AND len = 1919)),
         COALESCE((SELECT h || ' / ' || len FROM fn), '')
  UNION ALL
  SELECT '12', 'public.delivery_dispatches still has no column / constraint added by 04B (no maale_dispatch_requests reference)',
         NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.delivery_dispatches')
                       AND confrelid = (SELECT oid FROM t)), ''
  UNION ALL
  SELECT '13', 'INFO ledger rows total / last 60 min (counts only)', NULL,
         CASE WHEN (SELECT oid FROM t) IS NULL THEN 'table missing'
              ELSE (xpath('/row/c/text()', query_to_xml('SELECT count(*) || '' / '' || count(*) FILTER (WHERE created_at > now() - interval ''60 minutes'') AS c FROM public.maale_dispatch_requests', false, true, '')))[1]::text END
  UNION ALL
  SELECT '14', 'INFO public.delivery_dispatches rows (count only; never changed by 04B)', NULL,
         CASE WHEN to_regclass('public.delivery_dispatches') IS NULL THEN 'table missing'
              ELSE (xpath('/row/c/text()', query_to_xml('SELECT count(*) AS c FROM public.delivery_dispatches', false, true, '')))[1]::text END
)
SELECT check_id, check_name,
       CASE WHEN ok IS NULL THEN 'INFO' WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result,
       detail
FROM checks
ORDER BY check_id;
