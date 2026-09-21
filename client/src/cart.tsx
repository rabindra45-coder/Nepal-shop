// Cart state: signed-in buyers use the server cart (getCart / addToCart /
// updateCartItem / clearCart); guests keep the v2 localStorage cart. One
// seller per order is enforced up front, matching the server rule.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type AuthInfo } from "./api";
import { api2, toP2Product, type P2Product } from "./phase2api";

export interface CartLine { product: P2Product; quantity: number }

interface CartValue {
  lines: CartLine[]; count: number; subtotal: number;
  products: P2Product[]; storefrontPending: boolean; storefrontError: boolean; sellerCount: number;
  cartNotice: string; busy: boolean; cartError: string;
  add: (product: P2Product, qty?: number) => void;
  setQty: (productId: number, qty: number) => void;
  remove: (productId: number) => void;
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
export function readGuestCart(): Record<number, number> {
  try { const raw = JSON.parse(localStorage.getItem(GUEST_KEY) ?? "{}"); return raw && typeof raw === "object" ? raw : {}; }
  catch { return {}; }
}
export function writeGuestCart(cart: Record<number, number>) { localStorage.setItem(GUEST_KEY, JSON.stringify(cart)); }
export function clearGuestCart() { localStorage.removeItem(GUEST_KEY); }

const ONE_SELLER_MSG = "One seller per order keeps delivery fees and confirmation clear. Finish or empty this basket first.";

export function CartProvider({ auth, children }: { auth: AuthInfo | null; children: ReactNode }) {
  const queryClient = useQueryClient();
  const isBuyer = auth?.type === "buyer";
  const [guestCart, setGuestCart] = useState<Record<number, number>>(readGuestCart);
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
    () => (serverCart.data?.items ?? []).map((i) => ({ product: i.product, quantity: i.quantity })),
    [serverCart.data],
  );
  const guestLines: CartLine[] = useMemo(
    () => Object.entries(guestCart)
      .map(([id, qty]) => ({ product: productById.get(Number(id)), quantity: qty }))
      .filter((l): l is CartLine => !!l.product && l.quantity > 0),
    [guestCart, productById],
  );
  const lines = isBuyer ? serverLines : guestLines;
  const count = lines.reduce((s, l) => s + l.quantity, 0);
  const subtotal = lines.reduce((s, l) => s + l.product.price_paisa * l.quantity, 0);

  const checkOneSeller = useCallback((incoming: P2Product) => {
    const current = lines[0]?.product.store_id;
    if (incoming.store_id !== current && current !== undefined) { setCartNotice(ONE_SELLER_MSG); return false; }
    setCartNotice("");
    return true;
  }, [lines]);

  const add = useCallback((product: P2Product, qty = 1) => {
    setCartError("");
    if (product.stock === 0) { setCartError("That item is out of stock."); return; }
    if (!checkOneSeller(product)) return;
    if (isBuyer) {
      const existing = lines.find((l) => l.product.id === product.id)?.quantity ?? 0;
      if (existing + qty > product.stock) { setCartError(`Only ${product.stock} in stock${existing ? `, ${existing} already in your basket` : ""}.`); return; }
      mut.mutate(async () => { await api2.addToCart({ product_id: product.id, quantity: qty }); invalidateCart(); });
    } else {
      setGuestCart((cur) => {
        const existing = cur[product.id] ?? 0;
        const next = Math.min(product.stock, existing + qty);
        if (next <= existing) { setCartError(`Only ${product.stock} in stock.`); return cur; }
        return { ...cur, [product.id]: next };
      });
    }
  }, [isBuyer, lines, mut, checkOneSeller]);

  const setQty = useCallback((productId: number, qty: number) => {
    setCartError("");
    const product = productById.get(productId) ?? lines.find((l) => l.product.id === productId)?.product;
    if (isBuyer) {
      if (product && qty > product.stock) { setCartError(`Only ${product.stock} in stock.`); return; }
      mut.mutate(async () => { await api2.updateCartItem({ product_id: productId, quantity: qty }); invalidateCart(); });
    } else {
      setGuestCart((cur) => {
        if (qty <= 0) { const { [productId]: _drop, ...rest } = cur; return rest; }
        const stock = product?.stock ?? qty;
        if (qty > stock) { setCartError(`Only ${stock} in stock.`); return cur; }
        return { ...cur, [productId]: qty };
      });
    }
  }, [isBuyer, lines, mut, productById]);

  const remove = useCallback((productId: number) => setQty(productId, 0), [setQty]);
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
