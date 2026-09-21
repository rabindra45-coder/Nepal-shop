// Phase-2 buyer screens.
import { useEffect, useMemo, useRef, useState, type Dispatch, type FormEvent, type ReactNode, type SetStateAction } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api2, fmtDate, money, placeOrder, type P2Address, type P2Product } from "./phase2api";
import { useAuth, go } from "./session";
import { useCart } from "./cart";
import { EmptyBlock, Loading, PageError, ProductCard, ProductImage, Stars, getCompareIds, isCompared, toggleCompareId, useToast } from "./ui";

// --- shared bits ------------------------------------------------------------
function SectionRow({ title, products, onOpen, onAdd }: { title: string; products: P2Product[]; onOpen: (p: P2Product) => void; onAdd: (p: P2Product) => void }) {
  if (!products.length) return null;
  return (
    <section className="home-section">
      <div className="section-title"><h2>{title}</h2><button onClick={() => go("/shop")}>View all</button></div>
      <div className="rail">{products.map((p) => (
        <div className="rail-card" key={p.id}><ProductCard product={p} onOpen={() => onOpen(p)} onAdd={onAdd} /></div>
      ))}</div>
    </section>
  );
}

// --- homepage ---------------------------------------------------------------
export function Homepage() {
  const { auth } = useAuth();
  const { add } = useCart();
  const home = useQuery({ queryKey: ["homepage"], queryFn: () => api2.getHomepage({}) });
  const recent = useQuery({ queryKey: ["recently-viewed"], queryFn: () => api2.getRecentlyViewed({}), enabled: auth?.type === "buyer" });
  const open = (p: P2Product) => go(`/product/${p.id}`);
  const banners = home.data?.banners ?? [];
  const sections = home.data?.sections ?? [];

  return (
    <main>
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">Local marketplace</p>
          <h1>Shop local.<br />Know who packed it.</h1>
          <p>Verified sellers, honest prices in rupees, cash on delivery — and eSewa/Khalti where available.</p>
          <div className="hero-actions">
            <button className="primary" onClick={() => go("/shop")}>Browse everything</button>
            <button className="ghost" onClick={() => go("/search")}>Search</button>
          </div>
        </div>
      </section>

      <section className="trust-strip" aria-label="Shopping protections">
        <div><b>01</b><span>Total shown before ordering</span></div>
        <div><b>02</b><span>COD waits for seller confirmation</span></div>
        <div><b>03</b><span>Reviews require delivery</span></div>
      </section>

      <div className="home-wrap">
        {home.isPending && <p className="muted">Opening the market…</p>}
        {home.error && <p className="form-error">The homepage could not load. The shop is still open — <button className="linklike" onClick={() => go("/shop")}>browse everything</button>.</p>}
        {banners.length > 0 && <div className="banners">{banners.map((b, i) => (
          <a key={i} className="banner-card" href={b.link ?? "#/shop"}>
            <p className="eyebrow">Offer</p><h3>{b.title}</h3>{b.subtitle && <p>{b.subtitle}</p>}
          </a>
        ))}</div>}
        {sections.map((s) => <SectionRow key={s.key} title={s.title} products={s.products} onOpen={open} onAdd={add} />)}
        {!home.isPending && !home.error && sections.length === 0 && (
          <EmptyBlock kicker="FRESH MARKET" title="The shelves are being arranged." body="Product sections appear here as sellers publish listings. Meanwhile you can browse the full catalogue." actionLabel="Browse the shop" onAction={() => go("/shop")} />
        )}
        {auth?.type === "buyer" && (recent.data?.products?.length ?? 0) > 0 && (
          <SectionRow title="Recently viewed" products={recent.data!.products} onOpen={open} onAdd={add} />
        )}
        <div className="home-cta">
          <button className="primary" onClick={() => go("/shop")}>Browse the full catalogue</button>
        </div>
      </div>
    </main>
  );
}

// --- search ------------------------------------------------------------------
type SortKey = "relevance" | "price_asc" | "price_desc" | "rating" | "newest" | "popularity" | "discount";
const SORTS: { id: SortKey; label: string }[] = [
  { id: "relevance", label: "Most relevant" }, { id: "price_asc", label: "Price: low to high" },
  { id: "price_desc", label: "Price: high to low" }, { id: "rating", label: "Top rated" },
  { id: "newest", label: "Newest" }, { id: "popularity", label: "Most popular" }, { id: "discount", label: "Biggest discount" },
];
const PAGE = 24;

