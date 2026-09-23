// Phase-2 client API layer.
//
// The phase-2 actions are specified in /tmp/shopbuild/v3/CONTRACT.md. Until the
// server worker lands the phase-2 migration + actions in server/src/actions.ts,
// this file holds the contract shapes as zod schemas (used only as types via
// createActionClient — no runtime validation happens here, and no server
// runtime is ever imported into the client bundle). When the server side
// exists, these schemas must agree with CONTRACT.md; they are the source of
// truth on the client.
//
// Auth: like the v1 api proxy in ./api, every call auto-attaches `authToken`
// from localStorage unless the caller passed one explicitly.

import { z, type ZodType } from "zod";
import { createActionClient } from "@hatch/space-sdk/client";
import { api, getAuth, type ApiResponse } from "./api";

export const money = (paisa: number) =>
  `Rs ${Math.round(paisa / 100).toLocaleString("en-NP")}`;
export const fmtDate = (value: string | number) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));

// Honest tax wording shown on the product page and checkout summary. This
// is the exact wording of the server's canonical TAX_NOTE (also shipped on
// every getInvoice payload as tax_note), mirrored here for pages that don't
// call getInvoice.
export const MARKETPLACE_TAX_NOTE = "No separate tax is charged on this marketplace.";

const authToken = z.string().min(8).max(120).optional();

// --- shared shapes ---------------------------------------------------------
export const productPublicSchema = z.object({
  id: z.number(), store_id: z.number(), seller_code: z.string(), store_name: z.string(),
  store_location: z.string(), name: z.string(), category: z.string(), description: z.string(),
  price_paisa: z.number(), delivery_fee_paisa: z.number(), stock: z.number(),
  is_active: z.boolean(), rating: z.number().nullable(), review_count: z.number(),
  created_at: z.string(),
  // phase-2 additions
  brand: z.string().nullable(), original_price_paisa: z.number().nullable(),
  discount_pct: z.number(), image_url: z.string().nullable(), low_stock: z.boolean(),
  // v5: seller-uploaded photos (max 10 per product); first one is the cover
  images: z.array(z.string()),
  // seller checkpoint: optional stock-keeping unit, unique within the store
  sku: z.string().nullable(),
  // v15: real units sold (non-cancelled orders), gender filter, flash sale
  sold_count: z.number(), gender: z.string().nullable(),
  flash_sale: z.boolean(), flash_sale_ends_at: z.string().nullable(),
});
export type P2Product = z.infer<typeof productPublicSchema>;

// Customer-facing product variant (size, colour, …). price_paisa null means
// "same as the product price"; stock is the variant's own inventory.
export const variantSchema = z.object({
  id: z.number(), label: z.string(), sku: z.string().nullable(),
  price_paisa: z.number().nullable(), stock: z.number(), is_active: z.boolean(),
});
export type P2Variant = z.infer<typeof variantSchema>;

// Customer-facing product specification row (label/value), shown as a spec
// sheet on the product page. Mirrors the server's specShape.
export const specSchema = z.object({
  id: z.number(), label: z.string(), value: z.string(),
});
export type P2Spec = z.infer<typeof specSchema>;

export const orderStatusExSchema = z.enum([
  "confirmation_needed", "confirmed", "packed", "shipped", "out_for_delivery",
  "delivery_failed", "delivered", "return_requested", "returned", "refunded", "cancelled",
]);
export const refundStatusSchema = z.enum(["not_required", "pending", "completed", "failed"]);
export type P2OrderStatus = z.infer<typeof orderStatusExSchema>;

export const orderExSchema = z.object({
  id: z.number(), order_code: z.string(), customer_name: z.string(), phone: z.string(),
  address: z.string(), note: z.string(), subtotal_paisa: z.number(),
  delivery_fee_paisa: z.number(), total_paisa: z.number(),
  payment_method: z.enum(["cod", "esewa", "khalti"]),
  payment_status: z.enum(["pending", "processing", "paid", "failed", "refunded", "cancelled"]),
  discount_paisa: z.number(), coupon_code: z.string().nullable(),
  delivery_method: z.enum(["standard", "express", "pickup"]),
  status: orderStatusExSchema, created_at: z.string(),
  // shipping: carrier + tracking number, set by the seller once shipped
  tracking_number: z.string().nullable(),
  carrier: z.string().nullable(),
  delivered_at: z.string().nullable(),
  // returns/refunds: captured reason + honest refund state
  return_reason: z.string().nullable(),
  refund_status: refundStatusSchema.nullable(),
  // multi-seller checkout: every fulfilment belongs to one customer-facing group
  group_id: z.number().nullable().optional(),
  group_code: z.string().nullable().optional(),
  items: z.array(z.object({
    id: z.number(), product_id: z.number(), product_name: z.string(),
    quantity: z.number(), unit_price_paisa: z.number(),
    variant_id: z.number(), variant_label: z.string().nullable(),
  })),
});
export type P2Order = z.infer<typeof orderExSchema>;

