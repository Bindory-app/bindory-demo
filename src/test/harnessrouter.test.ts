import { describe, expect, it } from "vitest";

import { answerText } from "@/lib/harnessrouter.server";

describe("Collectr task answers", () => {
  it("takes the answer from the last message", () => {
    expect(
      answerText({
        id: "r",
        status: "completed",
        output: [
          { type: "message", content: [{ type: "output_text", text: "Working on it." }] },
          { type: "function_call", name: "mori__list_my_cards" },
          { type: "message", content: [{ type: "output_text", text: "Here you go." }] },
        ],
      }),
    ).toBe("Here you go.");
  });
});
