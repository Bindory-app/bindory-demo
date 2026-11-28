import type { Json } from "@/integrations/supabase/types";
import type { Market } from "./market";
import type { MoriRowDraft } from "./mori-context.server";
import { ebaySoldPrices } from "./silphco.server";
import { cardImage, getCardPricing, priceScale, usdRange } from "./tcgdex";

/** A card's prices for the collector's market: today's market points converted into their currency,
 *  and recent sold prices from their own eBay site (Apify), else pooled eBay sales converted. */
export async function marketPrices(
  card: { id: string; name: string; number: string },
  pricing: Parameters<typeof priceScale>[0],
  market: Market,
  /** Sales the agent read with the Apify actor itself (used instead of the server's lookup). */
  agentSales?: unknown[],
  /** The raw card's condition; sold prices are for this condition only. */
  condition: import("./ebay-sold.server").Condition = "nm",
) {
  const [
    { resolveMarketFx },
    { localSoldPrices, summarise, CONDITIONS },
    { browseCandidates, pickBrowseLowest },
  ] = await Promise.all([
    import("./fx.server"),
    import("./ebay-sold.server"),
    import("./ebay-browse.server"),
  ]);
  const scale = priceScale(pricing);
  const sales = (agentSales ?? []).filter(
    (
      x,
    ): x is {
      title?: string;
      soldPrice?: string | number;
      soldCurrency?: string;
      endedAt?: string;
    } => Boolean(x) && typeof x === "object",
  );
  // Without item locations the sales can't be limited to the collector's country, so the server
  // looks them up itself instead.
  const located = sales.some((x) => "itemLocation" in x);

  // Run independent work in parallel: FX and local sold listings start immediately (local sold
  // queries the collector's eBay site in its native currency and does not need FX). Browse starts
  // as soon as FX resolves using only the market-price floor so it runs alongside sold listings;
  // the sold-based floor is applied afterwards to the returned candidates.
  const fxPromise = resolveMarketFx(market);
  const localPromise =
    sales.length && located
      ? Promise.resolve(summarise(sales.slice(0, 60), card.number, market, condition))
      : localSoldPrices(card, market, condition);
  const browsePromise = fxPromise.then(({ market: effMarket, rate: fxRate }) => {
    const marketFloor =
      typeof scale?.market === "number"
        ? (Math.round(scale.market * fxRate * 100) / 100) * 0.4
        : undefined;
    return browseCandidates(card, effMarket, condition, marketFloor || undefined).catch(() => ({
      status: "error" as const,
      data: null,
    }));
  });

  const [fx, rawLocal] = await Promise.all([fxPromise, localPromise]);
  const effMarket = fx.market;
  const rate = fx.rate;
  const x = (v: number | null | undefined) =>
    typeof v === "number" ? Math.round(v * rate * 100) / 100 : null;

  // On a cold FX failure that fell back to US$, never mix foreign local sold prices into a US$
  // response.
  const local = rawLocal && rawLocal.currency === effMarket.currency ? rawLocal : null;
  const hasLocalSales = Boolean(
    local && (local.raw.n > 0 || local.psa9.n > 0 || local.psa10.n > 0),
  );
  // Fall back to pooled SilphCo near-mint sold prices when local sold data failed, is
  // unconfigured, or returned zero sales (empty). Never shown for non-near-mint conditions.
  const pooledPromise =
    hasLocalSales || condition !== "nm" ? Promise.resolve(null) : ebaySoldPrices(card.id);

  const [pooled, initialBrowse] = await Promise.all([pooledPromise, browsePromise]);
  const label = CONDITIONS[condition].label;
  // Today's lowest listings (worldwide and in their country) from eBay's Browse API, applying a
  // floor at half the recent sold average when present (else 40% of the converted market price) so
  // skins, cases and fan art drop out.
  const ref = local?.raw.avg_last_3 ? local.raw.avg_last_3 * 0.5 : (x(scale?.market) ?? 0) * 0.4;
  // Only if the sold-based floor is strictly lower than the market-based floor queried upstream do
  // we refetch at the lower floor so valid cheaper listings aren't missed.
  const browseResult =
    initialBrowse.data && ref > 0 && initialBrowse.data.queryFloor > Math.floor(ref)
      ? await browseCandidates(card, effMarket, condition, ref).catch(() => initialBrowse)
      : initialBrowse;
  const lowest =
    browseResult.data && (browseResult.status === "ok" || browseResult.status === "empty")
      ? pickBrowseLowest(browseResult.data, card, effMarket, condition, ref || undefined)
      : null;
  // Without listings (no keys yet, or eBay unavailable) the card still shows its new layout, with
  // "–" in place of the listing prices.
  const listings = {
    lowest_worldwide: lowest?.lowest_worldwide ?? null,
    lowest_local: lowest?.lowest_local ?? null,
    read: Boolean(lowest),
  };
  const soldOut = (v: {
    value: number | null;
    status: string;
    n?: number;
    avg_last_3?: number | null;
    avg_last_5?: number | null;
  }) => ({
    avg_last_3: v.avg_last_3 ?? null,
    avg_last_5: v.avg_last_5 ?? v.value,
    sales: v.n ?? null,
    status: v.status,
  });
  return {
    rate,
    scale,
    local,
    pooled,
    listings,
    forTool: {
      currency: effMarket.currency,
      ebay_site: effMarket.ebay,
      listings: {
        condition: label,
        lowest_worldwide: listings.lowest_worldwide,
        lowest_in_country: listings.lowest_local,
        listings_read: listings.read,
      },
      price_points: scale
        ? { lowest_listing: x(scale.low), market: x(scale.market), mid: x(scale.mid) }
        : null,
      recent_sold: hasLocalSales
        ? { from: effMarket.ebay, condition: label, raw: soldOut(local!.raw) }
        : pooled
          ? { condition: label, raw: { value: x(pooled.raw.value_usd), status: pooled.raw.status } }
          : local
            ? { from: effMarket.ebay, condition: label, raw: soldOut(local.raw) }
            : null,
    },
  };
}

