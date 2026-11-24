/**
 * Mori's agents on HarnessRouter: six specialists (one per Ask Mori shortcut) plus Ask Mori, the
 * general agent for everything else. Each runs on its own harness (harnessrouter.json) with only
 * the tools listed here; /api/mori-mcp?agent=<key> enforces the same list. Routing is rules-based
 * on the collector's own words, decided by the server, never by the browser.
 */
export const MORI_AGENTS = ["ask", "price", "order", "grade", "add", "memory", "tradeup"] as const;
export type MoriAgent = (typeof MORI_AGENTS)[number];
export const isMoriAgent = (v: unknown): v is MoriAgent =>
  typeof v === "string" && (MORI_AGENTS as readonly string[]).includes(v);

/** Tools each specialist may call. Ask Mori ("ask") may call every tool. */
export const AGENT_TOOLS: Record<Exclude<MoriAgent, "ask">, readonly string[]> = {
  price: [
    "search_catalogue",
    "get_card_prices",
    "find_related_cards",
    "list_my_cards",
    "my_price_movers",
    "market_trends",
    "add_to_wishlist",
  ],
  order: [
    "search_catalogue",
    "get_card_prices",
    "set_order",
    "list_my_orders",
    "list_my_cards",
    "request_card_photos",
  ],
  grade: [
    "search_catalogue",
    "get_card_prices",
    "pre_grade_report",
    "list_my_cards",
    "web_search",
    "web_fetch",
  ],
  add: [
    "search_catalogue",
    "add_card_to_collection",
    "list_my_cards",
    "suggest_binder_for_card",
    "create_binder",
    "find_related_cards",
  ],
  memory: ["search_catalogue", "save_memory", "list_my_cards"],
  tradeup: [
    "list_my_cards",
    "my_price_movers",
    "search_catalogue",
    "get_card_prices",
    "find_related_cards",
    "add_to_wishlist",
  ],
};

export function agentMayUse(agent: MoriAgent, tool: string): boolean {
  return agent === "ask" || AGENT_TOOLS[agent].includes(tool);
}

/** Display names, as the harnesses are named in HarnessRouter. */
export const AGENT_NAMES: Record<MoriAgent, string> = {
  ask: "Ask Mori",
  price: "Mori Price Check",
  order: "Mori Orders",
  grade: "Mori Pre-grade",
  add: "Mori Add Cards",
  memory: "Mori Memories",
  tradeup: "Mori Trade-up",
};

/** The specialist a message clearly belongs to, or null when it is general (or a follow-up). The
 *  patterns match the shortcut templates' own wording first, then plain requests. */
export function routeMoriMessage(
  message: string,
  hasPhotos = false,
): Exclude<MoriAgent, "ask"> | null {
  const m = message.trim();
  if (/help me save this memory\.?$/i.test(m) || /\b(save|log)\b.{0,20}\bmemor(y|ies)\b/i.test(m))
    return "memory";
  if (
    /\bpre-?grad|\bshould i (send|get) it graded|\bshould i grade\b|\bgrade (it|this|my)\b/i.test(m)
  )
    return "grade";
  if (/\btrade-?up\b/i.test(m)) return "tradeup";
  if (
    /^(buy|sell)\b.*\bUS\$/i.test(m) ||
    /\b(buy|sell) (order|alert)s?\b/i.test(m) ||
    /\bmy (open )?orders\b|\bcancel\b.{0,30}\border\b/i.test(m)
  )
    return "order";
  if (/^(please )?add\b.*\bcollection\b|\badd (this|a|the) card\b/i.test(m)) return "add";
  if (/\bprice\b|\bworth\b|\bvalue\b|\bhow much\b/i.test(m)) return "price";
  if (hasPhotos) return "price";
  return null;
}
