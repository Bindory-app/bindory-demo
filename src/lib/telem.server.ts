/**
 * Web search and page fetch for Mori's agents through Telem (https://router.telem.ai), server-only.
 * The key (TELEM_API_KEY) never reaches the browser or the agent. Calls are kept small on purpose:
 * search runs on two providers with at most 5 results each, fetch reads at most 3 pages and keeps
 * 6,000 characters of each, so a web lookup costs about a cent.
 */
import { upstreamFetch } from "./upstream-fetch";

const API = "https://router.telem.ai/v1";
const SEARCH_PROVIDERS = ["brave", "tavily"];
const MAX_RESULTS = 5;
const MAX_URLS = 3;
const MAX_CHARS = 6000;
const SEARCH_TIMEOUT_MS = 20_000;
const FETCH_TIMEOUT_MS = 25_000;

type WebResult = { title: string; url: string; summary?: string | undefined };
type WebPage = {
  url: string;
  ok: boolean;
  title?: string | undefined;
  content?: string | undefined;
  truncated?: boolean | undefined;
};

function key() {
  const k = process.env["TELEM_API_KEY"]?.trim();
  if (!k) throw new Error("Web search is not configured");
  return k;
}

async function post(path: string, body: unknown, timeoutMs: number) {
  // Paid POST (~1 cent/call): retry only fast 429/502/503 rejections; never retry timeouts or
  // network drops after submission.
  const res = await upstreamFetch(`${API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key()}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
    timeoutMs,
    maxAttempts: 2,
    retryStatuses: [429, 502, 503],
    retryOnTimeout: false,
    retryOnNetworkError: false,
    maxRetryElapsedMs: 5_000,
    baseDelayMs: 300,
    maxDelayMs: 1_500,
  });
  if (!res.ok) {
    console.error("Telem request failed", path, res.status);
    throw new Error(res.status === 429 ? "Web search is busy" : "Web search failed");
  }
  return (await res.json()) as {
    preprocessor_runs?: {
      status?: string;
      output_payload?: { results?: unknown[]; fetched_results?: unknown[] } | null;
    }[];
  };
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const httpUrl = (v: unknown): string | undefined => {
  const s = str(v);
  if (!s) return undefined;
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
};

/** Web results for one query, merged across providers, duplicates removed, best first. */
export async function webSearch(query: string): Promise<WebResult[]> {
  const q = query.trim().slice(0, 300);
  if (!q) return [];
  const d = await post(
    "/search",
    {
      user_input: { query: q },
      search: { providers: { include: SEARCH_PROVIDERS }, num_results: MAX_RESULTS },
    },
    SEARCH_TIMEOUT_MS,
  );
  const seen = new Set<string>();
  const ranked: (WebResult & { rank: number })[] = [];
  for (const run of d.preprocessor_runs ?? []) {
    if (run.status !== "succeeded") continue;
    for (const raw of run.output_payload?.results ?? []) {
      const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
      const url = httpUrl(r["url"]);
      if (!url) continue;
      const k = url.replace(/[#?].*$/, "").replace(/\/$/, "");
      if (seen.has(k)) continue;
      seen.add(k);
      ranked.push({
        title: str(r["title"]) ?? url,
        url,
        summary: str(r["summary"])?.slice(0, 400),
        rank: typeof r["rank"] === "number" ? r["rank"] : 99,
      });
    }
  }
  return ranked
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 8)
    .map(({ rank: _rank, ...r }) => r);
}

/** The text of up to three web pages (markdown, first 6,000 characters each). */
export async function webFetch(urls: string[]): Promise<WebPage[]> {
  const list = [...new Set(urls.map(httpUrl).filter((u): u is string => Boolean(u)))].slice(
    0,
    MAX_URLS,
  );
  if (!list.length) return [];
  const d = await post(
    "/fetch",
    { urls: list, options: { content_format: "markdown", inline_max_chars: MAX_CHARS } },
    FETCH_TIMEOUT_MS,
  );
  const pages: WebPage[] = [];
  for (const run of d.preprocessor_runs ?? []) {
    for (const raw of run.output_payload?.fetched_results ?? []) {
      const f = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
      const url = httpUrl(f["url"]) ?? "";
      const ok = f["status"] === "succeeded" && typeof f["content"] === "string";
      pages.push(
        ok
          ? {
              url,
              ok,
              title: str(f["title"]),
              content: String(f["content"]).slice(0, MAX_CHARS),
              truncated: f["content_truncated"] === true,
            }
          : { url, ok: false },
      );
    }
  }
  // A URL whose run failed outright still gets an answer, so the agent knows to try another.
  for (const u of list) if (!pages.some((p) => p.url === u)) pages.push({ url: u, ok: false });
  return pages;
}
