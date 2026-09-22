// v9 integration verification (fresh local DB, local server only).
// Usage: bun scripts/verify-v9.ts --port 3897
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
  // --- setup: admin, two sellers, products ---
  const admin = await call("adminLogin", { email: "admin@nepalshop.local", password: "Admin@123" });
  ok("admin login", !!admin.data?.token);
  const AT = admin.data.token;
  const s1 = await call("sellerLogin", { email: "himalaya.fashion@demo.local", password: "demo-seller-01" });
  const s2 = await call("sellerLogin", { email: "techsewa@demo.local", password: "demo-seller-02" });
  ok("seller1 login", !!s1.data?.token); ok("seller2 login", !!s2.data?.token);
  const S1 = s1.data.token, S2 = s2.data.token;
  const inv1 = await call("sellerInventory", { authToken: S1 });
  const inv2 = await call("sellerInventory", { authToken: S2 });
  const p1 = inv1.data.products.find((p: any) => p.stock >= 3 && p.is_active);
  const p2 = inv2.data.products.find((p: any) => p.stock >= 3 && p.is_active);
  ok("seller1 has sellable product", !!p1); ok("seller2 has sellable product", !!p2);

  // --- buyer + checkout ---
  const buyer = await call("signup", { name: "V9 Test Buyer", phone: "9851000001", password: "testpass1" });
  ok("buyer signup", !!buyer.data?.token);
  const BT = buyer.data.token;
  const order = await call("placeOrder", {
    authToken: BT, customer_name: "V9 Test Buyer", phone: "9851000001",
    address: "Lalitpur, Nepal", cod_confirmed: true, payment_method: "cod",
    items: [{ product_id: p1.id, quantity: 2 }],
  });
  ok("placeOrder ok", order.status === 200 && !!order.data?.order_code, order.error ?? "");
  const OC = order.data.order_code;

  // --- A. invoice role scoping ---
  const invBuyer = await call("getInvoice", { authToken: BT, order_code: OC });
  const inv = invBuyer.data?.invoice;
  ok("invoice: buyer sees own", !!inv && /^INV-2026-\d{6}$/.test(inv.invoice_no), `no=${inv?.invoice_no}`);
  ok("invoice: numbers consistent", inv && inv.grand_total_paisa === inv.subtotal_paisa - inv.discount_paisa + inv.delivery_fee_paisa, JSON.stringify({ g: inv?.grand_total_paisa, s: inv?.subtotal_paisa, d: inv?.discount_paisa, f: inv?.delivery_fee_paisa }));
  ok("invoice: line totals add up", inv && inv.fulfilments.every((f: any) => f.items.every((i: any) => i.line_total_paisa === i.unit_price_paisa * i.quantity)));
  ok("invoice: tax note present", inv?.tax_note === "No separate tax is charged on this marketplace.");
  const invSeller1 = await call("getInvoice", { authToken: S1, order_code: OC });
  ok("invoice: owning seller sees slice", !!invSeller1.data?.invoice && invSeller1.data.invoice.fulfilments.length === 1, invSeller1.error ?? "");
  const invSeller2 = await call("getInvoice", { authToken: S2, order_code: OC });
  ok("invoice: unrelated seller rejected", !!invSeller2.error, invSeller2.error ?? "");
  const stranger = await call("signup", { name: "Stranger", phone: "9851000002", password: "testpass1" });
  const invStranger = await call("getInvoice", { authToken: stranger.data.token, order_code: OC });
  ok("invoice: stranger buyer rejected", !!invStranger.error, invStranger.error ?? "");
  const invAdmin = await call("getInvoice", { authToken: AT, order_code: OC });
  ok("invoice: admin sees full group", !!invAdmin.data?.invoice && invAdmin.data.invoice.grand_total_paisa === inv.grand_total_paisa);

  // --- B. Q&A: ask -> seller sees pending -> answer -> public ---
  const q = await call("askQuestion", { authToken: BT, product_id: p1.id, question: "Is this available in red?" });
  ok("askQuestion ok", !!q.data?.id, q.error ?? "");
  const qGuest = await call("getProductQuestions", { product_id: p1.id });
  ok("guest sees no pending", (qGuest.data?.questions ?? []).length === 0);
  const qStranger = await call("getProductQuestions", { authToken: stranger.data.token, product_id: p1.id });
  ok("other buyer sees no pending", (qStranger.data?.questions ?? []).length === 0);
  const qSeller1 = await call("getProductQuestions", { authToken: S1, product_id: p1.id });
  ok("owning seller sees pending", (qSeller1.data?.questions ?? []).some((x: any) => x.question === "Is this available in red?" && x.answer == null), JSON.stringify(qSeller1.data?.questions?.length));
  const qSeller2 = await call("getProductQuestions", { authToken: S2, product_id: p1.id });
  ok("other seller does NOT see pending", !(qSeller2.data?.questions ?? []).some((x: any) => x.question === "Is this available in red?"));
  const qLegacy = await call("getProductQuestions", { seller_code: "SELL-BDC364DC", seller_key: "demo-seller-01", product_id: p1.id });
  ok("legacy code+key seller sees pending", (qLegacy.data?.questions ?? []).some((x: any) => x.answer == null));
  const ans = await call("answerQuestion", { authToken: S1, question_id: q.data.id, answer: "Yes, red is in stock." });
  ok("answerQuestion ok", !!ans.data?.ok, ans.error ?? "");
  const qAfter = await call("getProductQuestions", { product_id: p1.id });
  ok("public sees answered", (qAfter.data?.questions ?? []).some((x: any) => x.answer === "Yes, red is in stock."));
  const notifs = await call("getNotifications", { authToken: BT });
  ok("asker notified of answer", (notifs.data?.notifications ?? []).some((n: any) => n.type === "question_answered"), JSON.stringify((notifs.data?.notifications ?? []).map((n: any) => n.type)));
  const nUnread = notifs.data?.unread_count ?? 0;
  const nid = (notifs.data?.notifications ?? []).find((n: any) => n.type === "question_answered")?.id;
  const mark = await call("markNotificationRead", { authToken: BT, id: nid });
  const notifs2 = await call("getNotifications", { authToken: BT });
  ok("notification mark-read works", !!mark.data?.ok && notifs2.data?.unread_count === nUnread - 1, `unread ${nUnread} -> ${notifs2.data?.unread_count}`);

  // --- C. CSV import with bad rows ---
  const csv = [
    "name,price_paisa,stock,category,description",
    "V9 Good Shirt,129900,10,Fashion,A fine shirt",
    ",99900,5,Fashion,Missing name",
    "V9 Bad Price,abc,5,Fashion,Bad price",
    "V9 Good Shirt,139900,3,Fashion,Duplicate name",
  ].join("\n");
  const csvr = await call("sellerCsvImport", { authToken: S1, csv_text: csv });
  // Duplicate names are allowed (only SKUs dedupe): 2 created, rows 3+4
  // reported with their line numbers.
  ok("csv: good rows created, bad rows reported per row", csvr.data?.created === 2 && (csvr.data?.errors ?? []).length === 2, JSON.stringify(csvr.data));
  ok("csv: error rows reference line numbers", JSON.stringify((csvr.data?.errors ?? []).map((e: any) => e.row)) === "[3,4]" && (csvr.data?.errors ?? []).every((e: any) => typeof e.message === "string" && e.message.length > 0));
  const inv1b = await call("sellerInventory", { authToken: S1 });
  ok("csv: good product actually listed", (inv1b.data?.products ?? []).some((p: any) => p.name === "V9 Good Shirt"));

  // --- D. deleteAccount keeps orders, anonymises ---
  const delBuyer = await call("signup", { name: "V9 Del Buyer", phone: "9851000003", password: "delpass99" });
  const DT = delBuyer.data.token, DID = delBuyer.data.user.id;
  const dorder = await call("placeOrder", { authToken: DT, customer_name: "V9 Del Buyer", phone: "9851000003", address: "Kathmandu, Nepal", cod_confirmed: true, payment_method: "cod", items: [{ product_id: p2.id, quantity: 1 }] });
  ok("delete-test order placed", !!dorder.data?.order_code, dorder.error ?? "");
  const delWrong = await call("deleteAccount", { authToken: DT, password: "wrongpass", confirm_text: "DELETE" });
  ok("deleteAccount: wrong password rejected", !!delWrong.error);
  const delWrongText = await call("deleteAccount", { authToken: DT, password: "delpass99", confirm_text: "delete" });
  ok("deleteAccount: lowercase DELETE rejected", !!delWrongText.error);
  const del = await call("deleteAccount", { authToken: DT, password: "delpass99", confirm_text: "DELETE" });
  ok("deleteAccount ok, 1 order kept", !!del.data?.ok && del.data?.orders_kept === 1, JSON.stringify(del.data));
  const loginAfter = await call("login", { phone: "9851000003", password: "delpass99" });
  ok("deleted account cannot log in", !!loginAfter.error);
  const adminOrders = await call("adminListOrders", { authToken: AT });
  ok("deleted user's order still in admin list", (adminOrders.data?.orders ?? []).some((o: any) => o.order_code === dorder.data.order_code), `orders=${(adminOrders.data?.orders ?? []).length}`);

  // --- E. exportAccountData ---
  const exp = await call("exportAccountData", { authToken: BT });
  ok("exportAccountData ok", !!exp.data?.profile && exp.data.profile.phone === "9851000001", JSON.stringify(Object.keys(exp.data ?? {})));
  ok("export includes orders", Array.isArray(exp.data?.orders) && exp.data.orders.length >= 1);

  // --- G. category SEO round-trip ---
  const cats = await call("adminListCategories", { authToken: AT });
  ok("adminListCategories returns seo fields", (cats.data?.categories ?? []).every((c: any) => "seo_title" in c && "seo_description" in c && "intro_content" in c), JSON.stringify(cats.data?.categories?.[0]));
  const cat = cats.data.categories[0];
  const seo = await call("adminUpdateCategorySeo", { authToken: AT, category_id: cat.id, seo_title: "Test SEO Title", seo_description: "Test meta description", intro_content: "Intro block text" });
  ok("adminUpdateCategorySeo ok", !!seo.data?.ok, seo.error ?? "");
  const pub = await call("getPublicCategories", {});
  const pubCat = (pub.data?.categories ?? []).find((c: any) => c.id === cat.id);
  ok("public read shows saved SEO", !!pubCat && pubCat.seo_title === "Test SEO Title" && pubCat.intro_content === "Intro block text", JSON.stringify(pubCat));
  ok("public list only active + no internal fields", (pub.data?.categories ?? []).every((c: any) => Object.keys(c).sort().join(",") === "id,intro_content,name,seo_description,seo_title,slug"));

  // --- H. invalid order transitions still rejected ---
  const ords = await call("getMyOrders", { authToken: BT });
  const myOrder = (ords.data?.orders ?? []).find((o: any) => o.order_code === OC);
  const badTrans = await call("updateOrderStatus", { authToken: S1, order_id: myOrder.id, status: "delivered" });
  ok("invalid transition rejected (confirmation_needed -> delivered)", !!badTrans.error, badTrans.error ?? "");
  const goodTrans = await call("updateOrderStatus", { authToken: S1, order_id: myOrder.id, status: "confirmed" });
  ok("valid transition accepted (confirmation_needed -> confirmed)", !!goodTrans.data?.ok, goodTrans.error ?? "");

  // --- J. cart merge on login ---
  const guestBuyer = await call("signup", { name: "V9 Merge Buyer", phone: "9851000004", password: "mergepass1" });
  const MT = guestBuyer.data.token;
  const merge = await call("mergeCart", { authToken: MT, items: [{ product_id: p1.id, quantity: 1 }] });
  ok("mergeCart ok", (merge.data?.cart?.items ?? []).some((i: any) => i.product_id === p1.id), JSON.stringify(merge.data?.cart?.items?.length));
  const cart = await call("getCart", { authToken: MT });
  ok("cart persists after merge", (cart.data?.items ?? []).some((i: any) => i.product_id === p1.id), JSON.stringify(Object.keys(cart.data ?? {})));

  // --- invoice number uniqueness across orders ---
  const invA = await call("getInvoice", { authToken: BT, order_code: OC });
  const order2 = await call("placeOrder", { authToken: BT, customer_name: "V9 Test Buyer", phone: "9851000001", address: "Lalitpur, Nepal", cod_confirmed: true, payment_method: "cod", items: [{ product_id: p1.id, quantity: 1 }] });
  const invB = await call("getInvoice", { authToken: BT, order_code: order2.data.order_code });
  ok("invoice numbers unique per order", invA.data.invoice.invoice_no !== invB.data.invoice.invoice_no, `${invA.data.invoice.invoice_no} vs ${invB.data.invoice.invoice_no}`);

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
} catch (e) {
  console.error("HARNESS ERROR", e);
  process.exit(2);
}
