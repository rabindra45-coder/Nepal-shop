// Phase-2 buyer screens.
import { useEffect, useMemo, useRef, useState, type Dispatch, type FormEvent, type ReactNode, type SetStateAction } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { api2, fmtDate, money, placeOrder, MARKETPLACE_TAX_NOTE, type P2Address, type P2Product } from "./phase2api";
import { useAuth, go } from "./session";
import { useCart } from "./cart";
import { CategoryCircle, EmptyBlock, Loading, PageError, ProductCard, ProductImage, SectionHead, Stars, formatSold, getCompareIds, isCompared, toggleCompareId, useToast } from "./ui";

// --- shared bits ------------------------------------------------------------
// Change-password form for buyers (api2.updateMyPassword) and sellers
// (api2.updateSellerPassword). The server signs every other session out.
export function ChangePasswordForm({ kind, extraArgs }: { kind: "buyer" | "seller"; extraArgs?: Record<string, string | undefined> }) {
  const { toast } = useToast();
  const [mismatch, setMismatch] = useState("");
  const change = useMutation({
    mutationFn: (v: { old_password: string; new_password: string }) =>
      kind === "buyer" ? api2.updateMyPassword(v) : api2.updateSellerPassword({ ...extraArgs, ...v }),
    onSuccess: () => toast("Password changed. Other devices were signed out."),
    onError: (e) => toast(e instanceof Error ? e.message : "Could not change the password.", "err"),
  });
  return (
    <section className="studio-section"><h2>Change password</h2>
      <form className="stack-form" onSubmit={(e) => { e.preventDefault(); const d = new FormData(e.currentTarget); const a = String(d.get("n1") ?? ""), b = String(d.get("n2") ?? ""); if (a !== b) { setMismatch("The two new passwords do not match."); return; } setMismatch(""); change.mutate({ old_password: String(d.get("old") ?? ""), new_password: a }); (e.target as HTMLFormElement).reset(); }}>
        <label>Current password<input name="old" type="password" required autoComplete="current-password" /></label>
        <label>New password<input name="n1" type="password" required minLength={8} autoComplete="new-password" /><small>At least 8 characters.</small></label>
        <label>Repeat new password<input name="n2" type="password" required minLength={8} autoComplete="new-password" /></label>
        {mismatch && <p className="form-error">{mismatch}</p>}
        <button className="primary" disabled={change.isPending}>{change.isPending ? "Changing…" : "Change password"}</button>
      </form>
    </section>
  );
}

// Photo gallery for the product page: main photo plus a thumbnail strip when
// the seller uploaded more than one. Falls back to the single cover image or
// the styled placeholder.
// Let shoppers flag a review that looks like spam, abuse or fakery. Reports
// land in the admin panel's Reviews queue; nothing is hidden automatically.
function ReportReviewLink({ reviewId }: { reviewId: number }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const report = useMutation({
    mutationFn: (v: { reason: "spam" | "abuse" | "fake" | "other"; detail: string; reporter_name: string }) =>
      api.reportReview({ review_id: reviewId, ...v }),
    onSuccess: () => { setOpen(false); toast("Thanks — our team will take a look."); },
    onError: (e) => toast(e instanceof Error ? e.message : "Could not send the report.", "err"),
  });
  if (!open) return <div><button className="linklike" onClick={() => setOpen(true)}><small>Report this review</small></button></div>;
  return (
    <form className="stack-form compact" onSubmit={(e) => {
      e.preventDefault();
      const d = new FormData(e.currentTarget);
      report.mutate({
        reason: String(d.get("reason")) as "spam" | "abuse" | "fake" | "other",
        detail: String(d.get("detail") ?? ""),
        reporter_name: String(d.get("name") ?? ""),
      });
    }}>
      <div className="form-pair">
        <label>Reason<select name="reason" required><option value="spam">Spam</option><option value="abuse">Abusive content</option><option value="fake">Fake review</option><option value="other">Other</option></select></label>
        <label>Your name<input name="name" required minLength={2} maxLength={60} placeholder="So we can follow up" /></label>
      </div>
      <label>What's wrong?<textarea name="detail" required minLength={8} maxLength={500} placeholder="Tell us briefly what's wrong with this review" /></label>
      <div className="form-pair">
        <button className="primary" disabled={report.isPending}>{report.isPending ? "Sending…" : "Send report"}</button>
        <button type="button" className="ghost" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </form>
  );
}

