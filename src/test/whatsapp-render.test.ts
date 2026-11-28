import { describe, expect, it } from "vitest";
import type { Json } from "@/integrations/supabase/types";
import { PHOTO_INSTRUCTIONS } from "@/lib/mori-order.server";
import { paymentReminder } from "@/lib/mori-order-payment.server";
import type { MoriRow } from "@/lib/mori-tools";
import {
  WHATSAPP_LIMITS,
  buttonMessage,
  linkMessage,
  listMessage,
  renderWhatsApp,
  textMessage,
  type WhatsAppMessage,
} from "@/lib/whatsapp-render";

const row = (
  kind: string,
  content = "",
  payload: unknown = null,
  overrides: Partial<MoriRow> = {},
): MoriRow => ({
  id: "row-1",
  role: "mori",
  kind,
  content,
  payload: payload as Json | null,
  ...overrides,
});

function assertWireShape(msg: WhatsAppMessage) {
  expect(msg).not.toHaveProperty("messaging_product");
  expect(msg).not.toHaveProperty("recipient_type");
  expect(msg).not.toHaveProperty("to");
  expect(msg).not.toHaveProperty("recipient");
  if (msg.type === "text") {
    expect(msg.text.body.length).toBeGreaterThan(0);
    expect(msg.text.body.length).toBeLessThanOrEqual(WHATSAPP_LIMITS.textBody);
  } else if (msg.type === "image") {
    expect(msg.image.link).toMatch(/^https:\/\//);
    if (msg.image.caption !== undefined) {
      expect(msg.image.caption.length).toBeLessThanOrEqual(WHATSAPP_LIMITS.imageCaption);
    }
  } else if (msg.type === "interactive") {
    expect(msg.interactive.body.text.length).toBeGreaterThan(0);
    expect(msg.interactive.body.text.length).toBeLessThanOrEqual(WHATSAPP_LIMITS.interactiveBody);
    if (msg.interactive.footer) {
      expect(msg.interactive.footer.text.length).toBeLessThanOrEqual(WHATSAPP_LIMITS.footer);
    }
    if (msg.interactive.type === "button") {
      const buttons = msg.interactive.action.buttons;
      expect(buttons.length).toBeGreaterThan(0);
      expect(buttons.length).toBeLessThanOrEqual(WHATSAPP_LIMITS.buttonMax);
      const titles = buttons.map((b) => b.reply.title.toLowerCase());
      expect(new Set(titles).size).toBe(titles.length);
      for (const b of buttons) {
        expect(b.reply.id.length).toBeGreaterThan(0);
        expect(b.reply.id.length).toBeLessThanOrEqual(WHATSAPP_LIMITS.buttonId);
        expect(b.reply.title.length).toBeGreaterThan(0);
        expect(b.reply.title.length).toBeLessThanOrEqual(WHATSAPP_LIMITS.buttonTitle);
      }
    } else if (msg.interactive.type === "list") {
      expect(msg.interactive.action.button.length).toBeLessThanOrEqual(WHATSAPP_LIMITS.listButton);
      const rows = msg.interactive.action.sections.flatMap((s) => s.rows);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.length).toBeLessThanOrEqual(WHATSAPP_LIMITS.listMaxRows);
      for (const s of msg.interactive.action.sections) {
        if (s.title) expect(s.title.length).toBeLessThanOrEqual(WHATSAPP_LIMITS.listSectionTitle);
      }
      for (const r of rows) {
        expect(r.id.length).toBeGreaterThan(0);
        expect(r.id.length).toBeLessThanOrEqual(WHATSAPP_LIMITS.listRowId);
        expect(r.title.length).toBeGreaterThan(0);
        expect(r.title.length).toBeLessThanOrEqual(WHATSAPP_LIMITS.listRowTitle);
        if (r.description) {
          expect(r.description.length).toBeLessThanOrEqual(WHATSAPP_LIMITS.listRowDescription);
        }
      }
    } else {
      expect(msg.interactive.action.parameters.display_text.length).toBeLessThanOrEqual(
        WHATSAPP_LIMITS.ctaDisplayText,
      );
      expect(msg.interactive.action.parameters.url).toMatch(/^https:\/\//);
    }
  }
}

describe("WhatsApp constructors & wire limits", () => {
  it("supports template union shape without envelope keys", () => {
    const tpl: WhatsAppMessage = {
      type: "template",
      template: { name: "bindory_hello", language: { code: "en_US" } },
    };
    assertWireShape(tpl);
    expect(tpl.type).toBe("template");
  });

  it("enforces button limits, deduplicates titles, and drops invalid/oversized IDs", () => {
    const msg = buttonMessage("Pick one", [
      { id: "   ", title: "Dropped blank" },
      { id: "x".repeat(257), title: "Dropped too long" },
      { id: "a", title: "Same button" },
      { id: "a", title: "Duplicate id dropped" },
      { id: "b", title: "Same button" },
      { id: "c", title: "Third" },
      { id: "d", title: "Fourth dropped" },
    ]);
    assertWireShape(msg);
    if (msg.type !== "interactive" || msg.interactive.type !== "button")
      throw new Error("expected button");
    expect(msg.interactive.action.buttons.map((b) => b.reply)).toEqual([
      { id: "a", title: "Same button" },
      { id: "b", title: "Same button 2" },
      { id: "c", title: "Third" },
    ]);
  });

  it("throws when buttonMessage or listMessage has no valid IDs left", () => {
    expect(() => buttonMessage("Body", [{ id: "", title: "No id" }])).toThrow();
    expect(() => buttonMessage("Body", [{ id: "x".repeat(257), title: "Too long" }])).toThrow();
    expect(() =>
      listMessage("Body", "Pick", [{ id: "x".repeat(201), title: "Too long" }]),
    ).toThrow();
  });

  it("enforces list limits, drops invalid row IDs, and caps at 10 rows", () => {
    const rows = [
      { id: "", title: "Blank id dropped" },
      { id: "z".repeat(201), title: "Long id dropped" },
      ...Array.from({ length: 12 }, (_, i) => ({
        id: `item-${i}`,
        title: `Row ${i + 1}`,
        description: `Details for item ${i + 1}`,
      })),
    ];
    const msg = listMessage("Choose a card", "Choose an option now!", rows, {
      sectionTitle: "Very long section heading here",
      footer: "Footer ".repeat(15),
    });
    assertWireShape(msg);
    if (msg.type !== "interactive" || msg.interactive.type !== "list")
      throw new Error("expected list");
    expect(msg.interactive.action.sections[0]!.rows).toHaveLength(10);
    expect(msg.interactive.action.sections[0]!.rows[0]!.id).toBe("item-0");
    expect(msg.interactive.action.sections[0]!.rows[9]!.id).toBe("item-9");
  });

  it("validates https URLs in linkMessage", () => {
    const msg = linkMessage(
      "Open Bindory to continue",
      "Open Bindory web app now",
      "https://bindory.app/orders",
    );
    assertWireShape(msg);
    if (msg.type !== "interactive" || msg.interactive.type !== "cta_url")
      throw new Error("expected link");
    expect(msg.interactive.action.parameters.url).toBe("https://bindory.app/orders");
    expect(msg.interactive.action.parameters.display_text.length).toBeLessThanOrEqual(20);

    expect(() => linkMessage("Hi", "Go", "http://bindory.app")).toThrow();
    expect(() => linkMessage("Hi", "Go", "https://private@bindory.app")).toThrow();
    expect(() => linkMessage("Hi", "Go", "javascript:alert(1)")).toThrow();
    expect(() => linkMessage("Hi", "Go", "not a url")).toThrow();
  });

  it("never cuts prices, card numbers, grades, percentages, or surrogate pairs mid-token", () => {
    const titleOf = (raw: string) => {
      const m = buttonMessage("Pick", [{ id: "1", title: raw }]);
      if (m.type !== "interactive" || m.interactive.type !== "button") throw new Error();
      return m.interactive.action.buttons[0]!.reply.title;
    };

    // Whole price fits within 20 chars -> stays intact.
    expect(titleOf("Buy at US$1,250.50 now")).toBe("Buy at US$1,250.50…");
    // Budget lands mid-price -> backs off before price and strips dangling preposition.
    expect(titleOf("Buy card at US$1,250.50 now")).toBe("Buy card…");
    // Budget lands mid-"125 USD" -> backs off before numeric token.
    expect(titleOf("Offer around 125 USD now")).toBe("Offer around…");
    // Budget lands mid-decimal grade ("9.5") -> never shows misleading "9…".
    expect(titleOf("Likely PSA grade 9.5 card")).toBe("Likely PSA grade…");
    // Budget lands mid-percentage ("68.5%") -> never shows misleading "68…".
    expect(titleOf("Grade chance of 68.5% now")).toBe("Grade chance…");
    // Budget lands mid-card-number ("125/094") -> never cuts the fraction.
    expect(titleOf("Charizard ex 125/094 alt")).toBe("Charizard ex…");

    // Surrogate pair boundary check: emoji takes 2 UTF-16 code units.
    const t5 = titleOf(`${"a".repeat(18)}🔥🔥`);
    expect(t5.length).toBeLessThanOrEqual(20);
    expect(() => encodeURIComponent(t5)).not.toThrow();
  });
});

describe("renderWhatsApp core flows", () => {
  it("ignores user and status rows, formats markdown, coalesces text, and splits >4096 chars", () => {
    const longPara = "Charizard ex is moving up. ".repeat(200);
    const msgs = renderWhatsApp([
      row("text", "User message", null, { role: "user" }),
      row("status", "Checking recent market prices"),
      row(
        "text",
        "**Charizard** from *Obsidian Flames*\n- Item one\n- [Check](https://bindory.app)",
      ),
      row("text", "Second paragraph."),
    ]);
    expect(msgs).toHaveLength(1);
    assertWireShape(msgs[0]!);
    if (msgs[0]!.type !== "text") throw new Error("expected text");
    expect(msgs[0]!.text.body).toContain("*Charizard* from _Obsidian Flames_");
    expect(msgs[0]!.text.body).toContain("• Item one");
    expect(msgs[0]!.text.body).toContain("Check (https://bindory.app)");
    expect(msgs[0]!.text.body).toContain("Second paragraph.");

    const split = renderWhatsApp([row("text", longPara)]);
    expect(split.length).toBeGreaterThan(1);
    for (const m of split) assertWireShape(m);
  });

  it("renders price row with listings, import fees, sales, and folds into suggest as one message", () => {
    const pricePayload = {
      card: {
        id: "sv03-125",
        name: "Charizard ex",
        number: "125",
        set: "Obsidian Flames",
        rarity: "Special illustration rare",
        image: "https://assets.tcgdex.net/en/sv/sv03/125/low.png",
      },
      market: { currency: "AUD", symbol: "A$", ebay: "ebay.com.au", country: "Australia" },
      headline: 145,
      listings: {
        world: {
          price: 110,
          shipping: 15,
          total: 140.63,
          import_fees: 15.63,
          from: "United States",
        },
        local: { price: 145, shipping: 10, total: 155, import_fees: 0 },
        read: true,
      },
      sold: { raw: { avg_last_3: 138, sales: 2 }, condition: "Near mint" },
    };

    // Price + suggest folds into a single interactive list message (no separate image message).
    const withSuggest = renderWhatsApp([
      row("text", "Here is what **Charizard ex** is going for in Australia."),
      row("price", "Price check: Charizard ex 125", pricePayload, { id: "p1" }),
      row(
        "suggest",
        "",
        { suggestions: ["Set a buy order for this card", "Check lightly played prices"] },
        { id: "s1" },
      ),
    ]);
    expect(withSuggest).toHaveLength(1);
    assertWireShape(withSuggest[0]!);
    const m = withSuggest[0]!;
    if (m.type !== "interactive" || m.interactive.type !== "list") throw new Error("expected list");
    expect(m.interactive.body.text).toContain("*Charizard ex 125* · A$145");
    expect(m.interactive.body.text).toContain("Listing and Sold · Near mint");
    expect(m.interactive.body.text).toContain(
      "Lowest listing (worldwide): A$140.63 (from United States, incl. postage + est. import tax & fees)",
    );
    expect(m.interactive.body.text).toContain("Lowest listing (Australia): A$155 (incl. postage)");
    expect(m.interactive.body.text).toContain("Last 3 sold (Australia): A$138 (2 sales)");
    expect(m.interactive.action.sections[0]!.rows.map((r) => r.id)).toEqual([
      "suggest:s1:0",
      "suggest:s1:1",
    ]);

    // Standalone price with valid TCGdex image emits an image message with caption.
    const standalone = renderWhatsApp([row("price", "", pricePayload, { id: "p2" })]);
    expect(standalone).toHaveLength(1);
    assertWireShape(standalone[0]!);
    expect(standalone[0]!.type).toBe("image");
    if (standalone[0]!.type === "image") {
      expect(standalone[0]!.image.link).toBe("https://assets.tcgdex.net/en/sv/sv03/125/low.png");
      expect(standalone[0]!.image.caption).toContain("*Charizard ex 125* · A$145");
    }
  });

  it("distinguishes read:false from None listed and supports legacy scale price rows", () => {
    const unread = renderWhatsApp([
      row("price", "", {
        card: { name: "Pikachu", number: "025" },
        market: { symbol: "US$", country: "United States" },
        listings: { world: null, local: null, read: false },
        sold: { raw: {} },
      }),
    ]);
    if (unread[0]!.type !== "text") throw new Error("expected text");
    expect(unread[0]!.text.body).toContain("Lowest listing (worldwide): –");
    expect(unread[0]!.text.body).toContain("Last 3 sold (United States): No recent sales");

    const legacy = renderWhatsApp([
      row("price", "", {
        card: { name: "Umbreon VMAX" },
        scale: { low: 820, market: 900, mid: 880 },
        sold: { raw: { avg_last_5: 870 } },
      }),
    ]);
    if (legacy[0]!.type !== "text") throw new Error("expected text");
    expect(legacy[0]!.text.body).toContain("Lowest listing: US$820");
    expect(legacy[0]!.text.body).toContain("Market price: US$900");
    expect(legacy[0]!.text.body).toContain("Recent sales (your country): US$870");
  });

  it("renders set_order confirm with Save / Change details, no Watching line, and sell condition/photos", () => {
    const buyMsgs = renderWhatsApp([
      row(
        "confirm",
        "",
        {
          tool: "set_order",
          status: "pending",
          side: "buy",
          card: {
            tcgdex_id: "sv03-125",
            name: "Charizard ex",
            set_name: "Obsidian Flames",
            image: "https://assets.tcgdex.net/en/sv/sv03/125/high.png",
          },
          price_usd: 500,
          price: { amount: 750, currency: "AUD" },
          market_reference: { amount: 800, currency: "AUD" },
          note: "Clean corners only",
        },
        { id: "ord-42" },
      ),
    ]);
    expect(buyMsgs).toHaveLength(1);
    assertWireShape(buyMsgs[0]!);
    const m = buyMsgs[0]!;
    if (m.type !== "interactive" || m.interactive.type !== "button")
      throw new Error("expected button");
    expect(m.interactive.header).toEqual({
      type: "image",
      image: { link: "https://assets.tcgdex.net/en/sv/sv03/125/high.png" },
    });
    expect(m.interactive.body.text).toContain("*Buy order*");
    expect(m.interactive.body.text).toContain("Buy for up to: A$750");
    expect(m.interactive.body.text).toContain("US$ equivalent: US$500");
    expect(m.interactive.body.text).toContain(
      "Market comparison: Your target is below the market reference of A$800.",
    );
    expect(m.interactive.body.text).not.toContain("Watching:");
    expect(m.interactive.body.text).toContain("Note: Clean corners only");
    expect(m.interactive.action.buttons.map((b) => b.reply)).toEqual([
      { id: "save:ord-42", title: "Save" },
      { id: "edit:ord-42", title: "Change details" },
    ]);

    const sellMsgs = renderWhatsApp([
      row(
        "confirm",
        "",
        {
          tool: "set_order",
          status: "pending",
          side: "sell",
          card: { tcgdex_id: "sv03-125", name: "Charizard ex" },
          price_usd: 120,
          market_reference: null,
          condition: { overall: "Near mint" },
          photos: { front: "uid/front.jpg", back: "uid/back.jpg" },
        },
        { id: "sell-7" },
      ),
    ]);
    if (sellMsgs[0]!.type !== "interactive" || sellMsgs[0]!.interactive.type !== "button")
      throw new Error();
    expect(sellMsgs[0]!.interactive.header).toBeUndefined();
    expect(sellMsgs[0]!.interactive.body.text).toContain("Sell for at least: US$120");
    expect(sellMsgs[0]!.interactive.body.text).toContain(
      "Market comparison: No market reference is available.",
    );
    expect(sellMsgs[0]!.interactive.body.text).toContain("Condition: Near mint");
    expect(sellMsgs[0]!.interactive.body.text).toContain(
      "Photos: Front and back, saved for your listing",
    );
    expect(sellMsgs[0]!.interactive.body.text).not.toContain("uid/front.jpg");
  });

  it("renders save_memory confirm (trade pair, long story split, and confirmed status)", () => {
    const tradeMsgs = renderWhatsApp([
      row(
        "confirm",
        "",
        {
          tool: "save_memory",
          status: "pending",
          title: "Sydney card show trade",
          story: "Swapped my duplicate Lugia for a clean Charizard.",
          with_whom: "Sam",
          place: "Sydney",
          date: "2026-05-14",
          traded_card: { tcgdex_id: "swsh12-186", name: "Lugia V" },
          card: { tcgdex_id: "sv03-125", name: "Charizard ex" },
        },
        { id: "mem-1" },
      ),
    ]);
    expect(tradeMsgs).toHaveLength(1);
    assertWireShape(tradeMsgs[0]!);
    const m = tradeMsgs[0]!;
    if (m.type !== "interactive" || m.interactive.type !== "button")
      throw new Error("expected button");
    expect(m.interactive.body.text).toContain("Traded: Lugia V → Charizard ex");
    expect(m.interactive.body.text).toContain("When: May 14, 2026");
    expect(m.interactive.action.buttons.map((b) => b.reply)).toEqual([
      { id: "save:mem-1", title: "Confirm" },
      { id: "edit:mem-1", title: "Change details" },
    ]);

    // Long story (>1024 chars) emits full story first, then compact confirmation buttons.
    const longStory = "We spent the whole afternoon trading binders. ".repeat(30);
    const longMsgs = renderWhatsApp([
      row(
        "confirm",
        "",
        {
          tool: "save_memory",
          status: "pending",
          title: "Big weekend trade",
          story: longStory,
        },
        { id: "mem-2" },
      ),
    ]);
    expect(longMsgs).toHaveLength(2);
    assertWireShape(longMsgs[0]!);
    assertWireShape(longMsgs[1]!);
    expect(longMsgs[0]!.type).toBe("text");
    if (longMsgs[0]!.type === "text") expect(longMsgs[0]!.text.body).toContain(longStory.trim());
    if (longMsgs[1]!.type !== "interactive" || longMsgs[1]!.interactive.type !== "button")
      throw new Error();
    expect(longMsgs[1]!.interactive.body.text).toContain("Save the memory “Big weekend trade”");

    // Confirmed proposal renders as plain text with Saved and no buttons.
    const confirmed = renderWhatsApp([
      row(
        "confirm",
        "",
        {
          tool: "add_to_wishlist",
          status: "confirmed",
          card: { tcgdex_id: "base1-4", name: "Charizard" },
        },
        { id: "w-1" },
      ),
    ]);
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]!.type).toBe("text");
    if (confirmed[0]!.type === "text") {
      expect(confirmed[0]!.text.body).toContain("Add Charizard to your wishlist");
      expect(confirmed[0]!.text.body).toContain("Saved");
    }
  });

  it("renders grade report with outcomes, take, subgrades, raw price, and disclaimer", () => {
    const msgs = renderWhatsApp([
      row("grade", "", {
        card: "Charizard ex 125/094",
        outcomes: [
          { grade: 10, probability: 6, reason: "Centering is outside 55/45" },
          { grade: 9, probability: 68, reason: "Clean corners and surface" },
          { grade: 8, probability: 26, reason: "Light corner whitening" },
        ],
        take: "Worth sending. A 9 is the likely result.",
        confidence: 91,
        subgrades: {
          centering: { psa: 86, cgc: 87, bgs: 85, tag: 88 },
          corners: { psa: 84, cgc: 85, bgs: 82, tag: 86 },
        },
        overall: { psa: 9, cgc: 9, bgs: 8.5, tag: 9 },
        raw_price: { amount: 145, currency: "AUD" },
        notes: "60/40 back · light corner whitening",
      }),
      row("suggest", "", { suggestions: ["Grading cost?", "Price check"] }, { id: "g-sug" }),
    ]);
    expect(msgs).toHaveLength(1);
    assertWireShape(msgs[0]!);
    const m = msgs[0]!;
    if (m.type !== "interactive" || m.interactive.type !== "button")
      throw new Error("expected button");
    expect(m.interactive.body.text).toContain("*Should I grade?* · Charizard ex 125/094");
    expect(m.interactive.body.text).toContain("*9 (Mint)* — 68% · Most likely outcome");
    expect(m.interactive.body.text).toContain(
      "Mori’s take: Worth sending. A 9 is the likely result.",
    );
    expect(m.interactive.body.text).toContain("Raw price: A$145");
    expect(m.interactive.body.text).toContain("Subgrade report · Confidence 91%");
    expect(m.interactive.body.text).toContain("Centering: PSA 86% · CGC 87% · BGS 85% · TAG 88%");
    expect(m.interactive.body.text).toContain("Grade: PSA 9 · CGC 9 · BGS 8.5 · TAG 9");
    expect(m.interactive.body.text).toContain("Estimates from your photos, not official grades.");
    expect(m.interactive.action.buttons.map((b) => b.reply)).toEqual([
      { id: "suggest:g-sug:0", title: "Grading cost?" },
      { id: "suggest:g-sug:1", title: "Price check" },
    ]);
  });

  it("renders orders without duplicating paymentReminder and points to Bindory", () => {
    const msgs = renderWhatsApp([
      row("orders", "2 orders", {
        orders: [
          {
            id: "o1",
            side: "buy",
            card_name: "Charizard ex",
            price_usd: 120,
            status: "open",
            expires_at: "2026-12-15T00:00:00Z",
          },
          {
            id: "o2",
            side: "sell",
            card_name: "Pikachu",
            price_usd: 45.5,
            status: "pending",
          },
        ],
      }),
    ]);
    expect(msgs).toHaveLength(1);
    assertWireShape(msgs[0]!);
    if (msgs[0]!.type !== "text") throw new Error("expected text");
    expect(msgs[0]!.text.body).toContain(
      "• *Charizard ex* — Buy order, Up to US$120 (Open · expires December 15, 2026)",
    );
    expect(msgs[0]!.text.body).toContain(
      "• *Pikachu* — Sell order, At least US$45.50 (Pending payment)",
    );
    expect(msgs[0]!.text.body).not.toContain(paymentReminder);
    expect(msgs[0]!.text.body).toContain("Open Bindory to manage or cancel orders.");
  });
  it("does not infer an active order from a missing or unknown status", () => {
    const msgs = renderWhatsApp([
      row("orders", "", {
        orders: [
          { card_name: "A", price_usd: 2 },
          { card_name: "B", price_usd: 1, status: "other" },
        ],
      }),
    ]);
    expect(JSON.stringify(msgs)).not.toContain("(Open");
    expect(JSON.stringify(msgs).match(/Status unavailable/g)).toHaveLength(2);
  });
  it("caps unusually long answers without showing approval for omitted details", () => {
    const msgs = renderWhatsApp([
      row("text", "long paragraph. ".repeat(2000)),
      row("confirm", "", {
        tool: "save_memory",
        status: "pending",
        title: "Memory",
        story: "Long memory",
      }),
    ]);
    expect(msgs).toHaveLength(3);
    expect(msgs.at(-1)).toEqual(textMessage("Open Bindory to view the rest."));
    expect(msgs.every((m) => m.type === "text")).toBe(true);
  });

  it("renders photos row with PHOTO_INSTRUCTIONS and deduplicates if already stated", () => {
    const standalone = renderWhatsApp([row("photos", "", { for: "sell" })]);
    expect(standalone).toEqual([textMessage(PHOTO_INSTRUCTIONS)]);

    const deduped = renderWhatsApp([
      row("text", `I couldn't save both photos. ${PHOTO_INSTRUCTIONS}`),
      row("photos", "", { for: "sell" }),
    ]);
    expect(deduped).toHaveLength(1);
    if (deduped[0]!.type !== "text") throw new Error();
    expect(deduped[0]!.text.body.match(/front and back/gi)).toHaveLength(1);
  });

  it("renders choices with exact pick:<id>:<index>, preserves printing numbers, and caps >10 in footer", () => {
    const printingChoices = Array.from({ length: 12 }, (_, i) => ({
      label: `Mega Charizard ex ${125 + i}/094 (Obsidian Flames)`,
      intent: { kind: "price_check", card: { id: `sv03-${125 + i}` } },
    }));
    const msgs = renderWhatsApp([
      row("text", "Which printing should I price?"),
      row("choices", "", { choices: [{ label: "" }, ...printingChoices] }, { id: "ch-9" }),
    ]);
    expect(msgs).toHaveLength(1);
    assertWireShape(msgs[0]!);
    const m = msgs[0]!;
    if (m.type !== "interactive" || m.interactive.type !== "list") throw new Error("expected list");
    expect(m.interactive.body.text).toBe("Which printing should I price?");
    expect(m.interactive.footer?.text).toBe("Showing first 10 of 12.");
    const listRows = m.interactive.action.sections[0]!.rows;
    expect(listRows).toHaveLength(10);
    // Original index 0 was blank so first valid row keeps exact index 1.
    expect(listRows[0]!.id).toBe("pick:ch-9:1");
    expect(listRows[0]!.title).toContain("125/094");
    expect(listRows[0]!.description).toBe("Mega Charizard ex · Obsidian Flames");
  });

  it("preserves preceding text if all choice IDs are dropped for exceeding Meta limits", () => {
    const hugeId = "r".repeat(210);
    const msgs = renderWhatsApp([
      row("text", "Which printing should I price?"),
      row(
        "choices",
        "",
        { choices: [{ label: "Charizard ex 125/094 (Obsidian Flames)" }] },
        { id: hugeId },
      ),
    ]);
    expect(msgs).toEqual([textMessage("Which printing should I price?")]);
  });

  it("routes <=3 short unique choices to reply buttons and drops buttons when confirm id is invalid", () => {
    const btnChoices = renderWhatsApp([
      row("text", "Which condition?"),
      row(
        "choices",
        "",
        { choices: ["Near mint", "Lightly played", "Heavily played"] },
        { id: "c1" },
      ),
    ]);
    expect(btnChoices).toHaveLength(1);
    assertWireShape(btnChoices[0]!);
    const m = btnChoices[0]!;
    if (m.type !== "interactive" || m.interactive.type !== "button")
      throw new Error("expected button");
    expect(m.interactive.action.buttons.map((b) => b.reply)).toEqual([
      { id: "pick:c1:0", title: "Near mint" },
      { id: "pick:c1:1", title: "Lightly played" },
      { id: "pick:c1:2", title: "Heavily played" },
    ]);

    // Empty row.id must not fabricate "save:" / "edit:" button IDs.
    const noIdConfirm = renderWhatsApp([
      row(
        "confirm",
        "",
        {
          tool: "set_order",
          status: "pending",
          side: "buy",
          card: { tcgdex_id: "base1-4", name: "Charizard" },
          price_usd: 300,
        },
        { id: "" },
      ),
    ]);
    expect(noIdConfirm).toHaveLength(1);
    expect(noIdConfirm[0]!.type).toBe("text");
  });

  it("degrades non-core rows cleanly to row.content or a plain Bindory pointer", () => {
    const msgs = renderWhatsApp([
      row("tickets", "Sydney Card Show — 2 ticket options", { event: "Sydney Card Show" }),
      row("people", "", { people: [{ name: "Sam" }] }),
      row("sync", "Collectr sync started", { id: "sync-1" }),
      row("unknown_future_kind", ""),
    ]);
    expect(msgs).toHaveLength(1);
    assertWireShape(msgs[0]!);
    if (msgs[0]!.type !== "text") throw new Error("expected text");
    expect(msgs[0]!.text.body).toContain("Sydney Card Show — 2 ticket options");
    expect(msgs[0]!.text.body).toContain("Collectr sync started");
    expect(msgs[0]!.text.body).toContain("Open Bindory to view this.");
  });
});
