import { routeMoriMessage } from "./mori-agents";
import { SYSTEM, tools } from "./mori-prompt.server";
import {
  COLLECTR_BAD_LINK,
  collectrSyncBinder,
  collectrSyncLink,
  isCollectrLink,
} from "./collectr";
import type { MoriStreamEvent, MoriRow } from "./mori-tools";
import {
  streamResponse,
  GatewayError,
  type ResponsesInputItem,
  type ResponsesResponse,
} from "./ai-gateway.server";
import type { Json } from "@/integrations/supabase/types";
import { cardImage, getCard, getCardPricing, findCards, usdRange } from "./tcgdex";
import { validateWriteArgs, ownPhotoPath, orderCondition } from "./mori-validation";
import { stringArg as s, type Args, type DB, type MoriRowDraft } from "./mori-context.server";
import { runReadTool } from "./mori-read-tools.server";
import {
  isWriteTool,
  proposalTitle,
  TOOL_STATUS,
  type Proposal,
  type ProposalCard,
  type ProposalPayload,
} from "./mori-tools";

// Any tool-capable model ID from https://ai-gateway.vercel.sh/v1/models; override with AI_GATEWAY_MODEL.
// Default is on the AI Gateway free tier; newer models need paid credits.
const MODEL = process.env["AI_GATEWAY_MODEL"] || "google/gemini-2.5-flash";

async function briefCard(id: string, reason?: string): Promise<ProposalCard | null> {
  const c = await getCard(id);
  if (!c) return null;
  return {
    tcgdex_id: c.id,
    name: c.name,
    image: cardImage(c.image, "low"),
    set_name: c.set.name,
    reason,
  };
}

const NEEDS_DATA =
  /card show|chase|trade-?up|trend|went up|went down|value|worth|price|complete .*set|share my taste|collectors|binder|video|orders?\b|my cards|my collection|add .* (?:to|into) my|wishlist/i;

// "on 2 Nov 2026" in a memory template message, as YYYY-MM-DD.
const MONTH_NUM: Record<string, string> = {
  jan: "01",
  feb: "02",
  mar: "03",
  apr: "04",
  may: "05",
  jun: "06",
  jul: "07",
  aug: "08",
  sep: "09",
  oct: "10",
  nov: "11",
  dec: "12",
};
function templateDate(message: string): string | undefined {
  const m = /\bon (\d{1,2}) ([A-Za-z]{3})[a-z]* (\d{4})\b/.exec(message);
  const mon = m?.[2] ? MONTH_NUM[m[2].toLowerCase()] : undefined;
  return m && mon ? `${m[3]}-${mon}-${(m[1] ?? "").padStart(2, "0")}` : undefined;
}
const TEMPLATE_END = " Help me save this memory.";

/** One catalogue card for a label like "Charizard 125/094" or "Pikachu ex 25/25", or undefined
 *  when there is no single clear match. */
export async function cardFromLabel(label: string | undefined): Promise<ProposalCard | undefined> {
  const m = /^(.*?)\s+#?([A-Z]{0,3}\d{1,4}(?:\/[A-Z]{0,3}\d{1,4})?)$/i.exec(label?.trim() ?? "");
  if (!m?.[1] || !m[2]) return undefined;
  const found = await findCards(m[1], m[2]).catch(() => []);
  if (found.length !== 1 || !found[0]) return undefined;
  return (await briefCard(found[0].id).catch(() => null)) ?? undefined;
}

