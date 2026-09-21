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
  `Rs ${(paisa / 100).toLocaleString("en-NP", { maximumFractionDigits: 2 })}`;
export const fmtDate = (value: string | number) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));

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
});
export type P2Product = z.infer<typeof productPublicSchema>;

export const orderStatusExSchema = z.enum([
  "confirmation_needed", "confirmed", "packed", "shipped", "out_for_delivery",
  "delivered", "return_requested", "returned", "refunded", "cancelled",
]);
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
  items: z.array(z.object({
    id: z.number(), product_id: z.number(), product_name: z.string(),
    quantity: z.number(), unit_price_paisa: z.number(),
  })),
});
export type P2Order = z.infer<typeof orderExSchema>;

const cartResponseSchema = z.object({
  items: z.array(z.object({ product_id: z.number(), quantity: z.number(), product: productPublicSchema })),
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
  value: z.number(), min_order_paisa: z.number(), max_uses: z.number().nullable(),
  per_user_limit: z.number(), expires_at: z.number().nullable(),
  is_active: z.boolean(), created_at: z.number(),
});
export type P2Coupon = z.infer<typeof couponSchema>;

// --- phase-2 actions (exact per CONTRACT.md) --------------------------------
const p2Actions = {
  getCart: { request: z.object({ authToken }), response: cartResponseSchema },
  addToCart: {
    request: z.object({ authToken, product_id: z.number().int().positive(), quantity: z.number().int().min(1).max(20) }),
    response: z.object({ cart: cartResponseSchema }),
  },
  updateCartItem: {
    request: z.object({ authToken, product_id: z.number().int().positive(), quantity: z.number().int().min(0).max(20) }),
    response: z.object({ cart: cartResponseSchema }),
  },
  clearCart: { request: z.object({ authToken }), response: z.object({ ok: z.boolean() }) },
  mergeCart: {
    request: z.object({ authToken, items: z.array(z.object({ product_id: z.number().int().positive(), quantity: z.number().int().min(1).max(20) })).max(30) }),
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
    request: z.object({ authToken, code: z.string(), subtotal_paisa: z.number() }),
    response: z.object({ valid: z.boolean(), discount_paisa: z.number(), free_shipping: z.boolean(), message: z.string() }),
  },
  adminListCoupons: { request: z.object({ authToken }), response: z.object({ coupons: z.array(couponSchema) }) },
  adminSaveCoupon: {
    request: z.object({
      authToken, id: z.number().optional(), code: z.string().trim().min(1),
      kind: z.enum(["percent", "fixed", "free_shipping"]), value: z.number().int(),
      min_order_paisa: z.number().int().optional(), max_uses: z.number().int().nullable().optional(),
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
  updateReturnStatus: {
    request: z.object({ ...sellerAuthFields, order_id: z.number(), decision: z.enum(["accepted", "rejected"]) }),
    response: z.object({ ok: z.boolean() }),
  },
  markRefunded: {
    request: z.object({ ...sellerAuthFields, order_id: z.number() }),
    response: z.object({ ok: z.boolean() }),
  },

  initiateOnlinePayment: {
    request: z.object({ authToken, order_id: z.number(), provider: z.enum(["esewa", "khalti"]), phone: z.string().optional() }),
    response: z.object({ provider: z.string(), payment_url: z.string(), params: z.record(z.string(), z.unknown()).optional(), pidx: z.string().optional() }),
  },
  verifyEsewaPayment: {
    request: z.object({ order_id: z.number(), data: z.string() }),
    response: z.object({ ok: z.boolean() }),
  },
  verifyKhaltiPayment: {
    request: z.object({ order_id: z.number(), pidx: z.string() }),
    response: z.object({ ok: z.boolean() }),
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
      reviews: z.array(z.object({ id: z.number(), rating: z.number(), body: z.string(), reviewer_name: z.string(), created_at: z.string() })),
      related: z.array(productPublicSchema),
      frequently_bought_together: z.array(productPublicSchema),
      seller: z.object({ store_name: z.string(), location: z.string(), rating: z.number().nullable(), product_count: z.number(), verified: z.boolean() }),
    }),
  },
  searchProducts: {
    request: z.object({
      query: z.string(), category: z.string().optional(), brand: z.string().optional(),
      min_price_paisa: z.number().optional(), max_price_paisa: z.number().optional(),
      min_rating: z.number().optional(), in_stock_only: z.boolean().optional(),
      on_sale_only: z.boolean().optional(), seller_code: z.string().optional(),
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
      banners: z.array(z.object({ title: z.string(), subtitle: z.string().nullable(), link: z.string().nullable() })),
      sections: z.array(z.object({ key: z.string(), title: z.string(), products: z.array(productPublicSchema) })),
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
      low_stock: z.array(z.object({ id: z.number(), name: z.string(), stock: z.number() })),
      total_customers: z.number(), avg_rating: z.number().nullable(),
      revenue_by_day: z.array(z.object({ day: z.string(), revenue_paisa: z.number() })),
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
    }),
  },
  adminListCategories: {
    request: z.object({ authToken }),
    response: z.object({ categories: z.array(z.object({ id: z.number(), name: z.string(), slug: z.string(), is_active: z.boolean() })) }),
  },
  adminSaveCategory: {
    request: z.object({ authToken, id: z.number().optional(), name: z.string().trim().min(1), is_active: z.boolean().optional() }),
    response: z.object({ id: z.number() }),
  },
  adminDeleteCategory: { request: z.object({ authToken, id: z.number() }), response: z.object({ ok: z.boolean() }) },
  adminListBanners: {
    request: z.object({ authToken }),
    response: z.object({ banners: z.array(z.object({ id: z.number(), title: z.string(), subtitle: z.string().nullable(), link: z.string().nullable(), is_active: z.boolean(), sort_order: z.number() })) }),
  },
  adminSaveBanner: {
    request: z.object({ authToken, id: z.number().optional(), title: z.string().trim().min(1), subtitle: z.string().nullable().optional(), link: z.string().nullable().optional(), is_active: z.boolean().optional(), sort_order: z.number().optional() }),
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
  };
}

/** Extended placeOrder request/response per the phase-2 contract (server is
 *  backward compatible with the v1 shape). Casts are needed until server types
 *  are regenerated with the phase-2 actions. */
export type PlaceOrderArgs = Omit<Parameters<typeof api.placeOrder>[0], "cod_confirmed"> & {
  payment_method?: "cod" | "esewa" | "khalti";
  cod_confirmed?: boolean;
  coupon_code?: string;
  address_id?: number;
  delivery_method?: "standard" | "express" | "pickup";
};
export type PlaceOrderResult = Awaited<ReturnType<typeof api.placeOrder>> & {
  payment_method: "cod" | "esewa" | "khalti";
  payment_status: "pending" | "processing" | "paid" | "failed";
  order_id: number;
};
export async function placeOrder(args: PlaceOrderArgs): Promise<PlaceOrderResult> {
  const result = await api.placeOrder(args as Parameters<typeof api.placeOrder>[0]);
  return result as PlaceOrderResult;
}
