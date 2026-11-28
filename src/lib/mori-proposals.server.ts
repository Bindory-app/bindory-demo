import { stringArg, type Args, type DB } from "./mori-context.server";
import { isWriteTool, type Proposal, type ProposalCard } from "./mori-tools";
import { cardImage, getCard, getCardPricing, findCards, usdRange } from "./tcgdex";
import { validateWriteArgs, ownPhotoPath, writeSchemas } from "./mori-validation";
import { quoteOrder } from "./mori-order-money.server";

async function briefCard(id: string, reason?: string): Promise<ProposalCard | null> {
  const c = await getCard(id);
  if (!c) return null;
  return {
    tcgdex_id: c.id,
    name: c.name,
    image: cardImage(c.image, "low"),
    set_name: c.set.name,
    reason,
  };
}

// "on 2 Nov 2026" in a memory template message, as YYYY-MM-DD.
const MONTH_NUM: Record<string, string> = {
  jan: "01",
  feb: "02",
  mar: "03",
  apr: "04",
  may: "05",
  jun: "06",
  jul: "07",
  aug: "08",
  sep: "09",
  oct: "10",
  nov: "11",
  dec: "12",
};
function templateDate(message: string): string | undefined {
  const m = /\bon (\d{1,2}) ([A-Za-z]{3})[a-z]* (\d{4})\b/.exec(message);
  const mon = m?.[2] ? MONTH_NUM[m[2].toLowerCase()] : undefined;
  return m && mon ? `${m[3]}-${mon}-${(m[1] ?? "").padStart(2, "0")}` : undefined;
}
const TEMPLATE_END = " Help me save this memory.";

/** One catalogue card for a label like "Charizard 125/094" or "Pikachu ex 25/25", or undefined
 *  when there is no single clear match. */
export async function cardFromLabel(label: string | undefined): Promise<ProposalCard | undefined> {
  const m = /^(.*?)\s+#?([A-Z]{0,3}\d{1,4}(?:\/[A-Z]{0,3}\d{1,4})?)$/i.exec(label?.trim() ?? "");
  if (!m?.[1] || !m[2]) return undefined;
  const found = await findCards(m[1], m[2]).catch(() => []);
  if (found.length !== 1 || !found[0]) return undefined;
  return (await briefCard(found[0].id).catch(() => null)) ?? undefined;
}

