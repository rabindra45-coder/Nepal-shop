// Admin panel phase-2 tabs: coupons, categories, homepage (incl. branding),
// analytics, tickets, email/SMTP settings — plus the admin shell sidebar.
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api2, fmtDate, money, uploadBannerImage, type P2Coupon, type P2Ticket } from "./phase2api";
import { api, getAuth, type ApiResponse } from "./api";
import { go } from "./session";
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
      max_discount_paisa: kind === "percent" && d.get("max_discount") ? Math.round(Number(d.get("max_discount")) * 100) : null,
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
            <p className="muted">{c.kind === "percent" ? `${c.value}% off` : c.kind === "fixed" ? `${money(c.value)} off` : "Free shipping"} · min order {money(c.min_order_paisa)}{c.kind === "percent" && c.max_discount_paisa != null ? ` · capped at ${money(c.max_discount_paisa)}` : ""}{c.expires_at ? ` · expires ${fmtDate(c.expires_at)}` : ""}</p>
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
            <label>Max discount, rupees (percent coupons only — empty = no cap)<input name="max_discount" type="number" min="0" step="0.01" defaultValue={editing?.max_discount_paisa != null ? editing.max_discount_paisa / 100 : ""} /></label>
            <label>Expiry date<input name="expires_at" type="date" defaultValue={toDateInput(editing?.expires_at ?? null)} /></label>
          </div>
          <div className="form-pair">
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
// Per-category SEO editor. adminListCategories returns the current
// seo_title/seo_description/intro_content values, so the form prefills with
// whatever is saved; saving writes via adminUpdateCategorySeo.
type SeoCategory = { id: number; seo_title: string | null; seo_description: string | null; intro_content: string | null };
function CategorySeoEditor({ category }: { category: SeoCategory }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [seoTitle, setSeoTitle] = useState(category.seo_title ?? "");
  const [seoDescription, setSeoDescription] = useState(category.seo_description ?? "");
  const [introContent, setIntroContent] = useState(category.intro_content ?? "");
  const saveSeo = useMutation({
    mutationFn: () => api.adminUpdateCategorySeo({
      category_id: category.id,
      seo_title: seoTitle.trim() ? seoTitle.trim() : null,
      seo_description: seoDescription.trim() ? seoDescription.trim() : null,
      intro_content: introContent.trim() ? introContent.trim() : null,
    }),
    onSuccess: () => { toast("Category SEO saved."); void queryClient.invalidateQueries({ queryKey: ["admin-categories"] }); },
    onError: (e) => toast(e instanceof Error ? e.message : "Could not save the SEO fields.", "err"),
  });
  return (
    <details className="seo-editor">
      <summary>Edit SEO</summary>
      <div className="stack-form compact">
        <label>SEO title<input value={seoTitle} onChange={(e) => setSeoTitle(e.target.value)} maxLength={140} placeholder="e.g. Handwoven clothing — Nepal Shop" /></label>
        <label>SEO description<textarea value={seoDescription} onChange={(e) => setSeoDescription(e.target.value)} maxLength={220} rows={2} placeholder="One or two sentences for search results" /></label>
        <label>Intro content<textarea value={introContent} onChange={(e) => setIntroContent(e.target.value)} maxLength={3000} rows={3} placeholder="Category intro shown on the category page" /></label>
        <button className="primary" disabled={saveSeo.isPending} onClick={() => saveSeo.mutate()}>
          {saveSeo.isPending ? "Saving…" : "Save SEO"}
        </button>
      </div>
    </details>
  );
}

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
          <div><h3>{c.name}</h3><p className="muted">/{c.slug} · {c.is_active ? "Visible" : "Hidden"}</p>
            <CategorySeoEditor key={c.id} category={c} />
          </div>
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
      <CategoryRequestReview />
    </section>
  );
}

// v12: admin review of seller-proposed categories. Approval inserts the name
// into the shared categories table (visible to every seller); rejection just
// records the decision. Duplicate names are impossible — the server re-checks
// the slug at decision time.
function CategoryRequestReview() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const list = useQuery({ queryKey: ["admin-category-requests"], queryFn: () => api2.adminListCategoryRequests({}) });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["admin-category-requests"] });
    void queryClient.invalidateQueries({ queryKey: ["admin-categories"] });
  };
  const decide = useMutation({
    mutationFn: (args: { id: number; approve: boolean }) => api2.adminDecideCategoryRequest(args),
    onSuccess: (_d, v) => { toast(v.approve ? "Category approved — it is now available to all sellers." : "Request declined."); refresh(); },
    onError: (e) => toast(e instanceof Error ? e.message : "Could not decide.", "err"),
  });
  const pending = list.data?.requests.filter((r) => r.status === "pending") ?? [];
  const decided = list.data?.requests.filter((r) => r.status !== "pending") ?? [];
  return (
    <div style={{ marginTop: 24 }}>
      <div className="section-title"><h2>Category requests</h2><span>{pending.length} pending</span></div>
      {list.isPending && <p className="muted">Loading requests…</p>}
      {list.error && <p className="form-error">Could not load requests.</p>}
      {list.data && pending.length === 0 && <p className="muted">No pending requests.</p>}
      <div className="admin-table">{pending.map((r) => (
        <article key={r.id}>
          <div><h3>{r.name}</h3><p className="muted">Requested by {r.store_name} ({r.seller_code})</p></div>
          <div className="order-actions">
            <button className="primary" disabled={decide.isPending} onClick={() => decide.mutate({ id: r.id, approve: true })}>Approve</button>
            <button className="text-danger" disabled={decide.isPending} onClick={() => { if (window.confirm(`Decline the category “${r.name}”?`)) decide.mutate({ id: r.id, approve: false }); }}>Decline</button>
          </div>
        </article>
      ))}</div>
      {decided.length > 0 && <details style={{ marginTop: 12 }}><summary className="muted">Decided requests ({decided.length})</summary>
        <div className="admin-table">{decided.map((r) => (
          <div key={r.id} className="admin-row"><span><b>{r.name}</b><small className="muted"> · {r.store_name}</small></span>
            <span className={r.status === "approved" ? "success" : "text-danger"}>{r.status === "approved" ? "Approved" : "Declined"}</span>
          </div>
        ))}</div>
      </details>}
    </div>
  );
}

// --- homepage ----------------------------------------------------------------------

// --- site logo uploads -----------------------------------------------------------
// The site/app logo goes to /api/site-logo-uploads on the self-hosted server
// (multipart field "file", admin session token in the x-auth-token header —
// the same pattern as the banner uploads in phase2api). Returns
// { data: { url } }; the upload persists the logo and the public homepage
// payload exposes it as `site_logo_url` for the navbar and hero to display.
async function uploadSiteLogo(file: File): Promise<string> {
  const token = getAuth()?.token;
  if (!token) throw new Error("Please sign in as admin first.");
  const form = new FormData();
  form.append("file", file);
  const res = await fetch("/api/site-logo-uploads", { method: "POST", headers: { "x-auth-token": token }, body: form });
  const body = await res.json().catch(() => ({})) as { data?: { url: string }; error?: string };
  if (!res.ok || !body.data?.url) throw new Error(body.error ?? "Upload failed.");
  return body.data.url;
}