export function SearchPage({ initialQuery }: { initialQuery: string }) {
  const { products } = useCart();
  const [q, setQ] = useState(initialQuery);
  const [committed, setCommitted] = useState(initialQuery);
  const [category, setCategory] = useState("");
  const [brand, setBrand] = useState("");
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [minRating, setMinRating] = useState("0");
  const [inStock, setInStock] = useState(false);
  const [onSale, setOnSale] = useState(false);
  const [seller, setSeller] = useState("");
  const [sort, setSort] = useState<SortKey>("relevance");
  const [page, setPage] = useState(0);
  const [showSug, setShowSug] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  const categories = useMemo(() => [...new Set(products.map((p) => p.category))].sort(), [products]);
  const brands = useMemo(() => [...new Set(products.map((p) => p.brand).filter((b): b is string => !!b))].sort(), [products]);
  const sellers = useMemo(() => {
    const m = new Map<string, string>();
    products.forEach((p) => m.set(p.seller_code, p.store_name));
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [products]);

  useEffect(() => { const close = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setShowSug(false); }; document.addEventListener("mousedown", close); return () => document.removeEventListener("mousedown", close); }, []);

  const [sugQ, setSugQ] = useState("");
  useEffect(() => { const t = window.setTimeout(() => setSugQ(q.trim()), 220); return () => window.clearTimeout(t); }, [q]);
  const sug = useQuery({ queryKey: ["suggest", sugQ], queryFn: () => api2.suggestSearch({ query: sugQ }), enabled: sugQ.length >= 2 && showSug });

  const filters = {
    category: category || undefined, brand: brand.trim() || undefined,
    min_price_paisa: minPrice ? Math.round(Number(minPrice) * 100) : undefined,
    max_price_paisa: maxPrice ? Math.round(Number(maxPrice) * 100) : undefined,
    min_rating: Number(minRating) > 0 ? Number(minRating) : undefined,
    in_stock_only: inStock || undefined, on_sale_only: onSale || undefined,
    seller_code: seller || undefined, sort,
  };
  const search = useQuery({
    queryKey: ["search", committed, filters, page],
    queryFn: () => api2.searchProducts({ query: committed, ...filters, limit: PAGE, offset: page * PAGE }),
  });
  const results = search.data?.products ?? [];
  const total = search.data?.total ?? 0;

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    setShowSug(false); setPage(0); setCommitted(q.trim());
  };
  const activeFilters = [category, brand.trim(), minPrice, maxPrice, Number(minRating) > 0 ? `${minRating}★+` : "", inStock ? "In stock" : "", onSale ? "On sale" : "", seller].filter(Boolean).length;

  return (
    <main className="track-page wide-main"><section className="track-intro"><p className="eyebrow">Search the market</p><h1>Find it here.</h1></section>
      <form className="search-bar" onSubmit={submit}>
        <div className="suggest-box" ref={boxRef}>
          <input aria-label="Search products" value={q} onChange={(e) => { setQ(e.target.value); setShowSug(true); }} onFocus={() => setShowSug(true)} placeholder="Phone, pashmina, earbuds…" />
          {showSug && sugQ.length >= 2 && (sug.data?.product_names.length || sug.data?.categories.length) ? (
            <div className="suggest-drop" role="listbox">
              {sug.data.categories.map((c) => <button type="button" key={`c-${c}`} onClick={() => { setQ(c); setShowSug(false); setPage(0); setCommitted(c); }}><span className="sug-kind">Category</span> {c}</button>)}
              {sug.data.product_names.map((n) => <button type="button" key={`p-${n}`} onClick={() => { setQ(n); setShowSug(false); setPage(0); setCommitted(n); }}>{n}</button>)}
            </div>
          ) : null}
        </div>
        <button className="primary" type="submit">Search</button>
      </form>

      <div className="filter-bar">
        <label>Category <select value={category} onChange={(e) => { setCategory(e.target.value); setPage(0); }}><option value="">All</option>{categories.map((c) => <option key={c} value={c}>{c}</option>)}</select></label>
        <label>Brand <input list="brand-list" value={brand} onChange={(e) => { setBrand(e.target.value); setPage(0); }} placeholder="Any brand" /><datalist id="brand-list">{brands.map((b) => <option key={b} value={b} />)}</datalist></label>
        <label>Min Rs <input type="number" min={0} value={minPrice} onChange={(e) => { setMinPrice(e.target.value); setPage(0); }} /></label>
        <label>Max Rs <input type="number" min={0} value={maxPrice} onChange={(e) => { setMaxPrice(e.target.value); setPage(0); }} /></label>
        <label>Rating <select value={minRating} onChange={(e) => { setMinRating(e.target.value); setPage(0); }}><option value="0">Any</option><option value="3">3★+</option><option value="4">4★+</option><option value="4.5">4.5★+</option></select></label>
        <label>Seller <select value={seller} onChange={(e) => { setSeller(e.target.value); setPage(0); }}><option value="">All sellers</option>{sellers.map(([code, name]) => <option key={code} value={code}>{name}</option>)}</select></label>
        <label>Sort <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>{SORTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select></label>
        <label className="check"><input type="checkbox" checked={inStock} onChange={(e) => { setInStock(e.target.checked); setPage(0); }} /> In stock only</label>
        <label className="check"><input type="checkbox" checked={onSale} onChange={(e) => { setOnSale(e.target.checked); setPage(0); }} /> On sale only</label>
        {activeFilters > 0 && <button type="button" onClick={() => { setCategory(""); setBrand(""); setMinPrice(""); setMaxPrice(""); setMinRating("0"); setInStock(false); setOnSale(false); setSeller(""); setSort("relevance"); setPage(0); }}>Clear {activeFilters} filter{activeFilters === 1 ? "" : "s"}</button>}
      </div>

      {search.isPending ? <p className="muted">Searching…</p> :
        search.error ? <p className="form-error">Search failed. Please try again.</p> :
          <>
            <p className="muted result-count">{total} result{total === 1 ? "" : "s"}{committed ? <> for “<b>{committed}</b>”</> : ""}</p>
            {results.length === 0 ? (
              <EmptyBlock kicker="NO MATCHES" title="Nothing found." body="Try a different spelling, a shorter word, or clear the filters — every token is matched against names, brands and categories." />
            ) : (
              <div className="product-grid">{results.map((p) => <SearchCard key={p.id} product={p} />)}</div>
            )}
            {total > (page + 1) * PAGE && <button className="primary more" onClick={() => setPage((n) => n + 1)}>Show more ({total - (page + 1) * PAGE} left)</button>}
          </>}
    </main>
  );
}

function SearchCard({ product }: { product: P2Product }) {
  const { add } = useCart();
  return <ProductCard product={product} onOpen={() => go(`/product/${product.id}`)} onAdd={add} showSeller />;
}

