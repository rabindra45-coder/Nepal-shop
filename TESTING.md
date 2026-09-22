# Testing checklist — Nepal Shop (phase 2)

Simple English, repeatable steps. Everything below runs against a throwaway
database in `/tmp` — never against the bundled `data/app.db` and never against
production.

## Automated suite (covers sections a–h)

A scripted version of this whole checklist lives at
`/tmp/shopbuild/v3/v3test/run.ts`. It boots real `selfhost.ts` servers on
fresh copies of the demo database, drives them over `POST /actions`, checks
77 assertions, then kills every server.

```bash
cd /tmp/shopbuild/v3/v3test && bun run.ts
```

Expected result: `77 passed, 0 failed`. Per-section counts are printed at the
end (a: 22, b: 13, c: 8, d: 8, e: 5, f: 2, g: 4, h: 11, seo: 4).

Notes on the script:

- Each section boots its own server on its own DB copy (ports 3220+), so
  sections never contaminate each other.
- Boot also deletes stale `-wal`/`-shm` sidecar files and kills leftover
  `selfhost.ts` test processes, so re-runs are clean.
- All servers are killed in a `finally` block. Confirm with
  `ps aux | grep selfhost` afterwards — nothing should remain.

## Manual walkthrough

Start a scratch server (in a terminal you can close afterwards):

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres PORT=3333 bun selfhost.ts
```
(The server applies `supabase/schema.sql` and the demo seed on boot; point
`DATABASE_URL` at a scratch database.)

Call any action with `curl` like this (replace `ACTION` and `ARGS`):

```bash
curl -s http://localhost:3333/actions \
  -H 'content-type: application/json' \
  -d '{"action":"ACTION","args":ARGS}' | python3 -m json.tool
```

Example:

```bash
curl -s http://localhost:3333/actions \
  -H 'content-type: application/json' \
  -d '{"action":"getStorefront","args":{}}' | python3 -m json.tool
