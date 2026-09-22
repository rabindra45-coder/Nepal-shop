# Production go-live checklist — Nepal Shop (v7)

Work through every item before taking real orders. The stack is Bun +
SQLite (WAL mode) + Drizzle, served by `selfhost.ts`. The full deploy
reference (service settings, every env var, backups, monitoring) lives in
`README.md` — "Deploy on Render". This file is the checklist you tick off.

## 1. Environment

- [ ] `DB_PATH` points at the persistent disk (`/var/shop-data/app.db` on
      Render). Never use the default `./data/app.db` in production — the
      filesystem is ephemeral and orders would be lost on redeploy.
- [ ] `UPLOADS_DIR` points at the persistent disk
      (`/var/shop-data/uploads` on Render). Without this, seller product
      photos are lost on every redeploy or sleep/wake cycle.
- [ ] `PUBLIC_BASE_URL` set to the real public URL, e.g.
      `https://nepal-shop-2.onrender.com`. Payment callbacks, the sitemap
      and `robots.txt` all use it.
- [ ] `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM`
      set, so order/payment/shipment emails and admin alerts actually send.
      Without them the shop keeps working but every email honestly reports
      "not configured" in the logs.
- [ ] `GEMINI_API_KEY` set for AI product recommendations (optional — the
      shop falls back to rule-based picks without it).
- [ ] `EMAIL_TEST_CAPTURE` is **not** set. It captures emails in memory
      instead of sending them; it must never be set in production.
- [ ] Health check path `/api/health` is registered in Render (returns 200
      with `{ status, version, uptime_seconds, db }`; 503 if the DB is
      unreachable).

## 2. Admin accounts

- [ ] Set `ADMIN_EMAIL` / `ADMIN_PASSWORD` before the first production boot
      so the server creates the real admin (bcrypt-hashed). Then **remove
      the password from the environment** — it has done its job once the
      admin row exists.
- [ ] Confirm the dev seed admin (`admin@nepalshop.local` / `Admin@123`) can
      no longer sign in: change its password in the admin panel, or delete
      the row from the `admins` table.
- [ ] The dev admin credentials are public demo values. Treat any database
      that ever held them as compromised until the password is changed.

## 3. Demo data

The bundled database ships 3 demo sellers (`*@demo.local`) and 12 demo
products whose credentials are documented in the README. The server warns
loudly on every boot while any remain (`[security] Demo seller still
present: …`) — going live with them must be a conscious choice.

- [ ] Decide: **start fresh** (recommended — boot with an empty `DB_PATH`,
      let migrations create the schema, provision the real admin via
      `ADMIN_EMAIL`/`ADMIN_PASSWORD`) or **clean the seed**: suspend/delete
      the `@demo.local` sellers in the admin panel (or SQL), delete their
      products, and delete/deactivate the demo coupons `WELCOME10` and
      `FREESHIP` (or change their codes, limits and expiry).
- [ ] Demo seller keys (`demo-seller-01` etc.) are public. Any real seller
      must register with their own email and a strong password.
- [ ] Confirm the boot log has no `[security] Demo seller still present`
      warnings.

## 4. Payments

- [ ] Without `ESEWA_MERCHANT_ID`/`ESEWA_SECRET_KEY`, eSewa checkout
      honestly reports "not configured" and buyers fall back to COD. Same
      for Khalti without `KHALTI_SECRET_KEY`. This is the safe default —
      do not fake it.
- [ ] To go live with eSewa: sign up as a merchant at
      https://merchant.esewa.com.np/, complete onboarding, and set
      `ESEWA_MERCHANT_ID`, `ESEWA_SECRET_KEY`, `ESEWA_MODE=live`.
- [ ] To go live with Khalti: register as a merchant at https://khalti.com/,
      take the secret key from the merchant dashboard, and set
      `KHALTI_SECRET_KEY`, `KHALTI_MODE=live`.
- [ ] Test one real payment of a small amount in each provider's sandbox
      first (`ESEWA_MODE=test` / `KHALTI_MODE=test`).
- [ ] The provider callback flow is: provider →
      `{PUBLIC_BASE_URL}/#/payment-result?provider=esewa|khalti&order_id=…`,
      which calls `verifyEsewaPayment` / `verifyKhaltiPayment`. These verify
      the signature AND do a server-side status check before marking
      anything paid. Never mark an order paid from the redirect alone.
