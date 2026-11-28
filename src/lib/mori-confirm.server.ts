/** Confirm or edit one of Mori's proposals. Shared by the server function and /api/mori-confirm. */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/types";
import type { MoriRow, ProposalPayload } from "./mori-tools";
import { cardImage, getCard, getSet } from "./tcgdex";
import { orderAmount } from "./mori-validation";
import { orderUsd } from "./mori-order-money.server";

export class OrderEditError extends Error {}

export async function confirmWith(
  db: SupabaseClient<Database>,
  messageId: string,
  action: "confirm" | "edit",
  changes?: unknown,
) {
  const { data: msg, error } = await db
    .from("mori_messages")
    .select("payload")
    .eq("id", messageId)
    .eq("kind", "confirm")
    .single();
  if (error) throw error;
  const p = msg.payload as unknown as ProposalPayload;
  let details: Json | undefined;
  if (action === "confirm" && p.tool === "add_card_to_collection") {
    const card = await getCard(p.card.tcgdex_id);
    if (!card) throw new Error("Card not found");
    const set = await getSet(card.set.id);
    details = {
      tcgdex_id: card.id,
      name: card.name,
      set_name: card.set.name,
      set_id: card.set.id,
      number: card.localId,
      image_url: cardImage(card.image) ?? null,
      illustrator: card.illustrator ?? null,
      rarity: card.rarity ?? null,
      year: set?.releaseDate ? Number(set.releaseDate.slice(0, 4)) : null,
    };
  }
  if (action === "confirm" && p.tool === "set_order") details = orderChanges(p, changes);
  const result = await db.rpc("confirm_mori_proposal", {
    p_message_id: messageId,
    p_action: action,
    ...(details ? { p_card_details: details } : {}),
  });
  if (result.error) throw result.error;
  return result.data as unknown as { done: "confirmed" | "edited"; reply: MoriRow | null };
}

/** Old proposals had only a USD amount. New edits are in the proposal's original currency,
 *  at its stored rate; neither currency nor rate comes from the browser. */
export function orderChanges(
  p: Extract<ProposalPayload, { tool: "set_order" }>,
  changes: unknown,
): Json | undefined {
  const c = changes && typeof changes === "object" ? (changes as Record<string, unknown>) : {};
  const side = c["side"] === "buy" || c["side"] === "sell" ? c["side"] : p.side;
  if (side === "sell" && !(p.photos?.front && p.photos.back && p.photos.front !== p.photos.back))
    throw new OrderEditError(
      "A sell order needs front and back photos. Keep this as a buy order or start a sell order with photos.",
    );
  const out: Record<string, Json> = {};
  if (side !== p.side) out["side"] = side;
  if ("price" in c || "price_usd" in c) {
    const usdEdit = !("price" in c);
    if (usdEdit && p.price && p.price.currency !== "USD")
      throw new OrderEditError("Edit the price in " + p.price.currency + ".");
    const parsed = orderAmount.safeParse(usdEdit ? c["price_usd"] : c["price"]);
    const rate = p.price && p.price.currency !== "USD" ? p.fx_rate : 1;
    const usd = parsed.success && rate && rate > 0 ? orderUsd(parsed.data, rate) : null;
    if (!parsed.success || usd === null)
      throw new OrderEditError("Enter a valid price within the order limit.");
    out["price_usd"] = usd;
    if (p.price) out["price_amount"] = parsed.data;
  }
  if (c["expires_days"] === 7 || c["expires_days"] === 30 || c["expires_days"] === 90)
    out["expires_days"] = c["expires_days"];
  return Object.keys(out).length ? out : undefined;
}
