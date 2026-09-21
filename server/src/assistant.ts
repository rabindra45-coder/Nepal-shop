// AI shopping assistant — a real rule engine over the product catalogue.
//
// It works WITHOUT any key and never invents products: every product that
// appears in the answer or comparison comes from the database rows passed in.
// When nothing matches, it says so honestly instead of guessing.
//
// NOTE on AI_API_KEY: the env var is reserved for a future upgrade where an
// LLM re-ranks or re-phrases these rule-engine results (better typo handling,
// conversational follow-ups). The rule engine below is used regardless of
// whether the key is set, so the assistant keeps working with zero
// configuration. See the README "AI assistant" section for the upgrade path.

export interface AssistantProduct {
  id: number;
  name: string;
  category: string;
  brand: string | null;
  description: string;
  price_paisa: number;
  original_price_paisa: number | null;
  discount_pct: number;
  stock: number;
  rating: number | null;
  review_count: number;
  store_name: string;
  delivery_fee_paisa: number;
}

export interface AssistantComparison<T> {
  products: T[];
  rows: { label: string; values: string[] }[];
}

export interface AssistantResult<T> {
  answer: string;
  products: T[];
  comparison?: AssistantComparison<T>;
}

export function formatRs(paisa: number): string {
  const n = paisa / 100;
  return "Rs " + n.toLocaleString("en-IN", { maximumFractionDigits: Number.isInteger(n) ? 0 : 2 });
}

const STOPWORDS = new Set(
  "i me my we us you your the a an and or of for to in on with under over show find get please tell what which best any some there here is are do does have has want looking look need".split(" "),
);

function tokensOf(question: string): string[] {
  return question
    .toLowerCase()
    .replace(/[^a-z0-9\s,.-]/g, " ")
    .split(/[\s,]+/)
    .map((t) => t.replace(/^[.-]+|[.-]+$/g, ""))
    .filter((t) => t.length > 1 && !STOPWORDS.has(t) && !/^[\d,.-]+$/.test(t));
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr: number[] = [i];
    const ac = a[i - 1] ?? "";
    for (let j = 1; j <= b.length; j++) {
      const bc = b[j - 1] ?? "";
      curr[j] = Math.min((prev[j] ?? 0) + 1, (curr[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + (ac === bc ? 0 : 1));
    }
    prev = curr;
  }
  return prev[b.length] ?? 0;
}

function tokenMatches(hayWords: string[], token: string): boolean {
  return hayWords.some(
    (w) =>
      w.includes(token) ||
      token.includes(w) ||
      (token.length >= 4 && w.length >= 4 && levenshtein(w, token) <= 2),
  );
}

function productWords(p: AssistantProduct): string[] {
  return `${p.name} ${p.brand ?? ""} ${p.category} ${p.description}`.toLowerCase().split(/[\s,.;:!?()\/-]+/);
}

// --- price parsing: "under Rs 30,000", "Rs 20,000 to 50,000" ---
function parsePriceHints(q: string): { minPaisa?: number; maxPaisa?: number } {
  const range = q.match(/(?:rs\.?|npr|₨)?\s*([\d,]+)\s*(?:to|-|–)\s*(?:rs\.?|npr|₨)?\s*([\d,]+)/i);
  if (range) {
    const a = Number((range[1] ?? "").replace(/,/g, "")) * 100;
    const b = Number((range[2] ?? "").replace(/,/g, "")) * 100;
    if (Number.isFinite(a) && Number.isFinite(b)) return { minPaisa: Math.min(a, b), maxPaisa: Math.max(a, b) };
  }
  const max = q.match(/(?:under|below|max(?:imum)?|less than|up ?to|within|around)\s*(?:rs\.?|npr|₨)?\s*([\d,]+)/i);
  if (max) {
    const v = Number((max[1] ?? "").replace(/,/g, "")) * 100;
    if (Number.isFinite(v)) return { maxPaisa: v };
  }
  return {};
}

const CATEGORY_KEYWORDS: Array<[RegExp, string]> = [
  [/\b(phone|mobile|smartphone)\b/, "Electronics"],
  [/\b(laptop|macbook|computer)\b/, "Electronics"],
  [/\b(earbud|earphone|headphone|airpod)\b/, "Electronics"],
  [/\b(watch|smartwatch)\b/, "Electronics"],
  [/\b(speaker|soundbar)\b/, "Electronics"],
  [/\b(power ?bank|powerbank|charger)\b/, "Electronics"],
  [/\b(shawl|pashmina|scarf)\b/, "Fashion"],
  [/\b(kurtha|kurti|dress|saree|sari)\b/, "Fashion"],
  [/\b(wallet|purse|handbag)\b/, "Fashion"],
  [/\b(sneaker|shoe|shoes|footwear|sandal)\b/, "Footwear"],
  [/\b(khukuri|kukri)\b/, "Handicrafts"],
  [/\b(thangka|painting)\b/, "Handicrafts"],
  [/\b(singing bowl)\b/, "Handicrafts"],
  [/\b(notebook|diary|stationery)\b/, "Stationery"],
];

function fuzzyFindProduct<T extends AssistantProduct>(products: T[], name: string): T | null {
  const n = name.toLowerCase().trim();
  if (!n) return null;
  let best = products.find((p) => p.name.toLowerCase() === n) ?? null;
  if (!best) best = products.find((p) => p.name.toLowerCase().includes(n) || n.includes(p.name.toLowerCase())) ?? null;
  if (!best) {
    let bestScore = 3;
    for (const p of products) {
      for (const w of p.name.toLowerCase().split(/\s+/)) {
        const d = levenshtein(w, n);
        if (d < bestScore) {
          bestScore = d;
          best = p;
        }
      }
    }
  }
  return best;
}

function parseCompare<T extends AssistantProduct>(question: string, products: T[]): T[] | null {
  const m = question.match(/\bcompare\s+(.+)/i);
  if (!m) return null;
  const names = (m[1] ?? "")
    .split(/\s+vs\.?\s+|\s+and\s+|\s*,\s*/i)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 3);
  if (names.length < 2) return null;
  const matched: T[] = [];
  for (const n of names) {
    const p = fuzzyFindProduct(products, n);
    if (p && !matched.includes(p)) matched.push(p);
  }
  return matched.length >= 2 ? matched : null;
}

