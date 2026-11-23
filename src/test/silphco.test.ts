import { afterEach, describe, expect, it, vi } from "vitest";
import { ebaySoldPrices } from "@/lib/silphco.server";

const ok = (results: unknown[]) =>
  new Response(JSON.stringify({ contract: "price.v2", data: { results } }), { status: 200 });

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env["SILPHCO_API_KEY"];
});

describe("SilphCo eBay sold prices", () => {
  it("asks for raw, PSA 9 and PSA 10 on eBay only, and reads each median", async () => {
    process.env["SILPHCO_API_KEY"] = "test-key";
    const fetchMock = vi.fn(async () =>
      ok([
        { value_usd: 531.34, status: "ok", n_sales: 3, newest_sale_at: "2026-11-15T00:00:00Z" },
        { value_usd: 481.61, status: "ok", n_sales: 3 },
        { value_usd: null, status: "thin", n_sales: 1, last_sale: { value_usd: 1075 } },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);
    const r = await ebaySoldPrices("me02-125", 1_000);
    const body = JSON.parse(
      String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body),
    );
    expect(body.marketplace).toBe("ebay");
    expect(body.items).toEqual([
      { tcg_card_id: "me02-125" },
      { tcg_card_id: "me02-125", grade_key: "PSA:9" },
      { tcg_card_id: "me02-125", grade_key: "PSA:10" },
    ]);
    expect(r?.raw.value_usd).toBe(531.34);
    expect(r?.psa9.value_usd).toBe(481.61);
    expect(r?.psa10).toMatchObject({ value_usd: null, status: "thin", last_sale_usd: 1075 });
    expect(r?.source).toContain("eBay sold prices via SilphCo Analytics");
  });

  it("caches a card for six hours", async () => {
    process.env["SILPHCO_API_KEY"] = "test-key";
    const fetchMock = vi.fn(async () => ok([{ value_usd: 10, status: "ok", n_sales: 3 }, {}, {}]));
    vi.stubGlobal("fetch", fetchMock);
    await ebaySoldPrices("sv1-1", 0);
    await ebaySoldPrices("sv1-1", 5 * 60 * 60 * 1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await ebaySoldPrices("sv1-1", 7 * 60 * 60 * 1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("is null without a key, on errors, and when nothing sold", async () => {
    const fetchMock = vi.fn(async () =>
      ok([{ status: "none" }, { status: "none" }, { status: "none" }]),
    );
    vi.stubGlobal("fetch", fetchMock);
    expect(await ebaySoldPrices("sv2-2")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    process.env["SILPHCO_API_KEY"] = "test-key";
    expect(await ebaySoldPrices("sv2-2")).toBeNull();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network");
      }),
    );
    expect(await ebaySoldPrices("sv3-3")).toBeNull();
  });
});
