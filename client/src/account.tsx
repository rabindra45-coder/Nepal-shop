// Buyer account: sidebar shell, profile photo, notifications, address book,
// help & tickets. The order-trail components (FieldError, GroupTrail,
// OrderTrail) live here too — the guest tracking page in App.tsx renders
// them from this module.
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, getAuth } from "./api";
import { api2, fmtDate, money, toP2Order, toP2OrderGroup, type P2Address, type P2OrderGroup } from "./phase2api";
import { useAuth, go } from "./session";
import { useCart } from "./cart";
import { EmptyBlock, Loading, PageError, useToast } from "./ui";
import { CartPage, ChangePasswordForm, PAY_LABEL, STATUS_LABEL, WishlistPage } from "./screens";
import { ReturnRequestForm } from "./studio2";

// --- shared order-trail components (moved from App.tsx) ---
// --- moved verbatim from App.tsx (FieldError) ---
export function FieldError({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  const clean = message.replace(/^action \w+ (error|failed):\s*\d*\s*/, "").trim() || message;
  return <p className="form-error" role="alert">{clean}</p>;
}

// --- moved verbatim from App.tsx (GroupTrail) ---
// One customer checkout rendered as a group: the group header (code, totals,
// payment state) plus one trail per seller fulfilment. Cancelling any
// fulfilment cancels the whole group — the customer experiences one order.
export function GroupTrail({ group, credentials, invalidate }: { group: P2OrderGroup; credentials: { order_code: string; phone: string }; invalidate: () => void }) {
  const { auth } = useAuth();
  const anyCancellable = group.orders.some((o) => o.status === "confirmation_needed" || o.status === "confirmed");
  return <section className="order-trail group-trail">
    <div className="order-heading"><div><p className="eyebrow">{group.group_code}</p><h2>Order {group.group_code}</h2></div><strong>{money(group.total_paisa)}</strong></div>
    <p className="muted">Placed {new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(group.created_at))} · {group.orders.length} seller{group.orders.length === 1 ? "" : "s"} · {group.payment_method === "cod" ? "Cash on delivery" : `${group.payment_method.toUpperCase()} · ${PAY_LABEL[group.payment_status] ?? group.payment_status}`}{group.delivery_method !== "standard" ? ` · ${group.delivery_method} delivery` : ""}{group.coupon_code ? ` · Coupon ${group.coupon_code} (−${money(group.discount_paisa)})` : ""}</p>
    {auth && <div className="order-actions"><button className="ghost" onClick={() => go(`/invoice/${encodeURIComponent(group.group_code)}`)}>Download invoice</button></div>}
    {anyCancellable && <p className="muted">Cancelling one parcel cancels the whole order — every seller's reserved stock is released.</p>}
    {group.orders.map((o) => <OrderTrail key={o.id} order={o} groupCode={group.group_code} credentials={credentials} invalidate={invalidate} />)}
  </section>;
}

// --- moved verbatim from App.tsx (OrderTrail) ---
export function OrderTrail({ order, groupCode, credentials, invalidate }: { order: ReturnType<typeof toP2Order>; groupCode?: string; credentials: { order_code: string; phone: string }; invalidate: () => void }) {
  const { auth } = useAuth();
  const { toast } = useToast();
  const { add } = useCart();
  const [message, setMessage] = useState("");
  const [showReturn, setShowReturn] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [reordering, setReordering] = useState(false);
  // Reorder: re-fetch each item's CURRENT listing and only re-add what is
  // genuinely sellable right now, at today's price and stock. getProductDetail
  // only returns published, approved, active-seller listings, so anything it
  // rejects (unpublished, disapproved, gone) is skipped and named honestly.
  const reorder = async () => {
    setReordering(true);
    const skipped: string[] = [];
    let added = 0;
    for (const item of order.items) {
      let detail: Awaited<ReturnType<typeof api.getProductDetail>>;
      try {
        detail = await api.getProductDetail({ product_id: item.product_id });
      } catch {
        skipped.push(`${item.product_name} — no longer sold`);
        continue;
      }
      const product = detail.product;
      if (item.variant_id) {
        const v = detail.variants.find((x) => x.id === item.variant_id);
        if (!v || !v.is_active) { skipped.push(`${item.product_name}${item.variant_label ? ` (${item.variant_label})` : ""} — that option is no longer available`); continue; }
        if (v.stock <= 0) { skipped.push(`${item.product_name} (${v.label}) — out of stock`); continue; }
        add(product, Math.min(item.quantity, v.stock), { id: v.id, label: v.label, unitPrice: v.price_paisa ?? product.price_paisa, stock: v.stock });
        added += 1;
      } else {
        if (product.stock <= 0) { skipped.push(`${item.product_name} — out of stock`); continue; }
        add(product, Math.min(item.quantity, product.stock));
        added += 1;
      }
    }
    setReordering(false);
    if (added > 0) toast(`Added ${added} item${added === 1 ? "" : "s"} back to your basket.`);
    if (skipped.length > 0) toast(`Skipped: ${skipped.join("; ")}.`, "err");
    if (added === 0 && skipped.length === 0) toast("Nothing to reorder from this order.", "err");
  };
  const issue = useMutation({ mutationFn: api.reportIssue, onSuccess: () => { setMessage("Your issue is now in the seller’s queue."); invalidate(); } });
  const review = useMutation({ mutationFn: api.addReview, onSuccess: () => { setMessage("Your verified review is published."); invalidate(); } });
  const cancel = useMutation({
    mutationFn: () => auth?.type === "buyer"
      ? api2.cancelOrder({ order_id: order.id })
      : groupCode
        ? api2.cancelOrder({ group_code: groupCode, phone: credentials.phone })
        : api2.cancelOrder({ order_code: credentials.order_code, phone: credentials.phone }),
    onSuccess: () => { setConfirmingCancel(false); setMessage("Your order was cancelled. No payment is due."); toast("Order cancelled."); invalidate(); },
    onError: (e) => { setConfirmingCancel(false); toast(e instanceof Error ? e.message : "Could not cancel the order.", "err"); },
  });
  const steps = ["confirmation_needed", "confirmed", "packed", "shipped", "out_for_delivery", "delivered"];
  const endStates = ["return_requested", "returned", "refunded", "cancelled", "delivery_failed"];
  const current = endStates.includes(order.status) ? steps.length : steps.indexOf(order.status);
  const cancellable = order.status === "confirmation_needed" || order.status === "confirmed";
  const endBanner = (): string | null => {
    switch (order.status) {
      case "return_requested": return "Return requested — the seller is reviewing your request.";
      case "returned":
        if (order.refund_status === "pending") return "Returned — the item is back and your refund is with our team. It is completed manually, so please allow a few working days.";
        if (order.refund_status === "not_required") return "Returned — this was Cash on Delivery and no payment was collected, so there is nothing to refund.";
        if (order.refund_status === "failed") return "Returned — our team could not complete the refund yet and will try again. You do not need to do anything.";
        return "Returned — the item is on its way back.";
      case "refunded": return "Refunded — the money has been sent back.";
      case "delivery_failed": return "Delivery failed — the seller will arrange another attempt. If the parcel never arrives, you can request a return or report a problem below.";
      default: return null;
    }
  };
  const banner = endBanner();
  return <section className="order-trail"><div className="order-heading"><div><p className="eyebrow">{order.order_code}</p><h2>{STATUS_LABEL[order.status] ?? order.status}</h2></div><strong>{money(order.total_paisa)}</strong></div><div className="timeline">{steps.map((step, index) => <div className={index <= current && order.status !== "cancelled" ? "done" : ""} key={step}><span>{index + 1}</span><b>{STATUS_LABEL[step]}</b></div>)}</div>{banner && order.status !== "cancelled" && <p className="banner warn" role="status">{banner}</p>}{order.status === "cancelled" && <p className="banner" role="status">Cancelled — no payment is due and reserved stock was released.</p>}{order.tracking_number && <p className="banner" role="status">Tracking{order.carrier ? ` · ${order.carrier}` : ""}: <b>{order.tracking_number}</b></p>}<div className="order-items">{order.items.map((item) => <span key={item.id}>{item.quantity} × {item.product_name}{item.variant_label ? ` (${item.variant_label})` : ""}<b>{money(item.quantity * item.unit_price_paisa)}</b></span>)}<span>Delivery<b>{money(order.delivery_fee_paisa)}</b></span>{order.discount_paisa > 0 && <span>Coupon {order.coupon_code}<b className="success">−{money(order.discount_paisa)}</b></span>}</div><p className="muted">Ordered {new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(order.created_at))} · {order.status === "cancelled" ? "No payment due" : order.payment_method === "cod" ? "Cash on delivery" : `${order.payment_method.toUpperCase()} · ${PAY_LABEL[order.payment_status]}`}{order.delivery_method !== "standard" ? ` · ${order.delivery_method} delivery` : ""}</p>
    {cancellable && !confirmingCancel && <button className="ghost text-danger" onClick={() => setConfirmingCancel(true)}>Cancel this order</button>}
    {cancellable && confirmingCancel && <p className="banner warn" role="alert">Cancel order {order.order_code}? This cannot be undone.<span className="order-actions"><button className="ghost text-danger" disabled={cancel.isPending} onClick={() => cancel.mutate()}>{cancel.isPending ? "Cancelling…" : "Yes, cancel it"}</button><button className="ghost" onClick={() => setConfirmingCancel(false)}>Keep my order</button></span></p>}
    {order.status === "delivered" && !showReturn && <button className="ghost" onClick={() => setShowReturn(true)}>Request return</button>}
    {order.status === "delivered" && showReturn && <ReturnRequestForm orderCode={order.order_code} phone={credentials.phone} onDone={() => { setShowReturn(false); invalidate(); }} />}
    {order.status === "delivered" && <details><summary>Write a verified review</summary><form className="stack-form compact" onSubmit={(e) => { e.preventDefault(); const d = new FormData(e.currentTarget); review.mutate({ ...credentials, product_id: Number(d.get("product")), rating: Number(d.get("rating")), body: String(d.get("body") ?? "") }); }}><label>Product<select name="product">{order.items.map((item) => <option value={item.product_id} key={item.id}>{item.product_name}{item.variant_label ? ` (${item.variant_label})` : ""}</option>)}</select></label><label>Rating<select name="rating"><option value="5">5 — Excellent</option><option value="4">4 — Good</option><option value="3">3 — Okay</option><option value="2">2 — Poor</option><option value="1">1 — Bad</option></select></label><label>Review<textarea name="body" minLength={3} required /></label><button>Publish verified review</button></form></details>}<details><summary>Report a problem</summary><form className="stack-form compact" onSubmit={(e) => { e.preventDefault(); const d = new FormData(e.currentTarget); issue.mutate({ ...credentials, kind: String(d.get("kind") ?? ""), detail: String(d.get("detail") ?? "") }); }}><label>Issue<select name="kind"><option>Delivery delay</option><option>Wrong item</option><option>Damaged item</option><option>Refund request</option><option>Other</option></select></label><label>What happened?<textarea name="detail" minLength={8} required /></label><button>Send to seller</button></form></details>
    <div className="order-actions">{!groupCode && auth && <button className="ghost" onClick={() => go(`/invoice/${encodeURIComponent(order.order_code)}`)}>Download invoice</button>}<button className="ghost" disabled={reordering} onClick={() => void reorder()}>{reordering ? "Checking availability…" : "Reorder"}</button></div>
    {message && <p className="success">{message}</p>}</section>;
}

