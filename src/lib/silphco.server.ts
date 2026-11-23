/**
 * Recent eBay sold prices (raw near mint, PSA 9, PSA 10) from SilphCo Analytics
 * (https://silphcoanalytics.xyz/api/v3), server-only. Each value is SilphCo's median of the last
 * three clean sales; only the eBay venue is read, because SilphCo's pooled prices also include
 * tokenised-card and NFT marketplaces. The key (SILPHCO_API_KEY) never reaches the browser.
 * Results are cached per card for six hours to stay inside the plan's monthly lookups.
 */
const API = "https://silphcoanalytics.xyz/api/v3";
const TTL_MS = 6 * 60 * 60 * 1000;

export type SoldPoint = {
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

const GRADES = [
  ["raw", undefined],
  ["psa9", "PSA:9"],
  ["psa10", "PSA:10"],
] as const;
const cache = new Map<string, { at: number; value: EbaySold | null }>();

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

/** eBay sold prices for one TCGdex card id, or null when not configured or unavailable. */
export async function ebaySoldPrices(cardId: string, now = Date.now()): Promise<EbaySold | null> {
  const key = process.env["SILPHCO_API_KEY"]?.trim();
  if (!key || !cardId.trim()) return null;
  const hit = cache.get(cardId);
  if (hit && now - hit.at < TTL_MS) return hit.value;
  let value: EbaySold | null = null;
  try {
    const res = await fetch(`${API}/price/batch`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        items: GRADES.map(([, grade]) =>
          grade ? { tcg_card_id: cardId, grade_key: grade } : { tcg_card_id: cardId },
        ),
        marketplace: "ebay",
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const body = (await res.json()) as { data?: { results?: unknown[] } };
      const results = body.data?.results ?? [];
      const pick = (i: number) => {
        const r = (results[i] && typeof results[i] === "object" ? results[i] : {}) as Record<
          string,
          unknown
        >;
        return point(r["price"] ?? r);
      };
      const out = { raw: pick(0), psa9: pick(1), psa10: pick(2) };
      if ([out.raw, out.psa9, out.psa10].some((p) => p.value_usd !== null || p.last_sale_usd))
        value = {
          ...out,
          source: "eBay sold prices via SilphCo Analytics (median of the last 3 sales)",
        };
    } else {
      console.error("SilphCo price lookup failed", res.status);
    }
  } catch (e) {
    console.error("SilphCo price lookup failed", e instanceof Error ? e.message : "Unknown error");
    return null; // not cached, so a passing network error does not stick for six hours
  }
  cache.set(cardId, { at: now, value });
  return value;
}
