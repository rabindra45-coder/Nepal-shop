ALTER TABLE `seller_ledger` ADD COLUMN `rule_id` integer;
--> statement-breakpoint
ALTER TABLE `seller_ledger` ADD COLUMN `payout_id` integer;
--> statement-breakpoint
ALTER TABLE `seller_ledger` ADD COLUMN `ledger_key` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `seller_ledger_key_unique` ON `seller_ledger` (`ledger_key`);