// --- orders panel (moved from App.tsx; the shell provides the <main>) ---
function MyOrdersContent() {
  const { auth } = useAuth();
  const ordersQuery = useQuery({ queryKey: ["my-orders"], queryFn: () => api.getMyOrderGroups({}), enabled: auth?.type === "buyer" });
  const queryClient = useQueryClient();
  const refresh = () => { void queryClient.invalidateQueries({ queryKey: ["my-orders"] }); void queryClient.invalidateQueries({ queryKey: ["storefront"] }); };
  return <><section className="track-intro"><p className="eyebrow">{auth?.name}</p><h1>My orders.</h1><p>Every order you placed while signed in lives here — one card per checkout.</p></section>
    {ordersQuery.isPending && <p className="muted">Loading your orders…</p>}
    <FieldError error={ordersQuery.error} />
    {ordersQuery.data && ordersQuery.data.groups.length === 0 && <div className="empty-state"><h3>No orders yet</h3><p>Your signed-in orders will appear here. Guest orders can still be tracked with the order code.</p><button className="primary" onClick={() => go("/")}>Start shopping</button></div>}
    {ordersQuery.data?.groups.map((group) => <GroupTrail key={group.id} group={toP2OrderGroup(group)} credentials={{ order_code: group.group_code, phone: group.phone }} invalidate={refresh} />)}
  </>;
}


