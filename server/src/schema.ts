// ---------------------------------------------------------------------------
// Postgres (Supabase) port of the SQLite schema. Table names, column names,
// index/constraint names, nullability and defaults are byte-identical to the
// SQLite schema so data migration is a straight row-for-row copy.
//
// Type mapping decisions (verified against server/src/actions.ts usage):
// - integer PK with { autoIncrement: true } -> serial("id").primaryKey().
//   Two PKs are NOT autoincrement and stay plain integer PKs: smtp_settings.id
//   (single row, app always inserts id=1) and
//   seller_payout_details.store_id (app always inserts the store id).
// - integer(..., { mode: "boolean" }) -> boolean(...). SQLite stored 0/1 but
//   drizzle already surfaced these as JS booleans, so app code is unchanged;
//   the data migration must convert 0/1 to false/true.
// - integer(..., { mode: "timestamp_ms" }) -> timestamp(..., { mode: "date",
//   withTimezone: true }). The app inserts `new Date()` at every write site
//   and calls `.toISOString()` on every read value, so mode "date" keeps all
//   code compiling with zero changes. `withTimezone` is used because SQLite
//   timestamp_ms stores absolute UTC milliseconds and timestamptz is its
//   exact Postgres analogue; node-postgres parses timestamptz back to the
//   correct instant regardless of server TZ (plain `timestamp` would shift
//   under a non-UTC TZ and break expiry comparisons). The data migration
//   must convert millisecond integers, e.g. to_timestamp(ms / 1000.0).
// - text(..., { enum: [...] }) stays text with the same TS union type;
//   Postgres keeps it a plain TEXT column (no native enum created).
// - No blob() or real() columns exist in this schema.
// - $defaultFn(() => new Date()) is kept: drizzle evaluates it client-side,
//   so no SQL DEFAULT is emitted for those columns.
// - Schema drift fixed: drizzle/ migrations created objects that schema.ts
//   was missing; they are included here with identical names. Indexes:
//   cart_items_cart_product_unique, product_views_product_created_idx,
//   search_events_query_idx (0006); idx_products_active_created,
//   idx_orders_phone_created, idx_reviews_product_created (0002);
//   idx_products_store_id, idx_orders_store_id (0004). Foreign keys:
//   orders.group_id and coupon_usages.group_id both reference
//   order_groups(id) (0009, enforced in SQLite via PRAGMA foreign_keys=ON).
// ---------------------------------------------------------------------------

import { boolean, index, integer, pgTable, primaryKey, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const storeSettings = pgTable("store_settings", {
  id: serial("id").primaryKey(),
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
  vacationMode: boolean("vacation_mode").notNull().default(false),
  // Set by the token-based email verification flow (registerSeller /
  // verifySellerEmail). Sellers created before verification existed are
  // grandfathered via migration 0017.
  emailVerified: boolean("email_verified").notNull().default(false),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().$defaultFn(() => new Date()),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).notNull().$defaultFn(() => new Date()),
}, (table) => ({ sellerCodeIdx: uniqueIndex("store_settings_seller_code_unique").on(table.sellerCode), emailIdx: uniqueIndex("store_settings_email_unique").on(table.email) }));

export const products = pgTable("products", {
  id: serial("id").primaryKey(),
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
  isActive: boolean("is_active").notNull().default(true),
  // Product approval lifecycle (v9 gap-fill): "approved" products may go
  // public (still gated by is_active, the seller's publish toggle, and an
  // active store); "pending" products are invisible to customers while they
  // await admin review; "rejected" products are blocked from sale. Added in
  // migration 0061 with a backfill of "approved" so existing listings keep
  // their behaviour; products created by not-yet-approved sellers start at
  // "pending" (see createProduct).
  approvalStatus: text("approval_status", { enum: ["approved", "pending", "rejected"] }).notNull().default("approved"),
  // v15: gender for the Gender filter (men/women/kids/unisex, null = unset).
  gender: text("gender", { enum: ["men", "women", "kids", "unisex"] }),
  // v15: flash sale scheduling — flashSale marks the product for the homepage
  // flash-sale strip; flashSaleEndsAt (null = no end) bounds it.
  flashSale: boolean("flash_sale").notNull().default(false),
  flashSaleEndsAt: timestamp("flash_sale_ends_at", { mode: "date", withTimezone: true }),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().$defaultFn(() => new Date()),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).notNull().$defaultFn(() => new Date()),
}, (table) => ({
  storeSkuIdx: uniqueIndex("products_store_id_sku_unique").on(table.storeId, table.sku),
  // In the DB via drizzle/0002 but missing from the old schema.ts (drift, now included).
  activeCreatedIdx: index("idx_products_active_created").on(table.isActive, table.createdAt),
  // In the DB via drizzle/0004 but missing from the old schema.ts (drift, now included).
  storeIdx: index("idx_products_store_id").on(table.storeId),
}));

