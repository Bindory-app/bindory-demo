import type { Json } from "@/integrations/supabase/types";
import type { ResponsesInputItem } from "./ai-gateway.server";
import type { DB, MoriRowDraft } from "./mori-context.server";
import type { MoriStreamEvent } from "./mori-tools";

/** Maximum recent `mori_messages` rows loaded into model context per turn (~8–15 turns at
 *  4–7 rows/turn including status/confirm/suggest rows). Bounds DB reads and prompt tokens when
 *  `since` is omitted or a chat grows long. */
export const HISTORY_LIMIT = 60;

/** The conversation so far: up to the most recent `HISTORY_LIMIT` rows since `since` (when the
 *  collector opened Ask Mori or tapped New chat) and before `before` (this turn's own question),
 *  returned in chronological order. */
export async function history(
  db: DB,
  since?: string,
  before?: string,
): Promise<ResponsesInputItem[]> {
  let q = db.from("mori_messages").select("role, kind, content, payload");
  if (since) q = q.gt("created_at", since);
  if (before) q = q.lt("created_at", before);
  const page = await q
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(0, HISTORY_LIMIT - 1);
  if (page.error) throw page.error;
  const data = [...page.data].reverse();
  return data
    .filter((m) => m.kind !== "suggest")
    .map((m): ResponsesInputItem => {
      if (m.role === "user") return { role: "user", content: m.content };
      const text =
        m.kind === "status"
          ? `[Tool result: ${JSON.stringify(m.payload)}]`
          : m.kind === "confirm"
            ? `[Confirmation: ${JSON.stringify(m.payload)}]`
            : m.kind === "choices"
              ? `[Choices: ${JSON.stringify(m.payload)}]`
              : m.kind === "photos" &&
                  m.payload &&
                  typeof m.payload === "object" &&
                  "intent" in m.payload
                ? `[Requested photos: ${JSON.stringify(m.payload["intent"])}]`
                : m.content;
      return { role: "assistant", content: [{ type: "output_text", text, annotations: [] }] };
    });
}

/** A reply's parts, one chat bubble each: the agent separates them with a line of "---". */
export function replyParts(text: string): string[] {
  return text
    .split(/\n[ \t]*-{3,}[ \t]*(?:\n|$)/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/** Ends one answer: pulls out the follow-up suggestions, puts the reply before any card, and saves
 *  every row in order after the question. */
export async function finishMoriTurn(
  db: DB,
  rows: MoriRowDraft[],
  text: string,
  askedAt: number,
  emit: (event: MoriStreamEvent) => void,
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
  if (rows.some((r) => r.kind === "choices")) suggestions = choices = [];
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
        r.kind === "photos" ||
        r.kind === "choices",
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