// One customer checkout = one group + one fulfilment order per seller.
// The group is what the customer tracks, pays for and cancels.
export const orderGroupSchema = z.object({
  id: z.number(), group_code: z.string(), customer_name: z.string(), phone: z.string(),
  address: z.string(), note: z.string(), subtotal_paisa: z.number(),
  delivery_fee_paisa: z.number(), discount_paisa: z.number(), total_paisa: z.number(),
  payment_method: z.enum(["cod", "esewa", "khalti"]),
  payment_status: z.enum(["pending", "processing", "paid", "failed", "refunded", "cancelled", "partially_refunded"]),
  delivery_method: z.enum(["standard", "express", "pickup"]),
  coupon_code: z.string().nullable(), created_at: z.string(),
  orders: z.array(orderExSchema.extend({ store_name: z.string() })),
});
export type P2OrderGroup = z.infer<typeof orderGroupSchema>;

const cartResponseSchema = z.object({
  items: z.array(z.object({
    product_id: z.number(), quantity: z.number(),
    variant_id: z.number(), variant_label: z.string().nullable(),
    unit_price_paisa: z.number(), stock: z.number(), product: productPublicSchema,
  })),
  subtotal_paisa: z.number(),
});

const addressSchema = z.object({
  id: z.number(), label: z.string(), full_name: z.string(), phone: z.string(),
  province: z.string(), district: z.string(), municipality: z.string(),
  ward: z.string().nullable(), landmark: z.string().nullable(),
  note: z.string().nullable(), is_default: z.boolean(),
});
export type P2Address = z.infer<typeof addressSchema>;

const sellerAuthFields = {
  authToken,
  seller_code: z.string().optional(),
  seller_key: z.string().optional(),
};

const ticketSchema = z.object({
  ticket_code: z.string(), name: z.string(), contact: z.string(),
  subject: z.string(), message: z.string(), order_code: z.string().nullable(),
  status: z.enum(["open", "answered", "closed"]), admin_reply: z.string().nullable(),
  created_at: z.string(),
});
export type P2Ticket = z.infer<typeof ticketSchema>;

const couponSchema = z.object({
  id: z.number(), code: z.string(), kind: z.enum(["percent", "fixed", "free_shipping"]),
  value: z.number(), min_order_paisa: z.number(), max_discount_paisa: z.number().nullable(),
  max_uses: z.number().nullable(),
  per_user_limit: z.number(), expires_at: z.number().nullable(),
  is_active: z.boolean(), created_at: z.number(),
});
export type P2Coupon = z.infer<typeof couponSchema>;

