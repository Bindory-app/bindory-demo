/**
 * Trade-up game: two collectors at a card show each put in cards from their collection, Mori
 * values both piles, and one random draw decides who takes everything. The odds are fair: each
 * side's chance of winning equals its share of the combined value, so over many games nobody
 * gains or loses value on average (Bindory takes no cut).
 *
 * The draw is commit-reveal: each phone picks a secret, sends only its SHA-256 hash when locking
 * in, and reveals the secret once both are locked. The result comes from both secrets together,
 * so neither player (nor Bindory) can choose it, and anyone can recompute it afterwards.
 */
import { createHash } from "node:crypto";

export const MAX_CARDS_PER_SIDE = 10;
export const MAX_TOTAL_USD = 5000;

export const cents = (usd: number) => Math.round(usd * 100);

/** Each side's chance of winning: its share of the combined value. */
export function winChances(hostUsd: number, guestUsd: number): { host: number; guest: number } {
  const total = hostUsd + guestUsd;
  if (!(hostUsd > 0) || !(guestUsd > 0) || !(total > 0)) return { host: 0, guest: 0 };
  const host = hostUsd / total;
  return { host, guest: 1 - host };
}

export const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** A secret is 32 random bytes as hex; its commitment is the hash. */
export const isSecret = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
export const isCommit = isSecret;

/** The draw: a number in [0, 1) from both secrets. The host wins when it falls below the host's chance. */
export function drawFrom(hostSecret: string, guestSecret: string): number {
  const h = sha256(`bindory-tradeup:${hostSecret}:${guestSecret}`);
  // 52 bits keep the number exact in a double.
  return parseInt(h.slice(0, 13), 16) / 2 ** 52;
}

export function decide(hostUsd: number, guestUsd: number, hostSecret: string, guestSecret: string) {
  const draw = drawFrom(hostSecret, guestSecret);
  const { host } = winChances(hostUsd, guestUsd);
  return { draw, winner: draw < host ? ("host" as const) : ("guest" as const) };
}

/** A 6-digit join code. */
export function joinCode(random: () => number = Math.random): string {
  return String(Math.floor(random() * 900000) + 100000);
}
