ALTER TABLE store_settings ADD COLUMN seller_code TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE store_settings ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
DELETE FROM buyer_issues;
--> statement-breakpoint
DELETE FROM reviews;
--> statement-breakpoint
DELETE FROM order_items;
--> statement-breakpoint
DELETE FROM orders;
--> statement-breakpoint
DELETE FROM products;
--> statement-breakpoint
DELETE FROM store_settings;
--> statement-breakpoint
CREATE UNIQUE INDEX store_settings_seller_code_unique ON store_settings(seller_code);
--> statement-breakpoint
ALTER TABLE products ADD COLUMN store_id INTEGER NOT NULL DEFAULT 1 REFERENCES store_settings(id);
--> statement-breakpoint
ALTER TABLE orders ADD COLUMN store_id INTEGER NOT NULL DEFAULT 1 REFERENCES store_settings(id);
--> statement-breakpoint
CREATE INDEX idx_products_store_id ON products(store_id);
--> statement-breakpoint
CREATE INDEX idx_orders_store_id ON orders(store_id);