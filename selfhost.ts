// Self-host server for Nepal Shopping Site.
// Serves the built storefront (client/dist) and answers the same
// POST /actions RPC the Muse-hosted version uses, backed by the
// SQLite database in ./data/app.db.
//
// Run:  bun selfhost.ts
// Env:  PORT (default 3000), DB_PATH (default ./data/app.db)

import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Actions } from "./server/src/actions";
import * as schema from "./server/src/schema";

const PORT = Number(process.env.PORT ?? 3000);
const DB_PATH = process.env.DB_PATH ?? "./data/app.db";

const sqlite = new Database(DB_PATH);
// Match the production pragmas used for the SQLite store.
sqlite.exec("PRAGMA journal_mode = WAL;");
const db = drizzle(sqlite, { schema });

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

const DIST = "./client/dist";

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // --- Action RPC: POST /actions  { action, args } -> { data } ---
    if (url.pathname === "/actions" && req.method === "POST") {
      const body = await req.json().catch(() => null);
      const def = (Actions as Record<string, any>)[body?.action];
      if (!def) {
        return Response.json({ error: `Unknown action: ${String(body?.action)}` }, { status: 404 });
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
        return Response.json({ error: zodMessage(e) }, { status: 400 });
      }
    }

    // --- Static storefront ---
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(Bun.file(`${DIST}/index.html`));
    }
    const file = Bun.file(`${DIST}${url.pathname}`);
    if (await file.exists()) return new Response(file);
    // SPA fallback
    return new Response(Bun.file(`${DIST}/index.html`));
  },
});

console.log(`Nepal Shopping Site running at http://localhost:${PORT}`);
console.log(`Database: ${DB_PATH}`);
