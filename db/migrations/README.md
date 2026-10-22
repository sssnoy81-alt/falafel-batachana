# Database migrations — history and usage

These SQL files are **run manually** in the Supabase SQL editor (as `postgres`). The app never runs them. Each
change was reviewed, tested on a throwaway local PostgreSQL, checked with a read-only preflight in Production, then
installed and verified with a read-only query.

> **Do not re-run an applied migration on the existing Production database.** Every install script starts with a
> preflight that aborts if its objects already exist, but treat this as a safety net, not a workflow.
>
> Headers saying `REVIEW ONLY — NOT EXECUTED` describe the file **when it was written**. They were deliberately left
> unchanged after installation, because the files are pinned by SHA-256 / function fingerprints.

## Applied to Production (in order)

| # | File | What it does | Verified with |
|---|---|---|---|
| 08D15 | `20261006_08d15_kitchen_users.sql` | `public.kitchen_users` (server-only kitchen accounts) | — |
| 01 | `parcel_01_tables.sql` | Parcel tables, triggers, RLS, grants — **see the history note at the top of the file** | `parcel_99_verify.sql` (rows for 01/02) |
| 02 | `parcel_02_create_order_with_parcel.sql` | `create_order_with_parcel` wrapper (food order + parcel in one transaction) | `parcel_99_verify.sql` |
| 01b | `parcel_01b_insert_lock.sql` | Replaces `parcel_requests_before_write()` (order row `FOR SHARE` on insert) | post-check inside the file |
| 03 | `parcel_03_orders_gate.sql` | Acceptance gate + cancellation sync triggers on `orders` | `parcel_03_verify.sql` |
| SEC-2 | `sec2_01_revoke_public_access.sql` | Revokes PUBLIC / anon / authenticated table privileges on `orders`, `order_items`, `push_subscriptions` | `sec2_01_verify.sql` |
| 04 | `parcel_04_cancel_gate.sql` | Cancellation gate for `received` orders with a parcel (closes the "not_found → found" race) | `parcel_04_verify.sql` (12 PASS, 1 INFO) |

### Prepared — NOT yet applied to Production

| # | File | What it does | Checks |
|---|---|---|---|
| 05 | `parcel_05_recipient_name.sql` | Optional `parcel_requests.recipient_name` (NULL / 2–60 chars, trimmed, no control chars) + `create_order_with_parcel` accepts one more key, `recipient_name` (same signature, INVOKER, service_role-only). Additive only. | before: `parcel_05_production_preflight.sql` · after: `parcel_05_verify.sql` · `parcel_05_rollback.sql` = function-only, non-destructive, separate approval |

| S4-04B | `s4_04b_maale_quote_rate_limit.sql` | Durable kitchen courier **quote rate limit**: append-only ledger `public.maale_dispatch_requests` (order, branch, kitchen account, time — no customer data; RLS on, service_role SELECT+INSERT only) + `consume_maale_quote_slot(uuid, uuid, text)` (INVOKER, search_path '', lock_timeout 3s, service_role-only EXECUTE; one transaction-scoped advisory lock; 3/order/30 min, 20/branch/60 min, 40/global/60 min). Additive only; `delivery_dispatches` untouched. | before: `s4_04b_production_preflight.sql` · after: `s4_04b_verify.sql` · `s4_04b_rollback.sql` = manual, approval-only, needs `SET s4_04b.confirm_rollback = 'DROP-QUOTE-LEDGER'` · isolated test: `scripts/pgtest-s4-04b-quote-rate-limit.mjs` (Docker, `--network none`) |

**S4-04B order:** install it BEFORE deploying an application that calls `consume_maale_quote_slot` (the current
application never calls it). Primary rollback = application rollback; the schema can stay.

**Order: install 05 BEFORE deploying the application that uses `recipient_name`** (the pre-05 wrapper rejects unknown
parcel keys and the new kitchen query selects the column). Primary rollback = application rollback; the schema stays.
After 05, these historical checks pin the pre-05 wrapper fingerprint (`7d491c09…` / 2474) and will FAIL by design for that
row — use `parcel_05_verify.sql` instead: `parcel_03_production_preflight.sql`, `parcel_03_verify.sql`,
`parcel_04_production_preflight.sql`, `parcel_04_verify.sql` (and the S4-C0-A audit query, which also flags the new
constraint as "unexpected").

The security key migration (G2–G5: new `sb_secret_` / `sb_publishable_` keys, legacy JWT keys disabled, legacy HS256
signing key revoked) was done in the Supabase and Vercel dashboards. It has no SQL file.

## Read-only checks (safe to run at any time)

