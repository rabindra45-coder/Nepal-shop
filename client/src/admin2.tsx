// Admin panel phase-2 tabs: coupons, categories, homepage, analytics, tickets.
import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api2, fmtDate, money, type P2Coupon, type P2Ticket } from "./phase2api";
import { STATUS_LABEL } from "./screens";
import { useToast } from "./ui";

// --- coupons ---------------------------------------------------------------------
export function AdminCoupons() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<P2Coupon | null>(null);
  const [adding, setAdding] = useState(false);
  const list = useQuery({ queryKey: ["admin-coupons"], queryFn: () => api2.adminListCoupons({}) });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["admin-coupons"] });

  const save = useMutation({
    mutationFn: (args: Parameters<typeof api2.adminSaveCoupon>[0]) => api2.adminSaveCoupon(args),
    onSuccess: () => { refresh(); setEditing(null); setAdding(false); toast("Coupon saved."); },
    onError: (e) => toast(e instanceof Error ? e.message : "Could not save.", "err"),
  });
  const toggle = useMutation({
    mutationFn: (v: { id: number; is_active: boolean }) => api2.adminToggleCoupon(v),
    onSuccess: refresh,
  });

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault(); const d = new FormData(e.currentTarget);
    const kind = String(d.get("kind"));
    const expires = String(d.get("expires_at") ?? "").trim();
    save.mutate({
      id: editing?.id,
      code: String(d.get("code") ?? ""),
      kind: kind as "percent" | "fixed" | "free_shipping",
      value: kind === "percent" ? Number(d.get("value")) : Math.round(Number(d.get("value")) * 100),
      min_order_paisa: d.get("min_order") ? Math.round(Number(d.get("min_order")) * 100) : undefined,
      max_uses: d.get("max_uses") ? Number(d.get("max_uses")) : null,
      per_user_limit: Number(d.get("per_user_limit") ?? 1) || 1,
      expires_at: expires ? new Date(expires).toISOString() : null,
      is_active: d.get("is_active") === "on",
    });
  };

  const toDateInput = (ms: number | null) => (ms ? new Date(ms).toISOString().slice(0, 10) : "");

  return (
    <section className="studio-section wide"><div className="section-title"><h2>Coupons</h2><span>{list.data?.coupons.length ?? 0}</span></div>
      {list.isPending && <p className="muted">Loading coupons…</p>}
      {list.error && <p className="form-error">Could not load coupons.</p>}
      <div className="admin-table">{list.data?.coupons.map((c) => (
        <article key={c.id}>
          <div><h3>{c.code}</h3>
            <p className="muted">{c.kind === "percent" ? `${c.value}% off` : c.kind === "fixed" ? `${money(c.value)} off` : "Free shipping"} · min order {money(c.min_order_paisa)}{c.expires_at ? ` · expires ${fmtDate(c.expires_at)}` : ""}</p>
            <small>{c.max_uses ? `Max ${c.max_uses} uses · ` : ""}{c.per_user_limit} per buyer · {c.is_active ? "Active" : "Disabled"}</small></div>
          <div className="order-actions">
            <button onClick={() => toggle.mutate({ id: c.id, is_active: !c.is_active })}>{c.is_active ? "Disable" : "Enable"}</button>
            <button onClick={() => { setEditing(c); setAdding(false); }}>Edit</button>
          </div>
        </article>
      ))}</div>
      {!adding && !editing && <p><button className="primary" onClick={() => setAdding(true)}>+ New coupon</button></p>}
      {(adding || editing) && (
        <form className="stack-form" key={editing?.id ?? "new"} onSubmit={submit}>
          <div className="form-pair">
            <label>Code<input name="code" defaultValue={editing?.code} required style={{ textTransform: "uppercase" }} placeholder="WELCOME10" /></label>
            <label>Kind<select name="kind" defaultValue={editing?.kind ?? "percent"}><option value="percent">Percent off</option><option value="fixed">Fixed rupees off</option><option value="free_shipping">Free shipping</option></select></label>
          </div>
          <div className="form-pair">
            <label>Value (% or rupees)<input name="value" type="number" min="1" required defaultValue={editing ? (editing.kind === "percent" ? editing.value : editing.value / 100) : 10} /></label>
            <label>Min order, rupees<input name="min_order" type="number" min="0" defaultValue={editing ? editing.min_order_paisa / 100 : 0} /></label>
          </div>
          <div className="form-pair">
            <label>Max total uses (empty = unlimited)<input name="max_uses" type="number" min="1" defaultValue={editing?.max_uses ?? ""} /></label>
            <label>Per-buyer limit<input name="per_user_limit" type="number" min="1" defaultValue={editing?.per_user_limit ?? 1} /></label>
          </div>
          <div className="form-pair">
            <label>Expiry date<input name="expires_at" type="date" defaultValue={toDateInput(editing?.expires_at ?? null)} /></label>
            <label className="check"><input name="is_active" type="checkbox" defaultChecked={editing?.is_active ?? true} /> Active</label>
          </div>
          <div className="form-pair">
            <button className="primary" disabled={save.isPending}>{editing ? "Save coupon" : "Create coupon"}</button>
            <button type="button" className="ghost" onClick={() => { setEditing(null); setAdding(false); }}>Cancel</button>
          </div>
        </form>
      )}
    </section>
  );
}

