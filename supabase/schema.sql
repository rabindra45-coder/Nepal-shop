-- ============================================================================
-- Nepal Shop marketplace — consolidated Postgres baseline for Supabase.
-- Run this once in the Supabase SQL editor (in order, top to bottom).
--
-- Generated from server/src/schema.ts (the drizzle pg schema). Table names,
-- column names, index/constraint names, nullability, defaults and
-- foreign-key actions are identical to the SQLite schema so the data
-- migration is a straight row-for-row copy.
--
-- RLS: intentionally NOT enabled on any app table. The server talks to
-- Postgres with the service_role key, which bypasses RLS entirely, so
-- table-level policies would be dead weight and a false sense of security.
-- Access control lives in the server's action layer, not in the database.
-- Storage buckets (product/banner/avatar uploads) get their own public-read
-- policies in storage.sql, which is maintained separately.
--
-- Notes for the data migration (SQLite -> Postgres value conversions):
--   * timestamp_ms INTEGER columns are now TIMESTAMPTZ: convert with
--     to_timestamp(ms / 1000.0).
--   * boolean-mode INTEGER columns are now BOOLEAN: convert 0/1 to
--     false/true.
--   * created_at/updated_at-style columns have NO SQL DEFAULT (drizzle
--     fills them client-side via $defaultFn); the migration must supply
--     values for every NOT NULL timestamp column.
--   * Legacy dead table `entries` (created by drizzle/0001_initial.sql,
--     never referenced by the app or schema.ts) is deliberately NOT
--     created here.
-- Idempotent: safe to re-run; every statement is guarded.
-- ============================================================================

