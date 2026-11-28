import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SharedStore, StoredEntry } from "@/lib/cache.server";
import { resetBrowseCacheForTest } from "@/lib/ebay-browse.server";
import { resetLocalSoldCacheForTest } from "@/lib/ebay-sold.server";
import { resetFxCacheForTest, resolveMarketFx, usdRatesWithMeta, usdTo } from "@/lib/fx.server";
import { MARKETS } from "@/lib/market";
import { marketPrices } from "@/lib/mori-prices.server";
import { resetSilphcoCacheForTest } from "@/lib/silphco.server";
import { Route as FxRoute } from "@/routes/api/fx";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-27T12:00:00Z"));
  resetFxCacheForTest(null);
  resetLocalSoldCacheForTest(null);
  resetBrowseCacheForTest(null);
  resetSilphcoCacheForTest(null);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env["APIFY_TOKEN"];
  delete process.env["SILPHCO_API_KEY"];
  delete process.env["EBAY_CLIENT_ID"];
  delete process.env["EBAY_CLIENT_SECRET"];
});

function memorySharedStore(): SharedStore & { data: Map<string, StoredEntry<unknown>> } {
  const data = new Map<string, StoredEntry<unknown>>();
  return {
    data,
    async get<T>(key: string) {
      return (data.get(key) as StoredEntry<T> | undefined) ?? null;
    },
    async set<T>(key: string, entry: StoredEntry<T>) {
      data.set(key, entry);
    },
  };
}

describe("FX failure handling", () => {
  it("never returns rate 1 for a foreign currency on cold failure, and falls back honestly to US$", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("down", { status: 503 })),
    );

    const ratePromise = usdTo("AUD");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await ratePromise).toBeNull();

    const resolvedPromise = resolveMarketFx(MARKETS["AU"]!);
    await vi.advanceTimersByTimeAsync(10_000);
    const resolved = await resolvedPromise;
    expect(resolved).toEqual({
      market: { ...MARKETS["AU"]!, currency: "USD", symbol: "US$" },
      rate: 1,
      stale: false,
      fallbackToUsd: true,
    });
  });

  it("uses the last known rate from the shared cache when a live refresh fails", async () => {
    const shared = memorySharedStore();
    // Seed an expired rate written by another instance 24h ago.
    shared.data.set("fx:usd", {
      value: { USD: 1, AUD: 1.54, GBP: 0.79 },
      empty: false,
      expiresAt: Date.now() - 60_000,
    });
    resetFxCacheForTest(shared);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("outage", { status: 503 })),
    );

    const metaPromise = usdRatesWithMeta();
    await vi.advanceTimersByTimeAsync(10_000);
    const meta = await metaPromise;
    expect(meta).toEqual({
      rates: { USD: 1, AUD: 1.54, GBP: 0.79 },
      stale: true,
      ok: true,
    });

    const resolvedPromise = resolveMarketFx(MARKETS["AU"]!);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await resolvedPromise).toEqual({
      market: MARKETS["AU"]!,
      rate: 1.54,
      stale: true,
      fallbackToUsd: false,
    });
  });

  it("/api/fx returns US$ with no-store on cold failure, and stale local rate with short cache when available", async () => {
    const getHandler = (
      FxRoute.options.server as unknown as {
        handlers: { GET: (ctx: { request: Request }) => Promise<Response> };
      }
    ).handlers.GET;

    // Cold outage -> honest US$, never cached by browser/CDN.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("down", { status: 503 })),
    );
    const res1Promise = getHandler({
      request: new Request("https://bindory.test/api/fx?country=AU"),
    });
    await vi.advanceTimersByTimeAsync(10_000);
    const res1 = await res1Promise;
    expect(res1.headers.get("Cache-Control")).toBe("no-store");
    expect(await res1.json()).toMatchObject({
      country: "AU",
      currency: "USD",
      symbol: "US$",
      rate: 1,
      fx_fallback: true,
    });

    // Stale rate available in shared cache -> local currency with stale rate & 5 min cache.
    const shared = memorySharedStore();
    shared.data.set("fx:usd", {
      value: { USD: 1, AUD: 1.52 },
      empty: false,
      expiresAt: Date.now() - 10_000,
    });
    resetFxCacheForTest(shared);
    const res2Promise = getHandler({
      request: new Request("https://bindory.test/api/fx?country=AU"),
    });
    await vi.advanceTimersByTimeAsync(10_000);
    const res2 = await res2Promise;
    expect(res2.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(await res2.json()).toMatchObject({
      country: "AU",
      currency: "AUD",
      symbol: "A$",
      rate: 1.52,
      stale: true,
    });
  });

  it("marketPrices falls back honestly to US$ on cold FX failure without mixing AUD local sales into US$", async () => {
    process.env["APIFY_TOKEN"] = "apify_test";
    process.env["SILPHCO_API_KEY"] = "silph_test";

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("frankfurter.dev")) return new Response("down", { status: 503 });
        if (url.includes("apify.com")) {
          // Local AU scrape returned AUD prices; must NOT be labelled USD.
          return new Response(
            JSON.stringify([
              {
                title: "Umbreon ex 161/131",
                soldPrice: "1500",
                soldCurrency: "AUD",
                endedAt: "2026-11-26",
              },
            ]),
            { status: 200 },
          );
        }
        if (url.includes("silphcoanalytics.xyz")) {
          return new Response(
            JSON.stringify({
              contract: "price.v2",
              data: {
                results: [
                  { value_usd: 950, status: "ok", n_sales: 3 },
                  { status: "none" },
                  { status: "none" },
                ],
              },
            }),
            { status: 200 },
          );
        }
        return new Response("unexpected", { status: 500 });
      }),
    );

    const p = marketPrices(
      { id: "sv08.5-161", name: "Umbreon ex", number: "161" },
      { tcgplayer: { holofoil: { lowPrice: 900, marketPrice: 1000, midPrice: 1100 } } },
      MARKETS["AU"]!,
    );
    await vi.advanceTimersByTimeAsync(15_000);
    const out = await p;

    expect(out.rate).toBe(1);
    expect(out.forTool.currency).toBe("USD");
    expect(out.forTool.price_points).toEqual({ lowest_listing: 900, market: 1000, mid: 1100 });
    expect(out.local).toBeNull();
    // Fell back to USD SilphCo sold price instead of showing A$1500 as US$1500.
    expect(out.forTool.recent_sold).toEqual({
      condition: "Near mint or better",
      raw: { value: 950, status: "ok" },
    });
  });
});
