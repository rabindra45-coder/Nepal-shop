-- Demo seed for Nepal Shop (Supabase Postgres).
--
-- Idempotent: every INSERT is ON CONFLICT DO NOTHING, and serial sequences
-- are re-anchored to max(id) afterwards, so re-running this file is a no-op.
-- Applied automatically at server boot AFTER supabase/schema.sql, unless
-- SKIP_SEED=1 is set (production must set SKIP_SEED=1 so demo sellers,
-- whose credentials are documented, are never created in production).
--
-- Contents (mirrors the bundled SQLite demo database from the v6 era):
--   1 admin (admin@nepalshop.local), 3 demo sellers, 5 categories,
--   5 homepage sections, 2 homepage banners, 2 coupons (WELCOME10/FREESHIP),
--   12 demo products, 1 platform_settings row.

-- admins: 1 row(s)
INSERT INTO "admins" ("id", "name", "email", "password_hash", "created_at")
VALUES ('admin-1', 'Site Admin', 'admin@nepalshop.local', '$2b$10$vTwqS8JIRZOFf5MjDns9IO1XH/Z5guA3PhQRniTxhxnMKQTUNmYiK', to_timestamp(1790006400000/1000.0))
ON CONFLICT DO NOTHING;

-- store_settings: 3 row(s)
INSERT INTO "store_settings" ("id", "seller_code", "store_name", "tagline", "location", "phone", "admin_key_hash", "email", "password_hash", "status", "email_verified", "created_at", "updated_at")
VALUES (1, 'SELL-06A3B75B', 'TechSewa Electronics', 'Gadgets at honest prices', 'Lalitpur', '9800000002', '21fe42ce1cc49b80fadc21d1e644761ba9eaf24923f0344a3a4dc86e4e98312c', 'techsewa@demo.local', '$2b$10$RN6zIhSqIOMCRDkJqMpRnOFco6Pc1Tifttq45lctQUf.DiHnkDf9C', 'active', TRUE, to_timestamp(1790006750290/1000.0), to_timestamp(1790006750290/1000.0))
ON CONFLICT DO NOTHING;
INSERT INTO "store_settings" ("id", "seller_code", "store_name", "tagline", "location", "phone", "admin_key_hash", "email", "password_hash", "status", "email_verified", "created_at", "updated_at")
VALUES (2, 'SELL-05DC3C59', 'Nepali Hastakala', 'Authentic Nepali handicrafts', 'Bhaktapur', '9800000003', 'f8a2eee057808ee7ca9392ca6146540709893b10d38b9b6f19fd3b1def1645d5', 'hastakala@demo.local', '$2b$10$6Ao803SSGWbUl1lkM6ucueOeoOAEcNaDQEb7kd6EPb42sF2CGrxRK', 'active', TRUE, to_timestamp(1790006750327/1000.0), to_timestamp(1790006750327/1000.0))
ON CONFLICT DO NOTHING;
INSERT INTO "store_settings" ("id", "seller_code", "store_name", "tagline", "location", "phone", "admin_key_hash", "email", "password_hash", "status", "email_verified", "created_at", "updated_at")
VALUES (3, 'SELL-BDC364DC', 'Himalaya Fashion', 'Trendy wear for Nepal', 'Kathmandu', '9800000001', 'deb980fc7337e7b4d4b44ea5714a579b91484d2c8a950be49ca677b1f50ec6dd', 'himalaya.fashion@demo.local', '$2b$10$fCyTBmvFKwI9N5GTKpjqm.RbSiwMxTCIkltyEQOHXpCOal6vzoDF6', 'active', TRUE, to_timestamp(1790006750353/1000.0), to_timestamp(1790006750353/1000.0))
ON CONFLICT DO NOTHING;

-- categories: 5 row(s)
INSERT INTO "categories" ("id", "name", "slug", "is_active")
VALUES (1, 'Electronics', 'electronics', TRUE)
ON CONFLICT DO NOTHING;
INSERT INTO "categories" ("id", "name", "slug", "is_active")
VALUES (2, 'Footwear', 'footwear', TRUE)
ON CONFLICT DO NOTHING;
INSERT INTO "categories" ("id", "name", "slug", "is_active")
VALUES (3, 'Fashion', 'fashion', TRUE)
ON CONFLICT DO NOTHING;
INSERT INTO "categories" ("id", "name", "slug", "is_active")
VALUES (4, 'Handicrafts', 'handicrafts', TRUE)
ON CONFLICT DO NOTHING;
INSERT INTO "categories" ("id", "name", "slug", "is_active")
VALUES (5, 'Stationery', 'stationery', TRUE)
ON CONFLICT DO NOTHING;

