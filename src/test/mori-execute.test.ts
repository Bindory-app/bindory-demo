import { describe, expect, it } from "vitest";

describe("Event tickets", () => {
  it("shows the organiser's ticket page with its options, never a bad link", async () => {
    const { executeMoriTool } = await import("@/lib/mori-execute.server");
    const ctx = { seenIds: new Set<string>(), message: "", lastCard: "" };
    const ok = await executeMoriTool(
      null as never,
      "u1",
      "show_tickets",
      {
        event: "East Bay Card Show",
        date: "Sat 28 - Sun 29 Nov",
        venue: "San Mateo County Event Center",
        ticket_url: "https://www.eventbrite.com/e/east-bay-card-show-tickets-1",
        options: [{ name: "Saturday Early Bird", price: "US$15" }, { price: "no name" }],
      },
      ctx,
    );
    expect(ok.rows[0]?.kind).toBe("tickets");
    expect((ok.rows[0]?.payload as { options: unknown[] }).options).toHaveLength(1);
    for (const ticket_url of [
      "javascript:alert(1)",
      "http://example.com/t",
      "https://demo.bindory.app/x",
    ]) {
      const bad = await executeMoriTool(
        null as never,
        "u1",
        "show_tickets",
        { event: "X", ticket_url, options: [] },
        ctx,
      );
      expect(bad.rows).toHaveLength(0);
    }
  });
});
