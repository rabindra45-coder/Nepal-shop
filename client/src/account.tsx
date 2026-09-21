// Buyer account screens: notifications, hub, address book, help & tickets.
import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api2, fmtDate, type P2Address } from "./phase2api";
import { useAuth, go } from "./session";
import { useCart } from "./cart";
import { EmptyBlock, Loading, PageError, useToast } from "./ui";

// --- notifications -------------------------------------------------------------
export function NotificationsPage() {
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
    return <main className="track-page"><EmptyBlock kicker="NOTIFICATIONS" title="Log in to see updates." body="Order updates, price drops and ticket replies appear here." actionLabel="Log in" onAction={() => go("/login")} /></main>;
  }
  if (notes.isPending) return <Loading text="Checking your updates…" />;
  if (notes.error) return <PageError error={notes.error} retry={() => notes.refetch()} />;
  const items = notes.data?.notifications ?? [];
  return (
    <main className="track-page"><section className="track-intro"><p className="eyebrow">Updates</p><h1>Notifications.</h1>
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
    </main>
  );
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

// --- account hub ------------------------------------------------------------------
export function AccountHub() {
  const { auth, signOut } = useAuth();
  const { count } = useCart();
  const wish = useQuery({ queryKey: ["wishlist"], queryFn: () => api2.getWishlist({}), enabled: auth?.type === "buyer" });
  const notes = useQuery({ queryKey: ["notifications", "count"], queryFn: () => api2.getNotifications({ limit: 1 }), enabled: auth?.type === "buyer" });
  if (auth?.type !== "buyer") { go("/login"); return null; }
  const tiles = [
    { label: "My orders", desc: "Track and review your purchases", path: "/account/orders" },
    { label: "Addresses", desc: "Your delivery address book", path: "/account/addresses" },
    { label: `Wishlist${wish.data ? ` (${wish.data.items.length})` : ""}`, desc: "Saved products and price drops", path: "/wishlist" },
    { label: `Notifications${notes.data?.unread_count ? ` (${notes.data.unread_count} new)` : ""}`, desc: "Order updates and alerts", path: "/notifications" },
    { label: "Support tickets", desc: "Ask us anything", path: "/help" },
    { label: `Basket (${count})`, desc: "Finish what you started", path: "/cart" },
  ];
  return (
    <main className="track-page"><section className="track-intro"><p className="eyebrow">Signed in as {auth.name}</p><h1>My account.</h1></section>
      <div className="tile-grid">{tiles.map((t) => (
        <button key={t.path} className="tile" onClick={() => go(t.path)}><b>{t.label}</b><span>{t.desc}</span></button>
      ))}</div>
      <button className="ghost" onClick={signOut}>Log out</button>
    </main>
  );
}

// --- address book -------------------------------------------------------------------
export function AddressesPage() {
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
    <main className="track-page"><section className="track-intro"><p className="eyebrow">Delivery addresses</p><h1>Address book.</h1></section>
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
    </main>
  );
}

// --- help ------------------------------------------------------------------------------
const FAQS: { q: string; a: string }[] = [
  { q: "How do I place an order?", a: "Add products to your basket, go to checkout, fill in your delivery address, choose a delivery speed and pay with cash on delivery, eSewa or Khalti. You will get an order code to track the parcel." },
  { q: "Do I need an account to order?", a: "No. Guests can check out with just a name, phone number and address. An account keeps your orders, addresses, wishlist and notifications in one place." },
  { q: "How does cash on delivery work?", a: "You pay nothing now. Your order stays “Needs confirmation” until the seller accepts it, then it moves through Packed → On the way → Delivered. Pay the courier in cash when it arrives." },
  { q: "Why can't I pay with eSewa or Khalti?", a: "Online wallets need approved merchant credentials on our side. If they are not connected yet, checkout says so honestly and cash on delivery always works." },
  { q: "How long does delivery take?", a: "Standard delivery takes 2–5 working days; express takes 1–2 working days for an extra Rs 120. Picking up from the seller is free." },
  { q: "Can I return something?", a: "Yes — within 7 days of delivery, open your order on the tracking page and choose “Request return” with a reason. The seller accepts or declines; accepted returns are refunded after the item comes back." },
  { q: "How do I track my order?", a: "Open “My order” and enter your order code plus the mobile number used at checkout. Signed-in buyers also see every order under My account." },
  { q: "Are the sellers trustworthy?", a: "Sellers are approved by our team before their products appear. Look for the “Verified seller” badge on product pages, and read reviews — only delivered buyers can leave them." },
  { q: "How do coupons work?", a: "Enter a coupon code at checkout (step 3). If it is valid for your basket — for example WELCOME10 for 10% off orders over Rs 1,000 — the discount applies before delivery is added." },
  { q: "How do I sell on Nepal Shop?", a: "Open Seller studio, create a seller account and add your products. Our team approves your shop; after approval your products appear in the market and you get orders, analytics and return tools." },
];

export function HelpPage() {
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
    <main className="track-page"><section className="track-intro"><p className="eyebrow">Help centre</p><h1>Questions, answered.</h1></section>
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
    </main>
  );
}
