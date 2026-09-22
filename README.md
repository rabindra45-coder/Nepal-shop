# Nepal Shopping Site v7 (self-hosted)

A full-stack marketplace web app for Nepal — a customer-facing online shop
built to rival Daraz, with the things Daraz lacks: native eSewa/Khalti
checkout, COD order confirmation against fake orders, buyer protection,
verified sellers and transparent seller fees.

Buyers get a modern storefront: search with typo tolerance, product pages
with verified-delivery reviews, wishlist with price-drop alerts, server-side
cart, addresses, coupons, express delivery choice, multi-seller checkout,
order tracking and an AI shopping assistant. Sellers get a dashboard with
inventory, orders, returns, refunds, earnings and analytics. Admins get
marketplace analytics, seller approval, coupon/category/homepage management,
refunds, payouts and support tickets.

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

Rebuilding the frontend (only needed after changing `client/src` — a fresh
build ships in the repo):

```bash
bun install                       # once, from the repo root
bun scripts/build-client-local.mjs  # rebuilds client/dist for selfhost.ts
```

This is the script the Render pipeline uses. `client/build.mjs` is the
SDK-guarded builder for the Hatch artifact pipeline — do not use it for
Render/self-hosted deploys (it refuses to run without
`HATCH_SPACES_BUILD_DRIVER=1`, which only the artifact tooling sets).

## Features

**Buyer:** sign-up/login (mobile + password), email verification, password
reset (via email), guest checkout, typo-tolerant search with filters and
sorting, product detail with reviews/related items/frequently-bought-together,
wishlist with price-drop and back-in-stock alerts, server-side cart, address
book, coupons (`WELCOME10`, `FREESHIP`), standard/express/pickup delivery,
COD with seller confirmation, eSewa/Khalti online payment (keys required —
see Payments), order tracking by code + phone, returns within 30 days,
verified-purchase reviews, support tickets, notifications, AI shopping
assistant.

**Multi-seller checkout:** one basket can hold products from several sellers.
Checkout creates **one order group** for the customer and **one fulfilment
order per seller**. Each seller sees and fulfils only their own order;
the customer tracks the group; the admin sees everything. Inventory is
reserved per fulfilment at placement and restored on cancellation.
Checkout is idempotent — double-clicking "Place order" creates one group.

**Seller:** email+password or legacy code+key sign-in, email verification,
seller approval lifecycle (`pending → under_review → active`; pending shops
can only keep drafts), inventory management with SKUs, variants
(size/colour) and specifications, up to 10 uploaded photos per product,
order pipeline (confirm → pack → ship → deliver), guarded status
transitions, returns and refunds, revenue analytics, low-stock alerts,
stock-movement history, earnings ledger (sale / commission / refund /
payout / adjustment), payout details + payout requests.

**Admin:** marketplace analytics (revenue, conversion, top products,
searches), seller approval/suspension with legal lifecycle transitions,
product visibility, coupon manager, category manager, homepage
banners/sections, order-group list, buyer-issue resolution, returns and
refunds, payouts, seller-balance adjustments, commission rules and money
settings (default commission %, payout hold days, minimum payout),
support tickets, buyer list, admin password change, audit logs.

**Platform:** `sitemap.xml`, `robots.txt`, PWA web manifest, SQLite with
WAL mode, 54 drizzle migrations, single-binary Bun server, structured
JSON logging, admin email alerts on critical failures, `/api/health`
with version, automated backup script (`scripts/backup.ts`).

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
| `GEMINI_API_KEY` | Powers the AI “Recommended for you” picks on product pages (see below). Optional — without it the shop uses honest rule-based picks. |
| `UPLOADS_DIR` | Where seller product photos are stored. Production: `/var/shop-data/uploads` on the persistent disk (default `./data/uploads`). |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | Transactional email (order, payment, shipment, account and admin alerts). See “Production email setup”. |
| `SMS_PROVIDER_KEY` | Reserved for a future SMS hook (unused today). |

## Production email setup

The shop sends transactional emails (order confirmations, payment results,
shipment milestones, cancellations, returns, refunds, payouts, seller
account and product moderation decisions, low-stock and admin alerts).
Credentials are read **only** from environment variables — never committed
to the repo.

