import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

/**
 * Turns the collector's phone location into a place name ("Sydney, New South Wales, Australia")
 * for questions like "card shows near me". Coordinates arrive rounded to about 1 km, are only
 * used for this lookup and are never stored; the browser keeps just the place name.
 */
const cache = new Map<string, string>();

export const Route = createFileRoute("/api/mori-locate")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const origin = request.headers.get("origin");
        if (origin && origin !== new URL(request.url).origin)
          return new Response("Forbidden", { status: 403 });
        const token = request.headers.get("authorization");
        if (!token?.startsWith("Bearer ")) return new Response("Unauthorized", { status: 401 });
        const url = process.env["SUPABASE_URL"];
        const key = process.env["SUPABASE_PUBLISHABLE_KEY"];
        if (!url || !key) return new Response("Unavailable", { status: 503 });
        const db = createClient<Database>(url, key, {
          auth: { persistSession: false, autoRefreshToken: false },
        });
        const { data: auth, error } = await db.auth.getUser(token.slice(7));
        if (error || !auth.user) return new Response("Unauthorized", { status: 401 });
        const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
        const lat = Number(body?.["lat"]);
        const lon = Number(body?.["lon"]);
        if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180))
          return new Response("Invalid location", { status: 400 });
        const k = `${lat.toFixed(2)},${lon.toFixed(2)}`;
        let place = cache.get(k);
        if (!place) {
          const res = await fetch(
            `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&accept-language=en&lat=${lat.toFixed(2)}&lon=${lon.toFixed(2)}`,
            { headers: { "User-Agent": "MoriLocation/1.0" } },
          ).catch(() => null);
          const j = res?.ok
            ? ((await res.json().catch(() => null)) as { address?: Record<string, string> } | null)
            : null;
          const a = j?.address ?? {};
          const city = a["city"] ?? a["town"] ?? a["village"] ?? a["suburb"] ?? a["county"];
          place = [city, a["state"], a["country"]].filter(Boolean).join(", ");
          if (!place) return new Response("Place not found", { status: 404 });
          if (cache.size > 500) cache.clear();
          cache.set(k, place);
        }
        return Response.json({ place });
      },
    },
  },
});
