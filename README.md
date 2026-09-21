# Nepal Shopping Site (self-hosted)

A full-stack marketplace web app for Nepal — customer storefront, seller
dashboards, COD checkout, order tracking, reviews and buyer-issue handling.

## Run it

Requirements: [Bun](https://bun.sh) 1.3 or newer.

```bash
bun install     # installs dependencies (the SDK is vendored in ./vendor)
bun start       # serves the site at http://localhost:3000
```

Open **http://localhost:3000** in your browser.

- `PORT=8080 bun start` — run on a different port
- `DB_PATH=./data/app.db bun start` — point at a different database file
- `bun run build` — rebuild the frontend from `client/src` (a prebuilt
  copy is already included in `client/dist`)

## Try it

The database (`data/app.db`) ships with 3 demo sellers and 12 products.

Demo seller keys (seller dashboard → sign in with seller code + key):

| Store               | Seller code   | Key            |
|---------------------|---------------|----------------|
| Himalaya Fashion    | SELL-BDC364DC | demo-seller-01 |
| TechSewa Electronics| SELL-06A3B75B | demo-seller-02 |
| Nepali Hastakala    | SELL-05DC3C59 | demo-seller-03 |

As a customer you can browse, add to basket, check out with Cash on
Delivery, and track the order with the order code + phone number. Sellers
can add products, confirm/pack/ship orders, and resolve buyer issues.

## What's inside

- `client/src` — React storefront + seller dashboard (TypeScript)
- `client/dist` — prebuilt static bundle served by `selfhost.ts`
- `server/src/actions.ts` — all 16 backend actions (products, orders,
  sellers, reviews, issues); validated with Zod
- `server/src/schema.ts` — database tables (Drizzle ORM)
- `drizzle/` — SQL migrations for a fresh database
- `data/app.db` — SQLite database with the demo data
- `selfhost.ts` — small Bun server: serves the site and answers the
  `POST /actions` RPC the frontend expects
- `vendor/space-sdk.tgz` — the action/RPC contract library (offline copy)

## Notes

- Payments are Cash on Delivery with an order-confirmation step. Real
  eSewa/Khalti checkout is not connected — that needs merchant credentials
  and their checkout APIs.
- To start from an empty shop instead of the demo data, delete
  `data/app.db` and apply the migrations in `drizzle/` to a fresh file.
- Seller keys are demo values. Before any real use, register fresh sellers
  and pick strong keys.
