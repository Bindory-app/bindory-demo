// Adapted from the HarnessRouter integration Skill's Node template (Apache-2.0).
import { randomUUID } from "node:crypto";
import handoff from "../../harnessrouter.json";
import type { MoriAgent } from "./mori-agents";
import {
  callHarnessRouter,
  getResponse,
  HRError,
  isTerminal,
  type HRResponse,
  type OutputItem,
} from "./harnessrouter.server";

const TERMINAL_EVENTS = new Set(["response.completed", "response.incomplete", "response.failed"]);

/** Each Mori agent's harness id, from harnessrouter.json. Set by the server, never by the browser. */
export function harnessIdFor(agent: MoriAgent): string {
  const id = handoff.setups.find((s) => s.feature_key === agent)?.harness_id;
  if (!id) throw new Error(`No harness configured for Mori agent "${agent}"`);
  return id;
}

interface StreamEvent {
  type: string;
  response?: HRResponse;
  delta?: string;
  item?: OutputItem;
  [k: string]: unknown;
}

/** SSE frames split on a blank line, data: lines joined and parsed; [DONE] and junk skipped. */
export async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const take = (frame: string): StreamEvent | null => {
    const data = frame
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n")
      .trim();
    if (!data || data === "[DONE]") return null;
    try {
      const ev = JSON.parse(data) as StreamEvent;
      return typeof ev?.type === "string" ? ev : null;
    } catch {
      return null;
    }
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf = (buf + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const ev = take(buf.slice(0, i));
        buf = buf.slice(i + 2);
        if (ev) yield ev;
      }
    }
    buf += decoder.decode();
    const ev = buf.trim() ? take(buf) : null;
    if (ev) yield ev;
  } finally {
    reader.releaseLock();
  }
}

/** Poll until terminal: every 3 s, every 10 s after a minute. Never resends the task. */
async function waitForResponse(id: string, timeoutMs = 6 * 60_000): Promise<HRResponse> {
  const start = Date.now();
  for (;;) {
    try {
      const r = await getResponse(id);
      if (isTerminal(r.status)) return r;
    } catch (e) {
      if (!(e instanceof HRError) || !e.retryable) throw e;
    }
    if (Date.now() - start > timeoutMs) throw new HRError(504, null);
    await new Promise((r) => setTimeout(r, Date.now() - start > 60_000 ? 10_000 : 3_000));
  }
}

/** Uploads one file for a task's input (it appears in the task's working directory). */
export async function uploadFile(bytes: Uint8Array, filename: string, type: string) {
  const form = new FormData();
  form.append("purpose", "user_data");
  form.append("file", new Blob([bytes as BlobPart], { type }), filename);
  return (await (await callHarnessRouter("/v1/files", { method: "POST", body: form })).json()) as {
    id: string;
  };
}

/** The session's turns: rebuilds tool outputs when the stream did not carry them. */
export async function getTurns(sessionId: string) {
  return (await (
    await callHarnessRouter(`/v1/sessions/${encodeURIComponent(sessionId)}/turns`)
  ).json()) as {
    turns?: { id: string; tools?: { name?: string; arguments?: string; output?: string }[] }[];
  };
}

type TaskRequest = {
  /** The agent's own harness; on a follow-up, the harness the session started on. */
  harnessId: string;
  input: unknown;
  /** The signed-in collector's Bindory user id, from the server session. */
  user: string;
  /** Follow-ups in the same chat: both from the collector's stored chat rows. */
  previousResponseId?: string | undefined;
  sessionId?: string | undefined;
  /** Extra headers the harness forwards to its MCP server (listed in additional_headers). */
  headers?: Record<string, string>;
  /** The collector pressed Stop: the task is cancelled on HarnessRouter and the call throws. */
  signal?: AbortSignal | undefined;
};

/** Thrown when the collector stops Mori mid-answer. */
export class MoriStopped extends Error {
  constructor() {
    super("Stopped by the collector");
  }
}

/** Best-effort cancel of a running task (its session stays usable). */
async function cancelResponse(id: string): Promise<void> {
  await callHarnessRouter(`/v1/responses/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
  }).catch(() => {});
}

/**
 * Starts (or continues) one task on the Ask Mori harness and reads its stream to the end,
 * independent of the browser connection. Falls back to polling if the stream breaks after the
 * task started; never sends the task twice.
 */
export async function runStreamedTask(
  t: TaskRequest,
  onEvent: (ev: StreamEvent) => void = () => {},
): Promise<HRResponse> {
  const metadata: Record<string, string> = { harness_id: t.harnessId };
  if (t.sessionId) metadata["session_id"] = t.sessionId;
  const body: Record<string, unknown> = { input: t.input, user: t.user, metadata, stream: true };
  if (t.previousResponseId) body["previous_response_id"] = t.previousResponseId;
  const res = await callHarnessRouter("/v1/responses", {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "Idempotency-Key": randomUUID(),
      ...t.headers,
    },
    signal: t.signal ?? null,
  });
  if (!res.body) throw new HRError(502, null);
  let responseId = "";
  let terminal: HRResponse | null = null;
  try {
    // Stop aborts the request itself (passed to fetch), which ends this read at once.
    for await (const ev of parseSSE(res.body)) {
      if (ev.response?.id && !responseId) responseId = ev.response.id;
      if (t.signal?.aborted) break;
      onEvent(ev);
      if (TERMINAL_EVENTS.has(ev.type) && ev.response) terminal = ev.response;
    }
  } catch (e) {
    if (!responseId && !t.signal?.aborted) throw e;
  }
  if (t.signal?.aborted) {
    if (responseId) await cancelResponse(responseId);
    throw new MoriStopped();
  }
  if (terminal) return terminal;
  if (!responseId) throw new HRError(502, null);
  return waitForResponse(responseId);
}
