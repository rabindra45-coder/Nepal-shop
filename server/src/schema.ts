import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const storeSettings = sqliteTable("store_settings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sellerCode: text("seller_code").notNull(),
  storeName: text("store_name").notNull(),
  tagline: text("tagline").notNull(),
  location: text("location").notNull(),
  phone: text("phone").notNull(),
  adminKeyHash: text("admin_key_hash").notNull().default(""),
  // bcrypt hash of the seller access key for keys minted after v7; older
  // unsalted SHA-256 hashes in admin_key_hash are upgraded on next use.
  adminKeyHashBcrypt: text("admin_key_hash_bcrypt"),
  email: text("email"),
  passwordHash: text("password_hash"),
  // Seller verification lifecycle: pending (just registered) -> under_review
  // (admin is looking) -> active (approved, can sell) ; suspended / rejected
  // block the seller from selling. Extended in the Seller checkpoint from the
  // original pending/active/suspended trio.
  status: text("status", { enum: ["pending", "under_review", "active", "suspended", "rejected"] }).notNull().default("active"),
  // Storefront branding uploaded from the seller studio (Seller checkpoint).
  logoUrl: text("logo_url"),
  bannerUrl: text("banner_url"),
  description: text("description").notNull().default(""),
  // Vacation mode: the store stays visible but stops taking new orders until
  // the seller switches it off.
  vacationMode: integer("vacation_mode", { mode: "boolean" }).notNull().default(false),
  // Set by the token-based email verification flow (registerSeller /
  // verifySellerEmail). Sellers created before verification existed are
  // grandfathered via migration 0017.
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({ sellerCodeIdx: uniqueIndex("store_settings_seller_code_unique").on(table.sellerCode), emailIdx: uniqueIndex("store_settings_email_unique").on(table.email) }));

export const products = sqliteTable("products", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  storeId: integer("store_id").notNull().references(() => storeSettings.id),
  name: text("name").notNull(),
  category: text("category").notNull(),
  description: text("description").notNull(),
  pricePaisa: integer("price_paisa").notNull(),
  deliveryFeePaisa: integer("delivery_fee_paisa").notNull().default(0),
  stock: integer("stock").notNull().default(0),
  brand: text("brand"),
  originalPricePaisa: integer("original_price_paisa"),
  imageUrl: text("image_url"),
  // Seller-defined stock keeping unit. Optional; when present it must be
  // unique within the seller's store (products_store_id_sku_unique).
  sku: text("sku"),
  lowStockThreshold: integer("low_stock_threshold").notNull().default(5),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({ storeSkuIdx: uniqueIndex("products_store_id_sku_unique").on(table.storeId, table.sku) }));

