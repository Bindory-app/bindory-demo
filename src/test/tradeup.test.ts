import { describe, expect, it } from "vitest";

describe("Trade-up game", () => {
  it("draws from both secrets, repeatably", async () => {
    const { drawFrom } = await import("@/lib/tradeup");
    const s1 = "a".repeat(64),
      s2 = "b".repeat(64);
    expect(drawFrom(s1, s2)).toBe(drawFrom(s1, s2));
    expect(drawFrom(s1, s2)).not.toBe(drawFrom(s2, s1));
  });
  it("only accepts 64-hex secrets and makes 6-digit codes", async () => {
    const { isSecret, joinCode } = await import("@/lib/tradeup");
    expect(isSecret("f".repeat(64))).toBe(true);
    expect(isSecret("x".repeat(64))).toBe(false);
    expect(joinCode()).toMatch(/^\d{6}$/);
  });
});

describe("Trade-up options A and B", () => {
  it("sets B's chance so the trade is fair on average", async () => {
    const { optionBChance } = await import("@/lib/tradeup");
    expect(optionBChance(1000, 800, 1200)).toBeCloseTo(0.5, 6);
    expect(optionBChance(1000, 800, 1300)).toBeCloseTo(0.4, 6);
    expect(optionBChance(1000, 1000, 1200)).toBeNull();
    expect(optionBChance(1000, 800, 900)).toBeNull();
  });
  it("gives the starter B about as often as its chance", async () => {
    const { decideOption } = await import("@/lib/tradeup");
    const { randomBytes } = await import("node:crypto");
    let b = 0;
    const n = 20000;
    for (let i = 0; i < n; i++)
      if (
        decideOption(
          1000,
          800,
          1300,
          randomBytes(32).toString("hex"),
          randomBytes(32).toString("hex"),
        ).option === "b"
      )
        b++;
    expect(b / n).toBeGreaterThan(0.385);
    expect(b / n).toBeLessThan(0.415);
  });
});