CREATE TABLE IF NOT EXISTS "store_settings" (
  "id" SERIAL PRIMARY KEY NOT NULL,
  "seller_code" TEXT NOT NULL,
  "store_name" TEXT NOT NULL,
  "tagline" TEXT NOT NULL,
  "location" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "admin_key_hash" TEXT NOT NULL DEFAULT '',
  "admin_key_hash_bcrypt" TEXT,
  "email" TEXT,
  "password_hash" TEXT,
  "status" TEXT NOT NULL DEFAULT 'active',
  "logo_url" TEXT,
  "banner_url" TEXT,
  "description" TEXT NOT NULL DEFAULT '',
  "vacation_mode" BOOLEAN NOT NULL DEFAULT false,
  "email_verified" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ NOT NULL,
  "updated_at" TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS "products" (
  "id" SERIAL PRIMARY KEY NOT NULL,
  "store_id" INTEGER NOT NULL,
  "name" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "price_paisa" INTEGER NOT NULL,
  "delivery_fee_paisa" INTEGER NOT NULL DEFAULT 0,
  "stock" INTEGER NOT NULL DEFAULT 0,
  "brand" TEXT,
  "original_price_paisa" INTEGER,
  "image_url" TEXT,
  "sku" TEXT,
  "low_stock_threshold" INTEGER NOT NULL DEFAULT 5,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "approval_status" TEXT NOT NULL DEFAULT 'approved',
  "created_at" TIMESTAMPTZ NOT NULL,
  "updated_at" TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS "product_images" (
  "id" SERIAL PRIMARY KEY NOT NULL,
  "product_id" INTEGER NOT NULL,
  "url" TEXT NOT NULL,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS "orders" (
  "id" SERIAL PRIMARY KEY NOT NULL,
  "store_id" INTEGER NOT NULL,
  "order_code" TEXT NOT NULL,
  "customer_name" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "address" TEXT NOT NULL,
  "note" TEXT NOT NULL DEFAULT '',
  "subtotal_paisa" INTEGER NOT NULL,
  "delivery_fee_paisa" INTEGER NOT NULL,
  "total_paisa" INTEGER NOT NULL,
  "payment_method" TEXT NOT NULL,
  "payment_status" TEXT NOT NULL DEFAULT 'pending',
  "discount_paisa" INTEGER NOT NULL DEFAULT 0,
  "coupon_code" TEXT,
  "delivery_method" TEXT NOT NULL DEFAULT 'standard',
  "address_id" INTEGER,
  "user_id" TEXT,
  "group_id" INTEGER,
  "tracking_number" TEXT,
  "carrier" TEXT,
  "delivered_at" TIMESTAMPTZ,
  "status" TEXT NOT NULL DEFAULT 'confirmation_needed',
  "created_at" TIMESTAMPTZ NOT NULL,
  "updated_at" TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS "order_items" (
  "id" SERIAL PRIMARY KEY NOT NULL,
  "order_id" INTEGER NOT NULL,
  "product_id" INTEGER NOT NULL,
  "product_name" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL,
  "unit_price_paisa" INTEGER NOT NULL,
  "variant_id" INTEGER,
  "variant_label" TEXT
);

CREATE TABLE IF NOT EXISTS "reviews" (
  "id" SERIAL PRIMARY KEY NOT NULL,
  "order_id" INTEGER NOT NULL,
  "product_id" INTEGER NOT NULL,
  "reviewer_name" TEXT NOT NULL,
  "rating" INTEGER NOT NULL,
  "body" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS "review_reports" (
  "id" SERIAL PRIMARY KEY NOT NULL,
  "review_id" INTEGER NOT NULL,
  "reason" TEXT NOT NULL,
  "detail" TEXT NOT NULL DEFAULT '',
  "reporter_name" TEXT NOT NULL DEFAULT '',
  "status" TEXT NOT NULL DEFAULT 'open',
  "created_at" TIMESTAMPTZ NOT NULL,
  "updated_at" TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS "buyer_issues" (
  "id" SERIAL PRIMARY KEY NOT NULL,
  "order_id" INTEGER NOT NULL,
  "kind" TEXT NOT NULL,
  "detail" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'open',
  "created_at" TIMESTAMPTZ NOT NULL,
  "updated_at" TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS "users" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "name" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "email" TEXT,
  "password_hash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "email_verified" BOOLEAN NOT NULL DEFAULT false,
  "avatar_url" TEXT,
  "notify_order_emails" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ NOT NULL,
  "updated_at" TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS "admins" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "password_hash" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS "sessions" (
  "token" TEXT PRIMARY KEY NOT NULL,
  "user_type" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "expires_at" TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS "smtp_settings" (
  "id" INTEGER PRIMARY KEY NOT NULL,
  "host" TEXT,
  "port" INTEGER,
  "username" TEXT,
  "password" TEXT,
  "from_address" TEXT,
  "updated_at" TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS "carts" (
  "id" SERIAL PRIMARY KEY NOT NULL,
  "user_id" TEXT NOT NULL,
  "updated_at" TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS "cart_items" (
  "id" SERIAL PRIMARY KEY NOT NULL,
  "cart_id" INTEGER NOT NULL,
  "product_id" INTEGER NOT NULL,
  "quantity" INTEGER NOT NULL,
  "variant_id" INTEGER NOT NULL DEFAULT 0,
  "variant_label" TEXT
);

CREATE TABLE IF NOT EXISTS "addresses" (
  "id" SERIAL PRIMARY KEY NOT NULL,
  "user_id" TEXT NOT NULL,
  "label" TEXT NOT NULL DEFAULT 'Home',
  "full_name" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "province" TEXT NOT NULL,
  "district" TEXT NOT NULL,
  "municipality" TEXT NOT NULL,
  "ward" TEXT,
  "landmark" TEXT,
  "note" TEXT,
  "is_default" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS "wishlists" (
  "id" SERIAL PRIMARY KEY NOT NULL,
  "user_id" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS "wishlist_items" (
  "id" SERIAL PRIMARY KEY NOT NULL,
  "wishlist_id" INTEGER NOT NULL,
  "product_id" INTEGER NOT NULL,
  "added_price_paisa" INTEGER NOT NULL,
  "added_at" TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS "coupons" (
  "id" SERIAL PRIMARY KEY NOT NULL,
  "code" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "value" INTEGER NOT NULL,
  "min_order_paisa" INTEGER NOT NULL DEFAULT 0,
  "max_discount_paisa" INTEGER,
  "max_uses" INTEGER,
  "per_user_limit" INTEGER NOT NULL DEFAULT 1,
  "expires_at" TIMESTAMPTZ,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS "coupon_usages" (
  "id" SERIAL PRIMARY KEY NOT NULL,
  "coupon_id" INTEGER NOT NULL,
  "user_id" TEXT,
  "guest_phone" TEXT,
  "order_id" INTEGER NOT NULL,
  "group_id" INTEGER,
  "used_at" TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS "payments" (
  "id" SERIAL PRIMARY KEY NOT NULL,
  "order_id" INTEGER NOT NULL,
  "group_id" INTEGER,
  "provider" TEXT NOT NULL,
  "amount_paisa" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "transaction_id" TEXT,
  "payload_json" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL,
  "updated_at" TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS "checkout_idempotency" (
  "key" TEXT PRIMARY KEY NOT NULL,
  "group_id" INTEGER NOT NULL,
  "user_id" TEXT,
  "guest_phone" TEXT,
  "payload" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS "notifications" (
  "id" SERIAL PRIMARY KEY NOT NULL,
  "user_id" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "link" TEXT,
  "is_read" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS "support_tickets" (
  "id" SERIAL PRIMARY KEY NOT NULL,
  "ticket_code" TEXT NOT NULL,
  "user_id" TEXT,
  "name" TEXT NOT NULL,
  "contact" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "order_code" TEXT,
  "status" TEXT NOT NULL DEFAULT 'open',
  "admin_reply" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL,
  "updated_at" TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS "categories" (
  "id" SERIAL PRIMARY KEY NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "seo_title" TEXT,
  "seo_description" TEXT,
  "intro_content" TEXT
);

CREATE TABLE IF NOT EXISTS "invoices" (
  "id" SERIAL PRIMARY KEY NOT NULL,
  "invoice_no" TEXT NOT NULL,
  "order_id" INTEGER,
  "group_id" INTEGER,
  "issued_at" TIMESTAMPTZ NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS "invoice_counters" (
  "key" TEXT PRIMARY KEY NOT NULL,
  "last" INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS "product_questions" (
  "id" SERIAL PRIMARY KEY NOT NULL,
  "product_id" INTEGER NOT NULL,
  "user_id" TEXT NOT NULL,
  "asker_name" TEXT NOT NULL DEFAULT '',
  "question" TEXT NOT NULL,
  "answer" TEXT,
  "answered_at" TIMESTAMPTZ,
  "is_visible" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS "homepage_banners" (
  "id" SERIAL PRIMARY KEY NOT NULL,
  "title" TEXT NOT NULL,
  "subtitle" TEXT,
  "link" TEXT,
  "image_url" TEXT,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "sort_order" INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS "homepage_sections" (
  "key" TEXT PRIMARY KEY NOT NULL,
  "title" TEXT NOT NULL,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "sort_order" INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS "product_views" (
  "id" SERIAL PRIMARY KEY NOT NULL,
  "product_id" INTEGER NOT NULL,
  "user_id" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS "search_events" (
  "id" SERIAL PRIMARY KEY NOT NULL,
  "query" TEXT NOT NULL,
  "user_id" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS "funnel_events" (
  "id" SERIAL PRIMARY KEY NOT NULL,
  "event" TEXT NOT NULL,
  "product_id" INTEGER,
  "user_id" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS "recently_viewed" (
  "user_id" TEXT NOT NULL,
  "product_id" INTEGER NOT NULL,
  "viewed_at" TIMESTAMPTZ NOT NULL,
  PRIMARY KEY ("user_id", "product_id")
);

CREATE TABLE IF NOT EXISTS "password_reset_tokens" (
  "id" SERIAL PRIMARY KEY NOT NULL,
  "token_hash" TEXT NOT NULL,
  "user_type" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "expires_at" TIMESTAMPTZ NOT NULL,
  "used_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS "seller_email_verifications" (
  "id" SERIAL PRIMARY KEY NOT NULL,
  "token_hash" TEXT NOT NULL,
  "store_id" INTEGER NOT NULL,
  "expires_at" TIMESTAMPTZ NOT NULL,
  "used_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS "buyer_email_verifications" (
  "id" SERIAL PRIMARY KEY NOT NULL,
  "token_hash" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "expires_at" TIMESTAMPTZ NOT NULL,
  "used_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS "order_groups" (
  "id" SERIAL PRIMARY KEY NOT NULL,
  "group_code" TEXT NOT NULL,
  "user_id" TEXT,
  "customer_name" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "address" TEXT NOT NULL,
  "payment_method" TEXT NOT NULL,
  "subtotal_paisa" INTEGER NOT NULL DEFAULT 0,
  "delivery_fee_paisa" INTEGER NOT NULL DEFAULT 0,
  "discount_paisa" INTEGER NOT NULL DEFAULT 0,
  "total_paisa" INTEGER NOT NULL DEFAULT 0,
  "coupon_code" TEXT,
  "delivery_method" TEXT NOT NULL DEFAULT 'standard',
  "note" TEXT NOT NULL DEFAULT '',
  "created_at" TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS "product_variants" (
  "id" SERIAL PRIMARY KEY NOT NULL,
  "product_id" INTEGER NOT NULL,
  "label" TEXT NOT NULL,
  "sku" TEXT,
  "price_paisa" INTEGER,
  "stock" INTEGER NOT NULL DEFAULT 0,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS "product_specifications" (
  "id" SERIAL PRIMARY KEY NOT NULL,
  "product_id" INTEGER NOT NULL,
  "label" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS "commission_rules" (
  "id" SERIAL PRIMARY KEY NOT NULL,
  "scope" TEXT NOT NULL,
  "scope_id" TEXT NOT NULL DEFAULT '',
  "percent" INTEGER NOT NULL,
  "label" TEXT NOT NULL DEFAULT '',
  "starts_at" TIMESTAMPTZ,
  "ends_at" TIMESTAMPTZ,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS "seller_ledger" (
  "id" SERIAL PRIMARY KEY NOT NULL,
  "store_id" INTEGER NOT NULL,
  "order_id" INTEGER,
  "type" TEXT NOT NULL,
  "amount_paisa" INTEGER NOT NULL,
  "balance_after_paisa" INTEGER NOT NULL,
  "rule_id" INTEGER,
  "payout_id" INTEGER,
  "ledger_key" TEXT,
  "note" TEXT NOT NULL DEFAULT '',
  "created_at" TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS "seller_payout_details" (
  "store_id" INTEGER PRIMARY KEY NOT NULL,
  "bank_name" TEXT,
  "account_name" TEXT,
  "account_number" TEXT,
  "esewa_id" TEXT,
  "khalti_id" TEXT,
  "updated_at" TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS "seller_payouts" (
  "id" SERIAL PRIMARY KEY NOT NULL,
  "store_id" INTEGER NOT NULL,
  "amount_paisa" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'requested',
  "method" TEXT NOT NULL,
  "destination" TEXT NOT NULL DEFAULT '',
  "reference" TEXT,
  "note" TEXT NOT NULL DEFAULT '',
  "created_at" TIMESTAMPTZ NOT NULL,
  "updated_at" TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS "stock_movements" (
  "id" SERIAL PRIMARY KEY NOT NULL,
  "product_id" INTEGER NOT NULL,
  "variant_id" INTEGER NOT NULL DEFAULT 0,
  "change" INTEGER NOT NULL,
  "stock_after" INTEGER NOT NULL,
  "reason" TEXT NOT NULL,
  "order_id" INTEGER,
  "actor_type" TEXT NOT NULL DEFAULT '',
  "actor_id" TEXT NOT NULL DEFAULT '',
  "created_at" TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS "audit_logs" (
  "id" SERIAL PRIMARY KEY NOT NULL,
  "actor_type" TEXT NOT NULL,
  "actor_id" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "entity_type" TEXT NOT NULL DEFAULT '',
  "entity_id" TEXT NOT NULL DEFAULT '',
  "detail" TEXT NOT NULL DEFAULT '',
  "created_at" TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS "platform_settings" (
  "key" TEXT PRIMARY KEY NOT NULL,
  "value" TEXT NOT NULL,
  "updated_at" TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS "return_requests" (
  "id" SERIAL PRIMARY KEY NOT NULL,
  "order_id" INTEGER NOT NULL,
  "reason" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'requested',
  "requested_by" TEXT NOT NULL DEFAULT '',
  "decided_by" TEXT,
  "decided_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS "refunds" (
  "id" SERIAL PRIMARY KEY NOT NULL,
  "order_id" INTEGER NOT NULL,
  "group_id" INTEGER,
  "amount_paisa" INTEGER NOT NULL,
  "provider" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "method" TEXT NOT NULL DEFAULT 'manual',
  "note" TEXT NOT NULL DEFAULT '',
  "requested_by" TEXT NOT NULL DEFAULT '',
  "resolved_by" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL,
  "updated_at" TIMESTAMPTZ NOT NULL
);

-- Foreign keys (added after all tables exist, so creation order is irrelevant).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_store_id_store_settings_id_fk') THEN
    ALTER TABLE "products" ADD CONSTRAINT "products_store_id_store_settings_id_fk"
      FOREIGN KEY ("store_id") REFERENCES "store_settings" ("id");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_images_product_id_products_id_fk') THEN
    ALTER TABLE "product_images" ADD CONSTRAINT "product_images_product_id_products_id_fk"
      FOREIGN KEY ("product_id") REFERENCES "products" ("id") ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_store_id_store_settings_id_fk') THEN
    ALTER TABLE "orders" ADD CONSTRAINT "orders_store_id_store_settings_id_fk"
      FOREIGN KEY ("store_id") REFERENCES "store_settings" ("id");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_group_id_order_groups_id_fk') THEN
    ALTER TABLE "orders" ADD CONSTRAINT "orders_group_id_order_groups_id_fk"
      FOREIGN KEY ("group_id") REFERENCES "order_groups" ("id");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_items_order_id_orders_id_fk') THEN
    ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk"
      FOREIGN KEY ("order_id") REFERENCES "orders" ("id") ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_items_product_id_products_id_fk') THEN
    ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_id_products_id_fk"
      FOREIGN KEY ("product_id") REFERENCES "products" ("id");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reviews_order_id_orders_id_fk') THEN
    ALTER TABLE "reviews" ADD CONSTRAINT "reviews_order_id_orders_id_fk"
      FOREIGN KEY ("order_id") REFERENCES "orders" ("id");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reviews_product_id_products_id_fk') THEN
    ALTER TABLE "reviews" ADD CONSTRAINT "reviews_product_id_products_id_fk"
      FOREIGN KEY ("product_id") REFERENCES "products" ("id");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'review_reports_review_id_reviews_id_fk') THEN
    ALTER TABLE "review_reports" ADD CONSTRAINT "review_reports_review_id_reviews_id_fk"
      FOREIGN KEY ("review_id") REFERENCES "reviews" ("id") ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'buyer_issues_order_id_orders_id_fk') THEN
    ALTER TABLE "buyer_issues" ADD CONSTRAINT "buyer_issues_order_id_orders_id_fk"
      FOREIGN KEY ("order_id") REFERENCES "orders" ("id");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cart_items_cart_id_carts_id_fk') THEN
    ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_cart_id_carts_id_fk"
      FOREIGN KEY ("cart_id") REFERENCES "carts" ("id") ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cart_items_product_id_products_id_fk') THEN
    ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_product_id_products_id_fk"
      FOREIGN KEY ("product_id") REFERENCES "products" ("id");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wishlist_items_wishlist_id_wishlists_id_fk') THEN
    ALTER TABLE "wishlist_items" ADD CONSTRAINT "wishlist_items_wishlist_id_wishlists_id_fk"
      FOREIGN KEY ("wishlist_id") REFERENCES "wishlists" ("id") ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wishlist_items_product_id_products_id_fk') THEN
    ALTER TABLE "wishlist_items" ADD CONSTRAINT "wishlist_items_product_id_products_id_fk"
      FOREIGN KEY ("product_id") REFERENCES "products" ("id");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'coupon_usages_coupon_id_coupons_id_fk') THEN
    ALTER TABLE "coupon_usages" ADD CONSTRAINT "coupon_usages_coupon_id_coupons_id_fk"
      FOREIGN KEY ("coupon_id") REFERENCES "coupons" ("id");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'coupon_usages_order_id_orders_id_fk') THEN
    ALTER TABLE "coupon_usages" ADD CONSTRAINT "coupon_usages_order_id_orders_id_fk"
      FOREIGN KEY ("order_id") REFERENCES "orders" ("id");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'coupon_usages_group_id_order_groups_id_fk') THEN
    ALTER TABLE "coupon_usages" ADD CONSTRAINT "coupon_usages_group_id_order_groups_id_fk"
      FOREIGN KEY ("group_id") REFERENCES "order_groups" ("id");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_order_id_orders_id_fk') THEN
    ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_orders_id_fk"
      FOREIGN KEY ("order_id") REFERENCES "orders" ("id") ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_group_id_order_groups_id_fk') THEN
    ALTER TABLE "payments" ADD CONSTRAINT "payments_group_id_order_groups_id_fk"
      FOREIGN KEY ("group_id") REFERENCES "order_groups" ("id");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'checkout_idempotency_group_id_order_groups_id_fk') THEN
    ALTER TABLE "checkout_idempotency" ADD CONSTRAINT "checkout_idempotency_group_id_order_groups_id_fk"
      FOREIGN KEY ("group_id") REFERENCES "order_groups" ("id");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_order_id_orders_id_fk') THEN
    ALTER TABLE "invoices" ADD CONSTRAINT "invoices_order_id_orders_id_fk"
      FOREIGN KEY ("order_id") REFERENCES "orders" ("id");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_group_id_order_groups_id_fk') THEN
    ALTER TABLE "invoices" ADD CONSTRAINT "invoices_group_id_order_groups_id_fk"
      FOREIGN KEY ("group_id") REFERENCES "order_groups" ("id");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_questions_product_id_products_id_fk') THEN
    ALTER TABLE "product_questions" ADD CONSTRAINT "product_questions_product_id_products_id_fk"
      FOREIGN KEY ("product_id") REFERENCES "products" ("id") ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_views_product_id_products_id_fk') THEN
    ALTER TABLE "product_views" ADD CONSTRAINT "product_views_product_id_products_id_fk"
      FOREIGN KEY ("product_id") REFERENCES "products" ("id");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'funnel_events_product_id_products_id_fk') THEN
    ALTER TABLE "funnel_events" ADD CONSTRAINT "funnel_events_product_id_products_id_fk"
      FOREIGN KEY ("product_id") REFERENCES "products" ("id");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'recently_viewed_product_id_products_id_fk') THEN
    ALTER TABLE "recently_viewed" ADD CONSTRAINT "recently_viewed_product_id_products_id_fk"
      FOREIGN KEY ("product_id") REFERENCES "products" ("id");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'seller_email_verifications_store_id_store_settings_id_fk') THEN
    ALTER TABLE "seller_email_verifications" ADD CONSTRAINT "seller_email_verifications_store_id_store_settings_id_fk"
      FOREIGN KEY ("store_id") REFERENCES "store_settings" ("id") ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'buyer_email_verifications_user_id_users_id_fk') THEN
    ALTER TABLE "buyer_email_verifications" ADD CONSTRAINT "buyer_email_verifications_user_id_users_id_fk"
      FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_variants_product_id_products_id_fk') THEN
    ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_id_products_id_fk"
      FOREIGN KEY ("product_id") REFERENCES "products" ("id") ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_specifications_product_id_products_id_fk') THEN
    ALTER TABLE "product_specifications" ADD CONSTRAINT "product_specifications_product_id_products_id_fk"
      FOREIGN KEY ("product_id") REFERENCES "products" ("id") ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'seller_ledger_store_id_store_settings_id_fk') THEN
    ALTER TABLE "seller_ledger" ADD CONSTRAINT "seller_ledger_store_id_store_settings_id_fk"
      FOREIGN KEY ("store_id") REFERENCES "store_settings" ("id");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'seller_ledger_order_id_orders_id_fk') THEN
    ALTER TABLE "seller_ledger" ADD CONSTRAINT "seller_ledger_order_id_orders_id_fk"
      FOREIGN KEY ("order_id") REFERENCES "orders" ("id");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'seller_ledger_payout_id_seller_payouts_id_fk') THEN
    ALTER TABLE "seller_ledger" ADD CONSTRAINT "seller_ledger_payout_id_seller_payouts_id_fk"
      FOREIGN KEY ("payout_id") REFERENCES "seller_payouts" ("id");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'seller_payout_details_store_id_store_settings_id_fk') THEN
    ALTER TABLE "seller_payout_details" ADD CONSTRAINT "seller_payout_details_store_id_store_settings_id_fk"
      FOREIGN KEY ("store_id") REFERENCES "store_settings" ("id");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'seller_payouts_store_id_store_settings_id_fk') THEN
    ALTER TABLE "seller_payouts" ADD CONSTRAINT "seller_payouts_store_id_store_settings_id_fk"
      FOREIGN KEY ("store_id") REFERENCES "store_settings" ("id");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_movements_product_id_products_id_fk') THEN
    ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_product_id_products_id_fk"
      FOREIGN KEY ("product_id") REFERENCES "products" ("id") ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_movements_order_id_orders_id_fk') THEN
    ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_order_id_orders_id_fk"
      FOREIGN KEY ("order_id") REFERENCES "orders" ("id") ON DELETE SET NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'return_requests_order_id_orders_id_fk') THEN
    ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_order_id_orders_id_fk"
      FOREIGN KEY ("order_id") REFERENCES "orders" ("id");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'refunds_order_id_orders_id_fk') THEN
    ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_id_orders_id_fk"
      FOREIGN KEY ("order_id") REFERENCES "orders" ("id");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'refunds_group_id_order_groups_id_fk') THEN
    ALTER TABLE "refunds" ADD CONSTRAINT "refunds_group_id_order_groups_id_fk"
      FOREIGN KEY ("group_id") REFERENCES "order_groups" ("id");
  END IF;
END $$;

-- Column-level UNIQUE constraints (drizzle `.unique()`).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'seller_email_verifications_token_hash_unique') THEN
    ALTER TABLE "seller_email_verifications" ADD CONSTRAINT "seller_email_verifications_token_hash_unique" UNIQUE ("token_hash");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'buyer_email_verifications_token_hash_unique') THEN
    ALTER TABLE "buyer_email_verifications" ADD CONSTRAINT "buyer_email_verifications_token_hash_unique" UNIQUE ("token_hash");
  END IF;
END $$;

-- Unique indexes.
CREATE UNIQUE INDEX IF NOT EXISTS "store_settings_seller_code_unique" ON "store_settings" ("seller_code");

CREATE UNIQUE INDEX IF NOT EXISTS "store_settings_email_unique" ON "store_settings" ("email");

CREATE UNIQUE INDEX IF NOT EXISTS "products_store_id_sku_unique" ON "products" ("store_id", "sku");

CREATE UNIQUE INDEX IF NOT EXISTS "orders_order_code_unique" ON "orders" ("order_code");

CREATE UNIQUE INDEX IF NOT EXISTS "reviews_order_product_unique" ON "reviews" ("order_id", "product_id");

CREATE UNIQUE INDEX IF NOT EXISTS "users_phone_unique" ON "users" ("phone");

CREATE UNIQUE INDEX IF NOT EXISTS "users_email_unique" ON "users" ("email");

CREATE UNIQUE INDEX IF NOT EXISTS "admins_email_unique" ON "admins" ("email");

CREATE UNIQUE INDEX IF NOT EXISTS "carts_user_id_unique" ON "carts" ("user_id");

CREATE UNIQUE INDEX IF NOT EXISTS "cart_items_cart_product_variant_unique" ON "cart_items" ("cart_id", "product_id", "variant_id");

CREATE UNIQUE INDEX IF NOT EXISTS "cart_items_cart_product_unique" ON "cart_items" ("cart_id", "product_id");

CREATE UNIQUE INDEX IF NOT EXISTS "wishlists_user_id_unique" ON "wishlists" ("user_id");

CREATE UNIQUE INDEX IF NOT EXISTS "wishlist_items_wishlist_product_unique" ON "wishlist_items" ("wishlist_id", "product_id");

CREATE UNIQUE INDEX IF NOT EXISTS "coupons_code_unique" ON "coupons" ("code");

CREATE UNIQUE INDEX IF NOT EXISTS "coupon_usages_order_id_unique" ON "coupon_usages" ("order_id");

CREATE UNIQUE INDEX IF NOT EXISTS "payments_order_id_unique" ON "payments" ("order_id");

CREATE UNIQUE INDEX IF NOT EXISTS "support_tickets_ticket_code_unique" ON "support_tickets" ("ticket_code");

CREATE UNIQUE INDEX IF NOT EXISTS "categories_name_unique" ON "categories" ("name");

CREATE UNIQUE INDEX IF NOT EXISTS "categories_slug_unique" ON "categories" ("slug");

CREATE UNIQUE INDEX IF NOT EXISTS "invoices_invoice_no_unique" ON "invoices" ("invoice_no");

CREATE UNIQUE INDEX IF NOT EXISTS "password_reset_tokens_token_hash_unique" ON "password_reset_tokens" ("token_hash");

CREATE UNIQUE INDEX IF NOT EXISTS "order_groups_group_code_unique" ON "order_groups" ("group_code");

CREATE UNIQUE INDEX IF NOT EXISTS "seller_ledger_key_unique" ON "seller_ledger" ("ledger_key");

CREATE UNIQUE INDEX IF NOT EXISTS "return_requests_order_id_unique" ON "return_requests" ("order_id");

CREATE UNIQUE INDEX IF NOT EXISTS "refunds_order_id_unique" ON "refunds" ("order_id");

-- Plain indexes.
CREATE INDEX IF NOT EXISTS "idx_products_active_created" ON "products" ("is_active", "created_at");

CREATE INDEX IF NOT EXISTS "idx_products_store_id" ON "products" ("store_id");

CREATE INDEX IF NOT EXISTS "product_images_product_id_idx" ON "product_images" ("product_id");

CREATE INDEX IF NOT EXISTS "orders_user_id_idx" ON "orders" ("user_id");

CREATE INDEX IF NOT EXISTS "orders_group_id_idx" ON "orders" ("group_id");

CREATE INDEX IF NOT EXISTS "orders_created_at_idx" ON "orders" ("created_at");

CREATE INDEX IF NOT EXISTS "idx_orders_phone_created" ON "orders" ("phone", "created_at");

CREATE INDEX IF NOT EXISTS "idx_orders_store_id" ON "orders" ("store_id");

CREATE INDEX IF NOT EXISTS "order_items_order_id_idx" ON "order_items" ("order_id");

CREATE INDEX IF NOT EXISTS "idx_reviews_product_created" ON "reviews" ("product_id", "created_at");

CREATE INDEX IF NOT EXISTS "review_reports_review_id_idx" ON "review_reports" ("review_id");

CREATE INDEX IF NOT EXISTS "buyer_issues_order_id_idx" ON "buyer_issues" ("order_id");

CREATE INDEX IF NOT EXISTS "sessions_expires_at_idx" ON "sessions" ("expires_at");

CREATE INDEX IF NOT EXISTS "sessions_user_id_idx" ON "sessions" ("user_id");

CREATE INDEX IF NOT EXISTS "addresses_user_id_idx" ON "addresses" ("user_id");

CREATE INDEX IF NOT EXISTS "payments_group_id_idx" ON "payments" ("group_id");

CREATE INDEX IF NOT EXISTS "notifications_user_id_idx" ON "notifications" ("user_id");

CREATE INDEX IF NOT EXISTS "invoices_order_id_idx" ON "invoices" ("order_id");

CREATE INDEX IF NOT EXISTS "invoices_group_id_idx" ON "invoices" ("group_id");

CREATE INDEX IF NOT EXISTS "product_questions_product_id_idx" ON "product_questions" ("product_id");

CREATE INDEX IF NOT EXISTS "homepage_banners_active_sort_idx" ON "homepage_banners" ("is_active", "sort_order");

CREATE INDEX IF NOT EXISTS "product_views_created_at_idx" ON "product_views" ("created_at");

CREATE INDEX IF NOT EXISTS "product_views_product_created_idx" ON "product_views" ("product_id", "created_at");

CREATE INDEX IF NOT EXISTS "search_events_created_at_idx" ON "search_events" ("created_at");

CREATE INDEX IF NOT EXISTS "search_events_query_idx" ON "search_events" ("query");

CREATE INDEX IF NOT EXISTS "funnel_events_event_created_idx" ON "funnel_events" ("event", "created_at");

CREATE INDEX IF NOT EXISTS "product_variants_product_id_idx" ON "product_variants" ("product_id");

CREATE INDEX IF NOT EXISTS "product_specifications_product_id_idx" ON "product_specifications" ("product_id");

CREATE INDEX IF NOT EXISTS "seller_ledger_store_id_idx" ON "seller_ledger" ("store_id");

CREATE INDEX IF NOT EXISTS "seller_payouts_store_id_idx" ON "seller_payouts" ("store_id");

CREATE INDEX IF NOT EXISTS "stock_movements_product_id_idx" ON "stock_movements" ("product_id");

CREATE INDEX IF NOT EXISTS "audit_logs_created_at_idx" ON "audit_logs" ("created_at");

CREATE TABLE IF NOT EXISTS "category_requests" (
  "id" SERIAL PRIMARY KEY NOT NULL,
  "store_id" INTEGER NOT NULL REFERENCES "store_settings"("id") ON DELETE CASCADE,
  "name" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "decided_at" TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS "category_requests_pending_unique" ON "category_requests" ("store_id", lower("name")) WHERE "status" = 'pending';

CREATE INDEX IF NOT EXISTS "category_requests_status_idx" ON "category_requests" ("status");
