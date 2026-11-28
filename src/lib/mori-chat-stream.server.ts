/**
 * NDJSON stream contract for `/api/mori-chat`:
 * - Emits `{"type":"ping"}` heartbeats every `HEARTBEAT_INTERVAL_MS` (10 s) while the turn runs.
 * - Guarantees the stream ends with exactly one terminal event (`done` or `error`), including when
 *   `runMori` throws, returns without emitting `done`, or the request is aborted.
 * - Maps internal/upstream exceptions to short collector-safe messages with a stable `code` (no
 *   stack traces, credentials, or raw upstream response bodies).
 */
import { GatewayError } from "./ai-gateway.server";
import type { TurnTimer } from "./mori-timing.server";
import type { MoriErrorCode, MoriStreamEvent } from "./mori-tools";

/** Heartbeat interval (ms) — 3x shorter than the client's 30 s idle timeout. */
export const HEARTBEAT_INTERVAL_MS = 10_000;
/** Whole-turn budget (ms): below the 60 s function limit set for /api/mori-chat in vite.config.ts,
 *  so a slow turn ends with a clear error instead of being cut off by the platform. */
export const TURN_DEADLINE_MS = 55_000;

export function toCollectorError(
  error: unknown,
  aborted = false,
): { code: MoriErrorCode; text: string } {
  if (aborted) return { code: "aborted", text: "Stopped." };
  if (error instanceof GatewayError) {
    if (error.code === "rate_limited") {
      return {
        code: "rate_limited",
        text: "I am a little busy right now. Please try again in a moment.",
      };
    }
    if (error.code === "timeout") {
      return { code: "timeout", text: "That took too long to finish. Please try again." };
    }
    return {
      code: "upstream",
      text: "I could not reach the assistant right now. Please try again.",
    };
  }
  if (error instanceof Error && error.name === "TimeoutError") {
    return { code: "timeout", text: "That took too long to finish. Please try again." };
  }
  if (error instanceof Error && error.name === "AbortError") {
    return { code: "aborted", text: "Stopped." };
  }
  return { code: "internal", text: "I could not finish that request. Please try again." };
}

export function createMoriChatStream(options: {
  requestSignal?: AbortSignal;
  heartbeatMs?: number;
  deadlineMs?: number;
  timing?: TurnTimer;
  run: (ctx: { emit: (event: MoriStreamEvent) => void; signal: AbortSignal }) => Promise<unknown>;
}): { stream: ReadableStream<Uint8Array>; task: Promise<void> } {
  const encoder = new TextEncoder();
  const abort = new AbortController();
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_INTERVAL_MS;
  const deadlineMs = options.deadlineMs ?? TURN_DEADLINE_MS;

  let resolveTask!: () => void;
  const task = new Promise<void>((resolve) => {
    resolveTask = resolve;
  });

  let closed = false;
  let terminated = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let deadline: ReturnType<typeof setTimeout> | null = null;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;

  // Stops both timers: the heartbeat and the whole-turn deadline end with the turn.
  const stopHeartbeat = () => {
    if (heartbeat !== null) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    if (deadline !== null) {
      clearTimeout(deadline);
      deadline = null;
    }
  };

  const closeStream = () => {
    stopHeartbeat();
    if (closed || !controllerRef) return;
    closed = true;
    try {
      controllerRef.close();
    } catch {
      // Stream may already be closed or cancelled by the consumer.
    }
  };

  const emit = (event: MoriStreamEvent) => {
    if (closed || terminated || !controllerRef) return;
    const isTerminal = event.type === "done" || event.type === "error";
    if (isTerminal) {
      terminated = true;
      stopHeartbeat();
    }
    try {
      controllerRef.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
    } catch {
      closed = true;
      stopHeartbeat();
    }
  };

  const onRequestAbort = () => {
    abort.abort();
    if (!terminated) {
      emit({ type: "error", code: "aborted", text: "Stopped." });
    }
    options.timing?.flush("aborted", "aborted");
    closeStream();
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      if (options.requestSignal?.aborted) {
        onRequestAbort();
        resolveTask();
        return;
      }
      options.requestSignal?.addEventListener("abort", onRequestAbort, { once: true });
      if (heartbeatMs > 0) {
        heartbeat = setInterval(() => {
          emit({ type: "ping" });
        }, heartbeatMs);
      }

      if (deadlineMs > 0) {
        deadline = setTimeout(() => {
          if (terminated) return;
          const safe = toCollectorError(Object.assign(new Error("turn"), { name: "TimeoutError" }));
          emit({ type: "error", code: safe.code, text: safe.text });
          options.timing?.flush("error", safe.code);
          abort.abort();
        }, deadlineMs);
      }

      Promise.resolve()
        .then(() => options.run({ emit, signal: abort.signal }))
        .then(() => {
          if (!terminated) {
            const safe = toCollectorError(null, abort.signal.aborted);
            emit({ type: "error", code: safe.code, text: safe.text });
            options.timing?.flush(safe.code === "aborted" ? "aborted" : "error", safe.code);
          } else {
            options.timing?.flush("done");
          }
        })
        .catch((error: unknown) => {
          const safe = toCollectorError(error, abort.signal.aborted);
          if (safe.code !== "aborted") {
            console.error("Mori chat failed", {
              code: safe.code,
              detail: error instanceof Error ? error.message : "Unknown error",
            });
          }
          emit({ type: "error", code: safe.code, text: safe.text });
          options.timing?.flush(safe.code === "aborted" ? "aborted" : "error", safe.code);
        })
        .finally(() => {
          options.requestSignal?.removeEventListener("abort", onRequestAbort);
          closeStream();
          resolveTask();
        });
    },
    cancel() {
      closed = true;
      stopHeartbeat();
      options.requestSignal?.removeEventListener("abort", onRequestAbort);
      abort.abort();
      options.timing?.flush("aborted", "aborted");
    },
  });

  return { stream, task };
}
