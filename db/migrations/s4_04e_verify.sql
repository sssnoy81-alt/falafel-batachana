-- FALAFEL BATACHANA — s4_04e_verify.sql (S4-INTEGRATIONS-04E1/04E2) — READ-ONLY, ONE SELECT.
-- Run AFTER s4_04e_courier_coordination.sql. Catalog + row COUNTs only: no ids, no names, no writes.
-- Expected: every row PASS (rows 15–16 INFO). For the whole 04B + 04D + 04E state use s4_04_combined_verify.sql.
-- Columns: check_id | check_name | result | detail
WITH
fn AS (
  SELECT p.oid, p.proname, pg_get_function_identity_arguments(p.oid) AS args, pg_get_function_result(p.oid) AS res, p.prosecdef,
         p.proconfig, p.provolatile, l.lanname, p.proowner, p.proacl, md5(p.prosrc) AS h, length(p.prosrc) AS len
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang
  WHERE n.nspname = 'public' AND p.proname IN ('claim_maale_dispatch', 'record_maale_reconciliation_event', 'delivery_dispatches_coordination_guard')
),
coord AS (SELECT * FROM pg_roles WHERE rolname = 'maale_dispatch_coordinator'),
facl AS (
  SELECT fn.proname, a.grantee, a.privilege_type
  FROM fn, LATERAL aclexplode(COALESCE(fn.proacl, acldefault('f', fn.proowner))) a WHERE a.grantee <> fn.proowner
),
tacl AS (
  SELECT c.relname, CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS grantee, a.privilege_type
  FROM pg_class c, LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
  WHERE c.oid IN (to_regclass('public.maale_dispatch_reconciliations'), to_regclass('public.delivery_dispatches'), to_regclass('public.orders'))
    AND a.grantee <> c.relowner
),
cacl AS (
  SELECT c.relname, a.attname, CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END AS grantee, x.privilege_type
  FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL,
       LATERAL aclexplode(a.attacl) x
  WHERE c.oid IN (to_regclass('public.maale_dispatch_reconciliations'), to_regclass('public.delivery_dispatches'), to_regclass('public.orders'))
),
ccoord AS (
  SELECT relname, string_agg(privilege_type || '(' || attname || ')', ',' ORDER BY privilege_type COLLATE "C", attname COLLATE "C") AS s
  FROM cacl WHERE grantee = 'maale_dispatch_coordinator' GROUP BY relname
),
checks (check_id, check_name, ok, detail) AS (
  SELECT '01', 'exactly the 3 reviewed functions, one each',
         (SELECT count(*) FROM fn) = 3 AND (SELECT count(DISTINCT proname) FROM fn) = 3, (SELECT count(*) FROM fn)::text || ' found'
  UNION ALL
  SELECT '02', 'claim_maale_dispatch(uuid, integer, timestamptz) → text: plpgsql VOLATILE DEFINER, search_path '''', lock_timeout 3s',
         EXISTS (SELECT 1 FROM fn WHERE proname = 'claim_maale_dispatch' AND args = 'p_order_id uuid, p_seen_attempts integer, p_seen_last_attempt_at timestamp with time zone'
                   AND res = 'text' AND lanname = 'plpgsql' AND provolatile = 'v' AND prosecdef AND proconfig = ARRAY['search_path=""', 'lock_timeout=3s']), ''
  UNION ALL
  SELECT '03', 'record_maale_reconciliation_event(7 args) → TABLE: plpgsql VOLATILE DEFINER, search_path '''', lock_timeout 3s',
         EXISTS (SELECT 1 FROM fn WHERE proname = 'record_maale_reconciliation_event'
                   AND args = 'p_request_id uuid, p_order_id uuid, p_event_type text, p_actor text, p_provider_order_id text, p_provider_status text, p_reason_code text'
                   AND res = 'TABLE(result text, event_id uuid, event_created_at timestamp with time zone)'
                   AND lanname = 'plpgsql' AND provolatile = 'v' AND prosecdef AND proconfig = ARRAY['search_path=""', 'lock_timeout=3s']), ''
  UNION ALL
  SELECT '04', 'guard trigger function: plpgsql INVOKER, search_path ''''',
         EXISTS (SELECT 1 FROM fn WHERE proname = 'delivery_dispatches_coordination_guard' AND res = 'trigger' AND lanname = 'plpgsql'
                   AND NOT prosecdef AND proconfig = ARRAY['search_path=""']), ''
  UNION ALL
  SELECT '05', 'coordinator role: NOLOGIN NOINHERIT BYPASSRLS, no other attribute, member of no role; schema public USAGE, no CREATE',
         EXISTS (SELECT 1 FROM coord WHERE NOT rolcanlogin AND NOT rolinherit AND rolbypassrls AND NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication)
         AND NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = (SELECT oid FROM coord))
         AND has_schema_privilege((SELECT oid FROM coord), 'public', 'USAGE') AND NOT has_schema_privilege((SELECT oid FROM coord), 'public', 'CREATE'), ''
  UNION ALL
  SELECT '06', 'no application role (service_role / anon / authenticated / authenticator) can act as the coordinator',
         EXISTS (SELECT 1 FROM coord)
         AND NOT pg_has_role('service_role', 'maale_dispatch_coordinator', 'MEMBER')
         AND NOT pg_has_role('anon', 'maale_dispatch_coordinator', 'MEMBER')
         AND NOT pg_has_role('authenticated', 'maale_dispatch_coordinator', 'MEMBER')
         AND NOT EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE m.roleid = (SELECT oid FROM coord)
                           AND r.rolname IN ('authenticator', 'service_role', 'anon', 'authenticated')),
         COALESCE((SELECT string_agg(r.rolname, ', ' ORDER BY r.rolname) FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE m.roleid = (SELECT oid FROM coord)), 'no members')
  UNION ALL
  SELECT '07', 'both coordination functions are owned by the coordinator; the guard by the installer',
         (SELECT count(*) FROM fn WHERE proname IN ('claim_maale_dispatch', 'record_maale_reconciliation_event') AND proowner = (SELECT oid FROM coord)) = 2
         AND EXISTS (SELECT 1 FROM fn WHERE proname = 'delivery_dispatches_coordination_guard' AND proowner <> (SELECT oid FROM coord)), ''
  UNION ALL
  SELECT '08', 'EXECUTE: claim + record → exactly service_role; guard → nobody',
         (SELECT count(*) FROM facl WHERE proname = 'claim_maale_dispatch') = 1
         AND EXISTS (SELECT 1 FROM facl WHERE proname = 'claim_maale_dispatch' AND grantee = 'service_role'::regrole AND privilege_type = 'EXECUTE')
         AND (SELECT count(*) FROM facl WHERE proname = 'record_maale_reconciliation_event') = 1
         AND EXISTS (SELECT 1 FROM facl WHERE proname = 'record_maale_reconciliation_event' AND grantee = 'service_role'::regrole AND privilege_type = 'EXECUTE')
         AND (SELECT count(*) FROM facl WHERE proname = 'delivery_dispatches_coordination_guard') = 0,
         COALESCE((SELECT string_agg(proname || ':' || CASE WHEN grantee = 0 THEN 'PUBLIC' ELSE grantee::regrole::text END, ', ' ORDER BY 1) FROM facl), 'none')
  UNION ALL
  SELECT '09', 'function bodies = reviewed s4_04e bodies (LF or CRLF fingerprints)',
         EXISTS (SELECT 1 FROM fn WHERE proname = 'claim_maale_dispatch' AND ((h = '4dbe74fdc561de56f334b86e13df6f07' AND len = 2393) OR (h = '58b148e95dd9ead585600172578147ff' AND len = 2444)))
         AND EXISTS (SELECT 1 FROM fn WHERE proname = 'record_maale_reconciliation_event' AND ((h = 'df2aae601026de16c9cf130b2aea1934' AND len = 5223) OR (h = '6ff732afd787e8b2b6c225dc9206a1df' AND len = 5305)))
         AND EXISTS (SELECT 1 FROM fn WHERE proname = 'delivery_dispatches_coordination_guard' AND ((h = '9a8d6a28ff2b39c5ad341965a4ecd38d' AND len = 1076) OR (h = '8400468eb3d50410e44035fea6cd79d4' AND len = 1097))),
         COALESCE((SELECT string_agg(proname || '=' || h || '/' || len, ', ' ORDER BY proname) FROM fn), '')
  UNION ALL
  SELECT '10', 'guard trigger: enabled, BEFORE INSERT OR UPDATE, FOR EACH ROW on delivery_dispatches',
         EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = to_regclass('public.delivery_dispatches') AND t.tgname = 'delivery_dispatches_coordination_guard'
                   AND t.tgenabled = 'O' AND NOT t.tgisinternal
                   AND pg_get_triggerdef(t.oid) = 'CREATE TRIGGER delivery_dispatches_coordination_guard BEFORE INSERT OR UPDATE ON public.delivery_dispatches FOR EACH ROW EXECUTE FUNCTION delivery_dispatches_coordination_guard()'), ''
  UNION ALL
  SELECT '11', 'ledger: table-level service_role SELECT + coordinator SELECT only; coordinator INSERT on the 7 payload columns only; no app-role INSERT',
         (SELECT count(*) FROM tacl WHERE relname = 'maale_dispatch_reconciliations') = 2
         AND EXISTS (SELECT 1 FROM tacl WHERE relname = 'maale_dispatch_reconciliations' AND grantee = 'service_role' AND privilege_type = 'SELECT')
         AND EXISTS (SELECT 1 FROM tacl WHERE relname = 'maale_dispatch_reconciliations' AND grantee = 'maale_dispatch_coordinator' AND privilege_type = 'SELECT')
         AND (SELECT s FROM ccoord WHERE relname = 'maale_dispatch_reconciliations') = 'INSERT(actor_username),INSERT(event_type),INSERT(order_id),INSERT(provider_order_id),INSERT(provider_status),INSERT(reason_code),INSERT(request_id)'
         AND NOT COALESCE(has_any_column_privilege('service_role', to_regclass('public.maale_dispatch_reconciliations'), 'INSERT')
                       OR has_any_column_privilege('anon', to_regclass('public.maale_dispatch_reconciliations'), 'INSERT')
                       OR has_any_column_privilege('authenticated', to_regclass('public.maale_dispatch_reconciliations'), 'INSERT'), true),
         COALESCE((SELECT string_agg(grantee || ':' || privilege_type, ', ' ORDER BY 1) FROM tacl WHERE relname = 'maale_dispatch_reconciliations'), 'none')
  UNION ALL
  SELECT '12', 'delivery_dispatches: table-level service_role SELECT + INSERT + UPDATE (unchanged); coordinator column-level claim columns only',
         (SELECT count(*) FROM tacl WHERE relname = 'delivery_dispatches') = 3
         AND (SELECT count(*) FROM tacl WHERE relname = 'delivery_dispatches' AND grantee = 'service_role' AND privilege_type IN ('SELECT', 'INSERT', 'UPDATE')) = 3
         AND (SELECT s FROM ccoord WHERE relname = 'delivery_dispatches') = 'SELECT(attempts),SELECT(error_code),SELECT(last_attempt_at),SELECT(order_id),SELECT(provider_order_id),SELECT(status),UPDATE(attempts),UPDATE(error_code),UPDATE(last_attempt_at),UPDATE(status),UPDATE(updated_at)',
         COALESCE((SELECT string_agg(grantee || ':' || privilege_type, ', ' ORDER BY 1) FROM tacl WHERE relname = 'delivery_dispatches'), 'none')
  UNION ALL
  SELECT '13', 'orders: coordinator SELECT (id) only — no customer columns; BYPASSRLS reaches no other RLS-protected relation',
         NOT EXISTS (SELECT 1 FROM tacl WHERE relname = 'orders' AND grantee = 'maale_dispatch_coordinator')
         AND (SELECT s FROM ccoord WHERE relname = 'orders') = 'SELECT(id)'
         AND NOT EXISTS (SELECT 1 FROM pg_class oc WHERE oc.relrowsecurity AND oc.relkind IN ('r', 'p')
               AND oc.oid NOT IN (to_regclass('public.orders'), to_regclass('public.delivery_dispatches'), to_regclass('public.maale_dispatch_reconciliations'))
               AND (has_table_privilege((SELECT oid FROM coord), oc.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
                    OR has_any_column_privilege((SELECT oid FROM coord), oc.oid, 'SELECT,INSERT,UPDATE'))),
         COALESCE((SELECT string_agg(relname || '=' || s, '; ' ORDER BY relname) FROM ccoord), 'none')
  UNION ALL
  SELECT '14', 'S4-04B and S4-04D objects still present',
         to_regprocedure('public.consume_maale_quote_slot(uuid, uuid, text)') IS NOT NULL AND to_regclass('public.maale_dispatch_reconciliations') IS NOT NULL, ''
  UNION ALL
  SELECT '15', 'INFO delivery_dispatches rows by status (counts only)', NULL,
         (xpath('/row/c/text()', query_to_xml('SELECT COALESCE(string_agg(status || ''='' || n, '', '' ORDER BY status), ''none'') AS c FROM (SELECT status, count(*) AS n FROM public.delivery_dispatches GROUP BY status) s', false, true, '')))[1]::text
  UNION ALL
  SELECT '16', 'INFO ledger rows by event_type (counts only)', NULL,
         (xpath('/row/c/text()', query_to_xml('SELECT COALESCE(string_agg(event_type || ''='' || n, '', '' ORDER BY event_type), ''none'') AS c FROM (SELECT event_type, count(*) AS n FROM public.maale_dispatch_reconciliations GROUP BY event_type) s', false, true, '')))[1]::text
)
SELECT check_id, check_name,
       CASE WHEN ok IS NULL THEN 'INFO' WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result,
       detail
FROM checks
ORDER BY check_id;
