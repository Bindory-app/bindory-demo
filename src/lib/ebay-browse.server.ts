/**
 * Today's lowest listings for a card from eBay's own Browse API (official, free: 5,000 calls a day),
 * called server-only with the founder's eBay developer keys (EBAY_CLIENT_ID = App ID,
 * EBAY_CLIENT_SECRET = Cert ID; never sent to the browser or the agents). Uses the official API
 * directly rather than page fetching, which eBay blocks or replaces with sponsored-only pages.
 *
 * Two searches on the collector's own eBay marketplace (EBAY_AU for Australia, ...), both raw
 * singles (category 183454, condition Ungraded 4000) in the collector's condition (the "Card
 * Condition" aspect), Buy It Now only, cheapest first, from a floor that keeps out skins, cases and
 * fan art, with postage quoted for delivery to the collector's country:
 * - worldwide: sellers anywhere;
 * - local: itemLocationCountry = the collector's country.
 * Fetched candidate rows are cached for an hour (shared across instances) so different post-applied
 * price floors reuse the same upstream results without extra eBay API calls.
 */
import { createCache, type SharedStore } from "./cache.server";
import { CONDITIONS, type Condition } from "./ebay-sold.server";
import { pickLowest, type Listing, type ScrapedItem } from "./ebay-listings.server";
import { usdRates } from "./fx.server";
import type { Market } from "./market";
import { upstreamFetchJson } from "./upstream-fetch";

const API = "https://api.ebay.com";
const BROWSE_TTL_MS = 60 * 60 * 1000;
const BROWSE_EMPTY_TTL_MS = 10 * 60 * 1000;
const TOKEN_TIMEOUT_MS = 10_000;
const SEARCH_TIMEOUT_MS = 12_000;

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

