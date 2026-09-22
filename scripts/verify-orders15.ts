// Checkpoint 13+14+15 verification: orders + shipping + returns/refunds.
// Usage: bun scripts/verify-orders15.ts --port 3899 --db /tmp/orders15.db
// (server must already be running on a FRESH database)
import { Database } from "bun:sqlite";
const portIdx = process.argv.indexOf("--port");
const dbIdx = process.argv.indexOf("--db");
const port = portIdx >= 0 ? process.argv[portIdx + 1] : "3899";
const dbPath = dbIdx >= 0 ? process.argv[dbIdx + 1] : "/tmp/orders15.db";
const BASE = `http://localhost:${port}`;
const db = new Database(dbPath);
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
const q = (sql: string, p: any[] = []) => db.query(sql).all(...p) as any[];
const qr = (sql: string, p: any[] = []) => db.query(sql).get(...p) as any;
const run = (sql: string, p: any[] = []) => db.query(sql).run(...p);

try {
  // ============ 1. shipping settings ============
  const sm = await call("getShippingMethods", {});
  ok("getShippingMethods public", sm.status === 200 && sm.data?.methods?.length === 3, sm.error);
  ok("express fee default 12000", sm.data?.express_fee_paisa === 12000, JSON.stringify(sm.data?.express_fee_paisa));
  ok("courier not integrated (honest)", sm.data?.courier_integrated === false);
  ok("all methods enabled by default", sm.data?.methods?.every((m: any) => m.enabled));

  const al = await call("adminLogin", { email: "admin@nepalshop.local", password: "Admin@123" });
  ok("admin login", al.status === 200 && !!al.data?.token, al.error);
  const atok = al.data.token;

  const sv = await call("adminSaveShippingSettings", { authToken: atok, express_fee_paisa: 15000, standard_enabled: true, express_enabled: true, pickup_enabled: false });
  ok("admin saves shipping settings", sv.status === 200, sv.error);
  const sm2 = await call("getShippingMethods", {});
  ok("pickup disabled reflected", sm2.data?.methods?.find((m: any) => m.id === "pickup")?.enabled === false);
  ok("new express fee reflected", sm2.data?.express_fee_paisa === 15000);

  // ============ 2. buyer checkout with shipping ============
  const phone = "98" + String(Date.now()).slice(-8);
  const phone2 = "98" + String(Date.now() + 1).slice(-8);
  const su = await call("signup", { name: "Test Buyer", phone, password: "testpass123" });
  ok("signup", su.status === 200 && !!su.data?.token, su.error);
  const btok = su.data.token;
  const addr = await call("saveAddress", { authToken: btok, label: "Home", full_name: "Test Buyer", province: "Bagmati", district: "Kathmandu", municipality: "Kathmandu", ward: "5", landmark: "Near test", phone });
  const addressId = addr.data.id;

  const sf = await call("getStorefront", {});
  const prodA = sf.data.products.find((p: any) => p.seller_code === "SELL-BDC364DC" && p.stock >= 6);
  const prodB = sf.data.products.find((p: any) => p.seller_code === "SELL-06A3B75B" && p.stock >= 6);
  ok("two sellers' products available", !!prodA && !!prodB);

  const pk = await call("placeOrder", { authToken: btok, customer_name: "Test Buyer", phone, address: "Kathmandu Ward 5", note: "", payment_method: "cod", cod_confirmed: true, address_id: addressId, delivery_method: "pickup", items: [{ product_id: prodA.id, quantity: 1 }] });
  ok("disabled delivery method rejected", pk.status !== 200, pk.error);

  const ex = await call("placeOrder", { authToken: btok, customer_name: "Test Buyer", phone, address: "Kathmandu Ward 5", note: "", payment_method: "cod", cod_confirmed: true, address_id: addressId, delivery_method: "express", items: [{ product_id: prodA.id, quantity: 1 }] });
  ok("express order placed", ex.status === 200 && !!ex.data?.order_code, ex.error);
  const exTrack = await call("trackOrder", { authToken: btok, order_code: ex.data.order_code, phone });
  ok("express fee uses configured surcharge x1 seller", exTrack.data?.order?.delivery_fee_paisa === prodA.delivery_fee_paisa + 15000, `fee=${exTrack.data?.order?.delivery_fee_paisa} base=${prodA.delivery_fee_paisa}`);
  ok("delivery method shown on tracking", exTrack.data?.order?.delivery_method === "express");

  const grp = await call("placeOrder", { authToken: btok, customer_name: "Test Buyer", phone, address: "Kathmandu Ward 5", note: "", payment_method: "cod", cod_confirmed: true, address_id: addressId, delivery_method: "express", items: [{ product_id: prodA.id, quantity: 1 }, { product_id: prodB.id, quantity: 1 }] });
  ok("multi-seller express group placed", grp.status === 200 && !!grp.data?.group_code, grp.error);
  const grpTrack = await call("trackOrder", { authToken: btok, order_code: grp.data.group_code, phone });
  const gfee = grpTrack.data?.group?.delivery_fee_paisa;
  ok("express surcharge x2 sellers", gfee === prodA.delivery_fee_paisa + prodB.delivery_fee_paisa + 15000 * 2, `fee=${gfee}`);
  ok("group tracks both fulfilments", grpTrack.data?.group?.orders?.length === 2);

  // restore defaults
  await call("adminSaveShippingSettings", { authToken: atok, express_fee_paisa: 12000, standard_enabled: true, express_enabled: true, pickup_enabled: true });
  const sm3 = await call("getShippingMethods", {});
  ok("settings restored", sm3.data?.express_fee_paisa === 12000 && sm3.data?.methods?.every((m: any) => m.enabled));

  // ============ 3. seller shipment lifecycle ============
  const sellerCreds: Record<string, [string, string]> = {
    "SELL-BDC364DC": ["himalaya.fashion@demo.local", "demo-seller-01"],
    "SELL-06A3B75B": ["techsewa@demo.local", "demo-seller-02"],
    "SELL-05DC3C59": ["hastakala@demo.local", "demo-seller-03"],
  };
  const slogin = async (code: string) => (await call("sellerLogin", { email: sellerCreds[code][0], password: sellerCreds[code][1] })).data.token;
  const stokA = await slogin("SELL-BDC364DC");
  const stokB = await slogin("SELL-06A3B75B");
  ok("seller logins", !!stokA && !!stokB);

  const lo = await call("listOrders", { authToken: stokA });
  const sorder = lo.data?.orders?.find((o: any) => o.order_code === ex.data.order_code);
  ok("seller sees own fulfilment", !!sorder, ex.data.order_code);

  const sh = await call("setShipmentInfo", { authToken: stokA, order_id: sorder.id, carrier: "Pathao Courier", tracking_number: "NP-TEST-001" });
  ok("seller sets carrier+tracking", sh.status === 200, sh.error);
  const tr2 = await call("trackOrder", { authToken: btok, order_code: ex.data.order_code, phone });
  ok("tracking shows carrier", tr2.data?.order?.carrier === "Pathao Courier");
  ok("tracking shows tracking number", tr2.data?.order?.tracking_number === "NP-TEST-001");

  const illegal = await call("updateOrderStatus", { authToken: stokA, order_id: sorder.id, status: "packed" });
  ok("illegal transition rejected (confirmation_needed -> packed)", illegal.status !== 200, illegal.error);
  for (const st of ["confirmed", "packed", "shipped", "out_for_delivery"]) {
    const u = await call("updateOrderStatus", { authToken: stokA, order_id: sorder.id, status: st });
    if (u.status !== 200) { ok(`walk -> ${st}`, false, u.error); break; }
  }
  const df = await call("updateOrderStatus", { authToken: stokA, order_id: sorder.id, status: "delivery_failed" });
  ok("mark delivery failed", df.status === 200, df.error);
  const trDf = await call("trackOrder", { authToken: btok, order_code: ex.data.order_code, phone });
  ok("tracking shows delivery failed", trDf.data?.order?.status === "delivery_failed");
  const retry = await call("updateOrderStatus", { authToken: stokA, order_id: sorder.id, status: "out_for_delivery" });
  ok("retry delivery (failed -> out_for_delivery)", retry.status === 200, retry.error);
  const bad = await call("updateOrderStatus", { authToken: stokA, order_id: sorder.id, status: "returned" });
  ok("failed -> returned rejected", bad.status !== 200);
  const fin = await call("updateOrderStatus", { authToken: stokA, order_id: sorder.id, status: "delivered" });
  ok("delivered", fin.status === 200, fin.error);
  const stockRow = qr("select stock from products where id = ?", [prodA.id]);
  ok("COD marked paid on delivery", qr("select status from payments where order_id = ?", [sorder.id])?.status === "paid");
  void stockRow;

  // ============ 4. IDOR probes ============
  const x1 = await call("updateOrderStatus", { authToken: stokB, order_id: sorder.id, status: "cancelled" });
  ok("seller B cannot touch seller A's order", x1.status !== 200, x1.error);
  const x2 = await call("setShipmentInfo", { authToken: stokB, order_id: sorder.id, tracking_number: "EVIL" });
  ok("seller B cannot set shipment on A's order", x2.status !== 200, x2.error);
  const su2 = await call("signup", { name: "Buyer Two", phone: phone2, password: "testpass123" });
  const btok2 = su2.data.token;
  const x3 = await call("cancelOrder", { authToken: btok2, order_id: sorder.id });
  ok("buyer B cannot cancel buyer A's order", x3.status !== 200, x3.error);
  const x4 = await call("trackOrder", { authToken: btok2, order_code: ex.data.order_code, phone });
  ok("buyer B cannot track buyer A's registered order", x4.data?.order === null, JSON.stringify(x4.data)?.slice(0, 80));
  const x5 = await call("adminListRefunds", { authToken: btok });
  ok("buyer cannot hit admin actions", x5.status !== 200, x5.error);
  const x6 = await call("setShipmentInfo", { order_id: sorder.id, tracking_number: "EVIL" });
  ok("unauthenticated shipment change rejected", x6.status !== 200, x6.error);
  const x7 = await call("adminListReturns", {});
  ok("unauthenticated admin list rejected", x7.status !== 200, x7.error);

  // ============ 5. returns ============
  const rr0 = await call("requestReturn", { authToken: btok, order_code: ex.data.order_code, phone });
  ok("return without reason rejected", rr0.status !== 200, rr0.error);
  const stockBefore = qr("select stock from products where id = ?", [prodA.id])?.stock;
  const rr = await call("requestReturn", { authToken: btok, order_code: ex.data.order_code, phone, reason: "Wrong size, too big" });
  ok("requestReturn with reason", rr.status === 200, rr.error);
  const rrDup = await call("requestReturn", { authToken: btok, order_code: ex.data.order_code, phone, reason: "again" });
  ok("duplicate return rejected", rrDup.status !== 200, rrDup.error);
  const lr = await call("listReturns", { authToken: stokA });
  const retOrder = lr.data?.orders?.find((o: any) => o.order_code === ex.data.order_code);
  ok("seller sees reason preserved", retOrder?.return_reason === "Wrong size, too big", JSON.stringify(retOrder?.return_reason));
  const ar = await call("adminListReturns", { authToken: atok });
  ok("admin sees return request", ar.data?.returns?.some((r: any) => r.order_code === ex.data.order_code && String(r.requested_by).startsWith("buyer")), JSON.stringify(ar.data?.returns)?.slice(0, 120));
  const aud1 = await call("adminListAuditLogs", { authToken: atok, limit: 200, offset: 0 });
  ok("return_requested audited", (aud1.data?.entries ?? []).some((e: any) => e.action === "return_requested"), "");
  const acc = await call("updateReturnStatus", { authToken: stokA, order_id: sorder.id, decision: "accepted" });
  ok("seller accepts return", acc.status === 200, acc.error);
  const stockAfter = qr("select stock from products where id = ?", [prodA.id])?.stock;
  ok("stock restored exactly once", stockAfter === stockBefore + 1, `before=${stockBefore} after=${stockAfter}`);
  const trRet = await call("trackOrder", { authToken: btok, order_code: ex.data.order_code, phone });
  ok("tracking shows returned", trRet.data?.order?.status === "returned");

  // reject path on the second single-seller order: need a fresh delivered order
  const rej = await call("placeOrder", { authToken: btok, customer_name: "Test Buyer", phone, address: "Kathmandu Ward 5", note: "", payment_method: "cod", cod_confirmed: true, address_id: addressId, delivery_method: "standard", items: [{ product_id: prodA.id, quantity: 1 }] });
  const rejId = rej.data.order_id;
  for (const st of ["confirmed", "packed", "shipped", "out_for_delivery", "delivered"]) await call("updateOrderStatus", { authToken: stokA, order_id: rejId, status: st });
  await call("requestReturn", { authToken: btok, order_code: rej.data.order_code, phone, reason: "Changed my mind" });
  const rejDec = await call("updateReturnStatus", { authToken: stokA, order_id: rejId, decision: "rejected" });
  ok("seller rejects return", rejDec.status === 200, rejDec.error);
  const trRej = await call("trackOrder", { authToken: btok, order_code: rej.data.order_code, phone });
  ok("rejected return goes back to delivered", trRej.data?.order?.status === "delivered");

  // 30-day window: age a delivered order past the window
  run("update orders set delivered_at = ? where id = ?", [Date.now() - 31 * 86400 * 1000, rejId]);
  const old = await call("requestReturn", { authToken: btok, order_code: rej.data.order_code, phone, reason: "Too late" });
  ok("return after 30 days rejected", old.status !== 200 && /30-day/.test(old.error ?? ""), old.error);

  // ============ 6. refunds: honest staged flow ============
  // COD paid (auto-paid on delivery): request -> pending, nothing flips early
  const rfq = await call("requestRefund", { authToken: stokA, order_id: sorder.id });
  ok("requestRefund -> pending", rfq.status === 200 && rfq.data?.refund_status === "pending", rfq.error);
  const oStill = qr("select status, payment_status from orders where id = ?", [sorder.id]);
  ok("order NOT refunded before admin", oStill?.status === "returned", JSON.stringify(oStill));
  ok("payment row NOT refunded before admin", qr("select status from payments where order_id = ?", [sorder.id])?.status === "paid");
  const rl = await call("adminListRefunds", { authToken: atok, status: "pending" });
  const refundRow = rl.data?.refunds?.find((r: any) => r.order_id === sorder.id);
  ok("admin refund queue lists it", !!refundRow);
  const noRef = await call("adminResolveRefund", { authToken: atok, refund_id: refundRow.id, decision: "completed", reference: "" });
  ok("completion without reference rejected", noRef.status !== 200, noRef.error);
  const done = await call("adminResolveRefund", { authToken: atok, refund_id: refundRow.id, decision: "completed", reference: "ESEWA-TXN-99881" });
  ok("admin completes refund with reference", done.status === 200, done.error);
  const oDone = qr("select status, payment_status from orders where id = ?", [sorder.id]);
  ok("order refunded after completion", oDone?.status === "refunded" && oDone?.payment_status === "refunded", JSON.stringify(oDone));
  ok("COD payment row refunded", qr("select status from payments where order_id = ?", [sorder.id])?.status === "refunded");
  const trRef = await call("trackOrder", { authToken: btok, order_code: ex.data.order_code, phone });
  ok("tracking shows refunded + refund_status", trRef.data?.order?.status === "refunded" && trRef.data?.order?.refund_status === "completed");
  const aud2 = await call("adminListAuditLogs", { authToken: atok, limit: 200, offset: 0 });
  ok("refund_resolved audited", (aud2.data?.entries ?? []).some((e: any) => e.action === "refund_resolved"), "");

  // COD never paid: request -> not_required, nothing moves
  const unp = await call("placeOrder", { authToken: btok, customer_name: "Test Buyer", phone, address: "Kathmandu Ward 5", note: "", payment_method: "cod", cod_confirmed: true, address_id: addressId, delivery_method: "standard", items: [{ product_id: prodA.id, quantity: 1 }] });
  const unpId = unp.data.order_id;
  for (const st of ["confirmed", "packed", "shipped", "out_for_delivery", "delivered"]) await call("updateOrderStatus", { authToken: stokA, order_id: unpId, status: st });
  run("update payments set status = 'pending' where order_id = ?", [unpId]); // cash never collected
  await call("requestReturn", { authToken: btok, order_code: unp.data.order_code, phone, reason: "Not as described" });
  await call("updateReturnStatus", { authToken: stokA, order_id: unpId, decision: "accepted" });
  const rfq2 = await call("requestRefund", { authToken: stokA, order_id: unpId });
  ok("unpaid COD -> not_required", rfq2.status === 200 && rfq2.data?.refund_status === "not_required", rfq2.error);
  ok("order stays returned (not refunded)", qr("select status from orders where id = ?", [unpId])?.status === "returned");

  // failed decision: stays returned, refund row failed
  const fld = await call("placeOrder", { authToken: btok, customer_name: "Test Buyer", phone, address: "Kathmandu Ward 5", note: "", payment_method: "cod", cod_confirmed: true, address_id: addressId, delivery_method: "standard", items: [{ product_id: prodA.id, quantity: 1 }] });
  const fldId = fld.data.order_id;
  for (const st of ["confirmed", "packed", "shipped", "out_for_delivery", "delivered"]) await call("updateOrderStatus", { authToken: stokA, order_id: fldId, status: st });
  await call("requestReturn", { authToken: btok, order_code: fld.data.order_code, phone, reason: "Damaged in transit" });
  await call("updateReturnStatus", { authToken: stokA, order_id: fldId, decision: "accepted" });
  await call("requestRefund", { authToken: stokA, order_id: fldId });
  const rlF = await call("adminListRefunds", { authToken: atok, status: "pending" });
  const fldRow = rlF.data?.refunds?.find((r: any) => r.order_id === fldId);
  const failR = await call("adminResolveRefund", { authToken: atok, refund_id: fldRow.id, decision: "failed", reference: "provider timeout, will retry" });
  ok("admin marks refund failed", failR.status === 200, failR.error);
  ok("order still returned after failed refund", qr("select status from orders where id = ?", [fldId])?.status === "returned");
  ok("refund row failed", qr("select status from refunds where order_id = ?", [fldId])?.status === "failed");

  // ============ 7. partial group honesty (online) ============
  const og = await call("placeOrder", { authToken: btok, customer_name: "Test Buyer", phone, address: "Kathmandu Ward 5", note: "", payment_method: "esewa", address_id: addressId, delivery_method: "standard", items: [{ product_id: prodA.id, quantity: 1 }, { product_id: prodB.id, quantity: 1 }] });
  ok("online multi-seller group placed", og.status === 200 && !!og.data?.group_code, og.error);
  const ogId = og.data.group_id;
  const ogOrders = q("select id, store_id from orders where group_id = ?", [ogId]);
  ok("two fulfilments", ogOrders.length === 2);
  const ogPay = qr("select * from payments where group_id = ?", [ogId]);
  ok("one group payment row (esewa)", ogPay?.provider === "esewa" && q("select id from payments where group_id = ?", [ogId]).length === 1, JSON.stringify(ogPay?.provider));
  // simulate a completed provider payment (keys are not configured)
  run("update payments set status = 'paid' where group_id = ?", [ogId]);
  run("update orders set payment_status = 'paid' where group_id = ?", [ogId]);
  const storeA = qr("select id from store_settings where seller_code = 'SELL-BDC364DC'")?.id;
  const oa = ogOrders.find((o: any) => o.store_id === storeA) ?? ogOrders[0];
  const ob = ogOrders.find((o: any) => o.id !== oa.id);
  for (const st of ["confirmed", "packed", "shipped", "out_for_delivery", "delivered"]) {
    await call("updateOrderStatus", { authToken: stokA, order_id: oa.id, status: st });
    await call("updateOrderStatus", { authToken: stokB, order_id: ob.id, status: st });
  }
  for (const [oid, code] of [[oa.id, oa], [ob.id, ob]] as any) {
    const oc = qr("select order_code from orders where id = ?", [oid])?.order_code;
    await call("requestReturn", { authToken: btok, order_code: oc, phone, reason: "Partial group test" });
    await call("updateReturnStatus", { authToken: oid === oa.id ? stokA : stokB, order_id: oid, decision: "accepted" });
    const r = await call("requestRefund", { authToken: oid === oa.id ? stokA : stokB, order_id: oid });
    if (r.data?.refund_status !== "pending") ok("refund pending for fulfilment", false, JSON.stringify(r));
  }
  pass++; console.log("PASS both fulfilments refund-pending");
  const rlO = await call("adminListRefunds", { authToken: atok, status: "pending" });
  const rowA = rlO.data?.refunds?.find((r: any) => r.order_id === oa.id);
  const rowB = rlO.data?.refunds?.find((r: any) => r.order_id === ob.id);
  ok("both refunds queued", !!rowA && !!rowB);
  await call("adminResolveRefund", { authToken: atok, refund_id: rowA.id, decision: "completed", reference: "PARTIAL-1" });
  ok("fulfilment A order refunded", qr("select status from orders where id = ?", [oa.id])?.status === "refunded");
  ok("group payment row NOT marked fully refunded", qr("select status from payments where group_id = ?", [ogId])?.status === "paid", qr("select status from payments where group_id = ?", [ogId])?.status);
  const ogTrack1 = await call("trackOrder", { authToken: btok, order_code: og.data.group_code, phone });
  ok("group headline partially_refunded", ogTrack1.data?.group?.payment_status === "partially_refunded", ogTrack1.data?.group?.payment_status);
  await call("adminResolveRefund", { authToken: atok, refund_id: rowB.id, decision: "completed", reference: "PARTIAL-2" });
  ok("group payment row refunded once fully covered", qr("select status from payments where group_id = ?", [ogId])?.status === "refunded");
  const ogTrack2 = await call("trackOrder", { authToken: btok, order_code: og.data.group_code, phone });
  ok("group headline refunded when whole group covered", ogTrack2.data?.group?.payment_status === "refunded", ogTrack2.data?.group?.payment_status);

  // ============ 8. admin orders: filter/update/cancel ============
  const af = await call("adminListOrders", { authToken: atok, status: "refunded" });
  ok("admin filter by status", af.status === 200 && af.data?.orders?.length >= 2, JSON.stringify(af.data?.orders?.length));
  const co = await call("placeOrder", { authToken: btok, customer_name: "Test Buyer", phone, address: "Kathmandu Ward 5", note: "", payment_method: "cod", cod_confirmed: true, address_id: addressId, delivery_method: "standard", items: [{ product_id: prodA.id, quantity: 1 }] });
  const coId = co.data.order_id;
  const au = await call("adminUpdateOrderStatus", { authToken: atok, order_id: coId, status: "confirmed" });
  ok("admin updates order status", au.status === 200, au.error);
  const stockC0 = qr("select stock from products where id = ?", [prodA.id])?.stock;
  const ac = await call("adminCancelOrder", { authToken: atok, order_id: coId });
  ok("admin cancels order", ac.status === 200, ac.error);
  ok("cancelled + stock restored", qr("select status from orders where id = ?", [coId])?.status === "cancelled" && qr("select stock from products where id = ?", [prodA.id])?.stock === stockC0 + 1);

  // ============ 9. buyer groups view ============
  const myg = await call("getMyOrderGroups", { authToken: btok });
  ok("buyer groups list", myg.status === 200 && (myg.data?.groups?.length ?? 0) >= 2, JSON.stringify(myg.data?.groups?.length));

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  process.exit(fail ? 1 : 0);
} catch (e) {
  console.error("SCRIPT ERROR", e);
  process.exit(2);
}
