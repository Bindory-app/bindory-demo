import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayError } from "@/lib/ai-gateway.server";
import { createMoriChatStream } from "@/lib/mori-chat-stream.server";
import { createTurnTimer } from "@/lib/mori-timing.server";
import type { MoriStreamEvent } from "@/lib/mori-tools";

async function readNdjson(stream: ReadableStream<Uint8Array>): Promise<MoriStreamEvent[]> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    text += dec.decode(value, { stream: true });
  }
  text += dec.decode();
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as MoriStreamEvent);
}

type ClientReaderFn = (
  body: ReadableStream<Uint8Array>,
  opts: { idleMs?: number; onEvent?: (ev: Record<string, unknown>) => void; signal?: AbortSignal },
) => Promise<void>;

/** Extracts `readMoriNdjsonStream` straight from `wireframe/live.html` with no build step. */
function loadClientReaderFromLiveHtml(): ClientReaderFn {
  const html = readFileSync(path.resolve(process.cwd(), "wireframe/live.html"), "utf8");
  const start = html.indexOf("const MORI_STREAM_IDLE_MS =");
  const end = html.indexOf("// Called from the wireframe's own route()");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Could not locate readMoriNdjsonStream in wireframe/live.html");
  }
  const source = `${html.slice(start, end)}\nreadMoriNdjsonStream;`;
  const context = vm.createContext({
    TextDecoder,
    setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
    clearTimeout: (...args: Parameters<typeof clearTimeout>) => clearTimeout(...args),
  });
  return vm.runInContext(source, context) as ClientReaderFn;
}

describe("mori-chat NDJSON stream contract", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("emits periodic pings while running, stops them on done, and ends with exactly one terminal event", async () => {
    const logs: string[] = [];
    const timing = createTurnTimer(
      () => Date.now(),
      (line) => logs.push(line),
    );
    const { stream, task } = createMoriChatStream({
      heartbeatMs: 10_000,
      timing,
      run: async ({ emit }) => {
        emit({ type: "status", name: "get_card_prices", text: "Checking prices" });
        await new Promise((r) => setTimeout(r, 25_000));
        emit({ type: "text", text: "Done." });
        emit({ type: "done", rows: [] });
        // Any event emitted after terminal done must be ignored.
        emit({ type: "done", rows: [] });
      },
    });

    const eventsPromise = readNdjson(stream);
    await vi.advanceTimersByTimeAsync(60_000);
    await task;
    const events = await eventsPromise;

    const pings = events.filter((e) => e.type === "ping");
    const terminals = events.filter((e) => e.type === "done" || e.type === "error");
    expect(pings).toHaveLength(2);
    expect(terminals).toEqual([{ type: "done", rows: [] }]);
    expect(events.at(-1)?.type).toBe("done");
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0]!)).toMatchObject({ event: "mori.turn", outcome: "done" });
  });

  it("maps thrown errors to a single collector-safe error event with a stable code (no stack/keys/upstream body)", async () => {
    const cases: Array<{ err: unknown; code: string }> = [
      {
        err: new GatewayError(
          "rate_limited",
          "429 upstream sk-secret-key raw body stack at /src/lib/ai-gateway.server.ts:99",
        ),
        code: "rate_limited",
      },
      {
        err: new GatewayError("timeout", "Gateway stream stalled after 20000ms"),
        code: "timeout",
      },
      {
        err: new GatewayError("upstream", "502 upstream secret token leak"),
        code: "upstream",
      },
      {
        err: new Error("TypeError: secret_api_key=abc123\n    at internal.ts:42"),
        code: "internal",
      },
    ];

    for (const c of cases) {
      const logs: string[] = [];
      const timing = createTurnTimer(
        () => Date.now(),
        (line) => logs.push(line),
      );
      const { stream, task } = createMoriChatStream({
        heartbeatMs: 10_000,
        timing,
        run: async () => {
          throw c.err;
        },
      });
      const events = await readNdjson(stream);
      await task;

      const terminals = events.filter((e) => e.type === "done" || e.type === "error");
      expect(terminals).toHaveLength(1);
      const errEv = terminals[0]!;
      expect(errEv.type).toBe("error");
      if (errEv.type === "error") {
        expect(errEv.code).toBe(c.code);
        expect(errEv.text.length).toBeGreaterThan(5);
        expect(errEv.text).not.toMatch(/sk-secret|secret_api_key|ai-gateway|internal\.ts|502|429/i);
      }
      expect(JSON.parse(logs[0]!)).toMatchObject({
        event: "mori.turn",
        outcome: "error",
        error_code: c.code,
      });
    }
  });

  it("ends a turn that outlives its budget with one timeout error and aborts its work", async () => {
    const lines: string[] = [];
    const timing = createTurnTimer(undefined, (line) => lines.push(line));
    let turnSignal: AbortSignal | undefined;
    const { stream, task } = createMoriChatStream({
      heartbeatMs: 0,
      deadlineMs: 55_000,
      timing,
      run: ({ signal }) => {
        turnSignal = signal;
        return new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(new Error("stopped"))),
        );
      },
    });
    const read = readNdjson(stream);
    await vi.advanceTimersByTimeAsync(55_000);
    await task;
    expect(await read).toEqual([
      { type: "error", code: "timeout", text: "That took too long to finish. Please try again." },
    ]);
    expect(turnSignal?.aborted).toBe(true);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ outcome: "error", error_code: "timeout" });
  });

  it("emits exactly one error event if run completes without emitting done", async () => {
    const { stream, task } = createMoriChatStream({
      heartbeatMs: 10_000,
      run: async ({ emit }) => {
        emit({ type: "status", name: "search_catalogue", text: "Searching" });
      },
    });
    const events = await readNdjson(stream);
    await task;
    const terminals = events.filter((e) => e.type === "done" || e.type === "error");
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({ type: "error", code: "internal" });
  });

  it("emits exactly one aborted error event, stops heartbeats, and aborts the turn signal on request abort", async () => {
    const reqAbort = new AbortController();
    let innerAborted = false;
    const logs: string[] = [];
    const timing = createTurnTimer(
      () => Date.now(),
      (line) => logs.push(line),
    );
    const { stream, task } = createMoriChatStream({
      requestSignal: reqAbort.signal,
      heartbeatMs: 10_000,
      timing,
      run: async ({ signal }) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              innerAborted = true;
              resolve();
            },
            { once: true },
          );
        });
      },
    });

    const eventsPromise = readNdjson(stream);
    await vi.advanceTimersByTimeAsync(11_000);
    reqAbort.abort();
    await vi.advanceTimersByTimeAsync(30_000);
    await task;
    const events = await eventsPromise;

    expect(innerAborted).toBe(true);
    expect(events.filter((e) => e.type === "ping")).toHaveLength(1);
    const terminals = events.filter((e) => e.type === "done" || e.type === "error");
    expect(terminals).toEqual([{ type: "error", code: "aborted", text: "Stopped." }]);
    expect(JSON.parse(logs[0]!)).toMatchObject({
      event: "mori.turn",
      outcome: "aborted",
      error_code: "aborted",
    });
  });
});