function regionLabel(code: string): string {
  try {
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
}

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

export type BrowseCandidates = {
  world: ScrapedItem[];
  local: ScrapedItem[];
  /** Whole-unit floor used in the upstream eBay price filter (0 means no floor was applied). */
  queryFloor: number;
};

export type BrowseCandidatesLookup =
  | { status: "ok"; data: BrowseCandidates; fromCache?: boolean }
  | { status: "empty"; data: BrowseCandidates; fromCache?: boolean }
  | { status: "error"; data: null; fromCache?: boolean }
  | { status: "unconfigured"; data: null; fromCache?: boolean };

type Money = { value?: string; currency?: string };
type BrowseItem = {
  title?: string;
  price?: Money;
  shippingOptions?: { shippingCost?: Money; shippingCostType?: string }[];
  itemLocation?: { country?: string };
  buyingOptions?: string[];
};

function makeBrowseCache(store?: SharedStore | null) {
  return createCache<BrowseCandidates>({
    namespace: "ebay-browse",
    ttlMs: BROWSE_TTL_MS,
    emptyTtlMs: BROWSE_EMPTY_TTL_MS,
    ...(store !== undefined ? { store } : {}),
  });
}

// OAuth bearer tokens stay memory-only (`shared: false`) so credentials are never persisted in DB,
// while still benefiting from singleflight dedupe and TTL expiry.
const tokenCache = createCache<string>({
  namespace: "ebay-token",
  ttlMs: 6_900 * 1000,
  shared: false,
  maxEntries: 4,
});
let browseCache = makeBrowseCache();

/** Resets Browse and OAuth token caches (and optionally installs a custom shared store for tests). */
export function resetBrowseCacheForTest(store?: SharedStore | null): void {
  tokenCache.clear();
  browseCache = makeBrowseCache(store);
}

const hasBrowseKeys = () =>
  Boolean(process.env["EBAY_CLIENT_ID"]?.trim() && process.env["EBAY_CLIENT_SECRET"]?.trim());

/** An application token (client credentials), deduplicated and reused until shortly before expiry. */
async function appToken(): Promise<string> {
  const res = await tokenCache.getOrLoad("oauth", async () => {
    const id = process.env["EBAY_CLIENT_ID"]!.trim();
    const secret = process.env["EBAY_CLIENT_SECRET"]!.trim();
    const r = await upstreamFetchJson<{
      access_token?: string;
      expires_in?: number;
    }>(`${API}/identity/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope",
      timeoutMs: TOKEN_TIMEOUT_MS,
      maxAttempts: 3,
      baseDelayMs: 250,
      maxDelayMs: 2_000,
    });
    const j = r.data ?? {};
    if (!r.ok || !j.access_token) {
      throw new Error(`eBay token ${r.status}`);
    }
    const ttlMs = Math.max(60, (j.expires_in ?? 7200) - 300) * 1000;
    return { kind: "hit", value: j.access_token, ttlMs };
  });
  if (!res.ok) throw new Error("eBay token unavailable");
  return res.value;
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
  const name = !cc || cc === market.country ? null : regionLabel(cc);
  return {
    title: it.title ?? "",
    price: String(it.price?.value ?? ""),
    priceValue: Math.round(price * 100) / 100,
    currency: market.currency,
    shippingCost: Number.isNaN(shipping) ? null : Math.round(shipping * 100) / 100,
    itemLocation: name,
  };
}

async function search(
  url: string,
  market: Market,
  allowTokenRefresh = true,
): Promise<BrowseItem[]> {
  const mp = MARKETPLACE[market.country] ?? MARKETPLACE["US"]!;
  const res = await upstreamFetchJson<{ itemSummaries?: BrowseItem[] }>(url, {
    headers: {
      Authorization: `Bearer ${await appToken()}`,
      "X-EBAY-C-MARKETPLACE-ID": mp.id,
      "X-EBAY-C-ENDUSERCTX": `contextualLocation=country=${market.country},zip=${mp.zip}`,
    },
    timeoutMs: SEARCH_TIMEOUT_MS,
    maxAttempts: 3,
    baseDelayMs: 250,
    maxDelayMs: 2_000,
  });
  if (res.status === 401 && allowTokenRefresh) {
    await tokenCache.delete("oauth");
    return search(url, market, false);
  }
  if (!res.ok) throw new Error(`eBay search ${res.status}`);
  return res.data?.itemSummaries ?? [];
}

/** Picks the lowest worldwide and local listings from cached Browse candidates using `floor`. */
export function pickBrowseLowest(
  candidates: BrowseCandidates,
  card: { number: string },
  market: Market,
  condition: Condition,
  floor?: number,
): BrowseListings {
  const opts = floor && floor > 0 ? { floor } : {};
  return {
    lowest_worldwide: pickLowest(
      [...candidates.world, ...candidates.local],
      card.number,
      condition,
      market,
      { local: false, ...opts },
    ),
    lowest_local: pickLowest(candidates.local, card.number, condition, market, {
      local: true,
      ...opts,
    }),
  };
}

/**
 * Fetches and caches normalized Browse candidate rows for one card/market/condition.
 * Cached rows are reused for any floor >= the queried floor so post-applied floors avoid extra
 * upstream calls; only a strictly lower floor invalidates and refetches.
 */
export async function browseCandidates(
  card: { id: string; name: string; number: string },
  market: Market,
  condition: Condition = "nm",
  queryFloor?: number,
  now = Date.now(),
): Promise<BrowseCandidatesLookup> {
  if (!hasBrowseKeys()) return { status: "unconfigured", data: null };
  const reqFloor = queryFloor && queryFloor > 0 ? Math.floor(queryFloor) : 0;
  const key = `${card.id}@${market.country}:${market.currency}#${condition}`;

  const load = () =>
    browseCache.getOrLoad(
      key,
      async () => {
        try {
          const apiFloor = reqFloor > 0 ? reqFloor : undefined;
          const [worldRaw, localRaw, rates] = await Promise.all([
            search(browseQuery(card, market, condition, false, apiFloor), market),
            search(browseQuery(card, market, condition, true, apiFloor), market),
            usdRates(now),
          ]);
          const rows = (v: BrowseItem[]) =>
            v.map((x) => toRow(x, market, rates)).filter((x): x is ScrapedItem => x !== null);
          const value: BrowseCandidates = {
            world: rows(worldRaw),
            local: rows(localRaw),
            queryFloor: reqFloor,
          };
          return value.world.length > 0 || value.local.length > 0
            ? { kind: "hit", value }
            : { kind: "empty", value };
        } catch (e) {
          console.error("eBay Browse failed", e instanceof Error ? e.message : e);
          return { kind: "error" };
        }
      },
      { now },
    );

  let res = await load();
  // If cached candidates were fetched with a higher upstream floor than requested now, refetch at
  // the lower floor so valid cheaper listings aren't missed.
  if (res.ok && res.fromCache && res.value.queryFloor > reqFloor) {
    await browseCache.delete(key);
    res = await load();
  }

  if (!res.ok) return { status: "error", data: null, fromCache: false };
  return { status: res.empty ? "empty" : "ok", data: res.value, fromCache: res.fromCache };
}

/** Lowest listings worldwide and in the collector's country; null without keys or on error. */
export async function browseLowest(
  card: { id: string; name: string; number: string },
  market: Market,
  condition: Condition = "nm",
  floor?: number,
  now = Date.now(),
): Promise<BrowseListings | null> {
  const res = await browseCandidates(card, market, condition, floor, now);
  if (!res.data) return null;
  return pickBrowseLowest(res.data, card, market, condition, floor);
}
