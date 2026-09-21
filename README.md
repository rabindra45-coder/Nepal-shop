# Nepal Shopping Site v3 (self-hosted)

A full-stack marketplace web app for Nepal — a customer-facing online shop
built to rival Daraz, with the things Daraz lacks: native eSewa/Khalti
checkout architecture, COD order confirmation against fake orders, buyer
protection, verified sellers and transparent seller fees.

Buyers get a modern storefront: search with typo tolerance, product pages
with verified-delivery reviews, wishlist with price-drop alerts, server-side
cart, addresses, coupons, express delivery choice, order tracking and an AI
shopping assistant. Sellers get a dashboard with inventory, orders, returns,
refunds and analytics. Admins get marketplace analytics, seller approval,
coupon/category/homepage management and support tickets.

## Run it

Requirements: [Bun](https://bun.sh) 1.3 or newer.

```bash
bun install     # installs dependencies (the SDK is vendored in ./vendor)
bun start       # serves the site at http://localhost:3000
```

Open **http://localhost:3000** in your browser.

- `PORT=8080 bun start` — run on a different port
- `DB_PATH=/var/shop-data/app.db bun start` — use a persistent database file
- `cp .env.example .env` — see the env guide below

On first boot the server copies the bundled demo database to `DB_PATH`
(when the file does not exist yet), applies any pending migrations in
`drizzle/`, and — only if `ADMIN_EMAIL`/`ADMIN_PASSWORD` are set — creates
your production admin. Upgrades never lose existing sellers, products or
orders.

Rebuilding the frontend (rarely needed — a fresh build is included):

```bash
HATCH_SPACES_BUILD_DRIVER=1 bun ./client/build.mjs   # from the repo root
bun ./client/postbuild.mjs                            # re-links /manifest.webmanifest
```

## Features

**Buyer:** sign-up/login (mobile + password), guest checkout, typo-tolerant
search with filters and sorting, product detail with reviews/related items/
frequently-bought-together, wishlist with price-drop and back-in-stock
alerts, server-side cart, address book, coupons (`WELCOME10`, `FREESHIP`),
standard/express/pickup delivery, COD with seller confirmation,
eSewa/Khalti online payment architecture (keys required — see Payments),
order tracking by code + phone, returns within 30 days, verified-purchase
reviews, support tickets, notifications, AI shopping assistant.

**Seller:** email+password or legacy code+key sign-in, inventory management,
order pipeline (confirm → pack → ship → deliver), returns and refunds,
revenue analytics, low-stock alerts.

**Admin:** marketplace analytics (revenue, conversion, top products,
searches), seller approval/suspension, product visibility, coupon manager,
category manager, homepage banners/sections, order list, buyer-issue
resolution, support tickets, buyer list, admin password change.

**Platform:** `sitemap.xml`, `robots.txt`, PWA web manifest, SQLite with
WAL mode, drizzle migrations, single-binary Bun server.

## Demo credentials

> **Dev-only.** The values below are public demo values baked into the demo
> database. Change them before any real use (see Production admin below and
> `PRODUCTION.md`).

| Role | Login | Value |
|------|-------|-------|
| Admin (dev seed) | Email | `admin@nepalshop.local` |
| Admin (dev seed) | Password | `Admin@123` |
| Himalaya Fashion | Email (password = key) | `himalaya.fashion@demo.local` |
| Himalaya Fashion | Seller code / key | `SELL-BDC364DC` / `demo-seller-01` |
| TechSewa Electronics | Email (password = key) | `techsewa@demo.local` |
| TechSewa Electronics | Seller code / key | `SELL-06A3B75B` / `demo-seller-02` |
| Nepali Hastakala | Email (password = key) | `hastakala@demo.local` |
| Nepali Hastakala | Seller code / key | `SELL-05DC3C59` / `demo-seller-03` |

Demo coupons (marked demo — review before production):

| Code | Deal | Minimum order | Uses |
|------|------|---------------|------|
| `WELCOME10` | 10% off | Rs 1,000 | 500 total, 1 per buyer |
| `FREESHIP` | Free delivery | Rs 1,500 | 200 total, 1 per buyer |

## Try it: test flows

### Buyer flow

1. Open the site, click **Sign up**, create an account with a mobile number
   and password.
2. Search for "earbuds", open **Wireless Earbuds**, add it to the wishlist
   and the basket.
3. In **Checkout**, save an address, apply coupon `WELCOME10`, choose
   express delivery and Cash on Delivery.
4. Place the order — it stays "Needs confirmation" until the seller
   confirms it.
5. Open **My orders** to follow it, and **Track order** with the order code
   + phone number (works signed out too).

### Seller flow

1. Sign in at **Seller** with `techsewa@demo.local` / `demo-seller-02`
   (or the seller code + key).
2. Open the dashboard: confirm the buyer's order, then move it through
   Packed → Shipped → Out for delivery → Delivered.
3. Try **Returns**, **Analytics** and **Inventory** (lower a price or
   restock to zero to see wishlist alerts fire).

### Admin flow

1. Open the **Admin** link in the footer, sign in with the dev admin above.
2. Check **Analytics**, approve or suspend a seller, toggle a product,
   create a coupon in **Coupons**, edit homepage banners.
3. Resolve a buyer issue and answer a support ticket.

## Environment guide

Copy `.env.example` to `.env`. All values are read server-side only.

| Variable | Purpose |
|----------|---------|
| `PORT` | Server port (default 3000). |
| `DB_PATH` | SQLite file. Production: `/var/shop-data/app.db` on the persistent disk. |
| `PUBLIC_BASE_URL` | Public URL, used for payment callbacks, sitemap and robots.txt. |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Create the real production admin on first boot (see below). |
| `ESEWA_MERCHANT_ID` / `ESEWA_SECRET_KEY` / `ESEWA_MODE` | eSewa payments (`test`/`live`). |
| `KHALTI_SECRET_KEY` / `KHALTI_MODE` | Khalti payments (`test`/`live`). |
| `AI_API_KEY` | Reserved for a future LLM upgrade of the assistant (unused today). |
| `SMTP_HOST` / `SMTP_USER` / `SMTP_PASS` / `SMS_PROVIDER_KEY` | Notification provider hooks (not wired up yet). |

## Payments: eSewa and Khalti

The checkout supports three payment methods: `cod` (Cash on Delivery),
`esewa` and `khalti`. The online methods are fully architected but need
your merchant credentials — without them the server answers honestly
("payments are not configured yet") and buyers use COD. Success is never
faked.

**Where to get the keys:**

- **eSewa:** sign up as a merchant at https://merchant.esewa.com.np/ and
  complete onboarding — eSewa issues your merchant code (`product_code`)
  and secret key. Sandbox credentials are published in the eSewa developer
  docs (https://developer.esewa.com.np/) for testing with `ESEWA_MODE=test`.
- **Khalti:** register as a merchant at https://khalti.com/ — the secret key
  is issued in the Khalti merchant dashboard. Use `KHALTI_MODE=test` for
  the sandbox.

**How the callback flow maps to code:**

1. Buyer chooses eSewa/Khalti → `initiateOnlinePayment` builds the signed
   eSewa form (HMAC-SHA256) or starts a Khalti e-payment server-side.
2. The provider redirects the buyer to
   `{PUBLIC_BASE_URL}/#/payment-result?provider=esewa|khalti&order_id=…`.
3. That page calls `verifyEsewaPayment` / `verifyKhaltiPayment`, which
   verify the signature and do a **server-side status check** with the
   provider before marking the payment `paid` and the order `confirmed`.

Set `PUBLIC_BASE_URL` to your real public URL or the provider cannot
redirect back to you.

## AI shopping assistant

The assistant (`askAssistant`) runs on a built-in rule engine: it parses
prices ("under Rs 30,000"), categories, brands and comparison requests, and
only ever returns products that exist in your catalogue — it never invents
products, and says honestly when nothing matches. It works with no API key.

`AI_API_KEY` is reserved for a future upgrade where an LLM drafts richer
answers on top of the same catalogue-grounded results. The code comments in
`server/src/assistant.ts` mark the upgrade path.

## Production admin (secure first admin)

Do not go live with the dev seed admin. Instead:

1. Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` in the production environment.
2. Boot once — `selfhost.ts` creates that admin with a bcrypt-hashed
   password, but only if no admin with that email exists yet.
3. Remove the values from the environment and change or delete the dev
   seed admin (`admin@nepalshop.local`).

See `PRODUCTION.md` for the full go-live checklist.

## Deploy on Render

The project is set up for the easy-host path:

1. Push this folder to the repo (e.g.
   `github.com/rabindra45-coder/Nepal-shop`).
2. In Render, create a **Web Service** from the repo:
   - Runtime: **Bun** (or Node with Bun installed)
   - Build command: `bun install` (all lowercase)
   - Start command: `bun selfhost.ts`
3. Add a **persistent disk**: mount path `/var/shop-data`, size 1 GB.
4. Set environment variables: `DB_PATH=/var/shop-data/app.db`,
   `PUBLIC_BASE_URL=https://<your-service>.onrender.com`,
   plus `ADMIN_EMAIL`/`ADMIN_PASSWORD` for the first boot only.
5. Deploy. On later deploys, push the latest commit and hit **Redeploy** —
   the disk keeps sellers, products and orders across restarts.

## Test report (phase 2, 2026-09-21)

Automated HTTP acceptance tests against live `selfhost.ts` servers
(`POST /actions`), each section on a fresh copy of the demo database in
`/tmp`. Script: `/tmp/shopbuild/v3/v3test/run.ts`. Typechecks clean:
`server` (`bun x tsc --noEmit`) and `client` both pass.

**77 passed, 0 failed.**

| Section | What was tested | Pass |
|---------|-----------------|------|
| (a) | Full journey: homepage → search → product detail → signup → wishlist → server cart → address → WELCOME10 → order (coupon + express delivery, total 896430 paisa) → stock decremented → buyer/admin/seller see it → confirmed→packed→shipped→out_for_delivery→delivered → track → verified review → notifications | 22 |
| (b) | Empty-file boot: migrations 0001–0006 apply cleanly; signup → seller register → pending → admin activates → product → order → tracking; then no-file boot: seed copy gives 12 products / 3 sellers | 13 |
| (c) | Seeded DB: 12 products / 3 sellers; all three demo sellers log in via email+password AND legacy code+key; admin login | 8 |
| (d) | Coupon edges via `validateCoupon` AND `placeOrder`: expired, below-minimum, over max_uses, per-user repeat — all rejected by validation and all throw server-side on order | 8 |
| (e) | Oversell: stock set to 1 → addToCart qty 2 rejected, placeOrder qty 2 rejected, first qty-1 order wins, second fails, stock ends at exactly 0 | 5 |
| (f) | `initiateOnlinePayment` with no keys → honest "not configured" errors for eSewa and Khalti, never a success payload | 2 |
| (g) | `askAssistant`: phone under Rs 30,000 → real products; compare two real products → comparison with Price row; gibberish → honest "could not find"; no invented product names | 4 |
| (h) | v1/v2 regression: guest COD order, track code+phone (wrong phone → null), legacy seller auth, pending seller hidden until approved, suspend → products vanish → reactivate → return, reportIssue → adminResolveIssue, logout invalidates | 11 |
| (seo) | `/sitemap.xml` (12 product URLs, drops to 8 when a seller is suspended), `/robots.txt`, `/manifest.webmanifest` | 4 |

Notes:

- COD orders mark payment `paid` on delivery without a separate `payment`
  notification; `payment` notifications fire for verified online payments,
  failures and refunds.
- One order = one seller by design; mixed-seller baskets are rejected with
  a clear message.

## What's inside

- `client/src` — React storefront, buyer accounts, seller dashboard, admin
  panel (TypeScript); `client/dist` — prebuilt bundle served by `selfhost.ts`
- `server/src/actions.ts` — all backend actions, validated with Zod
- `server/src/schema.ts` — database tables (Drizzle ORM)
- `server/src/assistant.ts` — the rule-engine shopping assistant
- `server/src/payments.ts` — eSewa/Khalti integration (never fakes success)
- `server/src/providers.ts` — email/SMS/push hooks (not wired up yet)
- `drizzle/` — SQL migrations (0001–0006)
- `data/app.db` — SQLite database with the demo data
- `selfhost.ts` — the Bun server: static storefront + `POST /actions` RPC +
  sitemap/robots/manifest + first-admin boot
- `manifest.webmanifest` — PWA manifest source (the build resolves it)
- `vendor/space-sdk.tgz` — the action/RPC contract library (offline copy)
- `TESTING.md` — repeatable test checklist · `PRODUCTION.md` — go-live checklist

## Notes

- Demo passwords and keys are public values. Before any real use, create
  the production admin, change the dev admin password, register fresh
  sellers and pick strong passwords.
- To start from an empty shop instead of the demo data, point `DB_PATH` at
  a new file (or delete `data/app.db`) — migrations build the full schema.
- One order = one seller; product images are URLs (no uploads yet); no
  email verification or password reset yet — see `PRODUCTION.md`.