-- homepage_sections: 5 row(s)
INSERT INTO "homepage_sections" ("key", "title", "is_active", "sort_order")
VALUES ('trending', 'Trending now', TRUE, 0)
ON CONFLICT DO NOTHING;
INSERT INTO "homepage_sections" ("key", "title", "is_active", "sort_order")
VALUES ('new_arrivals', 'New arrivals', TRUE, 1)
ON CONFLICT DO NOTHING;
INSERT INTO "homepage_sections" ("key", "title", "is_active", "sort_order")
VALUES ('best_sellers', 'Best sellers', TRUE, 2)
ON CONFLICT DO NOTHING;
INSERT INTO "homepage_sections" ("key", "title", "is_active", "sort_order")
VALUES ('flash_deals', 'Flash deals', TRUE, 3)
ON CONFLICT DO NOTHING;
INSERT INTO "homepage_sections" ("key", "title", "is_active", "sort_order")
VALUES ('recommended', 'Recommended for you', TRUE, 4)
ON CONFLICT DO NOTHING;

-- homepage_banners: 2 row(s)
INSERT INTO "homepage_banners" ("id", "title", "subtitle", "link", "is_active", "sort_order")
VALUES (1, 'Festival Sale — up to 30% off', 'Big discounts across electronics, fashion and handicrafts.', '#/search', TRUE, 0)
ON CONFLICT DO NOTHING;
INSERT INTO "homepage_banners" ("id", "title", "subtitle", "link", "is_active", "sort_order")
VALUES (2, 'New sellers join free this month', 'Open your store on Nepal Shop in minutes.', '#/seller/login', TRUE, 1)
ON CONFLICT DO NOTHING;

-- coupons: 2 row(s)
INSERT INTO "coupons" ("id", "code", "kind", "value", "min_order_paisa", "max_uses", "per_user_limit", "expires_at", "is_active", "created_at")
VALUES (1, 'WELCOME10', 'percent', 10, 100000, 500, 1, to_timestamp(1797789658000/1000.0), TRUE, to_timestamp(1790013658000/1000.0))
ON CONFLICT DO NOTHING;
INSERT INTO "coupons" ("id", "code", "kind", "value", "min_order_paisa", "max_uses", "per_user_limit", "expires_at", "is_active", "created_at")
VALUES (2, 'FREESHIP', 'free_shipping', 0, 150000, 200, 1, to_timestamp(1795197658000/1000.0), TRUE, to_timestamp(1790013658000/1000.0))
ON CONFLICT DO NOTHING;

