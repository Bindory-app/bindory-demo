import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findCards, getCardPricing } from "@/lib/tcgdex";
import { runMori } from "@/lib/mori-agent.server";
import { resolveMarketFx } from "@/lib/fx.server";
import { marketFor } from "@/lib/market";
import type { OrderIntent } from "@/lib/mori-validation";
import {
  GatewayError,
  type ResponsesRequest,
  type ResponsesResponse,
} from "@/lib/ai-gateway.server";
import { latestSync, startSync } from "@/lib/collectr-sync.server";
import { marketPrices } from "@/lib/mori-prices.server";
import { asObject, type DB } from "@/lib/mori-context.server";
import type { MoriStreamEvent } from "@/lib/mori-tools";
import { createTurnTimer } from "@/lib/mori-timing.server";

vi.mock("@/lib/collectr-sync.server", () => ({ latestSync: vi.fn(), startSync: vi.fn() }));
vi.mock("@/lib/fx.server", () => ({
  resolveMarketFx: vi.fn(async (market) => ({
    market,
    rate: market.currency === "USD" ? 1 : 1.5,
    stale: false,
    fallbackToUsd: false,
  })),
}));
vi.mock("@/lib/tcgdex", async (original) => ({
  ...(await original<typeof import("@/lib/tcgdex")>()),
  findCards: vi.fn(),
  getCardPricing: vi.fn(async (id: string) => ({
    card: { id, name: "Pikachu", localId: "25", set: { id: "base1", name: "Base Set" } },
    pricing: null,
  })),
}));
vi.mock("@/lib/mori-prices.server", async (original) => ({
  ...(await original<typeof import("@/lib/mori-prices.server")>()),
  marketPrices: vi.fn(async () => ({ forTool: { currency: "USD", price_points: { market: 10 } } })),
}));

type Row = { role: string; kind: string; content: string; payload?: unknown };
const since = "2026-11-27T00:00:00.000Z";
function chat(rows: Row[] = []) {
  const upload = vi.fn(async (): Promise<{ error: { message: string } | null }> => ({
    error: null,
  }));
  const remove = vi.fn(async () => ({ error: null }));
  const bucket = vi.fn(() => ({ upload, remove }));
  const db = {
    from: () => ({
      select: () => {
        const q = {
          gt: () => q,
          lt: () => q,
          order: () => q,
          eq: () => q,
          not: () => q,
          limit: () => q,
          range: async () => ({ data: rows.slice(0, -1), error: null }),
          maybeSingle: async () => ({
            data:
              [...rows]
                .reverse()
                .find((r) => r.kind === "status" && asObject(r.payload)["photos"]) ?? null,
          }),
        };
        return q;
      },
      insert: (draft: Row | Row[]) => ({
        select: () => {
          if (Array.isArray(draft)) {
            rows.push(...draft);
            return Promise.resolve({ data: draft, error: null });
          }
          rows.push(draft);
          return { single: async () => ({ data: { ...draft, created_at: since }, error: null }) };
        },
      }),
    }),
    storage: { from: bucket },
  } as unknown as DB;
  const events: MoriStreamEvent[] = [];
  const send = (
    message: string,
    opts: Pick<
      Parameters<typeof runMori>[0],
      "images" | "location" | "country" | "intent" | "timing" | "signal"
    > = {},
  ) =>
    runMori({
      db,
      message,
      userId: "collector",
      emit: (event) => events.push(event),
      since,
      ...opts,
    });
  return { send, rows, events, bucket, upload, remove };
}

const call = (name: string, args: Record<string, unknown>) => ({
  type: "function_call",
  name,
  arguments: JSON.stringify(args),
  call_id: crypto.randomUUID(),
});
const say = (text: string) => ({ type: "message", content: [{ type: "output_text", text }] });
const requests: ResponsesRequest[] = [];
const replies: NonNullable<ResponsesResponse["output"]>[] = [];
function gateway(...output: NonNullable<ResponsesResponse["output"]>) {
  replies.push(output);
}
const priced = (id = "base1-25") => call("get_card_prices", { card_id: id, country: "US" });
const printing = { name: "Pikachu", number: "25/102", set: "Base Set" };
const hit = { ...printing, id: "base1-25", number: "25", set_size: 102 };
const order = (side: "sell" | "buy") =>
  call("place_order", { card: printing, side, price: { amount: 10, currency: "USD" } });