describe("wireframe/live.html client reader and embedded copy sync", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps wireframe/live.html and wireframe/app.html in sync (--check)", () => {
    const output = execFileSync("python3", ["scripts/sync-live-layer.py", "--check"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(output).toContain("in sync");
  });

  it("ignores pings and unknown events while resetting the 30s idle timer until done", async () => {
    const readMoriNdjsonStream = loadClientReaderFromLiveHtml();
    const enc = new TextEncoder();
    const received: Record<string, unknown>[] = [];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        setTimeout(() => controller.enqueue(enc.encode('{"type":"ping"}\n')), 10_000);
        setTimeout(() => controller.enqueue(enc.encode('{"type":"future_event","x":1}\n')), 20_000);
        setTimeout(() => controller.enqueue(enc.encode('{"type":"ping"}\n')), 30_000);
        setTimeout(() => {
          // Split across chunks and omit trailing newline on EOF to verify buffer flushing.
          controller.enqueue(enc.encode('{"type":"status","text":"Checking"}\n{"type":"do'));
          controller.enqueue(enc.encode('ne","rows":[]}'));
          controller.close();
        }, 40_000);
      },
    });

    const p = readMoriNdjsonStream(body, {
      idleMs: 30_000,
      onEvent: (ev) => received.push(ev),
    });
    await vi.advanceTimersByTimeAsync(45_000);
    await p;

    expect(received).toEqual([
      { type: "status", text: "Checking" },
      { type: "done", rows: [] },
    ]);
  });

  it("times out if no line (including pings) arrives within 30s", async () => {
    const readMoriNdjsonStream = loadClientReaderFromLiveHtml();
    const body = new ReadableStream<Uint8Array>({
      start() {
        // Stalled server sends nothing after headers.
      },
    });

    const p = readMoriNdjsonStream(body, { idleMs: 30_000 });
    const handled = p.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(30_100);
    const err = (await handled) as Error & { code?: string };
    expect(err.code).toBe("timeout");
  });

  it("errors clearly when the stream closes without a terminal done or error event", async () => {
    const readMoriNdjsonStream = loadClientReaderFromLiveHtml();
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode('{"type":"ping"}\n{"type":"status","text":"Working"}\n'));
        controller.close();
      },
    });

    const err = (await readMoriNdjsonStream(body, { idleMs: 30_000 }).catch((e: unknown) => e)) as
      (Error & { code?: string }) | undefined;
    expect(err?.code).toBe("incomplete_stream");
  });

  it("surfaces the server's error message and code on an error event", async () => {
    const readMoriNdjsonStream = loadClientReaderFromLiveHtml();
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          enc.encode(
            '{"type":"error","code":"rate_limited","text":"I am a little busy right now."}\n',
          ),
        );
        controller.close();
      },
    });

    const err = (await readMoriNdjsonStream(body, { idleMs: 30_000 }).catch((e: unknown) => e)) as
      (Error & { code?: string; fromServer?: boolean }) | undefined;
    expect(err?.fromServer).toBe(true);
    expect(err?.code).toBe("rate_limited");
    expect(err?.message).toBe("I am a little busy right now.");
  });
});
