-- FALAFEL BATACHANA — PARCEL MODULE — parcel_99_verify.sql (GATE 03B)
-- READ-ONLY verification after parcel_01 / parcel_02 (/ optional parcel_03). One SELECT, one result table:
--   section | check_name | object_name | status | details
-- Catalog / information_schema only: returns NO table rows, NO function bodies, performs NO writes.
-- Expected: every row OK / PRESENT / INFO, except parcel_03 rows which may be NOT_INSTALLED (optional) and
-- the STAGING_ONLY rows, which list behavioural tests that must be run in an isolated staging database —
-- never against Production, never with real orders.
WITH
roles AS (
  SELECT r.oid AS roid, r.rolname FROM pg_roles r WHERE r.rolname IN ('anon', 'authenticated', 'service_role')
),
tbl AS (
  SELECT t.name, to_regclass('public.' || t.name) AS reloid
  FROM unnest(ARRAY['parcel_requests', 'parcel_events']) AS t(name)
),
fns AS (
  SELECT p.oid AS foid, p.proname, pg_get_function_identity_arguments(p.oid) AS args,
         pg_get_function_result(p.oid) AS result, p.prosecdef, p.proconfig, p.proacl
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('create_order', 'create_order_with_parcel', 'parcel_requests_before_write',
                      'parcel_requests_log_event', 'parcel_events_append_only',
                      'orders_parcel_accept_gate', 'orders_parcel_cancel_sync')
),
expected_constraints AS (
  SELECT c.table_name, c.conname FROM (VALUES
    ('parcel_requests', 'parcel_requests_order_uq'), ('parcel_requests', 'parcel_requests_order_fk'),
    ('parcel_requests', 'parcel_requests_branch_fk'), ('parcel_requests', 'parcel_requests_tracking_ref_format'),
    ('parcel_requests', 'parcel_requests_tracking_key_len'), ('parcel_requests', 'parcel_requests_carrier_format'),
    ('parcel_requests', 'parcel_requests_status_check'), ('parcel_requests', 'parcel_requests_close_reason_check'),
    ('parcel_requests', 'parcel_requests_close_reason_iff_cancelled'), ('parcel_requests', 'parcel_requests_last_actor_format'),
    ('parcel_requests', 'parcel_requests_found_ts'), ('parcel_requests', 'parcel_requests_not_found_ts'),
    ('parcel_requests', 'parcel_requests_handoff_ts'), ('parcel_requests', 'parcel_requests_verified_ts'),
    ('parcel_requests', 'parcel_requests_closed_ts'),
    ('parcel_events', 'parcel_events_parcel_fk'), ('parcel_events', 'parcel_events_status_check'),
    ('parcel_events', 'parcel_events_actor_format')
  ) AS c(table_name, conname)
),
expected_triggers AS (
  SELECT e.table_name, e.tgname, e.optional, e.must_contain FROM (VALUES
    ('parcel_requests', 'parcel_requests_before_write', false, 'BEFORE INSERT OR UPDATE'),
    ('parcel_requests', 'parcel_requests_log_insert',   false, 'AFTER INSERT'),
    ('parcel_requests', 'parcel_requests_log_status',   false, 'AFTER UPDATE OF status'),
    ('parcel_events',   'parcel_events_no_update_delete', false, 'BEFORE UPDATE OR DELETE'),
    ('parcel_events',   'parcel_events_no_truncate',    false, 'BEFORE TRUNCATE'),
    ('orders',          'orders_parcel_accept_gate',    true,  '''received''::text) AND (new.status = ''confirmed''::text'),
    ('orders',          'orders_parcel_cancel_sync',    true,  '''cancelled''::text')
  ) AS e(table_name, tgname, optional, must_contain)
),

/* 01 — objects */
v01 AS (
  SELECT '01 objects'::text AS section, 1 AS ord, 'table'::text AS check_name, ('public.' || t.name)::text AS object_name,
         CASE WHEN t.reloid IS NULL THEN 'MISSING' ELSE 'PRESENT' END::text AS status,
         CASE WHEN t.reloid IS NULL THEN 'run parcel_01_tables.sql' ELSE 'exists' END::text AS details
  FROM tbl t
  UNION ALL
  SELECT '01 objects', 2, 'function', 'public.' || x.name,
         CASE WHEN EXISTS (SELECT 1 FROM fns WHERE fns.proname = x.name) THEN 'PRESENT'
              WHEN x.optional THEN 'NOT_INSTALLED' ELSE 'MISSING' END,
         CASE WHEN x.optional THEN 'optional (parcel_03)' ELSE 'required' END
  FROM (VALUES ('create_order_with_parcel', false), ('parcel_requests_before_write', false),
               ('parcel_requests_log_event', false), ('parcel_events_append_only', false),
               ('orders_parcel_accept_gate', true), ('orders_parcel_cancel_sync', true)) AS x(name, optional)
),

/* 02 — create_order unchanged */
v02 AS (
  SELECT '02 create_order unchanged', 1, 'source_md5', 'public.create_order(' || f.args || ')',
         CASE WHEN md5(p.prosrc) = 'db92e75f8bfdadb6d78be035da855996' THEN 'OK' ELSE 'REVIEW_REQUIRED' END,
         'md5=' || md5(p.prosrc) || ' | length=' || length(p.prosrc) || ' (expected db92e75f8bfdadb6d78be035da855996 / 6416)'
  FROM fns f JOIN pg_proc p ON p.oid = f.foid
  WHERE f.proname = 'create_order'
  UNION ALL
  SELECT '02 create_order unchanged', 2, 'overload_count', 'public.create_order',
         CASE (SELECT count(*) FROM fns WHERE proname = 'create_order') WHEN 1 THEN 'OK' ELSE 'REVIEW_REQUIRED' END,
         (SELECT count(*) FROM fns WHERE proname = 'create_order')::text || ' overload(s)'
),

/* 03 — parcel_requests structure */
v03 AS (
  SELECT '03 parcel_requests columns', 1, 'column', 'public.parcel_requests.' || e.col,
         CASE WHEN c.column_name IS NULL THEN 'MISSING'
              WHEN c.data_type <> e.typ OR c.is_nullable <> e.nullable THEN 'REVIEW_REQUIRED' ELSE 'OK' END,
         coalesce('type=' || c.data_type || ' nullable=' || c.is_nullable, 'not found')
         || ' | expected type=' || e.typ || ' nullable=' || e.nullable
  FROM (VALUES ('id','uuid','NO'), ('order_id','uuid','NO'), ('branch_id','uuid','NO'), ('tracking_ref','text','NO'),
               ('tracking_key','text','YES'), ('carrier','text','YES'), ('status','text','NO'), ('close_reason','text','YES'),
               ('last_actor','text','NO'), ('created_at','timestamp with time zone','NO'),
               ('updated_at','timestamp with time zone','NO'), ('found_at','timestamp with time zone','YES'),
               ('not_found_at','timestamp with time zone','YES'), ('handed_to_courier_at','timestamp with time zone','YES'),
               ('carrier_verified_at','timestamp with time zone','YES'), ('closed_at','timestamp with time zone','YES')
       ) AS e(col, typ, nullable)
  LEFT JOIN information_schema.columns c
    ON c.table_schema = 'public' AND c.table_name = 'parcel_requests' AND c.column_name = e.col
  UNION ALL
  SELECT '03 parcel_requests columns', 2, 'tracking_key_generated', 'public.parcel_requests.tracking_key',
         CASE WHEN a.attgenerated = 's' THEN 'OK' WHEN a.attname IS NULL THEN 'MISSING' ELSE 'REVIEW_REQUIRED' END,
         coalesce('generated=' || CASE a.attgenerated WHEN 's' THEN 'STORED' ELSE 'no' END
                  || ' | expr=' || pg_get_expr(d.adbin, d.adrelid), 'not found')
  FROM (SELECT 1) x
  LEFT JOIN pg_attribute a ON a.attrelid = to_regclass('public.parcel_requests') AND a.attname = 'tracking_key' AND NOT a.attisdropped
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
),

/* 04 — constraints and indexes */
v04 AS (
  SELECT '04 constraints', 1, 'constraint', 'public.' || e.table_name || '.' || e.conname,
         CASE WHEN c.oid IS NULL THEN 'MISSING' WHEN NOT c.convalidated THEN 'NOT_VALIDATED' ELSE 'OK' END,
         coalesce(pg_get_constraintdef(c.oid), 'not found')
  FROM expected_constraints e
  LEFT JOIN pg_constraint c ON c.conrelid = to_regclass('public.' || e.table_name) AND c.conname = e.conname
  UNION ALL
  SELECT '04 constraints', 2, 'index', 'public.' || x.idx,
         CASE WHEN i.indexrelid IS NULL THEN 'MISSING'
              WHEN NOT i.indisvalid THEN 'INVALID'
              WHEN x.must_unique AND NOT i.indisunique THEN 'REVIEW_REQUIRED'
              WHEN x.must_partial AND i.indpred IS NULL THEN 'REVIEW_REQUIRED'
              ELSE 'OK' END,
         coalesce(pg_get_indexdef(i.indexrelid), 'not found')
  FROM (VALUES ('parcel_requests_active_key_uq', true, true), ('parcel_requests_branch_status_idx', false, false),
               ('parcel_events_parcel_idx', false, false), ('parcel_requests_order_uq', true, false)) AS x(idx, must_unique, must_partial)
  LEFT JOIN pg_index i ON i.indexrelid = to_regclass('public.' || x.idx)
),

/* 05 — triggers */
v05 AS (
  SELECT '05 triggers', 1, 'trigger', 'public.' || e.table_name || '.' || e.tgname,
         CASE WHEN t.oid IS NULL AND e.optional THEN 'NOT_INSTALLED'
              WHEN t.oid IS NULL THEN 'MISSING'
              WHEN t.tgenabled = 'D' THEN 'DISABLED'
              WHEN position(lower(e.must_contain) IN lower(pg_get_triggerdef(t.oid))) = 0 THEN 'REVIEW_REQUIRED'
              ELSE 'OK' END,
         coalesce(pg_get_triggerdef(t.oid), CASE WHEN e.optional THEN 'optional (parcel_03)' ELSE 'not found' END)
  FROM expected_triggers e
  LEFT JOIN pg_trigger t ON t.tgrelid = to_regclass('public.' || e.table_name) AND t.tgname = e.tgname AND NOT t.tgisinternal
  UNION ALL
  SELECT '05 triggers', 2, 'unexpected_orders_triggers', 'public.orders',
         CASE WHEN count(*) = 0 THEN 'OK' ELSE 'REVIEW_REQUIRED' END,
         count(*)::text || ' user trigger(s) on orders besides the parcel_03 gate'
  FROM pg_trigger t
  WHERE t.tgrelid = to_regclass('public.orders') AND NOT t.tgisinternal
    AND t.tgname NOT IN ('orders_parcel_accept_gate', 'orders_parcel_cancel_sync')
),

/* 06 — RLS, policies, table grants */
v06 AS (
  SELECT '06 rls & grants', 1, 'rls_enabled', 'public.' || t.name,
         CASE WHEN t.reloid IS NULL THEN 'MISSING' WHEN c.relrowsecurity THEN 'OK' ELSE 'RISK' END,
         CASE WHEN t.reloid IS NULL THEN 'not found'
              ELSE 'enabled=' || c.relrowsecurity || ' | forced=' || c.relforcerowsecurity || ' (not forced by design)' END
  FROM tbl t LEFT JOIN pg_class c ON c.oid = t.reloid
  UNION ALL
  SELECT '06 rls & grants', 2, 'no_policies', 'public.' || t.name,
         CASE WHEN t.reloid IS NULL THEN 'MISSING'
              WHEN (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = t.name) = 0 THEN 'OK'
              ELSE 'RISK' END,
         (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = t.name)::text || ' policy(ies); expected 0'
  FROM tbl t
  UNION ALL
  SELECT '06 rls & grants', 3, 'privileges_' || r.rolname, 'public.' || t.name,
         CASE WHEN t.reloid IS NULL THEN 'MISSING'
              WHEN r.rolname IN ('anon', 'authenticated') THEN
                CASE WHEN has_table_privilege(r.roid, t.reloid, 'SELECT') OR has_table_privilege(r.roid, t.reloid, 'INSERT')
                       OR has_table_privilege(r.roid, t.reloid, 'UPDATE') OR has_table_privilege(r.roid, t.reloid, 'DELETE')
                       OR has_table_privilege(r.roid, t.reloid, 'TRUNCATE') OR has_table_privilege(r.roid, t.reloid, 'REFERENCES')
                       OR has_table_privilege(r.roid, t.reloid, 'TRIGGER')
                     THEN 'RISK' ELSE 'OK' END
              WHEN t.name = 'parcel_requests' THEN
                CASE WHEN has_table_privilege(r.roid, t.reloid, 'SELECT') AND has_table_privilege(r.roid, t.reloid, 'INSERT')
                       AND has_table_privilege(r.roid, t.reloid, 'UPDATE') AND NOT has_table_privilege(r.roid, t.reloid, 'DELETE')
                       AND NOT has_table_privilege(r.roid, t.reloid, 'TRUNCATE') THEN 'OK' ELSE 'REVIEW_REQUIRED' END
              ELSE
                CASE WHEN has_table_privilege(r.roid, t.reloid, 'SELECT') AND has_table_privilege(r.roid, t.reloid, 'INSERT')
                       AND NOT has_table_privilege(r.roid, t.reloid, 'UPDATE') AND NOT has_table_privilege(r.roid, t.reloid, 'DELETE')
                       AND NOT has_table_privilege(r.roid, t.reloid, 'TRUNCATE') THEN 'OK' ELSE 'REVIEW_REQUIRED' END
         END,
         CASE WHEN t.reloid IS NULL THEN 'not found' ELSE
           'select=' || has_table_privilege(r.roid, t.reloid, 'SELECT') || ' insert=' || has_table_privilege(r.roid, t.reloid, 'INSERT')
           || ' update=' || has_table_privilege(r.roid, t.reloid, 'UPDATE') || ' delete=' || has_table_privilege(r.roid, t.reloid, 'DELETE')
           || ' truncate=' || has_table_privilege(r.roid, t.reloid, 'TRUNCATE') END
  FROM tbl t CROSS JOIN roles r
),

/* 07 — functions: security mode, search_path, EXECUTE */
v07 AS (
  SELECT '07 functions', 1, 'security_and_search_path', 'public.' || f.proname || '(' || f.args || ')',
         CASE WHEN f.prosecdef THEN 'RISK'
              WHEN NOT coalesce(f.proconfig @> ARRAY['search_path=""'], false) THEN 'REVIEW_REQUIRED'
              ELSE 'OK' END,
         'security=' || CASE WHEN f.prosecdef THEN 'DEFINER' ELSE 'INVOKER' END
         || ' | config=' || coalesce(array_to_string(f.proconfig, ', '), 'none')
  FROM fns f WHERE f.proname <> 'create_order'
  UNION ALL
  SELECT '07 functions', 2, 'execute_' || r.rolname, 'public.create_order_with_parcel(' || f.args || ')',
         CASE WHEN has_function_privilege(r.roid, f.foid, 'EXECUTE') = (r.rolname = 'service_role') THEN 'OK' ELSE 'RISK' END,
         'has_execute=' || has_function_privilege(r.roid, f.foid, 'EXECUTE')
         || ' | expected=' || (r.rolname = 'service_role')::text
  FROM fns f CROSS JOIN roles r WHERE f.proname = 'create_order_with_parcel'
  UNION ALL
  SELECT '07 functions', 3, 'execute_PUBLIC', 'public.' || f.proname || '(' || f.args || ')',
         CASE WHEN f.proacl IS NULL
                OR EXISTS (SELECT 1 FROM aclexplode(f.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
              THEN 'RISK' ELSE 'OK' END,
         'acl=' || coalesce(f.proacl::text, 'NULL (default ACL = EXECUTE to PUBLIC)')
  FROM fns f WHERE f.proname <> 'create_order'
  UNION ALL
  SELECT '07 functions', 4, 'wrapper_return_shape', 'public.create_order_with_parcel',
         CASE WHEN w.result IS NULL THEN 'MISSING' WHEN w.result = c.result THEN 'OK' ELSE 'REVIEW_REQUIRED' END,
         'wrapper=' || coalesce(w.result, 'missing') || ' | create_order=' || coalesce(c.result, 'missing')
  FROM (SELECT 1) x
  LEFT JOIN fns w ON w.proname = 'create_order_with_parcel'
  LEFT JOIN fns c ON c.proname = 'create_order'
  UNION ALL
  SELECT '07 functions', 5, 'wrapper_arguments', 'public.create_order_with_parcel',
         CASE WHEN w.args IS NULL THEN 'MISSING'
              WHEN w.args = 'p_order jsonb, p_items jsonb, p_delivery jsonb, p_parcel jsonb' THEN 'OK' ELSE 'REVIEW_REQUIRED' END,
         coalesce(w.args, 'missing')
  FROM (SELECT 1) x LEFT JOIN fns w ON w.proname = 'create_order_with_parcel'
),

/* 08 — existing risks kept on record (unchanged by this migration) */
v08 AS (
  SELECT '08 known existing risks', 1, 'SEC-2', 'public.orders / public.order_items',
         'DOCUMENTED',
         'legacy permissive public SELECT/INSERT policies (true) remain — separate remediation track; '
         || 'parcel tables are not reachable through them (no grants, RLS on). Current policies on orders/order_items: '
         || (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename IN ('orders', 'order_items'))::text
  UNION ALL
  SELECT '08 known existing risks', 2, 'legacy_service_role_jwt', 'Supabase API keys',
         'UNKNOWN', 'RLS does not protect against a leaked service_role key; confirm legacy JWT keys are revoked (not checkable in SQL)'
),

/* 09 — behavioural tests: ISOLATED STAGING ONLY (never Production, never real orders) */
v09 AS (
  SELECT '09 staging-only tests', t.n, 'test_' || lpad(t.n::text, 2, '0'), t.area, 'STAGING_ONLY', t.descr
  FROM (VALUES
    (1,  'wrapper',  'create_order_with_parcel creates order + order_items + deliveries + parcel + 1 event; return shape equals create_order'),
    (2,  'wrapper',  'duplicate active tracking_key → unique_violation; NO order / items / delivery row remains (same transaction)'),
    (3,  'wrapper',  'invalid tracking_ref (format/length/URL), unexpected parcel field, pickup order → error; nothing created'),
    (4,  'wrapper',  'create_order validation failure (e.g. total mismatch) → error propagates; no parcel row'),
    (5,  'wrapper',  'anon / authenticated cannot EXECUTE create_order_with_parcel (permission denied)'),
    (6,  'parcel',   'every allowed transition succeeds; every other transition raises parcel_invalid_transition'),
    (7,  'parcel',   'search transitions only while order is received; handoff only when order confirmed/preparing/ready/delivered'),
    (8,  'parcel',   'food_only only from not_found while order received; timestamps stamped; immutable columns rejected'),
    (9,  'events',   'one parcel_events row per insert / status change; UPDATE / DELETE / TRUNCATE on parcel_events rejected'),
    (10, 'security', 'anon / authenticated: SELECT / INSERT / UPDATE on parcel_requests and parcel_events denied'),
    (11, 'gate',     'parcel_03: received→confirmed blocked (parcel_not_ready) for awaiting_search / not_found; allowed for found / cancelled'),
    (12, 'gate',     'parcel_03: orders WITHOUT parcel — every transition behaves exactly as before; INSERT unaffected'),
    (13, 'gate',     'parcel_03: order → cancelled cancels a pre-handoff parcel (order_cancelled) and releases the tracking number'),
    (14, 'gate',     'parcel_03: "delivered" never changes parcel status; handed_to_courier parcels are not touched by cancellation'),
    (15, 'concurrency', 'two sessions: un-find parcel vs accept order, both orders of commit → consistent result, no deadlock, no lost check'),
    (16, 'concurrency', 'two sessions: two concurrent create_order_with_parcel with the same tracking number → exactly one succeeds'),
    (17, 'concurrency', 'two sessions: cancel order vs parcel status change → consistent result, no deadlock')
  ) AS t(n, area, descr)
)

SELECT section, check_name, object_name, status, details
FROM (
  SELECT * FROM v01
  UNION ALL SELECT * FROM v02
  UNION ALL SELECT * FROM v03
  UNION ALL SELECT * FROM v04
  UNION ALL SELECT * FROM v05
  UNION ALL SELECT * FROM v06
  UNION ALL SELECT * FROM v07
  UNION ALL SELECT * FROM v08
  UNION ALL SELECT * FROM v09
) AS u(section, ord, check_name, object_name, status, details)
ORDER BY section, ord, check_name, object_name;