export const productImages = pgTable("product_images", {
  id: serial("id").primaryKey(),
  productId: integer("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().$defaultFn(() => new Date()),
}, (table) => ({ productIdx: index("product_images_product_id_idx").on(table.productId) }));

export const orders = pgTable("orders", {
  id: serial("id").primaryKey(),
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
  groupId: integer("group_id").references(() => orderGroups.id), // FK enforced in the DB since drizzle/0009 (was missing from the old schema.ts)
  trackingNumber: text("tracking_number"),
  carrier: text("carrier"),
  deliveredAt: timestamp("delivered_at", { mode: "date", withTimezone: true }),
  status: text("status", { enum: ["confirmation_needed", "confirmed", "packed", "shipped", "out_for_delivery", "delivery_failed", "delivered", "return_requested", "returned", "refunded", "cancelled"] }).notNull().default("confirmation_needed"),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().$defaultFn(() => new Date()),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).notNull().$defaultFn(() => new Date()),
}, (table) => ({
  orderCodeIdx: uniqueIndex("orders_order_code_unique").on(table.orderCode),
  userIdx: index("orders_user_id_idx").on(table.userId),
  groupIdx: index("orders_group_id_idx").on(table.groupId),
  createdIdx: index("orders_created_at_idx").on(table.createdAt),
  // In the DB via drizzle/0002 but missing from the old schema.ts (drift, now included).
  phoneCreatedIdx: index("idx_orders_phone_created").on(table.phone, table.createdAt),
  // In the DB via drizzle/0004 but missing from the old schema.ts (drift, now included).
  storeIdx: index("idx_orders_store_id").on(table.storeId),
}));

export const orderItems = pgTable("order_items", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
  productId: integer("product_id").notNull().references(() => products.id),
  productName: text("product_name").notNull(),
  quantity: integer("quantity").notNull(),
  unitPricePaisa: integer("unit_price_paisa").notNull(),
  variantId: integer("variant_id"),
  variantLabel: text("variant_label"),
}, (table) => ({ orderIdx: index("order_items_order_id_idx").on(table.orderId) }));

export const reviews = pgTable("reviews", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id").notNull().references(() => orders.id),
  productId: integer("product_id").notNull().references(() => products.id),
  reviewerName: text("reviewer_name").notNull(),
  rating: integer("rating").notNull(),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().$defaultFn(() => new Date()),
}, (table) => ({
  orderProductIdx: uniqueIndex("reviews_order_product_unique").on(table.orderId, table.productId),
  // In the DB via drizzle/0002 but missing from the old schema.ts (drift, now included).
  productCreatedIdx: index("idx_reviews_product_created").on(table.productId, table.createdAt),
}));

// Buyer-submitted reports against public product reviews. The admin panel
// (Admin checkpoint) triages these: dismiss the report or delete the review.
// No report row means nobody has flagged the review.
export const reviewReports = pgTable("review_reports", {
  id: serial("id").primaryKey(),
  reviewId: integer("review_id").notNull().references(() => reviews.id, { onDelete: "cascade" }),
  reason: text("reason", { enum: ["spam", "abuse", "fake", "other"] }).notNull(),
  detail: text("detail").notNull().default(""),
  reporterName: text("reporter_name").notNull().default(""),
  status: text("status", { enum: ["open", "resolved"] }).notNull().default("open"),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().$defaultFn(() => new Date()),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }),
}, (table) => ({ reviewIdx: index("review_reports_review_id_idx").on(table.reviewId) }));