export function AdminHomepage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [banner, setBanner] = useState<{ id?: number; title: string; subtitle: string; link: string; image_url: string; is_active: boolean; sort_order: number } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [logoUploading, setLogoUploading] = useState(false);
  const [newLogo, setNewLogo] = useState<string | null>(null);
  const banners = useQuery({ queryKey: ["admin-banners"], queryFn: () => api2.adminListBanners({}) });
  const sections = useQuery({ queryKey: ["admin-sections"], queryFn: () => api2.adminListSections({}) });
  // The public homepage payload carries the current logo as `site_logo_url`
  // (wired by the display-side worker); read defensively until it lands.
  const home = useQuery({ queryKey: ["admin-homepage-public"], queryFn: () => api2.getHomepage({}) });
  const currentLogo = newLogo ?? (home.data as unknown as { site_logo_url?: string | null } | undefined)?.site_logo_url ?? null;
  const refresh = () => { void queryClient.invalidateQueries({ queryKey: ["admin-banners"] }); void queryClient.invalidateQueries({ queryKey: ["admin-sections"] }); };

  const pickBannerImage = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    try {
      const url = await uploadBannerImage(file);
      setBanner((b) => (b ? { ...b, image_url: url } : b));
      toast("Banner image uploaded.");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Upload failed.", "err");
    } finally {
      setUploading(false);
    }
  };

  const pickSiteLogo = async (file: File | undefined) => {
    if (!file) return;
    const allowed = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    if (!allowed.includes(file.type)) { toast(`"${file.name}" is not a JPG, PNG, WebP or GIF image.`, "err"); return; }
    if (file.size > 5 * 1024 * 1024) { toast(`"${file.name}" is over 5 MB.`, "err"); return; }
    setLogoUploading(true);
    try {
      const url = await uploadSiteLogo(file);
      setNewLogo(url);
      toast("Site logo uploaded.");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Upload failed.", "err");
    } finally {
      setLogoUploading(false);
    }
  };

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
      <section className="studio-section wide"><div className="section-title"><h2>Branding</h2></div>
        <p className="muted">The site logo appears in the navbar and on the homepage hero.</p>
        <label>Site logo
          <input type="file" accept="image/jpeg,image/png,image/webp,image/gif" disabled={logoUploading}
            onChange={(e) => { void pickSiteLogo(e.target.files?.[0]); e.target.value = ""; }} />
          <small>JPG, PNG, WebP or GIF, up to 5 MB. A square image looks best.</small>
        </label>
        {logoUploading && <p className="muted">Uploading logo…</p>}
        {currentLogo
          ? <p><img src={currentLogo} alt="Current site logo" style={{ maxHeight: 72, borderRadius: 8, border: "1px solid var(--border)" }} /></p>
          : <p className="muted">{home.isPending ? "Loading current logo…" : "No site logo uploaded yet."}</p>}
      </section>
      <section className="studio-section wide"><div className="section-title"><h2>Advertisements</h2>{!banner && <button onClick={() => setBanner({ title: "", subtitle: "", link: "", image_url: "", is_active: true, sort_order: 0 })}>+ New advertisement</button>}</div>
        <p className="muted">Advertisements appear as an image carousel on the homepage. Every advertisement is shown with its image, so an image is required.</p>
        {banners.isPending && <p className="muted">Loading advertisements…</p>}
        <div className="admin-table">{banners.data?.banners.map((b) => (
          <article key={b.id}>
            <div className="banner-row">
              {b.image_url ? <img src={b.image_url} alt="" className="banner-thumb" /> : <span className="banner-thumb empty">No image</span>}
              <div><h3>{b.title}</h3><p className="muted">{b.subtitle ?? "—"} · link {b.link ?? "—"} · order {b.sort_order} · {b.is_active ? "Active" : "Hidden"}</p></div>
            </div>
            <div className="order-actions">
              <button onClick={() => setBanner({ id: b.id, title: b.title, subtitle: b.subtitle ?? "", link: b.link ?? "", image_url: b.image_url ?? "", is_active: b.is_active, sort_order: b.sort_order })}>Edit</button>
              <button className="text-danger" onClick={() => { if (window.confirm("Delete this advertisement?")) deleteBanner.mutate(b.id); }}>Delete</button>
            </div>
          </article>
        ))}</div>
        {banner && (
          <form className="stack-form" onSubmit={(e) => {
            e.preventDefault();
            if (!banner.image_url) { toast("Please upload a banner image first.", "err"); return; }
            saveBanner.mutate({ id: banner.id, title: banner.title, subtitle: banner.subtitle || null, link: banner.link || null, image_url: banner.image_url, is_active: banner.is_active, sort_order: banner.sort_order });
          }}>
            <label>Advertisement image (required)
              <input type="file" accept="image/jpeg,image/png,image/webp,image/gif" disabled={uploading}
                onChange={(e) => { void pickBannerImage(e.target.files?.[0]); e.target.value = ""; }} />
              <small>JPG, PNG, WebP or GIF, up to 5 MB. Wide images (about 16:9) look best.</small>
            </label>
            {uploading && <p className="muted">Uploading image…</p>}
            {banner.image_url && <img src={banner.image_url} alt="Advertisement preview" className="banner-preview" />}
            <label>Title<input value={banner.title} onChange={(e) => setBanner({ ...banner, title: e.target.value })} required /></label>
            <label>Subtitle<input value={banner.subtitle} onChange={(e) => setBanner({ ...banner, subtitle: e.target.value })} /></label>
            <div className="form-pair">
              <label>Link (hash route, e.g. #/search)<input value={banner.link} onChange={(e) => setBanner({ ...banner, link: e.target.value })} placeholder="#/search" /></label>
              <label>Sort order<input type="number" value={banner.sort_order} onChange={(e) => setBanner({ ...banner, sort_order: Number(e.target.value) })} /></label>
            </div>
            <label className="check"><input type="checkbox" checked={banner.is_active} onChange={(e) => setBanner({ ...banner, is_active: e.target.checked })} /> Active</label>
            <div className="form-pair"><button className="primary" disabled={saveBanner.isPending || uploading || !banner.image_url}>Save advertisement</button><button type="button" className="ghost" onClick={() => setBanner(null)}>Cancel</button></div>
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
  const f = d.funnel;
  const maxDay = Math.max(1, ...d.revenue_by_day.map((r) => r.revenue_paisa));
  const funnelEmpty = f.views_30d === 0 && f.add_to_cart_30d === 0;
  return (
    <div className="studio-layout">
      <section className="studio-section wide"><h2>Marketplace health</h2>
        <div className="stat-grid">
          <div><b>{d.conversion_pct.toFixed(1)}%</b><span>View → order conversion (30d)</span></div>
          <div><b>{money(d.aov_paisa)}</b><span>Average order value</span></div>
          <div><b>{money(d.totals.revenue_paisa_30d)}</b><span>Revenue (30d)</span></div>
          <div><b>{d.totals.customers_30d}</b><span>Customers (30d)</span></div>
          <div><b>{Object.values(d.orders_by_status).reduce((s, c) => s + c, 0)}</b><span>Total orders</span></div>
          <div className={d.low_stock_products.length ? "alert" : ""}><b>{d.low_stock_products.length}</b><span>Products low on stock</span></div>
        </div>
      </section>
      <section className="studio-section wide"><h2>Purchase funnel (30d)</h2>
        {funnelEmpty ? (
          <p className="muted">No shopper activity recorded yet. The funnel fills in as customers browse products, add items to their carts and check out.</p>
        ) : (
          <>
            <div className="stat-grid">
              <div><b>{f.views_30d}</b><span>Product views</span></div>
              <div><b>{f.add_to_cart_30d}</b><span>Added to cart</span></div>
              <div><b>{f.checkout_start_30d}</b><span>Checkout started</span></div>
              <div><b>{f.purchases_30d}</b><span>Orders placed</span></div>
            </div>
            <div className="kv">
              <span><b>{f.view_to_cart_pct.toFixed(1)}%</b> of views led to a cart</span>
              <span><b>{f.cart_to_checkout_pct.toFixed(1)}%</b> of carts reached checkout</span>
              <span><b>{f.checkout_to_purchase_pct.toFixed(1)}%</b> of checkouts became orders</span>
              <span><b>{f.cart_abandonment_pct.toFixed(1)}%</b> cart abandonment</span>
            </div>
          </>
        )}
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

// --- payments -----------------------------------------------------------------------
// Real payment rows from the database, with the live commission rules,
// payout queue and ledger-derived seller balances underneath.
export function AdminPayments() {
  const [filter, setFilter] = useState<string>("all");
  const list = useQuery({
    queryKey: ["admin-payments", filter],
    queryFn: () => api.adminListPayments(filter === "all" ? {} : { status: filter as "pending" | "processing" | "paid" | "failed" | "refunded" | "cancelled" }),
  });
  const rows = list.data?.payments ?? [];
  const paidTotal = rows.filter((p) => p.status === "paid").reduce((n, p) => n + p.amount_paisa, 0);
  const refundedTotal = rows.filter((p) => p.status === "refunded").reduce((n, p) => n + p.amount_paisa, 0);
  return (
    <div className="studio-layout">
      <section className="studio-section wide"><div className="section-title"><h2>Payments</h2><span>{rows.length}</span>
        <label className="muted">Status <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="all">All</option><option value="pending">Pending</option><option value="processing">Processing</option>
          <option value="paid">Paid</option><option value="failed">Failed</option><option value="refunded">Refunded</option><option value="cancelled">Cancelled</option>
        </select></label></div>
        <div className="stat-grid">
          <div><b>{money(paidTotal)}</b><span>Collected (paid)</span></div>
          <div><b>{money(refundedTotal)}</b><span>Refunded</span></div>
        </div>
        {list.isPending && <p className="muted">Loading payments…</p>}
        {list.error && <p className="form-error">Could not load payments.</p>}
        {rows.length === 0 && !list.isPending && <p className="muted">No payment records yet.</p>}
        <div className="admin-table">{rows.map((p) => (
          <article key={p.id}>
            <div><h3>{p.group_code ?? p.order_code}</h3><p className="muted">{p.store_name} · {p.provider === "cod" ? "Cash on delivery" : p.provider}{p.group_code ? ` · fulfilment ${p.order_code}` : ""}</p><small>{fmtDate(p.created_at)}</small></div>
            <div className="order-actions"><b>{money(p.amount_paisa)}</b><span className={`status ${p.status}`}>{p.status}</span></div>
          </article>
        ))}</div>
      </section>
      <section className="studio-section wide"><h2>Commission rules</h2><AdminCommission /></section>
      <section className="studio-section wide"><h2>Payout queue</h2><AdminPayouts /></section>
      <section className="studio-section wide"><h2>Seller balances</h2><AdminSellerBalances /></section>
    </div>
  );
}

// --- review moderation --------------------------------------------------------------
const REPORT_REASONS: Record<string, string> = { spam: "Spam", abuse: "Abusive content", fake: "Fake review", other: "Other" };
export function AdminReviewReports() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<string>("open");
  const list = useQuery({
    queryKey: ["admin-review-reports", filter],
    queryFn: () => api.adminListReviewReports(filter === "all" ? {} : { status: filter as "open" | "resolved" }),
  });
  const refresh = () => { void queryClient.invalidateQueries({ queryKey: ["admin-review-reports"] }); void queryClient.invalidateQueries({ queryKey: ["admin-stats"] }); };
  const resolve = useMutation({
    mutationFn: (v: { report_id: number; decision: "dismiss" | "delete_review" }) => api.adminResolveReviewReport(v),
    onSuccess: () => { refresh(); toast("Report handled."); },
    onError: (e) => toast(e instanceof Error ? e.message : "Could not handle the report.", "err"),
  });
  const rows = list.data?.reports ?? [];
  return (
    <section className="studio-section wide"><div className="section-title"><h2>Review reports</h2><span>{rows.length}</span>
      <label className="muted">Status <select value={filter} onChange={(e) => setFilter(e.target.value)}>
        <option value="open">Open</option><option value="resolved">Resolved</option><option value="all">All</option>
      </select></label></div>
      {list.isPending && <p className="muted">Loading reports…</p>}
      {list.error && <p className="form-error">Could not load reports.</p>}
      {rows.length === 0 && !list.isPending && <p className="muted">No review reports here.</p>}
      <div className="issues">{rows.map((r) => (
        <article key={r.id}>
          <div>
            <p className="eyebrow">{REPORT_REASONS[r.reason] ?? r.reason} · reported by {r.reporter_name} · {fmtDate(r.created_at)} · {r.status}</p>
            {r.review ? (<>
              <p><b>{r.review.product_name}</b> <span className="muted">· {r.review.store_name}</span></p>
              <p><b>{"★".repeat(r.review.rating)}{"☆".repeat(5 - r.review.rating)}</b> — “{r.review.body}”</p>
              <small className="muted">Written by {r.review.reviewer_name}</small>
            </>) : <p className="muted">The review was already removed.</p>}
            {r.detail && <p><small>Reporter's note: {r.detail}</small></p>}
          </div>
          {r.status === "open" && r.review && <div className="order-actions">
            <button disabled={resolve.isPending} onClick={() => resolve.mutate({ report_id: r.id, decision: "dismiss" })}>Dismiss report</button>
            <button className="text-danger" disabled={resolve.isPending} onClick={() => { if (window.confirm("Delete this review? This cannot be undone.")) resolve.mutate({ report_id: r.id, decision: "delete_review" }); }}>Delete review</button>
          </div>}
        </article>
      ))}</div>
    </section>
  );
}

// --- audit log ------------------------------------------------------------------------
export function AdminAuditLog() {
  const PAGE = 50;
  const [offset, setOffset] = useState(0);
  const list = useQuery({ queryKey: ["admin-audit", offset], queryFn: () => api.adminListAuditLogs({ limit: PAGE, offset }) });
  const rows = list.data?.entries ?? [];
  const total = list.data?.total ?? 0;
  return (
    <section className="studio-section wide"><div className="section-title"><h2>Audit log</h2><span>{total}</span></div>
      <p className="muted">Append-only record of sensitive actions: seller status changes, buyer suspensions, product visibility, order changes, refunds, password changes and moderation decisions.</p>
      {list.isPending && <p className="muted">Loading audit entries…</p>}
      {list.error && <p className="form-error">Could not load the audit log.</p>}
      {rows.length === 0 && !list.isPending && <p className="muted">No audit entries yet.</p>}
      <div className="admin-table">{rows.map((e) => (
        <article key={e.id}>
          <div><h3>{e.action.replace(/_/g, " ")}</h3>
            <p className="muted">{e.actor_type} {e.actor_id}{e.entity_type ? ` · ${e.entity_type} ${e.entity_id}` : ""}</p>
            {e.detail && <p><small>{e.detail}</small></p>}
            <small>{fmtDate(e.created_at)}</small></div>
        </article>
      ))}</div>
      <div className="form-pair">
        <button className="ghost" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>← Newer</button>
        <button className="ghost" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>Older →</button>
      </div>
    </section>
  );
}

// --- returns -----------------------------------------------------------------
// Marketplace-level return review: a seller's accept or reject can be
// overruled here (buyer protection). Every decision is recorded with who
// made it and when.
export function AdminReturns() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<string>("all");
  const list = useQuery({
    queryKey: ["admin-returns", filter],
    queryFn: () => api2.adminListReturns(filter === "all" ? {} : { status: filter as "requested" | "accepted" | "rejected" }),
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["admin-returns"] });
  const decide = useMutation({
    mutationFn: (v: { order_id: number; decision: "accepted" | "rejected" }) => api2.adminUpdateReturnStatus(v),
    onSuccess: () => { refresh(); toast("Return decision recorded."); },
    onError: (e) => toast(e instanceof Error ? e.message : "Could not update.", "err"),
  });
  const rows = list.data?.returns ?? [];
  const statusLabel: Record<string, string> = { requested: "Awaiting decision", accepted: "Accepted", rejected: "Rejected" };
  return (
    <section className="studio-section wide"><div className="section-title"><h2>Returns</h2><span>{rows.length}</span>
      <label className="muted">Status <select value={filter} onChange={(e) => setFilter(e.target.value)}>
        <option value="all">All</option><option value="requested">Awaiting decision</option><option value="accepted">Accepted</option><option value="rejected">Rejected</option>
      </select></label></div>
      {list.isPending && <p className="muted">Loading returns…</p>}
      {list.error && <p className="form-error">Could not load returns.</p>}
      {rows.length === 0 && !list.isPending && <p className="muted">No returns here yet.</p>}
      <div className="order-admin">{rows.map((r) => (
        <article key={r.id}>
          <div>
            <p className="eyebrow">{r.order_code} · {r.store_name} · {statusLabel[r.status] ?? r.status}</p>
            <h3>Reason given</h3>
            <p>{r.reason}</p>
            <p className="muted">Requested by {r.requested_by === "buyer" ? "the buyer" : r.requested_by === "admin" ? "admin" : r.requested_by}{r.decided_by ? ` · decided by ${r.decided_by}` : ""} · {fmtDate(r.created_at)}</p>
          </div>
          <div className="order-actions">
            <button className="primary" disabled={decide.isPending} onClick={() => decide.mutate({ order_id: r.order_id, decision: "accepted" })}>Accept return</button>
            <button disabled={decide.isPending} onClick={() => decide.mutate({ order_id: r.order_id, decision: "rejected" })}>Reject</button>
          </div>
        </article>
      ))}</div>
    </section>
  );
}

// --- refunds -----------------------------------------------------------------
// The only honest place a refund moves: the marketplace team completes each
// refund manually (wallet/bank transfer) and records a reference. Nothing
// here pretends money moved before this queue says so.
export function AdminRefunds() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<string>("pending");
  const [reference, setReference] = useState<Record<number, string>>({});
  const list = useQuery({
    queryKey: ["admin-refunds", filter],
    queryFn: () => api2.adminListRefunds(filter === "all" ? {} : { status: filter as "not_required" | "pending" | "completed" | "failed" }),
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["admin-refunds"] });
  const resolve = useMutation({
    mutationFn: (v: { refund_id: number; decision: "completed" | "failed"; reference: string }) => api2.adminResolveRefund(v),
    onSuccess: () => { refresh(); toast("Refund decision recorded."); },
    onError: (e) => toast(e instanceof Error ? e.message : "Could not resolve.", "err"),
  });
  const rows = list.data?.refunds ?? [];
  const statusLabel: Record<string, string> = { not_required: "Not required", pending: "Waiting on the team", completed: "Completed", failed: "Failed — retry" };
  return (
    <section className="studio-section wide"><div className="section-title"><h2>Refunds</h2><span>{rows.length}</span>
      <label className="muted">Status <select value={filter} onChange={(e) => setFilter(e.target.value)}>
        <option value="pending">Waiting on the team</option><option value="failed">Failed</option><option value="completed">Completed</option><option value="not_required">Not required</option><option value="all">All</option>
      </select></label></div>
      <p className="muted">Refunds are completed manually by the marketplace team — eSewa/Khalti refunds are initiated in the provider’s own dashboard. Partial provider refunds are not supported, so a multi-seller group is only marked fully refunded once every fulfilment’s refund is complete.</p>
      {list.isPending && <p className="muted">Loading refunds…</p>}
      {list.error && <p className="form-error">Could not load refunds.</p>}
      {rows.length === 0 && !list.isPending && <p className="muted">Nothing waiting in this queue.</p>}
      <div className="order-admin">{rows.map((r) => (
        <article key={r.id}>
          <div>
            <p className="eyebrow">{r.order_code} · {r.store_name} · {statusLabel[r.status] ?? r.status}</p>
            <h3>{money(r.amount_paisa)} · {r.provider.toUpperCase()}</h3>
            {r.note && <p>{r.note}</p>}
            <p className="muted">Requested by {r.requested_by} · {fmtDate(r.created_at)}{r.resolved_by ? ` · resolved by ${r.resolved_by}` : ""}</p>
          </div>
          {(r.status === "pending" || r.status === "failed") && (
            <div className="order-actions">
              <label>Reference<input placeholder="e.g. eSewa txn id" value={reference[r.id] ?? ""} onChange={(e) => setReference({ ...reference, [r.id]: e.target.value })} maxLength={160} /></label>
              <button className="primary" disabled={resolve.isPending} onClick={() => { const ref = (reference[r.id] ?? "").trim(); if (!ref) { toast("A reference is required so the refund stays traceable.", "err"); return; } resolve.mutate({ refund_id: r.id, decision: "completed", reference: ref }); }}>Mark completed</button>
              <button className="text-danger" disabled={resolve.isPending} onClick={() => { const ref = (reference[r.id] ?? "").trim(); if (!ref) { toast("A reference is required — note why it failed.", "err"); return; } resolve.mutate({ refund_id: r.id, decision: "failed", reference: ref }); }}>Mark failed</button>
            </div>
          )}
        </article>
      ))}</div>
    </section>
  );
}

// --- shipping settings --------------------------------------------------------
// Admin-configurable delivery methods and the express surcharge. The
// checkout reads these live; there is no separate courier integration, so
// sellers ship with their own couriers and attach tracking numbers.
export function AdminShippingSettings() {
  const { toast } = useToast();
  const settings = useQuery({ queryKey: ["admin-shipping-settings"], queryFn: () => api2.adminGetShippingSettings({}) });
  const [fee, setFee] = useState("");
  const [standard, setStandard] = useState(true);
  const [express, setExpress] = useState(true);
  const [pickup, setPickup] = useState(true);
  const data = settings.data;
  useEffect(() => {
    if (data) {
      setFee(String((data.express_fee_paisa / 100).toFixed(0)));
      setStandard(data.standard_enabled);
      setExpress(data.express_enabled);
      setPickup(data.pickup_enabled);
    }
  }, [data]);
  const save = useMutation({
    mutationFn: () => api2.adminSaveShippingSettings({
      express_fee_paisa: Math.max(0, Math.round(Number(fee) * 100) || 0),
      standard_enabled: standard, express_enabled: express, pickup_enabled: pickup,
    }),
    onSuccess: () => { toast("Shipping settings saved."); },
    onError: (e) => toast(e instanceof Error ? e.message : "Could not save.", "err"),
  });
  if (settings.isPending) return <p className="muted">Loading shipping settings…</p>;
  if (settings.error) return <p className="form-error">Could not load shipping settings.</p>;
  return (
    <section className="studio-section"><div className="section-title"><h2>Shipping settings</h2></div>
      <p className="muted">The express surcharge applies per seller, since each seller ships their own parcel. There is no courier integration yet — sellers ship with their own couriers and add the tracking number to each order.</p>
      <form className="stack-form" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <label>Express surcharge per seller, rupees<input type="number" min="0" step="1" value={fee} onChange={(e) => setFee(e.target.value)} required /></label>
        <label className="check"><input type="checkbox" checked={standard} onChange={(e) => setStandard(e.target.checked)} /> Standard delivery offered</label>
        <label className="check"><input type="checkbox" checked={express} onChange={(e) => setExpress(e.target.checked)} /> Express delivery offered</label>
        <label className="check"><input type="checkbox" checked={pickup} onChange={(e) => setPickup(e.target.checked)} /> Pick up from seller offered</label>
        <button className="primary" disabled={save.isPending}>{save.isPending ? "Saving…" : "Save shipping settings"}</button>
      </form>
    </section>
  );
}

// --- commission + payouts (money checkpoint) ------------------------------------
// Real rules engine, payout queue and ledger-derived balances. No invented
// numbers anywhere: every figure comes from the seller_ledger.
type CommissionScope = "platform" | "category" | "seller" | "product" | "campaign";
type CommissionRule = {
  id: number; scope: CommissionScope; scope_id: string; percent: number; label: string;
  starts_at: string | null; ends_at: string | null; is_active: boolean; created_at: string;
};
type PayoutRow = {
  id: number; store_id: number; store_name: string; seller_code: string; amount_paisa: number;
  status: "requested" | "processing" | "completed" | "failed" | "cancelled";
  method: "bank" | "esewa" | "khalti"; destination: string; reference: string | null; note: string;
  created_at: string; updated_at: string;
};
const SCOPE_LABEL: Record<CommissionScope, string> = {
  platform: "Platform default", category: "Category", seller: "Seller", product: "Product", campaign: "Campaign",
};
const PAYOUT_STATUS_LABEL: Record<string, string> = {
  requested: "Requested", processing: "Processing", completed: "Completed", failed: "Failed", cancelled: "Cancelled",
};
const PAYOUT_METHOD_LABEL: Record<string, string> = { bank: "Bank transfer", esewa: "eSewa", khalti: "Khalti" };

function scopeTargetLabel(r: CommissionRule): string {
  if (r.scope === "platform") return "everywhere";
  if (r.scope === "campaign") return `${r.scope_id}${r.label ? ` — ${r.label}` : ""}`;
  return r.scope_id;
}

export function AdminCommission() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const rules = useQuery({ queryKey: ["admin-commission-rules"], queryFn: () => api.adminListCommissionRules({}) });
  const settings = useQuery({ queryKey: ["admin-money-settings"], queryFn: () => api.adminGetMoneySettings({}) });
  const [editingId, setEditingId] = useState<number | null>(null);
  const [scope, setScope] = useState<CommissionScope>("platform");
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["admin-commission-rules"] });
    void queryClient.invalidateQueries({ queryKey: ["admin-money-settings"] });
    void queryClient.invalidateQueries({ queryKey: ["admin-seller-balances"] });
  };
  const save = useMutation({
    mutationFn: (v: { scope: CommissionScope; scope_id: string; percent: number; label?: string; starts_at?: string; ends_at?: string; is_active: boolean }) =>
      api.adminSaveCommissionRule(v),
    onSuccess: () => { setEditingId(null); refresh(); toast("Commission rule saved — it prices new sales from now on."); },
    onError: (e) => toast(e instanceof Error ? e.message : "Could not save the rule.", "err"),
  });
  const remove = useMutation({
    mutationFn: (rule_id: number) => api.adminDeleteCommissionRule({ rule_id }),
    onSuccess: () => { setConfirmDelete(null); refresh(); toast("Rule deleted."); },
    onError: (e) => toast(e instanceof Error ? e.message : "Could not delete the rule.", "err"),
  });
  const saveSettings = useMutation({
    mutationFn: (v: { commission_default_percent: number; payout_available_after_days: number; payout_min_paisa: number }) =>
      api.adminSaveMoneySettings(v),
    onSuccess: () => { refresh(); toast("Money settings saved."); },
    onError: (e) => toast(e instanceof Error ? e.message : "Could not save.", "err"),
  });
  const rows: CommissionRule[] = rules.data?.rules ?? [];
  const editing: CommissionRule | undefined = editingId != null && editingId !== -1 ? rows.find((r) => r.id === editingId) : undefined;
  const effScope = editing?.scope ?? scope;
  const toLocal = (iso: string | null) => (iso ? iso.slice(0, 16) : "");
  const submitRule = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    const s = (editing?.scope ?? String(d.get("scope"))) as CommissionScope;
    const percent = Math.round(Number(d.get("percent")));
    if (!Number.isInteger(percent) || percent < 0 || percent > 90) { toast("Commission must be 0–90%.", "err"); return; }
    const v: { scope: CommissionScope; scope_id: string; percent: number; label?: string; starts_at?: string; ends_at?: string; is_active: boolean } = {
      scope: s,
      scope_id: s === "platform" ? "" : String(d.get("scope_id") ?? "").trim(),
      percent,
      label: String(d.get("label") ?? "").trim() || undefined,
      is_active: d.get("is_active") === "on",
    };
    if (s === "campaign") {
      const st = String(d.get("starts_at") ?? "").trim(), en = String(d.get("ends_at") ?? "").trim();
      if (st) v.starts_at = new Date(st).toISOString();
      if (en) v.ends_at = new Date(en).toISOString();
    }
    save.mutate(v);
  };
  const submitSettings = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    saveSettings.mutate({
      commission_default_percent: Math.round(Number(d.get("default_percent"))),
      payout_available_after_days: Math.round(Number(d.get("hold_days"))),
      payout_min_paisa: Math.round(Number(d.get("min_payout")) * 100),
    });
  };
  const scopeIdHint: Record<CommissionScope, string> = {
    platform: "", category: "Category name, exactly as on products", seller: "Seller id (number)",
    product: "Product id (number)", campaign: "Campaign code, e.g. dashain-sale",
  };
  return (
    <div>
      {rules.isPending ? <p className="muted">Loading rules…</p> : rules.error ? <p className="form-error">Rules could not load.</p> : (
        <>
          {rows.length === 0 && <p className="muted">No rules yet — sales use the platform default below.</p>}
          <div className="kv">{rows.map((r) => (
            <span key={r.id} className={!r.is_active ? "muted" : undefined}>
              <b>{r.percent}%</b> {SCOPE_LABEL[r.scope]} · {scopeTargetLabel(r)}
              {r.scope === "campaign" && (r.starts_at || r.ends_at) && <small> · {r.starts_at ? fmtDate(r.starts_at) : "…"} → {r.ends_at ? fmtDate(r.ends_at) : "…"}</small>}
              {!r.is_active && <small> · inactive</small>}
              <span className="variant-actions">
                <button type="button" onClick={() => { setEditingId(r.id); setScope(r.scope); setConfirmDelete(null); }}>Edit</button>
                {confirmDelete === r.id
                  ? <button type="button" className="text-danger" disabled={remove.isPending} onClick={() => remove.mutate(r.id)}>Confirm</button>
                  : <button type="button" onClick={() => setConfirmDelete(r.id)}>Delete</button>}
              </span>
            </span>
          ))}</div>
        </>
      )}
      {editingId === -1 || editing ? (
        <form className="stack-form compact" key={editing?.id ?? "new"} onSubmit={submitRule}>
          <div className="form-pair">
            <label>Scope<select name="scope" defaultValue={editing?.scope ?? scope} disabled={!!editing} onChange={(e) => setScope(e.target.value as CommissionScope)}>
              {(Object.keys(SCOPE_LABEL) as CommissionScope[]).map((s) => <option key={s} value={s}>{SCOPE_LABEL[s]}</option>)}
            </select></label>
            <label>Commission %<input name="percent" type="number" min={0} max={90} defaultValue={editing?.percent ?? 5} required /></label>
          </div>
          {effScope !== "platform" && (
            <label>Target <small>{scopeIdHint[effScope]}</small>
              <input name="scope_id" defaultValue={editing?.scope_id ?? ""} required disabled={!!editing} maxLength={80} />
            </label>
          )}
          <label>Label (optional)<input name="label" defaultValue={editing?.label ?? ""} maxLength={80} placeholder='e.g. "Festive offer"' /></label>
          {effScope === "campaign" && (
            <div className="form-pair">
              <label>Starts<input name="starts_at" type="datetime-local" defaultValue={toLocal(editing?.starts_at ?? null)} /></label>
              <label>Ends<input name="ends_at" type="datetime-local" defaultValue={toLocal(editing?.ends_at ?? null)} /></label>
            </div>
          )}
          <label className="check"><input name="is_active" type="checkbox" defaultChecked={editing?.is_active ?? true} /> Active</label>
          <div className="form-row">
            <button className="primary" disabled={save.isPending}>{save.isPending ? "Saving…" : editing ? "Save rule" : "Add rule"}</button>
            <button type="button" onClick={() => setEditingId(null)}>Cancel</button>
          </div>
          <small className="muted">Resolution per order line: product → seller → category → active campaign → platform → default. Rules price new sales only; past ledger rows never change.</small>
        </form>
      ) : (
        <p><button type="button" className="up-add-inline" onClick={() => { setEditingId(-1); setConfirmDelete(null); }}>+ Add a commission rule</button></p>
      )}
      <h3>Platform money settings</h3>
      {settings.isPending ? <p className="muted"><small>Loading…</small></p> : settings.error ? <p className="form-error">Settings could not load.</p> : (
        <form className="stack-form compact" key={JSON.stringify(settings.data)} onSubmit={submitSettings}>
          <div className="form-pair">
            <label>Default commission %<input name="default_percent" type="number" min={0} max={90} defaultValue={settings.data!.commission_default_percent} required /></label>
            <label>Earnings hold, days after delivery<input name="hold_days" type="number" min={0} max={90} defaultValue={settings.data!.payout_available_after_days} required /></label>
          </div>
          <label>Minimum payout, rupees<input name="min_payout" type="number" min={0} step={0.01} defaultValue={settings.data!.payout_min_paisa / 100} required /></label>
          <button className="primary" disabled={saveSettings.isPending}>{saveSettings.isPending ? "Saving…" : "Save money settings"}</button>
        </form>
      )}
    </div>
  );
}

