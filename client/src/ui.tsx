// Shared client UI kit: toasts, product imagery, cards, ratings, states.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { money, type P2Product } from "./phase2api";

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
  if (product.image_url) {
    return (
      <div className={`product-mark img ${className ?? ""}`} aria-hidden="true">
        <img src={product.image_url} alt="" loading="lazy" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
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
export function ProductCard({ product, onOpen, onAdd, showSeller }: {
  product: P2Product; onOpen: () => void; onAdd?: (p: P2Product) => void; showSeller?: boolean;
}) {
  return (
    <article className="product">
      <button className="product-open" onClick={onOpen} aria-label={`View ${product.name}`}>
        <ProductImage product={product} />
        <div className="product-body">
          <p>{product.category}{product.brand ? ` · ${product.brand}` : ""}</p>
          <h3>{product.name}</h3>
          {showSeller && <small className="seller-line">{product.store_name} · {product.store_location}</small>}
          <div className="price-line">
            <span><strong>{money(product.price_paisa)}</strong>
              {product.original_price_paisa && product.original_price_paisa > product.price_paisa && (
                <> <s className="was">{money(product.original_price_paisa)}</s> <span className="off">-{product.discount_pct}%</span></>
              )}
            </span>
            <small>{product.stock > 0 ? (product.low_stock ? `Only ${product.stock} left` : `${product.stock} in stock`) : "Out of stock"}</small>
          </div>
          <Stars rating={product.rating} count={product.review_count} />
        </div>
      </button>
      {onAdd && (
        <button className="add" disabled={product.stock === 0} onClick={() => onAdd(product)}>
          {product.stock === 0 ? "Out of stock" : "Add to basket"}
        </button>
      )}
    </article>
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
