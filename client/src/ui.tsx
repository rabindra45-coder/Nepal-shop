// Shared client UI kit: toasts, product imagery, cards, ratings, states.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { money, type P2Product } from "./phase2api";
import { go } from "./session";

// --- toasts ----------------------------------------------------------------
interface Toast { id: number; message: string; kind: "ok" | "err"; }
const ToastCtx = createContext<{ toast: (message: string, kind?: "ok" | "err") => void }>({ toast: () => {} });
export function useToast() { return useContext(ToastCtx); }

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const idRef = useRef(1);
  const toast = useCallback((message: string, kind: "ok" | "err" = "ok") => {
    const id = idRef.current++;
    setToasts((t) => [...t, { id, message, kind }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);
  return (
    <ToastCtx.Provider value={{ toast }}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.message}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}

// --- imagery ---------------------------------------------------------------
const HUES = ["#d94829", "#e8a31a", "#2f6b4f", "#3e6b8f", "#8f3e6b", "#5f655f"];
export function ProductImage({ product, className }: { product: P2Product; className?: string }) {
  // Seller-uploaded photos win; the pasted image URL is next; otherwise a
  // styled monogram placeholder.
  const src = product.images?.[0] ?? product.image_url ?? null;
  if (src) {
    return (
      <div className={`product-mark img ${className ?? ""}`}>
        <img src={src} alt={product.name} loading="lazy" decoding="async" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
      </div>
    );
  }
  const hue = HUES[product.id % HUES.length];
  const initials = (product.brand ?? product.name).trim().slice(0, 2).toUpperCase();
  return (
    <div className={`product-mark ph ${className ?? ""}`} style={{ ["--phue" as string]: hue }} aria-hidden="true">
      <span>{initials}</span>
    </div>
  );
}

export function Stars({ rating, count }: { rating: number | null; count?: number }) {
  if (rating === null) return <small className="rating muted">No reviews yet</small>;
  const full = Math.round(rating);
  return <small className="rating">{"★".repeat(full)}{"☆".repeat(Math.max(0, 5 - full))} {rating.toFixed(1)}{count !== undefined ? ` · ${count} verified` : ""}</small>;
}

// --- cards ------------------------------------------------------------------
// v15: modern marketplace card (Meesho/Daraz-style): square image with a
// discount badge, two-line name, price + struck-through original + % off,
// stars with review count, and a real "N sold" label (never invented).
export function formatSold(n: number): string {
  if (n >= 1000) {
    const k = n / 1000;
    return `${k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, "")}k sold`;
  }
  return `${n} sold`;
}

export function ProductCard({ product, onOpen, onAdd, showSeller }: {
  product: P2Product; onOpen: () => void; onAdd?: (p: P2Product) => void; showSeller?: boolean;
}) {
  // The seller name doubles as a store link. It sits inside the card's open
  // button, so it stops propagation and handles Enter itself.
  const openStore = (e: { stopPropagation: () => void }) => { e.stopPropagation(); go(`/store/${product.seller_code}`); };
  const img = product.images?.[0] ?? product.image_url ?? null;
  const off = product.discount_pct > 0 && product.original_price_paisa != null && product.original_price_paisa > product.price_paisa;
  const out = product.stock === 0;
  const initials = (product.brand ?? product.name).trim().slice(0, 2).toUpperCase();
  return (
    <article className="m-card">
      <button className="m-card-open" onClick={onOpen} aria-label={`View ${product.name}`}>
        <span className="m-card-img">
          {img ? (
            <img src={img} alt="" loading="lazy" decoding="async" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
          ) : (
            <span className="m-card-ph" aria-hidden="true">{initials}</span>
          )}
          {off && <span className="m-off">-{product.discount_pct}%</span>}
          {product.flash_sale && <span className="m-flash">⚡ Flash</span>}
          {out && <span className="m-soldout">Out of stock</span>}
        </span>
        <span className="m-card-body">
          <span className="m-name">{product.name}</span>
          {showSeller && (
            <span className="m-seller" role="link" tabIndex={0} aria-label={`Visit ${product.store_name}`}
              onClick={openStore}
              onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); go(`/store/${product.seller_code}`); } }}>
              {product.store_name}
            </span>
          )}
          <span className="m-price-row">
            <span className="m-price">{money(product.price_paisa)}</span>
            {off && <s className="m-was">{money(product.original_price_paisa!)}</s>}
          </span>
          {off && <span className="m-off-txt">{product.discount_pct}% off</span>}
          <span className="m-meta">
            <Stars rating={product.rating} count={product.review_count} />
            {product.sold_count > 0 && <span className="m-sold"> · {formatSold(product.sold_count)}</span>}
          </span>
        </span>
      </button>
      {onAdd && (
        <button className="m-add" disabled={out} onClick={() => onAdd(product)}>
          {out ? "Out of stock" : "Add to basket"}
        </button>
      )}
    </article>
  );
}