export function AdminPayouts() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [refNote, setRefNote] = useState<Record<number, string>>({});
  const queue = useQuery({
    queryKey: ["admin-payouts-queue"],
    queryFn: async () => {
      const [req, proc] = await Promise.all([api.adminListPayouts({ status: "requested" }), api.adminListPayouts({ status: "processing" })]);
      return [...req.payouts, ...proc.payouts].sort((a, b) => a.id - b.id) as PayoutRow[];
    },
  });
  const history = useQuery({ queryKey: ["admin-payouts-history"], queryFn: () => api.adminListPayouts({}) });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["admin-payouts-queue"] });
    void queryClient.invalidateQueries({ queryKey: ["admin-payouts-history"] });
    void queryClient.invalidateQueries({ queryKey: ["admin-seller-balances"] });
  };
  const setStatus = useMutation({
    mutationFn: (v: { payout_id: number; status: "processing" | "completed" | "failed" | "cancelled"; reference?: string; note?: string }) =>
      api.adminSetPayoutStatus(v),
    onSuccess: (_, v) => {
      setRefNote((m) => { const c = { ...m }; delete c[v.payout_id]; return c; });
      refresh();
      toast(v.status === "completed" ? "Payout completed — the seller's balance was debited." : `Payout ${v.status}.`);
    },
    onError: (e) => toast(e instanceof Error ? e.message : "Could not update the payout.", "err"),
  });
  const rows = queue.data ?? [];
  const past: PayoutRow[] = (history.data?.payouts ?? []).filter((p) => p.status === "completed" || p.status === "failed" || p.status === "cancelled");
  const act = (p: PayoutRow, status: "processing" | "completed" | "failed" | "cancelled") => {
    const text = (refNote[p.id] ?? "").trim();
    if (status === "completed" && text.length < 2) { toast("Enter the bank/wallet transaction reference to complete.", "err"); return; }
    setStatus.mutate({ payout_id: p.id, status, reference: status === "completed" ? text : undefined, note: status === "completed" ? undefined : text || undefined });
  };
  return (
    <div>
      <h3>Waiting ({rows.length})</h3>
      {queue.isPending ? <p className="muted">Loading queue…</p> : queue.error ? <p className="form-error">Queue could not load.</p> :
        rows.length === 0 ? <p className="muted">Nothing waiting — the queue is clear.</p> : (
          <div className="issues">{rows.map((p) => (
            <article key={p.id}>
              <div>
                <p className="eyebrow">{p.store_name} · {p.seller_code} · {fmtDate(p.created_at)}</p>
                <h3>{money(p.amount_paisa)} <small>· {PAYOUT_METHOD_LABEL[p.method]} · {p.destination}</small></h3>
                <p><span className={`status ${p.status}`}>{PAYOUT_STATUS_LABEL[p.status]}</span></p>
                <label><small>{p.status === "processing" ? "Transaction reference (required to complete)" : "Reference / note (optional)"}</small>
                  <input value={refNote[p.id] ?? ""} onChange={(e) => setRefNote((m) => ({ ...m, [p.id]: e.target.value }))} maxLength={160} placeholder={p.status === "processing" ? "e.g. NBLFT20260922001" : "Optional note"} />
                </label>
              </div>
              <div className="order-actions">
                {p.status === "requested" && <button className="primary" disabled={setStatus.isPending} onClick={() => act(p, "processing")}>Start processing</button>}
                {p.status === "processing" && <button className="primary" disabled={setStatus.isPending} onClick={() => act(p, "completed")}>Complete payout</button>}
                <button disabled={setStatus.isPending} onClick={() => act(p, "failed")}>Fail</button>
                {p.status === "requested" && <button disabled={setStatus.isPending} onClick={() => act(p, "cancelled")}>Cancel</button>}
              </div>
            </article>
          ))}</div>
        )}
      <h3>History</h3>
      {history.isPending ? <p className="muted"><small>Loading…</small></p> :
        past.length === 0 ? <p className="muted">No completed payouts yet.</p> : (
          <div className="kv">{past.slice(0, 30).map((p) => (
            <span key={p.id}>
              <b>{money(p.amount_paisa)}</b> {p.store_name} · {PAYOUT_METHOD_LABEL[p.method]} · {PAYOUT_STATUS_LABEL[p.status]}
              {p.reference && <small> · ref {p.reference}</small>}{p.note && <small> · {p.note}</small>}
              <small> ({fmtDate(p.updated_at)})</small>
            </span>
          ))}</div>
        )}
      <AdminAdjustment onDone={refresh} />
    </div>
  );
}

