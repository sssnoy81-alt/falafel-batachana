-- FALAFEL BATACHANA — hyp05_privilege_audit.sql (HYP-03R Q4) — READ-ONLY, ONE SELECT. Run in the Supabase SQL editor.
-- EFFECTIVE privileges of anon / authenticated / PUBLIC on the customer-data and payment tables, including privileges
-- inherited through role membership and column-level grants (has_table_privilege / has_any_column_privilege), plus the
-- RLS state and the permissive policies that would apply. Catalog checks only: no customer rows, no writes.
-- Expected before AND after hyp05: every row PASS. A FAIL = a public-key role can reach that table → stop and review
-- (SEC-2 / SEC-2B remediation, separate approval). Payment tables that do not exist yet show INFO "not installed".
-- Columns: check_id | check_name | result | detail
WITH
t(rel, kind) AS (VALUES
  ('public.orders', 'customer'), ('public.order_items', 'customer'), ('public.deliveries', 'customer'),
  ('public.parcel_requests', 'customer'), ('public.parcel_events', 'customer'), ('public.push_subscriptions', 'customer'),
  ('public.payment_intents', 'payment'), ('public.payment_returns', 'payment'), ('public.payment_transactions', 'payment'),
  ('public.payment_reversals', 'payment'), ('public.payment_intent_events', 'payment')),
r(role) AS (VALUES ('anon'), ('authenticated'), ('public')),
p(priv) AS (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')),
grid AS (
  SELECT t.rel, t.kind, r.role, to_regclass(t.rel) AS oid,
         CASE WHEN to_regclass(t.rel) IS NULL THEN NULL ELSE
           coalesce(string_agg(p.priv, ',' ORDER BY p.priv) FILTER (WHERE has_table_privilege(r.role, to_regclass(t.rel), p.priv)), '') END AS table_privs,
         CASE WHEN to_regclass(t.rel) IS NULL THEN NULL ELSE
           coalesce(string_agg(p.priv, ',' ORDER BY p.priv) FILTER (WHERE p.priv IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
                                                                     AND has_any_column_privilege(r.role, to_regclass(t.rel), p.priv)), '') END AS column_privs
  FROM t CROSS JOIN r CROSS JOIN p
  GROUP BY t.rel, t.kind, r.role
),
checks (check_id, check_name, ok, detail) AS (
  SELECT lpad(row_number() OVER (ORDER BY g.kind, g.rel, g.role)::text, 2, '0'),
         g.rel || ' — no privilege for ' || g.role,
         CASE WHEN g.oid IS NULL THEN NULL ELSE g.table_privs = '' AND g.column_privs = '' END,
         CASE WHEN g.oid IS NULL THEN 'not installed'
              ELSE 'table: ' || CASE WHEN g.table_privs = '' THEN 'none' ELSE g.table_privs END
                || ' | columns: ' || CASE WHEN g.column_privs = '' THEN 'none' ELSE g.column_privs END
                || ' | rls: ' || (SELECT c.relrowsecurity::text FROM pg_class c WHERE c.oid = g.oid)
                || ' | permissive policies for role: ' || coalesce((SELECT string_agg(pol.polname, ', ' ORDER BY pol.polname) FROM pg_policy pol
                     WHERE pol.polrelid = g.oid AND pol.polpermissive
                       AND (0 = ANY (pol.polroles) OR (g.role <> 'public' AND to_regrole(g.role) = ANY (pol.polroles)))), 'none') END
  FROM grid g
)
SELECT check_id, check_name,
       CASE WHEN ok IS NULL THEN 'INFO' WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result,
       detail
FROM checks
ORDER BY check_id;
