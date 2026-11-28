// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Exercise the shipped live layer, not a second implementation of the checkout.
const file = readFileSync("wireframe/live.html", "utf8");
const steps = file.slice(
  file.indexOf("  const paymentLabels ="),
  file.indexOf('  app.addEventListener("cp:order-settings"'),
);
const order = { side: "buy", name: "Pikachu", price: 10, days: 7 };
function setup(uid = "collector", pending = true, push = true) {
  const app = document.createElement("div");
  document.body.append(app);
  const P = {
    moriUI: {
      say: (html: string) =>
        app.insertAdjacentHTML("beforeend", '<div class="cp-mori-msg">' + html + "</div>"),
    },
    orderSettings: { wallet: "paypal" },
    orderNext: vi.fn(),
    toast: vi.fn(),
  };
  const rpc = vi
    .fn()
    .mockResolvedValue({ data: { activated_ids: ["first", "second"] }, error: null });
  const upsert = vi.fn().mockResolvedValue({ error: null });
  const queries: string[] = [];
  const filters: unknown[][] = [];
  const sb = {
    rpc,
    from: (table: string) => {
      queries.push(table);
      return {
        select() {
          return this;
        },
        eq(key: string, value: string) {
          filters.push([table, "eq", key, value]);
          return this;
        },
        gt(key: string, value: string) {
          filters.push([table, "gt", key, value]);
          return this;
        },
        upsert,
        maybeSingle: async () => ({
          data: { alert_push: push, alert_email: false, wallet: "paypal" },
        }),
        limit: async () => ({ data: pending ? [{ id: "first" }] : [] }),
      };
    },
  };
  const api = new Function(
    "app",
    "P",
    "sb",
    "session",
    "esc",
    "refreshOrders",
    steps + "\nreturn {confirm:afterOrderConfirm,load:loadOrderSettings};",
  )(app, P, sb, { user: { id: uid } }, String, vi.fn()) as {
    confirm: (o: typeof order, status: string | undefined, uid: string) => void;
    load: () => Promise<void>;
  };
  const click = (key: string) => {
    const btn = [...app.querySelectorAll<HTMLButtonElement>('[data-bd-payment="' + key + '"]')]
      .reverse()
      .find((b) => !b.disabled);
    expect(btn).toBeDefined();
    btn!.click();
  };
  return {
    app,
    P,
    rpc,
    upsert,
    queries,
    filters,
    click,
    confirm: (status?: string) => api.confirm(order, status, uid),
    load: api.load,
  };
}