// --- product detail ----------------------------------------------------------
export function ProductPage({ id }: { id: number }) {
  const { auth } = useAuth();
  const { add } = useCart();
  const { toast } = useToast();
  const [qty, setQty] = useState(1);
  const detail = useQuery({ queryKey: ["product-detail", id], queryFn: () => api2.getProductDetail({ product_id: id }) });
  const wishlist = useQuery({ queryKey: ["wishlist"], queryFn: () => api2.getWishlist({}), enabled: auth?.type === "buyer" });
  const queryClient = useQueryClient();
  const [compared, setCompared] = useState(() => isCompared(id));

  const toggleWish = useMutation({
    mutationFn: () => api2.toggleWishlist({ product_id: id }),
    onSuccess: (r) => { void queryClient.invalidateQueries({ queryKey: ["wishlist"] }); toast(r.wishlisted ? "Saved to your wishlist." : "Removed from your wishlist."); },
    onError: () => toast("Please log in to use the wishlist.", "err"),
  });

  if (detail.isPending) return <Loading text="Opening the product…" />;
  if (detail.error || !detail.data) return <PageError error={detail.error} retry={() => detail.refetch()} />;
  const { product: p, reviews, related, frequently_bought_together: fbt, seller } = detail.data;
  const wishlisted = wishlist.data?.items.some((i) => i.product.id === id) ?? false;
  const deliveryNote = "2–5 working days · Standard";
  const expressNote = "1–2 working days · Express (+Rs 120)";

  const buyNow = () => { add(p, qty); go("/checkout"); };
  const share = async () => {
    const url = `${window.location.origin}${window.location.pathname}#/product/${p.id}`;
    if (navigator.share) { try { await navigator.share({ title: p.name, text: p.name, url }); } catch { /* dismissed */ } }
    else {
      try { await navigator.clipboard.writeText(url); toast("Product link copied."); }
      catch { toast("Could not copy the link.", "err"); }
    }
  };

  return (
    <main className="product-page">
      <button className="linklike back" onClick={() => window.history.length > 1 ? window.history.back() : go("/shop")}>← Back</button>
      <div className="pd-grid">
        <div className="pd-gallery"><ProductImage product={p} className="big" />
          {p.original_price_paisa && p.original_price_paisa > p.price_paisa && <span className="off-badge">-{p.discount_pct}%</span>}
        </div>
        <div className="pd-info">
          <p className="eyebrow">{p.category}{p.brand ? ` · ${p.brand}` : ""}</p>
          <h1>{p.name}</h1>
          <Stars rating={p.rating} count={p.review_count} />
          <div className="pd-price">
            <strong>{money(p.price_paisa)}</strong>
            {p.original_price_paisa && p.original_price_paisa > p.price_paisa && <s className="was">{money(p.original_price_paisa)}</s>}
          </div>
          <p className={p.stock === 0 ? "stock-out" : p.low_stock ? "stock-low" : "muted"}>
            {p.stock === 0 ? "Out of stock" : p.low_stock ? `Only ${p.stock} left — order soon` : `${p.stock} in stock`}
          </p>
          <div className="pd-actions">
            <div className="quantity"><button onClick={() => setQty((n) => Math.max(1, n - 1))} disabled={qty <= 1} aria-label="Decrease quantity">−</button><span>{qty}</span><button onClick={() => setQty((n) => Math.min(p.stock, n + 1))} disabled={qty >= p.stock || p.stock === 0} aria-label="Increase quantity">+</button></div>
            <button className="primary" disabled={p.stock === 0} onClick={() => { add(p, qty); toast(`${p.name} added to your basket.`); }}>Add to basket</button>
            <button className="ghost" disabled={p.stock === 0} onClick={buyNow}>Buy now</button>
          </div>
          <div className="pd-tools">
            <button className={wishlisted ? "tool active" : "tool"} onClick={() => toggleWish.mutate()} aria-label="Toggle wishlist" title={auth?.type === "buyer" ? "Wishlist" : "Log in to use the wishlist"}>♥ {wishlisted ? "Saved" : "Wishlist"}</button>
            <button className={compared ? "tool active" : "tool"} onClick={() => setCompared(toggleCompareId(id).includes(id))} title="Compare with up to 2 more products">{compared ? "✓ Comparing" : "Add to compare"}</button>
            <button className="tool" onClick={share}>Share</button>
          </div>
          <div className="pd-meta">
            <span>🚚 {deliveryNote}</span>
            <span>⚡ {expressNote}</span>
            <span>↩ 7-day returns on delivered orders</span>
          </div>
          <div className="seller-card">
            <div><h3>{seller.store_name}</h3><p className="muted">{seller.location} · {seller.product_count} products</p>
              {seller.rating !== null && <Stars rating={seller.rating} />}
            </div>
            {seller.verified && <span className="verified-badge">✓ Verified seller</span>}
          </div>
        </div>
      </div>

      <section className="pd-desc"><h2>About this product</h2><p>{p.description}</p></section>

      <section className="reviews"><h2>Verified buyers ({reviews.length})</h2>
        {reviews.length === 0 ? <p className="muted">No delivered-buyer reviews yet.</p> :
          reviews.map((r) => <article key={r.id}><b>{"★".repeat(r.rating)}{"☆".repeat(5 - r.rating)}</b><p>{r.body}</p><small>{r.reviewer_name} · {fmtDate(r.created_at)}</small></article>)}
        <button className="linklike" onClick={() => go("/track")}>Bought this? Write a verified review from your order page →</button>
      </section>

      {fbt.length > 0 && <SectionRow title="Frequently bought together" products={fbt} onOpen={(x) => go(`/product/${x.id}`)} onAdd={add} />}
      {related.length > 0 && <SectionRow title="You may also like" products={related} onOpen={(x) => go(`/product/${x.id}`)} onAdd={add} />}

      <div className="sticky-buy">
        <div><strong>{money(p.price_paisa)}</strong><small>{p.stock > 0 ? `${p.stock} in stock` : "Out of stock"}</small></div>
        <button className="primary" disabled={p.stock === 0} onClick={() => { add(p, qty); toast("Added to your basket."); }}>Add to basket</button>
        <button className="ghost" onClick={() => go("/cart")}>Basket</button>
      </div>
    </main>
  );
}

// --- cart --------------------------------------------------------------------
export function CartPage() {
  const { lines, count, subtotal, setQty, remove, cartError, dismissCartError } = useCart();
  const { auth } = useAuth();
  if (lines.length === 0) {
    return <main className="track-page"><EmptyBlock kicker="BASKET EMPTY" title="Your basket is empty." body="Fill it with something local — verified sellers, honest prices, cash on delivery." actionLabel="Browse the shop" onAction={() => go("/shop")} /></main>;
  }
  const delivery = lines.reduce((s, l) => s + l.product.delivery_fee_paisa * l.quantity, 0);
  return (
    <main className="track-page"><section className="track-intro"><p className="eyebrow">Your basket</p><h1>{count} item{count === 1 ? "" : "s"}.</h1>
      {auth?.type !== "buyer" && <p><button className="linklike" onClick={() => go("/login")}>Log in</button> to keep this basket on every device.</p>}</section>
      {cartError && <p className="form-error banner" role="alert">{cartError} <button className="linklike" onClick={dismissCartError}>Dismiss</button></p>}
      <div className="cart-lines">{lines.map(({ product: p, quantity }) => (
        <div className="cart-line" key={p.id}>
          <button className="mini-thumb" onClick={() => go(`/product/${p.id}`)} aria-label={`View ${p.name}`}><ProductImage product={p} /></button>
          <div><b>{p.name}</b><small>{money(p.price_paisa)} each · {p.store_name}</small></div>
          <div className="quantity small">
            <button onClick={() => setQty(p.id, quantity - 1)} aria-label="Decrease">−</button>
            <span>{quantity}</span>
            <button onClick={() => setQty(p.id, quantity + 1)} disabled={quantity >= p.stock} aria-label="Increase">+</button>
          </div>
          <b>{money(p.price_paisa * quantity)}</b>
          <button className="linklike text-danger" onClick={() => remove(p.id)}>Remove</button>
        </div>
      ))}</div>
      <div className="receipt">
        <span>Items <b>{money(subtotal)}</b></span>
        <span>Delivery (standard) <b>{money(delivery)}</b></span>
        <span className="total">Subtotal <b>{money(subtotal + delivery)}</b></span>
      </div>
      <button className="primary" onClick={() => go("/checkout")}>Go to checkout</button>
      <p className="muted">Delivery choices and coupon codes come next.</p>
    </main>
  );
}

