/**
 * Trade-up game: two collectors at a card show. The starter puts in cards; the other collector
 * offers two sets, Option A (worth less) and Option B (worth more). The trade always happens: the
 * starter's cards go to the other collector, and one random draw decides whether the starter gets
 * A or B. The odds are fair: B's chance is set so the starter's expected value equals what they
 * put in, (S - A) / (B - A), so over many games nobody gains or loses value (Bindory takes no cut).
 *
 * The draw is commit-reveal: each phone picks a secret, sends only its SHA-256 hash when locking
 * in, and reveals the secret once both are locked. The result comes from both secrets together,
 * so neither player (nor Bindory) can choose it, and anyone can recompute it afterwards.
 */
import { createHash } from "node:crypto";

export const MAX_CARDS_PER_SIDE = 10;
export const MAX_TOTAL_USD = 5000;

/** Chance the starter gets Option B, so the trade is fair on average: p·B + (1-p)·A = S. Null
 *  unless A < S < B. */
export function optionBChance(startUsd: number, aUsd: number, bUsd: number): number | null {
  if (!(aUsd > 0) || !(startUsd > aUsd) || !(bUsd > startUsd)) return null;
  return (startUsd - aUsd) / (bUsd - aUsd);
}

export function decideOption(
  startUsd: number,
  aUsd: number,
  bUsd: number,
  hostSecret: string,
  guestSecret: string,
) {
  const p = optionBChance(startUsd, aUsd, bUsd);
  if (p === null)
    throw new Error("Option A must be worth less, and Option B more, than the starter's cards.");
  const draw = drawFrom(hostSecret, guestSecret);
  return { draw, chanceB: p, option: draw < p ? ("b" as const) : ("a" as const) };
}

export const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** A secret is 32 random bytes as hex; its commitment is the hash. */
export const isSecret = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
export const isCommit = isSecret;

/** A repeatable draw in [0, 1) from both secrets; decideOption compares it with B's chance. */
export function drawFrom(hostSecret: string, guestSecret: string): number {
  const h = sha256(`bindory-tradeup:${hostSecret}:${guestSecret}`);
  // 52 bits keep the number exact in a double.
  return parseInt(h.slice(0, 13), 16) / 2 ** 52;
}

/** A 6-digit join code. */
export function joinCode(random: () => number = Math.random): string {
  return String(Math.floor(random() * 900000) + 100000);
}
