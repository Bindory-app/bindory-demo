/**
 * Ask Mori on HarnessRouter (MORI_RUNTIME=harnessrouter). One collector message is one task on the
 * "Ask Mori" harness; later messages in the same chat continue its session. The harness reaches
 * Mori's tools through /api/mori-mcp with the collector's sealed session, and the chat cards those
 * tools produce come back signed inside the tool outputs, so this server saves exactly what the
 * tools built. Instructions live on the harness (harnessrouter.json), not in this file.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/types";
import { TOOL_STATUS, type MoriStreamEvent } from "./mori-tools";
import { AGENT_NAMES, isMoriAgent, routeMoriMessage, type MoriAgent } from "./mori-agents";
import { marketFor, type Market } from "./market";
import {
  answerText,
  harnessIdFor,
  getTurns,
  HRError,
  runStreamedTask,
  uploadFile,
  MoriStopped,
  type HRResponse,
  type OutputItem,
} from "./harnessrouter.server";
import { readSignedRows, sealCollector, stripRowBlocks } from "./mori-mcp-auth.server";
import { cardImage, getCardPricing, priceScale } from "./tcgdex";
import { ebaySoldPrices } from "./silphco.server";
import { finishMoriTurn, tools, type MoriRowDraft } from "./mori-agent.server";

type DB = SupabaseClient<Database>;
const TOOL_NAMES = tools.map((t) => t.name);
const ROW_KINDS = new Set(["confirm", "grade", "people", "video", "binders", "orders", "photos"]);

/** "mori__set_order", "mori.set_order" or "set_order" -> "set_order"; null for other tools. */
export function moriToolName(raw: string | undefined): string | null {
  const n = (raw ?? "").trim();
  if (TOOL_NAMES.includes(n)) return n;
  return TOOL_NAMES.find((t) => new RegExp(`(^|[._:/-])${t}$`).test(n)) ?? null;
}

const asObject = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

function parseJson(text: string | undefined): unknown {
  try {
    return JSON.parse(text ?? "");
  } catch {
    return undefined;
  }
}

/** A tool output as HarnessRouter reports it: the JSON the tool returned, minus the row block.
 *  Some bases wrap MCP results ({content:[{text}]}); unwrap those. */
function toolResult(output: string | undefined): unknown {
  const raw = output ?? "";
  const wrapped = asObject(parseJson(raw));
  const inner = Array.isArray(wrapped["content"])
    ? (wrapped["content"] as { text?: unknown }[]).map((c) => String(c.text ?? "")).join("\n")
    : raw;
  const clean = stripRowBlocks(inner);
  return parseJson(clean) ?? clean.slice(0, 4000);
}

function isRow(v: unknown): v is MoriRowDraft {
  const r = asObject(v);
  return (
    r["role"] === "mori" &&
    typeof r["kind"] === "string" &&
    ROW_KINDS.has(r["kind"]) &&
    typeof r["content"] === "string"
  );
}

type ChatSession = { agent: MoriAgent; responseId: string; sessionId: string; at: string };

/** HarnessRouter sessions of this chat, newest first (one per Mori agent the chat has used). */
async function chatSessions(db: DB, since?: string): Promise<ChatSession[]> {
  let q = db
    .from("mori_messages")
    .select("payload, created_at")
    .eq("role", "mori")
    .not("payload->hr", "is", null);
  if (since) q = q.gt("created_at", since);
  const { data } = await q.order("created_at", { ascending: false }).limit(50);
  const out: ChatSession[] = [];
  for (const row of data ?? []) {
    const hr = asObject(asObject(row.payload)["hr"]);
    if (typeof hr["response_id"] !== "string" || typeof hr["session_id"] !== "string") continue;
    const agent = isMoriAgent(hr["agent"]) ? hr["agent"] : "ask";
    if (out.some((x) => x.agent === agent)) continue;
    out.push({
      agent,
      responseId: hr["response_id"],
      sessionId: hr["session_id"],
      at: row.created_at,
    });
  }
  return out;
}

/** The card the chat is about, from the newest row that names one: a price card, an order or
 *  wishlist card, a grade report, or a price lookup. */