// --- categories ---------------------------------------------------------------------
export function AdminCategories() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const list = useQuery({ queryKey: ["admin-categories"], queryFn: () => api2.adminListCategories({}) });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["admin-categories"] });
  const save = useMutation({
    mutationFn: (args: Parameters<typeof api2.adminSaveCategory>[0]) => api2.adminSaveCategory(args),
    onSuccess: () => { refresh(); setName(""); },
    onError: (e) => toast(e instanceof Error ? e.message : "Could not save.", "err"),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api2.adminDeleteCategory({ id }),
    onSuccess: refresh,
    onError: (e) => toast(e instanceof Error ? e.message : "Could not delete.", "err"),
  });
  return (
    <section className="studio-section wide"><div className="section-title"><h2>Categories</h2><span>{list.data?.categories.length ?? 0}</span></div>
      {list.isPending && <p className="muted">Loading categories…</p>}
      {list.error && <p className="form-error">Could not load categories.</p>}
      <div className="admin-table">{list.data?.categories.map((c) => (
        <article key={c.id}>
          <div><h3>{c.name}</h3><p className="muted">/{c.slug} · {c.is_active ? "Visible" : "Hidden"}</p></div>
          <div className="order-actions">
            <button onClick={() => save.mutate({ id: c.id, name: c.name, is_active: !c.is_active })}>{c.is_active ? "Hide" : "Show"}</button>
            <button className="text-danger" onClick={() => { if (window.confirm(`Delete category “${c.name}”?`)) remove.mutate(c.id); }}>Delete</button>
          </div>
        </article>
      ))}</div>
      <form className="stack-form" onSubmit={(e) => { e.preventDefault(); if (name.trim()) save.mutate({ name: name.trim() }); }}>
        <div className="form-pair"><label>New category<input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Home & Kitchen" /></label>
          <span style={{ alignSelf: "end" }}><button className="primary" disabled={!name.trim() || save.isPending}>Add category</button></span></div>
      </form>
    </section>
  );
}

