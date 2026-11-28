import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
export const Route = createFileRoute("/api/whatsapp-link")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (request.headers.get("origin") !== new URL(request.url).origin)
          return new Response(null, { status: 403 });
        const token = request.headers.get("authorization"),
          url = process.env["SUPABASE_URL"],
          key = process.env["SUPABASE_PUBLISHABLE_KEY"];
        if (!token?.startsWith("Bearer ")) return new Response(null, { status: 401 });
        if (!url || !key) return new Response(null, { status: 503 });
        try {
          const db = createClient(url, key, {
            auth: { persistSession: false, autoRefreshToken: false },
            global: { headers: { Authorization: token } },
          });
          const { data, error } = await db.auth.getUser(token.slice(7));
          if (error || !data.user) return new Response(null, { status: 401 });
          const body = await request.json();
          const { startLink } = await import("@/lib/whatsapp-state.server");
          return Response.json(
            { url: await startLink(data.user.id, body?.country) },
            { headers: { "Cache-Control": "private, no-store" } },
          );
        } catch {
          return new Response(null, { status: 503 });
        }
      },
    },
  },
});