/** 7-day vs 30-day average price change for these cards, biggest rise first. A few lookups at a
 *  time, retrying once, so a busy moment at TCGdex does not lose them all. */
export async function priceMoves(ids: string[]) {
  const lookup = (id: string) =>
    getCardPricing(id).catch(() =>
      new Promise((r) => setTimeout(r, 400)).then(() => getCardPricing(id).catch(() => null)),
    );
  const priced: Awaited<ReturnType<typeof lookup>>[] = [];
  for (let i = 0; i < ids.length; i += 6)
    priced.push(...(await Promise.all(ids.slice(i, i + 6).map(lookup))));
  const rows = await Promise.all(
    priced.map(async (r) => {
      const cm = r?.pricing?.cardmarket as { avg7?: number; avg30?: number } | undefined;
      if (!r || !cm?.avg7 || !cm.avg30) return null;
      const range = usdRange(r.pricing);
      return {
        card: `${r.card.name} ${r.card.localId}`,
        set: r.card.set.name,
        change_pct: Math.round(((cm.avg7 - cm.avg30) / cm.avg30) * 1000) / 10,
        todays_price_range_usd: range ? `US$${range.low} to US$${range.high}` : undefined,
      };
    }),
  );
  const moves = rows.filter((x): x is NonNullable<typeof x> => x !== null);
  moves.sort((x, y) => y.change_pct - x.change_pct);
  return moves;
}

/** A chat card with delivered listings and recent raw sales in the collector's currency. */
export async function priceCardRow(
  cardId: string,
  market: Market,
  fromTool?: Record<string, unknown> | null,
  condition: import("./ebay-sold.server").Condition = "nm",
): Promise<MoriRowDraft | null> {
  const r = await getCardPricing(cardId);
  if (!r) return null;
  // Reuse the prices the agent just fetched for this market; look them up only if missing.
  const tool =
    fromTool && fromTool["currency"] === market.currency
      ? (fromTool as {
          price_points?: Record<string, number | null> | null;
          recent_sold?: Record<string, unknown> | null;
          listings?: Record<string, unknown> | null;
        })
      : (
          await marketPrices(
            { id: r.card.id, name: r.card.name, number: r.card.localId },
            r.pricing,
            market,
            undefined,
            condition,
          )
        ).forTool;
  const pts = tool.price_points ?? null;
  const soldAll = (tool.recent_sold ?? null) as Record<string, unknown> | null;
  const sold = soldAll as Record<
    string,
    {
      avg_last_3?: number | null;
      avg_last_5?: number | null;
      value?: number | null;
      sales?: number | null;
      status: string;
    }
  > | null;
  const lst = (tool.listings ?? null) as {
    lowest_worldwide?: { price: number; shipping: number | null; total?: number } | null;
    lowest_in_country?: { price: number; shipping: number | null; total?: number } | null;
    change_7d_pct?: number | null;
    listings_read?: boolean;
  } | null;
  if (!pts && !sold && !lst) return null;
  // Prefer the average of the last 3 sales, then the pooled fallback. Without a sold price, use
  // the lowest local listing, then worldwide, then the converted market price.
  const headline =
    sold?.["raw"]?.avg_last_3 ??
    sold?.["raw"]?.value ??
    lst?.lowest_in_country?.total ??
    lst?.lowest_worldwide?.total ??
    pts?.["market"] ??
    undefined;
  return {
    role: "mori",
    kind: "price",
    content: `Price check: ${r.card.name} ${r.card.localId}${typeof headline === "number" ? `, ${market.symbol}${Math.round(headline)}` : ""}`,
    payload: {
      card: {
        id: r.card.id,
        name: r.card.name,
        number: r.card.localId,
        set: r.card.set.name,
        rarity: r.card.rarity,
        image: cardImage(r.card.image, "low"),
      },
      // Everything here is already in the collector's currency.
      market: {
        currency: market.currency,
        symbol: market.symbol,
        ebay: market.ebay,
        country: market.name.replace(/^the\s+/i, ""),
      },
      ...(typeof headline === "number" ? { headline } : {}),
      ...(lst
        ? {
            listings: {
              world: lst.lowest_worldwide ?? null,
              local: lst.lowest_in_country ?? null,
              change7: lst.change_7d_pct ?? null,
              read: lst.listings_read ?? false,
            },
          }
        : pts
          ? { scale: { low: pts["lowest_listing"], market: pts["market"], mid: pts["mid"] } }
          : {}),
      ...(sold
        ? {
            sold: {
              raw: sold["raw"],
              condition: typeof soldAll?.["condition"] === "string" ? soldAll["condition"] : null,
            },
          }
        : {}),
    } as Json,
  };
}
