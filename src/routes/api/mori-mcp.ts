import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { agentMayUse, isMoriAgent } from "@/lib/mori-agents";

/**
 * Mori's tools as an MCP server (Streamable HTTP, stateless, JSON answers) for the HarnessRouter
 * "Ask Mori" harness. Only that harness can call it (bearer derived from MORI_MCP_SECRET), and each
 * call acts as the collector whose sealed session HarnessRouter relays in X-Mori-User, so every
 * query runs under that collector's own Row Level Security. Writing tools only build confirmation
 * cards; nothing is saved until the collector taps Confirm in the app.
 */
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

type RpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
const ok = (id: RpcRequest["id"], result: unknown) => ({ jsonrpc: "2.0", id: id ?? null, result });
const fail = (id: RpcRequest["id"], code: number, message: string) => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: { code, message },
});

async function handle(req: RpcRequest, request: Request): Promise<object | null> {
  const { method, id } = req;
  // Notifications (no id) get no answer.
  if (id === undefined || id === null) return null;
  if (method === "initialize") {
    const asked = (req.params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
    return ok(id, {
      protocolVersion:
        typeof asked === "string" && PROTOCOL_VERSIONS.includes(asked)
          ? asked
          : PROTOCOL_VERSIONS[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "bindory-mori", version: "1.0.0" },
    });
  }
  if (method === "ping") return ok(id, {});
  // Each harness's MCP URL names its agent (?agent=price ...); it only sees and calls its own tools.
  const agent = new URL(request.url).searchParams.get("agent") ?? "ask";
  if (!isMoriAgent(agent)) return fail(id, -32602, "Unknown agent");
  const tools = (await import("@/lib/mori-prompt.server")).tools.filter((t) =>
    agentMayUse(agent, t.name),
  );
  if (method === "tools/list")
    return ok(id, {
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.parameters ?? { type: "object", properties: {} },
      })),
    });
  if (method !== "tools/call") return fail(id, -32601, "Method not found");

  const params = (req.params ?? {}) as { name?: unknown; arguments?: unknown };
  const name = typeof params.name === "string" ? params.name : "";
  if (!tools.some((t) => t.name === name)) return fail(id, -32602, "Unknown tool");
  const args =
    params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
      ? (params.arguments as Record<string, unknown>)
      : {};

  const { openCollector, signRows } = await import("@/lib/mori-mcp-auth.server");
  const who = openCollector(request.headers.get("x-mori-user"));
  if (!who)
    return ok(id, {
      isError: true,
      content: [
        {
          type: "text",
          text: "The collector's session has expired. Ask them to send the message again.",
        },
      ],
    });
  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_PUBLISHABLE_KEY"];
  if (!url || !key) return fail(id, -32603, "Tools are unavailable");
  const db = createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${who.accessToken}` } },
  });
  // The collector's latest message (saved before the task started): memory templates keep their words.
  const last = await db
    .from("mori_messages")
    .select("content")
    .eq("role", "user")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const { executeMoriTool } = await import("@/lib/mori-agent.server");
  try {
    const out = await executeMoriTool(db, who.userId, name, args, {
      message: last.data?.content ?? "",
      seenIds: null,
      lastCard: "",
    });
    let text = JSON.stringify(out.result ?? null).slice(0, 8000);
    if (out.rows.length) text += `\n${signRows(who.userId, out.rows)}`;
    const failed = Boolean(
      out.result && typeof out.result === "object" && "error" in (out.result as object),
    );
    return ok(id, { content: [{ type: "text", text }], isError: failed });
  } catch (e) {
    console.error("Mori MCP tool failed", name, e instanceof Error ? e.message : "Unknown error");
    return ok(id, {
      isError: true,
      content: [{ type: "text", text: "The tool failed. Try again." }],
    });
  }
}

export const Route = createFileRoute("/api/mori-mcp")({
  server: {
    handlers: {
      GET: () => new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } }),
      DELETE: () => new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } }),
      POST: async ({ request }) => {
        const { isHarnessBearer } = await import("@/lib/mori-mcp-auth.server");
        let allowed = false;
        try {
          allowed = isHarnessBearer(request.headers.get("authorization"));
        } catch {
          return new Response("Tools are unavailable", { status: 503 });
        }
        if (!allowed) return new Response("Unauthorized", { status: 401 });
        const body: unknown = await request.json().catch(() => undefined);
        if (body === undefined) return json(fail(null, -32700, "Parse error"), 400);
        const list = Array.isArray(body) ? body : [body];
        if (!list.length || list.length > 20)
          return json(fail(null, -32600, "Invalid request"), 400);
        const answers = (
          await Promise.all(
            list.map((r) =>
              r && typeof r === "object"
                ? handle(r as RpcRequest, request)
                : Promise.resolve(fail(null, -32600, "Invalid request")),
            ),
          )
        ).filter((a): a is object => a !== null);
        if (!answers.length) return new Response(null, { status: 202 });
        return json(Array.isArray(body) ? answers : answers[0]);
      },
    },
  },
});
