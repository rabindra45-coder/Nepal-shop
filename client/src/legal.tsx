// Nepal Shop — informational and legal pages (v4 production-readiness pass).
// Plain British English, no invented company details: real details that are
// not known are bracketed placeholders for Rabindra to fill in.
import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api2 } from "./phase2api";
import { go, useAuth } from "./session";
import { EmptyBlock, useToast } from "./ui";

// --- about -------------------------------------------------------------------
export function AboutPage() {
  return (
    <main className="track-page legal-page">
      <section className="track-intro">
        <p className="eyebrow">About us</p>
        <h1>A marketplace for Nepal.</h1>
        <p>
          Nepal Shop is a local online marketplace built for shoppers and
          sellers across Nepal. Instead of faceless listings, you see who is
          selling, what they charge, and exactly what your parcel costs before
          you order.
        </p>
      </section>
      <section className="studio-section">
        <h2>What makes us different</h2>
        <ul className="tick-list">
          <li><b>Verified sellers.</b> Every shop is reviewed and approved by our team before its products appear. You can shop with confidence.</li>
          <li><b>Transparent pricing.</b> The full total — product, delivery and any discount — is shown before you confirm. No surprise charges at the door.</li>
          <li><b>Cash on delivery, done properly.</b> COD orders stay “Needs confirmation” until the seller accepts them, which keeps fake orders and missed deliveries rare.</li>
          <li><b>Verified-purchase reviews.</b> Only buyers whose orders were actually delivered can leave reviews, so ratings reflect real experience.</li>
          <li><b>Buyer protection.</b> If an item arrives wrong or damaged, you can report the problem from the tracking page or raise a support ticket, and returns and refunds follow clear steps.</li>
        </ul>
      </section>
      <section className="studio-section">
        <h2>How it works</h2>
        <ol className="step-grid">
          <li><b>1 · Find</b><span>Search or browse products from local sellers, compare prices and read verified reviews.</span></li>
          <li><b>2 · Order</b><span>Check out as a guest or with an account. Pay cash on delivery, or with eSewa or Khalti when available.</span></li>
          <li><b>3 · Track</b><span>Follow your parcel with your order code and phone number until it is delivered.</span></li>
        </ol>
        <div className="form-pair cta-row">
          <button className="primary" onClick={() => go("/shop")}>Start shopping</button>
          <button className="ghost" onClick={() => go("/seller")}>Sell on Nepal Shop</button>
        </div>
      </section>
    </main>
  );
}

// --- contact -----------------------------------------------------------------
export function ContactPage() {
  const { auth } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [ticketCode, setTicketCode] = useState("");

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
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    create.mutate({
      name: String(d.get("name") ?? ""),
      contact: String(d.get("contact") ?? ""),
      subject: String(d.get("subject") ?? ""),
      message: String(d.get("message") ?? ""),
      order_code: String(d.get("order_code") ?? "").trim() || undefined,
    });
    (e.currentTarget as HTMLFormElement).reset();
  };

  return (
    <main className="track-page legal-page">
      <section className="track-intro">
        <p className="eyebrow">Contact</p>
        <h1>Talk to us.</h1>
        <p>Questions, problems or feedback — we read everything.</p>
      </section>
      <section className="studio-section">
        <h2>Reach us directly</h2>
        <dl className="contact-grid">
          <div><dt>Phone</dt><dd>[Your phone number]</dd></div>
          <div><dt>Email</dt><dd>[Your email address]</dd></div>
          <div><dt>Address</dt><dd>[Your business address]</dd></div>
          <div><dt>Social</dt><dd>[Your social media links]</dd></div>
        </dl>
        <p className="muted">Support hours: [Your support hours, e.g. Sunday–Friday, 9am–6pm NPT].</p>
      </section>
      <section className="studio-section">
        <h2>Open a support ticket</h2>
        <p className="muted">Tickets are answered by our support team. Signed-in buyers can follow their tickets on the Help page.</p>
        {ticketCode && <p className="success banner">Ticket {ticketCode} received. We will get back to you.</p>}
        <form className="stack-form" onSubmit={submit}>
          <div className="form-pair">
            <label>Your name<input name="name" required minLength={2} defaultValue={auth?.type === "buyer" ? auth.name : ""} /></label>
            <label>Contact (phone or email)<input name="contact" required minLength={3} /></label>
          </div>
          <label>Subject<input name="subject" required minLength={4} maxLength={80} placeholder="e.g. My order has not arrived" /></label>
          <label>Order code (optional)<input name="order_code" placeholder="NP-…" /></label>
          <label>Message<textarea name="message" required minLength={10} maxLength={1000} placeholder="Tell us what happened" /></label>
          {create.error && <p className="form-error" role="alert">{create.error instanceof Error ? create.error.message : String(create.error)}</p>}
          <button className="primary" disabled={create.isPending}>{create.isPending ? "Sending…" : "Send ticket"}</button>
        </form>
      </section>
    </main>
  );
}

