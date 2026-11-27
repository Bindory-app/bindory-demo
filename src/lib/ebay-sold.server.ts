/**
 * Recent eBay sold prices from the collector's own eBay site (ebay.com.au for Australia, and so on),
 * in that site's currency, from the Apify actor "eBay Sold Listings Search" (caffein.dev,
 * oTtB3VgfuE9GtxQt2). The Price Check agent runs the actor itself on HarnessRouter and passes the
 * sales to get_card_prices; when no sales are passed, the server runs it (APIFY_TOKEN, never in the
 * browser). Either way it is one search for the 5 newest RAW sales from the last 90 days, from sellers in the collector's own country: eBay's
 * trading-card singles category (183454), condition "Ungraded" (4000), and words like custom,
 * proxy and PSA excluded. The server's lookup is cached for 6 hours per card and site.
 *
 * Sales are sorted by their titles: PSA 10, PSA 9, other graders (ignored) and raw. Lots, proxies,
 * non-English printings and titles without the card number are left out, and so are sales far
 * below the rest (under 35% of the median, e.g. a custom or metal card that slipped through).
 * Result: the average of the newest 3 raw sales and of the newest 5.
 *
 * Condition: the collector picks near mint or better, lightly, moderately or heavily played. The
 * search uses eBay's own "Card Condition" filter for ungraded cards, and titles that name a
 * different condition (e.g. "LP" in a near mint search) are left out too.
 */
import { MARKETS, type Market } from "./market";

const ACTOR = "oTtB3VgfuE9GtxQt2";
const TTL = 6 * 60 * 60 * 1000;
const cache = new Map<string, { at: number; value: LocalSold | null }>();

export type SoldStat = {
  /** Average of the newest 5 sales (fewer when fewer exist); the headline value. */
  value: number | null;
  avg_last_3: number | null;
  avg_last_5: number | null;
  n: number;
  status: "ok" | "thin" | "none";
};
/** Raw card conditions, with eBay's "Card Condition" filter value for each. */
export const CONDITIONS = {
  nm: { label: "Near mint or better", ebay: "Near Mint or Better" },
  lp: { label: "Lightly played", ebay: "Lightly Played (Excellent)" },
  mp: { label: "Moderately played", ebay: "Moderately Played (Very Good)" },
  hp: { label: "Heavily played", ebay: "Heavily Played (Poor)" },
} as const;
export type Condition = keyof typeof CONDITIONS;

/** "LP", "lightly played", "heavily_played" and the like into a condition; null if unknown. */
export function toCondition(v: unknown): Condition | null {
  const t = String(v ?? "")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .trim();
  if (!t) return null;
  if (/^(nm|m|mint|near mint( or better)?|nm or better|nm\/m)$/.test(t)) return "nm";
  if (/^(lp|ex|excellent|light(ly)? played)$/.test(t) || /lightly played/.test(t)) return "lp";
  if (/^(mp|vg|very good|moderate(ly)? played)$/.test(t) || /moderately played/.test(t))
    return "mp";
  if (/^(hp|poor|dmg|damaged|heav(il)?y played)$/.test(t) || /heavily played/.test(t)) return "hp";
  return /near mint/.test(t) ? "nm" : null;
}

/** The condition a title names, if any (e.g. "LP Umbreon ex" is lightly played). */
export function titleCondition(title: string): Condition | null {
  const t = ` ${title} `;
  if (/\b(heavily\s*played|heavy\s*play|damaged|dmg|creased?)\b/i.test(t)) return "hp";
  if (/\b(moderately\s*played|MP)\b/.test(t) || /\bmoderately\s*played\b/i.test(t)) return "mp";
  if (/\b(lightly\s*played|LP)\b/.test(t) || /\blightly\s*played\b/i.test(t)) return "lp";
  if (/\b(near\s*mint|NM|mint)\b/i.test(t)) return "nm";
  return null;
}

export type LocalSold = {
  currency: string;
  condition: Condition;
  site: string;
  raw: SoldStat;
  psa9: SoldStat;
  psa10: SoldStat;
};
export type Sale = {
  title?: string;
  soldPrice?: string | number;
  soldCurrency?: string;
  endedAt?: string;
  /** Where the item was, as eBay shows it (e.g. "United States"); empty for the site's own country. */
  itemLocation?: string | null;
};

const GRADED =
  /\b(PSA|BGS|CGC|TAG|SGC|ACE|BECKETT|CGA|GMA|AGS|PCA|MNT)\b\s*(GEM\s*(MINT|MT)\s*)?(\d{1,2}(\.5)?)?/i;
const SKIP =
  /\b(lot|bundle|proxy|orica|custom|replica|mystery|fan\s*art|metal|gold\s*foil|digital|code\s*card|japanese|japan|jp|korean|chinese|s-?chinese|t-?chinese|thai|indonesian|empty|case\s*only|sleeve)\b|\bx\s?[2-9]\b|\b[2-9]\s?x\b/i;

