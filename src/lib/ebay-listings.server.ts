/**
 * Today's listings and the 7-day price change for one card, on the collector's own eBay site, from
 * the Apify actor "eBay Search Scraper" (memo23, gMpyLo1gOJVKTz8p5), which reads eBay search pages
 * we build ourselves, so eBay's own filters apply:
 *
 * - Lowest listing worldwide: Buy It Now listings from sellers anywhere (LH_PrefLoc=2), cheapest
 *   first (_sop=15, price + postage).
 * - Lowest listing in the collector's country: items located there (LH_LocatedIn=1 with eBay's
 *   country code, _salic; the actor ignores LH_PrefLoc=1 on pasted URLs).
 * - 7-day change: the median sale in the last 7 days against the median of the 7 days before, from
 *   the site's sold listings (all seller countries, for enough sales).
 *
 * Every search is raw only: the trading-card singles category, condition Ungraded, eBay's Card
 * Condition filter for the collector's condition and the same excluded words as the sold search.
 * Live listings are full of skins, cases, fan art and digital cards at a few dollars, so they start
 * at a floor (half the card's recent sold price) and titles go through the same checks as sales.
 * APIFY_TOKEN stays on the server. Cached for an hour per card, site and condition.
 */
import {
  CONDITIONS,
  EXCLUDE,
  classifySale,
  isDomestic,
  titleCondition,
  type Condition,
} from "./ebay-sold.server";
import type { Market } from "./market";

const ACTOR = "gMpyLo1gOJVKTz8p5";
const TTL = 60 * 60 * 1000;
/** eBay's own country codes (_salic) for each site's home country. */
const SALIC: Record<string, number> = {
  US: 1,
  CA: 2,
  GB: 3,
  AU: 15,
  FR: 71,
  DE: 77,
  IT: 101,
  ES: 186,
};
const cache = new Map<string, { at: number; value: MarketListings | null }>();

export type Listing = { price: number; shipping: number | null };
export type MarketListings = {
  currency: string;
  lowest_worldwide: Listing | null;
  lowest_local: Listing | null;
  /** Median sale in the last 7 days vs the 7 days before, in %; null without 2 sales in each week. */
  change_7d_pct: number | null;
  sales_7d: number;
  sales_prev_7d: number;
};
export type ScrapedItem = {
  title?: string;
  price?: string;
  priceValue?: number;
  currency?: string;
  shippingCost?: number | null;
  itemLocation?: string | null;
  soldDate?: string | null;
  searchUrl?: string;
};

/** Not the card itself: accessories, skins, cases, digital and fan-made cards. */
const JUNK =
  /\b(skin|sticker|case|playmat|sleeves?|binder|toploader|display|frame|digital|pocket|fan[\s-]*art|fan[\s-]*made|reprint|replica|proxy|custom|orica|code)\b/i;

/** One eBay search page: raw singles in one condition, newest or cheapest first. */
export function searchUrl(
  card: { name: string; number: string },
  market: Market,
  condition: Condition,
  kind: "worldwide" | "local" | "sold",
  floor?: number,
): string {
  const kw = `${card.name} ${card.number.replace(/^0+(?=\d)/, "")} ${EXCLUDE.map((w) => `-${w}`).join(" ")}`;
  // eBay double-encodes aspect names and values in search URLs.
  const aspect = `Card%2520Condition=${encodeURIComponent(encodeURIComponent(CONDITIONS[condition].ebay))}`;
  let url = `https://www.${market.ebay}/sch/183454/i.html?_nkw=${encodeURIComponent(kw).replace(/%20/g, "+")}&LH_ItemCondition=4000&${aspect}`;
  if (kind === "sold") return `${url}&LH_Sold=1&LH_Complete=1&_sop=13&_ipg=240`;
  url += "&LH_BIN=1&_sop=15";
  url +=
    kind === "local" ? `&LH_LocatedIn=1&_salic=${SALIC[market.country] ?? 1}` : "&LH_PrefLoc=2";
  if (floor && floor > 0) url += `&_udlo=${Math.floor(floor)}`;
  return url;
}

/** True when a scraped row is this card, raw, in this condition (and not a skin, case, ...). */
function isTheCard(x: ScrapedItem, number: string, condition: Condition): boolean {
  const title = String(x.title ?? "");
  if (!title || JUNK.test(title)) return false;
  // "A$6.93 to A$42.18": a listing with several options, not one price for this card.
  if (/\bto\b/i.test(String(x.price ?? ""))) return false;
  const named = titleCondition(title);
  if (named && named !== condition) return false;
  return classifySale(title, number) === "raw";
}

