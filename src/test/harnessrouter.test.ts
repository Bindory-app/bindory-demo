import { beforeAll, describe, expect, it } from "vitest";
import {
  isHarnessBearer,
  mcpBearer,
  openCollector,
  readSignedRows,
  sealCollector,
  signRows,
  stripRowBlocks,
} from "@/lib/mori-mcp-auth.server";
import { answerText } from "@/lib/harnessrouter.server";
import { parseSSE } from "@/lib/harnessrouter-chat.server";
import { moriToolName } from "@/lib/mori-harness.server";

const jwt = (exp: number) =>
  `x.${Buffer.from(JSON.stringify({ sub: "u1", exp })).toString("base64url")}.y`;

beforeAll(() => {
  process.env["MORI_MCP_SECRET"] = "test-secret-test-secret-test-secret-0123456789";
});

describe("Mori MCP collector tokens", () => {
  const now = Date.UTC(2026, 10, 23);
  const session = { userId: "u1", accessToken: jwt(now / 1000 + 3600) };

  it("round-trips a sealed session", () => {
    expect(openCollector(sealCollector(session, now), now)).toEqual(session);
  });
  it("hides the session from anyone who only sees the token", () => {
    expect(sealCollector(session, now)).not.toContain(session.accessToken.split(".")[1]);
  });
  it("rejects an altered token", () => {
    const t = sealCollector(session, now);
    const flipped = t.slice(0, 20) + (t[20] === "A" ? "B" : "A") + t.slice(21);
    expect(openCollector(flipped, now)).toBeNull();
  });
  it("expires after ten minutes, or with the session if sooner", () => {
    const t = sealCollector(session, now);
    expect(openCollector(t, now + 9 * 60_000)).not.toBeNull();
    expect(openCollector(t, now + 11 * 60_000)).toBeNull();
    const short = sealCollector({ userId: "u1", accessToken: jwt(now / 1000 + 60) }, now);
    expect(openCollector(short, now + 2 * 60_000)).toBeNull();
  });
  it("rejects missing and junk tokens", () => {
    expect(openCollector(null, now)).toBeNull();
    expect(openCollector("not-a-token", now)).toBeNull();
  });
});

describe("Mori MCP signed rows", () => {
  const rows = [{ role: "mori", kind: "confirm", content: "Add Pikachu", payload: { tool: "x" } }];
  it("reads rows signed for the same collector", () => {
    expect(readSignedRows(`{"ok":true}\n${signRows("u1", rows)}`, "u1")).toEqual(rows);
  });
  it("ignores rows signed for another collector", () => {
    expect(readSignedRows(signRows("u2", rows), "u1")).toEqual([]);
  });
  it("ignores forged or edited rows", () => {
    const line = signRows("u1", rows);
    const [body, sig] = line.slice("MORI_ROWS ".length).split(".");
    const edited = Buffer.from(
      Buffer.from(body!, "base64url").toString().replace("Pikachu", "Charizard"),
    ).toString("base64url");
    expect(readSignedRows(`MORI_ROWS ${edited}.${sig}`, "u1")).toEqual([]);
  });
  it("strips row blocks from text", () => {
    expect(stripRowBlocks(`Done.\n${signRows("u1", rows)}`)).toBe("Done.");
  });
});

describe("Mori MCP bearer", () => {
  it("accepts only the derived bearer", () => {
    expect(isHarnessBearer(`Bearer ${mcpBearer()}`)).toBe(true);
    expect(isHarnessBearer(`Bearer ${mcpBearer()}x`)).toBe(false);
    expect(isHarnessBearer(null)).toBe(false);
  });
});

