/**
 * Trade-up games, server side (see tradeup.ts for the fair-odds draw). Every change goes through
 * here with the service role: cards must be the player's own, values come from today's market
 * prices (never from the phone), and the draw uses both players' revealed secrets.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getCardPricing, priceScale, usdRange } from "./tcgdex";
import {
  MAX_CARDS_PER_SIDE,
  MAX_TOTAL_USD,
  decide,
  isCommit,
  isSecret,
  joinCode,
  sha256,
  winChances,
} from "./tradeup";

type Card = {
  id: string;
  tcgdex_id: string;
  name: string;
  number: string | null;
  set_name: string | null;
  image: string | null;
  usd: number;
};
type Game = {
  id: string;
  code: string;
  host_id: string;
  guest_id: string | null;
  host_cards: Card[];
  guest_cards: Card[];
  host_total: number;
  guest_total: number;
  host_commit: string | null;
  guest_commit: string | null;
  host_secret: string | null;
  guest_secret: string | null;
  status: "open" | "rolled" | "cancelled";
  winner: "host" | "guest" | null;
  draw: number | null;
  host_chance: number | null;
  expires_at: string;
};
export class TradeupError extends Error {}

async function admin(): Promise<SupabaseClient> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin as unknown as SupabaseClient;
}
const T = "tradeup_games";

async function load(db: SupabaseClient, userId: string, id: string): Promise<Game> {
  const { data, error } = await db.from(T).select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  const g = data as Game | null;
  if (!g || (g.host_id !== userId && g.guest_id !== userId))
    throw new TradeupError("Game not found.");
  return g;
}
const sideOf = (g: Game, userId: string) =>
  (g.host_id === userId ? "host" : "guest") as "host" | "guest";
const other = (s: "host" | "guest") => (s === "host" ? "guest" : "host");
const expired = (g: Game) => g.status === "open" && Date.parse(g.expires_at) < Date.now();

/** The game as one player sees it: their side as "me", the other as "them". */
export function view(g: Game, userId: string) {
  const me = sideOf(g, userId),
    them = other(me);
  const chances = winChances(Number(g[`${me}_total`]), Number(g[`${them}_total`]));
  return {
    id: g.id,
    code: g.code,
    status: expired(g) ? "expired" : g.status,
    role: me,
    joined: Boolean(g.guest_id),
    me: {
      cards: g[`${me}_cards`],
      total: Number(g[`${me}_total`]),
      locked: Boolean(g[`${me}_commit`]),
      revealed: Boolean(g[`${me}_secret`]),
    },
    them: {
      cards: g[`${them}_cards`],
      total: Number(g[`${them}_total`]),
      locked: Boolean(g[`${them}_commit`]),
      revealed: Boolean(g[`${them}_secret`]),
    },
    chance: { me: chances.host, them: chances.guest },
    result:
      g.status === "rolled" && g.winner
        ? {
            winner: g.winner === me ? "you" : "them",
            draw: Number(g.draw),
            your_chance: me === "host" ? Number(g.host_chance) : 1 - Number(g.host_chance),
            // Everything needed to check the draw: both secrets and their hashes.
            proof: {
              host_secret: g.host_secret,
              guest_secret: g.guest_secret,
              host_commit: g.host_commit,
              guest_commit: g.guest_commit,
              you_are: me,
            },
          }
        : null,
  };
}

export async function createGame(userId: string) {
  const db = await admin();
  for (let i = 0; i < 6; i++) {
    const { data, error } = await db
      .from(T)
      .insert({ code: joinCode(), host_id: userId })
      .select("*")
      .single();
    if (!error) return view(data as Game, userId);
    if (!/duplicate|unique/i.test(error.message)) throw error;
  }
  throw new TradeupError("Could not make a game code. Please try again.");
}

export async function joinGame(userId: string, code: string) {
  if (!/^\d{6}$/.test(code)) throw new TradeupError("Game codes are 6 digits.");
  const db = await admin();
  const { data } = await db.from(T).select("*").eq("code", code).eq("status", "open").maybeSingle();
  const g = data as Game | null;
  if (!g || expired(g)) throw new TradeupError("No open game with that code.");
  if (g.host_id === userId || g.guest_id === userId) return view(g, userId);
  if (g.guest_id) throw new TradeupError("That game already has two players.");
  const { data: joined, error } = await db
    .from(T)
    .update({ guest_id: userId, updated_at: new Date().toISOString() })
    .eq("id", g.id)
    .is("guest_id", null)
    .select("*")
    .single();
  if (error || !joined) throw new TradeupError("Someone else joined first.");
  return view(joined as Game, userId);
}

export async function gameState(userId: string, id: string) {
  return view(await load(await admin(), userId, id), userId);
}

/** A card's value today: TCGplayer market price, else the typical raw price. */
async function valueOf(tcgdexId: string): Promise<number | null> {
  const p = await getCardPricing(tcgdexId).catch(() => null);
  const v = priceScale(p?.pricing)?.market ?? usdRange(p?.pricing)?.typical;
  return typeof v === "number" && v > 0 ? Math.round(v * 100) / 100 : null;
}