function comparisonRows(products: AssistantProduct[]): { label: string; values: string[] }[] {
  return [
    { label: "Price", values: products.map((p) => formatRs(p.price_paisa)) },
    {
      label: "Rating",
      values: products.map((p) =>
        p.rating != null ? `${p.rating.toFixed(1)} (${p.review_count} review${p.review_count === 1 ? "" : "s"})` : "No ratings yet",
      ),
    },
    { label: "Discount", values: products.map((p) => (p.discount_pct > 0 ? `${p.discount_pct}% off` : "—")) },
    { label: "Stock", values: products.map((p) => (p.stock > 0 ? `In stock (${p.stock})` : "Out of stock")) },
    { label: "Seller", values: products.map((p) => p.store_name) },
    {
      label: "Delivery fee",
      values: products.map((p) => (p.delivery_fee_paisa === 0 ? "Free" : formatRs(p.delivery_fee_paisa))),
    },
  ];
}

export function runAssistant<T extends AssistantProduct>(question: string, products: T[]): AssistantResult<T> {
  const q = question.trim();
  const lower = q.toLowerCase();

  // 1. "compare X vs Y" → fuzzy-match 2-3 real products, side-by-side table.
  const compared = parseCompare(q, products);
  if (compared) {
    const names = compared.map((p) => `${p.name} (${formatRs(p.price_paisa)})`).join(", ");
    return {
      answer: `Here is a quick comparison: ${names}.`,
      products: compared,
      comparison: { products: compared, rows: comparisonRows(compared) },
    };
  }

  const { minPaisa, maxPaisa } = parsePriceHints(q);
  const brands = [...new Set(products.map((p) => p.brand).filter((b): b is string => !!b))];
  const brandHit = brands.find((b) => lower.includes(b.toLowerCase())) ?? null;
  const catHit = CATEGORY_KEYWORDS.find(([re]) => re.test(lower))?.[1] ?? null;
  const gaming = /\bgaming\b/.test(lower);
  const cheapest = /\b(cheapest|lowest price|budget|affordable)\b/.test(lower);

  let pool = products;
  if (catHit) pool = pool.filter((p) => p.category === catHit);
  if (brandHit) pool = pool.filter((p) => p.brand === brandHit);
  if (gaming && !catHit) pool = pool.filter((p) => p.category === "Electronics");

  if (!catHit && !brandHit && !gaming) {
    const toks = tokensOf(q);
    if (toks.length) {
      pool = pool.filter((p) => {
        const words = productWords(p);
        return toks.every((t) => tokenMatches(words, t));
      });
    } else if (minPaisa == null && maxPaisa == null) {
      // No category, brand, or searchable words and no price hint.
      pool = [];
    }
    // Otherwise it's a price-only question ("under 50000") → whole catalogue.
  }

  if (minPaisa != null) pool = pool.filter((p) => p.price_paisa >= minPaisa);
  if (maxPaisa != null) pool = pool.filter((p) => p.price_paisa <= maxPaisa);

  const sorted = [...pool].sort((a, b) =>
    cheapest ? a.price_paisa - b.price_paisa : (b.rating ?? 0) - (a.rating ?? 0) || b.review_count - a.review_count,
  );
  const top = sorted.slice(0, 6);

  if (!top.length) {
    return {
      answer: `I could not find any products matching '${q}'. Try a different word or browse the categories.`,
      products: [],
    };
  }

  let answer: string;
  if (gaming) {
    answer = `Here are the top-rated electronics for gaming:`;
  } else if (cheapest) {
    answer = `Here are the cheapest options I found${maxPaisa != null ? ` under ${formatRs(maxPaisa)}` : ""}:`;
  } else {
    const what = catHit ? `${catHit.toLowerCase()} items` : brandHit ? `${brandHit} products` : "products";
    if (minPaisa != null && maxPaisa != null) {
      answer = `I found ${pool.length} ${what} between ${formatRs(minPaisa)} and ${formatRs(maxPaisa)}:`;
    } else if (maxPaisa != null) {
      answer = `I found ${pool.length} ${what} under ${formatRs(maxPaisa)}:`;
    } else {
      answer = `I found ${pool.length} ${what}:`;
    }
  }
  answer += "\n" + top.map((p) => `- ${p.name} — ${formatRs(p.price_paisa)}`).join("\n");
  return { answer, products: top };
}
