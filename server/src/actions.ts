import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema";
import { formatRs, levenshtein, runAssistant } from "./assistant";
import { buildEsewaParams, esewaTransactionStatus, initiateKhalti, lookupKhalti, verifyEsewaSignature } from "./payments";

const sellerCode = z.string().trim().min(6).max(40);
const keyField = z.string().min(8).max(120);
const passwordField = z.string().min(6).max(120);
const emailField = z.string().trim().toLowerCase().email().max(120);
const authTokenField = z.string().min(8).max(120).optional();
const authTokenRequired = z.string().min(8).max(120);
const sellerAuthFields = {
  authToken: authTokenField,
  seller_code: sellerCode.optional(),
  seller_key: keyField.optional(),
};
const imageUrlField = z.string().trim().max(500).refine((u) => /^https?:\/\/.+/.test(u), "Image URL must start with http:// or https://.");

const productShape = z.object({ id: z.number(), store_id: z.number(), seller_code: z.string(), store_name: z.string(), store_location: z.string(), name: z.string(), category: z.string(), description: z.string(), price_paisa: z.number(), delivery_fee_paisa: z.number(), stock: z.number(), is_active: z.boolean(), rating: z.number().nullable(), review_count: z.number(), created_at: z.string(), brand: z.string().nullable(), original_price_paisa: z.number().nullable(), discount_pct: z.number(), image_url: z.string().nullable(), low_stock: z.boolean() });
const paymentMethodEnum = z.enum(["cod", "esewa", "khalti"]);
const paymentStatusEnum = z.enum(["pending", "processing", "paid", "failed", "refunded", "cancelled"]);
const orderStatus = z.enum(["confirmation_needed", "confirmed", "packed", "shipped", "out_for_delivery", "delivered", "return_requested", "returned", "refunded", "cancelled"]);
const deliveryMethodEnum = z.enum(["standard", "express", "pickup"]);
const orderShape = z.object({ id: z.number(), order_code: z.string(), customer_name: z.string(), phone: z.string(), address: z.string(), note: z.string(), subtotal_paisa: z.number(), delivery_fee_paisa: z.number(), total_paisa: z.number(), payment_method: paymentMethodEnum, payment_status: paymentStatusEnum, discount_paisa: z.number(), coupon_code: z.string().nullable(), delivery_method: deliveryMethodEnum, status: orderStatus, created_at: z.string(), items: z.array(z.object({ id: z.number(), product_id: z.number(), product_name: z.string(), quantity: z.number(), unit_price_paisa: z.number() })) });
const sellerStatus = z.enum(["pending", "active", "suspended"]);
const userShape = z.object({ id: z.string(), name: z.string(), phone: z.string(), email: z.string().nullable() });

// --- legacy seller-key hashing (kept so old code+key logins keep working) ---
async function hashKey(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function requireSeller(ctx: Ctx, code: string, key: string) {
  const db = ctx.db<typeof schema>();
  const store = (await db.select().from(schema.storeSettings).where(eq(schema.storeSettings.sellerCode, code.toUpperCase())).limit(1))[0];
  if (!store?.adminKeyHash || store.adminKeyHash !== await hashKey(key)) throw new Error("Seller code or access key is incorrect.");
  return store;
}

// --- token sessions ---
type SessionType = "buyer" | "seller" | "admin";
const SESSION_DAYS = 30;

async function createSession(ctx: Ctx, userType: SessionType, userId: string) {
  const db = ctx.db<typeof schema>();
  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 3600 * 1000);
  await db.insert(schema.sessions).values({ token, userType, userId, expiresAt });
  return token;
}

async function requireAuth(ctx: Ctx, token: string | undefined, ...types: SessionType[]) {
  if (!token) throw new Error("Please sign in first.");
  const db = ctx.db<typeof schema>();
  const session = (await db.select().from(schema.sessions).where(eq(schema.sessions.token, token)).limit(1))[0];
  if (!session || session.expiresAt.getTime() < Date.now()) {
    if (session) await db.delete(schema.sessions).where(eq(schema.sessions.token, token));
    throw new Error("Your session has expired. Please sign in again.");
  }
  if (!types.includes(session.userType)) throw new Error("You are not allowed to do that.");
  return { type: session.userType, id: session.userId };
}

// Accepts EITHER the legacy seller_code+seller_key OR a seller authToken.
async function resolveSeller(ctx: Ctx, args: { authToken?: string; seller_code?: string; seller_key?: string }) {
  if (args.seller_code && args.seller_key) return requireSeller(ctx, args.seller_code, args.seller_key);
  if (args.authToken) {
    const auth = await requireAuth(ctx, args.authToken, "seller");
    const db = ctx.db<typeof schema>();
    const store = (await db.select().from(schema.storeSettings).where(eq(schema.storeSettings.id, Number(auth.id))).limit(1))[0];
    if (!store) throw new Error("Seller account not found.");
    return store;
  }
  throw new Error("Seller sign-in is required.");
}

function mapOrder(o: typeof schema.orders.$inferSelect, items: (typeof schema.orderItems.$inferSelect)[]) {
  return { id: o.id, order_code: o.orderCode, customer_name: o.customerName, phone: o.phone, address: o.address, note: o.note, subtotal_paisa: o.subtotalPaisa, delivery_fee_paisa: o.deliveryFeePaisa, total_paisa: o.totalPaisa, payment_method: o.paymentMethod, payment_status: o.paymentStatus, discount_paisa: o.discountPaisa, coupon_code: o.couponCode, delivery_method: o.deliveryMethod, status: o.status, created_at: o.createdAt.toISOString(), items: items.filter((i) => i.orderId === o.id).map((i) => ({ id: i.id, product_id: i.productId, product_name: i.productName, quantity: i.quantity, unit_price_paisa: i.unitPricePaisa })) };
}

async function productRows(ctx: Ctx, storeId?: number) {
  const db = ctx.db<typeof schema>();
  const [products, reviews, stores] = await Promise.all([
    storeId ? db.select().from(schema.products).where(eq(schema.products.storeId, storeId)).orderBy(desc(schema.products.createdAt)) : db.select().from(schema.products).orderBy(desc(schema.products.createdAt)),
    db.select().from(schema.reviews),
    db.select().from(schema.storeSettings),
  ]);
  return products.map((p) => {
    const rs = reviews.filter((r) => r.productId === p.id), store = stores.find((s) => s.id === p.storeId);
    const original = p.originalPricePaisa;
    return { id: p.id, store_id: p.storeId, seller_code: store?.sellerCode ?? "", store_name: store?.storeName ?? "Seller", store_location: store?.location ?? "", name: p.name, category: p.category, description: p.description, price_paisa: p.pricePaisa, delivery_fee_paisa: p.deliveryFeePaisa, stock: p.stock, is_active: p.isActive, rating: rs.length ? rs.reduce((n, r) => n + r.rating, 0) / rs.length : null, review_count: rs.length, created_at: p.createdAt.toISOString(), brand: p.brand ?? null, original_price_paisa: original ?? null, discount_pct: original && original > p.pricePaisa ? Math.round((original - p.pricePaisa) / original * 100) : 0, image_url: p.imageUrl ?? null, low_stock: p.stock > 0 && p.stock <= (p.lowStockThreshold ?? 5) };
  });
}

type PublicProduct = Awaited<ReturnType<typeof productRows>>[number];

// Full drizzle DB type (the SDK's SpaceDb pick omits `transaction`, which the
// self-hosted server provides). Used only where transactions are needed.
function fullDb(ctx: Ctx): BunSQLiteDatabase<typeof schema> {
  return ctx.db<typeof schema>() as unknown as BunSQLiteDatabase<typeof schema>;
}

async function activeStoreIds(ctx: Ctx) {
  const db = ctx.db<typeof schema>();
  const stores = await db.select({ id: schema.storeSettings.id }).from(schema.storeSettings).where(eq(schema.storeSettings.status, "active"));
  return new Set(stores.map((s) => s.id));
}

function publicOnly(products: PublicProduct[], actives: Set<number>) {
  return products.filter((p) => p.is_active && actives.has(p.store_id));
}

async function notifyUser(ctx: Ctx, userId: string, n: { type: string; title: string; body: string; link?: string | null }) {
  const db = ctx.db<typeof schema>();
  await db.insert(schema.notifications).values({ userId, type: n.type, title: n.title, body: n.body, link: n.link ?? null, createdAt: new Date() });
}

function orderStatusLabel(status: string) {
  const labels: Record<string, string> = { confirmation_needed: "awaiting confirmation", confirmed: "confirmed", packed: "packed", shipped: "shipped", out_for_delivery: "out for delivery", delivered: "delivered", return_requested: "return requested", returned: "returned", refunded: "refunded", cancelled: "cancelled" };
  return labels[status] ?? status;
}

// Returns the signed-in buyer's user id, or null for guests / other sessions.
async function buyerIdOf(ctx: Ctx, token: string | undefined) {
  if (!token) return null;
  const db = ctx.db<typeof schema>();
  const session = (await db.select().from(schema.sessions).where(eq(schema.sessions.token, token)).limit(1))[0];
  if (!session || session.expiresAt.getTime() < Date.now() || session.userType !== "buyer") return null;
  return session.userId;
}

interface CouponEval { valid: boolean; discount_paisa: number; free_shipping: boolean; message: string; coupon_id?: number; code?: string }

// Shared by validateCoupon (never throws for invalid codes) and placeOrder
// (throws when a supplied code is invalid).
async function evaluateCoupon(ctx: Ctx, code: string, userId: string | null, subtotalPaisa: number): Promise<CouponEval> {
  const db = ctx.db<typeof schema>();
  const fail = (message: string): CouponEval => ({ valid: false, discount_paisa: 0, free_shipping: false, message });
  const normalized = code.trim().toUpperCase();
  if (!normalized) return fail("Please enter a coupon code.");
  const coupon = (await db.select().from(schema.coupons).where(eq(schema.coupons.code, normalized)).limit(1))[0];
  if (!coupon) return fail(`The code "${normalized}" is not a valid coupon.`);
  if (!coupon.isActive) return fail("This coupon is no longer active.");
  if (coupon.expiresAt && coupon.expiresAt.getTime() < Date.now()) return fail("This coupon has expired.");
  if (coupon.maxUses != null) {
    const uses = await db.select({ id: schema.couponUsages.id }).from(schema.couponUsages).where(eq(schema.couponUsages.couponId, coupon.id));
    if (uses.length >= coupon.maxUses) return fail("This coupon has reached its usage limit.");
  }
  if (userId && coupon.perUserLimit > 0) {
    const mine = await db.select({ id: schema.couponUsages.id }).from(schema.couponUsages).where(and(eq(schema.couponUsages.couponId, coupon.id), eq(schema.couponUsages.userId, userId)));
    if (mine.length >= coupon.perUserLimit) return fail("You have already used this coupon.");
  }
  if (subtotalPaisa < coupon.minOrderPaisa) return fail(`This coupon needs a minimum order of ${formatRs(coupon.minOrderPaisa)}.`);
  const freeShipping = coupon.kind === "free_shipping";
  const discount = coupon.kind === "percent" ? Math.round(subtotalPaisa * coupon.value / 100) : coupon.kind === "fixed" ? Math.min(coupon.value, subtotalPaisa) : 0;
  return { valid: true, discount_paisa: discount, free_shipping: freeShipping, message: freeShipping ? "Free delivery applied." : `${formatRs(discount)} off applied.`, coupon_id: coupon.id, code: normalized };
}

function dayKey(d: Date) {
  return d.toISOString().slice(0, 10);
}

interface CartLine { product_id: number; quantity: number; product: PublicProduct }

// Server-side cart. Lines whose product went inactive (or whose seller was
// deactivated) are dropped from the response and cleaned up.
async function loadCart(ctx: Ctx, userId: string | null): Promise<{ items: CartLine[]; subtotal_paisa: number }> {
  if (!userId) return { items: [], subtotal_paisa: 0 };
  const db = ctx.db<typeof schema>();
  const cart = (await db.select().from(schema.carts).where(eq(schema.carts.userId, userId)).limit(1))[0];
  if (!cart) return { items: [], subtotal_paisa: 0 };
  const rows = await db.select().from(schema.cartItems).where(eq(schema.cartItems.cartId, cart.id));
  if (!rows.length) return { items: [], subtotal_paisa: 0 };
  const byId = new Map(publicOnly(await productRows(ctx), await activeStoreIds(ctx)).map((p) => [p.id, p]));
  const stale: number[] = [];
  const items: CartLine[] = [];
  let subtotal = 0;
  for (const row of rows) {
    const product = byId.get(row.productId);
    if (!product) {
      stale.push(row.id);
      continue;
    }
    items.push({ product_id: row.productId, quantity: row.quantity, product });
    subtotal += product.price_paisa * row.quantity;
  }
  if (stale.length) await db.delete(schema.cartItems).where(inArray(schema.cartItems.id, stale));
  return { items, subtotal_paisa: subtotal };
}

// Units sold per product across non-cancelled orders (optionally only orders
// placed after `sinceMs`), used for popularity/trending rankings.
async function popularityCounts(ctx: Ctx, sinceMs?: number): Promise<Map<number, number>> {
  const db = ctx.db<typeof schema>();
  const [orders, items] = await Promise.all([
    sinceMs != null
      ? db.select({ id: schema.orders.id, status: schema.orders.status }).from(schema.orders).where(gte(schema.orders.createdAt, new Date(sinceMs)))
      : db.select({ id: schema.orders.id, status: schema.orders.status }).from(schema.orders),
    db.select({ orderId: schema.orderItems.orderId, productId: schema.orderItems.productId, quantity: schema.orderItems.quantity }).from(schema.orderItems),
  ]);
  const valid = new Set(orders.filter((o) => o.status !== "cancelled").map((o) => o.id));
  const counts = new Map<number, number>();
  for (const i of items) {
    if (valid.has(i.orderId)) counts.set(i.productId, (counts.get(i.productId) ?? 0) + i.quantity);
  }
  return counts;
}