function AdminAdjustment({ onDone }: { onDone: () => void }) {
  const { toast } = useToast();
  const balances = useQuery({ queryKey: ["admin-seller-balances"], queryFn: () => api.adminGetSellerBalances({}) });
  const adjust = useMutation({
    mutationFn: (v: { store_id: number; amount_paisa: number; reason: string }) => api.adminCreateAdjustment(v),
    onSuccess: () => { onDone(); toast("Adjustment posted to the seller's ledger."); },
    onError: (e) => toast(e instanceof Error ? e.message : "Could not post the adjustment.", "err"),
  });
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    const store_id = Number(d.get("store_id"));
    const rupees = Number(d.get("amount"));
    const reason = String(d.get("reason") ?? "").trim();
    if (!store_id || !Number.isFinite(rupees) || rupees === 0) { toast("Pick a seller and a non-zero amount.", "err"); return; }
    if (reason.length < 3) { toast("A reason is required — it goes on the ledger.", "err"); return; }
    adjust.mutate({ store_id, amount_paisa: Math.round(rupees * 100), reason });
    e.currentTarget.reset();
  };
  const sellers = balances.data?.sellers ?? [];
  return (
    <div>
      <h3>Manual adjustment (admin only)</h3>
      <form className="stack-form compact" onSubmit={submit}>
        <div className="form-pair">
          <label>Seller<select name="store_id" required defaultValue="">
            <option value="" disabled>Choose a seller</option>
            {sellers.map((s) => <option key={s.store_id} value={s.store_id}>{s.store_name} ({s.seller_code})</option>)}
          </select></label>
          <label>Amount, rupees (negative takes back)<input name="amount" type="number" step={0.01} required placeholder="e.g. -500 or 250" /></label>
        </div>
        <label>Reason (required, shown on the ledger)<input name="reason" required maxLength={280} placeholder="Why is this correction needed?" /></label>
        <button className="primary" disabled={adjust.isPending}>{adjust.isPending ? "Posting…" : "Post adjustment"}</button>
        <small className="muted">Adjustments hit the available balance immediately and are audit-logged. Corrections only — never routine earnings.</small>
      </form>
    </div>
  );
}

