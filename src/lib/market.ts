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
