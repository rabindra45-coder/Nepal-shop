// Seller studio phase-2 tabs: analytics + returns.
import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api2, deleteProductImage, fmtDate, money, uploadProductImage, uploadStoreAsset, type P2Order, type SellerUploadAuth } from "./phase2api";
import { api, getAuth } from "./api";
import { STATUS_LABEL } from "./screens";
import { useToast } from "./ui";

type SellerArgs = Record<string, unknown>;

const MAX_PHOTOS = 10;

// Seller photo uploader: up to 10 photos per product, shown in the shop's
// product cards and gallery. Files go to the self-hosted server (/api/uploads).
export function ProductImageUploader({ productId, callArgs }: { productId: number; callArgs: SellerArgs }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const list = useQuery({
    queryKey: ["product-images", productId],
    queryFn: () => api2.getProductImages({ ...callArgs, product_id: productId }),
  });
  const images = list.data?.images ?? [];
  const slotsLeft = MAX_PHOTOS - images.length;
  const authArgs = { authToken: getAuth()?.token ?? undefined, ...callArgs };
  type UploadState = { name: string; status: "uploading" | "done" | "error"; detail?: string };
  const [uploads, setUploads] = useState<UploadState[]>([]);

  const onFiles = async (files: FileList | null) => {
    if (!files?.length || busy) return;
    const picked = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (picked.length < files.length) toast("Only photo files please (JPG, PNG, WebP, GIF).", "err");
    const batch = picked.slice(0, Math.max(0, slotsLeft));
    if (!batch.length) {
      toast(images.length >= MAX_PHOTOS ? `This product already has ${MAX_PHOTOS} photos — remove one to add another.` : "No usable photos selected.", "err");
      return;
    }
    setBusy(true);
    setUploads(batch.map((f) => ({ name: f.name, status: "uploading" as const })));
    let failed = 0;
    let failedFirst = "";
    for (let i = 0; i < batch.length; i++) {
      const f = batch[i]!;
      try {
        await uploadProductImage(authArgs, productId, f);
        setUploads((prev) => prev.map((s, j) => j === i ? { ...s, status: "done" as const } : s));
      } catch (e) {
        failed++;
        const msg = e instanceof Error ? e.message : "Upload failed.";
        if (!failedFirst) failedFirst = msg;
        setUploads((prev) => prev.map((s, j) => j === i ? { ...s, status: "error" as const, detail: msg } : s));
      }
    }
    await list.refetch();
    void queryClient.invalidateQueries({ queryKey: ["seller-inventory"] });
    if (failed === 0) {
      toast(batch.length === 1 ? "Photo added — it is live in the shop now." : `${batch.length} photos added — live in the shop now.`);
    } else {
      toast(failed === batch.length ? failedFirst || "Upload failed." : `${failed} of ${batch.length} photos failed — ${failedFirst}`, "err");
    }
    setBusy(false);
  };

  const remove = async (imageId: number) => {
    try {
      await deleteProductImage(authArgs, imageId);
      await list.refetch();
      void queryClient.invalidateQueries({ queryKey: ["seller-inventory"] });
      toast("Photo removed.");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not remove the photo.", "err");
    }
  };

  return (
    <div className="uploader">
      <span className="up-label">Product photos <small>({images.length}/{MAX_PHOTOS})</small></span>
      {list.isPending ? <p className="muted"><small>Loading photos…</small></p> : (
        <div className="up-grid">
          {images.map((im) => (
            <div className="up-cell" key={im.id}>
              <img src={im.url} alt="Product photo" loading="lazy" decoding="async" />
              <button type="button" className="up-del" onClick={() => remove(im.id)} aria-label="Remove this photo">×</button>
            </div>
          ))}
          {slotsLeft > 0 && (
            <label className="up-add">
              <input type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple hidden disabled={busy}
                onChange={(e) => { void onFiles(e.target.files); e.target.value = ""; }} />
              <span aria-hidden="true">+</span>
              <small>{busy ? "Uploading…" : "Add photos"}</small>
            </label>
          )}
        </div>
      )}
      <small className="muted">Up to {MAX_PHOTOS} photos per product, 5 MB each. The first photo is the cover shown in the shop.</small>
      {uploads.length > 0 && (
        <ul className="up-progress" aria-live="polite">
          {uploads.map((u, i) => (
            <li key={`${i}-${u.name}`}>
              <small>
                {u.name}:{" "}
                {u.status === "uploading" ? <span className="muted">uploading…</span>
                  : u.status === "done" ? <span className="success">done</span>
                  : <span className="form-error">failed{u.detail ? ` — ${u.detail}` : ""}</span>}
              </small>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function SellerAnalytics({ callArgs }: { callArgs: SellerArgs }) {
  const a = useQuery({ queryKey: ["seller-analytics"], queryFn: () => api2.sellerAnalytics(callArgs) });
  if (a.isPending) return <p className="muted">Crunching your numbers…</p>;
  if (a.error) return <p className="form-error">Analytics could not load.</p>;
  const d = a.data!;
  const maxDay = Math.max(1, ...d.revenue_by_day.map((r) => r.revenue_paisa));
  return (
    <div className="studio-layout">
      <section className="studio-section wide"><h2>Last 30 days</h2>
        <div className="stat-grid">
          <div><b>{money(d.revenue_paisa_30d)}</b><span>Revenue</span></div>
          <div><b>{d.orders_30d}</b><span>Orders</span></div>
          <div><b>{d.total_customers}</b><span>Customers</span></div>
          <div><b>{d.avg_rating === null ? "—" : d.avg_rating.toFixed(1)}</b><span>Average rating</span></div>
          <div><b>{d.product_views_30d}</b><span>Product views</span></div>
          <div><b>{d.view_to_order_pct.toFixed(1)}%</b><span>View → order</span></div>
          <div><b>{d.avg_fulfilment_days === null ? "—" : `${d.avg_fulfilment_days.toFixed(1)} days`}</b><span>Avg fulfilment time</span></div>
        </div>
        {d.product_views_30d === 0 && <p className="muted">No product views recorded yet — views appear here as shoppers browse your catalogue.</p>}
      </section>
      <section className="studio-section wide"><h2>Revenue by day</h2>
        {d.revenue_by_day.every((r) => r.revenue_paisa === 0) ? <p className="muted">No sales in the last 30 days yet.</p> : (
          <div className="bars">{d.revenue_by_day.map((r) => (
            <div className="bar-row" key={r.day} title={`${r.day}: ${money(r.revenue_paisa)}`}>
              <span className="bar-day">{r.day.slice(5)}</span>
              <div className="bar-track"><div className="bar-fill" style={{ width: `${Math.max(2, (r.revenue_paisa / maxDay) * 100)}%` }} /></div>
              <span className="bar-val">{r.revenue_paisa ? money(r.revenue_paisa) : ""}</span>
            </div>
          ))}</div>
        )}
      </section>
      <section className="studio-section"><h2>Orders by status</h2>
        {Object.keys(d.orders_by_status).length === 0 ? <p className="muted">No orders yet.</p> : (
          <div className="kv">{Object.entries(d.orders_by_status).map(([s, c]) => (
            <span key={s}><b>{c}</b> {STATUS_LABEL[s] ?? s}</span>
          ))}</div>
        )}
      </section>
      <section className="studio-section"><h2>Top products</h2>
        {d.top_products.length === 0 ? <p className="muted">No sales yet.</p> : (
          <div className="kv">{d.top_products.map((p) => (
            <span key={p.id}><b>{p.quantity} sold</b> {p.name} · {money(p.revenue_paisa)}</span>
          ))}</div>
        )}
      </section>
      <section className="studio-section wide"><h2>Low stock alerts</h2>
        {d.low_stock.length === 0 ? <p className="muted">Everything is well stocked.</p> : (
          <div className="kv warn-kv">{d.low_stock.map((p) => (
            <span key={`${p.id}:${p.variant_label ?? "base"}`}><b>{p.stock} left</b> {p.name} — restock soon</span>
          ))}</div>
        )}
      </section>
    </div>
  );
}

// Seller: carrier + tracking number for a fulfilment. Shown to the buyer on
// the tracking page once saved. `admin` switches to the admin action.
export function ShipmentForm({ order, callArgs, admin, onSaved }: { order: { id: number; tracking_number: string | null; carrier: string | null }; callArgs?: SellerArgs; admin?: boolean; onSaved?: () => void }) {
  const { toast } = useToast();
  const [carrier, setCarrier] = useState(order.carrier ?? "");
  const [tracking, setTracking] = useState(order.tracking_number ?? "");
  const save = useMutation({
    mutationFn: () => admin
      ? api.adminSetShipmentInfo({ order_id: order.id, tracking_number: tracking.trim() || undefined, carrier: carrier.trim() || undefined })
      : api2.setShipmentInfo({ ...(callArgs ?? {}), order_id: order.id, tracking_number: tracking.trim() || undefined, carrier: carrier.trim() || undefined }),
    onSuccess: () => { toast("Shipment details saved."); onSaved?.(); },
    onError: (e) => toast(e instanceof Error ? e.message : "Could not save.", "err"),
  });
  return (
    <form className="stack-form compact" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <div className="form-pair">
        <label>Carrier<input value={carrier} onChange={(e) => setCarrier(e.target.value)} placeholder="e.g. Pathao Courier" maxLength={60} /></label>
        <label>Tracking number<input value={tracking} onChange={(e) => setTracking(e.target.value)} placeholder="e.g. NP123456" maxLength={80} /></label>
      </div>
      <button disabled={save.isPending}>{save.isPending ? "Saving…" : "Save shipment details"}</button>
    </form>
  );
}

export function SellerReturns({ callArgs }: { callArgs: SellerArgs }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const returns = useQuery({ queryKey: ["seller-returns"], queryFn: () => api2.listReturns(callArgs) });
  const refresh = () => { void queryClient.invalidateQueries({ queryKey: ["seller-returns"] }); void queryClient.invalidateQueries({ queryKey: ["orders"] }); };
  const decide = useMutation({
    mutationFn: (v: { order_id: number; decision: "accepted" | "rejected" }) => api2.updateReturnStatus({ ...callArgs, ...v }),
    onSuccess: (_, v) => { refresh(); toast(v.decision === "accepted" ? "Return accepted — stock restored." : "Return rejected — order back to delivered."); },
    onError: (e) => toast(e instanceof Error ? e.message : "Could not update.", "err"),
  });
  // Honest refund: this only RECORDS a refund request. COD orders that were
  // never paid close as "not required"; real refunds wait on the
  // marketplace team, who complete them manually.
  const refund = useMutation({
    mutationFn: (order_id: number) => api2.requestRefund({ ...callArgs, order_id }),
    onSuccess: (r) => { refresh(); toast(r.refund_status === "pending" ? "Refund requested — our team will complete it manually." : "Closed — COD was never paid, so no refund is owed."); },
    onError: (e) => toast(e instanceof Error ? e.message : "Could not request the refund.", "err"),
  });

  if (returns.isPending) return <p className="muted">Loading returns…</p>;
  if (returns.error) return <p className="form-error">Returns could not load.</p>;
  const orders: P2Order[] = returns.data?.orders ?? [];
  if (orders.length === 0) return <p className="muted">No return requests right now.</p>;
  const refundLabel: Record<string, string> = { not_required: "No refund needed (COD, not paid)", pending: "Refund requested — with our team", completed: "Refund completed", failed: "Refund failed — team retrying" };
  return (
    <div className="order-admin">{orders.map((o) => (
      <article key={o.id}>
        <div>
          <p className="eyebrow">{o.order_code} · {fmtDate(o.created_at)} · {STATUS_LABEL[o.status]}</p>
          <h3>{o.customer_name} · {o.phone}</h3>
          <p>{o.items.map((i) => `${i.quantity} × ${i.product_name}`).join(", ")}</p>
          {o.return_reason && <p><b>Buyer’s reason:</b> {o.return_reason}</p>}
          <p className="muted">Paid: {o.payment_method.toUpperCase()} · {o.payment_status}</p>
          {o.refund_status && <p className="muted">Refund: {refundLabel[o.refund_status] ?? o.refund_status}</p>}
        </div>
        <div className="order-actions">
          <b>{money(o.total_paisa)}</b>
          {o.status === "return_requested" && (
            <>
              <button className="primary" disabled={decide.isPending} onClick={() => decide.mutate({ order_id: o.id, decision: "accepted" })}>Accept return</button>
              <button disabled={decide.isPending} onClick={() => decide.mutate({ order_id: o.id, decision: "rejected" })}>Reject</button>
            </>
          )}
          {o.status === "returned" && !o.refund_status && (
            <button className="primary" disabled={refund.isPending} onClick={() => refund.mutate(o.id)}>Request refund</button>
          )}
        </div>
      </article>
    ))}</div>
  );
}

// --- stock history (inventory ledger) ---------------------------------------
// Read-only trail of every stock change for this shop: what each order took
// off the shelf, what each cancellation or accepted return put back, and the
// seller's own manual adjustments.
const STOCK_REASON_LABEL: Record<string, string> = {
  order_placed: "Order", order_cancelled: "Cancelled order", return_accepted: "Accepted return",
  manual_adjust: "Manual adjustment", product_created: "Product created", variant_created: "Option created",
};

export function StockHistory({ callArgs }: { callArgs: SellerArgs }) {
  const args = { ...(callArgs as { authToken?: string; seller_code?: string; seller_key?: string }), limit: 30 };
  const list = useQuery({ queryKey: ["stock-movements"], queryFn: () => api.sellerStockMovements(args) });
  if (list.isPending) return <p className="muted">Loading stock history…</p>;
  if (list.error) return <p className="form-error">Stock history could not load.</p>;
  const rows = list.data?.movements ?? [];
  if (!rows.length) return <p className="muted">No stock changes recorded yet.</p>;
  return (
    <div className="kv">{rows.map((m) => (
      <span key={m.id}>
        <b>{m.change > 0 ? `+${m.change}` : m.change}</b> {m.product_name}{m.variant_label ? ` — ${m.variant_label}` : ""} · {STOCK_REASON_LABEL[m.reason] ?? m.reason}{m.order_code ? ` · ${m.order_code}` : ""} <small>({m.stock_after} left · {fmtDate(m.created_at)})</small>
      </span>
    ))}</div>
  );
}

// Extended product form fields (brand, original price, photo uploader,
// low-stock threshold). Rendered inside Studio's existing product form.
// The uploader needs an existing product id; for brand-new products the form
// shows a hint until the product is published. Product photos are real file
// uploads only — there is no image-URL field.
export function ProductExtraFields({ editing, productId, callArgs }: {
  editing: { brand?: string | null; original_price_paisa?: number | null; low_stock_threshold?: number; sku?: string | null } | null;
  productId?: number;
  callArgs?: SellerArgs;
}) {
  return (
    <>
      <div className="form-pair">
        <label>Brand<input name="brand" defaultValue={editing?.brand ?? ""} placeholder="e.g. Himalaya Weaves" /></label>
        <label>Original price, rupees (for discounts)<input name="original_price" type="number" min="0.01" step="0.01" defaultValue={editing?.original_price_paisa ? editing.original_price_paisa / 100 : ""} placeholder="Leave empty for no discount" /></label>
      </div>
      <div className="form-pair">
        <label>SKU (optional)<input name="sku" defaultValue={editing?.sku ?? ""} maxLength={40} placeholder="e.g. KURTHA-RED-M" /><small>Unique within your shop.</small></label>
        <label>Low-stock alert at<input name="low_stock_threshold" type="number" min="0" defaultValue={editing?.low_stock_threshold ?? 5} /><small>Buyers see “Only X left” at or below this number.</small></label>
      </div>
      {productId != null && callArgs ? (
        <ProductImageUploader productId={productId} callArgs={callArgs} />
      ) : (
        <p className="muted up-hint"><small>Publish the product first — then you can add up to 10 photos here.</small></p>
      )}
    </>
  );
}

export function productExtraPayload(d: FormData) {
  const num = (v: FormDataEntryValue | null) => {
    const n = Number(v);
    return v !== null && v !== "" && Number.isFinite(n) ? Math.round(n * 100) : undefined;
  };
  const int = (v: FormDataEntryValue | null) => {
    const n = Number(v);
    return v !== null && v !== "" && Number.isInteger(n) ? n : undefined;
  };
  const brand = String(d.get("brand") ?? "").trim() || undefined;
  const original_price_paisa = num(d.get("original_price"));
  const low_stock_threshold = int(d.get("low_stock_threshold"));
  const sku = String(d.get("sku") ?? "").trim() || undefined;
  return { brand, original_price_paisa, low_stock_threshold, sku };
}

// --- store logo / banner uploader (studio settings) --------------------------
// Uploads one image to /api/store-uploads, then attaches it via the
// saveStoreAssets action (which also deletes the replaced file).
export function StoreAssetUploader({ kind, currentUrl, callArgs, onSaved }: {
  kind: "logo" | "banner"; currentUrl: string | null; callArgs: SellerUploadAuth; onSaved: (url: string | null) => void;
}) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const field = kind === "logo" ? "logo_url" : "banner_url";
  // Like ProductImageUploader above: email+password sellers sign in with a
  // session token, but `callArgs` is {} for them (App.tsx builds
  // `callArgs = tokenAuth ? {} : creds`), so merge the token explicitly
  // before the multipart upload — otherwise the server answers
  // "Seller sign-in is required." Legacy seller_code+seller_key sign-in
  // still works because those keys survive the merge untouched.
  const authArgs = { authToken: getAuth()?.token ?? undefined, ...callArgs };
  const onFiles = async (files: FileList | null) => {
    const f = files?.[0];
    if (!f || busy) return;
    if (!f.type.startsWith("image/")) { toast("Only photo files please (JPG, PNG, WebP, GIF).", "err"); return; }
    setBusy(true);
    try {
      const url = await uploadStoreAsset(authArgs, kind, f);
      await api.saveStoreAssets({ ...(callArgs as unknown as Record<string, unknown>), [field]: url });
      onSaved(url);
      toast(kind === "logo" ? "Store logo updated." : "Store banner updated.");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Upload failed.", "err");
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await api.saveStoreAssets({ ...(callArgs as unknown as Record<string, unknown>), [field]: null });
      onSaved(null);
      toast(kind === "logo" ? "Store logo removed." : "Store banner removed.");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not remove the image.", "err");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="uploader">
      <span className="up-label">{kind === "logo" ? "Store logo" : "Store banner"}</span>
      <div className="up-grid">
        {currentUrl && (
          <div className="up-cell wide">
            <img src={currentUrl} alt={kind === "logo" ? "Store logo" : "Store banner"} loading="lazy" decoding="async" />
            <button type="button" className="up-del" onClick={() => void remove()} disabled={busy} aria-label={`Remove the ${kind}`}>×</button>
          </div>
        )}
        <label className="up-add">
          <input type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden disabled={busy}
            onChange={(e) => { void onFiles(e.target.files); e.target.value = ""; }} />
          <span aria-hidden="true">+</span>
          <small>{busy ? "Uploading…" : currentUrl ? `Replace ${kind}` : `Add ${kind}`}</small>
        </label>
      </div>
      <small className="muted">JPG, PNG, WebP or GIF, up to 5 MB. Shown on your public store page.</small>
    </div>
  );
}

// --- product variant (option) manager (studio inventory) ---------------------
// Variants have their own label, optional SKU, optional price override and
// own stock; the shop's cart and checkout already price and decrement them.
type StudioVariant = { id: number; label: string; sku: string | null; price_paisa: number | null; stock: number; sort_order: number; is_active: boolean };
export function VariantManager({ productId, basePricePaisa, callArgs }: { productId: number; basePricePaisa: number; callArgs: SellerArgs }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const list = useQuery({
    queryKey: ["product-variants", productId],
    queryFn: () => api.listVariants({ ...(callArgs as unknown as Record<string, unknown>), product_id: productId }),
  });
  const variants: StudioVariant[] = list.data?.variants ?? [];
  const refresh = () => { void queryClient.invalidateQueries({ queryKey: ["product-variants", productId] }); void queryClient.invalidateQueries({ queryKey: ["seller-inventory"] }); };
  const save = useMutation({
    mutationFn: async (v: { id?: number; label: string; sku?: string; price_paisa?: number | null; stock: number; is_active: boolean }) =>
      v.id
        ? api.updateVariant({ ...(callArgs as unknown as Record<string, unknown>), id: v.id, label: v.label, sku: v.sku ?? null, price_paisa: v.price_paisa ?? null, stock: v.stock, is_active: v.is_active })
        : api.createVariant({ ...(callArgs as unknown as Record<string, unknown>), product_id: productId, label: v.label, sku: v.sku, price_paisa: v.price_paisa ?? null, stock: v.stock, is_active: v.is_active }),
    onSuccess: () => { setEditingId(null); refresh(); toast("Option saved."); },
    onError: (e) => toast(e instanceof Error ? e.message : "Could not save the option.", "err"),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.deleteVariant({ ...(callArgs as unknown as Record<string, unknown>), id }),
    onSuccess: () => { setConfirmDelete(null); refresh(); toast("Option removed."); },
    onError: (e) => toast(e instanceof Error ? e.message : "Could not remove the option.", "err"),
  });
  const submit = (e: FormEvent<HTMLFormElement>, existing?: StudioVariant) => {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    const priceStr = String(d.get("price") ?? "").trim();
    save.mutate({
      id: existing?.id,
      label: String(d.get("label") ?? "").trim(),
      sku: String(d.get("sku") ?? "").trim() || undefined,
      price_paisa: priceStr === "" ? null : Math.round(Number(priceStr) * 100),
      stock: Math.max(0, Number(d.get("stock") ?? 0) || 0),
      is_active: d.get("active") === "on",
    });
  };
  const priceLabel = (v: StudioVariant) => v.price_paisa == null ? `${money(basePricePaisa)} (base)` : money(v.price_paisa);
  return (
    <div className="variant-manager">
      <span className="up-label">Product options <small>({variants.length})</small></span>
      <small className="muted">Sizes, colours and the like — each with its own price and stock. Leave the price empty to use the product price.</small>
      {list.isPending ? <p className="muted"><small>Loading options…</small></p> : (
        <div className="variant-list">
          {variants.map((v) => editingId === v.id ? (
            <form className="stack-form compact variant-form" key={v.id} onSubmit={(e) => submit(e, v)}>
              <div className="form-pair">
                <label>Option label<input name="label" defaultValue={v.label} required maxLength={60} /></label>
                <label>SKU<input name="sku" defaultValue={v.sku ?? ""} maxLength={40} /></label>
              </div>
              <div className="form-pair">
                <label>Price, rupees (empty = base)<input name="price" type="number" min="0.01" step="0.01" defaultValue={v.price_paisa != null ? v.price_paisa / 100 : ""} placeholder={`${(basePricePaisa / 100).toLocaleString("en-NP")}`} /></label>
                <label>Stock<input name="stock" type="number" min="0" defaultValue={v.stock} required /></label>
              </div>
              <label className="check"><input name="active" type="checkbox" defaultChecked={v.is_active} /> Offered in the shop</label>
              <div className="form-row"><button className="primary" disabled={save.isPending}>Save</button><button type="button" onClick={() => setEditingId(null)}>Cancel</button></div>
            </form>
          ) : (
            <div className="variant-row" key={v.id}>
              <span><b>{v.label}</b><small>{v.sku ?? "no SKU"} · {priceLabel(v)} · {v.stock} in stock{v.is_active ? "" : " · hidden"}</small></span>
              <span className="variant-actions">
                <button type="button" onClick={() => { setEditingId(v.id); setConfirmDelete(null); }}>Edit</button>
                {confirmDelete === v.id
                  ? <button type="button" className="text-danger" disabled={remove.isPending} onClick={() => remove.mutate(v.id)}>Confirm</button>
                  : <button type="button" onClick={() => setConfirmDelete(v.id)}>Remove</button>}
              </span>
            </div>
          ))}
          {editingId === -1 ? (
            <form className="stack-form compact variant-form" onSubmit={(e) => submit(e)}>
              <div className="form-pair">
                <label>Option label<input name="label" required maxLength={60} placeholder="e.g. Large, Red" /></label>
                <label>SKU<input name="sku" maxLength={40} placeholder="Optional" /></label>
              </div>
              <div className="form-pair">
                <label>Price, rupees (empty = base)<input name="price" type="number" min="0.01" step="0.01" placeholder={`${(basePricePaisa / 100).toLocaleString("en-NP")}`} /></label>
                <label>Stock<input name="stock" type="number" min="0" defaultValue={0} required /></label>
              </div>
              <label className="check"><input name="active" type="checkbox" defaultChecked /> Offered in the shop</label>
              <div className="form-row"><button className="primary" disabled={save.isPending}>{save.isPending ? "Saving…" : "Add option"}</button><button type="button" onClick={() => setEditingId(null)}>Cancel</button></div>
            </form>
          ) : (
            <button type="button" className="up-add-inline" onClick={() => { setEditingId(-1); setConfirmDelete(null); }}>+ Add an option</button>
          )}
        </div>
      )}
    </div>
  );
}

export function ReturnRequestForm({ orderCode, phone, onDone }: { orderCode: string; phone: string; onDone: () => void }) {
  const { toast } = useToast();
  const req = useMutation({
    mutationFn: (reason: string) => api2.requestReturn({ order_code: orderCode, phone, reason }),
    onSuccess: () => { toast("Return requested. The seller will respond soon."); onDone(); },
    onError: (e) => toast(e instanceof Error ? e.message : "Could not request the return.", "err"),
  });
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    req.mutate(String(new FormData(e.currentTarget).get("reason") ?? ""));
  };
  return (
    <form className="stack-form compact" onSubmit={submit}>
      <label>Why are you returning this?<textarea name="reason" required minLength={8} maxLength={400} placeholder="Tell the seller what is wrong" /></label>
      <button className="primary" disabled={req.isPending}>{req.isPending ? "Sending…" : "Request return"}</button>
    </form>
  );
}

// --- seller account status banners + settings --------------------------------
// Seller checkpoint: the studio now explains every lifecycle state (pending,
// under review, active, suspended, rejected), lets the seller verify their
// email, describe the shop, take a break (vacation mode), and upload the
// store logo and banner shown on the public store page.
type SellerStoreInfo = Awaited<ReturnType<typeof api.sellerInventory>>["store"];

export function SellerStatusBanners({ store }: { store: SellerStoreInfo | null }) {
  if (!store) return null;
  return (<>
    {store.status === "pending" && !store.email_verified && <p className="banner warn" role="status">Verify your email to send your shop for admin review. Check your inbox — the link is valid for 24 hours, or request a new one under Settings.</p>}
    {store.status === "pending" && store.email_verified && <p className="banner" role="status">Your email is verified and your shop is waiting for admin approval. You can add products now; they appear in the shop after approval.</p>}
    {store.status === "under_review" && <p className="banner warn" role="status">Your shop is under admin review. You can open for selling as soon as it is approved.</p>}
    {store.status === "rejected" && <p className="banner danger" role="status">This shop application was not approved. Please contact support if you think this is a mistake.</p>}
    {store.status === "suspended" && <p className="banner danger" role="status">This shop is suspended and hidden from buyers. Please contact support.</p>}
    {store.vacation_mode && store.status === "active" && <p className="banner" role="status">Break mode is on — buyers can browse your shop but cannot place orders right now.</p>}
  </>);
}

export function StudioSellerSettings({ store, callArgs, onSaved }: { store: SellerStoreInfo; callArgs: SellerUploadAuth; onSaved: () => void }) {
  const { toast } = useToast();
  const [logoUrl, setLogoUrl] = useState(store.logo_url);
  const [bannerUrl, setBannerUrl] = useState(store.banner_url);
  const [resendState, setResendState] = useState<"idle" | "sent" | "noemail">("idle");
  useEffect(() => { setLogoUrl(store.logo_url); setBannerUrl(store.banner_url); }, [store.id]);
  const args = callArgs as unknown as Record<string, unknown>;
  const saveIdentity = useMutation({
    mutationFn: (v: { store_name: string; tagline: string; location: string; phone: string }) => api.saveStore({ ...args, ...v }),
    onSuccess: () => { toast("Store details saved."); onSaved(); },
    onError: (e) => toast(e instanceof Error ? e.message : "Could not save the store.", "err"),
  });
  const saveProfile = useMutation({
    mutationFn: (v: { description: string; vacation_mode: boolean }) => api.saveStore({ ...args, ...v }),
    onSuccess: () => { toast("Shop profile saved."); onSaved(); },
    onError: (e) => toast(e instanceof Error ? e.message : "Could not save the shop profile.", "err"),
  });
  const resend = useMutation({
    mutationFn: () => api.resendSellerVerification(args),
    onSuccess: (r) => setResendState(r.email_sent ? "sent" : "noemail"),
    onError: (e) => toast(e instanceof Error ? e.message : "Could not send the email.", "err"),
  });
  return (<>
    <section className="studio-section"><h2>Store identity</h2>
      <form className="stack-form" onSubmit={(e) => { e.preventDefault(); const d = new FormData(e.currentTarget); saveIdentity.mutate({ store_name: String(d.get("store") ?? ""), tagline: String(d.get("tagline") ?? ""), location: String(d.get("location") ?? ""), phone: String(d.get("phone") ?? "") }); }}>
        <label>Store name<input name="store" defaultValue={store.store_name} required /></label>
        <label>Short promise<input name="tagline" defaultValue={store.tagline} required /></label>
        <label>Location<input name="location" defaultValue={store.location} required /></label>
        <label>Public contact<input name="phone" defaultValue={store.phone} required /></label>
        <button className="primary" disabled={saveIdentity.isPending}>{saveIdentity.isPending ? "Saving…" : "Save store"}</button>
      </form>
    </section>
    <section className="studio-section"><h2>Shop profile</h2>
      <form className="stack-form" key={store.id} onSubmit={(e) => { e.preventDefault(); const d = new FormData(e.currentTarget); saveProfile.mutate({ description: String(d.get("description") ?? ""), vacation_mode: d.get("vacation") === "on" }); }}>
        <label>About this shop<textarea name="description" defaultValue={store.description} maxLength={2000} placeholder="What do you sell, and why should buyers trust you?" /></label>
        <label className="check"><input name="vacation" type="checkbox" defaultChecked={store.vacation_mode} /> Break mode <small>pause orders, keep the shop visible</small></label>
        <button className="primary" disabled={saveProfile.isPending}>{saveProfile.isPending ? "Saving…" : "Save shop profile"}</button>
      </form>
      <StoreAssetUploader kind="logo" currentUrl={logoUrl} callArgs={callArgs} onSaved={setLogoUrl} />
      <StoreAssetUploader kind="banner" currentUrl={bannerUrl} callArgs={callArgs} onSaved={setBannerUrl} />
    </section>
    <section className="studio-section"><h2>Email verification</h2>
      {store.email_verified
        ? <p className="success">Your email is verified.</p>
        : resendState === "sent"
          ? <p className="muted">A new verification link is on its way — check your inbox and spam folder. It expires in 24 hours and works once.</p>
          : resendState === "noemail"
            ? <p className="muted">We requested a new link, but this shop cannot send email right now (no email service configured). Please contact support and we will verify you manually.</p>
            : <div>
                <p className="muted"><small>Your email is not verified yet. Ask for a fresh link — it stays valid for 24 hours and works once.</small></p>
                <button className="primary" disabled={resend.isPending} onClick={() => resend.mutate()}>{resend.isPending ? "Sending…" : "Send me a new verification link"}</button>
              </div>}
    </section>
  </>);
}

// --- product specification sheet manager (studio inventory) -----------------
// Structured label/value rows ("Material → Cotton") shown as a spec sheet on
// the public product page. Simpler than variants: no price or stock.
type StudioSpec = { id: number; label: string; value: string };
export function SpecManager({ productId, callArgs }: { productId: number; callArgs: SellerArgs }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const list = useQuery({
    queryKey: ["product-specs", productId],
    queryFn: () => api.listSpecs({ ...(callArgs as unknown as Record<string, unknown>), product_id: productId }),
  });
  const specs: StudioSpec[] = list.data?.specs ?? [];
  const refresh = () => { void queryClient.invalidateQueries({ queryKey: ["product-specs", productId] }); };
  const save = useMutation<{ id: number } | { ok: true }, Error, { id?: number; label: string; value: string }>({
    mutationFn: (v: { id?: number; label: string; value: string }) =>
      v.id
        ? api.updateSpec({ ...(callArgs as unknown as Record<string, unknown>), id: v.id, label: v.label, value: v.value })
        : api.createSpec({ ...(callArgs as unknown as Record<string, unknown>), product_id: productId, label: v.label, value: v.value }),
    onSuccess: () => { setEditingId(null); refresh(); toast("Specification saved."); },
    onError: (e) => toast(e instanceof Error ? e.message : "Could not save the specification.", "err"),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.deleteSpec({ ...(callArgs as unknown as Record<string, unknown>), id }),
    onSuccess: () => { setConfirmDelete(null); refresh(); toast("Specification removed."); },
    onError: (e) => toast(e instanceof Error ? e.message : "Could not remove the specification.", "err"),
  });
  const submit = (e: FormEvent<HTMLFormElement>, existing?: StudioSpec) => {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    save.mutate({ id: existing?.id, label: String(d.get("label") ?? "").trim(), value: String(d.get("value") ?? "").trim() });
  };
  const form = (existing?: StudioSpec) => (
    <form className="stack-form compact variant-form" key={existing?.id ?? "new"} onSubmit={(e) => submit(e, existing)}>
      <div className="form-pair">
        <label>Label<input name="label" defaultValue={existing?.label ?? ""} required maxLength={40} placeholder="e.g. Material" /></label>
        <label>Value<input name="value" defaultValue={existing?.value ?? ""} required maxLength={200} placeholder="e.g. Pure cotton" /></label>
      </div>
      <div className="form-row"><button className="primary" disabled={save.isPending}>{existing ? "Save" : "Add specification"}</button><button type="button" onClick={() => setEditingId(null)}>Cancel</button></div>
    </form>
  );
  return (
    <div className="variant-manager">
      <span className="up-label">Specifications <small>({specs.length})</small></span>
      <small className="muted">The structured details buyers compare — shown as a spec sheet on the product page.</small>
      {list.isPending ? <p className="muted"><small>Loading specifications…</small></p> : (
        <div className="variant-list">
          {specs.map((s) => editingId === s.id ? form(s) : (
            <div className="variant-row" key={s.id}>
              <span><b>{s.label}</b><small>{s.value}</small></span>
              <span className="variant-actions">
                <button type="button" onClick={() => { setEditingId(s.id); setConfirmDelete(null); }}>Edit</button>
                {confirmDelete === s.id
                  ? <button type="button" className="text-danger" disabled={remove.isPending} onClick={() => remove.mutate(s.id)}>Confirm</button>
                  : <button type="button" onClick={() => setConfirmDelete(s.id)}>Remove</button>}
              </span>
            </div>
          ))}
          {editingId === -1 ? form() : editingId === null && (
            <button type="button" className="up-add-inline" onClick={() => { setEditingId(-1); setConfirmDelete(null); }}>+ Add a specification</button>
          )}
        </div>
      )}
    </div>
  );
}

// --- seller earnings (commission + payouts checkpoint) -----------------------
// Real ledger-derived figures: pending / available / paid balances, the
// full money trail, payout requests and payout details. Sellers can READ
// their money here but never write the ledger — the only writers are the
// server's payment transitions, admin adjustments and payout completion.
const LEDGER_TYPE_LABEL: Record<string, string> = {
  sale: "Sale", commission: "Commission", refund: "Refund", payout: "Payout", adjustment: "Adjustment",
};
const PAYOUT_STATUS_LABEL: Record<string, string> = {
  requested: "Requested", processing: "Processing", completed: "Completed", failed: "Failed", cancelled: "Cancelled",
};
const PAYOUT_METHOD_LABEL: Record<string, string> = { bank: "Bank transfer", esewa: "eSewa", khalti: "Khalti" };

type PayoutMethod = "bank" | "esewa" | "khalti";

export function SellerEarnings({ callArgs }: { callArgs: SellerArgs }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const args = callArgs as unknown as Record<string, unknown>;
  const earnings = useQuery({ queryKey: ["seller-earnings"], queryFn: () => api.sellerGetEarnings(args) });
  const details = useQuery({ queryKey: ["seller-payout-details"], queryFn: () => api.sellerGetPayoutDetails(args) });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["seller-earnings"] });
    void queryClient.invalidateQueries({ queryKey: ["seller-payout-details"] });
  };
  const requestPayout = useMutation({
    mutationFn: (v: { amount_paisa: number; method: PayoutMethod }) => api.sellerRequestPayout({ ...args, ...v }),
    onSuccess: () => { refresh(); toast("Payout requested — our team will process it shortly."); },
    onError: (e) => toast(e instanceof Error ? e.message : "Could not request the payout.", "err"),
  });
  const cancelPayout = useMutation({
    mutationFn: (payout_id: number) => api.sellerCancelPayout({ ...args, payout_id }),
    onSuccess: () => { refresh(); toast("Payout request cancelled — the amount is available again."); },
    onError: (e) => toast(e instanceof Error ? e.message : "Could not cancel.", "err"),
  });
  const saveDetails = useMutation({
    mutationFn: (v: { bank_name?: string; account_name?: string; account_number?: string; esewa_id?: string; khalti_id?: string; remove?: PayoutMethod[] }) =>
      api.sellerSavePayoutDetails({ ...args, ...v }),
    onSuccess: (_d, v) => {
      setFormKey((k) => k + 1);
      refresh();
      toast(v.remove?.length ? "Payout method removed." : "Payout details saved.");
    },
    onError: (e) => toast(e instanceof Error ? e.message : "Could not save.", "err"),
  });
  // Remount the details form after each save so cleared/removed methods
  // disappear instead of lingering in the inputs.
  const [formKey, setFormKey] = useState(0);
  const removeMethod = (m: PayoutMethod, label: string) => {
    if (!window.confirm(`Remove your ${label} payout details? You can add them again any time.`)) return;
    saveDetails.mutate({ remove: [m] });
  };

  if (earnings.isPending) return <p className="muted">Loading your earnings…</p>;
  if (earnings.error) return <p className="form-error">Earnings could not load.</p>;
  const d = earnings.data!;
  const b = d.balances;
  const det = details.data;
  const hasBank = !!det?.bank_name;
  const hasEsewa = !!det?.esewa_id;
  const hasKhalti = !!det?.khalti_id;
  const methodOk = (m: PayoutMethod) => (m === "bank" ? hasBank : m === "esewa" ? hasEsewa : hasKhalti);

  const submitPayout = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const rupees = Number(fd.get("amount"));
    if (!Number.isFinite(rupees) || rupees <= 0) { toast("Enter an amount in rupees.", "err"); return; }
    const method = String(fd.get("method") ?? "") as PayoutMethod;
    if (!methodOk(method)) { toast("Add your details for that method first.", "err"); return; }
    requestPayout.mutate({ amount_paisa: Math.round(rupees * 100), method });
    e.currentTarget.reset();
  };
  const submitDetails = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const v = (k: string) => { const s = String(fd.get(k) ?? "").trim(); return s ? s : undefined; };
    saveDetails.mutate({ bank_name: v("bank_name"), account_name: v("account_name"), account_number: v("account_number"), esewa_id: v("esewa_id"), khalti_id: v("khalti_id") });
  };
  const signed = (paisa: number) => `${paisa < 0 ? "−" : "+"}${money(Math.abs(paisa))}`;

  return (
    <div className="studio-layout">
      <section className="studio-section wide"><h2>Balances</h2>
        <div className="stat-grid">
          <div><b>{money(b.available_paisa)}</b><span>Available{b.reserved_paisa > 0 ? ` (${money(b.reserved_paisa)} held by pending payouts)` : ""}</span></div>
          <div><b>{money(b.pending_paisa)}</b><span>Pending</span></div>
          <div><b>{money(b.paid_paisa)}</b><span>Paid out</span></div>
        </div>
        <p className="muted"><small>
          Earnings become available {b.hold_days === 0 ? "as soon as an order is delivered" : `${b.hold_days} days after delivery`}.
          {" "}Minimum payout {money(b.min_payout_paisa)} · platform commission {b.default_commission_percent}% unless a rule says otherwise.
          Delivery fees go to the courier and never enter your earnings.
        </small></p>
      </section>

      <section className="studio-section"><h2>Request a payout</h2>
        <form className="stack-form compact" onSubmit={submitPayout}>
          <label>Amount, rupees (available: {money(b.requestable_paisa)})
            <input name="amount" type="number" min="0.01" step="0.01" required placeholder={String(Math.max(0, b.requestable_paisa / 100))} />
          </label>
          <label>Method
            <select name="method" defaultValue={hasBank ? "bank" : hasEsewa ? "esewa" : "khalti"}>
              <option value="bank" disabled={!hasBank}>Bank transfer{hasBank ? "" : " — add details below"}</option>
              <option value="esewa" disabled={!hasEsewa}>eSewa{hasEsewa ? "" : " — add ID below"}</option>
              <option value="khalti" disabled={!hasKhalti}>Khalti{hasKhalti ? "" : " — add ID below"}</option>
            </select>
          </label>
          <button className="primary" disabled={requestPayout.isPending || b.requestable_paisa < b.min_payout_paisa}>
            {requestPayout.isPending ? "Requesting…" : "Request payout"}
          </button>
          {b.requestable_paisa < b.min_payout_paisa && <small className="muted">You need {money(b.min_payout_paisa)} available before you can request a payout.</small>}
        </form>
      </section>

      <section className="studio-section"><h2>Payout details</h2>
        {details.isPending ? <p className="muted"><small>Loading…</small></p> : (
          <form key={formKey} className="stack-form compact" onSubmit={submitDetails}>
            <label>Bank name<input name="bank_name" defaultValue={det?.bank_name ?? ""} maxLength={80} placeholder="e.g. Nabil Bank" /></label>
            <div className="form-pair">
              <label>Account holder<input name="account_name" defaultValue={det?.account_name ?? ""} maxLength={80} /></label>
              <label>Account number<input name="account_number" inputMode="numeric" maxLength={30} placeholder={det?.account_number_masked ?? "Not set"} autoComplete="off" /><small>{det?.account_number_masked ? `Saved as ${det.account_number_masked} — enter a new number to replace it` : "Only the last four digits are ever shown back to you."}</small></label>
            </div>
            <div className="form-pair">
              <label>eSewa ID<input name="esewa_id" defaultValue={det?.esewa_id ?? ""} maxLength={40} placeholder="eSewa mobile number" /></label>
              <label>Khalti ID<input name="khalti_id" defaultValue={det?.khalti_id ?? ""} maxLength={40} placeholder="Khalti mobile number" /></label>
            </div>
            <button className="primary" disabled={saveDetails.isPending}>{saveDetails.isPending ? "Saving…" : "Save payout details"}</button>
            {(det?.bank_name || det?.esewa_id || det?.khalti_id) && (
              <small className="muted">Remove a method:
                {det?.bank_name && <> <button type="button" className="text-danger" disabled={saveDetails.isPending} onClick={() => removeMethod("bank", "bank")}>bank</button></>}
                {det?.esewa_id && <> · <button type="button" className="text-danger" disabled={saveDetails.isPending} onClick={() => removeMethod("esewa", "eSewa")}>eSewa</button></>}
                {det?.khalti_id && <> · <button type="button" className="text-danger" disabled={saveDetails.isPending} onClick={() => removeMethod("khalti", "Khalti")}>Khalti</button></>}
              </small>
            )}
          </form>
        )}
      </section>

      <section className="studio-section"><h2>Payout history</h2>
        {d.payouts.length === 0 ? <p className="muted">No payouts yet.</p> : (
          <div className="kv">{d.payouts.map((p) => (
            <span key={p.id}>
              <b>{money(p.amount_paisa)}</b> {PAYOUT_METHOD_LABEL[p.method]} · {p.destination} · {PAYOUT_STATUS_LABEL[p.status]}
              {p.reference && <small> · ref {p.reference}</small>}
              {p.status === "requested" && <button type="button" className="text-danger" disabled={cancelPayout.isPending} onClick={() => cancelPayout.mutate(p.id)}>Cancel</button>}
              <small> ({fmtDate(p.created_at)})</small>
            </span>
          ))}</div>
        )}
      </section>

      <section className="studio-section wide"><h2>Money trail</h2>
        <p className="muted"><small>Every rupee, in order — sales, commission, refunds, payouts and adjustments. Newest first.</small></p>
        {d.ledger.length === 0 ? <p className="muted">Nothing here yet — earnings appear once a paid order is delivered.</p> : (
          <div className="kv">{d.ledger.map((l) => (
            <span key={l.id} title={l.note}>
              <b>{signed(l.amount_paisa)}</b> {LEDGER_TYPE_LABEL[l.type] ?? l.type}
              {l.order_code ? ` · ${l.order_code}` : ""}{l.rule_id ? ` · rule #${l.rule_id}` : ""}
              <small> · balance {money(l.balance_after_paisa)} · {fmtDate(l.created_at)}</small>
            </span>
          ))}</div>
        )}
      </section>
    </div>
  );
}
