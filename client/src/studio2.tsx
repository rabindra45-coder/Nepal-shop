// Seller studio phase-2 tabs: analytics + returns.
import { type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api2, fmtDate, money, type P2Order } from "./phase2api";
import { STATUS_LABEL } from "./screens";
import { useToast } from "./ui";

type SellerArgs = Record<string, unknown>;

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
        </div>
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
            <span key={p.id}><b>{p.stock} left</b> {p.name} — restock soon</span>
          ))}</div>
        )}
      </section>
    </div>
  );
}

export function SellerReturns({ callArgs }: { callArgs: SellerArgs }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const returns = useQuery({ queryKey: ["seller-returns"], queryFn: () => api2.listReturns(callArgs) });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["seller-returns"] });
  const decide = useMutation({
    mutationFn: (v: { order_id: number; decision: "accepted" | "rejected" }) => api2.updateReturnStatus({ ...callArgs, ...v }),
    onSuccess: (_, v) => { refresh(); toast(v.decision === "accepted" ? "Return accepted." : "Return rejected — order back to delivered."); },
    onError: (e) => toast(e instanceof Error ? e.message : "Could not update.", "err"),
  });
  const refund = useMutation({
    mutationFn: (order_id: number) => api2.markRefunded({ ...callArgs, order_id }),
    onSuccess: () => { refresh(); toast("Order marked as refunded."); },
    onError: (e) => toast(e instanceof Error ? e.message : "Could not refund.", "err"),
  });

  if (returns.isPending) return <p className="muted">Loading returns…</p>;
  if (returns.error) return <p className="form-error">Returns could not load.</p>;
  const orders: P2Order[] = returns.data?.orders ?? [];
  if (orders.length === 0) return <p className="muted">No return requests right now.</p>;
  return (
    <div className="order-admin">{orders.map((o) => (
      <article key={o.id}>
        <div>
          <p className="eyebrow">{o.order_code} · {fmtDate(o.created_at)} · {STATUS_LABEL[o.status]}</p>
          <h3>{o.customer_name} · {o.phone}</h3>
          <p>{o.items.map((i) => `${i.quantity} × ${i.product_name}`).join(", ")}</p>
          <p className="muted">Paid: {o.payment_method.toUpperCase()} · {o.payment_status}</p>
        </div>
        <div className="order-actions">
          <b>{money(o.total_paisa)}</b>
          {o.status === "return_requested" && (
            <>
              <button className="primary" disabled={decide.isPending} onClick={() => decide.mutate({ order_id: o.id, decision: "accepted" })}>Accept return</button>
              <button disabled={decide.isPending} onClick={() => decide.mutate({ order_id: o.id, decision: "rejected" })}>Reject</button>
            </>
          )}
          {o.status === "returned" && (
            <button className="primary" disabled={refund.isPending} onClick={() => refund.mutate(o.id)}>Mark refunded</button>
          )}
        </div>
      </article>
    ))}</div>
  );
}

// Extended product form fields (brand, original price, image URL, low-stock
// threshold). Rendered inside Studio's existing product form.
export function ProductExtraFields({ editing }: { editing: { brand?: string | null; original_price_paisa?: number | null; image_url?: string | null; low_stock_threshold?: number } | null }) {
  return (
    <>
      <div className="form-pair">
        <label>Brand<input name="brand" defaultValue={editing?.brand ?? ""} placeholder="e.g. Himalaya Weaves" /></label>
        <label>Original price, rupees (for discounts)<input name="original_price" type="number" min="0.01" step="0.01" defaultValue={editing?.original_price_paisa ? editing.original_price_paisa / 100 : ""} placeholder="Leave empty for no discount" /></label>
      </div>
      <label>Image URL<input name="image_url" type="url" maxLength={500} defaultValue={editing?.image_url ?? ""} placeholder="https://…" /><small>Paste a link to a product photo. Leave empty for a styled placeholder.</small></label>
      <label>Low-stock alert at<input name="low_stock_threshold" type="number" min="0" defaultValue={editing?.low_stock_threshold ?? 5} /><small>Buyers see “Only X left” at or below this number.</small></label>
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
  const image_url = String(d.get("image_url") ?? "").trim() || undefined;
  const low_stock_threshold = int(d.get("low_stock_threshold"));
  return { brand, original_price_paisa, image_url, low_stock_threshold };
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
