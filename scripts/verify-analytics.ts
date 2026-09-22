// Checkpoint 19 (Analytics) verification: real funnel over real HTTP.
// Usage: boot a fresh server first, e.g.
//   PORT=3899 DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres EMAIL_TEST_CAPTURE=1 bun selfhost.ts
// then: bun scripts/verify-analytics.ts --port 3899
const port = process.argv.includes("--port") ? process.argv[process.argv.indexOf("--port") + 1] : "3899";
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
const hasPII = (o: any, phone: string, email: string) => {
  const s = JSON.stringify(o ?? {});
  return s.includes(phone) || s.includes(email);
};

try {
  // --- 1. baseline: snapshot the funnel before generating events ---
  const al = await call("adminLogin", { email: "admin@nepalshop.local", password: "Admin@123" });
  ok("admin login", al.status === 200 && !!al.data?.token, al.error);
  const atok = al.data.token;
  const base = await call("adminAnalytics", { authToken: atok });
  ok("adminAnalytics 200", base.status === 200, base.error);
  const f0 = base.data.funnel;
  ok("funnel present", !!f0 && typeof f0.cart_abandonment_pct === "number", JSON.stringify(f0)?.slice(0, 120));

  // --- 2. buyer journey generates funnel events ---
  const phone1 = "98" + String(Date.now()).slice(-8);
  const email1 = `buyer1-${Date.now()}@example.com`;
  const su = await call("signup", { name: "Funnel Buyer", phone: phone1, password: "testpass123" });
  ok("buyer signup", su.status === 200 && !!su.data?.token, su.error);
  const t1 = su.data.token;

  const sf = await call("getStorefront", {});
  const prod = [...sf.data.products].sort((a: any, b: any) => b.price_paisa - a.price_paisa)
    .find((p: any) => p.stock >= 5 && p.is_active);
  ok("test product found", !!prod);

  // 3 rapid product views -> deduped to 1
  await call("getProductDetail", { authToken: t1, product_id: prod.id });
  await call("getProductDetail", { authToken: t1, product_id: prod.id });
  await call("getProductDetail", { authToken: t1, product_id: prod.id });

  // 2 addToCart calls -> deduped to 1 add_to_cart event
  const a1 = await call("addToCart", { authToken: t1, product_id: prod.id, quantity: 1 });
  ok("addToCart", a1.status === 200, a1.error);
  const a2 = await call("addToCart", { authToken: t1, product_id: prod.id, quantity: 1 });
  ok("addToCart again", a2.status === 200, a2.error);

  // checkout start x2 -> deduped to 1
  const c1 = await call("trackCheckoutStart", { authToken: t1 });
  ok("trackCheckoutStart records", c1.status === 200 && c1.data?.recorded === true, c1.error || JSON.stringify(c1.data));
  const c2 = await call("trackCheckoutStart", { authToken: t1 });
  ok("trackCheckoutStart deduped", c2.status === 200 && c2.data?.recorded === false, JSON.stringify(c2.data));

  // purchase
  const addr = await call("saveAddress", { authToken: t1, label: "Home", full_name: "Funnel Buyer", province: "Bagmati", district: "Kathmandu", municipality: "Kathmandu", ward: "5", landmark: "x", phone: phone1 });
  ok("saveAddress", addr.status === 200, addr.error);
  const order = await call("placeOrder", {
    authToken: t1, customer_name: "Funnel Buyer", phone: phone1,
    address: "Kathmandu Ward 5", note: "", payment_method: "cod", cod_confirmed: true,
    address_id: addr.data.id, delivery_method: "standard",
    items: [{ product_id: prod.id, quantity: 1 }],
  });
  ok("placeOrder COD", order.status === 200 && !!order.data?.order_code, order.error);
  const orderCode = order.data.order_code;

  // --- 3. second buyer abandons: views + cart + checkout, no order ---
  const phone2 = "98" + String(Date.now() + 7).slice(-8);
  const su2 = await call("signup", { name: "Abandon Buyer", phone: phone2, password: "testpass123" });
  ok("buyer2 signup", su2.status === 200, su2.error);
  const t2 = su2.data.token;
  await call("getProductDetail", { authToken: t2, product_id: prod.id });
  await call("addToCart", { authToken: t2, product_id: prod.id, quantity: 1 });
  await call("trackCheckoutStart", { authToken: t2 });

  // --- 4. admin funnel reflects exactly what happened ---
  const an = await call("adminAnalytics", { authToken: atok });
  const f = an.data.funnel;
  const d = (k: string) => f[k] - f0[k];
  const pct4 = (n: number, den: number) => (den ? Math.round((n / den) * 10000) / 100 : 0);
  ok("views +2 (deduped per buyer)", d("views_30d") === 2, `delta=${d("views_30d")}`);
  ok("add_to_cart +2 (deduped)", d("add_to_cart_30d") === 2, `delta=${d("add_to_cart_30d")}`);
  ok("checkout_start +2 (deduped)", d("checkout_start_30d") === 2, `delta=${d("checkout_start_30d")}`);
  ok("purchases +1", d("purchases_30d") === 1, `delta=${d("purchases_30d")}`);
  // Conversion rates are internally consistent with the underlying counts.
  ok("view_to_cart_pct consistent", f.view_to_cart_pct === pct4(f.add_to_cart_30d, f.views_30d), `got ${f.view_to_cart_pct}`);
  ok("cart_to_checkout_pct consistent", f.cart_to_checkout_pct === pct4(f.checkout_start_30d, f.add_to_cart_30d), `got ${f.cart_to_checkout_pct}`);
  ok("checkout_to_purchase_pct consistent", f.checkout_to_purchase_pct === pct4(f.purchases_30d, f.checkout_start_30d), `got ${f.checkout_to_purchase_pct}`);
  // On a pristine DB the journey above is the whole funnel: every viewer
  // added to cart, every cart reached checkout, one of two checkouts bought.
  if (f0.views_30d === 0 && f0.add_to_cart_30d === 0) {
    ok("pristine: view_to_cart == 100", f.view_to_cart_pct === 100, `got ${f.view_to_cart_pct}`);
    ok("pristine: cart_to_checkout == 100", f.cart_to_checkout_pct === 100, `got ${f.cart_to_checkout_pct}`);
    ok("pristine: checkout_to_purchase == 50", f.checkout_to_purchase_pct === 50, `got ${f.checkout_to_purchase_pct}`);
  }
  ok("cart_abandonment_pct == 50", f.cart_abandonment_pct === 50, `got ${f.cart_abandonment_pct}`);
  ok("totals consistent", an.data.totals.orders_30d === f.purchases_30d && an.data.totals.customers_30d >= 1,
    JSON.stringify(an.data.totals));
  ok("no buyer PII in admin analytics", !hasPII(an.data, phone1, email1) && !hasPII(an.data, phone2, "x"),
    "leak!");

  // --- 5. auth boundaries on analytics ---
  const noAuth = await call("adminAnalytics", {});
  ok("adminAnalytics requires admin", noAuth.status !== 200, `status=${noAuth.status}`);
  const buyerAdmin = await call("adminAnalytics", { authToken: t1 });
  ok("buyer cannot read admin analytics", buyerAdmin.status !== 200, `status=${buyerAdmin.status}`);
  const badTrack = await call("trackCheckoutStart", {});
  ok("trackCheckoutStart requires auth", badTrack.status !== 200, `status=${badTrack.status}`);
  const badTrack2 = await call("trackCheckoutStart", { authToken: "not-a-real-token-12345" });
  ok("trackCheckoutStart rejects bad token", badTrack2.status !== 200, `status=${badTrack2.status}`);

  // --- 6. seller analytics: own performance only ---
  const sellerCreds: Record<string, [string, string]> = {
    "SELL-BDC364DC": ["himalaya.fashion@demo.local", "demo-seller-01"],
    "SELL-06A3B75B": ["techsewa@demo.local", "demo-seller-02"],
    "SELL-05DC3C59": ["hastakala@demo.local", "demo-seller-03"],
  };
  const [semail, spass] = sellerCreds[prod.seller_code] ?? [];
  const sl = await call("sellerLogin", { email: semail, password: spass });
  ok("seller login", sl.status === 200, sl.error);
  const stok = sl.data.token;
  const sa = await call("sellerAnalytics", { authToken: stok });
  ok("sellerAnalytics 200", sa.status === 200, sa.error);
  ok("seller sees own product views", sa.data.product_views_30d >= 2, `views=${sa.data.product_views_30d}`);
  ok("seller view_to_order_pct sane", sa.data.view_to_order_pct > 0 && sa.data.view_to_order_pct <= 100, `pct=${sa.data.view_to_order_pct}`);
  // Fulfilment time: null on a pristine seller, otherwise a real number
  // averaged over delivered orders (a previous run's delivered order counts
  // honestly — it is this seller's real performance).
  const fulfilBefore = sa.data.avg_fulfilment_days;
  ok("fulfilment time honest before delivery",
    fulfilBefore === null || (typeof fulfilBefore === "number" && fulfilBefore >= 0),
    `got ${fulfilBefore}`);
  ok("no buyer PII in seller analytics", !hasPII(sa.data, phone1, email1), "leak!");
  const buyerSeller = await call("sellerAnalytics", { authToken: t1 });
  ok("buyer cannot read seller analytics", buyerSeller.status !== 200, `status=${buyerSeller.status}`);

  // another seller sees none of this seller's views
  const otherCode = Object.keys(sellerCreds).find((c) => c !== prod.seller_code)!;
  const sl2 = await call("sellerLogin", { email: sellerCreds[otherCode][0], password: sellerCreds[otherCode][1] });
  const sa2 = await call("sellerAnalytics", { authToken: sl2.data.token });
  ok("other seller sees zero views of this product", sa2.data.product_views_30d === 0, `views=${sa2.data.product_views_30d}`);

  // walk the order to delivered -> fulfilment time becomes real
  const lo = await call("listOrders", { authToken: stok });
  const sorder = lo.data?.orders?.find((o: any) => o.order_code === orderCode);
  ok("seller sees the order", !!sorder);
  for (const st of ["confirmed", "packed", "shipped", "out_for_delivery", "delivered"]) {
    const u = await call("updateOrderStatus", { authToken: stok, order_id: sorder.id, status: st });
    if (u.status !== 200) { ok(`status -> ${st}`, false, u.error); break; }
  }
  const sa3 = await call("sellerAnalytics", { authToken: stok });
  ok("avg fulfilment days real after delivery",
    typeof sa3.data.avg_fulfilment_days === "number" && sa3.data.avg_fulfilment_days >= 0,
    `got ${sa3.data.avg_fulfilment_days}`);
} catch (e) {
  fail++; console.log("FAIL harness exception", e);
}

// --- 7. rate limit: 70 rapid trackCheckoutStart -> 429s after 60 (separate buyer) ---
try {
  const phone3 = "98" + String(Date.now() + 99).slice(-8);
  const su3 = await call("signup", { name: "Rate Buyer", phone: phone3, password: "testpass123" });
  const t3 = su3.data?.token;
  let ok429 = 0, other = 0;
  for (let i = 0; i < 70; i++) {
    const r = await call("trackCheckoutStart", { authToken: t3 });
    if (r.status === 429) ok429++; else other++;
  }
  ok("rate limit triggers 429 on tracking endpoint", ok429 >= 5, `429s=${ok429} other=${other}`);
} catch (e) { fail++; console.log("FAIL rate-limit harness", e); }

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
