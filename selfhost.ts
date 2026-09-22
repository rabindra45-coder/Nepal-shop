// Self-host server for Nepal Shopping Site.
// Serves the built storefront (client/dist) and answers the same
// POST /actions RPC the Muse-hosted version uses, backed by the
// SQLite database in ./data/app.db.
//
// Run:  bun selfhost.ts
// Env:  PORT (default 3000), DB_PATH (default ./data/app.db)

import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { and, eq, like } from "drizzle-orm";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Actions, notifyAdmin, sweepExpiredUnpaidGroups } from "./server/src/actions";
import * as schema from "./server/src/schema";

// --- Release version ----------------------------------------------------------
// Bumped by hand on each packaged release; surfaced by /api/health so a
// health check can confirm which build is actually running.
const APP_VERSION = "v7";
const BOOT_MS = Date.now();

// --- Structured server logging ------------------------------------------------
// Every server-side failure is written to stderr as one JSON line:
//   {"ts":"2026-09-22T08:00:00.000Z","level":"error","scope":"actions","msg":"..."}
// Render (and any log collector) captures stderr; the single-line JSON shape
// makes failures greppable without an external APM agent (honest scope:
// dependency-free, no third-party monitoring).
// Secrets are NEVER logged: messages are scanned for credential-shaped values
// and redacted before they leave the process. Request bodies/args are never
// logged at all — they can contain passwords, tokens and phone numbers.
const SECRET_VALUE_RE =
  /("(?:password|pass|passwd|pwd|token|secret|api[_-]?key|auth[_-]?token|seller[_-]?key|private[_-]?key|client[_-]?secret|merchant[_-]?id)"\s*:\s*")[^"]*(")/gi;
const BEARER_RE = /\b(Bearer\s+)[A-Za-z0-9\-._~+/=]{8,}/g;
function scrub(text: string): string {
  return String(text)
    .replace(SECRET_VALUE_RE, "$1[redacted]$2")
    .replace(BEARER_RE, "$1[redacted]");
}
function logEvent(
  level: "info" | "warn" | "error",
  scope: string,
  message: string,
  fields: Record<string, unknown> = {},
): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, scope, msg: scrub(message), ...fields });
  process.stderr.write(line + "\n");
}

// --- Critical-failure admin alerts -------------------------------------------
// Payment failures, checkout failures, webhook failures and sweeper
// exceptions already alert ADMIN_EMAIL from inside the actions layer
// (verify: notifyAdmin calls in actions.ts cover eSewa/Khalti verification
// failures, failed payouts and the unpaid-order sweeper). This covers the
// remaining two classes that are trivially safe to alert on:
//   1. repeated unexpected 5xx-class failures (a crash loop in disguise), and
//   2. boot failures (migrations/DB errors before the server can listen).
// Alerts are best-effort and throttled: alerting must never break the flow
// it reports on. When ADMIN_EMAIL is unset, notifyAdmin logs honestly and
// sends nothing.
const SERVER_ERROR_WINDOW_MS = 10 * 60 * 1000;
const SERVER_ERROR_THRESHOLD = 5; // >=5 unexpected failures in the window
const ALERT_COOLDOWN_MS = 6 * 3600 * 1000;
let serverErrorTimestamps: number[] = [];
let lastServerErrorAlertAt = 0;
function recordServerError(kind: string): void {
  const now = Date.now();
  serverErrorTimestamps = [...serverErrorTimestamps.filter((t) => now - t < SERVER_ERROR_WINDOW_MS), now];
  if (serverErrorTimestamps.length < SERVER_ERROR_THRESHOLD) return;
  if (now - lastServerErrorAlertAt < ALERT_COOLDOWN_MS) return;
  lastServerErrorAlertAt = now;
  serverErrorTimestamps = [];
  void notifyAdmin(
    "Repeated server errors",
    `Nepal Shop (${APP_VERSION}) recorded ${SERVER_ERROR_THRESHOLD}+ unexpected failures ` +
      `within ${SERVER_ERROR_WINDOW_MS / 60000} minutes (latest: ${kind}).\n\n` +
      `Check the server logs promptly — this pattern usually means a broken deploy, ` +
      `a full disk, or a database problem. You will not get another alert for ` +
      `${ALERT_COOLDOWN_MS / 3600000} hours even if failures continue.`,
  ).catch(() => { /* alerting must never break the server */ });
}