export const productImages = sqliteTable("product_images", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  productId: integer("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({ productIdx: index("product_images_product_id_idx").on(table.productId) }));

export const orders = sqliteTable("orders", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  storeId: integer("store_id").notNull().references(() => storeSettings.id),
  orderCode: text("order_code").notNull(),
  customerName: text("customer_name").notNull(),
  phone: text("phone").notNull(),
  address: text("address").notNull(),
  note: text("note").notNull().default(""),
  subtotalPaisa: integer("subtotal_paisa").notNull(),
  deliveryFeePaisa: integer("delivery_fee_paisa").notNull(),
  totalPaisa: integer("total_paisa").notNull(),
  paymentMethod: text("payment_method", { enum: ["cod", "esewa", "khalti"] }).notNull(),
  paymentStatus: text("payment_status", { enum: ["pending", "processing", "paid", "failed", "refunded", "cancelled"] }).notNull().default("pending"),
  discountPaisa: integer("discount_paisa").notNull().default(0),
  couponCode: text("coupon_code"),
  deliveryMethod: text("delivery_method", { enum: ["standard", "express", "pickup"] }).notNull().default("standard"),
  addressId: integer("address_id"),
  userId: text("user_id"),
  groupId: integer("group_id"),
  trackingNumber: text("tracking_number"),
  carrier: text("carrier"),
  deliveredAt: integer("delivered_at", { mode: "timestamp_ms" }),
  status: text("status", { enum: ["confirmation_needed", "confirmed", "packed", "shipped", "out_for_delivery", "delivery_failed", "delivered", "return_requested", "returned", "refunded", "cancelled"] }).notNull().default("confirmation_needed"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({
  orderCodeIdx: uniqueIndex("orders_order_code_unique").on(table.orderCode),
  userIdx: index("orders_user_id_idx").on(table.userId),
  groupIdx: index("orders_group_id_idx").on(table.groupId),
  createdIdx: index("orders_created_at_idx").on(table.createdAt),
}));

export const orderItems = sqliteTable("order_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  orderId: integer("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
  productId: integer("product_id").notNull().references(() => products.id),
  productName: text("product_name").notNull(),
  quantity: integer("quantity").notNull(),
  unitPricePaisa: integer("unit_price_paisa").notNull(),
  variantId: integer("variant_id"),
  variantLabel: text("variant_label"),
}, (table) => ({ orderIdx: index("order_items_order_id_idx").on(table.orderId) }));

export const reviews = sqliteTable("reviews", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  orderId: integer("order_id").notNull().references(() => orders.id),
  productId: integer("product_id").notNull().references(() => products.id),
  reviewerName: text("reviewer_name").notNull(),
  rating: integer("rating").notNull(),
  body: text("body").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({ orderProductIdx: uniqueIndex("reviews_order_product_unique").on(table.orderId, table.productId) }));

// Buyer-submitted reports against public product reviews. The admin panel
// (Admin checkpoint) triages these: dismiss the report or delete the review.
// No report row means nobody has flagged the review.
export const reviewReports = sqliteTable("review_reports", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  reviewId: integer("review_id").notNull().references(() => reviews.id, { onDelete: "cascade" }),
  reason: text("reason", { enum: ["spam", "abuse", "fake", "other"] }).notNull(),
  detail: text("detail").notNull().default(""),
  reporterName: text("reporter_name").notNull().default(""),
  status: text("status", { enum: ["open", "resolved"] }).notNull().default("open"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
}, (table) => ({ reviewIdx: index("review_reports_review_id_idx").on(table.reviewId) }));

export const buyerIssues = sqliteTable("buyer_issues", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  orderId: integer("order_id").notNull().references(() => orders.id),
  kind: text("kind").notNull(),
  detail: text("detail").notNull(),
  status: text("status", { enum: ["open", "resolved"] }).notNull().default("open"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({ orderIdx: index("buyer_issues_order_id_idx").on(table.orderId) }));

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  phone: text("phone").notNull(),
  email: text("email"),
  passwordHash: text("password_hash").notNull(),
  status: text("status", { enum: ["active", "suspended"] }).notNull().default("active"),
  // Set by the token-based buyer email verification flow (signup /
  // verifyBuyerEmail). Defaults to false; buyers who registered before this
  // existed simply verify from their account page.
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
  // Notification preference (Notifications checkpoint): when false, the
  // buyer gets no order-update emails (confirmation, payment, shipping,
  // returns, refunds). Security emails (password reset, verification)
  // always go through; in-app notifications are unaffected.
  notifyOrderEmails: integer("notify_order_emails", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
}, (table) => ({
  phoneIdx: uniqueIndex("users_phone_unique").on(table.phone),
  emailIdx: uniqueIndex("users_email_unique").on(table.email),
}));

export const admins = sqliteTable("admins", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  passwordHash: text("password_hash").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({ emailIdx: uniqueIndex("admins_email_unique").on(table.email) }));

export const sessions = sqliteTable("sessions", {
  token: text("token").primaryKey(),
  userType: text("user_type", { enum: ["buyer", "seller", "admin"] }).notNull(),
  userId: text("user_id").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => ({ expiresIdx: index("sessions_expires_at_idx").on(table.expiresAt), userIdx: index("sessions_user_id_idx").on(table.userId) }));

// ---------- phase 2: cart, wishlist, coupons, payments, notifications ----------

export const carts = sqliteTable("carts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({ userIdx: uniqueIndex("carts_user_id_unique").on(table.userId) }));

export const cartItems = sqliteTable("cart_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  cartId: integer("cart_id").notNull().references(() => carts.id, { onDelete: "cascade" }),
  productId: integer("product_id").notNull().references(() => products.id),
  quantity: integer("quantity").notNull(),
  variantId: integer("variant_id").notNull().default(0),
  variantLabel: text("variant_label"),
}, (table) => ({ cartProductVariantIdx: uniqueIndex("cart_items_cart_product_variant_unique").on(table.cartId, table.productId, table.variantId) }));

export const addresses = sqliteTable("addresses", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(),
  label: text("label").notNull().default("Home"),
  fullName: text("full_name").notNull(),
  phone: text("phone").notNull(),
  province: text("province").notNull(),
  district: text("district").notNull(),
  municipality: text("municipality").notNull(),
  ward: text("ward"),
  landmark: text("landmark"),
  note: text("note"),
  isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({ userIdx: index("addresses_user_id_idx").on(table.userId) }));

export const wishlists = sqliteTable("wishlists", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({ userIdx: uniqueIndex("wishlists_user_id_unique").on(table.userId) }));

export const wishlistItems = sqliteTable("wishlist_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  wishlistId: integer("wishlist_id").notNull().references(() => wishlists.id, { onDelete: "cascade" }),
  productId: integer("product_id").notNull().references(() => products.id),
  addedPricePaisa: integer("added_price_paisa").notNull(),
  addedAt: integer("added_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({ wishlistProductIdx: uniqueIndex("wishlist_items_wishlist_product_unique").on(table.wishlistId, table.productId) }));

export const coupons = sqliteTable("coupons", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  code: text("code").notNull(),
  kind: text("kind", { enum: ["percent", "fixed", "free_shipping"] }).notNull(),
  value: integer("value").notNull(),
  minOrderPaisa: integer("min_order_paisa").notNull().default(0),
  // Optional ceiling on the discount a percent coupon can grant, in paisa.
  // Null means uncapped (a percent coupon is still bounded by its 1-90%
  // value and by the order subtotal).
  maxDiscountPaisa: integer("max_discount_paisa"),
  maxUses: integer("max_uses"),
  perUserLimit: integer("per_user_limit").notNull().default(1),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({ codeIdx: uniqueIndex("coupons_code_unique").on(table.code) }));

export const couponUsages = sqliteTable("coupon_usages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  couponId: integer("coupon_id").notNull().references(() => coupons.id),
  userId: text("user_id"),
  // Guests have no account, so the per-user limit is enforced against their
  // verified checkout phone number instead (Checkout + Payments checkpoint).
  // NULL for signed-in buyers, whose limit is enforced on user_id.
  guestPhone: text("guest_phone"),
  orderId: integer("order_id").notNull().references(() => orders.id),
  groupId: integer("group_id"),
  usedAt: integer("used_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({ orderIdx: uniqueIndex("coupon_usages_order_id_unique").on(table.orderId) }));

export const payments = sqliteTable("payments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  orderId: integer("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
  // Online payments (eSewa/Khalti) are taken once per checkout at the order
  // GROUP level, so one payment row covers every seller fulfilment in the
  // group; COD keeps one row per fulfilment (cash is collected per parcel).
  groupId: integer("group_id").references(() => orderGroups.id),
  provider: text("provider", { enum: ["cod", "esewa", "khalti"] }).notNull(),
  amountPaisa: integer("amount_paisa").notNull(),
  status: text("status", { enum: ["pending", "processing", "paid", "failed", "refunded", "cancelled"] }).notNull().default("pending"),
  transactionId: text("transaction_id"),
  payloadJson: text("payload_json"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({ orderIdx: uniqueIndex("payments_order_id_unique").on(table.orderId), groupIdx: index("payments_group_id_idx").on(table.groupId) }));

// Idempotency keys for placeOrder. A key is written inside the same
// transaction that creates the order group, so a double-clicked "Place
// order" (two requests racing with the same key) can only ever create one
// group: the loser sees the winner's row and returns the same result.
// Rows older than 7 days are pruned opportunistically on insert.
export const checkoutIdempotency = sqliteTable("checkout_idempotency", {
  key: text("key").primaryKey(),
  groupId: integer("group_id").notNull().references(() => orderGroups.id),
  // Ownership binding: a key replays only for the same buyer identity that
  // created it (signed-in user id, or normalized guest phone), and only for
  // the same request payload. A different caller or different payload sees
  // an error, never the other buyer's order.
  userId: text("user_id"),
  guestPhone: text("guest_phone"),
  payload: text("payload"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

export const notifications = sqliteTable("notifications", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(),
  type: text("type").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  link: text("link"),
  isRead: integer("is_read", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({ userIdx: index("notifications_user_id_idx").on(table.userId) }));

export const supportTickets = sqliteTable("support_tickets", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ticketCode: text("ticket_code").notNull(),
  userId: text("user_id"),
  name: text("name").notNull(),
  contact: text("contact").notNull(),
  subject: text("subject").notNull(),
  message: text("message").notNull(),
  orderCode: text("order_code"),
  status: text("status", { enum: ["open", "answered", "closed"] }).notNull().default("open"),
  adminReply: text("admin_reply"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({ codeIdx: uniqueIndex("support_tickets_ticket_code_unique").on(table.ticketCode) }));

export const categories = sqliteTable("categories", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
}, (table) => ({
  nameIdx: uniqueIndex("categories_name_unique").on(table.name),
  slugIdx: uniqueIndex("categories_slug_unique").on(table.slug),
}));

export const homepageBanners = sqliteTable("homepage_banners", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  subtitle: text("subtitle"),
  link: text("link"),
  imageUrl: text("image_url"),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
}, (table) => ({ activeSortIdx: index("homepage_banners_active_sort_idx").on(table.isActive, table.sortOrder) }));

export const homepageSections = sqliteTable("homepage_sections", {
  key: text("key").primaryKey(),
  title: text("title").notNull(),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const productViews = sqliteTable("product_views", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  productId: integer("product_id").notNull().references(() => products.id),
  userId: text("user_id"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({ createdIdx: index("product_views_created_at_idx").on(table.createdAt) }));

export const searchEvents = sqliteTable("search_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  query: text("query").notNull(),
  userId: text("user_id"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({ createdIdx: index("search_events_created_at_idx").on(table.createdAt) }));

// Funnel events for honestly measurable purchase analytics. add_to_cart is
// recorded server-side inside addToCart (the product id is validated there,
// never trusted from the client); checkout_start is recorded by the
// trackCheckoutStart action when a signed-in buyer opens checkout. Purchases
// are derived from the orders table (the single source of truth) — they are
// not duplicated here. Rows are deduped at write time (see recordFunnelEvent)
// so refreshes and double-taps don't inflate the numbers.
export const funnelEvents = sqliteTable("funnel_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  event: text("event", { enum: ["add_to_cart", "checkout_start"] }).notNull(),
  productId: integer("product_id").references(() => products.id),
  userId: text("user_id"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({
  eventCreatedIdx: index("funnel_events_event_created_idx").on(table.event, table.createdAt),
}));

export const recentlyViewed = sqliteTable("recently_viewed", {
  userId: text("user_id").notNull(),
  productId: integer("product_id").notNull().references(() => products.id),
  viewedAt: integer("viewed_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({ pk: primaryKey({ columns: [table.userId, table.productId] }) }));

// ---------- v7: production-readiness ----------

// Password-reset tokens. Only the SHA-256 hash of the token is stored;
// tokens are single-use and expire after 1 hour.
export const passwordResetTokens = sqliteTable("password_reset_tokens", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tokenHash: text("token_hash").notNull(),
  userType: text("user_type", { enum: ["buyer", "seller", "admin"] }).notNull(),
  userId: text("user_id").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  usedAt: integer("used_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({ tokenHashIdx: uniqueIndex("password_reset_tokens_token_hash_unique").on(table.tokenHash) }));

// Seller email-verification tokens (Seller checkpoint). Same pattern as
// password_reset_tokens: only the SHA-256 hash of the token is stored;
// tokens are single-use and expire after 24 hours.
export const sellerEmailVerifications = sqliteTable("seller_email_verifications", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tokenHash: text("token_hash").notNull().unique(),
  storeId: integer("store_id").notNull().references(() => storeSettings.id, { onDelete: "cascade" }),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  usedAt: integer("used_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

// Buyer email-verification tokens (Notifications checkpoint). Same pattern
// as the seller flow: hash-only storage, single-use, 24-hour expiry.
// Verifying sets users.email_verified.
export const buyerEmailVerifications = sqliteTable("buyer_email_verifications", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tokenHash: text("token_hash").notNull().unique(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  usedAt: integer("used_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

// A checkout that spans several sellers creates one group plus one order per
// seller. The customer experiences a single order (the group code); each
// seller only ever sees their own sub-order.
export const orderGroups = sqliteTable("order_groups", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  groupCode: text("group_code").notNull(),
  userId: text("user_id"),
  customerName: text("customer_name").notNull(),
  phone: text("phone").notNull(),
  address: text("address").notNull(),
  paymentMethod: text("payment_method", { enum: ["cod", "esewa", "khalti"] }).notNull(),
  // Group-level totals: the sums of the per-seller fulfilment orders, with
  // the coupon discount (applied once at group level) allocated across them.
  subtotalPaisa: integer("subtotal_paisa").notNull().default(0),
  deliveryFeePaisa: integer("delivery_fee_paisa").notNull().default(0),
  discountPaisa: integer("discount_paisa").notNull().default(0),
  totalPaisa: integer("total_paisa").notNull().default(0),
  couponCode: text("coupon_code"),
  deliveryMethod: text("delivery_method", { enum: ["standard", "express", "pickup"] }).notNull().default("standard"),
  note: text("note").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({ groupCodeIdx: uniqueIndex("order_groups_group_code_unique").on(table.groupCode) }));

// Product variants (size, colour, ...). A variant may override the price and
// carries its own stock; variant_id 0 / NULL means "the base product".
export const productVariants = sqliteTable("product_variants", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  productId: integer("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  sku: text("sku"),
  pricePaisa: integer("price_paisa"),
  stock: integer("stock").notNull().default(0),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({ productIdx: index("product_variants_product_id_idx").on(table.productId) }));

// Product specifications (Seller checkpoint): a small structured
// label/value table per product (e.g. Material → Cotton, Fit → Regular),
// rendered as a spec sheet on the public product page.
export const productSpecifications = sqliteTable("product_specifications", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  productId: integer("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  value: text("value").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({ productIdx: index("product_specifications_product_id_idx").on(table.productId) }));

// Commission rules. Resolution order: product > seller > category >
// campaign (when its window is open) > platform default. `percent` is a
// whole percent (0-90). `scope_id` holds the product id, store id, category
// name or campaign code depending on scope; campaigns may carry an optional
// active window (starts_at/ends_at) and a human label like "Dashain sale".
export const commissionRules = sqliteTable("commission_rules", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  scope: text("scope", { enum: ["platform", "category", "seller", "product", "campaign"] }).notNull(),
  scopeId: text("scope_id").notNull().default(""),
  percent: integer("percent").notNull(),
  label: text("label").notNull().default(""),
  startsAt: integer("starts_at", { mode: "timestamp_ms" }),
  endsAt: integer("ends_at", { mode: "timestamp_ms" }),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

// Append-only seller money ledger. `amount_paisa` is signed: positive credits
// the seller, negative debits. `balance_after_paisa` is the store's running
// net balance after the row, so every calculation is traceable. `ledger_key`
// is a unique idempotency key (e.g. "sale:12", "commission:12",
// "payout:7"): re-running a transition can never double-post. Rows are
// never updated or deleted — corrections are new rows.
export const sellerLedger = sqliteTable("seller_ledger", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  storeId: integer("store_id").notNull().references(() => storeSettings.id),
  orderId: integer("order_id").references(() => orders.id),
  type: text("type", { enum: ["sale", "commission", "refund", "payout", "adjustment"] }).notNull(),
  amountPaisa: integer("amount_paisa").notNull(),
  balanceAfterPaisa: integer("balance_after_paisa").notNull(),
  ruleId: integer("rule_id"),
  payoutId: integer("payout_id").references(() => sellerPayouts.id),
  ledgerKey: text("ledger_key"),
  note: text("note").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({
  storeIdx: index("seller_ledger_store_id_idx").on(table.storeId),
  keyIdx: uniqueIndex("seller_ledger_key_unique").on(table.ledgerKey),
}));

// Where to send a seller's money. One row per seller; account numbers are
// masked in every API response.
export const sellerPayoutDetails = sqliteTable("seller_payout_details", {
  storeId: integer("store_id").primaryKey().references(() => storeSettings.id),
  bankName: text("bank_name"),
  accountName: text("account_name"),
  accountNumber: text("account_number"),
  esewaId: text("esewa_id"),
  khaltiId: text("khalti_id"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

export const sellerPayouts = sqliteTable("seller_payouts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  storeId: integer("store_id").notNull().references(() => storeSettings.id),
  amountPaisa: integer("amount_paisa").notNull(),
  status: text("status", { enum: ["requested", "processing", "completed", "failed", "cancelled"] }).notNull().default("requested"),
  method: text("method", { enum: ["bank", "esewa", "khalti"] }).notNull(),
  destination: text("destination").notNull().default(""),
  reference: text("reference"),
  note: text("note").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({ storeIdx: index("seller_payouts_store_id_idx").on(table.storeId) }));

// Append-only inventory ledger. Every stock change — order decrements,
// cancellation/return restores, seller manual adjustments, initial stock on
// creation — writes one row per touched stock pool (product row or variant
// row; variant_id 0 means the base product's own stock). `change` is signed
// (+ restock, − sale), `stock_after` is the pool's stock after the change, so
// the trail is reconcilable. Rows are never updated or deleted.
// (Inventory + Cart checkpoint.)
export const stockMovements = sqliteTable("stock_movements", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  productId: integer("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  variantId: integer("variant_id").notNull().default(0),
  change: integer("change").notNull(),
  stockAfter: integer("stock_after").notNull(),
  reason: text("reason", { enum: ["order_placed", "order_cancelled", "return_accepted", "manual_adjust", "product_created", "variant_created"] }).notNull(),
  orderId: integer("order_id").references(() => orders.id, { onDelete: "set null" }),
  actorType: text("actor_type").notNull().default(""),
  actorId: text("actor_id").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({ productIdx: index("stock_movements_product_id_idx").on(table.productId) }));

// Admin/sensitive-action audit trail. Append-only.
export const auditLogs = sqliteTable("audit_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  actorType: text("actor_type").notNull(),
  actorId: text("actor_id").notNull(),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull().default(""),
  entityId: text("entity_id").notNull().default(""),
  detail: text("detail").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({ createdIdx: index("audit_logs_created_at_idx").on(table.createdAt) }));

// ---------- orders + shipping + returns/refunds checkpoint ----------

// Platform-wide settings as plain key/value rows (admin-configurable from
// the admin panel). Shipping keys: shipping_express_fee_paisa,
// shipping_standard_enabled, shipping_express_enabled,
// shipping_pickup_enabled. Absent keys fall back to built-in defaults so a
// fresh database behaves sanely before an admin touches them.
export const platformSettings = sqliteTable("platform_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

// One row per return request on a fulfilment order. The reason the buyer
// typed is captured here at request time (the orders row only carries the
// status), and the seller's or admin's decision is recorded with who
// decided and when. One request per order — enforced by unique index.
export const returnRequests = sqliteTable("return_requests", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  orderId: integer("order_id").notNull().references(() => orders.id),
  reason: text("reason").notNull(),
  status: text("status", { enum: ["requested", "accepted", "rejected"] }).notNull().default("requested"),
  requestedBy: text("requested_by").notNull().default(""),
  decidedBy: text("decided_by"),
  decidedAt: integer("decided_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({ orderIdx: uniqueIndex("return_requests_order_id_unique").on(table.orderId) }));

// Refund records: one row per returned fulfilment order. Nepal Shop has NO
// automatic provider refunds (eSewa/Khalti integrations cannot reverse a
// payment), so every real refund is completed manually by the marketplace
// team through the provider dashboard and confirmed here with a reference.
// Statuses: not_required (COD order that was never paid — no money to send
// back), pending (a real refund is owed, waiting on the marketplace team),
// completed (money confirmed returned), failed (the attempt failed; the team
// retries and the row is re-resolved). The orders row only ever flips to
// "refunded" via a completed refund row — never by a seller's word alone.
export const refunds = sqliteTable("refunds", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  orderId: integer("order_id").notNull().references(() => orders.id),
  groupId: integer("group_id").references(() => orderGroups.id),
  amountPaisa: integer("amount_paisa").notNull(),
  provider: text("provider", { enum: ["cod", "esewa", "khalti"] }).notNull(),
  status: text("status", { enum: ["not_required", "pending", "completed", "failed"] }).notNull().default("pending"),
  method: text("method", { enum: ["none", "manual", "provider"] }).notNull().default("manual"),
  note: text("note").notNull().default(""),
  requestedBy: text("requested_by").notNull().default(""),
  resolvedBy: text("resolved_by"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({ orderIdx: uniqueIndex("refunds_order_id_unique").on(table.orderId) }));