describe("pending payment steps", () => {
  it("shows pending payment in order history and allows cancellation only after the second tap", async () => {
    const app = document.createElement("div");
    const history =
      '<section><div data-order-id="my-order"><span><small>Buy order · 7 days left</small></span><div class="cp-order-item-act"><button data-bd-order-cancel>Cancel</button></div></div></section>';
    app.innerHTML = history + history;
    const result = {
      id: "my-order",
      status: "pending",
      expires_at: new Date(Date.now() + 864e5).toISOString(),
    };
    const update = vi.fn(() => query),
      statusFilter = vi.fn(() => query);
    const query = {
      update,
      eq: vi.fn(() => query),
      in: statusFilter,
      gt: vi.fn(() => query),
      select: vi.fn(() => query),
      maybeSingle: vi.fn(async () => ({ data: { id: "my-order" }, error: null })),
    };
    const body =
      file.slice(
        file.indexOf("  function showOrderStatus"),
        file.indexOf("  // Post or save a video"),
      ) +
      file.slice(
        file.indexOf("  // Cancel a pending or open order"),
        file.indexOf("  // Change details on an order card"),
      );
    new Function(
      "app",
      "sb",
      "fresh",
      "P",
      "CSS",
      "esc",
      "order",
      body + "\nshowOrderStatus(app, order);",
    )(
      app,
      { from: () => query },
      vi.fn(async () => true),
      { toast: vi.fn() },
      { escape: String },
      String,
      result,
    );
    expect(app.textContent).toContain("Pending payment");
    expect(app.textContent).not.toContain("Cancelled");
    app.querySelector<HTMLButtonElement>("[data-bd-order-cancel]")!.click();
    expect(update).not.toHaveBeenCalled();
    app.querySelector<HTMLButtonElement>("[data-bd-order-yes]")!.click();
    await vi.waitFor(() =>
      expect([...app.querySelectorAll("mark")].map((el) => el.textContent)).toEqual([
        "Cancelled",
        "Cancelled",
      ]),
    );
    expect(app.querySelector("[data-bd-order-cancel]")).toBeNull();
    expect(update).toHaveBeenCalledWith({ status: "cancelled" });
    expect(statusFilter).toHaveBeenCalledWith("status", ["open", "pending"]);
  });
  beforeEach(() => {
    document.body.replaceChildren();
    localStorage.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  it("uses the original flow only for a legacy confirmation", () => {
    vi.useFakeTimers();
    const t = setup();
    t.confirm();
    vi.advanceTimersByTime(500);
    expect(t.P.orderNext).toHaveBeenCalledWith({
      side: "buy",
      card: "Pikachu",
      price: 10,
      days: 7,
    });
    expect(t.app.textContent).toBe("");
    expect(t.rpc).not.toHaveBeenCalled();
  });
  it("skips payment without activating and retries a missing RPC without claiming the order is live", async () => {
    const t = setup();
    t.confirm("pending");
    t.click("skip-alerts");
    expect(t.app.querySelector<HTMLInputElement>("input[type=radio]:checked")?.value).toBe(
      "paypal",
    );
    t.click("skip-wallet");
    expect(t.app.textContent).toContain("Your order stays pending");
    expect(t.rpc).not.toHaveBeenCalled();
    t.click("wallet");
    t.rpc.mockResolvedValueOnce({ data: null, error: { code: "PGRST202" } });
    t.click("connect");
    await vi.waitFor(() =>
      expect(t.P.toast).toHaveBeenCalledWith("Could not confirm activation. Try Connect again."),
    );
    expect(t.app.textContent).not.toContain("now live");
    expect(t.P.orderNext).not.toHaveBeenCalled();
    t.click("connect");
    await vi.waitFor(() => expect(t.app.textContent).toContain("2 orders are now live."));
    expect(t.rpc).toHaveBeenLastCalledWith("connect_order_payment", { p_wallet: "paypal" });
    expect(t.app.querySelector('[data-bd-payment-step="pending"]')).toBeNull();
  });
  it("saves only notification preferences in step one and never declares an empty activation live", async () => {
    const t = setup();
    t.confirm("pending");
    t.app.querySelector<HTMLInputElement>('[data-bd-alert="push"]')!.checked = false;
    t.app.querySelector<HTMLInputElement>('[data-bd-alert="email"]')!.checked = true;
    t.click("alerts");
    await vi.waitFor(() =>
      expect(t.app.querySelector('[data-bd-payment="connect"]')).not.toBeNull(),
    );
    expect(t.upsert).toHaveBeenCalledWith({
      user_id: "collector",
      alert_push: false,
      alert_email: true,
      updated_at: expect.any(String),
    });
    expect(t.rpc).not.toHaveBeenCalled();
    t.rpc.mockResolvedValue({ data: { activated_ids: [] }, error: null });
    t.click("connect");
    await vi.waitFor(() =>
      expect(t.app.textContent).toContain("No pending orders needed activation."),
    );
    expect(t.app.textContent).not.toContain("now live");
  });
  it("retires stale payment steps and admits just one Connect until activation settles", async () => {
    const t = setup();
    t.confirm("pending");
    const oldAlerts = t.app.querySelector<HTMLButtonElement>('[data-bd-payment="skip-alerts"]')!;
    t.click("skip-alerts");
    const oldSkip = t.app.querySelector<HTMLButtonElement>('[data-bd-payment="skip-wallet"]')!;
    let finish!: (result: unknown) => void;
    t.rpc.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    t.click("connect");
    t.confirm("pending");
    t.click("skip-alerts");
    t.click("connect");
    expect(t.rpc).toHaveBeenCalledTimes(1);
    finish({ data: { activated_ids: ["first", "second"] }, error: null });
    await vi.waitFor(() => expect(t.app.textContent).toContain("2 orders are now live."));
    expect(t.app.querySelector("[data-bd-payment-step]")).toBeNull();
    oldAlerts.click();
    oldSkip.click();
    expect(t.app.textContent).not.toContain("Your order stays pending");
    expect(t.app.querySelector("[data-bd-payment-step]")).toBeNull();
  });
  it("does not let a late alert save resurrect the wallet after Connect succeeds", async () => {
    const t = setup();
    let finish!: (result: unknown) => void;
    t.upsert.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    t.confirm("pending");
    t.click("alerts");
    t.confirm("pending");
    t.click("skip-alerts");
    t.click("connect");
    await vi.waitFor(() => expect(t.app.textContent).toContain("2 orders are now live."));
    finish({ error: null });
    await Promise.resolve();
    expect(t.app.querySelector("[data-bd-payment-step]")).toBeNull();
  });
  it("uses distinct wallet radio groups at the same time without secure-context randomUUID", async () => {
    vi.stubGlobal("crypto", {});
    vi.spyOn(Date, "now").mockReturnValue(123);
    try {
      const t = setup();
      t.confirm("pending");
      t.click("alerts");
      await vi.waitFor(() => expect(t.app.querySelector("input[type=radio]")).not.toBeNull());
      const radios = () =>
        [...t.app.querySelectorAll<HTMLInputElement>("input[type=radio]")].map((el) => el.name);
      const first = radios();
      expect(first).toHaveLength(4);
      expect(new Set(first).size).toBe(1);
      t.confirm("pending");
      t.click("skip-alerts");
      const second = radios();
      expect(second).toHaveLength(4);
      expect(new Set(second).size).toBe(1);
      expect(second[0]).not.toBe(first[0]);
      expect(t.P.toast).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });
  it("reminds on every app open, not on token refresh; local notifications are per collector per day", async () => {
    const notify = vi.fn(function () {});
    vi.stubGlobal("Notification", Object.assign(notify, { permission: "granted" }));
    const first = setup();
    await first.load();
    await first.load();
    expect(first.app.querySelectorAll('[data-bd-payment-step="reminder"]')).toHaveLength(1);
    expect(first.queries).toEqual(["order_settings", "market_orders"]);
    expect(first.filters).toEqual([
      ["order_settings", "eq", "user_id", "collector"],
      ["market_orders", "eq", "user_id", "collector"],
      ["market_orders", "eq", "status", "pending"],
      ["market_orders", "gt", "expires_at", expect.stringMatching(/^\d{4}-\d\d-\d\dT/)],
    ]);
    first.click("wallet");
    expect(first.app.querySelector('[data-bd-payment="connect"]')).not.toBeNull();
    const reopened = setup();
    await reopened.load();
    expect(reopened.app.textContent).toContain("You have pending orders");
    expect(notify).toHaveBeenCalledTimes(1);
    await setup("other").load();
    expect(notify).toHaveBeenCalledTimes(2);
    vi.setSystemTime(Date.now() + 864e5 + 1);
    await setup().load();
    expect(notify).toHaveBeenCalledTimes(3);
    const empty = setup("empty", false);
    await empty.load();
    expect(empty.app.textContent).toBe("");
    const off = setup("off", true, false);
    await off.load();
    expect(off.app.textContent).toContain("You have pending orders");
    expect(notify).toHaveBeenCalledTimes(3);
  });
  it("waits through the email auth sheet handoff and thread reset before showing or throttling reminders", async () => {
    const notify = vi.fn(function () {});
    vi.stubGlobal("Notification", Object.assign(notify, { permission: "granted" }));
    const t = setup();
    const sheet = document.createElement("div");
    sheet.dataset.authSheet = "";
    sheet.className = "is-open";
    t.app.append(sheet);
    const thread = document.createElement("div");
    t.app.append(thread);
    t.P.moriUI.say = (html) =>
      thread.insertAdjacentHTML("beforeend", '<div class="cp-mori-msg">' + html + "</div>");
    const loading = t.load();
    await Promise.resolve();
    await Promise.resolve();
    expect(thread.textContent).toBe("");
    expect(notify).not.toHaveBeenCalled();
    expect(localStorage.getItem("bd-payment-reminder:collector")).toBeNull();
    // The base calls closeAuth() then resets the thread synchronously, for login and signup.
    sheet.classList.remove("is-open");
    thread.replaceChildren();
    await loading;
    await t.load();
    expect(thread.querySelectorAll('[data-bd-payment-step="reminder"]')).toHaveLength(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("bd-payment-reminder:collector")).not.toBeNull();
  });
});
