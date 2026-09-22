CREATE UNIQUE INDEX IF NOT EXISTS `products_store_id_sku_unique` ON `products` (`store_id`, `sku`);