export function AdminSellerBalances() {
  const list = useQuery({ queryKey: ["admin-seller-balances"], queryFn: () => api.adminGetSellerBalances({}) });
  if (list.isPending) return <p className="muted">Loading balances…</p>;
  if (list.error) return <p className="form-error">Balances could not load.</p>;
  const sellers = list.data?.sellers ?? [];
  return (
    <div>
      <p className="muted"><small>Derived from the ledger at read time — never stored. “Held” is money reserved by payouts awaiting processing.</small></p>
      {sellers.length === 0 ? <p className="muted">No sellers yet.</p> : (
        <div className="admin-table">{sellers.map((s) => (
          <article key={s.store_id}>
            <div><h3>{s.store_name}</h3><p className="muted">{s.seller_code} · {s.status}</p></div>
            <div className="order-actions">
              <span><b>{money(s.available_paisa)}</b> <small>available</small></span>
              <span><b>{money(s.pending_paisa)}</b> <small>pending</small></span>
              {s.reserved_paisa > 0 && <span><b>{money(s.reserved_paisa)}</b> <small>held</small></span>}
              <span><b>{money(s.paid_paisa)}</b> <small>paid out</small></span>
            </div>
          </article>
        ))}</div>
      )}
    </div>
  );
}

// --- email / SMTP --------------------------------------------------------------------
// Marketplace email settings: host, port, username, password and the from
// address used for every transactional email.
//
// Precedence (shown honestly on the tab): SMTP_* environment variables win
// when set; otherwise these saved settings are used; when neither is set,
// emails are logged on the server and never sent. The password is never
// returned by the server — only a "saved" indicator — and the password
// field is always submitted blank unless the admin types a new one.
//
// Server contract (implemented in server/src/actions.ts):
//   api.adminGetSmtpSettings() -> { smtp_host, smtp_port, smtp_user,
//     smtp_from (each nullable when nothing is configured),
//     password_set, effective_source: "env"|"db"|"none" }
//   api.adminSaveSmtpSettings({ host, port, username, password, from })
//     -> { ok: true }  (port/username/password/from optional; an empty or
//     omitted password keeps the existing stored password)
//   api.adminSendTestSmtpEmail({ to }) -> { sent, error? }
// The response type is derived from the server's Actions type, so the
// client can never drift from the contract.
type AdminSmtpSettings = ApiResponse<typeof api, "adminGetSmtpSettings">;

