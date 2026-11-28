import { SYSTEM, tools, flowKinds } from "./mori-prompt.server";
import { parseMoriIntent, type MoriIntent } from "./mori-validation";
import type { IntentAnswer, IntentTools } from "./mori-intent-card.server";
import { runPreGrade } from "./mori-pre-grade.server";
import { runPriceCheck } from "./mori-price-check.server";
import { runOrder, PHOTO_INSTRUCTIONS } from "./mori-order.server";
import { runMemory } from "./mori-memory.server";
import { marketFor } from "./market";
import { toCondition, type Condition } from "./ebay-sold.server";
import { priceCardRow } from "./mori-prices.server";
import { saveOrderPhotos } from "./mori-order-photos.server";
import {
  COLLECTR_BAD_LINK,
  collectrSyncBinder,
  collectrSyncLink,
  isCollectrFollowUp,
  isCollectrLink,
} from "./collectr";
import { TOOL_STATUS, type MoriStreamEvent, type MoriRow } from "./mori-tools";
import {
  callToolOnce,
  streamResponse,
  GatewayError,
  type ResponsesInputItem,
  type ResponsesResponse,
} from "./ai-gateway.server";
import type { Json } from "@/integrations/supabase/types";
import { asObject, type Args, type DB, type MoriRowDraft } from "./mori-context.server";
import { executeMoriTool, type MoriToolContext } from "./mori-execute.server";
import { createTurnTimer, type TurnTimer } from "./mori-timing.server";
import { serializeToolResult } from "./mori-tool-output";
import { finishMoriTurn, history } from "./mori-turn.server";

const NEEDS_DATA =
  /card show|chase|trade-?up|trend|went up|went down|value|worth|price|complete .*set|share my taste|collectors|binder|video|orders?\b|my cards|my collection|add .* (?:to|into) my|wishlist/i;