const images = ["data:image/jpeg;base64,Zg==", "data:image/jpeg;base64,Yg=="];
beforeEach(() => {
  vi.clearAllMocks();
  requests.length = replies.length = 0;
  vi.mocked(findCards).mockReset();
  vi.stubEnv("AI_GATEWAY_API_KEY", "mock-key");
  vi.stubEnv("VERCEL_OIDC_TOKEN", "");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options: RequestInit) => {
      if (url !== "https://ai-gateway.vercel.sh/v1/responses") throw new Error("Unexpected URL");
      requests.push(JSON.parse(String(options.body)) as ResponsesRequest);
      const output = replies.shift();
      if (!output) throw new Error("Unexpected gateway call");
      const events = output
        .filter((o) => o.type === "message")
        .map((o) => ({ type: "response.output_text.delta", delta: o.content?.[0]?.text ?? "" }));
      return new Response(
        [...events, { type: "response.completed", response: { output } }]
          .map((e) => "data: " + JSON.stringify(e) + "\n\n")
          .join(""),
      );
    }),
  );
});
afterEach(() => {
  expect(fetch).toHaveBeenCalledTimes(requests.length);
  expect(replies).toHaveLength(0);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("structured pre-grading", () => {
  const candidate = {
    id: "base1-25",
    name: "Pikachu",
    number: "25",
    set: "Base Set",
    set_size: 102,
  };
  const intent = { kind: "pre_grade", card: { id: candidate.id } };
  const reading = { name: "Pikachu", number: "25/102", set: "Base Set", confidence: "high" };
  const report = {
    outcomes: [
      { grade: 9, probability: 70 },
      { grade: 8, probability: 30 },
    ],
    take: "The card is worth $9999.",
    confidence: 81,
    notes: "Light edge wear",
    overall: { psa: 9 },
    subgrades: { corners: { psa: 80 } },
  };
  it.each([[], images.slice(0, 1)].map((shots) => ({ shots })))(
    "requests the pair and keeps the exact intent with $shots",
    async ({ shots }) => {
      const { send, rows, upload } = chat();
      const pending = { ...intent, card: { name: "Pikachu", number: "25/102", set: "Base Set" } };
      await send("Pre-grade this card", { intent: pending, images: shots });
      expect(requests).toHaveLength(0);
      expect(getCardPricing).not.toHaveBeenCalled();
      expect(rows.find((r) => r.kind === "photos")?.payload).toEqual({
        for: "grade",
        intent: pending,
      });
      expect(upload).not.toHaveBeenCalled();
    },
  );
  it("prices a known card while vision is pending and records one turn-zero call", async () => {
    const { send, rows, events, bucket } = chat();
    const timing = createTurnTimer(Date.now, () => {});
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mockGateway = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementationOnce(async (...args) => {
      await gate;
      return mockGateway(...args);
    });
    gateway(call("pre_grade_report", report));
    const pending = send("Pre-grade", { intent, images, timing });
    try {
      await vi.waitFor(() => {
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(getCardPricing).toHaveBeenCalledWith(candidate.id);
      });
    } finally {
      release();
    }
    await pending;
    expect(rows.filter((r) => r.kind === "grade")).toHaveLength(1);
    expect(rows.find((r) => r.kind === "grade")?.payload).toMatchObject({
      card: "Pikachu 25 (Base Set)",
      card_id: candidate.id,
      raw_price: { amount: 10, currency: "USD" },
      notes: report.notes,
    });
    expect(JSON.stringify(rows)).not.toMatch(/data:image|9999/);
    expect(bucket).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      tool_choice: "required",
      max_output_tokens: 2000,
      tools: [{ name: "pre_grade_report" }],
    });
    expect(JSON.stringify(requests[0]?.tools)).not.toContain('"reading"');
    for (const shot of images) expect(JSON.stringify(requests[0]?.input)).toContain(shot);
    expect(timing.finish("done").models).toMatchObject([{ turn: 0, ok: true }]);
    expect(events.filter((e) => e.type === "status").map((e) => e.name)).toEqual([
      "pre_grade_report",
      "get_card_prices",
    ]);
  });
  it.each([
    ["AUD", false],
    ["USD", true],
  ] as const)(
    "identifies both photos in the same call and labels the real %s price",
    async (currency, fallback) => {
      vi.mocked(findCards).mockResolvedValue([candidate]);
      const market = vi.mocked(marketPrices).getMockImplementation()!;
      vi.mocked(marketPrices).mockImplementationOnce(async (...args) => {
        const m = await market(...args);
        return { ...m, forTool: { ...m.forTool, currency, fx_fallback: fallback } };
      });
      gateway(call("pre_grade_report", { ...report, reading }));
      const { send, rows } = chat();
      await send("Pre-grade", { intent: { kind: "pre_grade" }, images, country: "AU" });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.tools?.[0]?.parameters["required"]).toContain("reading");
      expect(findCards).toHaveBeenCalledWith("Pikachu", "25/102", "Base Set");
      expect(
        rows.filter((r) => r.kind === "status").map((r) => asObject(r.payload)["name"]),
      ).toEqual(["search_catalogue", "get_card_prices"]);
      expect(rows.find((r) => r.kind === "grade")?.payload).toMatchObject({
        card_id: candidate.id,
        raw_price: { amount: 10, currency },
      });
    },
  );
  it.each(["low confidence", "ambiguous printing", "price unavailable"])(
    "keeps the assessment without a price on %s",
    async (reason) => {
      vi.mocked(findCards).mockResolvedValue(
        reason === "ambiguous printing"
          ? [candidate, { ...candidate, id: "base1-25b" }]
          : [candidate],
      );
      if (reason === "price unavailable")
        vi.mocked(getCardPricing).mockRejectedValueOnce(new Error("offline"));
      gateway(
        call("pre_grade_report", {
          ...report,
          reading: { ...reading, confidence: reason === "low confidence" ? "low" : "high" },
        }),
      );
      const { send, rows } = chat();
      await send("Pre-grade", { intent: { kind: "pre_grade" }, images });
      const row = rows.find((r) => r.kind === "grade");
      expect(asObject(row?.payload)["price_note"]).toContain("couldn't verify");
      expect(asObject(row?.payload)["raw_price"]).toBeUndefined();
      if (reason !== "price unavailable") expect(getCardPricing).not.toHaveBeenCalled();
      expect(requests).toHaveLength(1);
    },
  );
  it("falls back on invalid outcomes without storing photos, even if chat asks for an order", async () => {
    const { send, rows, bucket } = chat();
    gateway(call("pre_grade_report", { ...report, outcomes: [{ grade: 9, probability: 100 }] }));
    gateway(order("sell"));
    await send("Pre-grade my card", { intent, images });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.tools?.length).toBeGreaterThan(1);
    expect(rows.filter((r) => r.role === "user")).toHaveLength(1);
    expect(rows.some((r) => r.kind === "grade")).toBe(false);
    expect(bucket).not.toHaveBeenCalled();
  });
  it("reports a gateway failure at once instead of retrying the photos in the chat loop", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { send, rows } = chat();
      await expect(send("Pre-grade", { intent, images })).rejects.toBeInstanceOf(GatewayError);
      // Only the forced call's own attempts reached the gateway; none carried the chat tools.
      expect(requests.every((r) => r.tool_choice === "required" && r.tools?.length === 1)).toBe(
        true,
      );
      expect(rows.some((r) => r.kind === "grade")).toBe(false);
    } finally {
      error.mockRestore();
    }
  });
  it("propagates cancellation during pricing rather than persisting a report or retrying in chat", async () => {
    const controller = new AbortController();
    vi.mocked(getCardPricing).mockImplementationOnce(async () => {
      controller.abort();
      throw controller.signal.reason;
    });
    gateway(call("pre_grade_report", report));
    const { send, rows } = chat();
    await expect(
      send("Pre-grade", { intent, images, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(requests.length).toBeLessThanOrEqual(1);
    expect(rows.some((r) => r.kind === "grade")).toBe(false);
  });
});

describe("model flow tools", () => {
  it("uses the router's photo reading once and resolves the next condition and sell requests from history", async () => {
    vi.mocked(findCards).mockResolvedValue([hit]);
    const { send, rows } = chat();
    gateway(say("A stray preamble."), call("price_check", { card: printing }), order("buy"));
    await send("How much is this?", { images: images.slice(0, 1) });
    const names = requests[0]?.tools?.map((t) => t.name);
    for (const name of [
      "price_check",
      "pre_grade",
      "place_order",
      "log_memory",
      "search_catalogue",
      "get_card_prices",
    ])
      expect(names).toContain(name);
    for (const retired of ["set_order", "save_memory", "pre_grade_report", "request_card_photos"])
      expect(names).not.toContain(retired);
    expect(rows.map((r) => r.kind).slice(1)).toEqual(["status", "status", "price", "suggest"]);
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0]?.input)).toContain(images[0]);
    expect(findCards).toHaveBeenCalledWith("Pikachu", "25/102", "Base Set");
    gateway(call("price_check", { card: { id: hit.id }, condition: "lightly_played" }));
    await send("What about lightly played?");
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1]?.input)).toContain(hit.id);
    expect(rows.filter((r) => r.kind === "price")).toHaveLength(2);
    expect(vi.mocked(marketPrices).mock.calls.at(-1)?.[3]).toBe("lp");
    gateway(
      call("place_order", {
        card: { id: hit.id },
        side: "sell",
        price: { amount: 20, currency: "USD" },
      }),
    );
    await send("Make it a sell order for US$20.");
    expect(requests).toHaveLength(3);
    expect(rows.find((r) => r.kind === "photos")?.payload).toMatchObject({
      for: "sell",
      intent: { kind: "order", card: { id: hit.id } },
    });
    expect(findCards).toHaveBeenCalledTimes(1);
  });
  it("hands a typed pre-grade's pending printing to its photo reply without an extra routing call", async () => {
    vi.mocked(findCards).mockResolvedValue([hit]);
    const { send, rows, upload } = chat();
    gateway(call("pre_grade", { card: printing }));
    await send("Pre-grade my Pikachu 25/102.");
    const pending = asObject(rows.find((r) => r.kind === "photos")?.payload)["intent"];
    expect(pending).toEqual({ kind: "pre_grade", card: printing });
    expect(requests).toHaveLength(1);
    gateway(
      call("pre_grade_report", {
        outcomes: [
          { grade: 9, probability: 80 },
          { grade: 8, probability: 20 },
        ],
        take: "Keep it raw.",
      }),
    );
    await send("Here are the photos", { images, intent: pending });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.tools).toHaveLength(1);
    expect(rows.filter((r) => r.kind === "grade")).toHaveLength(1);
    expect(upload).not.toHaveBeenCalled();
  });
  it.each(["invalid args", "no match", "unreadable photo", "unseen id"])(
    "returns a usable tool error for %s and stops a repeated call",
    async (reason) => {
      vi.mocked(findCards).mockResolvedValue([]);
      const kind = reason === "invalid args" ? "place_order" : "price_check";
      const args =
        reason === "unreadable photo"
          ? {}
          : reason === "unseen id"
            ? { card: { id: "guessed-25" } }
            : { card: printing };
      const { send, rows } = chat();
      gateway(call(kind, args));
      gateway(call(kind, args));
      await send("Can you check this?", {
        images: reason === "unreadable photo" ? images.slice(0, 1) : [],
      });
      expect(requests).toHaveLength(2);
      expect(requests[1]?.tools?.some((t) => t.name === kind)).toBe(false);
      expect(
        requests[1]?.input.filter((i) => "type" in i && i.type === "function_call_output"),
      ).toMatchObject([{ output: expect.stringContaining("ask the collector") }]);
      expect(rows.find((r) => r.kind === "text")?.content).toMatch(/\?$/);
      expect(findCards).toHaveBeenCalledTimes(reason === "no match" ? 1 : 0);
      expect(getCardPricing).not.toHaveBeenCalled();
    },
  );
  it("allows a natural clarification after a failed flow, not an unrelated price card", async () => {
    const { send, rows } = chat();
    gateway(priced(), call("place_order", { side: "buy" }));
    gateway(say("What target price and currency should I use?"));
    await send("Set a buy order");
    expect(requests).toHaveLength(2);
    expect(rows.some((r) => r.kind === "price")).toBe(false);
    expect(rows.find((r) => r.kind === "text")?.content).toBe(
      "What target price and currency should I use?",
    );
  });
  it.each(["pre_grade", "price_check"])(
    "does not donate photos from a rejected routed %s to a later sell call",
    async (kind) => {
      const { send, rows, upload } = chat();
      gateway(call(kind, { card: { id: "invented-25" } }));
      gateway(order("sell"));
      await send("Can you check this card?", { images });
      expect(requests).toHaveLength(2);
      expect(upload).not.toHaveBeenCalled();
      expect(rows.some((r) => r.kind === "confirm")).toBe(false);
      expect(rows.at(-1)).toMatchObject({ kind: "photos", payload: { for: "sell" } });
    },
  );
  it("rejects retired internal tool names even if a model emits one", async () => {
    const { send, rows } = chat();
    gateway(call("save_memory", { title: "Bogus", story: "Not what I said." }));
    gateway(say("What would you like to remember?"));
    await send("Help with memories");
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1]?.input)).toContain("Tool unavailable");
    expect(rows.some((r) => r.kind === "confirm")).toBe(false);
  });
  it("reports a required pre-grade gateway failure without asking the router to retry", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { send, rows, upload } = chat();
      vi.mocked(findCards).mockResolvedValue([hit]);
      gateway(call("pre_grade", { card: printing }));
      await expect(send("Pre-grade Pikachu", { images })).rejects.toBeInstanceOf(GatewayError);
      expect(
        requests
          .slice(1)
          .every((r) => r.tools?.length === 1 && r.tools[0]?.name === "pre_grade_report"),
      ).toBe(true);
      expect(upload).not.toHaveBeenCalled();
      expect(rows.some((r) => r.kind === "grade")).toBe(false);
    } finally {
      log.mockRestore();
    }
  });
  it("still proposes a sell without condition when its optional read fails at the gateway", async () => {
    const { send, rows, upload } = chat();
    vi.mocked(findCards).mockResolvedValue([hit]);
    const timing = createTurnTimer(Date.now, () => {});
    gateway(order("sell"));
    await send("Sell Pikachu for US$10", { images, timing });
    expect(timing.finish("done").models).toMatchObject([
      { turn: 1, ok: true },
      { turn: 0, ok: false },
    ]);
    expect(upload).toHaveBeenCalledTimes(2);
    const p = rows.find((r) => r.kind === "confirm")?.payload;
    expect(p).toMatchObject({ tool: "set_order", side: "sell" });
    expect(asObject(p)["condition"]).toBeUndefined();
    expect(rows.find((r) => r.kind === "text")?.content).toContain("couldn't assess condition");
  });
  it("propagates cancellation during the sell condition read without uploading or proposing", async () => {
    const { send, rows, upload } = chat();
    const controller = new AbortController();
    vi.mocked(findCards).mockResolvedValue([hit]);
    gateway(order("sell"));
    const normal = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch)
      .mockImplementationOnce(normal)
      .mockImplementationOnce(async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)) as ResponsesRequest);
        controller.abort();
        throw controller.signal.reason;
      });
    await expect(
      send("Sell Pikachu for US$10", { images, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(requests).toHaveLength(2);
    expect(upload).not.toHaveBeenCalled();
    expect(rows.some((r) => r.kind === "confirm")).toBe(false);
  });
  it("rethrows an abort after routing, without finishing the answer", async () => {
    const ctl = new AbortController();
    const { send, rows } = chat();
    gateway(call("price_check", { card: printing }));
    vi.mocked(findCards).mockImplementationOnce(async () => {
      ctl.abort();
      return [hit];
    });
    await expect(send("Price check", { signal: ctl.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(requests).toHaveLength(1);
    expect(rows.some((r) => r.kind === "price")).toBe(false);
  });
});

describe("the direct Mori tool loop", () => {
  beforeEach(() => {
    vi.mocked(findCards).mockResolvedValue([hit]);
  });
  it("sends the market, location and prior outcomes but no conversion arithmetic to the model", async () => {
    const { send } = chat(
      ["confirmed", "edited"].map((status) => ({
        role: "mori",
        kind: "confirm",
        content: "Add Pikachu",
        payload: { status, card: { name: "Pikachu" } },
      })),
    );
    gateway(say("Here you go."));
    await send("Shows near me?", { country: "AU", location: "Melbourne" });
    const input = requests[0]!.input;
    const appNote = input.find((item) => "role" in item && item.role === "developer");
    for (const detail of ["Australia", "country code AU", "AUD (A$)", "ebay.com.au", "Melbourne"])
      expect(JSON.stringify(appNote)).toContain(detail);
    for (const status of ["confirmed", "edited"]) expect(JSON.stringify(input)).toContain(status);
    expect(JSON.stringify(appNote)).not.toContain("1 US$ =");
  });

  it("shows one price card, not prose; keeps suggestions and ignores model-supplied sales", async () => {
    const { send, rows, events } = chat();
    gateway(
      call("get_card_prices", {
        card_id: "base1-25",
        country: "US",
        sold_listings: [{ soldPrice: 9999 }],
      }),
    );
    gateway(say("A short price summary.\nSuggestions: Set a buy order | Pre-grade this card"));
    await send("Price check Pikachu");
    expect(rows.filter((r) => r.role === "mori").map((r) => r.kind)).toEqual([
      "status",
      "price",
      "suggest",
    ]);
    expect(rows.find((r) => r.kind === "price")?.payload).toMatchObject({
      headline: 10,
      card: { id: "base1-25" },
    });
    expect(rows.at(-1)?.payload).toEqual({
      suggestions: ["Set a buy order", "Pre-grade this card"],
    });
    expect(events.some((e) => e.type === "text")).toBe(false);
    // marketPrices takes no sales argument: card, pricing, market, condition.
    expect(vi.mocked(marketPrices).mock.calls[0]?.slice(3)).toEqual(["nm"]);
    const schema = requests[0]!.tools?.find((t) => t.name === "get_card_prices");
    expect(schema).toBeDefined();
    expect(JSON.stringify(schema)).not.toContain("sold_listings");
  });

  it("does not replace a comparison of two distinctly priced cards with one price card", async () => {
    const { send, rows } = chat();
    gateway(priced(), priced("base1-4"));
    gateway(say("Here is the comparison."));
    await send("Compare the two prices.");
    expect(rows.some((r) => r.kind === "price")).toBe(false);
    expect(rows.find((r) => r.kind === "text")?.content).toBe("Here is the comparison.");
  });

  it("a sell call without photos shows only a photo request and records that result for the next turn", async () => {
    const { send, rows } = chat();
    gateway(say("Confirm your order below."), order("sell"), order("sell"));
    await send("Set a sell order");
    expect(rows.filter((r) => r.kind === "photos")).toHaveLength(1);
    expect(rows.find((r) => r.kind === "confirm")).toBeUndefined();
    expect(rows.find((r) => r.kind === "text")?.content).toContain("front and back");
    expect(rows.find((r) => r.kind === "status")?.payload).toMatchObject({
      name: "request_card_photos",
      output: { card: "photo_request", order_proposed: false },
    });
    expect(rows.find((r) => r.kind === "photos")?.payload).toMatchObject({
      for: "sell",
      intent: {
        kind: "order",
        side: "sell",
        card: printing,
        price: { amount: 10, currency: "USD" },
      },
    });
    gateway(say("I need the front and back."));
    await send("What are you waiting for?");
    const next = requests[1]!.input;
    expect(
      next.some(
        (i) =>
          "role" in i &&
          i.role === "assistant" &&
          i.content.some((c) => c.text.includes('"order_proposed":false')),
      ),
    ).toBe(true);
    const pending = asObject(rows.find((r) => r.kind === "photos")?.payload)["intent"];
    gateway(call("read_order_condition", { overall: "Near mint" }));
    await send("Here are the front and back.", { intent: pending, images });
    expect(requests).toHaveLength(3);
    expect(requests[2]?.tools?.map((t) => t.name)).toEqual(["read_order_condition"]);
    expect(rows.at(-1)?.payload).toMatchObject({
      tool: "set_order",
      side: "sell",
      price: { amount: 10, currency: "USD" },
    });
  });

  it("keeps free-text sell photos only when a sell tool actually requests them", async () => {
    const { send, rows, upload } = chat();
    gateway(say("What price?"));
    await send("Set a sell order", { images });
    expect(upload).not.toHaveBeenCalled();
    gateway(order("sell"));
    gateway(call("read_order_condition", { overall: "Near mint" }));
    await send("Sell at US$10", { images });
    expect(requests).toHaveLength(3); // earlier plain question, then routing plus condition
    expect(upload).toHaveBeenCalledTimes(2);
    expect(rows.find((r) => r.kind === "confirm")?.payload).toMatchObject({
      side: "sell",
      photos: {
        front: expect.stringMatching(/^collector\/orders\/.+-front.jpg$/),
        back: expect.stringMatching(/^collector\/orders\/.+-back.jpg$/),
      },
    });
  });

  it("does not save photos sent only for pre-grading; the grade keeps the last priced card label", async () => {
    const { send, rows, upload } = chat();
    gateway(call("pre_grade", { card: printing }), order("buy"));
    gateway(
      call("pre_grade_report", {
        card: "Stale model label",
        outcomes: [
          { grade: 9, probability: 70 },
          { grade: 8, probability: 30 },
        ],
        take: "Keep it raw.",
      }),
    );
    await send("Can you pre-grade this card?", { images });
    expect(requests).toHaveLength(2);
    expect(upload).not.toHaveBeenCalled();
    expect(rows.find((r) => r.kind === "grade")?.payload).toMatchObject({
      card: "Pikachu 25 (Base Set)",
    });
    expect(rows.some((r) => r.kind === "price" || r.kind === "confirm")).toBe(false);
  });

  it("stops after the first successful proposal, even across calls in one gateway batch", async () => {
    const { send, rows } = chat();
    gateway(order("buy"), order("buy"), order("sell"));
    await send("Set a buy order");
    expect(rows.filter((r) => r.kind === "status").map((r) => asObject(r.payload)["name"])).toEqual(
      ["search_catalogue", "get_card_prices", "set_order"],
    );
    expect(rows.filter((r) => r.kind === "confirm")).toHaveLength(1);
    expect(requests).toHaveLength(1);
  });

  it("keeps a ticket card rather than dropping it or replacing it with a price card", async () => {
    const { send, rows } = chat();
    gateway(
      priced(),
      call("show_tickets", {
        event: "Card show",
        ticket_url: "https://tickets.example.com/show",
        options: [{ name: "Adult", price: "$10" }],
      }),
    );
    gateway(say("Choose your ticket."));
    await send("Show the tickets");
    expect(rows.find((r) => r.kind === "tickets")?.payload).toMatchObject({ event: "Card show" });
    expect(rows.some((r) => r.kind === "price")).toBe(false);
  });

  it("only consults the last sync for explicit continuations, not new work or photos", async () => {
    const { send } = chat();
    const prior = { status: "completed", response_id: "r", session_id: "s", sig: "test" };
    vi.mocked(latestSync).mockResolvedValue(prior);
    vi.mocked(startSync).mockResolvedValue({
      role: "mori",
      kind: "sync",
      content: "Continuing",
      payload: {},
    });
    for (const message of ["Price check", "Set a sell order", "Save a memory"]) {
      gateway(say("Starting a new request."));
      await send(message);
    }
    gateway(say("I see your photos."));
    await send("Go ahead", { images });
    expect(latestSync).not.toHaveBeenCalled();
    expect(startSync).not.toHaveBeenCalled();
    await send("Only the first 20");
    expect(startSync).toHaveBeenCalledWith(expect.anything(), "collector", {
      followUp: "Only the first 20",
      prior,
    });
    expect(requests).toHaveLength(4);
  });
});

describe("order quotes and photo provenance", () => {
  const pika = { id: "base1-25", name: "Pikachu", number: "25", set: "Base Set", set_size: 102 };
  const buy: OrderIntent = {
    kind: "order",
    side: "buy",
    card: { name: "Pikachu", number: "25/102" },
    price: { amount: 15, currency: "AUD" },
  };
  const sell: OrderIntent = { ...buy, side: "sell" };
  const cold = () =>
    vi.mocked(resolveMarketFx).mockResolvedValueOnce({
      market: { ...marketFor("AU"), currency: "USD", symbol: "US$" },
      rate: 1,
      stale: false,
      fallbackToUsd: true,
    });
  it("orders at the resolved FX quote without a model and records prices before one confirmation", async () => {
    vi.mocked(findCards).mockResolvedValue([pika]);
    const { send, rows } = chat();
    await send("Buy Pikachu for A$15", { intent: buy, country: "AU" });
    expect(requests).toHaveLength(0);
    expect(vi.mocked(resolveMarketFx)).toHaveBeenCalledWith(
      expect.objectContaining({ currency: "AUD" }),
    );
    expect(rows.filter((r) => r.kind === "status").map((r) => asObject(r.payload)["name"])).toEqual(
      ["search_catalogue", "get_card_prices", "set_order"],
    );
    expect(rows.filter((r) => r.kind === "confirm")).toHaveLength(1);
    expect(rows.at(-1)).toMatchObject({
      kind: "confirm",
      content: "Buy Pikachu 25 at 15 AUD (US$10)",
      payload: {
        tool: "set_order",
        side: "buy",
        price: buy.price,
        price_usd: 10,
        fx_rate: 1.5,
        status: "pending",
      },
    });
    expect(rows.at(-1)?.payload).toMatchObject({
      market_reference: { amount: 10, currency: "USD" },
    });
  });
  it("refuses a guessed conversion on cold FX, then accepts an explicit USD order in Australia", async () => {
    cold();
    vi.mocked(findCards).mockResolvedValue([pika]);
    const { send, rows } = chat();
    await send("A$15", { intent: buy, country: "AU" });
    expect(rows.some((r) => r.kind === "confirm")).toBe(false);
    expect(rows.find((r) => r.kind === "text")?.content).toContain("What US$ price");
    await send("Use US$11", {
      intent: { ...buy, price: { amount: 11, currency: "USD" } },
      country: "AU",
    });
    expect(rows.at(-1)?.payload).toMatchObject({
      price_usd: 11,
      price: { amount: 11, currency: "USD" },
    });
    expect(requests).toHaveLength(0);
  });
  it("keeps the whole order on each printing choice; the chosen ID does not search again", async () => {
    const second = { ...pika, id: "promo-25", set: "Promos" };
    vi.mocked(findCards).mockResolvedValue([pika, second]);
    const { send, rows } = chat();
    await send("Buy Pikachu", { intent: buy });
    const choices = asObject(rows.at(-1)?.payload)["choices"] as {
      intent: OrderIntent;
      label: string;
    }[];
    expect(choices.map((c) => c.intent)).toEqual(
      [pika, second].map((c) => ({ ...buy, card: { id: c.id } })),
    );
    expect(marketPrices).not.toHaveBeenCalled();
    await send(choices[1]!.label, { intent: choices[1]!.intent });
    expect(findCards).toHaveBeenCalledTimes(1);
    expect(rows.at(-1)?.payload).toMatchObject({
      card: { tcgdex_id: second.id },
      side: "buy",
      price: buy.price,
    });
    expect(requests).toHaveLength(0);
  });

  it("falls through on an unmatched order without uploading or dropping its photos", async () => {
    vi.mocked(findCards).mockResolvedValue([]);
    gateway(say("Which printing did you mean?"));
    const { send, rows, upload } = chat();
    await send("Sell Pikachu for A$15", { intent: sell, images });
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0]?.input)).toContain(images[1]);
    expect(rows.filter((r) => r.role === "user")).toHaveLength(1);
    expect(rows.some((r) => r.kind === "confirm")).toBe(false);
    expect(upload).not.toHaveBeenCalled();
  });
  it("does not upload sell photos for an unquotable price", async () => {
    cold();
    vi.mocked(findCards).mockResolvedValue([pika]);
    gateway(call("read_order_condition", { overall: "Near mint" }));
    const { send, rows, upload } = chat();
    await send("Sell Pikachu for A$15", { intent: sell, images, country: "AU" });
    expect(rows.some((r) => r.kind === "confirm")).toBe(false);
    expect(rows.find((r) => r.kind === "text")?.content).toContain("What US$ price");
    expect(upload).not.toHaveBeenCalled();
  });

  it("cleans up a partial upload and asks again for the same sell order", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { send, rows, upload, remove } = chat();
      vi.mocked(findCards).mockResolvedValue([pika]);
      gateway(call("read_order_condition", { overall: "Near mint" }));
      upload
        .mockResolvedValueOnce({ error: null })
        .mockRejectedValueOnce(new Error("connection interrupted"));
      await send("Sell Pikachu", { intent: sell, images });
      expect(remove).toHaveBeenCalledWith([
        expect.stringMatching(/^collector\/orders\/.+-front.jpg$/),
        expect.stringMatching(/^collector\/orders\/.+-back.jpg$/),
      ]);
      expect(rows.at(-1)).toMatchObject({ kind: "photos", payload: { intent: sell } });
      expect(rows.some((r) => r.kind === "confirm")).toBe(false);
      expect(requests).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });
  it.each([[], images.slice(0, 1)])(
    "never substitutes another order's stored pair for missing images (%j)",
    async (...photo) => {
      const { send, rows, upload } = chat([
        {
          role: "mori",
          kind: "status",
          content: "Old photos",
          payload: { photos: { front: "collector/orders/a.jpg", back: "collector/orders/b.jpg" } },
        },
      ]);
      await send("Sell this card", { intent: sell, images: photo });
      expect(rows.at(-1)).toMatchObject({ kind: "photos", payload: { for: "sell", intent: sell } });
      expect(rows.some((r) => r.kind === "confirm")).toBe(false);
      expect(requests).toHaveLength(0);
      expect(upload).not.toHaveBeenCalled();
      expect(findCards).not.toHaveBeenCalled();
    },
  );
  it.each([true, false])("sells from the supplied pair; condition read success=%s", async (ok) => {
    const { send, rows, upload } = chat();
    const condition = {
      overall: "Lightly played",
      edges: "Light whitening",
      centering: { front: "55/45" },
      corners: { top_left: "Sharp" },
      surface: "Clean",
    };
    gateway(ok ? call("read_order_condition", condition) : say("I can't tell."));
    vi.mocked(findCards).mockResolvedValue([pika]);
    await send("Sell Pikachu", { intent: sell, images });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      tool_choice: "required",
      tools: [{ name: "read_order_condition" }],
    });
    for (const image of images) expect(JSON.stringify(requests[0]?.input)).toContain(image);
    expect(upload).toHaveBeenCalledTimes(2);
    expect(rows.at(-1)?.payload).toMatchObject({
      side: "sell",
      price: sell.price,
      price_usd: 10,
      photos: {
        front: expect.stringMatching(/-front.jpg$/),
        back: expect.stringMatching(/-back.jpg$/),
      },
    });
    if (ok) expect(asObject(rows.at(-1)?.payload)["condition"]).toEqual(condition);
    else {
      expect(asObject(rows.at(-1)?.payload)["condition"]).toBeUndefined();
      expect(rows.at(-2)?.content).toContain("couldn't assess condition");
    }
    expect(JSON.stringify(rows)).not.toContain("data:image");
  });
  it("converts a routed order on the server and stops it from guessing USD on FX failure", async () => {
    vi.mocked(findCards).mockResolvedValue([pika]);
    const args = {
      side: "buy",
      card: printing,
      price: { amount: 30, currency: "AUD" },
      note: "  PSA 9 wanted  ",
    };
    const { send, rows } = chat();
    gateway(call("place_order", args));
    await send("Buy for A$30, PSA 9 wanted");
    expect(rows.at(-1)?.payload).toMatchObject({
      price_usd: 20,
      price: { amount: 30, currency: "AUD" },
      note: "PSA 9 wanted",
    });
    const tool = requests[0]?.tools?.find((t) => t.name === "place_order");
    expect(tool?.parameters["required"]).toEqual(["side", "card", "price"]);
    cold();
    gateway(call("place_order", args), order("buy"));
    await send("Another A$30 order");
    expect(rows.filter((r) => r.kind === "confirm")).toHaveLength(1);
    expect(rows.filter((r) => r.kind === "text").at(-1)?.content).toContain("What US$ price");
    expect(requests).toHaveLength(2);
  });
});