const SMTP_SOURCE_LABEL: Record<AdminSmtpSettings["effective_source"], string> = {
  env: "environment variables",
  db: "saved settings",
  none: "not configured",
};

export function AdminEmail() {
  const { toast } = useToast();
  const settings = useQuery({ queryKey: ["admin-smtp-settings"], queryFn: () => api.adminGetSmtpSettings({}) });
  const [host, setHost] = useState("");
  const [port, setPort] = useState("587");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [from, setFrom] = useState("");
  const [testTo, setTestTo] = useState("");
  const [testResult, setTestResult] = useState<{ sent: boolean; error?: string } | null>(null);
  const data = settings.data;
  useEffect(() => {
    if (data) {
      setHost(data.smtp_host ?? "");
      setPort(data.smtp_port != null ? String(data.smtp_port) : "587");
      setUsername(data.smtp_user ?? "");
      setFrom(data.smtp_from ?? "");
    }
  }, [data]);

  const save = useMutation({
    mutationFn: () => api.adminSaveSmtpSettings({
      host: host.trim(),
      port: Math.max(1, Math.min(65535, Number(port) || 587)),
      username: username.trim(),
      password,
      from: from.trim(),
    }),
    onSuccess: () => { setPassword(""); void settings.refetch(); toast("SMTP settings saved."); },
    onError: (e) => toast(e instanceof Error ? e.message : "Could not save the settings.", "err"),
  });

  const sendTest = useMutation({
    mutationFn: (to: string) => api.adminSendTestSmtpEmail({ to }),
    onSuccess: (r) => {
      setTestResult(r);
      if (r.sent) toast("Test email sent.");
      else toast(r.error ? `The test email could not be sent: ${r.error}` : "The test email could not be sent.", "err");
    },
    onError: (e) => {
      const error = e instanceof Error ? e.message : "The test email request failed.";
      setTestResult({ sent: false, error });
      toast(error, "err");
    },
  });

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!host.trim() || !username.trim() || !from.trim()) { toast("Host, username and from address are required.", "err"); return; }
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) { toast("Port must be a number between 1 and 65535.", "err"); return; }
    if (data && data.effective_source !== "env" && !data.password_set && !password) {
      toast("Enter the SMTP password — none is saved yet.", "err");
      return;
    }
    save.mutate();
  };

  return (
    <div className="studio-layout">
      <section className="studio-section wide"><div className="section-title"><h2>Email / SMTP</h2></div>
        <p className="muted">Environment variables take precedence: when <b>SMTP_HOST</b> is set, the <b>SMTP_HOST</b>, <b>SMTP_PORT</b>, <b>SMTP_USER</b>, <b>SMTP_PASS</b> and <b>SMTP_FROM</b> variables are used and the fields below are ignored. Otherwise these saved settings are used. When neither is set, emails are logged on the server and never sent.</p>
        {settings.isPending && <p className="muted">Loading SMTP settings…</p>}
        {settings.error && <p className="form-error">Could not load the SMTP settings.</p>}
        {data && <p className="muted">Using: <b>{SMTP_SOURCE_LABEL[data.effective_source]}</b></p>}
        {data && (
          <form className="stack-form" onSubmit={submit}>
            <div className="form-pair">
              <label>SMTP host<input value={host} onChange={(e) => setHost(e.target.value)} placeholder="smtp.example.com" autoComplete="off" /></label>
              <label>SMTP port<input type="number" min={1} max={65535} value={port} onChange={(e) => setPort(e.target.value)} placeholder="587" /></label>
            </div>
            <div className="form-pair">
              <label>Username<input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" /></label>
              <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" placeholder={data.password_set ? "•••••••• (leave empty to keep)" : ""} />
                {data.password_set
                  ? <small className="success">A password is saved. Leave the field empty to keep it.</small>
                  : <small className="muted">No password saved yet.</small>}
              </label>
            </div>
            <label>From address<input type="email" value={from} onChange={(e) => setFrom(e.target.value)} placeholder="shop@example.com" /></label>
            <div className="form-pair">
              <button className="primary" disabled={save.isPending}>{save.isPending ? "Saving…" : "Save SMTP settings"}</button>
            </div>
          </form>
        )}
      </section>
      <section className="studio-section"><div className="section-title"><h2>Send a test email</h2></div>
        <form className="stack-form" onSubmit={(e) => { e.preventDefault(); const to = testTo.trim(); if (!to) { toast("Enter a recipient address.", "err"); return; } sendTest.mutate(to); }}>
          <label>Recipient<input type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="you@example.com" /></label>
          <button className="primary" disabled={sendTest.isPending}>{sendTest.isPending ? "Sending…" : "Send test email"}</button>
        </form>
        {testResult && (testResult.sent
          ? <p className="success">Test email sent.</p>
          : <p className="form-error">The test email could not be sent: {testResult.error ?? "unknown error"}</p>)}
      </section>
    </div>
  );
}