// --- phase-2 actions (exact per CONTRACT.md) --------------------------------
const p2Actions = {
  getCart: { request: z.object({ authToken }), response: cartResponseSchema },
  addToCart: {
    request: z.object({ authToken, product_id: z.number().int().positive(), quantity: z.number().int().min(1).max(20), variant_id: z.number().int().min(0).optional() }),
    response: z.object({ cart: cartResponseSchema }),
  },
  updateCartItem: {
    request: z.object({ authToken, product_id: z.number().int().positive(), quantity: z.number().int().min(0).max(20), variant_id: z.number().int().min(0).optional() }),
    response: z.object({ cart: cartResponseSchema }),
  },
  clearCart: { request: z.object({ authToken }), response: z.object({ ok: z.boolean() }) },
  trackCheckoutStart: { request: z.object({ authToken }), response: z.object({ recorded: z.boolean() }) },
  mergeCart: {
    request: z.object({ authToken, items: z.array(z.object({ product_id: z.number().int().positive(), quantity: z.number().int().min(1).max(20), variant_id: z.number().int().min(0).optional() })).max(30) }),
    response: z.object({ cart: cartResponseSchema }),
  },

  listAddresses: { request: z.object({ authToken }), response: z.object({ addresses: z.array(addressSchema) }) },
  saveAddress: {
    request: z.object({
      authToken, id: z.number().optional(), label: z.string().optional(),
      full_name: z.string().trim().min(2), phone: z.string().trim().min(7).max(20),
      province: z.string().trim().min(1), district: z.string().trim().min(1),
      municipality: z.string().trim().min(1),
      ward: z.string().trim().optional(), landmark: z.string().trim().optional(), note: z.string().trim().optional(),
    }),
    response: z.object({ id: z.number() }),
  },
  deleteAddress: { request: z.object({ authToken, id: z.number() }), response: z.object({ ok: z.boolean() }) },
  setDefaultAddress: { request: z.object({ authToken, id: z.number() }), response: z.object({ ok: z.boolean() }) },

  validateCoupon: {
    request: z.object({ authToken, code: z.string(), subtotal_paisa: z.number(), phone: z.string().optional() }),
    response: z.object({ valid: z.boolean(), discount_paisa: z.number(), free_shipping: z.boolean(), message: z.string() }),
  },
  adminListCoupons: { request: z.object({ authToken }), response: z.object({ coupons: z.array(couponSchema) }) },
  adminSaveCoupon: {
    request: z.object({
      authToken, id: z.number().optional(), code: z.string().trim().min(1),
      kind: z.enum(["percent", "fixed", "free_shipping"]), value: z.number().int(),
      min_order_paisa: z.number().int().optional(), max_discount_paisa: z.number().int().nullable().optional(),
      max_uses: z.number().int().nullable().optional(),
      per_user_limit: z.number().int().optional(), expires_at: z.string().nullable().optional(),
      is_active: z.boolean().optional(),
    }),
    response: z.object({ id: z.number() }),
  },
  adminToggleCoupon: { request: z.object({ authToken, id: z.number(), is_active: z.boolean() }), response: z.object({ ok: z.boolean() }) },

  requestReturn: {
    request: z.object({ authToken, order_code: z.string().trim().min(4), phone: z.string().trim().min(7), reason: z.string().trim().min(8).max(400) }),
    response: z.object({ ok: z.boolean() }),
  },
  cancelOrder: {
    request: z.object({
      authToken,
      order_id: z.number().int().positive().optional(),
      order_code: z.string().trim().min(4).max(40).optional(),
      group_code: z.string().trim().min(4).max(40).optional(),
      phone: z.string().trim().min(7).max(20).optional(),
    }),
    response: z.object({ ok: z.boolean() }),
  },
  updateReturnStatus: {
    request: z.object({ ...sellerAuthFields, order_id: z.number(), decision: z.enum(["accepted", "rejected"]) }),
    response: z.object({ ok: z.boolean() }),
  },
  markRefunded: {
    request: z.object({ ...sellerAuthFields, order_id: z.number() }),
    response: z.object({ ok: z.boolean(), refund_status: refundStatusSchema.optional() }),
  },
  // Honest refund request: records the refund, never flips "refunded" itself.
  requestRefund: {
    request: z.object({ ...sellerAuthFields, order_id: z.number() }),
    response: z.object({ ok: z.boolean(), refund_status: z.enum(["not_required", "pending"]) }),
  },
  // Seller records the carrier + tracking number once the parcel ships.
  setShipmentInfo: {
    request: z.object({ ...sellerAuthFields, order_id: z.number(), tracking_number: z.string().max(80).optional(), carrier: z.string().max(60).optional() }),
    response: z.object({ ok: z.boolean() }),
  },
  // Public shipping methods + admin-configurable express surcharge.
  getShippingMethods: {
    request: z.object({}),
    response: z.object({
      methods: z.array(z.object({ id: z.enum(["standard", "express", "pickup"]), label: z.string(), enabled: z.boolean(), express_fee_paisa: z.number() })),
      express_fee_paisa: z.number(),
      courier_integrated: z.boolean(),
    }),
  },
  adminGetShippingSettings: {
    request: z.object({ authToken }),
    response: z.object({ express_fee_paisa: z.number(), standard_enabled: z.boolean(), express_enabled: z.boolean(), pickup_enabled: z.boolean() }),
  },
  adminSaveShippingSettings: {
    request: z.object({ authToken, express_fee_paisa: z.number().int().min(0), standard_enabled: z.boolean(), express_enabled: z.boolean(), pickup_enabled: z.boolean() }),
    response: z.object({ ok: z.boolean() }),
  },
  adminUpdateReturnStatus: {
    request: z.object({ authToken, order_id: z.number(), decision: z.enum(["accepted", "rejected"]) }),
    response: z.object({ ok: z.boolean() }),
  },
  adminListReturns: {
    request: z.object({ authToken, status: z.enum(["requested", "accepted", "rejected"]).optional() }),
    response: z.object({ returns: z.array(z.object({ id: z.number(), order_id: z.number(), order_code: z.string(), store_name: z.string(), reason: z.string(), status: z.enum(["requested", "accepted", "rejected"]), requested_by: z.string(), decided_by: z.string().nullable(), created_at: z.string() })) }),
  },
  adminListRefunds: {
    request: z.object({ authToken, status: refundStatusSchema.optional() }),
    response: z.object({ refunds: z.array(z.object({ id: z.number(), order_id: z.number(), order_code: z.string(), store_name: z.string(), amount_paisa: z.number(), provider: z.enum(["cod", "esewa", "khalti"]), status: refundStatusSchema, note: z.string(), requested_by: z.string(), resolved_by: z.string().nullable(), created_at: z.string(), updated_at: z.string() })) }),
  },
  adminResolveRefund: {
    request: z.object({ authToken, refund_id: z.number(), decision: z.enum(["completed", "failed"]), reference: z.string().min(2).max(160) }),
    response: z.object({ ok: z.boolean() }),
  },
  adminSetShipmentInfo: {
    request: z.object({ authToken, order_id: z.number(), tracking_number: z.string().max(80).optional(), carrier: z.string().max(60).optional() }),
    response: z.object({ ok: z.boolean() }),
  },

  initiateOnlinePayment: {
    request: z.object({ authToken, order_id: z.number().optional(), group_id: z.number().optional(), provider: z.enum(["esewa", "khalti"]), phone: z.string().optional() }),
    response: z.object({ provider: z.string(), payment_url: z.string(), params: z.record(z.string(), z.unknown()).optional(), pidx: z.string().optional(), order_code: z.string(), group_id: z.number().nullable() }),
  },
  verifyEsewaPayment: {
    request: z.object({ authToken, order_id: z.number().optional(), group_id: z.number().optional(), data: z.string(), phone: z.string().optional() }),
    response: z.object({ ok: z.boolean(), order_code: z.string(), group_id: z.number().nullable() }),
  },
  verifyKhaltiPayment: {
    request: z.object({ authToken, order_id: z.number().optional(), group_id: z.number().optional(), pidx: z.string(), phone: z.string().optional() }),
    response: z.object({ ok: z.boolean(), order_code: z.string(), group_id: z.number().nullable() }),
  },
  cancelOnlinePayment: {
    request: z.object({ authToken, order_id: z.number().optional(), group_id: z.number().optional(), phone: z.string().optional() }),
    response: z.object({ ok: z.boolean() }),
  },
  updateMyPassword: {
    request: z.object({ authToken, old_password: z.string(), new_password: z.string() }),
    response: z.object({ ok: z.boolean() }),
  },
  updateSellerPassword: {
    request: z.object({ ...sellerAuthFields, old_password: z.string(), new_password: z.string() }),
    response: z.object({ ok: z.boolean() }),
  },
  requestPasswordReset: {
    request: z.object({ user_type: z.enum(["buyer", "seller", "admin"]), identifier: z.string() }),
    response: z.object({ ok: z.boolean() }),
  },
  resetPassword: {
    request: z.object({ user_type: z.enum(["buyer", "seller", "admin"]), token: z.string(), new_password: z.string() }),
    response: z.object({ ok: z.boolean() }),
  },

  getMyOrderGroups: {
    request: z.object({ authToken }),
    response: z.object({ groups: z.array(orderGroupSchema) }),
  },
  adminListOrderGroups: {
    request: z.object({ authToken, limit: z.number().int().positive().max(100).optional() }),
    response: z.object({ groups: z.array(orderGroupSchema) }),
  },
  adminGetOrderGroup: {
    request: z.object({ authToken, group_id: z.number().int().positive().optional(), group_code: z.string().optional() }),
    response: z.object({ group: orderGroupSchema.nullable() }),
  },

  getWishlist: {
    request: z.object({ authToken }),
    response: z.object({ items: z.array(z.object({
      product: productPublicSchema, added_price_paisa: z.number(),
      price_changed: z.boolean(), price_diff_paisa: z.number(), in_stock: z.boolean(),
    })) }),
  },
  toggleWishlist: {
    request: z.object({ authToken, product_id: z.number().int().positive() }),
    response: z.object({ wishlisted: z.boolean() }),
  },

  getProductDetail: {
    request: z.object({ authToken, product_id: z.number().int().positive() }),
    response: z.object({
      product: productPublicSchema,
      variants: z.array(variantSchema),
      specs: z.array(specSchema),
      reviews: z.array(z.object({ id: z.number(), rating: z.number(), body: z.string(), reviewer_name: z.string(), created_at: z.string() })),
      related: z.array(productPublicSchema),
      frequently_bought_together: z.array(productPublicSchema),
      seller: z.object({ store_name: z.string(), location: z.string(), rating: z.number().nullable(), product_count: z.number(), verified: z.boolean() }),
    }),
  },
  getProductRecommendations: {
    request: z.object({ authToken, product_id: z.number().int().positive() }),
    response: z.object({ products: z.array(productPublicSchema), source: z.enum(["ai", "rules"]) }),
  },
  getProductImages: {
    request: z.object({ authToken, product_id: z.number().int().positive() }),
    response: z.object({ images: z.array(z.object({ id: z.number(), url: z.string() })) }),
  },
  searchProducts: {
    request: z.object({
      query: z.string(), category: z.string().optional(), brand: z.string().optional(),
      min_price_paisa: z.number().optional(), max_price_paisa: z.number().optional(),
      min_rating: z.number().optional(), in_stock_only: z.boolean().optional(),
      on_sale_only: z.boolean().optional(), seller_code: z.string().optional(),
      gender: z.enum(["men", "women", "kids", "unisex"]).optional(),
      sort: z.enum(["relevance", "price_asc", "price_desc", "rating", "newest", "popularity", "discount"]).optional(),
      limit: z.number().optional(), offset: z.number().optional(),
    }),
    response: z.object({ products: z.array(productPublicSchema), total: z.number() }),
  },
  suggestSearch: {
    request: z.object({ query: z.string() }),
    response: z.object({ product_names: z.array(z.string()), categories: z.array(z.string()) }),
  },
  getRecentlyViewed: {
    request: z.object({ authToken }),
    response: z.object({ products: z.array(productPublicSchema) }),
  },
  getHomepage: {
    request: z.object({ authToken }),
    response: z.object({
      banners: z.array(z.object({ title: z.string(), subtitle: z.string().nullable(), link: z.string().nullable(), image_url: z.string().nullable() })),
      sections: z.array(z.object({ key: z.string(), title: z.string(), products: z.array(productPublicSchema) })),
      site_logo_url: z.string().nullable(),
      // v15: category rails + active flash sales (real data only)
      category_sections: z.array(z.object({ name: z.string(), products: z.array(productPublicSchema) })),
      flash_sales: z.array(productPublicSchema),
    }),
  },

  askAssistant: {
    request: z.object({ question: z.string().trim().min(3).max(500) }),
    response: z.object({
      answer: z.string(), products: z.array(productPublicSchema),
      comparison: z.object({
        products: z.array(productPublicSchema),
        rows: z.array(z.object({ label: z.string(), values: z.array(z.string()) })),
      }).optional(),
    }),
  },

  getNotifications: {
    request: z.object({ authToken, limit: z.number().optional() }),
    response: z.object({
      notifications: z.array(z.object({
        id: z.number(), type: z.string(), title: z.string(), body: z.string(),
        link: z.string().nullable(), is_read: z.boolean(), created_at: z.string(),
      })),
      unread_count: z.number(),
    }),
  },
  markNotificationRead: { request: z.object({ authToken, id: z.number() }), response: z.object({ ok: z.boolean() }) },
  markAllNotificationsRead: { request: z.object({ authToken }), response: z.object({ ok: z.boolean() }) },

  sellerAnalytics: {
    request: z.object({ ...sellerAuthFields }),
    response: z.object({
      revenue_paisa_30d: z.number(), orders_30d: z.number(),
      orders_by_status: z.record(z.string(), z.number()),
      top_products: z.array(z.object({ id: z.number(), name: z.string(), quantity: z.number(), revenue_paisa: z.number() })),
      low_stock: z.array(z.object({ id: z.number(), name: z.string(), stock: z.number(), variant_label: z.string().nullable() })),
      total_customers: z.number(), avg_rating: z.number().nullable(),
      revenue_by_day: z.array(z.object({ day: z.string(), revenue_paisa: z.number() })),
      product_views_30d: z.number(), view_to_order_pct: z.number(), avg_fulfilment_days: z.number().nullable(),
    }),
  },
  listReturns: { request: z.object({ ...sellerAuthFields }), response: z.object({ orders: z.array(orderExSchema) }) },

  adminAnalytics: {
    request: z.object({ authToken }),
    response: z.object({
      revenue_by_day: z.array(z.object({ day: z.string(), revenue_paisa: z.number() })),
      orders_by_status: z.record(z.string(), z.number()),
      conversion_pct: z.number(), aov_paisa: z.number(),
      top_products: z.array(z.object({ id: z.number(), name: z.string(), quantity: z.number(), revenue_paisa: z.number() })),
      top_categories: z.array(z.object({ category: z.string(), revenue_paisa: z.number() })),
      top_searches: z.array(z.object({ query: z.string(), count: z.number() })),
      low_stock_products: z.array(z.object({ id: z.number(), name: z.string(), stock: z.number(), store_name: z.string() })),
      funnel: z.object({
        views_30d: z.number(), add_to_cart_30d: z.number(), checkout_start_30d: z.number(), purchases_30d: z.number(),
        view_to_cart_pct: z.number(), cart_to_checkout_pct: z.number(), checkout_to_purchase_pct: z.number(),
        cart_abandonment_pct: z.number(),
      }),
      totals: z.object({ orders_30d: z.number(), revenue_paisa_30d: z.number(), customers_30d: z.number() }),
    }),
  },
  adminListCategories: {
    request: z.object({ authToken }),
    // Mirrors the server's adminListCategories response: includes the v9
    // category SEO fields (seo_title / seo_description / intro_content).
    response: z.object({ categories: z.array(z.object({ id: z.number(), name: z.string(), slug: z.string(), is_active: z.boolean(), seo_title: z.string().nullable(), seo_description: z.string().nullable(), intro_content: z.string().nullable() })) }),
  },
  adminSaveCategory: {
    request: z.object({ authToken, id: z.number().optional(), name: z.string().trim().min(1), is_active: z.boolean().optional() }),
    response: z.object({ id: z.number() }),
  },
  adminDeleteCategory: { request: z.object({ authToken, id: z.number() }), response: z.object({ ok: z.boolean() }) },
  // v12: seller category requests (mirrors server/src/actions.ts).
  sellerRequestCategory: {
    request: z.object({ authToken, name: z.string().trim().min(2).max(40) }),
    response: z.object({ id: z.number() }),
  },
  sellerListMyCategoryRequests: {
    request: z.object({ authToken }),
    response: z.object({ requests: z.array(z.object({ id: z.number(), name: z.string(), status: z.string(), created_at: z.string() })) }),
  },
  adminListCategoryRequests: {
    request: z.object({ authToken }),
    response: z.object({ requests: z.array(z.object({ id: z.number(), name: z.string(), status: z.string(), store_name: z.string(), seller_code: z.string(), created_at: z.string(), decided_at: z.string().nullable() })) }),
  },
  adminDecideCategoryRequest: {
    request: z.object({ authToken, id: z.number(), approve: z.boolean() }),
    response: z.object({ ok: z.boolean() }),
  },
  adminListBanners: {
    request: z.object({ authToken }),
    response: z.object({ banners: z.array(z.object({ id: z.number(), title: z.string(), subtitle: z.string().nullable(), link: z.string().nullable(), image_url: z.string().nullable(), is_active: z.boolean(), sort_order: z.number() })) }),
  },
  adminSaveBanner: {
    request: z.object({ authToken, id: z.number().optional(), title: z.string().trim().min(1), subtitle: z.string().nullable().optional(), link: z.string().nullable().optional(), image_url: z.string().nullable().optional(), is_active: z.boolean().optional(), sort_order: z.number().optional() }),
    response: z.object({ id: z.number() }),
  },
  adminDeleteBanner: { request: z.object({ authToken, id: z.number() }), response: z.object({ ok: z.boolean() }) },
  adminListSections: {
    request: z.object({ authToken }),
    response: z.object({ sections: z.array(z.object({ key: z.string(), title: z.string(), is_active: z.boolean(), sort_order: z.number() })) }),
  },
  adminSaveSection: {
    request: z.object({ authToken, key: z.string(), title: z.string().trim().min(1), is_active: z.boolean(), sort_order: z.number() }),
    response: z.object({ ok: z.boolean() }),
  },
  adminListTickets: {
    request: z.object({ authToken, status: z.enum(["open", "answered", "closed"]).optional() }),
    response: z.object({ tickets: z.array(ticketSchema) }),
  },
  adminReplyTicket: {
    request: z.object({ authToken, ticket_code: z.string(), reply: z.string().trim().min(1) }),
    response: z.object({ ok: z.boolean() }),
  },
  adminCloseTicket: { request: z.object({ authToken, ticket_code: z.string() }), response: z.object({ ok: z.boolean() }) },

  createTicket: {
    request: z.object({
      authToken, name: z.string().trim().min(2), contact: z.string().trim().min(3),
      subject: z.string().trim().min(4).max(80), message: z.string().trim().min(10).max(1000),
      order_code: z.string().trim().optional(),
    }),
    response: z.object({ ticket_code: z.string() }),
  },
  getMyTickets: { request: z.object({ authToken }), response: z.object({ tickets: z.array(ticketSchema) }) },
} satisfies Record<string, { request: ZodType; response: ZodType }>;