export const buyerIssues = pgTable("buyer_issues", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id").notNull().references(() => orders.id),
  kind: text("kind").notNull(),
  detail: text("detail").notNull(),
  status: text("status", { enum: ["open", "resolved"] }).notNull().default("open"),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().$defaultFn(() => new Date()),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).notNull().$defaultFn(() => new Date()),
}, (table) => ({ orderIdx: index("buyer_issues_order_id_idx").on(table.orderId) }));

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  phone: text("phone").notNull(),
  email: text("email"),
  passwordHash: text("password_hash").notNull(),
  status: text("status", { enum: ["active", "suspended"] }).notNull().default("active"),
  // Set by the token-based buyer email verification flow (signup /
  // verifyBuyerEmail). Defaults to false; buyers who registered before this
  // existed simply verify from their account page.
  emailVerified: boolean("email_verified").notNull().default(false),
  // Buyer profile photo uploaded from the account page (avatar-<uuid>.<ext>
  // under UPLOADS_DIR, served from /uploads/). Null until the buyer uploads
  // one; the client falls back to an initial-letter avatar.
  avatarUrl: text("avatar_url"),
  // Notification preference (Notifications checkpoint): when false, the
  // buyer gets no order-update emails (confirmation, payment, shipping,
  // returns, refunds). Security emails (password reset, verification)
  // always go through; in-app notifications are unaffected.
  notifyOrderEmails: boolean("notify_order_emails").notNull().default(true),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().$defaultFn(() => new Date()),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }),
}, (table) => ({
  phoneIdx: uniqueIndex("users_phone_unique").on(table.phone),
  emailIdx: uniqueIndex("users_email_unique").on(table.email),
}));

export const admins = pgTable("admins", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().$defaultFn(() => new Date()),
}, (table) => ({ emailIdx: uniqueIndex("admins_email_unique").on(table.email) }));

export const sessions = pgTable("sessions", {
  token: text("token").primaryKey(),
  userType: text("user_type", { enum: ["buyer", "seller", "admin"] }).notNull(),
  userId: text("user_id").notNull(),
  expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }).notNull(),
}, (table) => ({ expiresIdx: index("sessions_expires_at_idx").on(table.expiresAt), userIdx: index("sessions_user_id_idx").on(table.userId) }));

// Admin-managed SMTP settings (single row, id=1). Lets the admin configure
// outgoing mail from the admin panel instead of environment variables; env
// (SMTP_HOST/SMTP_USER/SMTP_PASS) takes precedence when fully set. The
// password is stored here but never returned by any action and never logged.
export const smtpSettings = pgTable("smtp_settings", {
  id: integer("id").primaryKey(),
  host: text("host"),
  port: integer("port"),
  username: text("username"),
  password: text("password"),
  fromAddress: text("from_address"),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }),
});

// ---------- phase 2: cart, wishlist, coupons, payments, notifications ----------

export const carts = pgTable("carts", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).notNull().$defaultFn(() => new Date()),
}, (table) => ({ userIdx: uniqueIndex("carts_user_id_unique").on(table.userId) }));

export const cartItems = pgTable("cart_items", {
  id: serial("id").primaryKey(),
  cartId: integer("cart_id").notNull().references(() => carts.id, { onDelete: "cascade" }),
  productId: integer("product_id").notNull().references(() => products.id),
  quantity: integer("quantity").notNull(),
  variantId: integer("variant_id").notNull().default(0),
  variantLabel: text("variant_label"),
}, (table) => ({ cartProductVariantIdx: uniqueIndex("cart_items_cart_product_variant_unique").on(table.cartId, table.productId, table.variantId),
  // Present in the DB via drizzle/0006_phase2.sql but missing from the old schema.ts (drift, now included).
  cartProductIdx: uniqueIndex("cart_items_cart_product_unique").on(table.cartId, table.productId) }));