-- products: 12 row(s)
INSERT INTO "products" ("id", "store_id", "name", "category", "description", "price_paisa", "delivery_fee_paisa", "stock", "brand", "original_price_paisa", "low_stock_threshold", "is_active", "created_at", "updated_at")
VALUES (1, 1, 'Wireless Earbuds', 'Electronics', 'Bluetooth earbuds with charging case, 24h battery', 299900, 9900, 30, 'TechSewa', 374875, 5, TRUE, to_timestamp(1790006756387/1000.0), to_timestamp(1790006756384/1000.0))
ON CONFLICT DO NOTHING;
INSERT INTO "products" ("id", "store_id", "name", "category", "description", "price_paisa", "delivery_fee_paisa", "stock", "brand", "original_price_paisa", "low_stock_threshold", "is_active", "created_at", "updated_at")
VALUES (2, 3, 'Running Sneakers', 'Footwear', 'Lightweight running sneakers for daily use', 459900, 12900, 12, 'Himalaya Weaves', 574875, 5, TRUE, to_timestamp(1790006756456/1000.0), to_timestamp(1790006756455/1000.0))
ON CONFLICT DO NOTHING;
INSERT INTO "products" ("id", "store_id", "name", "category", "description", "price_paisa", "delivery_fee_paisa", "stock", "brand", "original_price_paisa", "low_stock_threshold", "is_active", "created_at", "updated_at")
VALUES (3, 3, 'Pashmina Shawl', 'Fashion', 'Soft handwoven pashmina shawl made in Kathmandu', 249900, 9900, 25, 'Himalaya Weaves', 312375, 5, TRUE, to_timestamp(1790006756497/1000.0), to_timestamp(1790006756495/1000.0))
ON CONFLICT DO NOTHING;
INSERT INTO "products" ("id", "store_id", "name", "category", "description", "price_paisa", "delivery_fee_paisa", "stock", "brand", "original_price_paisa", "low_stock_threshold", "is_active", "created_at", "updated_at")
VALUES (4, 3, 'Kurtha Set', 'Fashion', 'Cotton kurtha with embroidered shawl, festive wear', 319900, 9900, 15, 'Himalaya Weaves', 399875, 5, TRUE, to_timestamp(1790006756522/1000.0), to_timestamp(1790006756522/1000.0))
ON CONFLICT DO NOTHING;
INSERT INTO "products" ("id", "store_id", "name", "category", "description", "price_paisa", "delivery_fee_paisa", "stock", "brand", "original_price_paisa", "low_stock_threshold", "is_active", "created_at", "updated_at")
VALUES (5, 1, 'Bluetooth Speaker', 'Electronics', 'Portable waterproof Bluetooth speaker', 349900, 9900, 20, 'TechSewa', 437375, 5, TRUE, to_timestamp(1790006756551/1000.0), to_timestamp(1790006756551/1000.0))
ON CONFLICT DO NOTHING;
INSERT INTO "products" ("id", "store_id", "name", "category", "description", "price_paisa", "delivery_fee_paisa", "stock", "brand", "original_price_paisa", "low_stock_threshold", "is_active", "created_at", "updated_at")
VALUES (6, 1, 'Smart Watch', 'Electronics', 'Fitness smartwatch with heart-rate tracking', 549900, 9900, 18, 'TechSewa', 687375, 5, TRUE, to_timestamp(1790006756579/1000.0), to_timestamp(1790006756579/1000.0))
ON CONFLICT DO NOTHING;
INSERT INTO "products" ("id", "store_id", "name", "category", "description", "price_paisa", "delivery_fee_paisa", "stock", "brand", "original_price_paisa", "low_stock_threshold", "is_active", "created_at", "updated_at")
VALUES (7, 3, 'Leather Wallet', 'Fashion', 'Genuine leather wallet with multiple card slots', 89900, 7900, 40, 'Himalaya Weaves', 112375, 5, TRUE, to_timestamp(1790006756599/1000.0), to_timestamp(1790006756599/1000.0))
ON CONFLICT DO NOTHING;
INSERT INTO "products" ("id", "store_id", "name", "category", "description", "price_paisa", "delivery_fee_paisa", "stock", "brand", "original_price_paisa", "low_stock_threshold", "is_active", "created_at", "updated_at")
VALUES (8, 1, 'Power Bank 20000mAh', 'Electronics', 'Fast-charging 20000mAh power bank', 219900, 7900, 35, 'TechSewa', 274875, 5, TRUE, to_timestamp(1790006756630/1000.0), to_timestamp(1790006756630/1000.0))
ON CONFLICT DO NOTHING;
INSERT INTO "products" ("id", "store_id", "name", "category", "description", "price_paisa", "delivery_fee_paisa", "stock", "brand", "original_price_paisa", "low_stock_threshold", "is_active", "created_at", "updated_at")
VALUES (9, 2, 'Thangka Painting', 'Handicrafts', 'Hand-painted traditional thangka on cotton canvas', 799900, 14900, 6, 'Nepali Hastakala', 999875, 5, TRUE, to_timestamp(1790006756655/1000.0), to_timestamp(1790006756655/1000.0))
ON CONFLICT DO NOTHING;
INSERT INTO "products" ("id", "store_id", "name", "category", "description", "price_paisa", "delivery_fee_paisa", "stock", "brand", "original_price_paisa", "low_stock_threshold", "is_active", "created_at", "updated_at")
VALUES (10, 2, 'Decorative Khukuri', 'Handicrafts', 'Handcrafted decorative khukuri with wooden sheath', 499900, 14900, 10, 'Nepali Hastakala', 624875, 5, TRUE, to_timestamp(1790006756678/1000.0), to_timestamp(1790006756678/1000.0))
ON CONFLICT DO NOTHING;
INSERT INTO "products" ("id", "store_id", "name", "category", "description", "price_paisa", "delivery_fee_paisa", "stock", "brand", "original_price_paisa", "low_stock_threshold", "is_active", "created_at", "updated_at")
VALUES (11, 2, 'Lokta Paper Notebook', 'Stationery', 'Eco-friendly lokta paper notebook, 100 pages', 49900, 5900, 50, 'Nepali Hastakala', 62375, 5, TRUE, to_timestamp(1790006756712/1000.0), to_timestamp(1790006756712/1000.0))
ON CONFLICT DO NOTHING;
INSERT INTO "products" ("id", "store_id", "name", "category", "description", "price_paisa", "delivery_fee_paisa", "stock", "brand", "original_price_paisa", "low_stock_threshold", "is_active", "created_at", "updated_at")
VALUES (12, 2, 'Singing Bowl', 'Handicrafts', 'Hand-hammered Tibetan singing bowl with mallet', 329900, 12900, 14, 'Nepali Hastakala', 412375, 5, TRUE, to_timestamp(1790006756745/1000.0), to_timestamp(1790006756745/1000.0))
ON CONFLICT DO NOTHING;

-- Re-anchor serial sequences: the seeds use explicit ids, so without
-- this the next nextval() would collide with a seeded row. The is_called=false
-- form makes the next value exactly max(id)+1 (or 1 on an empty table).
SELECT setval(pg_get_serial_sequence('store_settings', 'id'), COALESCE((SELECT max("id") FROM "store_settings"), 0) + 1, false);
SELECT setval(pg_get_serial_sequence('categories', 'id'), COALESCE((SELECT max("id") FROM "categories"), 0) + 1, false);
SELECT setval(pg_get_serial_sequence('homepage_banners', 'id'), COALESCE((SELECT max("id") FROM "homepage_banners"), 0) + 1, false);
SELECT setval(pg_get_serial_sequence('coupons', 'id'), COALESCE((SELECT max("id") FROM "coupons"), 0) + 1, false);
SELECT setval(pg_get_serial_sequence('products', 'id'), COALESCE((SELECT max("id") FROM "products"), 0) + 1, false);
-- platform_settings: absent from the bundled SQLite DB (migration 0056
-- backfills it there with INSERT OR IGNORE); seeded here for parity.
INSERT INTO "platform_settings" ("key", "value", "updated_at")
VALUES ('site_logo_url', '', to_timestamp(0))
ON CONFLICT DO NOTHING;
