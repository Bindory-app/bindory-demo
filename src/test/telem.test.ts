import { afterEach, describe, expect, it, vi } from "vitest";
import { webFetch, webSearch } from "@/lib/telem.server";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const bodyOf = (m: ReturnType<typeof vi.fn>) =>
  JSON.parse(String((m.mock.calls[0] as unknown as [string, RequestInit])[1].body));

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env["TELEM_API_KEY"];
});

describe("Telem web search", () => {
  it("searches two providers with few results, merging and de-duplicating links", async () => {
    process.env["TELEM_API_KEY"] = "tlm_test";
    const fetchMock = vi.fn(async () =>
      json({
        status: "succeeded",
        preprocessor_runs: [
          {
            status: "succeeded",
            output_payload: {
              results: [
                { rank: 1, url: "https://a.example/events", title: "Events" },
                { rank: 2, url: "javascript:alert(1)", title: "Bad" },
              ],
            },
          },
          {
            status: "succeeded",
            output_payload: {
              results: [
                { rank: 1, url: "https://a.example/events/", title: "Events again", summary: "x" },
                { rank: 2, url: "https://b.example/show", title: null },
              ],
            },
          },
          { status: "failed", output_payload: null },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const r = await webSearch("card show Sydney");
    const body = bodyOf(fetchMock);
    expect(body.search.providers.include).toEqual(["brave", "tavily"]);
    expect(body.search.num_results).toBe(5);
    expect(r.map((x) => x.url)).toEqual(["https://a.example/events", "https://b.example/show"]);
    expect(r[1]?.title).toBe("https://b.example/show");
  });

  it("fails clearly without a key or on an error status", async () => {
    await expect(webSearch("x")).rejects.toThrow("not configured");
    process.env["TELEM_API_KEY"] = "tlm_test";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ detail: "Rate limit" }, 429)),
    );
    await expect(webSearch("x")).rejects.toThrow("busy");
  });
});

describe("Telem web fetch", () => {
  it("reads at most 3 http(s) pages and reports the ones that failed", async () => {
    process.env["TELEM_API_KEY"] = "tlm_test";
    const fetchMock = vi.fn(async () =>
      json({
        preprocessor_runs: [
          {
            status: "succeeded",
            output_payload: {
              fetched_results: [
                {
                  url: "https://a.example/",
                  status: "succeeded",
                  title: "A",
                  content: "x".repeat(9000),
                  content_truncated: true,
                },
              ],
            },
          },
          { status: "failed", output_payload: { fetched_results: [] } },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const pages = await webFetch([
      "https://a.example/",
      "https://b.example/",
      "file:///etc/passwd",
      "https://c.example/",
      "https://d.example/",
    ]);
    expect(bodyOf(fetchMock).urls).toEqual([
      "https://a.example/",
      "https://b.example/",
      "https://c.example/",
    ]);
    expect(pages[0]).toMatchObject({ url: "https://a.example/", ok: true, truncated: true });
    expect(pages[0]?.content?.length).toBe(6000);
    expect(pages.filter((p) => !p.ok).map((p) => p.url)).toEqual([
      "https://b.example/",
      "https://c.example/",
    ]);
  });
});
