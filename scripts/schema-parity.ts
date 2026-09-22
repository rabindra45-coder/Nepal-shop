// Schema parity: the drizzle schema (server/src/schema.ts) and the
// authoritative SQL applied at boot (supabase/schema.sql) must define the
// same tables. Run in CI and after any schema change:
//
//   bun scripts/schema-parity.ts   (exit 0 = match, exit 1 = mismatch)
import { readFileSync } from "node:fs";

const drizzleTables = new Set(
  [...readFileSync("server/src/schema.ts", "utf8").matchAll(/pgTable\(\s*"([a-z_]+)"/g)].map((m) => m[1]),
);
const sqlTables = new Set(
  [...readFileSync("supabase/schema.sql", "utf8").matchAll(/CREATE TABLE IF NOT EXISTS "([a-z_]+)"/g)].map((m) => m[1]),
);

const missing = [...drizzleTables].filter((t) => !sqlTables.has(t));
const extra = [...sqlTables].filter((t) => !drizzleTables.has(t));
if (missing.length || extra.length) {
  if (missing.length) console.error("in drizzle schema but missing from supabase/schema.sql:", missing.join(", "));
  if (extra.length) console.error("in supabase/schema.sql but missing from drizzle schema:", extra.join(", "));
  process.exit(1);
}
console.log(`schema parity OK: ${drizzleTables.size} tables in both`);
