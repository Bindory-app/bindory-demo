import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayError, streamResponse } from "@/lib/ai-gateway.server";

function sseResponse(chunks: string[], headers: Record<string, string> = {}) {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(enc.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", ...headers },
  });
}

function eventLine(payload: Record<string, unknown>) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AI Gateway streaming timeouts and retries", () => {
  it("recovers from 429 (next model), 5xx and network errors before first byte without duplicating output", async () => {
    const cases: Array<() => Promise<Response>> = [
      async () => new Response("rate limit", { status: 429 }),
      async () => new Response("bad gateway", { status: 502 }),
      async () => {
        throw new TypeError("fetch failed");
      },
    ];

    for (const failFirst of cases) {
      let attempt = 0;
      const fetchMock = vi.fn(async () => {
        attempt++;
        if (attempt === 1) return failFirst();
        return sseResponse([
          eventLine({ type: "response.output_text.delta", delta: "Hello" }),
          eventLine({
            type: "response.completed",
            response: {
              output: [{ type: "message", content: [{ type: "output_text", text: "Hello" }] }],
            },
          }),
        ]);
      });
      vi.stubGlobal("fetch", fetchMock);

      const streamPromise = streamResponse(
        { input: [{ role: "user", content: "hi" }] },
        { oidcToken: "test-token", headersTimeoutMs: 2_000, idleTimeoutMs: 2_000, maxAttempts: 2 },
      );
      await vi.advanceTimersByTimeAsync(1_000);
      const stream = await streamPromise;

      const events: Array<{ type: string }> = [];
      for await (const ev of stream) events.push(ev);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(events.filter((e) => e.type === "response.output_text.delta")).toHaveLength(1);
      expect(events.at(-1)?.type).toBe("response.completed");
    }
  });

  it("never retries once headers arrived and stream output has begun", async () => {
    const enc = new TextEncoder();
    const fetchMock = vi.fn(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            enc.encode(eventLine({ type: "response.output_text.delta", delta: "Partial " })),
          );
          controller.enqueue(
            enc.encode(eventLine({ type: "error", error: { message: "mid-stream fail" } })),
          );
          controller.close();
        },
      });
      return new Response(body, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const stream = await streamResponse(
      { input: [{ role: "user", content: "hi" }] },
      { oidcToken: "test-token", maxAttempts: 2 },
    );

    const deltas: string[] = [];
    let caught: unknown = null;
    try {
      for await (const ev of stream) {
        if (ev.type === "response.output_text.delta" && ev.delta) deltas.push(ev.delta);
      }
    } catch (e) {
      caught = e;
    }

    expect(deltas).toEqual(["Partial "]);
    expect(caught).toBeInstanceOf(GatewayError);
    expect((caught as GatewayError).code).toBe("upstream");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails with GatewayError timeout when waiting for response headers exceeds headersTimeoutMs (no retry)", async () => {
    const fetchMock = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason ?? new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const p = streamResponse(
      { input: [{ role: "user", content: "hi" }] },
      { oidcToken: "test-token", headersTimeoutMs: 1_500, maxAttempts: 2 },
    );
    const handled = p.catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(1_600);
    const err = await handled;
    expect(err).toBeInstanceOf(GatewayError);
    expect((err as GatewayError).code).toBe("timeout");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails with GatewayError timeout when the SSE stream stalls between chunks without retrying", async () => {
    const enc = new TextEncoder();
    let cancelled = false;
    const fetchMock = vi.fn(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            enc.encode(eventLine({ type: "response.output_text.delta", delta: "First " })),
          );
          // Stall indefinitely after the first chunk.
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(body, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const stream = await streamResponse(
      { input: [{ role: "user", content: "hi" }] },
      { oidcToken: "test-token", idleTimeoutMs: 1_000, maxAttempts: 2 },
    );

    const deltas: string[] = [];
    const consume = (async () => {
      for await (const ev of stream) {
        if (ev.type === "response.output_text.delta" && ev.delta) deltas.push(ev.delta);
      }
    })();
    const handled = consume.catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(1_100);
    const err = await handled;
    expect(deltas).toEqual(["First "]);
    expect(err).toBeInstanceOf(GatewayError);
    expect((err as GatewayError).code).toBe("timeout");
    expect(cancelled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("respects caller abort both before headers and mid-stream without retrying", async () => {
    // 1) Abort before headers arrive
    const caller1 = new AbortController();
    const fetchMock1 = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason ?? new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock1);

    const p1 = streamResponse(
      { input: [{ role: "user", content: "hi" }] },
      { oidcToken: "test-token", signal: caller1.signal, headersTimeoutMs: 10_000, maxAttempts: 2 },
    );
    const h1 = p1.catch((e: unknown) => e);
    caller1.abort(new DOMException("Stopped", "AbortError"));
    const err1 = await h1;
    expect((err1 as Error).name).toBe("AbortError");
    expect(fetchMock1).toHaveBeenCalledTimes(1);

    // 2) Abort mid-stream
    const caller2 = new AbortController();
    const enc = new TextEncoder();
    const fetchMock2 = vi.fn(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            enc.encode(eventLine({ type: "response.output_text.delta", delta: "Start" })),
          );
        },
      });
      return new Response(body, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock2);

    const stream = await streamResponse(
      { input: [{ role: "user", content: "hi" }] },
      { oidcToken: "test-token", signal: caller2.signal, idleTimeoutMs: 10_000 },
    );

    const seen: string[] = [];
    const iter = stream[Symbol.asyncIterator]();
    const first = await iter.next();
    expect(first.done).toBe(false);
    if (!first.done && first.value.type === "response.output_text.delta" && first.value.delta) {
      seen.push(first.value.delta);
    }

    const nextPromise = iter.next().catch((e: unknown) => e);
    caller2.abort(new DOMException("User stopped", "AbortError"));
    const err2 = await nextPromise;
    expect(seen).toEqual(["Start"]);
    expect((err2 as Error).name).toBe("AbortError");
    expect(fetchMock2).toHaveBeenCalledTimes(1);
  });
});
