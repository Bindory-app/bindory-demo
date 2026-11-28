import type { Json } from "@/integrations/supabase/types";
import { asObject, stringArg, type Args, type DB, type MoriRowDraft } from "./mori-context.server";
import { buildProposal, gradeReport, gradeReportRow } from "./mori-proposals.server";
import { runReadTool } from "./mori-read-tools.server";
import { isWriteTool, proposalTitle, type ProposalPayload } from "./mori-tools";
import type { TurnTimer } from "./mori-timing.server";
import type { OrderIntent, PreGradeIntent } from "./mori-validation";
import { NEED_USD } from "./mori-order-money.server";

export type MoriToolContext = {
  /** The collector's message this answer is for (memory templates keep their exact words). */
  message: string;
  /** Card ids looked up in this chat. */
  seenIds: Set<string>;
  /** The card most recently priced in this answer, so a pre-grade report can name it. */
  lastCard: string;
  orderReference?: { id: string; point: { amount: number; currency: string } | null };
  /** Only persist this submission's front and back, after the price and card validate. */
  hasOrderPhotos: boolean;
  orderPhotos: () => Promise<{ front: string; back: string } | null>;
  /** Optional per-turn timing recorder shared across tool calls and deterministic flows. */
  timing?: TurnTimer;
  photoIntent?: OrderIntent | PreGradeIntent;
};

function requestPhotos(purpose: "sell" | "grade", pending?: MoriToolContext["photoIntent"]) {
  const intent =
    purpose === "grade"
      ? pending?.kind === "pre_grade" && pending
      : pending?.kind === "order" && pending.side === "sell" && pending;
  return {
    rows: [
      {
        role: "mori" as const,
        kind: "photos",
        content: "Front and back photos of your card",
        payload: {
          for: purpose,
          ...(intent ? { intent } : {}),
        },
      },
    ],
    result: {
      shown_to_user: true,
      card: "photo_request",
      ...(purpose === "sell" ? { order_proposed: false } : {}),
      note: "Take a photo and Upload buttons are on screen, not a confirmation. Wait for the collector to send front and back photos.",
    },
    stop: true,
  };
}

/** Runs one of Mori's tools for this collector. `rows` are the chat cards it shows (confirmation,
 *  pre-grade report, profiles, storyboard, binders, orders); `stop` means the answer should end
 *  after it. */
