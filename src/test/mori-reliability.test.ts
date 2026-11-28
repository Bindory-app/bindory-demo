import { describe, expect, it, vi } from "vitest";
import type { DB } from "@/lib/mori-context.server";
import { saveOrderPhotos } from "@/lib/mori-order-photos.server";
import { createTurnTimer } from "@/lib/mori-timing.server";
import { serializeToolResult } from "@/lib/mori-tool-output";
import { HISTORY_LIMIT, history } from "@/lib/mori-turn.server";

describe("serializeToolResult valid-JSON truncation", () => {
  it("leaves payloads within budget completely untouched", () => {
    const small = { card: { id: "base1-25", name: "Pikachu" }, prices: [10, 12] };
    expect(serializeToolResult(small, 8_000)).toBe(JSON.stringify(small));
  });

  it("trims the largest arrays first, keeps valid JSON <= maxChars, and sets truncated: true", () => {
    const big = {
      set: { id: "sv08.5", name: "Prismatic Evolutions", total: 200 },
      cards: Array.from({ length: 200 }, (_, i) => ({
        id: `sv08.5-${i + 1}`,
        number: String(i + 1),
        name: `Pokemon Card Number ${i + 1} Special Illustration Rare`,
      })),
    };
    const out = serializeToolResult(big, 2_000);
    expect(out.length).toBeLessThanOrEqual(2_000);
    const parsed = JSON.parse(out) as {
      set: { id: string; name: string; total: number };
      cards: unknown[];
      truncated: boolean;
    };
    expect(parsed.truncated).toBe(true);
    expect(parsed.set).toEqual(big.set);
    expect(parsed.cards.length).toBeGreaterThan(0);
    expect(parsed.cards.length).toBeLessThan(200);
  });

  it("wraps oversized root arrays cleanly and stays parseable", () => {
    const arr = Array.from({ length: 150 }, (_, i) => ({
      id: `card-${i}`,
      name: `Collector Card ${i}`,
      set: "Base Set",
    }));
    const out = serializeToolResult(arr, 1_500);
    expect(out.length).toBeLessThanOrEqual(1_500);
    const parsed = JSON.parse(out) as {
      results: unknown[];
      total_items: number;
      truncated: boolean;
    };
    expect(parsed.truncated).toBe(true);
    expect(parsed.total_items).toBe(150);
    expect(parsed.results.length).toBeGreaterThan(0);
    expect(parsed.results.length).toBeLessThan(150);
  });

  it("trims oversized strings (e.g. web_fetch page text) and stays valid JSON", () => {
    const fetched = {
      pages: [{ url: "https://example.com/show", text: "A".repeat(20_000) }],
    };
    const out = serializeToolResult(fetched, 2_000);
    expect(out.length).toBeLessThanOrEqual(2_000);
    const parsed = JSON.parse(out) as { truncated: boolean; pages: unknown[] };
    expect(parsed.truncated).toBe(true);
  });
});

describe("bounded history() in mori-turn.server", () => {
  it("fetches at most HISTORY_LIMIT newest rows in one query and returns them in chronological order", async () => {
    const allRows = Array.from({ length: 100 }, (_, i) => ({
      id: `row-${String(i + 1).padStart(3, "0")}`,
      created_at: new Date(Date.UTC(2026, 10, 27, 0, 0, i)).toISOString(),
      role: i % 2 === 0 ? "user" : "mori",
      kind: i === 97 ? "suggest" : "text",
      content: `msg-${i + 1}`,
      payload: null,
    }));

    const rangeSpy = vi.fn(async (from: number, to: number) => {
      // Simulate descending order by created_at, id from PostgREST.
      const desc = [...allRows].reverse();
      return { data: desc.slice(from, to + 1), error: null };
    });
    const orderCols: Array<{ col: string; ascending?: boolean | undefined }> = [];
    const q = {
      gt: () => q,
      order: (col: string, opts?: { ascending?: boolean }) => {
        orderCols.push({ col, ascending: opts?.ascending });
        return q;
      },
      range: rangeSpy,
    };
    const db = { from: () => ({ select: () => q }) } as unknown as DB;

    const items = await history(db);
    expect(rangeSpy).toHaveBeenCalledTimes(1);
    expect(rangeSpy).toHaveBeenCalledWith(0, HISTORY_LIMIT - 1);
    expect(orderCols).toEqual([
      { col: "created_at", ascending: false },
      { col: "id", ascending: false },
    ]);
    // 60 newest rows (msg-41..msg-100), minus the single "suggest" row (msg-98) = 59 items.
    expect(items).toHaveLength(HISTORY_LIMIT - 1);
    expect(items[0]).toEqual({ role: "user", content: "msg-41" });
    expect(items.at(-1)).toEqual({
      role: "assistant",
      content: [{ type: "output_text", text: "msg-100", annotations: [] }],
    });
  });
});

