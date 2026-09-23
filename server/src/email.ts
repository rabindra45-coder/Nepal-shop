// Outgoing email for Nepal Shop.
//
// Two providers, in this precedence:
//   1. Brevo HTTPS API (BREVO_API_KEY) — the production path on Render,
//      whose free tier blocks outbound SMTP ports entirely.
//   2. SMTP — configuration from environment variables OR the admin-managed
//      smtp_settings table (single row, id=1), with this precedence:
//        ENV (SMTP_HOST + SMTP_USER + SMTP_PASS all set) > DB row > none.
//        SMTP_PORT (default 587, use 465 for implicit TLS),
//        SMTP_FROM (defaults to SMTP_USER).
//
// Env values live outside the repo as before; the DB row is managed from
// the admin panel (adminSaveSmtpSettings). The stored password is never
// logged and never returned by any action.
//
// When unconfigured, sendEmail logs a warning and reports { sent: false }
// instead of faking delivery — callers must treat that honestly (e.g. the
// password-reset action still returns a generic ok to avoid account
// enumeration, but no email goes out and the server log says so).
import nodemailer, { type Transporter } from "nodemailer";
import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
// Runtime import (not type-only): dbSmtpConfig queries smtp_settings.
// schema.ts only depends on drizzle-orm, so there is no import cycle.
import * as schema from "./schema";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

// Result of an attempted send. `sent` is only ever true when the message
// genuinely left this server (Brevo API or SMTP) or was deliberately
// captured by the test harness — never faked.
export interface EmailResult {
  sent: boolean;
  error?: string;
  captured?: boolean;
}

// --- test capture mode -------------------------------------------------------
// When EMAIL_TEST_CAPTURE=1, sendEmail renders the message and records it in
// capturedEmails() instead of contacting any SMTP server, and reports
// { sent: true, captured: true }. The verification script uses this to assert
// that every trigger produces a well-formed email with correct data —
// without touching real credentials. NEVER set this in production.
export interface CapturedEmail {
  to: string;
  subject: string;
  text: string;
  html?: string;
  at: string;
}
const captured: CapturedEmail[] = [];
export function capturedEmails(): CapturedEmail[] {
  return [...captured];
}
export function clearCapturedEmails(): void {
  captured.length = 0;
}
function captureEnabled(): boolean {
  return process.env.EMAIL_TEST_CAPTURE === "1";
}

export function emailConfigured(): Promise<boolean> {
  // EMAIL_TEST_CAPTURE=1 counts as configured so test flows can exercise
  // the send path; production never sets that flag.
  return Promise.resolve(captureEnabled() || brevoConfig() !== null).then((fast) =>
    fast ? true : getSmtpConfig().then((cfg) => cfg !== null),
  );
}

// --- SMTP configuration: env > DB > none ------------------------------------
// The DB row is read fresh on every call (single-row lookup, negligible
// cost) so an admin saving new settings takes effect on the very next send
// with no restart. The cached transporter below is keyed on the full
// resolved config (including the row's updated_at), so any settings change
// transparently drops the old transporter — no stale credentials.
//
// The host process injects its drizzle instance once at boot via
// setSmtpDbProvider (selfhost.ts). Hosts that never call it (e.g. the
// Muse-hosted version) simply fall back to env-only behaviour.

export interface SmtpConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  from: string;
  source: "env" | "db";
  // Monotonic marker for the DB-sourced config (the row's updated_at, or 0
  // when unset); "env" for env-sourced. Part of the transporter cache key.
  version: string;
}

type SmtpDb = PostgresJsDatabase<typeof schema>;
let dbProvider: (() => SmtpDb) | null = null;
export function setSmtpDbProvider(provider: (() => SmtpDb) | null): void {
  dbProvider = provider;
}

