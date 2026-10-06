-- FALAFEL-SN-08D15 — public.kitchen_users: server-only kitchen accounts (replaces the KITCHEN_USERS env JSON).
--
-- NOT EXECUTED BY THE APP. Run manually in the Supabase SQL editor after review.
-- Contains NO users and NO password hashes (see db/templates/08d15_insert_kitchen_user_adumim.template.sql).
--
-- Security model:
--   * RLS enabled, NO policies → anon / authenticated can never read or write (deny by default).
--   * Table privileges revoked from PUBLIC, anon, authenticated; granted to service_role only
--     (lib/kitchenUsers.ts reads it via the server-only service-role client).
--   * Passwords: scrypt hashes only, exact app format scrypt$<N>$<r>$<p>$<salt b64url>$<key b64url>.
--   * Branch scope for this phase: only the verified branch 8fed141d-0e7c-46c1-803b-88d3d811c1f8 (מישור אדומים).
--
-- Re-running fails on CREATE TABLE (intentional: no silent partial re-apply).

begin;

-- Preflight: branches.id must be uuid and the allowed branch must exist (abort otherwise).
do $$
begin
  if (select data_type from information_schema.columns
       where table_schema = 'public' and table_name = 'branches' and column_name = 'id') is distinct from 'uuid' then
    raise exception 'kitchen_users migration: public.branches.id is not uuid';
  end if;
  if not exists (select 1 from public.branches where id = '8fed141d-0e7c-46c1-803b-88d3d811c1f8'::uuid) then
    raise exception 'kitchen_users migration: branch 8fed141d-0e7c-46c1-803b-88d3d811c1f8 not found';
  end if;
end
$$;

create table public.kitchen_users (
  username      text        primary key,
  password_hash text        not null,
  role          text        not null,
  branch_id     uuid        null references public.branches (id) on update restrict on delete restrict,
  label         text        not null,
  is_active     boolean     not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint kitchen_users_username_format
    check (username ~ '^[a-z0-9_-]{2,32}$'),
  constraint kitchen_users_role_check
    check (role in ('admin', 'branch')),
  constraint kitchen_users_role_branch_check
    check ((role = 'admin' and branch_id is null) or (role = 'branch' and branch_id is not null)),
  -- Current phase: only the verified מישור אדומים branch. Widen deliberately in a later migration.
  constraint kitchen_users_branch_allowed
    check (branch_id is null or branch_id = '8fed141d-0e7c-46c1-803b-88d3d811c1f8'::uuid),
  constraint kitchen_users_label_check
    check (char_length(btrim(label)) between 1 and 60),
  -- Same shape the app's parsePasswordHash() accepts (the app additionally checks N / r / p / lengths).
  constraint kitchen_users_password_hash_format
    check (password_hash ~ '^scrypt\$[0-9]+\$[0-9]+\$[0-9]+\$[A-Za-z0-9_-]{22,}\$[A-Za-z0-9_-]{43,}$')
);

comment on table public.kitchen_users is
  'Kitchen staff accounts (FALAFEL-SN-08D15). Server-only: service_role access, RLS on with no policies. scrypt hashes only.';
comment on column public.kitchen_users.password_hash is
  'scrypt$<N>$<r>$<p>$<salt b64url>$<key b64url> — never plaintext, never returned to clients.';

-- updated_at maintenance (future: password reset / activate / deactivate / admin screen).
create function public.kitchen_users_set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

revoke all on function public.kitchen_users_set_updated_at() from public, anon, authenticated;

create trigger kitchen_users_set_updated_at
  before update on public.kitchen_users
  for each row execute function public.kitchen_users_set_updated_at();

-- Lock-down: RLS on, no policies; privileges only for service_role.
alter table public.kitchen_users enable row level security;

revoke all on table public.kitchen_users from public, anon, authenticated;
grant select, insert, update, delete on table public.kitchen_users to service_role;

commit;

-- ─── Read-only verification (run after commit; expected results in comments) ───
-- 1) RLS on, no policies:
--    select relrowsecurity from pg_class where oid = 'public.kitchen_users'::regclass;          -- true
--    select count(*) from pg_policies where schemaname = 'public' and tablename = 'kitchen_users'; -- 0
-- 2) Only service_role (and the owner) hold privileges:
--    select grantee, privilege_type from information_schema.role_table_grants
--     where table_schema = 'public' and table_name = 'kitchen_users' order by grantee, privilege_type;
--    -- no rows for anon / authenticated / PUBLIC
-- 3) Constraints present:
--    select conname from pg_constraint where conrelid = 'public.kitchen_users'::regclass order by conname;
-- 4) Empty until the one-time insert:
--    select count(*) from public.kitchen_users;                                                  -- 0