describe("explicit price-check turns", () => {
  const pika = { id: "base1-25", name: "Pikachu", number: "25", set: "Base Set", set_size: 102 };
  const intent = {
    kind: "price_check",
    card: { name: "Pikachu", number: "25/102" },
    condition: "lightly_played",
  };

  it("prices the one exact printing with no gateway call and keeps a normal tool transcript", async () => {
    const { send, rows, events } = chat();
    vi.mocked(findCards).mockResolvedValue([
      pika,
      { ...pika, id: "base1-26", name: "Flying Pikachu" },
    ]);
    await send("Price check: Pikachu 25/102, Lightly played", { intent });
    expect(requests).toHaveLength(0);
    expect(findCards).toHaveBeenCalledWith("Pikachu", "25/102", undefined);
    expect(rows[0]?.content).toBe("Price check: Pikachu 25/102, Lightly played");
    expect(rows.slice(1).map((r) => r.kind)).toEqual(["status", "status", "price", "suggest"]);
    expect(rows[1]?.payload).toMatchObject({
      name: "search_catalogue",
      output: [pika, expect.anything()],
    });
    expect(rows[2]?.payload).toMatchObject({
      name: "get_card_prices",
      input: { card_id: pika.id, country: "US", currency: "USD", condition: "lightly_played" },
      output: { card: { id: pika.id } },
    });
    expect(marketPrices).toHaveBeenCalledTimes(1);
    expect(rows[3]?.payload).toMatchObject({ card: { id: pika.id } });
    expect(rows[4]?.payload).toEqual({
      suggestions: [
        "Set a buy order for this card",
        "Pre-grade this card",
        "Add this card to my wishlist",
      ],
    });
    expect(events.map((e) => (e.type === "status" ? e.name : e.type))).toEqual([
      "search_catalogue",
      "get_card_prices",
      "done",
    ]);
    gateway(say("That was Pikachu."));
    await send("Which card was that?");
    expect(JSON.stringify(requests[0]?.input)).toContain(pika.id);
  });

  it("shows several plausible printings as ID-backed choices; choosing one bypasses name search", async () => {
    const { send, rows } = chat();
    const second = { ...pika, id: "promo-25", set: "Promos" };
    vi.mocked(findCards).mockResolvedValue([pika, second]);
    await send("Check Pikachu", { intent });
    expect(rows.slice(1).map((r) => r.kind)).toEqual(["status", "text", "choices"]);
    const choices = asObject(rows.at(-1)?.payload)["choices"] as {
      label: string;
      intent: unknown;
    }[];
    expect(choices).toEqual(
      [pika, second].map((c) => ({
        label: `Pikachu 25/102 (${c.set})`,
        intent: { kind: "price_check", card: { id: c.id }, condition: "lightly_played" },
      })),
    );
    expect(marketPrices).not.toHaveBeenCalled();
    await send(choices[1]!.label, { intent: choices[1]!.intent });
    expect(findCards).toHaveBeenCalledTimes(1);
    expect(rows.at(-3)?.payload).toMatchObject({
      name: "get_card_prices",
      input: { card_id: second.id, condition: "lightly_played" },
    });
    expect(rows.at(-2)?.payload).toMatchObject({ card: { id: second.id } });
    expect(requests).toHaveLength(0);
  });

  it.each(["not found", "lookup error", "contradictory set size"])(
    "falls through to chat on %s without inserting another question",
    async (reason) => {
      if (reason === "lookup error")
        vi.mocked(findCards).mockRejectedValue(new Error("unavailable"));
      else
        vi.mocked(findCards).mockResolvedValue(
          reason === "not found" ? [] : [{ ...pika, set_size: 108 }],
        );
      const { send, rows } = chat();
      gateway(say("Which printing did you mean?"));
      await send("Look up Pikachu", { intent });
      expect(requests).toHaveLength(1);
      expect(rows.filter((r) => r.role === "user")).toHaveLength(1);
      expect(requests[0]?.input.filter((i) => "role" in i && i.role === "user")).toHaveLength(1);
      expect(rows.find((r) => r.kind === "text")?.content).toBe("Which printing did you mean?");
      expect(rows.some((r) => r.kind === "price")).toBe(false);
    },
  );

  it.each([
    { kind: "order" },
    {
      kind: "order",
      side: "buy",
      card: { id: "base1-25" },
      price: { amount: -10, currency: "USD" },
    },
    { kind: "price_check", card: { name: "" } },
    { kind: "pre_grade", card: { id: "not a catalogue id" } },
    { kind: "pre_grade", card: { name: "Pikachu", set: "" } },
    { kind: "pre_grade", card: { id: "base1-25", name: "Pikachu" } },
    { kind: "price_check" },
  ])("logs and ignores malformed, unsupported or image-less intents", async (bad) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      gateway(say("How can I help?"));
      await chat().send("A free-text question", { intent: bad });
      expect(warn).toHaveBeenCalledWith("Invalid or unsupported Mori intent; using chat");
      expect(requests).toHaveLength(1);
      expect(findCards).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("reads the photo with one forced tool call then prices the actual catalogue card", async () => {
    vi.mocked(findCards).mockResolvedValue([pika]);
    gateway(
      call("identify_card", {
        confidence: "high",
        name: pika.name,
        number: "25/102",
        set: pika.set,
      }),
    );
    const { send, rows, events } = chat();
    const timing = createTurnTimer(Date.now, () => {});
    await send("What is this card worth?", { intent: { kind: "price_check" }, images, timing });
    // The one-shot photo read is in the turn's timing line next to the tools it led to.
    const summary = timing.finish("done");
    expect(summary.models).toMatchObject([{ turn: 0, ok: true }]);
    expect(summary.tools.map((t) => t.name)).toEqual(["search_catalogue", "get_card_prices"]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      tool_choice: "required",
      tools: [{ name: "identify_card" }],
      max_output_tokens: 500,
    });
    expect(JSON.stringify(requests[0]?.input)).toContain(images[0]);
    expect(findCards).toHaveBeenCalledWith("Pikachu", "25/102", "Base Set");
    expect(events[0]).toMatchObject({ type: "status", name: "identify_card" });
    expect(rows.slice(1).map((r) => r.kind)).toEqual(["status", "status", "price", "suggest"]);
    expect(JSON.stringify(rows)).not.toContain("data:image");
  });

  it.each([
    call("identify_card", { confidence: "low", name: "Pikachu" }),
    say("I cannot tell."),
    { ...call("identify_card", {}), arguments: "bad json" },
  ])("keeps the original photo in chat when identification fails", async (output) => {
    gateway(output);
    gateway(say("Could you take a clearer photo?"));
    const { send, rows } = chat();
    await send("Photo price check", { intent: { kind: "price_check" }, images });
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1]?.input)).toContain(images[0]);
    expect(rows.find((r) => r.kind === "text")?.content).toBe("Could you take a clearer photo?");
    expect(findCards).not.toHaveBeenCalled();
  });

  it("returns to chat if a previously selected catalogue ID no longer exists", async () => {
    vi.mocked(getCardPricing).mockResolvedValueOnce(null);
    gateway(say("Which card was that?"));
    const { send, rows } = chat();
    await send("Pikachu 25", { intent: { kind: "price_check", card: { id: "removed-25" } } });
    expect(requests).toHaveLength(1);
    expect(rows.some((r) => r.kind === "price")).toBe(false);
  });
});
