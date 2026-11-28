import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { Cache } from "@/lib/cache.server";
import { upstreamFetchJson } from "@/lib/upstream-fetch";

/**
 * Turns the collector's phone location into a place name ("Sydney, New South Wales, Australia")
 * for questions like "card shows near me". Coordinates arrive rounded to about 1 km, are only
 * used for this lookup and are never stored; the browser keeps just the place name.
 */
const LOCATE_TIMEOUT_MS = 6_000;
const LOCATE_TTL_MS = 24 * 60 * 60 * 1000;
const LOCATE_EMPTY_TTL_MS = 10 * 60 * 1000;

let placeCache: Cache<string | null> | null = null;
async function getPlaceCache(): Promise<Cache<string | null>> {
  if (!placeCache) {
    const { createCache } = await import("@/lib/cache.server");
    // Memory-only (`shared: false`) so rounded coordinates are never persisted to the database.
    placeCache = createCache<string | null>({
      namespace: "mori-locate",
      ttlMs: LOCATE_TTL_MS,
      emptyTtlMs: LOCATE_EMPTY_TTL_MS,
      shared: false,
      maxEntries: 500,
    });
  }
  return placeCache;
}

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
        const cache = await getPlaceCache();
        const result = await cache.getOrLoad(k, async () => {
          try {
            const res = await upstreamFetchJson<{ address?: Record<string, string> }>(
              `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&accept-language=en&lat=${lat.toFixed(2)}&lon=${lon.toFixed(2)}`,
              {
                headers: { "User-Agent": "MoriLocation/1.0" },
                timeoutMs: LOCATE_TIMEOUT_MS,
                maxAttempts: 2,
                baseDelayMs: 1_000,
                maxDelayMs: 3_000,
                signal: request.signal,
              },
            );
            if (!res.ok || !res.data) return { kind: "error" };
            const a = res.data.address ?? {};
            const city = a["city"] ?? a["town"] ?? a["village"] ?? a["suburb"] ?? a["county"];
            const place = [city, a["state"], a["country"]].filter(Boolean).join(", ");
            return place ? { kind: "hit", value: place } : { kind: "empty", value: null };
          } catch {
            return { kind: "error" };
          }
        });
        if (!result.ok) return new Response("Location lookup unavailable", { status: 503 });
        if (!result.value) return new Response("Place not found", { status: 404 });
        return Response.json({ place: result.value });
      },
    },
  },
});