// Process-level safety net: an unhandled rejection/exception is a bug by
// definition — log it structured, alert (throttled), and for uncaught
// exceptions exit non-zero so the host restarts into a clean process.
process.on("unhandledRejection", (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  logEvent("error", "process", "unhandledRejection", { error: message });
  recordServerError("unhandledRejection");
});
process.on("uncaughtException", (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  logEvent("error", "process", "uncaughtException — exiting", { error: message });
  void notifyAdmin(
    "Server crashed (uncaughtException)",
    `Nepal Shop (${APP_VERSION}) hit an uncaught exception and is exiting ` +
      `so the host can restart it:\n\n${message}\n\nCheck the logs for the full detail.`,
  )
    .catch(() => {})
    .finally(() => process.exit(1));
  // If the alert itself hangs (dead SMTP), do not hang the exit.
  setTimeout(() => process.exit(1), 10_000).unref();
});

const PORT = Number(process.env.PORT ?? 3000);
const DB_PATH = process.env.DB_PATH ?? "./data/app.db";

// --- Boot: make sure the database exists and is up to date. ---
// On hosts with an ephemeral filesystem (e.g. Render), point DB_PATH at a
// persistent disk, e.g. DB_PATH=/var/shop-data/app.db. On first boot the
// database is seeded from the bundled demo database, then any pending
// drizzle migrations in ./drizzle are applied.
{
  const resolved = resolve(DB_PATH);
  mkdirSync(dirname(resolved), { recursive: true });
  if (!existsSync(resolved)) {
    const seed = resolve("./data/app.db");
    if (seed !== resolved && existsSync(seed)) {
      copyFileSync(seed, resolved);
      console.log(`Seeded database from ${seed}`);
    }
  }
}

// A boot failure (corrupt DB, failed migration, unwritable disk) must fail
// loudly: alert the admin best-effort, then exit non-zero so the host marks
// the deploy failed instead of serving a half-booted process. Alerting is
// given 10 seconds, then the exit happens regardless.
let sqlite!: Database;
let db!: ReturnType<typeof drizzle>;
try {
  sqlite = new Database(DB_PATH);
  // Match the production pragmas used for the SQLite store.
  sqlite.exec("PRAGMA journal_mode = WAL;");
  // Enforce declared foreign keys at runtime (cascades, set-null, restrict).
  sqlite.exec("PRAGMA foreign_keys = ON;");
  db = drizzle(sqlite, { schema });
  // Apply any pending migrations (no-op when already up to date).
  migrate(db, { migrationsFolder: "./drizzle" });
} catch (e) {
  const message = e instanceof Error ? e.message : String(e);
  logEvent("error", "boot", "database boot failed — server will not start", { error: message });
  await Promise.race([
    notifyAdmin(
      "Server failed to boot",
      `Nepal Shop (${APP_VERSION}) could not start — database/migration failure:\n\n${message}\n\n` +
        `The process is exiting; Render will mark the deploy as failed. Check the logs and the disk.`,
    ).catch(() => { /* alerting must never hang the exit */ }),
    new Promise((resolve) => setTimeout(resolve, 10_000)),
  ]);
  process.exit(1);
}

// --- First production admin (documented in README): if ADMIN_EMAIL and
// ADMIN_PASSWORD are set and no admin with that email exists yet, create the
// real production admin with a bcrypt hash. This is the safe way to go live
// instead of the dev seed admin (admin@nepalshop.local / Admin@123).
{
  const adminEmail = (process.env.ADMIN_EMAIL ?? "").trim().toLowerCase();
  const adminPassword = process.env.ADMIN_PASSWORD ?? "";
  if (adminEmail && adminPassword) {
    const existing = await db
      .select({ id: schema.admins.id })
      .from(schema.admins)
      .where(eq(schema.admins.email, adminEmail))
      .limit(1);
    if (!existing.length) {
      await db.insert(schema.admins).values({
        id: crypto.randomUUID(),
        name: "Production Admin",
        email: adminEmail,
        passwordHash: await Bun.password.hash(adminPassword),
        createdAt: new Date(),
      });
      console.log(`Created production admin: ${adminEmail}`);
    }
  }
}

