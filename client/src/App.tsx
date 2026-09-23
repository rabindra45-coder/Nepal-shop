// Nepal Shop — client shell. Phase-2 build: the v2 screens keep working
// untouched in behaviour; new routes/screens are added alongside.
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, clearAuth, clearLegacySeller, getAuth, getLegacySeller, setAuth, setLegacySeller, type ApiResponse, type AuthInfo, type LegacySeller } from "./api";
import { api2, money, toP2Order, toP2OrderGroup, type P2Product } from "./phase2api";
import { AuthContext, go, useAuth, useRoute } from "./session";
import { CartProvider, clearGuestCart, readGuestCart, useCart } from "./cart";
import { ToastProvider, useToast, ProductCard, ProductImage } from "./ui";
import heroArt from "./assets/hero-parcel-exchange.webp";
import {
  AssistantPage, CartPage, ChangePasswordForm, CheckoutPage, ComparePage, Homepage, PaymentResultPage,
  ProductPage, SearchPage, StorePage, WishlistPage, STATUS_LABEL,
} from "./screens";
import { AccountShell, Drawer, FieldError, GroupTrail, HelpPage, NotificationsPage, OrderTrail, useBuyerAvatar, useUnreadCount } from "./account";
import { AboutPage, ContactPage, CookiePolicyPage, PrivacyPage, RefundPolicyPage, ReturnPolicyPage, SellerTermsPage, ShippingPolicyPage, TermsPage, NotFoundPage, CookieBanner } from "./legal";
import { InvoicePage } from "./invoice";
import { ProductExtraFields, SellerAnalytics, SellerCsvImport, SellerEarnings, SellerQuestions, SellerReturns, SellerStatusBanners, ShipmentForm, SpecManager, StockHistory, StudioSellerSettings, VariantManager, productExtraPayload } from "./studio2";
import { AdminAnalytics, AdminAuditLog, AdminCategories, AdminCoupons, AdminEmail, AdminHomepage, AdminPayments, AdminRefunds, AdminReturns, AdminReviewReports, AdminShippingSettings, AdminShell, AdminTickets } from "./admin2";

type Order = ApiResponse<typeof api, "listOrders">["orders"][number];
type AdminSeller = ApiResponse<typeof api, "adminListSellers">["sellers"][number];
type AdminProduct = ApiResponse<typeof api, "adminListProducts">["products"][number];
type AdminOrder = ApiResponse<typeof api, "adminListOrders">["orders"][number];
type AdminIssue = ApiResponse<typeof api, "adminListIssues">["issues"][number];
type AdminUser = ApiResponse<typeof api, "adminListUsers">["users"][number];

const nextStatus: Partial<Record<Order["status"], Order["status"]>> = {
  confirmation_needed: "confirmed", confirmed: "packed", packed: "shipped",
  shipped: "out_for_delivery", out_for_delivery: "delivered",
  delivery_failed: "out_for_delivery",
};
const sellerStatusLabel: Record<AdminSeller["status"], string> = { pending: "Waiting for email verification", under_review: "Under review", active: "Active", suspended: "Suspended", rejected: "Not approved" };

