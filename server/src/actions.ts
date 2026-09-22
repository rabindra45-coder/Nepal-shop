import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { and, count, desc, eq, gte, inArray, isNull, like, lt, ne, or } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import * as schema from "./schema";
import { formatRs, levenshtein, runAssistant } from "./assistant";
import { recommendForProduct } from "./recommender";
import { buildEsewaParams, esewaConfig, esewaFormUrl, esewaTransactionStatus, initiateKhalti, lookupKhalti, verifyEsewaSignature } from "./payments";
import {
  adminAlertEmail, adminEmailAddress, buyerVerificationEmail, buyerWelcomeEmail,
  capturedEmails, clearCapturedEmails, commissionChangeEmail, emailConfigured, lowStockEmail,
  orderCancelledBuyerEmail, orderCancelledSellerEmail, orderConfirmationEmail, orderEmail,
  paymentFailedEmail, paymentReceivedEmail, productModerationEmail, resetPasswordEmail,
  returnRequestedBuyerEmail, sellerAccountStatusEmail, sellerNewOrderEmail, sellerVerificationEmail,
  sendEmail, shipmentEmail,
  type LowStockItem, type OrderLineSummary, type SellerAccountEvent, type ShipmentEvent,
} from "./email";

// Append-only audit trail for sensitive operations. Reads never throw: if
// the audit write fails the underlying operation has already succeeded, so
// we log to stderr instead of rolling back the user's action.
async function audit(ctx: Ctx, actorType: string, actorId: string, action: string, entityType = "", entityId = "", detail = "") {
  try {
    const db = ctx.db<typeof schema>();
    await db.insert(schema.auditLogs).values({ actorType, actorId, action, entityType, entityId, detail, createdAt: new Date() });
  } catch (e) {
    console.error(`[audit] failed to record ${action}:`, e instanceof Error ? e.message : e);
  }
}

// Delete every session for a user except (optionally) the one they are using
// right now. Used after password changes and resets.
async function revokeOtherSessions(ctx: Ctx, userType: "buyer" | "seller" | "admin", userId: string, exceptToken?: string) {
  const db = ctx.db<typeof schema>();
  if (exceptToken) {
    const rows = await db.select({ token: schema.sessions.token }).from(schema.sessions)
      .where(and(eq(schema.sessions.userType, userType), eq(schema.sessions.userId, userId)));
    for (const r of rows) {
      if (r.token !== exceptToken) await db.delete(schema.sessions).where(eq(schema.sessions.token, r.token));
    }
  } else {
    await db.delete(schema.sessions).where(and(eq(schema.sessions.userType, userType), eq(schema.sessions.userId, userId)));
  }
}

