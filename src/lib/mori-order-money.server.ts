import { resolveMarketFx } from "./fx.server";
import { MARKETS } from "./market";
import type { OrderIntent } from "./mori-validation";

export function orderUsd(amount: number, rate: number): number | null {
  const usd = Math.round((amount / rate) * 100) / 100;
  return Number.isFinite(usd) && usd > 0 && usd <= 1_000_000 ? usd : null;
}

export async function quoteOrder(price: OrderIntent["price"]) {
  // Use the currency of the amount, not the collector's country (e.g. US$ in Australia).
  const market = Object.values(MARKETS).find((m) => m.currency === price.currency)!;
  const { rate, fallbackToUsd } = await resolveMarketFx(market);
  if (fallbackToUsd)
    return {
      error: "Prices are temporarily shown in US$. What US$ price would you like for this order?",
    } as const;
  const usd = orderUsd(price.amount, rate);
  return usd === null
    ? ({
        error: "The order price must be between US$0.01 and US$1,000,000 after conversion.",
      } as const)
    : { price, fx_rate: rate, price_usd: usd };
}