- [ ] Payment verification failures alert `ADMIN_EMAIL` automatically —
      make sure that address is monitored.

## 5. Backups

- [ ] The persistent disk protects against redeploys and restarts. It does
      **not** protect against disk loss, corruption, or a bad deploy — so
      schedule `scripts/backup.ts` (Render cron job or any machine with Bun
      and disk access):
      `DB_PATH=/var/shop-data/app.db UPLOADS_DIR=/var/shop-data/uploads BACKUP_DIR=/var/shop-data/backups KEEP_DAILY=7 bun scripts/backup.ts`
- [ ] It snapshots the live DB with `VACUUM INTO` (online-safe; never
      plain `cp` on a live WAL database) and tars the uploads directory,
      keeping the last 7 of each. Exit code 1 on failure — alert on that.
- [ ] There are **no automated off-site backups**. Do not claim there are.
      If you need off-site copies, sync `BACKUP_DIR` somewhere yourself.
- [ ] Restore was tested 2026-09-22 (backup → wipe → restore → boot →
      data intact). The procedure is in `README.md` ("Backups and
      restore"). Re-test it yourself once against a scratch path before
      you need it for real.

## 6. Monitoring

- [ ] `/api/health` is fast, needs no auth, and probes real DB
      reachability — it is suitable for Render health checks and any uptime
      monitor.
- [ ] Server failures are logged to stderr as single-line JSON
      (`level`/`scope`/`msg`); Render captures stderr in the service logs.
      Secrets are never logged.
- [ ] Admin email alerts cover: payment verification failures, failed
      payouts, unpaid-order sweeper exceptions, repeated unexpected 5xx
      failures (5+ in 10 min, throttled), and boot failures. Verify
      `ADMIN_EMAIL` receives mail (send a test via the password-reset flow
      on a throwaway account, or trigger a test alert).
- [ ] Unexpected errors return a safe generic 500; user-facing messages
      keep their 400 contract. No stack traces or SQL reach the client.
- [ ] Support tickets, buyer issues and reviews are visible in the admin
      panel — assign someone to watch them.

## 7. Security and operations

- [ ] Serve over HTTPS (Render gives you this). The app itself does not
      terminate TLS.
- [ ] Keep Bun and dependencies up to date; re-run `bun install` and the
      typechecks after upgrades.
- [ ] `/actions` has built-in per-IP rate limiting on auth, checkout,
      payment and spam-sensitive endpoints. If you expect hostile traffic,
      still consider edge rate limiting.
- [ ] Re-run the full test suite (`TESTING.md`, plus
      `bun scripts/verify-v4.ts --port <PORT>` against a fresh boot) after
      every deploy.

## 8. Deploy checklist (v7, no questions asked)

1. `bun install` — dependencies (the SDK is vendored in `./vendor`).
2. If `client/src` changed: `bun scripts/build-client-local.mjs`
   (the Render/self-host builder — NOT `client/build.mjs`, which is the
   SDK-guarded Hatch artifact builder).
3. `bun run typecheck` — server + client must be green.
4. `bun scripts/verify-v4.ts --port <PORT>` against a fresh-boot server —
   expect 36/36.
5. Replace the repo contents with this folder, commit, push.
6. Render → **Manual Deploy → Deploy latest commit** (existing service
   settings: runtime Bun, build `bun install`, start `bun selfhost.ts`,
   disk at `/var/shop-data`, health check `/api/health`).
7. Watch the deploy logs: migrations apply, no `[security] Demo seller`
   warnings, `/api/health` returns `"status":"ok"`.

## 9. Known limits (do not work around, plan for them)

- No true product variants (size/colour) — schema reserves a future
  `product_variants` table.
- No live chat; support is ticket-based.
- One order = one seller. The checkout rejects mixed-seller baskets with a
  clear message.
- Backups are on-disk snapshots, not off-site — see section 5.
- No external APM; monitoring is the health endpoint + structured logs +
  admin email alerts (an honest, dependency-free scope).
- Privacy Policy and Terms drafts (in the app) still need a local
  lawyer's review before real customers.
