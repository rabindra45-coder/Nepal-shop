ALTER TABLE `commission_rules` ADD COLUMN `label` text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE `commission_rules` ADD COLUMN `starts_at` integer;
--> statement-breakpoint
ALTER TABLE `commission_rules` ADD COLUMN `ends_at` integer;
