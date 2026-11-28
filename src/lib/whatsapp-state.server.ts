import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { marketFor } from "./market";
import { whatsappToken } from "./mori-signing.server";
import type { Address, Inbound } from "./whatsapp-cloud.server";

export type Step = {
  kind?: "rows" | "edit" | "preview" | "alerts" | "wallet" | "paying" | "await_text";
  key?: string;
  rows?: string[];
  row?: string;
  media?: string[];
  mediaAt?: number;
  changes?: { side: "buy" | "sell"; price: number; expires_days: number };
};
export type Linked = Address & {
  user_id: string;
  channel_id: string;
  country: string;
  chat_since: string;
  last_inbound: string;
  last_reminder: string | null;
  step: Step;
};
// Only this bookkeeping crosses RLS. All conversation, settings and order operations use collectorClient.
const store = supabaseAdmin as unknown as SupabaseClient;
export async function startLink(userId: string, country: unknown) {
  const number = process.env["WHATSAPP_BUSINESS_NUMBER"];
  if (!number || !/^\+?[1-9]\d{5,14}$/.test(number))
    throw new Error("Business number not configured");
  const nonce = randomUUID(),
    expires = Date.now() + 10 * 60_000;
  const token = whatsappToken("link", nonce, expires);
  const { error } = await store.from("whatsapp_links").upsert({
    user_id: userId,
    country: marketFor(country).country,
    link_nonce: nonce,
    link_expires: new Date(expires).toISOString(),
  });
  if (error) throw error;
  return (
    "https://wa.me/" + number.replace(/^\+/, "") + "?text=" + encodeURIComponent("Link " + token)
  );
}
export async function firstDelivery(id: string) {
  const { error } = await store
    .from("whatsapp_receipts")
    .insert({ id: createHash("sha256").update(id).digest("hex") });
  if (error?.code === "23505") return false;
  if (error) throw error;
  return true;
}
export async function bindLink(nonce: string, m: Inbound) {
  const { data, error } = await store.rpc("bind_whatsapp", {
    p_nonce: nonce,
    p_phone: m.phone,
    p_bsuid: m.bsuid,
    p_at: m.at,
  });
  if (error) throw error;
  return data === true;
}
export async function touchLink(m: Inbound): Promise<Linked | null> {
  const { data, error } = await store
    .rpc("touch_whatsapp", { p_phone: m.phone, p_bsuid: m.bsuid, p_at: m.at })
    .maybeSingle();
  if (error) throw error;
  return data as Linked | null;
}
export async function pairPhoto(
  l: Linked,
  media: string,
  caption: string,
): Promise<{ media: string[]; caption: string } | null> {
  const { data, error } = await store.rpc("pair_whatsapp_photo", {
    p_user: l.user_id,
    p_channel: l.channel_id,
    p_media: media,
    p_caption: caption,
  });
  if (error) throw error;
  return data;
}
// Compare and swap the previous step. Old list/checkout controls and simultaneous submissions cannot win twice.
export async function setStep(l: Linked, next: Step) {
  const { data, error } = await store
    .from("whatsapp_links")
    .update({ step: next })
    .eq("channel_id", l.channel_id)
    .eq("step", JSON.stringify(l.step))
    .select("user_id")
    .maybeSingle();
  if (error) throw error;
  if (!data) return false;
  l.step = next;
  return true;
}
export async function paymentLink(nonce: string): Promise<Linked | null> {
  const { data, error } = await store
    .from("whatsapp_links")
    .select("*")
    .eq("step->>kind", "wallet")
    .eq("step->>key", nonce)
    .maybeSingle();
  if (error) throw error;
  return data as Linked | null;
}
export async function claimReminder(l: Linked, allowTemplate = false): Promise<Linked | null> {
  const { data, error } = await store
    .rpc("claim_whatsapp_reminder", {
      p_user: l.user_id,
      p_channel: l.channel_id,
      p_template: allowTemplate,
    })
    .maybeSingle();
  if (error) throw error;
  return data as Linked | null;
}
export async function unlinkWhatsApp(l: Linked) {
  const { error } = await store
    .from("whatsapp_links")
    .delete()
    .eq("channel_id", l.channel_id)
    .eq("user_id", l.user_id);
  if (error) throw error;
}
