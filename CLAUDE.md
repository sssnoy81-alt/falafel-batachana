# CLAUDE.md — Falafel BaTachana

Persistent project instructions for Claude / SN Capital AI agents working in this repository.
Read this file fully before starting any task.

---

## 1. Project Identity

| | |
|---|---|
| Project | Falafel BaTachana (פלאפל בתחנה) |
| Organization / development | SN Capital AI |
| Canonical repository | `sssnoy81-alt/falafel-batachana` (GitHub) |
| Canonical local path | `C:\Users\gsntr\poly-or-game\falafel-batachana\falafel-batachana` |
| Production branch | `main` (deployed to Vercel) |
| SN onboarding baseline | `c794056aeebaa4a537b39a43b5956159cedf8fbb` |

> ⚠️ **NEVER run Git operations in the outer folder `C:\Users\gsntr\poly-or-game\falafel-batachana`.**
> It is a stale legacy repository (March 2026) that points to the **same GitHub remote** with a divergent,
> older history. It records this repository as a broken gitlink (no `.gitmodules`). A push from the outer
> folder could overwrite production history. Treat the outer folder as a read-only archive.
> Always confirm `git rev-parse --show-toplevel` resolves to the canonical path above before any Git command.

---

## 2. Product Overview

A Hebrew-first (RTL) online ordering system for a falafel business with multiple branches.

**Customer-facing**
- **Landing page** — marketing page built from designed images with clickable hotspots (phone, WhatsApp, Waze, social, "order" button) and a video.
- **Ordering PWA** — installable, mobile-first app:
  - **first step: 🏃 pickup or 🛵 delivery** (delivery locks to מישור אדומים; pickup → branch list; one branch hidden)
  - **menu** by category, per-branch prices, item images from Supabase Storage; header toggle pickup ↔ delivery keeps the cart
  - item sheet: sauces, salads, paid add-ons, "no lettuce", notes, meal-deal (עסקית) drink/add-on choice
  - **cart** with edit/remove and upsell prompt
  - **checkout**: delivery address (approved localities dropdown), name, phone, payment-method choice (labels only).
    **No discount** (the old 5% app discount was removed).
  - **delivery pricing**: +₪4 per qualifying meal unit (category allowlist) + ₪20 fixed fee per delivery order.
    Customer-facing prices for delivery are shown **inclusive** of the +₪4; the ₪20 fee is a separate line.
  - **order tracking** screen with status, order number, order details; name/phone/address remembered for next order
  - business-hours gating (closed popup, order button disabled when closed)

**Operations**
- **Kitchen / staff order queue** (`/dashboard/orders`) — server-verified login (HttpOnly session cookie), columns by status, one-tap status advance, new-order audio alarm, branch filter for admin. Delivery orders show 🛵 badge, address, courier notes, surcharge + fee.
- **Order statuses**: `received → confirmed → preparing → ready → delivered`, plus `cancelled`.
- **Order note editing** per order item.
- **Cancellation** with confirmation.
- **Daily sales information** — today's total on the board.
- **CSV export** — today's delivered orders + customer summary, then opens a `mailto:` for the daily report.
- **Push notifications** — customer gets a web push when the order is marked `ready`.
- **Kitchen PWA installer** — `public/kitchen.html` + `public/manifest-kitchen.json`.

**Known incomplete areas**
- **No real payment integration.** Cash / credit / Cibus / Bit are labels stored on the order only. No provider, no payment status, no callbacks.
- **No printing integration.** No receipts, no kitchen tickets, no printer support.
- **Admin / business management is limited.** No menu/price management UI (edited directly in Supabase), no reporting beyond the daily total and CSV.

---

## 3. Current Route Map