/** Which bucket a sale's title belongs to, or null to leave it out. */
export function classifySale(title: string, number: string): "raw" | "psa9" | "psa10" | null {
  const t = ` ${title} `;
  if (SKIP.test(t)) return null;
  const num = number.replace(/^0+(?=\d)/, "");
  // The card number must appear (e.g. 125 or 125/094), so other printings are not mixed in.
  if (num && !new RegExp(`(^|[^\\d])0*${num.replace(/[^\w]/g, "")}([^\\d]|$)`, "i").test(t))
    return null;
  // A grader counts only with a grade after it, so "TAG TEAM" or "ACE SPEC" cards stay raw.
  const g = GRADED.exec(t);
  if (!g || !g[4]) return /\b(graded|slab)\b/i.test(t) ? null : "raw";
  if (g[1]!.toUpperCase() !== "PSA") return null;
  const grade = Number(g[4]);
  return grade === 10 ? "psa10" : grade === 9 ? "psa9" : null;
}

const avg = (v: number[]) =>
  v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100 : null;

/** Newest first: averages of the last 3 and the last 5 sales. */
export function stat(newestFirst: number[]): SoldStat {
  const five = newestFirst.slice(0, 5);
  if (!five.length)
    return { value: null, avg_last_3: null, avg_last_5: null, n: 0, status: "none" };
  const a5 = avg(five);
  return {
    value: a5,
    avg_last_3: avg(five.slice(0, 3)),
    avg_last_5: a5,
    n: five.length,
    status: five.length >= 3 ? "ok" : "thin",
  };
}

/** True when a sale's item location is the collector's own country (or not given). */
export function isDomestic(itemLocation: unknown, market: Market): boolean {
  const loc = String(itemLocation ?? "")
    .trim()
    .toLowerCase();
  if (!loc) return true;
  const home = market.name.replace(/^the\s+/i, "").toLowerCase();
  return loc === home || loc.endsWith(`, ${home}`);
}

export function summarise(
  sales: Sale[],
  number: string,
  market: Market,
  condition: Condition = "nm",
): LocalSold {
  const buckets: Record<"raw" | "psa9" | "psa10", number[]> = { raw: [], psa9: [], psa10: [] };
  const seen = new Set<string>();
  const newest = [...sales].sort((a, b) =>
    String(b.endedAt ?? "").localeCompare(String(a.endedAt ?? "")),
  );
  for (const s of newest) {
    const price = Number(s.soldPrice);
    if (!(price > 0) || (s.soldCurrency && s.soldCurrency !== market.currency)) continue;
    const key = `${s.title}|${price}|${s.endedAt}`;
    if (seen.has(key)) continue; // the same sale can come back from more than one search
    seen.add(key);
    // Only sales from the collector's own country: eBay leaves the location off for those.
    if (!isDomestic(s.itemLocation, market)) continue;
    const title = String(s.title ?? "");
    // A title that names another condition is not this condition's sale.
    const named = titleCondition(title);
    if (named && named !== condition) continue;
    const k = classifySale(title, number);
    if (k) buckets[k].push(price);
  }
  // Leave out sales far below the rest (customs, metal cards and other look-alikes).
  for (const k of ["raw", "psa9", "psa10"] as const) {
    const sorted = [...buckets[k]].sort((a, b) => a - b);
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0;
    if (sorted.length >= 3) buckets[k] = buckets[k].filter((v) => v >= median * 0.35);
  }
  return {
    currency: market.currency,
    condition,
    site: market.ebay,
    raw: stat(buckets.raw),
    psa9: stat(buckets.psa9),
    psa10: stat(buckets.psa10),
  };
}

/** Words eBay leaves out of the search: graded slabs, customs, proxies and look-alikes. */
export const EXCLUDE = [
  "custom",
  "proxy",
  "orica",
  "metal",
  "psa",
  "bgs",
  "cgc",
  "graded",
  "slab",
  "lot",
  "japanese",
  "mystery",
];

/** The actor's input for one card: one search for the 5 newest raw (ungraded) sales in one
 *  condition on the collector's eBay site, in eBay's trading-card singles category. */
export function actorInput(
  card: { name: string; number: string },
  market: Market,
  condition: Condition = "nm",
) {
  const base = `${card.name} ${card.number.replace(/^0+(?=\d)/, "")}`;
  return {
    keywords: [`${base} ${EXCLUDE.map((w) => `-${w}`).join(" ")}`],
    ebaySite: market.ebay,
    categoryId: "183454",
    conditionId: 4000,
    count: 5,
    // Sellers in the collector's own country only (eBay puts them first; any from elsewhere that
    // fill up the 10 are dropped by summarise). 90 days, since local sales are fewer.
    sellerCountry: market.country,
    daysToScrape: 90,
    sortOrder: "endedRecently",
    aspectFilter: { "Card Condition": CONDITIONS[condition].ebay },
  };
}

/** Sold prices for one card on the collector's eBay site; null when unavailable. */
export async function localSoldPrices(
  card: { id: string; name: string; number: string },
  market: Market = MARKETS["US"]!,
  condition: Condition = "nm",
): Promise<LocalSold | null> {
  const token = process.env["APIFY_TOKEN"]?.trim();
  if (!token) return null;
  const key = `${card.id}@${market.ebay}#${condition}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  let value: LocalSold | null = null;
  try {
    const res = await fetch(
      `https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items?timeout=90`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(actorInput(card, market, condition)),
        signal: AbortSignal.timeout(100_000),
      },
    );
    if (res.ok) {
      const items = (await res.json()) as Sale[];
      if (Array.isArray(items)) value = summarise(items, card.number, market, condition);
    } else console.error("Apify sold prices failed", res.status);
  } catch (e) {
    console.error("Apify sold prices failed", e instanceof Error ? e.message : e);
  }
  cache.set(key, { at: Date.now(), value });
  return value;
}
