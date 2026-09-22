CREATE TABLE `funnel_events` (`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL, `event` text NOT NULL, `product_id` integer, `user_id` text, `created_at` integer NOT NULL);
