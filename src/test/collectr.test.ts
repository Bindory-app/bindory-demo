import { describe, expect, it } from "vitest";

describe("Collectr sync", () => {
  it("spots the sync message, its binder, and checks the link", async () => {
    const { collectrSyncLink, collectrSyncBinder, isCollectrLink } = await import("@/lib/collectr");
    const link =
      "https://app.getcollectr.com/showcase/profile/6b10e282-6452-49ef-ae2e-e36ff91945e4";
    expect(collectrSyncLink(`Sync my Collectr collection: ${link} into the binder "Fire"`)).toBe(
      link,
    );
    expect(
      collectrSyncBinder(`Sync my Collectr collection: ${link} into the binder "Fire"`),
    ).toEqual({ name: "Fire", new: false });
    expect(
      collectrSyncBinder(
        `Sync my Collectr collection: ${link} into a new binder called "From Collectr"`,
      ),
    ).toEqual({ name: "From Collectr", new: true });
    expect(collectrSyncLink("Price check: Pikachu 25/25")).toBeNull();
    expect(isCollectrLink(link)).toBe(true);
    expect(isCollectrLink("https://evil.example.com/getcollectr.com")).toBe(false);
    expect(isCollectrLink("http://app.getcollectr.com/x")).toBe(false);
  });
  it("reads the proposed cards from the answer and hides the json block", async () => {
    const { syncItems, syncAnswerText } = await import("@/lib/collectr");
    const answer =
      '## Status\nProposed.\n\n```json\n{"bindory_items":[{"name":"Umbreon VMAX","number":"215/203","set":"Evolving Skies","quantity":1},{"bad":1}]}\n```';
    expect(syncItems(answer)).toEqual([
      { name: "Umbreon VMAX", number: "215/203", set: "Evolving Skies", quantity: 1 },
    ]);
    expect(syncAnswerText(answer)).toBe("## Status\nProposed.");
    expect(syncItems("no block")).toEqual([]);
  });
});
