import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { DB } from "@/lib/mori-context.server";
import { runReadTool } from "@/lib/mori-read-tools.server";
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

describe("pending order contracts", () => {
  it("lists the collector's unexpired pending and open orders with their status", async () => {
    const rows = [
      { id: "one", status: "pending" },
      { id: "two", status: "open" },
    ];
    const db = {
      from: (table: string) => {
        expect(table).toBe("market_orders");
        const query = {
          select(fields: string) {
            expect(fields.split(",").map((s) => s.trim())).toContain("status");
            return this;
          },
          in(key: string, values: string[]) {
            expect(key).toBe("status");
            expect(values).toEqual(["open", "pending"]);
            return this;
          },
          gt(key: string, value: string) {
            expect(key).toBe("expires_at");
            expect(Date.parse(value)).toBeGreaterThan(0);
            return this;
          },
          order() {
            return this;
          },
          limit() {
            return { data: rows, error: null };
          },
        };
        return query;
      },
    };
    expect(await runReadTool(db as unknown as DB, "list_my_orders", {})).toEqual(rows);
  });
  it("keeps the 015 confirmation safeguards and installs both 016 RPCs atomically", () => {
    const base = readFileSync("setup/015_order_confirmation.sql", "utf8");
    const sql = readFileSync("setup/016_pending_orders.sql", "utf8");
    expect(Buffer.byteLength(sql, "utf8")).toBe(sql.length);
    expect(sql).toContain(
      base.slice(
        base.indexOf("CREATE OR REPLACE FUNCTION"),
        base.indexOf("  INSERT INTO public.market_orders"),
      ),
    );
    expect(sql).toContain("o_price,p->>'note','pending'");
    expect(sql).toContain("jsonb_build_object('order_status','pending')");
    expect(sql).toContain("BEGIN;");
    expect(sql.trimEnd()).toMatch(/COMMIT;$/);
    const connect = sql.slice(
      sql.indexOf("CREATE OR REPLACE FUNCTION public.connect_order_payment"),
    );
    expect(connect).toContain("SECURITY INVOKER");
    expect(connect).toContain("uid uuid := auth.uid()");
    expect(connect).toContain(
      "IF p_wallet IS NULL OR p_wallet NOT IN ('card','crypto','paypal','google_pay')",
    );
    expect(connect).toContain("WHERE user_id=uid AND status='pending' AND expires_at>now()");
    expect(connect).toContain("expires_at=now() + (expires_at - created_at)");
  });
});
