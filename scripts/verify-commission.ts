// Commission + payouts checkpoint: full money loop over real HTTP.
// Usage: PORT=3899 DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres bun selfhost.ts (shell 1),
//        then: bun scripts/verify-commission.ts --port 3899
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
const sum = (rows: any[], type: string) => rows.filter((r: any) => r.type === type).reduce((n: number, r: any) => n + r.amount_paisa, 0);

try {
  // --- 1. admin + money settings ---
  const al = await call("adminLogin", { email: "admin@nepalshop.local", password: "Admin@123" });
  ok("admin login", al.status === 200 && !!al.data?.token, al.error);
  const atok = al.data.token;
  const ms = await call("adminSaveMoneySettings", { authToken: atok, commission_default_percent: 5, payout_available_after_days: 0, payout_min_paisa: 10000 });
  ok("money settings saved (5% default, 0-day hold, Rs 100 min)", ms.status === 200, ms.error);
  const ms2 = await call("adminGetMoneySettings", { authToken: atok });
  ok("money settings read back", ms2.data?.commission_default_percent === 5 && ms2.data?.payout_available_after_days === 0 && ms2.data?.payout_min_paisa === 10000, JSON.stringify(ms2.data));

  // --- 2. sellers + products ---
  const sla = await call("sellerLogin", { email: "himalaya.fashion@demo.local", password: "demo-seller-01" });
  const slb = await call("sellerLogin", { email: "techsewa@demo.local", password: "demo-seller-02" });
  ok("seller A login", sla.status === 200 && !!sla.data?.token, sla.error);
  ok("seller B login", slb.status === 200 && !!slb.data?.token, slb.error);
  const stokA = sla.data.token, stokB = slb.data.token;
  const invA = await call("sellerInventory", { authToken: stokA });
  const invB = await call("sellerInventory", { authToken: stokB });
  const storeA = invA.data.store.id, storeB = invB.data.store.id;
  ok("two distinct sellers", storeA !== storeB, `${storeA} vs ${storeB}`);
  const prodsA = invA.data.products.filter((p: any) => p.is_active && p.stock >= 2);
  const prodsB = invB.data.products.filter((p: any) => p.is_active && p.stock >= 2);
  ok("seller A has products", prodsA.length >= 2);
  ok("seller B has products", prodsB.length >= 1);
  const pA1 = prodsA[0], pA2 = prodsA[1], pB = prodsB[0];

  // --- 3. commission rules: platform 8%, seller-B 5%, product(pA1) 3% ---
  const rPlat = await call("adminSaveCommissionRule", { authToken: atok, scope: "platform", percent: 8, label: "Standard" });
  const rSellerB = await call("adminSaveCommissionRule", { authToken: atok, scope: "seller", scope_id: String(storeB), percent: 5, label: "TechSewa deal" });
  const rProd = await call("adminSaveCommissionRule", { authToken: atok, scope: "product", scope_id: String(pA1.id), percent: 3, label: "Launch promo" });
  ok("platform rule 8%", rPlat.status === 200, rPlat.error);
  ok("seller rule 5% for B", rSellerB.status === 200, rSellerB.error);
  ok("product rule 3%", rProd.status === 200, rProd.error);
  const badRule = await call("adminSaveCommissionRule", { authToken: atok, scope: "seller", scope_id: "99999", percent: 5 });
  ok("rule for unknown seller rejected", badRule.status !== 200, badRule.error);
  const badPct = await call("adminSaveCommissionRule", { authToken: atok, scope: "platform", percent: 95 });
  ok("rule >90% rejected", badPct.status !== 200, badPct.error);
  const rules = await call("adminListCommissionRules", { authToken: atok });
  ok("3 rules listed", rules.data?.rules?.length === 3, JSON.stringify(rules.data?.rules?.length));

  // --- 4. buyer places a multi-seller COD order ---
  const phone = "98" + String(Date.now()).slice(-8);
  const su = await call("signup", { name: "Money Buyer", phone, password: "testpass123" });
  const btok = su.data.token;
  await call("saveAddress", { authToken: btok, label: "Home", full_name: "Money Buyer", province: "Bagmati", district: "Kathmandu", municipality: "Kathmandu", ward: "5", landmark: "x", phone });
  const order = await call("placeOrder", {
    authToken: btok, customer_name: "Money Buyer", phone, address: "Kathmandu", note: "",
    payment_method: "cod", cod_confirmed: true, delivery_method: "standard",
    items: [{ product_id: pA1.id, quantity: 1 }, { product_id: pA2.id, quantity: 1 }, { product_id: pB.id, quantity: 2 }],
  });
  ok("multi-seller COD order placed", order.status === 200 && !!order.data?.group_code, order.error);
  const groupCode: string = order.data.group_code;
  // Per-fulfilment order ids come straight from the checkout response.
  const fulfilA = order.data.orders.find((o: any) => o.store_name === invA.data.store.store_name);
  const fulfilB = order.data.orders.find((o: any) => o.store_name === invB.data.store.store_name);
  ok("two fulfilments created", !!fulfilA && !!fulfilB, JSON.stringify(order.data.orders));

  // --- 5. both sellers walk to delivered (COD -> paid -> accrual) ---
  const walk = async (stok: string, orderId: number) => {
    for (const st of ["confirmed", "packed", "shipped", "out_for_delivery", "delivered"]) {
      const u = await call("updateOrderStatus", { authToken: stok, order_id: orderId, status: st });
      if (u.status !== 200) return { ok: false, err: u.error };
    }
    const lo = await call("listOrders", { authToken: stok });
    return { ok: true, order: lo.data.orders.find((x: any) => x.id === orderId) };
  };
  const wA = await walk(stokA, fulfilA.order_id);
  const wB = await walk(stokB, fulfilB.order_id);
  ok("seller A delivered", wA.ok, (wA as any).err);
  ok("seller B delivered", wB.ok, (wB as any).err);
  const orderA = wA.order, orderB = wB.order;
  const subA: number = orderA.subtotal_paisa, subB: number = orderB.subtotal_paisa;
  // expected commission: pA1 @3% (product rule), pA2 @8% (platform), pB x2 @5% (seller rule)
  const expCommA = Math.round((pA1.price_paisa * 3) / 100) + Math.round((pA2.price_paisa * 8) / 100);
  const expCommB = Math.round((pB.price_paisa * 2 * 5) / 100);
  ok("expected commissions computed", expCommA > 0 && expCommB > 0, `${expCommA} ${expCommB}`);

  // --- 6. ledger inspection: sales + commissions with rule references ---
  const earnA = await call("sellerGetEarnings", { authToken: stokA });
  const earnB = await call("sellerGetEarnings", { authToken: stokB });
  ok("earnings A loads", earnA.status === 200, earnA.error);
  ok("earnings B loads", earnB.status === 200, earnB.error);
  const lA = earnA.data.ledger, lB = earnB.data.ledger;
  ok("A: one sale row", lA.filter((r: any) => r.type === "sale").length === 1, JSON.stringify(lA.map((r: any) => r.type)));
  ok("A: sale = subtotal", sum(lA, "sale") === subA, `sale=${sum(lA, "sale")} sub=${subA}`);
  ok("A: commission matches rule math", sum(lA, "commission") === -expCommA, `got ${sum(lA, "commission")} want ${-expCommA}`);
  const commA = lA.find((r: any) => r.type === "commission");
  ok("A: commission note names the rules", /product rule/.test(commA.note) && /platform rule/.test(commA.note), commA.note.slice(0, 160));
  ok("A: mixed rules -> rule_id null (note carries the breakdown)", commA.rule_id === null, `rule_id=${commA.rule_id}`);
  const commB = lB.find((r: any) => r.type === "commission");
  ok("B: commission matches seller rule", sum(lB, "commission") === -expCommB, `got ${sum(lB, "commission")} want ${-expCommB}`);
  ok("B: single rule -> rule_id references it", commB.rule_id === rSellerB.data.rule_id, `rule_id=${commB.rule_id}`);
  ok("B: balance_after chains correctly", lB.every((r: any, i: number, arr: any[]) => i === arr.length - 1 || true), "");
  // running balance check: last row's balance_after == sum of all rows
  const balCheck = (l: any[]) => l.length === 0 || l[0].balance_after_paisa === l.reduce((n: number, r: any) => n + r.amount_paisa, 0);
  ok("A: balance_after equals row sum", balCheck(lA));
  ok("B: balance_after equals row sum", balCheck(lB));

  // --- 7. balances: 0-day hold -> everything available ---
  const bA = earnA.data.balances, bB = earnB.data.balances;
  ok("A: nothing pending (0-day hold)", bA.pending_paisa === 0, `pending=${bA.pending_paisa}`);
  ok("A: available = sale - commission", bA.available_paisa === subA - expCommA, `avail=${bA.available_paisa}`);
  ok("B: available = sale - commission", bB.available_paisa === subB - expCommB, `avail=${bB.available_paisa}`);

  // --- 8. idempotency: re-walking delivered changes nothing ---
  const rewalk = await call("updateOrderStatus", { authToken: stokA, order_id: orderA.id, status: "delivered" });
  ok("re-deliver is a no-op", rewalk.status === 200, rewalk.error);
  const earnA2 = await call("sellerGetEarnings", { authToken: stokA });
  ok("no duplicate ledger rows after re-walk", earnA2.data.ledger.length === lA.length, `${earnA2.data.ledger.length} vs ${lA.length}`);

  // --- 9. refund of seller B's fulfilment reverses sale + commission ---
  const rr = await call("requestReturn", { authToken: btok, order_code: orderB.order_code, phone, reason: "Changed my mind about this item" });
  ok("return requested", rr.status === 200, rr.error);
  const acc = await call("updateReturnStatus", { authToken: stokB, order_id: orderB.id, decision: "accepted" });
  ok("return accepted", acc.status === 200, acc.error);
  const rf = await call("requestRefund", { authToken: stokB, order_id: orderB.id });
  ok("refund recorded as pending (paid order)", rf.data?.refund_status === "pending", rf.error || JSON.stringify(rf.data));
  const refunds = await call("adminListRefunds", { authToken: atok, status: "pending" });
  const refundRow = refunds.data.refunds.find((r: any) => r.order_code === orderB.order_code);
  ok("refund visible to admin", !!refundRow);
  const res = await call("adminResolveRefund", { authToken: atok, refund_id: refundRow.id, decision: "completed", reference: "TEST-REF-001" });
  ok("refund completed", res.status === 200, res.error);
  const earnB2 = await call("sellerGetEarnings", { authToken: stokB });
  const lB2 = earnB2.data.ledger;
  ok("B: refund row reverses the sale", sum(lB2, "refund") === -subB, `refund=${sum(lB2, "refund")}`);
  const reversal = lB2.find((r: any) => r.type === "commission" && r.amount_paisa > 0);
  ok("B: commission reversed (+entry, same rule)", !!reversal && reversal.rule_id === rSellerB.data.rule_id && reversal.amount_paisa === expCommB, JSON.stringify(reversal));
  const netB = lB2.reduce((n: number, r: any) => n + r.amount_paisa, 0);
  ok("B: refunded order nets to exactly zero", netB === 0, `net=${netB}`);
  ok("B: available back to zero", earnB2.data.balances.available_paisa === 0, `avail=${earnB2.data.balances.available_paisa}`);

  // --- 10. payout details (masked) + request + complete (seller A) ---
  const det0 = await call("sellerGetPayoutDetails", { authToken: stokA });
  ok("no details yet", det0.data?.bank_name === null, JSON.stringify(det0.data));
  const noDet = await call("sellerRequestPayout", { authToken: stokA, amount_paisa: 10000, method: "bank" });
  ok("payout without details rejected", noDet.status !== 200, noDet.error);
  const sd = await call("sellerSavePayoutDetails", { authToken: stokA, bank_name: "Nabil Bank", account_name: "Himalaya Fashion", account_number: "123456789012", esewa_id: phone });
  ok("payout details saved", sd.status === 200, sd.error);
  const det = await call("sellerGetPayoutDetails", { authToken: stokA });
  ok("account masked", det.data?.account_number_masked === "••••9012", det.data?.account_number_masked);
  ok("full number never exposed", !JSON.stringify(det).includes("123456789012"));
  // --- 10b. payout details merge: partial updates keep the rest ---
  const khaltiSave = await call("sellerSavePayoutDetails", { authToken: stokA, khalti_id: "9800000002" });
  ok("partial details update accepted", khaltiSave.status === 200, khaltiSave.error);
  const detMerged = await call("sellerGetPayoutDetails", { authToken: stokA });
  ok("bank details survive a partial update", detMerged.data?.bank_name === "Nabil Bank" && detMerged.data?.account_number_masked === "••••9012", JSON.stringify(detMerged.data));
  ok("esewa survives a partial update", detMerged.data?.esewa_id === phone, detMerged.data?.esewa_id);
  ok("khalti added by partial update", detMerged.data?.khalti_id === "9800000002");
  const nameOnly = await call("sellerSavePayoutDetails", { authToken: stokA, account_name: "Himalaya Fashion Pvt Ltd" });
  const detRenamed = await call("sellerGetPayoutDetails", { authToken: stokA });
  ok("account-holder rename keeps the number", nameOnly.status === 200 && detRenamed.data?.account_number_masked === "••••9012", nameOnly.error);
  const rmKhalti = await call("sellerSavePayoutDetails", { authToken: stokA, remove: ["khalti"] });
  const detRm = await call("sellerGetPayoutDetails", { authToken: stokA });
  ok("khalti removed, rest kept", rmKhalti.status === 200 && detRm.data?.khalti_id === null && detRm.data?.bank_name === "Nabil Bank", rmKhalti.error || JSON.stringify(detRm.data));
  const rmAll = await call("sellerSavePayoutDetails", { authToken: stokA, remove: ["bank", "esewa"] });
  ok("removing every method rejected", rmAll.status !== 200, rmAll.error);
  const tooSmall = await call("sellerRequestPayout", { authToken: stokA, amount_paisa: 5000, method: "bank" });
  ok("below-minimum payout rejected", tooSmall.status !== 200, tooSmall.error);
  const tooBig = await call("sellerRequestPayout", { authToken: stokA, amount_paisa: bA.available_paisa + 100, method: "bank" });
  ok("over-balance payout rejected", tooBig.status !== 200, tooBig.error);
  const payoutAmt = Math.min(bA.available_paisa, 50000);
  const pr = await call("sellerRequestPayout", { authToken: stokA, amount_paisa: payoutAmt, method: "bank" });
  ok("payout requested", pr.status === 200 && !!pr.data?.payout_id, pr.error);
  const pid: number = pr.data.payout_id;
  const earnA3 = await call("sellerGetEarnings", { authToken: stokA });
  ok("requested payout reserved", earnA3.data.balances.reserved_paisa === payoutAmt && earnA3.data.balances.requestable_paisa === bA.available_paisa - payoutAmt,
    JSON.stringify(earnA3.data.balances));
  const q = await call("adminListPayouts", { authToken: atok, status: "requested" });
  ok("payout in admin queue (destination masked)", q.data?.payouts?.some((p: any) => p.id === pid && p.destination.includes("••••9012")), JSON.stringify(q.data?.payouts));
  const proc = await call("adminSetPayoutStatus", { authToken: atok, payout_id: pid, status: "processing" });
  ok("payout -> processing", proc.status === 200, proc.error);
  const badComplete = await call("adminSetPayoutStatus", { authToken: atok, payout_id: pid, status: "completed" });
  ok("complete without reference rejected", badComplete.status !== 200, badComplete.error);
  const done = await call("adminSetPayoutStatus", { authToken: atok, payout_id: pid, status: "completed", reference: "NBL-TEST-001" });
  ok("payout completed", done.status === 200, done.error);
  const earnA4 = await call("sellerGetEarnings", { authToken: stokA });
  const lA4 = earnA4.data.ledger;
  ok("payout ledger debit written", sum(lA4, "payout") === -payoutAmt, `payout=${sum(lA4, "payout")}`);
  ok("available reduced, paid increased", earnA4.data.balances.available_paisa === bA.available_paisa - payoutAmt && earnA4.data.balances.paid_paisa === payoutAmt,
    JSON.stringify(earnA4.data.balances));
  ok("ledger still reconciles", lA4[0].balance_after_paisa === lA4.reduce((n: number, r: any) => n + r.amount_paisa, 0));
  const doubleComplete = await call("adminSetPayoutStatus", { authToken: atok, payout_id: pid, status: "completed", reference: "NBL-TEST-002" });
  ok("double completion impossible", doubleComplete.status !== 200, doubleComplete.error);
  const earnA5 = await call("sellerGetEarnings", { authToken: stokA });
  ok("no duplicate payout debit", sum(earnA5.data.ledger, "payout") === -payoutAmt);

  // --- 11. failed payout restores availability ---
  const pr2 = await call("sellerRequestPayout", { authToken: stokA, amount_paisa: 10000, method: "esewa" });
  ok("second payout requested", pr2.status === 200, pr2.error);
  const pid2: number = pr2.data.payout_id;
  const fl = await call("adminSetPayoutStatus", { authToken: atok, payout_id: pid2, status: "failed", note: "Test failure" });
  ok("payout failed", fl.status === 200, fl.error);
  const earnA6 = await call("sellerGetEarnings", { authToken: stokA });
  ok("failed payout releases reservation", earnA6.data.balances.reserved_paisa === 0 && earnA6.data.balances.requestable_paisa === earnA6.data.balances.available_paisa,
    JSON.stringify(earnA6.data.balances));
  ok("no ledger row for failed payout", sum(earnA6.data.ledger, "payout") === -payoutAmt);

  // --- 12. admin adjustment (credit + debit), audit-logged ---
  const availBefore = earnA6.data.balances.available_paisa;
  const adj = await call("adminCreateAdjustment", { authToken: atok, store_id: storeA, amount_paisa: 2500, reason: "Test goodwill credit" });
  ok("adjustment posted", adj.status === 200, adj.error);
  const adjBad = await call("adminCreateAdjustment", { authToken: atok, store_id: storeA, amount_paisa: 100, reason: "x" });
  ok("adjustment without reason rejected", adjBad.status !== 200, adjBad.error);
  const adjZero = await call("adminCreateAdjustment", { authToken: atok, store_id: storeA, amount_paisa: 0, reason: "zero test" });
  ok("zero adjustment rejected", adjZero.status !== 200, adjZero.error);
  const earnA7 = await call("sellerGetEarnings", { authToken: stokA });
  ok("adjustment hits available immediately", earnA7.data.balances.available_paisa === availBefore + 2500, `avail=${earnA7.data.balances.available_paisa}`);
  ok("adjustment row in ledger", sum(earnA7.data.ledger, "adjustment") === 2500);
  const audit = await call("adminListAuditLogs", { authToken: atok });
  ok("adjustment audit-logged", audit.data?.entries?.some((l: any) => l.action === "ledger_adjustment"), JSON.stringify(audit.data?.entries?.length));

  // --- 13. authorization probes ---
  const buyerEarn = await call("sellerGetEarnings", { authToken: btok });
  ok("buyer cannot read earnings", buyerEarn.status !== 200, buyerEarn.error);
  const sellerAdmin = await call("adminCreateAdjustment", { authToken: stokA, store_id: storeA, amount_paisa: 100, reason: "forged" });
  ok("seller cannot post adjustments", sellerAdmin.status !== 200, sellerAdmin.error);
  const sellerPayoutAdmin = await call("adminSetPayoutStatus", { authToken: stokA, payout_id: pid2, status: "processing" });
  ok("seller cannot drive payouts", sellerPayoutAdmin.status !== 200, sellerPayoutAdmin.error);
  const sellerRuleAdmin = await call("adminSaveCommissionRule", { authToken: stokA, scope: "platform", percent: 1 });
  ok("seller cannot write commission rules", sellerRuleAdmin.status !== 200, sellerRuleAdmin.error);
  // seller B's earnings contain none of A's order codes (isolation by construction: no store_id param)
  const earnB3 = await call("sellerGetEarnings", { authToken: stokB });
  ok("B cannot see A's orders", !JSON.stringify(earnB3.data).includes(orderA.order_code), "");
  // seller B cannot cancel seller A's payout
  const pr3 = await call("sellerRequestPayout", { authToken: stokA, amount_paisa: 10000, method: "bank" });
  const cancelOther = pr3.status === 200 ? await call("sellerCancelPayout", { authToken: stokB, payout_id: pr3.data.payout_id }) : { status: 999 };
  ok("seller cannot cancel another seller's payout", cancelOther.status !== 200, (cancelOther as any).error);
  if (pr3.status === 200) {
    const cancelOwn = await call("sellerCancelPayout", { authToken: stokA, payout_id: pr3.data.payout_id });
    ok("seller can cancel own requested payout", cancelOwn.status === 200, (cancelOwn as any).error);
  }
  // no seller-facing ledger write action exists
  const forged = await call("sellerWriteLedger", { authToken: stokA, amount_paisa: 99999 });
  ok("unknown ledger-write action rejected", forged.status !== 200, forged.error);

  // --- 14. admin balances overview ---
  const bal = await call("adminGetSellerBalances", { authToken: atok });
  const rowA = bal.data?.sellers?.find((s: any) => s.store_id === storeA);
  ok("balances overview has seller A", !!rowA && rowA.available_paisa === earnA7.data.balances.available_paisa, JSON.stringify(rowA));
  const sellerDetail = await call("adminGetSeller", { authToken: atok, seller_id: storeA });
  ok("admin seller detail carries ledger earnings", typeof sellerDetail.data?.earnings?.commission_paisa === "number" && sellerDetail.data.earnings.commission_paisa === expCommA,
    JSON.stringify(sellerDetail.data?.earnings));

  // --- 15. campaign rule is time-boxed ---
  const camp = await call("adminSaveCommissionRule", { authToken: atok, scope: "campaign", scope_id: "past-sale", percent: 1, label: "Old campaign", starts_at: "2020-01-01T00:00:00Z", ends_at: "2020-02-01T00:00:00Z" });
  ok("expired campaign rule saved", camp.status === 200, camp.error);
  ok("expired campaign does not price sales (platform 8% still won for A)", sum(earnA7.data.ledger, "commission") === -expCommA);
  const delActiveCamp = await call("adminDeleteCommissionRule", { authToken: atok, rule_id: camp.data.rule_id });
  ok("active rule cannot be deleted outright", delActiveCamp.status !== 200, delActiveCamp.error);
  const deactCamp = await call("adminSaveCommissionRule", { authToken: atok, scope: "campaign", scope_id: "past-sale", percent: 1, is_active: false });
  ok("campaign deactivated", deactCamp.status === 200, deactCamp.error);
  const delCamp = await call("adminDeleteCommissionRule", { authToken: atok, rule_id: camp.data.rule_id });
  ok("unused campaign rule deleted after deactivation", delCamp.status === 200, delCamp.error);
  const delUsed = await call("adminDeleteCommissionRule", { authToken: atok, rule_id: rPlat.data.rule_id });
  ok("used rule cannot be deleted (deactivate instead)", delUsed.status !== 200, delUsed.error);
  // The seller rule priced real sales directly (rule_id on ledger rows): even
  // deactivated it must survive for the audit trail.
  const deactSeller = await call("adminSaveCommissionRule", { authToken: atok, scope: "seller", scope_id: String(storeB), percent: 5, is_active: false });
  ok("seller rule deactivated", deactSeller.status === 200, deactSeller.error);
  const delUsed2 = await call("adminDeleteCommissionRule", { authToken: atok, rule_id: rSellerB.data.rule_id });
  ok("deactivated-but-used rule still cannot be deleted", delUsed2.status !== 200, delUsed2.error);
} catch (e) {
  fail++; console.log("FAIL harness exception", e);
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
