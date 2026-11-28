import { describe, expect, it } from "vitest";

describe("Local currency", () => {
  it("maps countries to currency and eBay site, US by default", async () => {
    const { marketFor } = await import("@/lib/market");
    expect(marketFor("au")).toMatchObject({ currency: "AUD", symbol: "A$", ebay: "ebay.com.au" });
    expect(marketFor("GB").ebay).toBe("ebay.co.uk");
    expect(marketFor("ZZ").currency).toBe("USD");
  });
});

describe("Import fees on listings from abroad", () => {
  it("estimates import fees by the collector's country, none at home or within the EU", async () => {
    const { MARKETS, importFeeRate } = await import("@/lib/market");
    expect(importFeeRate(MARKETS["AU"]!, "United States")).toBe(0.125);
    expect(importFeeRate(MARKETS["AU"]!, null)).toBe(0);
    expect(importFeeRate(MARKETS["AU"]!, "Australia")).toBe(0);
    expect(importFeeRate(MARKETS["GB"]!, "United States")).toBe(0.2);
    expect(importFeeRate(MARKETS["DE"]!, "France")).toBe(0);
    expect(importFeeRate(MARKETS["DE"]!, "United Kingdom")).toBe(0.19);
  });
});
