CREATE TABLE `stock_movements` (`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL, `product_id` integer NOT NULL REFERENCES `products`(`id`) ON DELETE CASCADE, `variant_id` integer NOT NULL DEFAULT 0, `change` integer NOT NULL, `stock_after` integer NOT NULL, `reason` text NOT NULL, `order_id` integer REFERENCES `orders`(`id`) ON DELETE SET NULL, `actor_type` text NOT NULL DEFAULT '', `actor_id` text NOT NULL DEFAULT '', `created_at` integer NOT NULL);
--> statement-breakpoint
CREATE INDEX `stock_movements_product_id_idx` ON `stock_movements` (`product_id`);