const rawApi2 = createActionClient<typeof p2Actions>();
type Api2 = typeof rawApi2;

function withAuth(proxy: Api2): Api2 {
  return new Proxy(proxy, {
    get(target, name, receiver) {
      const fn = Reflect.get(target, name, receiver) as unknown;
      if (typeof fn !== "function" || typeof name !== "string") return fn;
      return (args?: Record<string, unknown>) => {
        let merged = args;
        const auth = getAuth();
        if (auth?.token && args && typeof args === "object" && !("authToken" in args)) {
          merged = { ...args, authToken: auth.token };
        }
        return (fn as (a?: unknown) => unknown).call(target, merged);
      };
    },
  }) as Api2;
}

export const api2 = withAuth(rawApi2);

export type { ApiResponse };
export type Api2Request<K extends keyof Api2> = Parameters<Api2[K]>[0];
export type Api2Response<K extends keyof Api2> = Awaited<ReturnType<Api2[K]>>;

// --- bridging helpers -------------------------------------------------------
// Storefront/products from v2 actions lack the phase-2 fields (the server
// returns them once phase-2 lands). Normalise so the whole UI can rely on
// P2Product everywhere.
type V2Product = ApiResponse<typeof api, "getStorefront">["products"][number];
type V2Order = ApiResponse<typeof api, "listOrders">["orders"][number];