// Shared slide-in drawer, used by the mobile site menu and by the mobile
// account/studio sidebars. Mobile only (CSS hides it at >=768px).
//
// Behaviour: overlay click closes, Escape closes, focus moves into the panel
// on open and is returned to the trigger on close, and the page behind the
// drawer does not scroll while it is open.
export function Drawer({ open, onClose, label, children }: {
  open: boolean;
  onClose: () => void;
  label: string;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeRef.current(); };
    document.addEventListener("keydown", onKey);
    document.body.classList.add("drawer-open");
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.classList.remove("drawer-open");
      if (previouslyFocused && document.contains(previouslyFocused)) previouslyFocused.focus();
    };
  }, [open ]);

  if (!open) return null;
  return (
    <>
      <div className="drawer-overlay" onClick={() => closeRef.current()} aria-hidden="true" />
      <div ref={panelRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={label} className="drawer">
        <div className="drawer-head">
          <strong>{label}</strong>
          <button className="drawer-close" onClick={() => closeRef.current()} aria-label={`Close ${label}`}>✕</button>
        </div>
        {children}
      </div>
    </>
  );
}

// --- account shell (sidebar layout) -------------------------------------------
// One shell for the whole buyer account: a persistent left sidebar on
// desktop and tablet, a hamburger-opened drawer on mobile. Every section
// keeps its existing functionality; sections that already have their own
// page (wishlist, basket) render that page as the panel.
export type AccountSection =
  | "orders" | "addresses" | "wishlist" | "notifications"
  | "tickets" | "basket" | "prefs" | "password" | "data";

const ACCOUNT_SECTIONS: { id: AccountSection; label: string; desc: string }[] = [
  { id: "orders", label: "My orders", desc: "Track and review your purchases" },
  { id: "addresses", label: "Addresses", desc: "Your delivery address book" },
  { id: "wishlist", label: "Wishlist", desc: "Saved products and price drops" },
  { id: "notifications", label: "Notifications", desc: "Order updates and alerts" },
  { id: "tickets", label: "Support tickets", desc: "Ask us anything" },
  { id: "basket", label: "Basket", desc: "Finish what you started" },
  { id: "prefs", label: "Email preferences", desc: "Choose which emails you get" },
  { id: "password", label: "Change password", desc: "Keep your account secure" },
  { id: "data", label: "My data", desc: "Export or delete your account" },
];

// The signed-in buyer, from the buyer me/profile action. The payload carries
// `avatar_url: string | null` once the server lands it; until then this reads
// null and the UI falls back to an initial — the cast keeps this compiling
// and behaving either way.
export function useBuyerAvatar(): string | null {
  const { auth } = useAuth();
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.getMe({}), enabled: auth?.type === "buyer", retry: false });
  return (me.data?.user as unknown as { avatar_url?: string | null } | undefined)?.avatar_url ?? null;
}