/** Run a turn with the signed-in collector's RLS-scoped client. */
export async function runMori({
  db,
  userId,
  message,
  intent: rawIntent,
  emit,
  signal,
  oidcToken,
  images = [],
  since,
  location,
  country,
  timing,
}: {
  db: DB;
  userId: string;
  message: string;
  intent?: unknown;
  emit: (event: MoriStreamEvent) => void;
  signal?: AbortSignal;
  oidcToken?: string | null;
  images?: string[];
  since?: string | undefined;
  location?: string | undefined;
  country?: string | undefined;
  timing?: TurnTimer;
}) {
  const ownTimer = !timing;
  const timer = timing ?? createTurnTimer();
  // Images go to the model on this turn; the transcript keeps only a note, not the image data.
  const stored = images.length
    ? `${message}\n[Sent ${images.length === 1 ? "a card photo: the front" : `${images.length} card photos: front and back`}]`
    : message;
  const intent = parseMoriIntent(rawIntent, images.length > 0);
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
  const collectr = rawIntent === undefined ? collectrSyncLink(message) : null;
  const { startSync, latestSync } = await import("./collectr-sync.server");
  const priorSync =
    rawIntent === undefined && collectr === null && !images.length && isCollectrFollowUp(message)
      ? await latestSync(db, userId, since)
      : null;
  if (collectr !== null || priorSync) {
    if (collectr !== null && !isCollectrLink(collectr)) {
      const done = await finishMoriTurn(db, [], COLLECTR_BAD_LINK, askedAt, emit);
      if (ownTimer) timer.flush("done");
      return done;
    }
    try {
      const syncStarted = Date.now();
      const row = await startSync(
        db,
        userId,
        priorSync
          ? { followUp: message, prior: priorSync }
          : { link: collectr!, binder: collectrSyncBinder(message) },
      );
      timer.recordStage("collectr_sync", Date.now() - syncStarted);
      const ins = await db
        .from("mori_messages")
        .insert(row)
        .select("id, role, kind, content, payload, created_at")
        .single();
      if (ins.error) throw ins.error;
      emit({ type: "done", rows: [ins.data as unknown as MoriRow] });
      if (ownTimer) timer.flush("done");
      return;
    } catch (e) {
      console.error("Collectr sync failed to start", e instanceof Error ? e.message : e);
      const done = await finishMoriTurn(
        db,
        [],
        "I could not start the Collectr sync just now. Please try again in a moment.",
        askedAt,
        emit,
      );
      if (ownTimer) timer.flush("done");
      return done;
    }
  }

  const rows: MoriRowDraft[] = [];
  const market = marketFor(country);
  const priced = new Map<string, { output: Args; condition: Condition }>();
  const onlyPrice = () => priced.size === 1 && rows.every((row) => row.kind === "status");
  let cardsOnly = false;
  let finalText = "";
  // Never reuse a previous card's photos, including on a free-text fallback.
  let saved: ReturnType<typeof saveOrderPhotos> | undefined;
  const ctx: MoriToolContext = {
    message,
    seenIds: new Set<string>(),
    lastCard: "",
    hasOrderPhotos: images.length === 2,
    orderPhotos: () => (saved ??= saveOrderPhotos(db, userId, images)),
    timing: timer,
  };
  const runTool = async (name: string, args: Args) => {
    signal?.throwIfAborted();
    const content = TOOL_STATUS[name] ?? "Working on it";
    emit({ type: "status", name, text: content });
    const status: MoriRowDraft = {
      role: "mori",
      kind: "status",
      content,
      payload: { name, input: args as Json },
    };
    rows.push(status);
    const toolStarted = Date.now();
    const out = await executeMoriTool(db, userId, name, args, ctx);
    const failed =
      out.result &&
      typeof out.result === "object" &&
      !Array.isArray(out.result) &&
      "error" in out.result;
    timer.recordTool({ name, ms: Date.now() - toolStarted, ok: !failed });
    // What is stored and what the model reads back are the same bounded, valid JSON.
    const serialized = serializeToolResult(out.result);
    status.payload = { name, input: args as Json, output: JSON.parse(serialized) as Json };
    rows.push(...out.rows);
    return { ...out, serialized };
  };

  // Structured flows make at most one forced call each; it is timed like a loop turn (turn 0).
  const callTool: IntentTools["callTool"] = async (tool, instructions, callInput, options) => {
    const started = Date.now();
    let model = "";
    const record = (ok: boolean, code?: string) =>
      timer.recordModel({
        turn: 0,
        model,
        ms: Date.now() - started,
        ok,
        ...(code ? { code } : {}),
      });
    try {
      const out = await callToolOnce(tool, instructions, callInput, {
        ...options,
        signal,
        oidcToken,
        onModel: (m) => {
          model = m;
        },
      });
      record(true);
      return out;
    } catch (e) {
      record(false, e instanceof GatewayError ? e.code : undefined);
      throw e;
    }
  };

  const options: IntentTools = { message, images, market, runTool, emit, signal, callTool };
  // Photos claimed by another flow never become sell photos, even if the flow fails.
  const claimPhotos = (kind: MoriIntent["kind"]) => {
    if (kind !== "order") ctx.hasOrderPhotos = false;
  };
  const runIntent = async (action: MoriIntent, reading?: Args) => {
    try {
      signal?.throwIfAborted();
      if (action.kind === "order" || action.kind === "pre_grade") ctx.photoIntent = action;
      else delete ctx.photoIntent;
      switch (action.kind) {
        case "price_check":
          return await runPriceCheck(action, options);
        case "order":
          return await runOrder(action, ctx.hasOrderPhotos ? options : { ...options, images: [] });
        case "pre_grade":
          return await runPreGrade(action, options);
        case "memory":
          return await runMemory(action, options, reading);
      }
    } catch (error) {
      // A gateway failure would fail the chat loop too, only later; report it now.
      if (signal?.aborted || error instanceof GatewayError) throw error;
      console.warn("Structured Mori request unavailable; continuing in chat");
      return null;
    }
  };
  const finishAnswer = async (answer: IntentAnswer) => {
    signal?.throwIfAborted();
    if (answer.row) rows.push(answer.row);
    const done = await finishMoriTurn(db, rows, answer.text, askedAt, emit, answer.cardsOnly);
    if (ownTimer) timer.flush("done");
    return done;
  };
  if (intent) {
    claimPhotos(intent.kind);
    const answer = await runIntent(intent);
    if (answer) return finishAnswer(answer);
  }

  // Successful structured turns never need to load the conversation. Exclude this turn's
  // already-persisted question when entering the general loop (including fallbacks).
  const historyStarted = Date.now();
  const past = await history(db, since, ins.data.created_at);
  timer.recordStage("history", Date.now() - historyStarted);
  // Card ids Mori has actually looked up in this chat, so it never proposes a card from a guessed id.
  for (const id of JSON.stringify(past).match(/[a-z0-9.]+-[a-z0-9]+(?=\\?")/gi) ?? [])
    ctx.seenIds.add(id);

  try {
    const input: ResponsesInputItem[] = [
      ...past,
      {
        role: "developer",
        content:
          `[App note: the collector is in ${market.name} (country code ${market.country}). Show prices in ${market.currency} (${market.symbol}); their eBay site is ${market.ebay}. Pass country "${market.country}" and currency "${market.currency}" to get_card_prices. If the tool reports fx_fallback, its prices are US$.]` +
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
    // General chat can use a failed lookup instead of repeating it or asking for the same details.
    for (const row of rows)
      if (row.kind === "status")
        input.push({
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: `[Tool result: ${JSON.stringify(row.payload)}]`,
              annotations: [],
            },
          ],
        });
    const failedFlows = new Map<string, string>();
    turns: for (let turn = 0; turn < 6; turn++) {
      // Questions about the collector's own cards, prices or plans must look at real data first,
      // so the first step has to use a tool (the model sometimes answers from guesswork otherwise).
      const mustUseTool = turn === 0 && !(intent && rows.length) && NEEDS_DATA.test(message);
      const modelStarted = Date.now();
      let activeModel = "";
      let res: ResponsesResponse | undefined;
      try {
        const stream = await streamResponse(
          {
            instructions: SYSTEM,
            input,
            tools: failedFlows.size ? tools.filter((t) => !failedFlows.has(t.name)) : tools,
            ...(mustUseTool ? { tool_choice: "required" } : {}),
            max_output_tokens: 3000,
          },
          {
            signal,
            oidcToken,
            onModel: (m) => {
              activeModel = m;
            },
          },
        );
        const streamText = !mustUseTool && !onlyPrice();
        for await (const event of stream) {
          if (event.type === "response.output_text.delta" && streamText)
            emit({ type: "text", text: event.delta ?? "" });
          if (event.type === "response.completed") res = event.response;
          if (event.type === "response.incomplete") throw new Error("Mori response incomplete");
        }
        if (!res) throw new Error("Mori response did not complete");
        timer.recordModel({
          turn: turn + 1,
          model: activeModel,
          ms: Date.now() - modelStarted,
          ok: true,
        });
      } catch (modelErr) {
        timer.recordModel({
          turn: turn + 1,
          model: activeModel,
          ms: Date.now() - modelStarted,
          ok: false,
          ...(modelErr instanceof GatewayError ? { code: modelErr.code } : {}),
        });
        throw modelErr;
      }
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
        const parsed: unknown = (() => {
          try {
            return JSON.parse(call.arguments ?? "");
          } catch {
            return null;
          }
        })();
        const args = asObject(parsed);
        input.push({
          type: "function_call",
          call_id: call.call_id ?? "",
          name,
          arguments: call.arguments ?? "{}",
        });
        const kind = flowKinds.get(name);
        if (kind) {
          claimPhotos(kind);
          const previous = failedFlows.get(name);
          if (previous) return await finishAnswer({ text: previous });
          // The router saw any photo: price needs its printing, memory needs its reading.
          // Only an actual tagged memory supplies trusted form slots.
          const action: MoriIntent | null | false =
            parsed === args &&
            !("kind" in args) &&
            (kind === "memory"
              ? typeof args["title"] === "string" && (intent?.kind === "memory" ? intent : { kind })
              : parseMoriIntent({ ...args, kind }, false));
          const card = action && "card" in action ? action.card : undefined;
          const knownCard =
            !card ||
            !("id" in card) ||
            ctx.seenIds.has(card.id) ||
            message.split(/[^a-z\d.-]+/i).includes(card.id);
          if (action && knownCard) {
            const answer = await runIntent(action, kind === "memory" ? args : undefined);
            if (answer) return await finishAnswer(answer);
          }
          const question =
            kind === "memory"
              ? "What would you like to remember?"
              : kind === "pre_grade"
                ? "Could you send clear front and back photos of this card?"
                : kind === "order" && !action
                  ? "Which printing, side and target price (with currency) should I use?"
                  : "Which card name and printed collector number should I use?";
          failedFlows.set(name, question);
          input.push({
            type: "function_call_output",
            call_id: call.call_id ?? "",
            output: JSON.stringify({
              error:
                "Could not complete this flow. Do not retry it this turn; ask the collector one clarifying question.",
              question,
            }),
          });
          continue;
        }
        // Do not grant a hallucinated/retired model tool the executor's internal privileges.
        if (!tools.some((t) => t.name === name)) {
          input.push({
            type: "function_call_output",
            call_id: call.call_id ?? "",
            output: '{"error":"Tool unavailable. Use a listed tool or ask for clarification."}',
          });
          continue;
        }
        const out = await runTool(name, args);
        const result = out.result;
        if (name === "get_card_prices") {
          const output = asObject(result);
          const id = asObject(output["card"])["id"];
          if (typeof id === "string")
            priced.set(id, { output, condition: toCondition(args["condition"]) ?? "nm" });
        }
        input.push({
          type: "function_call_output",
          call_id: call.call_id ?? "",
          output: out.serialized,
        });
        if (out.stop) {
          // A batch can contain several writes. Never execute calls after the card we showed.
          // A pre-tool sentence cannot know the sell proposal was blocked.
          if (typeof asObject(result)["error"] === "string") {
            priced.clear();
            finalText = String(asObject(result)["error"]);
          } else finalText = out.rows.some((r) => r.kind === "photos") ? PHOTO_INSTRUCTIONS : text;
          break turns;
        }
      }
    }
    if (!failedFlows.size && onlyPrice()) {
      const priceCardStarted = Date.now();
      const [id, { output, condition }] = [...priced][0]!;
      const row = await priceCardRow(id, market, output, condition).catch(() => null);
      timer.recordStage("price_card", Date.now() - priceCardStarted);
      if (row) {
        rows.push(row);
        cardsOnly = true;
      }
    }
  } catch (e) {
    if (signal?.aborted) {
      if (ownTimer) timer.flush("aborted", "aborted");
      throw e;
    }
    console.error(
      "Mori gateway error",
      e instanceof GatewayError ? { code: e.code, ids: e.ids } : e,
    );
    if (ownTimer) timer.flush("error", e instanceof GatewayError ? e.code : "internal");
    throw e;
  }

  const finishStarted = Date.now();
  const done = await finishMoriTurn(db, rows, finalText, askedAt, emit, cardsOnly);
  timer.recordStage("finish", Date.now() - finishStarted);
  if (ownTimer) timer.flush("done");
  return done;
}
