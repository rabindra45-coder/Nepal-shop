// One-time cutover: SQLite (bun:sqlite) -> Supabase Postgres.
//
// Copies every row from the local SQLite database into the Supabase Postgres
// database, converting SQLite conventions to Postgres types, then moves the
// legacy /uploads/* image files into Supabase Storage buckets and rewrites
// the stored URLs.
//
// Usage:
//   DATABASE_URL=postgres://... DB_PATH=./data/app.db \
//     SUPABASE_URL=https://<project>.supabase.co \
//     SUPABASE_SERVICE_ROLE_KEY=<secret> \
//     UPLOADS_DIR=./data/uploads \
//     bun scripts/migrate-to-supabase.ts [--force]
//
// Requirements:
// - DATABASE_URL must be set (same connection string the server uses).
// - supabase/schema.sql must already be applied to the target (boot the
//   server once with SKIP_SEED=1, or run it in the Supabase SQL editor).
// - The target must be EMPTY (refuses to run otherwise), unless --force is
//   passed, which TRUNCATEs every shop table first (CASCADE, identities reset).
//
// Data conversion per Postgres column type:
// - boolean:      SQLite 0/1 -> false/true
// - timestamptz:  SQLite millisecond integers -> Date (ISO text passes through)
// - everything else passes through unchanged (prices are integer paisa,
//   payload_json is TEXT — there are no json/jsonb columns).
// Tables are copied in foreign-key dependency order inside one transaction.
// Serial sequences are repaired afterwards (next id = max(id)+1).
//
// Uploads: files directly under UPLOADS_DIR are uploaded to their bucket
// (filename convention decides: banner-* -> banners, store-*/sitelogo-* ->
// site-assets, avatar-* -> avatars, bare <uuid>.<ext> -> product-images),
// then /uploads/<name> values in the known URL columns are rewritten to the
// new public URLs. Without SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY the file
// step is skipped with a warning (data still migrates; serve the files from
// UPLOADS_DIR via the legacy /uploads/* route instead).
//
// Exit 0 on success, 1 on any failure. Re-running without --force is safe
// (it refuses when the target already holds data).
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { uploadToBucket } from "../server/src/storage";

const DB_PATH = process.env.DB_PATH ?? "./data/app.db";
const DATABASE_URL = process.env.DATABASE_URL;
const UPLOADS_DIR = process.env.UPLOADS_DIR ?? "./data/uploads";
const FORCE = process.argv.includes("--force");

function fail(message: string): never {
  console.error(`[migrate] FATAL: ${message}`);
  process.exit(1);
}
function info(message: string): void {
  console.log(`[migrate] ${message}`);
}

if (!DATABASE_URL) fail("DATABASE_URL is not set.");
let lite: Database;
try {
  lite = new Database(DB_PATH, { readonly: true });
} catch (e) {
  fail(`cannot open SQLite database at ${DB_PATH}: ${e instanceof Error ? e.message : String(e)}`);
}
const sql = postgres(DATABASE_URL, { max: 4 });

