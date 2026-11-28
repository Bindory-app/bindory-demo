import { afterEach, expect, it, vi } from "vitest";
import {
  hasPendingOrders,
  saveAlertPreferences,
  connectPayment,
} from "@/lib/mori-order-payment.server";
import type { DB } from "@/lib/mori-context.server";
function fixture() {
  const q = {
    from: vi.fn(() => q),
    upsert: vi.fn().mockResolvedValue({ error: null }),
    rpc: vi.fn(),
    select: vi.fn(() => q),
    eq: vi.fn(() => q),
    gt: vi.fn(() => q),
    limit: vi.fn(),
  };
  return { q, db: q as unknown as DB };
}
afterEach(() => vi.useRealTimers());
it("upserts exactly the collector's two alert preferences, never a wallet", async () => {
  const { db, q } = fixture();
  vi.setSystemTime(new Date("2026-11-27T00:00:00Z"));
  await saveAlertPreferences(db, "mine", false, true);
  expect(q.from).toHaveBeenCalledWith("order_settings");
  expect(q.upsert).toHaveBeenCalledWith({
    user_id: "mine",
    alert_push: false,
    alert_email: true,
    updated_at: new Date().toISOString(),
  });
  q.upsert.mockResolvedValue({ error: new Error("offline") });
  await expect(saveAlertPreferences(db, "mine", true, false)).rejects.toThrow("offline");
});
it("returns only the count the activation RPC confirmed and rejects invalid labels or replies", async () => {
  const { db, q } = fixture();
  for (const bad of ["", "constructor", "unrecognised"])
    await expect(connectPayment(db, bad)).rejects.toThrow("Invalid payment method");
  expect(q.rpc).not.toHaveBeenCalled();
  for (const [wallet, ids] of [
    ["card", []],
    ["paypal", ["x"]],
    ["crypto", ["x", "y"]],
    ["google_pay", []],
  ] as const) {
    q.rpc.mockResolvedValue({ data: { activated_ids: ids } });
    expect(await connectPayment(db, wallet)).toBe(ids.length);
    expect(q.rpc).toHaveBeenLastCalledWith("connect_order_payment", { p_wallet: wallet });
  }
  for (const data of [null, {}, { activated_ids: null }, { activated_ids: [false] }]) {
    q.rpc.mockResolvedValue({ data });
    await expect(connectPayment(db, "card")).rejects.toThrow("Activation not confirmed");
  }
  q.rpc.mockResolvedValue({ data: { activated_ids: ["x"] }, error: new Error("offline") });
  await expect(connectPayment(db, "card")).rejects.toThrow("offline");
});
it("checks only the collector's unexpired, pending orders and propagates lookup failures", async () => {
  const { db, q } = fixture();
  vi.setSystemTime(new Date("2026-11-27T00:00:00Z"));
  q.limit
    .mockResolvedValueOnce({ data: [{ id: "x" }] })
    .mockResolvedValueOnce({ data: [] })
    .mockResolvedValueOnce({ error: new Error("offline") });
  expect(await hasPendingOrders(db, "mine")).toBe(true);
  expect(await hasPendingOrders(db, "mine")).toBe(false);
  await expect(hasPendingOrders(db, "mine")).rejects.toThrow("offline");
  expect(q.from).toHaveBeenCalledWith("market_orders");
  expect(q.select).toHaveBeenCalledWith("id");
  expect(q.eq).toHaveBeenCalledWith("user_id", "mine");
  expect(q.eq).toHaveBeenCalledWith("status", "pending");
  expect(q.gt).toHaveBeenCalledWith("expires_at", new Date().toISOString());
  expect(q.limit).toHaveBeenCalledWith(1);
});
