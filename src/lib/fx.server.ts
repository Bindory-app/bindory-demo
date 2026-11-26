/**
 * Today's exchange rates from US dollars (European Central Bank reference rates via
 * api.frankfurter.dev, free, no key), cached for 12 hours. 1 USD = rate[currency].
 */
const TTL = 12 * 60 * 60 * 1000;
let cached: { at: number; rates: Record<string, number> } | null = null;

export async function usdRates(): Promise<Record<string, number>> {
  if (cached && Date.now() - cached.at < TTL) return cached.rates;
  const res = await fetch("https://api.frankfurter.dev/v1/latest?base=USD").catch(() => null);
  const j = res?.ok
    ? ((await res.json().catch(() => null)) as { rates?: Record<string, number> } | null)
    : null;
  if (j?.rates) cached = { at: Date.now(), rates: { USD: 1, ...j.rates } };
  return cached?.rates ?? { USD: 1 };
}

/** How many units of `currency` one US dollar buys (1 when unknown). */
export async function usdTo(currency: string): Promise<number> {
  const r = await usdRates();
  return currency === "USD" ? 1 : (r[currency] ?? 1);
}
