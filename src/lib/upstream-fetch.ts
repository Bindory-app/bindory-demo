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

export async function upstreamFetch(
  url: string,
  options: UpstreamFetchOptions = {},
): Promise<Response> {
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
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);

      const hasMoreAttempts = attempt + 1 < maxAttempts;
      if (!hasMoreAttempts || !isRetryableStatus(res.status, retryStatuses)) return res;

      const elapsed = Date.now() - attemptStart;
      if (maxRetryElapsedMs !== undefined && elapsed > maxRetryElapsedMs) return res;

      const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
      // Never violate an explicit Retry-After longer than our cap or stall the serverless request.
      if (retryAfterMs !== null && retryAfterMs > maxDelayMs) return res;

      const delay =
        retryAfterMs !== null
          ? retryAfterMs
          : backoffDelayMs(attempt, baseDelayMs, maxDelayMs, random);
      void res.body?.cancel().catch(() => {});
      await sleep(delay, callerSignal);
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