// Account header: avatar, name, and the profile-photo uploader. A successful
// upload invalidates the shared ["me"] query, so the account header, the
// sidebar header and the navbar account chip all refresh together.
function AccountHead({ avatarUrl, name }: { avatarUrl: string | null; name: string }) {
  const { auth } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const upload = useMutation({
    mutationFn: async (file: File): Promise<string> => {
      if (!file.type.startsWith("image/")) throw new Error("Please choose an image file — JPG, PNG, WebP or GIF.");
      if (file.size > 5 * 1024 * 1024) throw new Error("That photo is over 5 MB. Please choose a smaller one.");
      const token = auth?.token ?? getAuth()?.token;
      if (!token) throw new Error("You have been signed out. Please log in again and retry.");
      const form = new FormData();
      form.append("file", file);
      let res: Response;
      try {
        res = await fetch("/api/profile-uploads", { method: "POST", headers: { "x-auth-token": token }, body: form });
      } catch {
        throw new Error("Could not reach the shop. Check your connection and try again.");
      }
      const body = (await res.json().catch(() => ({}))) as { data?: { url?: string }; error?: string };
      if (!res.ok) throw new Error(body.error || "The photo could not be uploaded. Please try again.");
      if (!body.data?.url) throw new Error("The server did not return a photo. Please try again.");
      return body.data.url;
    },
    onSuccess: () => {
      setError("");
      void queryClient.invalidateQueries({ queryKey: ["me"] });
      toast("Profile photo updated.");
    },
    onError: (e) => setError(e instanceof Error ? e.message : "The photo could not be uploaded."),
  });
  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow choosing the same file again
    if (file) { setError(""); upload.mutate(file); }
  };
  const initial = name.trim().charAt(0).toUpperCase() || "•";
  return (
    <section className="acct-hero" aria-label="Your profile">
      {avatarUrl
        ? <img className="avatar avatar-lg" src={avatarUrl} alt="Your profile photo" />
        : <span className="avatar avatar-lg avatar-fallback" aria-hidden="true">{initial}</span>}
      <div className="account-head-copy">
        <p className="eyebrow">My account</p>
        <h1>Hi, {name}.</h1>
        <button type="button" className="ghost photo-btn" disabled={upload.isPending} onClick={() => fileRef.current?.click()}>
          {upload.isPending ? "Uploading…" : "Upload profile photo"}
        </button>
        <input ref={fileRef} type="file" accept="image/*" onChange={onFile} disabled={upload.isPending} hidden aria-hidden="true" tabIndex={-1} />
        {upload.isPending && <p className="muted"><small>Uploading your photo…</small></p>}
        {error && <p className="form-error" role="alert">{error}</p>}
      </div>
    </section>
  );
}

// v15: Daraz-style account shortcuts — quick tiles plus a full menu list of
// sections, keeping the existing section system underneath.
const SECTION_ICONS: Record<AccountSection, string> = {
  orders: "📦", addresses: "📍", wishlist: "❤️", notifications: "🔔",
  tickets: "🎧", basket: "🧺", prefs: "✉️", password: "🔒", data: "🗂",
};

