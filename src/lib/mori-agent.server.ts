import { routeMoriMessage } from "./mori-agents";
import { SYSTEM, tools } from "./mori-prompt.server";
import {
  COLLECTR_BAD_LINK,
  collectrSyncBinder,
  collectrSyncLink,
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
import type { Args, DB } from "./mori-context.server";
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
