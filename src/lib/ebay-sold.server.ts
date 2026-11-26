/**
 * Recent eBay sold prices from the collector's own eBay site (ebay.com.au for Australia, and so on),
 * in that site's currency, via the Apify actor "eBay Sold Listings Search" (caffein.dev,
 * oTtB3VgfuE9GtxQt2), server-only. APIFY_TOKEN never reaches the browser. Each lookup reads up to
 * 40 sales from the last 30 days and is cached for 6 hours per card and site (the actor charges
 * per result).
 *
 * Sales are sorted by their titles: PSA 10, PSA 9, other graders (ignored) and raw. Lots, proxies,
 * non-English printings and titles without the card number are left out. Each value is the median
 * of the newest sales (up to 5).
 */
import { MARKETS, type Market } from "./market";

const ACTOR = "oTtB3VgfuE9GtxQt2";
const TTL = 6 * 60 * 60 * 1000;
const cache = new Map<string, { at: number; value: LocalSold | null }>();

export type SoldStat = { value: number | null; n: number; status: "ok" | "thin" | "none" };
export type LocalSold = {
  currency: string;
  site: string;
  raw: SoldStat;
  psa9: SoldStat;
  psa10: SoldStat;
};
type Sale = {
  title?: string;
  soldPrice?: string | number;
  soldCurrency?: string;
  endedAt?: string;
};

const GRADED =
  /\b(PSA|BGS|CGC|TAG|SGC|ACE|BECKETT|CGA|GMA|AGS|PCA|MNT)\b\s*(GEM\s*(MINT|MT)\s*)?(\d{1,2}(\.5)?)?/i;
const SKIP =
  /\b(lot|bundle|proxy|orica|custom|replica|fan\s*art|metal|gold\s*foil|digital|code\s*card|japanese|japan|jp|korean|chinese|s-?chinese|t-?chinese|thai|indonesian|empty|case\s*only|sleeve)\b|\bx\s?[2-9]\b|\b[2-9]\s?x\b/i;

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

function stat(values: number[]): SoldStat {
  const v = values.slice(0, 5).sort((a, b) => a - b);
  if (!v.length) return { value: null, n: 0, status: "none" };
  const mid = v.length % 2 ? v[(v.length - 1) / 2]! : (v[v.length / 2 - 1]! + v[v.length / 2]!) / 2;
  return { value: Math.round(mid * 100) / 100, n: v.length, status: v.length >= 3 ? "ok" : "thin" };
}

export function summarise(sales: Sale[], number: string, market: Market): LocalSold {
  const buckets: Record<"raw" | "psa9" | "psa10", number[]> = { raw: [], psa9: [], psa10: [] };
  const newest = [...sales].sort((a, b) =>
    String(b.endedAt ?? "").localeCompare(String(a.endedAt ?? "")),
  );
  for (const s of newest) {
    const price = Number(s.soldPrice);
    if (!(price > 0) || (s.soldCurrency && s.soldCurrency !== market.currency)) continue;
    const k = classifySale(String(s.title ?? ""), number);
    if (k) buckets[k].push(price);
  }
  return {
    currency: market.currency,
    site: market.ebay,
    raw: stat(buckets.raw),
    psa9: stat(buckets.psa9),
    psa10: stat(buckets.psa10),
  };
}

/** Sold prices for one card on the collector's eBay site; null when unavailable. */
export async function localSoldPrices(
  card: { id: string; name: string; number: string },
  market: Market = MARKETS["US"]!,
): Promise<LocalSold | null> {
  const token = process.env["APIFY_TOKEN"]?.trim();
  if (!token) return null;
  const key = `${card.id}@${market.ebay}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  let value: LocalSold | null = null;
  try {
    const res = await fetch(
      `https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items?timeout=90`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          keywords: [`${card.name} ${card.number.replace(/^0+(?=\d)/, "")}`],
          ebaySite: market.ebay,
          daysToScrape: 30,
          count: 40,
          sortOrder: "endedRecently",
        }),
        signal: AbortSignal.timeout(100_000),
      },
    );
    if (res.ok) {
      const items = (await res.json()) as Sale[];
      if (Array.isArray(items)) value = summarise(items, card.number, market);
    } else console.error("Apify sold prices failed", res.status);
  } catch (e) {
    console.error("Apify sold prices failed", e instanceof Error ? e.message : e);
  }
  cache.set(key, { at: Date.now(), value });
  return value;
}
