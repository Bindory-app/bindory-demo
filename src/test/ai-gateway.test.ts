import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayError, REASONING_HEADROOM_TOKENS, streamResponse } from "@/lib/ai-gateway.server";

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
  it("does not read or log request contents echoed by a rejected provider", async () => {
    const response = new Response("private-collector-text", { status: 400 });
    const read = vi.spyOn(response, "text");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    await expect(
      streamResponse({ input: [] }, { oidcToken: "test-token", maxAttempts: 1 }),
    ).rejects.toThrow("Gateway request failed (400)");
    expect(read).not.toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/private-collector-text|test-token/);
  });

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

  it("moves down the model list on 403 and 429, sending each model its reasoning effort", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        // 403: this key may not use the model. 429: the model is rate limited.
        const refusals = [403, 429, 403];
        const status = refusals[bodies.length - 1];
        return status
          ? new Response("refused", { status })
          : sseResponse([eventLine({ type: "response.completed", response: { output: [] } })]);
      }),
    );

    await streamResponse(
      { input: [{ role: "user", content: "hi" }], max_output_tokens: 500 },
      { oidcToken: "test-token" },
    );

    expect(bodies.map((b) => [b["model"], b["reasoning"]])).toEqual([
      ["openai/gpt-6.2-sol", { effort: "medium" }],
      ["anthropic/claude-sonnet-5.5", { effort: "medium" }],
      ["google/gemini-4-carbon", { effort: "low" }],
      ["google/gemini-2.5-flash", undefined],
    ]);
    for (const body of bodies)
      expect(body["max_output_tokens"]).toBe(500 + REASONING_HEADROOM_TOKENS);
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
