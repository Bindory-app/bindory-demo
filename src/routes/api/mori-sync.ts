import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

/**
 * Collectr sync tasks for the wireframe front end (bearer-authenticated, RLS applies):
 * { id, action: "status" } progress or the result, { id, action: "apply" } adds the approved
 * cards, { id, action: "file", n } one of the agent's files. The browser never sees task ids,
 * the harness or download links.
 */
export const Route = createFileRoute("/api/mori-sync")({
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
          global: { headers: { Authorization: token } },
        });
        const { data: auth, error } = await db.auth.getUser(token.slice(7));
        if (error || !auth.user) return new Response("Unauthorized", { status: 401 });
        const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
        const id = typeof body?.["id"] === "string" ? body["id"] : "";
        const action = body?.["action"];
        if (!/^[0-9a-f-]{36}$/i.test(id) || !["status", "apply", "file"].includes(String(action)))
          return new Response("Invalid request", { status: 400 });
        try {
          const sync = await import("@/lib/collectr-sync.server");
          if (action === "status") {
            const s = await sync.syncStatus(db, auth.user.id, id);
            return s ? Response.json(s) : new Response("Not found", { status: 404 });
          }
          if (action === "apply") {
            const a = await sync.applySync(db, auth.user.id, id);
            return a ? Response.json(a) : new Response("Not ready", { status: 409 });
          }
          const n = Number(body?.["n"]);
          if (!Number.isInteger(n) || n < 0 || n > 50)
            return new Response("Invalid file", { status: 400 });
          const f = await sync.syncFile(db, auth.user.id, id, n);
          if (!f) return new Response("Not found", { status: 404 });
          return new Response(f.res.body, {
            headers: {
              "Content-Type": "application/octet-stream",
              "Content-Disposition": `attachment; filename="${f.filename.replace(/[^\w.\- ]/g, "_")}"`,
              "Cache-Control": "no-store",
              "X-Content-Type-Options": "nosniff",
            },
          });
        } catch (e) {
          console.error("Collectr sync request failed", e instanceof Error ? e.message : e);
          return new Response("Sync is unavailable", { status: 502 });
        }
      },
    },
  },
});
