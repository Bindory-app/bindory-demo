import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findCards, getCardPricing } from "@/lib/tcgdex";
import { runMori } from "@/lib/mori-agent.server";
import type { ResponsesRequest, ResponsesResponse } from "@/lib/ai-gateway.server";
import { latestSync, startSync } from "@/lib/collectr-sync.server";
import { marketPrices } from "@/lib/mori-prices.server";
import { asObject, type DB } from "@/lib/mori-context.server";
import type { MoriStreamEvent } from "@/lib/mori-tools";

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
  const upload = vi.fn(async () => ({ error: null }));
  const bucket = vi.fn(() => ({ upload }));
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
    opts: Pick<Parameters<typeof runMori>[0], "images" | "location" | "country" | "intent"> = {},
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
const requests: ResponsesRequest[] = [];
const replies: NonNullable<ResponsesResponse["output"]>[] = [];
function gateway(...output: NonNullable<ResponsesResponse["output"]>) {
  replies.push(output);
}
const priced = (id = "base1-25") => call("get_card_prices", { card_id: id, country: "US" });
const order = (side: "sell" | "buy") =>
  call("set_order", { card_id: "base1-25", side, price: 10, currency: "USD" });
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

describe("the direct Mori tool loop", () => {
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
      name: "set_order",
      output: { card: "photo_request", order_proposed: false },
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
    { kind: "price_check", card: { name: "" } },
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
    await send("What is this card worth?", { intent: { kind: "price_check" }, images });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      tool_choice: "required",
      tools: [{ name: "identify_card" }],
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