describe("HarnessRouter stream", () => {
  const stream = (text: string) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        const bytes = new TextEncoder().encode(text);
        c.enqueue(bytes.slice(0, 17));
        c.enqueue(bytes.slice(17));
        c.close();
      },
    });
  it("parses data frames split across chunks and skips junk", async () => {
    const events = [];
    for await (const ev of parseSSE(
      stream(
        'data: {"type":"response.created","response":{"id":"resp_1"}}\r\n\r\ndata: nope\n\ndata: [DONE]\n\ndata: {"type":"response.output_text.delta","delta":"Hi"}\n\n',
      ),
    ))
      events.push(ev.type);
    expect(events).toEqual(["response.created", "response.output_text.delta"]);
  });
  it("takes the answer from the last message", () => {
    expect(
      answerText({
        id: "r",
        status: "completed",
        output: [
          { type: "message", content: [{ type: "output_text", text: "Working on it." }] },
          { type: "function_call", name: "mori__list_my_cards" },
          { type: "message", content: [{ type: "output_text", text: "Here you go." }] },
        ],
      }),
    ).toBe("Here you go.");
  });
  it("maps prefixed MCP tool names to Mori's tools only", () => {
    expect(moriToolName("mori__set_order")).toBe("set_order");
    expect(moriToolName("mori.list_my_cards")).toBe("list_my_cards");
    expect(moriToolName("pre_grade_report")).toBe("pre_grade_report");
    expect(moriToolName("bash")).toBeNull();
  });
});

import { agentMayUse, AGENT_TOOLS, MORI_AGENTS, routeMoriMessage } from "@/lib/mori-agents";
import handoff from "../../harnessrouter.json";

describe("Mori agent routing", () => {
  it("sends each shortcut's own wording to its specialist", () => {
    expect(routeMoriMessage("Price check: Mega Charizard X ex 125/094")).toBe("price");
    expect(routeMoriMessage("Buy Umbreon VMAX 215/203 for up to US$450")).toBe("order");
    expect(routeMoriMessage("Sell Umbreon ex 161 for at least US$1,200")).toBe("order");
    expect(
      routeMoriMessage("Here are photos of the front and back. Can you pre-grade this card?", true),
    ).toBe("grade");
    expect(routeMoriMessage("Add Umbreon VMAX 215/203 to my collection")).toBe("add");
    expect(
      routeMoriMessage(
        "I traded my Pikachu Celebrations card with @mina for a Charizard card at Tokyo on 2 Nov 2026. Help me save this memory.",
      ),
    ).toBe("memory");
    expect(routeMoriMessage("Start a trade-up challenge")).toBe("tradeup");
  });
  it("leaves general questions and follow-ups to the chat's current agent", () => {
    expect(routeMoriMessage("What card should I chase next?")).toBe("ask");
    expect(routeMoriMessage("Which collectors share my taste?")).toBe("ask");
    expect(routeMoriMessage("Yes, that one")).toBeNull();
    expect(routeMoriMessage("US$450 please")).toBeNull();
  });
  it("routes value questions and bare photos to price check", () => {
    expect(routeMoriMessage("Which of my cards went up in value this month?")).toBe("price");
    expect(routeMoriMessage("Here are photos of the front and back.", true)).toBe("price");
  });
});

describe("Mori agent harnesses and tool scopes", () => {
  // Mori's agents, plus "collectr" (Collectr sync, its own harness outside Mori's tool scopes).
  const moriSetups = handoff.setups.filter((s) => s.feature_key !== "collectr");
  it("has one harness per agent in harnessrouter.json", () => {
    const keys = moriSetups.map((s) => s.feature_key).sort();
    expect(keys).toEqual([...MORI_AGENTS].sort());
    expect(new Set(handoff.setups.map((s) => s.harness_id)).size).toBe(handoff.setups.length);
    expect(handoff.setups.find((s) => s.feature_key === "collectr")?.harness_id).toBe(
      "chrn_fb353c44d67fe5b51f47aa2e2fc72576",
    );
  });
  it("limits specialists to their own tools", () => {
    expect(agentMayUse("memory", "save_memory")).toBe(true);
    expect(agentMayUse("memory", "set_order")).toBe(false);
    expect(agentMayUse("price", "add_card_to_collection")).toBe(false);
    expect(agentMayUse("ask", "set_order")).toBe(true);
  });
  it("tells each specialist exactly the tools it may call", () => {
    for (const s of moriSetups) {
      if (s.feature_key === "ask") continue;
      const tools = AGENT_TOOLS[s.feature_key as keyof typeof AGENT_TOOLS];
      expect(s.instructions).toContain(`"mori": ${tools.join(", ")}.`);
    }
  });
});

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

import { orderCondition, writeSchemas } from "@/lib/mori-validation";