export const addresses = pgTable("addresses", {
  id: serial("id").primaryKey(),
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
  isDefault: boolean("is_default").notNull().default(false),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().$defaultFn(() => new Date()),
}, (table) => ({ userIdx: index("addresses_user_id_idx").on(table.userId) }));

export const wishlists = pgTable("wishlists", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().$defaultFn(() => new Date()),
}, (table) => ({ userIdx: uniqueIndex("wishlists_user_id_unique").on(table.userId) }));

export const wishlistItems = pgTable("wishlist_items", {
  id: serial("id").primaryKey(),
  wishlistId: integer("wishlist_id").notNull().references(() => wishlists.id, { onDelete: "cascade" }),
  productId: integer("product_id").notNull().references(() => products.id),
  addedPricePaisa: integer("added_price_paisa").notNull(),
  addedAt: timestamp("added_at", { mode: "date", withTimezone: true }).notNull().$defaultFn(() => new Date()),
}, (table) => ({ wishlistProductIdx: uniqueIndex("wishlist_items_wishlist_product_unique").on(table.wishlistId, table.productId) }));

export const coupons = pgTable("coupons", {
  id: serial("id").primaryKey(),
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
  expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().$defaultFn(() => new Date()),
}, (table) => ({ codeIdx: uniqueIndex("coupons_code_unique").on(table.code) }));

export const couponUsages = pgTable("coupon_usages", {
  id: serial("id").primaryKey(),
  couponId: integer("coupon_id").notNull().references(() => coupons.id),
  userId: text("user_id"),
  // Guests have no account, so the per-user limit is enforced against their
  // verified checkout phone number instead (Checkout + Payments checkpoint).
  // NULL for signed-in buyers, whose limit is enforced on user_id.
  guestPhone: text("guest_phone"),
  orderId: integer("order_id").notNull().references(() => orders.id),
  groupId: integer("group_id").references(() => orderGroups.id), // FK enforced in the DB since drizzle/0009 (was missing from the old schema.ts)
  usedAt: timestamp("used_at", { mode: "date", withTimezone: true }).notNull().$defaultFn(() => new Date()),
}, (table) => ({ orderIdx: uniqueIndex("coupon_usages_order_id_unique").on(table.orderId) }));

export const payments = pgTable("payments", {
  id: serial("id").primaryKey(),
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
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().$defaultFn(() => new Date()),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).notNull().$defaultFn(() => new Date()),
}, (table) => ({ orderIdx: uniqueIndex("payments_order_id_unique").on(table.orderId), groupIdx: index("payments_group_id_idx").on(table.groupId) }));

// Idempotency keys for placeOrder. A key is written inside the same
// transaction that creates the order group, so a double-clicked "Place
// order" (two requests racing with the same key) can only ever create one
// group: the loser sees the winner's row and returns the same result.
// Rows older than 7 days are pruned opportunistically on insert.
export const checkoutIdempotency = pgTable("checkout_idempotency", {
  key: text("key").primaryKey(),
  groupId: integer("group_id").notNull().references(() => orderGroups.id),
  // Ownership binding: a key replays only for the same buyer identity that
  // created it (signed-in user id, or normalized guest phone), and only for
  // the same request payload. A different caller or different payload sees
  // an error, never the other buyer's order.
  userId: text("user_id"),
  guestPhone: text("guest_phone"),
  payload: text("payload"),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().$defaultFn(() => new Date()),
});

export const notifications = pgTable("notifications", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  type: text("type").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  link: text("link"),
  isRead: boolean("is_read").notNull().default(false),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().$defaultFn(() => new Date()),
}, (table) => ({ userIdx: index("notifications_user_id_idx").on(table.userId) }));