export function AccountShell({ initial }: { initial: AccountSection }) {
  const { auth, signOut } = useAuth();
  const { count } = useCart();
  const [section, setSection] = useState<AccountSection>(initial);
  const [menuOpen, setMenuOpen] = useState(false);
  const avatarUrl = useBuyerAvatar();
  const wish = useQuery({ queryKey: ["wishlist"], queryFn: () => api2.getWishlist({}), enabled: auth?.type === "buyer" });
  const notes = useQuery({ queryKey: ["notifications", "count"], queryFn: () => api2.getNotifications({ limit: 1 }), enabled: auth?.type === "buyer" });
  if (auth?.type !== "buyer") { go("/login"); return null; }
  const unread = notes.data?.unread_count ?? 0;
  const labelFor = (id: AccountSection): string => {
    const base = ACCOUNT_SECTIONS.find((s) => s.id === id)?.label ?? id;
    if (id === "wishlist" && wish.data) return `${base} (${wish.data.items.length})`;
    if (id === "notifications" && unread > 0) return `${base} (${unread} new)`;
    if (id === "basket") return `${base} (${count})`;
    return base;
  };
  const pick = (s: AccountSection) => { setSection(s); setMenuOpen(false); };
  const initialLetter = auth.name.trim().charAt(0).toUpperCase() || "•";
  const sideHead = (
    <div className="sidebar-head">
      {avatarUrl
        ? <img className="avatar" src={avatarUrl} alt="Your profile photo" />
        : <span className="avatar avatar-fallback" aria-hidden="true">{initialLetter}</span>}
      <div><b>{auth.name}</b><span className="muted">My account</span></div>
    </div>
  );
  const nav = (
    <nav aria-label="Account sections" className="sidebar-nav">
      {ACCOUNT_SECTIONS.map((s) => (
        <button key={s.id} type="button" className={section === s.id ? "active" : ""} aria-current={section === s.id ? "page" : undefined} onClick={() => pick(s.id)}>
          <b>{labelFor(s.id)}</b><small>{s.desc}</small>
        </button>
      ))}
      <button type="button" className="sidebar-logout" onClick={() => { setMenuOpen(false); signOut(); }}>Log out</button>
      <button type="button" className="sidebar-home" onClick={() => { setMenuOpen(false); go("/"); }}><b>Homepage</b><small>Return to the storefront</small></button>
    </nav>
  );
  return (
    <main className="account-page">
      <div className="mobile-bar">
        <strong>{labelFor(section)}</strong>
        <button className="nav-hamburger" aria-label="Open account menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}>☰</button>
      </div>
      <div className="account-shell">
        <aside className="sidebar desktop-only" aria-label="Account sections">
          {sideHead}
          {nav}
        </aside>
        <div className="account-panel">
          <AccountHead avatarUrl={avatarUrl} name={auth.name} />
          {/* v15: quick tiles */}
          <div className="acct-row" aria-label="Quick shortcuts">
            <button type="button" className="acct-tile" onClick={() => pick("orders")}><span className="ico" aria-hidden="true">📦</span>My orders</button>
            <button type="button" className="acct-tile" onClick={() => pick("wishlist")}><span className="ico" aria-hidden="true">❤️</span>Wishlist{wish.data ? ` (${wish.data.items.length})` : ""}</button>
            <button type="button" className="acct-tile" onClick={() => go("/track")}><span className="ico" aria-hidden="true">🚚</span>Track order</button>
            <button type="button" className="acct-tile" onClick={() => pick("addresses")}><span className="ico" aria-hidden="true">📍</span>Addresses</button>
          </div>
          {/* v15: menu list of all sections */}
          <nav className="acct-menu" aria-label="Account menu">
            {ACCOUNT_SECTIONS.map((s) => (
              <button key={s.id} type="button" onClick={() => pick(s.id)} aria-current={section === s.id ? "page" : undefined}>
                <span className="ico" aria-hidden="true">{SECTION_ICONS[s.id]}</span>
                <span>{labelFor(s.id)}<br /><small className="muted">{s.desc}</small></span>
                <span className="chev" aria-hidden="true">›</span>
              </button>
            ))}
            <button type="button" onClick={() => { setMenuOpen(false); go("/"); }}>
              <span className="ico" aria-hidden="true">🏠</span>
              <span>Return to home<br /><small className="muted">Back to the storefront</small></span>
              <span className="chev" aria-hidden="true">›</span>
            </button>
          </nav>
          {section === "orders" && <MyOrdersContent />}
          {section === "addresses" && <AddressesContent />}
          {section === "wishlist" && <WishlistPage />}
          {section === "notifications" && <NotificationsContent />}
          {section === "tickets" && <HelpContent />}
          {section === "basket" && <CartPage />}
          {section === "prefs" && <NotificationPrefs />}
          {section === "password" && <ChangePasswordForm kind="buyer" />}
          {section === "data" && <DataDangerZone />}
        </div>
      </div>
      <Drawer open={menuOpen} onClose={() => setMenuOpen(false)} label="Account menu">
        {sideHead}
        {nav}
      </Drawer>
    </main>
  );
}


