/**
 * Minimal OpenAI Responses API client for Vercel AI Gateway.
 *
 * Exposes streamResponse, GatewayError and the Responses types mori-agent.server.ts uses.
 *
 * Auth, in order: the Vercel OIDC token for this request (set automatically on Vercel deployments,
 * no key to manage), VERCEL_OIDC_TOKEN from the environment, then AI_GATEWAY_API_KEY for local runs.
 * Server only: these credentials must never reach browser code.
 */

import { upstreamFetch } from "./upstream-fetch";

const GATEWAY_URL = "https://ai-gateway.vercel.sh/v1/responses";
/** Maximum wait for AI Gateway response headers (ms); retried only on 5xx/network before bytes flow. */
export const GATEWAY_HEADERS_TIMEOUT_MS = 15_000;
/** Maximum silence between SSE chunks once streaming begins (ms); never retried after output starts. */
export const GATEWAY_IDLE_TIMEOUT_MS = 20_000;
const GATEWAY_MAX_ATTEMPTS = 2;
const GATEWAY_ERROR_BODY_TIMEOUT_MS = 3_000;
const MODEL = process.env["AI_GATEWAY_MODEL"] || "google/gemini-2.5-flash";
const MODELS = [
  ...new Set([MODEL, "openai/gpt-4.1-mini", "google/gemini-2.5-flash-lite", "openai/gpt-5-mini"]),
];
type GatewayOptions = {
  signal?: AbortSignal | undefined;
  oidcToken?: string | null | undefined;
  headersTimeoutMs?: number;
  idleTimeoutMs?: number;
  maxAttempts?: number;
  /** Told which model each attempt uses (the next one is tried when a model is rate limited). */
  onModel?: (model: string) => void;
};

export type ResponsesFunctionTool = {
  type: "function";
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
};

export type ResponsesInputItem =
  | { role: "user" | "system" | "developer"; content: string }
  | {
      role: "user";
      content: (
        { type: "input_text"; text: string } | { type: "input_image"; image_url: string }
      )[];
    }
  | {
      role: "assistant";
      content: { type: "output_text"; text: string; annotations: unknown[] }[];
    }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

export type ResponsesRequest = {
  model: string;
  instructions?: string;
  input: ResponsesInputItem[];
  tools?: ResponsesFunctionTool[];
  tool_choice?: "auto" | "required";
  max_output_tokens?: number;
};

type OutputContent = { type: string; text?: string };
type OutputItem = {
  type: string;
  name?: string;
  arguments?: string;
  call_id?: string;
  content?: OutputContent[];
};

export type ResponsesResponse = { id?: string; output?: OutputItem[] };

/** One SSE event. `delta` is set on response.output_text.delta, `response` on response.completed. */
type ResponsesStreamEvent = {
  type: string;
  delta?: string;
  response?: ResponsesResponse;
};

type GatewayErrorCode =
  | "not_configured"
  | "unauthorized"
  | "payment_required"
  | "rate_limited"
  | "bad_request"
  | "timeout"
  | "upstream";

export class GatewayError extends Error {
  readonly code: GatewayErrorCode;
  readonly ids: { requestId?: string | undefined };
  constructor(
    code: GatewayErrorCode,
    message: string,
    ids: { requestId?: string | undefined } = {},
  ) {
    super(message);
    this.name = "GatewayError";
    this.code = code;
    this.ids = ids;
  }
}

function codeForStatus(status: number): GatewayErrorCode {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 402) return "payment_required";
  if (status === 429) return "rate_limited";
  if (status >= 400 && status < 500) return "bad_request";
  return "upstream";
}

function readChunkWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number,
  requestId?: string,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal?.aborted) {
    return Promise.reject(
      signal.reason ??
        (typeof DOMException !== "undefined"
          ? new DOMException("The operation was aborted", "AbortError")
          : Object.assign(new Error("The operation was aborted"), { name: "AbortError" })),
    );
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () =>
      finish(() => {
        void reader.cancel().catch(() => {});
        reject(
          signal?.reason ??
            (typeof DOMException !== "undefined"
              ? new DOMException("The operation was aborted", "AbortError")
              : Object.assign(new Error("The operation was aborted"), { name: "AbortError" })),
        );
      });
    const timer = setTimeout(
      () =>
        finish(() => {
          void reader.cancel().catch(() => {});
          reject(
            new GatewayError("timeout", `Gateway stream stalled after ${idleTimeoutMs}ms`, {
              requestId,
            }),
          );
        }),
      idleTimeoutMs,
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (chunk) => finish(() => resolve(chunk)),
      (err: unknown) => finish(() => reject(err)),
    );
  });
}

async function readTextBounded(res: Response, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void res.body?.cancel().catch(() => {});
      resolve("");
    }, timeoutMs);
    res.text().then(
      (txt) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(txt);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve("");
      },
    );
  });
}

