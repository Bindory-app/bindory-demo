// Adapted from the HarnessRouter integration Skill's Node template (Apache-2.0).
/**
 * HarnessRouter Cloud client, server-only. Contract: UHP-Version 2026-09-28
 * (https://api.harnessrouter.ai). The key comes from HR_API_KEY (Vercel project settings in
 * production) or, locally, the one-line, git-ignored .env.harnessrouter; it is never logged and
 * never reaches the browser.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import handoff from "../../harnessrouter.json";
import type { MoriAgent } from "./mori-agents";

export const API_BASE = "https://api.harnessrouter.ai";
export const UHP_VERSION = "2026-09-28";
const TERMINAL_STATUSES = new Set(["completed", "incomplete", "failed", "cancelled"]);
const TERMINAL_EVENTS = new Set(["response.completed", "response.incomplete", "response.failed"]);

/** Each Mori agent's harness id, from harnessrouter.json. Set by the server, never by the browser. */
export function harnessIdFor(agent: MoriAgent): string {
  const id = handoff.setups.find((s) => s.feature_key === agent)?.harness_id;
  if (!id) throw new Error(`No harness configured for Mori agent "${agent}"`);
  return id;
}

/** A harness by its feature key in harnessrouter.json (e.g. "collectr"), set by the server only. */
export function harnessIdForFeature(feature: string): string {
  const id = handoff.setups.find((s) => s.feature_key === feature)?.harness_id;
  if (!id) throw new Error(`No harness configured for feature "${feature}"`);
  return id;
}

export interface FileRef {
  file_id?: string | undefined;
  filename?: string | undefined;
  download_url?: string | undefined;
}
export interface OutputItem {
  id?: string;
  type: string;
  role?: string;
  content?: { type: string; text?: string; annotations?: (FileRef & { type?: string })[] }[];
  name?: string;
  arguments?: string;
  call_id?: string;
  output?: string;
}
export interface HRResponse {
  id: string;
  status: string;
  output: OutputItem[];
  incomplete_details?: { reason?: string } | null;
  metadata?: { session_id?: string; [k: string]: unknown };
}
export interface StreamEvent {
  type: string;
  response?: HRResponse;
  delta?: string;
  item?: OutputItem;
  [k: string]: unknown;
}

export class HRError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, body: unknown) {
    const env = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const e = (env["error"] && typeof env["error"] === "object" ? env["error"] : {}) as Record<
      string,
      unknown
    >;
    super(typeof e["message"] === "string" ? e["message"] : `HTTP ${status}`);
    this.name = "HRError";
    this.status = status;
    this.code = typeof e["code"] === "string" ? e["code"] : "unknown";
  }
  get retryable() {
    return [429, 502, 503, 504].includes(this.status);
  }
}

let cachedKey: string | undefined;
export function hrApiKey(): string {
  if (cachedKey) return cachedKey;
  const env = process.env["HR_API_KEY"]?.trim();
  if (env) return (cachedKey = env);
  const lines = readFileSync(join(process.cwd(), ".env.harnessrouter"), "utf8")
    .split("\n")
    .filter((l) => l.trim());
  const line = lines[0];
  if (lines.length !== 1 || !line?.startsWith("HR_API_KEY="))
    throw new Error(".env.harnessrouter must hold exactly one HR_API_KEY line");
  return (cachedKey = line.slice("HR_API_KEY=".length).trim());
}

async function call(path: string, init: RequestInit & { headers?: Record<string, string> } = {}) {
  const res = await fetch(API_BASE + path, {
    ...init,
    redirect: "manual",
    headers: {
      Authorization: `Bearer ${hrApiKey()}`,
      "UHP-Version": UHP_VERSION,
      Accept: "application/json",
      ...init.headers,
    },
  });
  if (!res.ok) throw new HRError(res.status, await res.json().catch(() => null));
  return res;
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

export const getResponse = async (id: string) =>
  (await (await call(`/v1/responses/${encodeURIComponent(id)}`)).json()) as HRResponse;

/** Poll until terminal: every 3 s, every 10 s after a minute. Never resends the task. */
export async function waitForResponse(id: string, timeoutMs = 6 * 60_000): Promise<HRResponse> {
  const start = Date.now();
  for (;;) {
    try {
      const r = await getResponse(id);
      if (TERMINAL_STATUSES.has(r.status)) return r;
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
  return (await (await call("/v1/files", { method: "POST", body: form })).json()) as { id: string };
}

/** The session's turns: rebuilds tool outputs when the stream did not carry them. */
export async function getTurns(sessionId: string) {
  return (await (await call(`/v1/sessions/${encodeURIComponent(sessionId)}/turns`)).json()) as {
    turns?: { id: string; tools?: { name?: string; arguments?: string; output?: string }[] }[];
  };
}

export type TaskRequest = {
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
export async function cancelResponse(id: string): Promise<void> {
  await call(`/v1/responses/${encodeURIComponent(id)}/cancel`, { method: "POST" }).catch(() => {});
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
  const res = await call("/v1/responses", {
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

/** The answer: the output_text of the LAST message item. */
export function answerText(r: HRResponse): string {
  const msgs = (r.output ?? []).filter((i) => i.type === "message");
  return (msgs[msgs.length - 1]?.content ?? [])
    .filter((c) => c.type === "output_text")
    .map((c) => c.text ?? "")
    .join("");
}

/** Starts a long task in the background (the server polls it; nothing is tied to a browser). */
export async function startBackgroundTask(t: {
  harnessId: string;
  input: string;
  user: string;
  previousResponseId?: string | undefined;
  sessionId?: string | undefined;
}): Promise<HRResponse> {
  const metadata: Record<string, string> = { harness_id: t.harnessId };
  if (t.sessionId) metadata["session_id"] = t.sessionId;
  const body: Record<string, unknown> = {
    input: t.input,
    user: t.user,
    metadata,
    background: true,
  };
  if (t.previousResponseId) body["previous_response_id"] = t.previousResponseId;
  const res = await call("/v1/responses", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
  });
  return (await res.json()) as HRResponse;
}

export const isTerminal = (status: string) => TERMINAL_STATUSES.has(status);

/** Files the agent made: annotations on the answer, plus the session's changed files. */
export async function responseFiles(r: HRResponse): Promise<FileRef[]> {
  const out = new Map<string, FileRef>();
  const add = (f: FileRef) => {
    if (f.download_url && f.filename && !out.has(f.filename))
      out.set(f.filename, {
        file_id: f.file_id,
        filename: f.filename,
        download_url: f.download_url,
      });
  };
  for (const item of r.output ?? [])
    for (const c of item.content ?? []) for (const a of c.annotations ?? []) add(a);
  const sid = r.metadata?.session_id;
  if (sid) {
    try {
      const res = await call(`/v1/sessions/${encodeURIComponent(sid)}/files?changed=true`);
      const j = (await res.json()) as { data?: FileRef[]; files?: FileRef[] };
      for (const f of j.data ?? j.files ?? []) add(f);
    } catch {
      // The annotations are enough when the list is unavailable.
    }
  }
  return [...out.values()].slice(0, 20);
}

/** Downloads one of the agent's files with the key. Only HarnessRouter's own file URLs. */
export async function downloadFile(url: string): Promise<Response> {
  const u = new URL(url);
  if (u.origin !== API_BASE || !u.pathname.startsWith("/v1/"))
    throw new Error("Not a HarnessRouter file");
  return call(u.pathname + u.search, { headers: { Accept: "*/*" } });
}