describe("order photo upload cleanup", () => {
  const images = ["data:image/jpeg;base64,Zg==", "data:image/jpeg;base64,Yg=="];

  it("removes the front photo when the back photo upload returns an error", async () => {
    const upload = vi
      .fn()
      .mockResolvedValueOnce({ error: null })
      .mockResolvedValueOnce({ error: { message: "storage full" } });
    const remove = vi.fn(async () => ({ data: [], error: null }));
    const db = { storage: { from: () => ({ upload, remove }) } } as unknown as DB;

    const result = await saveOrderPhotos(db, "u1", images);
    expect(result).toBeNull();
    expect(upload).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledTimes(1);
    const removedPaths = (remove.mock.calls[0] as unknown as [string[]])[0];
    expect(removedPaths).toHaveLength(1);
    expect(removedPaths[0]).toMatch(/^u1\/orders\/.+-front\.jpg$/);
  });

  it("removes the front photo when the back photo upload throws", async () => {
    const upload = vi
      .fn()
      .mockResolvedValueOnce({ error: null })
      .mockRejectedValueOnce(new Error("network reset"));
    const remove = vi.fn(async () => ({ data: [], error: null }));
    const db = { storage: { from: () => ({ upload, remove }) } } as unknown as DB;

    const result = await saveOrderPhotos(db, "u1", images);
    expect(result).toBeNull();
    expect(remove).toHaveBeenCalledTimes(1);
    const removedPaths = (remove.mock.calls[0] as unknown as [string[]])[0];
    expect(removedPaths).toHaveLength(1);
    expect(removedPaths[0]).toMatch(/^u1\/orders\/.+-front\.jpg$/);
  });

  it("does not call remove when the front photo upload itself fails", async () => {
    const upload = vi.fn().mockResolvedValueOnce({ error: { message: "denied" } });
    const remove = vi.fn(async () => ({ data: [], error: null }));
    const db = { storage: { from: () => ({ upload, remove }) } } as unknown as DB;

    const result = await saveOrderPhotos(db, "u1", images);
    expect(result).toBeNull();
    expect(upload).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
  });
});

describe("per-stage turn timing recorder", () => {
  it("logs exactly one structured JSON line per turn with model, tool, stage, cache, and outcome fields", () => {
    let t = 1_000;
    const lines: string[] = [];
    const timer = createTurnTimer(
      () => t,
      (line) => lines.push(line),
    );

    timer.recordStage("history", 18);
    timer.recordModel({ turn: 1, model: "google/gemini-2.5-flash", ms: 420, ok: true });
    timer.recordTool({ name: "get_card_prices", ms: 310, ok: true });
    timer.recordCache("fx", true);
    timer.recordCache("ebay_sold", false);
    timer.recordModel({ turn: 2, model: "google/gemini-2.5-flash", ms: 260, ok: true });
    t = 2_050;

    timer.flush("done");
    // Second flush is a no-op so each turn emits strictly one line.
    timer.flush("error", "internal");

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(parsed).toEqual({
      event: "mori.turn",
      total_ms: 1_050,
      outcome: "done",
      model_turns: 2,
      models: [
        { turn: 1, model: "google/gemini-2.5-flash", ms: 420, ok: true },
        { turn: 2, model: "google/gemini-2.5-flash", ms: 260, ok: true },
      ],
      tools: [{ name: "get_card_prices", ms: 310, ok: true }],
      stages: { history: 18 },
      cache: { fx: true, ebay_sold: false },
    });
  });
});
