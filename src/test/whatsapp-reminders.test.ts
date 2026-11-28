import { readFileSync } from "node:fs";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { sweepReminders } from "@/lib/whatsapp-reminders.server";
const f = vi.hoisted(() => ({ page: vi.fn(), claim: vi.fn(), send: vi.fn() }));
vi.mock("@/lib/whatsapp-state.server", () => ({
  reminderCandidates: f.page,
  claimReminder: f.claim,
}));
vi.mock("@/lib/whatsapp-cloud.server", () => ({ sendWhatsApp: f.send }));
const time = Date.UTC(2026, 10, 27, 12),
  inside = new Date(time - 864e5 + 1).toISOString(),
  outside = new Date(time - 864e5).toISOString();
const candidate = { user_id: "mock-user", channel_id: "mock-channel" };
const link = (at: string) => ({ ...candidate, phone: null, bsuid: "US.mock", last_inbound: at });
const run = (auth = "Bearer mock-secret") =>
  sweepReminders(
    new Request("https://example.invalid/api/whatsapp-reminders", {
      headers: auth ? { authorization: auth } : {},
    }),
  );
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(time);
  vi.stubEnv("CRON_SECRET", "mock-secret");
  vi.stubEnv("WHATSAPP_REMINDER_TEMPLATE", "");
  vi.stubEnv("WHATSAPP_REMINDER_LANGUAGE", "");
  f.page.mockResolvedValue([candidate]);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
it("rejects missing, incorrect or unconfigured Bearer authorization before any database work", async () => {
  for (const header of ["", "mock-secret", "Bearer wrong"])
    expect((await run(header)).status).toBe(401);
  vi.stubEnv("CRON_SECRET", "");
  expect((await run()).status).toBe(401);
  expect(f.page).not.toHaveBeenCalled();
});
it("sends the free-form CTA within 24 hours and uses the shared inbound claim", async () => {
  f.claim.mockResolvedValue(link(inside));
  const response = await run();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ sent: 1, skipped: 0, failed: 0 });
  expect(f.claim).toHaveBeenCalledWith(candidate, false);
  expect(f.send.mock.calls[0]![1]).toMatchObject({
    interactive: {
      type: "button",
      body: { text: "You have pending orders. Add a payment method to make them live." },
      action: {
        buttons: [{ type: "reply", reply: { id: "pay:resume", title: "Add payment method" } }],
      },
    },
  });
});
it("filters out-of-window recipients before claiming when the template is unset; rechecks the clock before sending", async () => {
  f.page.mockResolvedValueOnce([]);
  await run();
  expect(f.page).toHaveBeenCalledWith(null, false, 50);
  expect(f.claim).not.toHaveBeenCalled();
  // The claim was made just inside the window; the application clock has now reached its boundary.
  f.claim.mockResolvedValue(link(outside));
  expect(await (await run()).json()).toEqual({ sent: 0, skipped: 1, failed: 0 });
  expect(f.send).not.toHaveBeenCalled();
});
it("sends only a configured static template at the exact boundary, with the approved language", async () => {
  vi.stubEnv("WHATSAPP_REMINDER_TEMPLATE", "mock_pending");
  f.claim.mockResolvedValue(link(outside));
  await run();
  expect(f.page).toHaveBeenCalledWith(null, true, 50);
  expect(f.claim).toHaveBeenCalledWith(candidate, true);
  expect(f.send).toHaveBeenCalledWith(link(outside), {
    type: "template",
    template: { name: "mock_pending", language: { code: "en_US" } },
  });
  vi.stubEnv("WHATSAPP_REMINDER_LANGUAGE", "en_GB");
  await run();
  expect(f.send.mock.calls.at(-1)![1].template.language.code).toBe("en_GB");
  f.claim.mockResolvedValue(link(inside));
  await run();
  expect(f.send.mock.calls.at(-1)![1].type).toBe("interactive");
});
it("loses a raced claim without sending, and never retries an ambiguous Graph send", async () => {
  f.claim.mockResolvedValueOnce(link(inside)).mockResolvedValue(null);
  f.send.mockRejectedValue(new Error("private upstream details"));
  const responses = await Promise.all([run(), run()]);
  const counts = await Promise.all(responses.map((r) => r.text()));
  expect(responses.map((r) => r.status).sort()).toEqual([200, 503]);
  expect(counts.join("")).not.toMatch(/private|mock-user|US\.mock/);
  expect(f.send).toHaveBeenCalledTimes(1);
});
it("keyset-pages candidates, bounds recipient concurrency and continues past a failed claim", async () => {
  const first = Array.from({ length: 50 }, (_, i) => ({ ...candidate, user_id: String(i) }));
  f.page.mockResolvedValueOnce(first).mockResolvedValueOnce([candidate]);
  let live = 0,
    peak = 0;
  f.claim.mockImplementation(async (c) => {
    peak = Math.max(peak, ++live);
    await Promise.resolve();
    live--;
    if (c.user_id === "12") throw new Error("offline");
    return link(inside);
  });
  const response = await run();
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ sent: 50, skipped: 0, failed: 1 });
  expect(peak).toBe(5);
  expect(f.page).toHaveBeenLastCalledWith("49", false, 50);
});
it("keeps candidate scans service-only, read-only, keyset ordered and filtered to eligible pending orders", () => {
  const sql = readFileSync("setup/018_whatsapp_reminders.sql", "utf8");
  for (const part of [
    "SECURITY INVOKER",
    "p_after IS NULL OR l.user_id>p_after",
    "l.last_reminder<=now()-interval '24 hours'",
    "p_template OR l.last_inbound>now()-interval '24 hours'",
    "o.status='pending' AND o.expires_at>now()",
    "ORDER BY l.user_id LIMIT",
    "FROM PUBLIC,anon,authenticated",
    "TO service_role",
  ])
    expect(sql).toContain(part);
  expect(sql).not.toMatch(/SECURITY DEFINER|UPDATE public\.market_orders/i);
});
