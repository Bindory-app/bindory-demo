import { describe, expect, it } from "vitest";

describe("Local eBay sold prices", () => {
  it("sorts sales by title into raw, PSA 9 and PSA 10, leaving the rest out", async () => {
    process.env["APIFY_TOKEN"] ??= "";
    const { classifySale, summarise } = await import("@/lib/ebay-sold.server");
    const { MARKETS } = await import("@/lib/market");
    expect(
      classifySale("Mega Charizard X EX 125/094 Special Illustration Rare PSA 10 GEM MINT", "125"),
    ).toBe("psa10");
    expect(classifySale("2025 Pokemon PFL Mega Charizard X ex #125/094 PSA 9", "125")).toBe("psa9");
    expect(classifySale("Mega Charizard X ex 125/094 - Graded BGS 9", "125")).toBeNull();
    expect(classifySale("Mega Charizard X ex 125/094 TAG 10", "125")).toBeNull();
    expect(classifySale("Pikachu & Zekrom GX TAG TEAM 184/181", "184")).toBe("raw");
    expect(classifySale("Mega Charizard X ex 125/094 lot of 3", "125")).toBeNull();
    expect(classifySale("Mega Charizard X ex Japanese 125", "125")).toBeNull();
    expect(classifySale("Mega Charizard X ex 013/094", "125")).toBeNull();
    const s = summarise(
      [
        {
          title: "Mega Charizard X ex 125/094",
          soldPrice: "680",
          soldCurrency: "AUD",
          endedAt: "2026-11-26",
        },
        {
          title: "Mega Charizard X ex 125/094",
          soldPrice: "700",
          soldCurrency: "AUD",
          endedAt: "2026-11-25",
        },
        {
          title: "Mega Charizard X ex 125/094",
          soldPrice: "720",
          soldCurrency: "AUD",
          endedAt: "2026-11-24",
        },
        {
          title: "Mega Charizard X ex 125 PSA 10",
          soldPrice: "1700",
          soldCurrency: "AUD",
          endedAt: "2026-11-26",
        },
        {
          title: "Mega Charizard X ex 125/094",
          soldPrice: "500",
          soldCurrency: "USD",
          endedAt: "2026-11-26",
        },
      ],
      "125",
      MARKETS["AU"]!,
    );
    expect(s.raw).toMatchObject({ avg_last_3: 700, avg_last_5: 700, n: 3, status: "ok" });
    expect(s.psa10).toMatchObject({ avg_last_3: 1700, avg_last_5: 1700, n: 1, status: "thin" });
    expect(s.psa9.status).toBe("none");
  });
});