// --- homepage ----------------------------------------------------------------------
export function AdminHomepage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [banner, setBanner] = useState<{ id?: number; title: string; subtitle: string; link: string; is_active: boolean; sort_order: number } | null>(null);
  const banners = useQuery({ queryKey: ["admin-banners"], queryFn: () => api2.adminListBanners({}) });
  const sections = useQuery({ queryKey: ["admin-sections"], queryFn: () => api2.adminListSections({}) });
  const refresh = () => { void queryClient.invalidateQueries({ queryKey: ["admin-banners"] }); void queryClient.invalidateQueries({ queryKey: ["admin-sections"] }); };

  const saveBanner = useMutation({
    mutationFn: (args: Parameters<typeof api2.adminSaveBanner>[0]) => api2.adminSaveBanner(args),
    onSuccess: () => { refresh(); setBanner(null); toast("Banner saved."); },
    onError: (e) => toast(e instanceof Error ? e.message : "Could not save.", "err"),
  });
  const deleteBanner = useMutation({
    mutationFn: (id: number) => api2.adminDeleteBanner({ id }),
    onSuccess: refresh,
  });
  const saveSection = useMutation({
    mutationFn: (args: Parameters<typeof api2.adminSaveSection>[0]) => api2.adminSaveSection(args),
    onSuccess: refresh,
    onError: (e) => toast(e instanceof Error ? e.message : "Could not save.", "err"),
  });

  return (
    <div className="studio-layout">
      <section className="studio-section wide"><div className="section-title"><h2>Promo banners</h2>{!banner && <button onClick={() => setBanner({ title: "", subtitle: "", link: "", is_active: true, sort_order: 0 })}>+ New banner</button>}</div>
        {banners.isPending && <p className="muted">Loading banners…</p>}
        <div className="admin-table">{banners.data?.banners.map((b) => (
          <article key={b.id}>
            <div><h3>{b.title}</h3><p className="muted">{b.subtitle ?? "—"} · link {b.link ?? "—"} · order {b.sort_order} · {b.is_active ? "Active" : "Hidden"}</p></div>
            <div className="order-actions">
              <button onClick={() => setBanner({ id: b.id, title: b.title, subtitle: b.subtitle ?? "", link: b.link ?? "", is_active: b.is_active, sort_order: b.sort_order })}>Edit</button>
              <button className="text-danger" onClick={() => { if (window.confirm("Delete this banner?")) deleteBanner.mutate(b.id); }}>Delete</button>
            </div>
          </article>
        ))}</div>
        {banner && (
          <form className="stack-form" onSubmit={(e) => {
            e.preventDefault();
            saveBanner.mutate({ id: banner.id, title: banner.title, subtitle: banner.subtitle || null, link: banner.link || null, is_active: banner.is_active, sort_order: banner.sort_order });
          }}>
            <label>Title<input value={banner.title} onChange={(e) => setBanner({ ...banner, title: e.target.value })} required /></label>
            <label>Subtitle<input value={banner.subtitle} onChange={(e) => setBanner({ ...banner, subtitle: e.target.value })} /></label>
            <div className="form-pair">
              <label>Link (hash route, e.g. #/search)<input value={banner.link} onChange={(e) => setBanner({ ...banner, link: e.target.value })} placeholder="#/search" /></label>
              <label>Sort order<input type="number" value={banner.sort_order} onChange={(e) => setBanner({ ...banner, sort_order: Number(e.target.value) })} /></label>
            </div>
            <label className="check"><input type="checkbox" checked={banner.is_active} onChange={(e) => setBanner({ ...banner, is_active: e.target.checked })} /> Active</label>
            <div className="form-pair"><button className="primary" disabled={saveBanner.isPending}>Save banner</button><button type="button" className="ghost" onClick={() => setBanner(null)}>Cancel</button></div>
          </form>
        )}
      </section>
      <section className="studio-section wide"><div className="section-title"><h2>Homepage sections</h2></div>
        {sections.isPending && <p className="muted">Loading sections…</p>}
        <div className="admin-table">{sections.data?.sections.map((s) => (
          <article key={s.key}>
            <div><h3>{s.title}</h3><p className="muted">Key: {s.key} · order {s.sort_order}</p></div>
            <div className="order-actions">
              <label className="muted">Title <input value={s.title} onChange={(e) => saveSection.mutate({ key: s.key, title: e.target.value || s.title, is_active: s.is_active, sort_order: s.sort_order })} onBlur={(e) => { if (e.target.value.trim() && e.target.value !== s.title) saveSection.mutate({ key: s.key, title: e.target.value.trim(), is_active: s.is_active, sort_order: s.sort_order }); }} /></label>
              <label className="muted">Order <input type="number" defaultValue={s.sort_order} style={{ width: 64 }} onBlur={(e) => saveSection.mutate({ key: s.key, title: s.title, is_active: s.is_active, sort_order: Number(e.target.value) })} /></label>
              <button onClick={() => saveSection.mutate({ key: s.key, title: s.title, is_active: !s.is_active, sort_order: s.sort_order })}>{s.is_active ? "Hide" : "Show"}</button>
            </div>
          </article>
        ))}</div>
      </section>
    </div>
  );
}