// --- checkout (5 steps) -------------------------------------------------------
type PayMethod = "cod" | "esewa" | "khalti";
type DeliveryKind = "standard" | "express" | "pickup";
const EXPRESS_FEE = 12000; // paisa = Rs 120

const PROVINCES = ["Koshi", "Madhesh", "Bagmati", "Gandaki", "Lumbini", "Karnali", "Sudurpashchim"];

function AddressFields({ prefix, initial, required }: { prefix: string; initial?: Partial<P2Address>; required?: boolean }) {
  return (
    <>
      <div className="form-pair">
        <label>Full name<input name={`${prefix}full_name`} defaultValue={initial?.full_name} required={required} minLength={2} /></label>
        <label>Mobile number<input name={`${prefix}phone`} type="tel" defaultValue={initial?.phone} required={required} minLength={7} /></label>
      </div>
      <div className="form-pair">
        <label>Province<select name={`${prefix}province`} defaultValue={initial?.province ?? "Bagmati"} required={required}>{PROVINCES.map((p) => <option key={p}>{p}</option>)}</select></label>
        <label>District<input name={`${prefix}district`} defaultValue={initial?.district} required={required} placeholder="e.g. Kathmandu" /></label>
      </div>
      <div className="form-pair">
        <label>Municipality<input name={`${prefix}municipality`} defaultValue={initial?.municipality} required={required} placeholder="e.g. Kathmandu Metro" /></label>
        <label>Ward no.<input name={`${prefix}ward`} defaultValue={initial?.ward ?? ""} inputMode="numeric" /></label>
      </div>
      <label>Landmark / street<input name={`${prefix}landmark`} defaultValue={initial?.landmark ?? ""} placeholder="Near the temple, house no. 12…" /></label>
    </>
  );
}

const addressLine = (a: { full_name: string; phone: string; municipality: string; ward?: string | null; landmark?: string | null; district: string; province: string }) =>
  `${a.full_name}, ${a.phone}, ${a.municipality}${a.ward ? `-${a.ward}` : ""}${a.landmark ? `, ${a.landmark}` : ""}, ${a.district}, ${a.province}`;