| Variable | Purpose |
|----------|---------|
| `SMTP_HOST` | SMTP server hostname, e.g. `smtp.gmail.com`. |
| `SMTP_PORT` | SMTP port. `465` for implicit TLS, `587` for STARTTLS (default `587`). |
| `SMTP_USER` | SMTP login, usually the full email address. |
| `SMTP_PASS` | SMTP password or app password (see Gmail below). |
| `SMTP_FROM` | The `From:` address buyers and sellers see. |
| `ADMIN_EMAIL` | Receives admin alerts (new sellers, payouts, payment failures). |

### Gmail (Google Workspace or personal)

1. Turn on **2-Step Verification** on the Google account.
2. Create an **App password** (Google Account → Security → App passwords),
   e.g. for “Mail”. Use the 16-character app password as `SMTP_PASS` —
   never your real Google password.
3. Set `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=587` (STARTTLS),
   `SMTP_USER=you@gmail.com`, `SMTP_FROM=you@gmail.com`
   (or your shop address if the account is allowed to send as it).

### Behaviour when email is not configured

If `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS` are missing, every email helper
returns `{ sent: false }` and the server logs `[email] not configured`.
Checkout, payments, order updates and signups keep working — email failure
never breaks a buyer or seller flow, and nothing is ever reported as
delivered when it was not sent.

### Local testing

Set `EMAIL_TEST_CAPTURE=1` (never in production) to capture rendered emails
in memory instead of sending them. The test-only
`__testCapturedEmails` action then returns each email's recipient, subject
and body so the suite can assert on them. The automated check is
`bun scripts/verify-notifications.ts --port <PORT>` (85 checks: every
template, preferences opt-out, role/email privacy, unconfigured-SMTP
honesty, and SMTP-failure resilience).

Buyer order emails can be switched off per account in Account → Notifications
(“Order updates by email”); security emails (verification, password reset)
always stay on. Seller operational emails (new orders, payouts, account
decisions) are mandatory for fulfilment — seller preference controls are
deferred to a later checkpoint.

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

## AI product recommendations

Every product page shows a “Recommended for you” rail. When `GEMINI_API_KEY`
is set, the server asks Gemini to rank catalogue products for the viewed
item; **every id the model returns is validated against the catalogue** —
it can only pick real products, never invent them. When the key is missing
or the API call fails, the shop falls back to an honest rule-based ranking
(same category by rating, then best sellers), and the UI only shows the
“✨ AI picks” badge when the picks genuinely came from the AI. Picks are
cached per product for 30 minutes.

Get a key at https://aistudio.google.com/ (free tier available) and set it
as `GEMINI_API_KEY` on Render (Environment tab) alongside your other
variables. The key is read from the environment only — it is never stored
in the repo or the database.

## Advertisements (homepage hero)

The admin panel (Homepage tab) manages the homepage advertisement carousel:
each advertisement has a title, optional subtitle, link, sort order, an
active flag, and a required image. Images are uploaded through the admin UI
(`POST /api/banner-uploads`, admin session only; JPG/PNG/WebP/GIF, 5 MB) and
served from `/uploads/` like product photos, so **every advertisement is
shown with its image**. New advertisements cannot be saved without an
image; editing an imageless legacy banner also requires one. Deleting an
advertisement removes its image file too. The homepage shows active
advertisements as a swipeable image carousel with the title overlaid.

## Seller product photos

Sellers can upload up to 10 photos per product (JPG/PNG/WebP/GIF, 5 MB
each) from the studio product form. The first photo is the cover shown on
product cards, the homepage and search; the product page shows a gallery
with a thumbnail strip. Files are stored under `UPLOADS_DIR` — **on Render
this must be on the persistent disk** (e.g. `/var/shop-data/uploads`),
otherwise photos vanish on every redeploy or sleep/wake cycle.

## Production admin (secure first admin)

Do not go live with the dev seed admin. Instead:

1. Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` in the production environment.
2. Boot once — `selfhost.ts` creates that admin with a bcrypt-hashed
   password, but only if no admin with that email exists yet.
3. Remove the values from the environment and change or delete the dev
   seed admin (`admin@nepalshop.local`).

See `PRODUCTION.md` for the full go-live checklist.

## Deploy on Render

The project is set up for the easy-host path. The live site
(`https://nepal-shop-2.onrender.com/`) already runs this way.

### Service settings

1. Push this folder to the repo (e.g.
   `github.com/rabindra45-coder/Nepal-shop`).
