/**
 * Recent eBay sold prices (raw near mint, PSA 9, PSA 10) from SilphCo Analytics
 * (https://silphcoanalytics.xyz/api/v3), server-only. Each value is SilphCo's median of the last
 * three clean sales; only the eBay venue is read, because SilphCo's pooled prices also include
 * tokenised-card and NFT marketplaces. The key (SILPHCO_API_KEY) never reaches the browser.
 * Results are cached per card for six hours to stay inside the plan's monthly lookups; genuine
 * empty responses are cached briefly, and errors are never cached.
 */
import { createCache, type SharedStore } from "./cache.server";
import { upstreamFetch } from "./upstream-fetch";

const API = "https://silphcoanalytics.xyz/api/v3";
const TTL_MS = 6 * 60 * 60 * 1000;
const EMPTY_TTL_MS = 15 * 60 * 1000;
const TIMEOUT_MS = 8_000;

type SoldPoint = {
  value_usd: number | null;
  /** SilphCo status: ok, thin (few sales), stale, suspect or none. */
  status: string;
  n_sales: number;
  newest_sale_at?: string | undefined;
  /** Only when a single sale exists: that sale's price, never a market price. */
  last_sale_usd?: number | undefined;
};
export type EbaySold = {
  raw: SoldPoint;
  psa9: SoldPoint;
  psa10: SoldPoint;
  source: string;
};

export type SilphcoLookup =
  | { status: "ok"; data: EbaySold }
  | { status: "empty"; data: null }
  | { status: "error"; data: null }
  | { status: "unconfigured"; data: null };

const GRADES = [
  ["raw", undefined],
  ["psa9", "PSA:9"],
  ["psa10", "PSA:10"],
] as const;

function makeSilphcoCache(store?: SharedStore | null) {
  return createCache<EbaySold | null>({
    namespace: "silphco",
    ttlMs: TTL_MS,
    emptyTtlMs: EMPTY_TTL_MS,
    ...(store !== undefined ? { store } : {}),
  });
}

let silphcoCache = makeSilphcoCache();

/** Resets the SilphCo cache (and optionally installs a custom shared store for tests). */
export function resetSilphcoCacheForTest(store?: SharedStore | null): void {
  silphcoCache = makeSilphcoCache(store);
}

function point(v: unknown): SoldPoint {
  const p = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const last = (
    p["last_sale"] && typeof p["last_sale"] === "object" ? p["last_sale"] : {}
  ) as Record<string, unknown>;
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : undefined);
  return {
    value_usd: num(p["value_usd"]) ?? null,
    status: typeof p["status"] === "string" ? p["status"] : "none",
    n_sales: num(p["n_sales"]) ?? 0,
    newest_sale_at: typeof p["newest_sale_at"] === "string" ? p["newest_sale_at"] : undefined,
    last_sale_usd: num(last["value_usd"]) ?? num(last["price_usd"]),
  };
}

/** SilphCo lookup distinguishing unconfigured, error (uncached), empty (briefly cached), and ok. */
export async function ebaySoldPricesLookup(
  cardId: string,
  now = Date.now(),
): Promise<SilphcoLookup> {
  const key = process.env["SILPHCO_API_KEY"]?.trim();
  const id = cardId.trim();
  if (!key || !id) return { status: "unconfigured", data: null };
  const res = await silphcoCache.getOrLoad(
    id,
    async () => {
      try {
        const r = await upstreamFetch(`${API}/price/batch`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            items: GRADES.map(([, grade]) =>
              grade ? { tcg_card_id: id, grade_key: grade } : { tcg_card_id: id },
            ),
            marketplace: "ebay",
          }),
          timeoutMs: TIMEOUT_MS,
          maxAttempts: 2,
          retryOnTimeout: false,
          baseDelayMs: 250,
          maxDelayMs: 1_500,
        });
        if (!r.ok) {
          console.error("SilphCo price lookup failed", r.status);
          return { kind: "error" };
        }
        const body = (await r.json().catch(() => null)) as {
          data?: { results?: unknown[] };
        } | null;
        if (!body || !Array.isArray(body.data?.results)) return { kind: "error" };
        const results = body.data.results;
        const pick = (i: number) => {
          const item = (results[i] && typeof results[i] === "object" ? results[i] : {}) as Record<
            string,
            unknown
          >;
          return point(item["price"] ?? item);
        };
        const out = { raw: pick(0), psa9: pick(1), psa10: pick(2) };
        if ([out.raw, out.psa9, out.psa10].some((p) => p.value_usd !== null || p.last_sale_usd)) {
          return {
            kind: "hit",
            value: {
              ...out,
              source: "eBay sold prices via SilphCo Analytics (median of the last 3 sales)",
            },
          };
        }
        return { kind: "empty", value: null };
      } catch (e) {
        console.error(
          "SilphCo price lookup failed",
          e instanceof Error ? e.message : "Unknown error",
        );
        return { kind: "error" };
      }
    },
    { now },
  );
  if (!res.ok) return { status: "error", data: null };
  if (res.empty || !res.value) return { status: "empty", data: null };
  return { status: "ok", data: res.value };
}

/** eBay sold prices for one TCGdex card id, or null when not configured, empty, or unavailable. */
export async function ebaySoldPrices(cardId: string, now = Date.now()): Promise<EbaySold | null> {
  const r = await ebaySoldPricesLookup(cardId, now);
  return r.status === "ok" ? r.data : null;
}