async function* readSse(
  body: ReadableStream<Uint8Array>,
  requestId?: string,
  idleTimeoutMs = GATEWAY_IDLE_TIMEOUT_MS,
  signal?: AbortSignal,
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  let event = "";
  try {
    while (true) {
      const { value, done } = await readChunkWithIdleTimeout(
        reader,
        idleTimeoutMs,
        requestId,
        signal,
      );
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.search(/\r?\n/)) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(buffer[nl] === "\r" ? nl + 2 : nl + 1);
        if (line === "") {
          if (data.length) {
            const payload = data.join("\n");
            data = [];
            if (payload === "[DONE]") return;
            const parsed = JSON.parse(payload) as Record<string, unknown>;
            const type = (parsed["type"] as string | undefined) ?? event;
            if (type === "error" || type === "response.failed" || parsed["error"]) {
              throw new GatewayError("upstream", "Gateway stream reported an error", { requestId });
            }
            yield { ...parsed, type } as ResponsesStreamEvent;
          }
          event = "";
        } else if (!line.startsWith(":")) {
          const colon = line.indexOf(":");
          const field = colon === -1 ? line : line.slice(0, colon);
          const val = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
          if (field === "data") data.push(val);
          if (field === "event") event = val;
        }
      }
      if (done) return;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** POST a streaming Responses request to AI Gateway and iterate its SSE events. */
async function streamModelResponse(
  payload: ResponsesRequest,
  options: GatewayOptions,
): Promise<AsyncIterable<ResponsesStreamEvent>> {
  const sources: [string, string | null | undefined][] = [
    ["request OIDC token", options.oidcToken],
    ["VERCEL_OIDC_TOKEN", process.env["VERCEL_OIDC_TOKEN"]],
    ["AI_GATEWAY_API_KEY", process.env["AI_GATEWAY_API_KEY"]],
  ];
  const [source, key] = sources.find(([, v]) => !!v) ?? ["none", undefined];
  if (!key)
    throw new GatewayError("not_configured", "No AI Gateway credential (OIDC token or API key)");
  const headersTimeoutMs = options.headersTimeoutMs ?? GATEWAY_HEADERS_TIMEOUT_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? GATEWAY_IDLE_TIMEOUT_MS;
  const maxAttempts = options.maxAttempts ?? GATEWAY_MAX_ATTEMPTS;
  let res: Response;
  try {
    // Retries happen strictly before any stream byte is consumed (5xx / network errors). A rate
    // limit is not retried here: streamResponse moves on to the next model instead.
    // Header timeouts are not retried so a hung upstream never doubles latency inside the 60 s turn.
    res = await upstreamFetch(GATEWAY_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, stream: true }),
      timeoutMs: headersTimeoutMs,
      maxAttempts,
      baseDelayMs: 400,
      maxDelayMs: 2_000,
      retryStatuses: [500, 502, 503, 504],
      retryOnTimeout: false,
      retryOnNetworkError: true,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (err) {
    if (options.signal?.aborted) throw err;
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new GatewayError(
        "timeout",
        `Gateway timed out waiting for headers after ${headersTimeoutMs}ms`,
      );
    }
    throw new GatewayError(
      "upstream",
      err instanceof Error ? `Gateway network error: ${err.message}` : "Gateway network error",
    );
  }
  const requestId = res.headers.get("x-vercel-id") ?? undefined;
  if (!res.ok || !res.body) {
    const detail = await readTextBounded(res, GATEWAY_ERROR_BODY_TIMEOUT_MS);
    // Names the credential source only, never its value.
    console.error("AI Gateway rejected request", {
      status: res.status,
      credential: source,
      detail: detail.slice(0, 300),
    });
    throw new GatewayError(
      codeForStatus(res.status),
      `Gateway request failed (${res.status}): ${detail.slice(0, 300)}`,
      { requestId },
    );
  }
  const body = res.body;
  return {
    [Symbol.asyncIterator]: () => readSse(body, requestId, idleTimeoutMs, options.signal),
  };
}

/** Chat and single-purpose calls share the same model selection and rate-limit fallback. */
export async function streamResponse(
  payload: Omit<ResponsesRequest, "model">,
  options: GatewayOptions = {},
) {
  for (const model of MODELS) {
    options.onModel?.(model);
    try {
      return await streamModelResponse({ ...payload, model }, options);
    } catch (error) {
      if (
        !(error instanceof GatewayError && error.code === "rate_limited") ||
        model === MODELS.at(-1)
      )
        throw error;
    }
  }
  throw new Error("No gateway model configured");
}

/** One inference turn with one allowed function and no tool execution. Callers validate the
 *  returned arguments for their job; missing, ambiguous or malformed calls yield null. */
export async function callToolOnce(
  tool: ResponsesFunctionTool,
  instructions: string,
  input: ResponsesInputItem[],
  options: GatewayOptions = {},
): Promise<unknown> {
  const stream = await streamResponse(
    { instructions, input, tools: [tool], tool_choice: "required", max_output_tokens: 500 },
    options,
  );
  for await (const event of stream) {
    if (event.type !== "response.completed") continue;
    const calls = event.response?.output?.filter((item) => item.type === "function_call");
    if (calls?.length !== 1 || calls[0]?.name !== tool.name) return null;
    try {
      return JSON.parse(calls[0].arguments ?? "");
    } catch {
      return null;
    }
  }
  return null;
}