export function CheckoutPage() {
  const { auth } = useAuth();
  const { lines, subtotal, clear } = useCart();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [step, setStep] = useState(1);
  const [addressId, setAddressId] = useState<number | null>(null);
  const [addingAddress, setAddingAddress] = useState(false);
  const [delivery, setDelivery] = useState<DeliveryKind>("standard");
  const [couponCode, setCouponCode] = useState("");
  const [coupon, setCoupon] = useState<{ valid: boolean; discount_paisa: number; free_shipping: boolean; message: string } | null>(null);
  const [payMethod, setPayMethod] = useState<PayMethod>("cod");
  const [guest, setGuest] = useState({ full_name: "", phone: "", province: "Bagmati", district: "", municipality: "", ward: "", landmark: "", note: "" });
  const [note, setNote] = useState("");
  const [placing, setPlacing] = useState(false);
  const [placeError, setPlaceError] = useState("");
  const [onlineError, setOnlineError] = useState("");
  const [placed, setPlaced] = useState<{ order_code: string; total_paisa: number; payment_method: PayMethod; order_id: number } | null>(null);

  const isBuyer = auth?.type === "buyer";
  const addresses = useQuery({ queryKey: ["addresses"], queryFn: () => api2.listAddresses({}), enabled: isBuyer });
  useEffect(() => {
    if (addresses.data && addresses.data.addresses.length === 0 && !addingAddress && addressId === null) setAddingAddress(true);
  }, [addresses.data, addingAddress, addressId]);

  const baseDelivery = lines.reduce((s, l) => s + l.product.delivery_fee_paisa * l.quantity, 0);
  let deliveryFee = delivery === "pickup" ? 0 : baseDelivery + (delivery === "express" ? EXPRESS_FEE : 0);
  if (coupon?.valid && coupon.free_shipping) deliveryFee = 0;
  const discount = coupon?.valid ? coupon.discount_paisa : 0;
  const total = Math.max(0, subtotal - discount) + deliveryFee;

  const applyCoupon = useMutation({
    mutationFn: (code: string) => api2.validateCoupon({ code, subtotal_paisa: subtotal }),
    onSuccess: (r) => { setCoupon(r); if (r.valid) toast(`Coupon applied — ${money(r.discount_paisa)} off.`); },
  });
  const saveAddress = useMutation({
    mutationFn: (args: Parameters<typeof api2.saveAddress>[0]) => api2.saveAddress(args),
    onSuccess: (r) => { void queryClient.invalidateQueries({ queryKey: ["addresses"] }); setAddressId(r.id); setAddingAddress(false); toast("Address saved."); },
  });

  const addressReady = isBuyer ? addressId !== null : guest.full_name.trim().length >= 2 && guest.phone.trim().length >= 7 && guest.district.trim() && guest.municipality.trim();
  const chosenAddress = addresses.data?.addresses.find((a) => a.id === addressId) ?? null;

  async function submitOrder() {
    if (!addressReady || lines.length === 0) return;
    setPlacing(true); setPlaceError(""); setOnlineError("");
    try {
      const items = lines.map((l) => ({ product_id: l.product.id, quantity: l.quantity }));
      const result = await placeOrder({
        customer_name: isBuyer ? (chosenAddress?.full_name ?? auth!.name) : guest.full_name,
        phone: isBuyer ? (chosenAddress?.phone ?? "") : guest.phone,
        address: isBuyer ? (chosenAddress ? addressLine(chosenAddress) : "") : addressLine(guest),
        note: isBuyer ? note : guest.note,
        cod_confirmed: payMethod === "cod" ? true : undefined,
        items,
        payment_method: payMethod,
        coupon_code: coupon?.valid ? couponCode.trim().toUpperCase() : undefined,
        address_id: addressId ?? undefined,
        delivery_method: delivery,
      });
      sessionStorage.setItem("lastOrderCode", result.order_code);
      if (payMethod !== "cod") {
        try {
          const init = await api2.initiateOnlinePayment({
            order_id: result.order_id, provider: payMethod,
            phone: isBuyer ? chosenAddress?.phone : guest.phone,
          });
          clear();
          if (payMethod === "esewa") {
            const form = document.createElement("form");
            form.method = "POST"; form.action = init.payment_url;
            Object.entries(init.params ?? {}).forEach(([k, v]) => {
              const input = document.createElement("input");
              input.type = "hidden"; input.name = k; input.value = String(v ?? "");
              form.appendChild(input);
            });
            document.body.appendChild(form); form.submit();
            return; // leaving for eSewa
          }
          sessionStorage.setItem("khalti_pidx", init.pidx ?? "");
          sessionStorage.setItem("khalti_order", String(result.order_id));
          window.location.href = init.payment_url;
          return; // leaving for Khalti
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          clear();
          setPlaced({ order_code: result.order_code, total_paisa: result.total_paisa, payment_method: payMethod, order_id: result.order_id });
          setOnlineError(msg);
          setStep(5);
          return;
        }
      }
      clear();
      setPlaced({ order_code: result.order_code, total_paisa: result.total_paisa, payment_method: payMethod, order_id: result.order_id });
      setStep(5);
    } catch (e) {
      setPlaceError(e instanceof Error ? e.message : "The order could not be placed.");
    } finally {
      setPlacing(false);
    }
  }

  if (lines.length === 0 && !placed) {
    return <main className="track-page"><EmptyBlock kicker="BASKET EMPTY" title="Nothing to check out." body="Add some products to your basket first." actionLabel="Browse the shop" onAction={() => go("/shop")} /></main>;
  }

  const steps = ["Address", "Delivery", "Summary", "Payment", "Done"];
  return (
    <main className="track-page"><section className="track-intro"><p className="eyebrow">Checkout</p><h1>Almost yours.</h1></section>
      <ol className="steps">{steps.map((s, i) => <li key={s} className={step === i + 1 ? "current" : step > i + 1 ? "done" : ""}>{i + 1}. {s}</li>)}</ol>

      {step === 1 && (
        <section className="studio-section"><h2>Where should it go?</h2>
          {isBuyer ? (
            <>
              {addresses.isPending && <p className="muted">Loading your address book…</p>}
              {addresses.error && <p className="form-error">Could not load addresses.</p>}
              {addresses.data && !addingAddress && (
                <div className="addr-list">{addresses.data.addresses.map((a) => (
                  <label key={a.id} className={`addr-card${addressId === a.id ? " selected" : ""}`}>
                    <input type="radio" name="addr" checked={addressId === a.id} onChange={() => setAddressId(a.id)} />
                    <div><b>{a.label}{a.is_default ? " · Default" : ""}</b><p>{a.full_name} · {a.phone}</p><p className="muted">{addressLine(a)}</p></div>
                  </label>
                ))}</div>
              )}
              {!addingAddress ? <button className="ghost" onClick={() => setAddingAddress(true)}>+ Add a new address</button> : (
                <form className="stack-form" onSubmit={(e) => {
                  e.preventDefault(); const d = new FormData(e.currentTarget);
                  saveAddress.mutate({
                    label: String(d.get("label") ?? "Home") || "Home",
                    full_name: String(d.get("full_name") ?? ""), phone: String(d.get("phone") ?? ""),
                    province: String(d.get("province") ?? ""), district: String(d.get("district") ?? ""),
                    municipality: String(d.get("municipality") ?? ""),
                    ward: String(d.get("ward") ?? "") || undefined,
                    landmark: String(d.get("landmark") ?? "") || undefined,
                  });
                }}>
                  <label>Label<input name="label" defaultValue="Home" placeholder="Home, Office…" /></label>
                  <AddressFields prefix="" required />
                  {saveAddress.error && <p className="form-error">{saveAddress.error instanceof Error ? saveAddress.error.message : "Could not save."}</p>}
                  <div className="form-pair"><button className="primary" disabled={saveAddress.isPending}>Save address</button><button type="button" className="ghost" onClick={() => setAddingAddress(false)}>Cancel</button></div>
                </form>
              )}
              <label>Note for seller<textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anything the seller should know" /></label>
            </>
          ) : (
            <div className="stack-form">
              <AddressFields prefix="g_" required />
              <label>Note for seller<textarea value={guest.note} onChange={(e) => setGuest({ ...guest, note: e.target.value })} /></label>
              <p className="muted"><button className="linklike" onClick={() => go("/login")}>Log in</button> to save addresses for next time.</p>
            </div>
          )}
          <GuestBinder guest={guest} setGuest={setGuest} />
          <div className="step-nav"><button className="primary" disabled={!addressReady && !isBuyer} onClick={() => {
            if (isBuyer && addressId === null) {
              const def = addresses.data?.addresses.find((a) => a.is_default) ?? addresses.data?.addresses[0];
              if (def) setAddressId(def.id);
            }
            setStep(2);
          }}>Continue to delivery</button></div>
        </section>
      )}

      {step === 2 && (
        <section className="studio-section"><h2>How should it travel?</h2>
          <div className="choice-list">
            <label className={delivery === "standard" ? "selected" : ""}><input type="radio" checked={delivery === "standard"} onChange={() => setDelivery("standard")} /><div><b>Standard delivery</b><p className="muted">2–5 working days · {money(baseDelivery)}</p></div></label>
            <label className={delivery === "express" ? "selected" : ""}><input type="radio" checked={delivery === "express"} onChange={() => setDelivery("express")} /><div><b>Express delivery</b><p className="muted">1–2 working days · {money(baseDelivery + EXPRESS_FEE)} (includes {money(EXPRESS_FEE)} express fee)</p></div></label>
            <label className={delivery === "pickup" ? "selected" : ""}><input type="radio" checked={delivery === "pickup"} onChange={() => setDelivery("pickup")} /><div><b>Pick up from seller</b><p className="muted">Free · collect at {lines[0]?.product.store_location ?? "the seller's shop"}</p></div></label>
          </div>
          <div className="step-nav"><button className="ghost" onClick={() => setStep(1)}>Back</button><button className="primary" onClick={() => setStep(3)}>Continue to summary</button></div>
        </section>
      )}

      {step === 3 && (
        <section className="studio-section"><h2>Check every rupee</h2>
          <div className="order-items">{lines.map((l) => <span key={l.product.id}>{l.quantity} × {l.product.name}<b>{money(l.product.price_paisa * l.quantity)}</b></span>)}</div>
          <div className="coupon-row">
            <input aria-label="Coupon code" placeholder="Coupon code (e.g. WELCOME10)" value={couponCode} onChange={(e) => { setCouponCode(e.target.value); setCoupon(null); }} />
            <button className="ghost" disabled={!couponCode.trim() || applyCoupon.isPending} onClick={() => applyCoupon.mutate(couponCode.trim())}>{applyCoupon.isPending ? "Checking…" : "Apply"}</button>
          </div>
          {coupon && <p className={coupon.valid ? "success" : "form-error"}>{coupon.message}</p>}
          <div className="receipt">
            <span>Items <b>{money(subtotal)}</b></span>
            {discount > 0 && <span>Coupon {couponCode.trim().toUpperCase()} <b className="success">−{money(discount)}</b></span>}
            <span>Delivery ({delivery}) <b>{deliveryFee === 0 ? "Free" : money(deliveryFee)}</b></span>
            <span className="total">Total <b>{money(total)}</b></span>
          </div>
          <div className="step-nav"><button className="ghost" onClick={() => setStep(2)}>Back</button><button className="primary" onClick={() => setStep(4)}>Continue to payment</button></div>
        </section>
      )}

      {step === 4 && (
        <section className="studio-section"><h2>How will you pay?</h2>
          <div className="choice-list">
            <label className={payMethod === "cod" ? "selected" : ""}><input type="radio" checked={payMethod === "cod"} onChange={() => setPayMethod("cod")} /><div><b>Cash on delivery</b><p className="muted">Pay in cash when the parcel arrives. The order stays “Needs confirmation” until the seller accepts it.</p></div></label>
            <label className={payMethod === "esewa" ? "selected" : ""}><input type="radio" checked={payMethod === "esewa"} onChange={() => setPayMethod("esewa")} /><div><b>eSewa</b><p className="muted">Pay now through the eSewa wallet.</p></div></label>
            <label className={payMethod === "khalti" ? "selected" : ""}><input type="radio" checked={payMethod === "khalti"} onChange={() => setPayMethod("khalti")} /><div><b>Khalti</b><p className="muted">Pay now through the Khalti wallet.</p></div></label>
          </div>
          {payMethod !== "cod" && <p className="muted">You will be taken to {payMethod === "esewa" ? "eSewa" : "Khalti"} to finish the payment, then returned here.</p>}
          {payMethod === "cod" && <label className="check"><input type="checkbox" required id="cod-ok" /> I’ll respond when the seller confirms this COD order.</label>}
          {placeError && <p className="form-error">{placeError}</p>}
          <div className="step-nav"><button className="ghost" onClick={() => setStep(3)}>Back</button>
            <button className="primary" disabled={placing} onClick={submitOrder}>{placing ? "Placing order…" : `Place order · ${money(total)}`}</button></div>
        </section>
      )}

      {step === 5 && placed && (
        <section className="studio-section"><h2>{onlineError ? "Order saved — payment not finished" : "Order placed."}</h2>
          <div className="order-trail">
            <div className="order-heading"><div><p className="eyebrow">{placed.order_code}</p><h2>{onlineError ? "Needs your attention" : "Thank you"}</h2></div><strong>{money(placed.total_paisa)}</strong></div>
            {onlineError ? (
              <>
                <p className="form-error">{onlineError.replace(/^action \w+ (error|failed):\s*\d*\s*/, "").trim()}</p>
                <p>The payment step could not start, so no money moved. Your order <b>{placed.order_code}</b> is saved but not paid. Please choose <b>Cash on delivery</b> at checkout instead — your basket is untouched.</p>
                <div className="step-nav"><button className="primary" onClick={() => { setPlaced(null); setPayMethod("cod"); setStep(4); }}>Back to checkout — pay cash on delivery</button><button className="ghost" onClick={() => go("/track")}>Track the saved order</button></div>
              </>
            ) : (
              <>
                <p>{placed.payment_method === "cod" ? "The seller will confirm your COD order soon. Keep your phone nearby." : "Your online payment is being confirmed. You will hear from us shortly."}</p>
                <div className="step-nav"><button className="primary" onClick={() => go("/track")}>Track this order</button>{isBuyer && <button className="ghost" onClick={() => go("/account/orders")}>My orders</button>}</div>
              </>
            )}
          </div>
        </section>
      )}
    </main>
  );
}

