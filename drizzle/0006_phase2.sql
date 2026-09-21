CREATE TABLE `carts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `carts_user_id_unique` ON `carts` (`user_id`);
--> statement-breakpoint
CREATE TABLE `cart_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`cart_id` integer NOT NULL REFERENCES `carts`(`id`) ON DELETE CASCADE,
	`product_id` integer NOT NULL REFERENCES `products`(`id`),
	`quantity` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cart_items_cart_product_unique` ON `cart_items` (`cart_id`, `product_id`);
--> statement-breakpoint
CREATE TABLE `addresses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`label` text DEFAULT 'Home' NOT NULL,
	`full_name` text NOT NULL,
	`phone` text NOT NULL,
	`province` text NOT NULL,
	`district` text NOT NULL,
	`municipality` text NOT NULL,
	`ward` text,
	`landmark` text,
	`note` text,
	`is_default` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `wishlists` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wishlists_user_id_unique` ON `wishlists` (`user_id`);
--> statement-breakpoint
CREATE TABLE `wishlist_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`wishlist_id` integer NOT NULL REFERENCES `wishlists`(`id`) ON DELETE CASCADE,
	`product_id` integer NOT NULL REFERENCES `products`(`id`),
	`added_price_paisa` integer NOT NULL,
	`added_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wishlist_items_wishlist_product_unique` ON `wishlist_items` (`wishlist_id`, `product_id`);
--> statement-breakpoint
CREATE TABLE `coupons` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`code` text NOT NULL,
	`kind` text NOT NULL,
	`value` integer NOT NULL,
	`min_order_paisa` integer DEFAULT 0 NOT NULL,
	`max_uses` integer,
	`per_user_limit` integer DEFAULT 1 NOT NULL,
	`expires_at` integer,
	`is_active` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `coupons_code_unique` ON `coupons` (`code`);
--> statement-breakpoint
CREATE TABLE `coupon_usages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`coupon_id` integer NOT NULL REFERENCES `coupons`(`id`),
	`user_id` text,
	`order_id` integer NOT NULL REFERENCES `orders`(`id`),
	`used_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `coupon_usages_order_id_unique` ON `coupon_usages` (`order_id`);
--> statement-breakpoint
CREATE TABLE `payments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL REFERENCES `orders`(`id`) ON DELETE CASCADE,
	`provider` text NOT NULL,
	`amount_paisa` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`transaction_id` text,
	`payload_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payments_order_id_unique` ON `payments` (`order_id`);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`link` text,
	`is_read` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `support_tickets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ticket_code` text NOT NULL,
	`user_id` text,
	`name` text NOT NULL,
	`contact` text NOT NULL,
	`subject` text NOT NULL,
	`message` text NOT NULL,
	`order_code` text,
	`status` text DEFAULT 'open' NOT NULL,
	`admin_reply` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `support_tickets_ticket_code_unique` ON `support_tickets` (`ticket_code`);
--> statement-breakpoint
CREATE TABLE `categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`is_active` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `categories_name_unique` ON `categories` (`name`);
--> statement-breakpoint
CREATE UNIQUE INDEX `categories_slug_unique` ON `categories` (`slug`);
--> statement-breakpoint
CREATE TABLE `homepage_banners` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`subtitle` text,
	`link` text,
	`is_active` integer DEFAULT 1 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `homepage_sections` (
	`key` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`is_active` integer DEFAULT 1 NOT NULL,
	`sort_order` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `product_views` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`product_id` integer NOT NULL REFERENCES `products`(`id`),
	`user_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `product_views_product_created_idx` ON `product_views` (`product_id`, `created_at`);
--> statement-breakpoint
CREATE TABLE `search_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`query` text NOT NULL,
	`user_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `search_events_query_idx` ON `search_events` (`query`);
--> statement-breakpoint
CREATE TABLE `recently_viewed` (
	`user_id` text NOT NULL,
	`product_id` integer NOT NULL REFERENCES `products`(`id`),
	`viewed_at` integer NOT NULL,
	PRIMARY KEY (`user_id`, `product_id`)
);
--> statement-breakpoint
ALTER TABLE `products` ADD `brand` text;
--> statement-breakpoint
ALTER TABLE `products` ADD `original_price_paisa` integer;
--> statement-breakpoint
ALTER TABLE `products` ADD `image_url` text;
--> statement-breakpoint
ALTER TABLE `products` ADD `low_stock_threshold` integer DEFAULT 5 NOT NULL;
--> statement-breakpoint
ALTER TABLE `orders` ADD `payment_status` text DEFAULT 'pending' NOT NULL;
--> statement-breakpoint
ALTER TABLE `orders` ADD `discount_paisa` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `orders` ADD `coupon_code` text;
--> statement-breakpoint
ALTER TABLE `orders` ADD `delivery_method` text DEFAULT 'standard' NOT NULL;
--> statement-breakpoint
ALTER TABLE `orders` ADD `address_id` integer;
--> statement-breakpoint
INSERT INTO `categories` (`name`, `slug`) SELECT DISTINCT `category`, lower(replace(`category`, ' ', '-')) FROM `products`;
--> statement-breakpoint
INSERT INTO `homepage_sections` (`key`, `title`, `is_active`, `sort_order`) VALUES
('trending', 'Trending now', 1, 0),
('new_arrivals', 'New arrivals', 1, 1),
('best_sellers', 'Best sellers', 1, 2),
('flash_deals', 'Flash deals', 1, 3),
('recommended', 'Recommended for you', 1, 4);
--> statement-breakpoint
INSERT INTO `homepage_banners` (`title`, `subtitle`, `link`, `is_active`, `sort_order`) VALUES
('Festival Sale — up to 30% off', 'Big discounts across electronics, fashion and handicrafts.', '#/search', 1, 0),
('New sellers join free this month', 'Open your store on Nepal Shop in minutes.', '#/seller/login', 1, 1);
--> statement-breakpoint
INSERT INTO `coupons` (`code`, `kind`, `value`, `min_order_paisa`, `max_uses`, `per_user_limit`, `expires_at`, `is_active`, `created_at`) VALUES
('WELCOME10', 'percent', 10, 100000, 500, 1, (strftime('%s','now') + 90*86400) * 1000, 1, strftime('%s','now') * 1000),
('FREESHIP', 'free_shipping', 0, 150000, 200, 1, (strftime('%s','now') + 60*86400) * 1000, 1, strftime('%s','now') * 1000);
--> statement-breakpoint
UPDATE `products` SET `brand` = 'Himalaya Weaves' WHERE `name` IN ('Pashmina Shawl', 'Kurtha Set', 'Leather Wallet', 'Running Sneakers');
--> statement-breakpoint
UPDATE `products` SET `brand` = 'TechSewa' WHERE `name` IN ('Wireless Earbuds', 'Bluetooth Speaker', 'Smart Watch', 'Power Bank 20000mAh');
--> statement-breakpoint
UPDATE `products` SET `brand` = 'Nepali Hastakala' WHERE `name` IN ('Thangka Painting', 'Decorative Khukuri', 'Singing Bowl', 'Lokta Paper Notebook');
--> statement-breakpoint
UPDATE `products` SET `original_price_paisa` = CAST(ROUND(`price_paisa` * 1.25) AS INTEGER) WHERE `original_price_paisa` IS NULL;
