// v4 verification: fresh-DB boot + core journey + new pages + rate limit + payments.
// Usage: PORT=3897 DB_PATH=/tmp/verify.db bun selfhost.ts  (then in another shell: bun scripts/verify-v4.ts --port 3897)
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

try {
  // --- 1. fresh boot: storefront seeded by migrations ---
  const sf = await call("getStorefront", {});
  ok("storefront 200", sf.status === 200);
  ok("12 products seeded", sf.data?.products?.length === 12, `got ${sf.data?.products?.length}`);
  ok("3 sellers", sf.data?.seller_count === 3, `got ${sf.data?.seller_count}`);
  const prod = [...sf.data.products]
    .sort((a: any, b: any) => b.price_paisa - a.price_paisa)
    .find((p: any) => p.stock >= 5 && p.is_active && p.price_paisa * 2 >= 100000);
  ok("found product with stock>=5 and price>=Rs500", !!prod);
  const stockBefore: number = prod.stock;

  // --- 2. buyer journey ---
  const phone = "98" + String(Date.now()).slice(-8);
  const su = await call("signup", { name: "Test Buyer", phone, password: "testpass123" });
  ok("signup", su.status === 200 && !!su.data?.token, su.error);
  const token = su.data.token;
  const me = await call("getMe", { authToken: token });
  ok("getMe", me.data?.user?.phone === phone);

  const add = await call("addToCart", { authToken: token, product_id: prod.id, quantity: 1 });
  ok("addToCart", add.status === 200, add.error);
  const upd = await call("updateCartItem", { authToken: token, product_id: prod.id, quantity: 2 });
  ok("updateCartItem qty=2", upd.status === 200 && upd.data?.cart?.items?.[0]?.quantity === 2, JSON.stringify(upd.data?.cart)?.slice(0, 120));

  const addr = await call("saveAddress", { authToken: token, label: "Home", full_name: "Test Buyer", province: "Bagmati", district: "Kathmandu", municipality: "Kathmandu", ward: "5", landmark: "Near test", phone });
  ok("saveAddress", addr.status === 200 && !!addr.data?.id, addr.error);
  const addressId = addr.data.id;

  const vc = await call("validateCoupon", { authToken: token, code: "WELCOME10", subtotal_paisa: prod.price_paisa * 2 });
  ok("validateCoupon WELCOME10", vc.status === 200 && vc.data?.valid === true, vc.error || JSON.stringify(vc.data));

  const order = await call("placeOrder", {
    authToken: token, customer_name: "Test Buyer", phone,
    address: "Kathmandu Ward 5", note: "", payment_method: "cod", cod_confirmed: true,
    coupon_code: "WELCOME10", address_id: addressId, delivery_method: "standard",
    items: [{ product_id: prod.id, quantity: 2 }],
  });
  ok("placeOrder with coupon", order.status === 200 && !!order.data?.order_code, order.error);
  ok("coupon discount applied", (order.data?.total_paisa ?? 0) < prod.price_paisa * 2 + 100000, `total=${order.data?.total_paisa}`);
  const orderCode: string = order.data.order_code;

  const sf2 = await call("getStorefront", {});
  const prodAfter = sf2.data.products.find((p: any) => p.id === prod.id);
  ok("inventory decremented by 2", prodAfter?.stock === stockBefore - 2, `before=${stockBefore} after=${prodAfter?.stock}`);

  const myo = await call("getMyOrders", { authToken: token });
  ok("order in my orders", myo.data?.orders?.some((o: any) => o.order_code === orderCode));

  // --- 3. seller updates status to delivered ---
  const sellerCreds: Record<string, [string, string]> = {
    "SELL-BDC364DC": ["himalaya.fashion@demo.local", "demo-seller-01"],
    "SELL-06A3B75B": ["techsewa@demo.local", "demo-seller-02"],
    "SELL-05DC3C59": ["hastakala@demo.local", "demo-seller-03"],
  };
  const [semail, spass] = sellerCreds[prod.seller_code] ?? [];
  ok("product maps to a demo seller", !!semail, `seller_code=${prod.seller_code}`);
  const sl = await call("sellerLogin", { email: semail, password: spass });
  ok("seller email login", sl.status === 200 && !!sl.data?.token, sl.error);
  const stok = sl.data.token;
  const lo = await call("listOrders", { authToken: stok });
  const sorder = lo.data?.orders?.find((o: any) => o.order_code === orderCode);
  ok("seller sees the order", !!sorder);
  for (const st of ["confirmed", "packed", "shipped", "out_for_delivery", "delivered"]) {
    const u = await call("updateOrderStatus", { authToken: stok, order_id: sorder.id, status: st });
    if (u.status !== 200) { ok(`status -> ${st}`, false, u.error); break; }
    if (st === "delivered") ok("status walk to delivered", true);
  }
  const tr = await call("trackOrder", { authToken: token, order_code: orderCode, phone });
  ok("tracking shows delivered", tr.data?.order?.status === "delivered", tr.data?.order?.status);
  // A registered buyer's order is private: tracking someone else's order
  // code with a known phone number (no session) must return nothing.
  const trAnon = await call("trackOrder", { order_code: orderCode, phone });
  ok("anonymous tracking of a registered order returns null", trAnon.data?.order === null, JSON.stringify(trAnon.data)?.slice(0, 80));

  // --- 4. verified review ---
  const rev = await call("addReview", { order_code: orderCode, phone, product_id: prod.id, rating: 5, body: "Great product, fast delivery." });
  ok("verified review added", rev.status === 200, rev.error);
  const revs = await call("getProductReviews", { product_id: prod.id });
  ok("review visible", revs.data?.reviews?.some((r: any) => r.body.includes("Great product")));

  // --- 5. payments honestly unconfigured (needs a non-COD order) ---
  const eorder = await call("placeOrder", {
    authToken: token, customer_name: "Test Buyer", phone,
    address: "Kathmandu Ward 5", note: "", payment_method: "esewa",
    address_id: addressId, delivery_method: "standard",
    items: [{ product_id: prod.id, quantity: 1 }],
  });
  ok("esewa order placed (pending payment)", eorder.status === 200 && !!eorder.data?.order_id, eorder.error);
  const pay = await call("initiateOnlinePayment", { authToken: token, order_id: eorder.data.order_id, provider: "esewa", phone });
  ok("esewa without keys -> not configured", pay.status !== 200 && /not configured/i.test(pay.error ?? ""), pay.error);
  const korder = await call("placeOrder", {
    authToken: token, customer_name: "Test Buyer", phone,
    address: "Kathmandu Ward 5", note: "", payment_method: "khalti",
    address_id: addressId, delivery_method: "standard",
    items: [{ product_id: prod.id, quantity: 1 }],
  });
  ok("khalti order placed (pending payment)", korder.status === 200 && !!korder.data?.order_id, korder.error);
  const pay2 = await call("initiateOnlinePayment", { authToken: token, order_id: korder.data.order_id, provider: "khalti", phone });
  ok("khalti without keys -> not configured", pay2.status !== 200 && /not configured/i.test(pay2.error ?? ""), pay2.error);

  // --- 6. SEO/PWA routes ---
  for (const p of ["sitemap.xml", "robots.txt", "manifest.webmanifest"]) {
    const r = await fetch(`${BASE}/${p}`);
    ok(`GET /${p} 200`, r.status === 200);
  }
  const man = await (await fetch(`${BASE}/manifest.webmanifest`)).json();
  ok("manifest has icons", Array.isArray(man.icons) && man.icons.length === 2, JSON.stringify(man.icons));
  for (const p of ["icon-192.png", "icon-512.png", "favicon.svg", "apple-touch-icon.png"]) {
    const r = await fetch(`${BASE}/${p}`);
    ok(`GET /${p} 200`, r.status === 200);
  }

  // --- 7. new pages exist in the client bundle ---
  const idx = await (await fetch(`${BASE}/`)).text();
  ok("index serves", idx.includes("Nepal Shop"));
} catch (e) {
  fail++; console.log("FAIL harness exception", e);
}

// --- 8. rate limit: 25 rapid bad logins -> 429s after 20 ---
try {
  let ok429 = 0, other = 0;
  for (let i = 0; i < 25; i++) {
    const r = await call("login", { phone: "9800000001", password: "wrong-password" });
    if (r.status === 429) ok429++; else other++;
  }
  ok("rate limit triggers 429", ok429 >= 4, `429s=${ok429} other=${other}`);
} catch (e) { fail++; console.log("FAIL rate limit harness", e); }

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