export function cardInFocus(
  rows: { kind: string; payload: unknown }[],
): { id?: string; name: string; number?: string; set?: string } | null {
  for (const row of rows) {
    const p = asObject(row.payload);
    const pick = (c: Record<string, unknown>) => {
      const name = typeof c["name"] === "string" ? c["name"] : "";
      if (!name) return null;
      const id =
        typeof c["id"] === "string"
          ? c["id"]
          : typeof c["tcgdex_id"] === "string"
            ? c["tcgdex_id"]
            : undefined;
      const number = typeof c["number"] === "string" ? c["number"] : undefined;
      const set =
        typeof c["set"] === "string"
          ? c["set"]
          : typeof c["set_name"] === "string"
            ? c["set_name"]
            : undefined;
      return {
        name,
        ...(id ? { id } : {}),
        ...(number ? { number } : {}),
        ...(set ? { set } : {}),
      };
    };
    if ((row.kind === "price" || row.kind === "confirm") && p["card"]) {
      const c = pick(asObject(p["card"]));
      if (c) return c;
    }
    if (row.kind === "grade" && typeof p["card"] === "string" && p["card"])
      return { name: p["card"] };
    if (row.kind === "status" && p["name"] === "get_card_prices") {
      const c = pick(asObject(asObject(p["output"])["card"]));
      if (c) return c;
    }
  }
  return null;
}

/** What a Mori agent joining this chat needs: the card in focus and the last exchange. */
async function handoffNote(db: DB, since: string | undefined, askedAt: number) {
  let q = db
    .from("mori_messages")
    .select("role, kind, content, payload, created_at")
    .lt("created_at", new Date(askedAt).toISOString());
  if (since) q = q.gt("created_at", since);
  const { data } = await q.order("created_at", { ascending: false }).limit(40);
  const rows = data ?? [];
  const clip = (t: string) => (t.length > 600 ? `${t.slice(0, 600)}…` : t);
  const lastUser = rows.find((r) => r.role === "user" && r.content.trim());
  const shown = rows.find(
    (r) =>
      r.role === "mori" &&
      [
        "text",
        "price",
        "confirm",
        "grade",
        "photos",
        "orders",
        "people",
        "video",
        "binders",
      ].includes(r.kind),
  );
  const said = !shown
    ? ""
    : shown.kind === "text"
      ? `“${clip(shown.content)}”`
      : shown.kind === "price"
        ? `showed a price card (${shown.content})`
        : shown.kind === "confirm"
          ? `showed a card to confirm: ${shown.content}`
          : shown.kind === "photos"
            ? "asked for front and back photos"
            : clip(shown.content);
  const focus = cardInFocus(rows);
  if (!focus && !lastUser && !said) return "";
  const lines = ["[App note: hand-off from another Mori agent."];
  if (focus)
    lines.push(
      `Card in focus: ${focus.name}${focus.number ? ` ${focus.number}` : ""}${focus.set ? ` (${focus.set})` : ""}${
        focus.id ? `, catalogue id ${focus.id}` : ""
      }. "This card" or "it" means this card; use it without asking which card.`,
    );
  if (lastUser || said)
    lines.push(
      `Last exchange: collector “${clip(lastUser?.content ?? "")}”${said ? `; Mori ${said}` : ""}.`,
    );
  return `${lines.join("\n")}]\n`;
}

/** What the collector did with Mori's last cards (Confirm or Change), as an app note. */
async function cardOutcomes(db: DB, since: string) {
  const from = new Date(Date.parse(since) - 1000).toISOString();
  const { data } = await db
    .from("mori_messages")
    .select("content, payload")
    .eq("role", "mori")
    .eq("kind", "confirm")
    .gte("created_at", from)
    .limit(10);
  const done = (data ?? [])
    .map((r) => ({ title: r.content, status: asObject(r.payload)["status"] }))
    .filter((r) => r.status === "confirmed" || r.status === "edited");
  if (!done.length) return "";
  return `[App note: on your last cards the collector tapped ${done
    .map((r) => `${r.status === "confirmed" ? "Confirm" : "Change"} on “${r.title}”`)
    .join("; ")}.]\n`;
}