// --- draft banner -------------------------------------------------------------
function DraftBanner() {
  return (
    <p className="banner warn draft-banner" role="note">
      <b>Draft — get local legal review before serving real customers.</b>
      <span> This policy is a starting point. Have it checked by a lawyer in Nepal before you take real orders or store real customer data.</span>
    </p>
  );
}

// --- privacy ------------------------------------------------------------------
export function PrivacyPage() {
  return (
    <main className="track-page legal-page doc-page">
      <section className="track-intro">
        <p className="eyebrow">Privacy policy</p>
        <h1>Your data, your rights.</h1>
        <p className="muted">Last updated: September 2026</p>
      </section>
      <DraftBanner />
      <section className="studio-section doc-body">
        <h2>1. What we collect</h2>
        <p>We collect only what the marketplace needs to work:</p>
        <ul>
          <li><b>Account details:</b> your name, phone number, optional email address, and a securely stored password (never the password itself — only a one-way encrypted version).</li>
          <li><b>Order details:</b> delivery addresses, order contents, totals and order history.</li>
          <li><b>Support and reviews:</b> support tickets, reported issues, and reviews you write. Reviews are public; tickets are private.</li>
          <li><b>Seller details:</b> store name, location, contact details, and sign-in credentials for sellers.</li>
          <li><b>Technical data:</b> basic usage information such as the pages you visit, so we can keep the site working and improve it.</li>
        </ul>
        <h2>2. How we use it</h2>
        <p>Your data is used to run the marketplace: to place and deliver orders, confirm cash-on-delivery orders with sellers, process refunds, reply to support tickets, show verified reviews, and keep the site secure. We do not sell your personal data to anyone.</p>
        <h2>3. Payments</h2>
        <p>Online payments are processed through eSewa and Khalti when those are connected. Your wallet details are handled by the payment provider, not stored on our servers. Cash-on-delivery orders involve no payment data at all.</p>
        <h2>4. Who sees your data</h2>
        <ul>
          <li><b>Sellers</b> see only what they need to fulfil your order: your name, phone number, delivery address and order contents.</li>
          <li><b>Payment providers</b> (eSewa, Khalti) receive the payment information needed to process your payment.</li>
          <li><b>Our admin team</b> can see orders, tickets and issues to keep the marketplace running and resolve disputes.</li>
          <li>We share data with authorities only when the law requires it.</li>
        </ul>
        <h2>5. Cookies and consent</h2>
        <p>We use a small number of cookies and similar storage:</p>
        <ul>
          <li><b>Strictly necessary:</b> keeping you signed in and your basket saved. The site cannot work without these.</li>
          <li><b>Preferences:</b> remembering your cookie choice and similar settings.</li>
          <li><b>Analytics:</b> only if enabled in the future — anonymised counts of how the site is used, never tied to your identity.</li>
        </ul>
        <p>On your first visit you are asked to accept or decline non-essential cookies. Your choice is remembered. You can change it at any time by clearing this site's storage in your browser settings.</p>
        <h2>6. Data retention</h2>
        <p>We keep your account and order data for as long as your account exists and for a reasonable period afterwards, as required by law and for accounting and dispute records. If you delete your account, we remove your personal details as soon as we no longer need them for legal or accounting reasons.</p>
        <h2>7. Your rights</h2>
        <p>You can ask us at any time to see the data we hold about you, correct mistakes, or delete your account and personal data, by contacting us at [Your email address]. We will respond within a reasonable time.</p>
        <h2>8. Security</h2>
        <p>We protect your data with encrypted connections (HTTPS), password hashing, and access controls so sellers can only see their own shops. No system is perfectly secure, but we take reasonable steps and fix problems promptly when we learn of them.</p>
        <h2>9. Children</h2>
        <p>Nepal Shop is not aimed at children. If you are under 18, please use the site with a parent or guardian.</p>
        <h2>10. Changes to this policy</h2>
        <p>If we change this policy, we will update the date above and, for significant changes, tell you through the site. Continuing to use Nepal Shop after changes means you accept the updated policy.</p>
        <h2>11. Contact</h2>
        <p>For any privacy question, contact us at [Your email address] or visit our <button className="linklike" onClick={() => go("/contact")}>Contact page</button>.</p>
      </section>
    </main>
  );
}

