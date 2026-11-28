/**
 * Today's exchange rates from US dollars (European Central Bank reference rates via
 * api.frankfurter.dev, free, no key), cached for 12 hours in memory and the shared cache.
 * 1 USD = rate[currency].
 *
 * When Frankfurter is unreachable, the last known rate (from memory or shared cache) is used.
 * If no rate has ever been cached, foreign currencies never silently fall back to 1; callers fall
 * back honestly to showing US$.
 */
import { createCache, type SharedStore } from "./cache.server";
import type { Market } from "./market";
import { upstreamFetchJson } from "./upstream-fetch";

const FX_URL = "https://api.frankfurter.dev/v1/latest?base=USD";
const FX_TTL_MS = 12 * 60 * 60 * 1000;
const FX_TIMEOUT_MS = 6_000;

export type FxRatesResult = {
  rates: Record<string, number>;
  /** True when the rate came from an expired cache entry after a live fetch failure. */
  stale: boolean;
  /** False when no live or cached FX rates exist (only `{ USD: 1 }` is available). */
  ok: boolean;
  /** True when served from memory or shared cache. */
  fromCache?: boolean;
};

export type ResolvedMarketFx = {
  /** Collector's market, or the same country/site with currency/symbol set to US$ on FX fallback. */
  market: Market;
  /** Units of `market.currency` per 1 USD (always 1 when `market.currency === "USD"`). */
  rate: number;
  /** True when using an expired last-known rate after a live fetch failure. */
  stale: boolean;
  /** True when no rate existed for a non-USD market and we fell back honestly to US$. */
  fallbackToUsd: boolean;
  /** True when served from memory or shared cache (always true for USD). */
  fromCache?: boolean;
};

function makeFxCache(store?: SharedStore | null) {
  return createCache<Record<string, number>>({
    namespace: "fx",
    ttlMs: FX_TTL_MS,
    allowStaleOnError: true,
    ...(store !== undefined ? { store } : {}),
  });
}

let fxCache = makeFxCache();

/** Resets the in-memory FX cache (and optionally installs a custom shared store for tests). */
export function resetFxCacheForTest(store?: SharedStore | null): void {
  fxCache = makeFxCache(store);
}

async function fetchUsdRates(): Promise<Record<string, number> | null> {
  try {
    const res = await upstreamFetchJson<{ rates?: Record<string, unknown> }>(FX_URL, {
      timeoutMs: FX_TIMEOUT_MS,
      maxAttempts: 3,
      baseDelayMs: 250,
      maxDelayMs: 2_000,
    });
    if (!res.ok) {
      console.error("FX rate lookup failed", res.status);
      return null;
    }
    const j = res.data;
    if (!j?.rates || typeof j.rates !== "object") return null;
    const clean: Record<string, number> = { USD: 1 };
    let count = 0;
    for (const [code, val] of Object.entries(j.rates)) {
      if (typeof val === "number" && Number.isFinite(val) && val > 0) {
        clean[code] = val;
        count++;
      }
    }
    return count > 0 ? clean : null;
  } catch (e) {
    console.error("FX rate lookup failed", e instanceof Error ? e.message : e);
    return null;
  }
}

export async function usdRatesWithMeta(now = Date.now()): Promise<FxRatesResult> {
  const res = await fxCache.getOrLoad(
    "usd",
    async () => {
      const rates = await fetchUsdRates();
      return rates ? { kind: "hit", value: rates } : { kind: "error" };
    },
    { now },
  );
  if (res.ok) return { rates: res.value, stale: res.stale, ok: true, fromCache: res.fromCache };
  return { rates: { USD: 1 }, stale: false, ok: false, fromCache: false };
}

export async function usdRates(now = Date.now()): Promise<Record<string, number>> {
  return (await usdRatesWithMeta(now)).rates;
}

/**
 * How many units of `currency` one US dollar buys, or `null` if the rate is unavailable.
 * Never returns `1` for a foreign currency.
 */
export async function usdTo(currency: string, now = Date.now()): Promise<number | null> {
  if (currency === "USD") return 1;
  const { rates } = await usdRatesWithMeta(now);
  const v = rates[currency];
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Resolves a collector's market against live or last-known FX rates. If no rate exists for a
 * foreign currency, falls back honestly to US$ (`currency: "USD"`, `symbol: "US$"`, `rate: 1`).
 */
export async function resolveMarketFx(market: Market, now = Date.now()): Promise<ResolvedMarketFx> {
  if (market.currency === "USD") {
    return { market, rate: 1, stale: false, fallbackToUsd: false, fromCache: true };
  }
  const { rates, stale, fromCache } = await usdRatesWithMeta(now);
  const v = rates[market.currency];
  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    return { market, rate: v, stale, fallbackToUsd: false, fromCache: Boolean(fromCache) };
  }
  return {
    market: { ...market, currency: "USD", symbol: "US$" },
    rate: 1,
    stale: false,
    fallbackToUsd: true,
    fromCache: false,
  };
}
