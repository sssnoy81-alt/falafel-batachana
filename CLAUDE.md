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
  - branch selection (one branch is hidden from customers in code)
  - **menu** by category, per-branch prices, item images from Supabase Storage
  - item sheet: sauces, salads, paid add-ons, "no lettuce", notes, meal-deal (עסקית) drink/add-on choice
  - **cart** with edit/remove and upsell prompt
  - **checkout**: name, phone, payment-method choice, 5% app discount (not applied to Cibus)
  - **order tracking** screen with status, order number, order details; name/phone remembered for next order
  - business-hours gating (closed popup, order button disabled when closed)

**Operations**
- **Kitchen / staff order queue** (`/dashboard/orders`) — columns by status, one-tap status advance, new-order audio alarm, branch filter for admin.
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
| `/dashboard` | `app/dashboard/page.tsx` | **Legacy** order board. Old, unprotected, uses a privileged credential client-side. Considered unsafe; do not extend. |
| `/dashboard/orders` | `app/dashboard/orders/page.tsx` | **Main kitchen / staff application** (~780 lines). |
| `/api/push/subscribe` | `app/api/push/subscribe/route.ts` | Stores a customer push subscription (keyed by phone). |
| `/api/push/send` | `app/api/push/send/route.ts` | Sends the "order ready" push. Currently unauthenticated. |

Layouts: `app/layout.tsx` (root, RTL, PWA meta, "Powered by SN Capital AI" footer), `app/dashboard/layout.tsx` (kitchen manifest + Vercel Analytics).

Public PWA assets: `public/manifest.json` (customer app, start `/order`), `public/manifest-kitchen.json` (kitchen, start `/dashboard/orders`), `public/sw.js` (push handler only, no caching), `public/kitchen.html` (kitchen install page), `public/falafel-landing/*` (landing images + video).

`lib/supabase.js` exists but is **not used** by the current pages — each page creates its own Supabase client.

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
- Hardcoded business values exist in code: branch IDs, the hidden branch, business hours, meal-deal extra prices, discount rate.

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
| `orders` | branch_id, phone, customer_name, payment_method, status, total_price, daily_number, created_at. |
| `order_items` | order_id, item_id, quantity, unit_price, notes (selected options are serialized into notes text). |
| `push_subscriptions` | phone, order_id, subscription JSON. |

Storage: public bucket `menu-images` (logos, menu images, manifest icons).
Not used: RPCs, views, Realtime, Supabase Auth.

> ⚠️ **The exact production schema, constraints, triggers, and RLS policies have NOT been verified from the
> database.** Do not assume them. Any schema/RLS inspection or change requires explicit approval (§10).

---

## 6. Current Order Flow

```
customer → branch → menu → item options → cart → checkout (name, phone, payment label)
  → order creation (browser inserts orders + order_items directly via Supabase)
  → customer tracking screen (polls order status)
  → kitchen queue (polls today's orders)
  → received → confirmed → preparing → ready (push sent to customer) → delivered
  (cancel available from the kitchen board)
```

- **Prices are calculated in the browser** (item price + add-ons + deal extras − discount) and written as `total_price` / `unit_price`.
- `daily_number` = count of today's orders (all branches) + 1, computed in the browser.
- **Customer tracking polls Supabase** directly; session persists in `localStorage` for 6 hours and resets after `delivered`.
- **Kitchen polls** for today's orders; status changes are written directly from the browser.
- **Cash / credit / Cibus / Bit do not represent real payment processing.** All methods follow the identical flow.

---

## 7. Known Security Debt

These issues are **known and documented**. Never paste actual keys, JWTs, passwords, tokens, or secret values into code, docs, commits, or chat.

- A Supabase **service_role credential is referenced in client-side dashboard code** (`app/dashboard/page.tsx`, `app/dashboard/orders/page.tsx`). Service credentials must eventually move server-side.
- The Supabase URL and public anon key are hardcoded in `app/order/page.tsx` instead of read from env.
- **Legacy staff login is client-side only** (`app/dashboard/orders/page.tsx`); staff passwords are in browser code and must eventually be removed. Session is a `localStorage` entry.
- **`/dashboard` is legacy and unprotected.**
- **Push endpoints require stronger authentication** (anyone can call send/subscribe; subscriptions keyed by phone). Push routes fall back from the service key to the anon key if the env var is missing.
- **Customer prices are trusted from the browser.**
- **Current RLS state still needs verification.**
- The GitHub repository is public and historical commits contain credentials.

**Key rotation is intentionally DEFERRED for now by project decision.**
Do not repeatedly block or re-litigate unrelated development because the key has not yet been rotated.

**However — hard rule: never introduce any new client-side privileged credential**, never hardcode any key or password, and never widen the use of the existing exposed credential. New code reads Supabase config from environment variables; privileged access belongs in server-only code.

Environment variable names referenced by code (names only):
`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_EMAIL`, `VAPID_SUBJECT`.
Never print the values of `.env*` files.

---

## 8. Target Security Direction (roadmap context only)

- Server-only privileged Supabase client; browser client uses only public/publishable credentials from env.
- Supabase Auth for staff; role (admin / branch staff) + branch in a server-trusted location (not `user_metadata`).
- Role/branch-based access: branch staff see only their branch; admin sees all.
- Secure staff API routes for reading orders, status changes, and note edits; `/dashboard/*` protected via `proxy.ts`.
- Server-side pricing: client sends item IDs/options/quantities only; server loads canonical prices and writes the order.
- Secure order tracking (order-scoped token instead of broad anon reads).
- Authenticated / internal-only push sending; subscriptions tied to an order.
- RLS as the final database safety layer.

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