// --- terms --------------------------------------------------------------------
export function TermsPage() {
  return (
    <main className="track-page legal-page doc-page">
      <section className="track-intro">
        <p className="eyebrow">Terms of service</p>
        <h1>The rules of the market.</h1>
        <p className="muted">Last updated: September 2026</p>
      </section>
      <DraftBanner />
      <section className="studio-section doc-body">
        <h2>1. What Nepal Shop is</h2>
        <p>Nepal Shop is an online marketplace operated from Nepal. It connects independent sellers with buyers. We provide the platform — product listings, checkout, payments, tracking and support tools — while sellers provide and deliver the products.</p>
        <h2>2. Accounts</h2>
        <ul>
          <li>You must give accurate details when you register (name, phone number, and email where required).</li>
          <li>You are responsible for keeping your password private and for everything done under your account.</li>
          <li>Tell us promptly if you believe your account has been misused.</li>
          <li>We may suspend accounts that break these terms, submit fake orders, or misuse the marketplace.</li>
        </ul>
        <h2>3. Orders and pricing</h2>
        <ul>
          <li>All prices are shown in Nepali rupees (NPR) and include delivery costs where stated. The total shown at checkout is the total you pay.</li>
          <li>Placing an order is an offer to buy. The order is accepted when the seller confirms it.</li>
          <li>Cash-on-delivery orders stay “Needs confirmation” until the seller accepts them. If the seller does not confirm, the order is cancelled with no charge.</li>
          <li>We and sellers may cancel orders that contain obvious pricing errors, are out of stock, or look fraudulent. You will be told why.</li>
        </ul>
        <h2>4. Payments</h2>
        <ul>
          <li><b>Cash on delivery:</b> you pay the courier in cash when the parcel arrives. No payment is taken in advance.</li>
          <li><b>eSewa / Khalti:</b> when connected, online payments are processed securely by the provider. We never see your wallet PIN or full card details.</li>
          <li>If an online payment fails, your order is not confirmed until payment succeeds.</li>
        </ul>
        <h2>5. Delivery</h2>
        <p>Sellers are responsible for packing and dispatching orders within the stated delivery time. Delivery times shown at checkout are estimates; delays outside anyone's control (weather, strikes, natural disasters) do not make us liable, but we will still help you resolve problems.</p>
        <h2>6. Returns and refunds</h2>
        <ul>
          <li>You can request a return within 30 days of delivery from the tracking page, with a reason. The seller reviews your request, and the marketplace team can overrule a decision.</li>
          <li>The seller reviews your request and may accept or decline it with reasons; the marketplace team can overrule a decision. Accepted returns are refunded once the item comes back in its original condition.</li>
          <li>Refunds are completed manually by the marketplace team: online payments go back through the original payment method, and cash-on-delivery refunds are arranged with you directly.</li>
        </ul>
        <h2>7. Buyer obligations</h2>
        <ul>
          <li>Give a correct phone number and delivery address, and be reachable so the courier can find you.</li>
          <li>Pay cash on delivery when the parcel arrives; repeatedly refusing delivery may lead to your account being limited.</li>
          <li>Write honest reviews based on real experience. Only delivered buyers can leave reviews.</li>
        </ul>
        <h2>8. Seller obligations</h2>
        <ul>
          <li>Sell genuine, safe products that match your listings. Misleading listings or counterfeit goods lead to suspension.</li>
          <li>Confirm or decline COD orders promptly, keep stock levels accurate, and handle buyer issues and returns fairly.</li>
          <li>Use buyer details (name, phone, address) only to fulfil orders — never for marketing without permission.</li>
          <li>New sellers start as “pending” and their products appear only after our team approves the shop.</li>
        </ul>
        <h2>9. Our role and liability limits</h2>
        <ul>
          <li>We run the platform and help resolve disputes, but the sale contract is between you and the seller.</li>
          <li>We are not liable for the quality, safety or timely arrival of products beyond what we can reasonably control — but we will act on reports and may suspend sellers who let buyers down.</li>
          <li>Nothing in these terms limits rights you have under Nepalese consumer law.</li>
        </ul>
        <h2>10. Governing law</h2>
        <p>These terms are governed by the laws of Nepal. Disputes will first be handled through our support process; if they cannot be resolved, they fall under the jurisdiction of the courts of Nepal.</p>
        <h2>11. Changes</h2>
        <p>We may update these terms as the marketplace grows. Material changes will be announced on the site, and continued use after they take effect means you accept them.</p>
        <h2>12. Contact</h2>
        <p>Questions about these terms: [Your email address] or our <button className="linklike" onClick={() => go("/contact")}>Contact page</button>.</p>
      </section>
    </main>
  );
}

