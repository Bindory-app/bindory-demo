import type { Args, MoriRowDraft } from "./mori-context.server";
import type { Market } from "./market";
import type { MoriStreamEvent } from "./mori-tools";
import type { OrderIntent, PriceCheckIntent } from "./mori-validation";
import type { findCards } from "./tcgdex";

export type IntentTools = {
  images: string[];
  market: Market;
  runTool: (name: string, args: Args) => Promise<{ result: unknown; rows: MoriRowDraft[] }>;
  emit: (event: MoriStreamEvent) => void;
  signal?: AbortSignal | undefined;
  oidcToken?: string | null | undefined;
};
export type IntentAnswer = { row?: MoriRowDraft; text: string; cardsOnly?: boolean };
type Candidate = Awaited<ReturnType<typeof findCards>>[number];
export type CardQuery = { name: string; number?: string | undefined; set?: string | undefined };

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
  intent: PriceCheckIntent | OrderIntent,
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
