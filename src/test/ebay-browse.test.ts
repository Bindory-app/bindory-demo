import { describe, expect, it } from "vitest";

describe("eBay Browse API listings", () => {
  it("searches raw singles in one condition, Buy It Now, cheapest first, local or worldwide", async () => {
    const { browseQuery } = await import("@/lib/ebay-browse.server");
    const { MARKETS } = await import("@/lib/market");
    const card = { name: "Umbreon ex", number: "161" };
    const local = new URL(browseQuery(card, MARKETS["AU"]!, "lp", true, 678.4));
    expect(local.pathname).toBe("/buy/browse/v1/item_summary/search");
    expect(local.searchParams.get("q")).toBe("Umbreon ex 161");
    expect(local.searchParams.get("category_ids")).toBe("183454");
    expect(local.searchParams.get("sort")).toBe("price");
    const f = local.searchParams.get("filter")!;
    expect(f).toContain("buyingOptions:{FIXED_PRICE}");
    expect(f).toContain("conditionIds:{4000}");
    expect(f).toContain("deliveryCountry:AU");
    expect(f).toContain("itemLocationCountry:AU");
    expect(f).toContain("price:[678..]");
    expect(f).toContain("priceCurrency:AUD");
    expect(local.searchParams.get("aspect_filter")).toBe(
      "categoryId:183454,Card Condition:{Lightly Played (Excellent)}",
    );
    const world = new URL(browseQuery(card, MARKETS["AU"]!, "nm", false));
    expect(world.searchParams.get("filter")).not.toContain("itemLocationCountry");
  });
  it("turns items into rows in the collector's currency, with the seller's country", async () => {
    const { toRow } = await import("@/lib/ebay-browse.server");
    const { MARKETS } = await import("@/lib/market");
    const rates = { USD: 1, AUD: 1.5 };
    const us = toRow(
      {
        title: "Umbreon ex 161/131",
        price: { value: "880.00", currency: "USD" },
        shippingOptions: [{ shippingCost: { value: "32.00", currency: "USD" } }],
        itemLocation: { country: "US" },
      },
      MARKETS["AU"]!,
      rates,
    );
    expect(us).toMatchObject({ priceValue: 1320, shippingCost: 48, itemLocation: "United States" });
    const au = toRow(
      {
        title: "Umbreon ex 161/131",
        price: { value: "1466.70", currency: "AUD" },
        itemLocation: { country: "AU" },
      },
      MARKETS["AU"]!,
      rates,
    );
    expect(au).toMatchObject({ priceValue: 1466.7, shippingCost: null, itemLocation: null });
  });
});
