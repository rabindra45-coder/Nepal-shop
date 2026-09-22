// Automated backup for Nepal Shop (checkpoint: backups).
//
// Snapshots the SQLite database and the uploads directory into timestamped,
// self-describing files with retention. Dependency-free (Bun + tar only).
//
//   DB_PATH      path to the live SQLite database   (default ./data/app.db)
//   UPLOADS_DIR  directory with product/store/banner photos (default ./data/uploads)
//   BACKUP_DIR   where backups land                (default ./backups)
//   KEEP_DAILY   how many recent snapshots to keep  (default 7)
//
// Output per run:
//   <BACKUP_DIR>/db/app-YYYYMMDD-HHMMSS.sqlite
//   <BACKUP_DIR>/uploads/uploads-YYYYMMDD-HHMMSS.tar.gz
//
// The database snapshot uses `VACUUM INTO` — an online-safe, fully
// consistent copy of all committed data taken from the LIVE database.
// Never use plain `cp` on a live SQLite file in WAL mode: it can copy a
// torn page set or miss the -wal journal entirely. VACUUM INTO writes a
// fresh, self-contained database file with no -wal/-shm sidecars.
//
// Restore procedure (also documented in README "Backups and restore"):
//   1. Stop the server (restoring under a running writer is unsafe).
//   2. Copy the chosen app-*.sqlite over DB_PATH; delete any DB_PATH-wal /
//      DB_PATH-shm sidecars left from the old file — they belong to the old
//      database and must not be reused.
//   3. Extract the matching uploads-*.tar.gz over UPLOADS_DIR.
//   4. Boot the server and confirm orders/products load (see README).
//
// Exit code 0 on success, 1 on any failure (a cron wrapper should alert on
// non-zero exit — Render cron jobs surface this in the dashboard).
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const DB_PATH = process.env.DB_PATH ?? "./data/app.db";
const UPLOADS_DIR = process.env.UPLOADS_DIR ?? "./data/uploads";
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

const dbFile = resolve(DB_PATH);
if (!existsSync(dbFile)) fail(`database not found: ${dbFile}`);

const ts = stamp(new Date());
const dbDir = resolve(BACKUP_DIR, "db");
const uploadsDirBackup = resolve(BACKUP_DIR, "uploads");
mkdirSync(dbDir, { recursive: true });
mkdirSync(uploadsDirBackup, { recursive: true });

// --- 1. Online-safe database snapshot ---------------------------------------
const dbSnapshot = join(dbDir, `app-${ts}.sqlite`);
if (existsSync(dbSnapshot)) fail(`snapshot already exists: ${dbSnapshot}`);
{
  const db = new Database(dbFile, { readonly: true });
  try {
    // VACUUM INTO takes a transactionally consistent snapshot without
    // locking writers out. The target path is generated above (no user
    // input), but quote-escape defensively anyway.
    const target = dbSnapshot.replace(/'/g, "''");
    db.exec(`VACUUM INTO '${target}'`);
  } catch (e) {
    try { rmSync(dbSnapshot, { force: true }); } catch { /* ignore */ }
    fail(`VACUUM INTO failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    db.close();
  }
}

// --- 2. Uploads archive -------------------------------------------------------
const uploadsSnapshot = join(uploadsDirBackup, `uploads-${ts}.tar.gz`);
{
  const src = resolve(UPLOADS_DIR);
  if (!existsSync(src)) {
    process.stderr.write(
      JSON.stringify({ ts: new Date().toISOString(), level: "warn", scope: "backup", msg: `uploads dir missing (${src}) — skipping uploads archive` }) + "\n",
    );
  } else {
    const proc = Bun.spawn(["tar", "-czf", uploadsSnapshot, "-C", src, "."], { stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    if (code !== 0) {
      const err = (await new Response(proc.stderr).text()).trim();
      try { rmSync(uploadsSnapshot, { force: true }); } catch { /* ignore */ }
      fail(`tar of uploads failed (exit ${code}): ${err}`);
    }
  }
}

// --- 3. Retention: keep the KEEP_DAILY most recent of each kind ----------------
function prune(dir: string, prefix: string, suffix: string): number {
  const files = readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(suffix))
    .sort(); // timestamped names sort chronologically
  const excess = files.slice(0, Math.max(0, files.length - KEEP_DAILY));
  for (const f of excess) rmSync(join(dir, f));
  return excess.length;
}
const prunedDb = prune(dbDir, "app-", ".sqlite");
const prunedUploads = prune(uploadsDirBackup, "uploads-", ".tar.gz");

// --- 4. Report ----------------------------------------------------------------
console.log(JSON.stringify({
  ts: new Date().toISOString(),
  level: "info",
  scope: "backup",
  msg: "backup complete",
  db: basename(dbSnapshot),
  uploads: existsSync(uploadsSnapshot) ? basename(uploadsSnapshot) : null,
  pruned: prunedDb + prunedUploads,
  kept: KEEP_DAILY,
}));
