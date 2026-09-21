# Data Plan

## Context provenance
- `The shopping site — a customer-facing store that rivals Daraz` (current user clarification; sets the primary buyer-facing marketplace workflow rather than the earlier seller-SaaS recommendation.)
- `Add the most interesting features that daraz and other soping stores doesnot have.` (current request; shapes the trust-first differentiators: explicit COD confirmation, transparent order totals, seller status, verified-purchase reviews, and buyer issue reporting.)
- `Nepal's Instagram and Facebook sellers run their whole business over DMs with no proper storefront, no order tracking, and heavy losses from fake cash-on-delivery orders.` (parent-conversation research summary; informs the seller studio, inventory/order backend, and COD workflow.)
- Deep-research report `/home/hatch/workspace/research_notes/nepal-profitable-website-opportunities-20260921-1530/report.md` (web-derived; used only for the cited Nepal e-commerce and payment context, not as invented catalog data.)

## Tested sources
### Finished deep-research report
**Used by**: static trust/payment context links in the buyer and seller flows; feature selection
**Test command**: `read /home/hatch/workspace/research_notes/nepal-profitable-website-opportunities-20260921-1530/report.md`
**Sample output**: Social sellers face manual order handling and COD/RTO loss; the report cites 1,530 e-commerce registration applications, with 345 approved and over 90% of merchants concentrated in Kathmandu Valley. It reports eSewa 10M+ users and Khalti 5M+ users, 1.5–2% merchant commission, T+1 settlement, and merchant requirements including PAN/VAT, a Nepali bank account, and a live website; the report explicitly says commission rates should be reconfirmed at signup.
**Processing**: Use only concise, interaction-relevant context. Preserve the report’s caveat that wallet pricing and merchant terms must be reconfirmed. Do not turn report estimates into live store metrics, and do not fabricate catalog items, sellers, wallet connectivity, verification, orders, or reviews.

### Fossa Technology payment integration guide
**Used by**: wallet-setup disclosure within checkout/seller studio
**Test command**: source was already verified live by the finished research on 2026-09-21; no duplicate retrieval performed
**Sample output**: `https://fossatechnology.com.np/blog/esewa-khalti-integration-nepal` — report records eSewa/Khalti user counts, 1.5–2% commission, T+1 settlement, REST/sandbox support, and merchant onboarding requirements, with a reconfirm-at-signup caveat.
**Processing**: Link to the exact URL. Wallet choices remain visibly unavailable until real merchant credentials exist; the interface never simulates a payment.

### Kathmandu Post e-commerce article
**Used by**: compact Nepal-market context note in seller studio
**Test command**: source was indexed in the finished research; no duplicate retrieval performed
**Sample output**: `https://kathmandupost.com/money/2026/08/27/fast-delivery-changes-the-game-for-nepal-s-online-sellers` — the report attributes 1,530 applicants, 345 approvals, and >90% Valley concentration to this article.
**Processing**: Preserve attribution and avoid presenting the figures as live platform data.

### NCN Delivery COD/RTO article
**Used by**: rationale link beside the COD trust trail
**Test command**: source was indexed in the finished research; no duplicate retrieval performed
**Sample output**: `https://medium.com/@ncndeliveryseo/cash-on-delivery-cod-in-nepal-benefits-risks-and-best-practices-fc193c365b06` — the report describes COD return-to-origin as a major risk and recommends customer-history tracking.
**Processing**: Implement a transparent per-store history summary derived only from orders created in this artifact; do not create a hidden cross-store fraud score or pre-label any buyer.

## Image slots
### Hero parcel-exchange illustration
**Source**: generated at build time with `media_generate_image`; no external URL.
**Acceptance plan**: inspect the returned owned image and reject it if it contains baked-in text, logos, watermarks, photorealistic real-person implications, or imagery inconsistent with a Nepal-local marketplace. Import the accepted file from `client/src/assets/`.

### Product imagery
**Source**: none initially. Product catalog is seller-entered and starts empty; no remote URLs or fabricated merchandise are introduced.
**Acceptance plan**: product rows are intentionally designed to render well without images. Runtime image upload is out of scope until owned blob upload is implemented.

## Long-term data behavior
- **Refresh policy**: no cron or external refresh. Queries refetch after local mutations.
- **Growth**: seller-created products, orders, order items, reviews, and buyer issues grow in the artifact database. The catalog begins empty rather than shipping invented products.
- **Ordering**: in-stock products first, then newest listings; orders newest first; reviews newest first.
- **Time semantics**: creation and update timestamps are stored as UTC instants and rendered viewer-local. Order events do not infer a separate timezone.

## Rejected approaches
- **Tried**: pre-populating a Daraz-like catalog with plausible products and prices.
  **Why rejected**: the request provided no real sellers or inventory and did not ask for demo data; fabricated catalog rows would misrepresent products, prices, stock, and seller identity.
- **Tried**: showing eSewa/Khalti as working payment methods without merchant credentials.
  **Why rejected**: the research says merchant onboarding requires a registered business, bank account, and live website. The artifact will show an honest setup state and keep COD as the usable checkout path.
- **Tried**: implementing a shared secret fraud blacklist.
  **Why rejected**: opaque cross-seller risk scoring would be unfair and unsupported. The built COD trust trail uses only transparent counts from this artifact’s own order history.
- **Tried**: remote product-image URLs.
  **Why rejected**: the marketplace has no supplied catalog, and the artifact must own rendered image bytes.
