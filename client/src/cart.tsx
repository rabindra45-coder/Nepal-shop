// Cart state: signed-in buyers use the server cart (getCart / addToCart /
// updateCartItem / clearCart); guests keep the v2 localStorage cart. One
// seller per order is enforced up front, matching the server rule.
// Lines are keyed by product + variant (variant_id 0 = the base product).
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type AuthInfo } from "./api";
import { api2, toP2Product, type P2Product } from "./phase2api";

export interface CartLine { product: P2Product; quantity: number; variantId: number; variantLabel: string | null; unitPrice: number; stock: number }
// Variant info as known on the product page (from getProductDetail).
export interface CartVariant { id: number; label: string; unitPrice: number; stock: number }

interface CartValue {
  lines: CartLine[]; count: number; subtotal: number;
  products: P2Product[]; storefrontPending: boolean; storefrontError: boolean; sellerCount: number;
  cartNotice: string; busy: boolean; cartError: string;
  add: (product: P2Product, qty?: number, variant?: CartVariant) => void;
  setQty: (productId: number, qty: number, variantId?: number) => void;
  remove: (productId: number, variantId?: number) => void;
  clear: () => void;
  dismissCartError: () => void;
}

const CartCtx = createContext<CartValue>({
  lines: [], count: 0, subtotal: 0, products: [], storefrontPending: true,
  storefrontError: false, sellerCount: 0, cartNotice: "", busy: false, cartError: "",
  add: () => {}, setQty: () => {}, remove: () => {}, clear: () => {}, dismissCartError: () => {},
});
export function useCart() { return useContext(CartCtx); }

const GUEST_KEY = "nepalsite_guest_cart";
export interface GuestCartEntry { quantity: number; variantLabel: string | null; unitPrice: number; stock: number }
// Keyed `${productId}:${variantId}` (variant 0 = base product). Older carts
// stored a bare number per product id; those still read as base-product lines.
export function readGuestCart(): Record<string, GuestCartEntry> {
  try {
    const raw = JSON.parse(localStorage.getItem(GUEST_KEY) ?? "{}");
    if (!raw || typeof raw !== "object") return {};
    const out: Record<string, GuestCartEntry> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === "number") out[k] = { quantity: v, variantLabel: null, unitPrice: 0, stock: 0 };
      else if (v && typeof v === "object") {
        const e = v as Partial<GuestCartEntry>;
        out[k] = { quantity: Number(e.quantity) || 0, variantLabel: e.variantLabel ?? null, unitPrice: Number(e.unitPrice) || 0, stock: Number(e.stock) || 0 };
      }
    }
    return out;
  }
  catch { return {}; }
}
export function writeGuestCart(cart: Record<string, GuestCartEntry>) { localStorage.setItem(GUEST_KEY, JSON.stringify(cart)); }
export function clearGuestCart() { localStorage.removeItem(GUEST_KEY); }

const ONE_SELLER_MSG = "One seller per order keeps delivery fees and confirmation clear. Finish or empty this basket first.";