export async function buildProposal(
  db: DB,
  userId: string,
  name: string,
  a: Args,
  message = "",
  seen: Set<string> | null = new Set(),
): Promise<Proposal | { error: string }> {
  if (!isWriteTool(name)) return { error: "Unknown tool" };
  const parsed = validateWriteArgs(name, a);
  if (!parsed.success)
    return { error: "Missing or invalid details. Ask the collector before proposing." };
  if (name === "add_card_to_collection" || name === "add_to_wishlist") {
    const card = await briefCard(stringArg(a["card_id"]) ?? "");
    if (!card) return { error: "Card not found in the catalogue" };
    if (name === "add_to_wishlist") return { tool: name, card, note: stringArg(a["note"]) };
    // A binder by name: one of the collector's own (RLS), else a new binder made on confirm.
    const binderName = stringArg(a["binder_name"])
      ?.trim()
      .replace(/^["“”']+|["“”']+$/g, "");
    if (!binderName) return { tool: name, card };
    const { data: mine, error } = await db.from("binders").select("id, name");
    if (error) throw error;
    const found = (mine ?? []).find(
      (b) => b.name.trim().toLowerCase() === binderName.toLowerCase(),
    );
    return {
      tool: name,
      card,
      binder: found
        ? { id: found.id, name: found.name, new: false }
        : { name: binderName, new: true },
    };
  }
  if (name === "create_binder") {
    const list = a["cards"] as Args[];
    const { data: owned, error } = await db.from("cards").select("tcgdex_id");
    if (error) throw error;
    if (list.some((c) => !owned.some((card) => card.tcgdex_id === c["card_id"])))
      return {
        error:
          "Use only cards the collector owns. Suggest unowned cards separately, never add them to their collection.",
      };
    const cards = await Promise.all(
      list.map((c) => briefCard(stringArg(c["card_id"]) ?? "", stringArg(c["reason"]))),
    );
    if (!cards.every((c): c is ProposalCard => Boolean(c)))
      return { error: "Some cards were not found. Ask the collector to clarify." };
    return {
      tool: "create_binder",
      name: stringArg(a["name"]) ?? "New binder",
      description: stringArg(a["description"]),
      cards,
    };
  }
  if (name === "set_order") {
    const order = writeSchemas.set_order.parse(a);
    const money = await quoteOrder({ amount: order.price, currency: order.currency });
    if ("error" in money) return { error: money.error! };
    const r = await getCardPricing(order.card_id);
    if (!r) return { error: "Card not found in the catalogue" };
    const range = usdRange(r.pricing);
    return {
      tool: "set_order",
      side: order.side,
      card: {
        tcgdex_id: r.card.id,
        name: `${r.card.name} ${r.card.localId}`,
        image: cardImage(r.card.image, "low"),
        set_name: r.card.set.name,
      },
      ...money,
      market_usd: range?.typical,
      note: order.note,
      condition: order.side === "sell" ? order.condition : undefined,
    };
  }
  if (!ownPhotoPath(stringArg(a["photo_path"]), userId))
    return { error: "Photo must belong to the collector." };
  // Cards are optional: keep only ones Mori actually looked up, so a guessed id never shows the wrong card.
  const cid = stringArg(a["card_id"]);
  const tid = stringArg(a["traded_card_id"]);
  const card = cid && (!seen || seen.has(cid)) ? ((await briefCard(cid)) ?? undefined) : undefined;
  const traded_card =
    tid && (!seen || seen.has(tid)) ? ((await briefCard(tid)) ?? undefined) : undefined;
  // From the fill-in template, the story is exactly what the collector wrote (facts, feelings, ratings).
  const fromTemplate = message.endsWith(TEMPLATE_END);
  const story = fromTemplate
    ? message.slice(0, -TEMPLATE_END.length).trim()
    : (stringArg(a["story"]) ?? "");
  const date = stringArg(a["date"]) ?? (fromTemplate ? templateDate(message) : undefined);
  // A trade card the agent passed only by name ("Charizard 125/094") is looked up here, so the
  // memory shows the real card whenever the catalogue has exactly one match.
  const resolvedCard = card ?? (await cardFromLabel(stringArg(a["card_name"])));
  const resolvedTraded = traded_card ?? (await cardFromLabel(stringArg(a["traded_card_name"])));
  return {
    tool: name,
    title: stringArg(a["title"]) ?? "A memory",
    story,
    place: stringArg(a["place"]),
    with_whom: stringArg(a["with_whom"]),
    date: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined,
    card: resolvedCard,
    traded_card: resolvedTraded,
    card_name: resolvedCard ? undefined : stringArg(a["card_name"])?.slice(0, 160),
    traded_card_name: resolvedTraded ? undefined : stringArg(a["traded_card_name"])?.slice(0, 160),
    photo_path: stringArg(a["photo_path"]),
  };
}

/** Checks and tidies the model's pre-grade report before it is shown. */
export function gradeReport(a: Args) {
  const num = (v: unknown, lo: number, hi: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : undefined;
  };
  const outcomes = (Array.isArray(a["outcomes"]) ? (a["outcomes"] as Args[]) : [])
    .map((o) => ({
      grade: num(o["grade"], 1, 10),
      probability: num(o["probability"], 0, 100) ?? 0,
      reason: stringArg(o["reason"])?.slice(0, 120) ?? "",
    }))
    .filter(
      (o): o is { grade: number; probability: number; reason: string } => o.grade !== undefined,
    )
    .slice(0, 4);
  const take = stringArg(a["take"])?.slice(0, 400);
  if (outcomes.length < 2 || !take)
    return { error: "Give at least two likely grades and Mori's take." };
  const total = outcomes.reduce((n, o) => n + o.probability, 0) || 1;
  outcomes.forEach((o) => (o.probability = Math.round((o.probability / total) * 100)));
  outcomes.sort((x, y) => y.grade - x.grade);
  const companies = ["psa", "cgc", "bgs", "tag"] as const;
  const block = (v: unknown, lo: number, hi: number) =>
    Object.fromEntries(
      companies.map((c) => [
        c,
        num((v && typeof v === "object" ? (v as Args) : {})[c], lo, hi) ?? null,
      ]),
    );
  const subs = a["subgrades"] && typeof a["subgrades"] === "object" ? (a["subgrades"] as Args) : {};
  return {
    card: stringArg(a["card"])?.slice(0, 120),
    outcomes,
    take,
    confidence: num(a["confidence"], 0, 100) ?? 70,
    // Some models answer subgrades on a 1-10 scale (BGS style); show everything as 0-100.
    subgrades: Object.fromEntries(
      ["centering", "corners", "edges", "surface"].map((k) => [
        k,
        Object.fromEntries(
          Object.entries(block(subs[k], 0, 100)).map(([c, v]) => [
            c,
            v !== null && v <= 10 ? v * 10 : v,
          ]),
        ),
      ]),
    ),
    overall: block(a["overall"], 1, 10),
    notes: stringArg(a["notes"])?.slice(0, 160),
  };
}