const sellerCode = z.string().trim().min(6).max(40);
const keyField = z.string().min(8).max(120);
const passwordField = z.string().min(8).max(120);
const emailField = z.string().trim().toLowerCase().email().max(120);
const authTokenField = z.string().min(8).max(120).optional();
const authTokenRequired = z.string().min(8).max(120);
const sellerAuthFields = {
  authToken: authTokenField,
  seller_code: sellerCode.optional(),
  seller_key: keyField.optional(),
};
const imageUrlField = z.string().trim().max(500).refine((u) => /^https?:\/\/.+/.test(u), "Image URL must start with http:// or https://.");
// Store logo/banner URLs: only paths produced by POST /api/store-uploads
// (store-<uuid>.<ext> under /uploads/). External or hand-typed URLs are
// never accepted — the studio uploader is the only way in.
const storeAssetUrlField = z.string().trim().max(120).regex(/^\/uploads\/store-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|gif)$/, "Store images must be uploaded through the studio uploader.");
// Homepage advertisement images: only paths produced by POST
// /api/banner-uploads (banner-<uuid>.<ext> under /uploads/). External or
// hand-typed URLs are never accepted — the advertisement uploader is the
// only way in, exactly like store assets above.
// Advertisement link: hash routes (#/…) or http(s) URLs only. The link is
// rendered as <a href> on the public homepage, so javascript: and other
// schemes must never reach it (stored-XSS hardening, checkpoint 20).
const bannerImageUrlField = z.string().trim().max(120).regex(/^\/uploads\/banner-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|gif)$/, "Advertisement images must be uploaded through the advertisement uploader.");
const bannerLinkField = z.string().trim().max(200).refine((u) => /^(#\/|https?:\/\/)/.test(u), "Advertisement link must be a #/ route or an http(s) URL.");

// Remove a locally-uploaded file created by the self-hosted server. Only
// touches files we created inside UPLOADS_DIR (banner-<uuid>, store-<uuid>
// or a bare product-photo <uuid>, each with a whitelisted image extension);
// anything else is left alone.
function deleteUploadFile(url: string | null | undefined): void {
  if (!url) return;
  const fname = url.split("/").pop() ?? "";
  if (!/^((banner|store)-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|gif)$/.test(fname)) return;
  const dir = resolve(process.env.UPLOADS_DIR ?? "./data/uploads");
  void unlink(join(dir, fname)).catch(() => { /* already gone */ });
}

const productShape = z.object({ id: z.number(), store_id: z.number(), seller_code: z.string(), store_name: z.string(), store_location: z.string(), name: z.string(), category: z.string(), description: z.string(), price_paisa: z.number(), delivery_fee_paisa: z.number(), stock: z.number(), is_active: z.boolean(), rating: z.number().nullable(), review_count: z.number(), created_at: z.string(), brand: z.string().nullable(), original_price_paisa: z.number().nullable(), discount_pct: z.number(), image_url: z.string().nullable(), images: z.array(z.string()), low_stock: z.boolean(), sku: z.string().nullable() });
// Customer-facing variant (size, colour, …). Only active variants of public
// products are ever exposed; the seller studio (Seller checkpoint) manages them.
const variantShape = z.object({ id: z.number(), label: z.string(), sku: z.string().nullable(), price_paisa: z.number().nullable(), stock: z.number(), is_active: z.boolean() });
const variantIdField = z.number().int().min(0).optional().default(0);
// A product specification row (label/value pair) for the public spec sheet.
const specShape = z.object({ id: z.number(), label: z.string(), value: z.string() });
// Cart / order line variant info. variant_id 0 = the base product.
const cartLineShape = z.object({ product_id: z.number(), quantity: z.number(), variant_id: z.number(), variant_label: z.string().nullable(), unit_price_paisa: z.number(), stock: z.number(), product: productShape });
const cartShape = z.object({ items: z.array(cartLineShape), subtotal_paisa: z.number() });
const paymentMethodEnum = z.enum(["cod", "esewa", "khalti"]);
const paymentStatusEnum = z.enum(["pending", "processing", "paid", "failed", "refunded", "cancelled"]);
// Group-level payment headline: like paymentStatusEnum plus
// "partially_refunded" for groups whose fulfilments settled unevenly.
const groupPaymentStatusEnum = z.enum(["pending", "processing", "paid", "failed", "refunded", "cancelled", "partially_refunded"]);
const orderStatus = z.enum(["confirmation_needed", "confirmed", "packed", "shipped", "out_for_delivery", "delivery_failed", "delivered", "return_requested", "returned", "refunded", "cancelled"]);
const deliveryMethodEnum = z.enum(["standard", "express", "pickup"]);
const orderShape = z.object({ id: z.number(), order_code: z.string(), customer_name: z.string(), phone: z.string(), address: z.string(), note: z.string(), subtotal_paisa: z.number(), delivery_fee_paisa: z.number(), total_paisa: z.number(), payment_method: paymentMethodEnum, payment_status: paymentStatusEnum, discount_paisa: z.number(), coupon_code: z.string().nullable(), delivery_method: deliveryMethodEnum, status: orderStatus, created_at: z.string(), tracking_number: z.string().nullable(), carrier: z.string().nullable(), delivered_at: z.string().nullable(), return_reason: z.string().nullable(), refund_status: z.enum(["not_required", "pending", "completed", "failed"]).nullable(), items: z.array(z.object({ id: z.number(), product_id: z.number(), product_name: z.string(), quantity: z.number(), unit_price_paisa: z.number(), variant_id: z.number(), variant_label: z.string().nullable() })), group_id: z.number().nullable().optional(), group_code: z.string().nullable().optional() });
// One customer checkout -> one group row + one fulfilment order per seller.
// The customer tracks the group_code; each seller only sees their own
// fulfilment order (via the existing storeId-scoped listOrders).
const orderGroupShape = z.object({ id: z.number(), group_code: z.string(), customer_name: z.string(), phone: z.string(), address: z.string(), note: z.string(), subtotal_paisa: z.number(), delivery_fee_paisa: z.number(), discount_paisa: z.number(), total_paisa: z.number(), payment_method: paymentMethodEnum, payment_status: groupPaymentStatusEnum, delivery_method: deliveryMethodEnum, coupon_code: z.string().nullable(), created_at: z.string(), orders: z.array(orderShape.extend({ store_name: z.string() })) });
// Internal view: the buyer's user id is needed for ownership checks and
// notifications but must never leave the server — public responses use
// orderGroupShape (no user_id).
type OrderGroupView = z.infer<typeof orderGroupShape> & { user_id: string | null };
function publicGroupView(view: OrderGroupView): z.infer<typeof orderGroupShape> {
  const { user_id: _userId, ...rest } = view;
  return rest;
}
const stockReasonEnum = z.enum(["order_placed", "order_cancelled", "return_accepted", "manual_adjust", "product_created", "variant_created"]);
const stockMovementShape = z.object({ id: z.number(), product_id: z.number(), product_name: z.string(), variant_id: z.number(), variant_label: z.string().nullable(), change: z.number(), stock_after: z.number(), reason: stockReasonEnum, order_id: z.number().nullable(), order_code: z.string().nullable(), actor_type: z.string(), created_at: z.string() });
// Seller verification lifecycle: pending -> under_review -> active, with
// suspended / rejected as terminal-ish blocked states. Only "active" sellers
// can publish products; suspended/rejected sellers cannot sell at all.
const sellerStatus = z.enum(["pending", "under_review", "active", "suspended", "rejected"]);
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
  if (!store) throw new Error("Seller code or access key is incorrect.");
  // Prefer the bcrypt hash (v7+). A legacy unsalted SHA-256 hash is still
  // accepted once, then transparently upgraded to bcrypt.
  if (store.adminKeyHashBcrypt) {
    if (!await Bun.password.verify(key, store.adminKeyHashBcrypt)) throw new Error("Seller code or access key is incorrect.");
    return store;
  }
  if (!store.adminKeyHash || store.adminKeyHash !== await hashKey(key)) throw new Error("Seller code or access key is incorrect.");
  await db.update(schema.storeSettings)
    .set({ adminKeyHashBcrypt: await Bun.password.hash(key, { algorithm: "bcrypt", cost: 10 }), updatedAt: new Date() })
    .where(eq(schema.storeSettings.id, store.id));
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

// Selling guard (Seller checkpoint). Suspended and rejected sellers are
// blocked from every product/store write; pending and under_review sellers
// may only work on drafts — nothing they do can become publicly visible
// (public listings additionally require an "active" store, see
// activeStoreIds).
function assertSellerCanSell(store: typeof schema.storeSettings.$inferSelect) {
  if (store.status === "suspended") throw new Error("This shop is suspended and cannot sell right now. Please contact support.");
  if (store.status === "rejected") throw new Error("This seller application was not approved. Please contact support.");
}

// SKUs are optional, but when present they are normalised to uppercase and
// must be unique within the seller's store (products) or product (variants).
function normalizeSku(raw: string | undefined | null): string | null {
  const sku = raw?.trim().toUpperCase() ?? "";
  if (!sku) return null;
  if (!/^[A-Z0-9][A-Z0-9._-]{0,39}$/.test(sku)) {
    throw new Error("The SKU may only use letters, numbers, dots, dashes and underscores (max 40 characters).");
  }
  return sku;
}

// Per-order extras that live in sibling tables (return reason, refund
// state): fetched once per listing and passed into mapOrder so the shape
// stays a single object per order.
export interface OrderExtras { return_reason?: string | null; refund_status?: "not_required" | "pending" | "completed" | "failed" | null }

function mapOrder(o: typeof schema.orders.$inferSelect, items: (typeof schema.orderItems.$inferSelect)[], groupCode?: string | null, extra?: OrderExtras) {
  return { id: o.id, order_code: o.orderCode, customer_name: o.customerName, phone: o.phone, address: o.address, note: o.note, subtotal_paisa: o.subtotalPaisa, delivery_fee_paisa: o.deliveryFeePaisa, total_paisa: o.totalPaisa, payment_method: o.paymentMethod, payment_status: o.paymentStatus, discount_paisa: o.discountPaisa, coupon_code: o.couponCode, delivery_method: o.deliveryMethod, status: o.status, created_at: o.createdAt.toISOString(), tracking_number: o.trackingNumber ?? null, carrier: o.carrier ?? null, delivered_at: o.deliveredAt ? o.deliveredAt.toISOString() : null, return_reason: extra?.return_reason ?? null, refund_status: extra?.refund_status ?? null, group_id: o.groupId ?? null, group_code: groupCode ?? null, items: items.filter((i) => i.orderId === o.id).map((i) => ({ id: i.id, product_id: i.productId, product_name: i.productName, quantity: i.quantity, unit_price_paisa: i.unitPricePaisa, variant_id: i.variantId ?? 0, variant_label: i.variantLabel ?? null })) };
}

// Batch-load return/refund extras for a set of fulfilment order ids.
async function orderExtras(ctx: Ctx, orderIds: number[]): Promise<Map<number, OrderExtras>> {
  const out = new Map<number, OrderExtras>();
  if (!orderIds.length) return out;
  const db = ctx.db<typeof schema>();
  const [reasons, refunds] = await Promise.all([
    db.select({ orderId: schema.returnRequests.orderId, reason: schema.returnRequests.reason }).from(schema.returnRequests).where(inArray(schema.returnRequests.orderId, orderIds)),
    db.select({ orderId: schema.refunds.orderId, status: schema.refunds.status }).from(schema.refunds).where(inArray(schema.refunds.orderId, orderIds)),
  ]);
  for (const r of reasons) out.set(r.orderId, { ...out.get(r.orderId), return_reason: r.reason });
  for (const r of refunds) out.set(r.orderId, { ...out.get(r.orderId), refund_status: r.status });
  return out;
}

// ---------- platform shipping settings ----------
// Admin-configurable shipping methods and rates. Keys live in the
// platform_settings table; absent keys fall back to the built-ins below so
// a fresh database behaves sanely before an admin touches them. There is
// no courier integration: sellers hand parcels to their own couriers and
// record the carrier + tracking number on the order.
const SHIPPING_DEFAULTS = { express_fee_paisa: 12000, standard_enabled: true, express_enabled: true, pickup_enabled: true };
export interface ShippingConfig { express_fee_paisa: number; standard_enabled: boolean; express_enabled: boolean; pickup_enabled: boolean }
async function shippingConfig(ctx: Ctx): Promise<ShippingConfig> {
  const db = ctx.db<typeof schema>();
  const rows = await db.select().from(schema.platformSettings);
  const get = (k: string) => rows.find((r) => r.key === k)?.value;
  const bool = (v: string | undefined, dflt: boolean) => (v == null ? dflt : v === "1" || v.toLowerCase() === "true");
  const fee = Number(get("shipping_express_fee_paisa"));
  return {
    express_fee_paisa: Number.isFinite(fee) && fee >= 0 && fee <= 10000000 ? Math.round(fee) : SHIPPING_DEFAULTS.express_fee_paisa,
    standard_enabled: bool(get("shipping_standard_enabled"), true),
    express_enabled: bool(get("shipping_express_enabled"), true),
    pickup_enabled: bool(get("shipping_pickup_enabled"), true),
  };
}

// Best-effort email to a buyer (when they have an email on file) or to a
// seller's store contact. When SMTP is unconfigured sendEmail logs honestly
// and reports { sent: false } — callers never fake delivery. Email sending
// never throws: a failed send is logged and the flow continues, so email
// can never break checkout, payment or any other user journey.
//
// emailBuyer honours the buyer's "order update emails" preference — these are
// the routine order/payment/shipping/return/refund mails. Security mails
// (password reset, email verification) bypass the preference and go through
// sendEmail directly.
async function buyerContact(ctx: Ctx, userId: string | null): Promise<{ email: string; name: string; notify: boolean } | null> {
  if (!userId) return null;
  const db = ctx.db<typeof schema>();
  const user = (await db.select({ email: schema.users.email, name: schema.users.name, notify: schema.users.notifyOrderEmails }).from(schema.users).where(eq(schema.users.id, userId)).limit(1))[0];
  if (!user?.email) return null;
  return { email: user.email, name: user.name, notify: user.notify !== false };
}
async function sellerContact(ctx: Ctx, storeId: number): Promise<{ email: string; name: string } | null> {
  const db = ctx.db<typeof schema>();
  const store = (await db.select({ email: schema.storeSettings.email, name: schema.storeSettings.storeName }).from(schema.storeSettings).where(eq(schema.storeSettings.id, storeId)).limit(1))[0];
  if (!store?.email) return null;
  return { email: store.email, name: store.name };
}
async function emailBuyer(ctx: Ctx, userId: string | null, subject: string, body: string): Promise<void> {
  const c = await buyerContact(ctx, userId);
  if (!c) return;
  if (!c.notify) {
    console.log(`[email] order-update email to ${c.email} ("${subject}") skipped — buyer opted out`);
    return;
  }
  await sendEmail(orderEmail(c.email, subject, `Hello ${c.name},\n\n${body}`));
}
// Same preference rules as emailBuyer, but the caller builds the full
// message from a template (orderConfirmationEmail, shipmentEmail, …).
async function emailBuyerMsg(ctx: Ctx, userId: string | null, build: (to: string, name: string) => import("./email").EmailMessage): Promise<void> {
  const c = await buyerContact(ctx, userId);
  if (!c) return;
  if (!c.notify) {
    console.log(`[email] order-update email to ${c.email} skipped — buyer opted out`);
    return;
  }
  await sendEmail(build(c.email, c.name));
}
async function emailSeller(ctx: Ctx, storeId: number, subject: string, body: string): Promise<void> {
  const c = await sellerContact(ctx, storeId);
  if (!c) return;
  await sendEmail(orderEmail(c.email, subject, `Hello ${c.name},\n\n${body}`));
}
async function emailSellerMsg(ctx: Ctx, storeId: number, build: (to: string, storeName: string) => import("./email").EmailMessage): Promise<void> {
  const c = await sellerContact(ctx, storeId);
  if (!c) return;
  await sendEmail(build(c.email, c.name));
}
// Platform alert to the admin address (ADMIN_EMAIL env). Honest no-op when
// unset. Exported so selfhost.ts can report sweeper failures.
export async function notifyAdmin(subject: string, body: string): Promise<void> {
  const to = adminEmailAddress();
  if (!to) {
    console.warn(`[email] ADMIN_EMAIL not set — admin alert not sent ("${subject}")`);
    return;
  }
  await sendEmail(adminAlertEmail(to, subject, body));
}

// Normalise a phone number for guest identity (coupon per-user limits and
// idempotency-adjacent checks): strip everything but digits.
function normalizePhone(raw: string): string {
  return raw.replace(/\D/g, "");
}

type GroupPaymentStatus = "pending" | "processing" | "paid" | "failed" | "refunded" | "cancelled" | "partially_refunded";

// Headline payment status for an order group, derived from its fulfilment
// orders. An open (non-terminal) state always wins the headline so the
// customer sees what still needs doing; a mix of paid and refunded
// fulfilments is reported honestly as partially refunded. Terminal states
// of individual fulfilments are never rewritten by this derivation.
function aggregatePaymentStatus(statuses: string[]): GroupPaymentStatus {
  const uniq = [...new Set(statuses)];
  if (uniq.length === 1) return uniq[0] as GroupPaymentStatus;
  const terminal = new Set(["paid", "refunded", "cancelled"]);
  const open = uniq.filter((s) => !terminal.has(s));
  if (open.length) {
    if (open.includes("failed")) return "failed";
    if (open.includes("processing")) return "processing";
    return "pending";
  }
  if (uniq.includes("refunded")) return "partially_refunded";
  if (uniq.includes("cancelled")) return "cancelled";
  return "paid";
}

// Full customer/admin view of an order group: the group row plus every
// fulfilment order (with items) and the selling store's name on each.
async function loadOrderGroup(ctx: Ctx, groupId: number): Promise<OrderGroupView | null> {
  const db = ctx.db<typeof schema>();
  const group = (await db.select().from(schema.orderGroups).where(eq(schema.orderGroups.id, groupId)).limit(1))[0];
  if (!group) return null;
  const subOrders = await db.select().from(schema.orders).where(eq(schema.orders.groupId, groupId)).orderBy(schema.orders.id);
  const items = subOrders.length ? await db.select().from(schema.orderItems).where(inArray(schema.orderItems.orderId, subOrders.map((o) => o.id))) : [];
  const storeIds = [...new Set(subOrders.map((o) => o.storeId))];
  const stores = storeIds.length ? await db.select({ id: schema.storeSettings.id, name: schema.storeSettings.storeName }).from(schema.storeSettings).where(inArray(schema.storeSettings.id, storeIds)) : [];
  const storeName = (id: number) => stores.find((s) => s.id === id)?.name ?? "Seller";
  const extras = await orderExtras(ctx, subOrders.map((o) => o.id));
  return {
    id: group.id, group_code: group.groupCode, customer_name: group.customerName, phone: group.phone,
    address: group.address, note: group.note ?? "",
    subtotal_paisa: group.subtotalPaisa, delivery_fee_paisa: group.deliveryFeePaisa,
    discount_paisa: group.discountPaisa, total_paisa: group.totalPaisa,
    payment_method: group.paymentMethod, payment_status: aggregatePaymentStatus(subOrders.map((o) => o.paymentStatus)),
    delivery_method: group.deliveryMethod, coupon_code: group.couponCode ?? null,
    user_id: group.userId, created_at: group.createdAt.toISOString(),
    orders: subOrders.map((o) => ({ ...mapOrder(o, items, group.groupCode, extras.get(o.id)), store_name: storeName(o.storeId) })),
  };
}

// Shape returned by placeOrder (and by idempotent replays of it).
function groupResponseOf(view: NonNullable<Awaited<ReturnType<typeof loadOrderGroup>>>) {
  const first = view.orders[0];
  if (!first) throw new Error("The order could not be created.");
  return {
    group_code: view.group_code, group_id: view.id, total_paisa: view.total_paisa,
    payment_method: view.payment_method, payment_status: view.payment_status,
    orders: view.orders.map((o) => ({ order_id: o.id, order_code: o.order_code, store_name: o.store_name, total_paisa: o.total_paisa })),
    // Kept for older clients: the first fulfilment order (the only one for
    // single-seller checkouts).
    order_code: first.order_code, order_id: first.id, status: "confirmation_needed" as const,
  };
}

// Atomic coupon redemption, called INSIDE the placeOrder transaction.
// Re-reads the coupon and counts existing usages inside the transaction, so
// two checkouts racing each other cannot both slip under maxUses or the
// per-user limit: SQLite serialises the write transactions, and the second
// one sees the first one's committed usage row before inserting its own.
function redeemCouponTx(tx: DbTx, couponId: number, identity: { userId: string | null; guestPhone: string | null }, subtotalPaisa: number): { discount: number; freeShipping: boolean; code: string } {
  const coupon = tx.select().from(schema.coupons).where(eq(schema.coupons.id, couponId)).limit(1).prepare().get();
  if (!coupon) throw new Error("This coupon is no longer available.");
  if (!coupon.isActive) throw new Error("This coupon is no longer active.");
  if (coupon.expiresAt && coupon.expiresAt.getTime() < Date.now()) throw new Error("This coupon has expired.");
  if (subtotalPaisa < coupon.minOrderPaisa) throw new Error(`This coupon needs a minimum order of ${formatRs(coupon.minOrderPaisa)}.`);
  if (coupon.maxUses != null) {
    const uses = tx.select({ id: schema.couponUsages.id }).from(schema.couponUsages).where(eq(schema.couponUsages.couponId, coupon.id)).prepare().all();
    if (uses.length >= coupon.maxUses) throw new Error("This coupon has reached its usage limit.");
  }
  if (coupon.perUserLimit > 0) {
    // Signed-in buyers are limited by account; guests — who have no account
    // — are limited by the phone number they checked out with. Both are
    // counted inside the transaction, closing the guest bypass and the
    // concurrent-checkout race at once.
    const mine = identity.userId
      ? tx.select({ id: schema.couponUsages.id }).from(schema.couponUsages).where(and(eq(schema.couponUsages.couponId, coupon.id), eq(schema.couponUsages.userId, identity.userId))).prepare().all()
      : tx.select({ id: schema.couponUsages.id }).from(schema.couponUsages).where(and(eq(schema.couponUsages.couponId, coupon.id), eq(schema.couponUsages.guestPhone, identity.guestPhone ?? ""))).prepare().all();
    if (mine.length >= coupon.perUserLimit) throw new Error("This coupon has already been used the maximum number of times for this account.");
  }
  const freeShipping = coupon.kind === "free_shipping";
  let discount = coupon.kind === "percent" ? Math.round(subtotalPaisa * coupon.value / 100) : coupon.kind === "fixed" ? Math.min(coupon.value, subtotalPaisa) : 0;
  // A percent coupon can carry a maximum-discount ceiling so a high order
  // value never turns a marketing coupon into a loss-maker.
  if (coupon.kind === "percent" && coupon.maxDiscountPaisa != null) discount = Math.min(discount, coupon.maxDiscountPaisa);
  return { discount, freeShipping, code: coupon.code };
}

// Cancel a set of fulfilment orders atomically: every one must still be
// cancellable, otherwise nothing changes. Stock is restored per fulfilment
// and unsettled payments voided, mirroring the old single-order path.
function cancelFulfilmentsTx(tx: DbTx, orderIds: number[], actorType: string, actorId: string): void {
  const now = new Date();
  for (const oid of orderIds) {
    const current = tx.select().from(schema.orders).where(eq(schema.orders.id, oid)).limit(1).prepare().get();
    if (!current) throw new Error("That order was not found.");
    if (current.status !== "confirmation_needed" && current.status !== "confirmed") {
      throw new Error("This order can no longer be cancelled — a seller has already started packing it. Please contact support.");
    }
  }
  for (const oid of orderIds) {
    restoreStockTx(tx, oid, "order_cancelled", actorType, actorId);
    tx.update(schema.orders).set({ status: "cancelled", updatedAt: now }).where(eq(schema.orders.id, oid)).prepare().run();
  }
  // Void every unsettled payment attached to these fulfilments.
  const paymentRows = tx.select().from(schema.payments).where(inArray(schema.payments.orderId, orderIds)).prepare().all();
  for (const p of paymentRows) {
    if (p.status === "pending" || p.status === "processing" || p.status === "failed") {
      tx.update(schema.payments).set({ status: "cancelled", updatedAt: now }).where(eq(schema.payments.id, p.id)).prepare().run();
      tx.update(schema.orders).set({ paymentStatus: "cancelled", updatedAt: now }).where(eq(schema.orders.id, p.orderId)).prepare().run();
    }
  }
}

async function productRows(ctx: Ctx, storeId?: number) {
  const db = ctx.db<typeof schema>();
  const products = storeId
    ? await db.select().from(schema.products).where(eq(schema.products.storeId, storeId)).orderBy(desc(schema.products.createdAt))
    : await db.select().from(schema.products).orderBy(desc(schema.products.createdAt));
  const ids = products.map((p) => p.id);
  // Companion rows are fetched for exactly the products being returned —
  // never the whole reviews/images tables (sellerInventory/getStore call
  // this scoped to one store). Chunked IN lists stay under SQLite's
  // variable cap even for very large catalogues.
  const idChunks: number[][] = [];
  for (let i = 0; i < ids.length; i += 500) idChunks.push(ids.slice(i, i + 500));
  const [reviews, stores, images] = await Promise.all([
    (async () => {
      const out: (typeof schema.reviews.$inferSelect)[] = [];
      for (const c of idChunks) out.push(...await db.select().from(schema.reviews).where(inArray(schema.reviews.productId, c)));
      return out;
    })(),
    storeId
      ? await db.select().from(schema.storeSettings).where(eq(schema.storeSettings.id, storeId))
      : await db.select().from(schema.storeSettings),
    (async () => {
      const out: (typeof schema.productImages.$inferSelect)[] = [];
      for (const c of idChunks) out.push(...await db.select().from(schema.productImages).where(inArray(schema.productImages.productId, c)).orderBy(schema.productImages.sortOrder, schema.productImages.id));
      return out;
    })(),
  ]);
  const imagesByProduct = new Map<number, string[]>();
  for (const im of images) {
    const list = imagesByProduct.get(im.productId) ?? [];
    list.push(im.url);
    imagesByProduct.set(im.productId, list);
  }
  // Grouped once instead of filtering per product (was O(products x reviews)).
  const reviewsByProduct = new Map<number, (typeof schema.reviews.$inferSelect)[]>();
  for (const r of reviews) {
    const list = reviewsByProduct.get(r.productId) ?? [];
    list.push(r);
    reviewsByProduct.set(r.productId, list);
  }
  const storeById = new Map(stores.map((s) => [s.id, s]));
  return products.map((p) => {
    const rs = reviewsByProduct.get(p.id) ?? [], store = storeById.get(p.storeId);
    const original = p.originalPricePaisa;
    return { id: p.id, store_id: p.storeId, seller_code: store?.sellerCode ?? "", store_name: store?.storeName ?? "Seller", store_location: store?.location ?? "", name: p.name, category: p.category, description: p.description, price_paisa: p.pricePaisa, delivery_fee_paisa: p.deliveryFeePaisa, stock: p.stock, is_active: p.isActive, rating: rs.length ? rs.reduce((n, r) => n + r.rating, 0) / rs.length : null, review_count: rs.length, created_at: p.createdAt.toISOString(), brand: p.brand ?? null, original_price_paisa: original ?? null, discount_pct: original && original > p.pricePaisa ? Math.round((original - p.pricePaisa) / original * 100) : 0, image_url: p.imageUrl ?? null, images: imagesByProduct.get(p.id) ?? [], low_stock: p.stock > 0 && p.stock <= (p.lowStockThreshold ?? 5), sku: p.sku ?? null };
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

type VariantRow = typeof schema.productVariants.$inferSelect;

// Active variants for one product, cheapest-sort first. Only used for public
// (active product, active seller) products — callers must gate on that.
async function activeVariants(ctx: Ctx, productId: number): Promise<VariantRow[]> {
  const db = ctx.db<typeof schema>();
  return db.select().from(schema.productVariants)
    .where(and(eq(schema.productVariants.productId, productId), eq(schema.productVariants.isActive, true)))
    .orderBy(schema.productVariants.sortOrder, schema.productVariants.id);
}

type SpecRow = typeof schema.productSpecifications.$inferSelect;

// Specification rows for one product, in seller-defined order. Specs are
// public whenever the product is public — callers must gate on that.
async function activeSpecs(ctx: Ctx, productId: number): Promise<SpecRow[]> {
  const db = ctx.db<typeof schema>();
  return db.select().from(schema.productSpecifications)
    .where(eq(schema.productSpecifications.productId, productId))
    .orderBy(schema.productSpecifications.sortOrder, schema.productSpecifications.id);
}

// Validates a customer-supplied variant_id: the variant must exist, belong to
// the product and be active. Returns the row, or null for variant_id 0 (the
// base product). Throws on any mismatch — the id is never trusted blindly.
async function requireVariant(ctx: Ctx, productId: number, variantId: number): Promise<VariantRow | null> {
  if (!variantId) return null;
  const db = ctx.db<typeof schema>();
  const v = (await db.select().from(schema.productVariants).where(eq(schema.productVariants.id, variantId)).limit(1))[0];
  if (!v || v.productId !== productId || !v.isActive) throw new Error("That product option is no longer available.");
  return v;
}

// Effective unit price and sellable stock for a cart/order line. A variant
// may override the price and carries its own stock, independent of the base
// product's stock: variant_id 0 sells from product.stock, any other variant
// sells from its own stock row. Decrements and restores always touch the same
// row the availability check used.
// Vacation-mode guard: a store on a break stays visible but cannot take new
// orders until the seller switches vacation mode off.
async function assertStoreTakingOrders(ctx: Ctx, storeId: number) {
  const db = ctx.db<typeof schema>();
  const store = (await db.select({ name: schema.storeSettings.storeName, vacation: schema.storeSettings.vacationMode }).from(schema.storeSettings).where(eq(schema.storeSettings.id, storeId)).limit(1))[0];
  if (store?.vacation) throw new Error(`${store.name} is on a short break and not taking orders right now. Please check back later.`);
}

function linePricing(product: { pricePaisa: number; stock: number }, variant: VariantRow | null) {
  return { unitPrice: variant?.pricePaisa ?? product.pricePaisa, stock: variant ? variant.stock : product.stock };
}

async function notifyUser(ctx: Ctx, userId: string, n: { type: string; title: string; body: string; link?: string | null }) {
  const db = ctx.db<typeof schema>();
  await db.insert(schema.notifications).values({ userId, type: n.type, title: n.title, body: n.body, link: n.link ?? null, createdAt: new Date() });
}

// The transaction object drizzle hands to db.transaction() callbacks. Stock
// restores always run inside the same transaction as the order-status write,
// so a concurrent second cancel/return can never restore the same stock
// twice: the status guard and the restore are one atomic unit.
type DbTx = Parameters<Parameters<BunSQLiteDatabase<typeof schema>["transaction"]>[0]>[0];

type StockReason = "order_placed" | "order_cancelled" | "return_accepted" | "manual_adjust" | "product_created" | "variant_created";

// Append one row to the inventory ledger. Every stock change funnels through
// here so the trail is complete and reconcilable.
function recordMovementTx(tx: DbTx, m: {
  productId: number; variantId: number; change: number; stockAfter: number;
  reason: StockReason; orderId?: number | null; actorType?: string; actorId?: string;
}): void {
  tx.insert(schema.stockMovements).values({
    productId: m.productId, variantId: m.variantId, change: m.change,
    stockAfter: m.stockAfter, reason: m.reason, orderId: m.orderId ?? null,
    actorType: m.actorType ?? "", actorId: m.actorId ?? "", createdAt: new Date(),
  }).prepare().run();
}

// Returns reserved stock when an order is cancelled or a return is accepted.
// Mirrors placeOrder's decrement exactly: variant lines restore the variant
// row, base lines restore the product row. MUST be called inside the same
// transaction as the order-status update.
function restoreStockTx(tx: DbTx, orderId: number, reason: "order_cancelled" | "return_accepted", actorType: string, actorId: string): void {
  const items = tx.select().from(schema.orderItems).where(eq(schema.orderItems.orderId, orderId)).prepare().all();
  for (const item of items) {
    if (item.variantId) {
      const v = tx.select().from(schema.productVariants).where(eq(schema.productVariants.id, item.variantId)).limit(1).prepare().get();
      if (!v) continue;
      const after = v.stock + item.quantity;
      tx.update(schema.productVariants).set({ stock: after }).where(eq(schema.productVariants.id, v.id)).prepare().run();
      recordMovementTx(tx, { productId: item.productId, variantId: v.id, change: item.quantity, stockAfter: after, reason, orderId, actorType, actorId });
    } else {
      const product = tx.select().from(schema.products).where(eq(schema.products.id, item.productId)).limit(1).prepare().get();
      if (!product) continue;
      const after = product.stock + item.quantity;
      tx.update(schema.products).set({ stock: after, updatedAt: new Date() }).where(eq(schema.products.id, product.id)).prepare().run();
      recordMovementTx(tx, { productId: item.productId, variantId: 0, change: item.quantity, stockAfter: after, reason, orderId, actorType, actorId });
    }
  }
}

// Reads the newest movement rows for a set of product ids (already scoped to
// the caller's shop), enriched with product names, variant labels and order
// codes for display.
async function loadMovements(ctx: Ctx, productIds: number[], limit: number) {
  const db = ctx.db<typeof schema>();
  const rows = await db.select().from(schema.stockMovements)
    .where(inArray(schema.stockMovements.productId, productIds))
    .orderBy(desc(schema.stockMovements.id)).limit(limit);
  if (!rows.length) return [];
  const products = await db.select({ id: schema.products.id, name: schema.products.name }).from(schema.products).where(inArray(schema.products.id, [...new Set(rows.map((r) => r.productId))]));
  const variantIds = [...new Set(rows.map((r) => r.variantId).filter((v) => v > 0))];
  const variants = variantIds.length ? await db.select({ id: schema.productVariants.id, label: schema.productVariants.label }).from(schema.productVariants).where(inArray(schema.productVariants.id, variantIds)) : [];
  const orderIds = [...new Set(rows.map((r) => r.orderId).filter((o): o is number => o != null))];
  const orders = orderIds.length ? await db.select({ id: schema.orders.id, code: schema.orders.orderCode }).from(schema.orders).where(inArray(schema.orders.id, orderIds)) : [];
  const productById = new Map(products.map((p) => [p.id, p.name]));
  const variantById = new Map(variants.map((v) => [v.id, v.label]));
  const orderById = new Map(orders.map((o) => [o.id, o.code]));
  return rows.map((r) => ({
    id: r.id, product_id: r.productId, product_name: productById.get(r.productId) ?? "Product",
    variant_id: r.variantId, variant_label: r.variantId ? (variantById.get(r.variantId) ?? null) : null,
    change: r.change, stock_after: r.stockAfter, reason: r.reason,
    order_id: r.orderId ?? null, order_code: r.orderId != null ? (orderById.get(r.orderId) ?? null) : null,
    actor_type: r.actorType, created_at: r.createdAt.toISOString(),
  }));
}

function orderStatusLabel(status: string) {
  const labels: Record<string, string> = { confirmation_needed: "awaiting confirmation", confirmed: "confirmed", packed: "packed", shipped: "shipped", out_for_delivery: "out for delivery", delivery_failed: "delivery failed", delivered: "delivered", return_requested: "return requested", returned: "returned", refunded: "refunded", cancelled: "cancelled" };
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
// (throws when a supplied code is invalid). The usage counts here are a
// preview for friendly errors; placeOrder re-enforces them atomically inside
// its transaction via redeemCouponTx.
async function evaluateCoupon(ctx: Ctx, code: string, userId: string | null, subtotalPaisa: number, guestPhone?: string | null): Promise<CouponEval> {
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
  if (coupon.perUserLimit > 0) {
    // Signed-in buyers are limited by account; guests are limited by the
    // phone number they will check out with (validateCoupon accepts it as an
    // optional preview; placeOrder enforces it authoritatively in its
    // transaction). This closes the old guest bypass where guests skipped
    // the per-user limit entirely.
    if (userId) {
      const mine = await db.select({ id: schema.couponUsages.id }).from(schema.couponUsages).where(and(eq(schema.couponUsages.couponId, coupon.id), eq(schema.couponUsages.userId, userId)));
      if (mine.length >= coupon.perUserLimit) return fail("You have already used this coupon.");
    } else if (guestPhone) {
      const phone = normalizePhone(guestPhone);
      if (phone) {
        const mine = await db.select({ id: schema.couponUsages.id }).from(schema.couponUsages).where(and(eq(schema.couponUsages.couponId, coupon.id), eq(schema.couponUsages.guestPhone, phone)));
        if (mine.length >= coupon.perUserLimit) return fail("This coupon has already been used the maximum number of times for this phone number.");
      }
    }
  }
  if (subtotalPaisa < coupon.minOrderPaisa) return fail(`This coupon needs a minimum order of ${formatRs(coupon.minOrderPaisa)}.`);
  const freeShipping = coupon.kind === "free_shipping";
  let discount = coupon.kind === "percent" ? Math.round(subtotalPaisa * coupon.value / 100) : coupon.kind === "fixed" ? Math.min(coupon.value, subtotalPaisa) : 0;
  // A percent coupon can carry a maximum-discount ceiling so a high order
  // value never turns a marketing coupon into a loss-maker.
  if (coupon.kind === "percent" && coupon.maxDiscountPaisa != null) discount = Math.min(discount, coupon.maxDiscountPaisa);
  return { valid: true, discount_paisa: discount, free_shipping: freeShipping, message: freeShipping ? "Free delivery applied." : `${formatRs(discount)} off applied.`, coupon_id: coupon.id, code: normalized };
}

function dayKey(d: Date) {
  return d.toISOString().slice(0, 10);
}

// Analytics funnel tracking (Analytics checkpoint). Records one funnel row
// per buyer action with a sensible dedupe window so refreshes, retries and
// double-taps don't inflate the numbers:
// - add_to_cart:    one per buyer+product per 30 minutes (recorded
//                   server-side inside addToCart, where the product id is
//                   validated — never trusted blindly from the client)
// - checkout_start: one per buyer per 6 hours (trackCheckoutStart)
// Purchases are derived from the orders table (the single source of truth),
// not duplicated here. Never throws: tracking must not break shopping.
async function recordFunnelEvent(
  ctx: Ctx,
  event: "add_to_cart" | "checkout_start",
  userId: string | null,
  productId?: number,
  dedupeMs = 30 * 60 * 1000,
): Promise<boolean> {
  try {
    const db = ctx.db<typeof schema>();
    const since = new Date(Date.now() - dedupeMs);
    const conds = [eq(schema.funnelEvents.event, event), gte(schema.funnelEvents.createdAt, since)];
    conds.push(userId ? eq(schema.funnelEvents.userId, userId) : isNull(schema.funnelEvents.userId));
    if (productId !== undefined) conds.push(eq(schema.funnelEvents.productId, productId));
    const existing = (await db.select({ id: schema.funnelEvents.id }).from(schema.funnelEvents)
      .where(and(...conds)).limit(1))[0];
    if (existing) return false;
    await db.insert(schema.funnelEvents).values({ event, productId: productId ?? null, userId, createdAt: new Date() });
    return true;
  } catch (e) {
    console.error(`[funnel] failed to record ${event}:`, e instanceof Error ? e.message : e);
    return false;
  }
}

// Product-view tracking with the same dedupe rule: one row per buyer+product
// per 30 minutes. Anonymous views (userId null) can't be attributed, so each
// page load is recorded — the funnel counts them honestly as raw views.
async function recordProductView(ctx: Ctx, productId: number, userId: string | null): Promise<void> {
  const db = ctx.db<typeof schema>();
  if (userId) {
    const since = new Date(Date.now() - 30 * 60 * 1000);
    const existing = (await db.select({ id: schema.productViews.id }).from(schema.productViews)
      .where(and(eq(schema.productViews.productId, productId), eq(schema.productViews.userId, userId), gte(schema.productViews.createdAt, since)))
      .limit(1))[0];
    if (existing) return;
  }
  try {
    await db.insert(schema.productViews).values({ productId, userId, createdAt: new Date() });
  } catch (e) {
    console.error("[funnel] failed to record product view:", e instanceof Error ? e.message : e);
  }
}

interface CartLine { product_id: number; quantity: number; variant_id: number; variant_label: string | null; unit_price_paisa: number; stock: number; product: PublicProduct }

// Server-side cart. Lines whose product went inactive (or whose seller was
// deactivated, or whose variant was deactivated) are dropped from the
// response and cleaned up.
async function loadCart(ctx: Ctx, userId: string | null): Promise<{ items: CartLine[]; subtotal_paisa: number }> {
  if (!userId) return { items: [], subtotal_paisa: 0 };
  const db = ctx.db<typeof schema>();
  const cart = (await db.select().from(schema.carts).where(eq(schema.carts.userId, userId)).limit(1))[0];
  if (!cart) return { items: [], subtotal_paisa: 0 };
  const rows = await db.select().from(schema.cartItems).where(eq(schema.cartItems.cartId, cart.id));
  if (!rows.length) return { items: [], subtotal_paisa: 0 };
  const byId = new Map(publicOnly(await productRows(ctx), await activeStoreIds(ctx)).map((p) => [p.id, p]));
  const variants = new Map<number, VariantRow>();
  for (const v of await db.select().from(schema.productVariants).where(inArray(schema.productVariants.productId, [...new Set(rows.map((r) => r.productId))]))) variants.set(v.id, v);
  const stale: number[] = [];
  const items: CartLine[] = [];
  let subtotal = 0;
  for (const row of rows) {
    const product = byId.get(row.productId);
    const variantId = row.variantId ?? 0;
    const variant = variantId ? variants.get(variantId) ?? null : null;
    if (!product || (variantId && (!variant || !variant.isActive || variant.productId !== row.productId))) {
      stale.push(row.id);
      continue;
    }
    const { unitPrice, stock } = linePricing({ pricePaisa: product.price_paisa, stock: product.stock }, variant);
    items.push({ product_id: row.productId, quantity: row.quantity, variant_id: variantId, variant_label: variant?.label ?? null, unit_price_paisa: unitPrice, stock, product });
    subtotal += unitPrice * row.quantity;
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

// The order must belong to the caller: a signed-in buyer whose account owns
// it, or a guest proving ownership with the order's phone number.
// Group-level ownership proof: the group is what the customer pays for, so
async function assertGroupCaller(ctx: Ctx, view: { user_id: string | null; group_code: string; phone: string }, authToken: string | undefined, phone: string | undefined) {
  if (authToken) {
    const auth = await requireAuth(ctx, authToken, "buyer");
    if (view.user_id !== auth.id) throw new Error("This order does not belong to your account.");
    return;
  }
  if (phone) {
    if (normalizePhone(view.phone) !== normalizePhone(phone)) throw new Error("We could not match that order and phone number.");
    return;
  }
  throw new Error("Please sign in or provide the order phone number.");
}

// Legal order-status graph, shared by the seller studio and the admin
// panel: an order can only move along these edges, never jump arbitrarily.
// Moving to "cancelled" restores reserved stock; the payment row follows the
// order so money state never drifts from fulfilment state.
const ORDER_TRANSITIONS: Partial<Record<string, string[]>> = {
  confirmation_needed: ["confirmed", "cancelled"],
  confirmed: ["packed", "cancelled"],
  packed: ["shipped"],
  shipped: ["out_for_delivery", "delivered", "delivery_failed"],
  out_for_delivery: ["delivered", "delivery_failed"],
  // A failed delivery is a recoverable shipment hiccup, not a terminal
  // state: the seller (or the courier) retries via out_for_delivery, or the
  // buyer picks the return route if the parcel never arrives.
  delivery_failed: ["out_for_delivery"],
  delivered: ["return_requested"],
  return_requested: ["returned", "delivered"],
  returned: ["refunded"],
};

async function transitionOrderStatus(
  ctx: Ctx,
  order: typeof schema.orders.$inferSelect,
  next: typeof order.status,
  actor: { type: string; id: string } = { type: "seller", id: "" },
): Promise<void> {
  const db = fullDb(ctx);
  if (order.status === next) return;
  if (!ORDER_TRANSITIONS[order.status]?.includes(next)) throw new Error("That order status change is not allowed.");
  if (next === "cancelled" && order.groupId) {
    // One seller must never unilaterally break a shared online group
    // payment: cancelling a single fulfilment of a multi-seller eSewa/Khalti
    // group would need a partial refund, which the providers' integrations
    // do not support. COD groups are safe (one payment row per fulfilment)
    // and single-fulfilment groups behave exactly like the old single order.
    const gp = (await db.select().from(schema.payments).where(eq(schema.payments.groupId, order.groupId)).limit(1))[0];
    if (gp && gp.provider !== "cod") {
      const siblings = await db.select({ id: schema.orders.id }).from(schema.orders).where(eq(schema.orders.groupId, order.groupId));
      if (siblings.length > 1) {
        throw new Error("This parcel is part of a multi-seller online order. Please contact support to arrange a partial cancellation and refund — a single seller cannot cancel part of a shared online payment.");
      }
    }
  }
  // The whole transition — status guard, stock restore, status write,
  // payment sync and commission accrual — runs in ONE transaction. A
  // concurrent second cancel can no longer slip through the guard and
  // restore the same stock twice, and a retried delivery can never
  // double-post the seller's earnings (ledger_key guard).
  const cfg = await moneyConfig(ctx);
  db.transaction((tx) => {
    const current = tx.select().from(schema.orders).where(eq(schema.orders.id, order.id)).limit(1).prepare().get();
    if (!current) throw new Error("Order not found.");
    if (current.status === next) return;
    if (!ORDER_TRANSITIONS[current.status]?.includes(next)) throw new Error("That order status change is not allowed.");
    if (next === "cancelled") {
      restoreStockTx(tx, current.id, "order_cancelled", actor.type, actor.id);
    }
    const now = new Date();
    tx.update(schema.orders).set({ status: next, updatedAt: now, ...(next === "delivered" ? { deliveredAt: now } : {}) }).where(eq(schema.orders.id, current.id)).prepare().run();
    // Keep the payment row in sync: COD is paid on delivery, unsettled
    // payments are cancelled with the order, refunds mark it refunded.
    const payment = tx.select().from(schema.payments).where(eq(schema.payments.orderId, current.id)).limit(1).prepare().get();
    if (payment) {
      let paymentNext = payment.status;
      if (next === "delivered" && payment.provider === "cod" && payment.status === "pending") paymentNext = "paid";
      else if (next === "cancelled" && (payment.status === "pending" || payment.status === "processing" || payment.status === "failed")) paymentNext = "cancelled";
      else if (next === "refunded") paymentNext = "refunded";
      if (paymentNext !== payment.status) {
        tx.update(schema.payments).set({ status: paymentNext, updatedAt: now }).where(eq(schema.payments.id, payment.id)).prepare().run();
        tx.update(schema.orders).set({ paymentStatus: paymentNext === "paid" ? "paid" : paymentNext === "refunded" ? "refunded" : paymentNext === "cancelled" ? "cancelled" : current.paymentStatus, updatedAt: now }).where(eq(schema.orders.id, current.id)).prepare().run();
      }
      // Money is earned when the payment is confirmed: COD pays on
      // delivery, so the sale and the platform commission accrue in the
      // same transaction that marks the order paid.
      if (payment && payment.status !== "paid" && paymentNext === "paid") {
        accrueSaleCommissionTx(tx, current.id, cfg.commission_default_percent);
      }
    }
  });
  if (order.userId) {
    await notifyUser(ctx, order.userId, { type: "order_status", title: `Order ${order.orderCode}: ${orderStatusLabel(next)}`, body: `Your order ${order.orderCode} is now ${orderStatusLabel(next)}.`, link: "#/orders" });
  }
  // Buyer delivery emails (the "shipped" mail goes out with tracking details
  // from setShipmentInfo instead, so it is deliberately not duplicated here).
  if (next === "out_for_delivery" || next === "delivered" || next === "delivery_failed") {
    const event = next as ShipmentEvent;
    await emailBuyerMsg(ctx, order.userId, (to, name) =>
      shipmentEmail(to, name, order.orderCode, event, order.carrier, order.trackingNumber));
  }
  ctx.invalidateQueries();
}

async function adminCancelOrderCore(
  ctx: Ctx,
  order: typeof schema.orders.$inferSelect,
  actor: { type: string; id: string },
): Promise<void> {
  const db = fullDb(ctx);
  // Status guard, stock restore, status write and payment void run in ONE
  // transaction: a concurrent second cancel cannot restore stock twice.
  // Cancelling one fulfilment expands to its whole group so the order is
  // never left half-cancelled.
  const subs = order.groupId
    ? await db.select({ id: schema.orders.id }).from(schema.orders).where(eq(schema.orders.groupId, order.groupId))
    : [{ id: order.id }];
  db.transaction((tx) => {
    cancelFulfilmentsTx(tx, subs.map((s) => s.id), actor.type, actor.id);
  });
  if (order.userId) {
    await notifyUser(ctx, order.userId, { type: "order_status", title: `Order ${order.orderCode} cancelled`, body: `Your order ${order.orderCode} was cancelled by the marketplace team. No payment is due.`, link: "#/orders" });
  }
  await emailBuyerMsg(ctx, order.userId, (to, name) => orderCancelledBuyerEmail(to, name, order.orderCode, "admin"));
  await emailSellerMsg(ctx, order.storeId, (to, storeName) => orderCancelledSellerEmail(to, storeName, order.orderCode, "admin"));
  ctx.invalidateQueries();
}

// Shared implementation behind requestRefund and its deprecated alias
// markRefunded. Records one refund row and NEVER flips anything to
// "refunded" by itself: only the marketplace team moves money (via
// adminResolveRefund), so only they may record a refund as complete.
// For a Cash-on-Delivery order that was never paid there is no money to
// send back, so the refund is recorded as not_required instead of
// pretending a refund happened.
async function recordRefundRequest(ctx: Ctx, storeId: number, orderId: number): Promise<{ ok: true; refund_status: "not_required" | "pending" }> {
  const db = ctx.db<typeof schema>();
  const order = (await db.select().from(schema.orders).where(and(eq(schema.orders.id, orderId), eq(schema.orders.storeId, storeId))).limit(1))[0];
  if (!order) throw new Error("Order not found.");
  if (order.status !== "returned") throw new Error("Only returned orders can be refunded.");
  const existing = (await db.select({ id: schema.refunds.id, status: schema.refunds.status }).from(schema.refunds).where(eq(schema.refunds.orderId, order.id)).limit(1))[0];
  if (existing) throw new Error(existing.status === "pending" ? "A refund is already waiting with the marketplace team." : "This order's refund has already been recorded.");
  // The order-level payment row is authoritative for COD (one row per
  // fulfilment); for online groups the single group row covers every
  // fulfilment. Find whichever row money actually moved through.
  const orderPayment = (await db.select().from(schema.payments).where(eq(schema.payments.orderId, order.id)).limit(1))[0];
  const groupPayment = order.groupId ? (await db.select().from(schema.payments).where(eq(schema.payments.groupId, order.groupId)).limit(1))[0] : undefined;
  const provider = groupPayment && groupPayment.provider !== "cod" ? groupPayment.provider : orderPayment?.provider ?? "cod";
  const paid = provider === "cod" ? orderPayment?.status === "paid" : groupPayment?.status === "paid";
  const requestedBy = `seller:${storeId}`;
  const now = new Date();
  let refundStatus: "not_required" | "pending";
  if (!paid) {
    // COD and never collected: telling the buyer they were "refunded"
    // would be a lie, so the row says exactly what happened instead.
    await db.insert(schema.refunds).values({
      orderId: order.id, groupId: order.groupId ?? null, amountPaisa: 0, provider,
      status: "not_required", method: "none",
      note: "Cash on delivery — payment was never collected, so no refund is owed.",
      requestedBy, createdAt: now, updatedAt: now,
    });
    refundStatus = "not_required";
  } else {
    await db.insert(schema.refunds).values({
      orderId: order.id, groupId: order.groupId ?? null, amountPaisa: order.totalPaisa, provider,
      status: "pending", method: "manual",
      note: "Refund requested. The marketplace team completes the payment manually through the provider dashboard — no automatic refund has been sent yet.",
      requestedBy, createdAt: now, updatedAt: now,
    });
    refundStatus = "pending";
  }
  if (order.userId) {
    await notifyUser(ctx, order.userId, {
      type: "payment",
      title: refundStatus === "pending" ? `Refund requested for ${order.orderCode}` : `Return closed for ${order.orderCode}`,
      body: refundStatus === "pending"
        ? `A refund of ${formatRs(order.totalPaisa)} for order ${order.orderCode} is with our team. It is completed manually, so it can take a few working days.`
        : `Your return for order ${order.orderCode} is closed. It was Cash on Delivery and no payment was collected, so there is nothing to refund.`,
      link: "#/orders",
    });
  }
  await emailBuyer(ctx, order.userId, refundStatus === "pending" ? `Refund requested for order ${order.orderCode}` : `Return closed for order ${order.orderCode}`,
    refundStatus === "pending"
      ? `A refund of ${formatRs(order.totalPaisa)} for order ${order.orderCode} is waiting with our team. We complete refunds manually through the payment provider, so please allow a few working days — we will confirm here once the money is on its way back.`
      : `Your return for order ${order.orderCode} is closed. It was Cash on Delivery and no payment was collected, so no refund is owed.`);
  await audit(ctx, "seller", String(storeId), "refund_requested", "order", String(order.id), `${order.orderCode} → ${refundStatus}`);
  ctx.invalidateQueries();
  return { ok: true, refund_status: refundStatus };
}

// ---------- commission + payouts (money checkpoint) ----------
//
// Money rules for the marketplace, in one place:
//
// * Commission accrues exactly once, at the moment a fulfilment order's
//   payment is confirmed — COD when the order is delivered (the payment row
//   flips to paid inside transitionOrderStatus), eSewa/Khalti when the
//   provider verification marks the group paid. The accrual runs INSIDE the
//   same transaction that flips the payment, keyed by a unique ledger_key,
//   so a retried callback or a repeated status walk can never double-post.
// * The commission base is the fulfilment's item subtotal: delivery fees
//   belong to the courier and coupon discounts are platform-funded, so
//   neither touches the seller's earnings.
// * Rule resolution is per order line: product rule > seller rule >
//   category rule > active campaign > platform rule > platform default.
// * A completed refund writes a negative refund row plus a positive
//   commission-reversal row, so a refunded order always nets to exactly zero.
// * Balances are DERIVED from the append-only ledger every time they are
//   read — never stored as a bare number. A ledger row is "pending" until
//   its order is delivered and the admin-configured hold window has passed,
//   "available" after that, and "paid" once a payout completes. Payouts
//   still in requested/processing are reserved from the available balance.
// * Sellers have no write path to the ledger at all: the only writers are
//   the payment transitions below, admin adjustments, and payout
//   completion. There is deliberately no seller-facing ledger mutation
//   action.

const MONEY_DEFAULTS = { commission_default_percent: 5, payout_available_after_days: 7, payout_min_paisa: 50000 };

interface MoneyConfig { commission_default_percent: number; payout_available_after_days: number; payout_min_paisa: number }

async function moneyConfig(ctx: Ctx): Promise<MoneyConfig> {
  const db = ctx.db<typeof schema>();
  const rows = await db.select().from(schema.platformSettings);
  const get = (k: string) => rows.find((r) => r.key === k)?.value;
  const int = (v: string | undefined, dflt: number, min: number, max: number) => {
    const n = Number(v);
    return v != null && Number.isInteger(n) && n >= min && n <= max ? n : dflt;
  };
  return {
    commission_default_percent: int(get("commission_default_percent"), MONEY_DEFAULTS.commission_default_percent, 0, 90),
    payout_available_after_days: int(get("payout_available_after_days"), MONEY_DEFAULTS.payout_available_after_days, 0, 90),
    payout_min_paisa: int(get("payout_min_paisa"), MONEY_DEFAULTS.payout_min_paisa, 0, 100000000),
  };
}

// Any drizzle query runner: the tx inside db.transaction() and a plain db
// expose the same select/insert/update call shape.
type Runner = any;

interface ResolvedRule { percent: number; ruleId: number | null; source: string }

function resolveRuleForLine(
  rules: (typeof schema.commissionRules.$inferSelect)[],
  storeId: number, productId: number, category: string, defaultPercent: number,
): ResolvedRule {
  const now = Date.now();
  const named = (r: (typeof rules)[number], kind: string) => `${r.percent}% ${kind}${r.label ? ` \u201c${r.label}\u201d` : ""} (rule #${r.id})`;
  const product = rules.find((r) => r.scope === "product" && r.scopeId === String(productId));
  if (product) return { percent: product.percent, ruleId: product.id, source: named(product, "product rule") };
  const seller = rules.find((r) => r.scope === "seller" && r.scopeId === String(storeId));
  if (seller) return { percent: seller.percent, ruleId: seller.id, source: named(seller, "seller rule") };
  const cat = rules.find((r) => r.scope === "category" && r.scopeId === category);
  if (cat) return { percent: cat.percent, ruleId: cat.id, source: named(cat, "category rule") };
  const camp = rules.find((r) => r.scope === "campaign" && (!r.startsAt || r.startsAt.getTime() <= now) && (!r.endsAt || r.endsAt.getTime() >= now));
  if (camp) return { percent: camp.percent, ruleId: camp.id, source: named(camp, "campaign") };
  const plat = rules.find((r) => r.scope === "platform");
  if (plat) return { percent: plat.percent, ruleId: plat.id, source: named(plat, "platform rule") };
  return { percent: defaultPercent, ruleId: null, source: `${defaultPercent}% platform default` };
}

// Running net balance for a store inside a transaction (rows are
// append-only, so the latest row's balance_after is the truth).
function ledgerBalanceTx(tx: Runner, storeId: number): number {
  const last = tx.select({ b: schema.sellerLedger.balanceAfterPaisa }).from(schema.sellerLedger)
    .where(eq(schema.sellerLedger.storeId, storeId)).orderBy(desc(schema.sellerLedger.id)).limit(1).prepare().get();
  return last?.b ?? 0;
}

// Append one ledger row. The unique ledger_key makes the write idempotent:
// a retried transition hits the conflict and keeps the original row, so
// money can never be double-posted. ledgerKey may be null for one-off
// rows (admin adjustments), which SQLite's unique index permits.
function insertLedgerTx(tx: Runner, storeId: number, row: {
  orderId?: number | null; type: "sale" | "commission" | "refund" | "payout" | "adjustment";
  amountPaisa: number; ruleId?: number | null; payoutId?: number | null; ledgerKey?: string | null; note: string;
}): void {
  const after = ledgerBalanceTx(tx, storeId) + row.amountPaisa;
  tx.insert(schema.sellerLedger).values({
    storeId, orderId: row.orderId ?? null, type: row.type, amountPaisa: row.amountPaisa,
    balanceAfterPaisa: after, ruleId: row.ruleId ?? null, payoutId: row.payoutId ?? null,
    ledgerKey: row.ledgerKey ?? null, note: row.note, createdAt: new Date(),
  }).onConflictDoNothing({ target: schema.sellerLedger.ledgerKey }).prepare().run();
}

// Commission accrual for one fulfilment order. Called from inside the
// transaction that confirms the payment; no-ops unless the order is paid
// and has not been accrued yet (ledger_key guard).
function accrueSaleCommissionTx(tx: Runner, orderId: number, defaultPercent: number): void {
  const done = tx.select({ id: schema.sellerLedger.id }).from(schema.sellerLedger)
    .where(eq(schema.sellerLedger.ledgerKey, `sale:${orderId}`)).limit(1).prepare().get();
  if (done) return;
  const order = tx.select().from(schema.orders).where(eq(schema.orders.id, orderId)).limit(1).prepare().get();
  if (!order || order.paymentStatus !== "paid") return;
  const items: (typeof schema.orderItems.$inferSelect)[] = tx.select().from(schema.orderItems).where(eq(schema.orderItems.orderId, orderId)).prepare().all();
  const productIds = [...new Set(items.map((i) => i.productId))];
  const products: (typeof schema.products.$inferSelect)[] = productIds.length
    ? tx.select().from(schema.products).where(inArray(schema.products.id, productIds)).prepare().all()
    : [];
  const byId = new Map(products.map((p) => [p.id, p]));
  const rules: (typeof schema.commissionRules.$inferSelect)[] = tx.select().from(schema.commissionRules).where(eq(schema.commissionRules.isActive, true)).prepare().all();
  let commission = 0;
  const parts: string[] = [];
  const ruleIds = new Set<number>();
  for (const item of items) {
    const product = byId.get(item.productId);
    const line = item.unitPricePaisa * item.quantity;
    const r = resolveRuleForLine(rules, order.storeId, item.productId, product?.category ?? "", defaultPercent);
    const cut = Math.round((line * r.percent) / 100);
    commission += cut;
    if (r.ruleId != null) ruleIds.add(r.ruleId);
    parts.push(`${formatRs(line)} @ ${r.source} \u2192 ${formatRs(cut)}`);
  }
  insertLedgerTx(tx, order.storeId, {
    orderId, type: "sale", amountPaisa: order.subtotalPaisa, ledgerKey: `sale:${orderId}`,
    note: `Sale ${order.orderCode}: ${items.length} line(s), ${formatRs(order.subtotalPaisa)} gross of goods (delivery fee excluded).`,
  });
  insertLedgerTx(tx, order.storeId, {
    orderId, type: "commission", amountPaisa: -commission,
    ruleId: ruleIds.size === 1 ? [...ruleIds][0] : null,
    ledgerKey: `commission:${orderId}`,
    note: `Commission on ${order.orderCode}: ${parts.join("; ") || "no order lines"}.`,
  });
}

// Reverse the money of a refunded fulfilment: the sale is taken back and
// the commission is returned, so the order nets to exactly zero. No-op
// when the order never accrued (e.g. COD that was never paid).
function reverseCommissionTx(tx: Runner, orderId: number, orderCode: string): void {
  const sale = tx.select().from(schema.sellerLedger).where(eq(schema.sellerLedger.ledgerKey, `sale:${orderId}`)).limit(1).prepare().get();
  const comm = tx.select().from(schema.sellerLedger).where(eq(schema.sellerLedger.ledgerKey, `commission:${orderId}`)).limit(1).prepare().get();
  if (!sale && !comm) return;
  const storeId: number = (sale ?? comm).storeId;
  if (sale) {
    insertLedgerTx(tx, storeId, {
      orderId, type: "refund", amountPaisa: -sale.amountPaisa, ledgerKey: `refund:${orderId}`,
      note: `Refund ${orderCode}: sale of ${formatRs(sale.amountPaisa)} reversed.`,
    });
  }
  if (comm) {
    insertLedgerTx(tx, storeId, {
      orderId, type: "commission", amountPaisa: -comm.amountPaisa, ruleId: comm.ruleId,
      ledgerKey: `commission-reversal:${orderId}`,
      note: `Commission reversed \u2014 ${orderCode} refunded (${formatRs(-comm.amountPaisa)} returned to seller).`,
    });
  }
}

interface SellerBalances {
  pending_paisa: number; available_paisa: number; reserved_paisa: number;
  requestable_paisa: number; paid_paisa: number;
  hold_days: number; min_payout_paisa: number; default_commission_percent: number;
}

// Balances are always derived from the append-only ledger — never stored.
// A ledger row is "available" once its order is delivered and the
// admin-configured hold window has passed; anything earlier is "pending".
// Completed payouts reduce the available balance; payouts still in
// requested/processing are reserved from it.
async function sellerBalances(ctx: Ctx, storeId: number): Promise<SellerBalances> {
  const cfg = await moneyConfig(ctx);
  const db = ctx.db<typeof schema>();
  const [rows, orders, payouts] = await Promise.all([
    db.select().from(schema.sellerLedger).where(eq(schema.sellerLedger.storeId, storeId)).orderBy(desc(schema.sellerLedger.id)).limit(10000),
    db.select({ id: schema.orders.id, status: schema.orders.status, deliveredAt: schema.orders.deliveredAt }).from(schema.orders).where(eq(schema.orders.storeId, storeId)),
    db.select().from(schema.sellerPayouts).where(eq(schema.sellerPayouts.storeId, storeId)).orderBy(desc(schema.sellerPayouts.id)).limit(1000),
  ]);
  const holdMs = cfg.payout_available_after_days * 86400000;
  const now = Date.now();
  const orderById = new Map(orders.map((o) => [o.id, o]));
  let pending = 0, available = 0, paid = 0;
  for (const r of rows) {
    if (r.type === "payout") { available += r.amountPaisa; paid += -r.amountPaisa; continue; }
    const mature = r.orderId == null
      ? true // admin adjustments correct the balance immediately
      : (() => {
        const o = orderById.get(r.orderId);
        return !!o && o.status === "delivered" && !!o.deliveredAt && o.deliveredAt.getTime() + holdMs <= now;
      })();
    if (mature) available += r.amountPaisa; else pending += r.amountPaisa;
  }
  const reserved = payouts.filter((p) => p.status === "requested" || p.status === "processing").reduce((n, p) => n + p.amountPaisa, 0);
  return {
    pending_paisa: pending, available_paisa: available, reserved_paisa: reserved,
    requestable_paisa: Math.max(0, available - reserved), paid_paisa: paid,
    hold_days: cfg.payout_available_after_days, min_payout_paisa: cfg.payout_min_paisa,
    default_commission_percent: cfg.commission_default_percent,
  };
}

// Account numbers are sensitive: only the last four digits ever leave the
// server, everywhere — seller UI, admin UI, API responses.
function maskAccountNumber(raw: string | null | undefined): string {
  const digits = (raw ?? "").replace(/\D/g, "");
  if (digits.length < 4) return "\u2022\u2022\u2022\u2022";
  return `\u2022\u2022\u2022\u2022${digits.slice(-4)}`;
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
  // Public seller store page. Only active stores are reachable: suspended or
  // pending stores throw the same not-found error as a bad code, so nobody
  // can probe store status through this endpoint. Never exposes seller
  // credentials, email or phone.
  getStore: defineAction({
    request: z.object({ seller_code: z.string().trim().min(1).max(40) }),
    response: z.object({
      seller_code: z.string(), store_name: z.string(), tagline: z.string(), location: z.string(),
      rating: z.number().nullable(), review_count: z.number(), product_count: z.number(), verified: z.boolean(),
      description: z.string(), vacation_mode: z.boolean(),
      logo_url: z.string().nullable(), banner_url: z.string().nullable(),
      products: z.array(productShape),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const code = args.seller_code.toUpperCase();
      const store = (await db.select().from(schema.storeSettings).where(eq(schema.storeSettings.sellerCode, code)).limit(1))[0];
      if (!store || store.status !== "active") throw new Error("That store is not available.");
      // Scoped to this store's catalogue (not the whole marketplace), then
      // the same public/active gating as the storefront.
      const pubs = publicOnly(await productRows(ctx, store.id), await activeStoreIds(ctx));
      const reviewRows = pubs.length
        ? await db.select().from(schema.reviews).where(inArray(schema.reviews.productId, pubs.map((p) => p.id)))
        : [];
      return {
        seller_code: store.sellerCode, store_name: store.storeName, tagline: store.tagline, location: store.location,
        rating: reviewRows.length ? reviewRows.reduce((n, r) => n + r.rating, 0) / reviewRows.length : null,
        review_count: reviewRows.length, product_count: pubs.length,
        verified: !!store.email, description: store.description ?? "", vacation_mode: !!store.vacationMode,
        logo_url: store.logoUrl ?? null, banner_url: store.bannerUrl ?? null, products: pubs,
      };
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
      if (email) {
        // Welcome email — best-effort, never blocks registration.
        const sent = await sendEmail(buyerWelcomeEmail(email, args.name.trim()));
        if (!sent.sent) console.warn(`[auth] welcome email to ${email} not sent: ${sent.error ?? "unknown"}`);
        // Email-verification token (hash-only storage, single-use, 24 h).
        const token = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, "");
        await db.insert(schema.buyerEmailVerifications).values({
          tokenHash: await hashKey(token), userId: id,
          expiresAt: new Date(Date.now() + 24 * 3600 * 1000), createdAt: new Date(),
        });
        const { publicBaseUrl } = await import("./payments");
        const link = `${publicBaseUrl()}/#/verify-buyer?token=${token}`;
        const vsent = await sendEmail(buyerVerificationEmail(email, args.name.trim(), link));
        if (!vsent.sent) console.warn(`[auth] buyer verification email to ${email} not sent: ${vsent.error ?? "unknown"}`);
      }
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
      if (user.status === "suspended") throw new Error("This account has been suspended. Please contact support.");
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
  updateMyPassword: defineAction({
    request: z.object({ authToken: authTokenRequired, old_password: z.string().min(1).max(120), new_password: passwordField }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const auth = await requireAuth(ctx, args.authToken, "buyer");
      const db = ctx.db<typeof schema>();
      const user = (await db.select().from(schema.users).where(eq(schema.users.id, auth.id)).limit(1))[0];
      if (!user || !await Bun.password.verify(args.old_password, user.passwordHash)) throw new Error("The current password is incorrect.");
      await db.update(schema.users).set({ passwordHash: await Bun.password.hash(args.new_password, { algorithm: "bcrypt", cost: 10 }), updatedAt: new Date() }).where(eq(schema.users.id, user.id));
      await revokeOtherSessions(ctx, "buyer", user.id, args.authToken);
      return { ok: true };
    },
  }),
  updateSellerPassword: defineAction({
    request: z.object({ ...sellerAuthFields, old_password: z.string().min(1).max(120), new_password: passwordField }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const store = await resolveSeller(ctx, args);
      const db = ctx.db<typeof schema>();
      if (!store.passwordHash || !await Bun.password.verify(args.old_password, store.passwordHash)) throw new Error("The current password is incorrect.");
      await db.update(schema.storeSettings).set({ passwordHash: await Bun.password.hash(args.new_password, { algorithm: "bcrypt", cost: 10 }), updatedAt: new Date() }).where(eq(schema.storeSettings.id, store.id));
      await revokeOtherSessions(ctx, "seller", String(store.id), args.authToken);
      return { ok: true };
    },
  }),
  // Password reset. Always returns ok (even for unknown identifiers) so the
  // endpoint cannot be used to enumerate accounts. Delivery needs SMTP
  // configured; without it the request is logged server-side and nothing is
  // sent — the response stays generic either way.
  requestPasswordReset: defineAction({
    request: z.object({ user_type: z.enum(["buyer", "seller", "admin"]), identifier: z.string().trim().min(3).max(120) }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      const ident = args.identifier.trim().toLowerCase();
      let userId: string | null = null, email: string | null = null, name = "there";
      if (args.user_type === "buyer") {
        const u = (await db.select().from(schema.users).where(eq(schema.users.phone, args.identifier.trim())).limit(1))[0]
          ?? (await db.select().from(schema.users).where(eq(schema.users.email, ident)).limit(1))[0];
        if (u) { userId = u.id; email = u.email; name = u.name; }
      } else if (args.user_type === "seller") {
        const s = (await db.select().from(schema.storeSettings).where(eq(schema.storeSettings.email, ident)).limit(1))[0];
        if (s) { userId = String(s.id); email = s.email; name = s.storeName; }
      } else {
        const a = (await db.select().from(schema.admins).where(eq(schema.admins.email, ident)).limit(1))[0];
        if (a) { userId = a.id; email = a.email; name = a.name; }
      }
      if (userId && email && emailConfigured()) {
        const token = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, "");
        const tokenHash = await hashKey(token);
        await db.insert(schema.passwordResetTokens).values({
          tokenHash, userType: args.user_type, userId,
          expiresAt: new Date(Date.now() + 3600 * 1000), createdAt: new Date(),
        });
        const { publicBaseUrl } = await import("./payments");
        const link = `${publicBaseUrl()}/#/reset-password?token=${token}&type=${args.user_type}`;
        const sent = await sendEmail(resetPasswordEmail(email, name, link));
        if (!sent.sent) console.warn(`[auth] password-reset email to ${email} failed: ${sent.error}`);
      } else if (userId) {
        console.warn(`[auth] password-reset requested for ${args.user_type} ${userId} but no email is on file or SMTP is not configured`);
      }
      return { ok: true };
    },
  }),
  resetPassword: defineAction({
    request: z.object({ user_type: z.enum(["buyer", "seller", "admin"]), token: z.string().min(8).max(200), new_password: passwordField }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      const tokenHash = await hashKey(args.token);
      const row = (await db.select().from(schema.passwordResetTokens).where(eq(schema.passwordResetTokens.tokenHash, tokenHash)).limit(1))[0];
      if (!row || row.userType !== args.user_type || row.usedAt || row.expiresAt.getTime() < Date.now()) {
        throw new Error("This reset link is invalid or has expired. Please request a new one.");
      }
      const newHash = await Bun.password.hash(args.new_password, { algorithm: "bcrypt", cost: 10 });
      if (args.user_type === "buyer") {
        await db.update(schema.users).set({ passwordHash: newHash, updatedAt: new Date() }).where(eq(schema.users.id, row.userId));
      } else if (args.user_type === "seller") {
        await db.update(schema.storeSettings).set({ passwordHash: newHash, updatedAt: new Date() }).where(eq(schema.storeSettings.id, Number(row.userId)));
      } else {
        await db.update(schema.admins).set({ passwordHash: newHash }).where(eq(schema.admins.id, row.userId));
      }
      await db.update(schema.passwordResetTokens).set({ usedAt: new Date() }).where(eq(schema.passwordResetTokens.id, row.id));
      await revokeOtherSessions(ctx, args.user_type, row.userId);
      await audit(ctx, args.user_type, row.userId, "password_reset", "account", row.userId, "Password changed via reset link.");
      return { ok: true };
    },
  }),
  // Buyer email verification: consume a single-use token (24 h expiry) from
  // the welcome email. Mirrors the seller flow (verifySellerEmail).
  verifyBuyerEmail: defineAction({
    request: z.object({ token: z.string().min(8).max(200) }),
    response: z.object({ ok: z.literal(true), already_verified: z.boolean() }),
    async handler(ctx, args): Promise<{ ok: true; already_verified: boolean }> {
      const db = ctx.db<typeof schema>();
      const row = (await db.select().from(schema.buyerEmailVerifications).where(eq(schema.buyerEmailVerifications.tokenHash, await hashKey(args.token))).limit(1))[0];
      const user = row ? (await db.select({ email: schema.users.email, verified: schema.users.emailVerified }).from(schema.users).where(eq(schema.users.id, row.userId)).limit(1))[0] : undefined;
      if (!row || !user || row.expiresAt.getTime() < Date.now()) throw new Error("This verification link is invalid or has expired. Please sign in and request a new one from your account.");
      if (row.usedAt) {
        if (user.verified) return { ok: true, already_verified: true };
        throw new Error("This verification link has already been used. Please sign in and request a new one from your account.");
      }
      await db.update(schema.buyerEmailVerifications).set({ usedAt: new Date() }).where(eq(schema.buyerEmailVerifications.id, row.id));
      await db.update(schema.users).set({ emailVerified: true, updatedAt: new Date() }).where(eq(schema.users.id, row.userId));
      await audit(ctx, "buyer", row.userId, "buyer_email_verified", "account", row.userId, "Buyer email address verified.");
      ctx.invalidateQueries();
      return { ok: true, already_verified: false };
    },
  }),
  // Re-send the buyer verification email to the signed-in buyer.
  resendBuyerVerification: defineAction({
    request: z.object({ authToken: authTokenField }),
    response: z.object({ ok: z.literal(true), email_sent: z.boolean() }),
    async handler(ctx, args): Promise<{ ok: true; email_sent: boolean }> {
      const auth = await requireAuth(ctx, args.authToken, "buyer");
      const db = ctx.db<typeof schema>();
      const user = (await db.select({ email: schema.users.email, name: schema.users.name, verified: schema.users.emailVerified }).from(schema.users).where(eq(schema.users.id, auth.id)).limit(1))[0];
      if (!user) throw new Error("Account not found.");
      if (!user.email) throw new Error("Add an email address to your account first.");
      if (user.verified) return { ok: true, email_sent: false };
      const token = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, "");
      await db.insert(schema.buyerEmailVerifications).values({
        tokenHash: await hashKey(token), userId: auth.id,
        expiresAt: new Date(Date.now() + 24 * 3600 * 1000), createdAt: new Date(),
      });
      let emailSent = false;
      if (emailConfigured()) {
        const { publicBaseUrl } = await import("./payments");
        const link = `${publicBaseUrl()}/#/verify-buyer?token=${token}`;
        const sent = await sendEmail(buyerVerificationEmail(user.email, user.name, link));
        emailSent = sent.sent;
        if (!sent.sent) console.warn(`[auth] buyer verification email to ${user.email} failed: ${sent.error}`);
      } else {
        console.warn(`[auth] buyer verification email for ${user.email} not sent: SMTP is not configured`);
      }
      return { ok: true, email_sent: emailSent };
    },
  }),
  // Notification preferences (Notifications checkpoint): the buyer can turn
  // order-update emails on or off. Security emails always go through.
  getNotificationPrefs: defineAction({
    request: z.object({ authToken: authTokenField }),
    response: z.object({ order_update_emails: z.boolean(), email_verified: z.boolean(), email: z.string().nullable() }),
    async handler(ctx, args) {
      const auth = await requireAuth(ctx, args.authToken, "buyer");
      const db = ctx.db<typeof schema>();
      const user = (await db.select({ notify: schema.users.notifyOrderEmails, verified: schema.users.emailVerified, email: schema.users.email }).from(schema.users).where(eq(schema.users.id, auth.id)).limit(1))[0];
      if (!user) throw new Error("Account not found.");
      return { order_update_emails: user.notify !== false, email_verified: !!user.verified, email: user.email };
    },
  }),
  updateNotificationPrefs: defineAction({
    request: z.object({ authToken: authTokenField, order_update_emails: z.boolean() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const auth = await requireAuth(ctx, args.authToken, "buyer");
      const db = ctx.db<typeof schema>();
      await db.update(schema.users).set({ notifyOrderEmails: args.order_update_emails, updatedAt: new Date() }).where(eq(schema.users.id, auth.id));
      ctx.invalidateQueries();
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
      const groupIds = [...new Set(orders.map((o) => o.groupId).filter((g): g is number => g != null))];
      const groups = groupIds.length ? await db.select({ id: schema.orderGroups.id, code: schema.orderGroups.groupCode }).from(schema.orderGroups).where(inArray(schema.orderGroups.id, groupIds)) : [];
      const codeOf = (gid: number | null) => gid == null ? null : groups.find((g) => g.id === gid)?.code ?? null;
      const extras = await orderExtras(ctx, orders.map((o) => o.id));
      return { orders: orders.map((o) => mapOrder(o, items, codeOf(o.groupId), extras.get(o.id))) };
    },
  }),
  // The buyer's order history as groups: one card per checkout, each with
  // its per-seller fulfilments. This is what the "My orders" page renders.
  getMyOrderGroups: defineAction({
    request: z.object({ authToken: authTokenField }), response: z.object({ groups: z.array(orderGroupShape) }),
    async handler(ctx, args) {
      const auth = await requireAuth(ctx, args.authToken, "buyer");
      const db = ctx.db<typeof schema>();
      const groups = await db.select().from(schema.orderGroups).where(eq(schema.orderGroups.userId, auth.id)).orderBy(desc(schema.orderGroups.createdAt)).limit(50);
      const views: z.infer<typeof orderGroupShape>[] = [];
      for (const g of groups) {
        const view = await loadOrderGroup(ctx, g.id);
        if (view) views.push(publicGroupView(view));
      }
      return { groups: views };
    },
  }),

  // ---------- sellers ----------
  // Seller registration. New sellers start as "pending" and must verify
  // their email (token-based, 24 h, single-use — same pattern as the
  // password-reset flow) before an admin reviews them. Phone verification is
  // NOT offered: no SMS provider is configured (see providers.ts), and the
  // phone number is still collected as the public contact for the store.
  registerSeller: defineAction({
    request: z.object({ store_name: z.string().trim().min(2).max(60), tagline: z.string().trim().min(3).max(120), location: z.string().trim().min(2).max(80), phone: z.string().trim().min(7).max(20), email: emailField, password: passwordField, seller_key: keyField }),
    response: z.object({ seller_code: z.string(), email_sent: z.boolean() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const email = args.email.trim().toLowerCase();
      if ((await db.select({ id: schema.storeSettings.id }).from(schema.storeSettings).where(eq(schema.storeSettings.email, email)).limit(1)).length) throw new Error("That email is already registered as a seller.");
      const code = `SELL-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
      const inserted = await db.insert(schema.storeSettings).values({ sellerCode: code, storeName: args.store_name.trim(), tagline: args.tagline.trim(), location: args.location.trim(), phone: args.phone.trim(), email, passwordHash: await Bun.password.hash(args.password, { algorithm: "bcrypt", cost: 10 }), adminKeyHash: "", adminKeyHashBcrypt: await Bun.password.hash(args.seller_key, { algorithm: "bcrypt", cost: 10 }), status: "pending", createdAt: new Date(), updatedAt: new Date() }).returning({ id: schema.storeSettings.id });
      const storeId = inserted[0]?.id;
      if (!storeId) throw new Error("The seller account could not be created.");
      // Email verification token (stored as a hash, like password resets).
      const token = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, "");
      await db.insert(schema.sellerEmailVerifications).values({
        tokenHash: await hashKey(token), storeId,
        expiresAt: new Date(Date.now() + 24 * 3600 * 1000), createdAt: new Date(),
      });
      let emailSent = false;
      if (emailConfigured()) {
        const { publicBaseUrl } = await import("./payments");
        const link = `${publicBaseUrl()}/#/verify-seller?token=${token}`;
        const sent = await sendEmail(sellerVerificationEmail(email, args.store_name.trim(), link));
        emailSent = sent.sent;
        if (!sent.sent) console.warn(`[auth] seller verification email to ${email} failed: ${sent.error}`);
      } else {
        console.warn(`[auth] seller verification email for ${email} not sent: SMTP is not configured`);
      }
      await notifyAdmin(
        `New seller awaiting review: ${args.store_name.trim()}`,
        `A new seller registered and needs review.\n\nStore: ${args.store_name.trim()} (${code})\nEmail: ${email}\nPhone: ${args.phone.trim()}\nLocation: ${args.location.trim()}\n\nReview it in the admin panel under Sellers.`,
      );
      await audit(ctx, "seller", String(storeId), "seller_registered", "store", String(storeId), `${args.store_name.trim()} (${email})`);
      ctx.invalidateQueries();
      return { seller_code: code, email_sent: emailSent };
    },
  }),
  // Consume an email-verification token. Single-use, 24 h expiry. Re-opening
  // an already-used link reports "already verified" instead of an error when
  // the email really was verified — friendlier for double clicks.
  verifySellerEmail: defineAction({
    request: z.object({ token: z.string().min(8).max(200) }),
    response: z.object({ ok: z.literal(true), seller_code: z.string(), already_verified: z.boolean() }),
    async handler(ctx, args): Promise<{ ok: true; seller_code: string; already_verified: boolean }> {
      const db = ctx.db<typeof schema>();
      const row = (await db.select().from(schema.sellerEmailVerifications).where(eq(schema.sellerEmailVerifications.tokenHash, await hashKey(args.token))).limit(1))[0];
      const store = row ? (await db.select({ code: schema.storeSettings.sellerCode, verified: schema.storeSettings.emailVerified }).from(schema.storeSettings).where(eq(schema.storeSettings.id, row.storeId)).limit(1))[0] : undefined;
      if (!row || !store || row.expiresAt.getTime() < Date.now()) throw new Error("This verification link is invalid or has expired. Please sign in and request a new one from the studio settings.");
      if (row.usedAt) {
        if (store.verified) return { ok: true, seller_code: store.code, already_verified: true };
        throw new Error("This verification link has already been used. Please sign in and request a new one from the studio settings.");
      }
      await db.update(schema.sellerEmailVerifications).set({ usedAt: new Date() }).where(eq(schema.sellerEmailVerifications.id, row.id));
      await db.update(schema.storeSettings).set({ emailVerified: true, status: "under_review", updatedAt: new Date() }).where(and(eq(schema.storeSettings.id, row.storeId), eq(schema.storeSettings.status, "pending")));
      await audit(ctx, "seller", String(row.storeId), "seller_email_verified", "store", String(row.storeId), "Email address verified; moved to review queue.");
      ctx.invalidateQueries();
      return { ok: true, seller_code: store.code, already_verified: false };
    },
  }),
  // Re-send the verification email to a signed-in seller.
  resendSellerVerification: defineAction({
    request: z.object({ ...sellerAuthFields }),
    response: z.object({ ok: z.literal(true), email_sent: z.boolean() }),
    async handler(ctx, args): Promise<{ ok: true; email_sent: boolean }> {
      const store = await resolveSeller(ctx, args);
      if (store.emailVerified) return { ok: true, email_sent: false };
      if (!store.email) throw new Error("This seller account has no email address on file.");
      const db = ctx.db<typeof schema>();
      const token = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, "");
      await db.insert(schema.sellerEmailVerifications).values({
        tokenHash: await hashKey(token), storeId: store.id,
        expiresAt: new Date(Date.now() + 24 * 3600 * 1000), createdAt: new Date(),
      });
      let emailSent = false;
      if (emailConfigured()) {
        const { publicBaseUrl } = await import("./payments");
        const link = `${publicBaseUrl()}/#/verify-seller?token=${token}`;
        const sent = await sendEmail(sellerVerificationEmail(store.email, store.storeName, link));
        emailSent = sent.sent;
        if (!sent.sent) console.warn(`[auth] seller verification resend to ${store.email} failed: ${sent.error}`);
      } else {
        console.warn(`[auth] seller verification resend for ${store.email} not sent: SMTP is not configured`);
      }
      return { ok: true, email_sent: emailSent };
    },
  }),
  sellerLogin: defineAction({
    request: z.object({ email: emailField, password: z.string().min(1).max(120) }),
    response: z.object({ token: z.string(), seller: z.object({ seller_code: z.string(), store_name: z.string(), status: sellerStatus, email_verified: z.boolean() }) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const store = (await db.select().from(schema.storeSettings).where(eq(schema.storeSettings.email, args.email.trim().toLowerCase())).limit(1))[0];
      if (!store?.passwordHash || !await Bun.password.verify(args.password, store.passwordHash)) throw new Error("Email or password is incorrect.");
      if (store.status === "suspended") throw new Error("This seller account is suspended. Please contact support.");
      if (store.status === "rejected") throw new Error("This seller application was not approved. Please contact support.");
      const token = await createSession(ctx, "seller", String(store.id));
      return { token, seller: { seller_code: store.sellerCode, store_name: store.storeName, status: store.status, email_verified: !!store.emailVerified } };
    },
  }),
  sellerInventory: defineAction({
    request: z.object({ ...sellerAuthFields }), response: z.object({ store: z.object({ id: z.number(), store_name: z.string(), tagline: z.string(), location: z.string(), phone: z.string(), status: sellerStatus, description: z.string(), vacation_mode: z.boolean(), logo_url: z.string().nullable(), banner_url: z.string().nullable(), email_verified: z.boolean() }), products: z.array(productShape) }),
    async handler(ctx, args) {
      const store = await resolveSeller(ctx, args);
      return {
        store: { id: store.id, store_name: store.storeName, tagline: store.tagline, location: store.location, phone: store.phone, status: store.status, description: store.description ?? "", vacation_mode: !!store.vacationMode, logo_url: store.logoUrl ?? null, banner_url: store.bannerUrl ?? null, email_verified: !!store.emailVerified },
        products: await productRows(ctx, store.id),
      };
    },
  }),
  saveStore: defineAction({
    request: z.object({ ...sellerAuthFields, store_name: z.string().trim().min(2).max(60).optional(), tagline: z.string().trim().min(3).max(120).optional(), location: z.string().trim().min(2).max(80).optional(), phone: z.string().trim().min(7).max(20).optional(), description: z.string().trim().max(600).optional(), vacation_mode: z.boolean().optional() }), response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const store = await resolveSeller(ctx, args);
      assertSellerCanSell(store);
      const db = ctx.db<typeof schema>();
      await db.update(schema.storeSettings).set({
        storeName: args.store_name ?? store.storeName, tagline: args.tagline ?? store.tagline,
        location: args.location ?? store.location, phone: args.phone ?? store.phone,
        description: args.description === undefined ? store.description ?? "" : args.description.trim(),
        vacationMode: args.vacation_mode ?? !!store.vacationMode, updatedAt: new Date(),
      }).where(eq(schema.storeSettings.id, store.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),
  // Store logo / banner images. The files are uploaded first via
  // POST /api/store-uploads; this action only attaches their URLs. Replaced
  // images are deleted from disk so the uploads folder does not fill up.
  saveStoreAssets: defineAction({
    request: z.object({ ...sellerAuthFields, logo_url: storeAssetUrlField.nullish(), banner_url: storeAssetUrlField.nullish() }), response: z.object({ ok: z.literal(true), logo_url: z.string().nullable(), banner_url: z.string().nullable() }),
    async handler(ctx, args): Promise<{ ok: true; logo_url: string | null; banner_url: string | null }> {
      const store = await resolveSeller(ctx, args);
      assertSellerCanSell(store);
      const db = ctx.db<typeof schema>();
      const pick = (incoming: string | null | undefined, current: string | null, kind: "logo" | "banner") => {
        if (incoming === undefined) return current;
        const url = incoming?.trim() || null;
        if (url && !/^\/uploads\/store-[0-9a-f-]+\.(jpg|png|webp|gif)$/.test(url)) throw new Error(`The ${kind} image must be uploaded through the studio uploader.`);
        if (current && current !== url && current.startsWith("/uploads/")) deleteUploadFile(current);
        return url;
      };
      const logoUrl = pick(args.logo_url, store.logoUrl ?? null, "logo");
      const bannerUrl = pick(args.banner_url, store.bannerUrl ?? null, "banner");
      await db.update(schema.storeSettings).set({ logoUrl, bannerUrl, updatedAt: new Date() }).where(eq(schema.storeSettings.id, store.id));
      await audit(ctx, "seller", String(store.id), "store_assets_updated", "store", String(store.id), `logo=${logoUrl ? "set" : "none"} banner=${bannerUrl ? "set" : "none"}`);
      ctx.invalidateQueries();
      return { ok: true, logo_url: logoUrl, banner_url: bannerUrl };
    },
  }),
  createProduct: defineAction({
    request: z.object({ ...sellerAuthFields, name: z.string().trim().min(2).max(80), category: z.string().trim().min(2).max(40), description: z.string().trim().min(8).max(500), price_paisa: z.number().int().positive(), delivery_fee_paisa: z.number().int().min(0), stock: z.number().int().min(0).max(100000), brand: z.string().trim().max(40).optional(), original_price_paisa: z.number().int().positive().optional(), image_url: imageUrlField.optional(), low_stock_threshold: z.number().int().min(0).max(1000).optional(), sku: z.string().trim().max(40).optional(), is_active: z.boolean().optional().default(false) }), response: z.object({ id: z.number(), is_active: z.boolean() }),
    async handler(ctx, args) {
      const store = await resolveSeller(ctx, args);
      assertSellerCanSell(store);
      if (args.original_price_paisa != null && args.original_price_paisa <= args.price_paisa) throw new Error("The original price must be higher than the selling price.");
      const db = ctx.db<typeof schema>();
      const sku = normalizeSku(args.sku);
      if (sku) {
        const clash = (await db.select({ id: schema.products.id }).from(schema.products).where(and(eq(schema.products.storeId, store.id), eq(schema.products.sku, sku))).limit(1))[0];
        if (clash) throw new Error(`The SKU "${sku}" is already used by another product in this shop.`);
      }
      // Sellers who are not approved yet may only save drafts — nothing they
      // create can become publicly visible before admin approval.
      const isActive = store.status === "active" && args.is_active;
      const result = await db.insert(schema.products).values({ storeId: store.id, name: args.name, category: args.category, description: args.description, pricePaisa: args.price_paisa, deliveryFeePaisa: args.delivery_fee_paisa, stock: args.stock, brand: args.brand?.trim() || null, originalPricePaisa: args.original_price_paisa ?? null, imageUrl: args.image_url ?? null, lowStockThreshold: args.low_stock_threshold ?? 5, sku, isActive, updatedAt: new Date() }).returning({ id: schema.products.id });
      const row = result[0];
      if (!row) throw new Error("The product could not be saved.");
      if (args.stock > 0) {
        await db.insert(schema.stockMovements).values({ productId: row.id, variantId: 0, change: args.stock, stockAfter: args.stock, reason: "product_created", actorType: "seller", actorId: String(store.id), createdAt: new Date() });
      }
      ctx.invalidateQueries();
      return { id: row.id, is_active: isActive };
    },
  }),
  updateProduct: defineAction({
    request: z.object({ ...sellerAuthFields, id: z.number().int().positive(), name: z.string().trim().min(2).max(80), category: z.string().trim().min(2).max(40), description: z.string().trim().min(8).max(500), price_paisa: z.number().int().positive(), delivery_fee_paisa: z.number().int().min(0), stock: z.number().int().min(0).max(100000), is_active: z.boolean(), image_url: imageUrlField.nullish(), sku: z.string().trim().max(40).nullish(), brand: z.string().trim().max(40).nullish(), original_price_paisa: z.number().int().positive().nullish(), low_stock_threshold: z.number().int().min(0).max(1000).nullish() }), response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const store = await resolveSeller(ctx, args);
      assertSellerCanSell(store);
      const db = ctx.db<typeof schema>();
      const before = (await db.select().from(schema.products).where(and(eq(schema.products.id, args.id), eq(schema.products.storeId, store.id))).limit(1))[0];
      if (!before) throw new Error("Product not found.");
      if (args.original_price_paisa != null && args.original_price_paisa <= args.price_paisa) throw new Error("The original price must be higher than the selling price.");
      const sku = args.sku === undefined ? before.sku : normalizeSku(args.sku);
      if (sku) {
        const clash = (await db.select({ id: schema.products.id }).from(schema.products).where(and(eq(schema.products.storeId, store.id), eq(schema.products.sku, sku))).limit(1))[0];
        if (clash && clash.id !== args.id) throw new Error(`The SKU "${sku}" is already used by another product in this shop.`);
      }
      const isActive = store.status === "active" && args.is_active;
      await db.update(schema.products).set({ name: args.name, category: args.category, description: args.description, pricePaisa: args.price_paisa, deliveryFeePaisa: args.delivery_fee_paisa, stock: args.stock, isActive, imageUrl: args.image_url ?? before.imageUrl, sku, brand: args.brand === undefined ? before.brand : args.brand?.trim() || null, originalPricePaisa: args.original_price_paisa === undefined ? before.originalPricePaisa : args.original_price_paisa, lowStockThreshold: args.low_stock_threshold ?? before.lowStockThreshold, updatedAt: new Date() }).where(and(eq(schema.products.id, args.id), eq(schema.products.storeId, store.id)));
      // Manual stock adjustments are part of the inventory trail, same as
      // order decrements and restores.
      if (args.stock !== before.stock) {
        await db.insert(schema.stockMovements).values({ productId: args.id, variantId: 0, change: args.stock - before.stock, stockAfter: args.stock, reason: "manual_adjust", actorType: "seller", actorId: String(store.id), createdAt: new Date() });
      }
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
  // Delete a product and everything attached to it: uploaded photo files,
  // variants, specs, reviews, carts and wishlist entries. A product that
  // already appears in order history cannot be deleted — order_items keeps a
  // real foreign key to it — so it is archived instead (hidden from the
  // shop, row kept), and the order history is never rewritten.
  deleteProduct: defineAction({
    request: z.object({ ...sellerAuthFields, id: z.number().int().positive() }), response: z.object({ ok: z.literal(true), archived: z.boolean() }),
    async handler(ctx, args): Promise<{ ok: true; archived: boolean }> {
      const store = await resolveSeller(ctx, args);
      assertSellerCanSell(store);
      const db = ctx.db<typeof schema>();
      const product = (await db.select({ id: schema.products.id, name: schema.products.name }).from(schema.products).where(and(eq(schema.products.id, args.id), eq(schema.products.storeId, store.id))).limit(1))[0];
      if (!product) throw new Error("Product not found.");
      const inHistory = (await db.select({ id: schema.orderItems.id }).from(schema.orderItems).where(eq(schema.orderItems.productId, args.id)).limit(1))[0];
      if (inHistory) {
        await db.update(schema.products).set({ isActive: false, updatedAt: new Date() }).where(and(eq(schema.products.id, args.id), eq(schema.products.storeId, store.id)));
        await audit(ctx, "seller", String(store.id), "product_archived", "product", String(args.id), `${product.name} (has order history)`);
        ctx.invalidateQueries();
        return { ok: true, archived: true };
      }
      const imageRows = await db.select({ url: schema.productImages.url }).from(schema.productImages).where(eq(schema.productImages.productId, args.id));
      for (const im of imageRows) deleteUploadFile(im.url);
      await db.delete(schema.productImages).where(eq(schema.productImages.productId, args.id));
      await db.delete(schema.productVariants).where(eq(schema.productVariants.productId, args.id));
      await db.delete(schema.productSpecifications).where(eq(schema.productSpecifications.productId, args.id));
      await db.delete(schema.reviews).where(eq(schema.reviews.productId, args.id));
      await db.delete(schema.cartItems).where(eq(schema.cartItems.productId, args.id));
      await db.delete(schema.wishlistItems).where(eq(schema.wishlistItems.productId, args.id));
      await db.delete(schema.productViews).where(eq(schema.productViews.productId, args.id));
      await db.delete(schema.recentlyViewed).where(eq(schema.recentlyViewed.productId, args.id));
      await db.delete(schema.products).where(and(eq(schema.products.id, args.id), eq(schema.products.storeId, store.id)));
      await audit(ctx, "seller", String(store.id), "product_deleted", "product", String(args.id), product.name);
      ctx.invalidateQueries();
      return { ok: true, archived: false };
    },
  }),
  // ---------- product variants (Seller checkpoint) ----------
  // Variants (size, colour, …) had a read path but no writer until now.
  // A variant may override the price (null = same as the product) and
  // carries its own stock; cart and order logic already consume it.
  listVariants: defineAction({
    request: z.object({ ...sellerAuthFields, product_id: z.number().int().positive() }),
    response: z.object({ variants: z.array(z.object({ id: z.number(), label: z.string(), sku: z.string().nullable(), price_paisa: z.number().nullable(), stock: z.number(), sort_order: z.number(), is_active: z.boolean() })) }),
    async handler(ctx, args) {
      const store = await resolveSeller(ctx, args);
      const db = ctx.db<typeof schema>();
      const product = (await db.select({ id: schema.products.id }).from(schema.products).where(and(eq(schema.products.id, args.product_id), eq(schema.products.storeId, store.id))).limit(1))[0];
      if (!product) throw new Error("Product not found.");
      const rows = await db.select().from(schema.productVariants).where(eq(schema.productVariants.productId, args.product_id)).orderBy(schema.productVariants.sortOrder, schema.productVariants.id);
      return { variants: rows.map((v) => ({ id: v.id, label: v.label, sku: v.sku ?? null, price_paisa: v.pricePaisa ?? null, stock: v.stock, sort_order: v.sortOrder, is_active: v.isActive })) };
    },
  }),
  createVariant: defineAction({
    request: z.object({ ...sellerAuthFields, product_id: z.number().int().positive(), label: z.string().trim().min(1).max(60), sku: z.string().trim().max(40).optional(), price_paisa: z.number().int().positive().nullish(), stock: z.number().int().min(0).max(100000).default(0), is_active: z.boolean().optional().default(true) }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const store = await resolveSeller(ctx, args);
      assertSellerCanSell(store);
      const db = ctx.db<typeof schema>();
      const product = (await db.select({ id: schema.products.id }).from(schema.products).where(and(eq(schema.products.id, args.product_id), eq(schema.products.storeId, store.id))).limit(1))[0];
      if (!product) throw new Error("Product not found.");
      const sku = normalizeSku(args.sku);
      if (sku) {
        const clash = (await db.select({ id: schema.productVariants.id }).from(schema.productVariants).where(and(eq(schema.productVariants.productId, args.product_id), eq(schema.productVariants.sku, sku))).limit(1))[0];
        if (clash) throw new Error(`The SKU "${sku}" is already used by another option of this product.`);
      }
      const isActive = store.status === "active" && args.is_active;
      const result = await db.insert(schema.productVariants).values({ productId: args.product_id, label: args.label.trim(), sku, pricePaisa: args.price_paisa ?? null, stock: args.stock, isActive, createdAt: new Date() }).returning({ id: schema.productVariants.id });
      const row = result[0];
      if (!row) throw new Error("The option could not be saved.");
      if (args.stock > 0) {
        await db.insert(schema.stockMovements).values({ productId: args.product_id, variantId: row.id, change: args.stock, stockAfter: args.stock, reason: "variant_created", actorType: "seller", actorId: String(store.id), createdAt: new Date() });
      }
      ctx.invalidateQueries();
      return { id: row.id };
    },
  }),
  updateVariant: defineAction({
    request: z.object({ ...sellerAuthFields, id: z.number().int().positive(), label: z.string().trim().min(1).max(60), sku: z.string().trim().max(40).nullish(), price_paisa: z.number().int().positive().nullish(), stock: z.number().int().min(0).max(100000), is_active: z.boolean() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const store = await resolveSeller(ctx, args);
      assertSellerCanSell(store);
      const db = ctx.db<typeof schema>();
      const variant = (await db.select().from(schema.productVariants).where(eq(schema.productVariants.id, args.id)).limit(1))[0];
      const product = variant ? (await db.select({ id: schema.products.id }).from(schema.products).where(and(eq(schema.products.id, variant.productId), eq(schema.products.storeId, store.id))).limit(1))[0] : undefined;
      if (!variant || !product) throw new Error("Option not found.");
      const sku = args.sku === undefined ? variant.sku : normalizeSku(args.sku);
      if (sku) {
        const clash = (await db.select({ id: schema.productVariants.id }).from(schema.productVariants).where(and(eq(schema.productVariants.productId, variant.productId), eq(schema.productVariants.sku, sku))).limit(1))[0];
        if (clash && clash.id !== args.id) throw new Error(`The SKU "${sku}" is already used by another option of this product.`);
      }
      const isActive = store.status === "active" && args.is_active;
      await db.update(schema.productVariants).set({ label: args.label.trim(), sku, pricePaisa: args.price_paisa === undefined ? variant.pricePaisa : args.price_paisa, stock: args.stock, isActive }).where(eq(schema.productVariants.id, args.id));
      if (args.stock !== variant.stock) {
        await db.insert(schema.stockMovements).values({ productId: variant.productId, variantId: args.id, change: args.stock - variant.stock, stockAfter: args.stock, reason: "manual_adjust", actorType: "seller", actorId: String(store.id), createdAt: new Date() });
      }
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),
  deleteVariant: defineAction({
    request: z.object({ ...sellerAuthFields, id: z.number().int().positive() }), response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const store = await resolveSeller(ctx, args);
      assertSellerCanSell(store);
      const db = ctx.db<typeof schema>();
      const variant = (await db.select().from(schema.productVariants).where(eq(schema.productVariants.id, args.id)).limit(1))[0];
      const product = variant ? (await db.select({ id: schema.products.id }).from(schema.products).where(and(eq(schema.products.id, variant.productId), eq(schema.products.storeId, store.id))).limit(1))[0] : undefined;
      if (!variant || !product) throw new Error("Option not found.");
      // Baskets holding this option are cleaned on next read (loadCart drops
      // stale lines); historical orders keep their own snapshot.
      await db.delete(schema.cartItems).where(and(eq(schema.cartItems.productId, variant.productId), eq(schema.cartItems.variantId, args.id)));
      await db.delete(schema.productVariants).where(eq(schema.productVariants.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),
  // ---------- inventory history (Inventory + Cart checkpoint) ----------
  // Read-only view over the stock_movements ledger: sellers see their own
  // products' trail (what each order took, what each cancel/return put back,
  // manual adjustments); the admin sees everything. A seller can never see
  // another shop's movements — the product set is always scoped first.
  sellerStockMovements: defineAction({
    request: z.object({ ...sellerAuthFields, product_id: z.number().int().positive().optional(), limit: z.number().int().min(1).max(100).default(30) }),
    response: z.object({ movements: z.array(stockMovementShape) }),
    async handler(ctx, args) {
      const store = await resolveSeller(ctx, args);
      const db = ctx.db<typeof schema>();
      const mine = await db.select({ id: schema.products.id }).from(schema.products).where(eq(schema.products.storeId, store.id));
      const mineIds = new Set(mine.map((p) => p.id));
      if (args.product_id && !mineIds.has(args.product_id)) throw new Error("Product not found.");
      const scope = args.product_id ? [args.product_id] : [...mineIds];
      if (!scope.length) return { movements: [] };
      return { movements: await loadMovements(ctx, scope, args.limit) };
    },
  }),
  adminStockMovements: defineAction({
    request: z.object({ authToken: authTokenField, product_id: z.number().int().positive().optional(), store_id: z.number().int().positive().optional(), limit: z.number().int().min(1).max(100).default(30) }),
    response: z.object({ movements: z.array(stockMovementShape) }),
    async handler(ctx, args) {
      await requireAuth(ctx, args.authToken, "admin");
      const db = ctx.db<typeof schema>();
      let scope: number[];
      if (args.product_id) {
        scope = [args.product_id];
      } else if (args.store_id) {
        const mine = await db.select({ id: schema.products.id }).from(schema.products).where(eq(schema.products.storeId, args.store_id));
        scope = mine.map((p) => p.id);
      } else {
        scope = (await db.select({ id: schema.products.id }).from(schema.products)).map((p) => p.id);
      }
      if (!scope.length) return { movements: [] };
      return { movements: await loadMovements(ctx, scope, args.limit) };
    },
  }),
  // ---------- product specifications (Seller checkpoint) ----------
  // A small structured label/value sheet per product ("Material → Cotton").
  // Sellers manage the rows; buyers read them on the product page.
  listSpecs: defineAction({
    request: z.object({ ...sellerAuthFields, product_id: z.number().int().positive() }),
    response: z.object({ specs: z.array(specShape) }),
    async handler(ctx, args) {
      const store = await resolveSeller(ctx, args);
      const db = ctx.db<typeof schema>();
      const product = (await db.select({ id: schema.products.id }).from(schema.products).where(and(eq(schema.products.id, args.product_id), eq(schema.products.storeId, store.id))).limit(1))[0];
      if (!product) throw new Error("Product not found.");
      return { specs: (await activeSpecs(ctx, args.product_id)).map((s) => ({ id: s.id, label: s.label, value: s.value })) };
    },
  }),
  createSpec: defineAction({
    request: z.object({ ...sellerAuthFields, product_id: z.number().int().positive(), label: z.string().trim().min(1).max(40), value: z.string().trim().min(1).max(200) }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const store = await resolveSeller(ctx, args);
      assertSellerCanSell(store);
      const db = ctx.db<typeof schema>();
      const product = (await db.select({ id: schema.products.id }).from(schema.products).where(and(eq(schema.products.id, args.product_id), eq(schema.products.storeId, store.id))).limit(1))[0];
      if (!product) throw new Error("Product not found.");
      const maxOrder = (await db.select({ o: schema.productSpecifications.sortOrder }).from(schema.productSpecifications).where(eq(schema.productSpecifications.productId, args.product_id)).orderBy(desc(schema.productSpecifications.sortOrder)).limit(1))[0]?.o ?? -1;
      const row = (await db.insert(schema.productSpecifications).values({ productId: args.product_id, label: args.label.trim(), value: args.value.trim(), sortOrder: maxOrder + 1 }).returning({ id: schema.productSpecifications.id }))[0];
      if (!row) throw new Error("The specification could not be saved.");
      ctx.invalidateQueries();
      return { id: row.id };
    },
  }),
  updateSpec: defineAction({
    request: z.object({ ...sellerAuthFields, id: z.number().int().positive(), label: z.string().trim().min(1).max(40), value: z.string().trim().min(1).max(200) }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const store = await resolveSeller(ctx, args);
      assertSellerCanSell(store);
      const db = ctx.db<typeof schema>();
      const spec = (await db.select().from(schema.productSpecifications).where(eq(schema.productSpecifications.id, args.id)).limit(1))[0];
      const product = spec ? (await db.select({ id: schema.products.id }).from(schema.products).where(and(eq(schema.products.id, spec.productId), eq(schema.products.storeId, store.id))).limit(1))[0] : undefined;
      if (!spec || !product) throw new Error("Specification not found.");
      await db.update(schema.productSpecifications).set({ label: args.label.trim(), value: args.value.trim() }).where(eq(schema.productSpecifications.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),
  deleteSpec: defineAction({
    request: z.object({ ...sellerAuthFields, id: z.number().int().positive() }), response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const store = await resolveSeller(ctx, args);
      assertSellerCanSell(store);
      const db = ctx.db<typeof schema>();
      const spec = (await db.select().from(schema.productSpecifications).where(eq(schema.productSpecifications.id, args.id)).limit(1))[0];
      const product = spec ? (await db.select({ id: schema.products.id }).from(schema.products).where(and(eq(schema.products.id, spec.productId), eq(schema.products.storeId, store.id))).limit(1))[0] : undefined;
      if (!spec || !product) throw new Error("Specification not found.");
      await db.delete(schema.productSpecifications).where(eq(schema.productSpecifications.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),
  // Multi-seller checkout. One customer checkout creates ONE order group
  // (the customer-facing order, tracked by group_code) plus one fulfilment
  // order per seller, linked via group_id. Inventory is deducted per seller
  // (variant-level), the coupon is applied once at group level and allocated
  // across fulfilments, and delivery follows each seller's own fees.
  placeOrder: defineAction({
    request: z.object({ authToken: authTokenField, customer_name: z.string().trim().min(2).max(80), phone: z.string().trim().min(7).max(20), address: z.string().trim().min(5).max(240), note: z.string().trim().max(400).default(""), cod_confirmed: z.literal(true).optional(), payment_method: paymentMethodEnum.default("cod"), coupon_code: z.string().trim().max(40).optional(), address_id: z.number().int().positive().optional(), delivery_method: deliveryMethodEnum.default("standard"), idempotency_key: z.string().trim().min(8).max(120).optional(), items: z.array(z.object({ product_id: z.number().int().positive(), quantity: z.number().int().min(1).max(20), variant_id: variantIdField })).min(1).max(30) }),
    response: z.object({ group_code: z.string(), group_id: z.number(), total_paisa: z.number(), payment_method: paymentMethodEnum, payment_status: groupPaymentStatusEnum, orders: z.array(z.object({ order_id: z.number(), order_code: z.string(), store_name: z.string(), total_paisa: z.number() })), order_code: z.string(), order_id: z.number(), status: z.literal("confirmation_needed") }),
    async handler(ctx, args) {
      if (args.payment_method === "cod" && args.cod_confirmed !== true) throw new Error("Please confirm Cash on Delivery to place the order.");
      const db = fullDb(ctx);
      // A signed-in buyer gets the order linked to their account. Other
      // session types (or no token) check out as a guest, unchanged. A token
      // that was sent but no longer resolves (expired or signed out
      // elsewhere) is NOT silently demoted to guest: the order would land
      // outside the buyer's account and their saved cart would survive while
      // the order vanished from My orders. Fail loudly instead — the client
      // keeps the form and basket intact so nothing is lost.
      const userId = await buyerIdOf(ctx, args.authToken);
      if (args.authToken && !userId) {
        throw new Error("Your session has expired. Please log in again to place this order — your basket and details are saved.");
      }
      if (args.address_id && userId) {
        const addr = (await db.select({ id: schema.addresses.id }).from(schema.addresses).where(and(eq(schema.addresses.id, args.address_id), eq(schema.addresses.userId, userId))).limit(1))[0];
        if (!addr) throw new Error("That delivery address was not found.");
      }
      const idemKey = args.idempotency_key?.trim() || null;
      // Ownership + payload binding for the idempotency key: a replay
      // returns the earlier group only when the caller identity matches
      // (signed-in user id, or the normalized guest phone) AND the checkout
      // payload is identical. A different caller or different details are
      // rejected without revealing the earlier submission.
      const idemOwnerId = userId ?? null;
      const idemGuestPhone = userId ? null : normalizePhone(args.phone);
      const idemPayload = idemKey ? JSON.stringify({
        items: args.items.map((i) => [i.product_id, i.quantity, i.variant_id ?? 0].join(":")).sort(),
        coupon: args.coupon_code?.trim().toUpperCase() ?? null,
        delivery: args.delivery_method, pay: args.payment_method,
        name: args.customer_name.trim(), phone: normalizePhone(args.phone),
        address: args.address.trim(), note: args.note.trim(), address_id: args.address_id ?? null,
      }) : null;
      const idemReplayOf = (prior: { groupId: number; userId: string | null; guestPhone: string | null; payload: string | null } | undefined): number | null => {
        if (!prior) return null;
        const ownerOk = (prior.userId ?? null) === idemOwnerId && (prior.guestPhone ?? null) === idemGuestPhone;
        if (!ownerOk || prior.payload !== idemPayload) {
          throw new Error("This checkout was already submitted. Please start a new checkout if your details changed.");
        }
        return prior.groupId;
      };
      // Fast-path replay: a key we have already fulfilled returns the same
      // group without touching inventory or coupons again. The authoritative
      // check runs inside the transaction below; this one just saves work.
      if (idemKey) {
        const prior = (await db.select().from(schema.checkoutIdempotency).where(eq(schema.checkoutIdempotency.key, idemKey)).limit(1))[0];
        const groupId = idemReplayOf(prior);
        if (groupId != null) {
          const replay = await loadOrderGroup(ctx, groupId);
          if (replay) { ctx.invalidateQueries(); return groupResponseOf(replay); }
        }
      }
      const ids = [...new Set(args.items.map((i) => i.product_id))];
      const actives = await activeStoreIds(ctx);
      // Fast pre-check for friendly errors; the authoritative stock check
      // happens again inside the transaction below.
      const preview = await db.select().from(schema.products).where(inArray(schema.products.id, ids));
      for (const sid of [...new Set(preview.map((p) => p.storeId))]) await assertStoreTakingOrders(ctx, sid);
      let groupSubtotal = 0;
      for (const item of args.items) {
        const product = preview.find((p) => p.id === item.product_id);
        if (!product || !product.isActive || !actives.has(product.storeId)) throw new Error("One of these products is no longer available.");
        const variant = await requireVariant(ctx, product.id, item.variant_id);
        const { unitPrice, stock } = linePricing(product, variant);
        if (stock < item.quantity) throw new Error(`${product.name}${variant ? ` (${variant.label})` : ""} has only ${stock} left.`);
        groupSubtotal += unitPrice * item.quantity;
      }
      // Coupon preview for friendly errors; the authoritative redemption
      // (atomic maxUses / per-user checks) happens inside the transaction.
      let couponId: number | null = null;
      if (args.coupon_code) {
        const evald = await evaluateCoupon(ctx, args.coupon_code, userId, groupSubtotal, args.phone);
        if (!evald.valid) throw new Error(evald.message);
        couponId = evald.coupon_id ?? null;
      }
      const now = new Date();
      const groupCode = `NSG-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`;
      const guestPhone = userId ? null : normalizePhone(args.phone);
      // Shipping methods and the express surcharge are admin-configurable
      // (platform_settings); they are read here, outside the transaction,
      // because the transaction callback must stay synchronous.
      const ship = await shippingConfig(ctx);
      if (args.delivery_method === "express" && !ship.express_enabled) throw new Error("Express delivery is not available right now.");
      if (args.delivery_method === "pickup" && !ship.pickup_enabled) throw new Error("Store pickup is not available right now.");
      if (args.delivery_method === "standard" && !ship.standard_enabled) throw new Error("Standard delivery is not available right now.");
      // Everything below runs in ONE transaction: products are re-read and
      // stock re-checked inside it, so overselling is impossible; the coupon
      // is redeemed atomically; and the idempotency key is written with the
      // group so a retried "Place order" can only ever create one group.
      const outcome = db.transaction((tx) => {
        const rows = tx.select().from(schema.products).where(inArray(schema.products.id, ids)).prepare().all();
        const variantRows = tx.select().from(schema.productVariants).where(inArray(schema.productVariants.productId, ids)).prepare().all();
        const normalized = args.items.map((item) => {
          const product = rows.find((p) => p.id === item.product_id);
          if (!product || !product.isActive || !actives.has(product.storeId)) throw new Error("One of these products is no longer available.");
          const variant = item.variant_id ? variantRows.find((v) => v.id === item.variant_id) ?? null : null;
          if (item.variant_id && (!variant || variant.productId !== item.product_id || !variant.isActive)) throw new Error("One of these product options is no longer available.");
          const { unitPrice, stock } = linePricing(product, variant);
          if (stock < item.quantity) throw new Error(`${product.name}${variant ? ` (${variant.label})` : ""} has only ${stock} left.`);
          return { product, variant, quantity: item.quantity, unitPrice };
        });
        if (!normalized.length) throw new Error("The order could not be created.");
        // Idempotency, authoritative: a key that already produced a group for
        // the same caller and payload returns that group instead of
        // creating a second one.
        if (idemKey) {
          const prior = tx.select().from(schema.checkoutIdempotency).where(eq(schema.checkoutIdempotency.key, idemKey)).limit(1).prepare().get();
          const groupId = idemReplayOf(prior);
          if (groupId != null) return { replay: true as const, groupId };
        }
        // Re-check vacation mode per seller inside the transaction: a seller
        // may have switched it on between the pre-check and now.
        const sellerIds = [...new Set(normalized.map((x) => x.product.storeId))];
        for (const sid of sellerIds) {
          const txStore = tx.select({ name: schema.storeSettings.storeName, vacation: schema.storeSettings.vacationMode }).from(schema.storeSettings).where(eq(schema.storeSettings.id, sid)).limit(1).prepare().get();
          if (txStore?.vacation) throw new Error(`${txStore.name} is on a short break and not taking orders right now. Please check back later.`);
        }
        // Atomic coupon redemption: usage limits are enforced against counts
        // taken inside this transaction, so concurrent checkouts cannot
        // overshoot maxUses and guests cannot bypass the per-user limit.
        let discount = 0, freeShipping = false, couponCode: string | null = null;
        if (couponId != null) {
          const redeemed = redeemCouponTx(tx, couponId, { userId, guestPhone }, groupSubtotal);
          discount = redeemed.discount; freeShipping = redeemed.freeShipping; couponCode = redeemed.code;
        }
        // Per-seller fulfilment totals. Delivery follows each seller's own
        // product delivery fees; the express surcharge (admin-configurable,
        // read into `ship` above) applies per fulfilment because each
        // seller ships their parcel separately.
        const perSeller = sellerIds.map((sid) => {
          const lines = normalized.filter((x) => x.product.storeId === sid);
          const subtotal = lines.reduce((s, x) => s + x.unitPrice * x.quantity, 0);
          const baseDelivery = lines.reduce((s, x) => s + x.product.deliveryFeePaisa * x.quantity, 0);
          let delivery = args.delivery_method === "pickup" ? 0 : baseDelivery + (args.delivery_method === "express" ? ship.express_fee_paisa : 0);
          if (freeShipping) delivery = 0;
          return { storeId: sid, lines, subtotal, delivery, discount: 0, total: 0 };
        });
        // The group discount is allocated across fulfilments proportionally;
        // the last fulfilment absorbs rounding so the group total is exact.
        let allocated = 0;
        perSeller.forEach((s, i) => {
          s.discount = i === perSeller.length - 1 ? discount - allocated : Math.round((discount * s.subtotal) / groupSubtotal);
          allocated += s.discount;
          s.total = Math.max(0, s.subtotal - s.discount) + s.delivery;
        });
        const groupDelivery = perSeller.reduce((s, x) => s + x.delivery, 0);
        const groupTotal = perSeller.reduce((s, x) => s + x.total, 0);
        const g = tx.insert(schema.orderGroups).values({
          groupCode, userId, customerName: args.customer_name, phone: args.phone,
          address: args.address, paymentMethod: args.payment_method,
          subtotalPaisa: groupSubtotal, deliveryFeePaisa: groupDelivery,
          discountPaisa: discount, totalPaisa: groupTotal, couponCode,
          deliveryMethod: args.delivery_method, note: args.note, createdAt: now,
        }).returning({ id: schema.orderGroups.id }).prepare().all();
        const groupRow = g[0];
        if (!groupRow) throw new Error("The order could not be created.");
        const created: { orderId: number; orderCode: string }[] = [];
        // Low-stock crossings detected inside the transaction: an item that
        // drops to (or below) its threshold for the first time earns one
        // alert email after the commit. Items already at/below the threshold
        // do not re-alert on every order.
        const lowStockHits: { storeId: number; name: string; variantLabel: string | null; stock: number }[] = [];
        for (const s of perSeller) {
          const orderCode = `NP-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`;
          const inserted = tx.insert(schema.orders).values({
            storeId: s.storeId, groupId: groupRow.id, userId, orderCode,
            customerName: args.customer_name, phone: args.phone, address: args.address, note: args.note,
            subtotalPaisa: s.subtotal, deliveryFeePaisa: s.delivery, totalPaisa: s.total,
            paymentMethod: args.payment_method, paymentStatus: "pending",
            discountPaisa: s.discount, couponCode, deliveryMethod: args.delivery_method,
            addressId: args.address_id ?? null, status: "confirmation_needed", createdAt: now, updatedAt: now,
          }).returning({ id: schema.orders.id }).prepare().all();
          const orderRow = inserted[0];
          if (!orderRow) throw new Error("The order could not be created.");
          tx.insert(schema.orderItems).values(s.lines.map(({ product, variant, quantity, unitPrice }) => ({ orderId: orderRow.id, productId: product.id, productName: product.name, quantity, unitPricePaisa: unitPrice, variantId: variant?.id ?? 0, variantLabel: variant?.label ?? null }))).prepare().run();
          for (const { product, variant, quantity } of s.lines) {
            // Every decrement writes a movement row so sellers can reconcile
            // exactly what each order took off the shelf.
            const threshold = product.lowStockThreshold ?? 5;
            if (variant) {
              const before = variant.stock;
              const after = before - quantity;
              tx.update(schema.productVariants).set({ stock: after }).where(eq(schema.productVariants.id, variant.id)).prepare().run();
              recordMovementTx(tx, { productId: product.id, variantId: variant.id, change: -quantity, stockAfter: after, reason: "order_placed", orderId: orderRow.id, actorType: userId ? "buyer" : "guest", actorId: userId ?? "" });
              if (before > threshold && after <= threshold) lowStockHits.push({ storeId: s.storeId, name: product.name, variantLabel: variant.label, stock: after });
            } else {
              const before = product.stock;
              const after = before - quantity;
              tx.update(schema.products).set({ stock: after, updatedAt: now }).where(eq(schema.products.id, product.id)).prepare().run();
              recordMovementTx(tx, { productId: product.id, variantId: 0, change: -quantity, stockAfter: after, reason: "order_placed", orderId: orderRow.id, actorType: userId ? "buyer" : "guest", actorId: userId ?? "" });
              if (before > threshold && after <= threshold) lowStockHits.push({ storeId: s.storeId, name: product.name, variantLabel: null, stock: after });
            }
          }
          if (args.payment_method === "cod") {
            // COD keeps one payment row per fulfilment: cash is collected per
            // parcel and each seller's fulfilment settles independently.
            tx.insert(schema.payments).values({ orderId: orderRow.id, groupId: groupRow.id, provider: "cod", amountPaisa: s.total, status: "pending", createdAt: now, updatedAt: now }).prepare().run();
          }
          created.push({ orderId: orderRow.id, orderCode });
        }
        if (args.payment_method !== "cod") {
          // Online wallets take ONE payment for the whole group — the
          // customer pays once. order_id points at the first fulfilment for
          // the legacy unique constraint; group_id is the authoritative link.
          const first = created[0];
          if (!first) throw new Error("The order could not be created.");
          tx.insert(schema.payments).values({ orderId: first.orderId, groupId: groupRow.id, provider: args.payment_method, amountPaisa: groupTotal, status: "pending", createdAt: now, updatedAt: now }).prepare().run();
        }
        if (couponId != null) {
          // One usage row per group checkout (not per fulfilment): the
          // coupon was applied once, at group level.
          const first = created[0];
          if (!first) throw new Error("The order could not be created.");
          tx.insert(schema.couponUsages).values({ couponId, userId, guestPhone, orderId: first.orderId, groupId: groupRow.id, usedAt: now }).prepare().run();
        }
        if (userId) {
          const cart = tx.select().from(schema.carts).where(eq(schema.carts.userId, userId)).limit(1).prepare().get();
          if (cart) tx.delete(schema.cartItems).where(eq(schema.cartItems.cartId, cart.id)).prepare().run();
          tx.insert(schema.notifications).values({ userId, type: "order_placed", title: `Order ${groupCode} placed`, body: `Thanks ${args.customer_name}! Your order of ${formatRs(groupTotal)} is awaiting confirmation.`, link: "#/orders", createdAt: now }).prepare().run();
        }
        if (idemKey) {
          tx.insert(schema.checkoutIdempotency).values({ key: idemKey, groupId: groupRow.id, userId: idemOwnerId, guestPhone: idemGuestPhone, payload: idemPayload, createdAt: now }).prepare().run();
          // Prune keys older than 7 days so the table does not grow forever.
          tx.delete(schema.checkoutIdempotency).where(lt(schema.checkoutIdempotency.createdAt, new Date(Date.now() - 7 * 86400 * 1000))).prepare().run();
        }
        return { replay: false as const, groupId: groupRow.id, lowStockHits };
      });
      ctx.invalidateQueries();
      const view = await loadOrderGroup(ctx, outcome.groupId);
      if (!view) throw new Error("The order could not be created.");
      if (!outcome.replay) {
        // Transactional emails for a fresh order — buyer confirmation, one
        // "new order" mail per seller, and low-stock alerts. Best-effort and
        // AFTER the commit: a failed send is logged honestly and never
        // breaks the order (sendEmail never throws).
        const fuls = await db.select({
          id: schema.orders.id, orderCode: schema.orders.orderCode, storeId: schema.orders.storeId, totalPaisa: schema.orders.totalPaisa,
        }).from(schema.orders).where(eq(schema.orders.groupId, outcome.groupId));
        if (fuls.length) {
          const itemRows = await db.select().from(schema.orderItems).where(inArray(schema.orderItems.orderId, fuls.map((f) => f.id)));
          const storeRows = await db.select({ id: schema.storeSettings.id, name: schema.storeSettings.storeName }).from(schema.storeSettings).where(inArray(schema.storeSettings.id, [...new Set(fuls.map((f) => f.storeId))]));
          const storeNameOf = (id: number) => storeRows.find((s) => s.id === id)?.name ?? "Seller";
          const emailFuls = fuls.map((f) => {
            const lines: OrderLineSummary[] = itemRows
              .filter((i) => i.orderId === f.id)
              .map((i) => ({ name: i.productName, variantLabel: i.variantLabel, quantity: i.quantity, totalPaisa: i.unitPricePaisa * i.quantity }));
            return { orderCode: f.orderCode, storeName: storeNameOf(f.storeId), lines, totalPaisa: f.totalPaisa };
          });
          await emailBuyerMsg(ctx, userId, (to, name) =>
            orderConfirmationEmail(to, name, groupCode, emailFuls, view.total_paisa, args.payment_method));
          for (const f of fuls) {
            const lines: OrderLineSummary[] = itemRows
              .filter((i) => i.orderId === f.id)
              .map((i) => ({ name: i.productName, variantLabel: i.variantLabel, quantity: i.quantity, totalPaisa: i.unitPricePaisa * i.quantity }));
            await emailSellerMsg(ctx, f.storeId, (to, storeName) =>
              sellerNewOrderEmail(to, storeName, f.orderCode, lines, f.totalPaisa, args.customer_name.trim(), args.phone.trim(), args.address.trim()));
          }
        }
        // One aggregated low-stock email per seller.
        const hitsByStore = new Map<number, LowStockItem[]>();
        for (const h of outcome.lowStockHits) {
          const list = hitsByStore.get(h.storeId) ?? [];
          list.push({ name: h.name, variantLabel: h.variantLabel, stock: h.stock });
          hitsByStore.set(h.storeId, list);
        }
        for (const [storeId, items] of hitsByStore) {
          await emailSellerMsg(ctx, storeId, (to, storeName) => lowStockEmail(to, storeName, items));
        }
      }
      return groupResponseOf(view);
    },
  }),
  listOrders: defineAction({
    request: z.object({ ...sellerAuthFields, limit: z.number().int().positive().max(100).default(50) }), response: z.object({ orders: z.array(orderShape) }),
    async handler(ctx, args) {
      const store = await resolveSeller(ctx, args);
      const db = ctx.db<typeof schema>();
      const orders = await db.select().from(schema.orders).where(eq(schema.orders.storeId, store.id)).orderBy(desc(schema.orders.createdAt)).limit(args.limit);
      const items = orders.length ? await db.select().from(schema.orderItems).where(inArray(schema.orderItems.orderId, orders.map((o) => o.id))) : [];
      const groupIds = [...new Set(orders.map((o) => o.groupId).filter((g): g is number => g != null))];
      const groups = groupIds.length ? await db.select({ id: schema.orderGroups.id, code: schema.orderGroups.groupCode }).from(schema.orderGroups).where(inArray(schema.orderGroups.id, groupIds)) : [];
      const codeOf = (gid: number | null) => gid == null ? null : groups.find((g) => g.id === gid)?.code ?? null;
      const extras = await orderExtras(ctx, orders.map((o) => o.id));
      return { orders: orders.map((o) => mapOrder(o, items, codeOf(o.groupId), extras.get(o.id))) };
    },
  }),
  // Tracks by the customer-facing group code (NSG-…) or by a fulfilment code
  // (NP-…). Returns the group view for group codes and the single-order view
  // for fulfilment codes, so older clients and seller fulfilment references
  // keep working.
  trackOrder: defineAction({
    request: z.object({ order_code: z.string().trim().min(4), phone: z.string().trim().min(7), authToken: authTokenField }), response: z.object({ order: orderShape.nullable(), group: orderGroupShape.nullable() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const code = args.order_code.toUpperCase();
      const phone = args.phone.trim();
      const group = (await db.select().from(schema.orderGroups).where(and(eq(schema.orderGroups.groupCode, code), eq(schema.orderGroups.phone, phone))).limit(1))[0];
      if (group) {
        if (group.userId) {
          // A registered buyer's order is private: the phone number alone is
          // not proof of identity (it is semi-public), so require the
          // buyer's own session. The client attaches authToken automatically
          // when the buyer is signed in; guest orders keep phone-based
          // tracking.
          const callerId = await buyerIdOf(ctx, args.authToken);
          if (callerId !== group.userId) return { order: null, group: null };
        }
        const view = await loadOrderGroup(ctx, group.id);
        return { order: null, group: view ? publicGroupView(view) : null };
      }
      const order = (await db.select().from(schema.orders).where(and(eq(schema.orders.orderCode, code), eq(schema.orders.phone, phone))).limit(1))[0];
      if (!order) return { order: null, group: null };
      if (order.userId) {
        const callerId = await buyerIdOf(ctx, args.authToken);
        if (callerId !== order.userId) return { order: null, group: null };
      }
      const items = await db.select().from(schema.orderItems).where(eq(schema.orderItems.orderId, order.id));
      const gcode = order.groupId ? (await db.select({ code: schema.orderGroups.groupCode }).from(schema.orderGroups).where(eq(schema.orderGroups.id, order.groupId)).limit(1))[0]?.code ?? null : null;
      const extras = await orderExtras(ctx, [order.id]);
      return { order: mapOrder(order, items, gcode, extras.get(order.id)), group: null };
    },
  }),
  // Buyer-initiated cancellation. Cancelling one fulfilment of a group
  // cancels the WHOLE group: the customer experiences a single order, so
  // every seller's reserved stock is released and the group payment voided,
  // atomically. A signed-in buyer cancels by order id, fulfilment code or
  // group code; a guest cancels with the same order-code + phone proof that
  // trackOrder accepts. Only groups no seller has started packing can be
  // cancelled.
  cancelOrder: defineAction({
    request: z.object({ authToken: authTokenField, order_id: z.number().int().positive().optional(), order_code: z.string().trim().min(4).max(40).optional(), group_code: z.string().trim().min(4).max(40).optional(), phone: z.string().trim().min(7).max(20).optional() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      const buyerId = await buyerIdOf(ctx, args.authToken);
      let group: typeof schema.orderGroups.$inferSelect | undefined;
      let order: typeof schema.orders.$inferSelect | undefined;
      if (args.group_code) {
        const code = args.group_code.toUpperCase();
        group = buyerId
          ? (await db.select().from(schema.orderGroups).where(and(eq(schema.orderGroups.groupCode, code), eq(schema.orderGroups.userId, buyerId))).limit(1))[0]
          : args.phone
            ? (await db.select().from(schema.orderGroups).where(and(eq(schema.orderGroups.groupCode, code), eq(schema.orderGroups.phone, args.phone.trim()))).limit(1))[0]
            : undefined;
        if (!group || (group.userId && group.userId !== buyerId)) throw new Error("That order was not found.");
      } else if (buyerId && args.order_id) {
        order = (await db.select().from(schema.orders).where(and(eq(schema.orders.id, args.order_id), eq(schema.orders.userId, buyerId))).limit(1))[0];
        if (!order) throw new Error("That order was not found.");
      } else if (args.order_code && args.phone) {
        order = (await db.select().from(schema.orders).where(and(eq(schema.orders.orderCode, args.order_code.toUpperCase()), eq(schema.orders.phone, args.phone.trim()))).limit(1))[0];
        if (!order || order.userId) throw new Error("That order was not found.");
      } else {
        throw new Error("Please sign in or provide your order code and phone number.");
      }
      // Expand a single fulfilment to its whole group: the customer cancels
      // one order, not one seller's parcel.
      let orderIds: number[];
      let displayCode: string;
      let notifyUserId: string | null;
      if (group) {
        const subs = await db.select({ id: schema.orders.id }).from(schema.orders).where(eq(schema.orders.groupId, group.id));
        orderIds = subs.map((s) => s.id);
        displayCode = group.groupCode;
        notifyUserId = group.userId;
      } else if (order) {
        if (order.groupId) {
          const subs = await db.select({ id: schema.orders.id }).from(schema.orders).where(eq(schema.orders.groupId, order.groupId));
          orderIds = subs.map((s) => s.id);
          const g = (await db.select({ code: schema.orderGroups.groupCode }).from(schema.orderGroups).where(eq(schema.orderGroups.id, order.groupId)).limit(1))[0];
          displayCode = g?.code ?? order.orderCode;
        } else {
          orderIds = [order.id];
          displayCode = order.orderCode;
        }
        notifyUserId = order.userId;
      } else {
        throw new Error("That order was not found.");
      }
      if (!orderIds.length) throw new Error("That order was not found.");
      // The status guard, stock restore, status write and payment void run in
      // ONE transaction: double-clicking cancel (or a buyer and the seller
      // cancelling at once) can no longer restore the same stock twice, and
      // a group is never left half-cancelled.
      fullDb(ctx).transaction((tx) => {
        cancelFulfilmentsTx(tx, orderIds, buyerId ? "buyer" : "guest", buyerId ?? args.phone ?? "");
      });
      if (notifyUserId) {
        await notifyUser(ctx, notifyUserId, { type: "order_status", title: `Order ${displayCode} cancelled`, body: `Your order ${displayCode} was cancelled. No payment is due.`, link: "#/orders" });
      }
      await emailBuyerMsg(ctx, notifyUserId, (to, name) => orderCancelledBuyerEmail(to, name, displayCode, "buyer"));
      // Every affected seller must know not to dispatch.
      if (orderIds.length) {
        const cancelled = await db.select({ orderCode: schema.orders.orderCode, storeId: schema.orders.storeId }).from(schema.orders).where(inArray(schema.orders.id, orderIds));
        for (const c of cancelled) {
          await emailSellerMsg(ctx, c.storeId, (to, storeName) => orderCancelledSellerEmail(to, storeName, c.orderCode, "buyer"));
        }
      }
      await audit(ctx, buyerId ? "buyer" : "guest", buyerId ?? args.phone ?? "unknown", "cancel_order", "order_group", orderIds.join(","), displayCode);
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),
  updateOrderStatus: defineAction({
    request: z.object({ ...sellerAuthFields, order_id: z.number().int().positive(), status: orderStatus }), response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const store = await resolveSeller(ctx, args);
      const db = ctx.db<typeof schema>();
      const order = (await db.select().from(schema.orders).where(and(eq(schema.orders.id, args.order_id), eq(schema.orders.storeId, store.id))).limit(1))[0];
      if (!order) throw new Error("Order not found.");
      await transitionOrderStatus(ctx, order, args.status, { type: "seller", id: String(store.id) });
      await audit(ctx, "seller", String(store.id), "order_status_changed", "order", String(order.id), `${order.status} → ${args.status}`);
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
      // One verified review per product per order: repeated submissions
      // would inflate the product rating and search ranking.
      const existing = (await db.select({ id: schema.reviews.id }).from(schema.reviews).where(and(eq(schema.reviews.orderId, order.id), eq(schema.reviews.productId, args.product_id))).limit(1))[0];
      if (existing) throw new Error("You have already reviewed this product from this order.");
      try {
        await db.insert(schema.reviews).values({ orderId: order.id, productId: args.product_id, reviewerName: order.customerName, rating: args.rating, body: args.body });
      } catch {
        throw new Error("You have already reviewed this product from this order.");
      }
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
      // v7 money tables: nothing writes them yet, but keep the hard-delete
      // cascade complete so a future ledger/payout row can never block the
      // store delete with a foreign-key violation or dangle afterwards.
      // Ledger first: seller_ledger.order_id references orders.id, which is
      // deleted below.
      await db.delete(schema.sellerLedger).where(eq(schema.sellerLedger.storeId, store.id));
      await db.delete(schema.sellerPayouts).where(eq(schema.sellerPayouts.storeId, store.id));
      await db.delete(schema.sellerPayoutDetails).where(eq(schema.sellerPayoutDetails.storeId, store.id));
      await db.delete(schema.sellerEmailVerifications).where(eq(schema.sellerEmailVerifications.storeId, store.id));
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
    response: z.object({ sellers: z.number(), products: z.number(), orders: z.number(), users: z.number(), revenue_paisa: z.number(), pending_sellers: z.number(), open_issues: z.number(), refunded_orders: z.number(), open_tickets: z.number(), open_review_reports: z.number() }),
    async handler(ctx, args) {
      await requireAuth(ctx, args.authToken, "admin");
      const db = ctx.db<typeof schema>();
      const [sellers, products, orders, users, issues, tickets, reports] = await Promise.all([
        db.select({ id: schema.storeSettings.id, status: schema.storeSettings.status }).from(schema.storeSettings),
        db.select({ id: schema.products.id }).from(schema.products),
        db.select({ total: schema.orders.totalPaisa, status: schema.orders.status }).from(schema.orders),
        db.select({ id: schema.users.id }).from(schema.users),
        db.select({ id: schema.buyerIssues.id }).from(schema.buyerIssues).where(eq(schema.buyerIssues.status, "open")),
        db.select({ id: schema.supportTickets.id }).from(schema.supportTickets).where(eq(schema.supportTickets.status, "open")),
        db.select({ id: schema.reviewReports.id }).from(schema.reviewReports).where(eq(schema.reviewReports.status, "open")),
      ]);
      return {
        sellers: sellers.length,
        products: products.length,
        orders: orders.length,
        users: users.length,
        revenue_paisa: orders.filter((o) => o.status !== "cancelled").reduce((n, o) => n + o.total, 0),
        pending_sellers: sellers.filter((s) => s.status === "pending").length,
        open_issues: issues.length,
        refunded_orders: orders.filter((o) => o.status === "refunded").length,
        open_tickets: tickets.length,
        open_review_reports: reports.length,
      };
    },
  }),
  adminListSellers: defineAction({
    request: z.object({ authToken: authTokenField, q: z.string().trim().max(80).optional() }),
    response: z.object({ sellers: z.array(z.object({ id: z.number(), seller_code: z.string(), store_name: z.string(), location: z.string(), phone: z.string(), email: z.string().nullable(), status: sellerStatus, email_verified: z.boolean(), product_count: z.number(), order_count: z.number(), created_at: z.string() })) }),
    async handler(ctx, args) {
      await requireAuth(ctx, args.authToken, "admin");
      const db = ctx.db<typeof schema>();
      const q = args.q?.trim();
      // Per-seller product/order counts come from grouped COUNT queries —
      // never by loading every product and order row into memory.
      const [sellers, productCounts, orderCounts] = await Promise.all([
        q
          ? await db.select().from(schema.storeSettings).where(or(like(schema.storeSettings.storeName, `%${q}%`), like(schema.storeSettings.sellerCode, `%${q}%`), like(schema.storeSettings.email, `%${q}%`))).orderBy(desc(schema.storeSettings.createdAt))
          : await db.select().from(schema.storeSettings).orderBy(desc(schema.storeSettings.createdAt)),
        db.select({ storeId: schema.products.storeId, n: count() }).from(schema.products).groupBy(schema.products.storeId),
        db.select({ storeId: schema.orders.storeId, n: count() }).from(schema.orders).groupBy(schema.orders.storeId),
      ]);
      const productCountByStore = new Map(productCounts.map((r) => [r.storeId, r.n]));
      const orderCountByStore = new Map(orderCounts.map((r) => [r.storeId, r.n]));
      return {
        sellers: sellers.map((s) => ({
          id: s.id, seller_code: s.sellerCode, store_name: s.storeName, location: s.location, phone: s.phone, email: s.email, status: s.status, email_verified: !!s.emailVerified,
          product_count: productCountByStore.get(s.id) ?? 0,
          order_count: orderCountByStore.get(s.id) ?? 0,
          created_at: s.createdAt.toISOString(),
        })),
      };
    },
  }),
  adminSetSellerStatus: defineAction({
    request: z.object({ authToken: authTokenField, seller_id: z.number().int().positive(), status: sellerStatus }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const auth = await requireAuth(ctx, args.authToken, "admin");
      const db = ctx.db<typeof schema>();
      const store = (await db.select({ id: schema.storeSettings.id, status: schema.storeSettings.status, emailVerified: schema.storeSettings.emailVerified }).from(schema.storeSettings).where(eq(schema.storeSettings.id, args.seller_id)).limit(1))[0];
      if (!store) throw new Error("Seller not found.");
      // Legal lifecycle transitions: the admin can only move a shop along
      // the defined path, never jump arbitrarily between states.
      const LEGAL: Record<string, string[]> = {
        pending: ["under_review", "rejected"],
        under_review: ["active", "rejected"],
        active: ["suspended"],
        suspended: ["active"],
        rejected: [],
      };
      if (!(LEGAL[store.status] ?? []).includes(args.status)) throw new Error(`A shop cannot move from "${store.status}" to "${args.status}".`);
      if (args.status === "active" && !store.emailVerified) throw new Error("Approve only after the seller's email is verified.");
      await db.update(schema.storeSettings).set({ status: args.status, updatedAt: new Date() }).where(eq(schema.storeSettings.id, args.seller_id));
      if (args.status === "suspended") {
        // A suspended seller must not keep managing the shop on an existing session.
        await db.delete(schema.sessions).where(and(eq(schema.sessions.userType, "seller"), eq(schema.sessions.userId, String(args.seller_id))));
      }
      // The seller always hears about their own account status, by email.
      // A suspended → active move is a reactivation, not a first approval.
      if (args.status !== "pending") {
        const event: SellerAccountEvent = args.status === "active" && store.status === "suspended" ? "reactivated" : (args.status as SellerAccountEvent);
        await emailSellerMsg(ctx, args.seller_id, (to, storeName) => sellerAccountStatusEmail(to, storeName, event));
      }
      await audit(ctx, "admin", auth.id, "seller_status_changed", "store", String(args.seller_id), `${store.status} → ${args.status}`);
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),
  adminListProducts: defineAction({
    request: z.object({ authToken: authTokenField, seller_id: z.number().int().positive().optional(), q: z.string().trim().max(80).optional(), moderation: z.boolean().optional() }),
    response: z.object({ products: z.array(z.object({ id: z.number(), name: z.string(), category: z.string(), price_paisa: z.number(), stock: z.number(), is_active: z.boolean(), store_name: z.string(), seller_code: z.string(), seller_status: sellerStatus })) }),
    async handler(ctx, args) {
      await requireAuth(ctx, args.authToken, "admin");
      const db = ctx.db<typeof schema>();
      const stores = await db.select().from(schema.storeSettings);
      const storeById = new Map(stores.map((s) => [s.id, s]));
      const q = args.q?.trim().toLowerCase();
      let products = args.seller_id
        ? await db.select().from(schema.products).where(eq(schema.products.storeId, args.seller_id)).orderBy(desc(schema.products.createdAt))
        : await db.select().from(schema.products).orderBy(desc(schema.products.createdAt)).limit(200);
      if (q) products = products.filter((p) => p.name.toLowerCase().includes(q) || p.category.toLowerCase().includes(q));
      if (args.moderation) {
        // The moderation queue: hidden products plus anything listed by a
        // shop that is not an approved, active seller.
        products = products.filter((p) => !p.isActive || storeById.get(p.storeId)?.status !== "active");
      }
      return {
        products: products.map((p) => {
          const store = storeById.get(p.storeId);
          return { id: p.id, name: p.name, category: p.category, price_paisa: p.pricePaisa, stock: p.stock, is_active: p.isActive, store_name: store?.storeName ?? "Seller", seller_code: store?.sellerCode ?? "", seller_status: store?.status ?? "active" };
        }),
      };
    },
  }),
  adminSetProductActive: defineAction({
    request: z.object({ authToken: authTokenField, product_id: z.number().int().positive(), active: z.boolean() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const auth = await requireAuth(ctx, args.authToken, "admin");
      const db = ctx.db<typeof schema>();
      const product = (await db.select({ id: schema.products.id, name: schema.products.name, storeId: schema.products.storeId }).from(schema.products).where(eq(schema.products.id, args.product_id)).limit(1))[0];
      if (!product) throw new Error("Product not found.");
      await db.update(schema.products).set({ isActive: args.active, updatedAt: new Date() }).where(eq(schema.products.id, args.product_id));
      await emailSellerMsg(ctx, product.storeId, (to, storeName) => productModerationEmail(to, storeName, product.name, args.active));
      await audit(ctx, "admin", auth.id, args.active ? "product_shown" : "product_hidden", "product", String(args.product_id), product.name);
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
      const orders = args.status
        ? await db.select().from(schema.orders).where(eq(schema.orders.status, args.status)).orderBy(desc(schema.orders.createdAt)).limit(100)
        : await db.select().from(schema.orders).orderBy(desc(schema.orders.createdAt)).limit(100);
      // Items and groups are fetched only for the orders on screen — never
      // the whole order_items table.
      const orderIds = orders.map((o) => o.id);
      const [items, stores, groups] = await Promise.all([
        orderIds.length ? db.select().from(schema.orderItems).where(inArray(schema.orderItems.orderId, orderIds)) : [],
        db.select({ id: schema.storeSettings.id, name: schema.storeSettings.storeName }).from(schema.storeSettings),
        db.select({ id: schema.orderGroups.id, code: schema.orderGroups.groupCode }).from(schema.orderGroups),
      ]);
      const codeOf = (gid: number | null) => gid == null ? null : groups.find((g) => g.id === gid)?.code ?? null;
      return { orders: orders.map((o) => ({ ...mapOrder(o, items, codeOf(o.groupId)), store_name: stores.find((s) => s.id === o.storeId)?.name ?? "Seller" })) };
    },
  }),
  // Admin sees the customer-facing group together with every fulfilment:
  // one row per checkout, expanded into per-seller orders.
  adminListOrderGroups: defineAction({
    request: z.object({ authToken: authTokenField, limit: z.number().int().positive().max(100).default(50) }), response: z.object({ groups: z.array(orderGroupShape) }),
    async handler(ctx, args) {
      await requireAuth(ctx, args.authToken, "admin");
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.orderGroups).orderBy(desc(schema.orderGroups.createdAt)).limit(args.limit);
      const views: z.infer<typeof orderGroupShape>[] = [];
      for (const g of rows) {
        const view = await loadOrderGroup(ctx, g.id);
        if (view) views.push(publicGroupView(view));
      }
      return { groups: views };
    },
  }),
  adminGetOrderGroup: defineAction({
    request: z.object({ authToken: authTokenField, group_id: z.number().int().positive().optional(), group_code: z.string().trim().min(4).max(40).optional() }), response: z.object({ group: orderGroupShape.nullable() }),
    async handler(ctx, args) {
      await requireAuth(ctx, args.authToken, "admin");
      const db = ctx.db<typeof schema>();
      let groupId = args.group_id ?? null;
      if (groupId == null && args.group_code) {
        groupId = (await db.select({ id: schema.orderGroups.id }).from(schema.orderGroups).where(eq(schema.orderGroups.groupCode, args.group_code.toUpperCase())).limit(1))[0]?.id ?? null;
      }
      if (groupId == null) return { group: null };
      const view = await loadOrderGroup(ctx, groupId);
      return { group: view ? publicGroupView(view) : null };
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
      const auth = await requireAuth(ctx, args.authToken, "admin");
      const db = ctx.db<typeof schema>();
      const issue = (await db.select({ id: schema.buyerIssues.id }).from(schema.buyerIssues).where(eq(schema.buyerIssues.id, args.issue_id)).limit(1))[0];
      if (!issue) throw new Error("Issue not found.");
      await db.update(schema.buyerIssues).set({ status: "resolved", updatedAt: new Date() }).where(eq(schema.buyerIssues.id, args.issue_id));
      await audit(ctx, "admin", auth.id, "buyer_issue_resolved", "buyer_issue", String(args.issue_id), "");
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),
  adminListUsers: defineAction({
    request: z.object({ authToken: authTokenField, q: z.string().trim().max(80).optional() }),
    response: z.object({ users: z.array(z.object({ id: z.string(), name: z.string(), phone: z.string(), email: z.string().nullable(), status: z.enum(["active", "suspended"]), order_count: z.number(), created_at: z.string() })) }),
    async handler(ctx, args) {
      await requireAuth(ctx, args.authToken, "admin");
      const db = ctx.db<typeof schema>();
      const q = args.q?.trim();
      // Order counts come from a grouped COUNT — never the whole orders table.
      const [users, orderCounts] = await Promise.all([
        q
          ? await db.select().from(schema.users).where(or(like(schema.users.name, `%${q}%`), like(schema.users.phone, `%${q}%`), like(schema.users.email, `%${q}%`))).orderBy(desc(schema.users.createdAt)).limit(200)
          : await db.select().from(schema.users).orderBy(desc(schema.users.createdAt)).limit(200),
        db.select({ userId: schema.orders.userId, n: count() }).from(schema.orders).groupBy(schema.orders.userId),
      ]);
      const orderCountByUser = new Map(orderCounts.map((r) => [r.userId, r.n]));
      return {
        users: users.map((u) => ({ id: u.id, name: u.name, phone: u.phone, email: u.email, status: u.status, order_count: orderCountByUser.get(u.id) ?? 0, created_at: u.createdAt.toISOString() })),
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
      await revokeOtherSessions(ctx, "admin", admin.id, args.authToken);
      await audit(ctx, "admin", admin.id, "admin_change_password", "admin", admin.id, "Admin changed their own password.");
      return { ok: true };
    },
  }),
  // ---------- admin: audit trail viewer ----------
  adminListAuditLogs: defineAction({
    request: z.object({ authToken: authTokenField, limit: z.number().int().min(1).max(200).optional().default(50), offset: z.number().int().min(0).optional().default(0) }),
    response: z.object({ entries: z.array(z.object({ id: z.number(), actor_type: z.string(), actor_id: z.string(), action: z.string(), entity_type: z.string(), entity_id: z.string(), detail: z.string(), created_at: z.string() })), total: z.number() }),
    async handler(ctx, args) {
      await requireAuth(ctx, args.authToken, "admin");
      const db = ctx.db<typeof schema>();
      // The total is a COUNT query — never load every row id into memory.
      const total = (await db.select({ n: count() }).from(schema.auditLogs))[0]?.n ?? 0;
      const rows = await db.select().from(schema.auditLogs).orderBy(desc(schema.auditLogs.id)).limit(args.limit).offset(args.offset);
      return { entries: rows.map((r) => ({ id: r.id, actor_type: r.actorType, actor_id: r.actorId, action: r.action, entity_type: r.entityType, entity_id: r.entityId, detail: r.detail, created_at: r.createdAt.toISOString() })), total };
    },
  }),
  // ---------- admin: buyers ----------
  adminSetUserStatus: defineAction({
    request: z.object({ authToken: authTokenField, user_id: z.string().min(1).max(80), status: z.enum(["active", "suspended"]) }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const auth = await requireAuth(ctx, args.authToken, "admin");
      const db = ctx.db<typeof schema>();
      const user = (await db.select({ id: schema.users.id, status: schema.users.status, name: schema.users.name }).from(schema.users).where(eq(schema.users.id, args.user_id)).limit(1))[0];
      if (!user) throw new Error("Buyer not found.");
      if (user.status === args.status) return { ok: true };
      await db.update(schema.users).set({ status: args.status, updatedAt: new Date() }).where(eq(schema.users.id, args.user_id));
      if (args.status === "suspended") {
        // A suspended buyer must not keep shopping on an existing session.
        await db.delete(schema.sessions).where(and(eq(schema.sessions.userType, "buyer"), eq(schema.sessions.userId, args.user_id)));
      }
      await audit(ctx, "admin", auth.id, args.status === "suspended" ? "buyer_suspended" : "buyer_reactivated", "user", args.user_id, `${user.name} (${user.status} → ${args.status})`);
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),
  adminGetUser: defineAction({
    request: z.object({ authToken: authTokenField, user_id: z.string().min(1).max(80) }),
    response: z.object({
      user: z.object({ id: z.string(), name: z.string(), phone: z.string(), email: z.string().nullable(), status: z.enum(["active", "suspended"]), created_at: z.string() }),
      orders: z.array(orderShape),
    }),
    async handler(ctx, args) {
      await requireAuth(ctx, args.authToken, "admin");
      const db = ctx.db<typeof schema>();
      const user = (await db.select().from(schema.users).where(eq(schema.users.id, args.user_id)).limit(1))[0];
      if (!user) throw new Error("Buyer not found.");
      const [orders, items] = await Promise.all([
        db.select().from(schema.orders).where(eq(schema.orders.userId, args.user_id)).orderBy(desc(schema.orders.createdAt)).limit(100),
        db.select().from(schema.orderItems),
      ]);
      return {
        user: { id: user.id, name: user.name, phone: user.phone, email: user.email, status: user.status, created_at: user.createdAt.toISOString() },
        orders: orders.map((o) => mapOrder(o, items)),
      };
    },
  }),
  // ---------- admin: seller detail ----------
  adminGetSeller: defineAction({
    request: z.object({ authToken: authTokenField, seller_id: z.number().int().positive() }),
    response: z.object({
      seller: z.object({ id: z.number(), seller_code: z.string(), store_name: z.string(), location: z.string(), phone: z.string(), email: z.string().nullable(), status: sellerStatus, email_verified: z.boolean(), description: z.string(), created_at: z.string() }),
      products: z.array(z.object({ id: z.number(), name: z.string(), category: z.string(), price_paisa: z.number(), stock: z.number(), is_active: z.boolean() })),
      orders: z.array(orderShape),
      // Real, ledger-derived figures. The commission/payout engine writes
      // every row of this ledger, so these are audited earnings — never
      // computed estimates.
      earnings: z.object({ gmv_paisa: z.number(), delivered_paisa: z.number(), orders_by_status: z.record(z.string(), z.number()), commission_paisa: z.number(), refunded_paisa: z.number(), pending_paisa: z.number(), available_paisa: z.number(), reserved_paisa: z.number(), paid_out_paisa: z.number() }),
    }),
    async handler(ctx, args) {
      await requireAuth(ctx, args.authToken, "admin");
      const db = ctx.db<typeof schema>();
      const store = (await db.select().from(schema.storeSettings).where(eq(schema.storeSettings.id, args.seller_id)).limit(1))[0];
      if (!store) throw new Error("Seller not found.");
      const [products, orders, items] = await Promise.all([
        db.select().from(schema.products).where(eq(schema.products.storeId, args.seller_id)).orderBy(desc(schema.products.createdAt)),
        db.select().from(schema.orders).where(eq(schema.orders.storeId, args.seller_id)).orderBy(desc(schema.orders.createdAt)),
        db.select().from(schema.orderItems),
      ]);
      const billable = orders.filter((o) => o.status !== "cancelled");
      const byStatus: Record<string, number> = {};
      for (const o of orders) byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;
      const balances = await sellerBalances(ctx, store.id);
      const ledgerRows = await db.select({ type: schema.sellerLedger.type, amountPaisa: schema.sellerLedger.amountPaisa }).from(schema.sellerLedger).where(eq(schema.sellerLedger.storeId, store.id));
      const sumType = (t: string) => ledgerRows.filter((r) => r.type === t).reduce((n, r) => n + r.amountPaisa, 0);
      return {
        seller: { id: store.id, seller_code: store.sellerCode, store_name: store.storeName, location: store.location, phone: store.phone, email: store.email, status: store.status, email_verified: !!store.emailVerified, description: store.description, created_at: store.createdAt.toISOString() },
        products: products.map((p) => ({ id: p.id, name: p.name, category: p.category, price_paisa: p.pricePaisa, stock: p.stock, is_active: p.isActive })),
        orders: orders.map((o) => mapOrder(o, items)),
        earnings: {
          gmv_paisa: billable.filter((o) => o.status !== "refunded").reduce((n, o) => n + o.totalPaisa, 0),
          delivered_paisa: orders.filter((o) => o.status === "delivered").reduce((n, o) => n + o.totalPaisa, 0),
          orders_by_status: byStatus,
          commission_paisa: -sumType("commission"),
          refunded_paisa: -sumType("refund"),
          pending_paisa: balances.pending_paisa,
          available_paisa: balances.available_paisa,
          reserved_paisa: balances.reserved_paisa,
          paid_out_paisa: balances.paid_paisa,
        },
      };
    },
  }),
  // ---------- admin: orders ----------
  adminUpdateOrderStatus: defineAction({
    request: z.object({ authToken: authTokenField, order_id: z.number().int().positive(), status: orderStatus }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const auth = await requireAuth(ctx, args.authToken, "admin");
      const db = ctx.db<typeof schema>();
      const order = (await db.select().from(schema.orders).where(eq(schema.orders.id, args.order_id)).limit(1))[0];
      if (!order) throw new Error("Order not found.");
      const from = order.status;
      await transitionOrderStatus(ctx, order, args.status, { type: "admin", id: auth.id });
      await audit(ctx, "admin", auth.id, "order_status_changed", "order", String(order.id), `${from} → ${args.status}`);
      return { ok: true };
    },
  }),
  adminCancelOrder: defineAction({
    request: z.object({ authToken: authTokenField, order_id: z.number().int().positive() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const auth = await requireAuth(ctx, args.authToken, "admin");
      const db = ctx.db<typeof schema>();
      const order = (await db.select().from(schema.orders).where(eq(schema.orders.id, args.order_id)).limit(1))[0];
      if (!order) throw new Error("Order not found.");
      await adminCancelOrderCore(ctx, order, { type: "admin", id: auth.id });
      await audit(ctx, "admin", auth.id, "order_cancelled", "order", String(order.id), order.orderCode);
      return { ok: true };
    },
  }),
  // ---------- admin: payments (read-only real rows; engines not built yet) ----------
  adminListPayments: defineAction({
    request: z.object({ authToken: authTokenField, status: paymentStatusEnum.optional() }),
    response: z.object({ payments: z.array(z.object({ id: z.number(), order_code: z.string(), group_code: z.string().nullable(), store_name: z.string(), provider: paymentMethodEnum, amount_paisa: z.number(), status: paymentStatusEnum, created_at: z.string() })) }),
    async handler(ctx, args) {
      await requireAuth(ctx, args.authToken, "admin");
      const db = ctx.db<typeof schema>();
      const payments = args.status
        ? await db.select().from(schema.payments).where(eq(schema.payments.status, args.status)).orderBy(desc(schema.payments.createdAt)).limit(200)
        : await db.select().from(schema.payments).orderBy(desc(schema.payments.createdAt)).limit(200);
      // Join data is fetched only for the payments on screen — never the
      // whole orders / order_groups tables.
      const paymentOrderIds = [...new Set(payments.map((p) => p.orderId))];
      const paymentGroupIds = [...new Set(payments.map((p) => p.groupId).filter((g): g is number => g != null))];
      const [orders, stores, groups] = await Promise.all([
        paymentOrderIds.length ? db.select({ id: schema.orders.id, code: schema.orders.orderCode, storeId: schema.orders.storeId }).from(schema.orders).where(inArray(schema.orders.id, paymentOrderIds)) : [],
        db.select({ id: schema.storeSettings.id, name: schema.storeSettings.storeName }).from(schema.storeSettings),
        paymentGroupIds.length ? db.select({ id: schema.orderGroups.id, code: schema.orderGroups.groupCode }).from(schema.orderGroups).where(inArray(schema.orderGroups.id, paymentGroupIds)) : [],
      ]);
      return {
        payments: payments.map((p) => {
          const order = orders.find((o) => o.id === p.orderId);
          return { id: p.id, order_code: order?.code ?? "Unknown", group_code: p.groupId != null ? groups.find((g) => g.id === p.groupId)?.code ?? null : null, store_name: stores.find((s) => s.id === order?.storeId)?.name ?? "Seller", provider: p.provider, amount_paisa: p.amountPaisa, status: p.status, created_at: p.createdAt.toISOString() };
        }),
      };
    },
  }),
  // ---------- admin: review moderation ----------
  adminListReviewReports: defineAction({
    request: z.object({ authToken: authTokenField, status: z.enum(["open", "resolved"]).optional() }),
    response: z.object({ reports: z.array(z.object({ id: z.number(), review_id: z.number(), reason: z.string(), detail: z.string(), reporter_name: z.string(), status: z.enum(["open", "resolved"]), created_at: z.string(), review: z.object({ reviewer_name: z.string(), rating: z.number(), body: z.string(), product_name: z.string(), store_name: z.string() }).nullable() })) }),
    async handler(ctx, args) {
      await requireAuth(ctx, args.authToken, "admin");
      const db = ctx.db<typeof schema>();
      const [reports, reviews, products, stores] = await Promise.all([
        args.status
          ? await db.select().from(schema.reviewReports).where(eq(schema.reviewReports.status, args.status)).orderBy(desc(schema.reviewReports.createdAt)).limit(200)
          : await db.select().from(schema.reviewReports).orderBy(desc(schema.reviewReports.createdAt)).limit(200),
        db.select().from(schema.reviews),
        db.select({ id: schema.products.id, name: schema.products.name, storeId: schema.products.storeId }).from(schema.products),
        db.select({ id: schema.storeSettings.id, name: schema.storeSettings.storeName }).from(schema.storeSettings),
      ]);
      return {
        reports: reports.map((r) => {
          const review = reviews.find((v) => v.id === r.reviewId);
          const product = review ? products.find((p) => p.id === review.productId) : undefined;
          return {
            id: r.id, review_id: r.reviewId, reason: r.reason, detail: r.detail, reporter_name: r.reporterName, status: r.status, created_at: r.createdAt.toISOString(),
            review: review ? { reviewer_name: review.reviewerName, rating: review.rating, body: review.body, product_name: product?.name ?? "Product", store_name: stores.find((s) => s.id === product?.storeId)?.name ?? "Seller" } : null,
          };
        }),
      };
    },
  }),
  adminResolveReviewReport: defineAction({
    request: z.object({ authToken: authTokenField, report_id: z.number().int().positive(), decision: z.enum(["dismiss", "delete_review"]) }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const auth = await requireAuth(ctx, args.authToken, "admin");
      const db = ctx.db<typeof schema>();
      const report = (await db.select().from(schema.reviewReports).where(eq(schema.reviewReports.id, args.report_id)).limit(1))[0];
      if (!report) throw new Error("Report not found.");
      if (args.decision === "delete_review") {
        await db.delete(schema.reviews).where(eq(schema.reviews.id, report.reviewId));
        await audit(ctx, "admin", auth.id, "review_deleted", "review", String(report.reviewId), `After report #${report.id} (${report.reason})`);
      } else {
        await db.update(schema.reviewReports).set({ status: "resolved", updatedAt: new Date() }).where(eq(schema.reviewReports.id, args.report_id));
        await audit(ctx, "admin", auth.id, "review_report_dismissed", "review_report", String(report.id), report.reason);
      }
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),
  adminDeleteReview: defineAction({
    request: z.object({ authToken: authTokenField, review_id: z.number().int().positive() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const auth = await requireAuth(ctx, args.authToken, "admin");
      const db = ctx.db<typeof schema>();
      const review = (await db.select({ id: schema.reviews.id, body: schema.reviews.body }).from(schema.reviews).where(eq(schema.reviews.id, args.review_id)).limit(1))[0];
      if (!review) throw new Error("Review not found.");
      await db.delete(schema.reviews).where(eq(schema.reviews.id, args.review_id));
      await audit(ctx, "admin", auth.id, "review_deleted", "review", String(args.review_id), review.body.slice(0, 120));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),
  // ---------- public: report a review ----------
  reportReview: defineAction({
    request: z.object({ review_id: z.number().int().positive(), reason: z.enum(["spam", "abuse", "fake", "other"]), detail: z.string().trim().min(8).max(500), reporter_name: z.string().trim().min(2).max(60) }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      const review = (await db.select({ id: schema.reviews.id }).from(schema.reviews).where(eq(schema.reviews.id, args.review_id)).limit(1))[0];
      if (!review) throw new Error("Review not found.");
      const name = args.reporter_name.trim();
      const dup = (await db.select({ id: schema.reviewReports.id }).from(schema.reviewReports)
        .where(and(eq(schema.reviewReports.reviewId, args.review_id), eq(schema.reviewReports.reporterName, name), eq(schema.reviewReports.status, "open"))).limit(1))[0];
      if (dup) throw new Error("You have already reported this review. Our team will look at it.");
      await db.insert(schema.reviewReports).values({ reviewId: args.review_id, reason: args.reason, detail: args.detail.trim(), reporterName: name, createdAt: new Date() });
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),
  // ---------- phase 2: cart (buyer) ----------
  getCart: defineAction({
    request: z.object({ authToken: authTokenField }), response: cartShape,
    async handler(ctx, args) {
      return loadCart(ctx, await buyerIdOf(ctx, args.authToken));
    },
  }),
  addToCart: defineAction({
    request: z.object({ authToken: authTokenRequired, product_id: z.number().int().positive(), quantity: z.number().int().min(1).max(20), variant_id: variantIdField }), response: z.object({ cart: cartShape }),
    async handler(ctx, args) {
      const auth = await requireAuth(ctx, args.authToken, "buyer");
      const db = ctx.db<typeof schema>();
      const product = (await db.select().from(schema.products).where(eq(schema.products.id, args.product_id)).limit(1))[0];
      if (!product) throw new Error("That product was not found.");
      if (!product.isActive || !((await activeStoreIds(ctx)).has(product.storeId))) throw new Error("That product is no longer available.");
      await assertStoreTakingOrders(ctx, product.storeId);
      const variant = await requireVariant(ctx, product.id, args.variant_id);
      const { stock } = linePricing(product, variant);
      let cart = (await db.select().from(schema.carts).where(eq(schema.carts.userId, auth.id)).limit(1))[0];
      if (!cart) {
        await db.insert(schema.carts).values({ userId: auth.id, updatedAt: new Date() });
        const created = (await db.select().from(schema.carts).where(eq(schema.carts.userId, auth.id)).limit(1))[0];
        if (!created) throw new Error("Your cart could not be created.");
        cart = created;
      }
      const existing = (await db.select().from(schema.cartItems).where(and(eq(schema.cartItems.cartId, cart.id), eq(schema.cartItems.productId, args.product_id), eq(schema.cartItems.variantId, args.variant_id))).limit(1))[0];
      const newQty = (existing?.quantity ?? 0) + args.quantity;
      if (newQty > stock) throw new Error(`${product.name}${variant ? ` (${variant.label})` : ""} has only ${stock} left in stock.`);
      if (existing) await db.update(schema.cartItems).set({ quantity: newQty }).where(eq(schema.cartItems.id, existing.id));
      else await db.insert(schema.cartItems).values({ cartId: cart.id, productId: args.product_id, variantId: args.variant_id, variantLabel: variant?.label ?? null, quantity: args.quantity });
      await db.update(schema.carts).set({ updatedAt: new Date() }).where(eq(schema.carts.id, cart.id));
      // Funnel tracking: recorded server-side with a validated product id,
      // deduped per buyer+product per 30 minutes.
      await recordFunnelEvent(ctx, "add_to_cart", auth.id, args.product_id);
      ctx.invalidateQueries();
      return { cart: await loadCart(ctx, auth.id) };
    },
  }),
  trackCheckoutStart: defineAction({
    // Called once when a signed-in buyer opens the checkout page. Validates
    // the buyer session server-side; nothing else is trusted from the
    // client. Deduplicated to one event per buyer per 6 hours and
    // rate-limited in selfhost.ts, so it can't be used to spam the funnel.
    request: z.object({ authToken: authTokenRequired }),
    response: z.object({ recorded: z.boolean() }),
    async handler(ctx, args) {
      const auth = await requireAuth(ctx, args.authToken, "buyer");
      const recorded = await recordFunnelEvent(ctx, "checkout_start", auth.id, undefined, 6 * 3600 * 1000);
      ctx.invalidateQueries();
      return { recorded };
    },
  }),
  updateCartItem: defineAction({
    request: z.object({ authToken: authTokenRequired, product_id: z.number().int().positive(), quantity: z.number().int().min(0).max(20), variant_id: variantIdField }), response: z.object({ cart: cartShape }),
    async handler(ctx, args) {
      const auth = await requireAuth(ctx, args.authToken, "buyer");
      const db = ctx.db<typeof schema>();
      const cart = (await db.select().from(schema.carts).where(eq(schema.carts.userId, auth.id)).limit(1))[0];
      const item = cart ? (await db.select().from(schema.cartItems).where(and(eq(schema.cartItems.cartId, cart.id), eq(schema.cartItems.productId, args.product_id), eq(schema.cartItems.variantId, args.variant_id))).limit(1))[0] : undefined;
      if (!cart || !item) throw new Error("That item is not in your cart.");
      if (args.quantity === 0) {
        await db.delete(schema.cartItems).where(eq(schema.cartItems.id, item.id));
      } else {
        const product = (await db.select().from(schema.products).where(eq(schema.products.id, args.product_id)).limit(1))[0];
        if (!product || !product.isActive) throw new Error("That product is no longer available.");
        const variant = await requireVariant(ctx, product.id, args.variant_id);
        const { stock } = linePricing(product, variant);
        if (args.quantity > stock) throw new Error(`${product.name}${variant ? ` (${variant.label})` : ""} has only ${stock} left in stock.`);
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
    request: z.object({ authToken: authTokenRequired, items: z.array(z.object({ product_id: z.number().int().positive(), quantity: z.number().int().min(1).max(20), variant_id: variantIdField })).max(30) }), response: z.object({ cart: cartShape }),
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
        if (!product || !product.isActive || !actives.has(product.storeId)) continue;
        const variant = await requireVariant(ctx, product.id, item.variant_id).catch(() => null);
        const { stock } = linePricing(product, variant);
        if (stock < 1) continue;
        const qty = Math.min(item.quantity, stock);
        const existing = (await db.select().from(schema.cartItems).where(and(eq(schema.cartItems.cartId, cart.id), eq(schema.cartItems.productId, item.product_id), eq(schema.cartItems.variantId, item.variant_id))).limit(1))[0];
        const newQty = Math.min((existing?.quantity ?? 0) + qty, stock);
        if (existing) await db.update(schema.cartItems).set({ quantity: newQty }).where(eq(schema.cartItems.id, existing.id));
        else await db.insert(schema.cartItems).values({ cartId: cart.id, productId: item.product_id, variantId: item.variant_id, variantLabel: variant?.label ?? null, quantity: newQty });
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
    request: z.object({ authToken: authTokenField, code: z.string().trim().min(1).max(40), subtotal_paisa: z.number().int().min(0), phone: z.string().trim().min(7).max(20).optional() }),
    response: z.object({ valid: z.boolean(), discount_paisa: z.number(), free_shipping: z.boolean(), message: z.string() }),
    async handler(ctx, args) {
      // Never throws for an invalid code — the result carries the message.
      const evald = await evaluateCoupon(ctx, args.code, await buyerIdOf(ctx, args.authToken), args.subtotal_paisa, args.phone);
      return { valid: evald.valid, discount_paisa: evald.discount_paisa, free_shipping: evald.free_shipping, message: evald.message };
    },
  }),
  adminListCoupons: defineAction({
    request: z.object({ authToken: authTokenField }),
    response: z.object({ coupons: z.array(z.object({ id: z.number(), code: z.string(), kind: z.enum(["percent", "fixed", "free_shipping"]), value: z.number(), min_order_paisa: z.number(), max_discount_paisa: z.number().nullable(), max_uses: z.number().nullable(), per_user_limit: z.number(), expires_at: z.string().nullable(), is_active: z.boolean(), created_at: z.string() })) }),
    async handler(ctx, args) {
      await requireAuth(ctx, args.authToken, "admin");
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.coupons).orderBy(desc(schema.coupons.createdAt));
      return { coupons: rows.map((c) => ({ id: c.id, code: c.code, kind: c.kind, value: c.value, min_order_paisa: c.minOrderPaisa, max_discount_paisa: c.maxDiscountPaisa ?? null, max_uses: c.maxUses, per_user_limit: c.perUserLimit, expires_at: c.expiresAt ? c.expiresAt.toISOString() : null, is_active: c.isActive, created_at: c.createdAt.toISOString() })) };
    },
  }),
  adminSaveCoupon: defineAction({
    request: z.object({ authToken: authTokenField, id: z.number().int().positive().optional(), code: z.string().trim().min(1).max(20), kind: z.enum(["percent", "fixed", "free_shipping"]), value: z.number().int().min(0).max(1000000), min_order_paisa: z.number().int().min(0).optional(), max_discount_paisa: z.number().int().min(0).max(100000000).nullable().optional(), max_uses: z.number().int().positive().nullable().optional(), per_user_limit: z.number().int().min(1).optional(), expires_at: z.string().nullable().optional(), is_active: z.boolean().optional() }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      await requireAuth(ctx, args.authToken, "admin");
      const code = args.code.trim().toUpperCase();
      let value = args.value;
      if (args.kind === "percent" && (value < 1 || value > 90)) throw new Error("A percent coupon must be between 1 and 90.");
      if (args.kind === "fixed" && value < 1) throw new Error("A fixed coupon must discount at least 1 paisa.");
      if (args.kind === "free_shipping") value = 0;
      // The ceiling only applies to percent coupons; storing it on other
      // kinds would be dead config that misleads the next admin.
      const maxDiscountPaisa = args.kind === "percent" ? (args.max_discount_paisa ?? null) : null;
      let expiresAt: Date | null = null;
      if (args.expires_at) {
        expiresAt = new Date(args.expires_at);
        if (Number.isNaN(expiresAt.getTime())) throw new Error("That expiry date is not valid.");
      }
      const db = ctx.db<typeof schema>();
      const clash = (await db.select({ id: schema.coupons.id }).from(schema.coupons).where(eq(schema.coupons.code, code)).limit(1))[0];
      if (clash && clash.id !== args.id) throw new Error(`The code "${code}" is already in use.`);
      const values = { code, kind: args.kind, value, minOrderPaisa: args.min_order_paisa ?? 0, maxDiscountPaisa, maxUses: args.max_uses ?? null, perUserLimit: args.per_user_limit ?? 1, expiresAt, isActive: args.is_active ?? true };
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
  // Online wallets always pay for the whole ORDER GROUP — one payment for
  // one checkout, even when it spans several sellers. The payment row
  // carries group_id (order_id anchors to the first fulfilment for the
  // legacy unique constraint). Verification is group-aware: on success every
  // fulfilment's payment_status is set to paid atomically; duplicate
  // callbacks return success without regressing terminal states.
  initiateOnlinePayment: defineAction({
    request: z.object({ authToken: authTokenField, order_id: z.number().int().positive().optional(), group_id: z.number().int().positive().optional(), provider: z.enum(["esewa", "khalti"]), phone: z.string().trim().min(7).max(20).optional() }),
    response: z.object({ provider: z.enum(["esewa", "khalti"]), payment_url: z.string(), params: z.record(z.string(), z.string()).optional(), pidx: z.string().optional(), order_code: z.string(), group_id: z.number().nullable() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      let view = args.group_id ? await loadOrderGroup(ctx, args.group_id) : null;
      if (!view && args.order_id) {
        const order = (await db.select().from(schema.orders).where(eq(schema.orders.id, args.order_id)).limit(1))[0];
        if (!order) throw new Error("Order not found.");
        if (order.groupId) view = await loadOrderGroup(ctx, order.groupId);
      }
      if (!view) throw new Error("Order not found.");
      await assertGroupCaller(ctx, view, args.authToken, args.phone);
      if (view.payment_method !== args.provider) throw new Error(`This order was placed with ${view.payment_method === "cod" ? "Cash on Delivery" : view.payment_method}.`);
      const payment = (await db.select().from(schema.payments).where(eq(schema.payments.groupId, view.id)).limit(1))[0];
      if (!payment) throw new Error("No payment record found for this order.");
      if (payment.status === "paid") throw new Error("This order is already paid.");
      if (payment.status === "cancelled") throw new Error("This payment was cancelled. Please place the order again.");
      if (payment.status === "refunded") throw new Error("This payment was already refunded.");
      if (payment.status === "processing") {
        // Refresh/back safety: a payment already in flight at the provider
        // hands back the stored handoff instead of starting a duplicate.
        // eSewa params are deterministic per group (same total, same
        // transaction id, same merchant), so replaying them is safe.
        try {
          const stored = JSON.parse(payment.payloadJson ?? "null") as { params?: Record<string, string>; pidx?: string; paymentUrl?: string } | null;
          if (payment.provider === "esewa" && stored?.params) {
            return { provider: "esewa" as const, payment_url: esewaFormUrl(esewaConfig().mode), params: stored.params, order_code: view.group_code, group_id: view.id };
          }
          if (payment.provider === "khalti" && stored?.pidx && stored?.paymentUrl) {
            return { provider: "khalti" as const, payment_url: stored.paymentUrl, pidx: stored.pidx, order_code: view.group_code, group_id: view.id };
          }
        } catch { /* fall through to the honest error below */ }
        throw new Error("This payment is already being processed. Please complete it in your wallet, or cancel it and try again.");
      }
      try {
        if (args.provider === "esewa") {
          const { params, paymentUrl } = await buildEsewaParams({ orderCode: view.group_code, orderId: view.id, totalPaisa: view.total_paisa, deliveryPaisa: view.delivery_fee_paisa });
          await db.update(schema.payments).set({ status: "processing", payloadJson: JSON.stringify({ params }), updatedAt: new Date() }).where(eq(schema.payments.id, payment.id));
          // The group headline derives from the fulfilment rows, so keep
          // them in step with the payment row.
          await db.update(schema.orders).set({ paymentStatus: "processing", updatedAt: new Date() }).where(eq(schema.orders.groupId, view.id));
          ctx.invalidateQueries();
          return { provider: "esewa" as const, payment_url: paymentUrl, params, order_code: view.group_code, group_id: view.id };
        }
        const { pidx, paymentUrl } = await initiateKhalti({ orderCode: view.group_code, orderId: view.id, totalPaisa: view.total_paisa });
        await db.update(schema.payments).set({ status: "processing", transactionId: pidx, payloadJson: JSON.stringify({ pidx, paymentUrl }), updatedAt: new Date() }).where(eq(schema.payments.id, payment.id));
        await db.update(schema.orders).set({ paymentStatus: "processing", updatedAt: new Date() }).where(eq(schema.orders.groupId, view.id));
        ctx.invalidateQueries();
        return { provider: "khalti" as const, payment_url: paymentUrl, pidx, order_code: view.group_code, group_id: view.id };
      } catch (e) {
        await db.update(schema.payments).set({ status: "failed", updatedAt: new Date() }).where(eq(schema.payments.id, payment.id));
        await db.update(schema.orders).set({ paymentStatus: "failed", updatedAt: new Date() }).where(eq(schema.orders.groupId, view.id));
        throw e instanceof Error ? e : new Error("The payment could not be started. Please try again or choose Cash on Delivery.");
      }
    },
  }),
  // Webhook architecture: eSewa redirects the buyer to
  // {PUBLIC_BASE_URL}/#/payment-result?provider=esewa&group_id=<id> with a
  // base64 `data` param; that page calls this action, which verifies the
  // signature AND does a server-side status check before marking anything paid.
  //
  // Security model: a cryptographically VALID provider response is
  // self-authenticating (eSewa signed it with the merchant secret and it is
  // bound to this group's code), so guests can verify without signing in.
  // Marking a payment FAILED is a state change and requires the caller to
  // prove order ownership first — an unauthenticated caller can never flip
  // another buyer's payment to failed. Terminal states are never regressed.
  verifyEsewaPayment: defineAction({
    request: z.object({ order_id: z.number().int().positive().optional(), group_id: z.number().int().positive().optional(), data: z.string().min(8), authToken: authTokenField, phone: z.string().trim().min(7).max(20).optional() }),
    response: z.object({ ok: z.literal(true), order_code: z.string(), group_id: z.number().nullable() }),
    async handler(ctx, args): Promise<{ ok: true; order_code: string; group_id: number | null }> {
      const db = ctx.db<typeof schema>();
      let view = args.group_id ? await loadOrderGroup(ctx, args.group_id) : null;
      if (!view && args.order_id) {
        const order = (await db.select().from(schema.orders).where(eq(schema.orders.id, args.order_id)).limit(1))[0];
        if (!order) throw new Error("Order not found.");
        if (order.groupId) view = await loadOrderGroup(ctx, order.groupId);
      }
      if (!view) throw new Error("Order not found.");
      const payment = (await db.select().from(schema.payments).where(eq(schema.payments.groupId, view.id)).limit(1))[0];
      if (!payment || payment.provider !== "esewa") throw new Error("No eSewa payment found for this order.");
      if (payment.status === "paid") return { ok: true, order_code: view.group_code, group_id: view.id };
      if (payment.status === "refunded" || payment.status === "cancelled") throw new Error("This payment is already settled.");
      const fail = async (message: string): Promise<never> => {
        await assertGroupCaller(ctx, view, args.authToken, args.phone);
        const now = new Date();
        // Payment row and every fulfilment move together: the group can
        // never be left half-failed if the request is retried.
        fullDb(ctx).transaction((tx) => {
          tx.update(schema.payments).set({ status: "failed", updatedAt: now }).where(eq(schema.payments.id, payment.id)).prepare().run();
          tx.update(schema.orders).set({ paymentStatus: "failed", updatedAt: now }).where(eq(schema.orders.groupId, view.id)).prepare().run();
        });
        if (view.user_id) await notifyUser(ctx, view.user_id, { type: "payment", title: `Payment failed for ${view.group_code}`, body: message, link: "#/orders" });
        await emailBuyerMsg(ctx, view.user_id, (to, name) => paymentFailedEmail(to, name, view.group_code, message));
        await notifyAdmin(`eSewa payment verification failed for ${view.group_code}`, `Group ${view.group_code} (${formatRs(view.total_paisa)}): ${message}`);
        throw new Error(message);
      };
      const decoded = await verifyEsewaSignature(args.data);
      if (!decoded.ok || !decoded.payload) return fail(decoded.error ?? "The eSewa payment could not be verified.");
      const p = decoded.payload;
      // The signed response must be bound to THIS group: a valid signature
      // for a different (equal-value) order must never mark this one paid.
      if (!p.transaction_uuid || p.transaction_uuid !== view.group_code) return fail("This payment response is for a different order.");
      // Defense in depth: the signed amount must equal the group total.
      if (p.total_amount == null || Number(p.total_amount) !== view.total_paisa / 100) {
        return fail("The eSewa payment amount does not match this order.");
      }
      const status = await esewaTransactionStatus({ productCode: p.product_code ?? "", totalAmount: p.total_amount ?? "", transactionUuid: p.transaction_uuid ?? "" });
      if (status !== "COMPLETE") return fail("eSewa did not confirm this payment. No money was taken.");
      const now = new Date();
      // One transaction for the payment row and every fulfilment: the group
      // can never be left half-paid if the request is retried or interrupted.
      // Commission accrues per fulfilment inside the same transaction.
      const cfg = await moneyConfig(ctx);
      fullDb(ctx).transaction((tx) => {
        tx.update(schema.payments).set({ status: "paid", transactionId: p.transaction_code ?? null, payloadJson: args.data, updatedAt: now }).where(eq(schema.payments.id, payment.id)).prepare().run();
        for (const o of view.orders) {
          tx.update(schema.orders).set({ paymentStatus: "paid", status: o.status === "confirmation_needed" ? "confirmed" : o.status, updatedAt: now }).where(eq(schema.orders.id, o.id)).prepare().run();
          accrueSaleCommissionTx(tx, o.id, cfg.commission_default_percent);
        }
      });
      if (view.user_id) await notifyUser(ctx, view.user_id, { type: "payment", title: `Payment received for ${view.group_code}`, body: `Your eSewa payment of ${formatRs(view.total_paisa)} was confirmed.`, link: "#/orders" });
      await emailBuyerMsg(ctx, view.user_id, (to, name) => paymentReceivedEmail(to, name, view.group_code, view.total_paisa, "esewa"));
      ctx.invalidateQueries();
      return { ok: true, order_code: view.group_code, group_id: view.id };
    },
  }),
  // Khalti redirects to {PUBLIC_BASE_URL}/#/payment-result?provider=khalti&group_id=<id>&pidx=<pidx>;
  // this action does a server-side lookup before marking anything paid.
  // Same security model as eSewa above: a VALID Khalti "Completed" lookup is
  // self-authenticating; marking failed requires order ownership; terminal
  // states never regress.
  verifyKhaltiPayment: defineAction({
    request: z.object({ order_id: z.number().int().positive().optional(), group_id: z.number().int().positive().optional(), pidx: z.string().trim().min(4).max(120), authToken: authTokenField, phone: z.string().trim().min(7).max(20).optional() }),
    response: z.object({ ok: z.literal(true), order_code: z.string(), group_id: z.number().nullable() }),
    async handler(ctx, args): Promise<{ ok: true; order_code: string; group_id: number | null }> {
      const db = ctx.db<typeof schema>();
      let view = args.group_id ? await loadOrderGroup(ctx, args.group_id) : null;
      if (!view && args.order_id) {
        const order = (await db.select().from(schema.orders).where(eq(schema.orders.id, args.order_id)).limit(1))[0];
        if (!order) throw new Error("Order not found.");
        if (order.groupId) view = await loadOrderGroup(ctx, order.groupId);
      }
      if (!view) throw new Error("Order not found.");
      const payment = (await db.select().from(schema.payments).where(eq(schema.payments.groupId, view.id)).limit(1))[0];
      if (!payment || payment.provider !== "khalti") throw new Error("No Khalti payment found for this order.");
      // The pidx must be the one our server issued for THIS group. A Khalti
      // lookup response does not bind a payment to an order, so without this
      // check a Completed payment for a different (equal-value) order could
      // mark this one paid without the buyer ever paying for it. Payment
      // initiation is therefore mandatory.
      if (!payment.transactionId) throw new Error("This Khalti payment was not started from this order. Please start the payment again.");
      if (payment.transactionId !== args.pidx.trim()) throw new Error("This payment reference does not match the order.");
      if (payment.status === "paid") return { ok: true, order_code: view.group_code, group_id: view.id };
      if (payment.status === "refunded" || payment.status === "cancelled") throw new Error("This payment is already settled.");
      const fail = async (message: string): Promise<never> => {
        await assertGroupCaller(ctx, view, args.authToken, args.phone);
        const now = new Date();
        // Payment row and every fulfilment move together: the group can
        // never be left half-failed if the request is retried.
        fullDb(ctx).transaction((tx) => {
          tx.update(schema.payments).set({ status: "failed", updatedAt: now }).where(eq(schema.payments.id, payment.id)).prepare().run();
          tx.update(schema.orders).set({ paymentStatus: "failed", updatedAt: now }).where(eq(schema.orders.groupId, view.id)).prepare().run();
        });
        if (view.user_id) await notifyUser(ctx, view.user_id, { type: "payment", title: `Payment failed for ${view.group_code}`, body: message, link: "#/orders" });
        await emailBuyerMsg(ctx, view.user_id, (to, name) => paymentFailedEmail(to, name, view.group_code, message));
        await notifyAdmin(`Khalti payment verification failed for ${view.group_code}`, `Group ${view.group_code} (${formatRs(view.total_paisa)}): ${message}`);
        throw new Error(message);
      };
      const { status, amountPaisa } = await lookupKhalti(args.pidx.trim());
      if (status === "Completed") {
        // Defense in depth: the verified amount must be present and exactly
        // equal to the group total — a Completed payment for a different
        // amount must never mark this group paid.
        if (amountPaisa == null || amountPaisa !== view.total_paisa) {
          return fail("The Khalti payment amount does not match this order.");
        }
        const now = new Date();
        // One transaction for the payment row and every fulfilment: the
        // group can never be left half-paid if the request is retried or
        // interrupted. Commission accrues per fulfilment inside the same
        // transaction.
        const cfg = await moneyConfig(ctx);
        fullDb(ctx).transaction((tx) => {
          tx.update(schema.payments).set({ status: "paid", transactionId: args.pidx.trim(), payloadJson: JSON.stringify({ status, amount_paisa: amountPaisa }), updatedAt: now }).where(eq(schema.payments.id, payment.id)).prepare().run();
          for (const o of view.orders) {
            tx.update(schema.orders).set({ paymentStatus: "paid", status: o.status === "confirmation_needed" ? "confirmed" : o.status, updatedAt: now }).where(eq(schema.orders.id, o.id)).prepare().run();
            accrueSaleCommissionTx(tx, o.id, cfg.commission_default_percent);
          }
        });
        if (view.user_id) await notifyUser(ctx, view.user_id, { type: "payment", title: `Payment received for ${view.group_code}`, body: `Your Khalti payment of ${formatRs(view.total_paisa)} was confirmed.`, link: "#/orders" });
        await emailBuyerMsg(ctx, view.user_id, (to, name) => paymentReceivedEmail(to, name, view.group_code, view.total_paisa, "khalti"));
        ctx.invalidateQueries();
        return { ok: true, order_code: view.group_code, group_id: view.id };
      }
      if (status === "Pending") throw new Error("The Khalti payment is still pending. Please wait a moment and try again.");
      return fail("Khalti did not confirm this payment. No money was taken.");
    },
  }),
  // Release an unpaid online group so the buyer can walk away or retry with
  // another method. Requires order ownership. Terminal states are protected.
  cancelOnlinePayment: defineAction({
    request: z.object({ order_id: z.number().int().positive().optional(), group_id: z.number().int().positive().optional(), authToken: authTokenField, phone: z.string().trim().min(7).max(20).optional() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      let view = args.group_id ? await loadOrderGroup(ctx, args.group_id) : null;
      if (!view && args.order_id) {
        const order = (await db.select().from(schema.orders).where(eq(schema.orders.id, args.order_id)).limit(1))[0];
        if (!order) throw new Error("Order not found.");
        if (order.groupId) view = await loadOrderGroup(ctx, order.groupId);
      }
      if (!view) throw new Error("Order not found.");
      await assertGroupCaller(ctx, view, args.authToken, args.phone);
      if (view.payment_method === "cod") throw new Error("This is a Cash on Delivery order.");
      const payment = (await db.select().from(schema.payments).where(eq(schema.payments.groupId, view.id)).limit(1))[0];
      if (!payment) throw new Error("No online payment found for this order.");
      if (payment.status === "paid") throw new Error("This payment is already completed.");
      if (payment.status === "refunded" || payment.status === "cancelled") throw new Error("This payment is already settled.");
      // Releasing an unpaid online group cancels the whole group and returns
      // the reserved stock exactly once — atomically with voiding the
      // payment — so the buyer can cleanly check out again another way and
      // the sellers' inventory is never stranded by an abandoned wallet.
      const orderIds = view.orders.map((o) => o.id);
      fullDb(ctx).transaction((tx) => {
        cancelFulfilmentsTx(tx, orderIds, view.user_id ? "buyer" : "guest", view.user_id ?? args.phone ?? "guest");
      });
      if (view.user_id) {
        await notifyUser(ctx, view.user_id, { type: "order_status", title: `Order ${view.group_code} released`, body: `The unpaid order ${view.group_code} was released and its items returned to stock. You can check out again whenever you are ready.`, link: "#/orders" });
      }
      await audit(ctx, view.user_id ? "buyer" : "guest", view.user_id ?? args.phone ?? "guest", "release_online_payment", "order_group", orderIds.join(","), view.group_code);
      ctx.invalidateQueries();
      return { ok: true };
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
  // Test-only: read (and optionally clear) the emails captured by
  // EMAIL_TEST_CAPTURE=1. Hard-disabled otherwise — this must never exist
  // in production.
  __testCapturedEmails: defineAction({
    request: z.object({ clear: z.boolean().optional() }),
    response: z.object({ emails: z.array(z.object({ to: z.string(), subject: z.string(), text: z.string(), at: z.string() })) }),
    async handler(_ctx, args) {
      if (process.env.EMAIL_TEST_CAPTURE !== "1") throw new Error("Not available.");
      const emails = capturedEmails();
      if (args.clear) clearCapturedEmails();
      return { emails: emails.map((e) => ({ to: e.to, subject: e.subject, text: e.text, at: e.at })) };
    },
  }),

  // ---------- phase 2: returns ----------
  // A buyer asks to return a delivered fulfilment. The reason is captured
  // in a dedicated return_requests row (one per order, enforced by unique
  // index) so it survives every later status change; the orders row itself
  // only carries the return_requested status.
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
      // Measure the 30-day window from actual delivery, not from the last
      // time anyone touched the order — seller actions after delivery must
      // not extend it. Older rows without delivered_at fall back to
      // updatedAt, matching the previous behaviour.
      const deliveredAt = order.deliveredAt ?? order.updatedAt;
      if (Date.now() - deliveredAt.getTime() > 30 * 86400 * 1000) throw new Error("The 30-day return window for this order has passed.");
      const existing = (await db.select({ id: schema.returnRequests.id }).from(schema.returnRequests).where(eq(schema.returnRequests.orderId, order.id)).limit(1))[0];
      if (existing) throw new Error("A return has already been requested for this order.");
      const requestedBy = userId ? `buyer:${userId}` : `guest:${args.phone.trim()}`;
      fullDb(ctx).transaction((tx) => {
        const current = tx.select().from(schema.orders).where(eq(schema.orders.id, order.id)).limit(1).prepare().get();
        if (!current || current.status !== "delivered") throw new Error("Only delivered orders can be returned.");
        tx.update(schema.orders).set({ status: "return_requested", updatedAt: new Date() }).where(eq(schema.orders.id, current.id)).prepare().run();
        tx.insert(schema.returnRequests).values({ orderId: current.id, reason: args.reason.trim(), requestedBy }).prepare().run();
      });
      if (order.userId) {
        await notifyUser(ctx, order.userId, { type: "order_status", title: `Return requested for ${order.orderCode}`, body: `Your return request for order ${order.orderCode} is with the seller.`, link: "#/orders" });
      }
      await emailBuyerMsg(ctx, order.userId, (to, name) => returnRequestedBuyerEmail(to, name, order.orderCode));
      await emailSeller(ctx, order.storeId, `Return requested for ${order.orderCode}`, `A buyer has requested a return for order ${order.orderCode}.\n\nReason: ${args.reason.trim()}\n\nPlease review it in your seller studio.`);
      await audit(ctx, userId ? "buyer" : "guest", userId ?? args.phone.trim(), "return_requested", "order", String(order.id), order.orderCode);
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
      // Accepting a return puts the goods back on the shelf: stock is
      // restored inside the same transaction as the status write, mirroring
      // the cancellation path (variant lines restore the variant row, base
      // lines the product row). Rejecting just sends the order back to
      // delivered with no stock change. The decision itself is recorded on
      // the return_requests row, with who decided and when.
      fullDb(ctx).transaction((tx) => {
        const current = tx.select().from(schema.orders).where(eq(schema.orders.id, order.id)).limit(1).prepare().get();
        if (!current || current.storeId !== store.id) throw new Error("Order not found.");
        if (current.status !== "return_requested") throw new Error("This order does not have a pending return request.");
        if (next === "returned") {
          restoreStockTx(tx, current.id, "return_accepted", "seller", String(store.id));
        }
        tx.update(schema.orders).set({ status: next, updatedAt: new Date() }).where(eq(schema.orders.id, current.id)).prepare().run();
        const now = new Date();
        const rr = tx.select().from(schema.returnRequests).where(eq(schema.returnRequests.orderId, current.id)).limit(1).prepare().get();
        if (!rr || rr.status !== "requested") throw new Error("This return request was already decided.");
        tx.update(schema.returnRequests)
          .set({ status: args.decision, decidedBy: `seller:${store.id}`, decidedAt: now })
          .where(eq(schema.returnRequests.id, rr.id)).prepare().run();
      });
      if (order.userId) {
        await notifyUser(ctx, order.userId, { type: "order_status", title: `Return ${args.decision} for ${order.orderCode}`, body: args.decision === "accepted" ? `Your return for order ${order.orderCode} was accepted.` : `Your return for order ${order.orderCode} was declined.`, link: "#/orders" });
      }
      await emailBuyer(ctx, order.userId, `Return ${args.decision} for order ${order.orderCode}`, args.decision === "accepted"
        ? `Your return for order ${order.orderCode} was accepted. Please send the item back; once it arrives, the refund process begins.`
        : `Your return for order ${order.orderCode} was declined by the seller. If you disagree, please contact support.`);
      await audit(ctx, "seller", String(store.id), "return_decided", "order", String(order.id), `${order.orderCode} ${args.decision}`);
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),
  // ---------- phase 2: refunds (honest) ----------
  // A seller asks for the buyer to be refunded for a returned order. This
  // records a refund row and NEVER flips anything to "refunded" by itself:
  // Nepal Shop has no automatic provider refunds, so the marketplace team
  // moves the money manually through the provider dashboard and confirms it
  // with adminResolveRefund. For a Cash-on-Delivery order that was never
  // paid there is no money to send back, so the refund is recorded as
  // not_required instead of pretending a refund happened.
  requestRefund: defineAction({
    request: z.object({ ...sellerAuthFields, order_id: z.number().int().positive() }),
    response: z.object({ ok: z.literal(true), refund_status: z.enum(["not_required", "pending"]) }),
    async handler(ctx, args): Promise<{ ok: true; refund_status: "not_required" | "pending" }> {
      const store = await resolveSeller(ctx, args);
      return recordRefundRequest(ctx, store.id, args.order_id);
    },
  }),
  // Deprecated alias kept for older clients: same honest behaviour as
  // requestRefund (records the request, never marks anything refunded).
  markRefunded: defineAction({
    request: z.object({ ...sellerAuthFields, order_id: z.number().int().positive() }),
    response: z.object({ ok: z.literal(true), refund_status: z.enum(["not_required", "pending"]) }),
    async handler(ctx, args): Promise<{ ok: true; refund_status: "not_required" | "pending" }> {
      const store = await resolveSeller(ctx, args);
      return recordRefundRequest(ctx, store.id, args.order_id);
    },
  }),
  // Marketplace team confirms a pending refund after actually moving the
  // money (e.g. via the eSewa/Khalti merchant dashboard). Only a completed
  // refund row flips the order and payment rows to "refunded" — the state
  // always reflects a real money movement, with the reference recorded.
  adminResolveRefund: defineAction({
    request: z.object({ authToken: authTokenField, refund_id: z.number().int().positive(), decision: z.enum(["completed", "failed"]), reference: z.string().trim().min(2).max(160) }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const auth = await requireAuth(ctx, args.authToken, "admin");
      const db = ctx.db<typeof schema>();
      const refund = (await db.select().from(schema.refunds).where(eq(schema.refunds.id, args.refund_id)).limit(1))[0];
      if (!refund) throw new Error("Refund not found.");
      if (refund.status !== "pending" && refund.status !== "failed") throw new Error("This refund has already been resolved.");
      const order = (await db.select().from(schema.orders).where(eq(schema.orders.id, refund.orderId)).limit(1))[0];
      if (!order) throw new Error("Order not found.");
      const now = new Date();
      fullDb(ctx).transaction((tx) => {
        const current = tx.select().from(schema.refunds).where(eq(schema.refunds.id, refund.id)).limit(1).prepare().get();
        if (!current || (current.status !== "pending" && current.status !== "failed")) throw new Error("This refund has already been resolved.");
        tx.update(schema.refunds).set({ status: args.decision, note: args.reference.trim(), resolvedBy: `admin:${auth.id}`, updatedAt: now }).where(eq(schema.refunds.id, current.id)).prepare().run();
        if (args.decision === "completed") {
          // This fulfilment's money is genuinely back: the order and its
          // own payment row move to refunded. For online groups the money
          // moved through ONE shared group payment row, which must never
          // be marked refunded until every fulfilment it covers is settled
          // — a partial refund that pretended the whole group payment moved
          // would be a lie. Until then the group headline derives as
          // partially_refunded from the fulfilment rows.
          tx.update(schema.orders).set({ status: "refunded", paymentStatus: "refunded", updatedAt: now }).where(eq(schema.orders.id, order.id)).prepare().run();
          // The seller's ledger follows the money: the sale is taken back
          // and the commission returned, so the refunded order nets to
          // exactly zero. No-op when the order never accrued (COD unpaid).
          reverseCommissionTx(tx, order.id, order.orderCode);
          if (refund.provider === "cod") {
            // COD: one payment row per parcel — only this parcel's row moves.
            tx.update(schema.payments).set({ status: "refunded", updatedAt: now }).where(eq(schema.payments.orderId, order.id)).prepare().run();
          } else if (order.groupId) {
            const groupOrders = tx.select({ paymentStatus: schema.orders.paymentStatus }).from(schema.orders).where(eq(schema.orders.groupId, order.groupId)).prepare().all();
            const covered = groupOrders.length > 0 && groupOrders.every((o) => o.paymentStatus === "refunded" || o.paymentStatus === "cancelled");
            if (covered) {
              tx.update(schema.payments).set({ status: "refunded", updatedAt: now }).where(eq(schema.payments.groupId, order.groupId)).prepare().run();
            }
          }
        }
      });
      if (order.userId) {
        await notifyUser(ctx, order.userId, {
          type: "payment",
          title: args.decision === "completed" ? `Refund completed for ${order.orderCode}` : `Refund update for ${order.orderCode}`,
          body: args.decision === "completed"
            ? `A refund of ${formatRs(refund.amountPaisa)} for order ${order.orderCode} has been sent back. Reference: ${args.reference.trim()}.`
            : `Our team could not complete the refund for order ${order.orderCode} yet (${args.reference.trim()}). We will try again — you do not need to do anything.`,
          link: "#/orders",
        });
      }
      await emailBuyer(ctx, order.userId, args.decision === "completed" ? `Refund completed for order ${order.orderCode}` : `Refund update for order ${order.orderCode}`,
        args.decision === "completed"
          ? `A refund of ${formatRs(refund.amountPaisa)} for order ${order.orderCode} has been sent back to your ${refund.provider === "cod" ? "hand (cash)" : refund.provider} account.\n\nReference: ${args.reference.trim()}\n\nPlease allow the usual bank/wallet settlement time for it to appear.`
          : `Our team could not complete the refund of ${formatRs(refund.amountPaisa)} for order ${order.orderCode} yet.\n\nNote: ${args.reference.trim()}\n\nWe will try again — you do not need to do anything.`);
      await audit(ctx, "admin", auth.id, "refund_resolved", "refund", String(refund.id), `${order.orderCode} → ${args.decision} (${args.reference.trim().slice(0, 80)})`);
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),
  // Admin view of every refund record: pending ones need the team to move
  // money, the rest are a traceable history.
  adminListRefunds: defineAction({
    request: z.object({ authToken: authTokenField, status: z.enum(["not_required", "pending", "completed", "failed"]).optional() }),
    response: z.object({ refunds: z.array(z.object({ id: z.number(), order_id: z.number(), order_code: z.string(), store_name: z.string(), amount_paisa: z.number(), provider: z.enum(["cod", "esewa", "khalti"]), status: z.enum(["not_required", "pending", "completed", "failed"]), note: z.string(), requested_by: z.string(), resolved_by: z.string().nullable(), created_at: z.string(), updated_at: z.string() })) }),
    async handler(ctx, args) {
      await requireAuth(ctx, args.authToken, "admin");
      const db = ctx.db<typeof schema>();
      const rows = args.status
        ? await db.select().from(schema.refunds).where(eq(schema.refunds.status, args.status)).orderBy(desc(schema.refunds.createdAt)).limit(200)
        : await db.select().from(schema.refunds).orderBy(desc(schema.refunds.createdAt)).limit(200);
      const orderIds = [...new Set(rows.map((r) => r.orderId))];
      const [orders, stores] = await Promise.all([
        orderIds.length ? db.select({ id: schema.orders.id, code: schema.orders.orderCode, storeId: schema.orders.storeId }).from(schema.orders).where(inArray(schema.orders.id, orderIds)) : [],
        db.select({ id: schema.storeSettings.id, name: schema.storeSettings.storeName }).from(schema.storeSettings),
      ]);
      return {
        refunds: rows.map((r) => {
          const order = orders.find((o) => o.id === r.orderId);
          return { id: r.id, order_id: r.orderId, order_code: order?.code ?? "Unknown", store_name: stores.find((s) => s.id === order?.storeId)?.name ?? "Seller", amount_paisa: r.amountPaisa, provider: r.provider, status: r.status, note: r.note, requested_by: r.requestedBy, resolved_by: r.resolvedBy ?? null, created_at: r.createdAt.toISOString(), updated_at: r.updatedAt.toISOString() };
        }),
      };
    },
  }),
  // ---------- commission rules (admin) ----------
  // The rules engine behind every commission ledger row. One row per
  // (scope, scope_id): saving an existing pair updates it. Scope ids are
  // validated against real stores, products and categories so a typo can
  // never create a dead rule.
  adminListCommissionRules: defineAction({
    request: z.object({ authToken: authTokenField }),
    response: z.object({ rules: z.array(z.object({ id: z.number(), scope: z.enum(["platform", "category", "seller", "product", "campaign"]), scope_id: z.string(), percent: z.number(), label: z.string(), starts_at: z.string().nullable(), ends_at: z.string().nullable(), is_active: z.boolean(), created_at: z.string() })) }),
    async handler(ctx, args) {
      await requireAuth(ctx, args.authToken, "admin");
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.commissionRules).orderBy(schema.commissionRules.id);
      return {
        rules: rows.map((r) => ({
          id: r.id, scope: r.scope, scope_id: r.scopeId, percent: r.percent, label: r.label,
          starts_at: r.startsAt ? r.startsAt.toISOString() : null, ends_at: r.endsAt ? r.endsAt.toISOString() : null,
          is_active: r.isActive, created_at: r.createdAt.toISOString(),
        })),
      };
    },
  }),
  adminSaveCommissionRule: defineAction({
    request: z.object({
      authToken: authTokenField,
      scope: z.enum(["platform", "category", "seller", "product", "campaign"]),
      scope_id: z.string().trim().max(80).default(""),
      percent: z.number().int().min(0).max(90),
      label: z.string().trim().max(80).optional(),
      starts_at: z.string().trim().max(40).optional(),
      ends_at: z.string().trim().max(40).optional(),
      is_active: z.boolean().default(true),
    }),
    response: z.object({ ok: z.literal(true), rule_id: z.number() }),
    async handler(ctx, args): Promise<{ ok: true; rule_id: number }> {
      const auth = await requireAuth(ctx, args.authToken, "admin");
      const db = ctx.db<typeof schema>();
      let scopeId = args.scope_id.trim();
      if (args.scope === "platform") {
        scopeId = "";
      } else if (args.scope === "category") {
        if (!scopeId) throw new Error("Choose a category for a category rule.");
        const cats = await db.select({ category: schema.products.category }).from(schema.products);
        if (!cats.some((c) => c.category === scopeId)) throw new Error(`No product uses the category \u201c${scopeId}\u201d yet — create a product in it first.`);
      } else if (args.scope === "seller") {
        if (!/^\d+$/.test(scopeId)) throw new Error("A seller rule needs a numeric seller id.");
        const store = (await db.select({ id: schema.storeSettings.id }).from(schema.storeSettings).where(eq(schema.storeSettings.id, Number(scopeId))).limit(1))[0];
        if (!store) throw new Error("That seller does not exist.");
      } else if (args.scope === "product") {
        if (!/^\d+$/.test(scopeId)) throw new Error("A product rule needs a numeric product id.");
        const product = (await db.select({ id: schema.products.id }).from(schema.products).where(eq(schema.products.id, Number(scopeId))).limit(1))[0];
        if (!product) throw new Error("That product does not exist.");
      } else {
        if (!/^[a-z0-9][a-z0-9-]{1,39}$/i.test(scopeId)) throw new Error("A campaign code uses letters, numbers and dashes (2\u201340 characters).");
      }
      const parseDate = (v: string | undefined, name: string) => {
        if (!v) return null;
        const d = new Date(v);
        if (Number.isNaN(d.getTime())) throw new Error(`${name} is not a valid date.`);
        return d;
      };
      const startsAt = parseDate(args.starts_at, "The campaign start");
      const endsAt = parseDate(args.ends_at, "The campaign end");
      if (startsAt && endsAt && startsAt >= endsAt) throw new Error("The campaign must end after it starts.");
      const now = new Date();
      const existing = (await db.select().from(schema.commissionRules).where(and(eq(schema.commissionRules.scope, args.scope), eq(schema.commissionRules.scopeId, scopeId))).limit(1))[0];
      let ruleId: number;
      if (existing) {
        await db.update(schema.commissionRules).set({ percent: args.percent, label: args.label?.trim() ?? existing.label, startsAt, endsAt, isActive: args.is_active }).where(eq(schema.commissionRules.id, existing.id));
        ruleId = existing.id;
      } else {
        const inserted = await db.insert(schema.commissionRules).values({ scope: args.scope, scopeId, percent: args.percent, label: args.label?.trim() ?? "", startsAt, endsAt, isActive: args.is_active, createdAt: now }).returning({ id: schema.commissionRules.id });
        if (!inserted[0]) throw new Error("Could not save the rule.");
        ruleId = inserted[0].id;
      }
      await audit(ctx, "admin", auth.id, "commission_rule_saved", "commission_rule", String(ruleId), `${args.scope}:${scopeId || "platform"} → ${args.percent}%${args.is_active ? "" : " (inactive)"}`);
      // Sellers whose takings change must hear about it. Only active rules
      // move money, so only active rules trigger mail.
      if (args.is_active) {
        const scopeLabel =
          args.scope === "platform" ? "" :
          args.scope === "category" ? ` on products in the \u201c${scopeId}\u201d category` :
          args.scope === "seller" ? ` on your shop\u2019s sales` :
          args.scope === "product" ? ` on one of your products` :
          ` for the \u201c${scopeId}\u201d campaign`;
        let storeIds: number[];
        if (args.scope === "seller") {
          storeIds = [Number(scopeId)];
        } else if (args.scope === "product") {
          const p = (await db.select({ storeId: schema.products.storeId }).from(schema.products).where(eq(schema.products.id, Number(scopeId))).limit(1))[0];
          storeIds = p ? [p.storeId] : [];
        } else if (args.scope === "category") {
          const prods = await db.select({ storeId: schema.products.storeId }).from(schema.products).where(eq(schema.products.category, scopeId));
          storeIds = [...new Set(prods.map((p) => p.storeId))];
        } else {
          const actives = await db.select({ id: schema.storeSettings.id }).from(schema.storeSettings).where(eq(schema.storeSettings.status, "active"));
          storeIds = actives.map((s) => s.id);
        }
        for (const sid of storeIds) {
          await emailSellerMsg(ctx, sid, (to, storeName) => commissionChangeEmail(to, storeName, scopeLabel, args.percent));
        }
      }
      ctx.invalidateQueries();
      return { ok: true, rule_id: ruleId };
    },
  }),
  adminDeleteCommissionRule: defineAction({
    request: z.object({ authToken: authTokenField, rule_id: z.number().int().positive() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const auth = await requireAuth(ctx, args.authToken, "admin");
      const db = ctx.db<typeof schema>();
      const rule = (await db.select().from(schema.commissionRules).where(eq(schema.commissionRules.id, args.rule_id)).limit(1))[0];
      if (!rule) throw new Error("Rule not found.");
      // Deletion is for drafts and mistakes, never for live pricing: an
      // active rule must be deactivated first so the change is deliberate
      // and reversible. A rule that has ever priced a real sale is kept
      // forever for the audit trail (deactivate it instead).
      if (rule.isActive) throw new Error("Deactivate this rule before deleting it — active rules price live sales.");
      const used = (await db.select({ id: schema.sellerLedger.id }).from(schema.sellerLedger).where(eq(schema.sellerLedger.ruleId, rule.id)).limit(1))[0];
      if (used) throw new Error("This rule has already priced real orders — deactivate it instead of deleting, so the ledger history stays auditable.");
      await db.delete(schema.commissionRules).where(eq(schema.commissionRules.id, rule.id));
      await audit(ctx, "admin", auth.id, "commission_rule_deleted", "commission_rule", String(rule.id), `${rule.scope}:${rule.scopeId || "platform"} (${rule.percent}%)`);
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),
  // ---------- platform money settings (admin) ----------
  adminGetMoneySettings: defineAction({
    request: z.object({ authToken: authTokenField }),
    response: z.object({ commission_default_percent: z.number(), payout_available_after_days: z.number(), payout_min_paisa: z.number() }),
    async handler(ctx, args) {
      await requireAuth(ctx, args.authToken, "admin");
      return moneyConfig(ctx);
    },
  }),
  adminSaveMoneySettings: defineAction({
    request: z.object({
      authToken: authTokenField,
      commission_default_percent: z.number().int().min(0).max(90),
      payout_available_after_days: z.number().int().min(0).max(90),
      payout_min_paisa: z.number().int().min(0).max(100000000),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const auth = await requireAuth(ctx, args.authToken, "admin");
      const db = ctx.db<typeof schema>();
      const now = new Date();
      const rows: [string, string][] = [
        ["commission_default_percent", String(args.commission_default_percent)],
        ["payout_available_after_days", String(args.payout_available_after_days)],
        ["payout_min_paisa", String(args.payout_min_paisa)],
      ];
      for (const [key, value] of rows) {
        await db.insert(schema.platformSettings).values({ key, value, updatedAt: now })
          .onConflictDoUpdate({ target: schema.platformSettings.key, set: { value, updatedAt: now } });
      }
      await audit(ctx, "admin", auth.id, "money_settings_saved", "platform_settings", "", `default_commission=${args.commission_default_percent}% hold=${args.payout_available_after_days}d min_payout=${args.payout_min_paisa}`);
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),
  // ---------- seller balances overview (admin) ----------
  // Every figure is derived from the ledger at read time — there is no
  // stored balance anywhere to drift out of sync.
  adminGetSellerBalances: defineAction({
    request: z.object({ authToken: authTokenField }),
    response: z.object({
      sellers: z.array(z.object({
        store_id: z.number(), store_name: z.string(), seller_code: z.string(), status: sellerStatus,
        pending_paisa: z.number(), available_paisa: z.number(), reserved_paisa: z.number(), paid_paisa: z.number(),
      })),
    }),
    async handler(ctx, args) {
      await requireAuth(ctx, args.authToken, "admin");
      const db = ctx.db<typeof schema>();
      const stores = await db.select({ id: schema.storeSettings.id, name: schema.storeSettings.storeName, code: schema.storeSettings.sellerCode, status: schema.storeSettings.status }).from(schema.storeSettings).orderBy(schema.storeSettings.id);
      // Per-seller balance reads are independent — run them in parallel
      // instead of one round-trip per seller (was serial N+1).
      const sellers = await Promise.all(stores.map(async (s) => {
        const b = await sellerBalances(ctx, s.id);
        return { store_id: s.id, store_name: s.name, seller_code: s.code, status: s.status, pending_paisa: b.pending_paisa, available_paisa: b.available_paisa, reserved_paisa: b.reserved_paisa, paid_paisa: b.paid_paisa };
      }));
      return { sellers };
    },
  }),
  // ---------- seller: earnings (ledger-derived, read-only) ----------
  // Sellers can READ their ledger and balances but have no action that
  // writes to it — every write path is a server-side payment transition,
  // an admin adjustment, or payout completion.
  sellerGetEarnings: defineAction({
    request: z.object({ ...sellerAuthFields }),
    response: z.object({
      balances: z.object({ pending_paisa: z.number(), available_paisa: z.number(), reserved_paisa: z.number(), requestable_paisa: z.number(), paid_paisa: z.number(), hold_days: z.number(), min_payout_paisa: z.number(), default_commission_percent: z.number() }),
      ledger: z.array(z.object({ id: z.number(), type: z.enum(["sale", "commission", "refund", "payout", "adjustment"]), amount_paisa: z.number(), balance_after_paisa: z.number(), order_id: z.number().nullable(), order_code: z.string().nullable(), rule_id: z.number().nullable(), note: z.string(), created_at: z.string() })),
      payouts: z.array(z.object({ id: z.number(), amount_paisa: z.number(), status: z.enum(["requested", "processing", "completed", "failed", "cancelled"]), method: z.enum(["bank", "esewa", "khalti"]), destination: z.string(), reference: z.string().nullable(), note: z.string(), created_at: z.string(), updated_at: z.string() })),
    }),
    async handler(ctx, args) {
      const store = await resolveSeller(ctx, args);
      const db = ctx.db<typeof schema>();
      const [balances, rows, payouts] = await Promise.all([
        sellerBalances(ctx, store.id),
        db.select().from(schema.sellerLedger).where(eq(schema.sellerLedger.storeId, store.id)).orderBy(desc(schema.sellerLedger.id)).limit(60),
        db.select().from(schema.sellerPayouts).where(eq(schema.sellerPayouts.storeId, store.id)).orderBy(desc(schema.sellerPayouts.id)).limit(20),
      ]);
      // Order codes only for the ledger rows on screen — not every order.
      const ledgerOrderIds = [...new Set(rows.map((r) => r.orderId).filter((o): o is number => o != null))];
      const orders = ledgerOrderIds.length
        ? await db.select({ id: schema.orders.id, code: schema.orders.orderCode }).from(schema.orders).where(inArray(schema.orders.id, ledgerOrderIds))
        : [];
      const codeById = new Map(orders.map((o) => [o.id, o.code]));
      return {
        balances,
        ledger: rows.map((r) => ({
          id: r.id, type: r.type, amount_paisa: r.amountPaisa, balance_after_paisa: r.balanceAfterPaisa,
          order_id: r.orderId, order_code: r.orderId != null ? codeById.get(r.orderId) ?? null : null,
          rule_id: r.ruleId, note: r.note, created_at: r.createdAt.toISOString(),
        })),
        payouts: payouts.map((p) => ({
          id: p.id, amount_paisa: p.amountPaisa, status: p.status, method: p.method, destination: p.destination,
          reference: p.reference ?? null, note: p.note, created_at: p.createdAt.toISOString(), updated_at: p.updatedAt.toISOString(),
        })),
      };
    },
  }),
  // ---------- seller: payout details (sensitive, masked on read) ----------
  sellerGetPayoutDetails: defineAction({
    request: z.object({ ...sellerAuthFields }),
    response: z.object({
      bank_name: z.string().nullable(), account_name: z.string().nullable(), account_number_masked: z.string().nullable(),
      esewa_id: z.string().nullable(), khalti_id: z.string().nullable(),
    }),
    async handler(ctx, args) {
      const store = await resolveSeller(ctx, args);
      const db = ctx.db<typeof schema>();
      const d = (await db.select().from(schema.sellerPayoutDetails).where(eq(schema.sellerPayoutDetails.storeId, store.id)).limit(1))[0];
      return {
        bank_name: d?.bankName ?? null, account_name: d?.accountName ?? null,
        account_number_masked: d?.accountNumber ? maskAccountNumber(d.accountNumber) : null,
        esewa_id: d?.esewaId ?? null, khalti_id: d?.khaltiId ?? null,
      };
    },
  }),
  sellerSavePayoutDetails: defineAction({
    request: z.object({
      ...sellerAuthFields,
      bank_name: z.string().trim().max(80).optional(),
      account_name: z.string().trim().max(80).optional(),
      account_number: z.string().trim().max(30).optional(),
      esewa_id: z.string().trim().max(40).optional(),
      khalti_id: z.string().trim().max(40).optional(),
      remove: z.array(z.enum(["bank", "esewa", "khalti"])).max(3).optional(),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const store = await resolveSeller(ctx, args);
      const db = ctx.db<typeof schema>();
      const existing = (await db.select().from(schema.sellerPayoutDetails).where(eq(schema.sellerPayoutDetails.storeId, store.id)).limit(1))[0];
      // Merge semantics: a field left blank keeps its saved value, so a
      // seller topping up one method never wipes the others. Clearing a
      // method is explicit via `remove`. Nothing sensitive is logged.
      const keep = (provided: string | undefined, current: string | null) => {
        if (provided === undefined) return current;
        const t = provided.trim();
        return t ? t : current;
      };
      const removals = new Set(args.remove ?? []);
      let bankName = existing?.bankName ?? null;
      let accountName = existing?.accountName ?? null;
      let accountNumber = existing?.accountNumber ?? null;
      if (removals.has("bank")) {
        bankName = accountName = accountNumber = null;
      } else {
        bankName = keep(args.bank_name, bankName);
        accountName = keep(args.account_name, accountName);
        accountNumber = keep(args.account_number, accountNumber);
      }
      const bankFields = [bankName, accountName, accountNumber];
      if (bankFields.some((f) => f !== null) && bankFields.some((f) => f === null)) {
        throw new Error("Bank payouts need all three: bank name, account holder name and account number.");
      }
      if (accountNumber && !/^[0-9][0-9 \-]{5,23}$/.test(accountNumber)) {
        throw new Error("That account number does not look right — 6 to 24 digits.");
      }
      let esewaId = existing?.esewaId ?? null;
      let khaltiId = existing?.khaltiId ?? null;
      esewaId = removals.has("esewa") ? null : keep(args.esewa_id, esewaId);
      khaltiId = removals.has("khalti") ? null : keep(args.khalti_id, khaltiId);
      if (!bankName && !esewaId && !khaltiId) {
        throw new Error("Add at least one payout method: bank details, an eSewa ID or a Khalti ID.");
      }
      const now = new Date();
      await db.insert(schema.sellerPayoutDetails)
        .values({ storeId: store.id, bankName, accountName, accountNumber, esewaId, khaltiId, updatedAt: now })
        .onConflictDoUpdate({ target: schema.sellerPayoutDetails.storeId, set: { bankName, accountName, accountNumber, esewaId, khaltiId, updatedAt: now } });
      const changed = ["bank", "esewa", "khalti"].filter((m) => (args as Record<string, unknown>)[`${m === "bank" ? "bank_name" : `${m}_id`}`] !== undefined || removals.has(m as "bank" | "esewa" | "khalti"));
      await audit(ctx, "seller", String(store.id), "payout_details_saved", "seller_payout_details", String(store.id), `methods updated: ${changed.join(", ") || "none"}`);
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),
  // ---------- seller: payouts ----------
  sellerRequestPayout: defineAction({
    request: z.object({ ...sellerAuthFields, amount_paisa: z.number().int().positive().max(100000000), method: z.enum(["bank", "esewa", "khalti"]) }),
    response: z.object({ ok: z.literal(true), payout_id: z.number() }),
    async handler(ctx, args): Promise<{ ok: true; payout_id: number }> {
      const store = await resolveSeller(ctx, args);
      const db = ctx.db<typeof schema>();
      const details = (await db.select().from(schema.sellerPayoutDetails).where(eq(schema.sellerPayoutDetails.storeId, store.id)).limit(1))[0];
      let destination: string;
      if (args.method === "bank") {
        if (!details?.bankName || !details?.accountName || !details?.accountNumber) throw new Error("Add your bank details first — bank name, account holder and account number.");
        destination = `${details.bankName} \u2022 ${maskAccountNumber(details.accountNumber)}`;
      } else if (args.method === "esewa") {
        if (!details?.esewaId) throw new Error("Add your eSewa ID first, under payout details.");
        destination = `eSewa ${details.esewaId}`;
      } else {
        if (!details?.khaltiId) throw new Error("Add your Khalti ID first, under payout details.");
        destination = `Khalti ${details.khaltiId}`;
      }
      const b = await sellerBalances(ctx, store.id);
      if (b.requestable_paisa < b.min_payout_paisa) {
        throw new Error(`Payouts need at least ${formatRs(b.min_payout_paisa)} available. You have ${formatRs(b.requestable_paisa)} ready right now.`);
      }
      if (args.amount_paisa > b.requestable_paisa) {
        throw new Error(`You only have ${formatRs(b.requestable_paisa)} available to withdraw.`);
      }
      if (args.amount_paisa < b.min_payout_paisa) {
        throw new Error(`The minimum payout is ${formatRs(b.min_payout_paisa)}.`);
      }
      const now = new Date();
      const inserted = await db.insert(schema.sellerPayouts).values({
        storeId: store.id, amountPaisa: args.amount_paisa, status: "requested", method: args.method,
        destination, createdAt: now, updatedAt: now,
      }).returning({ id: schema.sellerPayouts.id });
      if (!inserted[0]) throw new Error("Could not create the payout request.");
      const payoutId = inserted[0].id;
      await audit(ctx, "seller", String(store.id), "payout_requested", "seller_payout", String(payoutId), `${formatRs(args.amount_paisa)} via ${args.method} → ${destination}`);
      await emailSeller(ctx, store.id, `Payout requested: ${formatRs(args.amount_paisa)}`,
        `We received your payout request for ${formatRs(args.amount_paisa)} via ${args.method} (${destination}). Our team will process it shortly — you can follow its progress under Earnings in the studio.`);
      await notifyAdmin(
        `Payout request needs action: ${formatRs(args.amount_paisa)}`,
        `${store.storeName} (${store.sellerCode}) requested a payout of ${formatRs(args.amount_paisa)} via ${args.method} → ${destination}.\n\nReview it in the admin panel under Payouts.`,
      );
      ctx.invalidateQueries();
      return { ok: true, payout_id: payoutId };
    },
  }),
  sellerCancelPayout: defineAction({
    request: z.object({ ...sellerAuthFields, payout_id: z.number().int().positive() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const store = await resolveSeller(ctx, args);
      fullDb(ctx).transaction((tx) => {
        const p = tx.select().from(schema.sellerPayouts).where(eq(schema.sellerPayouts.id, args.payout_id)).limit(1).prepare().get();
        if (!p || p.storeId !== store.id) throw new Error("Payout not found.");
        if (p.status !== "requested") throw new Error("Only a payout that is still waiting can be cancelled.");
        tx.update(schema.sellerPayouts).set({ status: "cancelled", updatedAt: new Date() }).where(eq(schema.sellerPayouts.id, p.id)).prepare().run();
      });
      await audit(ctx, "seller", String(store.id), "payout_cancelled", "seller_payout", String(args.payout_id), "cancelled by seller");
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),
  sellerListPayouts: defineAction({
    request: z.object({ ...sellerAuthFields }),
    response: z.object({ payouts: z.array(z.object({ id: z.number(), amount_paisa: z.number(), status: z.enum(["requested", "processing", "completed", "failed", "cancelled"]), method: z.enum(["bank", "esewa", "khalti"]), destination: z.string(), reference: z.string().nullable(), note: z.string(), created_at: z.string(), updated_at: z.string() })) }),
    async handler(ctx, args) {
      const store = await resolveSeller(ctx, args);
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.sellerPayouts).where(eq(schema.sellerPayouts.storeId, store.id)).orderBy(desc(schema.sellerPayouts.id)).limit(100);
      return {
        payouts: rows.map((p) => ({
          id: p.id, amount_paisa: p.amountPaisa, status: p.status, method: p.method, destination: p.destination,
          reference: p.reference ?? null, note: p.note, created_at: p.createdAt.toISOString(), updated_at: p.updatedAt.toISOString(),
        })),
      };
    },
  }),
  // ---------- admin: payouts ----------
  adminListPayouts: defineAction({
    request: z.object({ authToken: authTokenField, status: z.enum(["requested", "processing", "completed", "failed", "cancelled"]).optional() }),
    response: z.object({ payouts: z.array(z.object({ id: z.number(), store_id: z.number(), store_name: z.string(), seller_code: z.string(), amount_paisa: z.number(), status: z.enum(["requested", "processing", "completed", "failed", "cancelled"]), method: z.enum(["bank", "esewa", "khalti"]), destination: z.string(), reference: z.string().nullable(), note: z.string(), created_at: z.string(), updated_at: z.string() })) }),
    async handler(ctx, args) {
      await requireAuth(ctx, args.authToken, "admin");
      const db = ctx.db<typeof schema>();
      const rows = args.status
        ? await db.select().from(schema.sellerPayouts).where(eq(schema.sellerPayouts.status, args.status)).orderBy(desc(schema.sellerPayouts.createdAt)).limit(200)
        : await db.select().from(schema.sellerPayouts).orderBy(desc(schema.sellerPayouts.createdAt)).limit(200);
      const stores = await db.select({ id: schema.storeSettings.id, name: schema.storeSettings.storeName, code: schema.storeSettings.sellerCode }).from(schema.storeSettings);
      return {
        payouts: rows.map((p) => {
          const s = stores.find((x) => x.id === p.storeId);
          return {
            id: p.id, store_id: p.storeId, store_name: s?.name ?? "Seller", seller_code: s?.code ?? "",
            amount_paisa: p.amountPaisa, status: p.status, method: p.method, destination: p.destination,
            reference: p.reference ?? null, note: p.note, created_at: p.createdAt.toISOString(), updated_at: p.updatedAt.toISOString(),
          };
        }),
      };
    },
  }),
  // The payout state machine. Only completed writes a ledger debit; failed
  // and cancelled simply release the reservation (nothing was deducted).
  // requested → processing | failed | cancelled; processing → completed |
  // failed. Terminal states never move again.
  adminSetPayoutStatus: defineAction({
    request: z.object({
      authToken: authTokenField,
      payout_id: z.number().int().positive(),
      status: z.enum(["processing", "completed", "failed", "cancelled"]),
      reference: z.string().trim().max(160).optional(),
      note: z.string().trim().max(280).optional(),
    }),
    response: z.object({ ok: z.literal(true), status: z.string() }),
    async handler(ctx, args): Promise<{ ok: true; status: string }> {
      const auth = await requireAuth(ctx, args.authToken, "admin");
      const db = ctx.db<typeof schema>();
      const payout = (await db.select().from(schema.sellerPayouts).where(eq(schema.sellerPayouts.id, args.payout_id)).limit(1))[0];
      if (!payout) throw new Error("Payout not found.");
      const allowed: Record<string, string[]> = {
        requested: ["processing", "failed", "cancelled"],
        processing: ["completed", "failed"],
      };
      if (!allowed[payout.status]?.includes(args.status)) {
        throw new Error(`A payout that is ${payout.status} cannot move to ${args.status}.`);
      }
      const reference = (args.reference ?? "").trim();
      if (args.status === "completed" && reference.length < 2) {
        throw new Error("A payment reference is required to complete a payout — record the bank/Wallet transaction reference.");
      }
      // Read the balances just before the transaction; the status guard
      // inside the transaction is what makes double-completion impossible.
      const b = await sellerBalances(ctx, payout.storeId);
      const cover = b.available_paisa - (b.reserved_paisa - payout.amountPaisa);
      if (args.status === "completed" && cover < payout.amountPaisa) {
        throw new Error("The seller's available balance no longer covers this payout — it cannot be completed.");
      }
      const now = new Date();
      fullDb(ctx).transaction((tx) => {
        const current = tx.select().from(schema.sellerPayouts).where(eq(schema.sellerPayouts.id, payout.id)).limit(1).prepare().get();
        if (!current || !allowed[current.status]?.includes(args.status)) {
          throw new Error(`A payout that is ${current?.status ?? "unknown"} cannot move to ${args.status}.`);
        }
        tx.update(schema.sellerPayouts).set({
          status: args.status,
          reference: args.status === "completed" ? reference : current.reference,
          note: (args.note ?? "").trim() || current.note,
          updatedAt: now,
        }).where(eq(schema.sellerPayouts.id, current.id)).prepare().run();
        if (args.status === "completed") {
          // The money genuinely leaves: one ledger debit, idempotent on
          // the payout id, so completing twice is impossible.
          insertLedgerTx(tx, current.storeId, {
            type: "payout", amountPaisa: -current.amountPaisa, payoutId: current.id,
            ledgerKey: `payout:${current.id}`,
            note: `Payout completed via ${current.method} (${current.destination}). Reference: ${reference}.`,
          });
        }
      });
      const statusLabel: Record<string, string> = { processing: "being processed", completed: "completed", failed: "could not be completed", cancelled: "cancelled" };
      const availabilityNote = args.status === "completed"
        ? "Please allow the usual bank/wallet settlement time for it to arrive."
        : args.status === "processing"
          ? "The amount stays reserved while we process it — it is not available for a new request yet."
          : "The amount is available in your earnings again — you can request a new payout any time.";
      await emailSeller(ctx, payout.storeId, `Payout ${args.status}: ${formatRs(payout.amountPaisa)}`,
        args.status === "completed"
          ? `Your payout of ${formatRs(payout.amountPaisa)} via ${payout.method} (${payout.destination}) has been sent.\n\nReference: ${reference}\n\n${availabilityNote}`
          : `Your payout request for ${formatRs(payout.amountPaisa)} via ${payout.method} (${payout.destination}) ${statusLabel[args.status]}.${args.note?.trim() ? `\n\nNote from our team: ${args.note.trim()}` : ""}\n\n${availabilityNote}`);
      await audit(ctx, "admin", auth.id, "payout_status_changed", "seller_payout", String(payout.id), `${payout.status} → ${args.status}${reference ? ` (${reference.slice(0, 60)})` : ""}`);
      ctx.invalidateQueries();
      return { ok: true, status: args.status };
    },
  }),
  // ---------- admin: manual ledger adjustment ----------
  // The ONLY way to write an arbitrary ledger row, and only admins can.
  // A reason is mandatory and the write is audit-logged. Adjustments hit
  // the available balance immediately (they are corrections, not earnings).
  adminCreateAdjustment: defineAction({
    request: z.object({
      authToken: authTokenField,
      store_id: z.number().int().positive(),
      amount_paisa: z.number().int().refine((n) => n !== 0 && Math.abs(n) <= 100000000, "The amount must be non-zero."),
      reason: z.string().trim().min(3).max(280),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const auth = await requireAuth(ctx, args.authToken, "admin");
      const db = ctx.db<typeof schema>();
      const store = (await db.select({ id: schema.storeSettings.id, name: schema.storeSettings.storeName }).from(schema.storeSettings).where(eq(schema.storeSettings.id, args.store_id)).limit(1))[0];
      if (!store) throw new Error("Seller not found.");
      fullDb(ctx).transaction((tx) => {
        insertLedgerTx(tx, store.id, {
          type: "adjustment", amountPaisa: args.amount_paisa,
          note: `Manual adjustment by marketplace team: ${args.reason.trim()}`,
        });
      });
      await emailSeller(ctx, store.id, `Earnings adjustment: ${formatRs(args.amount_paisa)}`,
        `Our team made an adjustment of ${formatRs(args.amount_paisa)} to your earnings.\n\nReason: ${args.reason.trim()}\n\nIf you have any questions, please contact support.`);
      await audit(ctx, "admin", auth.id, "ledger_adjustment", "seller_ledger", String(store.id), `${store.name}: ${formatRs(args.amount_paisa)} — ${args.reason.trim().slice(0, 120)}`);
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
      const orders = all.filter((o) => o.status === "return_requested" || o.status === "returned" || o.status === "refunded").slice(0, 100);
      const items = orders.length ? await db.select().from(schema.orderItems).where(inArray(schema.orderItems.orderId, orders.map((o) => o.id))) : [];
      const extras = await orderExtras(ctx, orders.map((o) => o.id));
      return { orders: orders.map((o) => mapOrder(o, items, null, extras.get(o.id))) };
    },
  }),
  // Marketplace-team intervention on a pending return (e.g. the seller is
  // unresponsive). Mirrors the seller decision with an admin audit trail.
  adminUpdateReturnStatus: defineAction({
    request: z.object({ authToken: authTokenField, order_id: z.number().int().positive(), decision: z.enum(["accepted", "rejected"]) }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const auth = await requireAuth(ctx, args.authToken, "admin");
      const db = ctx.db<typeof schema>();
      const order = (await db.select().from(schema.orders).where(eq(schema.orders.id, args.order_id)).limit(1))[0];
      if (!order) throw new Error("Order not found.");
      if (order.status !== "return_requested") throw new Error("This order does not have a pending return request.");
      const next = args.decision === "accepted" ? "returned" : "delivered";
      fullDb(ctx).transaction((tx) => {
        const current = tx.select().from(schema.orders).where(eq(schema.orders.id, order.id)).limit(1).prepare().get();
        if (!current) throw new Error("Order not found.");
        if (current.status !== "return_requested") throw new Error("This order does not have a pending return request.");
        if (next === "returned") restoreStockTx(tx, current.id, "return_accepted", "admin", auth.id);
        tx.update(schema.orders).set({ status: next, updatedAt: new Date() }).where(eq(schema.orders.id, current.id)).prepare().run();
        const now = new Date();
        const rr = tx.select().from(schema.returnRequests).where(eq(schema.returnRequests.orderId, current.id)).limit(1).prepare().get();
        if (!rr || rr.status !== "requested") throw new Error("This return request was already decided.");
        tx.update(schema.returnRequests)
          .set({ status: args.decision, decidedBy: `admin:${auth.id}`, decidedAt: now })
          .where(eq(schema.returnRequests.id, rr.id)).prepare().run();
      });
      if (order.userId) {
        await notifyUser(ctx, order.userId, { type: "order_status", title: `Return ${args.decision} for ${order.orderCode}`, body: `The marketplace team ${args.decision} your return for order ${order.orderCode}.`, link: "#/orders" });
      }
      await emailBuyer(ctx, order.userId, `Return ${args.decision} for order ${order.orderCode}`, `The marketplace team ${args.decision} your return for order ${order.orderCode}.`);
      await audit(ctx, "admin", auth.id, "return_decided", "order", String(order.id), `${order.orderCode} ${args.decision}`);
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),
  // Admin view of every return request with its reason and decision state.
  adminListReturns: defineAction({
    request: z.object({ authToken: authTokenField, status: z.enum(["requested", "accepted", "rejected"]).optional() }),
    response: z.object({ returns: z.array(z.object({ id: z.number(), order_id: z.number(), order_code: z.string(), store_name: z.string(), reason: z.string(), status: z.enum(["requested", "accepted", "rejected"]), requested_by: z.string(), decided_by: z.string().nullable(), created_at: z.string() })) }),
    async handler(ctx, args) {
      await requireAuth(ctx, args.authToken, "admin");
      const db = ctx.db<typeof schema>();
      const rows = args.status
        ? await db.select().from(schema.returnRequests).where(eq(schema.returnRequests.status, args.status)).orderBy(desc(schema.returnRequests.createdAt)).limit(200)
        : await db.select().from(schema.returnRequests).orderBy(desc(schema.returnRequests.createdAt)).limit(200);
      const orderIds = [...new Set(rows.map((r) => r.orderId))];
      const [orders, stores] = await Promise.all([
        orderIds.length ? db.select({ id: schema.orders.id, code: schema.orders.orderCode, storeId: schema.orders.storeId }).from(schema.orders).where(inArray(schema.orders.id, orderIds)) : [],
        db.select({ id: schema.storeSettings.id, name: schema.storeSettings.storeName }).from(schema.storeSettings),
      ]);
      return {
        returns: rows.map((r) => {
          const order = orders.find((o) => o.id === r.orderId);
          return { id: r.id, order_id: r.orderId, order_code: order?.code ?? "Unknown", store_name: stores.find((s) => s.id === order?.storeId)?.name ?? "Seller", reason: r.reason, status: r.status, requested_by: r.requestedBy, decided_by: r.decidedBy ?? null, created_at: r.createdAt.toISOString() };
        }),
      };
    },
  }),
  // ---------- shipping ----------
  // Record (or clear) the carrier and tracking number for a fulfilment.
  // Only the seller who owns the fulfilment (or the admin) may set it; the
  // buyer sees it on the tracking page. Allowed once the parcel exists as
  // a real shipment (confirmed onward) and never on cancelled/refunded
  // orders, where a tracking number would be a lie.
  setShipmentInfo: defineAction({
    request: z.object({ ...sellerAuthFields, order_id: z.number().int().positive(), tracking_number: z.string().trim().max(80).optional(), carrier: z.string().trim().max(60).optional() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const store = await resolveSeller(ctx, args);
      const db = ctx.db<typeof schema>();
      const order = (await db.select().from(schema.orders).where(and(eq(schema.orders.id, args.order_id), eq(schema.orders.storeId, store.id))).limit(1))[0];
      if (!order) throw new Error("Order not found.");
      if (order.status === "cancelled" || order.status === "refunded") throw new Error("Shipment details cannot be set on a cancelled or refunded order.");
      const tracking = args.tracking_number?.trim() || null;
      const carrier = args.carrier?.trim() || null;
      await db.update(schema.orders).set({ trackingNumber: tracking, carrier, updatedAt: new Date() }).where(eq(schema.orders.id, order.id));
      if (tracking && order.userId) {
        await notifyUser(ctx, order.userId, { type: "order_status", title: `Shipment update for ${order.orderCode}`, body: `Your parcel ${order.orderCode} is on its way${carrier ? ` with ${carrier}` : ""}. Tracking number: ${tracking}.`, link: "#/orders" });
      }
      if (tracking) {
        await emailBuyerMsg(ctx, order.userId, (to, name) => shipmentEmail(to, name, order.orderCode, "shipped", carrier, tracking));
      }
      await audit(ctx, "seller", String(store.id), "shipment_info_set", "order", String(order.id), `${order.orderCode} carrier=${carrier ?? "—"} tracking=${tracking ?? "—"}`);
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),
  // Admin override of the same shipment details.
  adminSetShipmentInfo: defineAction({
    request: z.object({ authToken: authTokenField, order_id: z.number().int().positive(), tracking_number: z.string().trim().max(80).optional(), carrier: z.string().trim().max(60).optional() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const auth = await requireAuth(ctx, args.authToken, "admin");
      const db = ctx.db<typeof schema>();
      const order = (await db.select().from(schema.orders).where(eq(schema.orders.id, args.order_id)).limit(1))[0];
      if (!order) throw new Error("Order not found.");
      if (order.status === "cancelled" || order.status === "refunded") throw new Error("Shipment details cannot be set on a cancelled or refunded order.");
      const tracking = args.tracking_number?.trim() || null;
      const carrier = args.carrier?.trim() || null;
      await db.update(schema.orders).set({ trackingNumber: tracking, carrier, updatedAt: new Date() }).where(eq(schema.orders.id, order.id));
      if (tracking && order.userId) {
        await notifyUser(ctx, order.userId, { type: "order_status", title: `Shipment update for ${order.orderCode}`, body: `Your parcel ${order.orderCode} is on its way${carrier ? ` with ${carrier}` : ""}. Tracking number: ${tracking}.`, link: "#/orders" });
      }
      await audit(ctx, "admin", auth.id, "shipment_info_set", "order", String(order.id), `${order.orderCode} carrier=${carrier ?? "—"} tracking=${tracking ?? "—"}`);
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),
  // Public shipping methods: which delivery speeds the marketplace offers
  // and what the express surcharge currently is (admin-configurable).
  // Standard delivery follows each product's own delivery fee; the surcharge
  // applies per seller fulfilment. No courier is integrated — sellers ship
  // with their own couriers and record the tracking number.
  getShippingMethods: defineAction({
    request: z.object({}),
    response: z.object({
      methods: z.array(z.object({ id: deliveryMethodEnum, label: z.string(), enabled: z.boolean(), express_fee_paisa: z.number() })),
      express_fee_paisa: z.number(),
      courier_integrated: z.literal(false),
    }),
    async handler(ctx) {
      const ship = await shippingConfig(ctx);
      const fee = ship.express_fee_paisa;
      return {
        methods: [
          { id: "standard" as const, label: "Standard delivery", enabled: ship.standard_enabled, express_fee_paisa: 0 },
          { id: "express" as const, label: "Express delivery", enabled: ship.express_enabled, express_fee_paisa: fee },
          { id: "pickup" as const, label: "Store pickup", enabled: ship.pickup_enabled, express_fee_paisa: 0 },
        ],
        express_fee_paisa: fee,
        courier_integrated: false as const,
      };
    },
  }),
  // Admin: read the raw shipping settings.
  adminGetShippingSettings: defineAction({
    request: z.object({ authToken: authTokenField }),
    response: z.object({ express_fee_paisa: z.number(), standard_enabled: z.boolean(), express_enabled: z.boolean(), pickup_enabled: z.boolean() }),
    async handler(ctx, args) {
      await requireAuth(ctx, args.authToken, "admin");
      return shippingConfig(ctx);
    },
  }),
  // Admin: save shipping methods and the express surcharge. At least one
  // delivery method must stay enabled so checkout can never strand a buyer.
  adminSaveShippingSettings: defineAction({
    request: z.object({
      authToken: authTokenField,
      express_fee_paisa: z.number().int().min(0).max(10000000),
      standard_enabled: z.boolean(), express_enabled: z.boolean(), pickup_enabled: z.boolean(),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const auth = await requireAuth(ctx, args.authToken, "admin");
      if (!args.standard_enabled && !args.express_enabled && !args.pickup_enabled) {
        throw new Error("At least one delivery method must stay enabled.");
      }
      const db = ctx.db<typeof schema>();
      const now = new Date();
      const rows: [string, string][] = [
        ["shipping_express_fee_paisa", String(args.express_fee_paisa)],
        ["shipping_standard_enabled", args.standard_enabled ? "1" : "0"],
        ["shipping_express_enabled", args.express_enabled ? "1" : "0"],
        ["shipping_pickup_enabled", args.pickup_enabled ? "1" : "0"],
      ];
      for (const [key, value] of rows) {
        await db.insert(schema.platformSettings).values({ key, value, updatedAt: now })
          .onConflictDoUpdate({ target: schema.platformSettings.key, set: { value, updatedAt: now } });
      }
      await audit(ctx, "admin", auth.id, "shipping_settings_saved", "platform_settings", "", `express_fee=${args.express_fee_paisa} standard=${args.standard_enabled} express=${args.express_enabled} pickup=${args.pickup_enabled}`);
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),
  getProductDetail: defineAction({
    request: z.object({ product_id: z.number().int().positive(), authToken: authTokenField }),
    response: z.object({
      product: productShape,
      variants: z.array(variantShape),
      specs: z.array(specShape),
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
      // Record the view (deduped per buyer+product per 30 minutes), and the
      // recently-viewed entry for signed-in buyers.
      const userId = await buyerIdOf(ctx, args.authToken);
      await recordProductView(ctx, args.product_id, userId);
      if (userId) {
        await db.insert(schema.recentlyViewed).values({ userId, productId: args.product_id, viewedAt: new Date() })
          .onConflictDoUpdate({ target: [schema.recentlyViewed.userId, schema.recentlyViewed.productId], set: { viewedAt: new Date() } });
      }
      return {
        product,
        variants: (await activeVariants(ctx, product.id)).map((v) => ({ id: v.id, label: v.label, sku: v.sku ?? null, price_paisa: v.pricePaisa ?? null, stock: v.stock, is_active: v.isActive })),
        specs: (await activeSpecs(ctx, product.id)).map((s) => ({ id: s.id, label: s.label, value: s.value })),
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
  // AI recommendations for the product page. Uses Gemini when GEMINI_API_KEY
  // is set (ids validated against the catalogue — never invented), otherwise
  // an honest rule-based ranking. `source` tells the UI which one it got.
  getProductRecommendations: defineAction({
    request: z.object({ product_id: z.number().int().positive(), authToken: authTokenField }),
    response: z.object({ products: z.array(productShape), source: z.enum(["ai", "rules"]) }),
    async handler(ctx, args) {
      const actives = await activeStoreIds(ctx);
      const pubs = publicOnly(await productRows(ctx), actives);
      const product = pubs.find((p) => p.id === args.product_id);
      if (!product) throw new Error("That product was not found.");
      const soldCounts = await popularityCounts(ctx);
      const { ids, source } = await recommendForProduct(product, pubs, soldCounts);
      const byId = new Map(pubs.map((p) => [p.id, p]));
      const products = ids.flatMap((id) => {
        const p = byId.get(id);
        return p ? [p] : [];
      });
      return { products, source };
    },
  }),
  // Seller's own uploaded photos for one product (used by the studio uploader).
  getProductImages: defineAction({
    request: z.object({ ...sellerAuthFields, product_id: z.number().int().positive() }),
    response: z.object({ images: z.array(z.object({ id: z.number(), url: z.string() })) }),
    async handler(ctx, args) {
      const store = await resolveSeller(ctx, args);
      const db = ctx.db<typeof schema>();
      const product = (await db.select({ id: schema.products.id }).from(schema.products).where(and(eq(schema.products.id, args.product_id), eq(schema.products.storeId, store.id))).limit(1))[0];
      if (!product) throw new Error("Product not found.");
      const rows = await db.select().from(schema.productImages).where(eq(schema.productImages.productId, args.product_id)).orderBy(schema.productImages.sortOrder, schema.productImages.id);
      return { images: rows.map((r) => ({ id: r.id, url: r.url })) };
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
        // Variant labels and SKUs are searchable too, so "SKU" queries work.
        const variantText = new Map<number, string>();
        if (pubs.length) {
          const vrows = await db.select().from(schema.productVariants)
            .where(and(inArray(schema.productVariants.productId, pubs.map((p) => p.id)), eq(schema.productVariants.isActive, true)));
          for (const v of vrows) variantText.set(v.productId, `${variantText.get(v.productId) ?? ""} ${v.label} ${v.sku ?? ""}`);
        }
        const tokens = q.split(" ").filter(Boolean);
        pubs = pubs.filter((p) => {
          const hay = `${p.name} ${p.brand ?? ""} ${p.category} ${p.description}${variantText.get(p.id) ?? ""}`.toLowerCase();
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
      const names = [...new Set(pubs.map((p) => p.name))];
      const cats = [...new Set(pubs.map((p) => p.category))];
      // Prefix matches first (what the shopper is most likely typing), then
      // substring matches so "ear" still suggests "Wireless Earbuds".
      const rank = (list: string[]) => [
        ...list.filter((n) => n.toLowerCase().startsWith(q)),
        ...list.filter((n) => !n.toLowerCase().startsWith(q) && n.toLowerCase().includes(q)),
      ];
      return { product_names: rank(names).slice(0, 6), categories: rank(cats).slice(0, 4) };
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
      banners: z.array(z.object({ title: z.string(), subtitle: z.string().nullable(), link: z.string().nullable(), image_url: z.string().nullable() })),
      sections: z.array(z.object({ key: z.string(), title: z.string(), products: z.array(productShape) })),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const actives = await activeStoreIds(ctx);
      const pubs = publicOnly(await productRows(ctx), actives);
      const banners = (await db.select().from(schema.homepageBanners).where(eq(schema.homepageBanners.isActive, true)).orderBy(schema.homepageBanners.sortOrder))
        .map((b) => ({ title: b.title, subtitle: b.subtitle, link: b.link, image_url: b.imageUrl }));
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
      low_stock: z.array(z.object({ id: z.number(), name: z.string(), stock: z.number(), variant_label: z.string().nullable() })),
      total_customers: z.number(),
      avg_rating: z.number().nullable(),
      revenue_by_day: z.array(z.object({ day: z.string(), revenue_paisa: z.number() })),
      // Seller performance, measured from real data (aggregate only — no
      // buyer identities are exposed): product views of this seller's
      // catalogue in the last 30 days, the view→order rate, and the average
      // fulfilment time over delivered orders (null when nothing delivered).
      product_views_30d: z.number(),
      view_to_order_pct: z.number(),
      avg_fulfilment_days: z.number().nullable(),
    }),
    async handler(ctx, args) {
      const store = await resolveSeller(ctx, args);
      const db = ctx.db<typeof schema>();
      const cutoff = Date.now() - 30 * 86400 * 1000;
      const cutoffDate = new Date(cutoff);
      const isBillable = (s: string) => s !== "cancelled" && s !== "refunded";
      // Windowed reads ride the created_at indexes; the all-time status
      // breakdown and customer count use grouped/column-only selects.
      const [statusRows, recentOrders, products] = await Promise.all([
        db.select({ status: schema.orders.status, n: count() }).from(schema.orders).where(eq(schema.orders.storeId, store.id)).groupBy(schema.orders.status),
        db.select().from(schema.orders).where(and(eq(schema.orders.storeId, store.id), gte(schema.orders.createdAt, cutoffDate))),
        db.select().from(schema.products).where(eq(schema.products.storeId, store.id)),
      ]);
      const billableRecent = recentOrders.filter((o) => isBillable(o.status));
      const validIds = [...new Set(billableRecent.map((o) => o.id))];
      const items = validIds.length ? await db.select().from(schema.orderItems).where(inArray(schema.orderItems.orderId, validIds)) : [];
      const productIds = products.map((p) => p.id);
      const [viewRows, revs, customerRows] = await Promise.all([
        productIds.length
          ? db.select({ n: count() }).from(schema.productViews).where(and(inArray(schema.productViews.productId, productIds), gte(schema.productViews.createdAt, cutoffDate)))
          : [{ n: 0 }],
        productIds.length ? await db.select().from(schema.reviews).where(inArray(schema.reviews.productId, productIds)) : [],
        db.select({ userId: schema.orders.userId, phone: schema.orders.phone }).from(schema.orders).where(eq(schema.orders.storeId, store.id)),
      ]);
      const ordersByStatus: Record<string, number> = {};
      for (const r of statusRows) ordersByStatus[r.status] = r.n;
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
      // Low-stock covers the base product pool AND each variant's own pool:
      // a variant can sell out while the base product looks healthy.
      const variantRows = products.length ? await db.select({
        id: schema.productVariants.id, productId: schema.productVariants.productId,
        label: schema.productVariants.label, stock: schema.productVariants.stock,
        productName: schema.products.name, threshold: schema.products.lowStockThreshold, isActive: schema.productVariants.isActive,
      }).from(schema.productVariants).innerJoin(schema.products, eq(schema.productVariants.productId, schema.products.id)).where(inArray(schema.productVariants.productId, products.map((p) => p.id))) : [];
      const lowStock = [
        ...products.filter((p) => p.stock <= (p.lowStockThreshold ?? 5))
          .map((p) => ({ id: p.id, name: p.name, stock: p.stock, variant_label: null as string | null })),
        ...variantRows.filter((v) => v.isActive && v.stock <= (v.threshold ?? 5))
          .map((v) => ({ id: v.productId, name: `${v.productName} — ${v.label}`, stock: v.stock, variant_label: v.label })),
      ].sort((a, b) => a.stock - b.stock).slice(0, 12);
      const customers = new Set(customerRows.map((o) => o.userId ?? `phone:${o.phone}`));
      const byDay = new Map<string, number>();
      for (let i = 29; i >= 0; i--) byDay.set(dayKey(new Date(Date.now() - i * 86400 * 1000)), 0);
      for (const o of billableRecent) {
        const k = dayKey(o.createdAt);
        byDay.set(k, (byDay.get(k) ?? 0) + o.totalPaisa);
      }
      const views30 = viewRows[0]?.n ?? 0;
      // Fulfilment: average days from order placement to delivery, over this
      // seller's delivered orders that carry a delivered_at timestamp.
      const delivered = recentOrders.filter((o) => o.status === "delivered" && o.deliveredAt);
      const avgFulfilment = delivered.length
        ? Math.round((delivered.reduce((n, o) => n + (o.deliveredAt!.getTime() - o.createdAt.getTime()), 0) / delivered.length / 86400000) * 10) / 10
        : null;
      return {
        revenue_paisa_30d: billableRecent.reduce((n, o) => n + o.totalPaisa, 0),
        orders_30d: billableRecent.length,
        orders_by_status: ordersByStatus,
        top_products: topProducts,
        low_stock: lowStock,
        total_customers: customers.size,
        avg_rating: revs.length ? revs.reduce((n, r) => n + r.rating, 0) / revs.length : null,
        revenue_by_day: [...byDay.entries()].map(([day, revenue_paisa]) => ({ day, revenue_paisa })),
        product_views_30d: views30,
        view_to_order_pct: views30 ? Math.round((billableRecent.length / views30) * 10000) / 100 : 0,
        avg_fulfilment_days: avgFulfilment,
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
      // Purchase funnel over the last 30 days, measured from real events:
      // product views, server-recorded add-to-cart events, checkout starts,
      // and billable orders. All counts are honest — zero when there is no
      // data, never invented.
      funnel: z.object({
        views_30d: z.number(),
        add_to_cart_30d: z.number(),
        checkout_start_30d: z.number(),
        purchases_30d: z.number(),
        view_to_cart_pct: z.number(),
        cart_to_checkout_pct: z.number(),
        checkout_to_purchase_pct: z.number(),
        cart_abandonment_pct: z.number(),
      }),
      totals: z.object({
        orders_30d: z.number(),
        revenue_paisa_30d: z.number(),
        customers_30d: z.number(),
      }),
    }),
    async handler(ctx, args) {
      await requireAuth(ctx, args.authToken, "admin");
      const db = ctx.db<typeof schema>();
      const cutoff = Date.now() - 30 * 86400 * 1000;
      const cutoffDate = new Date(cutoff);
      const isBillable = (s: string) => s !== "cancelled" && s !== "refunded";
      const pct = (num: number, den: number) => (den ? Math.round((num / den) * 10000) / 100 : 0);
      // Date-filtered reads ride the created_at indexes — no full-table scans.
      const [statusRows, recentOrders, viewsCount, searches, cartEvents, checkoutEvents, adders, purchasers, products, stores] = await Promise.all([
        db.select({ status: schema.orders.status, n: count() }).from(schema.orders).groupBy(schema.orders.status),
        db.select().from(schema.orders).where(gte(schema.orders.createdAt, cutoffDate)),
        db.select({ n: count() }).from(schema.productViews).where(gte(schema.productViews.createdAt, cutoffDate)),
        db.select({ query: schema.searchEvents.query }).from(schema.searchEvents).where(gte(schema.searchEvents.createdAt, cutoffDate)),
        db.select({ n: count() }).from(schema.funnelEvents).where(and(eq(schema.funnelEvents.event, "add_to_cart"), gte(schema.funnelEvents.createdAt, cutoffDate))),
        db.select({ n: count() }).from(schema.funnelEvents).where(and(eq(schema.funnelEvents.event, "checkout_start"), gte(schema.funnelEvents.createdAt, cutoffDate))),
        db.select({ userId: schema.funnelEvents.userId }).from(schema.funnelEvents).where(and(eq(schema.funnelEvents.event, "add_to_cart"), gte(schema.funnelEvents.createdAt, cutoffDate))),
        db.select({ userId: schema.orders.userId }).from(schema.orders).where(gte(schema.orders.createdAt, cutoffDate)),
        db.select().from(schema.products),
        db.select({ id: schema.storeSettings.id, name: schema.storeSettings.storeName }).from(schema.storeSettings),
      ]);
      const billableRecent = recentOrders.filter((o) => isBillable(o.status));
      const billableIds = new Set(billableRecent.map((o) => o.id));
      const items = billableIds.size
        ? await db.select().from(schema.orderItems).where(inArray(schema.orderItems.orderId, [...billableIds]))
        : [];
      const views30 = viewsCount[0]?.n ?? 0;
      const adds30 = cartEvents[0]?.n ?? 0;
      const checkouts30 = checkoutEvents[0]?.n ?? 0;
      const purchases30 = billableRecent.length;
      const ordersByStatus: Record<string, number> = {};
      for (const r of statusRows) ordersByStatus[r.status] = r.n;
      const prodAgg = new Map<number, { name: string; quantity: number; revenue: number }>();
      const catAgg = new Map<string, number>();
      const catByProduct = new Map(products.map((p) => [p.id, p.category]));
      for (const i of items) {
        const a = prodAgg.get(i.productId) ?? { name: i.productName, quantity: 0, revenue: 0 };
        a.quantity += i.quantity;
        a.revenue += i.quantity * i.unitPricePaisa;
        prodAgg.set(i.productId, a);
        const cat = catByProduct.get(i.productId) ?? "Other";
        catAgg.set(cat, (catAgg.get(cat) ?? 0) + i.quantity * i.unitPricePaisa);
      }
      const searchAgg = new Map<string, number>();
      for (const s of searches) searchAgg.set(s.query, (searchAgg.get(s.query) ?? 0) + 1);
      const storeById = new Map(stores.map((s) => [s.id, s.name]));
      const byDay = new Map<string, number>();
      for (let i = 29; i >= 0; i--) byDay.set(dayKey(new Date(Date.now() - i * 86400 * 1000)), 0);
      for (const o of billableRecent) {
        const k = dayKey(o.createdAt);
        byDay.set(k, (byDay.get(k) ?? 0) + o.totalPaisa);
      }
      const revenue30 = billableRecent.reduce((n, o) => n + o.totalPaisa, 0);
      // Cart abandonment: signed-in buyers who added to cart in the window
      // but placed no (billable) order. Aggregate counts only — no buyer
      // identities leave this action.
      const adderIds = new Set(adders.map((r) => r.userId).filter((u): u is string => !!u));
      const purchaserIds = new Set(purchasers.map((r) => r.userId).filter((u): u is string => !!u));
      let abandoned = 0;
      for (const u of adderIds) if (!purchaserIds.has(u)) abandoned++;
      const customers30 = new Set(billableRecent.map((o) => o.userId ?? `phone:${o.phone}`)).size;
      return {
        revenue_by_day: [...byDay.entries()].map(([day, revenue_paisa]) => ({ day, revenue_paisa })),
        orders_by_status: ordersByStatus,
        conversion_pct: pct(purchases30, views30),
        aov_paisa: purchases30 ? Math.round(revenue30 / purchases30) : 0,
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
        funnel: {
          views_30d: views30,
          add_to_cart_30d: adds30,
          checkout_start_30d: checkouts30,
          purchases_30d: purchases30,
          view_to_cart_pct: pct(adds30, views30),
          cart_to_checkout_pct: pct(checkouts30, adds30),
          checkout_to_purchase_pct: pct(purchases30, checkouts30),
          cart_abandonment_pct: pct(abandoned, adderIds.size),
        },
        totals: {
          orders_30d: purchases30,
          revenue_paisa_30d: revenue30,
          customers_30d: customers30,
        },
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
    response: z.object({ banners: z.array(z.object({ id: z.number(), title: z.string(), subtitle: z.string().nullable(), link: z.string().nullable(), image_url: z.string().nullable(), is_active: z.boolean(), sort_order: z.number() })) }),
    async handler(ctx, args) {
      await requireAuth(ctx, args.authToken, "admin");
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.homepageBanners).orderBy(schema.homepageBanners.sortOrder);
      return { banners: rows.map((b) => ({ id: b.id, title: b.title, subtitle: b.subtitle, link: b.link, image_url: b.imageUrl, is_active: b.isActive, sort_order: b.sortOrder })) };
    },
  }),
  adminSaveBanner: defineAction({
    request: z.object({ authToken: authTokenField, id: z.number().int().positive().optional(), title: z.string().trim().min(2).max(80), subtitle: z.string().trim().max(160).nullable().optional(), link: bannerLinkField.nullable().optional(), image_url: bannerImageUrlField.nullable().optional(), is_active: z.boolean().optional(), sort_order: z.number().int().min(0).max(1000).optional() }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      await requireAuth(ctx, args.authToken, "admin");
      const db = ctx.db<typeof schema>();
      const imageUrl = args.image_url?.trim() || null;
      if (!args.id && !imageUrl) throw new Error("Please upload a banner image — every advertisement is shown with its image.");
      const values = { title: args.title.trim(), subtitle: args.subtitle?.trim() || null, link: args.link?.trim() || null, imageUrl, isActive: args.is_active ?? true, sortOrder: args.sort_order ?? 0 };
      if (args.id) {
        const existing = (await db.select().from(schema.homepageBanners).where(eq(schema.homepageBanners.id, args.id)).limit(1))[0];
        if (!existing) throw new Error("Banner not found.");
        if (!imageUrl && !existing.imageUrl) throw new Error("Please upload a banner image — every advertisement is shown with its image.");
        if (existing.imageUrl && imageUrl && existing.imageUrl !== imageUrl) deleteUploadFile(existing.imageUrl);
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
      const existing = (await db.select().from(schema.homepageBanners).where(eq(schema.homepageBanners.id, args.id)).limit(1))[0];
      if (existing?.imageUrl) deleteUploadFile(existing.imageUrl);
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
      const auth = await requireAuth(ctx, args.authToken, "admin");
      const db = ctx.db<typeof schema>();
      const ticket = (await db.select().from(schema.supportTickets).where(eq(schema.supportTickets.ticketCode, args.ticket_code.trim().toUpperCase())).limit(1))[0];
      if (!ticket) throw new Error("Ticket not found.");
      await db.update(schema.supportTickets).set({ adminReply: args.reply.trim(), status: "answered", updatedAt: new Date() }).where(eq(schema.supportTickets.id, ticket.id));
      if (ticket.userId) {
        await notifyUser(ctx, ticket.userId, { type: "ticket_reply", title: `Support replied to ${ticket.ticketCode}`, body: args.reply.trim().slice(0, 140), link: "#/support" });
      }
      await audit(ctx, "admin", auth.id, "ticket_replied", "ticket", ticket.ticketCode, ticket.subject.slice(0, 120));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),
  adminCloseTicket: defineAction({
    request: z.object({ authToken: authTokenField, ticket_code: z.string().trim().min(4).max(20) }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const auth = await requireAuth(ctx, args.authToken, "admin");
      const db = ctx.db<typeof schema>();
      const ticket = (await db.select({ id: schema.supportTickets.id }).from(schema.supportTickets).where(eq(schema.supportTickets.ticketCode, args.ticket_code.trim().toUpperCase())).limit(1))[0];
      if (!ticket) throw new Error("Ticket not found.");
      await db.update(schema.supportTickets).set({ status: "closed", updatedAt: new Date() }).where(eq(schema.supportTickets.id, ticket.id));
      await audit(ctx, "admin", auth.id, "ticket_closed", "ticket", args.ticket_code.trim().toUpperCase(), "");
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
      // A supplied order code must exist, and must not belong to a different
      // registered buyer — tickets referencing arbitrary orders would
      // otherwise show up in the admin panel as someone else's order.
      const orderCode = args.order_code?.trim().toUpperCase() || null;
      if (orderCode) {
        const ref = (await db.select({ id: schema.orders.id, userId: schema.orders.userId }).from(schema.orders).where(eq(schema.orders.orderCode, orderCode)).limit(1))[0];
        if (!ref) throw new Error("We could not find that order code.");
        if (ref.userId && userId && ref.userId !== userId) throw new Error("That order belongs to a different account.");
      }
      await db.insert(schema.supportTickets).values({
        ticketCode, userId, name: args.name.trim(), contact: args.contact.trim(),
        subject: args.subject.trim(), message: args.message.trim(),
        orderCode,
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

// ---------- unpaid online order expiry ----------
// Stock is reserved when a group is placed, including for eSewa/Khalti
// groups where the buyer has not paid yet. If the buyer abandons the wallet
// (closes the tab, the session expires, the payment times out) that stock
// would stay reserved forever. The server sweeps groups that are still
// waiting for an online payment after UNPAID_GROUP_TTL_MS: the whole group
// is cancelled and the reserved stock is restored exactly once, atomically
// with voiding the payment — the same unit cancelFulfilmentsTx gives the
// buyer/seller cancel paths. Groups a seller has started fulfilling are
// never swept; paid/refunded/cancelled groups are terminal and untouched.
export const UNPAID_GROUP_TTL_MS = 45 * 60 * 1000;

export function sweepExpiredUnpaidGroups(fullDb: BunSQLiteDatabase<typeof schema>, nowMs = Date.now()): { swept: number; groups: string[] } {
  const cutoff = new Date(nowMs - UNPAID_GROUP_TTL_MS);
  const swept: { userId: string | null; groupCode: string }[] = [];
  fullDb.transaction((tx) => {
    const stale = tx
      .select({ id: schema.orderGroups.id })
      .from(schema.orderGroups)
      .where(and(lt(schema.orderGroups.createdAt, cutoff), ne(schema.orderGroups.paymentMethod, "cod")))
      .prepare()
      .all();
    for (const g of stale) {
      const subs = tx.select().from(schema.orders).where(eq(schema.orders.groupId, g.id)).prepare().all();
      if (!subs.length) continue;
      // Never sweep a group a seller has started fulfilling.
      if (!subs.every((o) => o.status === "confirmation_needed")) continue;
      const pay = tx.select().from(schema.payments).where(eq(schema.payments.groupId, g.id)).limit(1).prepare().get();
      if (!pay || pay.status === "paid" || pay.status === "refunded" || pay.status === "cancelled") continue;
      const group = tx.select().from(schema.orderGroups).where(eq(schema.orderGroups.id, g.id)).limit(1).prepare().get();
      cancelFulfilmentsTx(tx, subs.map((o) => o.id), "system", "payment_expired");
      if (group) swept.push({ userId: group.userId, groupCode: group.groupCode });
    }
  });
  // Notifications are best-effort and stay outside the sweep transaction.
  const at = new Date(nowMs);
  for (const s of swept) {
    if (!s.userId) continue;
    try {
      fullDb.insert(schema.notifications).values({ userId: s.userId, type: "order_status", title: `Order ${s.groupCode} expired`, body: `The unpaid order ${s.groupCode} was released after 45 minutes without payment and its items returned to stock. You can check out again whenever you are ready.`, link: "#/orders", createdAt: at }).prepare().run();
    } catch { /* a missed notification must never break the sweep */ }
  }
  return { swept: swept.length, groups: swept.map((s) => s.groupCode) };
}
