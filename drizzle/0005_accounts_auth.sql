CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`phone` text NOT NULL,
	`email` text,
	`password_hash` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_phone_unique` ON `users` (`phone`);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);
--> statement-breakpoint
CREATE TABLE `admins` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`password_hash` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `admins_email_unique` ON `admins` (`email`);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`token` text PRIMARY KEY NOT NULL,
	`user_type` text NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sessions_user_id_idx` ON `sessions` (`user_id`);
--> statement-breakpoint
ALTER TABLE `store_settings` ADD `email` text;
--> statement-breakpoint
ALTER TABLE `store_settings` ADD `password_hash` text;
--> statement-breakpoint
ALTER TABLE `store_settings` ADD `status` text DEFAULT 'active' NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `store_settings_email_unique` ON `store_settings` (`email`);
--> statement-breakpoint
ALTER TABLE `orders` ADD `user_id` text;
--> statement-breakpoint
UPDATE `store_settings` SET `status` = 'active', `email` = 'himalaya.fashion@demo.local', `password_hash` = '$2b$10$fCyTBmvFKwI9N5GTKpjqm.RbSiwMxTCIkltyEQOHXpCOal6vzoDF6' WHERE `seller_code` = 'SELL-BDC364DC';
--> statement-breakpoint
UPDATE `store_settings` SET `status` = 'active', `email` = 'techsewa@demo.local', `password_hash` = '$2b$10$RN6zIhSqIOMCRDkJqMpRnOFco6Pc1Tifttq45lctQUf.DiHnkDf9C' WHERE `seller_code` = 'SELL-06A3B75B';
--> statement-breakpoint
UPDATE `store_settings` SET `status` = 'active', `email` = 'hastakala@demo.local', `password_hash` = '$2b$10$6Ao803SSGWbUl1lkM6ucueOeoOAEcNaDQEb7kd6EPb42sF2CGrxRK' WHERE `seller_code` = 'SELL-05DC3C59';
--> statement-breakpoint
INSERT INTO `admins` (`id`, `name`, `email`, `password_hash`, `created_at`) VALUES ('admin-1', 'Site Admin', 'admin@nepalshop.local', '$2b$10$vTwqS8JIRZOFf5MjDns9IO1XH/Z5guA3PhQRniTxhxnMKQTUNmYiK', 1790006400000);
