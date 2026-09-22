# Production-Ready Website Checklist — Nepal Shop (v8 audit)

> **v8 (user-reported fixes, 2026-09-22):** eight problems found testing v7 on phone + desktop, all fixed and verified over real HTTP on fresh boots: mobile-only hamburger drawer nav (desktop/tablet untouched); "Seller studio" hidden from the public nav unless seller; product photos are real file uploads (URL paste removed, per-file progress); admin Email/SMTP tab with masked password, test-email button and env>DB>none precedence (verification emails now actually send when configured); seller logo/banner upload fixed (session token now attached); admin-uploadable site logo shown in navbar + hero; account page rebuilt as a sidebar (mobile drawer) with buyer profile-photo upload shown in header/sidebar/navbar chip; same sidebar pattern in studio + admin; mobile overflow/tap-target pass. New: migrations 0055–0057, `POST /api/site-logo-uploads`, `POST /api/profile-uploads`, `adminGetSmtpSettings`/`adminSaveSmtpSettings`/`adminSendTestSmtpEmail`. Verified: typechecks clean, client rebuilt, 36/36 verify suite, 21-assertion HTTP integration suite, fresh-DB boot with 57 migrations, zip boots clean from extraction. Honest caveat: drawer animation verified from markup + CSS media queries only (no headless browser) — a quick real-phone check is worthwhile.

> **v7 (final production pass, 2026-09-22):** all 54 migrations, 148 RPC actions, and the full marketplace loop hardened and verified end to end over real HTTP on fresh boots. Verified this pass: multi-seller checkout (one group + one fulfilment per seller, correct ownership, inventory 10→9, 5% commission, ledger reconciles, per-role visibility) — 72/72 E2E checks; failure sweep (payment failure/timeout, duplicate verification, double-click idempotency, out-of-stock, expired coupon, session expiry, cancellation, return + refund, payout guards) — all safe and understandable; `scripts/verify-v4.ts` 36/36; payout flow (adjustment → request → processing → completed) 10/10; `scripts/backup.ts` exit 0 with both artifacts; server + client typechecks clean. Seller lifecycle `pending → under_review → active` with legal transitions; pending shops draft-only. Commission accrues on payment confirmation (COD: at delivery; eSewa/Khalti: at verified payment). Remaining: merchant keys, SMTP, Render disk/env, legal review, demo-data cleanup (all NEEDS-USER below — no code blockers).

> **v6 (advertisement images + hero carousel):** the admin's promo banners are now image advertisements — new `image_url` column on `homepage_banners` via migration `0008` (note: this repo's drizzle migrator runs every `-->`-separated chunk including empty ones, so single-statement migrations must not start or end with the breakpoint marker). Admin uploads banner images from the Homepage tab (`POST /api/banner-uploads`, admin session token only, JPG/PNG/WebP/GIF 5 MB, stored as `banner-<uuid>.<ext>` under `UPLOADS_DIR`); an image is required for new ads and for editing imageless legacy ones, so every ad is shown with its image; deleting an ad removes its file. The homepage renders active ads as a swipeable image hero carousel with title overlay (mobile-first snap scroll). Verified: migration applies on fresh boot, unauthenticated upload rejected, imageless create rejected, upload/serve/homepage/delete-file all pass over HTTP, 36/36 verify suite passes, typechecks clean, client rebuilt.