2. In Render, create a **Web Service** from the repo:
   - Runtime: **Bun** (1.3.x)
   - Build command: `bun install`
   - Start command: `bun selfhost.ts`
   - Health check path: `/api/health` (returns 200 with `{ status, version,
     uptime_seconds, db }`; returns 503 if the database is unreachable)
3. Add a **persistent disk**: mount path `/var/shop-data`, size 1 GB
   minimum. Without this, the database and uploaded photos live on
   Render's ephemeral filesystem and are lost on every redeploy or
   sleep/wake cycle.
4. Set the environment variables below.
5. Deploy. On later deploys, push the latest commit and hit **Manual
   Deploy → Deploy latest commit** — the disk keeps sellers, products,
   orders and photos across restarts. Migrations in `drizzle/` apply
   automatically on boot.

### Environment variables (all of them)

| Variable | Required | Purpose |
|----------|----------|---------|
| `DB_PATH` | yes | `/var/shop-data/app.db` — the database file on the persistent disk. |
| `UPLOADS_DIR` | yes | `/var/shop-data/uploads` — product/store/banner photos on the persistent disk. |
| `PUBLIC_BASE_URL` | yes | `https://<your-service>.onrender.com` — payment callbacks, sitemap, robots.txt. |
| `ADMIN_EMAIL` | yes | Your admin email. Creates the first production admin (with `ADMIN_PASSWORD`) on first boot, and receives all admin alerts (new sellers, payment failures, sweeper failures, repeated server errors, boot failures). |
| `ADMIN_PASSWORD` | first boot only | Password for the first production admin. **Remove it from the environment after the first boot** — it has done its job once the admin row exists. |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | yes | Transactional email. Without these, no email goes out and flows report honestly (see "Production email setup"). |
| `GEMINI_API_KEY` | no | AI "Recommended for you" picks. Without it, honest rule-based picks are used. |
| `ESEWA_MERCHANT_ID` / `ESEWA_SECRET_KEY` / `ESEWA_MODE` | no | eSewa payments (`test`/`live`). Without keys, checkout honestly reports "not configured" and buyers use COD. |
| `KHALTI_SECRET_KEY` / `KHALTI_MODE` | no | Khalti payments (`test`/`live`). Same honest fallback as eSewa. |
| `PORT` | no | Default 3000; Render sets this itself. |

**Never set `EMAIL_TEST_CAPTURE=1` in production** — it captures emails in
memory instead of sending them. It is a test-only flag.

### Monitoring (built in, no external APM)

- **Health endpoint:** `GET /api/health` — no auth, fast, probes real DB
  reachability. Point Render's health check (or any uptime monitor) at it.
- **Structured logs:** server failures are written to stderr as single-line
  JSON (`{"ts":…, "level":"error", "scope":"actions", "msg":…}`). Render
  captures stderr in the service logs. Secrets are never logged — values
  that look like passwords/tokens are redacted, and request bodies are
  never logged at all.
- **Admin email alerts:** payment verification failures, failed payouts,
  the unpaid-order sweeper, repeated unexpected 5xx-class failures (5+ in
  10 minutes, throttled to one alert per 6 hours), and boot failures all
  alert `ADMIN_EMAIL`. When `ADMIN_EMAIL` is unset the server logs honestly
  that no alert was sent — it never pretends.
- **Safe failures:** unexpected server errors return a generic 500 ("Something
  went wrong. Please try again.") — stack traces and SQL never reach the
  client. Curated user-facing messages (e.g. "Please sign in again.") keep
  their 400 + message contract.

### Backups and restore

The production backup story is: **Render's persistent disk** (protects
against redeploys and restarts) **plus `scripts/backup.ts`** (protects
against disk loss, corruption and bad deploys). There are no automated
off-site backups — do not claim there are.

Run the backup on a schedule (a Render cron job, or any machine with Bun
and read access to the disk):

```bash
DB_PATH=/var/shop-data/app.db UPLOADS_DIR=/var/shop-data/uploads \
  BACKUP_DIR=/var/shop-data/backups KEEP_DAILY=7 \
  bun scripts/backup.ts
```

It snapshots the live database with `VACUUM INTO` (online-safe — never
plain `cp` on a live WAL-mode database) and tars the uploads directory
into timestamped files, keeping the last 7 of each. Exit code 0 on
success, 1 on failure (alert on non-zero exit).

