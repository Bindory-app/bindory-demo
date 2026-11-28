import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectorClient } from "@/integrations/supabase/collector.server";

const uid = "cd949ed2-f388-40f2-a7a9-c40a78ce1122";
const secret = "mock-signing-secret-for-offline-tests-only";
function configure() {
  // Node 20 has no global WebSocket. The SDK checks for it even for REST-only queries.
  vi.stubGlobal("WebSocket", class {});
  vi.stubEnv("SUPABASE_URL", "https://example.invalid");
  vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_mock");
  vi.stubEnv("SUPABASE_JWT_SECRET", secret);
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("collector database access", () => {
  it.each(["", "mock-kid"])(
    "sends a five-minute authenticated bearer and separate opaque API key (kid: %s)",
    async (kid) => {
      configure();
      vi.stubEnv("SUPABASE_JWT_KID", kid);
      vi.setSystemTime(new Date("2026-11-27T12:00:00Z"));
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json([]));
      vi.stubGlobal("fetch", fetcher);
      await collectorClient(uid).from("profiles").select("id");
      const headers = new Headers(fetcher.mock.calls[0]![1]?.headers);
      expect(headers.get("apikey")).toBe("sb_publishable_mock");
      const [head, body, sig] = headers
        .get("authorization")!
        .replace(/^Bearer /, "")
        .split(".");
      expect(JSON.parse(Buffer.from(head!, "base64url").toString())).toEqual({
        alg: "HS256",
        typ: "JWT",
        ...(kid ? { kid } : {}),
      });
      const now = Date.now() / 1000;
      expect(JSON.parse(Buffer.from(body!, "base64url").toString())).toEqual({
        sub: uid,
        role: "authenticated",
        aud: "authenticated",
        iat: now,
        exp: now + 300,
      });
      expect(sig).toBe(
        createHmac("sha256", secret)
          .update(head + "." + body)
          .digest("base64url"),
      );
    },
  );
  it.each(["SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_JWT_SECRET"])(
    "fails closed without %s",
    (name) => {
      configure();
      vi.stubEnv(name, "");
      expect(() => collectorClient(uid)).toThrow("not configured");
    },
  );
  it("rejects invalid identities, short signing secrets and opaque admin keys", () => {
    configure();
    expect(() => collectorClient("")).toThrow("Invalid collector id");
    vi.stubEnv("SUPABASE_JWT_SECRET", "weak");
    expect(() => collectorClient(uid)).toThrow("not configured");
    configure();
    vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "sb_secret_mock");
    expect(() => collectorClient(uid)).toThrow("not configured");
  });
});
