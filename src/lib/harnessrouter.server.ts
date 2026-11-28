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

const API_BASE = "https://api.harnessrouter.ai";
const UHP_VERSION = "2026-09-28";
const TERMINAL_STATUSES = new Set(["completed", "incomplete", "failed", "cancelled"]);
/** A harness by its feature key in harnessrouter.json (e.g. "collectr"), set by the server only. */
export function harnessIdForFeature(feature: string): string {
  const id = handoff.setups.find((s) => s.feature_key === feature)?.harness_id;
  if (!id) throw new Error(`No harness configured for feature "${feature}"`);
  return id;
}

interface FileRef {
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
function hrApiKey(): string {
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

export async function callHarnessRouter(
  path: string,
  init: RequestInit & { headers?: Record<string, string> } = {},
) {
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

export const getResponse = async (id: string) =>
  (await (await callHarnessRouter(`/v1/responses/${encodeURIComponent(id)}`)).json()) as HRResponse;

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
  const res = await callHarnessRouter("/v1/responses", {
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
      const res = await callHarnessRouter(
        `/v1/sessions/${encodeURIComponent(sid)}/files?changed=true`,
      );
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
  return callHarnessRouter(u.pathname + u.search, { headers: { Accept: "*/*" } });
}