describe("Last 3 and last 5 sold averages", () => {
  it("averages the newest 3 and newest 5 sales", async () => {
    const { stat } = await import("@/lib/ebay-sold.server");
    const r = stat([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 999]);
    expect(r.avg_last_3).toBe(20);
    expect(r.avg_last_5).toBe(30);
    expect(r.n).toBe(5);
  });
  it("over-fetches one raw-only search on the collector's site", async () => {
    const { actorInput, SOLD_FETCH_COUNT, SOLD_KEEP_COUNT } =
      await import("@/lib/ebay-sold.server");
    const { MARKETS } = await import("@/lib/market");
    const input = actorInput({ name: "Umbreon ex", number: "161" }, MARKETS["AU"]!);
    expect(SOLD_FETCH_COUNT).toBeGreaterThan(SOLD_KEEP_COUNT);
    expect(input.keywords).toHaveLength(1);
    expect(input.keywords[0]).toMatch(/^Umbreon ex 161 -custom -proxy .*-psa .*-graded/);
    expect(input).toMatchObject({
      ebaySite: "ebay.com.au",
      categoryId: "183454",
      conditionId: 4000,
      count: SOLD_FETCH_COUNT,
      aspectFilter: { "Card Condition": "Near Mint or Better" },
    });
    expect(
      actorInput({ name: "Umbreon ex", number: "161" }, MARKETS["AU"]!, "lp").aspectFilter,
    ).toEqual({ "Card Condition": "Lightly Played (Excellent)" });
  });
  it("never excludes Full Art or TAG TEAM cards", async () => {
    const { actorInput, classifySale } = await import("@/lib/ebay-sold.server");
    const { MARKETS } = await import("@/lib/market");
    const k = actorInput({ name: "Umbreon ex", number: "161" }, MARKETS["AU"]!).keywords[0]!;
    expect(k).not.toMatch(/-art\b|-tag\b/);
    expect(
      classifySale("Umbreon ex 161/131 Prismatic Evolutions Full Art Holo Ultra Rare", "161"),
    ).toBe("raw");
  });
  it("keeps only sales from the collector's own country", async () => {
    const { actorInput, isDomestic, summarise } = await import("@/lib/ebay-sold.server");
    const { MARKETS } = await import("@/lib/market");
    const au = MARKETS["AU"]!;
    expect(actorInput({ name: "Umbreon ex", number: "161" }, au)).toMatchObject({
      ebaySite: "ebay.com.au",
      sellerCountry: "AU",
      daysToScrape: 90,
    });
    expect(isDomestic(null, au)).toBe(true);
    expect(isDomestic("Australia", au)).toBe(true);
    expect(isDomestic("United States", au)).toBe(false);
    expect(isDomestic("United Kingdom", MARKETS["GB"]!)).toBe(true);
    const sale = (p: string, d: string, loc: string | null) => ({
      title: "Umbreon ex 161/131",
      soldPrice: p,
      soldCurrency: "AUD",
      endedAt: d,
      itemLocation: loc,
    });
    const r = summarise(
      [
        sale("1300", "2026-11-26", null),
        sale("2000", "2026-11-25", "United States"),
        sale("1500", "2026-11-24", null),
      ],
      "161",
      au,
    );
    expect(r.raw).toMatchObject({ n: 2, avg_last_5: 1400 });
  });
  it("reads the collector's condition and keeps only that condition's sales", async () => {
    const { toCondition, titleCondition, summarise } = await import("@/lib/ebay-sold.server");
    const { MARKETS } = await import("@/lib/market");
    expect(toCondition("lightly_played")).toBe("lp");
    expect(toCondition("LP")).toBe("lp");
    expect(toCondition("Near mint or better")).toBe("nm");
    expect(toCondition("heavily_played")).toBe("hp");
    expect(toCondition("moderately played")).toBe("mp");
    expect(toCondition("whatever")).toBeNull();
    expect(titleCondition("LP Umbreon EX 161/131")).toBe("lp");
    expect(titleCondition("Umbreon ex 161/131 NM Near Mint SIR")).toBe("nm");
    expect(titleCondition("Umbreon ex 161/131 Prismatic Evolutions")).toBeNull();
    const sale = (p: string, d: string, t: string) => ({
      title: t,
      soldPrice: p,
      soldCurrency: "AUD",
      endedAt: d,
    });
    const sales = [
      sale("1500", "2026-11-26", "Umbreon ex 161/131 Prismatic"),
      sale("1300", "2026-11-25", "LP Umbreon ex 161/131"),
      sale("1700", "2026-11-24", "Umbreon ex 161/131 NM"),
    ];
    expect(summarise(sales, "161", MARKETS["AU"]!, "lp").raw).toMatchObject({
      n: 2,
      avg_last_5: 1400,
    });
    expect(summarise(sales, "161", MARKETS["AU"]!, "nm").raw).toMatchObject({
      n: 2,
      avg_last_5: 1600,
    });
  });
  it("leaves out sales far below the rest, like a custom or metal card", async () => {
    const { summarise } = await import("@/lib/ebay-sold.server");
    const { MARKETS } = await import("@/lib/market");
    const sale = (p: string, d: string, t = "Umbreon ex 161/131 Prismatic Evolutions") => ({
      title: t,
      soldPrice: p,
      soldCurrency: "AUD",
      endedAt: d,
    });
    const r = summarise(
      [
        sale("1500", "2026-11-26"),
        sale("1600", "2026-11-25"),
        sale("8.95", "2026-11-24", "Umbreon 161/131 holo card"),
        sale("1400", "2026-11-23"),
      ],
      "161",
      MARKETS["AU"]!,
    );
    expect(r.raw).toMatchObject({ n: 3, avg_last_3: 1500 });
  });
});
