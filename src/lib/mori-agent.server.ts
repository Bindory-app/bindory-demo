import { SYSTEM, tools } from "./mori-prompt.server";
import { marketFor } from "./market";
import { usdTo } from "./fx.server";
import { toCondition, type Condition } from "./ebay-sold.server";
import { priceCardRow } from "./mori-prices.server";
import { chatPhotos, saveOrderPhotos } from "./mori-order-photos.server";
import {
  COLLECTR_BAD_LINK,
  collectrSyncBinder,
  collectrSyncLink,
  isCollectrFollowUp,
  isCollectrLink,
} from "./collectr";
import { TOOL_STATUS, type MoriStreamEvent, type MoriRow } from "./mori-tools";
import {
  streamResponse,
  GatewayError,
  type ResponsesInputItem,
  type ResponsesResponse,
} from "./ai-gateway.server";
import type { Json } from "@/integrations/supabase/types";
import { asObject, type Args, type DB, type MoriRowDraft } from "./mori-context.server";
import { executeMoriTool, type MoriToolContext } from "./mori-execute.server";
import { finishMoriTurn, history } from "./mori-turn.server";

// Any tool-capable model ID from https://ai-gateway.vercel.sh/v1/models; override with AI_GATEWAY_MODEL.
// Default is on the AI Gateway free tier; newer models need paid credits.
const MODEL = process.env["AI_GATEWAY_MODEL"] || "google/gemini-2.5-flash";

const NEEDS_DATA =
  /card show|chase|trade-?up|trend|went up|went down|value|worth|price|complete .*set|share my taste|collectors|binder|video|orders?\b|my cards|my collection|add .* (?:to|into) my|wishlist/i;

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

/** Run a turn with the signed-in collector's RLS-scoped client. */
export async function runMori({
  db,
  userId,
  message,
  emit,
  signal,
  oidcToken,
  images = [],
  since,
  location,
  country,
}: {
  db: DB;
  userId: string;
  message: string;
  emit: (event: MoriStreamEvent) => void;
  signal?: AbortSignal;
  oidcToken?: string | null;
  images?: string[];
  since?: string | undefined;
  location?: string | undefined;
  country?: string | undefined;
}) {
  // Images go to the model on this turn; the transcript keeps only a note, not the image data.
  const stored = images.length
    ? `${message}\n[Sent ${images.length === 1 ? "a card photo: the front" : `${images.length} card photos: front and back`}]`
    : message;
  const past = await history(db, since);
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
  // only an explicit follow-up can continue a finished task.
  const collectr = collectrSyncLink(message);
  const { startSync, latestSync } = await import("./collectr-sync.server");
  const priorSync =
    collectr === null && !images.length && isCollectrFollowUp(message)
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

  const rows: MoriRowDraft[] = [];
  const market = marketFor(country);
  const priced = new Map<string, { output: Args; condition: Condition }>();
  const onlyPrice = () => priced.size === 1 && rows.every((row) => row.kind === "status");
  let cardsOnly = false;
  let finalText = "";
  // Save an explicitly attached sell pair even when the price will only arrive next turn.
  // Otherwise leave photos ephemeral until set_order actually needs them.
  let saved: Awaited<ReturnType<typeof saveOrderPhotos>> | undefined;
  const orderPhotos = async () => {
    if (!images.length) return since ? chatPhotos(db, userId, since) : null;
    if (saved === undefined) {
      saved = await saveOrderPhotos(db, userId, images);
      if (saved)
        rows.push({
          role: "mori",
          kind: "status",
          content: "Saved your photos for the listing",
          payload: { photos: saved },
        });
    }
    return saved;
  };
  const ctx: MoriToolContext = { message, seenIds: new Set<string>(), lastCard: "", orderPhotos };
  // Card ids Mori has actually looked up in this chat, so it never proposes a card from a guessed id.
  for (const id of JSON.stringify(past).match(/[a-z0-9.]+-[a-z0-9]+(?=\\?")/gi) ?? [])
    ctx.seenIds.add(id);

  try {
    const rate = market.currency === "USD" ? 1 : await usdTo(market.currency);
    const input: ResponsesInputItem[] = [
      ...past,
      {
        role: "developer",
        content:
          `[App note: the collector is in ${market.name} (country code ${market.country}). Show prices in ${market.currency} (${market.symbol}); their eBay site is ${market.ebay}. Pass country "${market.country}" and currency "${market.currency}" to get_card_prices. Today 1 US$ = ${rate} ${market.currency}; convert the collector's price to US$ for set_order at that rate.]` +
          (location
            ? `\n[App note: the collector's location, from their phone: ${location}. Use it for nearby shows, events and stores; never assume another city.]`
            : ""),
      },
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
    if (images.length >= 2 && /\bfor my sell order\b|^(?:please |i want to )?sell\b/i.test(message))
      await orderPhotos();
    turns: for (let turn = 0; turn < 6; turn++) {
      // Questions about the collector's own cards, prices or plans must look at real data first,
      // so the first step has to use a tool (the model sometimes answers from guesswork otherwise).
      const mustUseTool = turn === 0 && NEEDS_DATA.test(message);
      const stream = await streamWithFallback(input, signal, oidcToken, mustUseTool);
      const streamText = !mustUseTool && !onlyPrice();
      let res: ResponsesResponse | undefined;
      for await (const event of stream) {
        if (event.type === "response.output_text.delta" && streamText)
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
        const result = out.result;
        if (name === "get_card_prices") {
          const output = asObject(result);
          const id = asObject(output["card"])["id"];
          if (typeof id === "string")
            priced.set(id, { output, condition: toCondition(args["condition"]) ?? "nm" });
        }
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
        if (out.stop) {
          // A batch can contain several writes. Never execute calls after the card we showed.
          // A pre-tool sentence cannot know the sell proposal was blocked.
          finalText = out.rows.some((r) => r.kind === "photos")
            ? "Send clear photos of the front and back on a dark, flat background with all four corners in view."
            : text;
          break turns;
        }
      }
    }
    if (onlyPrice()) {
      const [id, { output, condition }] = [...priced][0]!;
      const row = await priceCardRow(id, market, output, condition).catch(() => null);
      if (row) {
        rows.push(row);
        cardsOnly = true;
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

  return finishMoriTurn(db, rows, finalText, askedAt, emit, cardsOnly);
}