export async function executeMoriTool(
  db: DB,
  userId: string,
  name: string,
  args: Args,
  ctx: MoriToolContext,
): Promise<{ result: unknown; rows: MoriRowDraft[]; stop: boolean }> {
  const rows: MoriRowDraft[] = [];
  let stop = false;
  let result: unknown;
  if (name === "pre_grade_report") {
    const report = gradeReport(args);
    if (!report)
      result = {
        error: "Give 2 to 4 distinct whole grades from 1 to 10 with probabilities and Mori's take.",
      };
    else {
      if (ctx.lastCard) report.card = ctx.lastCard;
      rows.push(gradeReportRow(report));
      result = { shown_to_user: true, note: "The report is on screen." };
      stop = true;
    }
  } else if (name === "show_collectors") {
    // Only real public profiles; Mori supplies the reason.
    const picks = (Array.isArray(args["picks"]) ? (args["picks"] as Args[]) : []).slice(0, 4);
    const { data } = await db.rpc("list_public_collectors", { p_query: "" });
    const all = (Array.isArray(data) ? data : []) as {
      display_name?: string;
      username?: string;
      avatar_url?: string;
    }[];
    const people = picks
      .map((x) => {
        const c = all.find(
          (o) => o.username === (stringArg(x["username"]) ?? "").replace(/^@/, ""),
        );
        return c
          ? {
              name: c.display_name ?? c.username,
              username: c.username,
              avatar: c.avatar_url ?? null,
              why: (stringArg(x["why"]) ?? "").slice(0, 140),
            }
          : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    if (!people.length)
      result = { error: "Use usernames exactly as find_collectors returned them." };
    else {
      rows.push({
        role: "mori",
        kind: "people",
        content: `Collectors you may like: ${people.map((x) => x.name).join(", ")}`,
        payload: { people } as unknown as Json,
      });
      result = {
        shown_to_user: true,
        note: "The profile cards are on screen. Reply in one short line.",
      };
    }
  } else if (name === "show_tickets") {
    // The organiser's own ticket page; the collector pays there (Bindory never takes payment).
    let url = "";
    try {
      const u = new URL(stringArg(args["ticket_url"]) ?? "");
      if (u.protocol === "https:" && !/(^|\.)bindory\.app$/i.test(u.hostname)) url = u.toString();
    } catch {
      url = "";
    }
    const clip = (v: unknown, n: number) =>
      (stringArg(v) ?? "").replace(/\s+/g, " ").trim().slice(0, n);
    const options = (Array.isArray(args["options"]) ? (args["options"] as Args[]) : [])
      .map((o) => ({
        name: clip(o["name"], 80),
        price: clip(o["price"], 30),
        note: clip(o["note"], 120),
      }))
      .filter((o) => o.name)
      .slice(0, 8);
    const event = clip(args["event"], 100);
    if (!url || !event)
      result = {
        error:
          "Give the event name and its official ticket page (an https link from the page you read).",
      };
    else {
      rows.push({
        role: "mori",
        kind: "tickets",
        content: `Tickets for ${event}`,
        payload: {
          event,
          date: clip(args["date"], 80),
          venue: clip(args["venue"], 120),
          url,
          options,
        } as unknown as Json,
      });
      result = {
        shown_to_user: true,
        note: "The ticket card is on screen: the collector picks a ticket and quantity and opens checkout to pay on the organiser's page. Reply in one or two short lines (which ticket suits them, if they said a day), and do not list the prices again.",
      };
    }
  } else if (name === "request_card_photos") {
    return requestPhotos(args["purpose"] === "grade" ? "grade" : "sell", ctx.photoIntent);
  } else if (name === "plan_video") {
    // Storyboard from the collector's own cards; they post or save it with a button.
    const scenes = (Array.isArray(args["scenes"]) ? (args["scenes"] as Args[]) : []).slice(0, 6);
    const ids = scenes.map((x) => stringArg(x["card_id"]) ?? "");
    const { data: owned } = await db
      .from("cards")
      .select("tcgdex_id, name, image_url")
      .in("tcgdex_id", ids.length ? ids : ["-"]);
    const frames = scenes
      .map((x) => {
        const c = (owned ?? []).find((o) => o.tcgdex_id === stringArg(x["card_id"]));
        return c && c.image_url
          ? {
              name: c.name,
              image: c.image_url,
              caption: (stringArg(x["caption"]) ?? "").slice(0, 120),
            }
          : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    if (frames.length < 2)
      result = { error: "Use 3-5 cards the collector owns (ids from list_my_cards)." };
    else {
      const title = (stringArg(args["title"]) ?? "My collection").slice(0, 80);
      rows.push({
        role: "mori",
        kind: "video",
        content: `Video plan: ${title}`,
        payload: { title, frames } as unknown as Json,
      });
      result = {
        shown_to_user: true,
        note: "The storyboard is on screen with Post to profile and Save draft buttons. Reply in one short line.",
      };
    }
  } else if (name === "suggest_binder_for_card") {
    // The collector picks the binder with an Add here button; Mori only suggests one.
    result = await runReadTool(db, name, args).catch((e: unknown) => ({
      error: e instanceof Error ? e.message : "Tool failed",
    }));
    const r = result as {
      card?: { id: string; name: string } | null;
      binders?: { id: string; name: string; binder_cards?: { count: number }[] }[];
    };
    const owned = r.card
      ? await db.from("cards").select("id").eq("tcgdex_id", r.card.id).limit(1).maybeSingle()
      : null;
    if (!r.card) result = { error: "Card not found" };
    else if (!owned?.data)
      result = {
        note: "This card is not in the collection yet. Offer to add it to the collection first.",
      };
    else if (!r.binders?.length)
      result = {
        note: "The collector has no binders yet. Offer to build one with this card.",
      };
    else {
      rows.push({
        role: "mori",
        kind: "binders",
        content: `Pick a binder for ${r.card.name}`,
        payload: {
          card: { name: r.card.name, owned_card_id: owned.data.id },
          binders: r.binders.map((b) => ({
            id: b.id,
            name: b.name,
            count: b.binder_cards?.[0]?.count ?? 0,
          })),
        } as unknown as Json,
      });
      result = {
        shown_to_user: true,
        binders: r.binders.map((b) => ({ name: b.name })),
        note: "The binders are on screen, each with an Add here button. In one or two short sentences, say which binder fits best and why. Never claim you added the card.",
      };
    }
  } else if (name === "list_my_orders") {
    // Open orders are shown as cards with a Cancel button; Mori only summarises them.
    result = await runReadTool(db, name, args).catch((e: unknown) => ({
      error: e instanceof Error ? e.message : "Tool failed",
    }));
    if (Array.isArray(result) && result.length) {
      rows.push({
        role: "mori",
        kind: "orders",
        content: `${result.length} order${result.length > 1 ? "s" : ""}`,
        payload: { orders: result } as unknown as Json,
      });
      result = {
        shown_to_user: true,
        count: result.length,
        note: "The orders are on screen with their status and a Cancel button. Do not list them again.",
      };
    }
  } else if (
    (name === "add_to_wishlist" || name === "add_card_to_collection") &&
    !ctx.seenIds.has(stringArg(args["card_id"]) ?? "")
  ) {
    result = {
      error:
        "Look this card up first with search_catalogue (name and number) and use the id it returns.",
    };
  } else if (isWriteTool(name)) {
    const sell = name === "set_order" && args["side"] === "sell";
    if (sell && !ctx.hasOrderPhotos) return requestPhotos("sell", ctx.photoIntent);
    const p = await buildProposal(db, userId, name, args, ctx.message, ctx.seenIds);
    if ("error" in p) {
      result = p;
      // Only the collector can provide a replacement US$ amount.
      if (name === "set_order" && p.error === NEED_USD) stop = true;
    } else {
      const photos = sell ? await ctx.orderPhotos() : null;
      if (sell && !photos) return requestPhotos("sell", ctx.photoIntent);
      if (p.tool === "set_order" && ctx.orderReference?.id === p.card.tcgdex_id)
        p.market_reference = ctx.orderReference.point;
      const payload: ProposalPayload = { ...p, ...(photos ? { photos } : {}), status: "pending" };
      rows.push({
        role: "mori",
        kind: "confirm",
        content: proposalTitle(p),
        payload: payload as unknown as Json,
      });
      result = { shown_to_user: true, note: "Waiting for the user to tap Confirm or Edit." };
      stop = true;
    }
  } else {
    result = await runReadTool(db, name, args, ctx.timing).catch((e: unknown) => ({
      error: e instanceof Error ? e.message : "Tool failed",
    }));
  }
  // The card this answer is about, so the report and follow-ups can name it.
  if (name === "get_card_prices" && result && typeof result === "object" && "card" in result) {
    const r = asObject(result),
      id = asObject(r["card"])["id"],
      amount = asObject(r["price_points"])["market"],
      currency = r["currency"];
    if (typeof id === "string")
      ctx.orderReference = {
        id,
        point:
          typeof amount === "number" && amount > 0 && typeof currency === "string"
            ? { amount, currency }
            : null,
      };
    const c = (result as { card: { name?: string; number?: string; set?: string } }).card;
    if (c.name)
      ctx.lastCard = `${c.name}${c.number ? ` ${c.number}` : ""}${c.set ? ` (${c.set})` : ""}`;
  }
  for (const m of JSON.stringify(result ?? null).matchAll(/"(?:id|tcgdex_id)":"([^"]+)"/g))
    if (m[1]) ctx.seenIds.add(m[1]);
  return { result, rows, stop };
}
