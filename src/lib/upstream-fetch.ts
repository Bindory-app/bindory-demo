/**
 * Shared upstream HTTP fetch helper with per-attempt timeouts, caller AbortSignal forwarding,
 * retry on transient failures (429, 5xx, network/timeout errors), capped exponential backoff with
 * jitter, and Retry-After support.
 *
 * Non-idempotent or paid endpoints (such as Apify actor runs or metered search APIs) opt out of
 * retrying timeouts, network errors, and slow failures so a request that may already have started
 * upstream is never submitted twice.
 */
export type UpstreamFetchOptions = RequestInit & {
  /** Maximum duration for a single HTTP attempt in milliseconds. */
  timeoutMs?: number;
  /** Maximum total attempts including the initial request (clamped to 1..5, default 3). */
  maxAttempts?: number;
  /** Initial backoff delay in milliseconds before jitter (default 300). */
  baseDelayMs?: number;
  /** Upper bound for any retry delay, including Retry-After (default 4_000). */
  maxDelayMs?: number;
  /** HTTP status codes eligible for retry (defaults to 429 and 500..599). */
  retryStatuses?: readonly number[];
  /** Whether to retry when a single attempt hits timeoutMs (default true). */
  retryOnTimeout?: boolean;
  /** Whether to retry on non-abort network errors (default true). */
  retryOnNetworkError?: boolean;
  /**
   * When set, retryable HTTP statuses are only retried if the attempt completed within this many
   * milliseconds (useful for paid sync runs where only fast 429/502/503 rejections are safe).
   */
  maxRetryElapsedMs?: number;
  /** Optional random source returning [0, 1) for deterministic tests (default Math.random). */
  random?: () => number;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_ATTEMPTS_CAP = 5;
const DEFAULT_BASE_DELAY_MS = 300;
const DEFAULT_MAX_DELAY_MS = 4_000;

function makeTimeoutError(timeoutMs: number): Error {
  return typeof DOMException !== "undefined"
    ? new DOMException(`Upstream request timed out after ${timeoutMs}ms`, "TimeoutError")
    : Object.assign(new Error(`Upstream request timed out after ${timeoutMs}ms`), {
        name: "TimeoutError",
      });
}

function makeAbortError(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  return typeof DOMException !== "undefined"
    ? new DOMException("The operation was aborted", "AbortError")
    : Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
}

/** Parses an HTTP Retry-After header (delta-seconds or HTTP-date) into milliseconds, or null. */
export function parseRetryAfterMs(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (!trimmed) return null;
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const sec = Number(trimmed);
    return Number.isFinite(sec) && sec >= 0 ? Math.round(sec * 1000) : null;
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - now);
  return null;
}

function isRetryableStatus(status: number, retryStatuses?: readonly number[]): boolean {
  if (retryStatuses) return retryStatuses.includes(status);
  return status === 429 || (status >= 500 && status <= 599);
}

function backoffDelayMs(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number,
): number {
  const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  const r = Math.min(1, Math.max(0, random()));
  return Math.round(exp * (0.5 + 0.5 * r));
}

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(makeAbortError(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(makeAbortError(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export type UpstreamJsonResponse<T = unknown> = {
  ok: boolean;
  status: number;
  headers: Headers;
  /** Parsed JSON body when `ok` is true and the body was valid JSON; otherwise null. */
  data: T | null;
};

function readJsonWithSignal(res: Response, signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) {
    void res.body?.cancel().catch(() => {});
    return Promise.reject(makeAbortError(signal));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      void res.body?.cancel().catch(() => {});
      reject(makeAbortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    res.json().then(
      (data) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(data);
      },
      (err: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

async function runAttemptLoop<R>(
  url: string,
  options: UpstreamFetchOptions,
  handleResponse: (res: Response, signal: AbortSignal) => Promise<R>,
): Promise<R> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxAttempts: rawMaxAttempts = DEFAULT_MAX_ATTEMPTS,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
    retryStatuses,
    retryOnTimeout = true,
    retryOnNetworkError = true,
    maxRetryElapsedMs,
    random = Math.random,
    signal: callerSignal,
    ...fetchInit
  } = options;

  const maxAttempts = Math.min(MAX_ATTEMPTS_CAP, Math.max(1, Math.floor(rawMaxAttempts)));

  if (callerSignal?.aborted) throw makeAbortError(callerSignal);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const attemptStart = Date.now();
    const controller = new AbortController();
    let timedOut = false;

    const onCallerAbort = () => controller.abort(makeAbortError(callerSignal!));
    if (callerSignal) {
      if (callerSignal.aborted) throw makeAbortError(callerSignal);
      callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    }

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(makeTimeoutError(timeoutMs));
    }, timeoutMs);

    try {
      const res = await fetch(url, { ...fetchInit, signal: controller.signal });

      const hasMoreAttempts = attempt + 1 < maxAttempts;
      const shouldCheckRetry = hasMoreAttempts && isRetryableStatus(res.status, retryStatuses);
      if (shouldCheckRetry) {
        const elapsed = Date.now() - attemptStart;
        const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
        const withinElapsed = maxRetryElapsedMs === undefined || elapsed <= maxRetryElapsedMs;
        // Never violate an explicit Retry-After longer than our cap or stall the serverless request.
        const withinRetryAfter = retryAfterMs === null || retryAfterMs <= maxDelayMs;
        if (withinElapsed && withinRetryAfter) {
          clearTimeout(timer);
          callerSignal?.removeEventListener("abort", onCallerAbort);
          const delay =
            retryAfterMs !== null
              ? retryAfterMs
              : backoffDelayMs(attempt, baseDelayMs, maxDelayMs, random);
          void res.body?.cancel().catch(() => {});
          await sleep(delay, callerSignal);
          continue;
        }
      }

      const out = await handleResponse(res, controller.signal);
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
      return out;
    } catch (err) {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);

      if (callerSignal?.aborted) throw makeAbortError(callerSignal);

      const isTimeout = timedOut || (err instanceof Error && err.name === "TimeoutError");
      const canRetry =
        attempt + 1 < maxAttempts && (isTimeout ? retryOnTimeout : retryOnNetworkError);

      if (!canRetry) throw isTimeout ? makeTimeoutError(timeoutMs) : err;

      const delay = backoffDelayMs(attempt, baseDelayMs, maxDelayMs, random);
      await sleep(delay, callerSignal);
    }
  }

  throw new Error("Upstream fetch exhausted attempts");
}

export async function upstreamFetch(
  url: string,
  options: UpstreamFetchOptions = {},
): Promise<Response> {
  return runAttemptLoop(url, options, async (res) => res);
}

/**
 * Fetches an upstream JSON endpoint and reads the JSON body under the same per-attempt timeout
 * deadline so a provider that sends headers then stalls cannot hang `res.json()`.
 */
export async function upstreamFetchJson<T = unknown>(
  url: string,
  options: UpstreamFetchOptions = {},
): Promise<UpstreamJsonResponse<T>> {
  return runAttemptLoop(url, options, async (res, signal) => {
    if (!res.ok) {
      void res.body?.cancel().catch(() => {});
      return { ok: false, status: res.status, headers: res.headers, data: null };
    }
    try {
      const data = (await readJsonWithSignal(res, signal)) as T;
      return { ok: true, status: res.status, headers: res.headers, data };
    } catch (err) {
      // Malformed JSON on a completed 2xx response is not a transient transport failure.
      if (!signal.aborted && err instanceof SyntaxError) {
        return { ok: true, status: res.status, headers: res.headers, data: null };
      }
      throw err;
    }
  });
}