describe("Sell orders with photos", () => {
  it("routes the sell-order photo message to the Orders agent", () => {
    expect(routeMoriMessage("Here are photos of the front and back for my sell order.", true)).toBe(
      "order",
    );
  });
  it("accepts a condition read from the photos, per corner", () => {
    const ok = writeSchemas.set_order.safeParse({
      side: "sell",
      card_id: "me02-125",
      price_usd: 550,
      condition: {
        overall: "Near mint",
        centering: { front: "55/45", back: "60/40" },
        corners: { top_left: "Sharp", bottom_right: "Light whitening (back)" },
        edges: "Clean",
        surface: "No scratches visible",
      },
    });
    expect(ok.success).toBe(true);
  });
  it("needs an overall condition", () => {
    expect(orderCondition.safeParse({ edges: "Clean" }).success).toBe(false);
  });
});

describe("Bare card names are price checks", () => {
  it("sends just a card name and number to Price Check", () => {
    expect(routeMoriMessage("Mega Charizard X ex 125/094")).toBe("price");
    expect(routeMoriMessage("Umbreon VMAX 215/203")).toBe("price");
    expect(routeMoriMessage("Pikachu 58/102")).toBe("price");
    expect(routeMoriMessage("Charizard ex SV107/SV122")).toBe("price");
  });
  it("keeps other requests that mention a card number with their own agent", () => {
    expect(routeMoriMessage("Add Umbreon VMAX 215/203 to my collection")).toBe("add");
    expect(routeMoriMessage("Sell Mega Charizard X ex 125/094 for at least US$550")).toBe("order");
    expect(routeMoriMessage("Is Umbreon VMAX 215/203 a good card to chase?")).toBe("ask");
  });
});

import { replyParts } from "@/lib/mori-turn.server";

describe("Reply bubbles", () => {
  it("splits a multi-part reply on --- lines, one bubble each", () => {
    expect(replyParts("Shows in Sydney:\n• A\n---\nYour grading options:\n• PSA\n---\n")).toEqual([
      "Shows in Sydney:\n• A",
      "Your grading options:\n• PSA",
    ]);
  });
  it("keeps a single answer whole", () => {
    expect(replyParts("Here are the shows.\n• A - B")).toEqual(["Here are the shows.\n• A - B"]);
  });
});

describe("Team hand-off prompts", () => {
  // Every prompt an agent offers to hand work to a teammate must reach that teammate.
  const table: [string, string][] = [
    ["Price check this card", "price"],
    ["Which of my cards went up?", "price"],
    ["What is the next trendy collection?", "price"],
    ["Pre-grade this card", "grade"],
    ["Should I grade it?", "grade"],
    ["What does grading cost?", "grade"],
    ["Where can I send it for grading?", "grade"],
    ["Set a sell order for this card", "order"],
    ["Set a buy order for this card", "order"],
    ["Show my open orders", "order"],
    ["Add this card to my collection", "add"],
    ["Put this card in a binder", "add"],
    ["Can you build a binder from my collection?", "add"],
    ["Save a memory about this card", "memory"],
    ["Start a trade-up challenge", "tradeup"],
    ["What card should I chase next?", "ask"],
    ["When is the next card show near me?", "ask"],
    ["What trendy cards should I hunt?", "price"],
  ];
  it.each(table)("%s -> %s", (prompt, agent) => {
    expect(routeMoriMessage(prompt)).toBe(agent);
  });
});

import { cardInFocus } from "@/lib/mori-harness.server";