function dataUrlBytes(url: string): { bytes: Uint8Array; type: string } | null {
  const m = /^data:([\w/+.-]+);base64,(.+)$/s.exec(url);
  return m?.[1] && m[2] ? { bytes: Buffer.from(m[2], "base64"), type: m[1] } : null;
}

async function buildInput(text: string, images: string[]) {
  if (!images.length) return text;
  const names = ["card-front.jpg", "card-back.jpg"];
  const files: { type: "input_file"; file_id: string }[] = [];
  for (const [i, url] of images.slice(0, 2).entries()) {
    const img = dataUrlBytes(url);
    if (!img) continue;
    const { id } = await uploadFile(img.bytes, names[i] ?? `card-${i + 1}.jpg`, img.type);
    files.push({ type: "input_file", file_id: id });
  }
  const note =
    files.length === 2
      ? `\n[Card photos attached as files in your working directory: ${names[0]} (front), ${names[1]} (back). Open them and look before you answer.]`
      : files.length === 1
        ? `\n[Card photo attached as a file in your working directory: ${names[0]} (the front). Open it and look before you answer.]`
        : "";
  return [{ role: "user", content: [{ type: "input_text", text: text + note }, ...files] }];
}

/** Saves the collector's front and back photos for a sell order in their own private folder
 *  (owner-only storage rules), so the order and its marketplace listing can use them. */
async function saveOrderPhotos(db: DB, userId: string, images: string[]) {
  const parts = images.slice(0, 2).map(dataUrlBytes);
  if (parts.length < 2 || parts.some((x) => !x)) return null;
  const id = crypto.randomUUID();
  const paths = {
    front: `${userId}/orders/${id}-front.jpg`,
    back: `${userId}/orders/${id}-back.jpg`,
  };
  const bucket = db.storage.from("memory-photos");
  for (const [i, path] of [paths.front, paths.back].entries()) {
    const img = parts[i]!;
    const { error } = await bucket.upload(path, img.bytes, {
      contentType: img.type,
      upsert: false,
    });
    if (error) {
      console.error("Order photo upload failed", error.message);
      return null;
    }
  }
  return paths;
}

/** The latest order photos saved in this chat, if any. */
async function chatPhotos(db: DB, userId: string, since?: string) {
  let q = db
    .from("mori_messages")
    .select("payload")
    .eq("role", "mori")
    .eq("kind", "status")
    .not("payload->photos", "is", null);
  if (since) q = q.gt("created_at", since);
  const { data } = await q.order("created_at", { ascending: false }).limit(1).maybeSingle();
  const ph = asObject(asObject(data?.payload)["photos"]);
  const ok = (v: unknown): v is string =>
    typeof v === "string" && v.startsWith(`${userId}/orders/`) && !v.includes("..");
  return ok(ph["front"]) && ok(ph["back"]) ? { front: ph["front"], back: ph["back"] } : null;
}

/** Tool calls of a finished task, paired with their outputs (from the turn if the response lacks them). */
async function toolCalls(r: HRResponse, sessionId: string) {
  const items = r.output ?? [];
  const outputs = new Map(
    items
      .filter((i) => i.type === "function_call_output")
      .map((i) => [i.call_id ?? "", i.output ?? ""] as const),
  );
  let calls = items
    .filter((i): i is OutputItem => i.type === "function_call" && moriToolName(i.name) !== null)
    .map((i) => ({
      name: moriToolName(i.name)!,
      args: i.arguments,
      output: outputs.get(i.call_id ?? ""),
    }));
  if (calls.some((c) => c.output === undefined) && sessionId) {
    const turn = (await getTurns(sessionId).catch(() => ({ turns: [] }))).turns?.find(
      (t) => t.id === r.id,
    );
    const fromTurn = (turn?.tools ?? [])
      .filter((t) => moriToolName(t.name) !== null)
      .map((t) => ({ name: moriToolName(t.name)!, args: t.arguments, output: t.output }));
    if (fromTurn.length) calls = fromTurn;
  }
  return calls;
}