// GuestBinder: syncs the uncontrolled guest address inputs into state on change.
type GuestForm = { full_name: string; phone: string; province: string; district: string; municipality: string; ward: string; landmark: string; note: string };
function GuestBinder({ guest, setGuest }: { guest: GuestForm; setGuest: Dispatch<SetStateAction<GuestForm>> }) {
  useEffect(() => {
    const handler = (e: Event) => {
      const el = e.target as HTMLInputElement;
      if (el.name?.startsWith("g_")) setGuest({ ...guest, [el.name.slice(2)]: el.value });
    };
    document.addEventListener("change", handler);
    return () => document.removeEventListener("change", handler);
  });
  return null;
}

// --- payment result -----------------------------------------------------------
export function PaymentResultPage({ query }: { query: URLSearchParams }) {
  const provider = query.get("provider");
  const orderId = Number(query.get("order_id") ?? sessionStorage.getItem("khalti_order") ?? 0);
  const esewaData = query.get("data");
  const khaltiPidx = query.get("pidx") ?? sessionStorage.getItem("khalti_pidx") ?? "";
  const [state, setState] = useState<"working" | "ok" | "fail">("working");
  const [message, setMessage] = useState("");
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return; ran.current = true;
    (async () => {
      try {
        if (!provider || !orderId) throw new Error("This page needs payment details from the wallet to verify.");
        if (provider === "esewa") {
          if (!esewaData) throw new Error("eSewa did not return payment data.");
          await api2.verifyEsewaPayment({ order_id: orderId, data: esewaData });
        } else if (provider === "khalti") {
          if (!khaltiPidx) throw new Error("Khalti did not return a payment reference.");
          await api2.verifyKhaltiPayment({ order_id: orderId, pidx: khaltiPidx });
        } else throw new Error(`Unknown payment provider “${provider}”.`);
        sessionStorage.removeItem("khalti_pidx"); sessionStorage.removeItem("khalti_order");
        setState("ok");
      } catch (e) {
        setMessage(e instanceof Error ? e.message.replace(/^action \w+ (error|failed):\s*\d*\s*/, "").trim() : "Verification failed.");
        setState("fail");
      }
    })();
  }, [provider, orderId, esewaData, khaltiPidx]);

  return (
    <main className="track-page"><section className="track-intro"><p className="eyebrow">Payment result</p><h1>{state === "working" ? "Confirming payment…" : state === "ok" ? "Payment confirmed." : "Payment not confirmed."}</h1></section>
      {state === "working" && <p className="muted">Checking with the wallet — this takes a few seconds.</p>}
      {state === "ok" && <div className="empty-state"><span>PAYMENT RECEIVED</span><h3>Your order is confirmed.</h3><p>The seller has been notified and will pack your parcel. You can follow it from the tracking page.</p><button className="primary" onClick={() => go("/track")}>Track my order</button></div>}
      {state === "fail" && <div className="empty-state"><span>PAYMENT UNCLEAR</span><h3>We could not confirm this payment.</h3><p>{message || "No money was taken according to the wallet. You can try again or choose cash on delivery."}</p><div className="step-nav"><button className="primary" onClick={() => go("/track")}>Check the order</button><button className="ghost" onClick={() => go("/help")}>Contact support</button></div></div>}
    </main>
  );
}

