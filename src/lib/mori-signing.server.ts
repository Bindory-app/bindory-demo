import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

function moriSecret(): string {
  const s = process.env["MORI_MCP_SECRET"]?.trim();
  if (!s || s.length < 32) throw new Error("MORI_MCP_SECRET is not configured");
  return s;
}
function signature(info: string, value: string) {
  const key = Buffer.from(hkdfSync("sha256", moriSecret(), "", info, 32));
  return createHmac("sha256", key).update(value).digest("base64url");
}
export function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Ties a background task (response and session) to one collector, so a stored task can only be
 *  read by the collector who started it, even if the stored row were edited. */
export function signTask(userId: string, responseId: string, sessionId: string): string {
  return signature("mori:task", `${userId}\n${responseId}\n${sessionId}`);
}
export function isOwnTask(userId: string, responseId: string, sessionId: string, sig: unknown) {
  return typeof sig === "string" && sameText(sig, signTask(userId, responseId, sessionId));
}

// Public tokens contain only a random nonce and expiry, never a collector id or phone.
type ChannelPurpose = "link" | "payment";
export function whatsappToken(purpose: ChannelPurpose, nonce: string, expires: number) {
  const data = nonce + "." + Math.floor(expires / 1000);
  return data + "." + signature("mori:whatsapp:" + purpose, data);
}
export function whatsappNonce(purpose: ChannelPurpose, token: string): string | null {
  const m = /^([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\.(\d{10})\.([\w-]{43})$/.exec(token);
  if (!m || Number(m[2]) * 1000 <= Date.now()) return null;
  return sameText(whatsappToken(purpose, m[1]!, Number(m[2]) * 1000), token) ? m[1]! : null;
}
