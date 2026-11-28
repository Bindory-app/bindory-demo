import { describe, expect, it } from "vitest";

import { replyParts } from "@/lib/mori-turn.server";

describe("Reply bubbles", () => {
  it("splits a multi-part reply on --- lines, one bubble each", () => {
    expect(replyParts("Shows in Sydney:\n• A\n---\nYour grading options:\n• PSA\n---\n")).toEqual([
      "Shows in Sydney:\n• A",
      "Your grading options:\n• PSA",
    ]);
  });
  it("keeps a single answer whole", () => {
    expect(replyParts("Here are the shows.\n• A - B")).toEqual(["Here are the shows.\n• A - B"]);
  });
});

describe("Answers to tap", () => {
  const fakeDb = () => {
    const saved: { kind: string; content: string; payload?: unknown }[] = [];
    const db = {
      from: () => ({
        insert: (rows: typeof saved) => {
          saved.push(...rows);
          return { select: async () => ({ data: rows, error: null }) };
        },
      }),
    };
    return { db: db as never, saved };
  };
  it("turns a Choices line into answers and drops the general suggestions", async () => {
    const { finishMoriTurn } = await import("@/lib/mori-turn.server");
    const { db, saved } = fakeDb();
    await finishMoriTurn(
      db,
      [],
      "Which day were you thinking?\nChoices: Saturday 28 Nov | Sunday 29 Nov | Both days: US$30 | Something else…",
      Date.now(),
      () => {},
    );
    expect(saved.find((r) => r.kind === "text")?.content).toBe("Which day were you thinking?");
    expect(saved.find((r) => r.kind === "choices")?.payload).toEqual({
      choices: ["Saturday 28 Nov", "Sunday 29 Nov", "Both days: US$30", "Something else…"],
    });
    expect(saved.some((r) => r.kind === "suggest")).toBe(false);
  });
  it("keeps Suggestions when no question was asked", async () => {
    const { finishMoriTurn } = await import("@/lib/mori-turn.server");
    const { db, saved } = fakeDb();
    await finishMoriTurn(
      db,
      [],
      "Done.\nSuggestions: Price check this card | Add it to a binder",
      Date.now(),
      () => {},
    );
    expect(saved.find((r) => r.kind === "suggest")?.payload).toEqual({
      suggestions: ["Price check this card", "Add it to a binder"],
    });
    expect(saved.some((r) => r.kind === "choices")).toBe(false);
  });
});
