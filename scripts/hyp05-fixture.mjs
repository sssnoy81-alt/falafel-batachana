// Production-shaped fixture shared by the isolated HYP tests (scripts/pgtest-hyp05-payment-intents.mjs,
// scripts/pgtest-hyp07-payment-flow.mjs). Tables, constraints, indexes, triggers, RLS, policies and grants follow the
// Production Q1 export (HYP-02, 2026-10-24); create_order, create_order_with_parcel and every trigger function on the
// order / parcel tables are installed BYTE-EXACT from db/schema/hyp05_production_function_sources.csv and their md5 is
// asserted against Production. parcel_events follows db/migrations/parcel_01_tables.sql. Test-only module.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const lit = s => (s === null || s === undefined ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`)
const rows = out => out.split('\n').filter(Boolean).map(l => l.split('|'))
export const PROD = {   // Production fingerprints (Q1 + Q6, 2026-10-24)
  create_order: 'db92e75f8bfdadb6d78be035da855996/6416',
  create_order_with_parcel: '6ceb72f6c80929adddd7a2b7bb1a0616/2771',
}

export const B1 = '8fed141d-0e7c-46c1-803b-88d3d811c1f8'
export const B2 = '1b9a3f0e-2c4d-4e5f-8a6b-7c8d9e0f1a2b'
export const M1 = '11111111-1111-4111-8111-111111111111'
export const M2 = '22222222-2222-4222-8222-222222222222'
export const FIXTURE = `
CREATE TABLE public.branches (id uuid PRIMARY KEY, name text);
CREATE TABLE public.menu_items (id uuid PRIMARY KEY, name text);
CREATE TABLE public.managers (id uuid PRIMARY KEY);
CREATE TABLE public.users (id uuid PRIMARY KEY);
CREATE SEQUENCE public.orders_order_number_seq AS integer;
CREATE TABLE public.orders (
  id uuid NOT NULL DEFAULT gen_random_uuid(), branch_id uuid NULL, user_id uuid NULL,
  order_number integer NOT NULL DEFAULT nextval('public.orders_order_number_seq'::regclass),
  type text NULL, status text NULL DEFAULT 'received'::text, total_price numeric(8,2) NULL, notes text NULL,
  created_at timestamptz NULL DEFAULT now(), updated_at timestamptz NULL DEFAULT now(), confirmed_at timestamptz NULL,
  ready_at timestamptz NULL, delivered_at timestamptz NULL, manager_id uuid NULL, payment_method text NULL, phone text NULL,
  customer_name text NULL DEFAULT ''::text, daily_number integer NULL,
  CONSTRAINT orders_pkey PRIMARY KEY (id),
  CONSTRAINT orders_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id),
  CONSTRAINT orders_manager_id_fkey FOREIGN KEY (manager_id) REFERENCES public.managers(id),
  CONSTRAINT orders_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id),
  CONSTRAINT orders_payment_method_check CHECK ((payment_method = ANY (ARRAY['cash'::text, 'credit'::text, 'cibus'::text, 'bit'::text]))),
  CONSTRAINT orders_status_check CHECK ((status = ANY (ARRAY['received'::text, 'confirmed'::text, 'preparing'::text, 'ready'::text, 'delivered'::text, 'cancelled'::text]))),
  CONSTRAINT orders_type_check CHECK ((type = ANY (ARRAY['pickup'::text, 'delivery'::text]))));
ALTER SEQUENCE public.orders_order_number_seq OWNED BY public.orders.order_number;
CREATE TABLE public.order_items (
  id uuid NOT NULL DEFAULT gen_random_uuid(), order_id uuid NULL, item_id uuid NULL, quantity integer NULL DEFAULT 1,
  unit_price numeric(6,2) NULL, notes text NULL,
  CONSTRAINT order_items_pkey PRIMARY KEY (id),
  CONSTRAINT order_items_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.menu_items(id),
  CONSTRAINT order_items_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id));
CREATE TABLE public.deliveries (
  id uuid NOT NULL DEFAULT gen_random_uuid(), order_id uuid NOT NULL, address text NOT NULL, phone text NULL, notes text NULL,
  delivery_fee numeric(5,2) NULL DEFAULT 0, city text NULL, street text NULL, house_number text NULL, apartment text NULL,
  floor text NULL, entrance text NULL, meal_surcharge numeric(10,2) NOT NULL DEFAULT 0, meal_quantity integer NOT NULL DEFAULT 0,
  delivery_lat numeric(9,6) NULL, delivery_lng numeric(9,6) NULL, geo_source text NULL, geo_precision text NULL,
  CONSTRAINT deliveries_pkey PRIMARY KEY (id),
  CONSTRAINT deliveries_order_id_key UNIQUE (order_id),
  CONSTRAINT deliveries_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id),
  CONSTRAINT deliveries_address_length_check CHECK (((btrim(address) <> ''::text) AND (char_length(address) <= 500))),
  CONSTRAINT deliveries_apartment_length_check CHECK (((apartment IS NULL) OR (char_length(apartment) <= 20))),
  CONSTRAINT deliveries_city_length_check CHECK (((city IS NULL) OR (char_length(city) <= 80))),
  CONSTRAINT deliveries_delivery_fee_nonnegative_check CHECK (((delivery_fee IS NULL) OR (delivery_fee >= (0)::numeric))),
  CONSTRAINT deliveries_entrance_length_check CHECK (((entrance IS NULL) OR (char_length(entrance) <= 20))),
  CONSTRAINT deliveries_floor_length_check CHECK (((floor IS NULL) OR (char_length(floor) <= 20))),
  CONSTRAINT deliveries_geo_consistency_check CHECK ((((geo_precision IS NULL) AND (geo_source IS NULL) AND (delivery_lat IS NULL) AND (delivery_lng IS NULL)) OR ((geo_precision = 'unresolved'::text) AND (geo_source = 'none'::text) AND (delivery_lat IS NULL) AND (delivery_lng IS NULL)) OR ((geo_precision = ANY (ARRAY['street'::text, 'locality'::text])) AND (geo_source = ANY (ARRAY['geocoder'::text, 'manual'::text])) AND (delivery_lat IS NOT NULL) AND (delivery_lng IS NOT NULL)))),
  CONSTRAINT deliveries_geo_lat_range_check CHECK (((delivery_lat IS NULL) OR ((delivery_lat >= 29.0) AND (delivery_lat <= 34.0)))),
  CONSTRAINT deliveries_geo_lng_range_check CHECK (((delivery_lng IS NULL) OR ((delivery_lng >= 34.0) AND (delivery_lng <= 36.0)))),
  CONSTRAINT deliveries_geo_precision_check CHECK (((geo_precision IS NULL) OR (geo_precision = ANY (ARRAY['street'::text, 'locality'::text, 'unresolved'::text])))),
  CONSTRAINT deliveries_geo_source_check CHECK (((geo_source IS NULL) OR (geo_source = ANY (ARRAY['geocoder'::text, 'manual'::text, 'none'::text])))),
  CONSTRAINT deliveries_house_number_length_check CHECK (((house_number IS NULL) OR (char_length(house_number) <= 20))),
  CONSTRAINT deliveries_meal_quantity_nonnegative_check CHECK ((meal_quantity >= 0)),
  CONSTRAINT deliveries_meal_surcharge_nonnegative_check CHECK ((meal_surcharge >= (0)::numeric)),
  CONSTRAINT deliveries_notes_length_check CHECK (((notes IS NULL) OR (char_length(notes) <= 300))),
  CONSTRAINT deliveries_street_length_check CHECK (((street IS NULL) OR (char_length(street) <= 120))),
  CONSTRAINT deliveries_structured_address_required_check CHECK (((city IS NOT NULL) AND (btrim(city) <> ''::text) AND (street IS NOT NULL) AND (btrim(street) <> ''::text) AND (house_number IS NOT NULL) AND (btrim(house_number) <> ''::text))));
CREATE TABLE public.parcel_requests (
  id uuid NOT NULL DEFAULT gen_random_uuid(), order_id uuid NOT NULL, branch_id uuid NOT NULL, tracking_ref text NOT NULL,
  tracking_key text GENERATED ALWAYS AS (upper(regexp_replace(tracking_ref, '[^A-Za-z0-9]'::text, ''::text, 'g'::text))) STORED,
  carrier text NULL, status text NOT NULL DEFAULT 'awaiting_search'::text, close_reason text NULL,
  last_actor text NOT NULL DEFAULT 'system'::text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  found_at timestamptz NULL, not_found_at timestamptz NULL, handed_to_courier_at timestamptz NULL, carrier_verified_at timestamptz NULL,
  closed_at timestamptz NULL, recipient_name text NULL,
  CONSTRAINT parcel_requests_pkey PRIMARY KEY (id),
  CONSTRAINT parcel_requests_order_uq UNIQUE (order_id),
  CONSTRAINT parcel_requests_branch_fk FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT parcel_requests_order_fk FOREIGN KEY (order_id) REFERENCES public.orders(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT parcel_requests_carrier_format CHECK (((carrier IS NULL) OR (((char_length(carrier) >= 1) AND (char_length(carrier) <= 40)) AND (carrier = btrim(carrier)) AND (carrier !~ '[[:cntrl:]]'::text) AND (carrier !~* '(https?:|www\\.|//)'::text)))),
  CONSTRAINT parcel_requests_close_reason_check CHECK (((close_reason IS NULL) OR (close_reason = ANY (ARRAY['order_cancelled'::text, 'food_only'::text, 'customer_request'::text, 'duplicate'::text, 'other'::text])))),
  CONSTRAINT parcel_requests_close_reason_iff_cancelled CHECK (((status = 'cancelled'::text) = (close_reason IS NOT NULL))),
  CONSTRAINT parcel_requests_closed_ts CHECK (((status = ANY (ARRAY['carrier_verified'::text, 'returned_to_store'::text, 'cancelled'::text])) = (closed_at IS NOT NULL))),
  CONSTRAINT parcel_requests_found_ts CHECK (((status <> 'found'::text) OR (found_at IS NOT NULL))),
  CONSTRAINT parcel_requests_handoff_ts CHECK (((status <> ALL (ARRAY['handed_to_courier'::text, 'delivery_problem'::text, 'returned_to_store'::text, 'carrier_verified'::text])) OR (handed_to_courier_at IS NOT NULL))),
  CONSTRAINT parcel_requests_last_actor_format CHECK ((last_actor ~ '^[a-z0-9_:-]{2,64}$'::text)),
  CONSTRAINT parcel_requests_not_found_ts CHECK (((status <> 'not_found'::text) OR (not_found_at IS NOT NULL))),
  CONSTRAINT parcel_requests_recipient_name_format CHECK (((recipient_name IS NULL) OR (((char_length(recipient_name) >= 2) AND (char_length(recipient_name) <= 60)) AND (recipient_name = btrim(recipient_name)) AND (recipient_name !~ '[[:cntrl:]]'::text)))),
  CONSTRAINT parcel_requests_status_check CHECK ((status = ANY (ARRAY['awaiting_search'::text, 'found'::text, 'not_found'::text, 'handed_to_courier'::text, 'carrier_verified'::text, 'delivery_problem'::text, 'returned_to_store'::text, 'cancelled'::text]))),
  CONSTRAINT parcel_requests_tracking_key_len CHECK (((char_length(tracking_key) >= 4) AND (char_length(tracking_key) <= 40))),
  CONSTRAINT parcel_requests_tracking_ref_format CHECK (((tracking_ref ~ '^[A-Za-z0-9 ._/#-]{4,40}$'::text) AND (tracking_ref = btrim(tracking_ref)) AND (tracking_ref !~ '  '::text))),
  CONSTRAINT parcel_requests_verified_ts CHECK (((status <> 'carrier_verified'::text) OR (carrier_verified_at IS NOT NULL))));
CREATE UNIQUE INDEX parcel_requests_active_key_uq ON public.parcel_requests USING btree (branch_id, tracking_key) WHERE (status = ANY (ARRAY['awaiting_search'::text, 'found'::text, 'not_found'::text, 'handed_to_courier'::text, 'delivery_problem'::text]));
CREATE INDEX parcel_requests_branch_status_idx ON public.parcel_requests USING btree (branch_id, status);
CREATE TABLE public.parcel_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), parcel_id uuid NOT NULL, order_id uuid NOT NULL, from_status text NULL,
  to_status text NOT NULL, actor text NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT parcel_events_parcel_fk FOREIGN KEY (parcel_id) REFERENCES public.parcel_requests (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT parcel_events_status_check CHECK (to_status IN ('awaiting_search', 'found', 'not_found', 'handed_to_courier', 'carrier_verified', 'delivery_problem', 'returned_to_store', 'cancelled')
    AND (from_status IS NULL OR from_status IN ('awaiting_search', 'found', 'not_found', 'handed_to_courier', 'carrier_verified', 'delivery_problem', 'returned_to_store', 'cancelled'))),
  CONSTRAINT parcel_events_actor_format CHECK (actor ~ '^[a-z0-9_:-]{2,64}$'));
`
export const HEADERS = {
  create_order: `CREATE FUNCTION public.create_order(p_order jsonb, p_items jsonb, p_delivery jsonb DEFAULT NULL)
    RETURNS TABLE(created_order_id uuid, created_order_number integer, created_daily_number integer)
    LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = ''`,
  create_order_with_parcel: `CREATE FUNCTION public.create_order_with_parcel(p_order jsonb, p_items jsonb, p_delivery jsonb, p_parcel jsonb)
    RETURNS TABLE(created_order_id uuid, created_order_number integer, created_daily_number integer)
    LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = ''`,
}
export const TRIGGERS_AND_SECURITY = `
CREATE TRIGGER orders_parcel_accept_gate BEFORE UPDATE ON public.orders FOR EACH ROW WHEN (((old.status = 'received'::text) AND (new.status IS DISTINCT FROM 'received'::text) AND (new.status IS DISTINCT FROM 'cancelled'::text))) EXECUTE FUNCTION public.orders_parcel_accept_gate();
CREATE TRIGGER orders_parcel_cancel_gate BEFORE UPDATE ON public.orders FOR EACH ROW WHEN (((old.status = 'received'::text) AND (new.status = 'cancelled'::text))) EXECUTE FUNCTION public.orders_parcel_cancel_gate();
CREATE TRIGGER orders_parcel_cancel_sync AFTER UPDATE ON public.orders FOR EACH ROW WHEN (((new.status = 'cancelled'::text) AND (old.status IS DISTINCT FROM 'cancelled'::text))) EXECUTE FUNCTION public.orders_parcel_cancel_sync();
CREATE TRIGGER parcel_requests_before_write BEFORE INSERT OR UPDATE ON public.parcel_requests FOR EACH ROW EXECUTE FUNCTION public.parcel_requests_before_write();
CREATE TRIGGER parcel_requests_log_insert AFTER INSERT ON public.parcel_requests FOR EACH ROW EXECUTE FUNCTION public.parcel_requests_log_event();
CREATE TRIGGER parcel_requests_log_status AFTER UPDATE OF status ON public.parcel_requests FOR EACH ROW WHEN ((old.status IS DISTINCT FROM new.status)) EXECUTE FUNCTION public.parcel_requests_log_event();
CREATE TRIGGER parcel_events_no_update_delete BEFORE UPDATE OR DELETE ON public.parcel_events FOR EACH ROW EXECUTE FUNCTION public.parcel_events_append_only();
CREATE TRIGGER parcel_events_no_truncate BEFORE TRUNCATE ON public.parcel_events FOR EACH STATEMENT EXECUTE FUNCTION public.parcel_events_append_only();
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY; ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.deliveries ENABLE ROW LEVEL SECURITY; ALTER TABLE public.parcel_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.parcel_events ENABLE ROW LEVEL SECURITY;
-- Production policies (Q1 section 06); inert without table privileges for anon.
CREATE POLICY "allow public insert orders" ON public.orders FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "allow public read orders" ON public.orders FOR SELECT TO anon USING (true);
CREATE POLICY insert_orders ON public.orders FOR INSERT WITH CHECK (true);
CREATE POLICY no_delete_orders ON public.orders FOR DELETE USING (false);
CREATE POLICY no_update_orders ON public.orders FOR UPDATE USING (false);
CREATE POLICY select_own_order ON public.orders FOR SELECT USING (true);
CREATE POLICY "allow public insert order_items" ON public.order_items FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "allow public read order_items" ON public.order_items FOR SELECT TO anon USING (true);
CREATE POLICY insert_order_items ON public.order_items FOR INSERT WITH CHECK (true);
CREATE POLICY no_delete_order_items ON public.order_items FOR DELETE USING (false);
CREATE POLICY no_update_order_items ON public.order_items FOR UPDATE USING (false);
CREATE POLICY select_order_items ON public.order_items FOR SELECT USING (true);
-- Production grants (Q1 section 07): non-owner privileges are service_role only.
REVOKE ALL ON public.orders, public.order_items, public.deliveries, public.parcel_requests, public.parcel_events,
              public.branches, public.menu_items, public.managers, public.users FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON public.orders, public.order_items, public.deliveries TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.parcel_requests TO service_role;
GRANT SELECT, INSERT ON public.parcel_events TO service_role;
GRANT SELECT ON public.branches, public.menu_items TO service_role;
REVOKE ALL ON SEQUENCE public.orders_order_number_seq FROM PUBLIC, anon, authenticated, service_role;
GRANT USAGE, SELECT, UPDATE ON SEQUENCE public.orders_order_number_seq TO service_role;
REVOKE ALL ON FUNCTION public.create_order(jsonb, jsonb, jsonb), public.create_order_with_parcel(jsonb, jsonb, jsonb, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_order(jsonb, jsonb, jsonb), public.create_order_with_parcel(jsonb, jsonb, jsonb, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.orders_parcel_accept_gate(), public.orders_parcel_cancel_gate(), public.orders_parcel_cancel_sync()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.parcel_requests_before_write(), public.parcel_requests_log_event(), public.parcel_events_append_only()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.parcel_requests_before_write(), public.parcel_requests_log_event() TO service_role;
INSERT INTO public.branches VALUES ('${B1}', 'adumim'), ('${B2}', 'other');
INSERT INTO public.menu_items VALUES ('${M1}', 'falafel'), ('${M2}', 'sabich');
`


