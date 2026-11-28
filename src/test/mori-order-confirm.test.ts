import { describe, expect, it } from "vitest";
import { orderChanges } from "@/lib/mori-confirm.server";
import type { ProposalPayload } from "@/lib/mori-tools";

describe("order confirmation edits", () => {
  const p: Extract<ProposalPayload, { tool: "set_order" }> = {
    tool: "set_order",
    status: "pending",
    card: { tcgdex_id: "base1-25", name: "Pikachu 25" },
    side: "buy",
    price: { amount: 15, currency: "AUD" },
    price_usd: 10,
    fx_rate: 1.5,
  };
  it("keeps an unsupported side change pending; the remaining edit can be resubmitted as a buy", () => {
    const changes = { side: "sell", price: 16.51, expires_days: 90 };
    expect(() => orderChanges(p, changes)).toThrow("needs front and back photos");
    expect(orderChanges(p, { ...changes, side: "buy" })).toEqual({
      price_usd: 11.01,
      price_amount: 16.51,
      expires_days: 90,
    });
    expect(() => orderChanges(p, { price_usd: 99 })).toThrow("Edit the price in AUD");
  });
  it("allows sell only with both photos and ignores client-supplied currency/rate", () => {
    const full = {
      ...p,
      photos: { front: "collector/orders/a-front.jpg", back: "collector/orders/a-back.jpg" },
    };
    expect(
      orderChanges(full, { side: "sell", price: 30, currency: "USD", fx_rate: 1, expires_days: 7 }),
    ).toEqual({ side: "sell", price_amount: 30, price_usd: 20, expires_days: 7 });
    expect(() =>
      orderChanges({ ...full, photos: { front: "a", back: "a" } }, { side: "sell" }),
    ).toThrow("front and back");
    expect(() => orderChanges({ ...p, side: "sell" }, {})).toThrow("front and back");
  });
  it("preserves the USD edit contract of pending legacy proposals", () => {
    const old = { ...p, price: undefined, fx_rate: undefined };
    expect(orderChanges(old, { price_usd: 200.05, expires_days: 30 })).toEqual({
      price_usd: 200.05,
      expires_days: 30,
    });
    expect(() => orderChanges(old, { price: 0.0001 })).toThrow("valid price");
    expect(orderChanges({ ...p, fx_rate: 2 }, { price: 2.01 })).toEqual({
      price_amount: 2.01,
      price_usd: 1.01,
    });
  });
});
