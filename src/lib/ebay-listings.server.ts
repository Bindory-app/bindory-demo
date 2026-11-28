/** Select the cheapest delivered listing from eBay Browse API results. */
import { classifySale, isDomestic, titleCondition, type Condition } from "./ebay-sold.server";
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