export function toP2Product(p: V2Product): P2Product {
  const x = p as Partial<P2Product>;
  return {
    ...(p as V2Product),
    brand: x.brand ?? null,
    original_price_paisa: x.original_price_paisa ?? null,
    discount_pct: x.discount_pct ?? 0,
    image_url: x.image_url ?? null,
    images: x.images ?? [],
    low_stock: x.low_stock ?? false,
  };
}

export function toP2Order(o: V2Order): P2Order {
  const x = o as Partial<P2Order>;
  return {
    ...o,
    payment_method: x.payment_method ?? "cod",
    payment_status: x.payment_status ?? "pending",
    discount_paisa: x.discount_paisa ?? 0,
    coupon_code: x.coupon_code ?? null,
    delivery_method: x.delivery_method ?? "standard",
    status: o.status as P2OrderStatus,
    group_id: x.group_id ?? null,
    group_code: x.group_code ?? null,
    tracking_number: x.tracking_number ?? null,
    carrier: x.carrier ?? null,
    delivered_at: x.delivered_at ?? null,
    return_reason: x.return_reason ?? null,
    refund_status: x.refund_status ?? null,
  };
}

export function toP2OrderGroup(g: {
  id: number; group_code: string; customer_name: string; phone: string; address: string; note: string;
  subtotal_paisa: number; delivery_fee_paisa: number; discount_paisa: number; total_paisa: number;
  payment_method: "cod" | "esewa" | "khalti";
  payment_status: P2OrderGroup["payment_status"];
  delivery_method: "standard" | "express" | "pickup";
  coupon_code: string | null; created_at: string;
  orders: (V2Order & { store_name: string })[];
}): P2OrderGroup {
  return { ...g, orders: g.orders.map((o) => ({ ...toP2Order(o), store_name: o.store_name })) };
}

