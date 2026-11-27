/**
 * The collector's market: country, currency and eBay site. The app sends a country code (from the
 * collector's saved place, else their phone's time zone); unknown countries fall back to the US.
 */
export type Market = {
  country: string;
  name: string;
  currency: string;
  symbol: string;
  ebay: string;
};

export const MARKETS: Record<string, Market> = {
  US: {
    country: "US",
    name: "the United States",
    currency: "USD",
    symbol: "US$",
    ebay: "ebay.com",
  },
  GB: {
    country: "GB",
    name: "the United Kingdom",
    currency: "GBP",
    symbol: "£",
    ebay: "ebay.co.uk",
  },
  DE: { country: "DE", name: "Germany", currency: "EUR", symbol: "€", ebay: "ebay.de" },
  FR: { country: "FR", name: "France", currency: "EUR", symbol: "€", ebay: "ebay.fr" },
  IT: { country: "IT", name: "Italy", currency: "EUR", symbol: "€", ebay: "ebay.it" },
  ES: { country: "ES", name: "Spain", currency: "EUR", symbol: "€", ebay: "ebay.es" },
  CA: { country: "CA", name: "Canada", currency: "CAD", symbol: "C$", ebay: "ebay.ca" },
  AU: { country: "AU", name: "Australia", currency: "AUD", symbol: "A$", ebay: "ebay.com.au" },
};

export const marketFor = (country: unknown): Market =>
  (typeof country === "string" && MARKETS[country.toUpperCase()]) || MARKETS["US"]!;

/** Estimated import fees (tax, duty and eBay's customs handling) on a card shipped from abroad, as a
 *  share of item + postage. Listing pages do not include them; checkout does. AU 12.5% is from a
 *  real ebay.com.au checkout (US$113.98 on US$879.99 + US$32.41 postage: 10% GST plus handling);
 *  the others are each country's VAT/GST on goods (no duty on trading cards), and roughly 10% for
 *  US import tariffs. None between EU countries. Estimates only, labelled as such. */
const IMPORT_RATE: Record<string, number> = {
  AU: 0.125,
  GB: 0.2,
  DE: 0.19,
  FR: 0.2,
  IT: 0.22,
  ES: 0.21,
  CA: 0.13,
  US: 0.1,
};
const EU = new Set([
  "austria",
  "belgium",
  "bulgaria",
  "croatia",
  "cyprus",
  "czech republic",
  "czechia",
  "denmark",
  "estonia",
  "finland",
  "france",
  "germany",
  "greece",
  "hungary",
  "ireland",
  "italy",
  "latvia",
  "lithuania",
  "luxembourg",
  "malta",
  "netherlands",
  "poland",
  "portugal",
  "romania",
  "slovakia",
  "slovenia",
  "spain",
  "sweden",
]);
const EU_MARKETS = new Set(["DE", "FR", "IT", "ES"]);

/** The import fee rate for an item located in `origin` (eBay's location text, e.g. "United States";
 *  empty means the collector's own country) bought from market `m`. */
export function importFeeRate(m: Market, origin: unknown): number {
  const o = String(origin ?? "")
    .trim()
    .toLowerCase();
  const home = m.name.replace(/^the\s+/i, "").toLowerCase();
  if (!o || o === home || o.endsWith(`, ${home}`)) return 0;
  if (EU_MARKETS.has(m.country) && EU.has(o.split(",").pop()!.trim())) return 0;
  return IMPORT_RATE[m.country] ?? 0.1;
}

/** Money in the collector's currency, e.g. A$1,234 or A$12.50. */
export function money(amount: number, m: Market): string {
  const v = Math.round(amount * 100) / 100;
  const cents = v < 100 && v % 1 !== 0;
  return (
    m.symbol +
    v.toLocaleString("en-US", {
      minimumFractionDigits: cents ? 2 : 0,
      maximumFractionDigits: cents ? 2 : 0,
    })
  );
}
