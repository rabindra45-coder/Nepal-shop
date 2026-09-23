# Production go-live checklist — Nepal Shop (Supabase era)

Work through every item before taking real orders. The stack is Bun +
Supabase Postgres + Supabase Storage + Drizzle, served by `selfhost.ts`.
The full deploy reference (service settings, every env var, backups,
monitoring, the SQLite → Postgres cutover) lives in `README.md` — "Deploy
on Render" and "Supabase cutover". This file is the checklist you tick off.

## 1. Environment

- [ ] `DATABASE_URL` is the Supabase **pooler** connection string
      (Project Settings → Database → Connection string → pooler host,
      port 6543). The server refuses to boot without it.
- [ ] `SUPABASE_URL=https://bdocgqightjjthuosvch.supabase.co`
      (Project Settings → General) and `SUPABASE_SERVICE_ROLE_KEY`
      (Project Settings → API, secret) are set — uploads need them.
      The service-role key is server-side only: never commit it, never
      expose it to the client.
- [ ] `SKIP_SEED=1` is set — the demo seed (admin, demo sellers, sample
      products) must never run on the live database.
- [ ] **No persistent disk is needed.** The database lives in Supabase
      Postgres and uploads in Supabase Storage; deploys and sleep/wake
      cycles lose nothing. If the old `/var/shop-data` disk is still
      attached, detach it.
- [ ] `PUBLIC_BASE_URL` set to the real public URL, e.g.
      `https://nepal-shop-2.onrender.com`. Payment callbacks, the sitemap
      and `robots.txt` all use it.
- [ ] `BREVO_API_KEY` set (Brevo transactional-email API key — the
      production email path on Render, whose free tier blocks outbound
      SMTP ports 25/465/587 entirely, so Gmail SMTP can never work there),
      plus `BREVO_SENDER_EMAIL` (a sender address verified in the Brevo
      account; falls back to `SMTP_FROM`, then `SMTP_USER`). SMTP
      (`SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM`)
      remains the fallback for local dev and hosts that allow outbound
      SMTP. Without any provider the shop keeps working but every email
      honestly reports "not configured" in the logs.
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

- [ ] Decide: **start fresh** (recommended — run `supabase/schema.sql`
      then `supabase/storage.sql` in the SQL editor, boot with
      `SKIP_SEED=1`, provision the real admin via
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

- [ ] Supabase point-in-time recovery is enabled (Project Settings →
      Database) — this is the primary protection against data loss.
- [ ] Schedule `scripts/backup.ts` as well (Render cron job or any machine
      with Bun and the PostgreSQL client tools):
      `DATABASE_URL=… BACKUP_DIR=./backups KEEP_DAILY=7 bun scripts/backup.ts`
- [ ] It dumps the live database with `pg_dump -Fc`, keeping the last 7
      dumps. Exit code 1 on failure — alert on that. The script fails
      clearly if `pg_dump` is missing from `PATH`.
- [ ] `pg_dump` backs up the **database only** — product/banner/avatar
      images live in Supabase Storage buckets, so keep bucket
      versioning/PITR enabled for those too.
- [ ] There are **no automated off-site backups** beyond what you
      configure. Do not claim there are. If you need off-site copies,
      sync `BACKUP_DIR` somewhere yourself.
- [ ] The restore procedure is in `README.md` ("Backups and restore").
      The old SQLite restore was tested 2026-09-22; the `pg_restore` flow
      has not been restore-tested yet — test it once against a scratch
      database before you need it for real.

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

## 8. Deploy checklist (no questions asked)

1. `bun install` — dependencies (the SDK is vendored in `./vendor`).
2. If `client/src` changed: `bun scripts/build-client-local.mjs`
   (the Render/self-host builder — NOT `client/build.mjs`, which is the
   SDK-guarded Hatch artifact builder).
3. `bun run typecheck` — server + client must be green.
4. `bun scripts/schema-parity.ts` — drizzle schema and
   `supabase/schema.sql` must agree (also runs in CI).
5. `bun scripts/verify-v4.ts --port <PORT>` and
   `bun scripts/verify-v9.ts --port <PORT>` against a fresh-boot server
   on a scratch Postgres — expect all green.
6. Replace the repo contents with this folder, commit, push.
7. Render → **Manual Deploy → Deploy latest commit** (service settings:
   runtime Bun, build `bun install`, start `bun selfhost.ts`, NO
   persistent disk, health check `/api/health`). Env must include
   `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
   `SKIP_SEED=1`.
8. Watch the deploy logs: `supabase/schema.sql` applies, no `[security]
   Demo seller` warnings, `/api/health` returns `"status":"ok"`.

## 9. Known limits (do not work around, plan for them)

- No true product variants (size/colour) — schema reserves a future
  `product_variants` table.
- No live chat; support is ticket-based.
- One order = one seller. The checkout rejects mixed-seller baskets with a
  clear message.
- Backups are `pg_dump` files plus Supabase PITR — not off-site until
  you sync them somewhere yourself; see section 5.
- No external APM; monitoring is the health endpoint + structured logs +
  admin email alerts (an honest, dependency-free scope).
- Privacy Policy and Terms drafts (in the app) still need a local
  lawyer's review before real customers.