// --- Demo-data production guard ------------------------------------------------
// The bundled seed database ships demo sellers (e.g. *@demo.local) whose
// credentials are documented. They must never serve real customers: warn
// loudly on every boot while any remain, so going live with them is a
// conscious choice, never an accident.
{
  try {
    const demos = await db
      .select({ sellerCode: schema.storeSettings.sellerCode, email: schema.storeSettings.email })
      .from(schema.storeSettings)
      .where(like(schema.storeSettings.email, "%@demo.local"));
    for (const d of demos) {
      console.warn(`[security] Demo seller still present: ${d.sellerCode} (${d.email}). Suspend or delete demo sellers before serving real customers.`);
    }
  } catch (e) {
    console.warn("[security] demo-seller check skipped:", e instanceof Error ? e.message : e);
  }
}

function notSupported(name: string): never {
  throw new Error(`${name} is not available in the self-hosted server.`);
}

// Minimal action context: the shop's actions only use ctx.db() and
// ctx.invalidateQueries(). Everything else is stubbed.
function makeCtx() {
  return {
    slug: "nepal-shopping-site",
    invocationId: crypto.randomUUID(),
    spaceDir: process.cwd(),
    db: () => db,
    viewer: undefined,
    emit: () => {},
    invalidateQueries: () => {},
    blobs: {
      put: async () => notSupported("Blob storage"),
      getUrl: async () => notSupported("Blob storage"),
      delete: async () => notSupported("Blob storage"),
      head: async () => null,
      list: async () => [],
    },
    executePrivileged: async () => notSupported("Privileged contracts"),
    agent: undefined,
    inference: undefined,
    tool: undefined,
  };
}

function zodMessage(e: unknown): string {
  if (e && typeof e === "object" && "issues" in e && Array.isArray((e as any).issues)) {
    return (e as any).issues.map((i: any) => `${i.path?.join(".") || "value"}: ${i.message}`).join("; ");
  }
  return e instanceof Error ? e.message : String(e);
}

// Heuristic: was this exception never meant for a buyer's eyes? Every action
// throws plain `new Error(...)` with a curated user-facing sentence, so a
// message that smells of drivers, stacks or type errors is a genuine bug.
// (Audited 2026-09-22: none of the 249 user-facing messages match these
// patterns, so false positives should not occur; if one ever does, the
// worst case is a generic "Something went wrong" instead of the specific
// message — safe, and visible in the structured log.)
const INTERNAL_MESSAGE_RE =
  /SQLITE_|drizzle|ECONN|EPIPE|ENOTFOUND|ENOMEM|ETIMEDOUT|Cannot read propert|is not a function|is not defined|Unexpected token|^\s*at\s/m;
function isInternalFailure(e: unknown, message: string): boolean {
  if (!(e instanceof Error)) return true;
  return INTERNAL_MESSAGE_RE.test(message);
}

const DIST = "./client/dist";

// --- Product image uploads -------------------------------------------------
// Sellers upload up to 10 photos per product (JPG/PNG/WebP/GIF, 5 MB each).
// Files live under UPLOADS_DIR (default ./data/uploads — on Render point it
// at the persistent disk, e.g. UPLOADS_DIR=/var/shop-data/uploads) and are
// served at /uploads/<file>. Uploads only work on this self-hosted server.
const UPLOADS_DIR = resolve(process.env.UPLOADS_DIR ?? "./data/uploads");
mkdirSync(UPLOADS_DIR, { recursive: true });
const MAX_IMAGES_PER_PRODUCT = 10;
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const UPLOAD_MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif",
};
const UPLOAD_NAME_RE = /^((banner|store)-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|gif)$/;

async function legacyKeyHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function resolveUploadSeller(authToken: string, sellerCode: string, sellerKey: string) {
  if (authToken) {
    const s = (await db.select().from(schema.sessions).where(eq(schema.sessions.token, authToken)).limit(1))[0];
    if (!s || s.userType !== "seller" || s.expiresAt.getTime() < Date.now()) throw new Error("Please sign in again.");
    const store = (await db.select().from(schema.storeSettings).where(eq(schema.storeSettings.id, Number(s.userId))).limit(1))[0];
    if (!store) throw new Error("Seller account not found.");
    return store;
  }
  if (sellerCode && sellerKey) {
    const store = (await db.select().from(schema.storeSettings).where(eq(schema.storeSettings.sellerCode, sellerCode.toUpperCase())).limit(1))[0];
    if (!store) throw new Error("Seller code or access key is incorrect.");
    // Prefer the bcrypt hash (v7+); accept a legacy unsalted SHA-256 hash
    // once and transparently upgrade it to bcrypt.
    if (store.adminKeyHashBcrypt) {
      if (!await Bun.password.verify(sellerKey, store.adminKeyHashBcrypt)) throw new Error("Seller code or access key is incorrect.");
    } else if (!store.adminKeyHash || store.adminKeyHash !== await legacyKeyHash(sellerKey)) {
      throw new Error("Seller code or access key is incorrect.");
    } else {
      await db.update(schema.storeSettings)
        .set({ adminKeyHashBcrypt: await Bun.password.hash(sellerKey, { algorithm: "bcrypt", cost: 10 }), updatedAt: new Date() })
        .where(eq(schema.storeSettings.id, store.id));
    }
    return store;
  }
  throw new Error("Seller sign-in is required.");
}

