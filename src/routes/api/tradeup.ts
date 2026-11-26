import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

/** Trade-up games for the chat (bearer-authenticated): create, join, state, cards, lock, reveal, cancel. */
export const Route = createFileRoute("/api/tradeup")({
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
        const auth = createClient<Database>(url, key, {
          auth: { persistSession: false, autoRefreshToken: false },
        });
        const { data: who, error } = await auth.auth.getUser(token.slice(7));
        if (error || !who.user) return new Response("Unauthorized", { status: 401 });
        const userId = who.user.id;
        const b = ((await request.json().catch(() => null)) ?? {}) as Record<string, unknown>;
        const id = typeof b["id"] === "string" && /^[0-9a-f-]{36}$/i.test(b["id"]) ? b["id"] : "";
        const T = await import("@/lib/tradeup.server");
        try {
          switch (b["action"]) {
            case "create":
              return Response.json(await T.createGame(userId));
            case "join":
              return Response.json(await T.joinGame(userId, String(b["code"] ?? "").trim()));
            case "state":
              return Response.json(await T.gameState(userId, id));
            case "cards": {
              const ids = Array.isArray(b["card_ids"])
                ? b["card_ids"].filter(
                    (x): x is string => typeof x === "string" && /^[0-9a-f-]{36}$/i.test(x),
                  )
                : [];
              return Response.json(
                await T.setCards(
                  userId,
                  id,
                  ids,
                  typeof b["option"] === "string" ? b["option"] : undefined,
                ),
              );
            }
            case "lock":
              return Response.json(
                await T.lockIn(userId, id, String(b["commit"] ?? ""), b["adult"] === true),
              );
            case "reveal":
              return Response.json(await T.reveal(userId, id, String(b["secret"] ?? "")));
            case "cancel":
              return Response.json(await T.cancelGame(userId, id));
            default:
              return new Response("Unknown action", { status: 400 });
          }
        } catch (e) {
          if (e instanceof T.TradeupError)
            return Response.json({ error: e.message }, { status: 400 });
          console.error("Trade-up failed", e instanceof Error ? e.message : JSON.stringify(e));
          return Response.json(
            { error: "Something went wrong. Please try again." },
            { status: 500 },
          );
        }
      },
    },
  },
});