// --- product Q&A ---------------------------------------------------------------
// Signed-in buyers can ask the seller a question; answered questions are
// public. A buyer also sees their own unanswered questions as "waiting".
function ProductQA({ productId }: { productId: number }) {
  const { auth } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [q, setQ] = useState("");
  const list = useQuery({
    queryKey: ["product-questions", productId],
    queryFn: () => api.getProductQuestions({ product_id: productId }),
    staleTime: 60_000,
  });
  const ask = useMutation({
    mutationFn: (text: string) => api.askQuestion({ authToken: auth?.token ?? "", product_id: productId, question: text }),
    onSuccess: () => {
      setQ("");
      void queryClient.invalidateQueries({ queryKey: ["product-questions", productId] });
      toast("Question sent to the seller.");
    },
    onError: (e) => toast(e instanceof Error ? e.message : "Could not send the question.", "err"),
  });
  const questions = list.data?.questions ?? [];
  const visible = questions.filter((x) => x.answer || x.mine);
  return (
    <section className="reviews qa">
      <h2>Questions & answers ({visible.length})</h2>
      {list.isPending && <p className="muted">Loading questions…</p>}
      {list.error && <p className="form-error">Could not load the questions.</p>}
      {!list.isPending && !list.error && visible.length === 0 && (
        <p className="muted">No questions yet — ask the seller anything about this product.</p>
      )}
      {visible.map((x) => (
        <article key={x.id}>
          <p><b>Q:</b> {x.question}</p>
          {x.answer
            ? <p className="qa-answer"><b>A:</b> {x.answer}</p>
            : <p className="muted"><small>Waiting for the seller's answer…</small></p>}
          <small>{x.asker_name}{x.answered_at ? ` · Answered ${fmtDate(x.answered_at)}` : ""}</small>
        </article>
      ))}
      {auth?.type === "buyer" ? (
        <form className="stack-form compact" onSubmit={(e) => { e.preventDefault(); const t = q.trim(); if (t.length >= 3) ask.mutate(t); }}>
          <label>Ask the seller<textarea value={q} onChange={(e) => setQ(e.target.value)} minLength={3} maxLength={500} required placeholder="e.g. Is this compatible with…" /></label>
          <button className="primary" disabled={ask.isPending || q.trim().length < 3}>{ask.isPending ? "Sending…" : "Ask a question"}</button>
        </form>
      ) : (
        <p className="muted"><button className="linklike" onClick={() => go("/login")}>Log in</button> to ask the seller a question.</p>
      )}
    </section>
  );
}

function ProductGallery({ product }: { product: P2Product }) {
  const photos = product.images?.length ? product.images : product.image_url ? [product.image_url] : [];
  const [sel, setSel] = useState(0);
  const [zoom, setZoom] = useState(false);
  useEffect(() => { setSel(0); setZoom(false); }, [product.id]);
  // Lightbox: Escape closes; the page behind does not scroll while it is open.
  useEffect(() => {
    if (!zoom) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setZoom(false); };
    document.addEventListener("keydown", onKey);
    document.body.classList.add("drawer-open");
    return () => { document.removeEventListener("keydown", onKey); document.body.classList.remove("drawer-open"); };
  }, [zoom]);
  if (!photos.length) return <ProductImage product={product} className="big" />;
  return (
    <div className="pd-gallery">
      <div className="g-main">
        <button type="button" className="g-zoom" onClick={() => setZoom(true)} aria-label={`Open full-size photo of ${product.name}`}>
          <img src={photos[sel]} alt={product.name} decoding="async" />
        </button>
      </div>
      {photos.length > 1 && (
        <div className="g-thumbs" role="group" aria-label="Product photos">
          {photos.map((src, i) => (
            <button key={src} type="button" className={i === sel ? "sel" : ""} onClick={() => setSel(i)} aria-label={`Show photo ${i + 1} of ${photos.length}`} aria-pressed={i === sel}>
              <img src={src} alt="" loading="lazy" decoding="async" />
            </button>
          ))}
        </div>
      )}
      {product.original_price_paisa && product.original_price_paisa > product.price_paisa && <span className="off-badge">-{product.discount_pct}%</span>}
      {zoom && (
        <div className="lightbox" role="dialog" aria-modal="true" aria-label={`${product.name} photos`} onClick={() => setZoom(false)}>
          <button type="button" className="lb-close" onClick={(e) => { e.stopPropagation(); setZoom(false); }} aria-label="Close photo viewer">✕</button>
          {photos.length > 1 && (
            <>
              <button type="button" className="lb-prev" onClick={(e) => { e.stopPropagation(); setSel((s) => (s - 1 + photos.length) % photos.length); }} aria-label="Previous photo">‹</button>
              <button type="button" className="lb-next" onClick={(e) => { e.stopPropagation(); setSel((s) => (s + 1) % photos.length); }} aria-label="Next photo">›</button>
            </>
          )}
          <img className="lb-img" src={photos[sel]} alt={`${product.name} — photo ${sel + 1} of ${photos.length}`} onClick={(e) => e.stopPropagation()} />
          {photos.length > 1 && (
            <div className="lb-thumbs" role="group" aria-label="Product photos">
              {photos.map((src, i) => (
                <button key={src} type="button" className={i === sel ? "sel" : ""} onClick={(e) => { e.stopPropagation(); setSel(i); }} aria-label={`Show photo ${i + 1} of ${photos.length}`} aria-pressed={i === sel}>
                  <img src={src} alt="" loading="lazy" decoding="async" />
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// v15: modern section rail — heading with "view all", horizontal snap rail
// of modern product cards.
function SectionRow({ title, badge, products, onOpen, onAdd, viewAll, actionLabel }: {
  title: string; badge?: string; products: P2Product[]; onOpen: (p: P2Product) => void; onAdd: (p: P2Product) => void; viewAll?: () => void; actionLabel?: string;
}) {
  if (!products.length) return null;
  return (
    <section>
      <SectionHead title={badge ? `${title} ${badge}` : title} actionLabel={actionLabel ?? (viewAll ? "View all" : undefined)} onAction={viewAll} />
      <div className="m-rail">{products.map((p) => (
        <ProductCard key={p.id} product={p} onOpen={() => onOpen(p)} onAdd={onAdd} />
      ))}</div>
    </section>
  );
}

// --- homepage ---------------------------------------------------------------
// v15: modern marketplace homepage — search bar, category circles, admin
// banners, flash-sale strip, category rails, Products For You, recently
// viewed. The "FRESH MARKET / shelves are being arranged" placeholder is
// gone: when there are no products the page says so honestly instead.
export function Homepage() {
  const { auth } = useAuth();
  const { add, products } = useCart();
  const home = useQuery({ queryKey: ["homepage"], queryFn: () => api2.getHomepage({}) });
  const recent = useQuery({ queryKey: ["recently-viewed"], queryFn: () => api2.getRecentlyViewed({}), enabled: auth?.type === "buyer" });
  const open = (p: P2Product) => go(`/product/${p.id}`);
  const banners = home.data?.banners ?? [];
  const sections = home.data?.sections ?? [];
  const catSections = home.data?.category_sections ?? [];
  const flash = home.data?.flash_sales ?? [];

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of products) m.set(p.category, (m.get(p.category) ?? 0) + 1);
    return m;
  }, [products]);

  // "Products for you": real catalogue products ordered by real units sold,
  // then discount — no invented rankings.
  const forYou = useMemo(() => {
    const seen = new Set<number>();
    const all: P2Product[] = [];
    for (const s of catSections) for (const p of s.products) {
      if (!seen.has(p.id)) { seen.add(p.id); all.push(p); }
    }
    return all.sort((a, b) => (b.sold_count - a.sold_count) || (b.discount_pct - a.discount_pct)).slice(0, 8);
  }, [home.data]);

  const hasContent = banners.length > 0 || sections.length > 0 || catSections.length > 0 || flash.length > 0;

  return (
    <main>
      <div className="home-wrap">
        {/* prominent search */}
        <div className="home-search">
          <button type="button" onClick={() => go("/search")} aria-label="Search products">
            <span aria-hidden="true">🔍</span> Search for products, brands and more…
          </button>
        </div>

        {/* category circles */}
        {catSections.length > 0 && (
          <nav className="cat-strip" aria-label="Shop by category">
            {catSections.map((s) => (
              <CategoryCircle key={s.name} name={s.name}
                image={s.products[0]?.images?.[0] ?? s.products[0]?.image_url ?? null}
                count={counts.get(s.name)}
                onOpen={() => go(`/categories?category=${encodeURIComponent(s.name)}`)} />
            ))}
          </nav>
        )}

        {/* compact admin banners */}
        {banners.length > 0 && (
          <div className="home-banner-strip" role="region" aria-label="Advertisements">
            {banners.slice(0, 3).map((b, i) => (
              <a key={i} className="home-banner" href={b.link ?? "#/shop"}>
                {b.image_url ? <img src={b.image_url} alt={b.title} loading="lazy" decoding="async" /> : (
                  <span className="hero-slide-fallback" aria-hidden="true" />
                )}
              </a>
            ))}
          </div>
        )}

        {home.isPending && <p className="muted">Opening the market…</p>}
        {home.error && <p className="form-error">The homepage could not load. The shop is still open — <button className="linklike" onClick={() => go("/shop")}>browse everything</button>.</p>}

        {/* flash sale */}
        <FlashSaleStrip products={flash} onOpen={open} />

        {/* admin-configured sections */}
        {sections.map((s) => <SectionRow key={s.key} title={s.title} products={s.products} onOpen={open} onAdd={add} viewAll={() => go("/shop")} />)}

        {/* category rails */}
        {catSections.map((s) => (
          <SectionRow key={`cat-${s.name}`} title={s.name} products={s.products} onOpen={open} onAdd={add}
            viewAll={() => go(`/categories?category=${encodeURIComponent(s.name)}`)} actionLabel="View all" />
        ))}

        {/* products for you */}
        {forYou.length > 0 && (
          <section>
            <SectionHead title="Products for you" actionLabel="View all" onAction={() => go("/shop")} />
            <div className="m-grid">{forYou.map((p) => <ProductCard key={p.id} product={p} onOpen={() => open(p)} onAdd={add} />)}</div>
          </section>
        )}

        {/* recently viewed */}
        {auth?.type === "buyer" && (recent.data?.products?.length ?? 0) > 0 && (
          <SectionRow title="Recently viewed" products={recent.data!.products} onOpen={open} onAdd={add} />
        )}

        {/* honest empty state — no fabricated "fresh market" placeholder */}
        {!home.isPending && !home.error && !hasContent && (
          <EmptyBlock kicker="NEW MARKETPLACE" title="No products yet." body="Sellers are still setting up their shops. Check back soon — or open your own shop and be the first on the shelves." actionLabel="Start selling" onAction={() => go("/sell")} />
        )}

        {hasContent && (
          <div className="home-cta">
            <button className="primary" onClick={() => go("/shop")}>Browse the full catalogue</button>
          </div>
        )}
      </div>
    </main>
  );
}

// v15: flash-sale strip — real discounted products flagged by the admin, with
// a countdown to the soonest end time and a real sold-progress bar.
export function FlashSaleStrip({ products, onOpen }: { products: P2Product[]; onOpen: (p: P2Product) => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!products.length) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [products.length]);
  if (!products.length) return null;
  const ends = products.map((p) => p.flash_sale_ends_at ? new Date(p.flash_sale_ends_at).getTime() : 0).filter(Boolean);
  const nearest = ends.length ? Math.min(...ends) : 0;
  const left = Math.max(0, nearest - now);
  const hh = Math.floor(left / 3600000), mm = Math.floor((left % 3600000) / 60000), ss = Math.floor((left % 60000) / 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    <section className="flash-strip" aria-label="Flash sale">
      <div className="flash-head">
        <h2>⚡ Flash Sale</h2>
        {nearest > now ? (
          <span className="flash-timer" aria-label="Sale ends in">Ends in <b>{pad(hh)}</b>:<b>{pad(mm)}</b>:<b>{pad(ss)}</b></span>
        ) : (
          <span className="flash-timer">Limited time</span>
        )}
      </div>
      <div className="flash-rail">
        {products.map((p) => {
          const soldPct = Math.min(100, Math.round((p.sold_count / Math.max(1, p.sold_count + p.stock)) * 100));
          const img = p.images?.[0] ?? p.image_url ?? null;
          return (
            <button key={p.id} className="flash-card" onClick={() => onOpen(p)} aria-label={`Flash sale: ${p.name}`}>
              <span className="m-card-img">
                {img ? <img src={img} alt="" loading="lazy" decoding="async" /> : <span className="m-card-ph" aria-hidden="true">{p.name.slice(0, 2).toUpperCase()}</span>}
                <span className="m-off">-{p.discount_pct}%</span>
              </span>
              <span className="m-card-body">
                <span className="m-name">{p.name}</span>
                <span className="m-price-row"><span className="m-price">{money(p.price_paisa)}</span></span>
                <span className="sold-bar" aria-hidden="true"><i style={{ width: `${soldPct}%` }} /></span>
                <span className="sold-lbl">{p.sold_count > 0 ? `${formatSold(p.sold_count)}` : "Be the first to grab it"}</span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

// --- public seller store page -----------------------------------------------
export function StorePage({ code }: { code: string }) {
  const store = useQuery({ queryKey: ["store", code.toUpperCase()], queryFn: () => api.getStore({ seller_code: code }) });
  const name = store.data?.store_name;
  useEffect(() => { document.title = name ? `${name} — Nepal Shop` : "Store — Nepal Shop"; }, [name]);
  if (store.isPending) return <Loading text="Opening the store…" />;
  // Suspended, pending and unknown stores all land here with the same
  // friendly message — never revealing which of the three it was.
  if (store.error || !store.data) return (
    <main className="track-page"><div className="empty-state">
      <span>STORE UNAVAILABLE</span>
      <h3>This store is not available.</h3>
      <p>It may have been renamed, closed or suspended. Browse the full marketplace instead.</p>
      <button className="primary" onClick={() => go("/shop")}>Browse the shop</button>
    </div></main>
  );
  const s = store.data;
  return (
    <main className="track-page wide-main">
      {s.banner_url && <div className="store-banner"><img src={s.banner_url} alt="" loading="lazy" decoding="async" /></div>}
      <section className="store-intro">
        <p className="eyebrow">Seller store · {s.location}</p>
        <div className="store-title-row">
          {s.logo_url && <img className="store-logo" src={s.logo_url} alt={`${s.store_name} logo`} loading="lazy" decoding="async" />}
          <h1>{s.store_name}</h1>
        </div>
        <p>{s.tagline}</p>
        {s.vacation_mode && <p className="banner warn" role="status">This shop is on a short break — you can browse, but orders are paused for now.</p>}
        {s.description && <p className="store-desc">{s.description}</p>}
        <div className="store-meta">
          {s.verified && <span className="verified-badge">✓ Verified seller</span>}
          <Stars rating={s.rating} count={s.review_count} />
          <span className="muted">{s.product_count} product{s.product_count === 1 ? "" : "s"}</span>
        </div>
      </section>
      {s.products.length === 0 ? (
        <EmptyBlock kicker="QUIET SHELVES" title="Nothing on the shelves yet." body="This seller hasn't published any products yet." actionLabel="Browse the shop" onAction={() => go("/shop")} />
      ) : (
        <div className="product-grid">{s.products.map((p) => <SearchCard key={p.id} product={p} />)}</div>
      )}
    </main>
  );
}

// --- search ------------------------------------------------------------------
// v15: modern search — big search field with suggestions, Meesho-style
// sticky filter strip (Sort | Category | Gender | Filters) opening bottom
// sheets, modern card grid, real result counts.
type SortKey = "relevance" | "price_asc" | "price_desc" | "rating" | "newest" | "popularity" | "discount";
const SORTS: { id: SortKey; label: string }[] = [
  { id: "relevance", label: "Most relevant" }, { id: "price_asc", label: "Price: low to high" },
  { id: "price_desc", label: "Price: high to low" }, { id: "rating", label: "Top rated" },
  { id: "newest", label: "Newest" }, { id: "popularity", label: "Most popular" }, { id: "discount", label: "Biggest discount" },
];
const GENDERS: { id: string; label: string }[] = [
  { id: "", label: "Everyone" }, { id: "women", label: "Women" }, { id: "men", label: "Men" },
  { id: "kids", label: "Kids" }, { id: "unisex", label: "Unisex" },
];
const PAGE = 24;

export function SearchPage({ initialQuery, initialCategory, kicker, heading }: { initialQuery: string; initialCategory: string; kicker?: string; heading?: string }) {
  const { products } = useCart();
  const [q, setQ] = useState(initialQuery);
  const [committed, setCommitted] = useState(initialQuery);
  const [category, setCategory] = useState(initialCategory);
  const [brand, setBrand] = useState("");
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [minRating, setMinRating] = useState("0");
  const [inStock, setInStock] = useState(false);
  const [onSale, setOnSale] = useState(false);
  const [seller, setSeller] = useState("");
  const [gender, setGender] = useState("");
  const [sort, setSort] = useState<SortKey>("relevance");
  const [page, setPage] = useState(0);
  const [showSug, setShowSug] = useState(false);
  const [sheet, setSheet] = useState<null | "sort" | "category" | "gender" | "filters">(null);
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
    seller_code: seller || undefined, gender: gender as "men" | "women" | "kids" | "unisex" | undefined || undefined, sort,
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
  const activeFilters = [category, brand.trim(), minPrice, maxPrice, Number(minRating) > 0 ? `${minRating}★+` : "", inStock ? "In stock" : "", onSale ? "On sale" : "", seller, gender].filter(Boolean).length;
  const clearAll = () => {
    setCategory(""); setBrand(""); setMinPrice(""); setMaxPrice(""); setMinRating("0");
    setInStock(false); setOnSale(false); setSeller(""); setGender(""); setSort("relevance"); setPage(0);
  };
  const sortLabel = SORTS.find((s) => s.id === sort)?.label ?? "Sort";
  const closeSheet = () => setSheet(null);

  return (
    <main className="track-page wide-main">
      <section className="track-intro"><p className="eyebrow">{kicker ?? "Search the market"}</p><h1>{heading ?? "Find it here."}</h1></section>
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

      {/* v15: Meesho-style sticky strip */}
      <div className="filter-strip" role="toolbar" aria-label="Search filters">
        <button type="button" className={`fbtn${sheet === "sort" ? " active" : ""}`} onClick={() => setSheet(sheet === "sort" ? null : "sort")}>⇅ {sortLabel}</button>
        <button type="button" className={`fbtn${sheet === "category" ? " active" : ""}${category ? " active" : ""}`} onClick={() => setSheet(sheet === "category" ? null : "category")}>{category || "Category"}</button>
        <button type="button" className={`fbtn${sheet === "gender" ? " active" : ""}${gender ? " active" : ""}`} onClick={() => setSheet(sheet === "gender" ? null : "gender")}>{GENDERS.find((g) => g.id === gender)?.label ?? "Gender"}</button>
        <button type="button" className={`fbtn${sheet === "filters" ? " active" : ""}${activeFilters > 0 ? " active" : ""}`} onClick={() => setSheet(sheet === "filters" ? null : "filters")}>⧩ Filters{activeFilters > 0 ? ` (${activeFilters})` : ""}</button>
        {activeFilters > 0 && <button type="button" className="fbtn" onClick={clearAll}>✕ Clear</button>}
      </div>

      {sheet && <div className="fbackdrop" onClick={closeSheet} aria-hidden="true" />}
      {sheet === "sort" && (
        <div className="fsheet" role="dialog" aria-label="Sort results">
          <h3>Sort by</h3>
          {SORTS.map((s) => (
            <div className="row" key={s.id}>
              <span>{s.label}</span>
              <input type="radio" name="sort" checked={sort === s.id} onChange={() => { setSort(s.id); closeSheet(); }} aria-label={s.label} />
            </div>
          ))}
        </div>
      )}
      {sheet === "category" && (
        <div className="fsheet" role="dialog" aria-label="Choose category">
          <h3>Category</h3>
          {[["", "All categories"] as [string, string], ...categories.map((c) => [c, c] as [string, string])].map(([id, label]) => (
            <div className="row" key={id || "all"}>
              <span>{label}</span>
              <input type="radio" name="cat" checked={category === id} onChange={() => { setCategory(id); setPage(0); closeSheet(); }} aria-label={label} />
            </div>
          ))}
        </div>
      )}
      {sheet === "gender" && (
        <div className="fsheet" role="dialog" aria-label="Choose gender">
          <h3>Gender</h3>
          {GENDERS.map((g) => (
            <div className="row" key={g.id || "all"}>
              <span>{g.label}</span>
              <input type="radio" name="gender" checked={gender === g.id} onChange={() => { setGender(g.id); setPage(0); closeSheet(); }} aria-label={g.label} />
            </div>
          ))}
        </div>
      )}
      {sheet === "filters" && (
        <div className="fsheet" role="dialog" aria-label="More filters">
          <h3>Filters</h3>
          <div className="row"><span>Brand</span><input list="brand-list" value={brand} onChange={(e) => setBrand(e.target.value)} placeholder="Any brand" /><datalist id="brand-list">{brands.map((b) => <option key={b} value={b} />)}</datalist></div>
          <div className="row"><span>Min Rs</span><input type="number" min={0} value={minPrice} onChange={(e) => setMinPrice(e.target.value)} /></div>
          <div className="row"><span>Max Rs</span><input type="number" min={0} value={maxPrice} onChange={(e) => setMaxPrice(e.target.value)} /></div>
          <div className="row"><span>Rating</span><select value={minRating} onChange={(e) => setMinRating(e.target.value)}><option value="0">Any</option><option value="3">3★+</option><option value="4">4★+</option><option value="4.5">4.5★+</option></select></div>
          <div className="row"><span>Seller</span><select value={seller} onChange={(e) => setSeller(e.target.value)}><option value="">All sellers</option>{sellers.map(([code, name]) => <option key={code} value={code}>{name}</option>)}</select></div>
          <div className="row"><span>In stock only</span><input type="checkbox" checked={inStock} onChange={(e) => setInStock(e.target.checked)} aria-label="In stock only" /></div>
          <div className="row"><span>On sale only</span><input type="checkbox" checked={onSale} onChange={(e) => setOnSale(e.target.checked)} aria-label="On sale only" /></div>
          <div className="fsheet-actions">
            <button type="button" className="ghost" onClick={() => { clearAll(); closeSheet(); }}>Clear all</button>
            <button type="button" className="primary" onClick={() => { setPage(0); closeSheet(); }}>Apply</button>
          </div>
        </div>
      )}

      {search.isPending ? <p className="muted">Searching…</p> :
        search.error ? <p className="form-error">Search failed. Please try again.</p> :
          <>
            <p className="muted result-count">{total} result{total === 1 ? "" : "s"}{committed ? <> for “<b>{committed}</b>”</> : ""}</p>
            {results.length === 0 ? (
              <EmptyBlock kicker="NO MATCHES" title="Nothing found." body="Try a different spelling, a shorter word, or clear the filters — every token is matched against names, brands and categories." />
            ) : (
              <div className="m-grid">{results.map((p) => <SearchCard key={p.id} product={p} />)}</div>
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

// --- v15: dedicated category browsing ---------------------------------------
// Sidebar of real categories (with live product counts) plus a product grid
// for the selected category. `/categories?category=X` deep-links a category.
export function CategoriesPage({ initialCategory }: { initialCategory: string }) {
  const { products } = useCart();
  const { add } = useCart();
  const cats = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of products) m.set(p.category, (m.get(p.category) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [products]);
  const [cat, setCat] = useState(initialCategory);
  useEffect(() => { setCat(initialCategory); }, [initialCategory]);
  const active = cat || cats[0]?.[0] || "";
  const list = useMemo(() => products.filter((p) => p.category === active), [products, active]);

  return (
    <main className="cats-page">
      <nav className="cats-side" aria-label="Categories">
        {cats.map(([name, count]) => (
          <button key={name} type="button" className={name === active ? "active" : ""} onClick={() => setCat(name)}>
            {name} <span className="muted">({count})</span>
          </button>
        ))}
        {cats.length === 0 && <p className="muted">No categories yet.</p>}
      </nav>
      <div className="cats-main">
        <SectionHead title={active || "Categories"} />
        {list.length === 0 ? (
          <EmptyBlock kicker="EMPTY CATEGORY" title="Nothing here yet." body="No approved products in this category right now — try another one." actionLabel="Browse everything" onAction={() => go("/shop")} />
        ) : (
          <div className="m-grid">{list.map((p) => <ProductCard key={p.id} product={p} onOpen={() => go(`/product/${p.id}`)} onAdd={add} />)}</div>
        )}
      </div>
    </main>
  );
}

// --- product detail ----------------------------------------------------------
export function ProductPage({ id }: { id: number }) {
  const { auth } = useAuth();
  const { add } = useCart();
  const { toast } = useToast();
  const [qty, setQty] = useState(1);
  const [variantId, setVariantId] = useState(0);
  useEffect(() => { setQty(1); setVariantId(0); }, [id]);
  const detail = useQuery({ queryKey: ["product-detail", id], queryFn: () => api2.getProductDetail({ product_id: id }) });
  const wishlist = useQuery({ queryKey: ["wishlist"], queryFn: () => api2.getWishlist({}), enabled: auth?.type === "buyer" });
  const queryClient = useQueryClient();
  const [compared, setCompared] = useState(() => isCompared(id));
  const productName = detail.data?.product.name;
  useEffect(() => { document.title = productName ? `${productName} — Nepal Shop` : "Product — Nepal Shop"; }, [productName]);
  // Per-product meta description for search results (real catalogue text only).
  useEffect(() => {
    const desc = detail.data?.product.description?.slice(0, 155);
    let el = document.querySelector('meta[name="description"]') as HTMLMetaElement | null;
    if (desc) {
      if (!el) { el = document.createElement("meta"); el.name = "description"; document.head.appendChild(el); }
      el.content = desc;
    }
  }, [detail.data]);
  // AI recommendations (Gemini when configured, honest rule-based picks
  // otherwise — the server labels which). Cached per product for 5 minutes.
  const recs = useQuery({
    queryKey: ["ai-recs", id],
    queryFn: () => api2.getProductRecommendations({ product_id: id }),
    staleTime: 5 * 60 * 1000,
  });

  const toggleWish = useMutation({
    mutationFn: () => api2.toggleWishlist({ product_id: id }),
    onSuccess: (r) => { void queryClient.invalidateQueries({ queryKey: ["wishlist"] }); toast(r.wishlisted ? "Saved to your wishlist." : "Removed from your wishlist."); },
    onError: () => toast("Please log in to use the wishlist.", "err"),
  });

  if (detail.isPending) return <Loading text="Opening the product…" />;
  if (detail.error || !detail.data) return <PageError error={detail.error} retry={() => detail.refetch()} />;
  const { product: p, variants, specs, reviews, frequently_bought_together: fbt, seller } = detail.data;
  const wishlisted = wishlist.data?.items.some((i) => i.product.id === id) ?? false;
  const deliveryNote = "2–5 working days · Standard";
  const expressNote = "1–2 working days · Express (+Rs 120)";

  const variant = variants.find((v) => v.id === variantId) ?? null;
  const unitPrice = variant?.price_paisa ?? p.price_paisa;
  const avail = variant ? variant.stock : p.stock;
  const cartVariant = variant ? { id: variant.id, label: variant.label, unitPrice, stock: variant.stock } : undefined;
  const variantName = variant ? `${p.name} (${variant.label})` : p.name;

  const buyNow = () => { add(p, qty, cartVariant); go("/checkout"); };
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
      <script type="application/ld+json">{JSON.stringify({
        "@context": "https://schema.org", "@type": "Product",
        name: p.name, description: p.description, category: p.category,
        brand: p.brand ?? undefined, image: p.images?.length ? p.images : p.image_url ?? undefined,
        offers: {
          "@type": "Offer", priceCurrency: "NPR", price: String(Math.round(p.price_paisa / 100)),
          availability: p.stock > 0 ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
        },
        aggregateRating: p.rating !== null ? { "@type": "AggregateRating", ratingValue: Number(p.rating.toFixed(1)), reviewCount: p.review_count } : undefined,
      })}</script>
      <button className="linklike back" onClick={() => window.history.length > 1 ? window.history.back() : go("/shop")}>← Back</button>
      <nav aria-label="Breadcrumb" className="crumbs">
        <button className="linklike" onClick={() => go("/")}>Home</button>
        <span aria-hidden="true"> › </span>
        <button className="linklike" onClick={() => go(`/search?category=${encodeURIComponent(p.category)}`)}>{p.category}</button>
        <span aria-hidden="true"> › </span>
        <span aria-current="page">{p.name}</span>
      </nav>
      <script type="application/ld+json">{JSON.stringify({
        "@context": "https://schema.org", "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: "https://nepal-shop-2.onrender.com/" },
          { "@type": "ListItem", position: 2, name: p.category },
          { "@type": "ListItem", position: 3, name: p.name },
        ],
      })}</script>
      <div className="pd-grid">
        <ProductGallery product={p} />
        <div className="pd-info">
          <p className="eyebrow">{p.category}{p.brand ? ` · ${p.brand}` : ""}</p>
          <h1>{p.name}</h1>
          <Stars rating={p.rating} count={p.review_count} />
          <div className="pd-price">
            {/* v15: discount badge + real units sold next to the price */}
            <strong className="pp-price">{money(unitPrice)}</strong>
            {p.original_price_paisa && p.original_price_paisa > p.price_paisa && !variant && (
              <><s className="was">{money(p.original_price_paisa)}</s> <span className="pp-off">-{p.discount_pct}%</span></>
            )}
            {p.sold_count > 0 && <span className="pp-sold">{formatSold(p.sold_count)}</span>}
          </div>
          <p className="muted tax-note">{MARKETPLACE_TAX_NOTE}</p>
          {variants.length > 0 && (
            <div className="variant-picker">
              <p className="variant-label">Choose an option</p>
              <div className="variant-options" role="radiogroup" aria-label="Choose a product option">
                <button type="button" role="radio" aria-checked={variantId === 0} className={variantId === 0 ? "variant-option selected" : "variant-option"} onClick={() => { setVariantId(0); setQty(1); }}>Standard</button>
                {variants.map((v) => (
                  <button key={v.id} type="button" role="radio" aria-checked={variantId === v.id} disabled={v.stock === 0}
                    className={variantId === v.id ? "variant-option selected" : "variant-option"}
                    onClick={() => { setVariantId(v.id); setQty(1); }} title={v.stock === 0 ? "Out of stock" : `${v.label}`}>
                    {v.label}{v.price_paisa !== null && v.price_paisa !== p.price_paisa && <span className="variant-price">{money(v.price_paisa)}</span>}
                  </button>
                ))}
              </div>
              {variant && <p className="muted">{variant.sku ? `SKU ${variant.sku} · ` : ""}{variant.stock > 0 ? `${variant.stock} in stock` : "Out of stock"}</p>}
            </div>
          )}
          <p className={avail === 0 ? "stock-out" : p.low_stock && !variant ? "stock-low" : "muted"}>
            {avail === 0 ? "Out of stock" : p.low_stock && !variant ? `Only ${avail} left — order soon` : `${avail} in stock`}
          </p>
          <div className="pd-actions">
            <div className="quantity"><button onClick={() => setQty((n) => Math.max(1, n - 1))} disabled={qty <= 1} aria-label="Decrease quantity">−</button><span>{qty}</span><button onClick={() => setQty((n) => Math.min(avail, n + 1))} disabled={qty >= avail || avail === 0} aria-label="Increase quantity">+</button></div>
            <button className="primary" disabled={avail === 0} onClick={() => { add(p, qty, cartVariant); toast(`${variantName} added to your basket.`); }}>Add to basket</button>
            <button className="ghost" disabled={avail === 0} onClick={buyNow}>Buy now</button>
          </div>
          <div className="pd-tools">
            <button className={wishlisted ? "tool active" : "tool"} onClick={() => toggleWish.mutate()} aria-label="Toggle wishlist" title={auth?.type === "buyer" ? "Wishlist" : "Log in to use the wishlist"}>♥ {wishlisted ? "Saved" : "Wishlist"}</button>
            <button className={compared ? "tool active" : "tool"} onClick={() => setCompared(toggleCompareId(id).includes(id))} title="Compare with up to 2 more products">{compared ? "✓ Comparing" : "Add to compare"}</button>
            <button className="tool" onClick={share}>Share</button>
          </div>
          <div className="pd-meta">
            <span>🚚 {deliveryNote}</span>
            <span>⚡ {expressNote}</span>
            <span>↩ 30-day returns on delivered orders</span>
          </div>
          <div className="seller-card">
            <div><h3>{seller.store_name}</h3><p className="muted">{seller.location} · {seller.product_count} products</p>
              {seller.rating !== null && <Stars rating={seller.rating} />}
              <p><button className="linklike" onClick={() => go(`/store/${p.seller_code}`)}>Visit this store →</button></p>
            </div>
            {seller.verified && <span className="verified-badge">✓ Verified seller</span>}
          </div>
        </div>
      </div>

      <section className="pd-desc"><h2>About this product</h2><p>{p.description}</p></section>

      {specs.length > 0 && <section className="pd-specs"><h2>Specifications</h2><dl className="spec-table">{specs.map((s) => <div key={s.id}><dt>{s.label}</dt><dd>{s.value}</dd></div>)}</dl></section>}

      <section className="reviews"><h2>Verified buyers ({reviews.length})</h2>
        {reviews.length === 0 ? <p className="muted">No delivered-buyer reviews yet.</p> :
          reviews.map((r) => <article key={r.id}><b>{"★".repeat(r.rating)}{"☆".repeat(5 - r.rating)}</b><p>{r.body}</p><small>{r.reviewer_name} · {fmtDate(r.created_at)}</small><ReportReviewLink reviewId={r.id} /></article>)}
        <button className="linklike" onClick={() => go("/track")}>Bought this? Write a verified review from your order page →</button>
      </section>

      <ProductQA productId={p.id} />

      {fbt.length > 0 && <SectionRow title="Frequently bought together" products={fbt} onOpen={(x) => go(`/product/${x.id}`)} onAdd={add} />}
      {recs.data && recs.data.products.length > 0 && (
        <SectionRow
          title="Recommended for you"
          badge={recs.data.source === "ai" ? "✨ AI picks" : undefined}
          products={recs.data.products}
          onOpen={(x) => go(`/product/${x.id}`)}
          onAdd={add}
        />
      )}
      {auth?.type === "buyer" && <RecentViewedRow excludeId={p.id} />}

      <div className="sticky-buy">
        <div><strong>{money(unitPrice)}</strong><small>{avail > 0 ? `${avail} in stock` : "Out of stock"}</small></div>
        <button className="primary" disabled={avail === 0} onClick={() => { add(p, qty, cartVariant); toast("Added to your basket."); }}>Add to basket</button>
        <button className="ghost" onClick={() => go("/cart")}>Basket</button>
      </div>
    </main>
  );
}

// --- cart --------------------------------------------------------------------
export function CartPage() {
  const { lines, count, subtotal, setQty, remove, cartError, dismissCartError, add, products } = useCart();
  const { auth } = useAuth();
  if (lines.length === 0) {
    // v15: an empty basket shows "Just for you" — real trending products
    // (by real units sold), never invented.
    const picks = [...products].sort((a, b) => b.sold_count - a.sold_count).slice(0, 8);
    return (
      <main className="track-page">
        <EmptyBlock kicker="BASKET EMPTY" title="Your basket is empty." body="Fill it with something local — verified sellers, honest prices, cash on delivery." actionLabel="Browse the shop" onAction={() => go("/shop")} />
        {picks.length > 0 && (
          <section>
            <SectionHead title="Just for you" actionLabel="View all" onAction={() => go("/shop")} />
            <div className="m-grid">{picks.map((p) => <ProductCard key={p.id} product={p} onOpen={() => go(`/product/${p.id}`)} onAdd={add} />)}</div>
          </section>
        )}
      </main>
    );
  }
  const delivery = lines.reduce((s, l) => s + l.product.delivery_fee_paisa * l.quantity, 0);
  return (
    <main className="track-page"><section className="track-intro"><p className="eyebrow">Your basket</p><h1>{count} item{count === 1 ? "" : "s"}.</h1>
      {auth?.type !== "buyer" && <p><button className="linklike" onClick={() => go("/login")}>Log in</button> to keep this basket on every device.</p>}</section>
      {cartError && <p className="form-error banner" role="alert">{cartError} <button className="linklike" onClick={dismissCartError}>Dismiss</button></p>}
      <div className="cart-lines">{lines.map((line) => {
        const { product: p, quantity, variantId, variantLabel, unitPrice, stock } = line;
        return (
          <div className="cart-line" key={`${p.id}:${variantId}`}>
            <button className="mini-thumb" onClick={() => go(`/product/${p.id}`)} aria-label={`View ${p.name}`}><ProductImage product={p} /></button>
            <div><b>{p.name}</b>{variantLabel && <small>Option: {variantLabel}</small>}<small>{money(unitPrice)} each · {p.store_name}</small></div>
            <div className="quantity small">
              <button onClick={() => setQty(p.id, quantity - 1, variantId)} aria-label="Decrease">−</button>
              <span>{quantity}</span>
              <button onClick={() => setQty(p.id, quantity + 1, variantId)} disabled={quantity >= stock} aria-label="Increase">+</button>
            </div>
            <b>{money(unitPrice * quantity)}</b>
            <button className="linklike text-danger" onClick={() => remove(p.id, variantId)}>Remove</button>
          </div>
        );
      })}</div>
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
const EXPRESS_FEE_FALLBACK = 12000; // paisa = Rs 120; the live value comes from getShippingMethods

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
  const [codConfirmed, setCodConfirmed] = useState(false);
  const [guest, setGuest] = useState({ full_name: "", phone: "", province: "Bagmati", district: "", municipality: "", ward: "", landmark: "", note: "" });
  const [note, setNote] = useState("");
  const [placing, setPlacing] = useState(false);
  const [placeError, setPlaceError] = useState("");
  const [onlineError, setOnlineError] = useState("");
  const [placed, setPlaced] = useState<{ order_code: string; group_code: string; group_id: number; total_paisa: number; payment_method: PayMethod; order_id: number; orders: { order_id: number; order_code: string; store_name: string; total_paisa: number }[] } | null>(null);
  // Idempotency key: generated once per checkout attempt and reused across
  // retries, so double-tapping "Place order" (or a refresh mid-submit) can
  // only ever create one order group.
  const idempotencyKey = useRef("");

  const isBuyer = auth?.type === "buyer";
  const addresses = useQuery({ queryKey: ["addresses"], queryFn: () => api2.listAddresses({}), enabled: isBuyer });
  // Analytics: record one checkout-start event per buyer per visit. The
  // server validates the session and dedupes (one per 6 hours); failures
  // are swallowed so tracking never breaks checkout.
  const checkoutTracked = useRef(false);
  useEffect(() => {
    if (isBuyer && !checkoutTracked.current) {
      checkoutTracked.current = true;
      void api2.trackCheckoutStart({}).catch(() => {});
    }
  }, [isBuyer]);
  useEffect(() => {
    if (addresses.data && addresses.data.addresses.length === 0 && !addingAddress && addressId === null) setAddingAddress(true);
  }, [addresses.data, addingAddress, addressId]);

  const baseDelivery = lines.reduce((s, l) => s + l.product.delivery_fee_paisa * l.quantity, 0);
  const sellerCount = new Set(lines.map((l) => l.product.store_id)).size;
  const pickupPoints = [...new Set(lines.map((l) => l.product.store_location).filter(Boolean))];
  // Delivery methods and the express surcharge are admin-configurable on
  // the server; the estimate below mirrors the server's authoritative
  // total. Disabled methods are hidden from the list.
  const shipMethods = useQuery({ queryKey: ["shipping-methods"], queryFn: () => api2.getShippingMethods({}), staleTime: 60_000 });
  const expressFee = shipMethods.data?.express_fee_paisa ?? EXPRESS_FEE_FALLBACK;
  const enabledDelivery = new Set<DeliveryKind>(shipMethods.data ? shipMethods.data.methods.filter((m) => m.enabled).map((m) => m.id) : ["standard", "express", "pickup"]);
  useEffect(() => {
    if (shipMethods.data && !enabledDelivery.has(delivery)) {
      const first = shipMethods.data.methods.find((m) => m.enabled)?.id ?? "standard";
      setDelivery(first);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shipMethods.data]);
  // The express surcharge applies per seller: each seller ships their own
  // parcel. The estimate matches the server's authoritative total.
  let deliveryFee = delivery === "pickup" ? 0 : baseDelivery + (delivery === "express" ? expressFee * sellerCount : 0);
  if (coupon?.valid && coupon.free_shipping) deliveryFee = 0;
  const discount = coupon?.valid ? coupon.discount_paisa : 0;
  const total = Math.max(0, subtotal - discount) + deliveryFee;
  // Per-seller breakdown for the summary step, so multi-seller baskets read
  // clearly: each seller ships (and is paid for) separately.
  const sellerBreakdown = useMemo(() => {
    const by = new Map<number, { store_name: string; store_location: string; subtotal: number; items: number }>();
    for (const l of lines) {
      const e = by.get(l.product.store_id) ?? { store_name: l.product.store_name, store_location: l.product.store_location, subtotal: 0, items: 0 };
      e.subtotal += l.unitPrice * l.quantity; e.items += l.quantity; by.set(l.product.store_id, e);
    }
    return [...by.values()];
  }, [lines]);

  const applyCoupon = useMutation({
    // Guests have no account, so the phone number is their identity for the
    // per-user coupon limit — send it so the preview is honest.
    mutationFn: (code: string) => api2.validateCoupon({ code, subtotal_paisa: subtotal, phone: isBuyer ? undefined : guest.phone.trim() || undefined }),
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
      if (!idempotencyKey.current) idempotencyKey.current = crypto.randomUUID();
      const items = lines.map((l) => ({ product_id: l.product.id, quantity: l.quantity, variant_id: l.variantId }));
      const result = await placeOrder({
        customer_name: isBuyer ? (chosenAddress?.full_name ?? auth!.name) : guest.full_name,
        phone: isBuyer ? (chosenAddress?.phone ?? "") : guest.phone,
        address: isBuyer ? (chosenAddress ? addressLine(chosenAddress) : "") : addressLine(guest),
        note: isBuyer ? note : guest.note,
        cod_confirmed: payMethod === "cod" ? codConfirmed : undefined,
        items,
        payment_method: payMethod,
        coupon_code: coupon?.valid ? couponCode.trim().toUpperCase() : undefined,
        address_id: addressId ?? undefined,
        delivery_method: delivery,
        idempotency_key: idempotencyKey.current,
      });
      const placedGroup = { order_code: result.group_code, group_code: result.group_code, group_id: result.group_id, total_paisa: result.total_paisa, payment_method: payMethod, order_id: result.order_id, orders: result.orders };
      // The customer-facing order code is the group code — one checkout, one
      // code, even when several sellers fulfil it.
      sessionStorage.setItem("lastOrderCode", result.group_code);
      if (payMethod !== "cod") {
        try {
          const init = await api2.initiateOnlinePayment({
            group_id: result.group_id, provider: payMethod,
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
          sessionStorage.setItem("khalti_group", String(result.group_id));
          window.location.href = init.payment_url;
          return; // leaving for Khalti
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          // The order is saved; only the wallet handoff failed. Keep the
          // basket intact so the buyer can retry or switch to COD.
          setPlaced(placedGroup);
          setOnlineError(msg);
          setStep(5);
          return;
        }
      }
      clear();
      setPlaced(placedGroup);
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
            {enabledDelivery.has("standard") && (
            <label className={delivery === "standard" ? "selected" : ""}><input type="radio" checked={delivery === "standard"} onChange={() => setDelivery("standard")} /><div><b>Standard delivery</b><p className="muted">2–5 working days · {money(baseDelivery)}</p></div></label>
            )}
            {enabledDelivery.has("express") && (
            <label className={delivery === "express" ? "selected" : ""}><input type="radio" checked={delivery === "express"} onChange={() => setDelivery("express")} /><div><b>Express delivery</b><p className="muted">1–2 working days · {money(baseDelivery + expressFee * sellerCount)} (includes {money(expressFee)} express fee{sellerCount > 1 ? " per seller" : ""})</p></div></label>
            )}
            {enabledDelivery.has("pickup") && (
            <label className={delivery === "pickup" ? "selected" : ""}><input type="radio" checked={delivery === "pickup"} onChange={() => setDelivery("pickup")} /><div><b>Pick up from seller</b><p className="muted">Free · collect at {pickupPoints.length > 1 ? pickupPoints.join(" and ") : (pickupPoints[0] ?? "the seller's shop")}{sellerCount > 1 ? " (each seller separately)" : ""}</p></div></label>
            )}
          </div>
          <p className="muted">Sellers ship with their own couriers and add the tracking number once your parcel is on its way.</p>
          <div className="step-nav"><button className="ghost" onClick={() => setStep(1)}>Back</button><button className="primary" onClick={() => setStep(3)}>Continue to summary</button></div>
        </section>
      )}

      {step === 3 && (
        <section className="studio-section"><h2>Check every rupee</h2>
          <div className="order-items">{lines.map((l) => <span key={`${l.product.id}:${l.variantId}`}>{l.quantity} × {l.product.name}{l.variantLabel ? ` (${l.variantLabel})` : ""}<b>{money(l.unitPrice * l.quantity)}</b></span>)}</div>
          {sellerBreakdown.length > 1 && (
            <div className="seller-split"><p className="muted">Your basket spans {sellerBreakdown.length} sellers — each ships its own parcel:</p>
              <div className="order-items">{sellerBreakdown.map((s) => <span key={s.store_name}>{s.store_name} · {s.items} item{s.items === 1 ? "" : "s"}<b>{money(s.subtotal)}</b></span>)}</div>
            </div>
          )}
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
          <p className="muted tax-note">{MARKETPLACE_TAX_NOTE}</p>
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
          {payMethod === "cod" && <label className="check"><input type="checkbox" id="cod-ok" checked={codConfirmed} onChange={(e) => setCodConfirmed(e.target.checked)} /> I’ll respond when the seller confirms this COD order.</label>}
          {placeError && <p className="form-error">{placeError}</p>}
          <div className="step-nav"><button className="ghost" onClick={() => setStep(3)}>Back</button>
            <button className="primary" disabled={placing || (payMethod === "cod" && !codConfirmed)} onClick={submitOrder}>{placing ? "Placing order…" : `Place order · ${money(total)}`}</button></div>
        </section>
      )}

      {step === 5 && placed && (
        <section className="studio-section"><h2>{onlineError ? "Order saved — payment not finished" : "Order placed."}</h2>
          <div className="order-trail">
            <div className="order-heading"><div><p className="eyebrow">{placed.group_code}</p><h2>{onlineError ? "Needs your attention" : "Thank you"}</h2></div><strong>{money(placed.total_paisa)}</strong></div>
            {placed.orders.length > 1 && (
              <div className="order-items">{placed.orders.map((o) => <span key={o.order_id}>{o.store_name} · {o.order_code}<b>{money(o.total_paisa)}</b></span>)}</div>
            )}
            {onlineError ? (
              <>
                <p className="form-error">{onlineError.replace(/^action \w+ (error|failed):\s*\d*\s*/, "").trim()}</p>
                <p>The payment step could not start, so no money moved. Your order <b>{placed.group_code}</b> is saved but not paid, and your basket is untouched. You can retry the wallet payment for this order, or cancel it and check out again with Cash on delivery.</p>
                <div className="step-nav">
                  <button className="primary" disabled={placing} onClick={async () => {
                    setPlacing(true); setOnlineError("");
                    try {
                      const init = await api2.initiateOnlinePayment({ group_id: placed.group_id, provider: placed.payment_method === "cod" ? "esewa" : placed.payment_method, phone: isBuyer ? chosenAddress?.phone : guest.phone });
                      if (placed.payment_method === "esewa") {
                        const form = document.createElement("form");
                        form.method = "POST"; form.action = init.payment_url;
                        Object.entries(init.params ?? {}).forEach(([k, v]) => {
                          const input = document.createElement("input");
                          input.type = "hidden"; input.name = k; input.value = String(v ?? "");
                          form.appendChild(input);
                        });
                        document.body.appendChild(form); form.submit(); return;
                      }
                      sessionStorage.setItem("khalti_pidx", init.pidx ?? "");
                      sessionStorage.setItem("khalti_group", String(placed.group_id));
                      window.location.href = init.payment_url;
                    } catch (e) {
                      setOnlineError(e instanceof Error ? e.message : "The payment could not be started.");
                    } finally { setPlacing(false); }
                  }}>{placing ? "Starting…" : `Retry ${placed.payment_method === "esewa" ? "eSewa" : "Khalti"} payment`}</button>
                  <button className="ghost text-danger" disabled={placing} onClick={async () => {
                    setPlacing(true);
                    try {
                      await api2.cancelOrder({ group_code: placed.group_code, phone: isBuyer ? undefined : guest.phone });
                      toast("Order cancelled. Your basket is ready for a fresh checkout.");
                      setPlaced(null); idempotencyKey.current = ""; setStep(1);
                    } catch (e) {
                      setOnlineError(e instanceof Error ? e.message : "Could not cancel the order.");
                    } finally { setPlacing(false); }
                  }}>Cancel order, keep basket</button>
                  <button className="ghost" onClick={() => go("/track")}>Track the saved order</button>
                </div>
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
  // The wallet redirects carry the order GROUP id (one checkout = one
  // payment). Older links may still carry order_id or session keys.
  const groupId = Number(query.get("group_id") ?? sessionStorage.getItem("khalti_group") ?? query.get("order_id") ?? sessionStorage.getItem("khalti_order") ?? 0);
  const esewaData = query.get("data");
  const khaltiPidx = query.get("pidx") ?? sessionStorage.getItem("khalti_pidx") ?? "";
  const { auth } = useAuth();
  const [state, setState] = useState<"working" | "ok" | "fail">("working");
  const [message, setMessage] = useState("");
  const [releasePhone, setReleasePhone] = useState("");
  const [releaseMsg, setReleaseMsg] = useState("");
  const [released, setReleased] = useState(false);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return; ran.current = true;
    (async () => {
      try {
        if (!provider || !groupId) throw new Error("This page needs payment details from the wallet to verify.");
        if (provider === "esewa") {
          if (!esewaData) throw new Error("eSewa did not return payment data.");
          await api2.verifyEsewaPayment({ group_id: groupId, data: esewaData });
        } else if (provider === "khalti") {
          if (!khaltiPidx) throw new Error("Khalti did not return a payment reference.");
          await api2.verifyKhaltiPayment({ group_id: groupId, pidx: khaltiPidx });
        } else throw new Error(`Unknown payment provider “${provider}”.`);
        sessionStorage.removeItem("khalti_pidx"); sessionStorage.removeItem("khalti_group"); sessionStorage.removeItem("khalti_order");
        setState("ok");
      } catch (e) {
        setMessage(e instanceof Error ? e.message.replace(/^action \w+ (error|failed):\s*\d*\s*/, "").trim() : "Verification failed.");
        setState("fail");
      }
    })();
  }, [provider, groupId, esewaData, khaltiPidx]);

  const release = async () => {
    setReleaseMsg("");
    try {
      await api2.cancelOnlinePayment({ group_id: groupId, phone: auth?.type === "buyer" ? undefined : releasePhone });
      setReleased(true);
    } catch (e) {
      setReleaseMsg(e instanceof Error ? e.message.replace(/^action \w+ (error|failed):\s*\d*\s*/, "").trim() : "Could not release the order.");
    }
  };

  return (
    <main className="track-page"><section className="track-intro"><p className="eyebrow">Payment result</p><h1>{state === "working" ? "Confirming payment…" : state === "ok" ? "Payment confirmed." : "Payment not confirmed."}</h1></section>
      {state === "working" && <p className="muted">Checking with the wallet — this takes a few seconds.</p>}
      {state === "ok" && <div className="empty-state"><span>PAYMENT RECEIVED</span><h3>Your order is confirmed.</h3><p>The seller has been notified and will pack your parcel. You can follow it from the tracking page.</p><button className="primary" onClick={() => go("/track")}>Track my order</button></div>}
      {state === "fail" && <div className="empty-state"><span>PAYMENT UNCLEAR</span><h3>We could not confirm this payment.</h3><p>{message || "No money was taken according to the wallet. You can try again or choose cash on delivery."}</p>
        <div className="step-nav"><button className="primary" onClick={() => go("/track")}>Check the order</button><button className="ghost" onClick={() => go("/help")}>Contact support</button></div>
        {!released ? (
          <div className="release-box"><h4>Done with this attempt?</h4><p>Release the unpaid order so it no longer waits for this payment. You can then check out again with another method.</p>
            {auth?.type !== "buyer" && <label>Order phone number<input type="tel" value={releasePhone} onChange={(e) => setReleasePhone(e.target.value)} placeholder="98XXXXXXXX" minLength={7} /></label>}
            {releaseMsg && <p className="form-error">{releaseMsg}</p>}
            <button className="ghost" onClick={release}>Release this order</button>
          </div>
        ) : (
          <p className="muted">Released. The order no longer waits for this payment — check out again whenever you are ready.</p>
        )}
      </div>}
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
        {cell("Returns", rows.map(() => "30-day returns on delivered orders"))}
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
  shipped: "On the way", out_for_delivery: "Out for delivery", delivery_failed: "Delivery failed", delivered: "Delivered",
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
