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
import { isMoriAgent, routeMoriMessage, type MoriAgent } from "./mori-agents";
import {
  answerText,
  harnessIdFor,
  getTurns,
  HRError,
  runStreamedTask,
  uploadFile,
  type HRResponse,
  type OutputItem,
} from "./harnessrouter.server";
import { readSignedRows, sealCollector, stripRowBlocks } from "./mori-mcp-auth.server";
import { cardImage, getCardPricing, priceScale } from "./tcgdex";
import { ebaySoldPrices } from "./silphco.server";
import { finishMoriTurn, tools, type MoriRowDraft } from "./mori-agent.server";

type DB = SupabaseClient<Database>;
const TOOL_NAMES = tools.map((t) => t.name);
const ROW_KINDS = new Set(["confirm", "grade", "people", "video", "binders", "orders"]);

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

/** The previous exchange in this chat, for an agent that was not part of it. */
async function previousExchange(db: DB, since: string | undefined, askedAt: number) {
  let q = db
    .from("mori_messages")
    .select("role, kind, content, created_at")
    .in("kind", ["text"])
    .lt("created_at", new Date(askedAt).toISOString());
  if (since) q = q.gt("created_at", since);
  const { data } = await q.order("created_at", { ascending: false }).limit(6);
  const rows = (data ?? []).filter((r) => r.content.trim());
  const lastMori = rows.find((r) => r.role === "mori");
  const lastUser = rows.find(
    (r) => r.role === "user" && (!lastMori || r.created_at < lastMori.created_at),
  );
  if (!lastMori && !lastUser) return "";
  const clip = (t: string) => (t.length > 700 ? `${t.slice(0, 700)}…` : t);
  return `[App note: earlier in this chat, with another Mori agent. Collector: “${clip(
    lastUser?.content ?? "",
  )}” Mori: “${clip(lastMori?.content ?? "")}”]\n`;
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
  const note = files.length
    ? `\n[Card photos attached as files in your working directory: ${names
        .slice(0, files.length)
        .join(" (front), ")} (back). Open them and look before you answer.]`
    : "";
  return [{ role: "user", content: [{ type: "input_text", text: text + note }, ...files] }];
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
export async function priceCardRow(cardId: string): Promise<MoriRowDraft | null> {
  const r = await getCardPricing(cardId);
  const scale = r ? priceScale(r.pricing) : null;
  const sold = r ? await ebaySoldPrices(r.card.id) : null;
  if (!r || (!scale && !sold)) return null;
  const headline = scale?.market ?? scale?.mid ?? scale?.low ?? sold?.raw.value_usd ?? undefined;
  return {
    role: "mori",
    kind: "price",
    content: `Price check: ${r.card.name} ${r.card.localId}${headline ? `, market US$${headline}` : ""}`,
    payload: {
      card: {
        id: r.card.id,
        name: r.card.name,
        number: r.card.localId,
        set: r.card.set.name,
        rarity: r.card.rarity,
        image: cardImage(r.card.image, "low"),
      },
      ...(scale
        ? {
            scale: { low: scale.low, market: scale.market, mid: scale.mid },
            variant: scale.variant,
            currency: "USD",
            updated: scale.updated,
          }
        : {}),
      ...(sold ? { sold: { raw: sold.raw, psa9: sold.psa9, psa10: sold.psa10 } } : {}),
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
) {
  const rows: MoriRowDraft[] = [];
  let finalText = "";
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

    const run = async (agent: MoriAgent, handoff: string) => {
      const prior = sessions.find((x) => x.agent === agent);
      const notes =
        (prior ? await cardOutcomes(db, prior.at) : "") +
        (current && current.agent !== agent ? await previousExchange(db, since, askedAt) : "") +
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
          },
          onEvent,
        );
      } catch (e) {
        // A retired or missing session starts a fresh task instead.
        if (!(prior && e instanceof HRError && e.status === 404)) throw e;
        return runStreamedTask({ harnessId, input, user: userId, headers }, onEvent);
      }
    };

    let agent = first;
    let r = await run(agent, "");
    // A specialist that gets something outside its job hands the message to Ask Mori.
    if (agent !== "ask" && /^\s*role_mismatch\b/i.test(answerText(r))) {
      agent = "ask";
      r = await run(agent, "[App note: a Mori specialist passed this message to you.]\n");
    }
    const sessionId = String(
      r.metadata?.session_id ?? sessions.find((x) => x.agent === agent)?.sessionId ?? "",
    );
    if (r.id && sessionId) hrIds = { response_id: r.id, session_id: sessionId, agent };

    let lastCard = "";
    let lastPricedId = "";
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
        if (typeof card["id"] === "string") lastPricedId = card["id"];
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
    if (agent === "price" && lastPricedId) {
      const row = await priceCardRow(lastPricedId).catch(() => null);
      if (row) {
        rows.push(row);
        cardsOnly = true;
      }
    }

    finalText = stripRowBlocks(answerText(r)).replace(/^\s*role_mismatch\s*/i, "");
    if (r.status === "failed" || r.status === "cancelled")
      finalText = finalText || "Sorry, I could not answer just now. Please try again.";
    if (r.status === "incomplete" && !finalText)
      finalText = "That took longer than I can manage in one go. Please try a narrower question.";
  } catch (e) {
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