// --- admin shell: sidebar layout ---------------------------------------------------
// Desktop: a persistent left sidebar lists the tabs. Mobile (<=767px): the
// sidebar becomes a drawer — the hamburger button slides it in from the
// left over an overlay, with a close button; picking a tab or pressing
// Escape closes it. Tab content arrives as children, so every tab's
// functionality stays exactly as-is: this is a layout change only.
//
// Wiring (App.tsx AdminPanel keeps owning the tab list and the admin
// guard): render
//   <AdminShell tabs={tabs} tab={tab} setTab={setTab}> …tab content… </AdminShell>
// in place of the category-list row. The CSS is scoped to admin-* classes
// and rendered here (admin2.tsx carries no theme.css edits), so the
// desktop/tablet appearance is unchanged apart from the sidebar chrome.
export type AdminShellTab = { id: string; label: string };

const ADMIN_SHELL_CSS = `
.admin-shell{display:grid;grid-template-columns:236px minmax(0,1fr);gap:28px;align-items:start;margin-top:26px}
.admin-hamburger{display:none}
.admin-sidebar{position:sticky;top:16px;border-top:4px solid var(--text);padding-top:14px;min-width:0}
.admin-sidebar-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
.admin-sidebar-head span{font-weight:900;font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim)}
.admin-sidebar ul{list-style:none;margin:0;padding:0;display:grid;gap:2px}
.admin-sidebar li button{width:100%;text-align:left;border:0;background:transparent;padding:10px 12px;border-radius:7px;font-weight:700;font-size:14px;min-height:44px;cursor:pointer;color:inherit}
.admin-sidebar li button:hover{background:var(--surface-2)}
.admin-sidebar li button.selected{background:var(--accent-2);color:#2c1b00;font-weight:800}
.admin-drawer-close{display:none}
.admin-overlay{display:none}
.admin-content{min-width:0}
@media (max-width:767px){
  .admin-shell{grid-template-columns:1fr;margin-top:18px}
  .admin-hamburger{display:inline-flex;align-items:center;gap:8px;border:1px solid var(--border);background:var(--surface);color:inherit;border-radius:7px;padding:10px 14px;font-weight:800;font-size:14px;min-height:44px;cursor:pointer;justify-self:end}
  .admin-sidebar{position:fixed;top:0;right:0;bottom:0;width:min(300px,82vw);background:var(--bg);z-index:70;padding:18px 16px;overflow-y:auto;transform:translateX(105%);transition:transform .22s ease;box-shadow:-8px 0 24px rgba(0,0,0,.25);border-top:0}
  .admin-sidebar.open{transform:none}
  .admin-drawer-close{display:inline-grid;place-items:center;border:1px solid var(--border);background:transparent;color:inherit;border-radius:7px;width:44px;height:44px;font-size:16px;cursor:pointer}
  .admin-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:65;border:0;padding:0;cursor:pointer}
  .admin-overlay.visible{display:block}
  .admin-home-li{margin-top:8px;border-top:1px solid var(--border);padding-top:8px}
}
`;