// --- 404 -----------------------------------------------------------------------
export function NotFoundPage() {
  return (
    <main className="track-page legal-page notfound">
      <section className="track-intro">
        <p className="eyebrow">404</p>
        <h1>This shelf is empty.</h1>
        <p>The page you are looking for is not here. It may have moved, or the link may be wrong.</p>
      </section>
      <EmptyBlock
        kicker="LOST YOUR WAY?"
        title="Let's get you back on track."
        body="Head home, search for something, or ask for help."
        actionLabel="Home"
        onAction={() => go("/")}
      />
      <div className="form-pair cta-row">
        <button className="ghost" onClick={() => go("/search")}>Search</button>
        <button className="ghost" onClick={() => go("/help")}>Help</button>
      </div>
    </main>
  );
}

// --- cookie consent ---------------------------------------------------------------
const CONSENT_KEY = "nepalsite_cookie_consent";

export function CookieBanner() {
  const [visible, setVisible] = useState(() => {
    try {
      return localStorage.getItem(CONSENT_KEY) == null;
    } catch {
      return false;
    }
  });
  if (!visible) return null;
  const choose = (value: "accepted" | "declined") => {
    try {
      localStorage.setItem(CONSENT_KEY, value);
    } catch {
      /* storage unavailable — banner simply hides for this visit */
    }
    setVisible(false);
  };
  return (
    <div className="cookie-banner" role="dialog" aria-live="polite" aria-label="Cookie consent">
      <p>
        We use a few cookies to keep you signed in and remember your basket. Read our{" "}
        <button className="linklike" onClick={() => go("/privacy")}>privacy policy</button>.
      </p>
      <div className="cookie-actions">
        <button className="primary" onClick={() => choose("accepted")}>Accept</button>
        <button className="ghost" onClick={() => choose("declined")}>Decline</button>
      </div>
    </div>
  );
}
