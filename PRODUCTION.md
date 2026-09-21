# Production readiness checklist — Nepal Shop

Work through every item before taking real orders. The stack is Bun +
SQLite (WAL mode) + Drizzle, served by `selfhost.ts`.

## 1. Environment

- [ ] `PORT` set (default 3000 is fine behind Render's routing).
- [ ] `DB_PATH` points at the persistent disk (`/var/shop-data/app.db` on
      Render). Never use the default `./data/app.db` in production — the
      filesystem is ephemeral and orders would be lost on redeploy.
- [ ] `PUBLIC_BASE_URL` set to the real public URL, e.g.
      `https://nepal-shop.onrender.com`. Payment callbacks, the sitemap and
      `robots.txt` all use it.

## 2. Admin accounts

- [ ] Set `ADMIN_EMAIL` / `ADMIN_PASSWORD` before the first production boot so
      the server creates the real admin (bcrypt-hashed). Then remove the
      values from the environment.
- [ ] Confirm the dev seed admin (`admin@nepalshop.local` / `Admin@123`) can
      no longer sign in: change its password in the admin panel, or delete
      the row from the `admins` table.
- [ ] The dev admin credentials are public demo values. Treat any database
      that ever held them as compromised until the password is changed.

## 3. Demo data

- [ ] Decide: keep the 3 demo sellers + 12 demo products as catalogue
      examples, or remove them. If you remove them, delete their rows from
      `store_settings` and `products` (orders reference them, so delete
      orders first — or start from a fresh database and re-run migrations).
- [ ] Demo seller keys (`demo-seller-01` etc.) are public. Any real seller
      must register with their own email and a strong password.
- [ ] Review the demo coupons `WELCOME10` and `FREESHIP` in the admin panel:
      change the codes, limits and expiry, or deactivate them.

## 4. Payments

- [ ] Without `ESEWA_MERCHANT_ID`/`ESEWA_SECRET_KEY`, eSewa checkout honestly
      reports "not configured" and buyers fall back to COD. Same for Khalti
      without `KHALTI_SECRET_KEY`. This is the safe default — do not fake it.
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
      the signature AND do a server-side status check before marking anything
      paid. Never mark an order paid from the redirect alone.

## 5. Backups

- [ ] Back up the persistent disk regularly (Render disk snapshots, or a
      cron job that copies `app.db` off the disk). SQLite WAL mode means you
      must copy the `-wal` file too, or checkpoint first.
- [ ] Test a restore once: copy the backup to a scratch path, boot with
      `DB_PATH` pointing at it, and confirm orders and products load.

## 6. Security and operations

- [ ] Serve over HTTPS (Render gives you this). The app itself does not
      terminate TLS.
- [ ] Keep Bun and dependencies up to date; re-run `bun install` and the
      typechecks after upgrades.
- [ ] Rate-limit `/actions` at the edge if you expect hostile traffic
      (the app has no built-in rate limiter).
- [ ] The AI assistant runs on a local rule engine and never sends buyer
      data anywhere. If you later set `AI_API_KEY` for an LLM upgrade, review
      what question text would leave your server.
- [ ] Support tickets, buyer issues and reviews are visible in the admin
      panel — assign someone to watch them.
- [ ] Re-run the full test suite (`TESTING.md`) after every deploy.

## 7. Known limits (do not work around, plan for them)

- No true product variants (size/colour) — schema reserves a future
  `product_variants` table.
- No live chat; support is ticket-based.
- Product images are URLs only — there is no file upload (uploads need
  object storage).
- No email verification or password reset yet — plan these before
  large-scale buyer sign-ups.
- One order = one seller. The checkout rejects mixed-seller baskets with a
  clear message.