describe("Hand-off card in focus", () => {
  it("takes the card from the newest price card, even with no text reply", () => {
    expect(
      cardInFocus([
        { kind: "suggest", payload: { suggestions: ["Pre-grade this card"] } },
        {
          kind: "price",
          payload: {
            card: {
              id: "me02-125",
              name: "Mega Charizard X ex",
              number: "125",
              set: "Phantasmal Flames",
            },
          },
        },
        {
          kind: "status",
          payload: { name: "get_card_prices", output: { card: { id: "sv1-1", name: "Old" } } },
        },
      ]),
    ).toEqual({
      id: "me02-125",
      name: "Mega Charizard X ex",
      number: "125",
      set: "Phantasmal Flames",
    });
  });
  it("reads order cards and price lookups too", () => {
    expect(
      cardInFocus([
        {
          kind: "confirm",
          payload: {
            card: { tcgdex_id: "swsh7-215", name: "Umbreon VMAX", set_name: "Evolving Skies" },
          },
        },
      ]),
    ).toEqual({ id: "swsh7-215", name: "Umbreon VMAX", set: "Evolving Skies" });
    expect(
      cardInFocus([
        {
          kind: "status",
          payload: {
            name: "get_card_prices",
            output: { card: { id: "sv1-1", name: "Sprigatito", number: "13" } },
          },
        },
      ]),
    ).toEqual({ id: "sv1-1", name: "Sprigatito", number: "13" });
    expect(cardInFocus([{ kind: "text", payload: null }])).toBeNull();
  });
});

describe("cardPhotoDataUrls", () => {
  const jpg = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
  it("accepts one or two image data URLs", async () => {
    const { cardPhotoDataUrls } = await import("@/lib/mori-validation");
    expect(cardPhotoDataUrls([jpg])).toEqual([jpg]);
    expect(cardPhotoDataUrls([jpg, jpg.replace("jpeg", "png")])).toHaveLength(2);
  });
  it("rejects URLs, other types, too many or too large", async () => {
    const { cardPhotoDataUrls } = await import("@/lib/mori-validation");
    expect(cardPhotoDataUrls(["https://example.com/a.jpg"])).toBeNull();
    expect(cardPhotoDataUrls(["data:image/svg+xml;base64,PHN2Zz4="])).toBeNull();
    expect(cardPhotoDataUrls([jpg, jpg, jpg])).toBeNull();
    expect(cardPhotoDataUrls([])).toBeNull();
    expect(cardPhotoDataUrls("x")).toBeNull();
    expect(cardPhotoDataUrls(["data:image/jpeg;base64," + "A".repeat(2_000_000)])).toBeNull();
  });
});

describe("Collectr sync", () => {
  it("spots the sync message, its binder, and checks the link", async () => {
    const { collectrSyncLink, collectrSyncBinder, isCollectrLink } = await import("@/lib/collectr");
    const link =
      "https://app.getcollectr.com/showcase/profile/6b10e282-6452-49ef-ae2e-e36ff91945e4";
    expect(collectrSyncLink(`Sync my Collectr collection: ${link} into the binder "Fire"`)).toBe(
      link,
    );
    expect(
      collectrSyncBinder(`Sync my Collectr collection: ${link} into the binder "Fire"`),
    ).toEqual({ name: "Fire", new: false });
    expect(
      collectrSyncBinder(
        `Sync my Collectr collection: ${link} into a new binder called "From Collectr"`,
      ),
    ).toEqual({ name: "From Collectr", new: true });
    expect(collectrSyncLink("Price check: Pikachu 25/25")).toBeNull();
    expect(isCollectrLink(link)).toBe(true);
    expect(isCollectrLink("https://evil.example.com/getcollectr.com")).toBe(false);
    expect(isCollectrLink("http://app.getcollectr.com/x")).toBe(false);
  });
  it("reads the proposed cards from the answer and hides the json block", async () => {
    const { syncItems, syncAnswerText } = await import("@/lib/collectr");
    const answer =
      '## Status\nProposed.\n\n```json\n{"bindory_items":[{"name":"Umbreon VMAX","number":"215/203","set":"Evolving Skies","quantity":1},{"bad":1}]}\n```';
    expect(syncItems(answer)).toEqual([
      { name: "Umbreon VMAX", number: "215/203", set: "Evolving Skies", quantity: 1 },
    ]);
    expect(syncAnswerText(answer)).toBe("## Status\nProposed.");
    expect(syncItems("no block")).toEqual([]);
  });
  it("signs a task for one collector only", async () => {
    process.env["MORI_MCP_SECRET"] ??= "x".repeat(40);
    const { signTask, isOwnTask } = await import("@/lib/mori-mcp-auth.server");
    const sig = signTask("u1", "resp_1", "hsess_1");
    expect(isOwnTask("u1", "resp_1", "hsess_1", sig)).toBe(true);
    expect(isOwnTask("u2", "resp_1", "hsess_1", sig)).toBe(false);
    expect(isOwnTask("u1", "resp_2", "hsess_1", sig)).toBe(false);
  });
});