| File | Purpose |
|---|---|
| `parcel_03_production_preflight.sql` | Pre-install compatibility check for 03 |
| `parcel_03_verify.sql` | Post-install check for 03. **Row 05 ("exactly two triggers") FAILs since 04 is installed — expected; `parcel_04_verify.sql` replaces it.** |
| `parcel_04_production_preflight.sql` | Pre-install compatibility check for 04. Rows 09 and 18 FAIL once 04 is installed — expected (it is a pre-install check). |
| `parcel_04_verify.sql` | Post-install check for 04 (also re-checks 03, 01b and neighbouring functions) |
| `sec2_01_verify.sql` | Post-install check for SEC-2 |
| `parcel_99_verify.sql` | Original verification for 01/02. **Superseded for the 03 rows** (it expects the old received→confirmed-only gate). |
| `s4_03_dispatch_readiness_verify.sql` | `public.delivery_dispatches` shape vs `lib/maaleDispatch.ts` (columns, uniques, FK, CHECKs, RLS, grants, row counts per status) + orders payment columns / deliveries geo constraint (S4-INTEGRATIONS-03B). Safe when the table is missing. |

## Schema documented outside migrations

| Object | File | Status |
|---|---|---|
| `public.delivery_dispatches` | `../schema/delivery_dispatches.baseline.sql` | **Exists in Production, created outside this repository (no migration was recorded).** The baseline is **documentation only — NOT a migration**: it starts with a `RAISE EXCEPTION` and must never be applied to Production. Columns, defaults, constraint / index names and security are transcribed from the owner's Production verification (03J2); the few remaining inferred / unverified details (FK action, exact CHECK spelling, triggers, owner) are marked inline. A fresh environment or any change to the Production table needs its own reviewed migration (preflight / verify / rollback). |

They return one table of PASS / FAIL / INFO rows and print no function bodies, tracking numbers or customer data.

## Emergency rollback scripts — never run without separate explicit approval

| File | Restores | Notes |
|---|---|---|
| `parcel_04_rollback.sql` | the Migration 03 state | Re-opens the cancellation race. **Must run before `parcel_03_rollback.sql`.** |
| `parcel_03_rollback.sql` | the pre-03 state | Refuses while 04 is installed (requires exactly two triggers on `orders`). |
| `parcel_01b_rollback.sql` | the exact pre-01b `parcel_requests_before_write()` | Embeds the verified Production source as hex. |
| `sec2_01_rollback.sql` | the exact pre-SEC-2 table privileges | **Re-opens public read / insert of customer order data.** |

Each refuses to run unless exactly the reviewed objects are installed, then checks its result in the same transaction.

## Known historical gaps

1. **`parcel_01_tables.sql` is the original authored draft, not the executed text.** Its `parcel_requests_before_write()`
   has an `IF NOT CASE … END THEN` check that PL/pgSQL cannot parse. Production ran a corrected version (fingerprint
   `caecf3a8…` / 4862), since replaced by 01b. The file is preserved unchanged below a history note; the original
   bytes (SHA-256 `a86699da…c7e5`) are everything after the note's END marker.
2. **The exact text executed for 01 is not recorded** — function bodies are known exactly (fingerprints, the hex in
   `parcel_01b_rollback.sql`); table / constraint / index / grant DDL is not. Read-only checks confirmed RLS, grants,
   triggers and the unique index on `parcel_requests(order_id)`. Constraint and index **names** (used by the S4-A error
   mapping, e.g. `parcel_requests_active_key_uq`) were not individually verified in Production.
3. **Earlier delivery migrations** (`deliveries` table, `create_order`, RLS lock-down) were applied before this folder
   was tracked and have no file here. `create_order` is pinned by fingerprint (`db92e75f…` / 6416) in the 02 / 03 / 04
   preflights.
4. **Production function sources** were captured on 2026-10-16 into `falafel_production_function_sources_verified.csv`
   (outside the repo). Not included here.

## Fingerprints (SHA-256 of the files as installed / verified)

| File | SHA-256 |
|---|---|
| `parcel_04_cancel_gate.sql` | `5d3fa41bf2a4128e36cee69d63930155d498b1734fb13692447aaca83e092fd0` |
| `parcel_04_verify.sql` | `f1e137257e4481f97a6b418d9244b37abcfc333d6c29a82689ed165dd7d0d41e` |
| `parcel_04_rollback.sql` | `7e09e49f91bc8f5524bcf1078c37fd96606bed7b950b99b783dc6f88e0eaf9e4` |
| `parcel_04_production_preflight.sql` | `64e595ac63f4636d3775a19f81b4589aa7b08186347dae5e23ae4526c6436573` |
| `parcel_01b_insert_lock.sql` | `10e99e64ed9f6c94ed8737d43a84bee935939e78f7c04e77d51fc9e07b77eee6` |
| `parcel_01b_rollback.sql` | `1c5a557bc6ee4184cd5ad6d13e4e459d4a5df2886e66b66140d05a46a985f1d2` |