/** Extended placeOrder request/response per the multi-seller contract.
 *  The server is backward compatible with the old single-seller shape:
 *  it still returns the first fulfilment's order_code/order_id, but the
 *  customer-facing order is now the group (group_code/group_id/orders). */
export type PlaceOrderArgs = Omit<Parameters<typeof api.placeOrder>[0], "cod_confirmed"> & {
  payment_method?: "cod" | "esewa" | "khalti";
  cod_confirmed?: boolean;
  coupon_code?: string;
  address_id?: number;
  delivery_method?: "standard" | "express" | "pickup";
  idempotency_key?: string;
};
export type PlaceOrderResult = Awaited<ReturnType<typeof api.placeOrder>>;
export async function placeOrder(args: PlaceOrderArgs): Promise<PlaceOrderResult> {
  const result = await api.placeOrder(args as Parameters<typeof api.placeOrder>[0]);
  return result;
}

// --- seller product photo uploads -------------------------------------------
// These go to the self-hosted server's /api/uploads routes (multipart file
// upload can't travel over the JSON action RPC). Only available when the
// shop is served by selfhost.ts.
export interface SellerUploadAuth {
  authToken?: string;
  seller_code?: string;
  seller_key?: string;
}

export async function uploadProductImage(
  auth: SellerUploadAuth, product_id: number, file: File,
): Promise<{ id: number; url: string }> {
  const form = new FormData();
  form.append("file", file);
  form.append("product_id", String(product_id));
  if (auth.authToken) form.append("authToken", auth.authToken);
  if (auth.seller_code) form.append("seller_code", auth.seller_code);
  if (auth.seller_key) form.append("seller_key", auth.seller_key);
  const res = await fetch("/api/uploads", { method: "POST", body: form });
  const body = await res.json().catch(() => ({})) as { data?: { images: { id: number; url: string }[] }; error?: string };
  if (!res.ok || !body.data?.images?.length) throw new Error(body.error ?? "Upload failed.");
  const img = body.data.images[0];
  if (!img) throw new Error("Upload failed.");
  return img;
}