// --- Rate limiting for auth-ish actions -----------------------------------
// Per-IP sliding window: max 20 attempts per 10 minutes per (IP, action).
// Dependency-free: module-level Map of timestamp arrays, pruned on each check.
const RATE_LIMIT_ACTIONS = new Set([
  "signup", "login", "sellerLogin", "adminLogin", "registerSeller",
  "requestPasswordReset", "resetPassword",
  "adminChangePassword", "updateMyPassword", "updateSellerPassword",
  // Public write endpoints that cost the platform (spam/abuse surface).
  "reportIssue", "createTicket", "reportReview",
  // Review submission: gated by delivered orders, but still rate-limited
  // against automated review-spam scripts (checkpoint 20).
  "addReview",
  // Seller email verification (token endpoints must not be brute-forced).
  "verifySellerEmail", "resendSellerVerification",
]);
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const rateLimitHits = new Map<string, number[]>();

function rateLimitExceeded(ip: string, action: string): boolean {
  const key = `${ip}:${action}`;
  const now = Date.now();
  const hits = (rateLimitHits.get(key) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (hits.length >= RATE_LIMIT_MAX) {
    rateLimitHits.set(key, hits);
    return true;
  }
  hits.push(now);
  rateLimitHits.set(key, hits);
  return false;
}

// --- Rate limiting for checkout and payment actions -----------------------
// Per-IP sliding window with per-action caps. These endpoints are
// abuse-sensitive (order creation, coupon probing, payment verification
// retries), so they get their own limits on top of the auth set above.
const PAYMENT_RATE_LIMITS: Record<string, { max: number; windowMs: number }> = {
  placeOrder: { max: 30, windowMs: 10 * 60 * 1000 },
  validateCoupon: { max: 60, windowMs: 10 * 60 * 1000 },
  initiateOnlinePayment: { max: 60, windowMs: 10 * 60 * 1000 },
  verifyEsewaPayment: { max: 60, windowMs: 10 * 60 * 1000 },
  verifyKhaltiPayment: { max: 60, windowMs: 10 * 60 * 1000 },
  cancelOnlinePayment: { max: 60, windowMs: 10 * 60 * 1000 },
  // Analytics tracking endpoint: buyer-validated, deduped server-side, but
  // still rate-limited so it can't be hammered to skew the funnel.
  trackCheckoutStart: { max: 60, windowMs: 10 * 60 * 1000 },
  // Public order-tracking lookup (order code + phone): rate-limited so it
  // can't be used for code/phone enumeration (checkpoint 20).
  trackOrder: { max: 60, windowMs: 10 * 60 * 1000 },
};
const paymentRateLimitHits = new Map<string, number[]>();

function paymentRateLimitExceeded(ip: string, action: string): boolean {
  const cap = PAYMENT_RATE_LIMITS[action];
  if (!cap) return false;
  const key = `${ip}:${action}`;
  const now = Date.now();
  const hits = (paymentRateLimitHits.get(key) ?? []).filter((t) => now - t < cap.windowMs);
  if (hits.length >= cap.max) {
    paymentRateLimitHits.set(key, hits);
    return true;
  }
  hits.push(now);
  paymentRateLimitHits.set(key, hits);
  return false;
}

// --- Static asset serving helpers (module scope so the gzip cache survives
// across requests) ---------------------------------------------------------
// Hashed assets (JS/CSS/images under /assets/) are content-addressed and
// immutable: cache them for a year. index.html is never cached — it carries
// the current asset hashes, so deploys take effect immediately. Text assets
// are served gzip-compressed (in-memory cache keyed on file mtime+size): the
// ~774 KB client bundle compresses to ~200 KB, which matters on mobile.
const COMPRESSIBLE_RE = /\.(?:js|css|html|svg|json|xml|webmanifest|txt)$/i;
const gzipCache = new Map<string, { mtime: number; size: number; body: Uint8Array }>();
async function staticFileResponse(absPath: string, req: Request, immutable: boolean): Promise<Response | null> {
  const file = Bun.file(absPath);
  if (!(await file.exists())) return null;
  const headers: Record<string, string> = {
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
  };
  if (req.headers.get("accept-encoding")?.includes("gzip") && COMPRESSIBLE_RE.test(absPath)) {
    const mtime = file.lastModified;
    const size = file.size;
    let entry = gzipCache.get(absPath);
    if (!entry || entry.mtime !== mtime || entry.size !== size) {
      entry = { mtime, size, body: Bun.gzipSync(await file.arrayBuffer()) };
      gzipCache.set(absPath, entry);
    }
    headers["content-encoding"] = "gzip";
    headers["content-type"] = file.type || "application/octet-stream";
    headers["vary"] = "accept-encoding";
    return new Response(entry.body, { headers });
  }
  return new Response(file, { headers });
}

Bun.serve({
  port: PORT,
  // Unhandled-error safety net for every request path: anything that escapes
  // the route handlers below returns a safe 500 (no stack traces, no SQL)
  // and is logged structured. Individual routes still return their own
  // 4xx contract responses.
  error(err) {
    const message = err instanceof Error ? err.message : String(err);
    logEvent("error", "http", "unhandled request failure", { error: message });
    recordServerError("unhandled request failure");
    return Response.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  },
  async fetch(req, server) {
    const url = new URL(req.url);

    // --- Health check (no auth, kept fast for Render health checks) ---------
    // GET /api/health -> 200 { status, version, uptime_seconds, db }.
    // db is a real reachability probe (SELECT 1); a dead database returns
    // 503 so the host stops routing traffic here.
    if ((url.pathname === "/api/health" || url.pathname === "/health") && (req.method === "GET" || req.method === "HEAD")) {
      let dbOk = false;
      try {
        sqlite.query("SELECT 1").get();
        dbOk = true;
      } catch (e) {
        logEvent("error", "health", "database reachability probe failed", {
          error: e instanceof Error ? e.message : String(e),
        });
      }
      return Response.json(
        {
          status: dbOk ? "ok" : "degraded",
          version: APP_VERSION,
          uptime_seconds: Math.round((Date.now() - BOOT_MS) / 1000),
          db: dbOk ? "reachable" : "unreachable",
        },
        { status: dbOk ? 200 : 503 },
      );
    }

    // --- Action RPC: POST /actions  { action, args } -> { data } ---
    if (url.pathname === "/actions" && req.method === "POST") {
      const body = await req.json().catch(() => null);
      const def = (Actions as Record<string, any>)[body?.action];
      if (!def) {
        return Response.json({ error: `Unknown action: ${String(body?.action)}` }, { status: 404 });
      }
      if (typeof body?.action === "string" && (RATE_LIMIT_ACTIONS.has(body.action) || PAYMENT_RATE_LIMITS[body.action])) {
        // Take the LAST X-Forwarded-For entry: the address appended by the
        // nearest trusted proxy (Render adds the real client IP); earlier
        // entries are client-controlled and must not be trusted.
        const xff = req.headers.get("x-forwarded-for");
        const ip = xff?.split(",").map((s) => s.trim()).filter(Boolean).pop()
          ?? (server as unknown as { requestIP?: (r: Request) => { address: string } | null }).requestIP?.(req)?.address
          ?? "unknown";
        const authLimited = RATE_LIMIT_ACTIONS.has(body.action) && rateLimitExceeded(ip, body.action);
        const paymentLimited = !authLimited && paymentRateLimitExceeded(ip, body.action);
        if (authLimited || paymentLimited) {
          return Response.json(
            { error: "Too many attempts. Please wait a few minutes and try again." },
            { status: 429 },
          );
        }
      }
      let args: unknown;
      try {
        args = def.request.parse(body?.args ?? {});
      } catch (e) {
        return Response.json({ error: `Invalid request: ${zodMessage(e)}` }, { status: 422 });
      }
      try {
        const data = await def.handler(makeCtx(), args);
        return Response.json({ data });
      } catch (e) {
        const message = zodMessage(e);
        // Internal failures (bugs, DB/driver errors — anything never written
        // as a buyer-facing message) must not leak implementation detail:
        // the client gets a safe 500, the real detail goes to the structured
        // log only, and repeated failures page the admin. User-facing
        // validation/business errors keep their 400 + message contract.
        if (isInternalFailure(e, message)) {
          logEvent("error", "actions", `internal failure in action "${body?.action}"`, { error: message });
          recordServerError(`action ${body?.action}`);
          return Response.json({ error: "Something went wrong. Please try again." }, { status: 500 });
        }
        return Response.json({ error: message }, { status: 400 });
      }
    }

    // --- SEO / PWA helpers (read-only, no behaviour changes to the shop) ---
    if (url.pathname === "/robots.txt") {
      const base = (process.env.PUBLIC_BASE_URL ?? `http://localhost:${PORT}`).replace(/\/+$/, "");
      return new Response(`User-agent: *\nAllow: /\nSitemap: ${base}/sitemap.xml\n`, {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    if (url.pathname === "/manifest.webmanifest") {
      return Response.json(
        {
          name: "Nepal Shop",
          short_name: "Nepal Shop",
          description: "A customer-facing online shopping site for Nepal.",
          start_url: "/#/",
          scope: "/",
          display: "standalone",
          background_color: "#fff9ed",
          theme_color: "#d94829",
          icons: [
            { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
            { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
          ],
        },
        { headers: { "content-type": "application/manifest+json" } }
      );
    }
    if (url.pathname === "/sitemap.xml") {
      const base = (process.env.PUBLIC_BASE_URL ?? `http://localhost:${PORT}`).replace(/\/+$/, "");
      const activeStores = await db
        .select({ id: schema.storeSettings.id })
        .from(schema.storeSettings)
        .where(eq(schema.storeSettings.status, "active"));
      const activeIds = new Set(activeStores.map((s) => s.id));
      const rows = await db
        .select({ id: schema.products.id, storeId: schema.products.storeId, updatedAt: schema.products.updatedAt })
        .from(schema.products)
        .where(eq(schema.products.isActive, true));
      const staticUrls = ["", "/#/shop", "/#/search", "/#/about", "/#/contact", "/#/help", "/#/track"]
        .map((p) => `  <url><loc>${base}/${p.replace(/^\//, "")}</loc></url>`)
        .join("\n");
      const urls = rows
        .filter((p) => activeIds.has(p.storeId))
        .map((p) => `  <url><loc>${base}/#/product/${p.id}</loc><lastmod>${p.updatedAt.toISOString().slice(0, 10)}</lastmod></url>`)
        .join("\n");
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${staticUrls}\n${urls}\n</urlset>\n`,
        { headers: { "content-type": "application/xml; charset=utf-8" } }
      );
    }

    if (url.pathname === "/api/uploads" && req.method === "POST") {
      try {
        const form = await req.formData();
        const store = await resolveUploadSeller(
          String(form.get("authToken") ?? ""), String(form.get("seller_code") ?? ""), String(form.get("seller_key") ?? ""),
        );
        if (store.status === "suspended" || store.status === "rejected") throw new Error("This shop is suspended and cannot upload photos. Please contact support.");
        const productId = Number(form.get("product_id"));
        if (!Number.isInteger(productId) || productId <= 0) throw new Error("Invalid product.");
        const product = (await db.select({ id: schema.products.id }).from(schema.products)
          .where(and(eq(schema.products.id, productId), eq(schema.products.storeId, store.id))).limit(1))[0];
        if (!product) throw new Error("Product not found.");
        const files = form.getAll("file").filter((f): f is File => f instanceof File && f.size > 0);
        if (!files.length) throw new Error("Choose a photo to upload.");
        const existing = await db.select({ id: schema.productImages.id }).from(schema.productImages)
          .where(eq(schema.productImages.productId, productId));
        if (existing.length + files.length > MAX_IMAGES_PER_PRODUCT)
          throw new Error(`Only ${MAX_IMAGES_PER_PRODUCT} photos per product — ${Math.max(0, MAX_IMAGES_PER_PRODUCT - existing.length)} slot(s) left.`);
        // Validate everything before writing anything.
        const exts = files.map((f) => {
          const ext = UPLOAD_MIME_TO_EXT[f.type];
          if (!ext) throw new Error(`"${f.name || "file"}" is not a JPG, PNG, WebP or GIF photo.`);
          if (f.size > MAX_UPLOAD_BYTES) throw new Error(`"${f.name || "file"}" is over 5 MB.`);
          return ext;
        });
        const saved: { id: number; url: string }[] = [];
        for (let i = 0; i < files.length; i++) {
          const name = `${crypto.randomUUID()}${exts[i]}`;
          await Bun.write(join(UPLOADS_DIR, name), files[i]);
          const rows = await db.insert(schema.productImages)
            .values({ productId, url: `/uploads/${name}`, sortOrder: existing.length + i })
            .returning({ id: schema.productImages.id });
          const row = rows[0];
          if (!row) throw new Error("The photo could not be saved.");
          saved.push({ id: row.id, url: `/uploads/${name}` });
        }
        return Response.json({ data: { images: saved } });
      } catch (e) {
        return Response.json({ error: e instanceof Error ? e.message : "Upload failed." }, { status: 400 });
      }
    }

    if (url.pathname.startsWith("/api/uploads/") && req.method === "DELETE") {
      try {
        const id = Number(url.pathname.slice("/api/uploads/".length));
        if (!Number.isInteger(id) || id <= 0) throw new Error("Invalid photo.");
        // Legacy seller credentials travel in headers, never in the URL:
        // query strings end up in access logs.
        const store = await resolveUploadSeller(
          req.headers.get("x-auth-token") ?? "", req.headers.get("x-seller-code") ?? "", req.headers.get("x-seller-key") ?? "",
        );
        if (store.status === "suspended" || store.status === "rejected") throw new Error("This shop is suspended and cannot remove photos. Please contact support.");
        const img = (await db.select().from(schema.productImages).where(eq(schema.productImages.id, id)).limit(1))[0];
        if (!img) throw new Error("Photo not found.");
        const product = (await db.select({ id: schema.products.id }).from(schema.products)
          .where(and(eq(schema.products.id, img.productId), eq(schema.products.storeId, store.id))).limit(1))[0];
        if (!product) throw new Error("You can only remove your own product photos.");
        await db.delete(schema.productImages).where(eq(schema.productImages.id, id));
        const fname = img.url.split("/").pop() ?? "";
        if (UPLOAD_NAME_RE.test(fname)) {
          try { await unlink(join(UPLOADS_DIR, fname)); } catch { /* already gone */ }
        }
        return Response.json({ data: { ok: true } });
      } catch (e) {
        return Response.json({ error: e instanceof Error ? e.message : "Could not remove the photo." }, { status: 400 });
      }
    }

    // Serve uploaded product photos (long-lived cache; filenames are unique).
    if (url.pathname.startsWith("/uploads/") && (req.method === "GET" || req.method === "HEAD")) {
      const fname = url.pathname.slice("/uploads/".length);
      if (!UPLOAD_NAME_RE.test(fname)) return new Response("Not found", { status: 404 });
      const file = Bun.file(join(UPLOADS_DIR, fname));
      if (!(await file.exists())) return new Response("Not found", { status: 404 });
      // nosniff: uploaded bytes are served strictly as the image type their
      // extension declares, so a smuggled SVG/HTML payload can never be
      // content-sniffed into an executable document (checkpoint 20).
      return new Response(file, { headers: { "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" } });
    }

    // --- Admin advertisement banner uploads ---------------------------------
    // The admin uploads one image per homepage advertisement (JPG/PNG/WebP/GIF,
    // 5 MB). Authenticated with an admin session token in the x-auth-token
    // header; the file is validated like product photos and served from
    // /uploads/ so every ad is shown with its image on the homepage.
    if (url.pathname === "/api/banner-uploads" && req.method === "POST") {
      try {
        const token = req.headers.get("x-auth-token") ?? "";
        const s = token ? (await db.select().from(schema.sessions).where(eq(schema.sessions.token, token)).limit(1))[0] : undefined;
        if (!s || s.userType !== "admin" || s.expiresAt.getTime() < Date.now()) throw new Error("Admin sign-in required.");
        const form = await req.formData();
        const file = form.get("file");
        if (!(file instanceof File) || file.size === 0) throw new Error("Choose a banner image to upload.");
        const ext = UPLOAD_MIME_TO_EXT[file.type];
        if (!ext) throw new Error(`"${file.name || "file"}" is not a JPG, PNG, WebP or GIF image.`);
        if (file.size > MAX_UPLOAD_BYTES) throw new Error(`"${file.name || "file"}" is over 5 MB.`);
        const name = `banner-${crypto.randomUUID()}${ext}`;
        await Bun.write(join(UPLOADS_DIR, name), file);
        return Response.json({ data: { url: `/uploads/${name}` } });
      } catch (e) {
        return Response.json({ error: e instanceof Error ? e.message : "Upload failed." }, { status: 400 });
      }
    }

    // --- Seller store logo / banner uploads ---------------------------------
    // Sellers upload their store logo and banner from the studio settings
    // (JPG/PNG/WebP/GIF, 5 MB each). Authenticated with a seller session
    // token or the legacy seller_code + seller_key in the multipart form.
    // Files are named store-<uuid>.<ext> and served from /uploads/; the
    // saveStoreAssets action attaches them to the store.
    if (url.pathname === "/api/store-uploads" && req.method === "POST") {
      try {
        const form = await req.formData();
        const store = await resolveUploadSeller(
          String(form.get("authToken") ?? ""), String(form.get("seller_code") ?? ""), String(form.get("seller_key") ?? ""),
        );
        if (store.status === "suspended" || store.status === "rejected") throw new Error("This shop is suspended and cannot upload images. Please contact support.");
        const kind = String(form.get("kind") ?? "");
        if (kind !== "logo" && kind !== "banner") throw new Error("Choose whether this image is the store logo or the banner.");
        const file = form.get("file");
        if (!(file instanceof File) || file.size === 0) throw new Error(`Choose a ${kind} image to upload.`);
        const ext = UPLOAD_MIME_TO_EXT[file.type];
        if (!ext) throw new Error(`"${file.name || "file"}" is not a JPG, PNG, WebP or GIF image.`);
        if (file.size > MAX_UPLOAD_BYTES) throw new Error(`"${file.name || "file"}" is over 5 MB.`);
        const name = `store-${crypto.randomUUID()}${ext}`;
        await Bun.write(join(UPLOADS_DIR, name), file);
        return Response.json({ data: { url: `/uploads/${name}` } });
      } catch (e) {
        return Response.json({ error: e instanceof Error ? e.message : "Upload failed." }, { status: 400 });
      }
    }

    // --- Static storefront ---
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return (await staticFileResponse(`${DIST}/index.html`, req, false)) ?? new Response("Not found", { status: 404 });
    }
    const staticHit = await staticFileResponse(`${DIST}${url.pathname}`, req, url.pathname.startsWith("/assets/"));
    if (staticHit) return staticHit;
    // Deep links (e.g. /about, /product/9): redirect to the hash route so the
    // SPA boots on the requested page instead of the homepage.
    if (req.method === "GET" || req.method === "HEAD") {
      return Response.redirect(new URL(`/#${url.pathname}${url.search}`, url).toString(), 302);
    }
    // SPA fallback
    return new Response(Bun.file(`${DIST}/index.html`));
  },
});

console.log(`Nepal Shopping Site running at http://localhost:${PORT}`);
console.log(`Database: ${DB_PATH}`);

// Unpaid online order expiry: stock is reserved at checkout, so groups left
// waiting for an eSewa/Khalti payment (abandoned wallet, expired session,
// timed-out attempt) are swept after 45 minutes — the group is cancelled and
// the reserved stock restored exactly once. Runs at boot and every 10 min.
{
  // Throttle: a persistently broken sweep must not mail the admin every 10 minutes.
  let lastSweepAlertAt = 0;
  const sweep = () => {
    try {
      const { swept, groups } = sweepExpiredUnpaidGroups(db);
      if (swept > 0) console.log(`[payments] released ${swept} expired unpaid order group(s): ${groups.join(", ")}`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logEvent("error", "payments", "unpaid-order sweep failed", { error: message });
      recordServerError("unpaid-order sweep");
      if (Date.now() - lastSweepAlertAt > 6 * 3600 * 1000) {
        lastSweepAlertAt = Date.now();
        void notifyAdmin(
          "Unpaid-order sweep failed",
          `The 45-minute unpaid-order sweeper threw an exception and may not be releasing expired reservations:\n\n${message}\n\nCheck the server logs promptly — stuck reservations hold stock.`,
        ).catch(() => { /* alerting must never break the sweep loop */ });
      }
    }
  };
  sweep();
  setInterval(sweep, 10 * 60 * 1000).unref();
}
