import { describe, expect, it } from "vitest";

describe("Today's listings and the 7-day change", () => {
  it("picks the cheapest real card, skipping junk, other conditions and other countries", async () => {
    const { pickLowest } = await import("@/lib/ebay-listings.server");
    const { MARKETS } = await import("@/lib/market");
    const au = MARKETS["AU"]!;
    const row = (priceValue: number, title: string, extra: Record<string, unknown> = {}) => ({
      priceValue,
      price: "AU " + priceValue,
      currency: "AUD",
      shippingCost: 8,
      title,
      itemLocation: null,
      ...extra,
    });
    const items = [
      row(6.64, "Umbreon ex PRE 161/131 CREDIT CARD SKIN"),
      row(8.13, "Umbreon ex 161/131 EXTENDED ART CASE", { price: "AU 8.13  to  AU 41.33" }),
      row(1200, "LP Umbreon ex 161/131"),
      row(1300, "Umbreon ex 161/131 SIR", { itemLocation: "United States" }),
      row(1466.7, "Umbreon ex 161/131 Prismatic Evolutions"),
      row(1674.7, "Umbreon ex 161/131 Special Illustration"),
    ];
    expect(pickLowest(items, "161", "nm", au, { local: false })).toEqual({
      price: 1300,
      shipping: 8,
      import_fees: 163.5,
      total: 1471.5,
      from: "United States",
    });
    expect(pickLowest(items, "161", "nm", au, { local: true })).toEqual({
      price: 1466.7,
      shipping: 8,
      import_fees: 0,
      total: 1474.7,
      from: null,
    });
    expect(pickLowest(items, "161", "nm", au, { local: true, floor: 1500 })).toMatchObject({
      price: 1674.7,
      shipping: 8,
    });
  });
});

describe("Import fees on listings from abroad", () => {
  it("picks the cheapest delivered: an overseas listing loses once import fees are added", async () => {
    const { pickLowest } = await import("@/lib/ebay-listings.server");
    const { MARKETS } = await import("@/lib/market");
    const row = (priceValue: number, shippingCost: number, itemLocation: string | null) => ({
      priceValue,
      price: "AU " + priceValue,
      currency: "AUD",
      shippingCost,
      itemLocation,
      title: "Umbreon ex 161/131 Prismatic Evolutions",
    });
    // The real case: US A$1,327.89 + A$48.91 postage vs Australia A$1,466.70 + A$8.26.
    const best = pickLowest(
      [row(1327.89, 48.91, "United States"), row(1466.7, 8.26, null)],
      "161",
      "nm",
      MARKETS["AU"]!,
      { local: false },
    );
    expect(best).toEqual({
      price: 1466.7,
      shipping: 8.26,
      import_fees: 0,
      total: 1474.96,
      from: null,
    });
    const us = pickLowest([row(1327.89, 48.91, "United States")], "161", "nm", MARKETS["AU"]!, {
      local: false,
    });
    expect(us).toMatchObject({ import_fees: 172.1, total: 1548.9, from: "United States" });
  });
});
