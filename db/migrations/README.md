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
| S4-04B | `s4_04b_maale_quote_rate_limit.sql` | Durable kitchen courier **quote rate limit**: append-only ledger `public.maale_dispatch_requests` (order, branch, kitchen account, time — no customer data; RLS on, service_role SELECT+INSERT only) + `consume_maale_quote_slot(uuid, uuid, text)` (INVOKER, search_path '', lock_timeout 3s, service_role-only EXECUTE; one transaction-scoped advisory lock; 3/order/30 min, 20/branch/60 min, 40/global/60 min). Additive only; `delivery_dispatches` untouched. | Production 2026-10-23: `s4_04b_production_preflight.sql` all PASS → install → `s4_04b_verify.sql` all PASS. `s4_04b_rollback.sql` = manual, approval-only (`SET s4_04b.confirm_rollback = 'DROP-QUOTE-LEDGER'`) |
| S4-04D | `s4_04d_maale_dispatch_reconciliations.sql` | Append-only **courier reconciliation / cancellation audit ledger** `public.maale_dispatch_reconciliations` (order → orders(id) RESTRICT, closed `event_type` list, kitchen-account actor, safe provider id / status, bounded `reason_code`; **no free text, no customer data, no dispatch_id**). RLS on, service_role SELECT+INSERT only. Never changes `delivery_dispatches`; no functions / triggers. | Production 2026-10-23: `s4_04d_production_preflight.sql` all PASS → install → `s4_04d_verify.sql` all PASS (before 04E). `s4_04d_rollback.sql` = manual, approval-only — **never after real ledger events** |
| S4-04E | `s4_04e_courier_coordination.sql` | **Atomic courier coordination** (requires 04B + 04D installed and verified). Dedicated role `maale_dispatch_coordinator` (NOLOGIN NOINHERIT BYPASSRLS, member of nothing; COLUMN-level grants only — `delivery_dispatches` SELECT of the 6 claim / consistency columns + UPDATE of the 5 claim columns, ledger SELECT + INSERT of the 7 payload columns, `orders` SELECT (id) only; USAGE on `public`; BYPASSRLS needed because these tables have RLS and no policies, and it reaches nothing else) owns both SECURITY DEFINER functions: `claim_maale_dispatch(uuid, integer, timestamptz)` and `record_maale_reconciliation_event(…7 args)`. They share one per-order transaction-scoped advisory lock, so a committed manual courier blocks a later claim and a committed claim (`sending` / `sent`) blocks an ordinary manual courier. Guard trigger on `delivery_dispatches`: new rows pending/0 only, `sent` immutable, leaving `pending` / entering `sending` only when `current_user` is the coordinator (service_role cannot become it). Revokes service_role's direct INSERT on the ledger (writes only through the function). No table / row changes. | Production 2026-10-23: `s4_04e_production_preflight.sql` all PASS → install → `s4_04e_verify.sql` 14 PASS + 2 INFO → `s4_04_combined_verify.sql` stage `post_04e`, 19 PASS + 1 INFO, 0 FAIL. `s4_04e_rollback.sql` = manual, approval-only (`SET s4_04e.confirm_rollback = 'DROP-COURIER-COORDINATION'`) |

### Prepared — NOT yet applied to Production

| # | File | What it does | Checks |
|---|---|---|---|
| 05 ⚠ | `parcel_05_recipient_name.sql` | Optional `parcel_requests.recipient_name` (NULL / 2–60 chars, trimmed, no control chars) + `create_order_with_parcel` accepts one more key, `recipient_name` (same signature, INVOKER, service_role-only). Additive only. | before: `parcel_05_production_preflight.sql` · after: `parcel_05_verify.sql` · `parcel_05_rollback.sql` = function-only, non-destructive, separate approval |
| HYP-05 | `hyp05_payment_intents.sql` | **Online payments (Hyp Pay)**: payment-intent ledger (`payment_intents`, `payment_returns`, `payment_transactions`, `payment_reversals`, `payment_intent_events`; RLS on, no policies, service_role SELECT only, append-only evidence), NOLOGIN coordinator role `hyp_payment_coordinator` (column grants derived from the Production bodies of `create_order` / wrapper), 7 SECURITY DEFINER functions, `orders_payment_method_check` + `online`, AFTER guard triggers on `orders` (an `online` order only via `finalize_paid_intent`). Bodies of `create_order` / wrapper unchanged. Includes HYP-06A (non-capture 600/700/800) and HYP-09 (staff flags, one reversal per HYP reference, notes in the trail). Isolated test: `node scripts/pgtest-hyp05-payment-intents.mjs`. | `hyp05_production_preflight.sql` (before), `hyp05_verify.sql` (after), `hyp05_privilege_audit.sql` (before + after) |