async function buildProposal(
  db: DB,
  userId: string,
  name: string,
  a: Args,
  message = "",
  seen: Set<string> | null = new Set(),
): Promise<Proposal | { error: string }> {
  if (!isWriteTool(name)) return { error: "Unknown tool" };
  const parsed = validateWriteArgs(name, a);
  if (!parsed.success)
    return { error: "Missing or invalid details. Ask the collector before proposing." };
  if (name === "add_card_to_collection" || name === "add_to_wishlist") {
    const card = await briefCard(s(a["card_id"]) ?? "");
    if (!card) return { error: "Card not found in the catalogue" };
    if (name === "add_to_wishlist") return { tool: name, card, note: s(a["note"]) };
    // A binder by name: one of the collector's own (RLS), else a new binder made on confirm.
    const binderName = s(a["binder_name"])
      ?.trim()
      .replace(/^["“”']+|["“”']+$/g, "");
    if (!binderName) return { tool: name, card };
    const { data: mine, error } = await db.from("binders").select("id, name");
    if (error) throw error;
    const found = (mine ?? []).find(
      (b) => b.name.trim().toLowerCase() === binderName.toLowerCase(),
    );
    return {
      tool: name,
      card,
      binder: found
        ? { id: found.id, name: found.name, new: false }
        : { name: binderName, new: true },
    };
  }
  if (name === "create_binder") {
    const list = Array.isArray(a["cards"]) ? (a["cards"] as Args[]) : [];
    const { data: owned, error } = await db.from("cards").select("tcgdex_id");
    if (error) throw error;
    if (list.some((c) => !owned.some((card) => card.tcgdex_id === c["card_id"])))
      return {
        error:
          "Use only cards the collector owns. Suggest unowned cards separately, never add them to their collection.",
      };
    const matched = await Promise.all(
      list.map((c) => briefCard(s(c["card_id"]) ?? "", s(c["reason"]))),
    );
    if (matched.some((c) => !c))
      return { error: "Some cards were not found. Ask the collector to clarify." };
    const cards = matched.filter((c): c is ProposalCard => Boolean(c));
    if (!cards.length) return { error: "None of those cards were found in the catalogue" };
    return {
      tool: "create_binder",
      name: s(a["name"]) ?? "New binder",
      description: s(a["description"]),
      cards,
    };
  }
  if (name === "set_order") {
    const r = await getCardPricing(s(a["card_id"]) ?? "");
    if (!r) return { error: "Card not found in the catalogue" };
    const range = usdRange(r.pricing);
    return {
      tool: "set_order",
      side: a["side"] === "sell" ? "sell" : "buy",
      card: {
        tcgdex_id: r.card.id,
        name: `${r.card.name} ${r.card.localId}`,
        image: cardImage(r.card.image, "low"),
        set_name: r.card.set.name,
      },
      price_usd: Math.round(Number(a["price_usd"]) * 100) / 100,
      market_usd: range?.typical,
      note: s(a["note"]),
      ...(() => {
        // Sell orders carry the condition read from the collector's photos.
        const condition = a["side"] === "sell" ? orderCondition.safeParse(a["condition"]) : null;
        return condition?.success ? { condition: condition.data } : {};
      })(),
    };
  }
  if (name === "save_memory") {
    if (!ownPhotoPath(s(a["photo_path"]), userId))
      return { error: "Photo must belong to the collector." };
    // Cards are optional: keep only ones Mori actually looked up, so a guessed id never shows the wrong card.
    const cid = s(a["card_id"]);
    const tid = s(a["traded_card_id"]);
    const card =
      cid && (!seen || seen.has(cid)) ? ((await briefCard(cid)) ?? undefined) : undefined;
    const traded_card =
      tid && (!seen || seen.has(tid)) ? ((await briefCard(tid)) ?? undefined) : undefined;
    // From the fill-in template, the story is exactly what the collector wrote (facts, feelings, ratings).
    const fromTemplate = message.endsWith(TEMPLATE_END);
    const story = fromTemplate
      ? message.slice(0, -TEMPLATE_END.length).trim()
      : (s(a["story"]) ?? "");
    const date = s(a["date"]) ?? (fromTemplate ? templateDate(message) : undefined);
    // A trade card the agent passed only by name ("Charizard 125/094") is looked up here, so the
    // memory shows the real card whenever the catalogue has exactly one match.
    const resolvedCard = card ?? (await cardFromLabel(s(a["card_name"])));
    const resolvedTraded = traded_card ?? (await cardFromLabel(s(a["traded_card_name"])));
    return {
      tool: "save_memory",
      title: s(a["title"]) ?? "A memory",
      story,
      place: s(a["place"]),
      with_whom: s(a["with_whom"]),
      date: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined,
      card: resolvedCard,
      traded_card: resolvedTraded,
      card_name: resolvedCard ? undefined : s(a["card_name"])?.slice(0, 160),
      traded_card_name: resolvedTraded ? undefined : s(a["traded_card_name"])?.slice(0, 160),
      photo_path: s(a["photo_path"]),
    };
  }
  return { error: "Unknown tool" };
}

/** Checks and tidies the model's pre-grade report before it is shown. */
function gradeReport(a: Args) {
  const num = (v: unknown, lo: number, hi: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : undefined;
  };
  const outcomes = (Array.isArray(a["outcomes"]) ? (a["outcomes"] as Args[]) : [])
    .map((o) => ({
      grade: num(o["grade"], 1, 10),
      probability: num(o["probability"], 0, 100) ?? 0,
      reason: s(o["reason"])?.slice(0, 120) ?? "",
    }))
    .filter(
      (o): o is { grade: number; probability: number; reason: string } => o.grade !== undefined,
    )
    .slice(0, 4);
  const take = s(a["take"])?.slice(0, 400);
  if (outcomes.length < 2 || !take)
    return { error: "Give at least two likely grades and Mori's take." };
  const total = outcomes.reduce((n, o) => n + o.probability, 0) || 1;
  outcomes.forEach((o) => (o.probability = Math.round((o.probability / total) * 100)));
  outcomes.sort((x, y) => y.grade - x.grade);
  const companies = ["psa", "cgc", "bgs", "tag"] as const;
  const block = (v: unknown, lo: number, hi: number) =>
    Object.fromEntries(
      companies.map((c) => [
        c,
        num((v && typeof v === "object" ? (v as Args) : {})[c], lo, hi) ?? null,
      ]),
    );
  const subs = a["subgrades"] && typeof a["subgrades"] === "object" ? (a["subgrades"] as Args) : {};
  return {
    card: s(a["card"])?.slice(0, 120),
    outcomes,
    take,
    confidence: num(a["confidence"], 0, 100) ?? 70,
    // Some models answer subgrades on a 1-10 scale (BGS style); show everything as 0-100.
    subgrades: Object.fromEntries(
      ["centering", "corners", "edges", "surface"].map((k) => [
        k,
        Object.fromEntries(
          Object.entries(block(subs[k], 0, 100)).map(([c, v]) => [
            c,
            v !== null && v <= 10 ? v * 10 : v,
          ]),
        ),
      ]),
    ),
    overall: block(a["overall"], 1, 10),
    notes: s(a["notes"])?.slice(0, 160),
  };
}

/** The conversation so far: everything since `since` (when the collector opened Ask Mori or tapped
 *  New chat), so a new chat starts with a clean slate instead of every message ever sent. */
async function history(db: DB, since?: string): Promise<ResponsesInputItem[]> {
  const data: { role: string; kind: string; content: string; payload: Json | null }[] = [];
  for (let offset = 0; ; offset += 500) {
    let q = db.from("mori_messages").select("role, kind, content, payload");
    if (since) q = q.gt("created_at", since);
    const page = await q
      .order("created_at")
      .order("id")
      .range(offset, offset + 499);
    if (page.error) throw page.error;
    data.push(...page.data);
    if (page.data.length < 500) break;
  }
  return data
    .filter((m) => m.kind !== "suggest")
    .map((m): ResponsesInputItem => {
      if (m.role === "user") return { role: "user", content: m.content };
      const text =
        m.kind === "status"
          ? `[Tool result: ${JSON.stringify(m.payload)}]`
          : m.kind === "confirm"
            ? `[Confirmation: ${JSON.stringify(m.payload)}]`
            : m.content;
      return { role: "assistant", content: [{ type: "output_text", text, annotations: [] }] };
    });
}

// The AI Gateway free tier allows only a few requests per minute per model provider, and one Mori
// answer takes several requests (tool calls). When a model is rate limited, try the next one; each
// provider has its own limit. All of these are on the free tier and support tools and images.
const FALLBACK_MODELS = [
  "openai/gpt-4.1-mini",
  "google/gemini-2.5-flash-lite",
  "openai/gpt-5-mini",
];
const MODELS = [MODEL, ...FALLBACK_MODELS.filter((m) => m !== MODEL)];

async function streamWithFallback(
  input: ResponsesInputItem[],
  signal: AbortSignal | undefined,
  oidcToken: string | null | undefined,
  mustUseTool = false,
) {
  for (let i = 0; ; i++) {
    try {
      return await streamResponse(
        {
          model: MODELS[i] ?? MODEL,
          instructions: SYSTEM,
          input,
          tools,
          ...(mustUseTool ? { tool_choice: "required" as const } : {}),
          max_output_tokens: 3000,
        },
        { ...(signal ? { signal } : {}), oidcToken: oidcToken ?? null },
      );
    } catch (e) {
      if (!(e instanceof GatewayError && e.code === "rate_limited") || i >= MODELS.length - 1)
        throw e;
    }
  }
}

export type MoriToolContext = {
  /** The collector's message this answer is for (memory templates keep their exact words). */
  message: string;
  /** Card ids looked up in this chat; null when the caller cannot know them (the MCP endpoint),
   *  in which case a card only has to exist in the catalogue. */
  seenIds: Set<string> | null;
  /** The card most recently priced in this answer, so a pre-grade report can name it. */
  lastCard: string;
};

/** Runs one of Mori's tools for this collector. `rows` are the chat cards it shows (confirmation,
 *  pre-grade report, profiles, storyboard, binders, orders); `stop` means the answer should end
 *  after it. Shared by the AI Gateway loop and the HarnessRouter MCP endpoint. */
export async function executeMoriTool(
  db: DB,
  userId: string,
  name: string,
  args: Args,
  ctx: MoriToolContext,
): Promise<{ result: unknown; rows: MoriRowDraft[]; stop: boolean }> {
  const rows: MoriRowDraft[] = [];
  let stop = false;
  let result: unknown;
  if (name === "pre_grade_report") {
    const report = gradeReport(args);
    if (!("error" in report) && !report.card && ctx.lastCard) report.card = ctx.lastCard;
    if ("error" in report) result = report;
    else {
      rows.push({
        role: "mori",
        kind: "grade",
        content: `Pre-grade${report.card ? ` for ${report.card}` : ""}: ${report.outcomes
          .map((o) => `${o.grade} (${o.probability}%)`)
          .join(", ")}. ${report.take}`,
        payload: report as unknown as Json,
      });
      result = { shown_to_user: true, note: "The report is on screen." };
      stop = true;
    }
  } else if (name === "show_collectors") {
    // Only real public profiles; Mori supplies the reason.
    const picks = (Array.isArray(args["picks"]) ? (args["picks"] as Args[]) : []).slice(0, 4);
    const { data } = await db.rpc("list_public_collectors", { p_query: "" });
    const all = (Array.isArray(data) ? data : []) as {
      display_name?: string;
      username?: string;
      avatar_url?: string;
    }[];
    const people = picks
      .map((x) => {
        const c = all.find((o) => o.username === (s(x["username"]) ?? "").replace(/^@/, ""));
        return c
          ? {
              name: c.display_name ?? c.username,
              username: c.username,
              avatar: c.avatar_url ?? null,
              why: (s(x["why"]) ?? "").slice(0, 140),
            }
          : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    if (!people.length)
      result = { error: "Use usernames exactly as find_collectors returned them." };
    else {
      rows.push({
        role: "mori",
        kind: "people",
        content: `Collectors you may like: ${people.map((x) => x.name).join(", ")}`,
        payload: { people } as unknown as Json,
      });
      result = {
        shown_to_user: true,
        note: "The profile cards are on screen. Reply in one short line.",
      };
    }
  } else if (name === "show_tickets") {
    // The organiser's own ticket page; the collector pays there (Bindory never takes payment).
    let url = "";
    try {
      const u = new URL(s(args["ticket_url"]) ?? "");
      if (u.protocol === "https:" && !/(^|\.)bindory\.app$/i.test(u.hostname)) url = u.toString();
    } catch {
      url = "";
    }
    const clip = (v: unknown, n: number) => (s(v) ?? "").replace(/\s+/g, " ").trim().slice(0, n);
    const options = (Array.isArray(args["options"]) ? (args["options"] as Args[]) : [])
      .map((o) => ({
        name: clip(o["name"], 80),
        price: clip(o["price"], 30),
        note: clip(o["note"], 120),
      }))
      .filter((o) => o.name)
      .slice(0, 8);
    const event = clip(args["event"], 100);
    if (!url || !event)
      result = {
        error:
          "Give the event name and its official ticket page (an https link from the page you read).",
      };
    else {
      rows.push({
        role: "mori",
        kind: "tickets",
        content: `Tickets for ${event}`,
        payload: {
          event,
          date: clip(args["date"], 80),
          venue: clip(args["venue"], 120),
          url,
          options,
        } as unknown as Json,
      });
      result = {
        shown_to_user: true,
        note: "The ticket card is on screen: the collector picks a ticket and quantity and opens checkout to pay on the organiser's page. Reply in one or two short lines (which ticket suits them, if they said a day), and do not list the prices again.",
      };
    }
  } else if (name === "request_card_photos") {
    // Take a photo / Upload buttons; the photos come back as the collector's next message.
    rows.push({
      role: "mori",
      kind: "photos",
      content: "Front and back photos of your card",
      payload: { for: args["purpose"] === "grade" ? "grade" : "sell" } as Json,
    });
    result = {
      shown_to_user: true,
      note: "Take a photo and Upload buttons are on screen. In one short line, ask for the front and back on a dark, flat background with all four corners in view. Wait for the photos before set_order or pre_grade_report.",
    };
    stop = true;
  } else if (name === "plan_video") {
    // Storyboard from the collector's own cards; they post or save it with a button.
    const scenes = (Array.isArray(args["scenes"]) ? (args["scenes"] as Args[]) : []).slice(0, 6);
    const ids = scenes.map((x) => s(x["card_id"]) ?? "");
    const { data: owned } = await db
      .from("cards")
      .select("tcgdex_id, name, image_url")
      .in("tcgdex_id", ids.length ? ids : ["-"]);
    const frames = scenes
      .map((x) => {
        const c = (owned ?? []).find((o) => o.tcgdex_id === s(x["card_id"]));
        return c && c.image_url
          ? {
              name: c.name,
              image: c.image_url,
              caption: (s(x["caption"]) ?? "").slice(0, 120),
            }
          : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    if (frames.length < 2)
      result = { error: "Use 3-5 cards the collector owns (ids from list_my_cards)." };
    else {
      const title = (s(args["title"]) ?? "My collection").slice(0, 80);
      rows.push({
        role: "mori",
        kind: "video",
        content: `Video plan: ${title}`,
        payload: { title, frames } as unknown as Json,
      });
      result = {
        shown_to_user: true,
        note: "The storyboard is on screen with Post to profile and Save draft buttons. Reply in one short line.",
      };
    }
  } else if (name === "suggest_binder_for_card") {
    // The collector picks the binder with an Add here button; Mori only suggests one.
    result = await runReadTool(db, name, args).catch((e: unknown) => ({
      error: e instanceof Error ? e.message : "Tool failed",
    }));
    const r = result as {
      card?: { id: string; name: string } | null;
      binders?: { id: string; name: string; binder_cards?: { count: number }[] }[];
    };
    const owned = r.card
      ? await db.from("cards").select("id").eq("tcgdex_id", r.card.id).limit(1).maybeSingle()
      : null;
    if (!r.card) result = { error: "Card not found" };
    else if (!owned?.data)
      result = {
        note: "This card is not in the collection yet. Offer to add it to the collection first.",
      };
    else if (!r.binders?.length)
      result = {
        note: "The collector has no binders yet. Offer to build one with this card.",
      };
    else {
      rows.push({
        role: "mori",
        kind: "binders",
        content: `Pick a binder for ${r.card.name}`,
        payload: {
          card: { name: r.card.name, owned_card_id: owned.data.id },
          binders: r.binders.map((b) => ({
            id: b.id,
            name: b.name,
            count: b.binder_cards?.[0]?.count ?? 0,
          })),
        } as unknown as Json,
      });
      result = {
        shown_to_user: true,
        binders: r.binders.map((b) => ({ name: b.name })),
        note: "The binders are on screen, each with an Add here button. In one or two short sentences, say which binder fits best and why. Never claim you added the card.",
      };
    }
  } else if (name === "list_my_orders") {
    // Open orders are shown as cards with a Cancel button; Mori only summarises them.
    result = await runReadTool(db, name, args).catch((e: unknown) => ({
      error: e instanceof Error ? e.message : "Tool failed",
    }));
    if (Array.isArray(result) && result.length) {
      rows.push({
        role: "mori",
        kind: "orders",
        content: `${result.length} open order${result.length > 1 ? "s" : ""}`,
        payload: { orders: result } as unknown as Json,
      });
      result = {
        shown_to_user: true,
        count: result.length,
        note: 'The open orders are on screen as cards, each with a Cancel button. Reply in one short, warm line such as "Here are your open orders. Tap Cancel on any you no longer want." Do not list them again.',
      };
    }
  } else if (
    (name === "add_to_wishlist" || name === "add_card_to_collection") &&
    ctx.seenIds !== null &&
    !ctx.seenIds.has(s(args["card_id"]) ?? "")
  ) {
    result = {
      error:
        "Look this card up first with search_catalogue (name and number) and use the id it returns.",
    };
  } else if (isWriteTool(name)) {
    const p = await buildProposal(db, userId, name, args, ctx.message, ctx.seenIds);
    if ("error" in p) result = p;
    else {
      const payload: ProposalPayload = { ...p, status: "pending" };
      rows.push({
        role: "mori",
        kind: "confirm",
        content: proposalTitle(p),
        payload: payload as unknown as Json,
      });
      result = { shown_to_user: true, note: "Waiting for the user to tap Confirm or Edit." };
      stop = true;
    }
  } else {
    result = await runReadTool(db, name, args).catch((e: unknown) => ({
      error: e instanceof Error ? e.message : "Tool failed",
    }));
  }
  // The card this answer is about, so the report and follow-ups can name it.
  if (name === "get_card_prices" && result && typeof result === "object" && "card" in result) {
    const c = (result as { card: { name?: string; number?: string; set?: string } }).card;
    if (c.name)
      ctx.lastCard = `${c.name}${c.number ? ` ${c.number}` : ""}${c.set ? ` (${c.set})` : ""}`;
  }
  for (const m of JSON.stringify(result ?? null).matchAll(/"(?:id|tcgdex_id)":"([^"]+)"/g))
    if (m[1]) ctx.seenIds?.add(m[1]);
  return { result, rows, stop };
}

/** Which agent runtime answers: "harnessrouter" (the Ask Mori harness) or "gateway" (default, and
 *  the rollback). Set with MORI_RUNTIME in the server environment. */
export const moriRuntime = (): "harnessrouter" | "gateway" =>
  process.env["MORI_RUNTIME"]?.trim() === "harnessrouter" ? "harnessrouter" : "gateway";

/** Server execution only: shared by the authenticated RPC and streaming HTTP handler. */
export async function runMori(
  db: DB,
  userId: string,
  message: string,
  emit: (event: MoriStreamEvent) => void = () => {},
  signal?: AbortSignal,
  oidcToken?: string | null,
  images: string[] = [],
  since?: string,
  accessToken?: string,
  location?: string,
  country?: string,
) {
  // HarnessRouter runs Mori when MORI_RUNTIME=harnessrouter; it needs the collector's session for
  // the tool endpoint, so callers without one (the plain RPC) stay on AI Gateway.
  const onHarness = moriRuntime() === "harnessrouter" && Boolean(accessToken);
  const past = onHarness ? [] : await history(db, since);
  // The stored text notes the photos so later turns know they were sent (the images themselves are not stored).
  const stored = images.length
    ? `${message}\n[Sent ${images.length === 1 ? "a card photo: the front" : `${images.length} card photos: front and back`}]`
    : message;
  const ins = await db
    .from("mori_messages")
    // The chat this message belongs to (its start time, sent by the app), so History lists one
    // entry per chat and New chat always starts a new one.
    .insert({ role: "user", content: stored, payload: since ? ({ chat: since } as Json) : null })
    .select("created_at")
    .single();
  if (ins.error) throw ins.error;
  const askedAt = Date.parse(ins.data.created_at);
  // "Sync from Collectr" runs on its own harness in the background (collectr-sync.server.ts);
  // a plain follow-up right after a finished sync continues that task.
  const collectr = collectrSyncLink(message);
  const { startSync, latestSync } = await import("./collectr-sync.server");
  const priorSync =
    collectr === null && !routeMoriMessage(message, images.length > 0)
      ? await latestSync(db, userId, since)
      : null;
  if (collectr !== null || priorSync) {
    if (collectr !== null && !isCollectrLink(collectr))
      return finishMoriTurn(db, [], COLLECTR_BAD_LINK, askedAt, emit);
    try {
      const row = await startSync(
        db,
        userId,
        priorSync
          ? { followUp: message, prior: priorSync }
          : { link: collectr!, binder: collectrSyncBinder(message) },
      );
      const ins = await db
        .from("mori_messages")
        .insert(row)
        .select("id, role, kind, content, payload, created_at")
        .single();
      if (ins.error) throw ins.error;
      emit({ type: "done", rows: [ins.data as unknown as MoriRow] });
      return;
    } catch (e) {
      console.error("Collectr sync failed to start", e instanceof Error ? e.message : e);
      return finishMoriTurn(
        db,
        [],
        "I could not start the Collectr sync just now. Please try again in a moment.",
        askedAt,
        emit,
      );
    }
  }
  if (onHarness && accessToken) {
    const { runMoriHarness } = await import("./mori-harness.server");
    return runMoriHarness(
      db,
      userId,
      accessToken,
      message,
      emit,
      images,
      since,
      askedAt,
      signal,
      location,
      country,
    );
  }

  const input: ResponsesInputItem[] = [
    ...past,
    images.length
      ? {
          role: "user",
          content: [
            { type: "input_text", text: message },
            ...images.map((image_url) => ({ type: "input_image" as const, image_url })),
          ],
        }
      : { role: "user", content: message },
  ];
  const rows: { role: "mori"; kind: string; content: string; payload?: Json }[] = [];
  let finalText = "";
  const ctx: MoriToolContext = { message, seenIds: new Set<string>(), lastCard: "" };
  // Card ids Mori has actually looked up in this chat, so it never proposes a card from a guessed id.
  for (const id of JSON.stringify(past).match(/[a-z0-9.]+-[a-z0-9]+(?=\\?")/gi) ?? [])
    ctx.seenIds?.add(id);

  try {
    for (let turn = 0; turn < 6; turn++) {
      // Questions about the collector's own cards, prices or plans must look at real data first,
      // so the first step has to use a tool (the model sometimes answers from guesswork otherwise).
      const stream = await streamWithFallback(
        input,
        signal,
        oidcToken,
        turn === 0 && NEEDS_DATA.test(message),
      );
      let res: ResponsesResponse | undefined;
      for await (const event of stream) {
        if (event.type === "response.output_text.delta")
          emit({ type: "text", text: event.delta ?? "" });
        if (event.type === "response.completed") res = event.response;
        if (event.type === "response.incomplete") throw new Error("Mori response incomplete");
      }
      if (!res) throw new Error("Mori response did not complete");
      const output = res.output ?? [];
      const calls = output.filter((o) => o.type === "function_call");
      const text = output
        .filter((o) => o.type === "message")
        .flatMap((o) => o.content ?? [])
        .map((c) => (c.type === "output_text" ? c.text : ""))
        .join("")
        .trim();
      if (!calls.length) {
        finalText = text;
        break;
      }

      let stop = false;
      for (const call of calls) {
        const name = call.name ?? "";
        const args = (() => {
          try {
            return JSON.parse(call.arguments ?? "{}") as Args;
          } catch {
            return {};
          }
        })();
        emit({ type: "status", name, text: TOOL_STATUS[name] ?? "Working on it" });
        const statusRow: { role: "mori"; kind: string; content: string; payload: Json } = {
          role: "mori",
          kind: "status",
          content: TOOL_STATUS[name] ?? "Working on it",
          payload: { name, input: args as Json } as Json,
        };
        rows.push(statusRow);
        input.push({
          type: "function_call",
          call_id: call.call_id ?? "",
          name,
          arguments: call.arguments ?? "{}",
        });
        const out = await executeMoriTool(db, userId, name, args, ctx);
        rows.push(...out.rows);
        if (out.stop) stop = true;
        const result = out.result;
        statusRow.payload = {
          name,
          input: args as Json,
          output: JSON.parse(JSON.stringify(result)) as Json,
        };
        input.push({
          type: "function_call_output",
          call_id: call.call_id ?? "",
          output: JSON.stringify(result).slice(0, 8000),
        });
      }
      if (stop) {
        finalText = text;
        break;
      }
    }
  } catch (e) {
    if (signal?.aborted) throw e;
    console.error(
      "Mori gateway error",
      e instanceof GatewayError ? { code: e.code, ids: e.ids } : e,
    );
    finalText =
      e instanceof GatewayError && e.code === "rate_limited"
        ? "I am a little busy right now. Please try again in a moment."
        : "Sorry, I could not answer just now. Please try again.";
  }

  return finishMoriTurn(db, rows, finalText, askedAt, emit);
}

/** A reply's parts, one chat bubble each: the agent separates them with a line of "---". */
export function replyParts(text: string): string[] {
  return text
    .split(/\n[ \t]*-{3,}[ \t]*(?:\n|$)/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/** Ends one answer: pulls out the follow-up suggestions, puts the reply before any card, and saves
 *  every row in order after the question. `hr` (HarnessRouter ids) is kept on the turn's last text
 *  or status row so the next message can continue the same session. */
export async function finishMoriTurn(
  db: DB,
  rows: MoriRowDraft[],
  text: string,
  askedAt: number,
  emit: (event: MoriStreamEvent) => void,
  hr?: { response_id: string; session_id: string; agent?: string },
  /** Show only the cards (a price check's market card): the reply text is dropped, its
   *  suggestions are kept. */
  cardsOnly = false,
) {
  let finalText = text;
  if (!finalText && !rows.some((row) => row.kind === "confirm" || row.kind === "grade"))
    finalText = "I could not finish that request. Please try again.";
  // Pull out the follow-up questions Mori suggests (shown as buttons under the answer).
  let suggestions: string[] = [];
  const tail = /(?:^|\n|(?<=[.?!])[ \t]+)[ \t*_]*suggestions?[ \t*_]*:(.*)$/is.exec(finalText);
  if (tail) {
    suggestions = (tail[1] ?? "")
      .split(/\||\n/)
      .map((x) => x.replace(/^[\s"'*•\-\d.)]+|[\s"'*]+$/g, ""))
      .filter((x) => x.length > 2 && x.length <= 80);
    finalText = finalText.slice(0, tail.index).trim();
  }
  // Answers the collector can tap when Mori asked them something ("Choices: Both days | ...").
  let choices: string[] = [];
  const asked = /(?:^|\n|(?<=[.?!])[ \t]+)[ \t*_]*choices?[ \t*_]*:(.*)$/is.exec(finalText);
  if (asked) {
    choices = [
      ...new Set(
        (asked[1] ?? "")
          .split(/\||\n/)
          .map((x) => x.replace(/^[\s"'*•\-\d.)]+|[\s"'*]+$/g, ""))
          .filter((x) => x.length > 0 && x.length <= 90),
      ),
    ].slice(0, 6);
    finalText = finalText.slice(0, asked.index).trim();
  }
  if (rows.some((r) => r.kind === "grade"))
    suggestions = [
      "Where can I send it for grading?",
      "What does grading cost?",
      // "This card" is the card in the photos; Mori resolves it from the chat.
      "Price check this card",
    ];
  if (!suggestions.length && !choices.length)
    suggestions = [
      "Price check a card",
      "What card should I chase next?",
      "Start a trade-up challenge",
    ];
  suggestions = [...new Set(suggestions)].slice(0, 3);
  // A confirmation card is the next step itself; follow-ups come after Confirm instead.
  if (rows.some((r) => r.kind === "confirm" || r.kind === "photos")) suggestions = choices = [];
  // A question with answers to tap replaces the general next steps.
  if (choices.length >= 2) suggestions = [];
  else choices = [];
  if (cardsOnly) finalText = "";

  if (finalText) {
    // Put the reply before any confirmation card so it reads naturally.
    const confirmAt = rows.findIndex(
      (r) =>
        r.kind === "confirm" ||
        r.kind === "grade" ||
        r.kind === "orders" ||
        r.kind === "binders" ||
        r.kind === "video" ||
        r.kind === "people" ||
        r.kind === "price" ||
        r.kind === "tickets" ||
        r.kind === "photos",
    );
    // One bubble per part: a reply that answers several things separates them with a "---" line.
    const replies = replyParts(finalText).map((content) => ({
      role: "mori" as const,
      kind: "text",
      content,
    }));
    if (confirmAt >= 0) rows.splice(confirmAt, 0, ...replies);
    else rows.push(...replies);
  }
  if (choices.length)
    rows.push({ role: "mori", kind: "choices", content: "", payload: { choices } });
  if (suggestions.length)
    rows.push({ role: "mori", kind: "suggest", content: "", payload: { suggestions } });
  if (hr) {
    const holder = [...rows].reverse().find((r) => r.kind === "text" || r.kind === "status");
    if (holder)
      holder.payload = {
        ...(holder.payload && typeof holder.payload === "object" && !Array.isArray(holder.payload)
          ? holder.payload
          : {}),
        hr,
      } as Json;
    else rows.push({ role: "mori", kind: "status", content: "Answered", payload: { hr } as Json });
  }
  // One insert gives every row the same time, and history is read back in time order, so give each
  // row its own millisecond (after the question) to keep the answer in order next time.
  const base = Math.max(Date.now(), Number.isFinite(askedAt) ? askedAt + 1 : 0);
  const out = await db
    .from("mori_messages")
    .insert(rows.map((r, i) => ({ ...r, created_at: new Date(base + i).toISOString() })))
    .select("id, role, kind, content, payload, created_at");
  if (out.error) throw out.error;
  emit({ type: "done", rows: out.data });
  return out.data;
}