/** The price card for one card: TCGplayer's lowest listing, market price and mid price (US$). */
export async function priceCardRow(
  cardId: string,
  market: Market,
  fromTool?: Record<string, unknown> | null,
  condition: import("./ebay-sold.server").Condition = "nm",
): Promise<MoriRowDraft | null> {
  const r = await getCardPricing(cardId);
  if (!r) return null;
  const { marketPrices } = await import("./mori-agent.server");
  // Reuse the prices the agent just fetched for this market; look them up only if missing.
  const tool =
    fromTool && fromTool["currency"] === market.currency
      ? (fromTool as {
          price_points?: Record<string, number | null> | null;
          recent_sold?: Record<string, unknown> | null;
          listings?: Record<string, unknown> | null;
        })
      : (
          await marketPrices(
            { id: r.card.id, name: r.card.name, number: r.card.localId },
            r.pricing,
            market,
            undefined,
            condition,
          )
        ).forTool;
  const pts = tool.price_points ?? null;
  const soldAll = (tool.recent_sold ?? null) as Record<string, unknown> | null;
  const sold = soldAll as Record<
    string,
    {
      avg_last_3?: number | null;
      avg_last_5?: number | null;
      value?: number | null;
      sales?: number | null;
      status: string;
    }
  > | null;
  const lst = (tool.listings ?? null) as {
    lowest_worldwide?: { price: number; shipping: number | null; total?: number } | null;
    lowest_in_country?: { price: number; shipping: number | null; total?: number } | null;
    change_7d_pct?: number | null;
    listings_read?: boolean;
  } | null;
  if (!pts && !sold && !lst) return null;
  // The headline is what the card is selling for here: the last 5 sales, else today's cheapest
  // local listing; the converted overseas market price only when there is nothing else.
  const headline =
    sold?.["raw"]?.avg_last_3 ??
    sold?.["raw"]?.value ??
    lst?.lowest_in_country?.total ??
    lst?.lowest_worldwide?.total ??
    pts?.["market"] ??
    undefined;
  return {
    role: "mori",
    kind: "price",
    content: `Price check: ${r.card.name} ${r.card.localId}${typeof headline === "number" ? `, ${market.symbol}${Math.round(headline)}` : ""}`,
    payload: {
      card: {
        id: r.card.id,
        name: r.card.name,
        number: r.card.localId,
        set: r.card.set.name,
        rarity: r.card.rarity,
        image: cardImage(r.card.image, "low"),
      },
      // Everything here is already in the collector's currency.
      market: {
        currency: market.currency,
        symbol: market.symbol,
        ebay: market.ebay,
        country: market.name.replace(/^the\s+/i, ""),
      },
      ...(typeof headline === "number" ? { headline } : {}),
      ...(lst
        ? {
            listings: {
              world: lst.lowest_worldwide ?? null,
              local: lst.lowest_in_country ?? null,
              change7: lst.change_7d_pct ?? null,
              read: lst.listings_read ?? false,
            },
          }
        : pts
          ? { scale: { low: pts["lowest_listing"], market: pts["market"], mid: pts["mid"] } }
          : {}),
      ...(sold
        ? {
            sold: {
              raw: sold["raw"],
              condition: typeof soldAll?.["condition"] === "string" ? soldAll["condition"] : null,
            },
          }
        : {}),
    } as Json,
  };
}