**S4-04 Production installation record (2026-10-23, owner-run in the Supabase SQL Editor as `postgres`):**
stage-0 read-only gate (PostgreSQL 17.6; installer CREATEROLE + BYPASSRLS; `delivery_dispatches` = documented baseline;
no user triggers; no S4-04 object) → 04B → 04D → combined verify `pre_04e` (19 PASS + 1 INFO) → `orders.phone` present →
04E → 04E verify → combined verify `post_04e` (19 PASS + 1 INFO, 0 FAIL). Data unchanged: `delivery_dispatches` sent=1
(historical courier #284), ledger empty. **SQL Editor finding:** the Editor (or an intermediary) fails with
`42P01 relation "the" does not exist` on the phrase `INSERT into the …` even inside a string literal (comments reworded as a precaution), so the
files below were installed / run with that prose reworded — `s4_04e_courier_coordination.sql` (comment line 10 and the
post-check message, line 352) and `s4_04_combined_verify.sql` (row-08 label). No function body, grant, check condition or
expected value changed (the function-body fingerprints in `s4_04e_verify.sql` are identical). Keep such phrases out of
SQL meant for the Editor. All S4-04 courier flags remain OFF; the application release is a separate, approved step.

**S4-04E order:** install 04B → 04D → 04E (each followed by its verify), together with the application change that calls
the two functions (S4-04E2; the app fails closed without them). For the whole courier schema use the version-aware
**`s4_04_combined_verify.sql`** (detects pre-04E / post-04E and applies the matching privileges; a partial install FAILs).
After 04E, the per-migration **04D verify row 05 reports FAIL by design** (service_role keeps only SELECT on the ledger);
the combined verify checks that state explicitly instead of ignoring it. Residual (documented, tested): the project owner /
installer role (`postgres`, which holds SET on the coordinator) and superusers can still act as the coordinator; no
application role can. 04E1's writable transaction-setting marker was removed — it was never an authorization boundary.

**S4-04F2:** 04E requires **PostgreSQL 16 or newer**. The migration checks this first and refuses with a clear message,
and `s4_04e_production_preflight.sql` row 12 FAILs below 16. A provider 401 on the dry-run **quote** no longer needs a
dispatch claim. The order's own never-attempted row gets `error_code = 'unauthorized'`, with status `pending` and
attempts 0 unchanged (the 04E guard allows this), and the existing 30-minute global stop reads that row. After install,
the PostgREST envelopes can be confirmed without writing anything using
`scripts/s4-04e-rpc-envelope-probe.mjs --confirm=READ-ONLY-RPC-ENVELOPE-PROBE`. That script is manual and owner-run;
it was tested offline and against an isolated real PostgREST by `scripts/pgtest-s4-04e-postgrest-envelope.mjs`.

**S4-04B order:** install it BEFORE deploying an application that calls `consume_maale_quote_slot` (the current
application never calls it). Primary rollback = application rollback; the schema can stay.

**S4-04D meaning:** a ledger row is an operational record entered by a kitchen ACCOUNT (usually after a phone call with
Maale Express), not independently verified provider truth. A `sent` dispatch stays `sent`; "cancelled at the provider"
exists only as a ledger row. Install it BEFORE deploying an application that reads or writes it.

**Order: install 05 BEFORE deploying the application that uses `recipient_name`** (the pre-05 wrapper rejects unknown
parcel keys and the new kitchen query selects the column). Primary rollback = application rollback; the schema stays.
After 05, these historical checks pin the pre-05 wrapper fingerprint (`7d491c09…` / 2474) and will FAIL by design for that
row — use `parcel_05_verify.sql` instead: `parcel_03_production_preflight.sql`, `parcel_03_verify.sql`,
`parcel_04_production_preflight.sql`, `parcel_04_verify.sql` (and the S4-C0-A audit query, which also flags the new
constraint as "unexpected").

The security key migration (G2–G5: new `sb_secret_` / `sb_publishable_` keys, legacy JWT keys disabled, legacy HS256
signing key revoked) was done in the Supabase and Vercel dashboards. It has no SQL file.
> ⚠ **Migration 05 is installed in Production** — verified read-only on 2026-10-24 (HYP-02 Q1: `parcel_requests.recipient_name` EXISTS; `create_order_with_parcel` = POST-05 CRLF body `6ceb72f6…` / 2771). The row stays here until its own install record is written.


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
| `hyp05_production_preflight.sql` | Pre-install check for HYP-05 (create_order / wrapper fingerprints, four-value payment CHECK, no online orders, installer rights, public-role privileges) |
| `hyp05_verify.sql` | Post-install check for HYP-05 (role, DEFINER functions, EXECUTE matrix, RLS / grants, guards, fingerprints unchanged) |
| `hyp05_privilege_audit.sql` | Effective anon / authenticated / PUBLIC privileges on customer + payment tables (HYP-03R Q4) — before and after HYP-05 |

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
| `hyp05_rollback.sql` | the exact pre-HYP-05 state | Refuses while any online order, HYP return, transaction or redirected intent exists (financial evidence is never dropped). Primary rollback = `HYP_PAYMENTS_ENABLED` off. |

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
| `s4_04b_production_preflight.sql` | `48f1516062d127ff2d624f24e69ce654ae25d85c8c1793444a5518081876a57f` |
| `s4_04b_maale_quote_rate_limit.sql` | `e2270f7c6ac56a6c1d0104f7ea523c92ff47c956bf673caefc9321de7b718d3a` |
| `s4_04b_verify.sql` | `74000589359f668c2505b7ed979a117aef12f5a17bbbcdb536f251f7ff2f866b` |
| `s4_04b_rollback.sql` | `d7aeba49bf3100bd99dcaca3a28dcde8809e7e546c3d1b83c5b96cc275152b89` |
| `s4_04d_production_preflight.sql` | `2b60337d7b2ed6ca2ec49d60240e3dafbfbf885985a6c1b5e015ce06afeb82c5` |
| `s4_04d_maale_dispatch_reconciliations.sql` | `0142a110cfeb0d3dea152bfdbacb5f1d3dc4707ecc7a635eabb8e931c7dde52a` |
| `s4_04d_verify.sql` | `8bd205c7775ca9d80de25112bf644098da09c38075a84e7516ef24c6b9dec6fb` |
| `s4_04d_rollback.sql` | `10c0f97f1551566f3db28b661e56df3381902fce722f6a4f5874ad170ade6df3` |
| `s4_04e_production_preflight.sql` | `f8a0e1295274110a0f882e1572c3e3c78b5b5cc731a50096cb76eb225cf1c697` |
| `s4_04e_courier_coordination.sql` | `6d65af2561ca8b39da1f3a1f88ab0b6fdc2def304d7041aa47cda0e1150d6d2e` |
| `s4_04e_verify.sql` | `6f96b986ef685d64c5eec15e4264cccebda49da9f0eac854235e0d98a6ebb03a` |
| `s4_04e_rollback.sql` | `03bd2b019b1d0d5f58125d26b224342b9aa9c877979550f63920ae088137cb86` |
| `s4_04_combined_verify.sql` | `b7db35ec9e5a8d27aa2298def911eb4c120b731f2b72b13e9f71a767a7be12c1` |
