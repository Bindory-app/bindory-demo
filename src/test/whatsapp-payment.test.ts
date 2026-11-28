import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { paymentLanding, submitPayment } from "@/lib/whatsapp-payment.server";
import { whatsappToken } from "@/lib/mori-signing.server";
import type { Linked, Step } from "@/lib/whatsapp-state.server";
const f = vi.hoisted(() => ({
  db: vi.fn(),
  find: vi.fn(),
  step: vi.fn(),
  connect: vi.fn(),
  send: vi.fn(),
}));
vi.mock("@/integrations/supabase/collector.server", () => ({ collectorClient: f.db }));
vi.mock("@/lib/whatsapp-state.server", () => ({ paymentLink: f.find, setStep: f.step }));
vi.mock("@/lib/mori-order-payment.server", async (orig) => ({
  ...(await orig<typeof import("@/lib/mori-order-payment.server")>()),
  connectPayment: f.connect,
}));
vi.mock("@/lib/whatsapp-cloud.server", async (orig) => ({
  ...(await orig<typeof import("@/lib/whatsapp-cloud.server")>()),
  sendWhatsApp: f.send,
}));
const nonce = "70bb1441-8ca6-427b-b175-727e9f0b06c1",
  url = "https://example.invalid/api/whatsapp-payment";
let l: Linked, token: string;
const post = (action: string, wallet = "paypal", cap = token, origin = "https://example.invalid") =>
  submitPayment(
    new Request(url, {
      method: "POST",
      headers: { origin },
      body: new URLSearchParams({ action, token: cap, wallet }),
    }),
  );
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("MORI_MCP_SECRET", "mock-channel-signing-secret-over-32-characters");
  vi.stubEnv("WHATSAPP_APP_ORIGIN", "https://example.invalid");
  token = whatsappToken("payment", nonce, Date.now() + 60000);
  l = { user_id: "mine", step: { kind: "wallet", key: nonce } } as Linked;
  f.find.mockImplementation(async () => (l.step.kind === "wallet" ? { ...l } : null));
  f.step.mockImplementation(async (link: Linked, step: Step) => {
    if (link.step !== l.step) return false;
    l.step = link.step = step;
    return true;
  });
  const q = {
    select: () => q,
    eq: () => q,
    maybeSingle: async () => ({ data: { wallet: "google_pay" } }),
  };
  f.db.mockReturnValue({ from: () => q });
  f.connect.mockResolvedValue(1);
});
afterEach(() => vi.unstubAllEnvs());
it("never puts a capability in request URLs; initial GET and authenticated form view don't connect", async () => {
  const page = paymentLanding();
  expect(page.headers.get("referrer-policy")).toBe("no-referrer");
  expect(await page.text()).toContain("location.hash.slice(1)");
  const view = await post("view");
  const html = await view.text();
  expect(html).toContain('value="google_pay" checked');
  expect(html).toContain("Demo only. Nothing is charged");
  expect(html).toContain('type="submit">Connect');
  expect(f.connect).not.toHaveBeenCalled();
});
it("rejects cross-origin posts, expired/other-purpose tokens and invalid wallets without activation", async () => {
  expect((await post("connect", "card", token, "https://other.invalid")).status).toBe(403);
  for (const cap of [
    whatsappToken("payment", nonce, Date.now() - 1000),
    whatsappToken("link", nonce, Date.now() + 60000),
    "<invalid>",
  ])
    expect((await post("connect", "card", cap)).status).toBe(410);
  expect((await post("connect", "constructor")).status).toBe(410);
  expect(f.connect).not.toHaveBeenCalled();
});
it("accepts the configured origin behind a proxy that reports http, and fails closed when unset", async () => {
  const proxied = (origin: string) =>
    submitPayment(
      new Request("http://example.invalid/api/whatsapp-payment", {
        method: "POST",
        headers: { origin },
        body: new URLSearchParams({ action: "view", token }),
      }),
    );
  expect((await proxied("https://example.invalid")).status).toBe(200);
  expect((await proxied("http://example.invalid")).status).toBe(403);
  vi.stubEnv("WHATSAPP_APP_ORIGIN", "");
  await expect(post("connect")).rejects.toThrow();
  vi.stubEnv("WHATSAPP_APP_ORIGIN", "http://example.invalid");
  await expect(post("connect")).rejects.toThrow();
  expect(f.connect).not.toHaveBeenCalled();
});
it("only one explicit connection wins; WhatsApp gets exactly the database-confirmed count", async () => {
  const result = await Promise.all([post("connect"), post("connect")]);
  expect(result.map((r) => r.status).sort()).toEqual([200, 410]);
  expect(f.connect).toHaveBeenCalledTimes(1);
  expect(f.connect).toHaveBeenCalledWith(expect.anything(), "paypal");
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(f.send.mock.calls[0]![1])).toContain("One order is now live.");
});
it("allows retry after an unconfirmed activation and never claims live for an empty activation", async () => {
  f.connect.mockRejectedValueOnce(new Error("missing RPC")).mockResolvedValueOnce(0);
  const first = await post("connect");
  expect(first.status).toBe(503);
  expect(await first.text()).not.toContain("now live");
  expect(f.send).not.toHaveBeenCalled();
  const second = await post("connect");
  expect(await second.text()).toContain("No pending orders needed activation.");
  expect(f.connect).toHaveBeenCalledTimes(2);
});
it("does not retry activation when the WhatsApp confirmation could not be sent", async () => {
  f.send.mockRejectedValueOnce(new Error("offline"));
  const page = await post("connect");
  expect(await page.text()).toContain(
    "One order is now live. The WhatsApp confirmation could not be sent.",
  );
  expect((await post("connect")).status).toBe(410);
  expect(f.connect).toHaveBeenCalledTimes(1);
});
