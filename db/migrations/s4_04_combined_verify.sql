-- FALAFEL BATACHANA — s4_04_combined_verify.sql (S4-INTEGRATIONS-04E2) — READ-ONLY, ONE SELECT.
-- VERSION-AWARE verification of the whole courier schema: S4-04B (quote limiter) + S4-04D (reconciliation ledger) +
-- S4-04E (atomic coordination). Detects the installed stage and applies the matching expectations — nothing is ignored:
--   stage 'pre_04e'  = 04B + 04D installed, no 04E object   → expects the original 04D privileges (service_role SELECT+INSERT)
--   stage 'post_04e' = 04B + 04D + complete 04E              → expects the hardened privileges (writes only via functions)
--   anything else (04B / 04D missing, 04E partially installed) → row 01 FAILs.
-- The per-migration files (s4_04b_verify, s4_04d_verify, s4_04e_verify) are unchanged; after 04E, 04D verify row 05
-- FAILs by design — use THIS file for the combined state. Catalog + counts only; no ids, names or writes.
-- Never errors on a missing object (missing → FAIL row). Expected: every row PASS (row 20 INFO).
-- Columns: check_id | check_name | result | detail
WITH
st AS (
  SELECT
    to_regclass('public.maale_dispatch_requests') IS NOT NULL AND to_regprocedure('public.consume_maale_quote_slot(uuid, uuid, text)') IS NOT NULL AS b_ok,
    to_regclass('public.maale_dispatch_reconciliations') IS NOT NULL AS d_ok,
    (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
       AND p.proname IN ('claim_maale_dispatch', 'record_maale_reconciliation_event', 'delivery_dispatches_coordination_guard'))
    + (SELECT count(*) FROM pg_trigger WHERE tgrelid = to_regclass('public.delivery_dispatches') AND tgname = 'delivery_dispatches_coordination_guard')
    + (SELECT count(*) FROM pg_roles WHERE rolname = 'maale_dispatch_coordinator') AS e_objects
),
stage AS (
  SELECT CASE WHEN NOT b_ok OR NOT d_ok THEN 'incomplete'
              WHEN e_objects = 0 THEN 'pre_04e' WHEN e_objects = 5 THEN 'post_04e' ELSE 'partial_04e' END AS s FROM st
),
post AS (SELECT (SELECT s FROM stage) = 'post_04e' AS is_post),
acl AS (
  SELECT c.relname, CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS grantee, a.privilege_type
  FROM pg_class c, LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
  WHERE c.oid IN (to_regclass('public.maale_dispatch_requests'), to_regclass('public.maale_dispatch_reconciliations'),
                  to_regclass('public.delivery_dispatches'), to_regclass('public.orders'))
    AND a.grantee <> c.relowner
),
acls AS (SELECT relname, string_agg(grantee || ':' || privilege_type, ',' ORDER BY grantee, privilege_type) AS s FROM acl GROUP BY relname),
fn AS (
  SELECT p.proname, p.prosecdef, p.proconfig, p.proowner, md5(p.prosrc) AS h, length(p.prosrc) AS len, p.proacl
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname IN ('consume_maale_quote_slot', 'claim_maale_dispatch', 'record_maale_reconciliation_event', 'delivery_dispatches_coordination_guard')
),
fexec AS (
  SELECT fn.proname, string_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END || ':' || a.privilege_type, ',' ORDER BY 1) AS s
  FROM fn, LATERAL aclexplode(COALESCE(fn.proacl, acldefault('f', fn.proowner))) a WHERE a.grantee <> fn.proowner GROUP BY fn.proname
),
coord AS (SELECT * FROM pg_roles WHERE rolname = 'maale_dispatch_coordinator'),
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
  SELECT '01', 'stage is complete and consistent (pre_04e or post_04e — never partial / incomplete)',
         (SELECT s FROM stage) IN ('pre_04e', 'post_04e'), (SELECT s FROM stage)
  UNION ALL
  -- ── 04B ──
  SELECT '02', '04B: consume_maale_quote_slot INVOKER, search_path '''', lock_timeout 3s, reviewed body, EXECUTE service_role only',
         EXISTS (SELECT 1 FROM fn WHERE proname = 'consume_maale_quote_slot' AND NOT prosecdef AND proconfig = ARRAY['search_path=""', 'lock_timeout=3s']
                   AND ((h = '9fd1a1a1e717a57d3efad05cfb7eaa49' AND len = 1877) OR (h = '71581e48e039ea3dadeb34ad04930afa' AND len = 1919)))
         AND (SELECT s FROM fexec WHERE proname = 'consume_maale_quote_slot') = 'service_role:EXECUTE', ''
  UNION ALL
  SELECT '03', '04B: maale_dispatch_requests RLS on, no policies; exactly service_role SELECT + INSERT',
         EXISTS (SELECT 1 FROM pg_class WHERE oid = to_regclass('public.maale_dispatch_requests') AND relrowsecurity)
         AND NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = to_regclass('public.maale_dispatch_requests'))
         AND (SELECT s FROM acls WHERE relname = 'maale_dispatch_requests') = 'service_role:INSERT,service_role:SELECT',
         COALESCE((SELECT s FROM acls WHERE relname = 'maale_dispatch_requests'), 'none')
  UNION ALL
  -- ── 04D ──
  SELECT '04', '04D: ledger has the 9 reviewed columns and 10 validated constraints incl. UNIQUE (request_id)',
         (SELECT count(*) FROM pg_attribute WHERE attrelid = to_regclass('public.maale_dispatch_reconciliations') AND attnum > 0 AND NOT attisdropped) = 9
         AND (SELECT count(*) FROM pg_constraint WHERE conrelid = to_regclass('public.maale_dispatch_reconciliations') AND convalidated) = 10
         AND EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = to_regclass('public.maale_dispatch_reconciliations')
                       AND c.conname = 'maale_dispatch_reconciliations_request_id_key' AND pg_get_constraintdef(c.oid) = 'UNIQUE (request_id)'), ''
  UNION ALL
  SELECT '05', '04D: event_type CHECK is the reviewed closed list (no automatic-cancellation state)',
         EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = to_regclass('public.maale_dispatch_reconciliations') AND c.conname = 'maale_dispatch_reconciliations_event_type_check'
                   AND pg_get_constraintdef(c.oid) = 'CHECK ((event_type = ANY (ARRAY[''confirmed_sent''::text, ''cancelled_at_provider''::text, ''not_received''::text, ''manual_courier''::text, ''provider_status_checked''::text, ''manual_review_opened''::text, ''manual_review_resolved''::text])))'), ''
  UNION ALL
  SELECT '06', '04D: ledger RLS on (not forced), no policies, no other triggers',
         EXISTS (SELECT 1 FROM pg_class WHERE oid = to_regclass('public.maale_dispatch_reconciliations') AND relrowsecurity AND NOT relforcerowsecurity)
         AND NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = to_regclass('public.maale_dispatch_reconciliations'))
         AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('public.maale_dispatch_reconciliations') AND NOT tgisinternal), ''
  UNION ALL
  SELECT '07', 'ledger table privileges match the stage (pre: service_role SELECT+INSERT · post: service_role SELECT, coordinator SELECT)',
         (SELECT s FROM acls WHERE relname = 'maale_dispatch_reconciliations') =
           CASE WHEN (SELECT is_post FROM post) THEN 'maale_dispatch_coordinator:SELECT,service_role:SELECT'
                ELSE 'service_role:INSERT,service_role:SELECT' END,
         COALESCE((SELECT s FROM acls WHERE relname = 'maale_dispatch_reconciliations'), 'none')
  UNION ALL
  SELECT '08', 'post-04E: NO application role can INSERT into the ledger directly (only via record_maale_reconciliation_event)',
         CASE WHEN NOT (SELECT is_post FROM post) THEN true
              ELSE NOT COALESCE(has_any_column_privilege('service_role', to_regclass('public.maale_dispatch_reconciliations'), 'INSERT')
                       OR has_any_column_privilege('anon', to_regclass('public.maale_dispatch_reconciliations'), 'INSERT')
                       OR has_any_column_privilege('authenticated', to_regclass('public.maale_dispatch_reconciliations'), 'INSERT'), true) END, ''
  UNION ALL
  -- ── delivery_dispatches (baseline; created outside migrations) ──
  SELECT '09', 'delivery_dispatches: RLS on; table privileges exactly service_role SELECT+INSERT+UPDATE (both stages; coordinator: column-level, row 16)',
         EXISTS (SELECT 1 FROM pg_class WHERE oid = to_regclass('public.delivery_dispatches') AND relrowsecurity)
         AND (SELECT s FROM acls WHERE relname = 'delivery_dispatches') =
           'service_role:INSERT,service_role:SELECT,service_role:UPDATE',
         COALESCE((SELECT s FROM acls WHERE relname = 'delivery_dispatches'), 'none')
  UNION ALL
  SELECT '10', 'delivery_dispatches: UNIQUE (order_id) and the 5-status CHECK present',
         EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
                  WHERE c.conrelid = to_regclass('public.delivery_dispatches') AND c.contype = 'u' AND array_length(c.conkey, 1) = 1 AND a.attname = 'order_id')
         AND EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = to_regclass('public.delivery_dispatches') AND c.conname = 'delivery_dispatches_status_check'), ''
  UNION ALL
  -- ── 04E ──
  SELECT '11', 'post-04E: claim_maale_dispatch DEFINER owned by the coordinator, search_path '''', lock_timeout 3s, reviewed body',
         NOT (SELECT is_post FROM post)
         OR EXISTS (SELECT 1 FROM fn WHERE proname = 'claim_maale_dispatch' AND prosecdef AND proowner = (SELECT oid FROM coord)
                      AND proconfig = ARRAY['search_path=""', 'lock_timeout=3s']
                      AND ((h = '4dbe74fdc561de56f334b86e13df6f07' AND len = 2393) OR (h = '58b148e95dd9ead585600172578147ff' AND len = 2444))), ''
  UNION ALL
  SELECT '12', 'post-04E: record_maale_reconciliation_event DEFINER owned by the coordinator, search_path '''', lock_timeout 3s, reviewed body',
         NOT (SELECT is_post FROM post)
         OR EXISTS (SELECT 1 FROM fn WHERE proname = 'record_maale_reconciliation_event' AND prosecdef AND proowner = (SELECT oid FROM coord)
                      AND proconfig = ARRAY['search_path=""', 'lock_timeout=3s']
                      AND ((h = 'df2aae601026de16c9cf130b2aea1934' AND len = 5223) OR (h = '6ff732afd787e8b2b6c225dc9206a1df' AND len = 5305))), ''
  UNION ALL
  SELECT '13', 'post-04E: guard function INVOKER, reviewed body; trigger enabled BEFORE INSERT OR UPDATE FOR EACH ROW',
         NOT (SELECT is_post FROM post)
         OR (EXISTS (SELECT 1 FROM fn WHERE proname = 'delivery_dispatches_coordination_guard' AND NOT prosecdef AND proconfig = ARRAY['search_path=""']
                       AND ((h = '9a8d6a28ff2b39c5ad341965a4ecd38d' AND len = 1076) OR (h = '8400468eb3d50410e44035fea6cd79d4' AND len = 1097)))
             AND EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = to_regclass('public.delivery_dispatches') AND t.tgname = 'delivery_dispatches_coordination_guard'
                           AND t.tgenabled = 'O' AND pg_get_triggerdef(t.oid) = 'CREATE TRIGGER delivery_dispatches_coordination_guard BEFORE INSERT OR UPDATE ON public.delivery_dispatches FOR EACH ROW EXECUTE FUNCTION delivery_dispatches_coordination_guard()')), ''
  UNION ALL
  SELECT '14', 'post-04E: EXECUTE on claim / record → exactly service_role; guard → nobody',
         NOT (SELECT is_post FROM post)
         OR ((SELECT s FROM fexec WHERE proname = 'claim_maale_dispatch') = 'service_role:EXECUTE'
             AND (SELECT s FROM fexec WHERE proname = 'record_maale_reconciliation_event') = 'service_role:EXECUTE'
             AND NOT EXISTS (SELECT 1 FROM fexec WHERE proname = 'delivery_dispatches_coordination_guard')), ''
  UNION ALL
  SELECT '15', 'post-04E: coordinator NOLOGIN NOINHERIT BYPASSRLS only, member of nothing, no CREATE on public; no app role / authenticator is a member',
         NOT (SELECT is_post FROM post)
         OR (EXISTS (SELECT 1 FROM coord WHERE NOT rolcanlogin AND NOT rolinherit AND rolbypassrls AND NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication)
             AND NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = (SELECT oid FROM coord))
             AND COALESCE(has_schema_privilege((SELECT oid FROM coord), 'public', 'USAGE') AND NOT has_schema_privilege((SELECT oid FROM coord), 'public', 'CREATE'), false)
             AND NOT EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE m.roleid = (SELECT oid FROM coord)
                               AND r.rolname IN ('authenticator', 'service_role', 'anon', 'authenticated'))
             AND NOT COALESCE(pg_has_role('service_role', (SELECT oid FROM coord), 'MEMBER')
                              OR pg_has_role('anon', (SELECT oid FROM coord), 'MEMBER')
                              OR pg_has_role('authenticated', (SELECT oid FROM coord), 'MEMBER'), true)), ''
  UNION ALL
  SELECT '16', 'post-04E: coordinator owns only the 2 functions; column-level grants exactly as reviewed; BYPASSRLS reaches nothing else',
         CASE WHEN NOT (SELECT is_post FROM post) THEN true
              ELSE (SELECT count(*) FROM pg_proc WHERE proowner = (SELECT oid FROM coord)) = 2
                   AND NOT EXISTS (SELECT 1 FROM pg_class WHERE relowner = (SELECT oid FROM coord))
                   AND COALESCE((SELECT s FROM acls WHERE relname = 'orders'), '') NOT LIKE '%maale_dispatch_coordinator:%'
                   AND (SELECT s FROM ccoord WHERE relname = 'orders') = 'SELECT(id)'
                   AND (SELECT s FROM ccoord WHERE relname = 'delivery_dispatches') = 'SELECT(attempts),SELECT(error_code),SELECT(last_attempt_at),SELECT(order_id),SELECT(provider_order_id),SELECT(status),UPDATE(attempts),UPDATE(error_code),UPDATE(last_attempt_at),UPDATE(status),UPDATE(updated_at)'
                   AND (SELECT s FROM ccoord WHERE relname = 'maale_dispatch_reconciliations') = 'INSERT(actor_username),INSERT(event_type),INSERT(order_id),INSERT(provider_order_id),INSERT(provider_status),INSERT(reason_code),INSERT(request_id)'
                   AND NOT EXISTS (SELECT 1 FROM pg_class oc WHERE oc.relrowsecurity AND oc.relkind IN ('r', 'p')
               AND oc.oid NOT IN (to_regclass('public.orders'), to_regclass('public.delivery_dispatches'), to_regclass('public.maale_dispatch_reconciliations'))
               AND (has_table_privilege((SELECT oid FROM coord), oc.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
                    OR has_any_column_privilege((SELECT oid FROM coord), oc.oid, 'SELECT,INSERT,UPDATE'))) END,
         COALESCE((SELECT string_agg(relname || '=' || s, '; ' ORDER BY relname) FROM ccoord), 'none')
  UNION ALL
  SELECT '17', 'pre-04E: no partial coordination objects (guard / role / functions all absent)',
         (SELECT is_post FROM post) OR (SELECT e_objects FROM st) = 0, (SELECT e_objects FROM st)::text || ' 04E objects'
  UNION ALL
  SELECT '18', 'no sent dispatch without dispatched_at (sent rows consistent; never claimable)',
         CASE WHEN to_regclass('public.delivery_dispatches') IS NULL THEN false
              ELSE (xpath('/row/c/text()', query_to_xml('SELECT count(*) AS c FROM public.delivery_dispatches WHERE status = ''sent'' AND dispatched_at IS NULL', false, true, '')))[1]::text = '0' END, ''
  UNION ALL
  SELECT '19', 'coordination invariant holds in the data: no order has BOTH a manual_courier record and a sending / sent dispatch',
         CASE WHEN to_regclass('public.delivery_dispatches') IS NULL OR to_regclass('public.maale_dispatch_reconciliations') IS NULL THEN false
              ELSE (xpath('/row/c/text()', query_to_xml('SELECT count(*) AS c FROM public.delivery_dispatches d WHERE d.status IN (''sending'', ''sent'')
            AND EXISTS (SELECT 1 FROM public.maale_dispatch_reconciliations r WHERE r.order_id = d.order_id AND r.event_type = ''manual_courier'')', false, true, '')))[1]::text = '0' END,
         CASE WHEN to_regclass('public.maale_dispatch_reconciliations') IS NULL THEN 'ledger missing' ELSE '' END
  UNION ALL
  SELECT '20', 'INFO stage / dispatch rows by status / ledger rows by event (counts only)', NULL,
         (SELECT s FROM stage) || ' · ' ||
         CASE WHEN to_regclass('public.delivery_dispatches') IS NULL THEN 'dispatches missing'
              ELSE (xpath('/row/c/text()', query_to_xml('SELECT COALESCE(string_agg(status || ''='' || n, '', '' ORDER BY status), ''none'') AS c FROM (SELECT status, count(*) AS n FROM public.delivery_dispatches GROUP BY status) s', false, true, '')))[1]::text END || ' · ' ||
         CASE WHEN to_regclass('public.maale_dispatch_reconciliations') IS NULL THEN 'ledger missing'
              ELSE (xpath('/row/c/text()', query_to_xml('SELECT COALESCE(string_agg(event_type || ''='' || n, '', '' ORDER BY event_type), ''none'') AS c FROM (SELECT event_type, count(*) AS n FROM public.maale_dispatch_reconciliations GROUP BY event_type) s', false, true, '')))[1]::text END
)
SELECT check_id, check_name,
       CASE WHEN ok IS NULL THEN 'INFO' WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result,
       detail
FROM checks
ORDER BY check_id;
