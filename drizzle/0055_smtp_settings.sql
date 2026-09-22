CREATE TABLE IF NOT EXISTS `smtp_settings` (`id` integer PRIMARY KEY NOT NULL, `host` text, `port` integer, `username` text, `password` text, `from_address` text, `updated_at` integer);