export async function runMoriHarness(
  db: DB,
  userId: string,
  accessToken: string,
  message: string,
  emit: (event: MoriStreamEvent) => void,
  images: string[],
  since: string | undefined,
  askedAt: number,
  signal?: AbortSignal,
  location?: string,
  country?: string,
) {
  const rows: MoriRowDraft[] = [];
  let finalText = "";
  // The collector's market: prices in their currency, from their country's eBay site.
  const market = marketFor(country);
  const rate =
    market.currency === "USD" ? 1 : await (await import("./fx.server")).usdTo(market.currency);
  const marketNote = `[App note: the collector is in ${market.name} (country code ${market.country}). Show every price in ${market.currency} (${market.symbol}), never US$${market.currency === "USD" ? "" : " unless asked"}; their eBay site is ${market.ebay}. Pass currency "${market.currency}" to get_card_prices and quote its \`local\` numbers. Today 1 US$ = ${rate} ${market.currency}; set_order prices are in US$, so convert the collector's ${market.currency} price at that rate.]\n`;
  let hrIds: { response_id: string; session_id: string; agent: MoriAgent } | undefined;
  let cardsOnly = false;
  try {
    const sessions = await chatSessions(db, since);
    const current = sessions[0];
    // The server picks the agent: a clear request goes to its specialist; anything else stays with
    // the agent this chat is already talking to, or Ask Mori for a new chat.
    const first: MoriAgent =
      routeMoriMessage(message, images.length > 0) ?? current?.agent ?? "ask";
    const headers = { "X-Mori-User": sealCollector({ userId, accessToken }) };
    // Photos sent for a sell order are kept (privately) for the order and its listing.
    const saved =
      first === "order" && images.length >= 2 ? await saveOrderPhotos(db, userId, images) : null;
    if (saved)
      rows.push({
        role: "mori",
        kind: "status",
        content: "Saved your photos for the listing",
        payload: { photos: saved } as Json,
      });

    const run = async (agent: MoriAgent, handoff: string) => {
      const prior = sessions.find((x) => x.agent === agent);
      const notes =
        marketNote +
        (location
          ? `[App note: the collector's location, from their phone: ${location}. Use it for anything near them (card shows, events, stores); never assume another city.]\n`
          : "") +
        (prior ? await cardOutcomes(db, prior.at) : "") +
        (current && current.agent !== agent ? await handoffNote(db, since, askedAt) : "") +
        handoff;
      const input = await buildInput(notes + message, images);
      // Hold back streamed text until it is clear this agent is answering (not role_mismatch).
      let head = "";
      let streaming = false;
      const onEvent = (ev: { type: string; delta?: string; item?: OutputItem }) => {
        if (ev.type === "response.output_text.delta" && typeof ev.delta === "string") {
          // The Price Check agent answers with the market card alone, so its text is not streamed.
          if (agent === "price") return;
          if (streaming) return emit({ type: "text", text: ev.delta });
          head += ev.delta;
          if (head.length >= 14 || !"role_mismatch".startsWith(head.trimStart().slice(0, 13))) {
            if (/^\s*role_mismatch/i.test(head)) return;
            streaming = true;
            emit({ type: "text", text: head });
          }
        }
        if (ev.type === "response.output_item.added" && ev.item?.type === "function_call") {
          const name = moriToolName(ev.item.name);
          if (name) emit({ type: "status", name, text: TOOL_STATUS[name] ?? "Working on it" });
        }
      };
      const harnessId = harnessIdFor(agent);
      try {
        return await runStreamedTask(
          {
            harnessId,
            input,
            user: userId,
            previousResponseId: prior?.responseId,
            sessionId: prior?.sessionId,
            headers,
            signal,
          },
          onEvent,
        );
      } catch (e) {
        // A retired or missing session starts a fresh task instead.
        if (!(prior && e instanceof HRError && e.status === 404)) throw e;
        return runStreamedTask({ harnessId, input, user: userId, headers, signal }, onEvent);
      }
    };

    let agent = first;
    let r = await run(agent, "");
    // A specialist that gets something outside its job hands the message to Ask Mori.
    // A specialist that gets a teammate's job names that teammate ("role_mismatch grade"); the
    // message goes there with the hand-off, or to Ask Mori when no teammate is named.
    const mismatch = /^\s*role_mismatch\b[ \t]*([a-z]+)?/i.exec(answerText(r));
    if (agent !== "ask" && mismatch) {
      const named = mismatch[1]?.toLowerCase();
      const from = agent;
      agent = isMoriAgent(named) && named !== from ? named : "ask";
      r = await run(
        agent,
        `[App note: ${AGENT_NAMES[from]} passed this message to you; it is your job.]\n` +
          (await handoffNote(db, since, askedAt)),
      );
    }
    const sessionId = String(
      r.metadata?.session_id ?? sessions.find((x) => x.agent === agent)?.sessionId ?? "",
    );
    if (r.id && sessionId) hrIds = { response_id: r.id, session_id: sessionId, agent };

    let lastCard = "";
    let lastPricedId = "";
    let lastPricedOutput: Record<string, unknown> | null = null;
    let lastPricedCondition: import("./ebay-sold.server").Condition = "nm";
    const pricedIds = new Set<string>();
    for (const c of await toolCalls(r, sessionId)) {
      const result = toolResult(c.output);
      rows.push({
        role: "mori",
        kind: "status",
        content: TOOL_STATUS[c.name] ?? "Working on it",
        payload: {
          name: c.name,
          input: asObject(parseJson(c.args)),
          output: JSON.parse(JSON.stringify(result ?? null)),
        } as Json,
      });
      const card = asObject(asObject(result)["card"]);
      if (c.name === "get_card_prices" && typeof card["name"] === "string") {
        lastCard = `${card["name"]}${card["number"] ? ` ${String(card["number"])}` : ""}${
          card["set"] ? ` (${String(card["set"])})` : ""
        }`;
        if (typeof card["id"] === "string") {
          lastPricedId = card["id"];
          lastPricedOutput = asObject(result);
          const { toCondition } = await import("./ebay-sold.server");
          lastPricedCondition = toCondition(asObject(parseJson(c.args))["condition"]) ?? "nm";
          pricedIds.add(card["id"]);
        }
      }
      for (const row of readSignedRows(c.output ?? "", userId).filter(isRow)) {
        const p = asObject(row.payload);
        if (row.kind === "grade" && !p["card"] && lastCard) {
          row.payload = { ...p, card: lastCard } as Json;
          row.content = row.content.replace(/^Pre-grade:/, `Pre-grade for ${lastCard}:`);
        }
        rows.push(row);
      }
    }

    // A price check shows the real market points on a scale, read here from TCGdex (not from the
    // agent).
    // The same format every time, whichever agent answered: an answer that prices exactly one
    // card and shows no other card (order, wishlist, grade, photos...) is a price check.
    const singlePriceCheck =
      pricedIds.size === 1 && !rows.some((row) => row.kind !== "status") && Boolean(lastPricedId);
    if (singlePriceCheck) {
      const row = await priceCardRow(
        lastPricedId,
        market,
        lastPricedOutput,
        lastPricedCondition,
      ).catch(() => null);
      if (row) {
        rows.push(row);
        cardsOnly = true;
      }
    }

    // A sell order needs the collector's own front and back photos: attach the ones from this chat,
    // or ask for them instead of showing the order.
    let photoRequest = false;
    const sell = rows.findIndex(
      (row) =>
        row.kind === "confirm" &&
        asObject(row.payload)["tool"] === "set_order" &&
        asObject(row.payload)["side"] === "sell",
    );
    if (sell >= 0) {
      const photos = saved ?? (await chatPhotos(db, userId, since));
      const row = rows[sell]!;
      if (photos) {
        row.payload = { ...asObject(row.payload), photos } as Json;
      } else {
        rows.splice(sell, 1, {
          role: "mori",
          kind: "photos",
          content: "Front and back photos of your card",
          payload: { for: "sell" } as Json,
        });
        photoRequest = true;
      }
    }

    finalText = stripRowBlocks(answerText(r)).replace(/^\s*role_mismatch\b[ \t]*[a-z]*\s*/i, "");
    if (photoRequest)
      finalText =
        "Before I list it, send me clear photos of the front and back on a dark, flat background with all four corners in view. I will check the condition and use them for your listing.";
    if (r.status === "failed" || r.status === "cancelled")
      finalText = finalText || "Sorry, I could not answer just now. Please try again.";
    if (r.status === "incomplete" && !finalText)
      finalText = "That took longer than I can manage in one go. Please try a narrower question.";
  } catch (e) {
    // Stopped by the collector: nothing more is shown or saved for this turn.
    if (e instanceof MoriStopped || signal?.aborted) return;
    console.error(
      "Mori HarnessRouter error",
      e instanceof HRError
        ? { status: e.status, code: e.code }
        : e instanceof Error
          ? e.message
          : e,
    );
    finalText =
      e instanceof HRError && e.status === 429
        ? "I am a little busy right now. Please try again in a moment."
        : "Sorry, I could not answer just now. Please try again.";
  }
  if (!finalText && !rows.some((row) => row.kind === "confirm" || row.kind === "grade"))
    finalText = "I could not finish that request. Please try again.";
  return finishMoriTurn(db, rows, finalText, askedAt, emit, hrIds, cardsOnly);
}
