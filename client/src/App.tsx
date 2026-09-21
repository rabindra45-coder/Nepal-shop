// Nepal Shop — client shell. Phase-2 build: the v2 screens keep working
// untouched in behaviour; new routes/screens are added alongside.
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, clearAuth, clearLegacySeller, getAuth, getLegacySeller, setAuth, setLegacySeller, type ApiResponse, type AuthInfo, type LegacySeller } from "./api";
import { api2, money, toP2Order, type P2Product } from "./phase2api";
import { AuthContext, go, useAuth, useRoute } from "./session";
import { CartProvider, clearGuestCart, readGuestCart, useCart } from "./cart";
import { ToastProvider, useToast, ProductCard, ProductImage } from "./ui";
import heroArt from "./assets/media-generation-parcel-exchange-hero-0-364bfe57-0c17-45e8-89e7-830437bcf626.png";
import {
  AssistantPage, CartPage, CheckoutPage, ComparePage, Homepage, PaymentResultPage,
  ProductPage, SearchPage, WishlistPage, STATUS_LABEL, PAY_LABEL,
} from "./screens";
import { AccountHub, AddressesPage, HelpPage, NotificationsPage, useUnreadCount } from "./account";
import { ProductExtraFields, ReturnRequestForm, SellerAnalytics, SellerReturns, productExtraPayload } from "./studio2";
import { AdminAnalytics, AdminCategories, AdminCoupons, AdminHomepage, AdminTickets } from "./admin2";

type Order = ApiResponse<typeof api, "listOrders">["orders"][number];
type AdminSeller = ApiResponse<typeof api, "adminListSellers">["sellers"][number];
type AdminProduct = ApiResponse<typeof api, "adminListProducts">["products"][number];
type AdminOrder = ApiResponse<typeof api, "adminListOrders">["orders"][number];
type AdminIssue = ApiResponse<typeof api, "adminListIssues">["issues"][number];
type AdminUser = ApiResponse<typeof api, "adminListUsers">["users"][number];

const nextStatus: Partial<Record<Order["status"], Order["status"]>> = {
  confirmation_needed: "confirmed", confirmed: "packed", packed: "shipped",
  shipped: "delivered",
};
const sellerStatusLabel: Record<AdminSeller["status"], string> = { pending: "Waiting for approval", active: "Active", suspended: "Suspended" };

function FieldError({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  const clean = message.replace(/^action \w+ (error|failed):\s*\d*\s*/, "").trim() || message;
  return <p className="form-error" role="alert">{clean}</p>;
}

async function mergeGuestCartOnLogin() {
  try {
    const guest = readGuestCart();
    const items = Object.entries(guest).map(([product_id, quantity]) => ({ product_id: Number(product_id), quantity }));
    if (items.length > 0) await api2.mergeCart({ items });
  } catch { /* a failed merge must never block sign-in */ }
  clearGuestCart();
}

export function App() {
  const queryClient = useQueryClient();
  const { path, query } = useRoute();
  const [auth, setAuthState] = useState<AuthInfo | null>(() => getAuth());
  const signIn = (info: AuthInfo) => {
    setAuth(info); setAuthState(info);
    if (info.type === "buyer") void mergeGuestCartOnLogin().then(() => queryClient.invalidateQueries({ queryKey: ["cart"] }));
  };
  const signOut = () => {
    if (getAuth()?.token) void api.logout({}).catch(() => {});
    clearAuth(); clearLegacySeller(); setAuthState(null);
    void queryClient.invalidateQueries();
    go("/");
  };
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["storefront"] });
    void queryClient.invalidateQueries({ queryKey: ["orders"] });
    void queryClient.invalidateQueries({ queryKey: ["issues"] });
  };

  return (
    <AuthContext.Provider value={{ auth, signIn, signOut }}>
      <CartProvider auth={auth}>
        <ToastProvider>
          <div className="app-shell">
            <SafeAreaTopScrim backgroundColor="var(--bg)" />
            <SiteHeader path={path} />
            <RouteView path={path} query={query} invalidate={invalidate} />
            <footer className="site-footer">
              <span>Nepal Shop · a local marketplace</span>
              <nav>
                <button className="linklike" onClick={() => go("/help")}>Help</button>
                <button className="linklike" onClick={() => go(auth?.type === "admin" ? "/admin" : "/admin/login")}>Admin</button>
              </nav>
            </footer>
            <MobileNav path={path} />
          </div>
        </ToastProvider>
      </CartProvider>
    </AuthContext.Provider>
  );
}

