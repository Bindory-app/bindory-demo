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
  inside = new Date(time + 1).toISOString(),
  outside = new Date(time).toISOString();
const candidate = { user_id: "mock-user", channel_id: "mock-channel" };
const link = (deadline: string) => ({ phone: null, bsuid: "US.mock", freeform_until: deadline });
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
  expect(await response.json()).toEqual({ sent: 1, skipped: 0, failed: 0, partial: false });
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
it("rejects malformed template configuration before paging, claiming or sending", async () => {
  for (const [name, language] of [
    ["Pending", "en_US"],
    [" ".repeat(3), "en_US"],
    ["x".repeat(513), "en_US"],
    ["pending_order", "en-US"],
    ["", "  "],
    ["pending_order", "en_US\n"],
  ] as const) {
    vi.stubEnv("WHATSAPP_REMINDER_TEMPLATE", name);
    vi.stubEnv("WHATSAPP_REMINDER_LANGUAGE", language);
    const response = await run();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "invalid_template_config" });
  }
  expect(f.page).not.toHaveBeenCalled();
  expect(f.claim).not.toHaveBeenCalled();
  expect(f.send).not.toHaveBeenCalled();
});
it("filters out-of-window recipients before claiming when the template is unset; rechecks the clock before sending", async () => {
  f.page.mockResolvedValueOnce([]);
  await run();
  expect(f.page).toHaveBeenCalledWith(null, false, 50);
  expect(f.claim).not.toHaveBeenCalled();
  // The claim was made just inside the window; the application clock has now reached its boundary.
  f.claim.mockResolvedValue(link(outside));
  expect(await (await run()).json()).toEqual({ sent: 0, skipped: 1, failed: 0, partial: false });
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
  expect(await response.json()).toEqual({ sent: 50, skipped: 0, failed: 1, partial: false });
  expect(peak).toBe(5);
  expect(f.page).toHaveBeenLastCalledWith("49", false, 50);
});
it("stops claiming partway through a page without counting untouched recipients as skipped", async () => {
  f.page.mockResolvedValue(Array(8).fill(candidate));
  f.claim.mockResolvedValue(link(new Date(time + 86_400_000).toISOString()));
  f.send.mockImplementation(async () => vi.setSystemTime(time + 40_000));
  const response = await run();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ sent: 5, skipped: 0, failed: 0, partial: true });
  expect(f.claim).toHaveBeenCalledTimes(5);
  expect(f.page).toHaveBeenCalledTimes(1);
});
it("does not page again if a full page finishes at the admission deadline", async () => {
  f.page.mockResolvedValue(Array(50).fill(candidate));
  f.claim.mockImplementation(async () => {
    if (f.claim.mock.calls.length === 50) vi.setSystemTime(time + 40_000);
    return null;
  });
  expect(await (await run()).json()).toEqual({ sent: 0, skipped: 50, failed: 0, partial: true });
  expect(f.page).toHaveBeenCalledTimes(1);
});
it("keeps candidate scans service-only, read-only, keyset ordered and filtered to eligible pending orders", () => {
  const sql = readFileSync("setup/018_whatsapp_reminders.sql", "utf8");
  for (const part of [
    "SECURITY INVOKER",
    "p_after IS NULL OR l.user_id>p_after",
    "l.last_reminder<=now()-interval '24 hours'",
    "p_template OR public.whatsapp_freeform_until(l.last_inbound)>now()",
    "GRANT SELECT ON public.market_orders TO service_role",
    "o.status='pending' AND o.expires_at>now()",
    "ORDER BY l.user_id LIMIT",
    "FROM PUBLIC,anon,authenticated",
    "TO service_role",
  ])
    expect(sql).toContain(part);
  expect(sql).not.toMatch(/SECURITY DEFINER|UPDATE public\.market_orders/i);
});
it("keeps the rolling slot across unlink/relink without retaining either sender identity", () => {
  const sql = readFileSync("setup/018_whatsapp_reminders.sql", "utf8");
  const table = sql
    .split("CREATE TABLE IF NOT EXISTS public.whatsapp_reminder_slots (")[1]!
    .split(");")[0]!;
  expect(table).toContain("user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE");
  expect(table).not.toMatch(/phone|bsuid|channel|order_id/);
  for (const part of [
    "REVOKE ALL ON public.whatsapp_reminder_slots FROM PUBLIC,anon,authenticated",
    "BEFORE UPDATE OF last_reminder ON public.whatsapp_links",
    "ON CONFLICT(user_id) DO UPDATE",
    "greatest(s.reminded_at,EXCLUDED.reminded_at)",
    "NEW.last_reminder IS DISTINCT FROM OLD.last_reminder",
    "s.reminded_at<=EXCLUDED.reminded_at-interval '24 hours'",
    "IF NOT FOUND THEN RETURN NULL",
    "SELECT user_id,last_reminder FROM public.whatsapp_links",
    "NOT EXISTS (SELECT 1 FROM public.whatsapp_reminder_slots",
  ])
    expect(sql).toContain(part);
});
it("uses one database-defined 60-second guard for enumeration, claim and the returned send deadline", () => {
  const claim = readFileSync("setup/017_whatsapp.sql", "utf8");
  expect(claim).toContain("SELECT p_at + interval '24 hours' - interval '60 seconds'");
  expect(claim).toContain("p_template OR public.whatsapp_freeform_until(l.last_inbound)>now()");
  expect(claim).toContain(
    "RETURNING l.phone,l.bsuid,public.whatsapp_freeform_until(l.last_inbound)",
  );
});
