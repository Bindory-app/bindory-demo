import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browseLowest, resetBrowseCacheForTest } from "@/lib/ebay-browse.server";
import {
  SOLD_FETCH_COUNT,
  SOLD_KEEP_COUNT,
  actorInput,
  resetLocalSoldCacheForTest,
  summarise,
} from "@/lib/ebay-sold.server";
import { resetFxCacheForTest } from "@/lib/fx.server";
import { MARKETS } from "@/lib/market";
import { marketPrices } from "@/lib/mori-prices.server";
import { resetSilphcoCacheForTest } from "@/lib/silphco.server";
import { getCard, getSet, priceScale } from "@/lib/tcgdex";

beforeEach(() => {
  resetFxCacheForTest(null);
  resetLocalSoldCacheForTest(null);
  resetBrowseCacheForTest(null);
  resetSilphcoCacheForTest(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env["APIFY_TOKEN"];
  delete process.env["SILPHCO_API_KEY"];
  delete process.env["EBAY_CLIENT_ID"];
  delete process.env["EBAY_CLIENT_SECRET"];
});

describe("Over-fetch then filter and keep three", () => {
  it("requests SOLD_FETCH_COUNT rows, filters junk/overseas/wrong-condition/outliers, and keeps the 3 newest", () => {
    const input = actorInput({ name: "Umbreon ex", number: "161" }, MARKETS["AU"]!);
    expect(SOLD_FETCH_COUNT).toBe(10);
    expect(SOLD_KEEP_COUNT).toBe(3);
    expect(input.count).toBe(SOLD_FETCH_COUNT);

    const au = MARKETS["AU"]!;
    const sales = [
      // Rejected: overseas seller
      {
        title: "Umbreon ex 161/131",
        soldPrice: "2000",
        soldCurrency: "AUD",
        endedAt: "2026-11-27",
        itemLocation: "United States",
      },
      // Rejected: wrong condition named in title
      {
        title: "LP Umbreon ex 161/131",
        soldPrice: "1200",
        soldCurrency: "AUD",
        endedAt: "2026-11-26",
      },
      // Rejected: outlier (< 35% of median)
      {
        title: "Umbreon ex 161/131 holo",
        soldPrice: "12",
        soldCurrency: "AUD",
        endedAt: "2026-11-26",
      },
      // Rejected: wrong card number
      {
        title: "Umbreon ex 060/131",
        soldPrice: "1500",
        soldCurrency: "AUD",
        endedAt: "2026-11-25",
      },
      // Valid #1 (newest, comma-formatted)
      {
        title: "Umbreon ex 161/131 SIR",
        soldPrice: "1,500",
        soldCurrency: "AUD",
        endedAt: "2026-11-25",
      },
      // Valid #2
      {
        title: "Umbreon ex 161/131 NM",
        soldPrice: "1600",
        soldCurrency: "AUD",
        endedAt: "2026-11-24",
      },
      // Valid #3
      {
        title: "Umbreon ex 161/131 Prismatic Evolutions",
        soldPrice: "1400",
        soldCurrency: "AUD",
        endedAt: "2026-11-23",
      },
      // Valid #4 (older — must be dropped when keeping only the 3 newest)
      {
        title: "Umbreon ex 161/131 Prismatic",
        soldPrice: "900",
        soldCurrency: "AUD",
        endedAt: "2026-11-20",
      },
      // Valid #5 (older — must be dropped too)
      {
        title: "Umbreon ex 161/131 Raw",
        soldPrice: "800",
        soldCurrency: "AUD",
        endedAt: "2026-11-18",
      },
    ];

    const summary = summarise(sales, "161", au, "nm");
    expect(summary.raw).toEqual({
      value: 1500,
      avg_last_3: 1500,
      avg_last_5: 1500,
      n: 3,
      status: "ok",
    });
  });
});

describe("Parallel marketPrices execution, post-applied floor, and empty-local fallback", () => {
  it("starts eBay Browse in parallel with Apify sold listings and applies the sold-based floor afterwards", async () => {
    process.env["APIFY_TOKEN"] = "apify_test";
    process.env["EBAY_CLIENT_ID"] = "ebay_id";
    process.env["EBAY_CLIENT_SECRET"] = "ebay_secret";

    let resolveApify!: (res: Response) => void;
    let apifyStarted = false;
    let browseStartedWhileApifyPending = false;
    let apifyResolved = false;
    const browseSearchUrls: string[] = [];
    let notifyBrowseDone!: () => void;
    const browseReady = new Promise<void>((r) => {
      notifyBrowseDone = r;
    });

    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("frankfurter.dev")) {
          return Promise.resolve(
            new Response(JSON.stringify({ rates: { AUD: 1.5 } }), { status: 200 }),
          );
        }
        if (url.includes("apify.com")) {
          apifyStarted = true;
          return new Promise<Response>((resolve) => {
            resolveApify = (r) => {
              apifyResolved = true;
              resolve(r);
            };
          });
        }
        if (url.includes("/identity/v1/oauth2/token")) {
          return Promise.resolve(
            new Response(JSON.stringify({ access_token: "tok", expires_in: 7200 }), {
              status: 200,
            }),
          );
        }
        if (url.includes("/buy/browse/v1/item_summary/search")) {
          browseSearchUrls.push(url);
          if (apifyStarted && !apifyResolved) browseStartedWhileApifyPending = true;
          if (browseSearchUrls.length === 2) notifyBrowseDone();
          // Market price = US$100 * 1.5 = A$150 -> marketFloor = A$60.
          // Sold avg will be A$200 -> soldFloor = A$100.
          // Listing at A$80 passes marketFloor (60) but MUST be dropped by post-applied soldFloor (100)!
          return Promise.resolve(
            new Response(
              JSON.stringify({
                itemSummaries: [
                  {
                    title: "Charizard ex 125/094",
                    price: { value: "80.00", currency: "AUD" },
                    shippingOptions: [{ shippingCost: { value: "5.00", currency: "AUD" } }],
                    itemLocation: { country: "AU" },
                  },
                  {
                    title: "Charizard ex 125/094 NM",
                    price: { value: "120.00", currency: "AUD" },
                    shippingOptions: [{ shippingCost: { value: "5.00", currency: "AUD" } }],
                    itemLocation: { country: "AU" },
                  },
                ],
              }),
              { status: 200 },
            ),
          );
        }
        return Promise.reject(new Error(`Unexpected URL: ${url}`));
      }),
    );

    const pending = marketPrices(
      { id: "me02-125", name: "Charizard ex", number: "125" },
      { tcgplayer: { holofoil: { lowPrice: 90, marketPrice: 100, midPrice: 110 } } },
      MARKETS["AU"]!,
    );

    // Wait until both Browse searches have started while Apify is still blocked.
    await browseReady;
    expect(apifyStarted).toBe(true);
    expect(browseStartedWhileApifyPending).toBe(true);
    expect(browseSearchUrls).toHaveLength(2); // world + local
    // Both upstream Browse queries used the market-price floor (40% of A$150 = 60).
    for (const u of browseSearchUrls) {
      expect(new URL(u).searchParams.get("filter")).toContain("price:[60..]");
    }

    // Now resolve Apify with A$200 average -> sold floor is A$100.
    resolveApify(
      new Response(
        JSON.stringify([
          {
            title: "Charizard ex 125/094",
            soldPrice: "200",
            soldCurrency: "AUD",
            endedAt: "2026-11-26",
          },
          {
            title: "Charizard ex 125/094",
            soldPrice: "200",
            soldCurrency: "AUD",
            endedAt: "2026-11-25",
          },
          {
            title: "Charizard ex 125/094",
            soldPrice: "200",
            soldCurrency: "AUD",
            endedAt: "2026-11-24",
          },
        ]),
        { status: 200 },
      ),
    );

    const out = await pending;
    // No extra Browse calls were made; post-applied sold floor (100) rejected A$80 and kept A$120.
    expect(browseSearchUrls).toHaveLength(2);
    expect(out.listings.lowest_local).toMatchObject({ price: 120, shipping: 5, total: 125 });
    expect(out.listings.lowest_worldwide).toMatchObject({ price: 120, shipping: 5, total: 125 });
  });

  it("reuses cached Browse candidates for higher floors and refetches only for a strictly lower floor", async () => {
    process.env["EBAY_CLIENT_ID"] = "ebay_id";
    process.env["EBAY_CLIENT_SECRET"] = "ebay_secret";

    let tokenCalls = 0;
    let searchCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/identity/v1/oauth2/token")) {
          tokenCalls++;
          return new Response(JSON.stringify({ access_token: "tok", expires_in: 7200 }), {
            status: 200,
          });
        }
        if (url.includes("frankfurter.dev")) {
          return new Response(JSON.stringify({ rates: { AUD: 1.5 } }), { status: 200 });
        }
        if (url.includes("/buy/browse/v1/item_summary/search")) {
          searchCalls++;
          return new Response(
            JSON.stringify({
              itemSummaries: [
                {
                  title: "Pikachu 25/25",
                  price: { value: "50.00", currency: "USD" },
                  itemLocation: { country: "US" },
                },
                {
                  title: "Pikachu 25/25 NM",
                  price: { value: "90.00", currency: "USD" },
                  itemLocation: { country: "US" },
                },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response("not found", { status: 404 });
      }),
    );

    const card = { id: "2021swsh-25", name: "Pikachu", number: "25" };
    // First call with floor 40: fetches once (2 searches: world + local) and only 1 OAuth token.
    const r1 = await browseLowest(card, MARKETS["US"]!, "nm", 40);
    expect(r1?.lowest_local?.price).toBe(50);
    expect(tokenCalls).toBe(1);
    expect(searchCalls).toBe(2);

    // Higher floor 60: reuses cached candidates (0 new upstream calls) and filters out $50!
    const r2 = await browseLowest(card, MARKETS["US"]!, "nm", 60);
    expect(r2?.lowest_local?.price).toBe(90);
    expect(searchCalls).toBe(2);

    // Strictly lower floor 20: refetches so cheaper listings below 40 aren't missed.
    const r3 = await browseLowest(card, MARKETS["US"]!, "nm", 20);
    expect(r3?.lowest_local?.price).toBe(50);
    expect(searchCalls).toBe(4);
  });

  it("refreshes the eBay OAuth token once on a 401 response", async () => {
    process.env["EBAY_CLIENT_ID"] = "ebay_id";
    process.env["EBAY_CLIENT_SECRET"] = "ebay_secret";

    let tokenCount = 0;
    let searchCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/identity/v1/oauth2/token")) {
          tokenCount++;
          return new Response(
            JSON.stringify({ access_token: `tok-${tokenCount}`, expires_in: 7200 }),
            { status: 200 },
          );
        }
        if (url.includes("frankfurter.dev")) {
          return new Response(JSON.stringify({ rates: { AUD: 1.5 } }), { status: 200 });
        }
        if (url.includes("/buy/browse/v1/item_summary/search")) {
          searchCalls++;
          const auth = new Headers(init?.headers).get("Authorization");
          if (auth === "Bearer tok-1") return new Response("expired", { status: 401 });
          return new Response(
            JSON.stringify({
              itemSummaries: [
                {
                  title: "Pikachu 25/25",
                  price: { value: "75.00", currency: "USD" },
                  itemLocation: { country: "US" },
                },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response("not found", { status: 404 });
      }),
    );

    const res = await browseLowest(
      { id: "2021swsh-25", name: "Pikachu", number: "25" },
      MARKETS["US"]!,
      "nm",
    );
    expect(res?.lowest_local?.price).toBe(75);
    expect(tokenCount).toBe(2);
    expect(searchCalls).toBeGreaterThanOrEqual(3);
  });

  it("falls back to SilphCo pooled sold prices when local sold succeeds with zero matching sales (NM only)", async () => {
    process.env["APIFY_TOKEN"] = "apify_test";
    process.env["SILPHCO_API_KEY"] = "silph_test";

    let silphcoCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("frankfurter.dev")) {
          return new Response(JSON.stringify({ rates: { AUD: 1.5 } }), { status: 200 });
        }
        if (url.includes("apify.com")) {
          // Local lookup succeeded (HTTP 200) but returned no matching domestic sales.
          return new Response(JSON.stringify([]), { status: 200 });
        }
        if (url.includes("silphcoanalytics.xyz")) {
          silphcoCalls++;
          return new Response(
            JSON.stringify({
              contract: "price.v2",
              data: {
                results: [
                  { value_usd: 200, status: "ok", n_sales: 3 },
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

    const nm = await marketPrices(
      { id: "sv08-238", name: "Pikachu ex", number: "238" },
      { tcgplayer: { holofoil: { marketPrice: 210 } } },
      MARKETS["AU"]!,
      undefined,
      "nm",
    );
    expect(silphcoCalls).toBe(1);
    expect(nm.pooled?.raw.value_usd).toBe(200);
    expect(nm.forTool.recent_sold).toEqual({
      condition: "Near mint or better",
      raw: { value: 300, status: "ok" },
    });

    // Non-NM condition: empty local result does NOT fall back to near-mint-only SilphCo.
    const lp = await marketPrices(
      { id: "sv08-238", name: "Pikachu ex", number: "238" },
      { tcgplayer: { holofoil: { marketPrice: 210 } } },
      MARKETS["AU"]!,
      undefined,
      "lp",
    );
    expect(silphcoCalls).toBe(1);
    expect(lp.pooled).toBeNull();
    expect(lp.forTool.recent_sold).toMatchObject({
      from: "ebay.com.au",
      condition: "Lightly played",
      raw: { sales: 0, status: "none" },
    });
  });

  it("guards against blank TCGdex IDs and zero-dollar marketPrice variants", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await getCard("")).toBeNull();
    expect(await getCard("   ")).toBeNull();
    expect(await getSet("")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    const scale = priceScale({
      tcgplayer: {
        normal: { marketPrice: 0, midPrice: 10 },
        holofoil: { marketPrice: 45.5, midPrice: 50 },
      },
    });
    expect(scale).toMatchObject({ variant: "holofoil", market: 45.5, mid: 50 });
  });
});