/** Builds the fixture and installs the 8 Production bodies; returns { sources } (name → { md5, len, body }). */
export function installFixture(psql, root) {
  psql(FIXTURE)
  const csv = readFileSync(join(root, 'db', 'schema', 'hyp05_production_function_sources.csv'), 'utf8').split(/\r?\n/).filter(Boolean).slice(1)
  const sources = {}
  for (const line of csv) {
    const m = line.match(/^([^,]+),(?:"([^"]*)"|([^,"]*)),([0-9a-f]{32}),(\d+),([0-9a-f]*)$/)
    assert.ok(m, `unparsed CSV row: ${line.slice(0, 60)}`)
    sources[m[1]] = { md5: m[4], len: Number(m[5]), body: Buffer.from(m[6], 'hex').toString('utf8') }
  }
  assert.equal(Object.keys(sources).length, 8, 'the Q6 export must hold 8 function sources')
  for (const [name, s] of Object.entries(sources)) {
    assert.ok(!s.body.includes('$hyp05src$'))
    const header = HEADERS[name] ?? `CREATE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''`
    psql(`${header} AS $hyp05src$${s.body}$hyp05src$;`)
  }
  psql(TRIGGERS_AND_SECURITY)
  const installed = rows(psql(`SELECT proname, md5(prosrc) || '/' || length(prosrc) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = ANY (ARRAY[${Object.keys(sources).map(lit).join(',')}]) ORDER BY 1;`))
  for (const [name, print] of installed) assert.equal(print, `${sources[name].md5}/${sources[name].len}`, `installed body of ${name} differs from Production`)
  assert.equal(installed.find(r => r[0] === 'create_order')[1], PROD.create_order)
  assert.equal(installed.find(r => r[0] === 'create_order_with_parcel')[1], PROD.create_order_with_parcel)
  console.log(`Production function bodies installed byte-exact: ${installed.map(r => `${r[0]}=${r[1].split('/')[0].slice(0, 8)}`).join(', ')}`)
  return { sources }
}