/** The cheapest listing that is really this card (at or above the floor). */
export function pickLowest(
  items: ScrapedItem[],
  number: string,
  condition: Condition,
  market: Market,
  opts: { local: boolean; floor?: number },
): Listing | null {
  let best: Listing | null = null;
  for (const x of items) {
    const price = Number(x.priceValue);
    if (!(price > 0) || (x.currency && x.currency !== market.currency)) continue;
    if (opts.floor && price < opts.floor) continue;
    if (opts.local && !isDomestic(x.itemLocation, market)) continue;
    if (!isTheCard(x, number, condition)) continue;
    const shipping = typeof x.shippingCost === "number" ? x.shippingCost : null;
    if (!best || price + (shipping ?? 0) < best.price + (best.shipping ?? 0))
      best = { price, shipping };
  }
  return best;
}

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** "Sold  Nov 24, 2026" (or an ISO date) into a time; NaN when unreadable. */
export function soldTime(v: unknown): number {
  const t = String(v ?? "")
    .replace(/^\s*sold\s*/i, "")
    .trim();
  return t ? Date.parse(t) : NaN;
}

/** Median sale in the last 7 days against the 7 days before. */
export function weekChange(
  items: ScrapedItem[],
  number: string,
  condition: Condition,
  market: Market,
  now = Date.now(),
): { pct: number | null; n: number; prev: number } {
  const day = 864e5;
  const rows = items
    .map((x) => ({ price: Number(x.priceValue), at: soldTime(x.soldDate), x }))
    .filter(
      (r) =>
        r.price > 0 &&
        !Number.isNaN(r.at) &&
        (!r.x.currency || r.x.currency === market.currency) &&
        isTheCard(r.x, number, condition),
    );
  // Leave out sales far below the rest (customs and look-alikes that slipped through).
  const mid = median(rows.map((r) => r.price)) ?? 0;
  const kept = rows.filter((r) => r.price >= mid * 0.35);
  // eBay shows the sale day only, so a sale "today" is up to a day old: count whole days back.
  const ageDays = (at: number) => Math.floor((now - at) / day);
  const week = kept.filter((r) => ageDays(r.at) < 7).map((r) => r.price);
  const prev = kept.filter((r) => ageDays(r.at) >= 7 && ageDays(r.at) < 14).map((r) => r.price);
  const a = median(week);
  const b = median(prev);
  const pct =
    week.length >= 2 && prev.length >= 2 && a !== null && b
      ? Math.round(((a - b) / b) * 1000) / 10
      : null;
  return { pct, n: week.length, prev: prev.length };
}

async function runActor(token: string, input: Record<string, unknown>): Promise<ScrapedItem[]> {
  const res = await fetch(
    `https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items?timeout=90`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        detailedItems: false,
        includeLegacyFields: false,
        includeSummary: false,
        ...input,
      }),
      signal: AbortSignal.timeout(100_000),
    },
  );
  if (!res.ok) throw new Error(`Apify listings ${res.status}`);
  const items = (await res.json()) as unknown;
  return Array.isArray(items) ? (items as ScrapedItem[]) : [];
}

/** Lowest listings (worldwide and local) and the 7-day change; null when unavailable. */
export async function marketListings(
  card: { id: string; name: string; number: string },
  market: Market,
  condition: Condition = "nm",
  /** A typical price for this card (recent sold average) to set the listings' floor. */
  reference?: number | null,
): Promise<MarketListings | null> {
  const token = process.env["APIFY_TOKEN"]?.trim();
  if (!token) return null;
  const key = `${card.id}@${market.ebay}#${condition}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  const floor = reference && reference > 0 ? reference * 0.5 : undefined;
  const world = searchUrl(card, market, condition, "worldwide", floor);
  const local = searchUrl(card, market, condition, "local", floor);
  let value: MarketListings | null = null;
  try {
    // Two runs at once: a few cheapest listings, and up to 14 days of sales.
    const [listed, sold] = await Promise.all([
      runActor(token, {
        startUrls: [{ url: world }, { url: local }],
        mode: "active",
        // eBay's page order is not strictly by price, so read the first 12 and take the cheapest.
        maxItems: 12,
        marketplace: market.ebay,
      }),
      runActor(token, {
        startUrls: [{ url: searchUrl(card, market, condition, "sold") }],
        mode: "sold",
        maxItems: 80,
        soldWithinDays: 14,
        marketplace: market.ebay,
      }).catch(() => [] as ScrapedItem[]),
    ]);
    // Each row says which search it came from: LH_LocatedIn is the local one.
    const from = (url: string) => {
      const isLocal = url.includes("LH_LocatedIn=1");
      return listed.filter((x) => String(x.searchUrl ?? "").includes("LH_LocatedIn=1") === isLocal);
    };
    const change = weekChange(sold, card.number, condition, market);
    value = {
      currency: market.currency,
      lowest_worldwide: pickLowest(from(world), card.number, condition, market, {
        local: false,
        ...(floor ? { floor } : {}),
      }),
      lowest_local: pickLowest(from(local), card.number, condition, market, {
        local: true,
        ...(floor ? { floor } : {}),
      }),
      change_7d_pct: change.pct,
      sales_7d: change.n,
      sales_prev_7d: change.prev,
    };
  } catch (e) {
    console.error("Apify listings failed", e instanceof Error ? e.message : e);
  }
  cache.set(key, { at: Date.now(), value });
  return value;
}