export async function setCards(userId: string, id: string, cardIds: string[]) {
  const db = await admin();
  const g = await load(db, userId, id);
  if (g.status !== "open" || expired(g)) throw new TradeupError("This game is closed.");
  const ids = [...new Set(cardIds)].slice(0, MAX_CARDS_PER_SIDE + 1);
  if (ids.length > MAX_CARDS_PER_SIDE)
    throw new TradeupError(`Up to ${MAX_CARDS_PER_SIDE} cards each.`);
  const me = sideOf(g, userId);
  let cards: Card[] = [];
  if (ids.length) {
    const { data, error } = await db
      .from("cards")
      .select("id, tcgdex_id, name, number, set_name, image_url")
      .eq("user_id", userId)
      .in("id", ids);
    if (error) throw error;
    if ((data ?? []).length !== ids.length)
      throw new TradeupError("Only cards from your own collection can go in.");
    const priced = await Promise.all(
      (data ?? []).map(async (c) => ({ c, usd: await valueOf(c.tcgdex_id) })),
    );
    const unpriced = priced.filter((x) => x.usd === null).map((x) => x.c.name);
    if (unpriced.length)
      throw new TradeupError(
        `No market price yet for ${unpriced.join(", ")}. Take it out to play.`,
      );
    cards = priced.map(({ c, usd }) => ({
      id: c.id,
      tcgdex_id: c.tcgdex_id,
      name: c.name,
      number: c.number,
      set_name: c.set_name,
      image: c.image_url,
      usd: usd!,
    }));
  }
  const total = Math.round(cards.reduce((n, c) => n + c.usd, 0) * 100) / 100;
  if (total > MAX_TOTAL_USD)
    throw new TradeupError(
      `Games are limited to US$${MAX_TOTAL_USD.toLocaleString("en-US")} a side.`,
    );
  // Changing cards unlocks both players, so nobody is held to odds they did not see.
  const { data, error } = await db
    .from(T)
    .update({
      [`${me}_cards`]: cards,
      [`${me}_total`]: total,
      host_commit: null,
      guest_commit: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("status", "open")
    .select("*")
    .single();
  if (error) throw error;
  return view(data as Game, userId);
}

export async function lockIn(userId: string, id: string, commit: string, adult: boolean) {
  if (!adult) throw new TradeupError("You need to be 18 or over to play.");
  if (!isCommit(commit)) throw new TradeupError("Invalid lock.");
  const db = await admin();
  const g = await load(db, userId, id);
  if (g.status !== "open" || expired(g)) throw new TradeupError("This game is closed.");
  if (!g.guest_id) throw new TradeupError("Wait for the other player to join.");
  if (!g.host_cards.length || !g.guest_cards.length)
    throw new TradeupError("Both players need cards in first.");
  const me = sideOf(g, userId);
  const { data, error } = await db
    .from(T)
    .update({ [`${me}_commit`]: commit, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "open")
    .select("*")
    .single();
  if (error) throw error;
  return view(data as Game, userId);
}

/** Both locked: each phone reveals its secret; with both in, the draw is made once. */
export async function reveal(userId: string, id: string, secret: string) {
  if (!isSecret(secret)) throw new TradeupError("Invalid secret.");
  const db = await admin();
  let g = await load(db, userId, id);
  if (g.status === "rolled") return view(g, userId);
  if (g.status !== "open" || !g.host_commit || !g.guest_commit)
    throw new TradeupError("Both players need to lock in first.");
  const me = sideOf(g, userId);
  if (sha256(secret) !== g[`${me}_commit`])
    throw new TradeupError("That does not match your lock.");
  const { data, error } = await db
    .from(T)
    .update({ [`${me}_secret`]: secret })
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;
  g = data as Game;
  if (g.host_secret && g.guest_secret) {
    const host = Number(g.host_total),
      guest = Number(g.guest_total);
    const { draw, winner } = decide(host, guest, g.host_secret, g.guest_secret);
    const { data: done } = await db
      .from(T)
      .update({
        status: "rolled",
        winner,
        draw,
        host_chance: winChances(host, guest).host,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .is("winner", null)
      .select("*")
      .maybeSingle();
    if (done) {
      g = done as Game;
      await saveToHistory(db, g);
    } else g = await load(db, userId, id);
  }
  return view(g, userId);
}

export async function cancelGame(userId: string, id: string) {
  const db = await admin();
  const g = await load(db, userId, id);
  if (g.status !== "open") return view(g, userId);
  const { data } = await db
    .from(T)
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "open")
    .select("*")
    .single();
  return view((data as Game) ?? g, userId);
}

/** Both players get the result in their Mori history (and Library). */
async function saveToHistory(db: SupabaseClient, g: Game) {
  const usd = (n: number) => "US$" + n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  const rows = (["host", "guest"] as const).map((side) => {
    const won = g.winner === side,
      mine = Number(g[`${side}_total`]),
      theirs = Number(g[`${other(side)}_total`]);
    return {
      user_id: side === "host" ? g.host_id : g.guest_id,
      role: "mori",
      kind: "text",
      content: won
        ? `You won the trade-up game: you keep your ${g[`${side}_cards`].length} cards (${usd(mine)}) and take the other player's ${g[`${other(side)}_cards`].length} (${usd(theirs)}). Swap the cards in person now.`
        : `The other player won the trade-up game this time: hand over your ${g[`${side}_cards`].length} cards (${usd(mine)}) and they keep theirs (${usd(theirs)}).`,
      payload: {
        tradeup: {
          id: g.id,
          won,
          draw: g.draw,
          chance: side === "host" ? g.host_chance : 1 - Number(g.host_chance),
        },
      },
    };
  });
  await db.from("mori_messages").insert(rows);
}
