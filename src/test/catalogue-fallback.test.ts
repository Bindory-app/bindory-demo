import { afterEach, describe, expect, it, vi } from "vitest";
import { findCards } from "@/lib/tcgdex";
import { writeSchemas } from "@/lib/mori-validation";

afterEach(() => vi.unstubAllGlobals());

describe("Catalogue search fallback", () => {
  it('finds "Pikachu ex 25/25" as the plain Pikachu 25/25', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith("/cards") && u.searchParams.get("name") === "Pikachu ex")
        return new Response(JSON.stringify([{ id: "A1-259", localId: "259", name: "Pikachu ex" }]));
      if (u.pathname.endsWith("/cards") && u.searchParams.get("name") === "Pikachu")
        return new Response(
          JSON.stringify([{ id: "2021swsh-25", localId: "25", name: "Pikachu" }]),
        );
      return new Response(
        JSON.stringify({
          id: "2021swsh-25",
          localId: "25",
          name: "Pikachu",
          set: { name: "McDonald's Collection 2021", cardCount: { official: 25 } },
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const r = await findCards("Pikachu ex", "25/25");
    expect(r[0]).toMatchObject({ id: "2021swsh-25", name: "Pikachu", number: "25" });
  });
});

describe("Trade memories", () => {
  it("accepts a trade card by name when it is not in the catalogue", () => {
    expect(
      writeSchemas.save_memory.safeParse({
        title: "Charizard for Pikachu",
        story: "I traded my Charizard with @mina",
        traded_card_id: "me02-125",
        card_name: "Pikachu ex 25/25",
      }).success,
    ).toBe(true);
  });
});

import { getCard } from "@/lib/tcgdex";
import { cardFromLabel } from "@/lib/mori-proposals.server";

describe("Catalogue resilience", () => {
  it("retries a TCGdex outage instead of failing the lookup", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        return calls === 1
          ? new Response("busy", { status: 503 })
          : new Response(JSON.stringify({ id: "me02-125", name: "Mega Charizard X ex" }));
      }),
    );
    expect(await getCard("me02-125")).toMatchObject({ id: "me02-125" });
    expect(calls).toBe(2);
  });

  it('turns a label like "Charizard 125/094" into the catalogue card', async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = new URL(url);
        if (u.pathname.endsWith("/cards"))
          return new Response(
            JSON.stringify([{ id: "me02-125", localId: "125", name: "Mega Charizard X ex" }]),
          );
        return new Response(
          JSON.stringify({
            id: "me02-125",
            localId: "125",
            name: "Mega Charizard X ex",
            image: "https://assets.tcgdex.net/en/me/me02/125",
            set: { name: "Phantasmal Flames", cardCount: { official: 94 } },
          }),
        );
      }),
    );
    expect(await cardFromLabel("Charizard 125/094")).toMatchObject({
      tcgdex_id: "me02-125",
      name: "Mega Charizard X ex",
      set_name: "Phantasmal Flames",
    });
    expect(await cardFromLabel("just words")).toBeUndefined();
  });
});
