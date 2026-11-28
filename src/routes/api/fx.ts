import { createFileRoute } from "@tanstack/react-router";
import { marketFor } from "@/lib/market";

/** The collector's market for showing prices: currency, symbol, eBay site and today's US$ rate. */
export const Route = createFileRoute("/api/fx")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const m = marketFor(new URL(request.url).searchParams.get("country"));
        const { resolveMarketFx } = await import("@/lib/fx.server");
        const resolved = await resolveMarketFx(m);
        if (resolved.fallbackToUsd) {
          return Response.json(
            { ...resolved.market, rate: 1, fx_fallback: true },
            { headers: { "Cache-Control": "no-store" } },
          );
        }
        return Response.json(
          {
            ...resolved.market,
            rate: resolved.rate,
            ...(resolved.stale ? { stale: true } : {}),
          },
          {
            headers: {
              "Cache-Control": resolved.stale ? "public, max-age=300" : "public, max-age=3600",
            },
          },
        );
      },
    },
  },
});
