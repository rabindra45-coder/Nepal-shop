// AI product recommendations.
//
// When GEMINI_API_KEY is set, Gemini re-ranks candidate products for the
// product page ("Recommended for you"). The model only ever chooses from
// product ids handed to it — every id is validated against the catalogue,
// so it can never invent products. When the key is missing, the API fails,
// or the response is unusable, an honest rule-based ranking is used instead
// and the response is labelled source:"rules" so the UI never claims AI
// picks it didn't make.

export interface RecCandidate {
  id: number;
  name: string;
  category: string;
  brand: string | null;
  price_paisa: number;
  rating: number | null;
  review_count: number;
}

export interface RecProduct extends RecCandidate {
  store_id: number;
}

const GEMINI_MODEL = "gemini-3.6-flash";
const GEMINI_TIMEOUT_MS = 15000;
const MAX_CANDIDATES = 40;
const MAX_PICKS = 6;

// Per-product cache so opening the same product page doesn't call the API
// on every view. Products change slowly; 30 minutes is a fair balance.
const cache = new Map<number, { expires: number; ids: number[] }>();
const CACHE_TTL_MS = 30 * 60 * 1000;

function rs(paisa: number): string {
  return "Rs " + Math.round(paisa / 100).toLocaleString("en-NP");
}

function candidateLine(c: RecCandidate, sold: number): string {
  const rating = c.rating !== null ? `${c.rating.toFixed(1)} (${c.review_count} reviews)` : "no reviews yet";
  return `${c.id} | ${c.name} | ${c.category} | ${c.brand ?? "no brand"} | ${rs(c.price_paisa)} | ${rating} | sold ${sold}`;
}

function buildCandidates(product: RecProduct, pubs: RecProduct[], soldCounts: Map<number, number>): RecCandidate[] {
  const others = pubs.filter((p) => p.id !== product.id);
  const sameCat = others.filter((p) => p.category === product.category);
  const rest = others.filter((p) => p.category !== product.category)
    .sort((a, b) => (soldCounts.get(b.id) ?? 0) - (soldCounts.get(a.id) ?? 0));
  return [...sameCat, ...rest].slice(0, MAX_CANDIDATES);
}

// Parse the model's id list. Strict JSON first; if the reply was cut off,
// salvage whatever valid ids appear in the "ids" array.
function parseIds(text: string, candidates: RecCandidate[]): number[] {
  const valid = new Set(candidates.map((c) => c.id));
  const collect = (rawIds: unknown[]): number[] => {
    const ids: number[] = [];
    for (const raw of rawIds) {
      const id = Number(raw);
      if (Number.isInteger(id) && valid.has(id) && !ids.includes(id)) ids.push(id);
      if (ids.length >= MAX_PICKS) break;
    }
    return ids;
  };
  try {
    const parsed = JSON.parse(text.trim().replace(/^```json\s*/i, "").replace(/```\s*$/, ""));
    if (Array.isArray(parsed?.ids)) return collect(parsed.ids);
  } catch { /* fall through to salvage */ }
  const m = text.match(/"ids"\s*:\s*\[([\d,\s]*)/);
  if (m) {
    const nums = (m[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    return collect(nums);
  }
  return [];
}

async function geminiPickIds(key: string, product: RecProduct, candidates: RecCandidate[], soldCounts: Map<number, number>): Promise<number[]> {
  const prompt = [
    "You are a recommendation engine for Nepal Shop, an online marketplace in Nepal.",
    `A buyer is viewing this product: "${product.name}" | Category: ${product.category} | Brand: ${product.brand ?? "none"} | Price: ${rs(product.price_paisa)}.`,
    "",
    "Candidate products (id | name | category | brand | price | rating | units sold):",
    ...candidates.map((c) => candidateLine(c, soldCounts.get(c.id) ?? 0)),
    "",
    `Pick up to ${MAX_PICKS} product ids this buyer is most likely to also want. Prefer complementary items (accessories, same use-case, same room/need) and strong same-category alternatives.`,
    'Return ONLY this JSON, no other text: {"ids":[1,2,3]}',
    "Rules: use only ids from the candidate list above. Never include the viewed product's id. Order most relevant first.",
  ].join("\n");

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), GEMINI_TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(key)}`,
      {
        method: "POST",
        signal: ctrl.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json", temperature: 0.4, maxOutputTokens: 2048 },
        }),
      },
    );
    if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
    const body = await res.json() as any;
    const text: string = body?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "";
    return parseIds(text, candidates);
  } finally {
    clearTimeout(timer);
  }
}

// Honest fallback: same-category by rating, then best sellers. Used when no
// key is configured or the AI call fails.
export function ruleRecommendIds(product: RecProduct, pubs: RecProduct[], soldCounts: Map<number, number>): number[] {
  const others = pubs.filter((p) => p.id !== product.id);
  const score = (p: RecProduct) => (p.rating ?? 0) * Math.log10(1 + p.review_count) + Math.log10(1 + (soldCounts.get(p.id) ?? 0));
  const sameCat = others.filter((p) => p.category === product.category).sort((a, b) => score(b) - score(a));
  const rest = others.filter((p) => p.category !== product.category).sort((a, b) => (soldCounts.get(b.id) ?? 0) - (soldCounts.get(a.id) ?? 0));
  return [...sameCat, ...rest].slice(0, MAX_PICKS).map((p) => p.id);
}

export async function recommendForProduct(
  product: RecProduct,
  pubs: RecProduct[],
  soldCounts: Map<number, number>,
): Promise<{ ids: number[]; source: "ai" | "rules" }> {
  const key = (process.env.GEMINI_API_KEY ?? "").trim();
  if (!key) return { ids: ruleRecommendIds(product, pubs, soldCounts), source: "rules" };
  const cached = cache.get(product.id);
  if (cached && cached.expires > Date.now()) return { ids: cached.ids, source: "ai" };
  const candidates = buildCandidates(product, pubs, soldCounts);
  if (!candidates.length) return { ids: [], source: "rules" };
  try {
    const ids = await geminiPickIds(key, product, candidates, soldCounts);
    if (!ids.length) return { ids: ruleRecommendIds(product, pubs, soldCounts), source: "rules" };
    cache.set(product.id, { expires: Date.now() + CACHE_TTL_MS, ids });
    return { ids, source: "ai" };
  } catch (e) {
    console.warn("AI recommendations unavailable, using rule-based picks:", e instanceof Error ? e.message : e);
    return { ids: ruleRecommendIds(product, pubs, soldCounts), source: "rules" };
  }
}