| Route | File | Purpose / status |
|---|---|---|
| `/` | `app/page.tsx` | Landing page. |
| `/order` | `app/order/page.tsx` | Customer ordering application (~1,000 lines, single client component). |
| `/dashboard` | `app/dashboard/page.tsx` | **Retired.** Server redirect → `/dashboard/orders`. |
| `/dashboard/orders` | `app/dashboard/orders/page.tsx` | **Kitchen / staff application.** Client UI only: **no Supabase client, no keys, no passwords**; all data via `/api/kitchen/*`. |
| `POST /api/orders` | `app/api/orders/route.ts` | **Only customer order-creation path.** Validates intent, prices server-side, calls `create_order` RPC. |
| `GET /api/orders/[id]/status` | `app/api/orders/[id]/status/route.ts` | Minimal customer tracking: `{ id, dailyNumber, status, type }` only, `no-store`. |
| `POST /api/push/subscribe` | `app/api/push/subscribe/route.ts` | Customer: stores a push subscription by `order_id` after verifying order + phone + recency. |
| `POST /api/push/send` | `app/api/push/send/route.ts` | **Kitchen session required**, same-origin, `{ orderId }` only, branch-scoped. Manual re-send only (status route sends the ready push itself). |
| `POST /api/kitchen/login` · `/logout` | `app/api/kitchen/{login,logout}/route.ts` | Server-verified kitchen login (scrypt hashes from env) → HttpOnly signed cookie. |
| `GET /api/kitchen/session` | `app/api/kitchen/session/route.ts` | Current kitchen user (+ branch list for admin). |
| `GET /api/kitchen/orders` | `app/api/kitchen/orders/route.ts` | Today's orders (Asia/Jerusalem day), session branch scope, minimal fields. |
| `PATCH /api/kitchen/orders/[id]/status` | `app/api/kitchen/orders/[id]/status/route.ts` | Locked transition table, conditional update (tablet-race safe), server-side ready push. |
| `PATCH /api/kitchen/order-items/[id]/notes` | `app/api/kitchen/order-items/[id]/notes/route.ts` | Item notes (≤500), only while order is confirmed/preparing. |

**Shared modules (`lib/`)**: `orderConfig.ts` (IDs, delivery areas, fees, labels, menu rules),
`pricing.ts` (pure pricing used by UI + server; customer display helpers), `orderRequest.ts` (order validation/building),
`hours.ts` (Asia/Jerusalem opening hours + Israel-day bounds), `deliveryAddress.ts`, `createOrder.ts` (atomic RPC adapter),
`supabaseServer.ts` (**server-only** privileged client, no anon fallback), `supabaseBrowser.ts` (public env key only),
`kitchenAuth.ts` (server-only auth/session/CSRF), `kitchenOrders.ts` (read model), `kitchenMutations.ts`
(transitions/notes), `push.ts` (server-only ready push), `kitchenTypes.ts` (API contract types, client-safe).
Local checks: `node scripts/verify-{pricing,kitchen-auth,kitchen-read,kitchen-mutations}.mjs`.
Kitchen password hashes: `node scripts/hash-kitchen-password.mjs` (run locally; never commit passwords/hashes).

Layouts: `app/layout.tsx` (root, RTL, PWA meta, "Powered by SN Capital AI" footer), `app/dashboard/layout.tsx` (kitchen manifest + Vercel Analytics).

Public PWA assets: `public/manifest.json` (customer app, start `/order`), `public/manifest-kitchen.json` (kitchen, start `/dashboard/orders`), `public/sw.js` (push handler only, no caching), `public/kitchen.html` (kitchen install page), `public/falafel-landing/*` (landing images + video).

---

## 4. Tech Stack

| Package | Version |
|---|---|
| Next.js | 16.1.6 (App Router) |
| React / React DOM | 19.2.3 |
| TypeScript | 5.x (`strict: true`) |
| Tailwind CSS | 4 (`@tailwindcss/postcss`) |
| @supabase/supabase-js | 2.98.x |
| web-push | 3.6.x |
| @vercel/analytics | 2.x |
| ESLint | 9 (`eslint-config-next` core-web-vitals + typescript) |
| recharts | installed, **not currently used** |
| xlsx | installed, **not currently used** |

**Architecture notes**
- Uses **`/app` directly**, not `/src/app`. Path alias `@/*` → repo root.
- Pages are mostly **`'use client'`** components; only layouts are server components.
- **Polling, not Supabase Realtime** — customer tracking polls every 10s, kitchen every 20s.
- **Monolithic page files** with duplicated logic (e.g. menu loading, status config).
- **Inline styles are common**; Tailwind is present but lightly used.
- `next.config.ts` is empty (no headers, redirects, or image config). Images use plain `<img>`.
- Next.js 16: route protection middleware file is `proxy.ts` (not `middleware.ts`). None exists yet.
- Hardcoded business values live in code (`lib/orderConfig.ts`, `lib/hours.ts`, `lib/kitchenAuth.ts`): branch IDs, the hidden branch, meal/drink category IDs, delivery areas, ₪4/₪20 delivery charges, business hours, meal-deal extra prices.

---

## 5. Data Model — Currently Observed

Inferred **only from application code**:

