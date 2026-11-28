import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { handleInbound } from "@/lib/whatsapp-turn.server";
import { BodyTooLarge } from "@/lib/whatsapp-cloud.server";
import { type Linked, type Step } from "@/lib/whatsapp-state.server";
import { whatsappToken } from "@/lib/mori-signing.server";
import type { MoriRow, MoriStreamEvent } from "@/lib/mori-tools";
const f = vi.hoisted(() => ({
  run: vi.fn(),
  confirm: vi.fn(),
  save: vi.fn(),
  has: vi.fn(),
  db: vi.fn(),
  send: vi.fn(),
  download: vi.fn(),
  first: vi.fn(),
  touch: vi.fn(),
  bind: vi.fn(),
  claim: vi.fn(),
  pair: vi.fn(),
  step: vi.fn(),
  read: vi.fn(),
  unlink: vi.fn(),
}));
vi.mock("@/lib/mori-agent.server", () => ({ runMori: f.run }));
vi.mock("@/lib/mori-confirm.server", async (orig) => ({
  ...(await orig<typeof import("@/lib/mori-confirm.server")>()),
  confirmWith: f.confirm,
}));
vi.mock("@/lib/mori-order-payment.server", async (orig) => ({
  ...(await orig<typeof import("@/lib/mori-order-payment.server")>()),
  saveAlertPreferences: f.save,
  hasPendingOrders: f.has,
}));
vi.mock("@/integrations/supabase/collector.server", () => ({ collectorClient: f.db }));
vi.mock("@/lib/whatsapp-cloud.server", async (orig) => ({
  ...(await orig<typeof import("@/lib/whatsapp-cloud.server")>()),
  sendWhatsApp: f.send,
  downloadPhoto: f.download,
}));
vi.mock("@/lib/whatsapp-state.server", () => ({
  firstDelivery: f.first,
  touchLink: f.touch,
  bindLink: f.bind,
  claimReminder: f.claim,
  pairPhoto: f.pair,
  setStep: f.step,
  unlinkWhatsApp: f.unlink,
}));
const uid = "9dbacc31-e506-4cf1-9074-429c30a63228",
  rowId = "2c573729-ec38-4d87-9159-774a027b7b00";
const base = { phone: "15555550101", bsuid: "US.123", id: "wamid.1", at: new Date().toISOString() };
let l: Linked;
let rows: MoriRow[] = [];
const text = (text: string) => handleInbound({ ...base, kind: "text", text });
const tap = (action: string) => handleInbound({ ...base, kind: "action", action });
const photo = (media: string, caption = "") =>
  handleInbound({ ...base, kind: "image", media, caption });
const out = () => JSON.stringify(f.send.mock.calls.map((x) => x[1]));
const sample = (kind: string, payload: MoriRow["payload"]): MoriRow => ({
  id: rowId,
  role: "mori",
  kind,
  content: "Example",
  payload,
});
const proposal = () =>
  sample("confirm", {
    tool: "set_order",
    status: "pending",
    side: "buy",
    price_usd: 9,
    price: { amount: 9, currency: "USD" },
    card: { name: "Eevee", tcgdex_id: "set-1" },
  });