describe("Event tickets", () => {
  it("routes ticket requests to Ask Mori", async () => {
    const { routeMoriMessage } = await import("@/lib/mori-agents");
    expect(routeMoriMessage("Help me buy tickets for East Bay Card Show")).toBe("ask");
  });
  it("shows the organiser's ticket page with its options, never a bad link", async () => {
    const { executeMoriTool } = await import("@/lib/mori-execute.server");
    const ctx = { seenIds: null, message: "" } as never;
    const ok = await executeMoriTool(
      null as never,
      "u1",
      "show_tickets",
      {
        event: "East Bay Card Show",
        date: "Sat 28 - Sun 29 Nov",
        venue: "San Mateo County Event Center",
        ticket_url: "https://www.eventbrite.com/e/east-bay-card-show-tickets-1",
        options: [{ name: "Saturday Early Bird", price: "US$15" }, { price: "no name" }],
      },
      ctx,
    );
    expect(ok.rows[0]?.kind).toBe("tickets");
    expect((ok.rows[0]?.payload as { options: unknown[] }).options).toHaveLength(1);
    for (const ticket_url of [
      "javascript:alert(1)",
      "http://example.com/t",
      "https://demo.bindory.app/x",
    ]) {
      const bad = await executeMoriTool(
        null as never,
        "u1",
        "show_tickets",
        { event: "X", ticket_url, options: [] },
        ctx,
      );
      expect(bad.rows).toHaveLength(0);
    }
  });
});

describe("Answers to tap", () => {
  const fakeDb = () => {
    const saved: { kind: string; content: string; payload?: unknown }[] = [];
    const db = {
      from: () => ({
        insert: (rows: typeof saved) => {
          saved.push(...rows);
          return { select: async () => ({ data: rows, error: null }) };
        },
      }),
    };
    return { db: db as never, saved };
  };
  it("turns a Choices line into answers and drops the general suggestions", async () => {
    const { finishMoriTurn } = await import("@/lib/mori-turn.server");
    const { db, saved } = fakeDb();
    await finishMoriTurn(
      db,
      [],
      "Which day were you thinking?\nChoices: Saturday 28 Nov | Sunday 29 Nov | Both days: US$30 | Something else…",
      Date.now(),
      () => {},
    );
    expect(saved.find((r) => r.kind === "text")?.content).toBe("Which day were you thinking?");
    expect(saved.find((r) => r.kind === "choices")?.payload).toEqual({
      choices: ["Saturday 28 Nov", "Sunday 29 Nov", "Both days: US$30", "Something else…"],
    });
    expect(saved.some((r) => r.kind === "suggest")).toBe(false);
  });
  it("keeps Suggestions when no question was asked", async () => {
    const { finishMoriTurn } = await import("@/lib/mori-turn.server");
    const { db, saved } = fakeDb();
    await finishMoriTurn(
      db,
      [],
      "Done.\nSuggestions: Price check this card | Add it to a binder",
      Date.now(),
      () => {},
    );
    expect(saved.find((r) => r.kind === "suggest")?.payload).toEqual({
      suggestions: ["Price check this card", "Add it to a binder"],
    });
    expect(saved.some((r) => r.kind === "choices")).toBe(false);
  });
});