function envSmtpConfig(): SmtpConfig | null {
  const host = (process.env.SMTP_HOST ?? "").trim();
  const username = (process.env.SMTP_USER ?? "").trim();
  const password = process.env.SMTP_PASS ?? "";
  if (!host || !username || !password) return null;
  const port = Number(process.env.SMTP_PORT ?? 587);
  return {
    host,
    port: Number.isFinite(port) && port >= 1 && port <= 65535 ? Math.round(port) : 587,
    username,
    password,
    from: (process.env.SMTP_FROM ?? "").trim() || username,
    source: "env",
    version: "env",
  };
}

async function dbSmtpConfig(): Promise<SmtpConfig | null> {
  if (!dbProvider) return null;
  try {
    const db = dbProvider();
    const row = (await db.select().from(schema.smtpSettings).where(eq(schema.smtpSettings.id, 1)).limit(1))[0];
    const host = (row?.host ?? "").trim();
    const username = (row?.username ?? "").trim();
    const password = row?.password ?? "";
    if (!host || !username || !password) return null;
    const port = row?.port ?? 587;
    return {
      host,
      port: Number.isFinite(port) && port >= 1 && port <= 65535 ? Math.round(port) : 587,
      username,
      password,
      from: (row?.fromAddress ?? "").trim() || username,
      source: "db",
      version: String(row?.updatedAt?.getTime() ?? 0),
    };
  } catch {
    // Table missing (database migrated before smtp_settings existed, or a
    // host without the provider) — treat as unconfigured, never crash.
    return null;
  }
}

export async function getSmtpConfig(): Promise<SmtpConfig | null> {
  return envSmtpConfig() ?? (await dbSmtpConfig());
}

let transporter: Transporter | null = null;
let transporterKey: string | null = null;

function transporterCacheKey(cfg: SmtpConfig): string {
  // Includes the password so a credential rotation drops the old
  // transporter; this string is in-memory only and is never logged.
  return [cfg.source, cfg.host, cfg.port, cfg.username, cfg.password, cfg.from, cfg.version].join("\u0000");
}

function getTransporter(cfg: SmtpConfig): Transporter {
  const key = transporterCacheKey(cfg);
  if (!transporter || transporterKey !== key) {
    transporter = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.port === 465,
      auth: { user: cfg.username, pass: cfg.password },
      // Hard timeouts: a stalled SMTP server must fail fast with its real
      // error instead of hanging the request forever (the "Load failed"
      // symptom on the admin test-email button, and verification emails
      // that never arrive because the send never completes).
      connectionTimeout: 15000, // wait for the TCP connection
      greetingTimeout: 15000, // wait for the SMTP greeting after connect
      socketTimeout: 30000, // inactivity during the session
    });
    transporterKey = key;
  }
  return transporter;
}

// --- Brevo HTTPS email provider ------------------------------------------------
// Render's free tier blocks outbound SMTP ports (25/465/587) at the network
// level, so no SMTP credentials can ever work there — every attempt fails
// with "Connection timeout". Brevo's transactional API speaks plain HTTPS
// (port 443, never blocked) and has a free tier (300 emails/day), so it is
// the production email path on Render. SMTP is kept for local development
// and hosts that allow outbound SMTP.
//
//   BREVO_API_KEY        — the v3 API key from Brevo (SMTP & API settings).
//   BREVO_SENDER_EMAIL   — the From address; must be added and verified as a
//                          sender in the Brevo account. Falls back to
//                          SMTP_FROM, then SMTP_USER.
//   BREVO_API_URL        — override for tests only; defaults to the real API.
//
// Precedence (highest first): test capture > BREVO_API_KEY > SMTP (env > db)
// > unconfigured. The key lives in the environment, never in the repo.

export interface BrevoConfig {
  apiKey: string;
  senderEmail: string;
  apiUrl: string;
}

export function brevoConfig(): BrevoConfig | null {
  const apiKey = (process.env.BREVO_API_KEY ?? "").trim();
  if (!apiKey) return null;
  const senderEmail =
    (process.env.BREVO_SENDER_EMAIL ?? "").trim() ||
    (process.env.SMTP_FROM ?? "").trim() ||
    (process.env.SMTP_USER ?? "").trim();
  if (!senderEmail) return null;
  return {
    apiKey,
    senderEmail,
    apiUrl: (process.env.BREVO_API_URL ?? "").trim() || "https://api.brevo.com/v3/smtp/email",
  };
}