const active = (r: MoriRow) => {
  l.step = { kind: "rows", rows: [r.id] };
  f.read.mockResolvedValue({ data: r });
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("WHATSAPP_APP_ORIGIN", "https://example.invalid");
  vi.stubEnv("MORI_MCP_SECRET", "mock-channel-signing-secret-over-32-characters");
  l = {
    ...base,
    user_id: uid,
    channel_id: "channel",
    country: "AU",
    chat_since: base.at,
    last_inbound: base.at,
    last_reminder: null,
    step: {},
  };
  rows = [sample("text", null)];
  f.first.mockResolvedValue(true);
  f.touch.mockResolvedValue(l);
  f.claim.mockResolvedValue(null);
  f.download.mockImplementation(async (media) => "data:" + media);
  f.step.mockImplementation(async (link: Linked, next: Step) => {
    link.step = next;
    return true;
  });
  f.run.mockImplementation(async ({ emit }: { emit: (e: MoriStreamEvent) => void }) =>
    emit({ type: "done", rows }),
  );
  const query = { select: () => query, eq: () => query, gte: () => query, maybeSingle: f.read };
  f.db.mockReturnValue({ from: () => query });
});
afterEach(() => vi.unstubAllEnvs());
it("honors delayed STOP without attempting a free-form response outside the window", async () => {
  await handleInbound({
    ...base,
    kind: "text",
    text: "STOP",
    at: new Date(Date.now() - 2 * 864e5).toISOString(),
  });
  expect(f.unlink).toHaveBeenCalledWith(l);
  expect(f.send).not.toHaveBeenCalled();
});
it("carries the photo pair only into the same sell-order printing pick", async () => {
  const sell = {
    kind: "order",
    side: "sell",
    price: { currency: "USD", amount: 10 },
    card: { id: "set-1" },
  };
  const choice = sample("choices", {
    choices: [
      { label: "Eevee sell", intent: sell },
      { label: "Eevee price", intent: { kind: "price_check", card: { id: "set-1" } } },
    ],
  });
  f.pair.mockResolvedValue({ media: ["100", "200"], caption: "Sell" });
  rows = [choice];
  await photo("200");
  expect(l.step.media).toEqual(["100", "200"]);
  f.read.mockResolvedValue({ data: choice });
  await tap("pick:" + rowId + ":1");
  expect(f.run).toHaveBeenLastCalledWith(
    expect.objectContaining({ images: [], selectionOnly: true }),
  );
  await photo("200");
  await tap("pick:" + rowId + ":0");
  expect(f.run).toHaveBeenLastCalledWith(
    expect.objectContaining({
      images: ["data:100", "data:200"],
      selectionOnly: true,
      intent: sell,
    }),
  );
});
it("handles PAYMENT and STOP without a model or an extra reminder", async () => {
  f.has.mockResolvedValue(false);
  await text("payment");
  expect(out()).toContain("You have no pending orders");
  await text("STOP");
  expect(f.unlink).toHaveBeenCalledWith(l);
  expect(out()).toContain("WhatsApp is unlinked.");
  expect(f.run).not.toHaveBeenCalled();
  expect(f.claim).not.toHaveBeenCalled();
});
it("ignores duplicates and delayed deliveries without a reply; unlinked phones get only link instructions", async () => {
  f.first.mockResolvedValueOnce(false);
  await text("hi");
  await handleInbound({
    ...base,
    kind: "text",
    text: "late",
    at: new Date(Date.now() - 2 * 864e5).toISOString(),
  });
  expect(f.touch).not.toHaveBeenCalled();
  expect(f.send).not.toHaveBeenCalled();
  f.touch.mockResolvedValueOnce(null);
  await text("hi");
  expect(out()).toContain("choose Link WhatsApp");
  expect(f.db).not.toHaveBeenCalled();
});
it("never feeds link tokens into chat; accepts only purpose-bound, unexpired tokens", async () => {
  await text("Link " + whatsappToken("link", uid, Date.now() - 1000));
  expect(f.bind).not.toHaveBeenCalled();
  expect(out()).toContain("invalid or expired");
  f.bind.mockResolvedValue(true);
  await text("Link " + whatsappToken("link", uid, Date.now() + 60000));
  expect(f.bind).toHaveBeenCalledWith(
    uid,
    expect.objectContaining({ phone: base.phone, bsuid: base.bsuid }),
  );
  expect(out()).toContain("WhatsApp is linked");
  expect(f.run).not.toHaveBeenCalled();
});
it("passes typed text, the link's market and since to Mori; a reminder is sent only on winning the daily claim", async () => {
  l.step = { kind: "wallet", key: "previously-offered" };
  f.claim.mockResolvedValueOnce(l);
  await text("price Eevee");
  await text("again");
  expect(f.run).toHaveBeenCalledWith(
    expect.objectContaining({
      message: "price Eevee",
      country: "AU",
      since: l.chat_since,
      intent: undefined,
      images: [],
    }),
  );
  expect(
    f.send.mock.calls.filter((c) => JSON.stringify(c[1]).includes("You have pending orders.")),
  ).toHaveLength(1);
});
it("consumes an atomic pair once under concurrent deliveries; holds uncaptained media ids for the next text", async () => {
  let held: string | undefined;
  f.pair.mockImplementation(async (_: Linked, id: string) => {
    if (!held) {
      held = id;
      return null;
    }
    return { media: [held, id], caption: "" };
  });
  await Promise.all([photo("100"), photo("200")]);
  expect(f.run).not.toHaveBeenCalled();
  expect(f.download).not.toHaveBeenCalled();
  expect(l.step).toMatchObject({ kind: "await_text", media: ["100", "200"] });
  expect(out()).toContain("What would you like me to do");
  await text("pre-grade these");
  expect(f.run).toHaveBeenCalledWith(
    expect.objectContaining({ images: ["data:100", "data:200"], message: "pre-grade these" }),
  );
  expect(l.step.media).toBeUndefined();
});
it("resumes the stored photo request intent with both images and their caption", async () => {
  const intent = { kind: "pre_grade", card: { id: "abc-12" } };
  const r = sample("photos", { intent });
  active(r);
  l.step.row = r.id;
  f.pair.mockResolvedValue({ media: ["100", "200"], caption: "This is the front" });
  await photo("200");
  expect(f.run).toHaveBeenCalledWith(
    expect.objectContaining({
      intent,
      message: "This is the front",
      images: ["data:100", "data:200"],
    }),
  );
});
it("loads the stored choice, not inbound text; stale choices cannot run the model", async () => {
  const intent = { kind: "price_check", card: { id: "abc-12" } };
  active(sample("choices", { choices: [{ label: "Eevee 12", intent }] }));
  await tap("pick:" + rowId + ":9");
  expect(f.run).not.toHaveBeenCalled();
  await tap("pick:" + rowId + ":0");
  expect(f.run).toHaveBeenCalledWith(
    expect.objectContaining({ message: "Eevee 12", intent, selectionOnly: true }),
  );
  await tap("pick:" + rowId + ":0");
  expect(f.run).toHaveBeenCalledTimes(1);
  active(sample("suggest", { suggestions: ["Show my collection"] }));
  await tap("suggest:" + rowId + ":0");
  expect(f.run).toHaveBeenLastCalledWith(
    expect.objectContaining({ message: "Show my collection", selectionOnly: false }),
  );
});
it("validates edits deterministically, previews before save, allows revision and rejects stale Save", async () => {
  active(proposal());
  await tap("edit:" + rowId);
  await text("sell 12.25 30 days");
  expect(out()).toContain("front and back photos");
  expect(f.confirm).not.toHaveBeenCalled();
  await text("buy 22 12 days");
  expect(l.step.kind).toBe("edit");
  await text("buy 22 7 days");
  expect(out()).toContain("Updated order: buy Eevee at 22 USD for 7 days.");
  expect(f.confirm).not.toHaveBeenCalled();
  await tap("save:" + rowId);
  expect(f.confirm).not.toHaveBeenCalled();
  await tap("revise:" + l.step.key);
  await text("buy 31.50 90 days");
  const key = l.step.key;
  f.confirm.mockResolvedValue({
    reply: { content: "Your order is saved." },
    order_status: "pending",
  });
  await tap("approve:" + key);
  expect(f.confirm).toHaveBeenCalledWith(expect.anything(), rowId, "confirm", {
    side: "buy",
    price: 31.5,
    expires_days: 90,
  });
  expect(l.step.kind).toBe("alerts");
  expect(out()).toContain("Choose your notification preferences");
});
it("keeps fields during partial revisions and checks the proposal currency", async () => {
  active(proposal());
  await tap("edit:" + rowId);
  await text("GBP 25");
  expect(out()).toContain("Enter the price in USD, the order’s original currency.");
  expect(l.step.kind).toBe("edit");
  await text("$1,200");
  expect(l.step.changes).toEqual({ side: "buy", price: 1200, expires_days: 30 });
  await tap("revise:" + l.step.key);
  await text("7 days");
  expect(l.step.changes).toEqual({ side: "buy", price: 1200, expires_days: 7 });
  await tap("revise:" + l.step.key);
  await text("30");
  expect(l.step.changes).toEqual({ side: "buy", price: 30, expires_days: 7 });
  await tap("revise:" + l.step.key);
  await text("buy");
  expect(l.step.changes?.price).toBe(30);
  await tap("revise:" + l.step.key);
  await text("cancel");
  expect(l.step).toEqual({});
  expect(f.confirm).not.toHaveBeenCalled();
});
it("clears handled edits, stale previews and unrecoverable photos without trapping the next chat", async () => {
  active(proposal());
  await tap("edit:" + rowId);
  f.read.mockResolvedValue({ data: null });
  await text("12");
  expect(l.step).toEqual({});
  l.step = {
    kind: "preview",
    row: rowId,
    key: "k",
    changes: { price: 12, side: "buy", expires_days: 30 },
  };
  f.read.mockResolvedValue({ data: sample("confirm", { status: "confirmed" }) });
  await tap("approve:k");
  expect(f.confirm).not.toHaveBeenCalled();
  expect(l.step).toEqual({});
  l.step = { kind: "await_text", media: ["1", "2"], mediaAt: 0 };
  await text("grade");
  expect(l.step).toEqual({});
  l.step = { kind: "await_text", media: ["1", "2"], mediaAt: Date.now() };
  f.download.mockRejectedValue(new BodyTooLarge());
  await text("grade");
  expect(out()).toContain("each under 1.5 MB");
  expect(l.step).toEqual({});
  await text("link my binder");
  expect(f.run).toHaveBeenCalledWith(expect.objectContaining({ message: "link my binder" }));
});
it("does not interrupt the first photo, and sends a safe reply on PAYMENT failure", async () => {
  f.pair.mockResolvedValue(null);
  await photo("1");
  expect(f.claim).not.toHaveBeenCalled();
  expect(f.send).not.toHaveBeenCalled();
  f.has.mockRejectedValue(new Error("private failure"));
  await text("PAYMENT");
  expect(out()).toContain("I could not finish that request.");
  expect(out()).not.toContain("private failure");
});
it("recovers abandoned paying steps after one minute without repeating activation", async () => {
  l.step = { kind: "paying", key: "a", payingAt: Date.now() };
  await text("PAYMENT");
  expect(f.has).not.toHaveBeenCalled();
  l.step.payingAt = Date.now() - 61000;
  f.has.mockResolvedValue(true);
  await text("PAYMENT");
  expect(l.step.kind).toBe("wallet");
});
it("returns both completed free-text answers, without dropping the second on a stale CAS", async () => {
  rows = [sample("text", null)];
  await Promise.all([text("first"), text("second")]);
  expect(f.send).toHaveBeenCalledTimes(2);
  expect(f.step.mock.calls.every((args) => args[2] === true)).toBe(true);
});
it("relays a legacy live confirmation without an invented payment gate or listing watcher", async () => {
  active(proposal());
  f.confirm.mockResolvedValue({
    reply: {
      content:
        "Your buy order for Eevee at US$9.00 is live for 30 days. I will tell you as soon as a matching listing appears.",
    },
  });
  await tap("save:" + rowId);
  expect(f.send.mock.calls[0]?.[1].text.body).toBe(
    "Your buy order for Eevee at US$9.00 is live for 30 days.",
  );
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(l.step).toEqual({});
});
it.each([
  ["push", true, false],
  ["email", false, true],
  ["both", true, true],
  ["none", false, false],
  ["skip", false, false],
] as const)(
  "maps %s to preferences without activating, then offers distinct payment and skip controls",
  async (choice, push, email) => {
    active(proposal());
    f.confirm.mockResolvedValue({ order_status: "pending", reply: { content: "Saved." } });
    await tap("save:" + rowId);
    const key = l.step.key;
    await tap("alerts:" + key + ":" + choice);
    if (choice === "skip") expect(f.save).not.toHaveBeenCalled();
    else expect(f.save).toHaveBeenCalledWith(expect.anything(), uid, push, email);
    expect(l.step.kind).toBe("wallet");
    expect(out()).toContain("cta_url");
    expect(out()).toContain("Skip for now");
    const old = l.step.key;
    await tap("skip:" + old);
    expect(out()).toContain("Your order stays pending");
    expect(l.step.kind).toBeUndefined();
    f.has.mockResolvedValueOnce(true);
    await tap("pay:resume");
    expect(l.step.kind).toBe("wallet");
    expect(l.step.key).not.toBe(old);
    expect(f.run).not.toHaveBeenCalled();
  },
);
it("supports non-order edit and save without inventing an activation or starting checkout", async () => {
  const memory = sample("confirm", {
    tool: "save_memory",
    status: "pending",
    title: "A trade",
    story: "It happened.",
  });
  active(memory);
  f.confirm.mockResolvedValue({ reply: null });
  await tap("edit:" + rowId);
  expect(f.confirm).toHaveBeenCalledWith(expect.anything(), rowId, "edit");
  active(memory);
  f.confirm.mockResolvedValue({ reply: { content: "Memory saved." } });
  await tap("save:" + rowId);
  expect(out()).toContain("Memory saved.");
  expect(out()).not.toContain("now live");
  expect(l.step.kind).toBeUndefined();
});
