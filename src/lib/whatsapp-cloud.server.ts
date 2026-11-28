import { createHmac, timingSafeEqual } from "node:crypto";
import { asObject } from "./mori-context.server";
import { upstreamFetchJson as upstreamJson } from "./upstream-fetch";
import type { WhatsAppMessage } from "./whatsapp-render";

export type Address = { phone: string | null; bsuid: string | null };
export type Inbound = Address & { id: string; at: string } & (
    | { kind: "text"; text: string }
    | { kind: "image"; media: string; caption: string }
    | { kind: "action"; action: string }
  );
const graph = "https://graph.facebook.com/v27.0/";
export function signedWebhook(bytes: Uint8Array, signature: string | null) {
  const secret = process.env["WHATSAPP_APP_SECRET"];
  if (!secret || !/^sha256=[a-f0-9]{64}$/i.test(signature ?? "")) return false;
  return timingSafeEqual(
    createHmac("sha256", secret).update(bytes).digest(),
    Buffer.from(signature!.slice(7), "hex"),
  );
}
export async function boundedBytes(body: ReadableStream<Uint8Array> | null, max: number) {
  if (!body) throw new Error("Missing body");
  const reader = body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) {
        await reader.cancel();
        throw new Error("Body too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}
const list = (v: unknown) => (Array.isArray(v) ? v : []);
export function inboundMessages(body: unknown, numberId: string): Inbound[] {
  const root = asObject(body),
    out: Inbound[] = [];
  if (!numberId || root["object"] !== "whatsapp_business_account") return out;
  for (const e of list(root["entry"]))
    for (const ch of list(e?.changes)) {
      const v = ch?.value;
      if (
        ch?.field !== "messages" ||
        v?.metadata?.phone_number_id !== numberId ||
        v.messaging_product !== "whatsapp"
      )
        continue;
      for (const m of list(v.messages)) {
        const phone =
          typeof m?.from === "string" && /^\+?[1-9]\d{5,14}$/.test(m.from)
            ? m.from.replace(/^\+/, "")
            : null;
        const bsuid =
          typeof m?.from_user_id === "string" &&
          /^[A-Z]{2}\.[a-zA-Z0-9]{1,128}$/.test(m.from_user_id)
            ? m.from_user_id
            : null;
        if (
          (!phone && !bsuid) ||
          typeof m.id !== "string" ||
          !m.id.length ||
          m.id.length > 512 ||
          !/^\d{10}$/.test(m.timestamp)
        )
          continue;
        const meta = {
          phone,
          bsuid,
          id: m.id,
          at: new Date(Number(m.timestamp) * 1000).toISOString(),
        };
        if (m.type === "text" && typeof m.text?.body === "string" && m.text.body.trim())
          out.push({ ...meta, kind: "text", text: m.text.body.trim() });
        if (m.type === "image" && typeof m.image?.id === "string" && /^\d{1,40}$/.test(m.image.id))
          out.push({
            ...meta,
            kind: "image",
            media: m.image.id,
            caption: typeof m.image.caption === "string" ? m.image.caption.trim() : "",
          });
        if (
          m.type === "interactive" &&
          ["button_reply", "list_reply"].includes(m.interactive?.type)
        ) {
          const a = m.interactive[m.interactive.type]?.id;
          if (typeof a === "string" && a.length <= 256)
            out.push({ ...meta, kind: "action", action: a });
        }
      }
    }
  return out;
}
function graphAuth() {
  const token = process.env["WHATSAPP_ACCESS_TOKEN"],
    number = process.env["WHATSAPP_PHONE_NUMBER_ID"];
  if (!token || !number || !/^\d+$/.test(number)) throw new Error("WhatsApp is not configured");
  return { number, headers: { Authorization: "Bearer " + token } };
}
export async function sendWhatsApp(addr: Address, message: WhatsAppMessage) {
  const { number, headers } = graphAuth();
  if (!addr.phone && !addr.bsuid) throw new Error("Missing recipient");
  const r = await upstreamJson<{ messages?: { id: string }[] }>(graph + number + "/messages", {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    redirect: "error",
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      ...(addr.phone ? { to: "+" + addr.phone } : { recipient: addr.bsuid }),
      ...message,
    }),
    maxAttempts: 1,
    timeoutMs: 8000,
  });
  if (!r.ok || !r.data?.messages?.[0]?.id) throw new Error("WhatsApp send was not confirmed");
}
export async function downloadPhoto(id: string) {
  if (!/^\d{1,40}$/.test(id)) throw new Error("Invalid media id");
  const { number, headers } = graphAuth();
  const meta = await upstreamJson<{
    id: string;
    url: string;
    mime_type: string;
    file_size?: number | string;
  }>(graph + id + "?phone_number_id=" + number, { headers, redirect: "error", maxAttempts: 2 });
  const info = meta.data,
    max = 5_000_000;
  if (
    !meta.ok ||
    info?.id !== id ||
    !["image/jpeg", "image/png", "image/webp"].includes(info.mime_type) ||
    Number(info.file_size) > max
  )
    throw new Error("Unsupported photo");
  // No documented exhaustive CDN allowlist. Fail closed on unknown hosts or redirects.
  const u = new URL(info.url);
  if (
    u.protocol !== "https:" ||
    u.hostname !== "lookaside.fbsbx.com" ||
    u.port ||
    u.username ||
    u.password
  )
    throw new Error("Untrusted media URL");
  const r = await fetch(u, { headers, redirect: "error", signal: AbortSignal.timeout(10000) });
  if (!r.ok || Number(r.headers.get("content-length")) > max) throw new Error("Photo unavailable");
  const bytes = await boundedBytes(r.body, max);
  if (!bytes.length) throw new Error("Empty photo");
  return "data:" + info.mime_type + ";base64," + bytes.toString("base64");
}