// --- analytics ------------------------------------------------------------------------
export function AdminAnalytics() {
  const a = useQuery({ queryKey: ["admin-analytics"], queryFn: () => api2.adminAnalytics({}) });
  if (a.isPending) return <p className="muted">Loading marketplace numbers…</p>;
  if (a.error) return <p className="form-error">Analytics could not load.</p>;
  const d = a.data!;
  const maxDay = Math.max(1, ...d.revenue_by_day.map((r) => r.revenue_paisa));
  return (
    <div className="studio-layout">
      <section className="studio-section wide"><h2>Marketplace health</h2>
        <div className="stat-grid">
          <div><b>{d.conversion_pct.toFixed(1)}%</b><span>View → order conversion (30d)</span></div>
          <div><b>{money(d.aov_paisa)}</b><span>Average order value</span></div>
          <div><b>{Object.values(d.orders_by_status).reduce((s, c) => s + c, 0)}</b><span>Total orders</span></div>
          <div className={d.low_stock_products.length ? "alert" : ""}><b>{d.low_stock_products.length}</b><span>Products low on stock</span></div>
        </div>
      </section>
      <section className="studio-section wide"><h2>Revenue by day (30d)</h2>
        <div className="bars">{d.revenue_by_day.map((r) => (
          <div className="bar-row" key={r.day}><span className="bar-day">{r.day.slice(5)}</span>
            <div className="bar-track"><div className="bar-fill" style={{ width: `${Math.max(2, (r.revenue_paisa / maxDay) * 100)}%` }} /></div>
            <span className="bar-val">{r.revenue_paisa ? money(r.revenue_paisa) : ""}</span></div>
        ))}</div>
      </section>
      <section className="studio-section"><h2>Orders by status</h2>
        <div className="kv">{Object.entries(d.orders_by_status).map(([s, c]) => <span key={s}><b>{c}</b> {STATUS_LABEL[s] ?? s}</span>)}</div>
      </section>
      <section className="studio-section"><h2>Top products</h2>
        <div className="kv">{d.top_products.map((p) => <span key={p.id}><b>{p.quantity} sold</b> {p.name} · {money(p.revenue_paisa)}</span>)}</div>
      </section>
      <section className="studio-section"><h2>Top categories</h2>
        <div className="kv">{d.top_categories.map((c) => <span key={c.category}><b>{money(c.revenue_paisa)}</b> {c.category}</span>)}</div>
      </section>
      <section className="studio-section"><h2>Top searches</h2>
        <div className="kv">{d.top_searches.length === 0 ? <span className="muted">No searches recorded yet.</span> : d.top_searches.map((s) => <span key={s.query}><b>{s.count}×</b> “{s.query}”</span>)}</div>
      </section>
      <section className="studio-section wide"><h2>Low stock across sellers</h2>
        {d.low_stock_products.length === 0 ? <p className="muted">Nothing is running low.</p> : (
          <div className="kv warn-kv">{d.low_stock_products.map((p) => <span key={p.id}><b>{p.stock} left</b> {p.name} · {p.store_name}</span>)}</div>
        )}
      </section>
    </div>
  );
}

// --- tickets -----------------------------------------------------------------------------
export function AdminTickets() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<string>("open");
  const [replying, setReplying] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const list = useQuery({
    queryKey: ["admin-tickets", filter],
    queryFn: () => api2.adminListTickets(filter === "all" ? {} : { status: filter as "open" | "answered" | "closed" }),
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["admin-tickets"] });
  const sendReply = useMutation({
    mutationFn: (v: { ticket_code: string; reply: string }) => api2.adminReplyTicket(v),
    onSuccess: () => { refresh(); setReplying(null); setReply(""); toast("Reply sent."); },
    onError: (e) => toast(e instanceof Error ? e.message : "Could not send.", "err"),
  });
  const close = useMutation({
    mutationFn: (ticket_code: string) => api2.adminCloseTicket({ ticket_code }),
    onSuccess: () => { refresh(); toast("Ticket closed."); },
  });
  const tickets: P2Ticket[] = list.data?.tickets ?? [];
  return (
    <section className="studio-section wide"><div className="section-title"><h2>Support tickets</h2><span>{tickets.length}</span>
      <label className="muted">Status <select value={filter} onChange={(e) => setFilter(e.target.value)}>
        <option value="open">Open</option><option value="answered">Answered</option><option value="closed">Closed</option><option value="all">All</option>
      </select></label></div>
      {list.isPending && <p className="muted">Loading tickets…</p>}
      {list.error && <p className="form-error">Could not load tickets.</p>}
      {tickets.length === 0 && !list.isPending && <p className="muted">No tickets here.</p>}
      <div className="issues">{tickets.map((t) => (
        <article key={t.ticket_code}>
          <div>
            <p className="eyebrow">{t.ticket_code} · {t.status}{t.order_code ? ` · order ${t.order_code}` : ""} · {fmtDate(t.created_at)}</p>
            <h3>{t.subject}</h3>
            <p><b>{t.name}</b> ({t.contact})</p>
            <p>{t.message}</p>
            {t.admin_reply && <p className="reply"><b>Reply sent:</b> {t.admin_reply}</p>}
            {replying === t.ticket_code && (
              <form className="stack-form compact" onSubmit={(e) => { e.preventDefault(); if (reply.trim()) sendReply.mutate({ ticket_code: t.ticket_code, reply: reply.trim() }); }}>
                <label>Your reply<textarea value={reply} onChange={(e) => setReply(e.target.value)} required /></label>
                <div className="form-pair"><button className="primary" disabled={sendReply.isPending}>Send reply</button><button type="button" className="ghost" onClick={() => setReplying(null)}>Cancel</button></div>
              </form>
            )}
          </div>
          <div className="order-actions">
            {t.status !== "closed" && <button onClick={() => { setReplying(t.ticket_code); setReply(t.admin_reply ?? ""); }}>{t.admin_reply ? "Update reply" : "Reply"}</button>}
            {t.status !== "closed" && <button onClick={() => close.mutate(t.ticket_code)}>Close</button>}
          </div>
        </article>
      ))}</div>
    </section>
  );
}