describe("Trade-up game", () => {
  it("gives each side a chance equal to its share of the value", async () => {
    const { winChances } = await import("@/lib/tradeup");
    const a = winChances(1000, 800);
    expect(a.host).toBeCloseTo(0.5556, 3);
    const b = winChances(1000, 1200);
    expect(b.host).toBeCloseTo(0.4545, 3);
    expect(winChances(1000, 0)).toEqual({ host: 0, guest: 0 });
  });
  it("draws from both secrets, repeatably, and is fair over many games", async () => {
    const { decide, drawFrom } = await import("@/lib/tradeup");
    const s1 = "a".repeat(64),
      s2 = "b".repeat(64);
    expect(drawFrom(s1, s2)).toBe(drawFrom(s1, s2));
    expect(drawFrom(s1, s2)).not.toBe(drawFrom(s2, s1));
    const { randomBytes } = await import("node:crypto");
    let hostWins = 0;
    const n = 20000;
    for (let i = 0; i < n; i++)
      if (
        decide(1000, 800, randomBytes(32).toString("hex"), randomBytes(32).toString("hex"))
          .winner === "host"
      )
        hostWins++;
    expect(hostWins / n).toBeGreaterThan(0.54);
    expect(hostWins / n).toBeLessThan(0.571);
  });
  it("only accepts 64-hex secrets and makes 6-digit codes", async () => {
    const { isSecret, joinCode } = await import("@/lib/tradeup");
    expect(isSecret("f".repeat(64))).toBe(true);
    expect(isSecret("x".repeat(64))).toBe(false);
    expect(joinCode()).toMatch(/^\d{6}$/);
  });
});

describe("Trade-up memory request", () => {
  it("goes to Mori Memories even though it mentions a trade-up and prices", async () => {
    const { routeMoriMessage } = await import("@/lib/mori-agents");
    expect(
      routeMoriMessage(
        "Help me save a memory of this trade-up game. I put in Sylveon V 74 (Evolving Skies), Espeon VMAX 65 (Evolving Skies), Lunatone 062 (Crown Zenith) (US$21.25); the other player put in Mega Charizard X ex 125 (Phantasmal Flames) (US$504.71). My chance was 4.0% and they won, so I handed over my cards. Use only these cards: the card I gave is Espeon VMAX 65. Do not attach any other card.",
      ),
    ).toBe("memory");
  });
});

describe("Trade-up options A and B", () => {
  it("sets B's chance so the trade is fair on average", async () => {
    const { optionBChance } = await import("@/lib/tradeup");
    expect(optionBChance(1000, 800, 1200)).toBeCloseTo(0.5, 6);
    expect(optionBChance(1000, 800, 1300)).toBeCloseTo(0.4, 6);
    expect(optionBChance(1000, 1000, 1200)).toBeNull();
    expect(optionBChance(1000, 800, 900)).toBeNull();
  });
  it("gives the starter B about as often as its chance", async () => {
    const { decideOption } = await import("@/lib/tradeup");
    const { randomBytes } = await import("node:crypto");
    let b = 0;
    const n = 20000;
    for (let i = 0; i < n; i++)
      if (
        decideOption(
          1000,
          800,
          1300,
          randomBytes(32).toString("hex"),
          randomBytes(32).toString("hex"),
        ).option === "b"
      )
        b++;
    expect(b / n).toBeGreaterThan(0.385);
    expect(b / n).toBeLessThan(0.415);
  });
});

describe("Local currency", () => {
  it("routes orders priced in any currency to Mori Orders", async () => {
    const { routeMoriMessage } = await import("@/lib/mori-agents");
    expect(routeMoriMessage("Buy Umbreon VMAX 215/203 for up to A$680")).toBe("order");
    expect(routeMoriMessage("Sell Charizard 4/102 for at least £300")).toBe("order");
    expect(routeMoriMessage("Buy Pikachu 25 for up to US$20")).toBe("order");
  });
  it("maps countries to currency and eBay site, US by default", async () => {
    const { marketFor, money } = await import("@/lib/market");
    expect(marketFor("au")).toMatchObject({ currency: "AUD", symbol: "A$", ebay: "ebay.com.au" });
    expect(marketFor("GB").ebay).toBe("ebay.co.uk");
    expect(marketFor("ZZ").currency).toBe("USD");
    expect(money(1234.5, marketFor("AU"))).toBe("A$1,235");
    expect(money(12.5, marketFor("AU"))).toBe("A$12.50");
  });
});

