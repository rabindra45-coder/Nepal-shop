// Printable invoice for one order group (or one seller fulfilment slice —
// the page renders whatever the server's getInvoice payload contains, so a
// signed-in seller sees only their own slice, and buyers/admins see the
// whole group).
import { useQuery } from "@tanstack/react-query";
import { api, type ApiResponse } from "./api";
import { fmtDate, money } from "./phase2api";
import { go, useAuth } from "./session";
import { EmptyBlock, Loading, PageError } from "./ui";

type Invoice = ApiResponse<typeof api, "getInvoice">["invoice"];

const PAY_STATUS: Record<string, string> = {
  pending: "Pending", processing: "Processing", paid: "Paid",
  failed: "Failed", refunded: "Refunded", cancelled: "Cancelled",
  partially_refunded: "Partially refunded",
};

export function InvoicePage({ orderCode }: { orderCode: string }) {
  const { auth } = useAuth();
  const inv = useQuery({
    queryKey: ["invoice", orderCode],
    queryFn: () => api.getInvoice({ authToken: auth?.token ?? "", order_code: orderCode }),
    enabled: !!auth && !!orderCode,
    retry: false,
  });

  if (!auth) {
    return (
      <main className="track-page">
        <EmptyBlock kicker="INVOICE" title="Log in to see this invoice." body="Invoices are available to the buyer who placed the order and to the fulfilling seller." actionLabel="Log in" onAction={() => go("/login")} />
      </main>
    );
  }
  if (inv.isPending) return <Loading text="Preparing the invoice…" />;
  if (inv.error || !inv.data) return <PageError error={inv.error} retry={() => inv.refetch()} />;
  return <InvoiceDoc invoice={inv.data.invoice} />;
}

function InvoiceDoc({ invoice: d }: { invoice: Invoice }) {
  const isSeller = useAuth().auth?.type === "seller";
  return (
    <main className="track-page invoice-page">
      <div className="invoice-actions no-print">
        <button className="ghost" onClick={() => window.history.length > 1 ? window.history.back() : go(isSeller ? "/seller" : "/account/orders")}>← Back</button>
        <button className="primary" onClick={() => window.print()}>Print invoice</button>
      </div>

      <article className="invoice" aria-label={`Invoice ${d.invoice_no}`}>
        <header className="inv-head">
          <div>
            <p className="eyebrow">Nepal Shop</p>
            <h1>Invoice</h1>
          </div>
          <dl className="inv-meta">
            <div><dt>Invoice no.</dt><dd><b>{d.invoice_no}</b></dd></div>
            <div><dt>Issued</dt><dd>{fmtDate(d.issued_at)}</dd></div>
            <div><dt>Order date</dt><dd>{fmtDate(d.order_date)}</dd></div>
            <div><dt>Order</dt><dd>{d.group_code}</dd></div>
          </dl>
        </header>

        <section className="inv-billto">
          <h2>Bill to</h2>
          <p><b>{d.customer.name}</b><br />{d.customer.phone}<br />{d.customer.address}</p>
        </section>

        {d.fulfilments.map((f) => (
          <section key={f.order_code} className="inv-seller">
            <h2>{f.store_name}</h2>
            <p className="muted">{f.order_code} · {f.status}{f.contact_phone ? ` · ${f.contact_phone}` : ""}{f.contact_email ? ` · ${f.contact_email}` : ""}</p>
            <table className="inv-table">
              <thead>
                <tr><th>Item</th><th className="num">Qty</th><th className="num">Unit price</th><th className="num">Total</th></tr>
              </thead>
              <tbody>
                {f.items.map((item, j) => (
                  <tr key={j}>
                    <td>{item.product_name}{item.variant_label ? ` (${item.variant_label})` : ""}</td>
                    <td className="num">{item.quantity}</td>
                    <td className="num">{money(item.unit_price_paisa)}</td>
                    <td className="num">{money(item.line_total_paisa)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {d.fulfilments.length > 1 && (
              <p className="muted"><small>This parcel: {money(f.subtotal_paisa)} items{f.discount_paisa > 0 && <> − {money(f.discount_paisa)} discount</>} + {f.delivery_fee_paisa === 0 ? "free" : money(f.delivery_fee_paisa)} delivery = <b>{money(f.total_paisa)}</b></small></p>
            )}
          </section>
        ))}

        <section className="inv-totals">
          <dl>
            <div><dt>Subtotal</dt><dd>{money(d.subtotal_paisa)}</dd></div>
            {d.discount_paisa > 0 && <div><dt>Discount</dt><dd className="success">−{money(d.discount_paisa)}</dd></div>}
            <div><dt>Delivery</dt><dd>{d.delivery_fee_paisa === 0 ? "Free" : money(d.delivery_fee_paisa)}</dd></div>
            <div className="grand"><dt>Grand total</dt><dd><b>{money(d.grand_total_paisa)}</b></dd></div>
          </dl>
        </section>

        <section className="inv-pay">
          <p>
            <b>Payment:</b> {d.payment.provider.toUpperCase()} · {PAY_STATUS[d.payment.status] ?? d.payment.status}
          </p>
          <p className="muted tax-note">{d.tax_note}</p>
        </section>
      </article>
    </main>
  );
}
