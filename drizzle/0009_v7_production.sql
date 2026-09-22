-- v7 production-readiness: password reset, multi-seller order groups, product
-- variants, commission/ledger/payouts, audit logs, tracking fields, hot-path
-- indexes. All additive. Note the repo migrator executes every `-->`
-- statement-breakpoint chunk including empty ones, so there is exactly one
-- marker between statements and none at the start or end.
CREATE TABLE `password_reset_tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`token_hash` text NOT NULL,
	`user_type` text NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `password_reset_tokens_token_hash_unique` ON `password_reset_tokens` (`token_hash`);
--> statement-breakpoint
CREATE TABLE `order_groups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`group_code` text NOT NULL,
	`user_id` text,
	`customer_name` text NOT NULL,
	`phone` text NOT NULL,
	`address` text NOT NULL,
	`payment_method` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `order_groups_group_code_unique` ON `order_groups` (`group_code`);
--> statement-breakpoint
ALTER TABLE `orders` ADD COLUMN `group_id` integer REFERENCES `order_groups`(`id`);
--> statement-breakpoint
ALTER TABLE `orders` ADD COLUMN `tracking_number` text;
--> statement-breakpoint
ALTER TABLE `orders` ADD COLUMN `carrier` text;
--> statement-breakpoint
ALTER TABLE `orders` ADD COLUMN `delivered_at` integer;
--> statement-breakpoint
ALTER TABLE `coupon_usages` ADD COLUMN `group_id` integer REFERENCES `order_groups`(`id`);
--> statement-breakpoint
CREATE TABLE `product_variants` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`product_id` integer NOT NULL REFERENCES `products`(`id`) ON DELETE CASCADE,
	`label` text NOT NULL,
	`sku` text,
	`price_paisa` integer,
	`stock` integer DEFAULT 0 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `product_variants_product_id_idx` ON `product_variants` (`product_id`);
--> statement-breakpoint
CREATE TABLE `commission_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scope` text NOT NULL,
	`scope_id` text NOT NULL DEFAULT '',
	`percent` integer NOT NULL,
	`is_active` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `seller_ledger` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`store_id` integer NOT NULL REFERENCES `store_settings`(`id`),
	`order_id` integer REFERENCES `orders`(`id`),
	`type` text NOT NULL,
	`amount_paisa` integer NOT NULL,
	`balance_after_paisa` integer NOT NULL,
	`note` text NOT NULL DEFAULT '',
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `seller_ledger_store_id_idx` ON `seller_ledger` (`store_id`);
--> statement-breakpoint
CREATE TABLE `seller_payout_details` (
	`store_id` integer PRIMARY KEY REFERENCES `store_settings`(`id`),
	`bank_name` text,
	`account_name` text,
	`account_number` text,
	`esewa_id` text,
	`khalti_id` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `seller_payouts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`store_id` integer NOT NULL REFERENCES `store_settings`(`id`),
	`amount_paisa` integer NOT NULL,
	`status` text NOT NULL DEFAULT 'requested',
	`method` text NOT NULL,
	`destination` text NOT NULL DEFAULT '',
	`reference` text,
	`note` text NOT NULL DEFAULT '',
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `seller_payouts_store_id_idx` ON `seller_payouts` (`store_id`);
--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text NOT NULL,
	`action` text NOT NULL,
	`entity_type` text NOT NULL DEFAULT '',
	`entity_id` text NOT NULL DEFAULT '',
	`detail` text NOT NULL DEFAULT '',
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_logs_created_at_idx` ON `audit_logs` (`created_at`);
--> statement-breakpoint
ALTER TABLE `store_settings` ADD COLUMN `admin_key_hash_bcrypt` text;
--> statement-breakpoint
ALTER TABLE `users` ADD COLUMN `status` text DEFAULT 'active' NOT NULL;
--> statement-breakpoint
ALTER TABLE `users` ADD COLUMN `updated_at` integer;
--> statement-breakpoint
-- cart_items is rebuilt so the uniqueness key becomes (cart, product, variant):
-- two variants of the same product must be allowed as separate lines.
ALTER TABLE `cart_items` RENAME TO `cart_items_legacy`;
--> statement-breakpoint
CREATE TABLE `cart_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`cart_id` integer NOT NULL REFERENCES `carts`(`id`) ON DELETE CASCADE,
	`product_id` integer NOT NULL REFERENCES `products`(`id`),
	`quantity` integer NOT NULL,
	`variant_id` integer DEFAULT 0 NOT NULL,
	`variant_label` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cart_items_cart_product_variant_unique` ON `cart_items` (`cart_id`, `product_id`, `variant_id`);
--> statement-breakpoint
INSERT INTO `cart_items` (`id`, `cart_id`, `product_id`, `quantity`, `variant_id`) SELECT `id`, `cart_id`, `product_id`, `quantity`, 0 FROM `cart_items_legacy`;
--> statement-breakpoint
DROP TABLE `cart_items_legacy`;
--> statement-breakpoint
ALTER TABLE `order_items` ADD COLUMN `variant_id` integer;
--> statement-breakpoint
ALTER TABLE `order_items` ADD COLUMN `variant_label` text;
--> statement-breakpoint
CREATE INDEX `orders_user_id_idx` ON `orders` (`user_id`);
--> statement-breakpoint
CREATE INDEX `notifications_user_id_idx` ON `notifications` (`user_id`);
--> statement-breakpoint
CREATE INDEX `addresses_user_id_idx` ON `addresses` (`user_id`);
--> statement-breakpoint
CREATE INDEX `order_items_order_id_idx` ON `order_items` (`order_id`);
--> statement-breakpoint
CREATE INDEX `homepage_banners_active_sort_idx` ON `homepage_banners` (`is_active`, `sort_order`);
--> statement-breakpoint
CREATE INDEX `sessions_expires_at_idx` ON `sessions` (`expires_at`);
--> statement-breakpoint
CREATE INDEX `orders_group_id_idx` ON `orders` (`group_id`)
