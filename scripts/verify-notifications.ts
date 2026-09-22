// Checkpoint 18 — notifications verification.
// Fresh-DB boot with EMAIL_TEST_CAPTURE=1, then exercises every email trigger
// over real HTTP and asserts each renders a well-formed captured email.
// A second phase boots WITHOUT capture/SMTP (honest {sent:false}) and a
// third with a dead SMTP host (failure must not break checkout).
//
// Usage: PORT=3899 DB_PATH=/tmp/notify-test.db bun selfhost.ts   (shell 1)
//        bun scripts/verify-notifications.ts --port 3899          (shell 2)
// The script boots its own servers on ports --port/--port+1/--port+2 instead.
const portArg = process.argv.includes("--port") ? Number(process.argv[process.argv.indexOf("--port") + 1]) : 3899;
const BASE = `http://localhost:${portArg}`;
const BASE_B = `http://localhost:${portArg + 1}`;
const BASE_C = `http://localhost:${portArg + 2}`;

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
}
async function call(base: string, action: string, args: any) {
  const r = await fetch(`${base}/actions`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, args }),
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, data: (j as any).data, error: (j as any).error };
}
interface Cap { to: string; subject: string; text: string; at: string }
async function captured(clear = false): Promise<Cap[]> {
  const r = await call(BASE, "__testCapturedEmails", { clear });
  return r.data?.emails ?? [];
}
function wellFormed(e: Cap): boolean {
  return !!e.to && e.to.includes("@") && !!e.subject && !!e.text && e.text.length > 20
    && !e.text.includes("password_hash") && !e.text.includes("session_token");
}
function findMails(mails: Cap[], to: string, subj: string): Cap[] {
  return mails.filter((m) => m.to.toLowerCase() === to.toLowerCase() && m.subject.includes(subj));
}
async function freePort(port: number) {
  // A crashed earlier run can leave a server holding the port; make sure
  // the server we boot is the one answering.
  for (let i = 0; i < 20; i++) {
    let busy = false;
    try { const s = await Bun.connect({ hostname: "127.0.0.1", port }); s.end(); busy = true; } catch { /* free */ }
    if (!busy) return;
    await Bun.spawn(["pkill", "-f", "[s]elfhost.ts"]).exited.catch(() => {});
    await Bun.sleep(500);
  }
  throw new Error(`port ${port} still busy after cleanup`);
}
async function boot(env: Record<string, string>, logFile: string) {
  const port = Number(env.PORT);
  await freePort(port);
  const proc = Bun.spawn(["bun", "selfhost.ts"], {
    cwd: process.cwd(), env: { ...process.env, ...env },
    stdout: "ignore", stderr: Bun.file(logFile),
  });
  // wait for readiness
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${env.BASE_URL}/actions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "getStorefront", args: {} }) });
      if (r.status === 200) break;
    } catch { /* not up yet */ }
    await Bun.sleep(500);
  }
  return proc;
}
async function serverLog(path: string): Promise<string> {
  await Bun.sleep(400);
  try { return await Bun.file(path).text(); } catch { return ""; }
}

const SELLER_CREDS: Record<string, [string, string]> = {
  "SELL-BDC364DC": ["himalaya.fashion@demo.local", "demo-seller-01"],
  "SELL-06A3B75B": ["techsewa@demo.local", "demo-seller-02"],
  "SELL-05DC3C59": ["hastakala@demo.local", "demo-seller-03"],
};