// --- wishlist ------------------------------------------------------------------
export function WishlistPage() {
  const { auth } = useAuth();
  const { add } = useCart();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const wish = useQuery({ queryKey: ["wishlist"], queryFn: () => api2.getWishlist({}), enabled: auth?.type === "buyer" });

  const remove = useMutation({
    mutationFn: (product_id: number) => api2.toggleWishlist({ product_id }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["wishlist"] }),
  });

  if (auth?.type !== "buyer") {
    return <main className="track-page"><EmptyBlock kicker="WISHLIST" title="Log in to keep a wishlist." body="Save products you love and we will tell you when the price drops or they come back in stock." actionLabel="Log in" onAction={() => go("/login")} /></main>;
  }
  if (wish.isPending) return <Loading text="Opening your wishlist…" />;
  if (wish.error) return <PageError error={wish.error} retry={() => wish.refetch()} />;
  const items = wish.data?.items ?? [];
  if (items.length === 0) {
    return <main className="track-page"><EmptyBlock kicker="WISHLIST" title="Nothing saved yet." body="Tap the heart on any product and it will wait for you here — with price-drop alerts." actionLabel="Browse the shop" onAction={() => go("/shop")} /></main>;
  }
  return (
    <main className="track-page wide-main"><section className="track-intro"><p className="eyebrow">Saved for later</p><h1>Your wishlist.</h1></section>
      <div className="wish-list">{items.map(({ product: p, added_price_paisa, price_changed, price_diff_paisa, in_stock }) => (
        <article key={p.id} className="wish-row">
          <button className="mini-thumb" onClick={() => go(`/product/${p.id}`)} aria-label={`View ${p.name}`}><ProductImage product={p} /></button>
          <div className="wish-main">
            <h3><button className="linklike" onClick={() => go(`/product/${p.id}`)}>{p.name}</button></h3>
            <p><strong>{money(p.price_paisa)}</strong> {p.original_price_paisa && p.original_price_paisa > p.price_paisa && <s className="was">{money(p.original_price_paisa)}</s>}</p>
            <div className="wish-signals">
              {price_changed && price_diff_paisa < 0 && <span className="signal good">Price dropped {money(-price_diff_paisa)} since you saved it</span>}
              {price_changed && price_diff_paisa > 0 && <span className="signal warn">Price is {money(price_diff_paisa)} higher than when you saved it</span>}
              {!price_changed && added_price_paisa !== p.price_paisa && <span className="signal muted-s">Saved at {money(added_price_paisa)}</span>}
              {in_stock ? <span className="signal ok">In stock</span> : <span className="signal bad">Out of stock</span>}
            </div>
          </div>
          <div className="wish-actions">
            <button className="primary" disabled={!in_stock} onClick={() => { add(p, 1); remove.mutate(p.id); toast("Moved to your basket."); }}>Move to basket</button>
            <button className="ghost" onClick={() => remove.mutate(p.id)}>Remove</button>
          </div>
        </article>
      ))}</div>
    </main>
  );
}

// --- compare ---------------------------------------------------------------------
export function ComparePage() {
  const [ids, setIds] = useState<number[]>(() => getCompareIds());
  const { toast } = useToast();
  if (ids.length < 2) {
    return <main className="track-page"><EmptyBlock kicker="COMPARE" title="Pick at least two products." body="Open any product and tap “Add to compare” — you can compare up to three side by side." actionLabel="Browse the shop" onAction={() => go("/shop")} /></main>;
  }
  return (
    <main className="track-page wide-main"><section className="track-intro"><p className="eyebrow">Side by side</p><h1>Compare products.</h1><p className="muted">Cells that differ are highlighted.</p></section>
      <CompareTable ids={ids} onRemove={(id) => { const next = toggleCompareId(id); setIds(next); toast("Removed from comparison."); }} />
    </main>
  );
}