export const supportTickets = pgTable("support_tickets", {
  id: serial("id").primaryKey(),
  ticketCode: text("ticket_code").notNull(),
  userId: text("user_id"),
  name: text("name").notNull(),
  contact: text("contact").notNull(),
  subject: text("subject").notNull(),
  message: text("message").notNull(),
  orderCode: text("order_code"),
  status: text("status", { enum: ["open", "answered", "closed"] }).notNull().default("open"),
  adminReply: text("admin_reply"),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().$defaultFn(() => new Date()),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).notNull().$defaultFn(() => new Date()),
}, (table) => ({ codeIdx: uniqueIndex("support_tickets_ticket_code_unique").on(table.ticketCode) }));

export const categories = pgTable("categories", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  // Category SEO (v9 gap-fill): shown on the public category page by the
  // client; null means "not set" and the client falls back to defaults.
  seoTitle: text("seo_title"),
  seoDescription: text("seo_description"),
  introContent: text("intro_content"),
}, (table) => ({
  nameIdx: uniqueIndex("categories_name_unique").on(table.name),
  slugIdx: uniqueIndex("categories_slug_unique").on(table.slug),
}));

// ---------- v12: seller category requests ----------
// A seller proposes a new category from the product workflow; an admin
// approves or rejects it. Approval inserts the category into `categories`,
// which is the same table every seller picks from — no duplicate systems,
// no duplicate names (pending requests are unique per seller by
// lower(name); approval reuses the categories slug-uniqueness check).
export const categoryRequests = pgTable("category_requests", {
  id: serial("id").primaryKey(),
  storeId: integer("store_id").notNull().references(() => storeSettings.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  status: text("status", { enum: ["pending", "approved", "rejected"] }).notNull().default("pending"),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().$defaultFn(() => new Date()),
  decidedAt: timestamp("decided_at", { mode: "date", withTimezone: true }),
});

// ---------- v9: invoices, product Q&A, product approval ----------

// Invoices. One row is created per checkout group right after placeOrder
// commits (auto-heal: getInvoice also creates it on demand for older
// orders). A single fulfilment can also carry its own row (order_id) —
// exactly one of order_id / group_id is set on every row.
export const invoices = pgTable("invoices", {
  id: serial("id").primaryKey(),
  invoiceNo: text("invoice_no").notNull(),
  orderId: integer("order_id").references(() => orders.id),
  groupId: integer("group_id").references(() => orderGroups.id),
  issuedAt: timestamp("issued_at", { mode: "date", withTimezone: true }).notNull().$defaultFn(() => new Date()),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().$defaultFn(() => new Date()),
}, (table) => ({
  noIdx: uniqueIndex("invoices_invoice_no_unique").on(table.invoiceNo),
  orderIdx: index("invoices_order_id_idx").on(table.orderId),
  groupIdx: index("invoices_group_id_idx").on(table.groupId),
}));

// Yearly invoice-number counters. The counter row is bumped inside the same
// transaction that inserts the invoice row, so concurrent checkouts serialize
// on the write lock and invoice numbers can never be issued twice.
export const invoiceCounters = pgTable("invoice_counters", {
  key: text("key").primaryKey(),
  last: integer("last").notNull().default(0),
});

// Buyer questions about a product. The asker is a signed-in buyer; the
// product's owning seller writes the answer. Pending (unanswered) questions
// are visible only to their asker — never to other buyers.
export const productQuestions = pgTable("product_questions", {
  id: serial("id").primaryKey(),
  productId: integer("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  askerName: text("asker_name").notNull().default(""),
  question: text("question").notNull(),
  answer: text("answer"),
  answeredAt: timestamp("answered_at", { mode: "date", withTimezone: true }),
  isVisible: boolean("is_visible").notNull().default(true),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().$defaultFn(() => new Date()),
}, (table) => ({ productIdx: index("product_questions_product_id_idx").on(table.productId) }));

export const homepageBanners = pgTable("homepage_banners", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  subtitle: text("subtitle"),
  link: text("link"),
  imageUrl: text("image_url"),
  isActive: boolean("is_active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
}, (table) => ({ activeSortIdx: index("homepage_banners_active_sort_idx").on(table.isActive, table.sortOrder) }));

export const homepageSections = pgTable("homepage_sections", {
  key: text("key").primaryKey(),
  title: text("title").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const productViews = pgTable("product_views", {
  id: serial("id").primaryKey(),
  productId: integer("product_id").notNull().references(() => products.id),
  userId: text("user_id"),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().$defaultFn(() => new Date()),
}, (table) => ({
  createdIdx: index("product_views_created_at_idx").on(table.createdAt),
  // Present in the DB via drizzle/0006_phase2.sql but missing from the old schema.ts (drift, now included).
  productCreatedIdx: index("product_views_product_created_idx").on(table.productId, table.createdAt),
}));

export const searchEvents = pgTable("search_events", {
  id: serial("id").primaryKey(),
  query: text("query").notNull(),
  userId: text("user_id"),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().$defaultFn(() => new Date()),
}, (table) => ({
  createdIdx: index("search_events_created_at_idx").on(table.createdAt),
  // Present in the DB via drizzle/0006_phase2.sql but missing from the old schema.ts (drift, now included).
  queryIdx: index("search_events_query_idx").on(table.query),
}));

// Funnel events for honestly measurable purchase analytics. add_to_cart is
// recorded server-side inside addToCart (the product id is validated there,
// never trusted from the client); checkout_start is recorded by the
// trackCheckoutStart action when a signed-in buyer opens checkout. Purchases
// are derived from the orders table (the single source of truth) — they are
// not duplicated here. Rows are deduped at write time (see recordFunnelEvent)
// so refreshes and double-taps don't inflate the numbers.
export const funnelEvents = pgTable("funnel_events", {
  id: serial("id").primaryKey(),
  event: text("event", { enum: ["add_to_cart", "checkout_start"] }).notNull(),
  productId: integer("product_id").references(() => products.id),
  userId: text("user_id"),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().$defaultFn(() => new Date()),
}, (table) => ({
  eventCreatedIdx: index("funnel_events_event_created_idx").on(table.event, table.createdAt),
}));

export const recentlyViewed = pgTable("recently_viewed", {
  userId: text("user_id").notNull(),
  productId: integer("product_id").notNull().references(() => products.id),
  viewedAt: timestamp("viewed_at", { mode: "date", withTimezone: true }).notNull().$defaultFn(() => new Date()),
}, (table) => ({ pk: primaryKey({ columns: [table.userId, table.productId] }) }));

// ---------- v7: production-readiness ----------

// Password-reset tokens. Only the SHA-256 hash of the token is stored;
// tokens are single-use and expire after 1 hour.
export const passwordResetTokens = pgTable("password_reset_tokens", {
  id: serial("id").primaryKey(),
  tokenHash: text("token_hash").notNull(),
  userType: text("user_type", { enum: ["buyer", "seller", "admin"] }).notNull(),
  userId: text("user_id").notNull(),
  expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { mode: "date", withTimezone: true }),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().$defaultFn(() => new Date()),
}, (table) => ({ tokenHashIdx: uniqueIndex("password_reset_tokens_token_hash_unique").on(table.tokenHash) }));

// Seller email-verification tokens (Seller checkpoint). Same pattern as
// password_reset_tokens: only the SHA-256 hash of the token is stored;
// tokens are single-use and expire after 24 hours.
export const sellerEmailVerifications = pgTable("seller_email_verifications", {
  id: serial("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  storeId: integer("store_id").notNull().references(() => storeSettings.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { mode: "date", withTimezone: true }),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().$defaultFn(() => new Date()),
});

// Buyer email-verification tokens (Notifications checkpoint). Same pattern
// as the seller flow: hash-only storage, single-use, 24-hour expiry.
// Verifying sets users.email_verified.
export const buyerEmailVerifications = pgTable("buyer_email_verifications", {
  id: serial("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { mode: "date", withTimezone: true }),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().$defaultFn(() => new Date()),
});

// A checkout that spans several sellers creates one group plus one order per
// seller. The customer experiences a single order (the group code); each
// seller only ever sees their own sub-order.
export const orderGroups = pgTable("order_groups", {
  id: serial("id").primaryKey(),
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
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().$defaultFn(() => new Date()),
}, (table) => ({ groupCodeIdx: uniqueIndex("order_groups_group_code_unique").on(table.groupCode) }));

// Product variants (size, colour, ...). A variant may override the price and
// carries its own stock; variant_id 0 / NULL means "the base product".
export const productVariants = pgTable("product_variants", {
  id: serial("id").primaryKey(),
  productId: integer("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  sku: text("sku"),
  pricePaisa: integer("price_paisa"),
  stock: integer("stock").notNull().default(0),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().$defaultFn(() => new Date()),
}, (table) => ({ productIdx: index("product_variants_product_id_idx").on(table.productId) }));

// Product specifications (Seller checkpoint): a small structured
// label/value table per product (e.g. Material → Cotton, Fit → Regular),
// rendered as a spec sheet on the public product page.
export const productSpecifications = pgTable("product_specifications", {
  id: serial("id").primaryKey(),
  productId: integer("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  value: text("value").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().$defaultFn(() => new Date()),
}, (table) => ({ productIdx: index("product_specifications_product_id_idx").on(table.productId) }));

// Commission rules. Resolution order: product > seller > category >
// campaign (when its window is open) > platform default. `percent` is a
// whole percent (0-90). `scope_id` holds the product id, store id, category
// name or campaign code depending on scope; campaigns may carry an optional
// active window (starts_at/ends_at) and a human label like "Dashain sale".
export const commissionRules = pgTable("commission_rules", {
  id: serial("id").primaryKey(),
  scope: text("scope", { enum: ["platform", "category", "seller", "product", "campaign"] }).notNull(),
  scopeId: text("scope_id").notNull().default(""),
  percent: integer("percent").notNull(),
  label: text("label").notNull().default(""),
  startsAt: timestamp("starts_at", { mode: "date", withTimezone: true }),
  endsAt: timestamp("ends_at", { mode: "date", withTimezone: true }),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().$defaultFn(() => new Date()),
});

// Append-only seller money ledger. `amount_paisa` is signed: positive credits
// the seller, negative debits. `balance_after_paisa` is the store's running
// net balance after the row, so every calculation is traceable. `ledger_key`
// is a unique idempotency key (e.g. "sale:12", "commission:12",
// "payout:7"): re-running a transition can never double-post. Rows are
// never updated or deleted — corrections are new rows.
export const sellerLedger = pgTable("seller_ledger", {
  id: serial("id").primaryKey(),
  storeId: integer("store_id").notNull().references(() => storeSettings.id),
  orderId: integer("order_id").references(() => orders.id),
  type: text("type", { enum: ["sale", "commission", "refund", "payout", "adjustment"] }).notNull(),
  amountPaisa: integer("amount_paisa").notNull(),
  balanceAfterPaisa: integer("balance_after_paisa").notNull(),
  ruleId: integer("rule_id"),
  payoutId: integer("payout_id").references(() => sellerPayouts.id),
  ledgerKey: text("ledger_key"),
  note: text("note").notNull().default(""),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().$defaultFn(() => new Date()),
}, (table) => ({
  storeIdx: index("seller_ledger_store_id_idx").on(table.storeId),
  keyIdx: uniqueIndex("seller_ledger_key_unique").on(table.ledgerKey),
}));

// Where to send a seller's money. One row per seller; account numbers are
// masked in every API response.
export const sellerPayoutDetails = pgTable("seller_payout_details", {
  storeId: integer("store_id").primaryKey().references(() => storeSettings.id),
  bankName: text("bank_name"),
  accountName: text("account_name"),
  accountNumber: text("account_number"),
  esewaId: text("esewa_id"),
  khaltiId: text("khalti_id"),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).notNull().$defaultFn(() => new Date()),
});

export const sellerPayouts = pgTable("seller_payouts", {
  id: serial("id").primaryKey(),
  storeId: integer("store_id").notNull().references(() => storeSettings.id),
  amountPaisa: integer("amount_paisa").notNull(),
  status: text("status", { enum: ["requested", "processing", "completed", "failed", "cancelled"] }).notNull().default("requested"),
  method: text("method", { enum: ["bank", "esewa", "khalti"] }).notNull(),
  destination: text("destination").notNull().default(""),
  reference: text("reference"),
  note: text("note").notNull().default(""),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().$defaultFn(() => new Date()),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).notNull().$defaultFn(() => new Date()),
}, (table) => ({ storeIdx: index("seller_payouts_store_id_idx").on(table.storeId) }));

// Append-only inventory ledger. Every stock change — order decrements,
// cancellation/return restores, seller manual adjustments, initial stock on
// creation — writes one row per touched stock pool (product row or variant
// row; variant_id 0 means the base product's own stock). `change` is signed
// (+ restock, − sale), `stock_after` is the pool's stock after the change, so
// the trail is reconcilable. Rows are never updated or deleted.
// (Inventory + Cart checkpoint.)
export const stockMovements = pgTable("stock_movements", {
  id: serial("id").primaryKey(),
  productId: integer("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  variantId: integer("variant_id").notNull().default(0),
  change: integer("change").notNull(),
  stockAfter: integer("stock_after").notNull(),
  reason: text("reason", { enum: ["order_placed", "order_cancelled", "return_accepted", "manual_adjust", "product_created", "variant_created"] }).notNull(),
  orderId: integer("order_id").references(() => orders.id, { onDelete: "set null" }),
  actorType: text("actor_type").notNull().default(""),
  actorId: text("actor_id").notNull().default(""),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().$defaultFn(() => new Date()),
}, (table) => ({ productIdx: index("stock_movements_product_id_idx").on(table.productId) }));

// Admin/sensitive-action audit trail. Append-only.
export const auditLogs = pgTable("audit_logs", {
  id: serial("id").primaryKey(),
  actorType: text("actor_type").notNull(),
  actorId: text("actor_id").notNull(),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull().default(""),
  entityId: text("entity_id").notNull().default(""),
  detail: text("detail").notNull().default(""),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().$defaultFn(() => new Date()),
}, (table) => ({ createdIdx: index("audit_logs_created_at_idx").on(table.createdAt) }));

// ---------- orders + shipping + returns/refunds checkpoint ----------

// Platform-wide settings as plain key/value rows (admin-configurable from
// the admin panel). Shipping keys: shipping_express_fee_paisa,
// shipping_standard_enabled, shipping_express_enabled,
// shipping_pickup_enabled. Absent keys fall back to built-in defaults so a
// fresh database behaves sanely before an admin touches them.
export const platformSettings = pgTable("platform_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).notNull().$defaultFn(() => new Date()),
});

// One row per return request on a fulfilment order. The reason the buyer
// typed is captured here at request time (the orders row only carries the
// status), and the seller's or admin's decision is recorded with who
// decided and when. One request per order — enforced by unique index.
export const returnRequests = pgTable("return_requests", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id").notNull().references(() => orders.id),
  reason: text("reason").notNull(),
  status: text("status", { enum: ["requested", "accepted", "rejected"] }).notNull().default("requested"),
  requestedBy: text("requested_by").notNull().default(""),
  decidedBy: text("decided_by"),
  decidedAt: timestamp("decided_at", { mode: "date", withTimezone: true }),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().$defaultFn(() => new Date()),
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
export const refunds = pgTable("refunds", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id").notNull().references(() => orders.id),
  groupId: integer("group_id").references(() => orderGroups.id),
  amountPaisa: integer("amount_paisa").notNull(),
  provider: text("provider", { enum: ["cod", "esewa", "khalti"] }).notNull(),
  status: text("status", { enum: ["not_required", "pending", "completed", "failed"] }).notNull().default("pending"),
  method: text("method", { enum: ["none", "manual", "provider"] }).notNull().default("manual"),
  note: text("note").notNull().default(""),
  requestedBy: text("requested_by").notNull().default(""),
  resolvedBy: text("resolved_by"),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().$defaultFn(() => new Date()),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).notNull().$defaultFn(() => new Date()),
}, (table) => ({ orderIdx: uniqueIndex("refunds_order_id_unique").on(table.orderId) }));