async function mergeGuestCartOnLogin() {
  try {
    const guest = readGuestCart();
    const items = Object.entries(guest).flatMap(([key, entry]) => {
      const [idStr, varStr] = key.split(":");
      const quantity = entry.quantity;
      if (!quantity || quantity <= 0) return [];
      return [{ product_id: Number(idStr), quantity, variant_id: Number(varStr ?? 0) || 0 }];
    });
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

  // Unique page titles + meta descriptions for SEO, and robots noindex on
  // private/utility routes (product pages set their own title/description).
  useEffect(() => {
    const titles: Record<string, string> = {
      "/": "Nepal Shop — Local Marketplace",
      "/shop": "Shop all products — Nepal Shop",
      "/search": "Search products — Nepal Shop",
      "/cart": "Your basket — Nepal Shop",
      "/checkout": "Checkout — Nepal Shop",
      "/track": "Track your order — Nepal Shop",
      "/login": "Log in — Nepal Shop",
      "/signup": "Create an account — Nepal Shop",
      "/account": "My account — Nepal Shop",
      "/account/orders": "My orders — Nepal Shop",
      "/account/addresses": "My addresses — Nepal Shop",
      "/wishlist": "Wishlist — Nepal Shop",
      "/compare": "Compare products — Nepal Shop",
      "/assistant": "Shopping assistant — Nepal Shop",
      "/notifications": "Notifications — Nepal Shop",
      "/help": "Help centre — Nepal Shop",
      "/about": "About — Nepal Shop",
      "/contact": "Contact us — Nepal Shop",
      "/privacy": "Privacy policy — Nepal Shop",
      "/terms": "Terms and conditions — Nepal Shop",
      "/refund": "Refund policy — Nepal Shop",
      "/returns": "Return policy — Nepal Shop",
      "/shipping": "Shipping policy — Nepal Shop",
      "/seller-terms": "Seller terms — Nepal Shop",
      "/cookies": "Cookie policy — Nepal Shop",
      "/invoice": "Invoice — Nepal Shop",
      "/seller": "Seller studio — Nepal Shop",
      "/seller/login": "Seller log in — Nepal Shop",
      "/admin": "Admin panel — Nepal Shop",
      "/admin/login": "Admin log in — Nepal Shop",
    };
    const descriptions: Record<string, string> = {
      "/": "Shop from verified local sellers across Nepal — transparent prices in NPR, eSewa/Khalti and cash on delivery, and 30-day returns.",
      "/shop": "Browse every product from verified Nepali sellers in one place.",
      "/search": "Search local Nepali products by name, brand or category.",
      "/track": "Track your Nepal Shop order with your order code and phone number.",
      "/help": "Delivery, payments, returns and buyer protection — Nepal Shop help centre.",
      "/about": "Nepal Shop is a local multi-vendor marketplace: shop local, know who packed it.",
      "/contact": "Contact Nepal Shop support for help with orders, sellers and payments.",
      "/privacy": "Nepal Shop privacy policy — how we handle your data.",
      "/terms": "Nepal Shop terms and conditions for buyers and sellers.",
      "/refund": "How Nepal Shop refunds work — timelines, eSewa/Khalti and COD.",
      "/returns": "30-day returns on Nepal Shop — how to request one.",
      "/shipping": "Delivery options, times and costs across Nepal.",
      "/seller-terms": "Rules for selling on Nepal Shop — verification, fees and fulfilment.",
      "/cookies": "Nepal Shop cookie policy — what we store and why.",
    };
    // Private dashboards, baskets and auth pages must never appear in search results.
    const noindex = path.startsWith("/admin") || path.startsWith("/seller") || path.startsWith("/account")
      || path.startsWith("/invoice")
      || ["/cart", "/checkout", "/wishlist", "/notifications", "/login", "/signup", "/compare", "/assistant"].includes(path);
    const setMeta = (name: string, content: string | null) => {
      let el = document.querySelector(`meta[name="${name}"]`) as HTMLMetaElement | null;
      if (content === null) { el?.remove(); return; }
      if (!el) { el = document.createElement("meta"); el.name = name; document.head.appendChild(el); }
      el.content = content;
    };
    document.title = titles[path] ?? (path.startsWith("/invoice/") ? "Invoice — Nepal Shop"
      : path.startsWith("/product/") || path.startsWith("/store/") ? document.title : "Nepal Shop — Local Marketplace");
    if (descriptions[path] && !path.startsWith("/product/") && !path.startsWith("/store/")) setMeta("description", descriptions[path]);
    setMeta("robots", noindex ? "noindex, nofollow" : null);
  }, [path]);

  return (
    <AuthContext.Provider value={{ auth, signIn, signOut }}>
      <CartProvider auth={auth}>
        <ToastProvider>
          <div className="app-shell">
            <a className="skip-link" href="#main-content">Skip to content</a>
            <SafeAreaTopScrim backgroundColor="var(--bg)" />
            <SiteHeader path={path} />
            <div id="main-content"><RouteView path={path} query={query} invalidate={invalidate} /></div>
            <footer className="site-footer">
              <img className="footer-wordmark" src="/wordmark.png" alt="NepalShop" />
              <nav>
                <button className="linklike" onClick={() => go("/about")}>About</button>
                <button className="linklike" onClick={() => go("/contact")}>Contact</button>
                <button className="linklike" onClick={() => go("/help")}>Help</button>
                <button className="linklike" onClick={() => go("/shipping")}>Shipping</button>
                <button className="linklike" onClick={() => go("/returns")}>Returns</button>
                <button className="linklike" onClick={() => go("/refund")}>Refunds</button>
                <button className="linklike" onClick={() => go("/privacy")}>Privacy</button>
                <button className="linklike" onClick={() => go("/cookies")}>Cookies</button>
                <button className="linklike" onClick={() => go("/terms")}>Terms</button>
                <button className="linklike" onClick={() => go("/seller-terms")}>Seller terms</button>
                <button className="linklike" onClick={() => go(auth?.type === "admin" ? "/admin" : "/admin/login")}>Admin</button>
              </nav>
              <small className="muted">© 2026 Nepal Shop · Built by Tanetra Technologies</small>
            </footer>
            <CookieBanner />
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
  const [menuOpen, setMenuOpen] = useState(false);
  // A signed-in seller (token session) or a legacy code+key seller session.
  const isSeller = auth?.type === "seller" || !!getLegacySeller();
  // Site logo from the public homepage payload (null until the admin sets
  // one — the text brand is the fallback). Shares the "homepage" query cache
  // with the homepage itself.
  const home = useQuery({ queryKey: ["homepage"], queryFn: () => api2.getHomepage({}) });
  const siteLogoUrl = (home.data as unknown as { site_logo_url?: string | null } | undefined)?.site_logo_url ?? null;
  const avatarUrl = useBuyerAvatar();
  // Dashboard pages (buyer account, seller studio, admin panel) have their
  // own hamburger + drawer — the storefront hamburger stays hidden there so
  // there is never a second, competing menu button.
  const isDashboard = /^\/(account|seller|admin)(\/|$)/.test(path);
  return (<>
    <header className="topbar">
      {/* Brand lockup: the uploaded site logo (left corner) with the "Nepal Shop"
          name always immediately to its right — never the tagline. */}
      <button className="brand brand-lockup" onClick={() => go("/")} aria-label="Nepal Shop home">
        {siteLogoUrl && <img src={siteLogoUrl} alt="" />}
        <span>Nepal&nbsp;Shop</span>
      </button>
      <nav aria-label="Main sections" className="tabs">
        <button className={path === "/" ? "active" : ""} onClick={() => go("/")}>Home</button>
        <button className={path === "/shop" ? "active" : ""} onClick={() => go("/shop")}>Shop</button>
        <button className={path === "/assistant" ? "active" : ""} onClick={() => go("/assistant")}>Assistant</button>
        <button className={path === "/track" || path === "/account/orders" ? "active" : ""} onClick={() => go("/track")}>My order</button>
        {isSeller && <button className={path.startsWith("/seller") ? "active" : ""} onClick={() => go("/seller")}>Seller studio</button>}
      </nav>
      <div className="header-search hide-mobile"><HeaderSearch /></div>
      <div className="account-menu">
        {auth?.type === "buyer" && <>
          <button className={path === "/wishlist" ? "active" : ""} onClick={() => go("/wishlist")} aria-label={`Wishlist, ${wish.data?.items.length ?? 0} items`}>♥ {wish.data ? wish.data.items.length : ""}</button>
          <button className={`bell${path === "/notifications" ? " active" : ""}`} onClick={() => go("/notifications")} aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`}>🔔{unread > 0 && <span className="badge">{unread}</span>}</button>
          <button className={path.startsWith("/account") ? "active" : ""} onClick={() => go("/account")} aria-label="My account">
            {avatarUrl && <img className="nav-avatar" src={avatarUrl} alt="" />}
            Account
          </button>
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
        <button className="cart-button" onClick={() => setShowCart(true)} aria-label={`Open basket with ${count} items`}>
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path d="M4 7.5h16l-1.4 10.4a1.5 1.5 0 0 1-1.5 1.1H6.9a1.5 1.5 0 0 1-1.5-1.1L4 7.5z" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" /><path d="M8.5 10V6.8a3.5 3.5 0 0 1 7 0V10" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" /></svg>
          Basket <span className="cart-count">{count}</span>
        </button>
      </div>
      {/* Storefront hamburger sits at the top-right (CSS) and is hidden on
          dashboard pages, where each dashboard shows only its own menu. */}
      {!isDashboard && <button className="nav-hamburger" aria-label="Open menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}>☰</button>}
    </header>
    {!isDashboard && <NavDrawer open={menuOpen} onClose={() => setMenuOpen(false)} path={path} />}
    {showCart && <CheckoutSheet close={() => setShowCart(false)} onPlaced={(code) => { setShowCart(false); go("/track"); sessionStorage.setItem("lastOrderCode", code); }} />}
  </>);
}

// Mobile-only slide-in site menu. The hamburger that opens it is hidden at
// >=768px, so this drawer never exists on desktop or tablet.
function NavDrawer({ open, onClose, path }: { open: boolean; onClose: () => void; path: string }) {
  const { auth, signOut } = useAuth();
  const isSeller = auth?.type === "seller" || !!getLegacySeller();
  const goAndClose = (to: string) => { onClose(); go(to); };
  const items: { label: string; desc: string; to: string; active: boolean }[] = [
    { label: "Home", desc: "Today's market", to: "/", active: path === "/" },
    { label: "Shop", desc: "Browse everything", to: "/shop", active: path === "/shop" },
    { label: "Assistant", desc: "Ask for recommendations", to: "/assistant", active: path === "/assistant" },
    { label: "Search", desc: "Find products and sellers", to: "/search", active: path === "/search" },
    { label: "Basket", desc: "Review and check out", to: "/cart", active: path === "/cart" },
    { label: "Track order", desc: "Where's my package?", to: "/track", active: path === "/track" || path === "/account/orders" },
  ];
  return (
    <Drawer open={open} onClose={onClose} label="Menu">
      <nav aria-label="Site menu" className="drawer-nav">
        {items.map((i) => (
          <button key={i.to} type="button" className={i.active ? "active" : ""} aria-current={i.active ? "page" : undefined} onClick={() => goAndClose(i.to)}>
            <b>{i.label}</b><small>{i.desc}</small>
          </button>
        ))}
        {!auth && <>
          <button type="button" className={path === "/login" ? "active" : ""} onClick={() => goAndClose("/login")}><b>Log in</b><small>Your orders and wishlist</small></button>
          <button type="button" className={path === "/signup" ? "active" : ""} onClick={() => goAndClose("/signup")}><b>Sign up</b><small>Join the market</small></button>
        </>}
        {auth?.type === "buyer" && <button type="button" className={path.startsWith("/account") ? "active" : ""} onClick={() => goAndClose("/account")}><b>Account</b><small>Orders, addresses, settings</small></button>}
        {isSeller && <button type="button" className={path.startsWith("/seller") ? "active" : ""} onClick={() => goAndClose("/seller")}><b>Seller studio</b><small>Inventory, orders, earnings</small></button>}
        {auth?.type === "admin" && <button type="button" className={path.startsWith("/admin") ? "active" : ""} onClick={() => goAndClose("/admin")}><b>Admin panel</b><small>Marketplace control</small></button>}
        {auth && <button type="button" className="drawer-logout" onClick={() => { onClose(); signOut(); }}><b>Log out</b></button>}
        {/* v12: info & legal pages, below the account actions. These routes
            already exist (same pages the footer links to) — nothing is
            recreated here. */}
        <div className="drawer-section" role="group" aria-label="Information and legal">
          <span className="drawer-heading">Information</span>
          {[
            { label: "About", to: "/about" },
            { label: "Contact", to: "/contact" },
            { label: "Help", to: "/help" },
            { label: "Shipping", to: "/shipping" },
            { label: "Returns", to: "/returns" },
            { label: "Refunds", to: "/refund" },
            { label: "Privacy", to: "/privacy" },
            { label: "Cookies", to: "/cookies" },
            { label: "Terms", to: "/terms" },
            { label: "Seller terms", to: "/seller-terms" },
          ].map((l) => (
            <button key={l.to} type="button" className={path === l.to ? "active" : ""} aria-current={path === l.to ? "page" : undefined} onClick={() => goAndClose(l.to)}><b>{l.label}</b></button>
          ))}
        </div>
      </nav>
    </Drawer>
  );
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
  if (path === "/forgot-password") return <ForgotPasswordPage />;
  if (path === "/reset-password") return <ResetPasswordPage query={query} />;
  if (path === "/verify-seller") return <VerifySellerPage query={query} />;
  if (path === "/verify-buyer") return <VerifyBuyerPage query={query} />;
  if (path === "/account") return auth?.type === "buyer" ? <AccountShell key="account" initial="orders" /> : null;
  if (path === "/account/addresses") return auth?.type === "buyer" ? <AccountShell key="addresses" initial="addresses" /> : null;
  if (path === "/account/orders") return auth?.type === "buyer" ? <AccountShell key="orders" initial="orders" /> : null;
  if (path === "/notifications") return <NotificationsPage />;
  if (path === "/wishlist") return <WishlistPage />;
  if (path === "/cart") return <CartPage />;
  if (path === "/checkout") return <CheckoutPage />;
  if (path === "/payment-result") return <PaymentResultPage query={query} />;
  if (path === "/search") return <SearchPage key={`q=${query.get("q") ?? ""}&c=${query.get("category") ?? ""}`} initialQuery={query.get("q") ?? ""} initialCategory={query.get("category") ?? ""} />;
  if (path === "/compare") return <ComparePage />;
  if (path === "/assistant") return <AssistantPage />;
  if (path === "/help") return <HelpPage />;
  if (path === "/about") return <AboutPage />;
  if (path === "/contact") return <ContactPage />;
  if (path === "/privacy") return <PrivacyPage />;
  if (path === "/terms") return <TermsPage />;
  if (path === "/refund") return <RefundPolicyPage />;
  if (path === "/returns") return <ReturnPolicyPage />;
  if (path === "/shipping") return <ShippingPolicyPage />;
  if (path === "/seller-terms") return <SellerTermsPage />;
  if (path === "/cookies") return <CookiePolicyPage />;
  if (path.startsWith("/invoice/")) {
    const code = decodeURIComponent(path.slice("/invoice/".length).split(/[/?]/)[0] ?? "");
    return code ? <InvoicePage key={code} orderCode={code} /> : <NotFoundPage />;
  }
  if (path.startsWith("/product/")) {
    const id = Number(path.slice("/product/".length).split(/[/?]/)[0]);
    return Number.isInteger(id) && id > 0 ? <ProductPage key={id} id={id} /> : <ShopPage />;
  }
  if (path.startsWith("/store/")) {
    const code = decodeURIComponent(path.slice("/store/".length).split(/[/?]/)[0] ?? "");
    return code ? <StorePage key={code.toUpperCase()} code={code} /> : <ShopPage />;
  }
  if (path === "/shop") return <ShopPage />;
  if (path === "/seller/login") return <SellerLogin />;
  if (path === "/seller") return auth?.type === "seller" || getLegacySeller() ? <Studio invalidate={invalidate} /> : null;
  if (path === "/admin/login") return <AdminLogin />;
  if (path === "/admin") return auth?.type === "admin" ? <AdminPanel /> : null;
  return path === "/" ? <Homepage /> : <NotFoundPage />;
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
        <img src={heroArt} alt="Two hands passing a wrapped parcel across a shop counter" fetchPriority="high" />
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
  const { lines, setQty, clear, subtotal } = useCart();
  const [error, setError] = useState("");
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.getMe({}), enabled: auth?.type === "buyer", retry: false });
  const delivery = lines.reduce((sum, line) => sum + line.product.delivery_fee_paisa * line.quantity, 0);
  // Idempotency key: one per sheet instance, reused across retries, so a
  // double-tap on "Place COD order" cannot create two order groups.
  const idempotencyKey = useRef("");
  const order = useMutation({
    mutationFn: api.placeOrder,
    onSuccess: (result) => { clear(); onPlaced(result.group_code); },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setError("");
    if (!idempotencyKey.current) idempotencyKey.current = crypto.randomUUID();
    const data = new FormData(event.currentTarget);
    order.mutate({
      customer_name: String(data.get("name") ?? ""), phone: String(data.get("phone") ?? ""),
      address: String(data.get("address") ?? ""), note: String(data.get("note") ?? ""),
      cod_confirmed: true, payment_method: "cod", delivery_method: "standard",
      idempotency_key: idempotencyKey.current,
      items: lines.map((l) => ({ product_id: l.product.id, quantity: l.quantity, variant_id: l.variantId })),
    });
  };
  const buyerName = me.data?.user.name ?? "";
  const buyerPhone = me.data?.user.phone ?? "";
  return <div className="overlay" role="dialog" aria-modal="true" aria-label="Basket and checkout"><div className="sheet checkout"><button className="sheet-close" onClick={close} aria-label="Close basket">Close</button><p className="eyebrow">Your parcel</p><h2>Check every rupee</h2>{lines.length === 0 ? <div className="empty-mini"><p>Your basket is empty.</p><button onClick={close}>Keep shopping</button></div> : <><div className="cart-lines">{lines.map((line) => { const { product, quantity, variantId, variantLabel, unitPrice, stock } = line; return <div className="cart-line" key={`${product.id}:${variantId}`}><div><b>{product.name}</b>{variantLabel && <small>Option: {variantLabel}</small>}<small>{money(unitPrice)} each</small></div><div className="quantity small"><button onClick={() => setQty(product.id, quantity - 1, variantId)} aria-label={`Remove one ${product.name}`}>−</button><span>{quantity}</span><button onClick={() => setQty(product.id, quantity + 1, variantId)} disabled={quantity >= stock} aria-label={`Add one ${product.name}`}>+</button></div></div>; })}</div><div className="receipt"><span>Items <b>{money(subtotal)}</b></span><span>Delivery <b>{money(delivery)}</b></span><span className="total">Due on delivery <b>{money(subtotal + delivery)}</b></span></div><form onSubmit={submit} className="stack-form" key={auth?.type === "buyer" ? `buyer-${buyerPhone}` : "guest"}><label>Your name<input name="name" required minLength={2} defaultValue={buyerName} /></label><label>Mobile number<input name="phone" type="tel" required minLength={7} defaultValue={buyerPhone} /></label><label>Delivery address<textarea name="address" required minLength={5} /></label><label>Note for seller <textarea name="note" /></label>{auth?.type === "buyer" ? <p className="muted">Signed in as {auth.name}. This order will appear under My orders.</p> : <p className="muted"><button type="button" className="linklike" onClick={() => { close(); go("/login"); }}>Log in</button> to link this order to an account, or check out as a guest.</p>}<div className="payment-choice"><b>Cash on delivery</b><p>No money is taken now. Your order stays “Needs confirmation” until the seller accepts it.</p></div><label className="check"><input type="checkbox" required /> I’ll respond when the seller confirms this COD order.</label>{error && <p className="form-error">{error}</p>}<button className="primary" disabled={order.isPending}>{order.isPending ? "Placing order…" : `Place COD order · ${money(subtotal + delivery)}`}</button></form><p className="muted">Prefer delivery choices, coupons or wallets? <button type="button" className="linklike" onClick={() => { close(); go("/checkout"); }}>Use the full checkout →</button></p></>}</div></div>;
}

// --- tracking (guest code+phone, extended statuses) ---------------------------
// The customer-facing code is the GROUP code (NSG-…); older fulfilment codes
// (NP-…) still resolve to the single fulfilment view.
function TrackOrder({ invalidate }: { invalidate: () => void }) {
  const [credentials, setCredentials] = useState({ order_code: sessionStorage.getItem("lastOrderCode") ?? "", phone: "" });
  const [enabled, setEnabled] = useState(false);
  const track = useQuery({ queryKey: ["track", credentials], queryFn: () => api.trackOrder(credentials), enabled });
  const submit = (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); setEnabled(false); const data = new FormData(e.currentTarget); setCredentials({ order_code: String(data.get("code") ?? "").toUpperCase(), phone: String(data.get("phone") ?? "") }); setTimeout(() => setEnabled(true), 0); };
  const refresh = () => { invalidate(); void track.refetch(); };
  return <main className="track-page"><section className="track-intro"><p className="eyebrow">No account needed</p><h1>Follow your parcel.</h1><p>Your order code and phone number reveal only your matching order.</p></section><form className="track-form" onSubmit={submit}><label>Order code<input name="code" defaultValue={credentials.order_code} placeholder="NSG-…" required /></label><label>Mobile number<input name="phone" type="tel" required /></label><button className="primary">Find order</button></form>{track.isFetching && <p className="muted">Checking the order trail…</p>}{enabled && track.data?.order === null && track.data?.group === null && <div className="empty-state"><h3>No matching order</h3><p>Check the code and mobile number exactly as entered at checkout.</p></div>}{track.data?.group && <GroupTrail group={toP2OrderGroup(track.data.group)} credentials={credentials} invalidate={refresh} />}{track.data?.order && !track.data?.group && <OrderTrail order={toP2Order(track.data.order)} credentials={credentials} invalidate={refresh} />}</main>;
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
    <p className="muted">New here? <button className="linklike" onClick={() => go("/signup")}>Create an account</button> · <button className="linklike" onClick={() => go("/forgot-password")}>Forgot password?</button></p>
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
      <label>Password<input name="password" type="password" required minLength={8} autoComplete="new-password" /><small>At least 8 characters.</small></label>
      <FieldError error={signup.error} />
      <button className="primary" disabled={signup.isPending}>{signup.isPending ? "Creating account…" : "Create account"}</button>
    </form>
    <p className="muted">Already have an account? <button className="linklike" onClick={() => go("/login")}>Log in</button></p>
  </main>;
}

function ForgotPasswordPage() {
  const [userType, setUserType] = useState<"buyer" | "seller" | "admin">("buyer");
  const [done, setDone] = useState(false);
  const req = useMutation({
    mutationFn: (identifier: string) => api2.requestPasswordReset({ user_type: userType, identifier }),
    onSuccess: () => setDone(true),
  });
  return <main className="track-page"><section className="track-intro"><p className="eyebrow">Account recovery</p><h1>Forgot your password?</h1><p>Enter the {userType === "buyer" ? "mobile number or email" : "email"} on your account and we will email you a one-time reset link (valid 1 hour).</p></section>
    {done ? (
      <div className="empty-state"><span>CHECK YOUR EMAIL</span><h3>Request received.</h3><p>If an account matches, a reset link is on its way — check your inbox and spam folder. The link expires in 1 hour and works once.</p><button className="primary" onClick={() => go("/login")}>Back to log in</button></div>
    ) : (
      <form className="stack-form auth-form" onSubmit={(e) => { e.preventDefault(); const d = new FormData(e.currentTarget); req.mutate(String(d.get("identifier") ?? "")); }}>
        <div className="category-list" role="tablist" aria-label="Account type">
          {(["buyer", "seller", "admin"] as const).map((t) => <button type="button" key={t} className={userType === t ? "selected" : ""} onClick={() => setUserType(t)}>{t === "buyer" ? "Buyer" : t === "seller" ? "Seller" : "Admin"}</button>)}
        </div>
        <label>{userType === "buyer" ? "Mobile number or email" : "Email"}<input name="identifier" required minLength={3} autoComplete={userType === "buyer" ? "tel" : "email"} /></label>
        <FieldError error={req.error} />
        <button className="primary" disabled={req.isPending}>{req.isPending ? "Sending…" : "Email me a reset link"}</button>
      </form>
    )}
  </main>;
}

function ResetPasswordPage({ query }: { query: URLSearchParams }) {
  const token = query.get("token") ?? "";
  const userType = query.get("type") === "seller" ? "seller" : query.get("type") === "admin" ? "admin" : "buyer";
  const [done, setDone] = useState(false);
  const [mismatch, setMismatch] = useState("");
  const reset = useMutation({
    mutationFn: (new_password: string) => api2.resetPassword({ user_type: userType, token, new_password }),
    onSuccess: () => setDone(true),
  });
  if (!token) return <main className="track-page"><section className="track-intro"><p className="eyebrow">Account recovery</p><h1>That link is incomplete.</h1><p>Please open the full reset link from your email, or request a new one.</p></section><button className="primary" onClick={() => go("/forgot-password")}>Request a new link</button></main>;
  return <main className="track-page"><section className="track-intro"><p className="eyebrow">Account recovery</p><h1>Choose a new password.</h1><p>At least 8 characters. Every other signed-in device will be signed out.</p></section>
    {done ? (
      <div className="empty-state"><span>PASSWORD CHANGED</span><h3>You are all set.</h3><p>Your password has been changed. Please log in with the new one.</p><button className="primary" onClick={() => go(userType === "seller" ? "/seller/login" : userType === "admin" ? "/admin/login" : "/login")}>Log in</button></div>
    ) : (
      <form className="stack-form auth-form" onSubmit={(e) => { e.preventDefault(); const d = new FormData(e.currentTarget); const a = String(d.get("a") ?? ""), b = String(d.get("b") ?? ""); if (a !== b) { setMismatch("The two passwords do not match."); return; } setMismatch(""); reset.mutate(a); }}>
        <label>New password<input name="a" type="password" required minLength={8} autoComplete="new-password" /></label>
        <label>Repeat new password<input name="b" type="password" required minLength={8} autoComplete="new-password" /></label>
        {mismatch && <p className="form-error">{mismatch}</p>}
        <FieldError error={reset.error} />
        <button className="primary" disabled={reset.isPending}>{reset.isPending ? "Changing…" : "Change password"}</button>
      </form>
    )}
  </main>;
}

function VerifyBuyerPage({ query }: { query: URLSearchParams }) {
  const token = query.get("token") ?? "";
  const [state, setState] = useState<"working" | "done" | "failed">("working");
  const [detail, setDetail] = useState("");
  useEffect(() => {
    if (!token) { setState("failed"); setDetail("That link is incomplete."); return; }
    api.verifyBuyerEmail({ token })
      .then((r) => { setState("done"); setDetail(r.already_verified ? "This link was already used — your email was verified earlier." : "Your email is verified. You will now receive order updates by email."); })
      .catch((e) => { setState("failed"); setDetail(e instanceof Error ? e.message : "Verification failed."); });
  }, [token]);
  return <main className="track-page"><section className="track-intro"><p className="eyebrow">Email verification</p><h1>Confirming your email.</h1></section>
    {state === "working" && <p className="muted">Checking your verification link…</p>}
    {state !== "working" && (
      <div className="empty-state"><span>{state === "done" ? "EMAIL VERIFIED" : "LINK NOT VALID"}</span><h3>{state === "done" ? "You are all set." : "That link didn’t work."}</h3><p>{detail}</p>
        {state === "done"
          ? <button className="primary" onClick={() => go("/account")}>Continue to your account</button>
          : <button className="primary" onClick={() => go("/account")}>Back to your account</button>}
      </div>)}
  </main>;
}

function VerifySellerPage({ query }: { query: URLSearchParams }) {
  const token = query.get("token") ?? "";
  const [state, setState] = useState<"working" | "done" | "failed">("working");
  const [detail, setDetail] = useState("");
  useEffect(() => {
    if (!token) { setState("failed"); setDetail("That link is incomplete."); return; }
    api.verifySellerEmail({ token })
      .then((r) => { setState("done"); setDetail(r.already_verified ? "This link was already used — your email was verified earlier." : "Your email is verified. Your shop is now in the review queue."); })
      .catch((e) => { setState("failed"); setDetail(e instanceof Error ? e.message : "Verification failed."); });
  }, [token]);
  return <main className="track-page"><section className="track-intro"><p className="eyebrow">Seller verification</p><h1>Confirming your email.</h1></section>
    {state === "working" && <p className="muted">Checking your verification link…</p>}
    {state !== "working" && (
      <div className="empty-state"><span>{state === "done" ? "EMAIL VERIFIED" : "LINK NOT VALID"}</span><h3>{state === "done" ? "You are all set." : "That link didn’t work."}</h3><p>{detail}</p>
        {state === "done"
          ? <button className="primary" onClick={() => go("/seller/login")}>Continue to sign in</button>
          : <button className="primary" onClick={() => go("/seller/login")}>Back to seller sign in</button>}
      </div>)}
  </main>;
}

// --- sellers ------------------------------------------------------------------
function SellerLogin() {
  const { signIn, auth } = useAuth();
  const [mode, setMode] = useState<"email" | "code" | "register">("email");
  const [createdCode, setCreatedCode] = useState("");
  // Whether the registration email actually went out (false when the shop
  // has no email service configured — the UI must say so honestly).
  const [createdEmailSent, setCreatedEmailSent] = useState(true);
  useEffect(() => { if (auth?.type === "seller" || getLegacySeller()) go("/seller"); }, [auth]);
  const emailLogin = useMutation({
    mutationFn: api.sellerLogin,
    onSuccess: (result) => { signIn({ token: result.token, type: "seller", name: result.seller.store_name }); go("/seller"); },
  });
  const codeLogin = useMutation({
    mutationFn: (vars: { seller_code: string; seller_key: string }) => api.sellerInventory(vars),
    onSuccess: (_data, vars) => { setLegacySeller(vars); go("/seller"); },
  });
  const register = useMutation({ mutationFn: api.registerSeller, onSuccess: (result) => { setCreatedCode(result.seller_code); setCreatedEmailSent(result.email_sent); } });
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
      <p className="muted"><button type="button" className="linklike" onClick={() => go("/forgot-password")}>Forgot password?</button></p>
    </form>}
    {mode === "code" && <form className="stack-form auth-form" onSubmit={submitCode}>
      <label>Seller code<input name="code" placeholder="SELL-…" required autoComplete="username" /></label>
      <label>Private access key<input name="key" type="password" minLength={8} required autoComplete="current-password" /></label>
      <FieldError error={codeLogin.error} />
      <button className="primary" disabled={codeLogin.isPending}>{codeLogin.isPending ? "Unlocking…" : "Unlock studio"}</button>
      <p className="muted">The original code + key sign-in keeps working for existing sellers.</p>
    </form>}
    {mode === "register" && (createdCode ? <div className="empty-state"><span>SHOP CREATED</span><h3>Save your seller code</h3><p className="seller-code-big">{createdCode}</p>{createdEmailSent
        ? <p>We sent a verification link to your email — it expires in 24 hours. Verify it to send your shop for admin review.</p>
        : <p>We could not send the verification email — this shop has no email service configured yet. Please contact support to verify your email.</p>}<p>You can sign in and add products now; they appear in the shop once approved.</p><button className="primary" onClick={() => { setMode("email"); setCreatedCode(""); }}>Continue to sign in</button></div> :
      <form className="stack-form auth-form" onSubmit={submitRegister}>
        <label>Store name<input name="store" required minLength={2} /></label>
        <label>Short promise<input name="tagline" required minLength={3} /></label>
        <label>Location<input name="location" required minLength={2} /></label>
        <label>Public contact<input name="phone" type="tel" required minLength={7} /></label>
        <label>Email<input name="email" type="email" required autoComplete="email" /><small>Used for sign-in and admin contact.</small></label>
        <label>Password<input name="password" type="password" required minLength={8} autoComplete="new-password" /><small>At least 8 characters.</small></label>
        <label>Private access key<input name="key" type="password" minLength={8} required /><small>At least 8 characters. The old code + key sign-in also works with this.</small></label>
        <FieldError error={register.error} />
        <button className="primary" disabled={register.isPending}>{register.isPending ? "Creating…" : "Create seller account"}</button>
      </form>)}
  </main>;
}

type StudioTab = "inventory" | "orders" | "returns" | "issues" | "questions" | "analytics" | "earnings" | "settings";
// v12: category picker for the seller product form. Lists the active
// categories from the shared category system; the seller's previously saved
// free-text category is kept as an option so older products still edit cleanly.
function CategorySelect({ editingCategory }: { editingCategory?: string }) {
  const cats = useQuery({ queryKey: ["public-categories"], queryFn: () => api.getPublicCategories({}) });
  const names = (cats.data?.categories ?? []).map((c) => c.name);
  const options = editingCategory && !names.includes(editingCategory) ? [editingCategory, ...names] : names;
  return (
    <label>Category
      <select name="category" defaultValue={editingCategory ?? ""} required>
        {cats.isPending && <option value="">Loading categories…</option>}
        {options.map((n) => <option key={n} value={n}>{n}</option>)}
      </select>
    </label>
  );
}

// v12: "request new category" box for the seller product workflow. The seller
// proposes a name; the admin reviews it in the Categories tab; approval adds
// it to the shared category list for every seller.
function CategoryRequestBox({ callArgs }: { callArgs: { authToken?: string; seller_code?: string; seller_key?: string } }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const mine = useQuery({ queryKey: ["my-category-requests"], queryFn: () => api2.sellerListMyCategoryRequests({ ...callArgs }) });
  const send = useMutation({
    mutationFn: (n: string) => api2.sellerRequestCategory({ ...callArgs, name: n }),
    onSuccess: () => {
      setName(""); setMsg("Request sent — the admin will review it. Approved categories appear in the list above.");
      void queryClient.invalidateQueries({ queryKey: ["my-category-requests"] });
    },
    onError: (e) => setMsg(e instanceof Error ? e.message : "Could not send the request."),
  });
  return (
    <section className="studio-section">
      <div className="section-title"><h2>Request a new category</h2></div>
      <p className="muted">Can’t find the right category for your products? Propose one — once the admin approves it, every seller can use it.</p>
      <form className="form-row" onSubmit={(e) => { e.preventDefault(); const n = name.trim(); if (n) send.mutate(n); }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Handmade Soaps" maxLength={40} aria-label="Proposed category name" />
        <button className="primary" disabled={!name.trim() || send.isPending}>{send.isPending ? "Sending…" : "Send request"}</button>
      </form>
      {msg && <p className={msg.startsWith("Request sent") ? "success" : "form-error"}>{msg}</p>}
      {mine.data && mine.data.requests.length > 0 && (
        <div className="admin-table">{mine.data.requests.map((r) => (
          <div key={r.id} className="admin-row"><span><b>{r.name}</b></span>
            <span className={r.status === "approved" ? "success" : r.status === "rejected" ? "text-danger" : "muted"}>
              {r.status === "pending" ? "Awaiting review" : r.status === "approved" ? "Approved" : "Declined"}
            </span>
          </div>
        ))}</div>
      )}
    </section>
  );
}

function Studio({ invalidate }: { invalidate: () => void }) {
  const { auth, signOut } = useAuth();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<StudioTab>("inventory");
  const [legacy, setLegacyState] = useState<LegacySeller | null>(() => getLegacySeller());
  const [editing, setEditing] = useState<P2Product | null>(null);
  // After publishing a new product, jump straight into edit mode for it so
  // the seller can add photos without hunting through the list.
  const [pendingEditId, setPendingEditId] = useState<number | null>(null);
  const [notice, setNotice] = useState("");
  // Two-step confirmation for deleting a product from the studio.
  const [confirmDeleteProduct, setConfirmDeleteProduct] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const creds: LegacySeller = auth?.type === "seller" ? { seller_code: "", seller_key: "" } : legacy ?? { seller_code: "", seller_key: "" };
  const tokenAuth = auth?.type === "seller";
  const callArgs: { authToken?: string; seller_code?: string; seller_key?: string } = tokenAuth ? {} : creds;
  const authed = tokenAuth || !!(legacy?.seller_code && legacy?.seller_key);

  const inventory = useQuery({ queryKey: ["seller-inventory", tokenAuth ? "token" : legacy?.seller_code], queryFn: () => api.sellerInventory(callArgs), enabled: authed, retry: false });
  const orders = useQuery({ queryKey: ["orders", tokenAuth ? "token" : legacy?.seller_code], queryFn: () => api.listOrders({ ...callArgs, limit: 100 }), enabled: inventory.isSuccess, retry: false });
  const issues = useQuery({ queryKey: ["issues", tokenAuth ? "token" : legacy?.seller_code], queryFn: () => api.listIssues(callArgs), enabled: inventory.isSuccess, retry: false });
  const privateRefresh = () => { invalidate(); void queryClient.invalidateQueries({ queryKey: ["seller-inventory"] }); void queryClient.invalidateQueries({ queryKey: ["orders"] }); void queryClient.invalidateQueries({ queryKey: ["issues"] }); void queryClient.invalidateQueries({ queryKey: ["seller-returns"] }); void queryClient.invalidateQueries({ queryKey: ["seller-analytics"] }); void queryClient.invalidateQueries({ queryKey: ["stock-movements"] }); };
  const create = useMutation({
    mutationFn: (v: Parameters<typeof api.createProduct>[0]) => api.createProduct(v),
    onSuccess: (data) => { setNotice(data.is_active ? "Product published — add up to 10 photos below." : "Product saved as a draft. It will appear in the shop once your shop is approved."); setPendingEditId(data.id); privateRefresh(); },
  });
  const update = useMutation({
    mutationFn: (v: Parameters<typeof api.updateProduct>[0]) => api.updateProduct(v),
    onSuccess: () => { setNotice("Product updated."); setEditing(null); setConfirmDeleteProduct(false); privateRefresh(); },
  });
  const removeProduct = useMutation({
    mutationFn: (id: number) => api.deleteProduct({ ...callArgs, id }),
    onSuccess: (res) => { setNotice(res.archived ? "Product archived — hidden from the shop, but its order history is kept." : "Product deleted."); setEditing(null); setConfirmDeleteProduct(false); privateRefresh(); },
    onError: (e) => { setConfirmDeleteProduct(false); setNotice(e instanceof Error ? e.message : "Could not remove the product."); },
  });
  // v9 approval flow: a rejected product can be sent back for review. While
  // under review the server hides it from the shop (is_active=false).
  const submitApproval = useMutation({
    mutationFn: (product_id: number) => api.submitProductForApproval({ ...callArgs, product_id }),
    onSuccess: () => { setNotice("Sent for approval — it stays hidden from the shop until an admin reviews it."); void queryClient.invalidateQueries({ queryKey: ["seller-inventory"] }); },
    onError: (e) => setNotice(e instanceof Error ? e.message : "Could not submit for approval."),
  });
  const updateOrder = useMutation({ mutationFn: api.updateOrderStatus, onSuccess: privateRefresh });
  const resolve = useMutation({ mutationFn: api.resolveIssue, onSuccess: privateRefresh });
  const products: P2Product[] = useMemo(() => (inventory.data?.products ?? []).map((p) => {
    const r = p as unknown as Record<string, unknown>;
    return {
      ...(p as unknown as P2Product),
      brand: (r.brand as string | null) ?? null,
      original_price_paisa: (r.original_price_paisa as number | null) ?? null,
      discount_pct: (r.discount_pct as number) ?? 0,
      image_url: (r.image_url as string | null) ?? null,
      images: (r.images as string[] | undefined) ?? [],
      low_stock: (r.low_stock as boolean) ?? false,
      sku: (r.sku as string | null) ?? null,
    };
  }), [inventory.data]);
  useEffect(() => {
    if (pendingEditId != null && inventory.isSuccess) {
      const fresh = products.find((p) => p.id === pendingEditId);
      if (fresh) { setEditing(fresh); setPendingEditId(null); }
    }
  }, [pendingEditId, inventory.isSuccess, products]);
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
      is_active: d.get("active") === "on",
      ...extra,
    };
    if (editing) update.mutate({ ...payload, id: editing.id });
    else create.mutate(payload);
  };
  const tabs: { id: StudioTab; label: string }[] = [
    { id: "inventory", label: "Inventory" }, { id: "orders", label: "Orders" }, { id: "returns", label: "Returns" },
    { id: "issues", label: "Issues" }, { id: "questions", label: "Questions" }, { id: "analytics", label: "Analytics" }, { id: "earnings", label: "Earnings" }, { id: "settings", label: "Settings" },
  ];
  if (inventory.error) return <main className="studio-page"><section className="studio-intro"><p className="eyebrow">Session problem</p><h1>That sign-in didn’t work.</h1><p>Please sign in again.</p><button className="primary" onClick={lockStudio}>Back to sign in</button></section></main>;
  if (inventory.isPending) return <main className="studio-page"><p className="muted">Unlocking the studio…</p></main>;
  return <main className="studio-page"><section className="studio-intro"><p className="eyebrow">{tokenAuth ? "Signed in" : creds.seller_code}</p><h1>Run the counter.</h1><p>Publish real inventory, confirm COD orders, and resolve buyer issues from one protected place.</p><button className="switch-mode" onClick={lockStudio}>Lock studio</button></section>
    {notice && <p className="success banner">{notice}</p>}
    <SellerStatusBanners store={store} />
    <div className="mobile-bar">
      <strong>{tabs.find((t) => t.id === tab)?.label ?? "Seller studio"}</strong>
      <button className="nav-hamburger" aria-label="Open studio menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}>☰</button>
    </div>
    <div className="studio-shell">
      <aside className="sidebar desktop-only" aria-label="Studio sections">
        <div className="sidebar-head"><div><b>Seller studio</b><span className="muted">{store ? store.store_name : creds.seller_code}</span></div></div>
        <StudioTabNav tabs={tabs} tab={tab} pick={(t) => { setTab(t); setMenuOpen(false); }} />
      </aside>
      <div className="studio-panel">
    {tab === "inventory" && <div className="studio-layout">
      <section className="studio-section"><div className="section-title"><h2>{editing ? "Edit product" : "New product"}</h2>{editing && <button onClick={() => { setEditing(null); setConfirmDeleteProduct(false); }}>Cancel edit</button>}</div>
      <form className="stack-form" key={editing?.id ?? "new"} onSubmit={saveProduct}>
        <label>Product name<input name="name" defaultValue={editing?.name} required /></label>
        <div className="form-pair"><CategorySelect editingCategory={editing?.category} /><label>Stock<input name="stock" type="number" min="0" defaultValue={editing?.stock ?? 1} required /></label></div>
        <label>Description<textarea name="description" defaultValue={editing?.description} minLength={8} required /></label>
        <div className="form-pair"><label>Price, rupees<input name="price" type="number" min="0.01" step="0.01" defaultValue={editing ? editing.price_paisa / 100 : ""} required /></label><label>Delivery, rupees<input name="delivery" type="number" min="0" step="0.01" defaultValue={editing ? editing.delivery_fee_paisa / 100 : 0} required /></label></div>
        <ProductExtraFields editing={editing} productId={editing?.id} callArgs={callArgs} />
        <label className="check"><input name="active" type="checkbox" defaultChecked={editing ? editing.is_active : true} /> Visible in shop{store && store.status !== "active" && <small> — your shop isn’t approved yet, so new products are saved as drafts</small>}</label>
        <div className="form-row">
          <button className="primary" disabled={create.isPending || update.isPending}>{editing ? "Save product" : "Publish product"}</button>
          {editing && (confirmDeleteProduct
            ? <><button type="button" className="text-danger" disabled={removeProduct.isPending} onClick={() => removeProduct.mutate(editing.id)}>Yes, remove it</button><button type="button" onClick={() => setConfirmDeleteProduct(false)}>Keep it</button></>
            : <button type="button" onClick={() => setConfirmDeleteProduct(true)}>Delete product</button>)}
        </div>
        {editing && <small className="muted">Deleting removes the listing and its photos. Products with past orders are archived instead, keeping order history intact.</small>}
      </form>
      {editing && <VariantManager productId={editing.id} basePricePaisa={editing.price_paisa} callArgs={callArgs} />}
      {editing && <SpecManager productId={editing.id} callArgs={callArgs} />}
      <div className="product-admin">{products.map((p) => {
        const approval = (p as unknown as { approval_status?: string }).approval_status ?? "approved";
        return <div key={p.id} className="product-admin-row">
          <button onClick={() => { setEditing(p); setConfirmDeleteProduct(false); }}>
            <span><b>{p.name}</b><small>{p.is_active ? `${p.stock} in stock` : "Hidden / draft"}{approval === "pending" ? " · Awaiting approval" : approval === "rejected" ? " · Rejected — fix it and resubmit" : ""}</small></span>
            <strong>{money(p.price_paisa)}</strong>
          </button>
          {approval === "rejected" && (
            <button className="ghost" disabled={submitApproval.isPending} onClick={() => submitApproval.mutate(p.id)}>
              {submitApproval.isPending ? "Sending…" : "Submit for approval"}
            </button>
          )}
        </div>;
      })}</div></section>
      <section className="studio-section"><div className="section-title"><h2>Stock history</h2></div><StockHistory callArgs={callArgs} /></section>
      <CategoryRequestBox callArgs={callArgs} />
      <section className="studio-section wide"><div className="section-title"><h2>Bulk import</h2></div><SellerCsvImport callArgs={callArgs} /></section>
    </div>}

    {tab === "orders" && <section className="studio-section wide"><div className="section-title"><h2>Orders</h2><span>{orderRows.length}</span></div>{orders.isPending ? <p className="muted">Loading orders…</p> : orderRows.length === 0 ? <p className="muted">New COD orders for this shop will arrive here.</p> : <div className="order-admin">{orderRows.map((order) => <article key={order.id}><div><p className="eyebrow">{order.order_code} · {new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(order.created_at))}</p><h3>{order.customer_name}</h3><p>{order.items.map((i) => `${i.quantity} × ${i.product_name}`).join(", ")}</p><small>{order.address} · {order.phone}</small>{(order.tracking_number || order.carrier) && <p className="muted">Shipment: {[order.carrier, order.tracking_number].filter(Boolean).join(" · ")}</p>}<details><summary>Shipment details</summary><ShipmentForm order={order} callArgs={callArgs} onSaved={privateRefresh} /></details></div><div className="order-actions"><b>{money(order.total_paisa)}</b><span className={`status ${order.status}`}>{STATUS_LABEL[order.status] ?? order.status}</span>{nextStatus[order.status] && <button onClick={() => updateOrder.mutate({ ...callArgs, order_id: order.id, status: nextStatus[order.status] ?? order.status })}>Mark {(STATUS_LABEL[nextStatus[order.status] ?? order.status] ?? "").toLowerCase()}</button>}{order.status === "out_for_delivery" && <button className="text-danger" onClick={() => updateOrder.mutate({ ...callArgs, order_id: order.id, status: "delivery_failed" })}>Mark delivery failed</button>}{order.status === "confirmation_needed" && <button className="text-danger" onClick={() => updateOrder.mutate({ ...callArgs, order_id: order.id, status: "cancelled" })}>Decline</button>}</div></article>)}</div>}</section>}

    {tab === "returns" && <section className="studio-section wide"><div className="section-title"><h2>Returns</h2></div><SellerReturns callArgs={callArgs} /></section>}

    {tab === "issues" && <section className="studio-section wide"><div className="section-title"><h2>Buyer issues</h2><span>{issueRows.filter((i) => i.status === "open").length} open</span></div>{issues.isPending ? <p className="muted">Loading issues…</p> : issueRows.length === 0 ? <p className="muted">No buyer issues reported for this shop.</p> : <div className="issues">{issueRows.map((item) => <article key={item.id}><div><p className="eyebrow">{item.order_code} · {item.kind}</p><p>{item.detail}</p><small>{new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(item.created_at))}</small></div>{item.status === "open" ? <button onClick={() => resolve.mutate({ ...callArgs, issue_id: item.id })}>Mark resolved</button> : <span className="success">Resolved</span>}</article>)}</div>}</section>}

    {tab === "questions" && <section className="studio-section wide"><div className="section-title"><h2>Buyer questions</h2></div><SellerQuestions products={products.map((p) => ({ id: p.id, name: p.name }))} callArgs={callArgs} /></section>}

    {tab === "analytics" && <SellerAnalytics callArgs={callArgs} />}

    {tab === "earnings" && <SellerEarnings callArgs={callArgs} />}

    {tab === "settings" && store && <><StudioSellerSettings store={store} callArgs={callArgs} onSaved={privateRefresh} /><ChangePasswordForm kind="seller" extraArgs={callArgs} /></>}
      </div>
    </div>
    <Drawer open={menuOpen} onClose={() => setMenuOpen(false)} label="Studio menu">
      <div className="sidebar-head"><div><b>Seller studio</b><span className="muted">{store ? store.store_name : creds.seller_code}</span></div></div>
      <StudioTabNav tabs={tabs} tab={tab} pick={(t) => { setTab(t); setMenuOpen(false); }} />
    </Drawer>
  </main>;
}

// Sidebar tab list shared by the desktop studio sidebar and the mobile
// studio drawer — same tabs, same behaviour, one place.
function StudioTabNav({ tabs, tab, pick }: { tabs: { id: StudioTab; label: string }[]; tab: StudioTab; pick: (t: StudioTab) => void }) {
  return (
    <nav aria-label="Studio sections" className="sidebar-nav">
      {tabs.map((t) => (
        <button key={t.id} type="button" className={tab === t.id ? "active" : ""} aria-current={tab === t.id ? "page" : undefined} onClick={() => pick(t.id)}>
          <b>{t.label}</b>
        </button>
      ))}
      <button type="button" className="sidebar-home" onClick={() => go("/")}>
        <b>Homepage</b><small>Return to the storefront</small>
      </button>
    </nav>
  );
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
    <p className="muted"><button className="linklike" onClick={() => go("/forgot-password")}>Forgot password?</button></p>
  </main>;
}

type AdminTab = "overview" | "sellers" | "products" | "orders" | "returns" | "refunds" | "shipping" | "issues" | "buyers" | "payments" | "reviews" | "audit" | "coupons" | "categories" | "homepage" | "analytics" | "tickets" | "email";
function AdminPanel() {
  const [tab, setTab] = useState<AdminTab>("overview");
  const tabs: { id: AdminTab; label: string }[] = [
    { id: "overview", label: "Overview" }, { id: "sellers", label: "Sellers" },
    { id: "products", label: "Products" }, { id: "orders", label: "Orders" },
    { id: "returns", label: "Returns" }, { id: "refunds", label: "Refunds" },
    { id: "shipping", label: "Shipping" }, { id: "issues", label: "Issues" },
    { id: "buyers", label: "Buyers" }, { id: "payments", label: "Payments" },
    { id: "reviews", label: "Reviews" }, { id: "audit", label: "Audit log" },
    { id: "coupons", label: "Coupons" }, { id: "categories", label: "Categories" },
    { id: "homepage", label: "Homepage" }, { id: "analytics", label: "Analytics" },
    { id: "tickets", label: "Tickets" }, { id: "email", label: "Email" },
  ];
  return <main className="studio-page"><section className="studio-intro"><p className="eyebrow">Marketplace control</p><h1>Admin panel.</h1><p>Approve sellers, curate products, and watch orders across the whole market.</p></section>
    <AdminShell tabs={tabs} tab={tab} setTab={(id: string) => setTab(id as AdminTab)}>
    {tab === "overview" && <AdminOverview />}
    {tab === "sellers" && <AdminSellers />}
    {tab === "products" && <AdminProducts />}
    {tab === "orders" && <AdminOrders />}
    {tab === "returns" && <AdminReturns />}
    {tab === "refunds" && <AdminRefunds />}
    {tab === "shipping" && <AdminShippingSettings />}
    {tab === "issues" && <AdminIssues />}
    {tab === "buyers" && <AdminBuyers />}
    {tab === "payments" && <AdminPayments />}
    {tab === "reviews" && <AdminReviewReports />}
    {tab === "audit" && <AdminAuditLog />}
    {tab === "coupons" && <AdminCoupons />}
    {tab === "categories" && <AdminCategories />}
    {tab === "homepage" && <AdminHomepage />}
    {tab === "analytics" && <AdminAnalytics />}
    {tab === "tickets" && <AdminTickets />}
    {tab === "email" && <AdminEmail />}
    </AdminShell>
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
        <div><b>{s.refunded_orders}</b><span>Refunded orders</span></div>
        <div className={s.pending_sellers ? "alert" : ""}><b>{s.pending_sellers}</b><span>Sellers waiting</span></div>
        <div className={s.open_issues ? "alert" : ""}><b>{s.open_issues}</b><span>Open issues</span></div>
        <div className={s.open_tickets ? "alert" : ""}><b>{s.open_tickets}</b><span>Open tickets</span></div>
        <div className={s.open_review_reports ? "alert" : ""}><b>{s.open_review_reports}</b><span>Review reports</span></div>
      </div>}
      <p className="muted"><small>Every figure is computed live from the database. Commission rules and the payout engine are not built yet, so no commission or payout figures are shown anywhere.</small></p>
    </section>
    <section className="studio-section"><h2>Change admin password</h2>
      <form className="stack-form" onSubmit={(e) => { e.preventDefault(); const d = new FormData(e.currentTarget); changePw.mutate({ old_password: String(d.get("old") ?? ""), new_password: String(d.get("new") ?? "") }); }}>
        <label>Current password<input name="old" type="password" required autoComplete="current-password" /></label>
        <label>New password<input name="new" type="password" required minLength={8} autoComplete="new-password" /></label>
        <FieldError error={changePw.error} />
        {message && !changePw.error && <p className="success">{message}</p>}
        <button className="primary" disabled={changePw.isPending}>Change password</button>
      </form>
    </section>
  </div>;
}

// Only the transitions the verification lifecycle allows. The server
// enforces the same map; the panel simply never offers an illegal move.
const SELLER_TRANSITIONS: Record<AdminSeller["status"], { to: AdminSeller["status"]; label: string }[]> = {
  pending: [{ to: "under_review", label: "Start review" }, { to: "rejected", label: "Reject" }],
  under_review: [{ to: "active", label: "Approve" }, { to: "rejected", label: "Reject" }],
  active: [{ to: "suspended", label: "Suspend" }],
  suspended: [{ to: "active", label: "Reactivate" }],
  rejected: [],
};

function AdminSellers() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [q, setQ] = useState("");
  const [detailId, setDetailId] = useState<number | null>(null);
  const sellers = useQuery({ queryKey: ["admin-sellers", q], queryFn: () => api.adminListSellers(q ? { q } : {}) });
  const setStatus = useMutation({
    mutationFn: api.adminSetSellerStatus,
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["admin-sellers"] }); void queryClient.invalidateQueries({ queryKey: ["admin-stats"] }); void queryClient.invalidateQueries({ queryKey: ["storefront"] }); toast("Seller status updated."); },
    onError: (e) => toast(e instanceof Error ? e.message : "Could not update.", "err"),
  });
  const rows: AdminSeller[] = sellers.data?.sellers ?? [];
  return <section className="studio-section wide"><div className="section-title"><h2>Sellers</h2><span>{rows.length}</span></div>
    <form className="stack-form compact" onSubmit={(e) => e.preventDefault()}>
      <label>Search sellers<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Shop name, code or email" /></label>
    </form>
    {sellers.isPending && <p className="muted">Loading sellers…</p>}
    <FieldError error={sellers.error} />
    {detailId !== null && <AdminSellerDetail id={detailId} onBack={() => setDetailId(null)} />}
    <div className="admin-table">{rows.map((seller) => <article key={seller.id}>
      <div><h3>{seller.store_name}</h3><p className="muted">{seller.seller_code} · {seller.location} · {seller.phone}</p><p className="muted">{seller.email ?? "No email"}{seller.email_verified ? " · email verified" : " · email not verified"} · {seller.product_count} products · {seller.order_count} orders</p><small>Joined {new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(seller.created_at))}</small></div>
      <div className="order-actions"><span className={`status status-${seller.status}`}>{sellerStatusLabel[seller.status]}</span>
        <button onClick={() => setDetailId(seller.id)}>View</button>
        {SELLER_TRANSITIONS[seller.status].map((t) => (
          <button key={t.to} disabled={setStatus.isPending || (t.to === "active" && !seller.email_verified)}
            title={t.to === "active" && !seller.email_verified ? "Approve only after the seller's email is verified." : undefined}
            className={t.to === "suspended" || t.to === "rejected" ? "text-danger" : undefined}
            onClick={() => { if (t.to === "suspended" || t.to === "rejected") { if (!window.confirm(`${t.label} ${seller.store_name}?`)) return; } setStatus.mutate({ seller_id: seller.id, status: t.to }); }}>
            {t.label}
          </button>
        ))}
        {SELLER_TRANSITIONS[seller.status].length === 0 && <small className="muted">No further moves — terminal state.</small>}
      </div>
    </article>)}</div>
    <FieldError error={setStatus.error} />
  </section>;
}

function AdminSellerDetail({ id, onBack }: { id: number; onBack: () => void }) {
  const detail = useQuery({ queryKey: ["admin-seller-detail", id], queryFn: () => api.adminGetSeller({ seller_id: id }) });
  if (detail.isPending) return <p className="muted">Loading seller…</p>;
  if (detail.error || !detail.data) return <div><FieldError error={detail.error} /><button className="ghost" onClick={onBack}>Back to sellers</button></div>;
  const d = detail.data;
  return <section className="studio-section wide">
    <div className="section-title"><h2>{d.seller.store_name}</h2><button className="ghost" onClick={onBack}>Back to sellers</button></div>
    <p className="muted">{d.seller.seller_code} · {d.seller.location} · {d.seller.phone} · {d.seller.email ?? "No email"}</p>
    <p><span className={`status status-${d.seller.status}`}>{sellerStatusLabel[d.seller.status]}</span></p>
    {d.seller.description && <p>{d.seller.description}</p>}
    <h3>Earnings (from the ledger)</h3>
    <div className="stat-grid">
      <div><b>{money(d.earnings.available_paisa)}</b><span>Available</span></div>
      <div><b>{money(d.earnings.pending_paisa)}</b><span>Pending</span></div>
      <div><b>{money(d.earnings.paid_out_paisa)}</b><span>Paid out</span></div>
      <div><b>{money(d.earnings.commission_paisa)}</b><span>Commission taken</span></div>
    </div>
    <p className="muted"><small>Ledger-derived and auditable — every rupee is traceable in the money trail. {d.earnings.reserved_paisa > 0 && <>{money(d.earnings.reserved_paisa)} is held by payouts awaiting processing. </>}Gross order value {money(d.earnings.gmv_paisa)} · refunded {money(d.earnings.refunded_paisa)}.</small></p>
    <h3>Orders by status</h3>
    <div className="kv">{Object.entries(d.earnings.orders_by_status).map(([s, c]) => <span key={s}><b>{c}</b> {STATUS_LABEL[s] ?? s}</span>)}</div>
    <h3>Products</h3>
    {d.products.length === 0 ? <p className="muted">No products yet.</p> :
      <div className="kv">{d.products.map((p) => <span key={p.id}><b>{money(p.price_paisa)}</b> {p.name} · {p.stock} in stock · {p.is_active ? "visible" : "hidden"}</span>)}</div>}
    <h3>Recent orders</h3>
    {d.orders.length === 0 ? <p className="muted">No orders yet.</p> :
      <div className="kv">{d.orders.slice(0, 20).map((o) => <span key={o.id}><b>{money(o.total_paisa)}</b> {o.order_code} · {o.customer_name} · {STATUS_LABEL[o.status] ?? o.status}</span>)}</div>}
  </section>;
}

function AdminProducts() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [q, setQ] = useState("");
  const [queueOnly, setQueueOnly] = useState(false);
  const products = useQuery({ queryKey: ["admin-products", q, queueOnly], queryFn: () => api.adminListProducts({ ...(q ? { q } : {}), ...(queueOnly ? { moderation: true } : {}) }) });
  const toggle = useMutation({
    mutationFn: api.adminSetProductActive,
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["admin-products"] }); void queryClient.invalidateQueries({ queryKey: ["storefront"] }); toast("Product visibility updated."); },
    onError: (e) => toast(e instanceof Error ? e.message : "Could not update.", "err"),
  });
  const rows: AdminProduct[] = products.data?.products ?? [];
  const [rejecting, setRejecting] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["admin-products"] });
  const approve = useMutation({
    mutationFn: (product_id: number) => api.adminApproveProduct({ product_id }),
    onSuccess: () => { refresh(); toast("Product approved — the seller can publish it now."); },
    onError: (e) => toast(e instanceof Error ? e.message : "Could not approve.", "err"),
  });
  const reject = useMutation({
    mutationFn: (v: { product_id: number; reason?: string }) => api.adminRejectProduct(v),
    onSuccess: () => { setRejecting(null); setReason(""); refresh(); toast("Product rejected — the seller was notified."); },
    onError: (e) => toast(e instanceof Error ? e.message : "Could not reject.", "err"),
  });
  const approvalLabel: Record<string, string> = { approved: "Approved", pending: "Awaiting approval", rejected: "Rejected" };
  return <section className="studio-section wide"><div className="section-title"><h2>Products</h2><span>{rows.length}</span>
    <label className="muted"><input type="checkbox" checked={queueOnly} onChange={(e) => setQueueOnly(e.target.checked)} /> Moderation queue</label></div>
    <form className="stack-form compact" onSubmit={(e) => e.preventDefault()}>
      <label>Search products<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or category" /></label>
    </form>
    {queueOnly && <p className="muted">Needs a look: hidden products, plus anything listed by a shop that is not an approved active seller.</p>}
    {products.isPending && <p className="muted">Loading products…</p>}
    <FieldError error={products.error} />
    <div className="admin-table">{rows.map((p) => <article key={p.id}>
      <div><h3>{p.name}</h3><p className="muted">{p.category} · {p.store_name} ({p.seller_code}) · seller {sellerStatusLabel[p.seller_status]}</p><p><b>{money(p.price_paisa)}</b> · {p.stock} in stock</p></div>
      <div className="order-actions">
        <span className={`status ${p.approval_status === "approved" ? "confirmed" : p.approval_status === "pending" ? "processing" : "cancelled"}`}>{approvalLabel[p.approval_status] ?? p.approval_status}</span>
        {p.approval_status === "pending" && <>
          <button disabled={approve.isPending} onClick={() => approve.mutate(p.id)}>Approve</button>
          {rejecting === p.id
            ? <form className="stack-form compact" onSubmit={(e) => { e.preventDefault(); reject.mutate({ product_id: p.id, reason: reason.trim() ? reason.trim() : undefined }); }}>
                <label>Reason (optional — the seller sees it)<input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={400} placeholder="e.g. Photos don't match the description" /></label>
                <div className="form-row">
                  <button type="submit" className="text-danger" disabled={reject.isPending}>{reject.isPending ? "Rejecting…" : "Reject product"}</button>
                  <button type="button" className="ghost" onClick={() => { setRejecting(null); setReason(""); }}>Cancel</button>
                </div>
              </form>
            : <button className="text-danger" onClick={() => { setRejecting(p.id); setReason(""); }}>Reject…</button>}
        </>}
        <span className={`status ${p.is_active ? "confirmed" : "cancelled"}`}>{p.is_active ? "Visible" : "Hidden"}</span>
        <button disabled={toggle.isPending} onClick={() => toggle.mutate({ product_id: p.id, active: !p.is_active })}>{p.is_active ? "Hide" : "Show"}</button>
      </div>
    </article>)}</div>
    <FieldError error={toggle.error} />
  </section>;
}

// Legal order moves, mirroring the server-side ORDER_TRANSITIONS map.
const ORDER_NEXT: Record<string, string[]> = {
  confirmation_needed: ["confirmed", "cancelled"],
  confirmed: ["packed", "cancelled"],
  packed: ["shipped"],
  shipped: ["out_for_delivery", "delivered"],
  out_for_delivery: ["delivered", "delivery_failed"],
  delivery_failed: ["out_for_delivery"],
  delivered: ["return_requested"],
  return_requested: ["returned", "delivered"],
  returned: ["refunded"],
};

function AdminOrders() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<string>("all");
  const [openId, setOpenId] = useState<number | null>(null);
  const orders = useQuery({ queryKey: ["admin-orders", filter], queryFn: () => api.adminListOrders(filter === "all" ? {} : { status: filter as AdminOrder["status"] }) });
  const refresh = () => { void queryClient.invalidateQueries({ queryKey: ["admin-orders"] }); void queryClient.invalidateQueries({ queryKey: ["admin-stats"] }); };
  const advance = useMutation({
    mutationFn: (v: { order_id: number; status: AdminOrder["status"] }) => api.adminUpdateOrderStatus(v),
    onSuccess: () => { refresh(); toast("Order updated."); },
    onError: (e) => toast(e instanceof Error ? e.message : "Could not update.", "err"),
  });
  const cancel = useMutation({
    mutationFn: (order_id: number) => api.adminCancelOrder({ order_id }),
    onSuccess: () => { refresh(); toast("Order cancelled."); },
    onError: (e) => toast(e instanceof Error ? e.message : "Could not cancel.", "err"),
  });
  const rows: AdminOrder[] = orders.data?.orders ?? [];
  // Group fulfilment rows under their customer-facing order group so the
  // admin sees one checkout (NSG-…) with each seller's fulfilment (NP-…).
  const grouped = useMemo(() => {
    const map = new Map<string, AdminOrder[]>();
    const singles: AdminOrder[] = [];
    for (const o of rows) {
      if (o.group_code) {
        const list = map.get(o.group_code) ?? [];
        list.push(o); map.set(o.group_code, list);
      } else singles.push(o);
    }
    return { map, singles };
  }, [rows]);
  const renderRow = (order: AdminOrder) => <article key={order.id}>
      <div><p className="eyebrow">{order.group_code ? `${order.group_code} · ${order.order_code}` : order.order_code} · {order.store_name}</p><h3>{order.customer_name} · {order.phone}</h3><p>{order.items.map((i) => `${i.quantity} × ${i.product_name}`).join(", ")}</p><small>{new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(order.created_at))}</small></div>
      <div className="order-actions"><b>{money(order.total_paisa)}</b><span className={`status ${order.status}`}>{STATUS_LABEL[order.status] ?? order.status}</span>
        <button className="ghost" onClick={() => setOpenId(openId === order.id ? null : order.id)}>{openId === order.id ? "Hide detail" : "Detail"}</button>
      </div>
      {openId === order.id && <div className="order-detail">
        <p><b>Payment:</b> {order.payment_method} · {order.payment_status}{order.coupon_code ? ` · coupon ${order.coupon_code}` : ""}{order.discount_paisa > 0 ? ` (−${money(order.discount_paisa)} group discount share)` : ""}</p>
        <p><b>Deliver to:</b> {order.address}{order.note ? ` — “${order.note}”` : ""}</p>
        <ShipmentForm admin order={order} onSaved={refresh} />
        <div className="kv">{order.items.map((i) => <span key={i.id}><b>{i.quantity} ×</b> {i.product_name}{i.variant_label ? ` (${i.variant_label})` : ""} · {money(i.unit_price_paisa)}</span>)}</div>
        <div className="order-actions">
          {(ORDER_NEXT[order.status] ?? []).filter((s) => s !== "cancelled").map((s) => (
            <button key={s} disabled={advance.isPending} onClick={() => advance.mutate({ order_id: order.id, status: s as AdminOrder["status"] })}>Mark {(STATUS_LABEL[s] ?? s).toLowerCase()}</button>
          ))}
          {(ORDER_NEXT[order.status] ?? []).includes("cancelled") && (
            <button className="text-danger" disabled={cancel.isPending} onClick={() => { if (window.confirm(`Cancel order ${order.group_code ?? order.order_code}? The whole order (all sellers) will be cancelled and reserved stock returned.`)) cancel.mutate(order.id); }}>Cancel order</button>
          )}
          {(ORDER_NEXT[order.status] ?? []).length === 0 && <small className="muted">Terminal state — nothing further to do here.</small>}
        </div>
        <FieldError error={advance.error} /><FieldError error={cancel.error} />
      </div>}
    </article>;
  return <section className="studio-section wide"><div className="section-title"><h2>Orders</h2><span>{rows.length}</span>
    <label className="muted">Status <select value={filter} onChange={(e) => setFilter(e.target.value)}>
      <option value="all">All</option><option value="confirmation_needed">Needs confirmation</option><option value="confirmed">Confirmed</option><option value="packed">Packed</option><option value="shipped">On the way</option><option value="out_for_delivery">Out for delivery</option><option value="delivered">Delivered</option><option value="return_requested">Return requested</option><option value="returned">Returned</option><option value="refunded">Refunded</option><option value="cancelled">Cancelled</option>
    </select></label></div>
    {orders.isPending && <p className="muted">Loading orders…</p>}
    <FieldError error={orders.error} />
    {rows.length === 0 && !orders.isPending && <p className="muted">No orders here yet.</p>}
    <div className="admin-table">
      {[...grouped.map.entries()].map(([code, fulfilments]) => (
        <div key={code} className="order-group-block">
          <p className="eyebrow group-head">Order {code} · {fulfilments.length} seller{fulfilments.length === 1 ? "" : "s"} · {money(fulfilments.reduce((s, o) => s + o.total_paisa, 0))}</p>
          {fulfilments.map(renderRow)}
        </div>
      ))}
      {grouped.singles.map(renderRow)}
    </div>
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
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [q, setQ] = useState("");
  const [detailId, setDetailId] = useState<string | null>(null);
  const buyers = useQuery({ queryKey: ["admin-buyers", q], queryFn: () => api.adminListUsers(q ? { q } : {}) });
  const setStatus = useMutation({
    mutationFn: (v: { user_id: string; status: "active" | "suspended" }) => api.adminSetUserStatus(v),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["admin-buyers"] }); void queryClient.invalidateQueries({ queryKey: ["admin-stats"] }); toast("Buyer account updated."); },
    onError: (e) => toast(e instanceof Error ? e.message : "Could not update.", "err"),
  });
  const rows: AdminUser[] = buyers.data?.users ?? [];
  return <section className="studio-section wide"><div className="section-title"><h2>Buyers</h2><span>{rows.length}</span></div>
    <form className="stack-form compact" onSubmit={(e) => e.preventDefault()}>
      <label>Search buyers<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, mobile or email" /></label>
    </form>
    {buyers.isPending && <p className="muted">Loading buyers…</p>}
    <FieldError error={buyers.error} />
    {rows.length === 0 && !buyers.isPending && <p className="muted">No buyer accounts yet.</p>}
    {detailId !== null && <AdminBuyerDetail id={detailId} onBack={() => setDetailId(null)} />}
    <div className="admin-table">{rows.map((u) => <article key={u.id}>
      <div><h3>{u.name}</h3><p className="muted">{u.phone}{u.email ? ` · ${u.email}` : ""}</p><small>Joined {new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(u.created_at))}</small></div>
      <div className="order-actions"><b>{u.order_count}</b><span className="muted">orders</span>
        <span className={`status ${u.status === "suspended" ? "cancelled" : "confirmed"}`}>{u.status === "suspended" ? "Suspended" : "Active"}</span>
        <button onClick={() => setDetailId(u.id)}>View</button>
        {u.status === "active"
          ? <button className="text-danger" disabled={setStatus.isPending} onClick={() => { if (window.confirm(`Suspend ${u.name}'s account? They will be signed out everywhere and cannot log back in.`)) setStatus.mutate({ user_id: u.id, status: "suspended" }); }}>Suspend</button>
          : <button disabled={setStatus.isPending} onClick={() => setStatus.mutate({ user_id: u.id, status: "active" })}>Reactivate</button>}
      </div>
    </article>)}</div>
    <FieldError error={setStatus.error} />
  </section>;
}

function AdminBuyerDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const detail = useQuery({ queryKey: ["admin-buyer-detail", id], queryFn: () => api.adminGetUser({ user_id: id }) });
  if (detail.isPending) return <p className="muted">Loading buyer…</p>;
  if (detail.error || !detail.data) return <div><FieldError error={detail.error} /><button className="ghost" onClick={onBack}>Back to buyers</button></div>;
  const d = detail.data;
  return <section className="studio-section wide">
    <div className="section-title"><h2>{d.user.name}</h2><button className="ghost" onClick={onBack}>Back to buyers</button></div>
    <p className="muted">{d.user.phone}{d.user.email ? ` · ${d.user.email}` : ""}</p>
    <p><span className={`status ${d.user.status === "suspended" ? "cancelled" : "confirmed"}`}>{d.user.status === "suspended" ? "Suspended" : "Active"}</span></p>
    <p className="muted"><small>Joined {new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(d.user.created_at))}</small></p>
    <h3>Orders ({d.orders.length})</h3>
    {d.orders.length === 0 ? <p className="muted">No orders yet.</p> :
      <div className="admin-table">{d.orders.map((o) => <article key={o.id}>
        <div><p className="eyebrow">{o.order_code}</p><p>{o.items.map((i) => `${i.quantity} × ${i.product_name}`).join(", ")}</p><small>{new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(o.created_at))}</small></div>
        <div className="order-actions"><b>{money(o.total_paisa)}</b><span className={`status ${o.status}`}>{STATUS_LABEL[o.status] ?? o.status}</span></div>
      </article>)}</div>}
  </section>;
}
