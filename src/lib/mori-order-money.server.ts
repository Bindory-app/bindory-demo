import { resolveMarketFx } from "./fx.server";
import { MARKETS } from "./market";
import type { OrderIntent } from "./mori-validation";

export function orderUsd(amount: number, rate: number): number | null {
  const usd = Math.round(Math.round(amount * 100) / rate) / 100;
  return Number.isFinite(usd) && usd > 0 && usd <= 1_000_000 ? usd : null;
}

export const NEED_USD =
  "Prices are temporarily shown in US$. What US$ price would you like for this order?";
export async function quoteOrder(
  price: OrderIntent["price"],
): Promise<
  { error: string } | { price: OrderIntent["price"]; fx_rate: number; price_usd: number }
> {
  // Use the currency of the amount, not the collector's country (e.g. US$ in Australia).
  const market = Object.values(MARKETS).find((m) => m.currency === price.currency)!;
  const { rate, fallbackToUsd } = await resolveMarketFx(market);
  if (fallbackToUsd) return { error: NEED_USD };
  const usd = orderUsd(price.amount, rate);
  return usd === null
    ? {
        error: "The order price must be between US$0.01 and US$1,000,000 after conversion.",
      }
    : { price, fx_rate: rate, price_usd: usd };
}