// --- Table inventory ---------------------------------------------------------
const liteTables = (lite.query(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_%' ESCAPE '\\'`).all() as { name: string }[])
  .map((r) => r.name);
const pgTables = (await sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`).map((r: { tablename: string }) => r.tablename as string);
const shopTables = liteTables.filter((t) => pgTables.includes(t));
const skipped = liteTables.filter((t) => !pgTables.includes(t));
if (shopTables.length === 0) fail("target Postgres has no shop tables — apply supabase/schema.sql first (or boot the server once with SKIP_SEED=1).");
if (skipped.length) info(`skipping SQLite-only tables: ${skipped.join(", ")}`);

// --- Target must be empty unless --force -------------------------------------
const counts = await sql.unsafe(
  shopTables.map((t) => `SELECT '${t}' AS t, COUNT(*)::int AS c FROM "${t}"`).join(" UNION ALL "),
) as { t: string; c: number }[];
const nonEmpty = counts.filter((r) => r.c > 0);
if (nonEmpty.length && !FORCE) {
  fail(`target already holds data (${nonEmpty.map((r) => `${r.t}:${r.c}`).join(", ")}). Re-run with --force to TRUNCATE everything first.`);
}
if (nonEmpty.length && FORCE) {
  info(`--force: truncating ${shopTables.length} tables (CASCADE, identities reset)`);
  await sql.unsafe(`TRUNCATE ${shopTables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
}

// --- FK-safe order from supabase/schema.sql ----------------------------------
// Foreign keys live in DO-blocked ALTER TABLE statements (not inline in the
// CREATE TABLE bodies), so dependencies are parsed from those statements.
const schemaSql = readFileSync("supabase/schema.sql", "utf8");
const deps = new Map<string, Set<string>>();
for (const m of schemaSql.matchAll(/ALTER TABLE "([a-z_]+)" ADD CONSTRAINT "[a-z_0-9]+"\s+FOREIGN KEY \("[a-z_0-9]+"\) REFERENCES "([a-z_]+)"/g)) {
  const child = m[1];
  const parent = m[2];
  if (child === parent) continue;
  if (!deps.has(child)) deps.set(child, new Set());
  deps.get(child)!.add(parent);
}
const ordered: string[] = [];
const pending = new Set(shopTables);
while (pending.size) {
  const ready = [...pending].filter((t) => [...(deps.get(t) ?? [])].every((d) => !pending.has(d) || d === t));
  if (!ready.length) fail(`circular foreign-key dependency among: ${[...pending].join(", ")}`);
  ready.sort();
  for (const t of ready) { pending.delete(t); ordered.push(t); }
}
info(`copy order: ${ordered.join(", ")}`);

// --- Postgres column types ----------------------------------------------------
type ColInfo = { name: string; dataType: string; isSerial: boolean };
const colTypes = new Map<string, ColInfo[]>();
for (const t of shopTables) {
  const rows = await sql`
    SELECT column_name, data_type, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${t}` as { column_name: string; data_type: string; column_default: string | null }[];
  colTypes.set(t, rows.map((r) => ({
    name: r.column_name,
    dataType: r.data_type,
    isSerial: (r.column_default ?? "").startsWith("nextval"),
  })));
}

function convert(dataType: string, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (dataType === "boolean") return Boolean(value);
  if (dataType === "timestamp with time zone" && typeof value === "number") return new Date(value);
  return value;
}

// --- Copy ---------------------------------------------------------------------
let totalRows = 0;
await sql.begin(async (tx) => {
  for (const t of shopTables) {
    const cols = colTypes.get(t)!;
    const liteCols = (lite.query(`PRAGMA table_info("${t}")`).all() as { name: string }[]).map((c) => c.name);
    const useCols = cols.filter((c) => liteCols.includes(c.name));
    const missing = liteCols.filter((c) => !cols.some((x) => x.name === c));
    if (missing.length) info(`${t}: SQLite columns absent in Postgres, skipped: ${missing.join(", ")}`);
    if (!useCols.length) { info(`${t}: no shared columns, skipped`); continue; }
    const rows = lite.query(`SELECT * FROM "${t}"`).all() as Record<string, unknown>[];
    const colList = useCols.map((c) => `"${c.name}"`).join(", ");
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      const params: unknown[] = [];
      const values = chunk.map((r) => {
        const vals = useCols.map((c) => {
          const v = convert(c.dataType, r[c.name]);
          params.push(v);
          return `$${params.length}`;
        });
        return `(${vals.join(", ")})`;
      }).join(", ");
      await tx.unsafe(`INSERT INTO "${t}" (${colList}) VALUES ${values}`, params);
    }
    totalRows += rows.length;
    info(`${t}: ${rows.length} rows`);
  }
});
info(`data copy complete: ${totalRows} rows across ${shopTables.length} tables`);

// --- Repair serial sequences ---------------------------------------------------
for (const t of shopTables) {
  const serialId = colTypes.get(t)!.find((c) => c.isSerial && c.name === "id");
  if (!serialId) continue;
  await sql.unsafe(
    `SELECT setval(pg_get_serial_sequence('"${t}"', 'id'), COALESCE((SELECT MAX("id") FROM "${t}"), 0) + 1, false)`,
  );
}
info("serial sequences repaired");

// --- Uploads -> Supabase Storage -----------------------------------------------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MIME: Record<string, string> = { ".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif" };
function bucketFor(filename: string): string | null {
  if (/^banner-[0-9a-f-]+\.(jpg|png|webp|gif)$/.test(filename)) return "banners";
  if (/^(store|sitelogo)-[0-9a-f-]+\.(jpg|png|webp|gif)$/.test(filename)) return "site-assets";
  if (/^avatar-[0-9a-f-]+\.(jpg|png|webp|gif)$/.test(filename)) return "avatars";
  if (/^[0-9a-f-]+\.(jpg|png|webp|gif)$/.test(filename)) return "product-images";
  return null;
}
if (!SUPABASE_URL || !SERVICE_KEY) {
  info("WARNING: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — skipping file migration. Legacy /uploads/* URLs stay as-is; serve them from UPLOADS_DIR via the legacy /uploads/* route.");
} else {
  let files: string[] = [];
  try {
    files = readdirSync(UPLOADS_DIR).filter((f) => /\.(jpg|png|webp|gif)$/i.test(f));
  } catch {
    info(`UPLOADS_DIR ${UPLOADS_DIR} not readable — skipping file migration.`);
  }
  const moved = new Map<string, string>(); // filename -> public URL
  for (const f of files) {
    const bucket = bucketFor(f);
    if (!bucket) { info(`uploads: skipping unrecognized filename ${f}`); continue; }
    const ext = f.slice(f.lastIndexOf(".")).toLowerCase();
    const data = readFileSync(join(UPLOADS_DIR, f));
    try {
      const url = await uploadToBucket(bucket, f, data, MIME[ext] ?? "application/octet-stream");
      moved.set(f, url);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/already exists|duplicate/i.test(msg)) {
        moved.set(f, `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${f}`);
        info(`uploads: ${f} already in ${bucket}, reusing URL`);
      } else {
        info(`uploads: WARNING failed to upload ${f}: ${msg}`);
      }
    }
  }
  info(`uploads: ${moved.size}/${files.length} files in Supabase Storage`);
  // Rewrite /uploads/<name> values to the new public URLs.
  const urlTargets: { table: string; column: string; extraWhere?: string }[] = [
    { table: "store_settings", column: "logo_url" },
    { table: "store_settings", column: "banner_url" },
    { table: "products", column: "image_url" },
    { table: "product_images", column: "url" },
    { table: "users", column: "avatar_url" },
    { table: "homepage_banners", column: "image_url" },
    { table: "platform_settings", column: "value", extraWhere: `AND "key" = 'site_logo_url'` },
  ];
  let rewrites = 0;
  for (const [filename, publicUrl] of moved) {
    const legacy = `/uploads/${filename}`;
    for (const tgt of urlTargets) {
      if (!shopTables.includes(tgt.table)) continue;
      const cols = colTypes.get(tgt.table)!.map((c) => c.name);
      if (!cols.includes(tgt.column)) continue;
      const res = await sql.unsafe(
        `UPDATE "${tgt.table}" SET "${tgt.column}" = $1 WHERE "${tgt.column}" = $2 ${tgt.extraWhere ?? ""}`,
        [publicUrl, legacy],
      ) as unknown as { count: number }[];
      const n = Array.isArray(res) ? res.reduce((a, r) => a + (r.count ?? 0), 0) : 0;
      rewrites += n;
    }
  }
  info(`uploads: rewrote ${rewrites} stored URL value(s) to Supabase public URLs`);
}

await sql.end();
lite.close();
info("done. Boot the server with SKIP_SEED=1 (schema is applied idempotently at boot; the demo seed must NOT run on migrated data).");
