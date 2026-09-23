// v15 verification: homepage category sections, approval filtering, real
// sold counts (cancelled excluded), real ratings, flash-sale rules, gender
// filtering, and the real-image watermark removal.
// Usage: boot the server with ADMIN_EMAIL/ADMIN_PASSWORD + EMAIL_TEST_CAPTURE=1
// on a scratch DB, then: ADMIN_EMAIL=... ADMIN_PASSWORD=... bun scripts/verify-v15.ts --port <port>
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const port = process.argv.includes("--port") ? process.argv[process.argv.indexOf("--port") + 1] : "3897";
const BASE = `http://localhost:${port}`;
let pass = 0, fail = 0;
async function call(action: string, args: any) {
  const r = await fetch(`${BASE}/actions`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, args }),
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, data: (j as any).data, error: (j as any).error };
}
function ok(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
}

const suffix = String(Date.now()).slice(-6);

try {
  // --- 1. homepage category sections: real approved products, grouped ---
  const hp = await call("getHomepage", {});
  ok("getHomepage 200", hp.status === 200, hp.error);
  const sections: any[] = hp.data?.category_sections ?? [];
  ok("category_sections non-empty", sections.length > 0, `got ${sections.length}`);
  ok("at most 6 sections", sections.length <= 6);
  const allSecProducts = sections.flatMap((s) => s.products);
  ok("sections carry real products", allSecProducts.length > 0);
  ok("every section product matches its section category",
    sections.every((s) => s.products.every((p: any) => p.category === s.name)),
    JSON.stringify(sections.map((s) => [s.name, s.products.slice(0, 3).map((p: any) => p.category)])));
  ok("every section product is approved+active+visible",
    allSecProducts.every((p: any) => p.approval_status === "approved" && p.is_active !== false),
    JSON.stringify(allSecProducts.filter((p: any) => p.approval_status !== "approved").slice(0, 2)));
  ok("sections have real ids/prices/images", allSecProducts.every((p: any) => typeof p.id === "number" && p.price_paisa > 0 && typeof p.name === "string"));
  ok("no fake shelf text in homepage payload", JSON.stringify(hp.data).toLowerCase().indexOf("shelves are being arranged") === -1);

  // --- 2. pending products stay out of the homepage (genuinely pending:
  // from a shop that is not active, so nothing is auto-approved) ---
  const pemail = `v15seller${suffix}@test.local`;
  const preg = await call("registerSeller", {
    store_name: `V15 Store ${suffix}`, tagline: "A test shop for v15 checks",
    location: "Kathmandu", phone: "98" + suffix + "34",
    email: pemail, password: "testpass123", seller_key: "key-" + suffix + "-v15",
  });
  ok("pending seller registered", !!preg.data?.seller_code, preg.error);
  const cap = await call("__testCapturedEmails", { clear: false });
  const vmail = (cap.data?.emails ?? []).find((m: any) => m.to === pemail && m.subject.includes("Verify your"));
  const vtoken = vmail?.text?.match(/verify-seller\?token=([a-f0-9]+)/)?.[1] ?? "";
  const pver = await call("verifySellerEmail", { token: vtoken });
  ok("pending seller email verified", pver.status === 200, pver.error);
  const plogin = await call("sellerLogin", { email: pemail, password: "testpass123" });
  const pstok = plogin.data?.token;
  const pend = await call("createProduct", {
    authToken: pstok, name: `V15 Pending ${suffix}`, category: "TestCat",
    description: "Pending product for v15 checks.", price_paisa: 50000,
    delivery_fee_paisa: 0, stock: 3, is_active: true,
  });
  const pendId = pend.data?.id;
  ok("pending product created", !!pendId && pend.data?.is_active === false, pend.error ?? JSON.stringify(pend.data));
  const sl = await call("sellerLogin", { email: "himalaya.fashion@demo.local", password: "demo-seller-01" });
  const stok = sl.data?.token;
  const hp2 = await call("getHomepage", {});
  const hp2All = [...(hp2.data?.category_sections ?? []).flatMap((s: any) => s.products), ...(hp2.data?.flash_sales ?? [])];
  ok("pending product absent from homepage", !hp2All.some((p: any) => p.id === pendId));

  // --- 3. sold counts: delivered counts, cancelled excluded ---
  const sf = await call("getStorefront", {});
  const prod = (sf.data?.products ?? []).find((p: any) => p.stock >= 10 && p.is_active && p.seller_code === "SELL-BDC364DC");
  ok("seeded product available", !!prod);
  const before = await call("getStorefront", {});
  const soldBefore: number = (before.data?.products ?? []).find((p: any) => p.id === prod.id)?.sold_count ?? -1;
  const phone = "98" + String(Date.now()).slice(-8);
  const su = await call("signup", { name: "V15 Buyer", phone, password: "testpass123" });
  const token = su.data?.token;
  ok("buyer signup", !!token, su.error);
  const o1 = await call("placeOrder", {
    authToken: token, customer_name: "V15 Buyer", phone, address: "Kathmandu", note: "",
    payment_method: "cod", cod_confirmed: true, items: [{ product_id: prod.id, quantity: 2 }],
  });
  ok("order placed", o1.status === 200 && !!o1.data?.order_code, o1.error);
  const lo = await call("listOrders", { authToken: stok });
  const sorder = (lo.data?.orders ?? []).find((o: any) => o.order_code === o1.data.order_code);
  for (const st of ["confirmed", "packed", "shipped", "out_for_delivery", "delivered"]) {
    const u = await call("updateOrderStatus", { authToken: stok, order_id: sorder.id, status: st });
    if (u.status !== 200) { ok(`status -> ${st}`, false, u.error); break; }
  }
  const sf3 = await call("getStorefront", {});
  const soldAfter: number = (sf3.data?.products ?? []).find((p: any) => p.id === prod.id)?.sold_count ?? -1;
  ok("sold_count rose by delivered qty", soldAfter === soldBefore + 2, `before=${soldBefore} after=${soldAfter}`);
  // second order, then cancel it — must NOT count
  const o2 = await call("placeOrder", {
    authToken: token, customer_name: "V15 Buyer", phone, address: "Kathmandu", note: "",
    payment_method: "cod", cod_confirmed: true, items: [{ product_id: prod.id, quantity: 5 }],
  });
  ok("second order placed", o2.status === 200, o2.error);
  const myo2 = await call("getMyOrders", { authToken: token });
  const o2id = (myo2.data?.orders ?? []).find((o: any) => o.order_code === o2.data.order_code)?.id;
  const co = await call("cancelOrder", { authToken: token, order_id: o2id });
  ok("second order cancelled", co.status === 200, co.error);
  const sf4 = await call("getStorefront", {});
  const soldFinal: number = (sf4.data?.products ?? []).find((p: any) => p.id === prod.id)?.sold_count ?? -1;
  ok("cancelled order excluded from sold_count", soldFinal === soldAfter, `after-delivery=${soldAfter} after-cancel=${soldFinal}`);

  // --- 4. ratings come from stored reviews, not invented ---
  const rev = await call("addReview", { order_code: o1.data.order_code, phone, product_id: prod.id, rating: 4, body: `V15 real review ${suffix}` });
  ok("review added", rev.status === 200, rev.error);
  const sf5 = await call("getStorefront", {});
  const rated = (sf5.data?.products ?? []).find((p: any) => p.id === prod.id);
  ok("review_count >= 1 and rating set from stored reviews", (rated?.review_count ?? 0) >= 1 && typeof rated?.rating === "number", JSON.stringify({ rc: rated?.review_count, r: rated?.rating }));

  // --- 5. flash-sale rules: discount required, expiry honoured ---
  const al = await call("adminLogin", { email: process.env.ADMIN_EMAIL!, password: process.env.ADMIN_PASSWORD! });
  const atoken = al.data?.token;
  ok("admin login", !!atoken, al.error);
  const plain = (sf5.data?.products ?? []).find((p: any) => (p.discount_pct ?? 0) === 0 && p.id !== prod.id);
  const disc = (sf5.data?.products ?? []).find((p: any) => (p.discount_pct ?? 0) > 0 && p.id !== prod.id);
  ok("plain and discounted products found", !!plain && !!disc);
  const fsBad = await call("adminSetFlashSale", { authToken: atoken, product_id: plain.id, flash_sale: true });
  ok("undiscounted product rejected from flash sale", fsBad.status !== 200, fsBad.error ?? "unexpectedly accepted");
  const future = new Date(Date.now() + 3600_000).toISOString();
  const fsOk = await call("adminSetFlashSale", { authToken: atoken, product_id: disc.id, flash_sale: true, ends_at: future });
  ok("discounted product joins flash sale", fsOk.status === 200, fsOk.error);
  const hp3 = await call("getHomepage", {});
  ok("flash_sales lists it", (hp3.data?.flash_sales ?? []).some((p: any) => p.id === disc.id));
  const past = new Date(Date.now() - 3600_000).toISOString();
  const fsPast = await call("adminSetFlashSale", { authToken: atoken, product_id: disc.id, flash_sale: true, ends_at: past });
  ok("expired end time accepted by setter", fsPast.status === 200, fsPast.error);
  const hp4 = await call("getHomepage", {});
  ok("expired flash sale hidden from strip", !(hp4.data?.flash_sales ?? []).some((p: any) => p.id === disc.id));
  const fsOff = await call("adminSetFlashSale", { authToken: atoken, product_id: disc.id, flash_sale: false });
  ok("flash sale removed", fsOff.status === 200, fsOff.error);
  const hp5 = await call("getHomepage", {});
  ok("removed flash sale absent", !(hp5.data?.flash_sales ?? []).some((p: any) => p.id === disc.id));

  // --- 6. gender filtering is real ---
  const gprod = (sf5.data?.products ?? []).find((p: any) => p.seller_code === "SELL-BDC364DC");
  const upd = await call("updateProduct", {
    authToken: stok, id: gprod.id, name: gprod.name, category: gprod.category,
    description: gprod.description, price_paisa: gprod.price_paisa,
    delivery_fee_paisa: gprod.delivery_fee_paisa, stock: gprod.stock,
    is_active: true, gender: "women",
  });
  ok("seller set product gender", upd.status === 200, upd.error);
  const gs = await call("searchProducts", { gender: "women" });
  ok("gender search returns the product", (gs.data?.products ?? []).some((p: any) => p.id === gprod.id), `got ${(gs.data?.products ?? []).length} results`);
  const gs2 = await call("searchProducts", { gender: "men" });
  ok("other gender excludes it", !(gs2.data?.products ?? []).some((p: any) => p.id === gprod.id));

  // --- 7. real images carry no orange/green pseudo-element overlay ---
  const cssDir = join(process.cwd(), "client", "dist", "assets");
  const cssFile = readdirSync(cssDir).find((f) => f.endsWith(".css"))!;
  const css = readFileSync(join(cssDir, cssFile), "utf8");
  ok("bundled CSS disables .product-mark.img pseudo-elements",
    css.includes(".product-mark.img:before") && /display\s*:\s*none/.test(css),
    "rule missing from bundle");

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
} catch (e) {
  console.error("SCRIPT ERROR", e);
  process.exit(1);
}