describe("Local eBay sold prices", () => {
  it("sorts sales by title into raw, PSA 9 and PSA 10, leaving the rest out", async () => {
    process.env["APIFY_TOKEN"] ??= "";
    const { classifySale, summarise } = await import("@/lib/ebay-sold.server");
    const { MARKETS } = await import("@/lib/market");
    expect(
      classifySale("Mega Charizard X EX 125/094 Special Illustration Rare PSA 10 GEM MINT", "125"),
    ).toBe("psa10");
    expect(classifySale("2025 Pokemon PFL Mega Charizard X ex #125/094 PSA 9", "125")).toBe("psa9");
    expect(classifySale("Mega Charizard X ex 125/094 - Graded BGS 9", "125")).toBeNull();
    expect(classifySale("Mega Charizard X ex 125/094 TAG 10", "125")).toBeNull();
    expect(classifySale("Pikachu & Zekrom GX TAG TEAM 184/181", "184")).toBe("raw");
    expect(classifySale("Mega Charizard X ex 125/094 lot of 3", "125")).toBeNull();
    expect(classifySale("Mega Charizard X ex Japanese 125", "125")).toBeNull();
    expect(classifySale("Mega Charizard X ex 013/094", "125")).toBeNull();
    const s = summarise(
      [
        {
          title: "Mega Charizard X ex 125/094",
          soldPrice: "680",
          soldCurrency: "AUD",
          endedAt: "2026-11-26",
        },
        {
          title: "Mega Charizard X ex 125/094",
          soldPrice: "700",
          soldCurrency: "AUD",
          endedAt: "2026-11-25",
        },
        {
          title: "Mega Charizard X ex 125/094",
          soldPrice: "720",
          soldCurrency: "AUD",
          endedAt: "2026-11-24",
        },
        {
          title: "Mega Charizard X ex 125 PSA 10",
          soldPrice: "1700",
          soldCurrency: "AUD",
          endedAt: "2026-11-26",
        },
        {
          title: "Mega Charizard X ex 125/094",
          soldPrice: "500",
          soldCurrency: "USD",
          endedAt: "2026-11-26",
        },
      ],
      "125",
      MARKETS["AU"]!,
    );
    expect(s.raw).toMatchObject({ avg_last_3: 700, avg_last_5: 700, n: 3, status: "ok" });
    expect(s.psa10).toMatchObject({ avg_last_3: 1700, avg_last_5: 1700, n: 1, status: "thin" });
    expect(s.psa9.status).toBe("none");
  });
});