async function sendViaBrevo(msg: EmailMessage, cfg: BrevoConfig): Promise<EmailResult> {
  const body: Record<string, unknown> = {
    sender: { email: cfg.senderEmail, name: "Nepal Shop" },
    to: [{ email: msg.to }],
    subject: msg.subject,
    textContent: msg.text,
  };
  if (msg.html) body.htmlContent = msg.html;
  let res: Response;
  try {
    res = await fetch(cfg.apiUrl, {
      method: "POST",
      headers: {
        "api-key": cfg.apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      // Fail fast with Brevo's real error instead of hanging the request.
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[email] brevo request to ${msg.to} failed: ${message}`);
    return { sent: false, error: message };
  }
  if (res.ok) return { sent: true };
  let detail = `Brevo API error ${res.status}`;
  try {
    const data = (await res.json()) as { message?: string; code?: string };
    if (data?.message) detail = data.code ? `${data.message} (${data.code})` : data.message;
  } catch {
    // Non-JSON error body — keep the status-based detail.
  }
  console.error(`[email] brevo send to ${msg.to} failed: ${detail}`);
  return { sent: false, error: detail };
}

export async function sendEmail(msg: EmailMessage): Promise<EmailResult> {
  if (captureEnabled()) {
    captured.push({ to: msg.to, subject: msg.subject, text: msg.text, html: msg.html, at: new Date().toISOString() });
    return { sent: true, captured: true };
  }
  const brevo = brevoConfig();
  if (brevo) return sendViaBrevo(msg, brevo);
  const cfg = await getSmtpConfig();
  if (!cfg) {
    console.warn(`[email] not configured — email to ${msg.to} ("${msg.subject}") was not sent`);
    return { sent: false, error: "Email is not configured." };
  }
  try {
    await getTransporter(cfg).sendMail({
      from: cfg.from,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
    });
    return { sent: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[email] send to ${msg.to} failed: ${message}`);
    return { sent: false, error: message };
  }
}

export function resetPasswordEmail(to: string, name: string, link: string): EmailMessage {
  return {
    to,
    subject: "Reset your Nepal Shop password",
    text:
      `Hello ${name},\n\n` +
      `We received a request to reset the password for your Nepal Shop account.\n\n` +
      `Reset it here (valid for 1 hour, one-time use):\n${link}\n\n` +
      `If you did not ask for this, you can safely ignore this email — your password will not change.\n\n` +
      `— Nepal Shop`,
  };
}

export function sellerVerificationEmail(to: string, name: string, link: string): EmailMessage {
  return {
    to,
    subject: "Verify your Nepal Shop seller account",
    text:
      `Hello ${name},\n\n` +
      `Welcome to Nepal Shop! Please verify this email address to finish setting up your seller account.\n\n` +
      `Verify here (valid for 24 hours, one-time use):\n${link}\n\n` +
      `After verification, your shop goes to our review team. You can add products as drafts in the meantime — they go live once your shop is approved.\n\n` +
      `If you did not create this account, you can safely ignore this email.\n\n` +
      `— Nepal Shop`,
  };
}

export function orderEmail(to: string, subject: string, body: string): EmailMessage {
  return {
    to,
    subject: `[Nepal Shop] ${subject}`,
    text: `${body}\n\n— Nepal Shop`,
  };
}

// ---------------------------------------------------------------------------
// Transactional templates (checkpoint 18 — notifications).
//
// Every template takes only the data it needs and never includes passwords,
// session tokens, full bank account numbers or other sensitive values.
// Single-use links (verification / password reset) are fine — they expire
// and cannot be replayed.
// ---------------------------------------------------------------------------

export function buyerWelcomeEmail(to: string, name: string): EmailMessage {
  return orderEmail(
    to,
    `Welcome to Nepal Shop, ${name}`,
    `Hello ${name},\n\n` +
      `Welcome to Nepal Shop — thank you for creating an account.\n\n` +
      `You can now check out faster, track every order in one place, and save items to your wishlist. ` +
      `If you added an email address, we have sent you a separate message to verify it.\n\n` +
      `Happy shopping!`,
  );
}

export function buyerVerificationEmail(to: string, name: string, link: string): EmailMessage {
  return orderEmail(
    to,
    "Please verify your email address",
    `Hello ${name},\n\n` +
      `Please confirm that this email address belongs to you:\n${link}\n\n` +
      `The link is valid for 24 hours and can only be used once.\n\n` +
      `If you did not create a Nepal Shop account, you can safely ignore this email.`,
  );
}

export interface OrderLineSummary {
  name: string;
  variantLabel: string | null;
  quantity: number;
  totalPaisa: number;
}

export function formatMoney(paisa: number): string {
  return `Rs ${Math.round(paisa / 100).toLocaleString("en-NP")}`;
}

function linesBlock(lines: OrderLineSummary[]): string {
  return lines
    .map((l) => `• ${l.name}${l.variantLabel ? ` (${l.variantLabel})` : ""} × ${l.quantity} — ${formatMoney(l.totalPaisa)}`)
    .join("\n");
}

export function orderConfirmationEmail(
  to: string,
  name: string,
  groupCode: string,
  fulfilments: { orderCode: string; storeName: string; lines: OrderLineSummary[]; totalPaisa: number }[],
  groupTotalPaisa: number,
  paymentMethod: string,
): EmailMessage {
  const paymentLabel = paymentMethod === "cod" ? "Cash on Delivery" : paymentMethod === "esewa" ? "eSewa" : "Khalti";
  const paymentNote = paymentMethod === "cod"
    ? "Payment is due in cash when your parcel arrives."
    : `We are awaiting payment confirmation from ${paymentLabel} — your sellers start preparing as soon as it clears.`;
  const body =
    `Hello ${name},\n\n` +
    `We have received your order ${groupCode} — thank you.\n\n` +
    fulfilments
      .map((f) => `${f.storeName} — order ${f.orderCode} (${formatMoney(f.totalPaisa)})\n${linesBlock(f.lines)}`)
      .join("\n\n") +
    `\n\nOrder total: ${formatMoney(groupTotalPaisa)} (${paymentLabel})\n${paymentNote}\n\n` +
    `Each seller prepares and dispatches their own parcel, so items may arrive separately. ` +
    `You can follow every parcel from your orders page.`;
  return orderEmail(to, `Order ${groupCode} received — thank you`, body);
}

export function sellerNewOrderEmail(
  to: string,
  storeName: string,
  orderCode: string,
  lines: OrderLineSummary[],
  totalPaisa: number,
  buyerName: string,
  buyerPhone: string,
  buyerAddress: string,
): EmailMessage {
  return orderEmail(
    to,
    `New order ${orderCode} — please prepare for dispatch`,
    `Hello ${storeName},\n\n` +
      `You have a new order: ${orderCode} (${formatMoney(totalPaisa)}).\n\n` +
      `${linesBlock(lines)}\n\n` +
      `Deliver to:\n${buyerName}\n${buyerPhone}\n${buyerAddress}\n\n` +
      `Please confirm it in your seller studio and dispatch promptly. Add your carrier and tracking number there so the buyer stays informed.`,
  );
}

export function paymentReceivedEmail(to: string, name: string, groupCode: string, amountPaisa: number, provider: string): EmailMessage {
  const providerLabel = provider === "esewa" ? "eSewa" : provider === "khalti" ? "Khalti" : provider;
  return orderEmail(
    to,
    `Payment received for order ${groupCode}`,
    `Hello ${name},\n\n` +
      `Good news — your ${providerLabel} payment of ${formatMoney(amountPaisa)} for order ${groupCode} has been confirmed.\n\n` +
      `The sellers are now preparing your parcels. You can follow their progress from your orders page.`,
  );
}

export function paymentFailedEmail(to: string, name: string, groupCode: string, reason: string): EmailMessage {
  return orderEmail(
    to,
    `Your payment for order ${groupCode} did not go through`,
    `Hello ${name},\n\n` +
      `Your payment for order ${groupCode} could not be completed.\n\n` +
      `What happened: ${reason}\n\n` +
      `No money was taken. Your items are still reserved for a short while — please try paying again from your orders page, or choose Cash on Delivery.`,
  );
}

export type ShipmentEvent = "shipped" | "out_for_delivery" | "delivered" | "delivery_failed";

export function shipmentEmail(
  to: string,
  name: string,
  orderCode: string,
  event: ShipmentEvent,
  carrier: string | null,
  tracking: string | null,
): EmailMessage {
  const carrierBit = carrier ? ` with ${carrier}` : "";
  const trackingBit = tracking ? `\n\nTracking number: ${tracking}` : "";
  const subjects: Record<ShipmentEvent, string> = {
    shipped: `Your parcel ${orderCode} is on its way`,
    out_for_delivery: `Your parcel ${orderCode} is out for delivery`,
    delivered: `Your parcel ${orderCode} has been delivered`,
    delivery_failed: `We could not deliver your parcel ${orderCode}`,
  };
  const bodies: Record<ShipmentEvent, string> = {
    shipped: `Hello ${name},\n\nGood news — your parcel ${orderCode} has shipped${carrierBit}.${trackingBit}\n\nTrack it any time from your orders page.`,
    out_for_delivery: `Hello ${name},\n\nYour parcel ${orderCode} is out for delivery${carrierBit} — please keep your phone nearby.${trackingBit}\n\nTrack it any time from your orders page.`,
    delivered: `Hello ${name},\n\nYour parcel ${orderCode} has been delivered. We hope you love it!\n\nIf anything is wrong with your items, you have 30 days from delivery to request a return from your orders page.`,
    delivery_failed: `Hello ${name},\n\nWe tried to deliver your parcel ${orderCode} but could not reach you.\n\nThe courier will usually try again. If the parcel comes back to the seller, we will cancel the order and you will owe nothing. You can also contact the seller through your orders page.`,
  };
  return orderEmail(to, subjects[event], bodies[event]);
}

export function orderCancelledBuyerEmail(to: string, name: string, code: string, actor: "buyer" | "seller" | "admin"): EmailMessage {
  const actorBit =
    actor === "buyer"
      ? "as you requested"
      : actor === "seller"
        ? "by the seller"
        : "by our marketplace team";
  return orderEmail(
    to,
    `Order ${code} cancelled`,
    `Hello ${name},\n\n` +
      `Your order ${code} has been cancelled ${actorBit}.\n\n` +
      `No payment is due. If you already paid online, the refund is handled separately and we will confirm it here. ` +
      `The reserved items have been returned to stock.`,
  );
}

export function orderCancelledSellerEmail(to: string, storeName: string, orderCode: string, actor: "buyer" | "admin"): EmailMessage {
  const actorBit = actor === "buyer" ? "The buyer" : "Our marketplace team";
  return orderEmail(
    to,
    `Order ${orderCode} was cancelled`,
    `Hello ${storeName},\n\n` +
      `${actorBit} cancelled order ${orderCode}.\n\n` +
      `Do not dispatch this parcel. The reserved stock has been returned to your inventory automatically.`,
  );
}

export type SellerAccountEvent = "under_review" | "active" | "reactivated" | "rejected" | "suspended";

export function sellerAccountStatusEmail(to: string, storeName: string, event: SellerAccountEvent): EmailMessage {
  const copy: Record<SellerAccountEvent, { subject: string; body: string }> = {
    under_review: {
      subject: "Your shop is under review",
      body: `Hello ${storeName},\n\nYour email is verified and your shop is now with our review team.\n\nYou can add products as drafts in the meantime — they go live once your shop is approved. We will email you the moment a decision is made.`,
    },
    active: {
      subject: "Your shop is approved — welcome aboard",
      body: `Hello ${storeName},\n\nCongratulations — your shop has been approved and your products are now live on Nepal Shop.\n\nOrders will arrive by email as well as in your seller studio. Keep your stock accurate and dispatch promptly to earn great ratings.`,
    },
    reactivated: {
      subject: "Your shop is active again",
      body: `Hello ${storeName},\n\nGood news — your shop has been reactivated. Your products are visible to buyers again and you can sign in to the studio as normal.\n\nIf anything about the suspension was unclear, please contact our support team.`,
    },
    rejected: {
      subject: "Your seller application was not approved",
      body: `Hello ${storeName},\n\nThank you for your interest in selling on Nepal Shop. After review, we are not able to approve your shop at this time.\n\nIf you believe this is a mistake, please reply to this email or contact our support team and we will take another look.`,
    },
    suspended: {
      subject: "Your shop has been suspended",
      body: `Hello ${storeName},\n\nYour shop has been suspended, so your products are no longer visible to buyers and you cannot sign in to the studio.\n\nPlease contact our support team to discuss this — if the issue is resolved, your shop can be reactivated.`,
    },
  };
  const c = copy[event];
  return orderEmail(to, c.subject, c.body);
}

export function productModerationEmail(to: string, storeName: string, productName: string, visible: boolean): EmailMessage {
  return orderEmail(
    to,
    visible ? `Your product "${productName}" is visible again` : `Your product "${productName}" was hidden`,
    visible
      ? `Hello ${storeName},\n\nGood news — your product "${productName}" is visible to buyers again.\n\nNo action is needed.`
      : `Hello ${storeName},\n\nOur marketplace team has hidden your product "${productName}" — it is no longer visible to buyers.\n\nThis usually means something in the listing needs attention (for example the description, photos or pricing). Please review it in your seller studio, or contact our support team if you think this is a mistake.`,
  );
}

export function commissionChangeEmail(to: string, storeName: string, scopeLabel: string, percent: number): EmailMessage {
  return orderEmail(
    to,
    "An update to marketplace commission rates",
    `Hello ${storeName},\n\n` +
      `We have updated the marketplace commission rate to ${percent}%${scopeLabel}.\n\n` +
      `The new rate applies to sales from now on — your past ledger entries are unchanged. You can see the exact commission on every order under Earnings in your seller studio.`,
  );
}

export interface LowStockItem {
  name: string;
  variantLabel: string | null;
  stock: number;
}

export function lowStockEmail(to: string, storeName: string, items: LowStockItem[]): EmailMessage {
  const list = items
    .map((i) => `• ${i.name}${i.variantLabel ? ` (${i.variantLabel})` : ""} — ${i.stock} left`)
    .join("\n");
  return orderEmail(
    to,
    `Low stock alert: ${items.length} item${items.length === 1 ? "" : "s"} running low`,
    `Hello ${storeName},\n\n` +
      `The following items have fallen to (or below) your low-stock threshold after recent orders:\n\n` +
      `${list}\n\n` +
      `Top them up in your seller studio so you do not miss sales. You will only get this alert when an item first drops to the threshold — not on every order.`,
  );
}

export function returnRequestedBuyerEmail(to: string, name: string, orderCode: string): EmailMessage {
  return orderEmail(
    to,
    `Return requested for order ${orderCode}`,
    `Hello ${name},\n\n` +
      `We have received your return request for order ${orderCode} and passed it to the seller.\n\n` +
      `You will get another email once the seller accepts or declines it.`,
  );
}

// --- admin alerts ------------------------------------------------------------
// Platform alerts go to ADMIN_EMAIL (the same address that provisions the
// first production admin). When it is unset, alertAdmin logs honestly and
// sends nothing — alerts must never crash the flow they report on.
export function adminAlertEmail(to: string, subject: string, body: string): EmailMessage {
  return {
    to,
    subject: `[Nepal Shop admin] ${subject}`,
    text: `${body}\n\n— Nepal Shop platform alert`,
  };
}

export function adminEmailAddress(): string {
  return (process.env.ADMIN_EMAIL ?? "").trim();
}