try {
  // ================= phase 1: capture mode =================
  console.log("--- phase 1: capture mode ---");
  const dbA = `/tmp/notify-a-${Date.now()}.db`;
  const srvA = await boot({ PORT: String(portArg), DB_PATH: dbA, EMAIL_TEST_CAPTURE: "1", ADMIN_EMAIL: "admin-test@nepalshop.test", BASE_URL: BASE }, "/tmp/notify-a.log");

  // --- 1. signup: welcome + verification emails ---
  await captured(true);
  const ts = Date.now();
  const buyerEmail = `buyer${ts}@test.local`;
  const phone = "98" + String(ts).slice(-8);
  const su = await call(BASE, "signup", { name: "Notify Buyer", phone, email: buyerEmail, password: "testpass123" });
  ok("signup 200", su.status === 200 && !!su.data?.token, su.error);
  const buyerToken = su.data.token;
  let mails = await captured();
  ok("welcome email captured", findMails(mails, buyerEmail, "Welcome to Nepal Shop").length === 1);
  const vmail = findMails(mails, buyerEmail, "verify your email address");
  ok("verification email captured", vmail.length === 1);
  ok("verification email well-formed", vmail.length === 1 && wellFormed(vmail[0]));
  const vtok = vmail[0]?.text.match(/verify-buyer\?token=([a-f0-9]+)/)?.[1] ?? "";
  ok("verification token extractable", vtok.length > 20);
  const vv = await call(BASE, "verifyBuyerEmail", { token: vtok });
  ok("verifyBuyerEmail ok", vv.status === 200 && vv.data?.already_verified === false, vv.error);
  const vv2 = await call(BASE, "verifyBuyerEmail", { token: vtok });
  ok("verifyBuyerEmail replay -> already_verified", vv2.status === 200 && vv2.data?.already_verified === true, vv2.error);
  const vb = await call(BASE, "verifyBuyerEmail", { token: "deadbeefdeadbeefdeadbeef" });
  ok("verifyBuyerEmail bad token rejected", vb.status !== 200);
  const prefs = await call(BASE, "getNotificationPrefs", { authToken: buyerToken });
  ok("prefs: order emails on, verified", prefs.data?.order_update_emails === true && prefs.data?.email_verified === true, JSON.stringify(prefs.data));

  // --- 2. placeOrder: buyer confirmation + seller new-order ---
  const sf = await call(BASE, "getStorefront", {});
  const prod = [...sf.data.products].sort((a: any, b: any) => b.price_paisa - a.price_paisa)
    .find((p: any) => p.stock >= 6 && p.is_active && p.price_paisa * 2 >= 100000);
  ok("seed product available", !!prod);
  await captured(true);
  const order1 = await call(BASE, "placeOrder", {
    authToken: buyerToken, customer_name: "Notify Buyer", phone, address: "Kathmandu Ward 5",
    note: "", payment_method: "cod", cod_confirmed: true, delivery_method: "standard",
    items: [{ product_id: prod.id, quantity: 1 }],
  });
  ok("placeOrder 200", order1.status === 200 && !!order1.data?.order_code, order1.error);
  const groupCode: string = order1.data.group_code;
  mails = await captured();
  const conf = findMails(mails, buyerEmail, `Order ${groupCode} received`);
  ok("order confirmation email to buyer", conf.length === 1 && wellFormed(conf[0]) && conf[0].text.includes(prod.name)
    && conf[0].text.includes("We have received your order") && conf[0].text.includes("due in cash"));
  const [semail] = SELLER_CREDS[prod.seller_code] ?? [];
  const newOrd = mails.filter((m) => m.subject.includes("New order"));
  ok("new-order email to seller", newOrd.length === 1 && wellFormed(newOrd[0]) && newOrd[0].to === semail, JSON.stringify(newOrd.map((m) => m.to)));
  const sellerOrderCode: string = order1.data.orders[0].order_code;

  // --- 3. shipment milestones: shipped (with tracking) + out_for_delivery + delivered ---
  const sl = await call(BASE, "sellerLogin", { email: semail, password: SELLER_CREDS[prod.seller_code][1] });
  ok("seller login", sl.status === 200 && !!sl.data?.token, sl.error);
  const stok = sl.data.token;
  const lo = await call(BASE, "listOrders", { authToken: stok });
  const sorder = lo.data?.orders?.find((o: any) => o.order_code === sellerOrderCode);
  ok("seller sees order", !!sorder);
  ok("seller order view hides buyer email", !!sorder && !("email" in sorder) && !("buyer_email" in sorder) && !JSON.stringify(sorder).includes(buyerEmail));
  // COD orders start at confirmation_needed: confirmed -> packed -> shipped
  // -> out_for_delivery -> delivered is the legal path.
  const c1 = await call(BASE, "updateOrderStatus", { authToken: stok, order_id: sorder.id, status: "confirmed" });
  ok("confirmed 200", c1.status === 200, c1.error);
  const c2 = await call(BASE, "updateOrderStatus", { authToken: stok, order_id: sorder.id, status: "packed" });
  ok("packed 200", c2.status === 200, c2.error);
  await captured(true);
  const ship = await call(BASE, "setShipmentInfo", { authToken: stok, order_id: sorder.id, tracking_number: "TRK123", carrier: "Pathao" });
  ok("setShipmentInfo 200", ship.status === 200, ship.error);
  mails = await captured();
  const shipped = findMails(mails, buyerEmail, "is on its way");
  ok("shipped email with tracking", shipped.length === 1 && shipped[0].text.includes("TRK123") && shipped[0].text.includes("Pathao"));
  await captured(true);
  const sh2 = await call(BASE, "updateOrderStatus", { authToken: stok, order_id: sorder.id, status: "shipped" });
  ok("shipped transition 200 (no duplicate email)", sh2.status === 200, sh2.error);
  mails = await captured();
  ok("no duplicate shipped email", mails.filter((m) => m.subject.includes("is on its way")).length === 0);
  await captured(true);
  const ofd = await call(BASE, "updateOrderStatus", { authToken: stok, order_id: sorder.id, status: "out_for_delivery" });
  ok("out_for_delivery 200", ofd.status === 200, ofd.error);
  mails = await captured();
  ok("out-for-delivery email", findMails(mails, buyerEmail, "out for delivery").length === 1);
  await captured(true);
  const del = await call(BASE, "updateOrderStatus", { authToken: stok, order_id: sorder.id, status: "delivered" });
  ok("delivered 200", del.status === 200, del.error);
  mails = await captured();
  ok("delivered email", findMails(mails, buyerEmail, "has been delivered").length === 1);

  // --- 4. buyer cancel: buyer + seller emails ---
  const order2 = await call(BASE, "placeOrder", {
    authToken: buyerToken, customer_name: "Notify Buyer", phone, address: "Kathmandu Ward 5",
    note: "", payment_method: "cod", cod_confirmed: true, delivery_method: "standard",
    items: [{ product_id: prod.id, quantity: 1 }],
  });
  ok("second order placed", order2.status === 200, order2.error);
  await captured(true);
  const cx = await call(BASE, "cancelOrder", { authToken: buyerToken, group_code: order2.data.group_code });
  ok("cancelOrder 200", cx.status === 200, cx.error);
  mails = await captured();
  ok("buyer cancellation email", findMails(mails, buyerEmail, "cancelled").length >= 1);
  ok("seller cancellation email", mails.filter((m) => m.subject.includes("was cancelled")).length === 1);

  // --- 5. payment failure: buyer + admin alert ---
  const order3 = await call(BASE, "placeOrder", {
    authToken: buyerToken, customer_name: "Notify Buyer", phone, address: "Kathmandu Ward 5",
    note: "", payment_method: "esewa", delivery_method: "standard",
    items: [{ product_id: prod.id, quantity: 1 }],
  });
  ok("online order placed", order3.status === 200, order3.error);
  await captured(true);
  // Bogus signature: verification fails -> fail() path marks payment failed,
  // emails the buyer and alerts the admin.
  const vf = await call(BASE, "verifyEsewaPayment", { authToken: buyerToken, group_id: order3.data.group_id, data: "bogus-signature-data-12345" });
  ok("bad eSewa verify rejected", vf.status !== 200);
  mails = await captured();
  ok("payment-failed email to buyer", findMails(mails, buyerEmail, "did not go through").length === 1);
  ok("payment-failure admin alert", findMails(mails, "admin-test@nepalshop.test", "eSewa payment verification failed").length === 1);

  // --- 6. return flow: buyer + seller + refund emails ---
  const order4 = await call(BASE, "placeOrder", {
    authToken: buyerToken, customer_name: "Notify Buyer", phone, address: "Kathmandu Ward 5",
    note: "", payment_method: "cod", cod_confirmed: true, delivery_method: "standard",
    items: [{ product_id: prod.id, quantity: 1 }],
  });
  const lo4 = await call(BASE, "listOrders", { authToken: stok });
  const so4 = lo4.data?.orders?.find((o: any) => o.order_code === order4.data.orders[0].order_code);
  ok("return-test order found", !!so4);
  // Walk the legal path to delivered before requesting a return.
  for (const st of ["confirmed", "packed", "shipped", "delivered"]) {
    const tr = await call(BASE, "updateOrderStatus", { authToken: stok, order_id: so4.id, status: st });
    if (tr.status !== 200) { ok(`walk to ${st}`, false, tr.error); break; }
  }
  await captured(true);
  const rr = await call(BASE, "requestReturn", { authToken: buyerToken, order_code: so4.order_code, phone, reason: "The item arrived damaged and does not work." });
  ok("requestReturn 200", rr.status === 200, rr.error);
  mails = await captured();
  ok("return-requested email to buyer", findMails(mails, buyerEmail, "Return requested").length === 1);
  ok("return-requested email to seller", findMails(mails, semail, "Return requested").length === 1);
  await captured(true);
  const ur = await call(BASE, "updateReturnStatus", { authToken: stok, order_id: so4.id, decision: "accepted" });
  ok("updateReturnStatus accepted", ur.status === 200, ur.error);
  mails = await captured();
  ok("return accepted email to buyer", findMails(mails, buyerEmail, "Return accepted").length === 1);
  const al = await call(BASE, "adminLogin", { email: "admin@nepalshop.local", password: "Admin@123" });
  ok("admin login", al.status === 200 && !!al.data?.token, al.error);
  const atok = al.data.token;
  await captured(true);
  const rf = await call(BASE, "requestRefund", { authToken: stok, order_id: so4.id });
  ok("requestRefund (COD unpaid -> not_required)", rf.status === 200, rf.error);
  mails = await captured();
  ok("refund/return-closed email to buyer", mails.filter((m) => m.to === buyerEmail && /Refund|Return closed/.test(m.subject)).length === 1);

  // --- 7. password reset ---
  await captured(true);
  const pr = await call(BASE, "requestPasswordReset", { user_type: "buyer", identifier: phone });
  ok("requestPasswordReset 200", pr.status === 200, JSON.stringify(pr.data ?? pr.error));
  mails = await captured();
  ok("password reset email", findMails(mails, buyerEmail, "Reset your Nepal Shop password").length === 1);
  // Global sweep: no captured email may contain a password or session token.
  const secrets1 = [buyerToken, stok, "testpass123"];
  const all1 = await captured();
  const leaked1 = all1.filter((m) => secrets1.some((s) => s && (m.text.includes(s) || m.subject.includes(s))));
  ok("no passwords or session tokens in captured emails", leaked1.length === 0, leaked1.map((m) => m.subject).join(", "));

  // ================= phase 2: seller/admin lifecycle =================
  console.log("--- phase 2: seller/admin lifecycle ---");
  srvA.kill();
  await Bun.sleep(1000);
  const dbP2 = `/tmp/notify-p2-${Date.now()}.db`;
  const srvP2 = await boot({ PORT: String(portArg), DB_PATH: dbP2, EMAIL_TEST_CAPTURE: "1", ADMIN_EMAIL: "admin-test@nepalshop.test", BASE_URL: BASE }, "/tmp/notify-p2.log");

  const al2 = await call(BASE, "adminLogin", { email: "admin@nepalshop.local", password: "Admin@123" });
  ok("admin login (p2)", al2.status === 200, al2.error);
  const atok2 = al2.data.token;

  // registerSeller -> admin alert; verify -> under_review -> active/rejected mails
  await captured(true);
  const sts = Date.now();
  const reg = await call(BASE, "registerSeller", {
    store_name: "Notify Test Store", tagline: "Testing notifications end to end", location: "Pokhara",
    phone: "98" + String(sts).slice(-8), email: `sellertest${sts}@test.local`,
    password: "sellerpass123", seller_key: "sellerkey123",
  });
  ok("registerSeller 200", reg.status === 200 && !!reg.data?.seller_code, reg.error);
  mails = await captured();
  ok("new-seller admin alert", findMails(mails, "admin-test@nepalshop.test", "New seller awaiting review").length === 1);
  const svmail = mails.filter((m) => m.subject.includes("Verify your Nepal Shop seller account"));
  ok("seller verification email", svmail.length === 1 && wellFormed(svmail[0]));
  const stok2 = svmail[0].text.match(/verify-seller\?token=([a-f0-9]+)/)?.[1] ?? "";
  const vs2 = await call(BASE, "verifySellerEmail", { token: stok2 });
  ok("verifySellerEmail ok", vs2.status === 200, vs2.error);
  const sellers = await call(BASE, "adminListSellers", { authToken: atok2 });
  const ns = sellers.data?.sellers?.find((s: any) => s.seller_code === reg.data.seller_code);
  ok("new seller found under_review", !!ns && ns.status === "under_review", JSON.stringify(ns?.status));
  await captured(true);
  const act = await call(BASE, "adminSetSellerStatus", { authToken: atok2, seller_id: ns.id, status: "active" });
  ok("approve seller", act.status === 200, act.error);
  mails = await captured();
  const appr = findMails(mails, `sellertest${sts}@test.local`, "approved");
  ok("seller approval email", appr.length === 1 && wellFormed(appr[0]));
  // suspension + reactivation
  const susp = await call(BASE, "adminSetSellerStatus", { authToken: atok2, seller_id: ns.id, status: "suspended" });
  ok("suspend seller", susp.status === 200, susp.error);
  mails = await captured();
  ok("seller suspension email", findMails(mails, `sellertest${sts}@test.local`, "suspended").length === 1);
  await captured(true);
  const reac = await call(BASE, "adminSetSellerStatus", { authToken: atok2, seller_id: ns.id, status: "active" });
  ok("reactivate seller", reac.status === 200, reac.error);
  mails = await captured();
  ok("seller reactivation email", findMails(mails, `sellertest${sts}@test.local`, "active again").length === 1);

  // product moderation -> seller email
  const sf2 = await call(BASE, "getStorefront", {});
  const p0 = sf2.data.products.find((p: any) => p.seller_code === "SELL-BDC364DC" && p.is_active);
  const [se0] = SELLER_CREDS[p0.seller_code];
  await captured(true);
  const hide = await call(BASE, "adminSetProductActive", { authToken: atok2, product_id: p0.id, active: false });
  ok("hide product", hide.status === 200, hide.error);
  mails = await captured();
  ok("product hidden email to seller", findMails(mails, se0, "was hidden").length === 1);
  const show = await call(BASE, "adminSetProductActive", { authToken: atok2, product_id: p0.id, active: true });
  ok("show product", show.status === 200, show.error);
  mails = await captured();
  ok("product visible email to seller", findMails(mails, se0, "visible again").length === 1);

  // commission rule -> affected sellers
  await captured(true);
  const cr = await call(BASE, "adminSaveCommissionRule", { authToken: atok2, scope: "platform", percent: 7, label: "notify-test" });
  ok("save commission rule", cr.status === 200, cr.error);
  mails = await captured();
  const cc = mails.filter((m) => m.subject.includes("commission rates"));
  ok("commission emails to active sellers", cc.length >= 3 && cc.every(wellFormed), `got ${cc.length}`);

  // payout request -> seller email + admin alert (tested after the low-stock
  // section, which leaves a deliverable order to fund the balance).
  const sl3 = await call(BASE, "sellerLogin", { email: se0, password: SELLER_CREDS[p0.seller_code][1] });
  await call(BASE, "sellerSavePayoutDetails", { authToken: sl3.data.token, esewa_id: "98XXXXXXXX" });

  // prefs toggle: off -> no buyer order emails, seller mails unaffected
  const ts2 = Date.now();
  const b2email = `buyerb${ts2}@test.local`;
  const b2phone = "98" + String(ts2).slice(-8);
  const su2 = await call(BASE, "signup", { name: "Quiet Buyer", phone: b2phone, email: b2email, password: "testpass123" });
  const b2tok = su2.data.token;
  const up = await call(BASE, "updateNotificationPrefs", { authToken: b2tok, order_update_emails: false });
  ok("opt out of order emails", up.status === 200, up.error);
  await captured(true);
  const qo = await call(BASE, "placeOrder", {
    authToken: b2tok, customer_name: "Quiet Buyer", phone: b2phone, address: "Lalitpur Ward 3",
    note: "", payment_method: "cod", cod_confirmed: true, delivery_method: "standard",
    items: [{ product_id: p0.id, quantity: 1 }],
  });
  ok("order still succeeds with emails off", qo.status === 200, qo.error);
  mails = await captured();
  ok("no buyer emails when opted out", mails.filter((m) => m.to === b2email).length === 0, JSON.stringify(mails.map((m) => m.subject)));
  ok("seller still gets new-order email", mails.filter((m) => m.subject.includes("New order")).length === 1);
  await call(BASE, "updateNotificationPrefs", { authToken: b2tok, order_update_emails: true });
  const prefs2 = await call(BASE, "getNotificationPrefs", { authToken: b2tok });
  ok("opt back in", prefs2.data?.order_update_emails === true);

  // low-stock: first crossing alerts once, further orders do not re-alert
  const cp = await call(BASE, "createProduct", {
    authToken: sl3.data.token, name: `Lowstock Test ${ts2}`, category: p0.category,
    description: "A product to test low-stock email alerts.", price_paisa: 150000,
    delivery_fee_paisa: 0, stock: 6, low_stock_threshold: 5, is_active: true,
  });
  ok("low-stock test product created", cp.status === 200 && cp.data?.is_active === true, cp.error);
  const lpId = cp.data.id;
  await captured(true);
  const lso1 = await call(BASE, "placeOrder", {
    authToken: b2tok, customer_name: "Quiet Buyer", phone: b2phone, address: "Lalitpur Ward 3",
    note: "", payment_method: "cod", cod_confirmed: true, delivery_method: "standard",
    items: [{ product_id: lpId, quantity: 1 }],
  });
  ok("low-stock crossing order", lso1.status === 200, lso1.error);
  mails = await captured();
  const ls1 = mails.filter((m) => m.subject.includes("Low stock alert"));
  ok("low-stock alert sent once on crossing", ls1.length === 1 && ls1[0].text.includes("5 left"), JSON.stringify(ls1.map((m) => m.subject)));
  await captured(true);
  const lso2 = await call(BASE, "placeOrder", {
    authToken: b2tok, customer_name: "Quiet Buyer", phone: b2phone, address: "Lalitpur Ward 3",
    note: "", payment_method: "cod", cod_confirmed: true, delivery_method: "standard",
    items: [{ product_id: lpId, quantity: 1 }],
  });
  ok("second low-stock order", lso2.status === 200, lso2.error);
  mails = await captured();
  ok("no repeat low-stock alert", mails.filter((m) => m.subject.includes("Low stock alert")).length === 0);

  // --- payout emails: fund the balance by delivering a low-stock order ---
  const ms = await call(BASE, "adminSaveMoneySettings", { authToken: atok2, commission_default_percent: 7, payout_available_after_days: 0, payout_min_paisa: 50000 });
  ok("money settings hold=0", ms.status === 200, ms.error);
  const loL = await call(BASE, "listOrders", { authToken: sl3.data.token });
  const lso = loL.data?.orders?.find((o: any) => o.order_code === lso1.data.orders[0].order_code);
  ok("low-stock order found for delivery", !!lso);
  for (const st of ["confirmed", "packed", "shipped", "delivered"]) {
    await call(BASE, "updateOrderStatus", { authToken: sl3.data.token, order_id: lso.id, status: st });
  }
  const bal2 = await call(BASE, "sellerGetEarnings", { authToken: sl3.data.token });
  const req6 = bal2.data?.balances?.requestable_paisa ?? 0;
  ok("balance requestable after delivery", req6 >= 50000, `requestable=${req6}`);
  await captured(true);
  const po = await call(BASE, "sellerRequestPayout", { authToken: sl3.data.token, amount_paisa: req6, method: "esewa" });
  ok("sellerRequestPayout", po.status === 200, po.error);
  mails = await captured();
  ok("payout requested email to seller", findMails(mails, se0, "Payout requested").length === 1);
  ok("payout admin alert", findMails(mails, "admin-test@nepalshop.test", "Payout request needs action").length === 1);
  const secrets2 = [b2tok, sl3.data.token, atok2, "testpass123", "sellerpass123"];
  const all2 = await captured();
  const leaked2 = all2.filter((m) => secrets2.some((s) => s && (m.text.includes(s) || m.subject.includes(s))));
  ok("no passwords or session tokens in captured emails (p2)", leaked2.length === 0, leaked2.map((m) => m.subject).join(", "));

  // __testCapturedEmails must refuse when capture mode is off — covered in phase 3.
  srvP2.kill();
  await Bun.sleep(1000);
  console.log(`phase 2 done: ${pass} pass, ${fail} fail`);

  // ================= phase 3: no SMTP -> honest {sent:false}, flows unaffected =================
  console.log("--- phase 3: SMTP unconfigured (honest no-send) ---");
  const dbB = `/tmp/notify-b-${Date.now()}.db`;
  const logB = `/tmp/notify-b-${Date.now()}.log`;
  const srvB = await boot({ PORT: String(portArg + 1), DB_PATH: dbB, BASE_URL: BASE_B }, logB);
  const tsb = Date.now();
  const sub = await call(BASE_B, "signup", { name: "Honest Buyer", phone: "98" + String(tsb).slice(-8), email: `honest${tsb}@test.local`, password: "testpass123" });
  ok("signup works without SMTP", sub.status === 200 && !!sub.data?.token, sub.error);
  const sfb = await call(BASE_B, "getStorefront", {});
  const pb = sfb.data.products.find((p: any) => p.stock >= 2 && p.is_active);
  const ob = await call(BASE_B, "placeOrder", {
    authToken: sub.data.token, customer_name: "Honest Buyer", phone: "98" + String(tsb).slice(-8),
    address: "Kathmandu", note: "", payment_method: "cod", cod_confirmed: true, delivery_method: "standard",
    items: [{ product_id: pb.id, quantity: 1 }],
  });
  ok("checkout works without SMTP", ob.status === 200, ob.error);
  const tc = await call(BASE_B, "__testCapturedEmails", {});
  ok("__testCapturedEmails refused without capture mode", tc.status !== 200 || !!tc.error);
  srvB.kill();
  const logBText = await serverLog(logB);
  ok("server log honestly reports unconfigured email", logBText.includes("[email] not configured"), logBText.slice(-300));
  console.log(`phase 3 done: ${pass} pass, ${fail} fail`);

  // ================= phase 4: dead SMTP host -> failure never breaks checkout =================
  console.log("--- phase 4: SMTP failure must not break checkout ---");
  const dbC = `/tmp/notify-c-${Date.now()}.db`;
  const logC = `/tmp/notify-c-${Date.now()}.log`;
  const srvC = await boot({
    PORT: String(portArg + 2), DB_PATH: dbC, BASE_URL: BASE_C,
    SMTP_HOST: "127.0.0.1", SMTP_PORT: "1", SMTP_USER: "x", SMTP_PASS: "y", SMTP_FROM: "x@y.test",
  }, logC);
  const tsc2 = Date.now();
  const suc = await call(BASE_C, "signup", { name: "Fail Buyer", phone: "98" + String(tsc2).slice(-8), email: `fail${tsc2}@test.local`, password: "testpass123" });
  ok("signup works with dead SMTP", suc.status === 200 && !!suc.data?.token, suc.error);
  const sfc = await call(BASE_C, "getStorefront", {});
  const pc = sfc.data.products.find((p: any) => p.stock >= 2 && p.is_active);
  const oc = await call(BASE_C, "placeOrder", {
    authToken: suc.data.token, customer_name: "Fail Buyer", phone: "98" + String(tsc2).slice(-8),
    address: "Kathmandu", note: "", payment_method: "cod", cod_confirmed: true, delivery_method: "standard",
    items: [{ product_id: pc.id, quantity: 1 }],
  });
  ok("checkout succeeds despite SMTP failure", oc.status === 200 && !!oc.data?.order_code, oc.error);
  srvC.kill();
  const logCText = await serverLog(logC);
  ok("server log honestly reports the send failure", /\[email\] send to .* failed/.test(logCText), logCText.slice(-300));
  console.log(`phase 4 done: ${pass} pass, ${fail} fail`);

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
} catch (e) {
  console.error("verification crashed:", e);
  process.exit(1);
}