// Personalized picks: categories the buyer has shown interest in (wishlist,
// recent views, past orders), filled up with trending products.
async function recommendedFor(ctx: Ctx, userId: string, pubs: PublicProduct[], trending: PublicProduct[]): Promise<PublicProduct[]> {
  const db = ctx.db<typeof schema>();
  const wlRows = await db.select({ productId: schema.wishlistItems.productId }).from(schema.wishlistItems)
    .innerJoin(schema.wishlists, eq(schema.wishlistItems.wishlistId, schema.wishlists.id))
    .where(eq(schema.wishlists.userId, userId));
  const rvRows = await db.select({ productId: schema.recentlyViewed.productId }).from(schema.recentlyViewed).where(eq(schema.recentlyViewed.userId, userId));
  const userOrders = await db.select({ id: schema.orders.id }).from(schema.orders).where(eq(schema.orders.userId, userId));
  const orderItemRows = userOrders.length
    ? await db.select({ productId: schema.orderItems.productId }).from(schema.orderItems).where(inArray(schema.orderItems.orderId, userOrders.map((o) => o.id)))
    : [];
  const byId = new Map(pubs.map((p) => [p.id, p]));
  const catCount = new Map<string, number>();
  for (const r of [...wlRows, ...rvRows, ...orderItemRows]) {
    const p = byId.get(r.productId);
    if (p) catCount.set(p.category, (catCount.get(p.category) ?? 0) + 1);
  }
  const topCats = [...catCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([c]) => c);
  const seen = new Set<number>();
  const rec: PublicProduct[] = [];
  for (const c of topCats) {
    for (const p of pubs.filter((p) => p.category === c).sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))) {
      if (rec.length >= 8) break;
      if (!seen.has(p.id)) {
        seen.add(p.id);
        rec.push(p);
      }
    }
  }
  for (const p of trending) {
    if (rec.length >= 8) break;
    if (!seen.has(p.id)) {
      seen.add(p.id);
      rec.push(p);
    }
  }
  return rec;
}

