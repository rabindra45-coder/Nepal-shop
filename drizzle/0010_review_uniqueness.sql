CREATE UNIQUE INDEX IF NOT EXISTS `reviews_order_product_unique` ON `reviews` (`order_id`, `product_id`);