export function CartProvider({ auth, children }: { auth: AuthInfo | null; children: ReactNode }) {
  const queryClient = useQueryClient();
  const isBuyer = auth?.type === "buyer";
  const [guestCart, setGuestCart] = useState<Record<string, GuestCartEntry>>(readGuestCart);
  const [cartNotice, setCartNotice] = useState("");
  const [cartError, setCartError] = useState("");

  useEffect(() => { if (!isBuyer) writeGuestCart(guestCart); }, [guestCart, isBuyer]);

  const storefront = useQuery({ queryKey: ["storefront"], queryFn: () => api.getStorefront({}) });
  const products: P2Product[] = useMemo(() => (storefront.data?.products ?? []).map(toP2Product), [storefront.data]);
  const productById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  // server cart for signed-in buyers
  const serverCart = useQuery({
    queryKey: ["cart", auth?.token ?? null],
    queryFn: () => api2.getCart({}),
    enabled: !!isBuyer,
  });
  const invalidateCart = () => { void queryClient.invalidateQueries({ queryKey: ["cart"] }); };

  const mut = useMutation({
    mutationFn: async (fn: () => Promise<void>) => fn(),
    onError: (e) => {
      const message = e instanceof Error ? e.message : String(e);
      setCartError(message.replace(/^action \w+ (error|failed):\s*\d*\s*/, "").trim() || message);
    },
  });

  const serverLines: CartLine[] = useMemo(
    () => (serverCart.data?.items ?? []).map((i) => ({
      product: i.product, quantity: i.quantity, variantId: i.variant_id,
      variantLabel: i.variant_label, unitPrice: i.unit_price_paisa, stock: i.stock,
    })),
    [serverCart.data],
  );
  const guestLines: CartLine[] = useMemo(
    () => Object.entries(guestCart).flatMap(([key, entry]): CartLine[] => {
      const [idStr, varStr] = key.split(":");
      const product = productById.get(Number(idStr));
      if (!product || entry.quantity <= 0) return [];
      const variantId = Number(varStr ?? 0) || 0;
      const unitPrice = entry.unitPrice > 0 ? entry.unitPrice : product.price_paisa;
      return [{
        product, quantity: entry.quantity, variantId,
        variantLabel: entry.variantLabel, unitPrice,
        stock: entry.stock > 0 ? entry.stock : product.stock,
      }];
    }),
    [guestCart, productById],
  );
  const lines = isBuyer ? serverLines : guestLines;
  const count = lines.reduce((s, l) => s + l.quantity, 0);
  const subtotal = lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0);

  const checkOneSeller = useCallback((incoming: P2Product) => {
    const current = lines[0]?.product.store_id;
    if (incoming.store_id !== current && current !== undefined) { setCartNotice(ONE_SELLER_MSG); return false; }
    setCartNotice("");
    return true;
  }, [lines]);

  const add = useCallback((product: P2Product, qty = 1, variant?: CartVariant) => {
    setCartError("");
    const variantId = variant?.id ?? 0;
    const stock = variant?.stock ?? product.stock;
    const unitPrice = variant?.unitPrice ?? product.price_paisa;
    if (stock === 0) { setCartError("That item is out of stock."); return; }
    if (!checkOneSeller(product)) return;
    if (isBuyer) {
      const existing = lines.find((l) => l.product.id === product.id && l.variantId === variantId)?.quantity ?? 0;
      if (existing + qty > stock) { setCartError(`Only ${stock} in stock${existing ? `, ${existing} already in your basket` : ""}.`); return; }
      mut.mutate(async () => { await api2.addToCart({ product_id: product.id, quantity: qty, variant_id: variantId }); invalidateCart(); });
    } else {
      const key = `${product.id}:${variantId}`;
      setGuestCart((cur) => {
        const existing = cur[key]?.quantity ?? 0;
        const next = Math.min(stock, existing + qty);
        if (next <= existing) { setCartError(`Only ${stock} in stock.`); return cur; }
        return { ...cur, [key]: { quantity: next, variantLabel: variant?.label ?? null, unitPrice, stock } };
      });
    }
  }, [isBuyer, lines, mut, checkOneSeller]);

  const setQty = useCallback((productId: number, qty: number, variantId = 0) => {
    setCartError("");
    const line = lines.find((l) => l.product.id === productId && l.variantId === variantId);
    const stock = line?.stock ?? line?.product.stock ?? qty;
    if (isBuyer) {
      if (qty > stock) { setCartError(`Only ${stock} in stock.`); return; }
      mut.mutate(async () => { await api2.updateCartItem({ product_id: productId, quantity: qty, variant_id: variantId }); invalidateCart(); });
    } else {
      setGuestCart((cur) => {
        const key = `${productId}:${variantId}`;
        if (qty <= 0) { const { [key]: _drop, ...rest } = cur; return rest; }
        if (qty > stock) { setCartError(`Only ${stock} in stock.`); return cur; }
        const prev = cur[key];
        if (!prev) return cur;
        return { ...cur, [key]: { ...prev, quantity: qty } };
      });
    }
  }, [isBuyer, lines, mut]);

  const remove = useCallback((productId: number, variantId = 0) => setQty(productId, 0, variantId), [setQty]);
  const clear = useCallback(() => {
    setCartError("");
    if (isBuyer) mut.mutate(async () => { await api2.clearCart({}); invalidateCart(); });
    else setGuestCart({});
  }, [isBuyer, mut]);

  const value: CartValue = {
    lines, count, subtotal, products, cartNotice,
    storefrontPending: storefront.isPending,
    storefrontError: !!storefront.error,
    sellerCount: storefront.data?.seller_count ?? 0,
    busy: mut.isPending, cartError, add, setQty, remove, clear,
    dismissCartError: () => setCartError(""),
  };
  return <CartCtx.Provider value={value}>{children}</CartCtx.Provider>;
}
