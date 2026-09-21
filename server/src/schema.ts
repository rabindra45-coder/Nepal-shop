import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const storeSettings = sqliteTable("store_settings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sellerCode: text("seller_code").notNull(),
  storeName: text("store_name").notNull(),
  tagline: text("tagline").notNull(),
  location: text("location").notNull(),
  phone: text("phone").notNull(),
  adminKeyHash: text("admin_key_hash").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({ sellerCodeIdx: uniqueIndex("store_settings_seller_code_unique").on(table.sellerCode) }));

export const products = sqliteTable("products", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  storeId: integer("store_id").notNull().references(() => storeSettings.id),
  name: text("name").notNull(),
  category: text("category").notNull(),
  description: text("description").notNull(),
  pricePaisa: integer("price_paisa").notNull(),
  deliveryFeePaisa: integer("delivery_fee_paisa").notNull().default(0),
  stock: integer("stock").notNull().default(0),
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
  paymentMethod: text("payment_method", { enum: ["cod"] }).notNull(),
  status: text("status", { enum: ["confirmation_needed", "confirmed", "packed", "shipped", "delivered", "cancelled"] }).notNull().default("confirmation_needed"),
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
