import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMori } from "@/lib/mori-agent.server";
import { streamResponse, type ResponsesResponse } from "@/lib/ai-gateway.server";
import { latestSync, startSync } from "@/lib/collectr-sync.server";
import { marketPrices } from "@/lib/mori-prices.server";
import { asObject, type DB } from "@/lib/mori-context.server";
import type { MoriStreamEvent } from "@/lib/mori-tools";

vi.mock("@/lib/ai-gateway.server", async (original) => ({
  ...(await original<typeof import("@/lib/ai-gateway.server")>()),
  streamResponse: vi.fn(),
}));
vi.mock("@/lib/collectr-sync.server", () => ({ latestSync: vi.fn(), startSync: vi.fn() }));
vi.mock("@/lib/fx.server", () => ({ usdTo: () => Promise.resolve(1.5) }));
vi.mock("@/lib/tcgdex", async (original) => ({
  ...(await original<typeof import("@/lib/tcgdex")>()),
  getCardPricing: async (id: string) => ({
    card: { id, name: "Pikachu", localId: "25", set: { id: "base1", name: "Base Set" } },
    pricing: null,
  }),
}));
vi.mock("@/lib/mori-prices.server", async (original) => ({
  ...(await original<typeof import("@/lib/mori-prices.server")>()),
  marketPrices: vi.fn(async () => ({ forTool: { currency: "USD", price_points: { market: 10 } } })),
}));

type Row = { role: string; kind: string; content: string; payload?: unknown };
const since = "2026-11-27T00:00:00.000Z";
function chat(rows: Row[] = []) {
  const upload = vi.fn(async () => ({ error: null }));
  const bucket = vi.fn(() => ({ upload }));
  const db = {
    from: () => ({
      select: () => {
        const q = {
          gt: () => q,
          order: () => q,
          eq: () => q,
          not: () => q,
          limit: () => q,
          range: async () => ({ data: [...rows], error: null }),
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
    opts: Pick<Parameters<typeof runMori>[0], "images" | "location" | "country"> = {},
  ) =>
    runMori({
      db,
      message,
      userId: "collector",
      emit: (event) => events.push(event),
      since,
      ...opts,
    });
  return { send, rows, events, bucket, upload };
}

const call = (name: string, args: Record<string, unknown>) => ({
  type: "function_call",
  name,
  arguments: JSON.stringify(args),
  call_id: crypto.randomUUID(),
});
const say = (text: string) => ({ type: "message", content: [{ type: "output_text", text }] });
function gateway(...output: NonNullable<ResponsesResponse["output"]>) {
  vi.mocked(streamResponse).mockResolvedValueOnce(
    (async function* () {
      for (const item of output)
        if (item.type === "message")
          yield { type: "response.output_text.delta", delta: item.content?.[0]?.text ?? "" };
      yield { type: "response.completed", response: { output } };
    })(),
  );
}
const priced = (id = "base1-25") => call("get_card_prices", { card_id: id, country: "US" });
const order = (side: "sell" | "buy") =>
  call("set_order", { card_id: "base1-25", side, price_usd: 10 });
const images = ["data:image/jpeg;base64,Zg==", "data:image/jpeg;base64,Yg=="];
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(streamResponse).mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected network call");
    }),
  );
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("the direct Mori tool loop", () => {
  it("sends the market, exchange rate, phone location and prior card outcomes to the model", async () => {
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
    const input = vi.mocked(streamResponse).mock.calls[0]![0].input;
    const appNote = input.find((item) => "role" in item && item.role === "developer");
    for (const detail of [
      "Australia",
      "country code AU",
      "AUD (A$)",
      "ebay.com.au",
      "1 US$ = 1.5 AUD",
      "US$ for set_order",
      "Melbourne",
    ])
      expect(JSON.stringify(appNote)).toContain(detail);
    for (const status of ["confirmed", "edited"]) expect(JSON.stringify(input)).toContain(status);
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
    const schema = vi
      .mocked(streamResponse)
      .mock.calls[0]![0].tools?.find((t) => t.name === "get_card_prices");
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
      name: "set_order",
      output: { card: "photo_request", order_proposed: false },
    });
    gateway(say("I need the front and back."));
    await send("What are you waiting for?");
    const next = vi.mocked(streamResponse).mock.calls[1]![0].input;
    expect(
      next.some(
        (i) =>
          "role" in i &&
          i.role === "assistant" &&
          i.content.some((c) => c.text.includes('"order_proposed":false')),
      ),
    ).toBe(true);
  });

  it.each([
    null,
    "Here are photos of the front and back for my sell order.",
    "Set a sell order for this card",
  ])(
    "attaches the collector's private sell photos (earlier photo message: %s)",
    async (earlier) => {
      const { send, rows, bucket, upload } = chat();
      if (earlier) {
        gateway(say("What price did you have in mind?"));
        await send(earlier, { images });
      }
      gateway(order("sell"));
      await send(earlier ? "$10" : "Set a sell order at $10", earlier ? {} : { images });
      expect(bucket).toHaveBeenCalledWith("memory-photos");
      expect(upload).toHaveBeenCalledTimes(2);
      const paths = rows.find((r) => asObject(r.payload)["photos"] && r.kind === "status")?.payload;
      expect(paths).toMatchObject({
        photos: {
          front: expect.stringMatching(/^collector\/orders\/.+-front.jpg$/),
          back: expect.stringMatching(/^collector\/orders\/.+-back.jpg$/),
        },
      });
      expect(rows.find((r) => r.kind === "confirm")?.payload).toMatchObject({
        ...asObject(paths),
        side: "sell",
        status: "pending",
      });
    },
  );

  it("does not save photos sent only for pre-grading; the grade keeps the last priced card label", async () => {
    const { send, rows, upload } = chat();
    gateway(
      priced(),
      call("pre_grade_report", {
        card: "Stale model label",
        outcomes: [
          { grade: 9, probability: 70 },
          { grade: 8, probability: 30 },
        ],
        take: "Keep it raw.",
      }),
      order("buy"),
    );
    await send("Can you pre-grade this card?", { images });
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
    expect(rows.filter((r) => r.kind === "status")).toHaveLength(1);
    expect(rows.filter((r) => r.kind === "confirm")).toHaveLength(1);
    expect(streamResponse).toHaveBeenCalledTimes(1);
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
    expect(streamResponse).toHaveBeenCalledTimes(4);
  });
});
