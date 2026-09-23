// v14 verification: pending-approval products must not leak onto the
// storefront. Reproduces the live bug from the video: a product with
// is_active=true and an active store but approval_status="pending" appeared
// on the homepage while its detail page 404'd ("This page could not load").
//
// Flow on a scratch DB:
//   1. seller registers (shop pending), logs in, adds a product
//      -> approval "pending", is_active forced false (draft)
//   2. admin moves the shop pending -> under_review -> active
//   3. seller publishes the product -> is_active=true, still "pending"
//      (this is the live DB's exact state)
//   4. assert getStorefront HIDES it and getProductDetail 404s  <- the fix
//      (before the fix, getStorefront listed it -> buyer taps -> error page)
//   5. admin approves the product -> it appears on the storefront and the
//      detail page loads.
//
// Usage: boot the server with ADMIN_EMAIL/ADMIN_PASSWORD on a scratch DB,
// then: ADMIN_EMAIL=... ADMIN_PASSWORD=... bun scripts/verify-storefront-approval.ts --port <port>
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

const suffix = String(Date.now()).slice(-6);
const email = `seller${suffix}@test.local`;

// --- admin ---
const adminLogin = await call("adminLogin", { email: process.env.ADMIN_EMAIL!, password: process.env.ADMIN_PASSWORD! });
const adminToken = adminLogin.data?.token;
ok("admin login", !!adminToken, adminLogin.error);

// --- seller registers (shop starts pending) ---
const reg = await call("registerSeller", {
  store_name: `Test Store ${suffix}`, tagline: "A test shop for approval flow",
  location: "Kathmandu", phone: "98" + suffix + "12",
  email, password: "testpass123", seller_key: "key-" + suffix + "-secret",
});
ok("seller registered", !!reg.data?.seller_code, reg.error);
const login = await call("sellerLogin", { email, password: "testpass123" });
const sellerToken = login.data?.token;
ok("seller login", !!sellerToken, login.error);

// Verify the seller's email via the captured verification email
// (server booted with EMAIL_TEST_CAPTURE=1).
const cap = await call("__testCapturedEmails", { clear: true });
const vmail = (cap.data?.emails ?? []).find((m: any) => m.to === email && m.subject.includes("Verify your"));
const vtoken = vmail?.text?.match(/verify-seller\?token=([a-f0-9]+)/)?.[1] ?? "";
ok("verification email captured", !!vtoken);
const ver = await call("verifySellerEmail", { token: vtoken });
ok("seller email verified", ver.status === 200, ver.error);

// --- seller adds a product while unapproved -> pending draft ---
const prod = await call("createProduct", {
  authToken: sellerToken, name: `Pending Widget ${suffix}`, category: "Test",
  description: "A widget awaiting approval.", price_paisa: 100000,
  delivery_fee_paisa: 0, stock: 5, is_active: true,
});
const productId = prod.data?.id;
ok("seller created product (pending draft)", !!productId && prod.data?.is_active === false, prod.error ?? JSON.stringify(prod.data));

// --- admin activates the shop: pending -> under_review -> active ---
const sellers = await call("adminListSellers", { authToken: adminToken });
const me = (sellers.data?.sellers ?? []).find((s: any) => s.email === email);
ok("shop found in admin list", !!me?.id, sellers.error);
for (const st of ["under_review", "active"]) {
  const r = await call("adminSetSellerStatus", { authToken: adminToken, seller_id: me.id, status: st });
  // Email verification already moves pending -> under_review, so the first
  // step may legitimately be a no-op.
  const alreadyThere = st === "under_review" && (r.error ?? "").includes(`from "under_review" to "under_review"`);
  ok(`shop -> ${st}`, r.status === 200 || alreadyThere, r.error);
}

// --- seller publishes -> is_active=true but STILL pending (the live state) ---
const upd = await call("updateProduct", {
  authToken: sellerToken, id: productId, name: `Pending Widget ${suffix}`, category: "Test",
  description: "A widget awaiting approval.", price_paisa: 100000,
  delivery_fee_paisa: 0, stock: 5, is_active: true,
});
ok("seller published product", upd.status === 200, upd.error);

// --- THE FIX: pending product must be invisible to buyers ---
const sf1 = await call("getStorefront", {});
const listed1 = (sf1.data?.products ?? []).some((p: any) => p.id === productId);
ok("pending product hidden from storefront", !listed1, `listed=${listed1}`);
const det1 = await call("getProductDetail", { product_id: productId });
ok("pending product detail 404s honestly", det1.error === "That product was not found.", det1.error ?? JSON.stringify(det1.data));

// --- admin approves the product -> goes live everywhere ---
const ap = await call("adminApproveProduct", { authToken: adminToken, product_id: productId });
ok("admin approved product", ap.status === 200, ap.error);
const sf2 = await call("getStorefront", {});
const listed2 = (sf2.data?.products ?? []).some((p: any) => p.id === productId);
ok("approved product appears on storefront", listed2);
const det2 = await call("getProductDetail", { product_id: productId });
ok("approved product detail loads", !det2.error && det2.data?.product?.id === productId, det2.error);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
