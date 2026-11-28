import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import {
  downloadPhoto,
  inboundMessages,
  sendWhatsApp,
  signedWebhook,
} from "@/lib/whatsapp-cloud.server";
import { receiveWebhook, verifyWebhook } from "@/lib/whatsapp-webhook.server";
import { handleInbound } from "@/lib/whatsapp-turn.server";
import { whatsappToken, whatsappNonce } from "@/lib/mori-signing.server";
vi.mock("@/lib/whatsapp-turn.server", () => ({ handleInbound: vi.fn(async () => {}) }));
const now = Date.now(),
  id = "34230553-6f92-44b9-87a7-dc932dfe4052";
const base = {
  id: "wamid.abc",
  timestamp: String(Math.floor(now / 1000)),
  from: "15555550101",
  from_user_id: "US.123",
};
const envelope = (messages: unknown[], field = "messages", phone = "123") => ({
  object: "whatsapp_business_account",
  entry: [
    {
      changes: [
        {
          field,
          value: {
            messaging_product: "whatsapp",
            metadata: { phone_number_id: phone },
            messages,
            statuses: [{ status: "sent" }],
          },
        },
      ],
    },
  ],
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("WHATSAPP_ACCESS_TOKEN", "mock");
  vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", "123");
  vi.stubEnv("WHATSAPP_APP_SECRET", "mock-app");
  vi.stubEnv("WHATSAPP_VERIFY_TOKEN", "verify");
  vi.stubEnv("MORI_MCP_SECRET", "mock-channel-signing-secret-over-32-characters");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("WhatsApp transport", () => {
  it("accepts only the verify token and returns the challenge verbatim", async () => {
    const req = (q: string) =>
      new Request(
        "https://example.invalid/?hub.mode=subscribe&hub.challenge=0007&hub.verify_token=" + q,
      );
    expect(verifyWebhook(req("wrong")).status).toBe(403);
    expect(await verifyWebhook(req("verify")).text()).toBe("0007");
    vi.stubEnv("WHATSAPP_VERIFY_TOKEN", "");
    expect(verifyWebhook(req("")).status).toBe(403);
  });
  it("authenticates the raw body before any parse, doesn't await a turn, and ignores status-only payloads", async () => {
    const post = (body: string, sig: string) =>
      new Request("https://example.invalid", {
        method: "POST",
        body,
        headers: { "X-Hub-Signature-256": sig },
      });
    const sig = (s: string) => "sha256=" + createHmac("sha256", "mock-app").update(s).digest("hex");
    const tasks: Promise<void>[] = [];
    const bg = (p: Promise<void>) => {
      tasks.push(p);
    };
    expect((await receiveWebhook(post("not JSON", "sha256=abc"), bg)).status).toBe(403);
    expect((await receiveWebhook(post("bad", sig("bad")), bg)).status).toBe(400);
    const raw = JSON.stringify(envelope([{ ...base, type: "text", text: { body: "hello" } }]));
    expect(signedWebhook(Buffer.from(raw + " "), sig(raw))).toBe(false);
    let finish!: () => void;
    vi.mocked(handleInbound).mockReturnValueOnce(
      new Promise<void>((r) => {
        finish = r;
      }),
    );
    expect((await receiveWebhook(post(raw, sig(raw)), bg)).status).toBe(200);
    expect(tasks).toHaveLength(1);
    finish();
    await tasks[0];
    const statuses = JSON.stringify(envelope([]));
    expect((await receiveWebhook(post(statuses, sig(statuses)), bg)).status).toBe(200);
    expect(tasks).toHaveLength(1);
  });
  it("extracts only inbound text, images, button and list replies for this business number", () => {
    const messages = [
      { ...base, from: undefined, type: "text", text: { body: " Hello " } },
      { ...base, type: "image", image: { id: "123", caption: "Front" } },
      ...["button_reply", "list_reply"].map((t) => ({
        ...base,
        type: "interactive",
        interactive: { type: t, [t]: { id: "choice" } },
      })),
      {
        ...base,
        type: "interactive",
        interactive: { type: "button_reply", button_reply: { id: "" } },
      },
      { ...base, type: "audio" },
      null,
    ];
    const m = inboundMessages(envelope(messages), "123");
    expect(m.map((x) => x.kind)).toEqual(["text", "image", "action", "action"]);
    expect(m[0]).toMatchObject({ phone: null, bsuid: "US.123", text: "Hello" });
    expect(m[1]).toMatchObject({ phone: "15555550101", bsuid: "US.123", media: "123" });
    expect(inboundMessages(envelope(messages, "messages", "999"), "123")).toEqual([]);
  });
  it("enforces the web data URL limit even when a CDN omits the content length", async () => {
    const url = "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=mock";
    const max = 3 * Math.floor((2_000_000 - "data:image/jpeg;base64,".length) / 4);
    const f = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", f);
    for (const size of [max, max + 1]) {
      f.mockResolvedValueOnce(
        Response.json({ id: "99", url, mime_type: "image/jpeg" }),
      ).mockResolvedValueOnce(new Response(new Uint8Array(size)));
      if (size === max) expect((await downloadPhoto("99")).length).toBeLessThanOrEqual(2_000_000);
      else await expect(downloadPhoto("99")).rejects.toThrow("Body too large");
    }
  });
  it("posts to the versioned messages endpoint with +phone or recipient-only BSUID", async () => {
    const f = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ messages: [{ id: "mock" }] }));
    vi.stubGlobal("fetch", f);
    for (const phone of ["15555550101", null])
      await sendWhatsApp({ phone, bsuid: "US.test" }, { type: "text", text: { body: "Hi" } });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("https://graph.facebook.com/v27.0/123/messages");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer mock");
    expect(JSON.parse(String(init?.body))).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "+15555550101",
      type: "text",
      text: { body: "Hi" },
    });
    const body = JSON.parse(String(f.mock.calls[1]![1]?.body));
    expect(body.recipient).toBe("US.test");
    expect(body.to).toBeUndefined();
  });
  it("resolves fresh media by id and sends the bearer only to the expected HTTPS endpoints", async () => {
    const u = "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=mock";
    const f = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ id: "99", url: u, mime_type: "image/jpeg", file_size: "2" }),
      )
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2])));
    vi.stubGlobal("fetch", f);
    expect(await downloadPhoto("99")).toBe("data:image/jpeg;base64,AQI=");
    expect(f.mock.calls[0]![0]).toBe("https://graph.facebook.com/v27.0/99?phone_number_id=123");
    expect(String(f.mock.calls[1]![0])).toBe(u);
    for (const [, init] of f.mock.calls) {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer mock");
      expect(init?.redirect).toBe("error");
    }
    for (const url of [
      "https://example.invalid/private",
      "http://lookaside.fbsbx.com/x",
      "https://lookaside.fbsbx.com@evil.invalid/x",
    ]) {
      f.mockResolvedValueOnce(Response.json({ id: "99", url, mime_type: "image/jpeg" }));
      await expect(downloadPhoto("99")).rejects.toThrow("Untrusted");
    }
    f.mockResolvedValueOnce(
      Response.json({ id: "99", url: u, mime_type: "image/jpeg", file_size: 5_000_001 }),
    );
    await expect(downloadPhoto("99")).rejects.toThrow("too large");
    expect(f).toHaveBeenCalledTimes(6);
  });
  it("logs only the HTTP status and numeric Graph failure code", async () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(
            Response.json(
              { error: { code: 131056, message: "private upstream text" } },
              { status: 429 },
            ),
          ),
      );
      await expect(
        sendWhatsApp(
          { phone: null, bsuid: "US.private" },
          { type: "text", text: { body: "private collector text" } },
        ),
      ).rejects.toThrow("not confirmed");
      expect(log).toHaveBeenCalledWith("WhatsApp send not confirmed", {
        status: 429,
        code: 131056,
      });
      expect(JSON.stringify(log.mock.calls)).not.toContain("private");
    } finally {
      log.mockRestore();
    }
  });
  it("purpose-separates token signatures and refuses expired, malformed or altered values", () => {
    vi.setSystemTime(now);
    const token = whatsappToken("link", id, now + 60_000);
    expect(whatsappNonce("link", token)).toBe(id);
    expect(whatsappNonce("payment", token)).toBeNull();
    expect(whatsappNonce("link", token.replace(/^3/, "4"))).toBeNull();
    expect(whatsappNonce("link", "bad")).toBeNull();
    vi.setSystemTime(now + 60_000);
    expect(whatsappNonce("link", token)).toBeNull();
  });
});
