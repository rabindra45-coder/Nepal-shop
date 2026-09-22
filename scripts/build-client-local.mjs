// Local client build for the Render zip (selfhost.ts serves client/dist).
// Mirrors node_modules/@hatch/space-sdk/dist/build.js buildClient() without
// touching its guard: this project ships as a zip to Render, never through
// the Hatch artifact pipeline, so dist must be rebuilt by hand here.
import { cp, rm } from "node:fs/promises";
import { basename } from "node:path";
import tailwindPlugin from "bun-plugin-tailwind";

const ENTRY = "./client/index.html";
const OUTDIR = "./client/dist";
// Static brand files referenced by unhashed URL (the manifest, index.html and
// the verify suite expect /icon-192.png, /icon-512.png, /favicon.svg and
// /apple-touch-icon.png at the site root — not the hashed asset copies Bun
// emits). They must be copied into dist after the bundle is written.
const STATIC_DIRS = ["./client/icons"];

await rm(OUTDIR, { force: true, recursive: true });
const result = await Bun.build({
  entrypoints: [ENTRY],
  outdir: OUTDIR,
  minify: true,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  naming: {
    asset: "assets/[name]-[hash].[ext]",
    chunk: "assets/[name]-[hash].[ext]",
    entry: "[name].[ext]",
  },
  plugins: [tailwindPlugin],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error("client build failed");
}
const assetFiles = result.outputs
  .filter((o) => o.kind === "asset")
  .map((o) => basename(o.path));
if (assetFiles.length > 0) {
  for (const output of result.outputs) {
    if (!/\.(js|css|html)$/.test(output.path)) continue;
    let text = await output.text();
    let changed = false;
    for (const name of assetFiles) {
      const bare = `./${name}`;
      if (text.includes(bare)) {
        text = text.split(bare).join(`./assets/${name}`);
        changed = true;
      }
    }
    if (changed) await Bun.write(output.path, text);
  }
}
for (const dir of STATIC_DIRS) {
  await cp(dir, OUTDIR, { recursive: true });
}
console.log("client/dist rebuilt:", result.outputs.length, "outputs");
