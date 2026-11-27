/**
 * Today's lowest listings for one card on the collector's own eBay site, without Apify: the app
 * builds the two eBay search pages (tool ebay_listing_pages), the Price Check agent reads them with
 * Firecrawl on HarnessRouter (eBay blocks plain fetches and HarnessRouter's web_fetch), and passes
 * the listings it read to get_card_prices, which keeps only the real card and picks the cheapest.
 *
 * - Lowest listing worldwide: Buy It Now listings from sellers anywhere (LH_PrefLoc=2), cheapest
 *   first (_sop=15, price + postage).
 * - Lowest listing in the collector's country: "<country> only" (LH_PrefLoc=1). When there are
 *   none, eBay fills the page with international sellers ("from United States"); those are dropped.
 *
 * Both are raw only: the trading-card singles category, condition Ungraded, eBay's Card Condition
 * filter for the collector's condition and the same excluded words as the sold search. Live
 * listings are full of skins, cases, fan art and digital cards at a few dollars, so the pages start
 * at a floor and titles go through the same checks as sales. Listings are compared by delivered
 * cost: item + postage + estimated import fees for items from abroad.
 *
 * The 7-day change is not from eBay: its sold pages can only be read through Apify, which is kept
 * for the last 5 sales. It is the card's 7-day average sale price against its 30-day average, from
 * the catalogue's Cardmarket data (free, updated daily, all conditions).
 */
import {
  CONDITIONS,
  EXCLUDE,
  classifySale,
  isDomestic,
  titleCondition,
  type Condition,
} from "./ebay-sold.server";
import { importFeeRate, type Market } from "./market";

/** A listing's delivered cost: item, postage and (from abroad) estimated import fees. */
export type Listing = {
  price: number;
  shipping: number | null;
  import_fees: number;
  total: number;
  /** Where the item is, when outside the collector's country (e.g. "United States"). */
  from: string | null;
};
export type ScrapedItem = {
  title?: string;
  price?: string;
  priceValue?: number;
  currency?: string;
  shippingCost?: number | null;
  itemLocation?: string | null;
};

/** Not the card itself: accessories, skins, cases, digital and fan-made cards. */
const JUNK =
  /\b(skin|sticker|case|playmat|sleeves?|binder|toploader|display|frame|digital|pocket|fan[\s-]*art|fan[\s-]*made|reprint|replica|proxy|custom|orica|code|shop on ebay)\b/i;

/** eBay double-encodes aspect values in search URLs, brackets included: "Lightly Played
 *  (Excellent)" is Lightly%2520Played%2520%2528Excellent%2529. encodeURIComponent leaves ( ) alone,
 *  and eBay then ignores the filter and shows every condition. */
export const ebayAspect = (v: string) =>
  encodeURIComponent(encodeURIComponent(v).replace(/\(/g, "%28").replace(/\)/g, "%29"));

/** One eBay search page of live Buy It Now listings: raw singles in one condition, cheapest first. */
export function searchUrl(
  card: { name: string; number: string },
  market: Market,
  condition: Condition,
  kind: "worldwide" | "local",
  floor?: number,
): string {
  const kw = `${card.name} ${card.number.replace(/^0+(?=\d)/, "")} ${EXCLUDE.map((w) => `-${w}`).join(" ")}`;
  const aspect = `Card%2520Condition=${ebayAspect(CONDITIONS[condition].ebay)}`;
  let url = `https://www.${market.ebay}/sch/183454/i.html?_nkw=${encodeURIComponent(kw).replace(/%20/g, "+")}&LH_ItemCondition=4000&${aspect}`;
  url += `&LH_BIN=1&_sop=15&LH_PrefLoc=${kind === "local" ? 1 : 2}`;
  if (floor && floor > 0) url += `&_udlo=${Math.floor(floor)}`;
  return `${url}&rt=nc`;
}

/** "AU $1,493.89" or 1493.89 into a number; NaN when there is no single price. */
export function moneyValue(v: unknown): number {
  if (typeof v === "number") return v;
  const t = String(v ?? "");
  if (/\bto\b/i.test(t)) return NaN; // "A$6.93 to A$42.18": several options, not one price
  if (/free/i.test(t)) return 0;
  const m = /(\d[\d,]*(?:\.\d+)?)/.exec(t);
  return m ? Number(m[1]!.replace(/,/g, "")) : NaN;
}

/** A row the agent read from an eBay page ({title, price, shipping, location}) as a scraped item. */
export function fromAgentRow(x: unknown): ScrapedItem | null {
  if (!x || typeof x !== "object") return null;
  const r = x as Record<string, unknown>;
  const price = moneyValue(r["price"]);
  if (!(price > 0)) return null;
  const ship = moneyValue(r["shipping"]);
  const loc = String(r["location"] ?? "")
    .replace(/^\s*(from|located in)\s+/i, "")
    .trim();
  return {
    title: String(r["title"] ?? ""),
    price: String(r["price"] ?? ""),
    priceValue: price,
    shippingCost: Number.isNaN(ship) ? null : ship,
    itemLocation: loc || null,
  };
}

/** True when a scraped row is this card, raw, in this condition (and not a skin, case, ...). */
function isTheCard(x: ScrapedItem, number: string, condition: Condition): boolean {
  const title = String(x.title ?? "");
  if (!title || JUNK.test(title)) return false;
  if (/\bto\b/i.test(String(x.price ?? ""))) return false;
  const named = titleCondition(title);
  if (named && named !== condition) return false;
  return classifySale(title, number) === "raw";
}

/** The cheapest listing that is really this card (at or above the floor), by delivered cost:
 *  item + postage + estimated import fees for items from abroad (listing pages leave those out). */
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
    const rate = importFeeRate(market, x.itemLocation);
    const cents = (v: number) => Math.round(v * 100) / 100;
    const fees = cents((price + (shipping ?? 0)) * rate);
    const total = cents(price + (shipping ?? 0) + fees);
    if (!best || total < best.total)
      best = {
        price,
        shipping,
        import_fees: fees,
        total,
        from: rate > 0 ? String(x.itemLocation) : null,
      };
  }
  return best;
}

/** The card's 7-day average sale price against its 30-day average, in % (catalogue data). */
export function weekChange(pricing: unknown): number | null {
  const cm = (pricing as { cardmarket?: Record<string, unknown> } | null)?.cardmarket;
  const a7 = Number(cm?.["avg7"]);
  const a30 = Number(cm?.["avg30"]);
  return a7 > 0 && a30 > 0 ? Math.round(((a7 - a30) / a30) * 1000) / 10 : null;
}

/** Lowest listings from the rows the agent read, worldwide and in the collector's country. */
export function lowestListings(
  card: { number: string },
  market: Market,
  condition: Condition,
  rows: { worldwide?: unknown[]; local?: unknown[] },
  floor?: number,
) {
  const parse = (v?: unknown[]) =>
    (v ?? []).map(fromAgentRow).filter((x): x is ScrapedItem => x !== null);
  const world = parse(rows.worldwide);
  const local = parse(rows.local);
  const opts = floor ? { floor } : {};
  return {
    // Worldwide includes local sellers: whichever is cheapest delivered, fees included.
    lowest_worldwide: pickLowest([...world, ...local], card.number, condition, market, {
      local: false,
      ...opts,
    }),
    // The "<country> only" page: international sellers eBay adds when there are none are dropped.
    lowest_local: pickLowest(local.length ? local : world, card.number, condition, market, {
      local: true,
      ...opts,
    }),
  };
}
