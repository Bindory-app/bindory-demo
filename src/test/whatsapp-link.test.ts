import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Route } from "@/routes/api/whatsapp-link";
const f = vi.hoisted(() => ({ user: vi.fn(), start: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ auth: { getUser: f.user } }) }));
vi.mock("@/lib/whatsapp-state.server", () => ({ startLink: f.start }));
const post = (
  Route.options.server as unknown as {
    handlers: { POST: (o: { request: Request }) => Promise<Response> };
  }
).handlers.POST;
const call = (origin = "https://example.invalid", token = "Bearer mock") =>
  post({
    request: new Request("https://example.invalid/api/whatsapp-link", {
      method: "POST",
      headers: { origin, authorization: token, "Content-Type": "application/json" },
      body: JSON.stringify({ country: "GB", userId: "not-authoritative" }),
    }),
  });
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("SUPABASE_URL", "https://example.invalid");
  vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "mock");
});
afterEach(() => vi.unstubAllEnvs());
it("rejects cross-origin, missing and invalid bearers before issuing a link", async () => {
  expect((await call("https://other.invalid")).status).toBe(403);
  expect((await call(undefined, "")).status).toBe(401);
  f.user.mockResolvedValue({ data: { user: null }, error: {} });
  expect((await call()).status).toBe(401);
  expect(f.start).not.toHaveBeenCalled();
});
it("takes the collector id only from the verified bearer, never the body, and prevents caching", async () => {
  f.user.mockResolvedValue({ data: { user: { id: "verified" } } });
  f.start.mockResolvedValue("https://wa.me/15555550101?text=mock");
  const r = await call();
  expect(r.status).toBe(200);
  expect(r.headers.get("Cache-Control")).toContain("no-store");
  expect(f.user).toHaveBeenCalledWith("mock");
  expect(f.start).toHaveBeenCalledWith("verified", "GB");
  expect(await r.json()).toEqual({ url: "https://wa.me/15555550101?text=mock" });
});
