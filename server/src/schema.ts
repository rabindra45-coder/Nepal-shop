import { integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const storeSettings = sqliteTable("store_settings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sellerCode: text("seller_code").notNull(),
  storeName: text("store_name").notNull(),
  tagline: text("tagline").notNull(),
  location: text("location").notNull(),
  phone: text("phone").notNull(),
  adminKeyHash: text("admin_key_hash").notNull().default(""),
  email: text("email"),
  passwordHash: text("password_hash"),
  status: text("status", { enum: ["pending", "active", "suspended"] }).notNull().default("active"),
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
  lowStockThreshold: integer("low_stock_threshold").notNull().default(5),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

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
  status: text("status", { enum: ["confirmation_needed", "confirmed", "packed", "shipped", "out_for_delivery", "delivered", "return_requested", "returned", "refunded", "cancelled"] }).notNull().default("confirmation_needed"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({ orderCodeIdx: uniqueIndex("orders_order_code_unique").on(table.orderCode) }));

export const orderItems = sqliteTable("order_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  orderId: integer("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
  productId: integer("product_id").notNull().references(() => products.id),
  productName: text("product_name").notNull(),
  quantity: integer("quantity").notNull(),
  unitPricePaisa: integer("unit_price_paisa").notNull(),
});

export const reviews = sqliteTable("reviews", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  orderId: integer("order_id").notNull().references(() => orders.id),
  productId: integer("product_id").notNull().references(() => products.id),
  reviewerName: text("reviewer_name").notNull(),
  rating: integer("rating").notNull(),
  body: text("body").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({ orderProductIdx: uniqueIndex("reviews_order_product_unique").on(table.orderId, table.productId) }));

export const buyerIssues = sqliteTable("buyer_issues", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  orderId: integer("order_id").notNull().references(() => orders.id),
  kind: text("kind").notNull(),
  detail: text("detail").notNull(),
  status: text("status", { enum: ["open", "resolved"] }).notNull().default("open"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  phone: text("phone").notNull(),
  email: text("email"),
  passwordHash: text("password_hash").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
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
});

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
}, (table) => ({ cartProductIdx: uniqueIndex("cart_items_cart_product_unique").on(table.cartId, table.productId) }));

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
});

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
  orderId: integer("order_id").notNull().references(() => orders.id),
  usedAt: integer("used_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({ orderIdx: uniqueIndex("coupon_usages_order_id_unique").on(table.orderId) }));

export const payments = sqliteTable("payments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  orderId: integer("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
  provider: text("provider", { enum: ["cod", "esewa", "khalti"] }).notNull(),
  amountPaisa: integer("amount_paisa").notNull(),
  status: text("status", { enum: ["pending", "processing", "paid", "failed", "refunded", "cancelled"] }).notNull().default("pending"),
  transactionId: text("transaction_id"),
  payloadJson: text("payload_json"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({ orderIdx: uniqueIndex("payments_order_id_unique").on(table.orderId) }));

export const notifications = sqliteTable("notifications", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(),
  type: text("type").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  link: text("link"),
  isRead: integer("is_read", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

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
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
});

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
});

export const searchEvents = sqliteTable("search_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  query: text("query").notNull(),
  userId: text("user_id"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

export const recentlyViewed = sqliteTable("recently_viewed", {
  userId: text("user_id").notNull(),
  productId: integer("product_id").notNull().references(() => products.id),
  viewedAt: integer("viewed_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({ pk: primaryKey({ columns: [table.userId, table.productId] }) }));