// --- data & privacy (export + delete) ------------------------------------------
function DataDangerZone() {
  const { signOut } = useAuth();
  const { toast } = useToast();
  const [typed, setTyped] = useState("");
  const [password, setPassword] = useState("");
  const [confirming, setConfirming] = useState(false);

  const exportData = useMutation({
    mutationFn: () => api.exportAccountData({ authToken: getAuth()?.token ?? "" }),
    onSuccess: (r) => {
      const blob = new Blob([JSON.stringify(r, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `nepal-shop-my-data-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast("Your data was downloaded as a JSON file.");
    },
    onError: (e) => toast(e instanceof Error ? e.message : "Could not export your data.", "err"),
  });

  const remove = useMutation({
    mutationFn: () => api.deleteAccount({ authToken: getAuth()?.token ?? "", password, confirm_text: "DELETE" }),
    onSuccess: (r) => {
      setConfirming(false);
      signOut();
      go("/");
      toast(`Your account was deleted. ${r.orders_kept} order${r.orders_kept === 1 ? "" : "s"} kept for records (PII removed), ${r.addresses_deleted} address${r.addresses_deleted === 1 ? "" : "es"} and ${r.wishlist_items_removed} wishlist item${r.wishlist_items_removed === 1 ? "" : "s"} removed.`);
    },
    onError: (e) => toast(e instanceof Error ? e.message : "Could not delete your account.", "err"),
  });

  return (
    <>
      <section className="track-intro"><p className="eyebrow">My data</p><h1>Your data, your call.</h1>
        <p>Take a copy of everything the marketplace holds about you, or delete your account entirely.</p></section>
      <section className="studio-section">
        <div className="section-title"><h2>Export my data</h2></div>
        <p className="muted">Downloads your profile, addresses, orders, wishlist, reviews and notification preferences as one JSON file.</p>
        <button className="ghost" disabled={exportData.isPending} onClick={() => exportData.mutate()}>
          {exportData.isPending ? "Preparing…" : "Export my data (JSON)"}
        </button>
      </section>
      <section className="studio-section danger-zone">
        <div className="section-title"><h2>Delete my account</h2></div>
        <p className="banner warn" role="note">
          <b>This is permanent.</b>
          <span> Your orders are kept for accounting and dispute records, but your name and contact details are removed from them. Your profile, addresses, wishlist and other personal details are deleted and cannot be recovered.</span>
        </p>
        {!confirming
          ? <button className="ghost text-danger" onClick={() => { setConfirming(true); setTyped(""); setPassword(""); }}>Delete my account…</button>
          : (
            <form className="stack-form" onSubmit={(e) => { e.preventDefault(); if (typed === "DELETE" && password) remove.mutate(); }}>
              <label>Your password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required /></label>
              <label>Type <b>DELETE</b> to confirm<input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="DELETE" required autoComplete="off" /></label>
              {remove.error && <p className="form-error" role="alert">{remove.error instanceof Error ? remove.error.message : "Could not delete your account."}</p>}
              <div className="form-pair">
                <button type="submit" className="primary" disabled={remove.isPending || typed !== "DELETE" || !password}>
                  {remove.isPending ? "Deleting…" : "Yes, delete my account"}
                </button>
                <button type="button" className="ghost" onClick={() => setConfirming(false)}>Keep my account</button>
              </div>
            </form>
          )}
      </section>
    </>
  );
}


// --- notifications -------------------------------------------------------------
function NotificationsContent() {
  const { auth } = useAuth();
  const queryClient = useQueryClient();
  const notes = useQuery({ queryKey: ["notifications"], queryFn: () => api2.getNotifications({}), enabled: auth?.type === "buyer" });
  const markRead = useMutation({
    mutationFn: (id: number) => api2.markNotificationRead({ id }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["notifications"] }),
  });
  const markAll = useMutation({
    mutationFn: () => api2.markAllNotificationsRead({}),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["notifications"] }),
  });

  if (auth?.type !== "buyer") {
    return <EmptyBlock kicker="NOTIFICATIONS" title="Log in to see updates." body="Order updates, price drops and ticket replies appear here." actionLabel="Log in" onAction={() => go("/login")} />;
  }
  if (notes.isPending) return <Loading text="Checking your updates…" />;
  if (notes.error) return <PageError error={notes.error} retry={() => notes.refetch()} />;
  const items = notes.data?.notifications ?? [];
  return (
    <>
      <section className="track-intro"><p className="eyebrow">Updates</p><h1>Notifications.</h1>
        {notes.data && notes.data.unread_count > 0 && <p><button className="linklike" onClick={() => markAll.mutate()}>Mark all as read</button></p>}</section>
      {items.length === 0 && <EmptyBlock kicker="ALL QUIET" title="No notifications yet." body="Order updates, price drops and back-in-stock alerts will land here." />}
      <div className="note-list">{items.map((n) => (
        <article key={n.id} className={`note${n.is_read ? "" : " unread"}`}>
          <div><h3>{n.title}</h3><p>{n.body}</p><small className="muted">{fmtDate(n.created_at)}</small>
            <div className="note-links">
              {n.link && <button className="linklike" onClick={() => go(n.link!)}>View →</button>}
              {!n.is_read && <button className="linklike" onClick={() => markRead.mutate(n.id)}>Mark read</button>}
            </div></div>
          {!n.is_read && <span className="dot" aria-label="Unread" />}
        </article>
      ))}</div>
    </>
  );
}

export function NotificationsPage() {
  return <main className="track-page"><NotificationsContent /></main>;
}

export function useUnreadCount(): number {
  const { auth } = useAuth();
  const notes = useQuery({
    queryKey: ["notifications", "count"],
    queryFn: () => api2.getNotifications({ limit: 1 }),
    enabled: auth?.type === "buyer",
    refetchInterval: 30000,
  });
  return auth?.type === "buyer" ? notes.data?.unread_count ?? 0 : 0;
}

// --- notification preferences -------------------------------------------------
// Minimal, honest toggle: the buyer can switch order-update emails on or off.
// Security emails (password reset, verification) always go through.
function NotificationPrefs() {
  const { auth } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const prefs = useQuery({ queryKey: ["notification-prefs"], queryFn: () => api.getNotificationPrefs({}), enabled: auth?.type === "buyer" });
  const update = useMutation({
    mutationFn: (order_update_emails: boolean) => api.updateNotificationPrefs({ order_update_emails }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["notification-prefs"] }); toast("Preference saved."); },
    onError: (e) => toast(e instanceof Error ? e.message : "Could not save.", "err"),
  });
  const resend = useMutation({
    mutationFn: () => api.resendBuyerVerification({}),
    onSuccess: (r) => { void queryClient.invalidateQueries({ queryKey: ["notification-prefs"] }); toast(r.email_sent ? "Verification email sent." : "Your email is already verified."); },
    onError: (e) => toast(e instanceof Error ? e.message : "Could not send.", "err"),
  });
  if (auth?.type !== "buyer" || prefs.isPending) return null;
  if (prefs.error || !prefs.data) return null;
  const p = prefs.data;
  return (
    <section className="pref-card">
      <h3>Email preferences</h3>
      {p.email && !p.email_verified && (
        <p className="muted">Your email {p.email} is not verified yet. <button className="linklike" onClick={() => resend.mutate()} disabled={resend.isPending}>{resend.isPending ? "Sending…" : "Resend verification email"}</button></p>
      )}
      <label className="pref-row">
        <input
          type="checkbox"
          checked={p.order_update_emails}
          disabled={update.isPending}
          onChange={(e) => update.mutate(e.target.checked)}
        />
        <span><b>Order update emails</b><small className="muted">Order confirmations, payment receipts, dispatch and delivery updates, returns and refunds. Password and security emails are always sent.</small></span>
      </label>
    </section>
  );
}

// --- address book -------------------------------------------------------------------
function AddressesContent() {
  const { auth } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<P2Address | null>(null);
  const [adding, setAdding] = useState(false);
  const list = useQuery({ queryKey: ["addresses"], queryFn: () => api2.listAddresses({}), enabled: auth?.type === "buyer" });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["addresses"] });

  const save = useMutation({
    mutationFn: (args: Parameters<typeof api2.saveAddress>[0]) => api2.saveAddress(args),
    onSuccess: () => { refresh(); setEditing(null); setAdding(false); toast("Address saved."); },
    onError: (e) => toast(e instanceof Error ? e.message : "Could not save.", "err"),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api2.deleteAddress({ id }),
    onSuccess: () => { refresh(); toast("Address deleted."); },
  });
  const setDefault = useMutation({
    mutationFn: (id: number) => api2.setDefaultAddress({ id }),
    onSuccess: () => { refresh(); toast("Default address updated."); },
  });

  if (auth?.type !== "buyer") { go("/login"); return null; }
  if (list.isPending) return <Loading text="Loading your address book…" />;
  if (list.error) return <PageError error={list.error} retry={() => list.refetch()} />;

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault(); const d = new FormData(e.currentTarget);
    save.mutate({
      id: editing?.id,
      label: String(d.get("label") ?? "Home") || "Home",
      full_name: String(d.get("full_name") ?? ""), phone: String(d.get("phone") ?? ""),
      province: String(d.get("province") ?? ""), district: String(d.get("district") ?? ""),
      municipality: String(d.get("municipality") ?? ""),
      ward: String(d.get("ward") ?? "") || undefined,
      landmark: String(d.get("landmark") ?? "") || undefined,
      note: String(d.get("note") ?? "") || undefined,
    });
  };

  return (
    <>
      <section className="track-intro"><p className="eyebrow">Delivery addresses</p><h1>Address book.</h1></section>
      <div className="addr-list">{list.data?.addresses.map((a) => (
        <article key={a.id} className="addr-card">
          <div><b>{a.label}{a.is_default ? " · Default" : ""}</b><p>{a.full_name} · {a.phone}</p>
            <p className="muted">{a.municipality}{a.ward ? `-${a.ward}` : ""}{a.landmark ? `, ${a.landmark}` : ""}, {a.district}, {a.province}</p>
            {a.note && <p className="muted">Note: {a.note}</p>}</div>
          <div className="addr-actions">
            {!a.is_default && <button className="ghost" onClick={() => setDefault.mutate(a.id)}>Make default</button>}
            <button className="ghost" onClick={() => { setEditing(a); setAdding(false); }}>Edit</button>
            <button className="ghost text-danger" onClick={() => { if (window.confirm("Delete this address?")) remove.mutate(a.id); }}>Delete</button>
          </div>
        </article>
      ))}</div>
      {!adding && !editing && <button className="primary" onClick={() => setAdding(true)}>+ Add address</button>}
      {(adding || editing) && (
        <form className="stack-form" key={editing?.id ?? "new"} onSubmit={submit}>
          <label>Label<input name="label" defaultValue={editing?.label ?? "Home"} /></label>
          <div className="form-pair">
            <label>Full name<input name="full_name" defaultValue={editing?.full_name} required minLength={2} /></label>
            <label>Mobile number<input name="phone" type="tel" defaultValue={editing?.phone} required minLength={7} /></label>
          </div>
          <div className="form-pair">
            <label>Province<input name="province" defaultValue={editing?.province} required /></label>
            <label>District<input name="district" defaultValue={editing?.district} required /></label>
          </div>
          <div className="form-pair">
            <label>Municipality<input name="municipality" defaultValue={editing?.municipality} required /></label>
            <label>Ward no.<input name="ward" defaultValue={editing?.ward ?? ""} /></label>
          </div>
          <label>Landmark / street<input name="landmark" defaultValue={editing?.landmark ?? ""} /></label>
          <label>Delivery note<input name="note" defaultValue={editing?.note ?? ""} /></label>
          <div className="form-pair">
            <button className="primary" disabled={save.isPending}>{editing ? "Save changes" : "Add address"}</button>
            <button type="button" className="ghost" onClick={() => { setEditing(null); setAdding(false); }}>Cancel</button>
          </div>
        </form>
      )}
    </>
  );
}

export function AddressesPage() {
  return <main className="track-page"><AddressesContent /></main>;
}

// --- help ------------------------------------------------------------------------------
const FAQS: { q: string; a: string }[] = [
  { q: "How do I place an order?", a: "Add products to your basket, go to checkout, fill in your delivery address, choose a delivery speed and pay with cash on delivery, eSewa or Khalti. You will get an order code to track the parcel." },
  { q: "Do I need an account to order?", a: "No. Guests can check out with just a name, phone number and address. An account keeps your orders, addresses, wishlist and notifications in one place." },
  { q: "How does cash on delivery work?", a: "You pay nothing now. Your order stays “Needs confirmation” until the seller accepts it, then it moves through Packed → On the way → Delivered. Pay the courier in cash when it arrives." },
  { q: "Why can't I pay with eSewa or Khalti?", a: "Online wallets need approved merchant credentials on our side. If they are not connected yet, checkout says so honestly and cash on delivery always works." },
  { q: "How long does delivery take?", a: "Standard delivery takes 2–5 working days; express takes 1–2 working days for an extra Rs 120. Picking up from the seller is free." },
  { q: "Can I return something?", a: "Yes — within 30 days of delivery, open your order on the tracking page and choose “Request return” with a reason. The seller accepts or declines (the marketplace team can overrule); accepted returns are refunded by our team after the item comes back." },
  { q: "How do I track my order?", a: "Open “My order” and enter your order code plus the mobile number used at checkout. Signed-in buyers also see every order under My account." },
  { q: "Are the sellers trustworthy?", a: "Sellers are approved by our team before their products appear. Look for the “Verified seller” badge on product pages, and read reviews — only delivered buyers can leave them." },
  { q: "How do coupons work?", a: "Enter a coupon code at checkout (step 3). If it is valid for your basket — for example WELCOME10 for 10% off orders over Rs 1,000 — the discount applies before delivery is added." },
  { q: "How do I sell on Nepal Shop?", a: "Open Seller studio, create a seller account and add your products. Our team approves your shop; after approval your products appear in the market and you get orders, analytics and return tools." },
];

function HelpContent() {
  const { auth } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [ticketCode, setTicketCode] = useState("");
  const myTickets = useQuery({ queryKey: ["my-tickets"], queryFn: () => api2.getMyTickets({}), enabled: auth?.type === "buyer" });

  const create = useMutation({
    mutationFn: (args: Parameters<typeof api2.createTicket>[0]) => api2.createTicket(args),
    onSuccess: (r) => {
      setTicketCode(r.ticket_code);
      void queryClient.invalidateQueries({ queryKey: ["my-tickets"] });
      toast(`Ticket ${r.ticket_code} created.`);
    },
    onError: (e) => toast(e instanceof Error ? e.message : "Could not create the ticket.", "err"),
  });

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault(); const d = new FormData(e.currentTarget);
    create.mutate({
      name: String(d.get("name") ?? ""), contact: String(d.get("contact") ?? ""),
      subject: String(d.get("subject") ?? ""), message: String(d.get("message") ?? ""),
      order_code: String(d.get("order_code") ?? "").trim() || undefined,
    });
    (e.currentTarget as HTMLFormElement).reset();
  };

  return (
    <>
      <section className="track-intro"><p className="eyebrow">Help centre</p><h1>Questions, answered.</h1></section>
      <section className="studio-section"><h2>Frequently asked</h2>
        {FAQS.map((f) => <details key={f.q}><summary>{f.q}</summary><p>{f.a}</p></details>)}
      </section>
      <section className="studio-section"><h2>Contact support</h2>
        <p className="muted">Send a ticket and our team will reply. Signed-in buyers can follow their tickets below.</p>
        {ticketCode && <p className="success banner">Ticket {ticketCode} received. We will get back to you.</p>}
        <form className="stack-form" onSubmit={submit}>
          <div className="form-pair">
            <label>Your name<input name="name" required minLength={2} defaultValue={auth?.type === "buyer" ? auth.name : ""} /></label>
            <label>Contact (phone or email)<input name="contact" required minLength={3} /></label>
          </div>
          <label>Subject<input name="subject" required minLength={4} maxLength={80} placeholder="e.g. My order has not arrived" /></label>
          <label>Order code (optional)<input name="order_code" placeholder="NP-…" /></label>
          <label>Message<textarea name="message" required minLength={10} maxLength={1000} placeholder="Tell us what happened" /></label>
          <button className="primary" disabled={create.isPending}>{create.isPending ? "Sending…" : "Send ticket"}</button>
        </form>
      </section>
      {auth?.type === "buyer" && (
        <section className="studio-section"><h2>My tickets</h2>
          {myTickets.isPending && <p className="muted">Loading your tickets…</p>}
          {myTickets.data && myTickets.data.tickets.length === 0 && <p className="muted">No tickets yet.</p>}
          <div className="issues">{myTickets.data?.tickets.map((t) => (
            <article key={t.ticket_code}>
              <div><p className="eyebrow">{t.ticket_code} · {t.status}{t.order_code ? ` · order ${t.order_code}` : ""}</p>
                <h3>{t.subject}</h3><p>{t.message}</p>
                {t.admin_reply && <p className="reply"><b>Our reply:</b> {t.admin_reply}</p>}
                <small>{fmtDate(t.created_at)}</small></div>
            </article>
          ))}</div>
        </section>
      )}
    </>
  );
}

export function HelpPage() {
  return <main className="track-page"><HelpContent /></main>;
}