```

### (a) Full buyer journey

1. `getHomepage {}` → banners and named sections with products.
2. `searchProducts {"query":"earbuds"}` → finds "Wireless Earbuds".
3. `getProductDetail {"product_id":1}` → product, reviews, related, seller card.
4. `signup {"name":"Test","phone":"9800000001","password":"Test@1234"}` → token.
5. `toggleWishlist {"authToken":TOKEN,"product_id":1}` → `{"wishlisted":true}`.
6. `addToCart {"authToken":TOKEN,"product_id":1,"quantity":2}` → subtotal 599800.
7. `updateCartItem {"authToken":TOKEN,"product_id":1,"quantity":3}`.
8. `saveAddress {"authToken":TOKEN,"full_name":"Test","phone":"9800000001","province":"Bagmati","district":"Kathmandu","municipality":"Kathmandu"}` → id.
9. `validateCoupon {"authToken":TOKEN,"code":"WELCOME10","subtotal_paisa":949700}` → valid, discount 94970.
10. `placeOrder` with `authToken`, `customer_name`, `phone`, `address`,
    `delivery_method:"express"`, `payment_method:"cod"`,
    `items:[{"product_id":1,"quantity":2},{"product_id":5,"quantity":1}]` →
    total 896430 paisa, status `confirmation_needed`, payment `pending`.
11. `getProductDetail {"product_id":1}` → stock dropped 30 → 28.
12. `getMyOrders {"authToken":TOKEN}` → shows the order.
13. `adminLogin {"email":"admin@nepalshop.local","password":"Admin@123"}` →
    admin token; `adminListOrders {"authToken":ADMIN}` → shows the order.
14. `sellerLogin {"email":"techsewa@demo.local","password":"demo-seller-02"}` →
    seller token; `listOrders {"authToken":SELLER}` → shows the order.
15. `updateOrderStatus {"authToken":SELLER,"order_id":ID,"status":"confirmed"}`
    then `packed`, `shipped`, `out_for_delivery`, `delivered` → each `{"ok":true}`.
16. `trackOrder {"order_code":CODE,"phone":"9800000001"}` → status `delivered`.
17. `addReview {"order_code":CODE,"phone":"9800000001","product_id":1,"rating":5,"body":"Great earbuds, fast delivery!"}` → ok.
18. `getNotifications {"authToken":TOKEN}` → types include `order_placed` and
    `order_status`.

### (b) Fresh empty database

1. Boot against an empty Postgres database with `SKIP_SEED=1`. No seed
   copy happens; `supabase/schema.sql` must apply with no errors in the
   server log.
2. `signup` → works. `adminLogin` with the dev admin → works (seeded by migration).
3. `registerSeller` → returns `SELL-…`; `adminListSellers` → status `pending`.
4. `getStorefront` → 0 sellers, 0 products while pending.
5. `adminSetSellerStatus {"authToken":ADMIN,"seller_id":ID,"status":"active"}`.
6. `sellerLogin` with the new email+password → works.
7. `createProduct` → id; `getStorefront` → 1 product.
8. Guest `placeOrder` (COD) → `confirmation_needed`; `trackOrder` → found.
9. Delete the file, boot again with a path that does not exist → the server
   copies `data/app.db`; `getStorefront` → 12 products, 3 sellers.
### (c) Seeded demo database

1. Boot with a fresh copy of `data/app.db`.
2. `getStorefront` → 12 products, `seller_count` 3.
3. For each demo seller, `sellerLogin` with email + key-as-password AND
   `sellerInventory` with `seller_code` + `seller_key` → both work.
4. `adminLogin` with the dev admin → works.

### (d) Coupon edge cases

Create test coupons with `adminSaveCoupon` (admin token): an expired one, one
with a very high `min_order_paisa`, one with `max_uses:1`, one with
`per_user_limit:1`. For each:

1. `validateCoupon` → `{"valid":false}` with a clear message (expired /
   minimum order / usage limit / already used).
2. `placeOrder` with the bad code → the action throws; no order is created.

Then use the `max_uses:1` coupon once → the second use (any buyer) is
rejected. Use the `per_user_limit:1` coupon once → the same buyer's second
use is rejected.

### (e) Oversell protection

1. As the TechSewa seller, `updateProduct` on product 8 with `stock:1`
   (keep the other fields as they are).
2. As a buyer, `addToCart {"product_id":8,"quantity":2}` → rejected
   ("only 1 left").
3. `placeOrder` with quantity 2 → rejected.
4. `placeOrder` with quantity 1 → succeeds.
5. `placeOrder` with quantity 1 again → rejected ("only 0 left").
6. `getProductDetail {"product_id":8}` → stock is exactly 0, never negative.

### (f) Online payments without credentials

1. Boot with no `ESEWA_*` / `KHALTI_*` env vars set.
2. `placeOrder` with `payment_method:"esewa"` (no `cod_confirmed` needed).
3. `initiateOnlinePayment {"order_id":ID,"provider":"esewa","phone":PHONE}` →
   throws "eSewa payments are not configured yet…". Same for `khalti`.
4. Confirm the error is thrown, never a success payload with a payment URL.

### (g) AI assistant

1. `askAssistant {"question":"Find me a phone under Rs. 30,000"}` →
   returns real products from the catalogue.
2. `askAssistant {"question":"Compare Wireless Earbuds and Bluetooth Speaker"}` →
   a comparison with rows (Price, Rating, Discount, Stock, Seller,
   Delivery fee).
3. `askAssistant {"question":"xqzblorp flibbertigibbet"}` → an honest
   "could not find" answer, no products.
4. Every product name in every answer exists in `getStorefront` — the
   assistant never invents products.

### (h) v1/v2 regression

1. Guest COD `placeOrder` with no `authToken` → `confirmation_needed`.
2. `trackOrder` with code + correct phone → the order; with a wrong phone →
   `{"order":null}`.
3. `sellerInventory` with legacy `seller_code` + `seller_key` → works.
4. `registerSeller` → pending; the seller's product stays out of
   `getStorefront` until `adminSetSellerStatus` sets them `active`.
5. `adminSetSellerStatus` → `suspended` → the seller's products vanish from
   the storefront; back to `active` → they return.
6. `reportIssue` → `adminListIssues` shows it as `open` →
   `adminResolveIssue` → `resolved`.
7. `login` → `logout` → `getMe` with the old token throws (expired session).

### SEO / PWA routes

With the server running, open in a browser or `curl`:

- `/sitemap.xml` → one `<url>` per active product of an active seller,
  pointing at `/#/product/{id}`.
- `/robots.txt` → allows `/`, names the sitemap.
- `/manifest.webmanifest` → JSON with name "Nepal Shop", `start_url` `/#/`.