**Restore procedure** (tested 2026-09-22 — a backup is not a backup until
restoration is tested):

1. Stop the web service (restoring under a running writer is unsafe).
2. Copy the chosen `backups/db/app-<timestamp>.sqlite` over `DB_PATH`.
   Delete any `app.db-wal` / `app.db-shm` sidecars from the old file —
   they belong to the old database and must not be reused. (Backups made
   by `VACUUM INTO` have no sidecars of their own.)
3. Extract the matching `backups/uploads/uploads-<timestamp>.tar.gz`
   over `UPLOADS_DIR`.
4. Start the service, open `/api/health` (expect `"db":"reachable"`),
   and confirm orders and products load in the admin panel.

### Demo-data cleanup before going live

The bundled database ships demo sellers (`*@demo.local`) whose credentials
are documented in this README. The server warns loudly on every boot while
any remain (`[security] Demo seller still present: …`). Before serving real
customers, either:

- **Start fresh** (recommended): boot with an empty `DB_PATH` on the
  persistent disk, let migrations create the schema, and set
  `ADMIN_EMAIL`/`ADMIN_PASSWORD` so the server creates only your real
  admin; or
- **Clean the seed**: in the admin panel (or SQL), suspend/delete the
  `@demo.local` sellers, delete their products, and change or delete the
  dev seed admin (`admin@nepalshop.local` / `Admin@123`).

`PRODUCTION.md` is the full go-live checklist — work through it before
taking real orders.

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

Notes (phase 2, historical):

- COD orders mark payment `paid` on delivery without a separate `payment`
  notification; `payment` notifications fire for verified online payments,
  failures and refunds.
- ~~One order = one seller by design; mixed-seller baskets are rejected
  with a clear message.~~ Superseded: since the order-group upgrade, one
  checkout creates one order group with one fulfilment per seller.

## What's inside

- `client/src` — React storefront, buyer accounts, seller dashboard, admin
  panel (TypeScript); `client/dist` — prebuilt bundle served by `selfhost.ts`
- `server/src/actions.ts` — all backend actions, validated with Zod
- `server/src/schema.ts` — database tables (Drizzle ORM)
- `server/src/assistant.ts` — the rule-engine shopping assistant
- `server/src/payments.ts` — eSewa/Khalti integration (never fakes success)
- `server/src/providers.ts` — email/SMS/push hooks (not wired up yet)
- `drizzle/` — SQL migrations (0001–0054: marketplace core, accounts/auth,
  order groups, idempotency, returns/refunds, seller ledger, payouts,
  commission rules, product images/variants/specs, banner images, integrity
  indexes and more)
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
- Mixed-seller baskets are supported: checkout creates one order group with
  one fulfilment per seller. Seller product photos are real uploads under
  `UPLOADS_DIR` (persistent disk in production). Email verification and
  password reset are built in — both need SMTP configured to deliver the
  emails (see "Production email setup"); without it the links are never
  sent and the UI says so honestly.
- `scripts/` holds the automated checks: `verify-v4.ts` (36 core-journey
  checks), `verify-orders15.ts`, `verify-commission.ts`,
  `verify-notifications.ts`, `verify-analytics.ts`, and `backup.ts`.

## v4 — production-readiness pass

- **New pages** (`client/src/legal.tsx`): `/about` (what Nepal Shop is,
  differentiators, 3 steps, shop/sell CTAs), `/contact` (placeholder contact
  details + support-ticket form wired to `api2.createTicket`, same pattern as
  the Help page), `/privacy` and `/terms` (complete drafts for a Nepal
  e-commerce marketplace — each starts with a prominent
  "Draft — get local legal review before serving real customers." banner).
  Contact details are bracketed placeholders (`[Your phone number]`, etc.) —
  fill them in before launch.