| Table | Observed purpose |
|---|---|
| `branches` | Branch list (id, name, address, sort_order). |
| `menu_categories` | Menu sections (name_he, sort_order). Deal category detected by name containing `עסקי`. |
| `menu_items` | Products (name_he/en, description, image_url, dietary_type, is_active, is_popular, flags like has_lettuce). |
| `toppings` | Sauces (`spread`), salads (`filling`), paid add-ons (`paid_addon`, with price). |
| `branch_prices` | Per-branch item price and `is_available`. Items without a price are hidden. |
| `orders` | branch_id, phone, customer_name, payment_method, status, total_price, daily_number (per Israel day), order_number (global sequence — NOT the ticket number), `type` ('pickup'/'delivery', NULL on legacy rows; new orders always set it), created_at. |
| `deliveries` | 1:1 extension of `orders` for delivery orders (FK + UNIQUE order_id, ON DELETE NO ACTION): address, structured address (city/street/house_number/apartment/floor/entrance), notes, delivery_fee, meal_surcharge, meal_quantity. **RLS on, no anon/authenticated access — server-only.** |
| `order_items` | order_id, item_id, quantity, unit_price, notes (selected options are serialized into notes text). |
| `push_subscriptions` | phone, order_id, subscription JSON. |

Storage: public bucket `menu-images` (logos, menu images, manifest icons).
RPC: `public.create_order(p_order, p_items, p_delivery)` — SECURITY INVOKER, EXECUTE for `service_role` only.
Not used: views, Realtime, Supabase Auth. `orders.confirmed_at/ready_at/delivered_at` exist but are not maintained.

> ⚠️ Verified: `deliveries` (RLS + grants), `create_order` (exists, privileges). **Not verified / known open:** anon
> still reads/inserts `orders`, `order_items`, `push_subscriptions` (SEC-2). Any schema/RLS change requires approval (§10).

---

## 6. Current Order Flow

```
customer → pickup|delivery → branch (pickup) / מישור אדומים (delivery) → menu → item options → cart
  → checkout (address for delivery, name, phone, payment label)
  → POST /api/orders (server validates + prices → create_order RPC: orders + order_items + deliveries atomically)
  → customer tracking screen (polls GET /api/orders/[id]/status)
  → kitchen (logged in) polls GET /api/kitchen/orders every 20s
  → PATCH /api/kitchen/orders/[id]/status: received → confirmed → preparing → ready (server sends push) → delivered
    (cancel from confirmed/preparing)
```

- **Prices are authoritative on the server** (`lib/pricing.ts`); the browser only displays the same calculation.
  `order_items.unit_price` = base + paid add-ons + deal extras. Delivery charges live in `deliveries`.
- `daily_number` is assigned inside the `create_order` DB function (advisory lock per Israel day).
- **Cash / credit / Cibus / Bit do not represent real payment processing.** Payment method never affects price.
- DB steps for delivery are **applied** (deliveries migration + RLS lock-down + `create_order`). If `create_order` were
  ever missing, `/api/orders` returns 503 (no partial orders, no fallback writes).
- ⚠️ **Deploy coupling:** the kitchen security work (auth + `/api/kitchen/*` + protected push + migrated kitchen UI)
  must ship **together** and only with `KITCHEN_SESSION_SECRET` + `KITCHEN_USERS` (and the public Supabase vars) set.

---

## 7. Known Security Debt

These issues are **known and documented**. Never paste actual keys, JWTs, passwords, tokens, or secret values into code, docs, commits, or chat.

**Fixed in the current code (06B–06E):** no service_role in browser code; no hardcoded Supabase keys (customer uses
public `NEXT_PUBLIC_*` env); kitchen login is server-verified (no passwords in code, no localStorage auth); legacy
`/dashboard` retired; push send requires a kitchen session.

**Still open:**
- **The old service_role + anon JWTs and old kitchen passwords are in public git history** (and in the currently
  deployed production build until this work ships). **RLS does not protect against the leaked service_role key** —
  addresses stay readable with it until **key rotation**.
- **Anon can still read `orders` / `order_items` / `push_subscriptions` and insert orders directly** (SEC-2 → RLS).
  The customer app no longer depends on those anon reads/inserts.
- Kitchen accounts are shared per branch (no per-person audit); login protection is a delay only (no attempt limit).
- The GitHub repository is public.

**Planned key rotation (separately approved, after the secure release is live in ALL deployments):** create new
Supabase keys (publishable + secret) → set server secret + public key in Vercel (both projects) → redeploy → verify →
disable legacy JWT keys → confirm old keys return 401.

