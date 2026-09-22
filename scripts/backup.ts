// Automated backup for Nepal Shop (Supabase Postgres era).
//
// Dumps the Postgres database with pg_dump (custom format, -Fc) into
// timestamped files with retention. Dependency-free apart from pg_dump
// itself (Bun only).
//
//   DATABASE_URL  Postgres connection string (REQUIRED — same one the server uses)
//   BACKUP_DIR    where backups land                (default ./backups)
//   KEEP_DAILY    how many recent dumps to keep     (default 7)
//
// Output per run:
//   <BACKUP_DIR>/db/app-YYYYMMDD-HHMMSS.dump
//
// NOTE: this backs up the DATABASE only. Product/banner/avatar images live
// in Supabase Storage buckets (product-images, banners, avatars,
// site-assets) — pg_dump does not touch them. Keep Supabase's own
// point-in-time recovery / bucket versioning enabled for those.
//
// Restore procedure (also documented in README "Backups and restore"):
//   1. pg_restore -d "$DATABASE_URL" --clean --if-exists <chosen .dump>
//      (--clean drops objects before recreating them; the schema is in the
//      dump, so no need to run supabase/schema.sql first.)
//   2. Storage objects are untouched by pg_restore — restore them from the
//      Supabase dashboard / bucket backups if needed.
//   3. Boot the server and confirm orders/products load (see README).
//
// Exit code 0 on success, 1 on any failure (a cron wrapper should alert on
// non-zero exit — Render cron jobs surface this in the dashboard).
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const DATABASE_URL = process.env.DATABASE_URL;
const BACKUP_DIR = process.env.BACKUP_DIR ?? "./backups";
const KEEP_DAILY = Number(process.env.KEEP_DAILY ?? 7);

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function fail(message: string): never {
  process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), level: "error", scope: "backup", msg: message }) + "\n");
  process.exit(1);
}

if (!DATABASE_URL) fail("DATABASE_URL is not set — the backup needs the same Postgres connection string the server uses.");
if (!Number.isFinite(KEEP_DAILY) || KEEP_DAILY < 1) fail(`KEEP_DAILY must be a positive number, got: ${process.env.KEEP_DAILY}`);

// pg_dump must exist on PATH. Check first so the failure message names the
// actual problem instead of surfacing a cryptic spawn error.
{
  const probe = Bun.spawn(["pg_dump", "--version"], { stdout: "pipe", stderr: "pipe" });
  const code = await probe.exited;
  if (code !== 0) {
    const err = (await new Response(probe.stderr).text()).trim();
    fail(`pg_dump is not available on PATH (exit ${code}): ${err || "command not found"}. Install the PostgreSQL client tools to run backups.`);
  }
}

const ts = stamp(new Date());
const dbDir = resolve(BACKUP_DIR, "db");
mkdirSync(dbDir, { recursive: true });

// --- 1. Database dump (custom format: compressed, pg_restore-able) ------------
const dbSnapshot = join(dbDir, `app-${ts}.dump`);
if (existsSync(dbSnapshot)) fail(`snapshot already exists: ${dbSnapshot}`);
{
  // -Fc custom format, single file. DATABASE_URL is passed as the dbname
  // argument (never interpolated into a shell string — argv array, no shell).
  const proc = Bun.spawn(["pg_dump", DATABASE_URL!, "-Fc", "-f", dbSnapshot], { stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) {
    const err = (await new Response(proc.stderr).text()).trim();
    try { rmSync(dbSnapshot, { force: true }); } catch { /* ignore */ }
    fail(`pg_dump failed (exit ${code}): ${err}`);
  }
}

// --- 2. Retention: keep the KEEP_DAILY most recent dumps ----------------------
function prune(dir: string, prefix: string, suffix: string): number {
  const files = readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(suffix))
    .sort(); // timestamped names sort chronologically
  const excess = files.slice(0, Math.max(0, files.length - KEEP_DAILY));
  for (const f of excess) rmSync(join(dir, f));
  return excess.length;
}
const pruned = prune(dbDir, "app-", ".dump");

// --- 3. Report ----------------------------------------------------------------
console.log(JSON.stringify({
  ts: new Date().toISOString(),
  level: "info",
  scope: "backup",
  msg: "backup complete",
  db: basename(dbSnapshot),
  note: "database only — Supabase Storage buckets are not part of pg_dump",
  pruned,
  kept: KEEP_DAILY,
}));