// --- header ------------------------------------------------------------------
function SiteHeader({ path }: { path: string }) {
  const { auth, signOut } = useAuth();
  const { count } = useCart();
  const wish = useQuery({ queryKey: ["wishlist"], queryFn: () => api2.getWishlist({}), enabled: auth?.type === "buyer" });
  const unread = useUnreadCount();
  const [showCart, setShowCart] = useState(false);
  return (<>
    <header className="topbar">
      <button className="brand" onClick={() => go("/")} aria-label="Nepal Shop home">Nepal&nbsp;Shop</button>
      <nav aria-label="Main sections" className="tabs">
        <button className={path === "/" ? "active" : ""} onClick={() => go("/")}>Home</button>
        <button className={path === "/shop" ? "active" : ""} onClick={() => go("/shop")}>Shop</button>
        <button className={path === "/assistant" ? "active" : ""} onClick={() => go("/assistant")}>Assistant</button>
        <button className={path === "/track" || path === "/account/orders" ? "active" : ""} onClick={() => go("/track")}>My order</button>
        <button className={path.startsWith("/seller") ? "active" : ""} onClick={() => go("/seller")}>Seller studio</button>
      </nav>
      <div className="header-search hide-mobile"><HeaderSearch /></div>
      <div className="account-menu">
        {auth?.type === "buyer" && <>
          <button className={path === "/wishlist" ? "active" : ""} onClick={() => go("/wishlist")} aria-label={`Wishlist, ${wish.data?.items.length ?? 0} items`}>♥ {wish.data ? wish.data.items.length : ""}</button>
          <button className={`bell${path === "/notifications" ? " active" : ""}`} onClick={() => go("/notifications")} aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`}>🔔{unread > 0 && <span className="badge">{unread}</span>}</button>
          <button className={path.startsWith("/account") ? "active" : ""} onClick={() => go("/account")}>Account</button>
        </>}
        {!auth && <>
          <button className={path === "/login" ? "active" : ""} onClick={() => go("/login")}>Log in</button>
          <button className={`signup-cta${path === "/signup" ? " active" : ""}`} onClick={() => go("/signup")}>Sign up</button>
        </>}
        {auth?.type === "seller" && <>
          <button onClick={() => go("/seller")}>Studio</button>
          <span className="account-name" title={auth.name}>{auth.name}</span>
          <button onClick={signOut}>Log out</button>
        </>}
        {auth?.type === "admin" && <>
          <button onClick={() => go("/admin")}>Admin panel</button>
          <span className="account-name" title={auth.name}>{auth.name}</span>
          <button onClick={signOut}>Log out</button>
        </>}
        {auth?.type === "buyer" && <span className="account-name" title={auth.name}>{auth.name}</span>}
        {auth?.type === "buyer" && <button onClick={signOut} title="Log out">⎋</button>}
        <button className="cart-button" onClick={() => setShowCart(true)} aria-label={`Open basket with ${count} items`}>Basket <span>{count}</span></button>
      </div>
    </header>
    {showCart && <CheckoutSheet close={() => setShowCart(false)} onPlaced={(code) => { setShowCart(false); go("/track"); sessionStorage.setItem("lastOrderCode", code); }} />}
  </>);
}

function HeaderSearch() {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [debounced, setDebounced] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => { const t = window.setTimeout(() => setDebounced(q.trim()), 220); return () => window.clearTimeout(t); }, [q]);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);
  const sug = useQuery({ queryKey: ["suggest", debounced], queryFn: () => api2.suggestSearch({ query: debounced }), enabled: debounced.length >= 2 && open });
  const pick = (term: string) => { setOpen(false); setQ(""); go(`/search?q=${encodeURIComponent(term)}`); };
  return (
    <div className="suggest-box" ref={boxRef}>
      <form onSubmit={(e) => { e.preventDefault(); if (q.trim()) pick(q.trim()); }}>
        <input aria-label="Search products" value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} placeholder="Search products…" />
      </form>
      {open && debounced.length >= 2 && (sug.data?.product_names.length || sug.data?.categories.length) ? (
        <div className="suggest-drop" role="listbox">
          {sug.data.categories.map((c) => <button type="button" key={`c-${c}`} onClick={() => pick(c)}><span className="sug-kind">Category</span> {c}</button>)}
          {sug.data.product_names.map((n) => <button type="button" key={`p-${n}`} onClick={() => pick(n)}>{n}</button>)}
        </div>
      ) : null}
    </div>
  );
}

function MobileNav({ path }: { path: string }) {
  const { count } = useCart();
  const { auth } = useAuth();
  const items = [
    { id: "/", label: "Home", icon: "⌂" },
    { id: "/search", label: "Search", icon: "⚲" },
    { id: "/cart", label: `Basket${count ? ` (${count})` : ""}`, icon: "🧺" },
    { id: auth?.type === "buyer" ? "/account" : "/login", label: "Account", icon: "☺" },
  ];
  return (
    <nav className="mobile-nav" aria-label="Quick sections">
      {items.map((i) => <button key={i.id} className={path === i.id ? "active" : ""} onClick={() => go(i.id)}><span>{i.icon}</span>{i.label}</button>)}
    </nav>
  );
}

// --- router ------------------------------------------------------------------
function RouteView({ path, query, invalidate }: { path: string; query: URLSearchParams; invalidate: () => void }) {
  const { auth } = useAuth();
  useEffect(() => {
    if ((path === "/account" || path === "/account/addresses" || path === "/account/orders") && auth?.type !== "buyer") go("/login");
    if (path === "/admin" && auth?.type !== "admin") go("/admin/login");
    if (path === "/seller" && auth?.type !== "seller" && !getLegacySeller()) go("/seller/login");
  }, [path, auth]);
  if (path === "/track") return <TrackOrder invalidate={invalidate} />;
  if (path === "/login") return <BuyerLogin />;
  if (path === "/signup") return <BuyerSignup />;
  if (path === "/account") return auth?.type === "buyer" ? <AccountHub /> : null;
  if (path === "/account/addresses") return auth?.type === "buyer" ? <AddressesPage /> : null;
  if (path === "/account/orders") return auth?.type === "buyer" ? <MyOrders /> : null;
  if (path === "/notifications") return <NotificationsPage />;
  if (path === "/wishlist") return <WishlistPage />;
  if (path === "/cart") return <CartPage />;
  if (path === "/checkout") return <CheckoutPage />;
  if (path === "/payment-result") return <PaymentResultPage query={query} />;
  if (path === "/search") return <SearchPage key={query.get("q") ?? ""} initialQuery={query.get("q") ?? ""} />;
  if (path === "/compare") return <ComparePage />;
  if (path === "/assistant") return <AssistantPage />;
  if (path === "/help") return <HelpPage />;
  if (path.startsWith("/product/")) {
    const id = Number(path.slice("/product/".length).split(/[/?]/)[0]);
    return Number.isInteger(id) && id > 0 ? <ProductPage key={id} id={id} /> : <ShopPage />;
  }
  if (path === "/shop") return <ShopPage />;
  if (path === "/seller/login") return <SellerLogin />;
  if (path === "/seller") return auth?.type === "seller" || getLegacySeller() ? <Studio invalidate={invalidate} /> : null;
  if (path === "/admin/login") return <AdminLogin />;
  if (path === "/admin") return auth?.type === "admin" ? <AdminPanel /> : null;
  return <Homepage />;
}

// --- shop (v2 content, kept working at /shop) ----------------------------------
function ShopPage() {
  const { products, lines, cartNotice, add, setQty, storefrontPending, storefrontError, sellerCount } = useCart();
  const { toast } = useToast();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");
  const [selected, setSelected] = useState<P2Product | null>(null);
  const qtyById = useMemo(() => { const m = new Map<number, number>(); lines.forEach((l) => m.set(l.product.id, l.quantity)); return m; }, [lines]);
  const categories = ["All", ...new Set(products.map((p) => p.category))];
  const visible = products.filter((p) => (category === "All" || p.category === category) && `${p.name} ${p.description} ${p.category}`.toLowerCase().includes(query.toLowerCase()));

  if (storefrontPending) return <main className="loading">Opening the market…</main>;
  if (storefrontError) return <main className="loading">The storefront couldn’t load. Please reopen it.</main>;

  return (<>
    <main>
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">Local marketplace</p>
          <h1>Shop local.<br />Know who packed it.</h1>
          <p>{sellerCount ? `${sellerCount} local ${sellerCount === 1 ? "seller" : "sellers"}, one transparent checkout.` : "Products appear here when the first local seller publishes a listing."}</p>
        </div>
        <img src={heroArt} alt="Two hands passing a wrapped parcel across a shop counter" />
      </section>

      <section className="trust-strip" aria-label="Shopping protections">
        <div><b>01</b><span>Total shown before ordering</span></div>
        <div><b>02</b><span>COD waits for seller confirmation</span></div>
        <div><b>03</b><span>Reviews require delivery</span></div>
      </section>

      {cartNotice && <p className="cart-notice" role="status">{cartNotice}</p>}
      <section className="catalog">
        <div className="catalog-head">
          <div><p className="eyebrow">Open shelves</p><h2>What’s in stock</h2></div>
          <label className="search"><span>Search</span><input aria-label="Search products" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Name, category, detail" /></label>
        </div>
        {categories.length > 1 && <div className="category-list" aria-label="Product categories">{categories.map((item) => <button key={item} className={category === item ? "selected" : ""} onClick={() => setCategory(item)}>{item}</button>)}</div>}
        {visible.length === 0 ? <div className="empty-state"><span>THE SHELVES ARE QUIET</span><h3>{products.length ? "No products match that search." : "This seller hasn’t published a product yet."}</h3><p>{products.length ? "Try another word or show every category." : "Open Seller studio to create the store profile and first real listing."}</p>{products.length === 0 && <button className="primary" onClick={() => go("/seller")}>Set up the store</button>}</div> : <div className="product-grid">{visible.map((product) => <ProductCard key={product.id} product={product} onOpen={() => setSelected(product)} onAdd={(p) => { add(p, 1); toast(`${p.name} added to your basket.`); }} showSeller />)}</div>}
      </section>
    </main>
    {selected && <ProductSheet product={selected} quantity={qtyById.get(selected.id) ?? 0} close={() => setSelected(null)} adjust={(by) => { const q = (qtyById.get(selected.id) ?? 0) + by; setQty(selected.id, q); }} />}
  </>);
}

function ProductSheet({ product, quantity, close, adjust }: { product: P2Product; quantity: number; close: () => void; adjust: (by: number) => void }) {
  const reviews = useQuery({ queryKey: ["reviews", product.id], queryFn: () => api.getProductReviews({ product_id: product.id }) });
  return <div className="overlay" role="dialog" aria-modal="true" aria-label={`${product.name} details`}><div className="sheet"><button className="sheet-close" onClick={close} aria-label="Close product details">Close</button><ProductImage product={product} className="sheet-img" /><p className="eyebrow">{product.category}</p><h2>{product.name}</h2><p className="seller-line">Seller-provided profile · {product.store_name} · {product.store_location}</p><p>{product.description}</p><div className="detail-price"><strong>{money(product.price_paisa)}</strong><span>+ {money(product.delivery_fee_paisa)} delivery each</span></div><div className="quantity"><button onClick={() => adjust(-1)} disabled={quantity === 0} aria-label={`Remove one ${product.name}`}>−</button><span>{quantity}</span><button onClick={() => adjust(1)} disabled={quantity >= product.stock} aria-label={`Add one ${product.name}`}>+</button></div><p><button className="linklike" onClick={() => go(`/product/${product.id}`)}>Open the full product page →</button></p><section className="reviews"><h3>Verified buyers</h3>{reviews.data?.reviews.length ? reviews.data.reviews.map((review) => <article key={review.id}><b>{"★".repeat(review.rating)}</b><p>{review.body}</p><small>{review.reviewer_name} · {new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(review.created_at))}</small></article>) : <p className="muted">No delivered-buyer reviews yet.</p>}</section></div></div>;
}

// --- legacy guest COD checkout sheet (kept working) ---------------------------
function CheckoutSheet({ close, onPlaced }: { close: () => void; onPlaced: (code: string) => void }) {
  const { auth } = useAuth();
  const { lines, setQty, clear } = useCart();
  const [error, setError] = useState("");
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.getMe({}), enabled: auth?.type === "buyer", retry: false });
  const subtotal = lines.reduce((sum, line) => sum + line.product.price_paisa * line.quantity, 0);
  const delivery = lines.reduce((sum, line) => sum + line.product.delivery_fee_paisa * line.quantity, 0);
  const order = useMutation({
    mutationFn: api.placeOrder,
    onSuccess: (result) => { clear(); onPlaced(result.order_code); },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setError("");
    const data = new FormData(event.currentTarget);
    order.mutate({
      customer_name: String(data.get("name") ?? ""), phone: String(data.get("phone") ?? ""),
      address: String(data.get("address") ?? ""), note: String(data.get("note") ?? ""),
      cod_confirmed: true, payment_method: "cod", delivery_method: "standard", items: lines.map((l) => ({ product_id: l.product.id, quantity: l.quantity })),
    });
  };
  const buyerName = me.data?.user.name ?? "";
  const buyerPhone = me.data?.user.phone ?? "";
  return <div className="overlay" role="dialog" aria-modal="true" aria-label="Basket and checkout"><div className="sheet checkout"><button className="sheet-close" onClick={close} aria-label="Close basket">Close</button><p className="eyebrow">Your parcel</p><h2>Check every rupee</h2>{lines.length === 0 ? <div className="empty-mini"><p>Your basket is empty.</p><button onClick={close}>Keep shopping</button></div> : <><div className="cart-lines">{lines.map(({ product, quantity }) => <div className="cart-line" key={product.id}><div><b>{product.name}</b><small>{money(product.price_paisa)} each</small></div><div className="quantity small"><button onClick={() => setQty(product.id, quantity - 1)} aria-label={`Remove one ${product.name}`}>−</button><span>{quantity}</span><button onClick={() => setQty(product.id, quantity + 1)} disabled={quantity >= product.stock} aria-label={`Add one ${product.name}`}>+</button></div></div>)}</div><div className="receipt"><span>Items <b>{money(subtotal)}</b></span><span>Delivery <b>{money(delivery)}</b></span><span className="total">Due on delivery <b>{money(subtotal + delivery)}</b></span></div><form onSubmit={submit} className="stack-form" key={auth?.type === "buyer" ? `buyer-${buyerPhone}` : "guest"}><label>Your name<input name="name" required minLength={2} defaultValue={buyerName} /></label><label>Mobile number<input name="phone" type="tel" required minLength={7} defaultValue={buyerPhone} /></label><label>Delivery address<textarea name="address" required minLength={5} /></label><label>Note for seller <textarea name="note" /></label>{auth?.type === "buyer" ? <p className="muted">Signed in as {auth.name}. This order will appear under My orders.</p> : <p className="muted"><button type="button" className="linklike" onClick={() => { close(); go("/login"); }}>Log in</button> to link this order to an account, or check out as a guest.</p>}<div className="payment-choice"><b>Cash on delivery</b><p>No money is taken now. Your order stays “Needs confirmation” until the seller accepts it.</p></div><label className="check"><input type="checkbox" required /> I’ll respond when the seller confirms this COD order.</label>{error && <p className="form-error">{error}</p>}<button className="primary" disabled={order.isPending}>{order.isPending ? "Placing order…" : `Place COD order · ${money(subtotal + delivery)}`}</button></form><p className="muted">Prefer delivery choices, coupons or wallets? <button type="button" className="linklike" onClick={() => { close(); go("/checkout"); }}>Use the full checkout →</button></p></>}</div></div>;
}

// --- tracking (guest code+phone, extended statuses) ---------------------------
function TrackOrder({ invalidate }: { invalidate: () => void }) {
  const [credentials, setCredentials] = useState({ order_code: sessionStorage.getItem("lastOrderCode") ?? "", phone: "" });
  const [enabled, setEnabled] = useState(false);
  const track = useQuery({ queryKey: ["track", credentials], queryFn: () => api.trackOrder(credentials), enabled });
  const submit = (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); setEnabled(false); const data = new FormData(e.currentTarget); setCredentials({ order_code: String(data.get("code") ?? "").toUpperCase(), phone: String(data.get("phone") ?? "") }); setTimeout(() => setEnabled(true), 0); };
  return <main className="track-page"><section className="track-intro"><p className="eyebrow">No account needed</p><h1>Follow your parcel.</h1><p>Your order code and phone number reveal only your matching order.</p></section><form className="track-form" onSubmit={submit}><label>Order code<input name="code" defaultValue={credentials.order_code} placeholder="NP-…" required /></label><label>Mobile number<input name="phone" type="tel" required /></label><button className="primary">Find order</button></form>{track.isFetching && <p className="muted">Checking the order trail…</p>}{enabled && track.data?.order === null && <div className="empty-state"><h3>No matching order</h3><p>Check the code and mobile number exactly as entered at checkout.</p></div>}{track.data?.order && <OrderTrail order={toP2Order(track.data.order)} credentials={credentials} invalidate={() => { invalidate(); void track.refetch(); }} />}</main>;
}

function OrderTrail({ order, credentials, invalidate }: { order: ReturnType<typeof toP2Order>; credentials: { order_code: string; phone: string }; invalidate: () => void }) {
  const [message, setMessage] = useState("");
  const [showReturn, setShowReturn] = useState(false);
  const issue = useMutation({ mutationFn: api.reportIssue, onSuccess: () => { setMessage("Your issue is now in the seller’s queue."); invalidate(); } });
  const review = useMutation({ mutationFn: api.addReview, onSuccess: () => { setMessage("Your verified review is published."); invalidate(); } });
  const steps = ["confirmation_needed", "confirmed", "packed", "shipped", "out_for_delivery", "delivered"];
  const endStates = ["return_requested", "returned", "refunded", "cancelled"];
  const current = endStates.includes(order.status) ? steps.length : steps.indexOf(order.status);
  return <section className="order-trail"><div className="order-heading"><div><p className="eyebrow">{order.order_code}</p><h2>{STATUS_LABEL[order.status] ?? order.status}</h2></div><strong>{money(order.total_paisa)}</strong></div><div className="timeline">{steps.map((step, index) => <div className={index <= current && order.status !== "cancelled" ? "done" : ""} key={step}><span>{index + 1}</span><b>{STATUS_LABEL[step]}</b></div>)}</div>{endStates.includes(order.status) && order.status !== "cancelled" && <p className="banner warn" role="status">{STATUS_LABEL[order.status]}{order.status === "return_requested" ? " — the seller is reviewing your request." : order.status === "returned" ? " — the item is on its way back." : " — the refund has been issued."}</p>}<div className="order-items">{order.items.map((item) => <span key={item.id}>{item.quantity} × {item.product_name}<b>{money(item.quantity * item.unit_price_paisa)}</b></span>)}<span>Delivery<b>{money(order.delivery_fee_paisa)}</b></span>{order.discount_paisa > 0 && <span>Coupon {order.coupon_code}<b className="success">−{money(order.discount_paisa)}</b></span>}</div><p className="muted">Ordered {new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(order.created_at))} · {order.status === "cancelled" ? "No payment due" : order.payment_method === "cod" ? "Cash on delivery" : `${order.payment_method.toUpperCase()} · ${PAY_LABEL[order.payment_status]}`}{order.delivery_method !== "standard" ? ` · ${order.delivery_method} delivery` : ""}</p>
    {order.status === "delivered" && !showReturn && <button className="ghost" onClick={() => setShowReturn(true)}>Request return</button>}
    {order.status === "delivered" && showReturn && <ReturnRequestForm orderCode={order.order_code} phone={credentials.phone} onDone={() => { setShowReturn(false); invalidate(); }} />}
    {order.status === "delivered" && <details><summary>Write a verified review</summary><form className="stack-form compact" onSubmit={(e) => { e.preventDefault(); const d = new FormData(e.currentTarget); review.mutate({ ...credentials, product_id: Number(d.get("product")), rating: Number(d.get("rating")), body: String(d.get("body") ?? "") }); }}><label>Product<select name="product">{order.items.map((item) => <option value={item.product_id} key={item.id}>{item.product_name}</option>)}</select></label><label>Rating<select name="rating"><option value="5">5 — Excellent</option><option value="4">4 — Good</option><option value="3">3 — Okay</option><option value="2">2 — Poor</option><option value="1">1 — Bad</option></select></label><label>Review<textarea name="body" minLength={3} required /></label><button>Publish verified review</button></form></details>}<details><summary>Report a problem</summary><form className="stack-form compact" onSubmit={(e) => { e.preventDefault(); const d = new FormData(e.currentTarget); issue.mutate({ ...credentials, kind: String(d.get("kind") ?? ""), detail: String(d.get("detail") ?? "") }); }}><label>Issue<select name="kind"><option>Delivery delay</option><option>Wrong item</option><option>Damaged item</option><option>Refund request</option><option>Other</option></select></label><label>What happened?<textarea name="detail" minLength={8} required /></label><button>Send to seller</button></form></details>{message && <p className="success">{message}</p>}</section>;
}

// --- buyer accounts ----------------------------------------------------------
function BuyerLogin() {
  const { signIn } = useAuth();
  const login = useMutation({
    mutationFn: api.login,
    onSuccess: (result) => { signIn({ token: result.token, type: "buyer", name: result.user.name }); go("/account/orders"); },
  });
  return <main className="track-page"><section className="track-intro"><p className="eyebrow">Buyer account</p><h1>Welcome back.</h1><p>Log in to see your orders in one place and check out faster.</p></section>
    <form className="stack-form auth-form" onSubmit={(e) => { e.preventDefault(); const d = new FormData(e.currentTarget); login.mutate({ phone: String(d.get("phone") ?? ""), password: String(d.get("password") ?? "") }); }}>
      <label>Mobile number<input name="phone" type="tel" required minLength={7} autoComplete="tel" /></label>
      <label>Password<input name="password" type="password" required autoComplete="current-password" /></label>
      <FieldError error={login.error} />
      <button className="primary" disabled={login.isPending}>{login.isPending ? "Logging in…" : "Log in"}</button>
    </form>
    <p className="muted">New here? <button className="linklike" onClick={() => go("/signup")}>Create an account</button></p>
  </main>;
}

function BuyerSignup() {
  const { signIn } = useAuth();
  const signup = useMutation({
    mutationFn: api.signup,
    onSuccess: (result) => { signIn({ token: result.token, type: "buyer", name: result.user.name }); go("/"); },
  });
  return <main className="track-page"><section className="track-intro"><p className="eyebrow">Buyer account</p><h1>Join the market.</h1><p>One account for faster checkout and all your orders in one place.</p></section>
    <form className="stack-form auth-form" onSubmit={(e) => { e.preventDefault(); const d = new FormData(e.currentTarget); signup.mutate({ name: String(d.get("name") ?? ""), phone: String(d.get("phone") ?? ""), email: String(d.get("email") ?? "") || undefined, password: String(d.get("password") ?? "") }); }}>
      <label>Your name<input name="name" required minLength={2} autoComplete="name" /></label>
      <label>Mobile number<input name="phone" type="tel" required minLength={7} autoComplete="tel" /></label>
      <label>Email (optional)<input name="email" type="email" autoComplete="email" /></label>
      <label>Password<input name="password" type="password" required minLength={6} autoComplete="new-password" /><small>At least 6 characters.</small></label>
      <FieldError error={signup.error} />
      <button className="primary" disabled={signup.isPending}>{signup.isPending ? "Creating account…" : "Create account"}</button>
    </form>
    <p className="muted">Already have an account? <button className="linklike" onClick={() => go("/login")}>Log in</button></p>
  </main>;
}

function MyOrders() {
  const { auth } = useAuth();
  const ordersQuery = useQuery({ queryKey: ["my-orders"], queryFn: () => api.getMyOrders({}), enabled: auth?.type === "buyer" });
  const queryClient = useQueryClient();
  const refresh = () => { void queryClient.invalidateQueries({ queryKey: ["my-orders"] }); void queryClient.invalidateQueries({ queryKey: ["storefront"] }); };
  return <main className="track-page"><section className="track-intro"><p className="eyebrow">{auth?.name}</p><h1>My orders.</h1><p>Every order you placed while signed in lives here.</p></section>
    {ordersQuery.isPending && <p className="muted">Loading your orders…</p>}
    <FieldError error={ordersQuery.error} />
    {ordersQuery.data && ordersQuery.data.orders.length === 0 && <div className="empty-state"><h3>No orders yet</h3><p>Your signed-in orders will appear here. Guest orders can still be tracked with the order code.</p><button className="primary" onClick={() => go("/")}>Start shopping</button></div>}
    {ordersQuery.data?.orders.map((order) => <OrderTrail key={order.id} order={toP2Order(order)} credentials={{ order_code: order.order_code, phone: order.phone }} invalidate={refresh} />)}
  </main>;
}

// --- sellers ------------------------------------------------------------------
function SellerLogin() {
  const { signIn, auth } = useAuth();
  const [mode, setMode] = useState<"email" | "code" | "register">("email");
  const [createdCode, setCreatedCode] = useState("");
  useEffect(() => { if (auth?.type === "seller" || getLegacySeller()) go("/seller"); }, [auth]);
  const emailLogin = useMutation({
    mutationFn: api.sellerLogin,
    onSuccess: (result) => { signIn({ token: result.token, type: "seller", name: result.seller.store_name }); go("/seller"); },
  });
  const codeLogin = useMutation({
    mutationFn: (vars: { seller_code: string; seller_key: string }) => api.sellerInventory(vars),
    onSuccess: (_data, vars) => { setLegacySeller(vars); go("/seller"); },
  });
  const register = useMutation({ mutationFn: api.registerSeller, onSuccess: (result) => setCreatedCode(result.seller_code) });
  const submitEmail = (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); const d = new FormData(e.currentTarget); emailLogin.mutate({ email: String(d.get("email") ?? ""), password: String(d.get("password") ?? "") }); };
  const submitCode = (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); const d = new FormData(e.currentTarget); codeLogin.mutate({ seller_code: String(d.get("code") ?? "").toUpperCase(), seller_key: String(d.get("key") ?? "") }); };
  const submitRegister = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault(); const d = new FormData(e.currentTarget);
    register.mutate({
      store_name: String(d.get("store") ?? ""), tagline: String(d.get("tagline") ?? ""), location: String(d.get("location") ?? ""),
      phone: String(d.get("phone") ?? ""), email: String(d.get("email") ?? ""), password: String(d.get("password") ?? ""), seller_key: String(d.get("key") ?? ""),
    });
  };
  return <main className="track-page"><section className="track-intro"><p className="eyebrow">Private seller workspace</p><h1>Enter your shop.</h1><p>Each seller has a separate sign-in, so one shop can never open another shop’s customer orders.</p></section>
    <div className="category-list" role="tablist" aria-label="Seller sign-in methods">
      <button className={mode === "email" ? "selected" : ""} onClick={() => setMode("email")}>Email + password</button>
      <button className={mode === "code" ? "selected" : ""} onClick={() => setMode("code")}>Seller code + key</button>
      <button className={mode === "register" ? "selected" : ""} onClick={() => setMode("register")}>New seller</button>
    </div>
    {mode === "email" && <form className="stack-form auth-form" onSubmit={submitEmail}>
      <label>Email<input name="email" type="email" required autoComplete="email" /></label>
      <label>Password<input name="password" type="password" required autoComplete="current-password" /></label>
      <FieldError error={emailLogin.error} />
      <button className="primary" disabled={emailLogin.isPending}>{emailLogin.isPending ? "Signing in…" : "Sign in"}</button>
    </form>}
    {mode === "code" && <form className="stack-form auth-form" onSubmit={submitCode}>
      <label>Seller code<input name="code" placeholder="SELL-…" required autoComplete="username" /></label>
      <label>Private access key<input name="key" type="password" minLength={8} required autoComplete="current-password" /></label>
      <FieldError error={codeLogin.error} />
      <button className="primary" disabled={codeLogin.isPending}>{codeLogin.isPending ? "Unlocking…" : "Unlock studio"}</button>
      <p className="muted">The original code + key sign-in keeps working for existing sellers.</p>
    </form>}
    {mode === "register" && (createdCode ? <div className="empty-state"><span>SHOP CREATED</span><h3>Save your seller code</h3><p className="seller-code-big">{createdCode}</p><p>Your shop is waiting for admin approval. You can sign in and add products now; they appear in the shop once approved.</p><button className="primary" onClick={() => { setMode("email"); setCreatedCode(""); }}>Continue to sign in</button></div> :
      <form className="stack-form auth-form" onSubmit={submitRegister}>
        <label>Store name<input name="store" required minLength={2} /></label>
        <label>Short promise<input name="tagline" required minLength={3} /></label>
        <label>Location<input name="location" required minLength={2} /></label>
        <label>Public contact<input name="phone" type="tel" required minLength={7} /></label>
        <label>Email<input name="email" type="email" required autoComplete="email" /><small>Used for sign-in and admin contact.</small></label>
        <label>Password<input name="password" type="password" required minLength={6} autoComplete="new-password" /><small>At least 6 characters.</small></label>
        <label>Private access key<input name="key" type="password" minLength={8} required /><small>At least 8 characters. The old code + key sign-in also works with this.</small></label>
        <FieldError error={register.error} />
        <button className="primary" disabled={register.isPending}>{register.isPending ? "Creating…" : "Create seller account"}</button>
      </form>)}
  </main>;
}

type StudioTab = "inventory" | "orders" | "returns" | "issues" | "analytics" | "settings";
function Studio({ invalidate }: { invalidate: () => void }) {
  const { auth, signOut } = useAuth();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<StudioTab>("inventory");
  const [legacy, setLegacyState] = useState<LegacySeller | null>(() => getLegacySeller());
  const [editing, setEditing] = useState<P2Product | null>(null);
  const [notice, setNotice] = useState("");
  const creds: LegacySeller = auth?.type === "seller" ? { seller_code: "", seller_key: "" } : legacy ?? { seller_code: "", seller_key: "" };
  const tokenAuth = auth?.type === "seller";
  const callArgs: { authToken?: string; seller_code?: string; seller_key?: string } = tokenAuth ? {} : creds;
  const authed = tokenAuth || !!(legacy?.seller_code && legacy?.seller_key);

  const inventory = useQuery({ queryKey: ["seller-inventory", tokenAuth ? "token" : legacy?.seller_code], queryFn: () => api.sellerInventory(callArgs), enabled: authed, retry: false });
  const orders = useQuery({ queryKey: ["orders", tokenAuth ? "token" : legacy?.seller_code], queryFn: () => api.listOrders({ ...callArgs, limit: 100 }), enabled: inventory.isSuccess, retry: false });
  const issues = useQuery({ queryKey: ["issues", tokenAuth ? "token" : legacy?.seller_code], queryFn: () => api.listIssues(callArgs), enabled: inventory.isSuccess, retry: false });
  const privateRefresh = () => { invalidate(); void queryClient.invalidateQueries({ queryKey: ["seller-inventory"] }); void queryClient.invalidateQueries({ queryKey: ["orders"] }); void queryClient.invalidateQueries({ queryKey: ["issues"] }); void queryClient.invalidateQueries({ queryKey: ["seller-returns"] }); void queryClient.invalidateQueries({ queryKey: ["seller-analytics"] }); };
  const saveStore = useMutation({ mutationFn: api.saveStore, onSuccess: () => { setNotice("Store details saved."); privateRefresh(); } });
  const create = useMutation({
    mutationFn: (v: Parameters<typeof api.createProduct>[0]) => api.createProduct(v),
    onSuccess: () => { setNotice("Product published."); privateRefresh(); },
  });
  const update = useMutation({
    mutationFn: (v: Parameters<typeof api.updateProduct>[0]) => api.updateProduct(v),
    onSuccess: () => { setNotice("Product updated."); setEditing(null); privateRefresh(); },
  });
  const updateOrder = useMutation({ mutationFn: api.updateOrderStatus, onSuccess: privateRefresh });
  const resolve = useMutation({ mutationFn: api.resolveIssue, onSuccess: privateRefresh });
  const products: P2Product[] = useMemo(() => (inventory.data?.products ?? []).map((p) => ({ ...(p as unknown as P2Product), brand: (p as Record<string, unknown>).brand as string | null ?? null, original_price_paisa: null, discount_pct: 0, image_url: (p as Record<string, unknown>).image_url as string | null ?? null, low_stock: false })), [inventory.data]);
  const orderRows = orders.data?.orders ?? [];
  const issueRows = issues.data?.issues ?? [];
  const store = inventory.data?.store ?? null;
  const lockStudio = () => { if (tokenAuth) signOut(); else { clearLegacySeller(); setLegacyState(null); go("/seller/login"); } };
  const saveProduct = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault(); const d = new FormData(e.currentTarget);
    const extra = productExtraPayload(d);
    const payload = {
      ...callArgs,
      name: String(d.get("name") ?? ""), category: String(d.get("category") ?? ""), description: String(d.get("description") ?? ""),
      price_paisa: Math.round(Number(d.get("price")) * 100), delivery_fee_paisa: Math.round(Number(d.get("delivery")) * 100), stock: Number(d.get("stock")),
      ...extra,
    };
    if (editing) update.mutate({ ...payload, id: editing.id, is_active: d.get("active") === "on" });
    else create.mutate(payload);
  };
  const tabs: { id: StudioTab; label: string }[] = [
    { id: "inventory", label: "Inventory" }, { id: "orders", label: "Orders" }, { id: "returns", label: "Returns" },
    { id: "issues", label: "Issues" }, { id: "analytics", label: "Analytics" }, { id: "settings", label: "Settings" },
  ];
  if (inventory.error) return <main className="studio-page"><section className="studio-intro"><p className="eyebrow">Session problem</p><h1>That sign-in didn’t work.</h1><p>Please sign in again.</p><button className="primary" onClick={lockStudio}>Back to sign in</button></section></main>;
  if (inventory.isPending) return <main className="studio-page"><p className="muted">Unlocking the studio…</p></main>;
  return <main className="studio-page"><section className="studio-intro"><p className="eyebrow">{tokenAuth ? "Signed in" : creds.seller_code}</p><h1>Run the counter.</h1><p>Publish real inventory, confirm COD orders, and resolve buyer issues from one protected place.</p><button className="switch-mode" onClick={lockStudio}>Lock studio</button></section>
    {notice && <p className="success banner">{notice}</p>}
    {store?.status === "pending" && <p className="banner warn" role="status">Your shop is waiting for admin approval. You can add products now, but they will only appear in the shop after approval.</p>}
    {store?.status === "suspended" && <p className="banner danger" role="status">This shop is suspended and hidden from buyers. Please contact support.</p>}
    <div className="category-list" role="tablist" aria-label="Studio sections">{tabs.map((t) => <button key={t.id} className={tab === t.id ? "selected" : ""} onClick={() => setTab(t.id)}>{t.label}</button>)}</div>

    {tab === "inventory" && <div className="studio-layout">
      <section className="studio-section"><div className="section-title"><h2>{editing ? "Edit product" : "New product"}</h2>{editing && <button onClick={() => setEditing(null)}>Cancel edit</button>}</div><form className="stack-form" key={editing?.id ?? "new"} onSubmit={saveProduct}><label>Product name<input name="name" defaultValue={editing?.name} required /></label><div className="form-pair"><label>Category<input name="category" defaultValue={editing?.category} required /></label><label>Stock<input name="stock" type="number" min="0" defaultValue={editing?.stock ?? 1} required /></label></div><label>Description<textarea name="description" defaultValue={editing?.description} minLength={8} required /></label><div className="form-pair"><label>Price, rupees<input name="price" type="number" min="0.01" step="0.01" defaultValue={editing ? editing.price_paisa / 100 : ""} required /></label><label>Delivery, rupees<input name="delivery" type="number" min="0" step="0.01" defaultValue={editing ? editing.delivery_fee_paisa / 100 : 0} required /></label></div><ProductExtraFields editing={editing} />{editing && <label className="check"><input name="active" type="checkbox" defaultChecked={editing.is_active} /> Visible in shop</label>}<button className="primary" disabled={create.isPending || update.isPending}>{editing ? "Save product" : "Publish product"}</button></form><div className="product-admin">{products.map((p) => <button key={p.id} onClick={() => setEditing(p)}><span><b>{p.name}</b><small>{p.is_active ? `${p.stock} in stock` : "Hidden"}</small></span><strong>{money(p.price_paisa)}</strong></button>)}</div></section>
    </div>}

    {tab === "orders" && <section className="studio-section wide"><div className="section-title"><h2>Orders</h2><span>{orderRows.length}</span></div>{orders.isPending ? <p className="muted">Loading orders…</p> : orderRows.length === 0 ? <p className="muted">New COD orders for this shop will arrive here.</p> : <div className="order-admin">{orderRows.map((order) => <article key={order.id}><div><p className="eyebrow">{order.order_code} · {new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(order.created_at))}</p><h3>{order.customer_name}</h3><p>{order.items.map((i) => `${i.quantity} × ${i.product_name}`).join(", ")}</p><small>{order.address} · {order.phone}</small></div><div className="order-actions"><b>{money(order.total_paisa)}</b><span className={`status ${order.status}`}>{STATUS_LABEL[order.status] ?? order.status}</span>{nextStatus[order.status] && <button onClick={() => updateOrder.mutate({ ...callArgs, order_id: order.id, status: nextStatus[order.status] ?? order.status })}>Mark {(STATUS_LABEL[nextStatus[order.status] ?? order.status] ?? "").toLowerCase()}</button>}{order.status === "confirmation_needed" && <button className="text-danger" onClick={() => updateOrder.mutate({ ...callArgs, order_id: order.id, status: "cancelled" })}>Decline</button>}</div></article>)}</div>}</section>}

    {tab === "returns" && <section className="studio-section wide"><div className="section-title"><h2>Returns</h2></div><SellerReturns callArgs={callArgs} /></section>}

    {tab === "issues" && <section className="studio-section wide"><div className="section-title"><h2>Buyer issues</h2><span>{issueRows.filter((i) => i.status === "open").length} open</span></div>{issues.isPending ? <p className="muted">Loading issues…</p> : issueRows.length === 0 ? <p className="muted">No buyer issues reported for this shop.</p> : <div className="issues">{issueRows.map((item) => <article key={item.id}><div><p className="eyebrow">{item.order_code} · {item.kind}</p><p>{item.detail}</p><small>{new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(item.created_at))}</small></div>{item.status === "open" ? <button onClick={() => resolve.mutate({ ...callArgs, issue_id: item.id })}>Mark resolved</button> : <span className="success">Resolved</span>}</article>)}</div>}</section>}

    {tab === "analytics" && <SellerAnalytics callArgs={callArgs} />}

    {tab === "settings" && <section className="studio-section"><h2>Store identity</h2><form className="stack-form" onSubmit={(e) => { e.preventDefault(); const d = new FormData(e.currentTarget); saveStore.mutate({ ...callArgs, store_name: String(d.get("store") ?? ""), tagline: String(d.get("tagline") ?? ""), location: String(d.get("location") ?? ""), phone: String(d.get("phone") ?? "") }); }}><label>Store name<input name="store" defaultValue={store?.store_name} required /></label><label>Short promise<input name="tagline" defaultValue={store?.tagline} required /></label><label>Location<input name="location" defaultValue={store?.location} required /></label><label>Public contact<input name="phone" defaultValue={store?.phone} required /></label><button className="primary">Save store</button></form></section>}
  </main>;
}

// --- admin ------------------------------------------------------------------
function AdminLogin() {
  const { signIn, auth } = useAuth();
  useEffect(() => { if (auth?.type === "admin") go("/admin"); }, [auth]);
  const login = useMutation({
    mutationFn: api.adminLogin,
    onSuccess: (result) => { signIn({ token: result.token, type: "admin", name: result.admin.name }); go("/admin"); },
  });
  return <main className="track-page"><section className="track-intro"><p className="eyebrow">Restricted area</p><h1>Admin sign in.</h1><p>Marketplace controls: sellers, products, orders, issues and buyers.</p></section>
    <form className="stack-form auth-form" onSubmit={(e) => { e.preventDefault(); const d = new FormData(e.currentTarget); login.mutate({ email: String(d.get("email") ?? ""), password: String(d.get("password") ?? "") }); }}>
      <label>Email<input name="email" type="email" required autoComplete="email" /></label>
      <label>Password<input name="password" type="password" required autoComplete="current-password" /></label>
      <FieldError error={login.error} />
      <button className="primary" disabled={login.isPending}>{login.isPending ? "Signing in…" : "Sign in"}</button>
    </form>
  </main>;
}

type AdminTab = "overview" | "sellers" | "products" | "orders" | "issues" | "buyers" | "coupons" | "categories" | "homepage" | "analytics" | "tickets";
function AdminPanel() {
  const [tab, setTab] = useState<AdminTab>("overview");
  const tabs: { id: AdminTab; label: string }[] = [
    { id: "overview", label: "Overview" }, { id: "sellers", label: "Sellers" },
    { id: "products", label: "Products" }, { id: "orders", label: "Orders" },
    { id: "issues", label: "Issues" }, { id: "buyers", label: "Buyers" },
    { id: "coupons", label: "Coupons" }, { id: "categories", label: "Categories" },
    { id: "homepage", label: "Homepage" }, { id: "analytics", label: "Analytics" },
    { id: "tickets", label: "Tickets" },
  ];
  return <main className="studio-page"><section className="studio-intro"><p className="eyebrow">Marketplace control</p><h1>Admin panel.</h1><p>Approve sellers, curate products, and watch orders across the whole market.</p></section>
    <div className="category-list" role="tablist" aria-label="Admin sections">{tabs.map((t) => <button key={t.id} className={tab === t.id ? "selected" : ""} onClick={() => setTab(t.id)}>{t.label}</button>)}</div>
    {tab === "overview" && <AdminOverview />}
    {tab === "sellers" && <AdminSellers />}
    {tab === "products" && <AdminProducts />}
    {tab === "orders" && <AdminOrders />}
    {tab === "issues" && <AdminIssues />}
    {tab === "buyers" && <AdminBuyers />}
    {tab === "coupons" && <AdminCoupons />}
    {tab === "categories" && <AdminCategories />}
    {tab === "homepage" && <AdminHomepage />}
    {tab === "analytics" && <AdminAnalytics />}
    {tab === "tickets" && <AdminTickets />}
  </main>;
}

function AdminOverview() {
  const stats = useQuery({ queryKey: ["admin-stats"], queryFn: () => api.adminStats({}) });
  const [message, setMessage] = useState("");
  const changePw = useMutation({
    mutationFn: api.adminChangePassword,
    onSuccess: () => setMessage("Password changed."),
    onError: () => setMessage(""),
  });
  const s = stats.data;
  return <div className="studio-layout">
    <section className="studio-section wide"><div className="section-title"><h2>Marketplace at a glance</h2></div>
      {stats.isPending && <p className="muted">Loading numbers…</p>}
      <FieldError error={stats.error} />
      {s && <div className="stat-grid">
        <div><b>{s.sellers}</b><span>Sellers</span></div>
        <div><b>{s.products}</b><span>Products</span></div>
        <div><b>{s.orders}</b><span>Orders</span></div>
        <div><b>{s.users}</b><span>Buyers</span></div>
        <div><b>{money(s.revenue_paisa)}</b><span>Order value</span></div>
        <div className={s.pending_sellers ? "alert" : ""}><b>{s.pending_sellers}</b><span>Sellers waiting</span></div>
        <div className={s.open_issues ? "alert" : ""}><b>{s.open_issues}</b><span>Open issues</span></div>
      </div>}
    </section>
    <section className="studio-section"><h2>Change admin password</h2>
      <form className="stack-form" onSubmit={(e) => { e.preventDefault(); const d = new FormData(e.currentTarget); changePw.mutate({ old_password: String(d.get("old") ?? ""), new_password: String(d.get("new") ?? "") }); (e.currentTarget as HTMLFormElement).reset(); }}>
        <label>Current password<input name="old" type="password" required autoComplete="current-password" /></label>
        <label>New password<input name="new" type="password" required minLength={6} autoComplete="new-password" /></label>
        <FieldError error={changePw.error} />
        {message && !changePw.error && <p className="success">{message}</p>}
        <button className="primary" disabled={changePw.isPending}>Change password</button>
      </form>
    </section>
  </div>;
}

function AdminSellers() {
  const queryClient = useQueryClient();
  const sellers = useQuery({ queryKey: ["admin-sellers"], queryFn: () => api.adminListSellers({}) });
  const setStatus = useMutation({ mutationFn: api.adminSetSellerStatus, onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["admin-sellers"] }); void queryClient.invalidateQueries({ queryKey: ["admin-stats"] }); void queryClient.invalidateQueries({ queryKey: ["storefront"] }); } });
  const rows: AdminSeller[] = sellers.data?.sellers ?? [];
  return <section className="studio-section wide"><div className="section-title"><h2>Sellers</h2><span>{rows.length}</span></div>
    {sellers.isPending && <p className="muted">Loading sellers…</p>}
    <FieldError error={sellers.error} />
    <div className="admin-table">{rows.map((seller) => <article key={seller.id}>
      <div><h3>{seller.store_name}</h3><p className="muted">{seller.seller_code} · {seller.location} · {seller.phone}</p><p className="muted">{seller.email ?? "No email"} · {seller.product_count} products · {seller.order_count} orders</p><small>Joined {new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(seller.created_at))}</small></div>
      <div className="order-actions"><span className={`status status-${seller.status}`}>{sellerStatusLabel[seller.status]}</span>
        <label className="muted">Status <select value={seller.status} disabled={setStatus.isPending} onChange={(e) => setStatus.mutate({ seller_id: seller.id, status: e.target.value as AdminSeller["status"] })}>
          <option value="pending">Waiting for approval</option><option value="active">Active</option><option value="suspended">Suspended</option>
        </select></label>
      </div>
    </article>)}</div>
    <FieldError error={setStatus.error} />
  </section>;
}

function AdminProducts() {
  const queryClient = useQueryClient();
  const products = useQuery({ queryKey: ["admin-products"], queryFn: () => api.adminListProducts({}) });
  const toggle = useMutation({ mutationFn: api.adminSetProductActive, onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["admin-products"] }); void queryClient.invalidateQueries({ queryKey: ["storefront"] }); } });
  const rows: AdminProduct[] = products.data?.products ?? [];
  return <section className="studio-section wide"><div className="section-title"><h2>Products</h2><span>{rows.length}</span></div>
    {products.isPending && <p className="muted">Loading products…</p>}
    <FieldError error={products.error} />
    <div className="admin-table">{rows.map((p) => <article key={p.id}>
      <div><h3>{p.name}</h3><p className="muted">{p.category} · {p.store_name} ({p.seller_code}) · seller {sellerStatusLabel[p.seller_status]}</p><p><b>{money(p.price_paisa)}</b> · {p.stock} in stock</p></div>
      <div className="order-actions"><span className={`status ${p.is_active ? "confirmed" : "cancelled"}`}>{p.is_active ? "Visible" : "Hidden"}</span>
        <button disabled={toggle.isPending} onClick={() => toggle.mutate({ product_id: p.id, active: !p.is_active })}>{p.is_active ? "Hide" : "Show"}</button>
      </div>
    </article>)}</div>
    <FieldError error={toggle.error} />
  </section>;
}

function AdminOrders() {
  const [filter, setFilter] = useState<string>("all");
  const orders = useQuery({ queryKey: ["admin-orders", filter], queryFn: () => api.adminListOrders(filter === "all" ? {} : { status: filter as AdminOrder["status"] }) });
  const rows: AdminOrder[] = orders.data?.orders ?? [];
  return <section className="studio-section wide"><div className="section-title"><h2>Orders</h2><span>{rows.length}</span>
    <label className="muted">Status <select value={filter} onChange={(e) => setFilter(e.target.value)}>
      <option value="all">All</option><option value="confirmation_needed">Needs confirmation</option><option value="confirmed">Confirmed</option><option value="packed">Packed</option><option value="shipped">On the way</option><option value="out_for_delivery">Out for delivery</option><option value="delivered">Delivered</option><option value="return_requested">Return requested</option><option value="returned">Returned</option><option value="refunded">Refunded</option><option value="cancelled">Cancelled</option>
    </select></label></div>
    {orders.isPending && <p className="muted">Loading orders…</p>}
    <FieldError error={orders.error} />
    <div className="admin-table">{rows.map((order) => <article key={order.id}>
      <div><p className="eyebrow">{order.order_code} · {order.store_name}</p><h3>{order.customer_name} · {order.phone}</h3><p>{order.items.map((i) => `${i.quantity} × ${i.product_name}`).join(", ")}</p><small>{new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(order.created_at))}</small></div>
      <div className="order-actions"><b>{money(order.total_paisa)}</b><span className={`status ${order.status}`}>{STATUS_LABEL[order.status] ?? order.status}</span></div>
    </article>)}</div>
  </section>;
}

function AdminIssues() {
  const queryClient = useQueryClient();
  const issues = useQuery({ queryKey: ["admin-issues"], queryFn: () => api.adminListIssues({}) });
  const resolve = useMutation({ mutationFn: api.adminResolveIssue, onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["admin-issues"] }); void queryClient.invalidateQueries({ queryKey: ["admin-stats"] }); } });
  const rows: AdminIssue[] = issues.data?.issues ?? [];
  return <section className="studio-section wide"><div className="section-title"><h2>Buyer issues</h2><span>{rows.filter((i) => i.status === "open").length} open</span></div>
    {issues.isPending && <p className="muted">Loading issues…</p>}
    <FieldError error={issues.error} />
    {rows.length === 0 && !issues.isPending && <p className="muted">No buyer issues reported.</p>}
    <div className="issues">{rows.map((item) => <article key={item.id}>
      <div><p className="eyebrow">{item.order_code} · {item.store_name} · {item.kind}</p><p>{item.detail}</p><small>{new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(item.created_at))}</small></div>
      {item.status === "open" ? <button disabled={resolve.isPending} onClick={() => resolve.mutate({ issue_id: item.id })}>Mark resolved</button> : <span className="success">Resolved</span>}
    </article>)}</div>
    <FieldError error={resolve.error} />
  </section>;
}

function AdminBuyers() {
  const buyers = useQuery({ queryKey: ["admin-buyers"], queryFn: () => api.adminListUsers({}) });
  const rows: AdminUser[] = buyers.data?.users ?? [];
  return <section className="studio-section wide"><div className="section-title"><h2>Buyers</h2><span>{rows.length}</span></div>
    {buyers.isPending && <p className="muted">Loading buyers…</p>}
    <FieldError error={buyers.error} />
    {rows.length === 0 && !buyers.isPending && <p className="muted">No buyer accounts yet.</p>}
    <div className="admin-table">{rows.map((u) => <article key={u.id}>
      <div><h3>{u.name}</h3><p className="muted">{u.phone}{u.email ? ` · ${u.email}` : ""}</p><small>Joined {new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(u.created_at))}</small></div>
      <div className="order-actions"><b>{u.order_count}</b><span className="muted">orders</span></div>
    </article>)}</div>
  </section>;
}