// v15: circular category tile for the homepage category strip.
export function CategoryCircle({ name, image, count, onOpen }: {
  name: string; image?: string | null; count?: number; onOpen: () => void;
}) {
  const initials = name.trim().slice(0, 2).toUpperCase();
  return (
    <button className="cat-circle" onClick={onOpen} aria-label={`Shop ${name}`}>
      <span className="cat-circle-img">
        {image ? <img src={image} alt="" loading="lazy" decoding="async" /> : <span aria-hidden="true">{initials}</span>}
      </span>
      <span className="cat-circle-name">{name}</span>
      {count !== undefined && <span className="cat-circle-count">{count}</span>}
    </button>
  );
}

// v15: section header with a "view all" link, used across the new homepage.
export function SectionHead({ title, actionLabel, onAction }: {
  title: string; actionLabel?: string; onAction?: () => void;
}) {
  return (
    <div className="m-sec-head">
      <h2>{title}</h2>
      {actionLabel && onAction && <button className="linklike" onClick={onAction}>{actionLabel} →</button>}
    </div>
  );
}

// --- states -----------------------------------------------------------------
export function Loading({ text }: { text?: string }) {
  return <main className="loading">{text ?? "Loading…"}</main>;
}
export function PageError({ error, retry }: { error: unknown; retry?: () => void }) {
  const message = error instanceof Error ? error.message.replace(/^action \w+ (error|failed):\s*\d*\s*/, "").trim() : "Something went wrong.";
  return (
    <main className="track-page"><div className="empty-state">
      <span>NOT AVAILABLE</span>
      <h3>This page could not load.</h3>
      <p>{message || "Please check your connection and try again."}</p>
      {retry && <button className="primary" onClick={retry}>Try again</button>}
    </div></main>
  );
}
export function EmptyBlock({ kicker, title, body, actionLabel, onAction }: {
  kicker: string; title: string; body: string; actionLabel?: string; onAction?: () => void;
}) {
  return (
    <div className="empty-state">
      <span>{kicker}</span>
      <h3>{title}</h3>
      <p>{body}</p>
      {actionLabel && onAction && <button className="primary" onClick={onAction}>{actionLabel}</button>}
    </div>
  );
}

export function QueryState({ pending, error, empty, text, children }: {
  pending: boolean; error: unknown; empty: boolean;
  text: string; children: ReactNode;
}) {
  if (pending) return <p className="muted">{text}…</p>;
  if (error) return <p className="form-error" role="alert">{error instanceof Error ? error.message : "Could not load."}</p>;
  if (empty) return <p className="muted">{text.replace(/Loading|loading/, "Nothing here yet")}</p>;
  return <>{children}</>;
}

// --- compare list (local) ---------------------------------------------------
const COMPARE_KEY = "nepalsite_compare";
export function getCompareIds(): number[] {
  try { const raw = JSON.parse(localStorage.getItem(COMPARE_KEY) ?? "[]"); return Array.isArray(raw) ? raw.filter((n) => typeof n === "number").slice(0, 3) : []; }
  catch { return []; }
}
export function toggleCompareId(id: number): number[] {
  const ids = getCompareIds();
  const next = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id].slice(0, 3);
  localStorage.setItem(COMPARE_KEY, JSON.stringify(next));
  return next;
}
export function isCompared(id: number) { return getCompareIds().includes(id); }

export function useNow(intervalMs: number) {
  const [, setTick] = useState(0);
  useEffect(() => { const t = window.setInterval(() => setTick((n) => n + 1), intervalMs); return () => window.clearInterval(t); }, [intervalMs]);
}
