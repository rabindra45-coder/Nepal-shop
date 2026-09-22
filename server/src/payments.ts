// eSewa v2 + Khalti payment helpers.
//
// Credentials come ONLY from process.env (ESEWA_MERCHANT_ID, ESEWA_SECRET_KEY,
// ESEWA_MODE, KHALTI_SECRET_KEY, KHALTI_MODE, PUBLIC_BASE_URL). Nothing here
// ever fakes success: when keys are missing or a provider call fails, the
// callers throw honest errors and mark the payment row accordingly.
//
// Webhook/redirect architecture: neither provider calls us server-to-server.
// Both redirect the buyer's browser to
//   {PUBLIC_BASE_URL}/#/payment-result?provider=<esewa|khalti>&group_id=<id>
// (the id is the customer-facing order GROUP; one checkout = one payment,
// even when it spans several sellers)
// (see buildEsewaParams / initiateKhalti return_url), and that page calls the
// verifyEsewaPayment / verifyKhaltiPayment actions, which do the real
// server-side verification below before marking anything paid.

export type PaymentMode = "test" | "live";

function modeOf(v: string | undefined): PaymentMode {
  return (v ?? "test").toLowerCase() === "live" ? "live" : "test";
}

export function publicBaseUrl(): string {
  return (process.env.PUBLIC_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}

// ---------- eSewa ----------

export function esewaConfig() {
  return {
    merchantId: process.env.ESEWA_MERCHANT_ID ?? "",
    secretKey: process.env.ESEWA_SECRET_KEY ?? "",
    mode: modeOf(process.env.ESEWA_MODE),
  };
}

export function esewaFormUrl(mode: PaymentMode): string {
  return mode === "live"
    ? "https://epay.esewa.com.np/api/epay/main/v2/form"
    : "https://rc-epay.esewa.com.np/api/epay/main/v2/form";
}

// eSewa amounts are rupees; our DB stores paisa.
export function paisaToRs(paisa: number): string {
  return (paisa / 100).toString();
}

export async function hmacSha256Base64(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Buffer.from(sig).toString("base64");
}

// Build the real eSewa v2 form params. Throws an honest error when the
// merchant credentials are not configured.
export async function buildEsewaParams(args: {
  orderCode: string;
  orderId: number;
  totalPaisa: number;
  deliveryPaisa: number;
}): Promise<{ params: Record<string, string>; paymentUrl: string }> {
  const { merchantId, secretKey, mode } = esewaConfig();
  if (!merchantId || !secretKey) {
    throw new Error("eSewa payments are not configured yet. Please choose Cash on Delivery.");
  }
  const baseUrl = publicBaseUrl();
  const total = paisaToRs(args.totalPaisa);
  const params: Record<string, string> = {
    amount: paisaToRs(args.totalPaisa - args.deliveryPaisa),
    tax_amount: "0",
    total_amount: total,
    transaction_uuid: args.orderCode,
    product_code: merchantId,
    product_service_charge: "0",
    product_delivery_charge: paisaToRs(args.deliveryPaisa),
    success_url: `${baseUrl}/#/payment-result?provider=esewa&group_id=${args.orderId}`,
    failure_url: `${baseUrl}/#/payment-result?provider=esewa&group_id=${args.orderId}`,
    signed_field_names: "total_amount,transaction_uuid,product_code",
  };
  const signedString = `total_amount=${total},transaction_uuid=${args.orderCode},product_code=${merchantId}`;
  params.signature = await hmacSha256Base64(secretKey, signedString);
  return { params, paymentUrl: esewaFormUrl(mode) };
}

export interface EsewaDecoded {
  ok: boolean;
  payload?: Record<string, string>;
  error?: string;
}

// Verify the base64 `data` eSewa appends to success_url.
export async function verifyEsewaSignature(data: string): Promise<EsewaDecoded> {
  const { secretKey } = esewaConfig();
  if (!secretKey) return { ok: false, error: "eSewa payments are not configured yet." };
  let payload: Record<string, string>;
  try {
    payload = JSON.parse(Buffer.from(data, "base64").toString("utf-8"));
  } catch {
    return { ok: false, error: "The eSewa payment response could not be read." };
  }
  const fieldNames = (payload.signed_field_names ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!fieldNames.length || !payload.signature) {
    return { ok: false, error: "The eSewa payment response is missing its signature." };
  }
  const signedString = fieldNames.map((n) => `${n}=${payload[n] ?? ""}`).join(",");
  const expected = await hmacSha256Base64(secretKey, signedString);
  if (expected !== payload.signature) {
    return { ok: false, error: "The eSewa payment signature could not be verified." };
  }
  return { ok: true, payload };
}

// Server-side status check with eSewa. Returns the status string
// ("COMPLETE" when the money moved) or null when unreachable.
export async function esewaTransactionStatus(args: {
  productCode: string;
  totalAmount: string;
  transactionUuid: string;
}): Promise<string | null> {
  const { mode } = esewaConfig();
  const host = mode === "live" ? "https://epay.esewa.com.np" : "https://rc-epay.esewa.com.np";
  const url =
    `${host}/api/epay/transaction/status/` +
    `?product_code=${encodeURIComponent(args.productCode)}` +
    `&total_amount=${encodeURIComponent(args.totalAmount)}` +
    `&transaction_uuid=${encodeURIComponent(args.transactionUuid)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = (await res.json().catch(() => null)) as { status?: string } | null;
    return json?.status ?? null;
  } catch {
    return null;
  }
}

// ---------- Khalti ----------

export function khaltiConfig() {
  return {
    secretKey: process.env.KHALTI_SECRET_KEY ?? "",
    mode: modeOf(process.env.KHALTI_MODE),
  };
}

export function khaltiBaseUrl(mode: PaymentMode): string {
  return mode === "live" ? "https://khalti.com" : "https://dev.khalti.com";
}

export interface KhaltiInitiated {
  pidx: string;
  paymentUrl: string;
}

// Server-side initiate call. Khalti amounts are paisa, matching our DB.
// Throws an honest error when unconfigured or when Khalti rejects/errors.
export async function initiateKhalti(args: {
  orderCode: string;
  orderId: number;
  totalPaisa: number;
}): Promise<KhaltiInitiated> {
  const { secretKey, mode } = khaltiConfig();
  if (!secretKey) {
    throw new Error("Khalti payments are not configured yet. Please choose Cash on Delivery.");
  }
  const baseUrl = publicBaseUrl();
  let res: Response;
  try {
    res = await fetch(`${khaltiBaseUrl(mode)}/api/v2/epayment/initiate/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Key ${secretKey}` },
      body: JSON.stringify({
        return_url: `${baseUrl}/#/payment-result?provider=khalti&group_id=${args.orderId}`,
        website_url: baseUrl,
        amount: args.totalPaisa,
        purchase_order_id: args.orderCode,
        purchase_order_name: `Nepal Shop order ${args.orderCode}`,
      }),
    });
  } catch {
    throw new Error("Khalti could not be reached. Please try again or choose Cash on Delivery.");
  }
  const json = (await res.json().catch(() => null)) as { pidx?: string; payment_url?: string; detail?: string } | null;
  if (!res.ok || !json?.pidx || !json?.payment_url) {
    throw new Error(
      json?.detail ?? "Khalti could not start this payment. Please try again or choose Cash on Delivery.",
    );
  }
  return { pidx: json.pidx, paymentUrl: json.payment_url };
}

// Server-side lookup of a Khalti payment. Returns the status string
// ("Completed" when the money moved) and the amount in paisa when Khalti
// reports it, or nulls when unreachable.
export async function lookupKhalti(pidx: string): Promise<{ status: string | null; amountPaisa: number | null }> {
  const { secretKey, mode } = khaltiConfig();
  if (!secretKey) {
    throw new Error("Khalti payments are not configured yet. Please choose Cash on Delivery.");
  }
  try {
    const res = await fetch(`${khaltiBaseUrl(mode)}/api/v2/epayment/lookup/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Key ${secretKey}` },
      body: JSON.stringify({ pidx }),
    });
    if (!res.ok) return { status: null, amountPaisa: null };
    const json = (await res.json().catch(() => null)) as { status?: string; total_amount?: number } | null;
    return { status: json?.status ?? null, amountPaisa: typeof json?.total_amount === "number" ? json.total_amount : null };
  } catch {
    return { status: null, amountPaisa: null };
  }
}
