/**
 * Today's lowest listings for a card from eBay's own Browse API (official, free: 5,000 calls a day),
 * called by this server with the founder's eBay developer keys (EBAY_CLIENT_ID = App ID,
 * EBAY_CLIENT_SECRET = Cert ID; never sent to the browser or the agents). No scraping: eBay blocks
 * HarnessRouter's web_fetch and serves Firecrawl a sponsored-only page, so those are not used.
 *
 * Two searches on the collector's own eBay marketplace (EBAY_AU for Australia, ...), both raw
 * singles (category 183454, condition Ungraded 4000) in the collector's condition (the "Card
 * Condition" aspect), Buy It Now only, cheapest first, from a floor that keeps out skins, cases and
 * fan art, with postage quoted for delivery to the collector's country:
 * - worldwide: sellers anywhere;
 * - local: itemLocationCountry = the collector's country.
 * Rows then go through the same checks as before (title is the card, the condition, no junk) and
 * are compared by delivered cost: item + postage + estimated import tax and fees from abroad.
 * Cached for an hour per card, marketplace and condition.
 */
import { CONDITIONS, type Condition } from "./ebay-sold.server";
import { pickLowest, type Listing, type ScrapedItem } from "./ebay-listings.server";
import { usdRates } from "./fx.server";
import type { Market } from "./market";

const API = "https://api.ebay.com";
const TTL = 60 * 60 * 1000;
const cache = new Map<string, { at: number; value: BrowseListings | null }>();
let token: { value: string; until: number } | null = null;

/** eBay marketplace for each market, and a postcode in its biggest city so postage is quoted. */
const MARKETPLACE: Record<string, { id: string; zip: string }> = {
  US: { id: "EBAY_US", zip: "10001" },
  GB: { id: "EBAY_GB", zip: "SW1A1AA" },
  DE: { id: "EBAY_DE", zip: "10115" },
  FR: { id: "EBAY_FR", zip: "75001" },
  IT: { id: "EBAY_IT", zip: "00118" },
  ES: { id: "EBAY_ES", zip: "28001" },
  CA: { id: "EBAY_CA", zip: "M5V2T6" },
  AU: { id: "EBAY_AU", zip: "2000" },
};

export type BrowseListings = { lowest_worldwide: Listing | null; lowest_local: Listing | null };

type Money = { value?: string; currency?: string };
export type BrowseItem = {
  title?: string;
  price?: Money;
  shippingOptions?: { shippingCost?: Money; shippingCostType?: string }[];
  itemLocation?: { country?: string };
  buyingOptions?: string[];
};

export const hasBrowseKeys = () =>
  Boolean(process.env["EBAY_CLIENT_ID"]?.trim() && process.env["EBAY_CLIENT_SECRET"]?.trim());

/** An application token (client credentials), reused until shortly before it expires. */
async function appToken(): Promise<string> {
  if (token && Date.now() < token.until) return token.value;
  const id = process.env["EBAY_CLIENT_ID"]!.trim();
  const secret = process.env["EBAY_CLIENT_SECRET"]!.trim();
  const res = await fetch(`${API}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope",
    signal: AbortSignal.timeout(15_000),
  });
  const j = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error_description?: string;
  };
  if (!res.ok || !j.access_token)
    throw new Error(`eBay token ${res.status} ${j.error_description ?? ""}`);
  token = { value: j.access_token, until: Date.now() + ((j.expires_in ?? 7200) - 300) * 1000 };
  return token.value;
}

/** The Browse API search for one card: raw, one condition, Buy It Now, cheapest first. */
export function browseQuery(
  card: { name: string; number: string },
  market: Market,
  condition: Condition,
  local: boolean,
  floor?: number,
): string {
  const filters = [
    "buyingOptions:{FIXED_PRICE}",
    "conditionIds:{4000}",
    `deliveryCountry:${market.country}`,
    ...(local ? [`itemLocationCountry:${market.country}`] : []),
    ...(floor && floor > 0
      ? [`price:[${Math.floor(floor)}..]`, `priceCurrency:${market.currency}`]
      : []),
  ];
  const q = new URLSearchParams({
    q: `${card.name} ${card.number.replace(/^0+(?=\d)/, "")}`,
    category_ids: "183454",
    filter: filters.join(","),
    aspect_filter: `categoryId:183454,Card Condition:{${CONDITIONS[condition].ebay}}`,
    sort: "price",
    limit: "50",
  });
  return `${API}/buy/browse/v1/item_summary/search?${q.toString()}`;
}

/** A Browse API item as a row for pickLowest, in the collector's currency. */
export function toRow(
  it: BrowseItem,
  market: Market,
  rates: Record<string, number>,
): ScrapedItem | null {
  const conv = (m?: Money) => {
    const v = Number(m?.value);
    if (!(v >= 0) || !m?.currency) return NaN;
    if (m.currency === market.currency) return v;
    const from = rates[m.currency];
    const to = rates[market.currency];
    return from && to ? (v / from) * to : NaN;
  };
  const price = conv(it.price);
  if (!(price > 0)) return null;
  const ship = it.shippingOptions?.[0]?.shippingCost;
  const shipping = ship ? conv(ship) : NaN;
  const cc = it.itemLocation?.country ?? "";
  const name =
    !cc || cc === market.country
      ? null
      : (new Intl.DisplayNames(["en"], { type: "region" }).of(cc) ?? cc);
  return {
    title: it.title ?? "",
    price: String(it.price?.value ?? ""),
    priceValue: Math.round(price * 100) / 100,
    currency: market.currency,
    shippingCost: Number.isNaN(shipping) ? null : Math.round(shipping * 100) / 100,
    itemLocation: name,
  };
}

async function search(url: string, market: Market): Promise<BrowseItem[]> {
  const mp = MARKETPLACE[market.country] ?? MARKETPLACE["US"]!;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${await appToken()}`,
      "X-EBAY-C-MARKETPLACE-ID": mp.id,
      "X-EBAY-C-ENDUSERCTX": `contextualLocation=country=${market.country},zip=${mp.zip}`,
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`eBay search ${res.status} ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { itemSummaries?: BrowseItem[] };
  return j.itemSummaries ?? [];
}

/** Lowest listings worldwide and in the collector's country; null without keys or on error. */
export async function browseLowest(
  card: { id: string; name: string; number: string },
  market: Market,
  condition: Condition = "nm",
  floor?: number,
): Promise<BrowseListings | null> {
  if (!hasBrowseKeys()) return null;
  const key = `${card.id}@${market.country}#${condition}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  let value: BrowseListings | null = null;
  try {
    const [world, local, rates] = await Promise.all([
      search(browseQuery(card, market, condition, false, floor), market),
      search(browseQuery(card, market, condition, true, floor), market),
      usdRates(),
    ]);
    const rows = (v: BrowseItem[]) =>
      v.map((x) => toRow(x, market, rates)).filter((x): x is ScrapedItem => x !== null);
    const opts = floor ? { floor } : {};
    value = {
      lowest_worldwide: pickLowest(
        [...rows(world), ...rows(local)],
        card.number,
        condition,
        market,
        {
          local: false,
          ...opts,
        },
      ),
      lowest_local: pickLowest(rows(local), card.number, condition, market, {
        local: true,
        ...opts,
      }),
    };
  } catch (e) {
    console.error("eBay Browse failed", e instanceof Error ? e.message : e);
  }
  cache.set(key, { at: Date.now(), value });
  return value;
}
