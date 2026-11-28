import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseRetryAfterMs, upstreamFetch, upstreamFetchJson } from "@/lib/upstream-fetch";
import { localSoldPrices, resetLocalSoldCacheForTest } from "@/lib/ebay-sold.server";
import { MARKETS } from "@/lib/market";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-27T12:00:00Z"));
  resetLocalSoldCacheForTest(null);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env["APIFY_TOKEN"];
});

function hangUntilAborted(): typeof fetch {
  return vi.fn(
    (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal;
        if (sig?.aborted) {
          reject(sig.reason ?? new DOMException("Aborted", "AbortError"));
          return;
        }
        sig?.addEventListener(
          "abort",
          () => reject(sig.reason ?? new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      }),
  );
}

describe("upstreamFetch", () => {
  it("aborts a hung request on timeout and retries up to maxAttempts", async () => {
    const fetchMock = hangUntilAborted();
    vi.stubGlobal("fetch", fetchMock);

    const p = upstreamFetch("https://example.test/slow", {
      timeoutMs: 1_000,
      maxAttempts: 2,
      baseDelayMs: 200,
      random: () => 0,
    });
    const handled = p.catch((e: unknown) => e);

    // Attempt 1 times out at 1000ms, sleeps 100ms (0.5 * 200), attempt 2 times out at +1000ms.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);

    const err = await handled;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("TimeoutError");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries on 503 with backoff and succeeds on the next attempt", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      if (calls === 1) return new Response("unavailable", { status: 503 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const p = upstreamFetch("https://example.test/data", {
      timeoutMs: 5_000,
      maxAttempts: 3,
      baseDelayMs: 400,
      maxDelayMs: 2_000,
      random: () => 1, // delay = 400 * (0.5 + 0.5 * 1) = 400ms
    });

    await vi.advanceTimersByTimeAsync(399);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    const res = await p;
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
  });

  it("honours numeric and HTTP-date Retry-After headers, and skips retry if longer than maxDelayMs", async () => {
    expect(parseRetryAfterMs("2")).toBe(2_000);
    expect(parseRetryAfterMs("Fri, 27 Nov 2026 12:00:03 GMT", Date.now())).toBe(3_000);
    expect(parseRetryAfterMs("not-a-date")).toBeNull();

    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        return new Response("slow down", { status: 429, headers: { "Retry-After": "2" } });
      }
      return new Response("ok", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const p = upstreamFetch("https://example.test/rate", {
      timeoutMs: 5_000,
      maxAttempts: 2,
      baseDelayMs: 200,
      maxDelayMs: 3_000,
    });

    await vi.advanceTimersByTimeAsync(1_999);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    const res = await p;
    expect(res.status).toBe(200);
    expect(calls).toBe(2);

    // Retry-After exceeding maxDelayMs should return the 429 immediately without retrying.
    const longMock = vi.fn(
      async () => new Response("slow down", { status: 429, headers: { "Retry-After": "60" } }),
    );
    vi.stubGlobal("fetch", longMock);
    const r2 = await upstreamFetch("https://example.test/rate-long", {
      timeoutMs: 5_000,
      maxAttempts: 3,
      maxDelayMs: 3_000,
    });
    expect(r2.status).toBe(429);
    expect(longMock).toHaveBeenCalledTimes(1);
  });

  it("stops immediately without retrying when the caller AbortSignal aborts", async () => {
    const fetchMock = hangUntilAborted();
    vi.stubGlobal("fetch", fetchMock);

    const caller = new AbortController();
    const p = upstreamFetch("https://example.test/cancel", {
      timeoutMs: 10_000,
      maxAttempts: 3,
      signal: caller.signal,
    });
    const handled = p.catch((e: unknown) => e);

    caller.abort(new DOMException("User cancelled", "AbortError"));
    const err = await handled;
    expect((err as Error).name).toBe("AbortError");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("Apify sold-listings retry guard", () => {
  it("never retries the Apify POST after a timeout", async () => {
    process.env["APIFY_TOKEN"] = "apify_test";
    const fetchMock = hangUntilAborted();
    vi.stubGlobal("fetch", fetchMock);

    const p = localSoldPrices(
      { id: "sv08.5-161", name: "Umbreon ex", number: "161" },
      MARKETS["AU"]!,
    );

    await vi.advanceTimersByTimeAsync(30_000);
    const res = await p;
    expect(res).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a fast 503 rejection from Apify once, but not a 500 or slow 503", async () => {
    process.env["APIFY_TOKEN"] = "apify_test";
    let fastCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        fastCalls++;
        if (fastCalls === 1) return new Response("busy", { status: 503 });
        return new Response(
          JSON.stringify([
            {
              title: "Umbreon ex 161/131",
              soldPrice: "1500",
              soldCurrency: "AUD",
              endedAt: "2026-11-26",
            },
          ]),
          { status: 200 },
        );
      }),
    );

    const p1 = localSoldPrices(
      { id: "sv08.5-161", name: "Umbreon ex", number: "161" },
      MARKETS["AU"]!,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    const r1 = await p1;
    expect(r1?.raw.n).toBe(1);
    expect(fastCalls).toBe(2);

    // 500 is NOT retried (actor run may have started).
    resetLocalSoldCacheForTest(null);
    const err500Mock = vi.fn(async () => new Response("internal error", { status: 500 }));
    vi.stubGlobal("fetch", err500Mock);
    const r2 = await localSoldPrices(
      { id: "sv08.5-161", name: "Umbreon ex", number: "161" },
      MARKETS["AU"]!,
    );
    expect(r2).toBeNull();
    expect(err500Mock).toHaveBeenCalledTimes(1);
  });
});

describe("upstreamFetchJson body deadline", () => {
  it("times out when response headers arrive promptly but the JSON body stalls", async () => {
    const fetchMock = vi.fn(async () => {
      const stalledBody = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"partial":'));
          // Never closes or sends the rest of the JSON payload.
        },
      });
      return new Response(stalledBody, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const p = upstreamFetchJson("https://example.com/slow-body", {
      timeoutMs: 1_500,
      maxAttempts: 1,
    });
    const handled = p.catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(1_600);
    const err = await handled;
    expect((err as Error).name).toBe("TimeoutError");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a 503 response and parses JSON under the deadline", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      if (calls === 1) return new Response("busy", { status: 503 });
      return new Response(JSON.stringify({ ok: true, items: [1, 2] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const p = upstreamFetchJson<{ ok: boolean; items: number[] }>("https://example.com/json", {
      timeoutMs: 2_000,
      maxAttempts: 2,
      baseDelayMs: 50,
    });
    await vi.advanceTimersByTimeAsync(200);
    const res = await p;
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ ok: true, items: [1, 2] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
