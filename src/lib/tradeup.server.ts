/**
 * Trade-up games, server side (see tradeup.ts for the fair-odds draw). The starter (host) puts in
 * cards; the other collector (guest) offers Option A (worth less) and Option B (worth more), stored
 * as guest_cards = {a: [...], b: [...]}. The trade always happens; the draw decides A or B
 * (winner "host" = Option B, "guest" = Option A; host_chance = B's chance). Every change goes
 * through here with the service role: cards must be the player's own, values come from today's
 * market prices (never from the phone), and the draw uses both players' revealed secrets.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getCardPricing, priceScale, usdRange } from "./tcgdex";
import {
  MAX_CARDS_PER_SIDE,
  MAX_TOTAL_USD,
  decideOption,
  optionBChance,
  isCommit,
  isSecret,
  joinCode,
  sha256,
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
  guest_cards: Card[] | { a?: Card[]; b?: Card[] };
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

const sum = (cards: Card[]) => Math.round(cards.reduce((n, c) => n + c.usd, 0) * 100) / 100;
function offers(g: Game) {
  const o = Array.isArray(g.guest_cards) ? {} : g.guest_cards;
  const a = o.a ?? [];
  const b = o.b ?? [];
  return { a: { cards: a, total: sum(a) }, b: { cards: b, total: sum(b) } };
}

/** The game as one player sees it: the starter's cards, the two offers, B's chance and the result. */
export function view(g: Game, userId: string) {
  const me = sideOf(g, userId);
  const start = { cards: g.host_cards, total: Number(g.host_total) };
  const o = offers(g);
  return {
    id: g.id,
    code: g.code,
    status: expired(g) ? "expired" : g.status,
    role: me, // "host" = starter, "guest" = makes the two offers
    joined: Boolean(g.guest_id),
    start,
    offers: o,
    chance_b: optionBChance(start.total, o.a.total, o.b.total),
    locked: { me: Boolean(g[`${me}_commit`]), them: Boolean(g[`${other(me)}_commit`]) },
    revealed: { me: Boolean(g[`${me}_secret`]) },
    result:
      g.status === "rolled" && g.winner
        ? {
            option: g.winner === "host" ? "b" : "a",
            draw: Number(g.draw),
            chance_b: Number(g.host_chance),
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

export async function setCards(userId: string, id: string, cardIds: string[], option?: string) {
  const db = await admin();
  const g = await load(db, userId, id);
  if (g.status !== "open" || expired(g)) throw new TradeupError("This game is closed.");
  const me = sideOf(g, userId);
  if (me === "guest" && option !== "a" && option !== "b")
    throw new TradeupError("Choose Option A or Option B.");
  const ids = [...new Set(cardIds)].slice(0, MAX_CARDS_PER_SIDE + 1);
  if (ids.length > MAX_CARDS_PER_SIDE)
    throw new TradeupError(`Up to ${MAX_CARDS_PER_SIDE} cards each.`);
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
  const total = sum(cards);
  if (total > MAX_TOTAL_USD)
    throw new TradeupError(`Each set is limited to US$${MAX_TOTAL_USD.toLocaleString("en-US")}.`);
  // Changing any cards unlocks both players, so nobody is held to odds they did not see.
  const patch: Record<string, unknown> = {
    host_commit: null,
    guest_commit: null,
    updated_at: new Date().toISOString(),
  };
  if (me === "host") Object.assign(patch, { host_cards: cards, host_total: total });
  else {
    const o = offers(g);
    const next = { a: option === "a" ? cards : o.a.cards, b: option === "b" ? cards : o.b.cards };
    Object.assign(patch, { guest_cards: next, guest_total: sum(next.a) });
  }
  const { data, error } = await db
    .from(T)
    .update(patch)
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
  const o = offers(g);
  if (!g.host_cards.length || !o.a.cards.length || !o.b.cards.length)
    throw new TradeupError(
      "The starter needs cards in, and the other player needs both Option A and Option B.",
    );
  if (optionBChance(Number(g.host_total), o.a.total, o.b.total) === null)
    throw new TradeupError(
      "Option A must be worth less than the starter's cards, and Option B more.",
    );
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
    const o = offers(g);
    const { draw, option, chanceB } = decideOption(
      Number(g.host_total),
      o.a.total,
      o.b.total,
      g.host_secret,
      g.guest_secret,
    );
    const winner = option === "b" ? "host" : "guest";
    const { data: done } = await db
      .from(T)
      .update({
        status: "rolled",
        winner,
        draw,
        host_chance: chanceB,
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
  const o = offers(g);
  const pick = g.winner === "host" ? "b" : "a";
  const got = o[pick];
  const names = (cards: Card[]) => cards.map((c) => c.name).join(", ");
  const label = pick === "b" ? "Option B" : "Option A";
  const payload = { tradeup: { id: g.id, option: pick, draw: g.draw, chance_b: g.host_chance } };
  await db.from("mori_messages").insert([
    {
      user_id: g.host_id,
      role: "mori",
      kind: "text",
      content: `Trade-up done: the draw picked ${label}. You give your ${g.host_cards.length} cards (${usd(Number(g.host_total))}) and get ${names(got.cards)} (${usd(got.total)}). Swap the cards in person now.`,
      payload,
    },
    {
      user_id: g.guest_id,
      role: "mori",
      kind: "text",
      content: `Trade-up done: the draw picked ${label}. You give ${names(got.cards)} (${usd(got.total)}) and get their ${g.host_cards.length} cards (${usd(Number(g.host_total))}). Swap the cards in person now.`,
      payload,
    },
  ]);
}
