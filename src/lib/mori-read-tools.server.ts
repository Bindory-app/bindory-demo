import type { SupabaseClient } from "@supabase/supabase-js";
import { marketFor } from "./market";
import { toCondition } from "./ebay-sold.server";
import { stringArg, type Args, type DB } from "./mori-context.server";
import { marketPrices, priceMoves } from "./mori-prices.server";
import { cardsByIllustrator, findCards, getCard, getCardPricing, getSetCards, searchCards } from "./tcgdex";
import { webFetch, webSearch } from "./telem.server";

/** The collector's market from the tool's country (or currency) argument; US by default. */
function marketFromArgs(a: Args) {
  const byCurrency: Record<string, string> = {
    AUD: "AU",
    GBP: "GB",
    CAD: "CA",
    EUR: "DE",
    USD: "US",
  };
  const c = stringArg(a["country"]) ?? byCurrency[(stringArg(a["currency"]) ?? "").toUpperCase()];
  return marketFor(c);
}

// Popular chase cards (checked in TCGdex) whose prices show where collectors are heading.
const TREND_CARDS = [
  "sv08.5-161",
  "me02-125",
  "sv03.5-199",
  "swsh7-215",
  "swsh12-186",
  "sv08.5-156",
  "sv04.5-234",
  "sv08-238",
  "sv03.5-201",
  "swsh11-186",
  "me01-180",
  "sv09-184",
  "sv08.5-167",
];

export async function runReadTool(db: DB, name: string, a: Args): Promise<unknown> {
  switch (name) {
    case "search_catalogue": {
      const r = await findCards(stringArg(a["name"]) ?? "", stringArg(a["number"]), stringArg(a["set"]));
      return r.length
        ? r
        : {
            results: [],
            note: "No cards found. Try the name alone, or check the number with the collector.",
          };
    }
    case "get_card_prices": {
      const r = await getCardPricing(stringArg(a["card_id"]) ?? "");
      if (!r) return { error: "Card not found" };
      const card = { id: r.card.id, name: r.card.name, number: r.card.localId };
      const m = await marketPrices(
        card,
        r.pricing,
        marketFromArgs(a),
        Array.isArray(a["sold_listings"]) ? (a["sold_listings"] as unknown[]) : undefined,
        toCondition(a["condition"]) ?? "nm",
      );
      return {
        card: { ...card, set: r.card.set.name, rarity: r.card.rarity },
        // Every price below is in this currency, for the collector's market.
        ...m.forTool,
        ...(m.forTool.price_points || m.forTool.recent_sold || m.forTool.listings
          ? {}
          : { note: "No price data for this card" }),
      };
    }
    case "web_search": {
      const results = await webSearch(stringArg(a["query"]) ?? "");
      return results.length
        ? { results }
        : {
            results: [],
            note: "Nothing found. Try different words, or say you could not find it.",
          };
    }
    case "web_fetch": {
      const urls = Array.isArray(a["urls"]) ? a["urls"].filter((u) => typeof u === "string") : [];
      const pages = await webFetch(urls as string[]);
      return pages.length ? { pages } : { error: "Give 1-3 http(s) links from web_search." };
    }
    case "find_related_cards": {
      const c = await getCard(stringArg(a["card_id"]) ?? "");
      if (!c) return { results: [], note: "Card not found" };
      const [same, art] = await Promise.all([
        searchCards(c.name, 6),
        c.illustrator ? cardsByIllustrator(c.illustrator, 6) : Promise.resolve([]),
      ]);
      return {
        card: { id: c.id, name: c.name, illustrator: c.illustrator },
        same_pokemon: same.filter((x) => x.id !== c.id).map((x) => ({ id: x.id, name: x.name })),
        same_artist: art.filter((x) => x.id !== c.id).map((x) => ({ id: x.id, name: x.name })),
      };
    }
    case "list_my_cards": {
      let q = db
        .from("cards")
        .select("tcgdex_id, name, set_name, illustrator, year, rarity")
        .order("created_at", { ascending: false })
        .limit(50);
      if (stringArg(a["artist"])) q = q.ilike("illustrator", `%${stringArg(a["artist"])}%`);
      if (stringArg(a["set"])) q = q.ilike("set_name", `%${stringArg(a["set"])}%`);
      if (typeof a["year"] === "number") q = q.eq("year", a["year"]);
      const { data, error } = await q;
      if (error) throw error;
      return data.length ? data : { results: [], note: "No matching cards in the collection" };
    }
    case "list_my_orders": {
      // market_orders is created by setup/009 and is not in the generated types yet.
      const { data, error } = await (db as unknown as SupabaseClient)
        .from("market_orders")
        .select("id, side, card_name, image_url, price_usd, status, expires_at, created_at")
        .eq("status", "open")
        .gt("expires_at", new Date().toISOString())
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) throw error;
      return data?.length ? data : { results: [], note: "No open orders" };
    }
    case "my_price_movers": {
      const { data, error } = await db
        .from("cards")
        .select("tcgdex_id, name, set_name")
        .order("created_at", { ascending: false })
        .limit(24);
      if (error) throw error;
      const ids = [...new Set(data.map((c) => c.tcgdex_id).filter(Boolean))];
      const moves = await priceMoves(ids);
      return moves.length
        ? {
            compared: "7-day average price vs 30-day average price",
            cards_checked: moves.length,
            moves,
          }
        : { results: [], note: "No price history for the cards in this collection" };
    }
    case "market_trends": {
      const moves = await priceMoves(TREND_CARDS);
      return moves.length
        ? { compared: "7-day average price vs 30-day average price", moves }
        : { results: [], note: "Market prices are unavailable right now. Try again shortly." };
    }
    case "get_set_cards": {
      const set = await getSetCards(stringArg(a["set_id"]) ?? "");
      if (!set) return { error: "Set not found" };
      return {
        set: { id: set.id, name: set.name, total: set.cards.length },
        cards: set.cards.slice(0, 300).map((c) => ({ id: c.id, number: c.localId, name: c.name })),
      };
    }
    case "find_collectors": {
      // Public profiles only (bio and public binder count); private memories are never used for discovery.
      const { data, error } = await db.rpc("list_public_collectors", { p_query: "" });
      if (error) throw error;
      const list = (Array.isArray(data) ? data : []) as {
        display_name?: string;
        username?: string;
        bio?: string;
        binders?: number;
      }[];
      return list.length
        ? list.map((c) => ({
            name: c.display_name,
            username: c.username,
            bio: c.bio,
            public_binders: c.binders,
          }))
        : { results: [], note: "No public collector profiles found" };
    }
    case "suggest_binder_for_card": {
      const [{ data: binders, error }, card] = await Promise.all([
        db.from("binders").select("id, name, description, binder_cards(count)"),
        getCard(stringArg(a["card_id"]) ?? ""),
      ]);
      if (error) throw error;
      return {
        card: card ? { id: card.id, name: card.name, set: card.set.name } : null,
        binders: binders ?? [],
      };
    }
  }
  return { error: "Unknown tool" };
}