export const Actions = {
  // ---------- public storefront ----------
  getStorefront: defineAction({
    request: z.object({}), response: z.object({ seller_count: z.number(), products: z.array(productShape) }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const stores = await db.select({ id: schema.storeSettings.id, status: schema.storeSettings.status }).from(schema.storeSettings);
      const activeIds = new Set(stores.filter((s) => s.status === "active").map((s) => s.id));
      const products = (await productRows(ctx)).filter((p) => p.is_active && activeIds.has(p.store_id));
      return { seller_count: activeIds.size, products };
    },
  }),

  // ---------- buyer accounts ----------
  signup: defineAction({
    request: z.object({ name: z.string().trim().min(2).max(80), phone: z.string().trim().min(7).max(20), email: emailField.optional(), password: passwordField }),
    response: z.object({ token: z.string(), user: userShape }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const phone = args.phone.trim();
      const email = args.email?.trim() ? args.email.trim().toLowerCase() : null;
      if ((await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.phone, phone)).limit(1)).length) throw new Error("That mobile number already has an account. Please log in.");
      if (email && (await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email)).limit(1)).length) throw new Error("That email is already registered. Please log in.");
      const id = crypto.randomUUID();
      await db.insert(schema.users).values({ id, name: args.name.trim(), phone, email, passwordHash: await Bun.password.hash(args.password, { algorithm: "bcrypt", cost: 10 }) });
      const token = await createSession(ctx, "buyer", id);
      ctx.invalidateQueries();
      return { token, user: { id, name: args.name.trim(), phone, email } };
    },
  }),
  login: defineAction({
    request: z.object({ phone: z.string().trim().min(7).max(20), password: z.string().min(1).max(120) }),
    response: z.object({ token: z.string(), user: userShape }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const user = (await db.select().from(schema.users).where(eq(schema.users.phone, args.phone.trim())).limit(1))[0];
      if (!user || !await Bun.password.verify(args.password, user.passwordHash)) throw new Error("Mobile number or password is incorrect.");
      const token = await createSession(ctx, "buyer", user.id);
      return { token, user: { id: user.id, name: user.name, phone: user.phone, email: user.email } };
    },
  }),
  getMe: defineAction({
    request: z.object({ authToken: authTokenField }), response: z.object({ user: userShape }),
    async handler(ctx, args) {
      const auth = await requireAuth(ctx, args.authToken, "buyer");
      const db = ctx.db<typeof schema>();
      const user = (await db.select().from(schema.users).where(eq(schema.users.id, auth.id)).limit(1))[0];
      if (!user) throw new Error("Account not found.");
      return { user: { id: user.id, name: user.name, phone: user.phone, email: user.email } };
    },
  }),
  logout: defineAction({
    request: z.object({ authToken: authTokenField }), response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      if (args.authToken) {
        const db = ctx.db<typeof schema>();
        await db.delete(schema.sessions).where(eq(schema.sessions.token, args.authToken));
      }
      return { ok: true };
    },
  }),
  getMyOrders: defineAction({
    request: z.object({ authToken: authTokenField }), response: z.object({ orders: z.array(orderShape) }),
    async handler(ctx, args) {
      const auth = await requireAuth(ctx, args.authToken, "buyer");
      const db = ctx.db<typeof schema>();
      const orders = await db.select().from(schema.orders).where(eq(schema.orders.userId, auth.id)).orderBy(desc(schema.orders.createdAt)).limit(100);
      const items = orders.length ? await db.select().from(schema.orderItems).where(inArray(schema.orderItems.orderId, orders.map((o) => o.id))) : [];
      return { orders: orders.map((o) => mapOrder(o, items)) };
    },
  }),

  // ---------- sellers ----------
  registerSeller: defineAction({
    request: z.object({ store_name: z.string().trim().min(2).max(60), tagline: z.string().trim().min(3).max(120), location: z.string().trim().min(2).max(80), phone: z.string().trim().min(7).max(20), email: emailField, password: passwordField, seller_key: keyField }),
    response: z.object({ seller_code: z.string() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const email = args.email.trim().toLowerCase();
      if ((await db.select({ id: schema.storeSettings.id }).from(schema.storeSettings).where(eq(schema.storeSettings.email, email)).limit(1)).length) throw new Error("That email is already registered as a seller.");
      const code = `SELL-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
      await db.insert(schema.storeSettings).values({ sellerCode: code, storeName: args.store_name.trim(), tagline: args.tagline.trim(), location: args.location.trim(), phone: args.phone.trim(), email, passwordHash: await Bun.password.hash(args.password, { algorithm: "bcrypt", cost: 10 }), adminKeyHash: await hashKey(args.seller_key), status: "pending", createdAt: new Date(), updatedAt: new Date() });
      ctx.invalidateQueries();
      return { seller_code: code };
    },
  }),
  sellerLogin: defineAction({
    request: z.object({ email: emailField, password: z.string().min(1).max(120) }),
    response: z.object({ token: z.string(), seller: z.object({ seller_code: z.string(), store_name: z.string(), status: sellerStatus }) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const store = (await db.select().from(schema.storeSettings).where(eq(schema.storeSettings.email, args.email.trim().toLowerCase())).limit(1))[0];
      if (!store?.passwordHash || !await Bun.password.verify(args.password, store.passwordHash)) throw new Error("Email or password is incorrect.");
      if (store.status === "suspended") throw new Error("This seller account is suspended. Please contact support.");
      const token = await createSession(ctx, "seller", String(store.id));
      return { token, seller: { seller_code: store.sellerCode, store_name: store.storeName, status: store.status } };
    },
  }),
  sellerInventory: defineAction({
    request: z.object({ ...sellerAuthFields }), response: z.object({ store: z.object({ store_name: z.string(), tagline: z.string(), location: z.string(), phone: z.string(), status: sellerStatus }), products: z.array(productShape) }),
    async handler(ctx, args) {
      const store = await resolveSeller(ctx, args);
      return { store: { store_name: store.storeName, tagline: store.tagline, location: store.location, phone: store.phone, status: store.status }, products: await productRows(ctx, store.id) };
    },
  }),
  saveStore: defineAction({
    request: z.object({ ...sellerAuthFields, store_name: z.string().trim().min(2).max(60), tagline: z.string().trim().min(3).max(120), location: z.string().trim().min(2).max(80), phone: z.string().trim().min(7).max(20) }), response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const store = await resolveSeller(ctx, args);
      const db = ctx.db<typeof schema>();
      await db.update(schema.storeSettings).set({ storeName: args.store_name, tagline: args.tagline, location: args.location, phone: args.phone, updatedAt: new Date() }).where(eq(schema.storeSettings.id, store.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),
  createProduct: defineAction({
    request: z.object({ ...sellerAuthFields, name: z.string().trim().min(2).max(80), category: z.string().trim().min(2).max(40), description: z.string().trim().min(8).max(500), price_paisa: z.number().int().positive(), delivery_fee_paisa: z.number().int().min(0), stock: z.number().int().min(0).max(100000), brand: z.string().trim().max(40).optional(), original_price_paisa: z.number().int().positive().optional(), image_url: imageUrlField.optional(), low_stock_threshold: z.number().int().min(0).max(1000).optional() }), response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const store = await resolveSeller(ctx, args);
      if (args.original_price_paisa != null && args.original_price_paisa <= args.price_paisa) throw new Error("The original price must be higher than the selling price.");
      const db = ctx.db<typeof schema>();
      const result = await db.insert(schema.products).values({ storeId: store.id, name: args.name, category: args.category, description: args.description, pricePaisa: args.price_paisa, deliveryFeePaisa: args.delivery_fee_paisa, stock: args.stock, brand: args.brand?.trim() || null, originalPricePaisa: args.original_price_paisa ?? null, imageUrl: args.image_url ?? null, lowStockThreshold: args.low_stock_threshold ?? 5, updatedAt: new Date() }).returning({ id: schema.products.id });
      const row = result[0];
      if (!row) throw new Error("The product could not be saved.");
      ctx.invalidateQueries();
      return { id: row.id };
    },
  }),
  updateProduct: defineAction({
    request: z.object({ ...sellerAuthFields, id: z.number().int().positive(), name: z.string().trim().min(2).max(80), category: z.string().trim().min(2).max(40), description: z.string().trim().min(8).max(500), price_paisa: z.number().int().positive(), delivery_fee_paisa: z.number().int().min(0), stock: z.number().int().min(0).max(100000), is_active: z.boolean(), image_url: imageUrlField.nullish() }), response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const store = await resolveSeller(ctx, args);
      const db = ctx.db<typeof schema>();
      const before = (await db.select().from(schema.products).where(and(eq(schema.products.id, args.id), eq(schema.products.storeId, store.id))).limit(1))[0];
      if (!before) throw new Error("Product not found.");
      await db.update(schema.products).set({ name: args.name, category: args.category, description: args.description, pricePaisa: args.price_paisa, deliveryFeePaisa: args.delivery_fee_paisa, stock: args.stock, isActive: args.is_active, imageUrl: args.image_url ?? before.imageUrl, updatedAt: new Date() }).where(and(eq(schema.products.id, args.id), eq(schema.products.storeId, store.id)));
      // Wishlist alerts: price drops and back-in-stock restocks.
      const priceLowered = args.price_paisa < before.pricePaisa;
      const backInStock = before.stock <= 0 && args.stock > 0;
      if (priceLowered || backInStock) {
        const items = await db.select().from(schema.wishlistItems).where(eq(schema.wishlistItems.productId, args.id));
        if (items.length) {
          const wls = await db.select().from(schema.wishlists).where(inArray(schema.wishlists.id, [...new Set(items.map((i) => i.wishlistId))]));
          const userIds = [...new Set(wls.map((w) => w.userId))];
          for (const uid of userIds) {
            if (priceLowered) await notifyUser(ctx, uid, { type: "price_drop", title: `Price drop: ${args.name}`, body: `${args.name} is now ${formatRs(args.price_paisa)} (was ${formatRs(before.pricePaisa)}).`, link: `#/product/${args.id}` });
            if (backInStock) await notifyUser(ctx, uid, { type: "back_in_stock", title: `Back in stock: ${args.name}`, body: `${args.name} is available again — order before it sells out.`, link: `#/product/${args.id}` });
          }
        }
      }
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  // ---------- orders ----------
  placeOrder: defineAction({
    request: z.object({ authToken: authTokenField, customer_name: z.string().trim().min(2).max(80), phone: z.string().trim().min(7).max(20), address: z.string().trim().min(5).max(240), note: z.string().trim().max(400).default(""), cod_confirmed: z.literal(true).optional(), payment_method: paymentMethodEnum.default("cod"), coupon_code: z.string().trim().max(40).optional(), address_id: z.number().int().positive().optional(), delivery_method: deliveryMethodEnum.default("standard"), items: z.array(z.object({ product_id: z.number().int().positive(), quantity: z.number().int().min(1).max(20) })).min(1).max(30) }), response: z.object({ order_code: z.string(), total_paisa: z.number(), status: z.literal("confirmation_needed"), payment_method: paymentMethodEnum, payment_status: z.literal("pending"), order_id: z.number() }),
    async handler(ctx, args): Promise<{ order_code: string; total_paisa: number; status: "confirmation_needed"; payment_method: "cod" | "esewa" | "khalti"; payment_status: "pending"; order_id: number }> {
      if (args.payment_method === "cod" && args.cod_confirmed !== true) throw new Error("Please confirm Cash on Delivery to place the order.");
      const db = fullDb(ctx);
      // A signed-in buyer gets the order linked to their account. Other
      // session types (or no token) check out as a guest, unchanged.
      const userId = await buyerIdOf(ctx, args.authToken);
      if (args.address_id && userId) {
        const addr = (await db.select({ id: schema.addresses.id }).from(schema.addresses).where(and(eq(schema.addresses.id, args.address_id), eq(schema.addresses.userId, userId))).limit(1))[0];
        if (!addr) throw new Error("That delivery address was not found.");
      }
      const ids = [...new Set(args.items.map((i) => i.product_id))];
      const actives = await activeStoreIds(ctx);
      // Fast pre-check for friendly errors; the authoritative stock check
      // happens again inside the transaction below.
      const preview = await db.select().from(schema.products).where(inArray(schema.products.id, ids));
      let subtotal = 0, deliveryStandard = 0;
      let previewStoreId: number | null = null;
      for (const item of args.items) {
        const product = preview.find((p) => p.id === item.product_id);
        if (!product || !product.isActive || !actives.has(product.storeId)) throw new Error("One of these products is no longer available.");
        if (previewStoreId == null) previewStoreId = product.storeId;
        else if (product.storeId !== previewStoreId) throw new Error("Please place a separate order for each seller.");
        if (product.stock < item.quantity) throw new Error(`${product.name} has only ${product.stock} left.`);
        subtotal += product.pricePaisa * item.quantity;
        deliveryStandard += product.deliveryFeePaisa * item.quantity;
      }
      let couponId: number | null = null, couponCode: string | null = null, discount = 0, freeShipping = false;
      if (args.coupon_code) {
        const evald = await evaluateCoupon(ctx, args.coupon_code, userId, subtotal);
        if (!evald.valid) throw new Error(evald.message);
        couponId = evald.coupon_id ?? null;
        couponCode = evald.code ?? null;
        discount = evald.discount_paisa;
        freeShipping = evald.free_shipping;
      }
      // Discount applies to the subtotal; delivery is computed after.
      let delivery = args.delivery_method === "pickup" ? 0 : deliveryStandard + (args.delivery_method === "express" ? 12000 : 0);
      if (freeShipping) delivery = 0;
      const total = Math.max(0, subtotal - discount) + delivery;
      const orderCode = `NP-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`;
      const now = new Date();
      // Everything below runs in ONE transaction: products are re-read and
      // stock re-checked inside it, so overselling is impossible.
      const orderId = db.transaction((tx) => {
        const rows = tx.select().from(schema.products).where(inArray(schema.products.id, ids)).prepare().all();
        const normalized = args.items.map((item) => {
          const product = rows.find((p) => p.id === item.product_id);
          if (!product || !product.isActive || !actives.has(product.storeId)) throw new Error("One of these products is no longer available.");
          if (product.stock < item.quantity) throw new Error(`${product.name} has only ${product.stock} left.`);
          return { product, quantity: item.quantity };
        });
        const first = normalized[0];
        if (!first) throw new Error("The order could not be created.");
        if (normalized.some((x) => x.product.storeId !== first.product.storeId)) throw new Error("Please place a separate order for each seller.");
        const inserted = tx.insert(schema.orders).values({
          storeId: first.product.storeId, userId, orderCode, customerName: args.customer_name, phone: args.phone,
          address: args.address, note: args.note, subtotalPaisa: subtotal, deliveryFeePaisa: delivery,
          totalPaisa: total, paymentMethod: args.payment_method, paymentStatus: "pending",
          discountPaisa: discount, couponCode, deliveryMethod: args.delivery_method,
          addressId: args.address_id ?? null, status: "confirmation_needed", createdAt: now, updatedAt: now,
        }).returning({ id: schema.orders.id }).prepare().all();
        const orderRow = inserted[0];
        if (!orderRow) throw new Error("The order could not be created.");
        tx.insert(schema.orderItems).values(normalized.map(({ product, quantity }) => ({ orderId: orderRow.id, productId: product.id, productName: product.name, quantity, unitPricePaisa: product.pricePaisa }))).prepare().run();
        for (const { product, quantity } of normalized) {
          tx.update(schema.products).set({ stock: product.stock - quantity, updatedAt: now }).where(eq(schema.products.id, product.id)).prepare().run();
        }
        tx.insert(schema.payments).values({ orderId: orderRow.id, provider: args.payment_method, amountPaisa: total, status: "pending", createdAt: now, updatedAt: now }).prepare().run();
        if (couponId != null) {
          tx.insert(schema.couponUsages).values({ couponId, userId, orderId: orderRow.id, usedAt: now }).prepare().run();
        }
        if (userId) {
          const cart = tx.select().from(schema.carts).where(eq(schema.carts.userId, userId)).limit(1).prepare().get();
          if (cart) tx.delete(schema.cartItems).where(eq(schema.cartItems.cartId, cart.id)).prepare().run();
          tx.insert(schema.notifications).values({ userId, type: "order_placed", title: `Order ${orderCode} placed`, body: `Thanks ${args.customer_name}! Your order of ${formatRs(total)} is awaiting confirmation.`, link: "#/orders", createdAt: now }).prepare().run();
        }
        return orderRow.id;
      });
      ctx.invalidateQueries();
      return { order_code: orderCode, total_paisa: total, status: "confirmation_needed", payment_method: args.payment_method, payment_status: "pending", order_id: orderId };
    },
  }),
  listOrders: defineAction({
    request: z.object({ ...sellerAuthFields, limit: z.number().int().positive().max(100).default(50) }), response: z.object({ orders: z.array(orderShape) }),
    async handler(ctx, args) {
      const store = await resolveSeller(ctx, args);
      const db = ctx.db<typeof schema>();
      const orders = await db.select().from(schema.orders).where(eq(schema.orders.storeId, store.id)).orderBy(desc(schema.orders.createdAt)).limit(args.limit);
      const items = orders.length ? await db.select().from(schema.orderItems).where(inArray(schema.orderItems.orderId, orders.map((o) => o.id))) : [];
      return { orders: orders.map((o) => mapOrder(o, items)) };
    },
  }),
  trackOrder: defineAction({
    request: z.object({ order_code: z.string().trim().min(4), phone: z.string().trim().min(7) }), response: z.object({ order: orderShape.nullable() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const order = (await db.select().from(schema.orders).where(and(eq(schema.orders.orderCode, args.order_code.toUpperCase()), eq(schema.orders.phone, args.phone))).limit(1))[0];
      if (!order) return { order: null };
      const items = await db.select().from(schema.orderItems).where(eq(schema.orderItems.orderId, order.id));
      return { order: mapOrder(order, items) };
    },
  }),
  updateOrderStatus: defineAction({
    request: z.object({ ...sellerAuthFields, order_id: z.number().int().positive(), status: orderStatus }), response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const store = await resolveSeller(ctx, args);
      const db = ctx.db<typeof schema>();
      const order = (await db.select().from(schema.orders).where(and(eq(schema.orders.id, args.order_id), eq(schema.orders.storeId, store.id))).limit(1))[0];
      if (!order) throw new Error("Order not found.");
      if (order.status === args.status) return { ok: true };
      const allowed: Partial<Record<typeof order.status, typeof order.status[]>> = { confirmation_needed: ["confirmed", "cancelled"], confirmed: ["packed", "cancelled"], packed: ["shipped"], shipped: ["out_for_delivery", "delivered"], out_for_delivery: ["delivered"], delivered: ["return_requested"], return_requested: ["returned", "delivered"], returned: ["refunded"] };
      if (!allowed[order.status]?.includes(args.status)) throw new Error("That order status change is not allowed.");
      if (args.status === "cancelled") {
        const items = await db.select().from(schema.orderItems).where(eq(schema.orderItems.orderId, order.id));
        for (const item of items) {
          const product = (await db.select().from(schema.products).where(and(eq(schema.products.id, item.productId), eq(schema.products.storeId, store.id))).limit(1))[0];
          if (product) await db.update(schema.products).set({ stock: product.stock + item.quantity, updatedAt: new Date() }).where(eq(schema.products.id, product.id));
        }
      }
      await db.update(schema.orders).set({ status: args.status, updatedAt: new Date() }).where(eq(schema.orders.id, order.id));
      // Keep the payment row in sync: COD is paid on delivery, unsettled
      // payments are cancelled with the order, refunds mark it refunded.
      const payment = (await db.select().from(schema.payments).where(eq(schema.payments.orderId, order.id)).limit(1))[0];
      if (payment) {
        let next = payment.status;
        if (args.status === "delivered" && payment.provider === "cod" && payment.status === "pending") next = "paid";
        else if (args.status === "cancelled" && (payment.status === "pending" || payment.status === "processing" || payment.status === "failed")) next = "cancelled";
        else if (args.status === "refunded") next = "refunded";
        if (next !== payment.status) {
          await db.update(schema.payments).set({ status: next, updatedAt: new Date() }).where(eq(schema.payments.id, payment.id));
          await db.update(schema.orders).set({ paymentStatus: next === "paid" ? "paid" : next === "refunded" ? "refunded" : next === "cancelled" ? "cancelled" : order.paymentStatus, updatedAt: new Date() }).where(eq(schema.orders.id, order.id));
        }
      }
      if (order.userId) {
        await notifyUser(ctx, order.userId, { type: "order_status", title: `Order ${order.orderCode}: ${orderStatusLabel(args.status)}`, body: `Your order ${order.orderCode} is now ${orderStatusLabel(args.status)}.`, link: "#/orders" });
      }
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  // ---------- reviews & issues ----------
  getProductReviews: defineAction({
    request: z.object({ product_id: z.number().int().positive() }), response: z.object({ reviews: z.array(z.object({ id: z.number(), reviewer_name: z.string(), rating: z.number(), body: z.string(), created_at: z.string() })) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.reviews).where(eq(schema.reviews.productId, args.product_id)).orderBy(desc(schema.reviews.createdAt));
      return { reviews: rows.map((r) => ({ id: r.id, reviewer_name: r.reviewerName, rating: r.rating, body: r.body, created_at: r.createdAt.toISOString() })) };
    },
  }),
  addReview: defineAction({
    request: z.object({ order_code: z.string().trim().min(4), phone: z.string().trim().min(7), product_id: z.number().int().positive(), rating: z.number().int().min(1).max(5), body: z.string().trim().min(3).max(500) }), response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      const order = (await db.select().from(schema.orders).where(and(eq(schema.orders.orderCode, args.order_code.toUpperCase()), eq(schema.orders.phone, args.phone), eq(schema.orders.status, "delivered"))).limit(1))[0];
      if (!order) throw new Error("Only delivered orders can leave a verified review.");
      const item = (await db.select().from(schema.orderItems).where(and(eq(schema.orderItems.orderId, order.id), eq(schema.orderItems.productId, args.product_id))).limit(1))[0];
      if (!item) throw new Error("That product was not part of this order.");
      await db.insert(schema.reviews).values({ orderId: order.id, productId: args.product_id, reviewerName: order.customerName, rating: args.rating, body: args.body });
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),
  reportIssue: defineAction({
    request: z.object({ order_code: z.string().trim().min(4), phone: z.string().trim().min(7), kind: z.string().trim().min(2).max(60), detail: z.string().trim().min(8).max(700) }), response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      const order = (await db.select().from(schema.orders).where(and(eq(schema.orders.orderCode, args.order_code.toUpperCase()), eq(schema.orders.phone, args.phone))).limit(1))[0];
      if (!order) throw new Error("We could not match that order and phone number.");
      await db.insert(schema.buyerIssues).values({ orderId: order.id, kind: args.kind, detail: args.detail, updatedAt: new Date() });
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),
  listIssues: defineAction({
    request: z.object({ ...sellerAuthFields }), response: z.object({ issues: z.array(z.object({ id: z.number(), order_code: z.string(), kind: z.string(), detail: z.string(), status: z.enum(["open", "resolved"]), created_at: z.string() })) }),
    async handler(ctx, args) {
      const store = await resolveSeller(ctx, args);
      const db = ctx.db<typeof schema>();
      const orders = await db.select({ id: schema.orders.id, code: schema.orders.orderCode }).from(schema.orders).where(eq(schema.orders.storeId, store.id));
      const orderIds = orders.map((o) => o.id);
      if (!orderIds.length) return { issues: [] };
      const issues = await db.select().from(schema.buyerIssues).where(inArray(schema.buyerIssues.orderId, orderIds)).orderBy(desc(schema.buyerIssues.createdAt));
      return { issues: issues.map((i) => ({ id: i.id, order_code: orders.find((o) => o.id === i.orderId)?.code ?? "Unknown", kind: i.kind, detail: i.detail, status: i.status, created_at: i.createdAt.toISOString() })) };
    },
  }),
  resolveIssue: defineAction({
    request: z.object({ ...sellerAuthFields, issue_id: z.number().int().positive() }), response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const store = await resolveSeller(ctx, args);
      const db = ctx.db<typeof schema>();
      const issue = (await db.select().from(schema.buyerIssues).where(eq(schema.buyerIssues.id, args.issue_id)).limit(1))[0];
      if (!issue) throw new Error("Issue not found.");
      const order = (await db.select({ storeId: schema.orders.storeId }).from(schema.orders).where(eq(schema.orders.id, issue.orderId)).limit(1))[0];
      if (order?.storeId !== store.id) throw new Error("Issue not found.");
      await db.update(schema.buyerIssues).set({ status: "resolved", updatedAt: new Date() }).where(eq(schema.buyerIssues.id, args.issue_id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),
  deleteSeller: defineAction({
    request: z.object({ ...sellerAuthFields, confirmation: z.string() }), response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const store = await resolveSeller(ctx, args);
      if (args.confirmation !== store.storeName) throw new Error("Store name confirmation did not match.");
      const db = ctx.db<typeof schema>();
      await db.delete(schema.sessions).where(and(eq(schema.sessions.userType, "seller"), eq(schema.sessions.userId, String(store.id))));
      const storeOrders = await db.select({ id: schema.orders.id }).from(schema.orders).where(eq(schema.orders.storeId, store.id));
      const orderIds = storeOrders.map((o) => o.id);
      const storeProducts = await db.select({ id: schema.products.id }).from(schema.products).where(eq(schema.products.storeId, store.id));
      const productIds = storeProducts.map((p) => p.id);
      if (orderIds.length) {
        await db.delete(schema.couponUsages).where(inArray(schema.couponUsages.orderId, orderIds));
        await db.delete(schema.buyerIssues).where(inArray(schema.buyerIssues.orderId, orderIds));
        await db.delete(schema.reviews).where(inArray(schema.reviews.orderId, orderIds));
        await db.delete(schema.orderItems).where(inArray(schema.orderItems.orderId, orderIds));
        await db.delete(schema.orders).where(inArray(schema.orders.id, orderIds));
      }
      if (productIds.length) {
        await db.delete(schema.reviews).where(inArray(schema.reviews.productId, productIds));
        await db.delete(schema.cartItems).where(inArray(schema.cartItems.productId, productIds));
        await db.delete(schema.wishlistItems).where(inArray(schema.wishlistItems.productId, productIds));
        await db.delete(schema.productViews).where(inArray(schema.productViews.productId, productIds));
        await db.delete(schema.recentlyViewed).where(inArray(schema.recentlyViewed.productId, productIds));
        await db.delete(schema.products).where(inArray(schema.products.id, productIds));
      }
      await db.delete(schema.storeSettings).where(eq(schema.storeSettings.id, store.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  // ---------- admin ----------
  adminLogin: defineAction({
    request: z.object({ email: emailField, password: z.string().min(1).max(120) }),
    response: z.object({ token: z.string(), admin: z.object({ name: z.string(), email: z.string() }) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const admin = (await db.select().from(schema.admins).where(eq(schema.admins.email, args.email.trim().toLowerCase())).limit(1))[0];
      if (!admin || !await Bun.password.verify(args.password, admin.passwordHash)) throw new Error("Email or password is incorrect.");
      const token = await createSession(ctx, "admin", admin.id);
      return { token, admin: { name: admin.name, email: admin.email } };
    },
  }),
  adminStats: defineAction({
    request: z.object({ authToken: authTokenField }),
    response: z.object({ sellers: z.number(), products: z.number(), orders: z.number(), users: z.number(), revenue_paisa: z.number(), pending_sellers: z.number(), open_issues: z.number() }),
    async handler(ctx, args) {
      await requireAuth(ctx, args.authToken, "admin");
      const db = ctx.db<typeof schema>();
      const [sellers, products, orders, users, issues] = await Promise.all([
        db.select({ id: schema.storeSettings.id, status: schema.storeSettings.status }).from(schema.storeSettings),
        db.select({ id: schema.products.id }).from(schema.products),
        db.select({ total: schema.orders.totalPaisa, status: schema.orders.status }).from(schema.orders),
        db.select({ id: schema.users.id }).from(schema.users),
        db.select({ id: schema.buyerIssues.id }).from(schema.buyerIssues).where(eq(schema.buyerIssues.status, "open")),
      ]);
      return {
        sellers: sellers.length,
        products: products.length,
        orders: orders.length,
        users: users.length,
        revenue_paisa: orders.filter((o) => o.status !== "cancelled").reduce((n, o) => n + o.total, 0),
        pending_sellers: sellers.filter((s) => s.status === "pending").length,
        open_issues: issues.length,
      };
    },
  }),
  adminListSellers: defineAction({
    request: z.object({ authToken: authTokenField }),
    response: z.object({ sellers: z.array(z.object({ id: z.number(), seller_code: z.string(), store_name: z.string(), location: z.string(), phone: z.string(), email: z.string().nullable(), status: sellerStatus, product_count: z.number(), order_count: z.number(), created_at: z.string() })) }),
    async handler(ctx, args) {
      await requireAuth(ctx, args.authToken, "admin");
      const db = ctx.db<typeof schema>();
      const [sellers, products, orders] = await Promise.all([
        db.select().from(schema.storeSettings).orderBy(desc(schema.storeSettings.createdAt)),
        db.select({ id: schema.products.id, storeId: schema.products.storeId }).from(schema.products),
        db.select({ id: schema.orders.id, storeId: schema.orders.storeId }).from(schema.orders),
      ]);
      return {
        sellers: sellers.map((s) => ({
          id: s.id, seller_code: s.sellerCode, store_name: s.storeName, location: s.location, phone: s.phone, email: s.email, status: s.status,
          product_count: products.filter((p) => p.storeId === s.id).length,
          order_count: orders.filter((o) => o.storeId === s.id).length,
          created_at: s.createdAt.toISOString(),
        })),
      };
    },
  }),
  adminSetSellerStatus: defineAction({
    request: z.object({ authToken: authTokenField, seller_id: z.number().int().positive(), status: sellerStatus }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      await requireAuth(ctx, args.authToken, "admin");
      const db = ctx.db<typeof schema>();
      const store = (await db.select({ id: schema.storeSettings.id }).from(schema.storeSettings).where(eq(schema.storeSettings.id, args.seller_id)).limit(1))[0];
      if (!store) throw new Error("Seller not found.");
      await db.update(schema.storeSettings).set({ status: args.status, updatedAt: new Date() }).where(eq(schema.storeSettings.id, args.seller_id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),
  adminListProducts: defineAction({
    request: z.object({ authToken: authTokenField, seller_id: z.number().int().positive().optional() }),
    response: z.object({ products: z.array(z.object({ id: z.number(), name: z.string(), category: z.string(), price_paisa: z.number(), stock: z.number(), is_active: z.boolean(), store_name: z.string(), seller_code: z.string(), seller_status: sellerStatus })) }),
    async handler(ctx, args) {
      await requireAuth(ctx, args.authToken, "admin");
      const db = ctx.db<typeof schema>();
      const stores = await db.select().from(schema.storeSettings);
      const products = args.seller_id
        ? await db.select().from(schema.products).where(eq(schema.products.storeId, args.seller_id)).orderBy(desc(schema.products.createdAt))
        : await db.select().from(schema.products).orderBy(desc(schema.products.createdAt)).limit(200);
      return {
        products: products.map((p) => {
          const store = stores.find((s) => s.id === p.storeId);
          return { id: p.id, name: p.name, category: p.category, price_paisa: p.pricePaisa, stock: p.stock, is_active: p.isActive, store_name: store?.storeName ?? "Seller", seller_code: store?.sellerCode ?? "", seller_status: store?.status ?? "active" };
        }),
      };
    },
  }),
  adminSetProductActive: defineAction({
    request: z.object({ authToken: authTokenField, product_id: z.number().int().positive(), active: z.boolean() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      await requireAuth(ctx, args.authToken, "admin");
      const db = ctx.db<typeof schema>();
      const product = (await db.select({ id: schema.products.id }).from(schema.products).where(eq(schema.products.id, args.product_id)).limit(1))[0];
      if (!product) throw new Error("Product not found.");
      await db.update(schema.products).set({ isActive: args.active, updatedAt: new Date() }).where(eq(schema.products.id, args.product_id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),
  adminListOrders: defineAction({
    request: z.object({ authToken: authTokenField, status: orderStatus.optional() }),
    response: z.object({ orders: z.array(orderShape.extend({ store_name: z.string() })) }),
    async handler(ctx, args) {
      await requireAuth(ctx, args.authToken, "admin");
      const db = ctx.db<typeof schema>();
      const [orders, items, stores] = await Promise.all([
        args.status
          ? await db.select().from(schema.orders).where(eq(schema.orders.status, args.status)).orderBy(desc(schema.orders.createdAt)).limit(100)
          : await db.select().from(schema.orders).orderBy(desc(schema.orders.createdAt)).limit(100),
        db.select().from(schema.orderItems),
        db.select({ id: schema.storeSettings.id, name: schema.storeSettings.storeName }).from(schema.storeSettings),
      ]);
      return { orders: orders.map((o) => ({ ...mapOrder(o, items), store_name: stores.find((s) => s.id === o.storeId)?.name ?? "Seller" })) };
    },
  }),
  adminListIssues: defineAction({
    request: z.object({ authToken: authTokenField }),
    response: z.object({ issues: z.array(z.object({ id: z.number(), order_code: z.string(), store_name: z.string(), kind: z.string(), detail: z.string(), status: z.enum(["open", "resolved"]), created_at: z.string() })) }),
    async handler(ctx, args) {
      await requireAuth(ctx, args.authToken, "admin");
      const db = ctx.db<typeof schema>();
      const [issues, orders, stores] = await Promise.all([
        db.select().from(schema.buyerIssues).orderBy(desc(schema.buyerIssues.createdAt)).limit(200),
        db.select({ id: schema.orders.id, code: schema.orders.orderCode, storeId: schema.orders.storeId }).from(schema.orders),
        db.select({ id: schema.storeSettings.id, name: schema.storeSettings.storeName }).from(schema.storeSettings),
      ]);
      return {
        issues: issues.map((i) => {
          const order = orders.find((o) => o.id === i.orderId);
          return { id: i.id, order_code: order?.code ?? "Unknown", store_name: stores.find((s) => s.id === order?.storeId)?.name ?? "Seller", kind: i.kind, detail: i.detail, status: i.status, created_at: i.createdAt.toISOString() };
        }),
      };
    },
  }),
  adminResolveIssue: defineAction({
    request: z.object({ authToken: authTokenField, issue_id: z.number().int().positive() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      await requireAuth(ctx, args.authToken, "admin");
      const db = ctx.db<typeof schema>();
      const issue = (await db.select({ id: schema.buyerIssues.id }).from(schema.buyerIssues).where(eq(schema.buyerIssues.id, args.issue_id)).limit(1))[0];
      if (!issue) throw new Error("Issue not found.");
      await db.update(schema.buyerIssues).set({ status: "resolved", updatedAt: new Date() }).where(eq(schema.buyerIssues.id, args.issue_id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),
  adminListUsers: defineAction({
    request: z.object({ authToken: authTokenField }),
    response: z.object({ users: z.array(z.object({ id: z.string(), name: z.string(), phone: z.string(), email: z.string().nullable(), order_count: z.number(), created_at: z.string() })) }),
    async handler(ctx, args) {
      await requireAuth(ctx, args.authToken, "admin");
      const db = ctx.db<typeof schema>();
      const [users, orders] = await Promise.all([
        db.select().from(schema.users).orderBy(desc(schema.users.createdAt)).limit(200),
        db.select({ id: schema.orders.id, userId: schema.orders.userId }).from(schema.orders),
      ]);
      return {
        users: users.map((u) => ({ id: u.id, name: u.name, phone: u.phone, email: u.email, order_count: orders.filter((o) => o.userId === u.id).length, created_at: u.createdAt.toISOString() })),
      };
    },
  }),
  adminChangePassword: defineAction({
    request: z.object({ authToken: authTokenField, old_password: z.string().min(1).max(120), new_password: passwordField }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const auth = await requireAuth(ctx, args.authToken, "admin");
      const db = ctx.db<typeof schema>();
      const admin = (await db.select().from(schema.admins).where(eq(schema.admins.id, auth.id)).limit(1))[0];
      if (!admin || !await Bun.password.verify(args.old_password, admin.passwordHash)) throw new Error("The current password is incorrect.");
      await db.update(schema.admins).set({ passwordHash: await Bun.password.hash(args.new_password, { algorithm: "bcrypt", cost: 10 }) }).where(eq(schema.admins.id, admin.id));
      return { ok: true };
    },
  }),
  // ---------- phase 2: cart (buyer) ----------
  getCart: defineAction({
    request: z.object({ authToken: authTokenField }), response: z.object({ items: z.array(z.object({ product_id: z.number(), quantity: z.number(), product: productShape })), subtotal_paisa: z.number() }),
    async handler(ctx, args) {
      return loadCart(ctx, await buyerIdOf(ctx, args.authToken));
    },
  }),
  addToCart: defineAction({
    request: z.object({ authToken: authTokenRequired, product_id: z.number().int().positive(), quantity: z.number().int().min(1).max(20) }), response: z.object({ cart: z.object({ items: z.array(z.object({ product_id: z.number(), quantity: z.number(), product: productShape })), subtotal_paisa: z.number() }) }),
    async handler(ctx, args) {
      const auth = await requireAuth(ctx, args.authToken, "buyer");
      const db = ctx.db<typeof schema>();
      const product = (await db.select().from(schema.products).where(eq(schema.products.id, args.product_id)).limit(1))[0];
      if (!product) throw new Error("That product was not found.");
      if (!product.isActive || !((await activeStoreIds(ctx)).has(product.storeId))) throw new Error("That product is no longer available.");
      let cart = (await db.select().from(schema.carts).where(eq(schema.carts.userId, auth.id)).limit(1))[0];
      if (!cart) {
        await db.insert(schema.carts).values({ userId: auth.id, updatedAt: new Date() });
        const created = (await db.select().from(schema.carts).where(eq(schema.carts.userId, auth.id)).limit(1))[0];
        if (!created) throw new Error("Your cart could not be created.");
        cart = created;
      }
      const existing = (await db.select().from(schema.cartItems).where(and(eq(schema.cartItems.cartId, cart.id), eq(schema.cartItems.productId, args.product_id))).limit(1))[0];
      const newQty = (existing?.quantity ?? 0) + args.quantity;
      if (newQty > product.stock) throw new Error(`${product.name} has only ${product.stock} left in stock.`);
      if (existing) await db.update(schema.cartItems).set({ quantity: newQty }).where(eq(schema.cartItems.id, existing.id));
      else await db.insert(schema.cartItems).values({ cartId: cart.id, productId: args.product_id, quantity: args.quantity });
      await db.update(schema.carts).set({ updatedAt: new Date() }).where(eq(schema.carts.id, cart.id));
      ctx.invalidateQueries();
      return { cart: await loadCart(ctx, auth.id) };
    },
  }),
  updateCartItem: defineAction({
    request: z.object({ authToken: authTokenRequired, product_id: z.number().int().positive(), quantity: z.number().int().min(0).max(20) }), response: z.object({ cart: z.object({ items: z.array(z.object({ product_id: z.number(), quantity: z.number(), product: productShape })), subtotal_paisa: z.number() }) }),
    async handler(ctx, args) {
      const auth = await requireAuth(ctx, args.authToken, "buyer");
      const db = ctx.db<typeof schema>();
      const cart = (await db.select().from(schema.carts).where(eq(schema.carts.userId, auth.id)).limit(1))[0];
      const item = cart ? (await db.select().from(schema.cartItems).where(and(eq(schema.cartItems.cartId, cart.id), eq(schema.cartItems.productId, args.product_id))).limit(1))[0] : undefined;
      if (!cart || !item) throw new Error("That item is not in your cart.");
      if (args.quantity === 0) {
        await db.delete(schema.cartItems).where(eq(schema.cartItems.id, item.id));
      } else {
        const product = (await db.select().from(schema.products).where(eq(schema.products.id, args.product_id)).limit(1))[0];
        if (!product || !product.isActive) throw new Error("That product is no longer available.");
        if (args.quantity > product.stock) throw new Error(`${product.name} has only ${product.stock} left in stock.`);
        await db.update(schema.cartItems).set({ quantity: args.quantity }).where(eq(schema.cartItems.id, item.id));
      }
      ctx.invalidateQueries();
      return { cart: await loadCart(ctx, auth.id) };
    },
  }),
  clearCart: defineAction({
    request: z.object({ authToken: authTokenField }), response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const userId = await buyerIdOf(ctx, args.authToken);
      if (userId) {
        const db = ctx.db<typeof schema>();
        const cart = (await db.select().from(schema.carts).where(eq(schema.carts.userId, userId)).limit(1))[0];
        if (cart) {
          await db.delete(schema.cartItems).where(eq(schema.cartItems.cartId, cart.id));
          await db.delete(schema.carts).where(eq(schema.carts.id, cart.id));
        }
      }
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),
  mergeCart: defineAction({
    request: z.object({ authToken: authTokenRequired, items: z.array(z.object({ product_id: z.number().int().positive(), quantity: z.number().int().min(1).max(20) })).max(30) }), response: z.object({ cart: z.object({ items: z.array(z.object({ product_id: z.number(), quantity: z.number(), product: productShape })), subtotal_paisa: z.number() }) }),
    async handler(ctx, args) {
      // Merges a guest's localStorage cart into the server cart on sign-in,
      // capping every line at available stock.
      const auth = await requireAuth(ctx, args.authToken, "buyer");
      const db = ctx.db<typeof schema>();
      const actives = await activeStoreIds(ctx);
      let cart = (await db.select().from(schema.carts).where(eq(schema.carts.userId, auth.id)).limit(1))[0];
      if (!cart && args.items.length) {
        await db.insert(schema.carts).values({ userId: auth.id, updatedAt: new Date() });
        const created = (await db.select().from(schema.carts).where(eq(schema.carts.userId, auth.id)).limit(1))[0];
        if (!created) throw new Error("Your cart could not be created.");
        cart = created;
      }
      for (const item of args.items) {
        if (!cart) break;
        const product = (await db.select().from(schema.products).where(eq(schema.products.id, item.product_id)).limit(1))[0];
        if (!product || !product.isActive || !actives.has(product.storeId) || product.stock < 1) continue;
        const qty = Math.min(item.quantity, product.stock);
        const existing = (await db.select().from(schema.cartItems).where(and(eq(schema.cartItems.cartId, cart.id), eq(schema.cartItems.productId, item.product_id))).limit(1))[0];
        const newQty = Math.min((existing?.quantity ?? 0) + qty, product.stock);
        if (existing) await db.update(schema.cartItems).set({ quantity: newQty }).where(eq(schema.cartItems.id, existing.id));
        else await db.insert(schema.cartItems).values({ cartId: cart.id, productId: item.product_id, quantity: newQty });
      }
      ctx.invalidateQueries();
      return { cart: await loadCart(ctx, auth.id) };
    },
  }),

  // ---------- phase 2: addresses (buyer) ----------
  listAddresses: defineAction({
    request: z.object({ authToken: authTokenField }),
    response: z.object({ addresses: z.array(z.object({ id: z.number(), label: z.string(), full_name: z.string(), phone: z.string(), province: z.string(), district: z.string(), municipality: z.string(), ward: z.string().nullable(), landmark: z.string().nullable(), note: z.string().nullable(), is_default: z.boolean() })) }),
    async handler(ctx, args) {
      const userId = await buyerIdOf(ctx, args.authToken);
      if (!userId) return { addresses: [] };
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.addresses).where(eq(schema.addresses.userId, userId)).orderBy(desc(schema.addresses.isDefault), desc(schema.addresses.createdAt));
      return { addresses: rows.map((a) => ({ id: a.id, label: a.label, full_name: a.fullName, phone: a.phone, province: a.province, district: a.district, municipality: a.municipality, ward: a.ward, landmark: a.landmark, note: a.note, is_default: a.isDefault })) };
    },
  }),
  saveAddress: defineAction({
    request: z.object({ authToken: authTokenRequired, id: z.number().int().positive().optional(), label: z.string().trim().min(1).max(30).optional(), full_name: z.string().trim().min(2).max(80), phone: z.string().trim().min(7).max(20), province: z.string().trim().min(2).max(60), district: z.string().trim().min(2).max(60), municipality: z.string().trim().min(2).max(60), ward: z.string().trim().max(20).optional(), landmark: z.string().trim().max(120).optional(), note: z.string().trim().max(200).optional() }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const auth = await requireAuth(ctx, args.authToken, "buyer");
      const db = ctx.db<typeof schema>();
      const values = { userId: auth.id, label: args.label?.trim() || "Home", fullName: args.full_name.trim(), phone: args.phone.trim(), province: args.province.trim(), district: args.district.trim(), municipality: args.municipality.trim(), ward: args.ward?.trim() || null, landmark: args.landmark?.trim() || null, note: args.note?.trim() || null };
      if (args.id) {
        const existing = (await db.select().from(schema.addresses).where(and(eq(schema.addresses.id, args.id), eq(schema.addresses.userId, auth.id))).limit(1))[0];
        if (!existing) throw new Error("That address was not found.");
        await db.update(schema.addresses).set(values).where(eq(schema.addresses.id, args.id));
        ctx.invalidateQueries();
        return { id: args.id };
      }
      const count = (await db.select({ id: schema.addresses.id }).from(schema.addresses).where(eq(schema.addresses.userId, auth.id))).length;
      const result = await db.insert(schema.addresses).values({ ...values, isDefault: count === 0, createdAt: new Date() }).returning({ id: schema.addresses.id });
      const row = result[0];
      if (!row) throw new Error("The address could not be saved.");
      ctx.invalidateQueries();
      return { id: row.id };
    },
  }),
  deleteAddress: defineAction({
    request: z.object({ authToken: authTokenRequired, id: z.number().int().positive() }), response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const auth = await requireAuth(ctx, args.authToken, "buyer");
      const db = ctx.db<typeof schema>();
      const existing = (await db.select().from(schema.addresses).where(and(eq(schema.addresses.id, args.id), eq(schema.addresses.userId, auth.id))).limit(1))[0];
      if (!existing) throw new Error("That address was not found.");
      await db.delete(schema.addresses).where(eq(schema.addresses.id, args.id));
      if (existing.isDefault) {
        const next = (await db.select().from(schema.addresses).where(eq(schema.addresses.userId, auth.id)).orderBy(desc(schema.addresses.createdAt)).limit(1))[0];
        if (next) await db.update(schema.addresses).set({ isDefault: true }).where(eq(schema.addresses.id, next.id));
      }
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),
  setDefaultAddress: defineAction({
    request: z.object({ authToken: authTokenRequired, id: z.number().int().positive() }), response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const auth = await requireAuth(ctx, args.authToken, "buyer");
      const db = ctx.db<typeof schema>();
      const existing = (await db.select({ id: schema.addresses.id }).from(schema.addresses).where(and(eq(schema.addresses.id, args.id), eq(schema.addresses.userId, auth.id))).limit(1))[0];
      if (!existing) throw new Error("That address was not found.");
      await db.update(schema.addresses).set({ isDefault: false }).where(eq(schema.addresses.userId, auth.id));
      await db.update(schema.addresses).set({ isDefault: true }).where(eq(schema.addresses.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  // ---------- phase 2: wishlist (buyer) ----------
  getWishlist: defineAction({
    request: z.object({ authToken: authTokenField }),
    response: z.object({ items: z.array(z.object({ product: productShape, added_price_paisa: z.number(), price_changed: z.boolean(), price_diff_paisa: z.number(), in_stock: z.boolean() })) }),
    async handler(ctx, args) {
      const userId = await buyerIdOf(ctx, args.authToken);
      if (!userId) return { items: [] };
      const db = ctx.db<typeof schema>();
      const wl = (await db.select().from(schema.wishlists).where(eq(schema.wishlists.userId, userId)).limit(1))[0];
      if (!wl) return { items: [] };
      const rows = await db.select().from(schema.wishlistItems).where(eq(schema.wishlistItems.wishlistId, wl.id)).orderBy(desc(schema.wishlistItems.addedAt));
      const actives = await activeStoreIds(ctx);
      const byId = new Map(publicOnly(await productRows(ctx), actives).map((p) => [p.id, p]));
      const items = rows.flatMap((r) => {
        const product = byId.get(r.productId);
        if (!product) return [];
        return [{ product, added_price_paisa: r.addedPricePaisa, price_changed: product.price_paisa !== r.addedPricePaisa, price_diff_paisa: r.addedPricePaisa - product.price_paisa, in_stock: product.stock > 0 }];
      });
      return { items };
    },
  }),
  toggleWishlist: defineAction({
    request: z.object({ authToken: authTokenRequired, product_id: z.number().int().positive() }), response: z.object({ wishlisted: z.boolean() }),
    async handler(ctx, args) {
      const auth = await requireAuth(ctx, args.authToken, "buyer");
      const db = ctx.db<typeof schema>();
      const product = (await db.select().from(schema.products).where(eq(schema.products.id, args.product_id)).limit(1))[0];
      if (!product || !product.isActive || !((await activeStoreIds(ctx)).has(product.storeId))) throw new Error("That product is not available right now.");
      let wl = (await db.select().from(schema.wishlists).where(eq(schema.wishlists.userId, auth.id)).limit(1))[0];
      if (!wl) {
        await db.insert(schema.wishlists).values({ userId: auth.id, createdAt: new Date() });
        const created = (await db.select().from(schema.wishlists).where(eq(schema.wishlists.userId, auth.id)).limit(1))[0];
        if (!created) throw new Error("Your wishlist could not be created.");
        wl = created;
      }
      const existing = (await db.select().from(schema.wishlistItems).where(and(eq(schema.wishlistItems.wishlistId, wl.id), eq(schema.wishlistItems.productId, args.product_id))).limit(1))[0];
      if (existing) {
        await db.delete(schema.wishlistItems).where(eq(schema.wishlistItems.id, existing.id));
        ctx.invalidateQueries();
        return { wishlisted: false };
      }
      await db.insert(schema.wishlistItems).values({ wishlistId: wl.id, productId: args.product_id, addedPricePaisa: product.pricePaisa, addedAt: new Date() });
      ctx.invalidateQueries();
      return { wishlisted: true };
    },
  }),
  // ---------- phase 2: coupons ----------
  validateCoupon: defineAction({
    request: z.object({ authToken: authTokenField, code: z.string().trim().min(1).max(40), subtotal_paisa: z.number().int().min(0) }),
    response: z.object({ valid: z.boolean(), discount_paisa: z.number(), free_shipping: z.boolean(), message: z.string() }),
    async handler(ctx, args) {
      // Never throws for an invalid code — the result carries the message.
      const evald = await evaluateCoupon(ctx, args.code, await buyerIdOf(ctx, args.authToken), args.subtotal_paisa);
      return { valid: evald.valid, discount_paisa: evald.discount_paisa, free_shipping: evald.free_shipping, message: evald.message };
    },
  }),
  adminListCoupons: defineAction({
    request: z.object({ authToken: authTokenField }),
    response: z.object({ coupons: z.array(z.object({ id: z.number(), code: z.string(), kind: z.enum(["percent", "fixed", "free_shipping"]), value: z.number(), min_order_paisa: z.number(), max_uses: z.number().nullable(), per_user_limit: z.number(), expires_at: z.string().nullable(), is_active: z.boolean(), created_at: z.string() })) }),
    async handler(ctx, args) {
      await requireAuth(ctx, args.authToken, "admin");
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.coupons).orderBy(desc(schema.coupons.createdAt));
      return { coupons: rows.map((c) => ({ id: c.id, code: c.code, kind: c.kind, value: c.value, min_order_paisa: c.minOrderPaisa, max_uses: c.maxUses, per_user_limit: c.perUserLimit, expires_at: c.expiresAt ? c.expiresAt.toISOString() : null, is_active: c.isActive, created_at: c.createdAt.toISOString() })) };
    },
  }),
  adminSaveCoupon: defineAction({
    request: z.object({ authToken: authTokenField, id: z.number().int().positive().optional(), code: z.string().trim().min(1).max(20), kind: z.enum(["percent", "fixed", "free_shipping"]), value: z.number().int().min(0).max(1000000), min_order_paisa: z.number().int().min(0).optional(), max_uses: z.number().int().positive().nullable().optional(), per_user_limit: z.number().int().min(1).optional(), expires_at: z.string().nullable().optional(), is_active: z.boolean().optional() }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      await requireAuth(ctx, args.authToken, "admin");
      const code = args.code.trim().toUpperCase();
      let value = args.value;
      if (args.kind === "percent" && (value < 1 || value > 90)) throw new Error("A percent coupon must be between 1 and 90.");
      if (args.kind === "fixed" && value < 1) throw new Error("A fixed coupon must discount at least 1 paisa.");
      if (args.kind === "free_shipping") value = 0;
      let expiresAt: Date | null = null;
      if (args.expires_at) {
        expiresAt = new Date(args.expires_at);
        if (Number.isNaN(expiresAt.getTime())) throw new Error("That expiry date is not valid.");
      }
      const db = ctx.db<typeof schema>();
      const clash = (await db.select({ id: schema.coupons.id }).from(schema.coupons).where(eq(schema.coupons.code, code)).limit(1))[0];
      if (clash && clash.id !== args.id) throw new Error(`The code "${code}" is already in use.`);
      const values = { code, kind: args.kind, value, minOrderPaisa: args.min_order_paisa ?? 0, maxUses: args.max_uses ?? null, perUserLimit: args.per_user_limit ?? 1, expiresAt, isActive: args.is_active ?? true };
      if (args.id) {
        const existing = (await db.select({ id: schema.coupons.id }).from(schema.coupons).where(eq(schema.coupons.id, args.id)).limit(1))[0];
        if (!existing) throw new Error("Coupon not found.");
        await db.update(schema.coupons).set(values).where(eq(schema.coupons.id, args.id));
        ctx.invalidateQueries();
        return { id: args.id };
      }
      const result = await db.insert(schema.coupons).values({ ...values, createdAt: new Date() }).returning({ id: schema.coupons.id });
      const row = result[0];
      if (!row) throw new Error("The coupon could not be saved.");
      ctx.invalidateQueries();
      return { id: row.id };
    },
  }),
  adminToggleCoupon: defineAction({
    request: z.object({ authToken: authTokenField, id: z.number().int().positive(), is_active: z.boolean() }), response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      await requireAuth(ctx, args.authToken, "admin");
      const db = ctx.db<typeof schema>();
      const existing = (await db.select({ id: schema.coupons.id }).from(schema.coupons).where(eq(schema.coupons.id, args.id)).limit(1))[0];
      if (!existing) throw new Error("Coupon not found.");
      await db.update(schema.coupons).set({ isActive: args.is_active }).where(eq(schema.coupons.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  // ---------- phase 2: payments (never fakes success) ----------
  initiateOnlinePayment: defineAction({
    request: z.object({ authToken: authTokenField, order_id: z.number().int().positive(), provider: z.enum(["esewa", "khalti"]), phone: z.string().trim().min(7).max(20).optional() }),
    response: z.object({ provider: z.enum(["esewa", "khalti"]), payment_url: z.string(), params: z.record(z.string(), z.string()).optional(), pidx: z.string().optional() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const order = (await db.select().from(schema.orders).where(eq(schema.orders.id, args.order_id)).limit(1))[0];
      if (!order) throw new Error("Order not found.");
      // The order must belong to the caller: a signed-in buyer, or a guest
      // proving ownership with the order's phone number.
      if (args.authToken) {
        const auth = await requireAuth(ctx, args.authToken, "buyer");
        if (order.userId !== auth.id) throw new Error("This order does not belong to your account.");
      } else if (args.phone) {
        if (order.phone !== args.phone.trim()) throw new Error("We could not match that order and phone number.");
      } else {
        throw new Error("Please sign in or provide the order phone number.");
      }
      if (order.paymentMethod !== args.provider) throw new Error(`This order was placed with ${order.paymentMethod === "cod" ? "Cash on Delivery" : order.paymentMethod}.`);
      const payment = (await db.select().from(schema.payments).where(eq(schema.payments.orderId, order.id)).limit(1))[0];
      if (!payment) throw new Error("No payment record found for this order.");
      if (payment.status === "paid") throw new Error("This order is already paid.");
      if (payment.status !== "pending" && payment.status !== "failed") throw new Error("This payment is already being processed.");
      try {
        if (args.provider === "esewa") {
          const { params, paymentUrl } = await buildEsewaParams({ orderCode: order.orderCode, orderId: order.id, totalPaisa: order.totalPaisa, deliveryPaisa: order.deliveryFeePaisa });
          await db.update(schema.payments).set({ status: "processing", payloadJson: JSON.stringify({ params }), updatedAt: new Date() }).where(eq(schema.payments.id, payment.id));
          ctx.invalidateQueries();
          return { provider: "esewa" as const, payment_url: paymentUrl, params };
        }
        const { pidx, paymentUrl } = await initiateKhalti({ orderCode: order.orderCode, orderId: order.id, totalPaisa: order.totalPaisa });
        await db.update(schema.payments).set({ status: "processing", transactionId: pidx, payloadJson: JSON.stringify({ pidx }), updatedAt: new Date() }).where(eq(schema.payments.id, payment.id));
        ctx.invalidateQueries();
        return { provider: "khalti" as const, payment_url: paymentUrl, pidx };
      } catch (e) {
        await db.update(schema.payments).set({ status: "failed", updatedAt: new Date() }).where(eq(schema.payments.id, payment.id));
        throw e instanceof Error ? e : new Error("The payment could not be started. Please try again or choose Cash on Delivery.");
      }
    },
  }),
  // Webhook architecture: eSewa redirects the buyer to
  // {PUBLIC_BASE_URL}/#/payment-result?provider=esewa&order_id=<id> with a
  // base64 `data` param; that page calls this action, which verifies the
  // signature AND does a server-side status check before marking anything paid.
  verifyEsewaPayment: defineAction({
    request: z.object({ order_id: z.number().int().positive(), data: z.string().min(8) }),
    response: z.object({ ok: z.literal(true), order_code: z.string() }),
    async handler(ctx, args): Promise<{ ok: true; order_code: string }> {
      const db = ctx.db<typeof schema>();
      const order = (await db.select().from(schema.orders).where(eq(schema.orders.id, args.order_id)).limit(1))[0];
      if (!order) throw new Error("Order not found.");
      const payment = (await db.select().from(schema.payments).where(eq(schema.payments.orderId, order.id)).limit(1))[0];
      if (!payment || payment.provider !== "esewa") throw new Error("No eSewa payment found for this order.");
      const fail = async (message: string): Promise<never> => {
        await db.update(schema.payments).set({ status: "failed", updatedAt: new Date() }).where(eq(schema.payments.id, payment.id));
        if (order.userId) await notifyUser(ctx, order.userId, { type: "payment", title: `Payment failed for ${order.orderCode}`, body: message, link: "#/orders" });
        throw new Error(message);
      };
      const decoded = await verifyEsewaSignature(args.data);
      if (!decoded.ok || !decoded.payload) return fail(decoded.error ?? "The eSewa payment could not be verified.");
      const p = decoded.payload;
      if (p.transaction_uuid && p.transaction_uuid !== order.orderCode) return fail("This payment response is for a different order.");
      const status = await esewaTransactionStatus({ productCode: p.product_code ?? "", totalAmount: p.total_amount ?? "", transactionUuid: p.transaction_uuid ?? "" });
      if (status !== "COMPLETE") return fail("eSewa did not confirm this payment. No money was taken.");
      await db.update(schema.payments).set({ status: "paid", transactionId: p.transaction_code ?? null, payloadJson: args.data, updatedAt: new Date() }).where(eq(schema.payments.id, payment.id));
      if (order.status === "confirmation_needed") {
        await db.update(schema.orders).set({ status: "confirmed", updatedAt: new Date() }).where(eq(schema.orders.id, order.id));
      }
      if (order.userId) await notifyUser(ctx, order.userId, { type: "payment", title: `Payment received for ${order.orderCode}`, body: `Your eSewa payment of ${formatRs(order.totalPaisa)} was confirmed.`, link: "#/orders" });
      ctx.invalidateQueries();
      return { ok: true, order_code: order.orderCode };
    },
  }),
  // Same redirect architecture for Khalti: the result page calls this with the
  // pidx; a server-side lookup decides the outcome.
  verifyKhaltiPayment: defineAction({
    request: z.object({ order_id: z.number().int().positive(), pidx: z.string().trim().min(4).max(120) }),
    response: z.object({ ok: z.literal(true), order_code: z.string() }),
    async handler(ctx, args): Promise<{ ok: true; order_code: string }> {
      const db = ctx.db<typeof schema>();
      const order = (await db.select().from(schema.orders).where(eq(schema.orders.id, args.order_id)).limit(1))[0];
      if (!order) throw new Error("Order not found.");
      const payment = (await db.select().from(schema.payments).where(eq(schema.payments.orderId, order.id)).limit(1))[0];
      if (!payment || payment.provider !== "khalti") throw new Error("No Khalti payment found for this order.");
      if (payment.transactionId && payment.transactionId !== args.pidx.trim()) throw new Error("This payment reference does not match the order.");
      const fail = async (message: string): Promise<never> => {
        await db.update(schema.payments).set({ status: "failed", updatedAt: new Date() }).where(eq(schema.payments.id, payment.id));
        if (order.userId) await notifyUser(ctx, order.userId, { type: "payment", title: `Payment failed for ${order.orderCode}`, body: message, link: "#/orders" });
        throw new Error(message);
      };
      const status = await lookupKhalti(args.pidx.trim());
      if (status === "Completed") {
        await db.update(schema.payments).set({ status: "paid", transactionId: args.pidx.trim(), updatedAt: new Date() }).where(eq(schema.payments.id, payment.id));
        if (order.status === "confirmation_needed") {
          await db.update(schema.orders).set({ status: "confirmed", updatedAt: new Date() }).where(eq(schema.orders.id, order.id));
        }
        if (order.userId) await notifyUser(ctx, order.userId, { type: "payment", title: `Payment received for ${order.orderCode}`, body: `Your Khalti payment of ${formatRs(order.totalPaisa)} was confirmed.`, link: "#/orders" });
        ctx.invalidateQueries();
        return { ok: true, order_code: order.orderCode };
      }
      if (status === "Pending") throw new Error("The Khalti payment is still pending. Please wait a moment and try again.");
      return fail("Khalti did not confirm this payment. No money was taken.");
    },
  }),

  // ---------- phase 2: notifications (buyer) ----------
  getNotifications: defineAction({
    request: z.object({ authToken: authTokenField, limit: z.number().int().min(1).max(100).optional().default(30) }),
    response: z.object({ notifications: z.array(z.object({ id: z.number(), type: z.string(), title: z.string(), body: z.string(), link: z.string().nullable(), is_read: z.boolean(), created_at: z.string() })), unread_count: z.number() }),
    async handler(ctx, args) {
      const userId = await buyerIdOf(ctx, args.authToken);
      if (!userId) return { notifications: [], unread_count: 0 };
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.notifications).where(eq(schema.notifications.userId, userId)).orderBy(desc(schema.notifications.createdAt)).limit(args.limit);
      const unreadRows = await db.select({ id: schema.notifications.id }).from(schema.notifications).where(and(eq(schema.notifications.userId, userId), eq(schema.notifications.isRead, false)));
      return {
        notifications: rows.map((n) => ({ id: n.id, type: n.type, title: n.title, body: n.body, link: n.link, is_read: n.isRead, created_at: n.createdAt.toISOString() })),
        unread_count: unreadRows.length,
      };
    },
  }),
  markNotificationRead: defineAction({
    request: z.object({ authToken: authTokenRequired, id: z.number().int().positive() }), response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const auth = await requireAuth(ctx, args.authToken, "buyer");
      const db = ctx.db<typeof schema>();
      const existing = (await db.select({ id: schema.notifications.id }).from(schema.notifications).where(and(eq(schema.notifications.id, args.id), eq(schema.notifications.userId, auth.id))).limit(1))[0];
      if (!existing) throw new Error("Notification not found.");
      await db.update(schema.notifications).set({ isRead: true }).where(eq(schema.notifications.id, args.id));
      return { ok: true };
    },
  }),
  markAllNotificationsRead: defineAction({
    request: z.object({ authToken: authTokenField }), response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const userId = await buyerIdOf(ctx, args.authToken);
      if (userId) {
        const db = ctx.db<typeof schema>();
        await db.update(schema.notifications).set({ isRead: true }).where(eq(schema.notifications.userId, userId));
      }
      return { ok: true };
    },
  }),

  // ---------- phase 2: returns ----------
  requestReturn: defineAction({
    request: z.object({ authToken: authTokenField, order_code: z.string().trim().min(4).max(40), phone: z.string().trim().min(7).max(20), reason: z.string().trim().min(8).max(400) }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      const code = args.order_code.toUpperCase();
      const userId = await buyerIdOf(ctx, args.authToken);
      const order = userId
        ? (await db.select().from(schema.orders).where(and(eq(schema.orders.orderCode, code), eq(schema.orders.userId, userId))).limit(1))[0]
        : (await db.select().from(schema.orders).where(and(eq(schema.orders.orderCode, code), eq(schema.orders.phone, args.phone.trim()))).limit(1))[0];
      if (!order) throw new Error("We could not match that order.");
      if (order.status !== "delivered") throw new Error("Only delivered orders can be returned.");
      if (Date.now() - order.updatedAt.getTime() > 30 * 86400 * 1000) throw new Error("The 30-day return window for this order has passed.");
      await db.update(schema.orders).set({ status: "return_requested", updatedAt: new Date() }).where(eq(schema.orders.id, order.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),
  updateReturnStatus: defineAction({
    request: z.object({ ...sellerAuthFields, order_id: z.number().int().positive(), decision: z.enum(["accepted", "rejected"]) }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const store = await resolveSeller(ctx, args);
      const db = ctx.db<typeof schema>();
      const order = (await db.select().from(schema.orders).where(and(eq(schema.orders.id, args.order_id), eq(schema.orders.storeId, store.id))).limit(1))[0];
      if (!order) throw new Error("Order not found.");
      if (order.status !== "return_requested") throw new Error("This order does not have a pending return request.");
      const next = args.decision === "accepted" ? "returned" : "delivered";
      await db.update(schema.orders).set({ status: next, updatedAt: new Date() }).where(eq(schema.orders.id, order.id));
      if (order.userId) {
        await notifyUser(ctx, order.userId, { type: "order_status", title: `Return ${args.decision} for ${order.orderCode}`, body: args.decision === "accepted" ? `Your return for order ${order.orderCode} was accepted.` : `Your return for order ${order.orderCode} was declined.`, link: "#/orders" });
      }
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),
  markRefunded: defineAction({
    request: z.object({ ...sellerAuthFields, order_id: z.number().int().positive() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const store = await resolveSeller(ctx, args);
      const db = ctx.db<typeof schema>();
      const order = (await db.select().from(schema.orders).where(and(eq(schema.orders.id, args.order_id), eq(schema.orders.storeId, store.id))).limit(1))[0];
      if (!order) throw new Error("Order not found.");
      if (order.status !== "returned") throw new Error("Only returned orders can be marked refunded.");
      await db.update(schema.orders).set({ status: "refunded", paymentStatus: "refunded", updatedAt: new Date() }).where(eq(schema.orders.id, order.id));
      const payment = (await db.select().from(schema.payments).where(eq(schema.payments.orderId, order.id)).limit(1))[0];
      if (payment) await db.update(schema.payments).set({ status: "refunded", updatedAt: new Date() }).where(eq(schema.payments.id, payment.id));
      if (order.userId) {
        await notifyUser(ctx, order.userId, { type: "payment", title: `Refund issued for ${order.orderCode}`, body: `A refund of ${formatRs(order.totalPaisa)} was issued for order ${order.orderCode}.`, link: "#/orders" });
      }
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),
  listReturns: defineAction({
    request: z.object({ ...sellerAuthFields }),
    response: z.object({ orders: z.array(orderShape) }),
    async handler(ctx, args) {
      const store = await resolveSeller(ctx, args);
      const db = ctx.db<typeof schema>();
      const all = await db.select().from(schema.orders).where(eq(schema.orders.storeId, store.id)).orderBy(desc(schema.orders.createdAt)).limit(200);
      const orders = all.filter((o) => o.status === "return_requested" || o.status === "returned").slice(0, 100);
      const items = orders.length ? await db.select().from(schema.orderItems).where(inArray(schema.orderItems.orderId, orders.map((o) => o.id))) : [];
      return { orders: orders.map((o) => mapOrder(o, items)) };
    },
  }),
  // ---------- phase 2: product detail, search, discovery ----------
  getProductDetail: defineAction({
    request: z.object({ product_id: z.number().int().positive(), authToken: authTokenField }),
    response: z.object({
      product: productShape,
      reviews: z.array(z.object({ id: z.number(), reviewer_name: z.string(), rating: z.number(), body: z.string(), created_at: z.string() })),
      related: z.array(productShape),
      frequently_bought_together: z.array(productShape),
      seller: z.object({ store_name: z.string(), location: z.string(), rating: z.number().nullable(), product_count: z.number(), verified: z.boolean() }),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const actives = await activeStoreIds(ctx);
      const pubs = publicOnly(await productRows(ctx), actives);
      const product = pubs.find((p) => p.id === args.product_id);
      if (!product) throw new Error("That product was not found.");
      const reviewRows = await db.select().from(schema.reviews).where(eq(schema.reviews.productId, args.product_id)).orderBy(desc(schema.reviews.createdAt));
      const related = pubs.filter((p) => p.category === product.category && p.id !== product.id).slice(0, 4);
      const ownItems = await db.select().from(schema.orderItems).where(eq(schema.orderItems.productId, args.product_id));
      const orderIds = [...new Set(ownItems.map((i) => i.orderId))];
      let frequentlyBoughtTogether: PublicProduct[] = [];
      if (orderIds.length) {
        const others = await db.select().from(schema.orderItems).where(inArray(schema.orderItems.orderId, orderIds));
        const counts = new Map<number, number>();
        for (const o of others) if (o.productId !== args.product_id) counts.set(o.productId, (counts.get(o.productId) ?? 0) + 1);
        const byId = new Map(pubs.map((p) => [p.id, p]));
        frequentlyBoughtTogether = [...counts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 4)
          .flatMap(([id]) => {
            const p = byId.get(id);
            return p ? [p] : [];
          });
      }
      const store = (await db.select().from(schema.storeSettings).where(eq(schema.storeSettings.id, product.store_id)).limit(1))[0];
      const sellerProducts = pubs.filter((p) => p.store_id === product.store_id);
      const sellerReviews = sellerProducts.length
        ? await db.select().from(schema.reviews).where(inArray(schema.reviews.productId, sellerProducts.map((p) => p.id)))
        : [];
      // Record the view, and the recently-viewed entry for signed-in buyers.
      const userId = await buyerIdOf(ctx, args.authToken);
      await db.insert(schema.productViews).values({ productId: args.product_id, userId, createdAt: new Date() });
      if (userId) {
        await db.insert(schema.recentlyViewed).values({ userId, productId: args.product_id, viewedAt: new Date() })
          .onConflictDoUpdate({ target: [schema.recentlyViewed.userId, schema.recentlyViewed.productId], set: { viewedAt: new Date() } });
      }
      return {
        product,
        reviews: reviewRows.map((r) => ({ id: r.id, reviewer_name: r.reviewerName, rating: r.rating, body: r.body, created_at: r.createdAt.toISOString() })),
        related,
        frequently_bought_together: frequentlyBoughtTogether,
        seller: {
          store_name: store?.storeName ?? product.store_name,
          location: store?.location ?? "",
          rating: sellerReviews.length ? sellerReviews.reduce((n, r) => n + r.rating, 0) / sellerReviews.length : null,
          product_count: sellerProducts.length,
          verified: (store?.status ?? "") === "active" && !!store?.email,
        },
      };
    },
  }),
  searchProducts: defineAction({
    request: z.object({
      query: z.string().trim().max(120).default(""),
      category: z.string().trim().max(40).optional(),
      brand: z.string().trim().max(40).optional(),
      min_price_paisa: z.number().int().min(0).optional(),
      max_price_paisa: z.number().int().min(0).optional(),
      min_rating: z.number().min(0).max(5).optional(),
      in_stock_only: z.boolean().optional(),
      on_sale_only: z.boolean().optional(),
      seller_code: z.string().trim().max(40).optional(),
      sort: z.enum(["relevance", "price_asc", "price_desc", "rating", "newest", "popularity", "discount"]).optional().default("relevance"),
      limit: z.number().int().min(1).max(60).optional().default(24),
      offset: z.number().int().min(0).optional().default(0),
    }),
    response: z.object({ products: z.array(productShape), total: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const actives = await activeStoreIds(ctx);
      let pubs = publicOnly(await productRows(ctx), actives);
      const q = args.query.toLowerCase().trim().replace(/\s+/g, " ");
      if (q) {
        // Token match with typo tolerance: every token must appear in the
        // product text, or be within Levenshtein distance 2 of a word.
        const tokens = q.split(" ").filter(Boolean);
        pubs = pubs.filter((p) => {
          const hay = `${p.name} ${p.brand ?? ""} ${p.category} ${p.description}`.toLowerCase();
          const words = hay.split(/[\s,.;:!?()\/-]+/);
          return tokens.every((t) => hay.includes(t) || (t.length >= 4 && words.some((w) => w.length >= 4 && levenshtein(w, t) <= 2)));
        });
        await db.insert(schema.searchEvents).values({ query: q, userId: null, createdAt: new Date() });
      }
      if (args.category) pubs = pubs.filter((p) => p.category.toLowerCase() === args.category!.toLowerCase());
      if (args.brand) pubs = pubs.filter((p) => (p.brand ?? "").toLowerCase() === args.brand!.toLowerCase());
      if (args.min_price_paisa != null) pubs = pubs.filter((p) => p.price_paisa >= args.min_price_paisa!);
      if (args.max_price_paisa != null) pubs = pubs.filter((p) => p.price_paisa <= args.max_price_paisa!);
      if (args.min_rating != null) pubs = pubs.filter((p) => (p.rating ?? 0) >= args.min_rating!);
      if (args.in_stock_only) pubs = pubs.filter((p) => p.stock > 0);
      if (args.on_sale_only) pubs = pubs.filter((p) => p.discount_pct > 0);
      if (args.seller_code) pubs = pubs.filter((p) => p.seller_code === args.seller_code!.toUpperCase());
      const counts = args.sort === "popularity" ? await popularityCounts(ctx) : new Map<number, number>();
      const relevance = (p: PublicProduct) => {
        let score = 0;
        const name = p.name.toLowerCase();
        for (const t of q.split(" ").filter(Boolean)) {
          if (name.startsWith(t)) score += 4;
          else if (name.includes(t)) score += 3;
          else if ((p.brand ?? "").toLowerCase().includes(t) || p.category.toLowerCase().includes(t)) score += 2;
          else score += 1;
        }
        return score;
      };
      const sorted = [...pubs].sort((a, b) => {
        switch (args.sort) {
          case "price_asc": return a.price_paisa - b.price_paisa;
          case "price_desc": return b.price_paisa - a.price_paisa;
          case "rating": return (b.rating ?? -1) - (a.rating ?? -1) || b.review_count - a.review_count;
          case "newest": return b.created_at.localeCompare(a.created_at);
          case "popularity": return (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0);
          case "discount": return b.discount_pct - a.discount_pct;
          default: return relevance(b) - relevance(a) || (b.rating ?? 0) - (a.rating ?? 0);
        }
      });
      const total = sorted.length;
      return { products: sorted.slice(args.offset, args.offset + args.limit), total };
    },
  }),
  suggestSearch: defineAction({
    request: z.object({ query: z.string().trim().min(1).max(80) }),
    response: z.object({ product_names: z.array(z.string()), categories: z.array(z.string()) }),
    async handler(ctx, args) {
      const pubs = publicOnly(await productRows(ctx), await activeStoreIds(ctx));
      const q = args.query.toLowerCase().trim();
      const product_names = [...new Set(pubs.map((p) => p.name))].filter((n) => n.toLowerCase().startsWith(q)).slice(0, 6);
      const categories = [...new Set(pubs.map((p) => p.category))].filter((c) => c.toLowerCase().startsWith(q));
      return { product_names, categories };
    },
  }),
  getRecentlyViewed: defineAction({
    request: z.object({ authToken: authTokenField }),
    response: z.object({ products: z.array(productShape) }),
    async handler(ctx, args) {
      const userId = await buyerIdOf(ctx, args.authToken);
      if (!userId) return { products: [] };
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.recentlyViewed).where(eq(schema.recentlyViewed.userId, userId)).orderBy(desc(schema.recentlyViewed.viewedAt)).limit(12);
      const byId = new Map(publicOnly(await productRows(ctx), await activeStoreIds(ctx)).map((p) => [p.id, p]));
      const products = rows.flatMap((r) => {
        const p = byId.get(r.productId);
        return p ? [p] : [];
      });
      return { products };
    },
  }),
  getHomepage: defineAction({
    request: z.object({ authToken: authTokenField }),
    response: z.object({
      banners: z.array(z.object({ title: z.string(), subtitle: z.string().nullable(), link: z.string().nullable() })),
      sections: z.array(z.object({ key: z.string(), title: z.string(), products: z.array(productShape) })),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const actives = await activeStoreIds(ctx);
      const pubs = publicOnly(await productRows(ctx), actives);
      const banners = (await db.select().from(schema.homepageBanners).where(eq(schema.homepageBanners.isActive, true)).orderBy(schema.homepageBanners.sortOrder))
        .map((b) => ({ title: b.title, subtitle: b.subtitle, link: b.link }));
      const sectionRows = await db.select().from(schema.homepageSections).where(eq(schema.homepageSections.isActive, true)).orderBy(schema.homepageSections.sortOrder);
      const counts = await popularityCounts(ctx);
      const recentCounts = await popularityCounts(ctx, Date.now() - 30 * 86400 * 1000);
      const trending = [...pubs].sort((a, b) => (recentCounts.get(b.id) ?? 0) - (recentCounts.get(a.id) ?? 0));
      const userId = await buyerIdOf(ctx, args.authToken);
      const recommended = userId ? await recommendedFor(ctx, userId, pubs, trending) : trending.slice(0, 8);
      const builders: Record<string, PublicProduct[]> = {
        trending: trending.slice(0, 8),
        new_arrivals: [...pubs].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 8),
        best_sellers: [...pubs].sort((a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0)).slice(0, 8),
        flash_deals: pubs.filter((p) => p.discount_pct > 0).sort((a, b) => b.discount_pct - a.discount_pct).slice(0, 8),
        recommended,
      };
      return { banners, sections: sectionRows.map((s) => ({ key: s.key, title: s.title, products: builders[s.key] ?? [] })) };
    },
  }),

  // ---------- phase 2: AI shopping assistant ----------
  askAssistant: defineAction({
    request: z.object({ question: z.string().trim().min(3).max(500) }),
    response: z.object({
      answer: z.string(),
      products: z.array(productShape),
      comparison: z.object({ products: z.array(productShape), rows: z.array(z.object({ label: z.string(), values: z.array(z.string()) })) }).optional(),
    }),
    async handler(ctx, args) {
      const pubs = publicOnly(await productRows(ctx), await activeStoreIds(ctx));
      const result = runAssistant(args.question, pubs);
      return {
        answer: result.answer,
        products: result.products,
        comparison: result.comparison ? { products: result.comparison.products, rows: result.comparison.rows } : undefined,
      };
    },
  }),

  // ---------- phase 2: seller portal ----------
  sellerAnalytics: defineAction({
    request: z.object({ ...sellerAuthFields }),
    response: z.object({
      revenue_paisa_30d: z.number(),
      orders_30d: z.number(),
      orders_by_status: z.record(z.string(), z.number()),
      top_products: z.array(z.object({ id: z.number(), name: z.string(), quantity: z.number(), revenue_paisa: z.number() })),
      low_stock: z.array(z.object({ id: z.number(), name: z.string(), stock: z.number() })),
      total_customers: z.number(),
      avg_rating: z.number().nullable(),
      revenue_by_day: z.array(z.object({ day: z.string(), revenue_paisa: z.number() })),
    }),
    async handler(ctx, args) {
      const store = await resolveSeller(ctx, args);
      const db = ctx.db<typeof schema>();
      const cutoff = Date.now() - 30 * 86400 * 1000;
      const orders = await db.select().from(schema.orders).where(eq(schema.orders.storeId, store.id));
      const billable = orders.filter((o) => o.status !== "cancelled" && o.status !== "refunded");
      const recent = billable.filter((o) => o.createdAt.getTime() >= cutoff);
      const ordersByStatus: Record<string, number> = {};
      for (const o of orders) ordersByStatus[o.status] = (ordersByStatus[o.status] ?? 0) + 1;
      const validIds = [...new Set(billable.map((o) => o.id))];
      const items = validIds.length ? await db.select().from(schema.orderItems).where(inArray(schema.orderItems.orderId, validIds)) : [];
      const agg = new Map<number, { name: string; quantity: number; revenue: number }>();
      for (const i of items) {
        const a = agg.get(i.productId) ?? { name: i.productName, quantity: 0, revenue: 0 };
        a.quantity += i.quantity;
        a.revenue += i.quantity * i.unitPricePaisa;
        agg.set(i.productId, a);
      }
      const topProducts = [...agg.entries()]
        .sort((a, b) => b[1].quantity - a[1].quantity)
        .slice(0, 5)
        .map(([id, a]) => ({ id, name: a.name, quantity: a.quantity, revenue_paisa: a.revenue }));
      const products = await db.select().from(schema.products).where(eq(schema.products.storeId, store.id));
      const lowStock = products
        .filter((p) => p.stock <= (p.lowStockThreshold ?? 5))
        .sort((a, b) => a.stock - b.stock)
        .slice(0, 10)
        .map((p) => ({ id: p.id, name: p.name, stock: p.stock }));
      const customers = new Set(orders.map((o) => o.userId ?? `phone:${o.phone}`));
      const productIds = products.map((p) => p.id);
      const revs = productIds.length ? await db.select().from(schema.reviews).where(inArray(schema.reviews.productId, productIds)) : [];
      const byDay = new Map<string, number>();
      for (let i = 29; i >= 0; i--) byDay.set(dayKey(new Date(Date.now() - i * 86400 * 1000)), 0);
      for (const o of recent) {
        const k = dayKey(o.createdAt);
        byDay.set(k, (byDay.get(k) ?? 0) + o.totalPaisa);
      }
      return {
        revenue_paisa_30d: recent.reduce((n, o) => n + o.totalPaisa, 0),
        orders_30d: recent.length,
        orders_by_status: ordersByStatus,
        top_products: topProducts,
        low_stock: lowStock,
        total_customers: customers.size,
        avg_rating: revs.length ? revs.reduce((n, r) => n + r.rating, 0) / revs.length : null,
        revenue_by_day: [...byDay.entries()].map(([day, revenue_paisa]) => ({ day, revenue_paisa })),
      };
    },
  }),

  // ---------- phase 2: admin ----------
  adminAnalytics: defineAction({
    request: z.object({ authToken: authTokenField }),
    response: z.object({
      revenue_by_day: z.array(z.object({ day: z.string(), revenue_paisa: z.number() })),
      orders_by_status: z.record(z.string(), z.number()),
      conversion_pct: z.number(),
      aov_paisa: z.number(),
      top_products: z.array(z.object({ id: z.number(), name: z.string(), quantity: z.number(), revenue_paisa: z.number() })),
      top_categories: z.array(z.object({ category: z.string(), revenue_paisa: z.number() })),
      top_searches: z.array(z.object({ query: z.string(), count: z.number() })),
      low_stock_products: z.array(z.object({ id: z.number(), name: z.string(), stock: z.number(), store_name: z.string() })),
    }),
    async handler(ctx, args) {
      await requireAuth(ctx, args.authToken, "admin");
      const db = ctx.db<typeof schema>();
      const cutoff = Date.now() - 30 * 86400 * 1000;
      const [orders, items, views, searches, products, stores] = await Promise.all([
        db.select().from(schema.orders),
        db.select().from(schema.orderItems),
        db.select().from(schema.productViews),
        db.select().from(schema.searchEvents),
        db.select().from(schema.products),
        db.select({ id: schema.storeSettings.id, name: schema.storeSettings.storeName }).from(schema.storeSettings),
      ]);
      const billable = orders.filter((o) => o.status !== "cancelled" && o.status !== "refunded");
      const validIds = new Set(billable.map((o) => o.id));
      const recentOrders = billable.filter((o) => o.createdAt.getTime() >= cutoff);
      const recentViews = views.filter((v) => v.createdAt.getTime() >= cutoff).length;
      const ordersByStatus: Record<string, number> = {};
      for (const o of orders) ordersByStatus[o.status] = (ordersByStatus[o.status] ?? 0) + 1;
      const prodAgg = new Map<number, { name: string; quantity: number; revenue: number }>();
      const catAgg = new Map<string, number>();
      const catByProduct = new Map(products.map((p) => [p.id, p.category]));
      for (const i of items) {
        if (!validIds.has(i.orderId)) continue;
        const a = prodAgg.get(i.productId) ?? { name: i.productName, quantity: 0, revenue: 0 };
        a.quantity += i.quantity;
        a.revenue += i.quantity * i.unitPricePaisa;
        prodAgg.set(i.productId, a);
        const cat = catByProduct.get(i.productId) ?? "Other";
        catAgg.set(cat, (catAgg.get(cat) ?? 0) + i.quantity * i.unitPricePaisa);
      }
      const searchAgg = new Map<string, number>();
      for (const s of searches) {
        if (s.createdAt.getTime() < cutoff) continue;
        searchAgg.set(s.query, (searchAgg.get(s.query) ?? 0) + 1);
      }
      const storeById = new Map(stores.map((s) => [s.id, s.name]));
      const byDay = new Map<string, number>();
      for (let i = 29; i >= 0; i--) byDay.set(dayKey(new Date(Date.now() - i * 86400 * 1000)), 0);
      for (const o of recentOrders) {
        const k = dayKey(o.createdAt);
        byDay.set(k, (byDay.get(k) ?? 0) + o.totalPaisa);
      }
      const revenue30 = recentOrders.reduce((n, o) => n + o.totalPaisa, 0);
      return {
        revenue_by_day: [...byDay.entries()].map(([day, revenue_paisa]) => ({ day, revenue_paisa })),
        orders_by_status: ordersByStatus,
        conversion_pct: recentViews ? Math.round((recentOrders.length / recentViews) * 10000) / 100 : 0,
        aov_paisa: recentOrders.length ? Math.round(revenue30 / recentOrders.length) : 0,
        top_products: [...prodAgg.entries()].sort((a, b) => b[1].quantity - a[1].quantity).slice(0, 5)
          .map(([id, a]) => ({ id, name: a.name, quantity: a.quantity, revenue_paisa: a.revenue })),
        top_categories: [...catAgg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
          .map(([category, revenue_paisa]) => ({ category, revenue_paisa })),
        top_searches: [...searchAgg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
          .map(([query, count]) => ({ query, count })),
        low_stock_products: products
          .filter((p) => p.stock <= (p.lowStockThreshold ?? 5))
          .sort((a, b) => a.stock - b.stock)
          .slice(0, 8)
          .map((p) => ({ id: p.id, name: p.name, stock: p.stock, store_name: storeById.get(p.storeId) ?? "Seller" })),
      };
    },
  }),
  adminListCategories: defineAction({
    request: z.object({ authToken: authTokenField }),
    response: z.object({ categories: z.array(z.object({ id: z.number(), name: z.string(), slug: z.string(), is_active: z.boolean() })) }),
    async handler(ctx, args) {
      await requireAuth(ctx, args.authToken, "admin");
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.categories).orderBy(schema.categories.name);
      return { categories: rows.map((c) => ({ id: c.id, name: c.name, slug: c.slug, is_active: c.isActive })) };
    },
  }),
  adminSaveCategory: defineAction({
    request: z.object({ authToken: authTokenField, id: z.number().int().positive().optional(), name: z.string().trim().min(2).max(40), is_active: z.boolean().optional() }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      await requireAuth(ctx, args.authToken, "admin");
      const name = args.name.trim();
      const slug = name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
      if (!slug) throw new Error("That category name cannot be used.");
      const db = ctx.db<typeof schema>();
      const clash = (await db.select({ id: schema.categories.id }).from(schema.categories).where(eq(schema.categories.slug, slug)).limit(1))[0];
      if (clash && clash.id !== args.id) throw new Error(`The category "${name}" already exists.`);
      if (args.id) {
        const existing = (await db.select({ id: schema.categories.id }).from(schema.categories).where(eq(schema.categories.id, args.id)).limit(1))[0];
        if (!existing) throw new Error("Category not found.");
        await db.update(schema.categories).set({ name, slug, isActive: args.is_active ?? true }).where(eq(schema.categories.id, args.id));
        ctx.invalidateQueries();
        return { id: args.id };
      }
      const result = await db.insert(schema.categories).values({ name, slug, isActive: args.is_active ?? true }).returning({ id: schema.categories.id });
      const row = result[0];
      if (!row) throw new Error("The category could not be saved.");
      ctx.invalidateQueries();
      return { id: row.id };
    },
  }),
  adminDeleteCategory: defineAction({
    request: z.object({ authToken: authTokenField, id: z.number().int().positive() }), response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      await requireAuth(ctx, args.authToken, "admin");
      const db = ctx.db<typeof schema>();
      const category = (await db.select().from(schema.categories).where(eq(schema.categories.id, args.id)).limit(1))[0];
      if (!category) throw new Error("Category not found.");
      const inUse = (await db.select({ id: schema.products.id }).from(schema.products).where(eq(schema.products.category, category.name)).limit(1)).length;
      if (inUse) throw new Error(`Cannot delete "${category.name}": products still use this category.`);
      await db.delete(schema.categories).where(eq(schema.categories.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),
  adminListBanners: defineAction({
    request: z.object({ authToken: authTokenField }),
    response: z.object({ banners: z.array(z.object({ id: z.number(), title: z.string(), subtitle: z.string().nullable(), link: z.string().nullable(), is_active: z.boolean(), sort_order: z.number() })) }),
    async handler(ctx, args) {
      await requireAuth(ctx, args.authToken, "admin");
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.homepageBanners).orderBy(schema.homepageBanners.sortOrder);
      return { banners: rows.map((b) => ({ id: b.id, title: b.title, subtitle: b.subtitle, link: b.link, is_active: b.isActive, sort_order: b.sortOrder })) };
    },
  }),
  adminSaveBanner: defineAction({
    request: z.object({ authToken: authTokenField, id: z.number().int().positive().optional(), title: z.string().trim().min(2).max(80), subtitle: z.string().trim().max(160).nullable().optional(), link: z.string().trim().max(200).nullable().optional(), is_active: z.boolean().optional(), sort_order: z.number().int().min(0).max(1000).optional() }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      await requireAuth(ctx, args.authToken, "admin");
      const db = ctx.db<typeof schema>();
      const values = { title: args.title.trim(), subtitle: args.subtitle?.trim() || null, link: args.link?.trim() || null, isActive: args.is_active ?? true, sortOrder: args.sort_order ?? 0 };
      if (args.id) {
        const existing = (await db.select({ id: schema.homepageBanners.id }).from(schema.homepageBanners).where(eq(schema.homepageBanners.id, args.id)).limit(1))[0];
        if (!existing) throw new Error("Banner not found.");
        await db.update(schema.homepageBanners).set(values).where(eq(schema.homepageBanners.id, args.id));
        ctx.invalidateQueries();
        return { id: args.id };
      }
      const result = await db.insert(schema.homepageBanners).values(values).returning({ id: schema.homepageBanners.id });
      const row = result[0];
      if (!row) throw new Error("The banner could not be saved.");
      ctx.invalidateQueries();
      return { id: row.id };
    },
  }),
  adminDeleteBanner: defineAction({
    request: z.object({ authToken: authTokenField, id: z.number().int().positive() }), response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      await requireAuth(ctx, args.authToken, "admin");
      const db = ctx.db<typeof schema>();
      await db.delete(schema.homepageBanners).where(eq(schema.homepageBanners.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),
  adminListSections: defineAction({
    request: z.object({ authToken: authTokenField }),
    response: z.object({ sections: z.array(z.object({ key: z.string(), title: z.string(), is_active: z.boolean(), sort_order: z.number() })) }),
    async handler(ctx, args) {
      await requireAuth(ctx, args.authToken, "admin");
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.homepageSections).orderBy(schema.homepageSections.sortOrder);
      return { sections: rows.map((s) => ({ key: s.key, title: s.title, is_active: s.isActive, sort_order: s.sortOrder })) };
    },
  }),
  adminSaveSection: defineAction({
    request: z.object({ authToken: authTokenField, key: z.enum(["trending", "new_arrivals", "best_sellers", "flash_deals", "recommended"]), title: z.string().trim().min(2).max(60), is_active: z.boolean(), sort_order: z.number().int().min(0).max(100) }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      await requireAuth(ctx, args.authToken, "admin");
      const db = ctx.db<typeof schema>();
      await db.insert(schema.homepageSections).values({ key: args.key, title: args.title.trim(), isActive: args.is_active, sortOrder: args.sort_order })
        .onConflictDoUpdate({ target: schema.homepageSections.key, set: { title: args.title.trim(), isActive: args.is_active, sortOrder: args.sort_order } });
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),
  adminListTickets: defineAction({
    request: z.object({ authToken: authTokenField, status: z.enum(["open", "answered", "closed"]).optional() }),
    response: z.object({ tickets: z.array(z.object({ ticket_code: z.string(), name: z.string(), contact: z.string(), subject: z.string(), message: z.string(), order_code: z.string().nullable(), status: z.enum(["open", "answered", "closed"]), admin_reply: z.string().nullable(), created_at: z.string() })) }),
    async handler(ctx, args) {
      await requireAuth(ctx, args.authToken, "admin");
      const db = ctx.db<typeof schema>();
      const rows = args.status
        ? await db.select().from(schema.supportTickets).where(eq(schema.supportTickets.status, args.status)).orderBy(desc(schema.supportTickets.createdAt)).limit(200)
        : await db.select().from(schema.supportTickets).orderBy(desc(schema.supportTickets.createdAt)).limit(200);
      return { tickets: rows.map((t) => ({ ticket_code: t.ticketCode, name: t.name, contact: t.contact, subject: t.subject, message: t.message, order_code: t.orderCode, status: t.status, admin_reply: t.adminReply, created_at: t.createdAt.toISOString() })) };
    },
  }),
  adminReplyTicket: defineAction({
    request: z.object({ authToken: authTokenField, ticket_code: z.string().trim().min(4).max(20), reply: z.string().trim().min(1).max(1000) }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      await requireAuth(ctx, args.authToken, "admin");
      const db = ctx.db<typeof schema>();
      const ticket = (await db.select().from(schema.supportTickets).where(eq(schema.supportTickets.ticketCode, args.ticket_code.trim().toUpperCase())).limit(1))[0];
      if (!ticket) throw new Error("Ticket not found.");
      await db.update(schema.supportTickets).set({ adminReply: args.reply.trim(), status: "answered", updatedAt: new Date() }).where(eq(schema.supportTickets.id, ticket.id));
      if (ticket.userId) {
        await notifyUser(ctx, ticket.userId, { type: "ticket_reply", title: `Support replied to ${ticket.ticketCode}`, body: args.reply.trim().slice(0, 140), link: "#/support" });
      }
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),
  adminCloseTicket: defineAction({
    request: z.object({ authToken: authTokenField, ticket_code: z.string().trim().min(4).max(20) }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      await requireAuth(ctx, args.authToken, "admin");
      const db = ctx.db<typeof schema>();
      const ticket = (await db.select({ id: schema.supportTickets.id }).from(schema.supportTickets).where(eq(schema.supportTickets.ticketCode, args.ticket_code.trim().toUpperCase())).limit(1))[0];
      if (!ticket) throw new Error("Ticket not found.");
      await db.update(schema.supportTickets).set({ status: "closed", updatedAt: new Date() }).where(eq(schema.supportTickets.id, ticket.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  // ---------- phase 2: support (public) ----------
  createTicket: defineAction({
    request: z.object({ authToken: authTokenField, name: z.string().trim().min(2).max(80), contact: z.string().trim().min(5).max(40), subject: z.string().trim().min(4).max(80), message: z.string().trim().min(10).max(1000), order_code: z.string().trim().min(4).max(40).optional() }),
    response: z.object({ ticket_code: z.string() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const userId = await buyerIdOf(ctx, args.authToken);
      let ticketCode = "";
      for (let i = 0; i < 5; i++) {
        const candidate = "TKT-" + crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase();
        const exists = (await db.select({ id: schema.supportTickets.id }).from(schema.supportTickets).where(eq(schema.supportTickets.ticketCode, candidate)).limit(1))[0];
        if (!exists) {
          ticketCode = candidate;
          break;
        }
      }
      if (!ticketCode) throw new Error("Please try again in a moment.");
      await db.insert(schema.supportTickets).values({
        ticketCode, userId, name: args.name.trim(), contact: args.contact.trim(),
        subject: args.subject.trim(), message: args.message.trim(),
        orderCode: args.order_code?.trim().toUpperCase() || null,
        status: "open", createdAt: new Date(), updatedAt: new Date(),
      });
      ctx.invalidateQueries();
      return { ticket_code: ticketCode };
    },
  }),
  getMyTickets: defineAction({
    request: z.object({ authToken: authTokenField }),
    response: z.object({ tickets: z.array(z.object({ ticket_code: z.string(), subject: z.string(), message: z.string(), order_code: z.string().nullable(), status: z.enum(["open", "answered", "closed"]), admin_reply: z.string().nullable(), created_at: z.string() })) }),
    async handler(ctx, args) {
      const userId = await buyerIdOf(ctx, args.authToken);
      if (!userId) return { tickets: [] };
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.supportTickets).where(eq(schema.supportTickets.userId, userId)).orderBy(desc(schema.supportTickets.createdAt)).limit(50);
      return { tickets: rows.map((t) => ({ ticket_code: t.ticketCode, subject: t.subject, message: t.message, order_code: t.orderCode, status: t.status, admin_reply: t.adminReply, created_at: t.createdAt.toISOString() })) };
    },
  }),
} satisfies ActionsModule;