export async function deleteProductImage(auth: SellerUploadAuth, imageId: number): Promise<void> {
  // Credentials travel in headers, never in the URL: query strings end up in
  // server access logs. The session token goes in x-auth-token; legacy
  // seller credentials go in x-seller-code / x-seller-key.
  const headers: Record<string, string> = {};
  if (auth.authToken) headers["x-auth-token"] = auth.authToken;
  if (auth.seller_code) headers["x-seller-code"] = auth.seller_code;
  if (auth.seller_key) headers["x-seller-key"] = auth.seller_key;
  const res = await fetch(`/api/uploads/${imageId}`, { method: "DELETE", headers });
  const body = await res.json().catch(() => ({})) as { error?: string };
  if (!res.ok) throw new Error(body.error ?? "Could not remove the photo.");
}

// --- admin advertisement banner uploads --------------------------------------
// The admin's banner images go to /api/banner-uploads (admin session token in
// the x-auth-token header). Only available on the self-hosted server.
export async function uploadBannerImage(file: File): Promise<string> {
  const token = getAuth()?.token;
  if (!token) throw new Error("Please sign in as admin first.");
  const form = new FormData();
  form.append("file", file);
  const res = await fetch("/api/banner-uploads", { method: "POST", headers: { "x-auth-token": token }, body: form });
  const body = await res.json().catch(() => ({})) as { data?: { url: string }; error?: string };
  if (!res.ok || !body.data?.url) throw new Error(body.error ?? "Upload failed.");
  return body.data.url;
}

// --- seller store logo / banner uploads -------------------------------------
// The seller's store logo and banner go to /api/store-uploads on the
// self-hosted server (multipart, like product photos). The saveStoreAssets
// action then attaches the returned URL to the store.
export async function uploadStoreAsset(
  auth: SellerUploadAuth, kind: "logo" | "banner", file: File,
): Promise<string> {
  const form = new FormData();
  form.append("file", file);
  form.append("kind", kind);
  if (auth.authToken) form.append("authToken", auth.authToken);
  if (auth.seller_code) form.append("seller_code", auth.seller_code);
  if (auth.seller_key) form.append("seller_key", auth.seller_key);
  const res = await fetch("/api/store-uploads", { method: "POST", body: form });
  const body = await res.json().catch(() => ({})) as { data?: { url: string }; error?: string };
  if (!res.ok || !body.data?.url) throw new Error(body.error ?? "Upload failed.");
  return body.data.url;
}