describe("Last 3 and last 5 sold averages", () => {
  it("averages the newest 3 and newest 5 sales", async () => {
    const { stat } = await import("@/lib/ebay-sold.server");
    const r = stat([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 999]);
    expect(r.avg_last_3).toBe(20);
    expect(r.avg_last_5).toBe(30);
    expect(r.n).toBe(5);
  });
  it("asks the actor for one raw-only search of 3 on the collector's site", async () => {
    const { actorInput } = await import("@/lib/ebay-sold.server");
    const { MARKETS } = await import("@/lib/market");
    const input = actorInput({ name: "Umbreon ex", number: "161" }, MARKETS["AU"]!);
    expect(input.keywords).toHaveLength(1);
    expect(input.keywords[0]).toMatch(/^Umbreon ex 161 -custom -proxy .*-psa .*-graded/);
    expect(input).toMatchObject({
      ebaySite: "ebay.com.au",
      categoryId: "183454",
      conditionId: 4000,
      count: 3,
      aspectFilter: { "Card Condition": "Near Mint or Better" },
    });
    expect(
      actorInput({ name: "Umbreon ex", number: "161" }, MARKETS["AU"]!, "lp").aspectFilter,
    ).toEqual({ "Card Condition": "Lightly Played (Excellent)" });
  });
  it("never excludes Full Art or TAG TEAM cards", async () => {
    const { actorInput, classifySale } = await import("@/lib/ebay-sold.server");
    const { MARKETS } = await import("@/lib/market");
    const k = actorInput({ name: "Umbreon ex", number: "161" }, MARKETS["AU"]!).keywords[0]!;
    expect(k).not.toMatch(/-art\b|-tag\b/);
    expect(
      classifySale("Umbreon ex 161/131 Prismatic Evolutions Full Art Holo Ultra Rare", "161"),
    ).toBe("raw");
  });
  it("keeps only sales from the collector's own country", async () => {
    const { actorInput, isDomestic, summarise } = await import("@/lib/ebay-sold.server");
    const { MARKETS } = await import("@/lib/market");
    const au = MARKETS["AU"]!;
    expect(actorInput({ name: "Umbreon ex", number: "161" }, au)).toMatchObject({
      ebaySite: "ebay.com.au",
      sellerCountry: "AU",
      daysToScrape: 90,
    });
    expect(isDomestic(null, au)).toBe(true);
    expect(isDomestic("Australia", au)).toBe(true);
    expect(isDomestic("United States", au)).toBe(false);
    expect(isDomestic("United Kingdom", MARKETS["GB"]!)).toBe(true);
    const sale = (p: string, d: string, loc: string | null) => ({
      title: "Umbreon ex 161/131",
      soldPrice: p,
      soldCurrency: "AUD",
      endedAt: d,
      itemLocation: loc,
    });
    const r = summarise(
      [
        sale("1300", "2026-11-26", null),
        sale("2000", "2026-11-25", "United States"),
        sale("1500", "2026-11-24", null),
      ],
      "161",
      au,
    );
    expect(r.raw).toMatchObject({ n: 2, avg_last_5: 1400 });
  });
  it("reads the collector's condition and keeps only that condition's sales", async () => {
    const { toCondition, titleCondition, summarise } = await import("@/lib/ebay-sold.server");
    const { MARKETS } = await import("@/lib/market");
    expect(toCondition("lightly_played")).toBe("lp");
    expect(toCondition("LP")).toBe("lp");
    expect(toCondition("Near mint or better")).toBe("nm");
    expect(toCondition("heavily_played")).toBe("hp");
    expect(toCondition("moderately played")).toBe("mp");
    expect(toCondition("whatever")).toBeNull();
    expect(titleCondition("LP Umbreon EX 161/131")).toBe("lp");
    expect(titleCondition("Umbreon ex 161/131 NM Near Mint SIR")).toBe("nm");
    expect(titleCondition("Umbreon ex 161/131 Prismatic Evolutions")).toBeNull();
    const sale = (p: string, d: string, t: string) => ({
      title: t,
      soldPrice: p,
      soldCurrency: "AUD",
      endedAt: d,
    });
    const sales = [
      sale("1500", "2026-11-26", "Umbreon ex 161/131 Prismatic"),
      sale("1300", "2026-11-25", "LP Umbreon ex 161/131"),
      sale("1700", "2026-11-24", "Umbreon ex 161/131 NM"),
    ];
    expect(summarise(sales, "161", MARKETS["AU"]!, "lp").raw).toMatchObject({
      n: 2,
      avg_last_5: 1400,
    });
    expect(summarise(sales, "161", MARKETS["AU"]!, "nm").raw).toMatchObject({
      n: 2,
      avg_last_5: 1600,
    });
  });
  it("leaves out sales far below the rest, like a custom or metal card", async () => {
    const { summarise } = await import("@/lib/ebay-sold.server");
    const { MARKETS } = await import("@/lib/market");
    const sale = (p: string, d: string, t = "Umbreon ex 161/131 Prismatic Evolutions") => ({
      title: t,
      soldPrice: p,
      soldCurrency: "AUD",
      endedAt: d,
    });
    const r = summarise(
      [
        sale("1500", "2026-11-26"),
        sale("1600", "2026-11-25"),
        sale("8.95", "2026-11-24", "Umbreon 161/131 holo card"),
        sale("1400", "2026-11-23"),
      ],
      "161",
      MARKETS["AU"]!,
    );
    expect(r.raw).toMatchObject({ n: 3, avg_last_3: 1500 });
  });
});

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
  it("estimates import fees by the collector's country, none at home or within the EU", async () => {
    const { MARKETS, importFeeRate } = await import("@/lib/market");
    expect(importFeeRate(MARKETS["AU"]!, "United States")).toBe(0.125);
    expect(importFeeRate(MARKETS["AU"]!, null)).toBe(0);
    expect(importFeeRate(MARKETS["AU"]!, "Australia")).toBe(0);
    expect(importFeeRate(MARKETS["GB"]!, "United States")).toBe(0.2);
    expect(importFeeRate(MARKETS["DE"]!, "France")).toBe(0);
    expect(importFeeRate(MARKETS["DE"]!, "United Kingdom")).toBe(0.19);
  });
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