> **v5 (seller photos + AI recommendations):** sellers can upload up to 10 photos per product (JPG/PNG/WebP/GIF, 5 MB each) from the studio product form — the uploader appears when editing a product, and after publishing a new product the form jumps straight into edit mode so photos can be added immediately. Uploaded photos are served from `/uploads/*` and shown on product cards (first photo as cover), the homepage, search results, and a new product-page gallery with thumbnail strip. New `product_images` table via migration `0007`. Every product page also shows a “Recommended for you” rail: with `GEMINI_API_KEY` set, Gemini ranks catalogue products (every returned id is validated against the catalogue — nothing invented; picks cached 30 min; honest rule-based fallback on any failure, and the “✨ AI picks” badge only shows for genuine AI picks). New env: `GEMINI_API_KEY`, `UPLOADS_DIR` (must be on Render's persistent disk). Verified: typechecks clean, client rebuilt, fresh-DB boot + migration, upload/serve/10-cap/delete/ownership/type-validation tested over HTTP, AI path tested with the real key (source:"ai", sensible picks), 36/36 verify suite passes.

> **v4 refresh (mobile audit fixes):** after the first v4 package, a phone-layout audit of the live site found and fixed: prices now round to whole rupees everywhere ("Rs 9,998.75" → "Rs 9,999"); cart quantity steppers and product-page tool pills enlarged to 44px touch targets; deep links like `/about` or `/product/9` now redirect to the correct app page (`/#/about`) instead of landing on the homepage; top nav tabs scroll horizontally on narrow screens so nothing overflows at 390px; product carousels use slim scrollbars. Verified: typechecks clean, client rebuilt with fresh hashes, fresh-DB boot, `/about` → 302 `/#/about`, homepage and `/actions` 200.

Audited against the code in this repo and the live site. **Status key:** `DONE` = complete in the codebase · `NEEDS-USER` = needs a decision, secret, or action from Rabindra · `GAP` = not built yet, deferred on purpose (documented).

## 1. Brand & Content

- [DONE] Company/product name is consistent everywhere — "Nepal Shop" in header, footer, manifest, page titles, legal pages.
- [DONE] Logo is final and high resolution — real icon set generated (SVG + 32/192/512 PNG, apple-touch-icon); a bespoke brand mark can replace it later without code changes.
- [DONE] Favicon + app icons added — wired in `index.html`, copied unhashed to `dist/` by `postbuild.mjs`, declared in the web manifest.
- [DONE] Professional typography and spacing — system type stack, consistent spacing scale in `theme.css`.
- [DONE] No placeholder text like "Lorem ipsum" — grep-verified across `client/src`.
- [DONE] No broken/missing images — hero art optimised and bundled; products without photos render a clean initials placeholder.
- [DONE] All headings and copy proofread — plain British English throughout; new pages reviewed.
- [DONE] Clear CTA on important pages — shop/sell CTAs on About, checkout CTAs, seller onboarding CTAs.
- [NEEDS-USER] Contact information is correct — `/contact` uses bracketed placeholders (`[Your phone number]` etc.); fill in real details before launch.
- [NEEDS-USER] Social media links work — placeholders only; add real accounts when they exist (never invent them).
- [DONE] Copyright/footer information is correct — "© 2026 Nepal Shop" plus About/Contact/Help/Privacy/Terms/Admin links.

## 2. Pages

- [DONE] Home — database-driven sections (trending, new arrivals, best sellers, deals, recommendations).
- [DONE] About — `/about`: what the marketplace is, differentiators, how it works, CTAs.
- [DONE] Services / Products — `/shop`, `/search`, `/product/:id` catalogue.
- [DONE] Pricing, if applicable — not applicable to a marketplace; every product shows transparent price + delivery + discounts = final total.
- [DONE] Contact — `/contact`: details block (placeholders) + support-ticket form wired to `createTicket`.
- [DONE] FAQ — `/help` FAQ section (10 real questions) + ticket system.
- [DONE] Privacy Policy — `/privacy`: complete Nepal-marketplace draft; opens with "Draft — get local legal review before serving real customers."
- [DONE] Terms & Conditions — `/terms`: complete draft (accounts, orders, COD, returns, liability, Nepal governing law); same legal-review banner.
- [DONE] 404 page — custom "This shelf is empty." page; unknown routes land here, `/` still loads the homepage.
- [DONE] Cookie/consent mechanism if required — banner with Accept/Decline persisted in `localStorage`; choice never asked twice; linked to `/privacy`.

## 3. Responsive Design

- [NEEDS-USER] Test on iPhone — code reviewed statically; live check on a real device pending.
- [NEEDS-USER] Test on Android phone — code reviewed statically; live check on a real device pending.
- [NEEDS-USER] Test on tablet — code reviewed statically; live check on a real device pending.
- [DONE] Test on laptop — responsive breakpoints at 700px/1020px verified in CSS.
- [DONE] Test on large desktop — max-width containers (1120–1180px) centred; verified in CSS.
- [DONE] Portrait + landscape — fluid grids and rails adapt; no fixed-pixel layouts on key pages.
- [DONE] Navigation — sticky desktop header; bottom mobile nav with safe-area insets.
- [DONE] Hero section — stacks on mobile, two-column on desktop; image optimised.
- [DONE] Buttons — full-width touch targets on mobile; visible focus states everywhere (`a11y.css`).
- [DONE] Forms — stacked labels on mobile, two-column pairs on desktop.
- [DONE] Cards — product/wishlist/order cards reflow across breakpoints.
- [DONE] Tables — compare table scrolls horizontally on small screens; admin lists stack.
- [DONE] Images — `loading="lazy"` + `decoding="async"` on non-critical images; hero eager as LCP.
- [DONE] Modals — bottom sheets on mobile, centred dialogs on desktop; `role="dialog"`, labelled close buttons.
- [DONE] Footer — wraps and stacks on small screens.
- [DONE] Mobile menu — hamburger opens a slide-in sidebar drawer below 768px (public nav, account, seller studio, admin panel); desktop/tablet layouts unchanged.
- [DONE] Public nav hides seller-only links — "Seller studio" only renders for signed-in sellers, in nav and drawer.
- [DONE] Account/studio/admin dashboards — persistent sidebar on desktop, drawer on mobile; all tab functionality preserved.
- [DONE] Buyer profile photo — upload from the account page (buyer-authenticated, 5 MB, image types only); avatar shown in account header, sidebar and navbar chip.

## 4. Functionality

- [DONE] Navigation links — every `go()` target resolves to an explicit route (audited).
- [DONE] Buttons — all wired; no dead buttons.
- [DONE] Forms — zod-validated server-side; inline errors; no raw technical errors shown.
- [DONE] Contact form — creates a real support ticket; ticket code shown; admin can reply/close.
- [DONE] Login/signup — buyer, seller (email+password and legacy code+key), admin; 24-hour sessions; email verification for buyers and sellers; password reset via emailed token (needs SMTP to deliver).
- [GAP] Password reset — built end to end; only the delivery needs SMTP configured (see NEEDS-USER under Security).
- [DONE] Search — autocomplete, filters, 7 sort orders, typo tolerance, search analytics.
- [DONE] Filters — price/category/brand/rating/availability/discount/seller.
- [DONE] Dropdowns — delivery method, order status, admin filters all functional.
- [DONE] Modals — product sheet, checkout sheet, dialogs; Escape-friendly close buttons.
- [NEEDS-USER] WhatsApp/contact buttons — contact is via the ticket form for now; add a WhatsApp number when you have one.
- [NEEDS-USER] Email links — placeholder email on `/contact`; replace with the real support address.
- [DONE] External links — no dead external links; canonical + OG URLs point at the live site.
- [DONE] Authentication — bcrypt passwords, token sessions, role-separated (buyer/seller/admin).
- [DONE] Database operations — all writes through drizzle + zod-validated actions (148 actions); transactions where money/stock moves.
- [DONE] File uploads — seller product photos (up to 10/product, real file picker — URL paste removed), store logo/banner, buyer profile photo, admin banner ads and site logo: validated type/size, stored under `UPLOADS_DIR`, served from `/uploads/`; ownership checks on every upload/delete.
- [DONE] Admin Email/SMTP settings — admin panel Email tab saves host/port/username/password/from (password masked, test-email button, env vars take precedence when set); verification emails send when configured.
- [DONE] Error states — `PageError` with retry on every data screen; friendly 400/422/429 messages.
- [DONE] Loading states — skeletons/spinners on every async view.
- [DONE] Empty states — cart, wishlist, orders, search, notifications, tickets all have guided empty states.

## 5. Security

- [DONE] HTTPS enabled — served by Render; the app does not terminate TLS itself.
- [DONE] No API secrets in frontend code — client bundle grep-verified clean.
- [DONE] No private keys committed to GitHub — `.gitignore` covers `.env`, databases, build output.
- [DONE] .env excluded from Git — `.gitignore` created at repo root.
- [NEEDS-USER] Production environment variables configured — set `DB_PATH`, `PUBLIC_BASE_URL`, `ADMIN_EMAIL`/`ADMIN_PASSWORD` (first boot), payment keys when available.
- [DONE] Authentication properly protected — sessions expire, logout invalidates, wrong passwords rejected.
- [DONE] Authorization/RLS rules tested — server-side role checks on every privileged action (SQLite app, so no Supabase RLS; documented as N/A).
- [DONE] User input validated — zod schemas on all 148 actions; lengths/patterns enforced.
- [DONE] Server-side validation where required — coupons, stock, prices, order transitions all re-checked in transactions.
- [DONE] Rate limiting where appropriate — per-IP sliding window (20/10 min) on signup, login, sellerLogin, adminLogin, registerSeller; 429 with a friendly message.
- [DONE] CORS configured correctly — same-origin API; no cross-origin surface to configure.
- [DONE] Database permissions reviewed — single app-owned SQLite file on a persistent disk; never directly exposed.
- [DONE] Error messages don't expose sensitive information — curated user-facing messages; zod errors sanitised (one theoretical path noted: raw non-zod errors would pass through, but no handler throws them today).

## 6. Performance

- [DONE] Images compressed — hero PNG optimised (3.4 MB → ~2 MB, 1400px); product images lazy-loaded.
- [GAP] WebP/AVIF used where appropriate — hero still PNG; convert to WebP in a future asset pass.
- [DONE] Lazy loading implemented — `loading="lazy"` on product/rail/banner images; hero eager as LCP.
- [DONE] Fonts optimized — system font stack; zero webfont downloads.
- [DONE] Unused dependencies removed — `recharts` removed (`bun remove`); bundle shrinks on rebuild.
- [DONE] JavaScript bundle checked — ~639 KiB pre-cleanup; recharts removal + rebuild will reduce it further.
- [DONE] CSS optimized — ~37 KiB single stylesheet.
- [DONE] No unnecessary API requests — react-query caching; only intentional poll is the 30s unread-badge check for signed-in buyers.
- [DONE] Caching configured — hashed JS/CSS fingerprinted for long-term caching; icons served with stable names.
- [NEEDS-USER] CDN enabled where useful — Render's CDN serves the bundle; add a dedicated CDN only if traffic demands it.
- [NEEDS-USER] Lighthouse performance checked — not run yet; run against the live URL on mobile + desktop.
- [NEEDS-USER] Core Web Vitals checked — measure on real devices after launch (LCP/INP/CLS).

## 7. SEO

- [DONE] Unique <title> for every important page — route-based titles added in v4 (product pages use the product name).
- [DONE] Meta description — in `index.html`.
- [DONE] Proper H1/H2/H3 hierarchy — one H1 per page; sections use H2.
- [GAP] Descriptive URLs — hash routing (`/#/product/12`); human-readable slugs deferred.
- [DONE] Canonical URLs where needed — canonical tag points at the live Render URL (update if a custom domain is added).
- [DONE] robots.txt — served by `selfhost.ts`, references the sitemap.
- [DONE] sitemap.xml — served by `selfhost.ts`; lists active products of active sellers only.
- [DONE] Open Graph metadata — title/description/type/locale in `index.html`.
- [DONE] Twitter/X metadata if relevant — summary card tags added in v4.
- [DONE] Image alt text — meaningful alts after the v4 pass (hero, product images).
- [DONE] Structured data/schema where appropriate — JSON-LD `Product` schema (price, availability, ratings) on product pages.
- [NEEDS-USER] Google Search Console configured — submit the sitemap after launch.
- [NEEDS-USER] Search indexing checked — verify pages get indexed once live.

## 8. Accessibility

- [DONE] Keyboard navigation works — real buttons/links; skip-to-content link added in v4.
- [DONE] Visible focus states — global `:focus-visible` outline in `a11y.css`.
- [DONE] Sufficient color contrast — palette spot-checked in both light and dark modes.
- [DONE] Images have meaningful alt text — v4 audit fixed empty/decorative alts.
- [DONE] Buttons have accessible names — icon-only buttons carry `aria-label`.
- [DONE] Forms have labels — v4 audit: every input/select/textarea has a `<label>` or `aria-label`.
- [DONE] Error messages are understandable — plain-language form errors with `role` alert semantics.
- [NEEDS-USER] Screen-reader basics tested — not tested with a real screen reader yet; recommend a pass.
- [DONE] No important information conveyed by color alone — statuses show text labels, not just colour.
- [DONE] Text can be zoomed without breaking the layout — relative units; no fixed-pixel text containers.

## 9. Analytics & Monitoring

- [NEEDS-USER] Analytics installed — none installed; the cookie banner is ready to gate non-essential tracking (consider Plausible).
- [NEEDS-USER] Conversion events configured — define with the analytics provider (signup, checkout started, order placed).
- [NEEDS-USER] Error monitoring configured — wire Sentry or similar for client + server errors.
- [NEEDS-USER] Uptime monitoring — set up UptimeRobot/Better Uptime on the Render URL.
- [DONE] Important API failures logged — structured single-line JSON to stderr (`scope`, `msg`, secret redaction); payment failures, failed payouts, sweeper failures, repeated 5xx (5+/10 min, throttled) and boot failures also alert `ADMIN_EMAIL`.
- [DONE] Health endpoint — `GET /api/health` (no auth, real DB probe, version + uptime; 503 when the DB is unreachable); registered as the Render health-check path.
- [DONE] Backup strategy established — `scripts/backup.ts` snapshots the live DB with `VACUUM INTO` (online-safe) and tars `UPLOADS_DIR` with 7-day retention; tested 2026-09-22 (exit 0, both artifacts). [NEEDS-USER] Put it on a schedule (Render cron) and practise one restore.

## 10. Domain & Deployment

- [NEEDS-USER] Production domain connected — live on `nepal-shop-2.onrender.com`; point a custom domain at Render when ready.
- [DONE] HTTPS certificate active — automatic on Render.
- [NEEDS-USER] www/non-www behavior decided — decide when the custom domain is added.
- [NEEDS-USER] DNS configured correctly — configure when the custom domain is added.
- [NEEDS-USER] Production environment variables configured — `PORT`, `DB_PATH=/var/shop-data/app.db`, `PUBLIC_BASE_URL`, `ADMIN_EMAIL`/`ADMIN_PASSWORD`, payment keys.
- [DONE] Build succeeds in production mode — `bun install` + canonical client build verified for v4.
- [DONE] Deployment pipeline tested — Render deploys verified across v1→v4.
- [GAP] Preview/staging environment tested — deploys go straight to production; no staging environment.
- [NEEDS-USER] Rollback procedure known — Render: redeploy the previous commit; practise once before launch.

## 11. Legal & Privacy

- [DONE] Privacy Policy — `/privacy` draft live.
- [DONE] Terms of Service — `/terms` draft live.
- [DONE] Cookie policy/consent where applicable — banner + cookie section in the privacy draft.
- [DONE] Data collection explained — accounts, orders, support, cookies covered in the draft.
- [NEEDS-USER] Account deletion process if applicable — currently handled via support ticket; add a self-serve flow later if volume demands it.
- [NEEDS-USER] Contact/support information — placeholders on `/contact` and in the legal drafts; fill in before launch.
- [DONE] Third-party services disclosed where required — eSewa/Khalti/COD disclosed in the drafts.
- [DONE] Appropriate age/usage notices where relevant — eligibility covered in the terms draft.
- [NEEDS-USER] Legal review — get both drafts reviewed by a lawyer in Nepal before serving real customers (banner on each page says so).

## 12. Final QA

- [DONE] New user — signup → cart → checkout journey tested end to end.
- [DONE] Existing user — login, session restore, order history tested.
- [DONE] Wrong password — rejected with a friendly message; rate-limited after 20 attempts/10 min.
- [DONE] Empty form — required-field validation on every form.
- [DONE] Invalid input — zod rejects bad phone numbers, emails, quantities, coupons server-side.
- [NEEDS-USER] Slow network — manual test on a throttled connection recommended.
- [DONE] Offline/failed API — error states with retry on every data screen.
- [NEEDS-USER] Database failure — boot handles a missing DB (seeds + migrates); test a corrupt-disk scenario manually.
- [DONE] Refresh during authentication — session persists via `localStorage`; refresh keeps you signed in.
- [DONE] Direct URL access — hash routes resolve on load; unknown paths show the 404 page.
- [DONE] Back/forward browser navigation — hash routing supports it natively.
- [NEEDS-USER] Multiple browsers — manual pass recommended (Chrome/Safari/Firefox, mobile + desktop).

## 13. Production Code Cleanup

- [DONE] Remove console.log — none in `client/src`; server keeps only intentional unconfigured-provider diagnostics.
- [DONE] Remove debug UI — none present.
- [NEEDS-USER] Remove test accounts/data — demo admin, demo sellers and demo coupons are documented demo data; remove or replace before real customers.
- [DONE] Remove placeholder API URLs — none; base URL comes from `PUBLIC_BASE_URL` env.
- [DONE] Remove unused imports — `noUnusedLocals`/`noUnusedParameters` enforced by `tsc` on both projects.
- [DONE] Remove unused packages — `recharts` removed in v4.
- [DONE] Fix build warnings — client build verified clean for v4.
- [DONE] Fix TypeScript/Dart analyzer errors — server + client `tsc --noEmit` clean.
- [DONE] Run tests — core journey + new pages + fresh-DB boot run for v4 (see README test report).
- [DONE] Run production build — canonical client build + postbuild sanity checks pass.
- [NEEDS-USER] Review Git history for accidentally committed secrets — `.gitignore` is in place; scan history before the first public push.