- **404**: unknown paths now render a friendly `NotFoundPage` ("This shelf is
  empty.") with Home / Search / Help buttons; `/` still loads the homepage.
  All footer links resolve to explicit routes.
- **Cookie consent**: `CookieBanner` mounted in the app shell; stores
  `accepted`/`declined` in `localStorage` (`nepalsite_cookie_consent`) and
  never reappears after a choice; links to `/privacy`.
- **Footer**: About, Contact, Privacy, Terms links added next to Help + Admin,
  plus a `© 2026 Nepal Shop` line.
- **Favicon/icons**: real brand icons in `client/icons/` (SVG + PNGs generated in
  this pass). The bundler copies them into `dist/assets` with hashed names and
  rewrites the `<link>` tags in `index.html`; `client/postbuild.mjs`
  additionally copies stable-name PNGs (`icon-192.png`, `icon-512.png`) to
  `dist/` root for the web manifest. `index.html` also gained Twitter card
  tags and a canonical URL.
- **`.gitignore`**: `node_modules/`, `.env*`, `*.db*`, build output, and
  `/tmp/` covered.
- **`CHECKLIST.md`**: the 13-section production-readiness checklist mapped to
  DONE / NEEDS-USER / GAP with one-line notes per item.
- **Admin-password reminder**: before first production boot, set
  `ADMIN_EMAIL` / `ADMIN_PASSWORD` so the server creates the real admin, then
  remove the values from the environment — and change or delete the public
  dev admin (`admin@nepalshop.local` / `Admin@123`).

### v4 verification report (2026-09-22, fresh empty-DB boot + local HTTP)

35/35 automated checks passed against a temporary database
(`/tmp/v4test/fresh.db`, seeded from the bundled `data/app.db` via the
Render first-boot path — migrations 0001–0006 applied with zero errors):

- **Storefront seed**: 12 products / 3 sellers on fresh boot.
- **Buyer journey**: signup → getMe → addToCart → quantity update →
  saveAddress (Bagmati/Kathmandu) → WELCOME10 validation → COD checkout
  with `cod_confirmed` → coupon discount applied to the total.
- **Inventory**: stock decremented by exactly the ordered quantity.
- **Seller**: email login → sees the test order → status walk
  `confirmation_needed → confirmed → packed → shipped → out_for_delivery →
  delivered` → tracking endpoint reflects `delivered`.
- **Reviews**: verified review on the delivered order appears in
  `getProductReviews`.
- **Payments**: `initiateOnlinePayment` for eSewa and Khalti returns an
  honest "not configured" error when no merchant keys are set — never a fake
  success. Cross-provider initiation on a placed order is refused.
- **SEO/PWA routes** (all HTTP 200): `/sitemap.xml`, `/robots.txt`,
  `/manifest.webmanifest` (2 icons), `/icon-192.png`, `/icon-512.png`,
  `/favicon.svg`, `/apple-touch-icon.png`.
- **New pages in the built bundle**: 404 ("This shelf is empty"), legal
  review banner, cookie-consent key, skip link, JSON-LD product schema.
- **Rate limiting**: 25 rapid bad logins → HTTP 429s after 20 attempts per
  IP/action window ("Too many attempts…").
- **TypeScript**: `tsc --noEmit` clean for both `client` and `server`.
- **Bundle**: `index-az3f6eq6.js` 660 KiB / `index-edjz132e.css` 40 KiB
  (recharts removed; net flat after adding the new pages); hero PNG
  optimised from ~3.4 MB to ~2.0 MB (1920→1400px); no secrets in the bundle.
- **SEO extras in v4**: route-specific `document.title` (product pages use
  the product name), JSON-LD `Product` schema with NPR price, stock
  availability and aggregate ratings.
- **Accessibility extras in v4**: skip-to-content link, global
  `:focus-visible` outlines, meaningful image alts, lazy-loaded images.

Not done by automation (needs a human/browser): Lighthouse/Core Web Vitals,
real-device and multi-browser passes, screen-reader testing, slow-network
testing — all flagged NEEDS-USER in `CHECKLIST.md`.

## v5 / v6 — marketplace upgrades (2026-09-22)

- **v5 — seller photos + AI recommendations:** sellers upload up to 10
  photos per product (JPG/PNG/WebP/GIF, 5 MB each) from the studio product
  form; first photo is the public cover on cards/homepage/search, and the
  product page shows a gallery with thumbnail strip (`product_images`
  table, migration `0007`). Every product page also shows "Recommended for
  you": Gemini ranks real catalogue products when `GEMINI_API_KEY` is set
  (validated ids only — nothing invented, 30-minute cache, honest
  rule-based fallback, "✨ AI picks" badge only for genuine AI picks).
  Verified: typechecks, client rebuilt, fresh-DB boot, upload/serve/
  10-cap/delete/ownership/file-type tests over HTTP, AI path with the real
  key (source:"ai"), 36/36 verify suite.
- **v6 — admin-managed image advertisements:** `homepage_banners` gained
  `image_url` (migration `0008` — note this repo's drizzle migrator
  executes every `-->`-separated chunk including empty ones, so
  single-statement migrations must NOT start or end with the breakpoint
  marker). Admin uploads banner images from the panel's Homepage tab via
  `POST /api/banner-uploads` (admin session token in `x-auth-token` header
  only; JPG/PNG/WebP/GIF, 5 MB; stored as `banner-<uuid>.<ext>` under
  `UPLOADS_DIR`, served at `/uploads/`). Image required for new ads AND
  for editing imageless legacy ads — every ad is shown with its image;
  delete removes the file too. Homepage renders active ads as a swipeable
  image hero carousel with title overlay (mobile-first snap scroll).
  Verified: migration applies on fresh boot, unauthenticated upload
  rejected, imageless create rejected, upload/serve/homepage/delete-file
  over HTTP all pass, 36/36 verify suite, typechecks clean, client rebuilt.

## v7 — final production pass (2026-09-22)

All 54 migrations, 148 RPC actions, and the full marketplace loop hardened
and verified end to end over real HTTP on fresh boots:

- **Multi-seller marketplace core:** one customer checkout → one order
  group + one fulfilment per seller; guarded order-status transitions;
  inventory reserved at placement and restored on cancellation; checkout
  idempotency (double-click "Place order" creates one group); commission
  accrues when payment is confirmed (COD: on delivery; eSewa/Khalti: on
  verified payment) into a per-seller ledger (sale / commission / refund /
  payout / adjustment) that always reconciles with balances; seller
  earnings, payout details/requests and admin payout lifecycle
  (`requested → processing → completed`); seller-balance adjustments;
  commission rules + money settings (default commission 5%, payout hold
  7 days, minimum payout Rs 500).
- **Seller lifecycle:** `pending → under_review → active` with legal
  transitions enforced; email verification required before activation;
  pending shops can only keep drafts (nothing public).
- **Failure behaviour:** unconfigured eSewa/Khalti refuse honestly ("not
  configured yet"); bogus/duplicate payment verifications fail safely with
  no state change; cancelled payments refuse re-initiation; out-of-stock
  checkout rejected with no group created and no oversell; expired coupons
  rejected at validation and at checkout; expired sessions rejected;
  customer cancellation restores stock and leaves no orphan ledger
  entries; return on undelivered orders rejected; full return → refund
  flow posts to the seller ledger; below-minimum and over-balance payout
  requests rejected.
- **Final E2E (this checkpoint):** Seller A (Product A, Rs 1,000, stock
  10) + Seller B (Product B, Rs 2,000, stock 10) → customer adds both to
  cart → COD checkout → ONE group with TWO fulfilments, correct
  ownership, stock 9 each, 5% commission (Rs 50 / Rs 100), seller earnings
  Rs 950.00 net, per-role visibility verified (customer sees group, each
  seller only own fulfilment, admin sees all), ledger reconciles —
  **72/72 checks passed**. Failure sweep: **all failures safe and
  understandable**. Regression `scripts/verify-v4.ts`: **36/36**.
  Payout flow: **10/10**. Backup script: exit 0 with both artifacts.
  Typechecks: clean (client + server).

**Honest limitations (need Rabindra, not code):**

- eSewa/Khalti merchant keys — online payments report "not configured"
  until real keys are set (`ESEWA_MERCHANT_ID`/`ESEWA_SECRET_KEY`,
  `KHALTI_SECRET_KEY`). Nothing is faked.
- SMTP credentials — without them no email is sent (verification, order,
  password-reset, admin alerts); flows keep working and say so honestly.
- Render persistent disk + env vars (`DB_PATH`, `UPLOADS_DIR`,
  `ADMIN_EMAIL`/`ADMIN_PASSWORD`, `PUBLIC_BASE_URL`) — see "Deploy on
  Render" and `PRODUCTION.md`.
- Privacy/Terms drafts need a local lawyer's review before real customers.
- Demo sellers/products/coupons must be removed or replaced before launch
  (the server warns on every boot while they remain).
- Lighthouse/Core Web Vitals, real-device and screen-reader passes —
  manual, not run.
