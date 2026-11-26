import { createFileRoute } from "@tanstack/react-router";
import { marketFor } from "@/lib/market";

/** The collector's market for showing prices: currency, symbol, eBay site and today's US$ rate. */
export const Route = createFileRoute("/api/fx")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const m = marketFor(new URL(request.url).searchParams.get("country"));
        const { usdTo } = await import("@/lib/fx.server");
        const rate = m.currency === "USD" ? 1 : await usdTo(m.currency);
        return Response.json(
          { ...m, rate },
          { headers: { "Cache-Control": "public, max-age=3600" } },
        );
      },
    },
  },
});
