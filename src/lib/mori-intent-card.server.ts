import { z } from "zod";
import type { ResponsesFunctionTool, ResponsesInputItem } from "./ai-gateway.server";
import type { Args, MoriRowDraft } from "./mori-context.server";
import type { Market } from "./market";
import type { MoriStreamEvent } from "./mori-tools";
import type { OrderIntent, PreGradeIntent, PriceCheckIntent } from "./mori-validation";
import type { findCards } from "./tcgdex";

export type IntentTools = {
  images: string[];
  market: Market;
  runTool: (name: string, args: Args) => Promise<{ result: unknown; rows: MoriRowDraft[] }>;
  emit: (event: MoriStreamEvent) => void;
  /** One forced function call; the runtime owns credentials, cancellation and timing. */
  callTool: (
    tool: ResponsesFunctionTool,
    instructions: string,
    input: ResponsesInputItem[],
    options?: { maxOutputTokens: number },
  ) => Promise<unknown>;
  signal?: AbortSignal | undefined;
};
export type IntentAnswer = { row?: MoriRowDraft; text: string; cardsOnly?: boolean };
type Candidate = Awaited<ReturnType<typeof findCards>>[number];
export type CardQuery = { name: string; number?: string | undefined; set?: string | undefined };

export const cardReadingParameters = {
  type: "object",
  properties: {
    confidence: { type: "string", enum: ["high", "low"] },
    name: { type: "string" },
    number: { type: "string" },
    set: { type: "string" },
  },
  required: ["name", "confidence"],
  additionalProperties: false,
};
const photoReading = z.object({
  confidence: z.enum(["high", "low"]),
  name: z.string().trim().min(1).max(160),
  number: z.string().trim().max(24).optional(),
  set: z.string().trim().max(160).optional(),
});
export function confidentCardReading(raw: unknown): CardQuery | null {
  const result = photoReading.safeParse(raw);
  return result.success && result.data.confidence === "high" ? result.data : null;
}

function plausibleMatches(query: CardQuery, result: unknown): Candidate[] {
  if (!Array.isArray(result)) return [];
  const matches = [...new Map((result as Candidate[]).map((c) => [c.id, c])).values()];
  const [num, total] = (query.number ?? "").split("/").map((s) =>
    s
      .trim()
      .toLowerCase()
      .replace(/^0+(?=\d)/, ""),
  );
  const possible = matches.filter(
    (c) =>
      (!num || c.number.toLowerCase().replace(/^0+(?=\d)/, "") === num) &&
      // The official numeric set size cannot verify a subset code such as "TG30".
      (!total || !/^\d+$/.test(total) || !c.set_size || String(c.set_size) === total) &&
      (!query.set || c.set.toLowerCase().includes(query.set.toLowerCase())),
  );
  if (!num) return possible;
  const exact = possible.filter((c) => c.name.toLowerCase() === query.name.toLowerCase());
  return exact.length ? exact : possible;
}

/** Resolve the printing or return choices that resume exactly the same collector action. */
export async function resolveIntentCard(
  card: { id: string } | CardQuery,
  intent: PriceCheckIntent | OrderIntent | PreGradeIntent,
  runTool: IntentTools["runTool"],
): Promise<string | IntentAnswer | null> {
  if ("id" in card) return card.id;
  const query = {
    name: card.name,
    ...(card.number ? { number: card.number } : {}),
    ...(card.set ? { set: card.set } : {}),
  };
  const matches = plausibleMatches(query, (await runTool("search_catalogue", query)).result);
  if (!matches.length) return null;
  if (matches.length === 1) return matches[0]!.id;
  // A pre-grade can still show the assessment without a price for an ambiguous printing.
  if (intent.kind === "pre_grade") return null;
  return {
    text:
      intent.kind === "order"
        ? "Which printing is this order for?"
        : "Which printing should I price?",
    row: {
      role: "mori",
      kind: "choices",
      content: "",
      payload: {
        choices: matches.map((c) => ({
          label: `${c.name} ${c.number}${c.set_size ? `/${c.set_size}` : ""} (${c.set})`,
          intent: { ...intent, card: { id: c.id } },
        })),
      },
    },
  };
}
