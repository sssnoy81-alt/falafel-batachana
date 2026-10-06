-- FALAFEL-SN-08D15 — ONE-TIME insert of the first kitchen account (TEMPLATE — contains NO hash, NO password).
--
-- How to use (locally, never commit the filled copy):
--   1. Generate the hash on your own machine:   node scripts/hash-kitchen-password.mjs
--      (input is hidden; it prints ONLY the scrypt hash). Verify it before use.
--   2. Paste it into a COPY of this file outside Git (e.g. db/local/, which is git-ignored) or straight
--      into the Supabase SQL editor — replace the placeholder below.
--   3. Run after db/migrations/20261006_08d15_kitchen_users.sql has been applied.
--   Never put the plaintext password in this file, chat, logs or commits.
--
-- The guard aborts (nothing inserted) if the placeholder was not replaced or the hash format is wrong.

begin;

do $$
declare
  h text := '<PASTE_VERIFIED_SCRYPT_HASH_HERE>';
begin
  if h like '<%' or h !~ '^scrypt\$[0-9]+\$[0-9]+\$[0-9]+\$[A-Za-z0-9_-]{22,}\$[A-Za-z0-9_-]{43,}$' then
    raise exception 'kitchen user insert: paste a verified scrypt hash first';
  end if;

  insert into public.kitchen_users (username, password_hash, role, branch_id, label, is_active)
  values ('adumim', h, 'branch', '8fed141d-0e7c-46c1-803b-88d3d811c1f8'::uuid, 'מישור אדומים', true);
end
$$;

commit;

-- Read-only check (never selects the hash):
--   select username, role, branch_id, label, is_active, created_at, updated_at
--     from public.kitchen_users where username = 'adumim';
