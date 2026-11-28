import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  bindLink,
  firstDelivery,
  pairPhoto,
  startLink,
  touchLink,
  setStep,
  type Linked,
} from "@/lib/whatsapp-state.server";
import { whatsappNonce } from "@/lib/mori-signing.server";
const q = vi.hoisted(() => ({
  from: vi.fn(),
  eq: vi.fn(),
  select: vi.fn(),
  update: vi.fn(),
  upsert: vi.fn(),
  insert: vi.fn(),
  rpc: vi.fn(),
  maybeSingle: vi.fn(),
}));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: q }));
const m = {
  id: "wamid.private",
  at: new Date().toISOString(),
  kind: "text" as const,
  text: "private",
  phone: null,
  bsuid: "US.123",
};
const l = { user_id: "uid", channel_id: "cid", step: { kind: "edit" } } as Linked;
beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of [q.from, q.eq, q.update, q.select]) fn.mockReturnValue(q);
});
afterEach(() => vi.unstubAllEnvs());
it("mints an opaque single-use handoff bound to the authenticated user and their current market", async () => {
  vi.stubEnv("WHATSAPP_BUSINESS_NUMBER", "+15555550102");
  vi.stubEnv("MORI_MCP_SECRET", "mock-channel-signing-secret-over-32-characters");
  q.upsert.mockResolvedValue({ error: null });
  const url = new URL(await startLink("uid", "gb")),
    token = url.searchParams.get("text")!.slice(5);
  expect(url.origin + url.pathname).toBe("https://wa.me/15555550102");
  expect(token).not.toContain("uid");
  expect(q.upsert).toHaveBeenCalledWith({
    user_id: "uid",
    country: "GB",
    link_nonce: whatsappNonce("link", token),
    link_expires: expect.any(String),
  });
  q.rpc.mockResolvedValueOnce({ data: true });
  expect(await bindLink(whatsappNonce("link", token)!, m)).toBe(true);
  expect(q.rpc).toHaveBeenCalledWith("bind_whatsapp", {
    p_nonce: whatsappNonce("link", token),
    p_at: m.at,
    p_phone: null,
    p_bsuid: "US.123",
  });
});
it("de-duplicates a hashed id and fails closed on ledger errors", async () => {
  q.insert
    .mockResolvedValueOnce({})
    .mockResolvedValueOnce({ error: { code: "23505" } })
    .mockResolvedValueOnce({ error: new Error("offline") });
  expect(await firstDelivery(m.id)).toBe(true);
  expect(await firstDelivery(m.id)).toBe(false);
  await expect(firstDelivery(m.id)).rejects.toThrow("offline");
  expect(q.insert).toHaveBeenCalledWith({ id: expect.stringMatching(/^[a-f0-9]{64}$/) });
});
it("uses the locked database photo-pair RPC, not two client statements, and CASes steps", async () => {
  q.rpc.mockReturnValueOnce(q);
  q.maybeSingle.mockResolvedValueOnce({ data: l });
  expect(await touchLink(m)).toBe(l);
  q.rpc
    .mockResolvedValueOnce({ data: null })
    .mockResolvedValueOnce({ data: { media: ["100", "200"], caption: "grade" } });
  expect(await Promise.all([pairPhoto(l, "100", "grade"), pairPhoto(l, "200", "")])).toEqual([
    null,
    { media: ["100", "200"], caption: "grade" },
  ]);
  expect(q.rpc).toHaveBeenCalledWith("pair_whatsapp_photo", {
    p_channel: "cid",
    p_user: "uid",
    p_media: "200",
    p_caption: "",
  });
  q.maybeSingle.mockResolvedValueOnce({ data: null });
  expect(await setStep(l, {})).toBe(false);
  expect(q.eq).toHaveBeenCalledWith("step", JSON.stringify({ kind: "edit" }));
});
it("SQL contract: exclusive identities, service-only state writes, single-use tokens, locked photo pairs and daily reminder claim", () => {
  const sql = readFileSync("setup/017_whatsapp.sql", "utf8");
  for (const fragment of [
    "phone text UNIQUE",
    "bsuid text UNIQUE",
    "user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE",
    "GRANT SELECT, DELETE ON public.whatsapp_links TO authenticated",
    "FOR SELECT TO authenticated USING (user_id=auth.uid())",
    "FOR DELETE TO authenticated USING (user_id=auth.uid())",
    "REVOKE ALL ON public.whatsapp_receipts FROM PUBLIC, anon, authenticated",
    "WHERE link_nonce=p_nonce AND link_expires>now()",
    "link_nonce=NULL",
    "channel_id=gen_random_uuid()",
    "l.held_at <= now()-interval '30 minutes'",
    "GRANT SELECT ON public.market_orders TO service_role",
    "EXCEPTION WHEN unique_violation THEN RETURN false",
    "WHERE user_id=p_user AND channel_id=p_channel FOR UPDATE",
    "SET held_media=NULL,held_caption=NULL,held_at=NULL",
    "l.last_reminder<=now()-interval '24 hours'",
    "o.status='pending' AND o.expires_at>now()",
    "FROM PUBLIC,anon,authenticated",
    "TO service_role",
    "COMMIT;",
  ])
    expect(sql).toContain(fragment);
  expect(sql).not.toContain("SECURITY DEFINER");
});
