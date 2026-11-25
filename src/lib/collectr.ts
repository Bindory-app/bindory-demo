/**
 * "Sync from Collectr": the collector pastes their public Collectr link (and picks a binder).
 * The "Collection sync" harness (harnessrouter.json, feature "collectr") reads the Collectr page
 * with its browser and proposes the cards to add; Bindory adds them itself after the collector
 * approves (the harness never touches Bindory).
 */
const SYNC = /^\s*sync my collectr collection\b[:\s]*(\S*)/i;

/** The pasted link when the message is a Collectr sync request, "" when the link is missing. */
export function collectrSyncLink(message: string): string | null {
  const m = SYNC.exec(message);
  return m ? (m[1] ?? "") : null;
}

/** The binder named in the sync message: an existing one, or a new one to create. */
export function collectrSyncBinder(message: string): { name: string; new: boolean } | null {
  const m = /\binto (the binder|a new binder called) "([^"]{1,60})"/i.exec(message);
  return m?.[2]?.trim() ? { name: m[2].trim(), new: /new/i.test(m[1] ?? "") } : null;
}

/** A public Collectr link (https, getcollectr.com), or null. */
export function isCollectrLink(link: string): boolean {
  try {
    const u = new URL(link);
    return (
      u.protocol === "https:" &&
      (u.hostname === "getcollectr.com" || u.hostname.endsWith(".getcollectr.com"))
    );
  } catch {
    return false;
  }
}

export const COLLECTR_BAD_LINK =
  "That does not look like a Collectr link. In Collectr, open Profile, then Settings, turn on Portfolio Sharing and copy the link it gives you (it starts with https://app.getcollectr.com/). Then tap Sync from Collectr and paste it.";

/** The task sent to the harness: the source, the destination and the behaviour, with what the
 *  collector already owns so nothing is proposed twice. */
export function collectrTaskInput(
  link: string,
  binder: { name: string; new: boolean } | null,
  owned: { name: string; number: string | null; set_name: string | null }[],
): string {
  const have = owned.length
    ? owned
        .slice(0, 400)
        .map(
          (c) =>
            `- ${c.name}${c.number ? ` ${c.number}` : ""}${c.set_name ? ` (${c.set_name})` : ""}`,
        )
        .join("\n")
    : "(none yet)";
  return [
    `Source URL: ${link}`,
    "Reading the source: Collectr pages load their cards with JavaScript. First look for Firecrawl among your connected apps (the Apps tools: search for \"firecrawl\", then execute its scrape or crawl action on the source URL, rendering JavaScript, with actions that scroll to load the whole list). Use Browser only if Firecrawl is not available or fails, and say which one you used. Read every card, not just the first screen.",
    `Destination: the collector's Bindory collection${binder ? `, ${binder.new ? "in a new binder called" : "in their binder"} "${binder.name}"` : ""}. You cannot open or change Bindory: Bindory adds the approved cards itself, so only read the Collectr page and return the proposed change list. Do not ask for Bindory access.`,
    "Synchronization behavior: add missing items only. Never delete, never update quantities in Bindory, never change anything on Collectr. The source collection may not belong to the collector.",
    "Scope: Pokémon trading cards only (raw or graded singles). Skip sealed products and other games, and say how many you skipped.",
    `Cards already in the Bindory collection (do not propose these):\n${have}`,
    'After your Markdown sections, add one fenced code block tagged json holding {"bindory_items":[{"name":"Card name","number":"125/094","set":"Set name","quantity":1}]} with every Pokémon card you propose to add, using the card number exactly as Collectr shows it.',
  ].join("\n\n");
}

export type SyncItem = {
  name: string;
  number?: string | undefined;
  set?: string | undefined;
  quantity?: number | undefined;
};

/** The machine-readable list at the end of the harness's answer (empty when missing). */
export function syncItems(answer: string): SyncItem[] {
  const blocks = [...answer.matchAll(/```json\s*([\s\S]*?)```/gi)];
  for (const b of blocks.reverse()) {
    try {
      const j = JSON.parse(b[1] ?? "") as { bindory_items?: unknown };
      if (!Array.isArray(j.bindory_items)) continue;
      return j.bindory_items
        .filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object")
        .map((x) => ({
          name: String(x["name"] ?? "")
            .trim()
            .slice(0, 80),
          number: typeof x["number"] === "string" ? x["number"].trim().slice(0, 20) : undefined,
          set: typeof x["set"] === "string" ? x["set"].trim().slice(0, 80) : undefined,
          quantity: typeof x["quantity"] === "number" ? x["quantity"] : undefined,
        }))
        .filter((x) => x.name)
        .slice(0, 200);
    } catch {
      continue;
    }
  }
  return [];
}

/** The answer without the machine-readable block (what the collector reads). */
export const syncAnswerText = (answer: string) =>
  answer.replace(/```json\s*[\s\S]*?bindory_items[\s\S]*?```/gi, "").trim();
