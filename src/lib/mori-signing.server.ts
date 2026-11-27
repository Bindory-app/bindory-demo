import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

export function moriSecret(): string {
  const s = process.env["MORI_MCP_SECRET"]?.trim();
  if (!s || s.length < 32) throw new Error("MORI_MCP_SECRET is not configured");
  return s;
}
export const deriveMoriKey = (info: string) => Buffer.from(hkdfSync("sha256", moriSecret(), "", info, 32));
export function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Ties a background task (response and session) to one collector, so a stored task can only be
 *  read by the collector who started it, even if the stored row were edited. */
export function signTask(userId: string, responseId: string, sessionId: string): string {
  return createHmac("sha256", deriveMoriKey("mori:task"))
    .update(`${userId}\n${responseId}\n${sessionId}`)
    .digest("base64url");
}
export function isOwnTask(userId: string, responseId: string, sessionId: string, sig: unknown) {
  return typeof sig === "string" && sameText(sig, signTask(userId, responseId, sessionId));
}