export function AdminShell({ tabs, tab, setTab, children }: { tabs: AdminShellTab[]; tab: string; setTab: (t: string) => void; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [open]);
  const pick = (id: string) => { setTab(id); setOpen(false); };
  return (
    <>
      <style>{ADMIN_SHELL_CSS}</style>
      <div className="admin-shell">
        <button type="button" className="admin-hamburger" aria-label="Open admin menu" aria-expanded={open} aria-controls="admin-sidebar" onClick={() => setOpen(true)}>
          <span aria-hidden="true">☰</span> Menu
        </button>
        <div className={`admin-overlay${open ? " visible" : ""}`} onClick={() => setOpen(false)} aria-hidden={!open} />
        <nav id="admin-sidebar" className={`admin-sidebar${open ? " open" : ""}`} aria-label="Admin sections">
          <div className="admin-sidebar-head">
            <span>Sections</span>
            <button type="button" className="admin-drawer-close" aria-label="Close admin menu" onClick={() => setOpen(false)}>✕</button>
          </div>
          <ul>{tabs.map((t) => (
            <li key={t.id}><button type="button" className={tab === t.id ? "selected" : ""} aria-current={tab === t.id ? "page" : undefined} onClick={() => pick(t.id)}>{t.label}</button></li>
          ))}
            <li className="admin-home-li"><button type="button" onClick={() => { setOpen(false); go("/"); }}>Homepage</button></li>
          </ul>
        </nav>
        <div className="admin-content">{children}</div>
      </div>
    </>
  );
}