function CompareTable({ ids, onRemove }: { ids: number[]; onRemove: (id: number) => void }) {
  const [products, setProducts] = useState<(P2Product | null)[]>(ids.map(() => null));
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    Promise.all(ids.map((id) => api2.getProductDetail({ product_id: id }).then((d) => d.product).catch(() => null)))
      .then((rows) => { if (live) { setProducts(rows); setFailed(rows.some((r) => r === null)); } });
    return () => { live = false; };
  }, [ids.join(",")]);
  const rows = products.filter((p): p is P2Product => p !== null);
  if (rows.length === 0 && !failed) return <p className="muted">Loading the comparison…</p>;
  if (rows.length === 0) return <p className="form-error">The compared products could not load.</p>;

  const cell = (label: string, values: string[]) => {
    const differ = new Set(values).size > 1;
    return (
      <tr key={label} className={differ ? "diff-row" : ""}>
        <th>{label}</th>
        {values.map((v, i) => <td key={i} className={differ ? "diff" : ""}>{v}</td>)}
      </tr>
    );
  };
  return (
    <div className="compare-wrap"><table className="compare-table">
      <thead><tr><th></th>{rows.map((p) => (
        <th key={p.id}><ProductImage product={p} /><button className="linklike" onClick={() => go(`/product/${p.id}`)}>{p.name}</button><br /><button className="linklike text-danger" onClick={() => onRemove(p.id)}>Remove</button></th>
      ))}</tr></thead>
      <tbody>
        {cell("Price", rows.map((p) => money(p.price_paisa)))}
        {cell("Discount", rows.map((p) => (p.original_price_paisa && p.original_price_paisa > p.price_paisa ? `-${p.discount_pct}% (was ${money(p.original_price_paisa)})` : "No discount")))}
        {cell("Rating", rows.map((p) => (p.rating === null ? "No reviews" : `${p.rating.toFixed(1)} ★ (${p.review_count})`)))}
        {cell("Stock", rows.map((p) => (p.stock === 0 ? "Out of stock" : `${p.stock} in stock`)))}
        {cell("Seller", rows.map((p) => `${p.store_name} · ${p.store_location}`))}
        {cell("Delivery fee", rows.map((p) => money(p.delivery_fee_paisa)))}
        {cell("Returns", rows.map(() => "7-day returns on delivered orders"))}
      </tbody>
    </table></div>
  );
}

// --- assistant ---------------------------------------------------------------------
interface ChatMsg { role: "user" | "ai"; text: string; products?: P2Product[]; comparison?: { products: P2Product[]; rows: { label: string; values: string[] }[] }; }
const EXAMPLES = [
  "Find me a phone under Rs 30,000",
  "Compare the wireless earbuds and the smart watch",
  "Show me the cheapest pashmina shawl",
];

export function AssistantPage() {
  const { add } = useCart();
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, busy]);

  const ask = async (question: string) => {
    const q = question.trim();
    if (!q || busy) return;
    setMessages((m) => [...m, { role: "user", text: q }]);
    setInput(""); setBusy(true);
    try {
      const r = await api2.askAssistant({ question: q });
      setMessages((m) => [...m, { role: "ai", text: r.answer, products: r.products, comparison: r.comparison }]);
    } catch (e) {
      setMessages((m) => [...m, { role: "ai", text: e instanceof Error ? e.message : "I could not answer that just now. Please try again." }]);
    } finally { setBusy(false); }
  };

  return (
    <main className="track-page"><section className="track-intro"><p className="eyebrow">Shopping assistant</p><h1>Ask, I’ll search.</h1><p className="muted">I only suggest products that actually exist in this market — never invented ones.</p></section>
      <div className="chat">
        {messages.length === 0 && (
          <div className="chat-hint"><p>Try one of these:</p>{EXAMPLES.map((e) => <button key={e} onClick={() => ask(e)}>“{e}”</button>)}</div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            <p>{m.text}</p>
            {m.comparison && (
              <table className="compare-table small"><thead><tr><th></th>{m.comparison.products.map((p) => <th key={p.id}><button className="linklike" onClick={() => go(`/product/${p.id}`)}>{p.name}</button></th>)}</tr></thead>
                <tbody>{m.comparison.rows.map((r) => <tr key={r.label}><th>{r.label}</th>{r.values.map((v, j) => <td key={j}>{v}</td>)}</tr>)}</tbody></table>
            )}
            {m.products && m.products.length > 0 && (
              <div className="chat-products">{m.products.map((p) => (
                <article key={p.id} className="chat-product">
                  <button className="mini-thumb" onClick={() => go(`/product/${p.id}`)} aria-label={`View ${p.name}`}><ProductImage product={p} /></button>
                  <div><b><button className="linklike" onClick={() => go(`/product/${p.id}`)}>{p.name}</button></b><p className="muted">{money(p.price_paisa)}{p.rating !== null ? ` · ${p.rating.toFixed(1)}★` : ""}</p></div>
                  <button className="ghost" disabled={p.stock === 0} onClick={() => add(p, 1)}>{p.stock === 0 ? "Out of stock" : "Add"}</button>
                </article>
              ))}</div>
            )}
          </div>
        ))}
        {busy && <div className="msg ai"><p className="muted">Searching the shelves…</p></div>}
        <div ref={bottom} />
      </div>
      <form className="chat-form" onSubmit={(e) => { e.preventDefault(); ask(input); }}>
        <input aria-label="Ask the assistant" value={input} onChange={(e) => setInput(e.target.value)} placeholder="e.g. Find me a phone under Rs 30,000" maxLength={500} />
        <button className="primary" disabled={busy || !input.trim()}>Ask</button>
      </form>
    </main>
  );
}

// --- order status labels (extended) -----------------------------------------------
export const STATUS_LABEL: Record<string, string> = {
  confirmation_needed: "Needs confirmation", confirmed: "Confirmed", packed: "Packed",
  shipped: "On the way", out_for_delivery: "Out for delivery", delivered: "Delivered",
  return_requested: "Return requested", returned: "Returned", refunded: "Refunded", cancelled: "Cancelled",
};
export const PAY_LABEL: Record<string, string> = { pending: "Payment pending", processing: "Payment processing", paid: "Paid", failed: "Payment failed", refunded: "Refunded", cancelled: "Cancelled" };

export function OrderSummaryLine({ order }: { order: { order_code: string; total_paisa: number; created_at: string } }) {
  return <p className="muted">Ordered {fmtDate(order.created_at)} · {order.order_code}</p>;
}

export function RecentViewedRow({ excludeId }: { excludeId?: number }) {
  const { auth } = useAuth();
  const { add } = useCart();
  const recent = useQuery({ queryKey: ["recently-viewed"], queryFn: () => api2.getRecentlyViewed({}), enabled: auth?.type === "buyer" });
  const items = (recent.data?.products ?? []).filter((p) => p.id !== excludeId).slice(0, 8);
  if (!items.length) return null;
  return <SectionRow title="Recently viewed" products={items} onOpen={(p) => go(`/product/${p.id}`)} onAdd={add} />;
}

// keep an unused-name-safe re-export for App's legacy imports
export type { ReactNode };
