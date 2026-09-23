// Post-build step: run after `client/build.mjs`.
// Bun's HTML bundler copies the <link rel="manifest"> target into dist as a
// hashed asset and rewrites the href to `./assets/manifest-<hash>.webmanifest`.
// We serve the manifest dynamically from selfhost.ts (`GET /manifest.webmanifest`),
// so point the built index.html back at the canonical URL and drop the hashed copy.
import { readdir, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import { join } from "node:path";

const dist = new URL("./dist/", import.meta.url);
const indexPath = join(dist.pathname, "index.html");
let html = await readFile(indexPath, "utf8");
const match = html.match(/\.\/assets\/(manifest-[a-z0-9]+\.webmanifest)/);
if (match) {
  html = html.split(`./assets/${match[1]}`).join("/manifest.webmanifest");
  await writeFile(indexPath, html);
  await rm(join(dist.pathname, "assets", match[1]), { force: true });
  console.log(`postbuild: linked /manifest.webmanifest, removed assets/${match[1]}`);
} else {
  console.log("postbuild: no hashed manifest link found, nothing to do");
}

// sanity: dist must contain fresh hashed js/css
const assets = await readdir(join(dist.pathname, "assets"));
const js = assets.find((f) => /^index-[a-z0-9]+\.js$/.test(f));
const css = assets.find((f) => /^index-[a-z0-9]+\.css$/.test(f));
if (!js || !css) throw new Error("postbuild: missing hashed js/css assets");
if (!html.includes(js) || !html.includes(css)) throw new Error("postbuild: built index.html does not reference hashed assets");
console.log(`postbuild: ok (${js}, ${css})`);

// icons: copy client/icons/*.{png,svg} to dist root with stable filenames
// (favicons, PWA icons, maskable icon, apple-touch-icon and iOS splash
// screens must never be hashed).
const iconsDir = new URL("./icons/", import.meta.url);
const distRoot = join(dist.pathname);
let copied = 0;
for (const name of ["favicon.svg", "favicon-32.png", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png", "wordmark.png"]) {
  await copyFile(join(iconsDir.pathname, name), join(distRoot, name));
  copied++;
}
for (const f of await readdir(iconsDir)) {
  if (/^splash-\d+x\d+\.png$/.test(f)) {
    await copyFile(join(iconsDir.pathname, f), join(distRoot, f));
    copied++;
  }
}
console.log(`postbuild: copied ${copied} icons/splash screens to dist/`);