**Hard rule: never introduce any client-side privileged credential**, never hardcode any key or password, never
put a server secret in a `NEXT_PUBLIC_*` variable. Privileged access belongs in server-only code (`lib/supabaseServer.ts`).

Environment variable names (names only):
public: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_VAPID_PUBLIC_KEY` ·
server-only: `SUPABASE_SERVICE_ROLE_KEY` (or `SUPABASE_SERVICE_KEY`), `KITCHEN_SESSION_SECRET`, `KITCHEN_USERS`,
`VAPID_PRIVATE_KEY`, `VAPID_EMAIL` / `VAPID_SUBJECT`. Never print the values of `.env*` files or env settings.

---

## 8. Target Security Direction (roadmap context only)

Done: server-only privileged client · public-env browser client · server-side pricing · secure tracking endpoint ·
server-verified kitchen session with role/branch scope · secure kitchen APIs · authenticated push send.

Remaining:
- Key rotation (see §7).
- SEC-2: RLS so anon can no longer read/insert `orders` / `order_items` / `push_subscriptions`.
- Optional later: Supabase Auth per-person staff accounts; login attempt limiting.

Implement these only when a task explicitly asks for them.

---

## 9. SN Agent Working Model

Agents MAY perform automatically, in meaningful safe local batches:

- inspect files, search code, analyse architecture
- implement and refactor local application code
- create tests
- run `npm run lint`, `npx tsc --noEmit`, `npm run build`
- inspect local Git state and diffs (read-only Git commands)
- document findings

Prefer meaningful safe batches over stopping after every minor edit.
Keep filesystem searches targeted — never recursively scan `node_modules/`, `.next/`, or `.git/`.

---

## 10. Explicit Approval Checkpoints

**STOP and request explicit approval before:**

- SQL of any kind
- Supabase writes
- schema changes / migrations
- RLS changes
- production database operations
- environment variable changes
- Supabase project configuration changes (including key rotation)
- Vercel changes
- staging (preview) deployment / production deployment
- `git add`, `git commit`, `git push`, `git tag`
- destructive Git operations (reset, restore, clean, rebase, force push, branch deletion, history rewrite)
- deleting files / moving important files
- dependency installation or upgrade (`npm install`, `npm update`, `npm audit fix`)
- authentication production changes (creating/changing staff users, passwords)
- permissions changes
- payment-provider operations
- printer / physical hardware configuration

Approval for one action does not carry over to the next.

---

## 11. Git Rules

- `main` is production. Vercel deploys from it.
- **Never force push `main`.**
- **Never work in the outer stale repository.**
- Run `git status` before starting work.
- Protect pre-existing local changes; report unexpected changes instead of overwriting them.
- Never reset, restore, or discard user work without explicit permission.
- Feature work normally happens on a feature branch.
- Commit and push require explicit approval.
- Never commit `.env*` files or any secret.

---

## 12. Validation Rules

For local implementation, validate with (when appropriate):

```
npm run lint
npx tsc --noEmit
npm run build
```

If a check fails, classify each failure as:

- **PRE-EXISTING FAILURE** — present on the baseline before the current change, or
- **NEW FAILURE CAUSED BY CURRENT CHANGE**.

Fix new failures. Do not silently fix unrelated pre-existing debt unless necessary for the task; report it instead.

---

## 13. UX / Business Principle

This system runs a **real falafel business**. Keep operational interfaces extremely simple.

**Kitchen / staff UI**
- minimal clicks, large clear actions
- obvious statuses, low cognitive load
- tablet/mobile-friendly
- no unnecessary technical complexity

**Customer ordering**
- fast, visual, simple
- Hebrew-first (RTL), mobile-first

Do not add complexity merely for architectural elegance.

---

## 14. Change Discipline

Before implementing a task:

1. Understand the existing behavior.
2. Identify affected files.
3. State the intended change.
4. Preserve unrelated behavior.
5. Implement locally.
6. Validate locally (§12).
7. Summarize the diff.
8. Stop before commit / push / deploy unless approved.

Be particularly conservative with production-critical flows:
**ordering, kitchen queue, pricing, payment, printing, notifications, authentication.**
A broken order flow or kitchen board directly stops the business.

---

## 15. Project Roadmap Context

| Phase | Scope |
|---|---|
| A | SN re-onboarding and agent integration |
| B | Security architecture cleanup |
| C | Correctness and technical debt |
| D | Business / product changes requested by the owner |
| E | Real payment integration |
| F | Printing / kitchen hardware integration |

Phases are not strictly sequential. Do not assume every phase must be completed before working on requested product changes.
**Priorities are decided by the project owner.**
