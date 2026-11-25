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
import { answerText, parseSSE } from "@/lib/harnessrouter.server";
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
  it("has one harness per agent in harnessrouter.json", () => {
    const keys = handoff.setups.map((s) => s.feature_key).sort();
    expect(keys).toEqual([...MORI_AGENTS].sort());
    expect(new Set(handoff.setups.map((s) => s.harness_id)).size).toBe(MORI_AGENTS.length);
  });
  it("limits specialists to their own tools", () => {
    expect(agentMayUse("memory", "save_memory")).toBe(true);
    expect(agentMayUse("memory", "set_order")).toBe(false);
    expect(agentMayUse("price", "add_card_to_collection")).toBe(false);
    expect(agentMayUse("ask", "set_order")).toBe(true);
  });
  it("tells each specialist exactly the tools it may call", () => {
    for (const s of handoff.setups) {
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

import { replyParts } from "@/lib/mori-agent.server";

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
