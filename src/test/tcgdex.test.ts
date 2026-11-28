import { describe, expect, it } from "vitest";

import { priceScale } from "@/lib/tcgdex";

describe("Price card points", () => {
  it("reads TCGplayer's lowest listing, market and mid price for one printing", () => {
    expect(
      priceScale({
        tcgplayer: {
          unit: "USD",
          updated: "2026-11-22T22:16:35.383Z",
          holofoil: { lowPrice: 467.19, midPrice: 589.81, highPrice: 10000, marketPrice: 522.94 },
        },
      }),
    ).toEqual({
      low: 467.19,
      market: 522.94,
      mid: 589.81,
      variant: "holofoil",
      updated: "2026-11-22T22:16:35.383Z",
    });
  });
  it("is null without US$ market data", () => {
    expect(priceScale({ cardmarket: { unit: "EUR" } })).toBeNull();
    expect(priceScale(null)).toBeNull();
  });
});
