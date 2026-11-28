import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findCards, getCard } from "@/lib/tcgdex";
import { runMori } from "@/lib/mori-agent.server";
import { parseMoriIntent, type MemoryIntent } from "@/lib/mori-validation";
import type { ResponsesRequest, ResponsesResponse } from "@/lib/ai-gateway.server";
import type { DB } from "@/lib/mori-context.server";
import type { MoriStreamEvent } from "@/lib/mori-tools";
import { createTurnTimer } from "@/lib/mori-timing.server";

vi.mock("@/lib/collectr-sync.server", () => ({ latestSync: vi.fn(), startSync: vi.fn() }));
vi.mock("@/lib/tcgdex", async (original) => ({
  ...(await original<typeof import("@/lib/tcgdex")>()),
  findCards: vi.fn(),
  getCard: vi.fn(),
}));

type Row = { role: string; kind: string; content: string; payload?: unknown };
const since = "2026-11-27T00:00:00.000Z";
const images = ["data:image/jpeg;base64,Zg=="];

function chat(rows: Row[] = []) {
  let historyLoads = 0;
  const db = {
    from: () => ({
      select: () => {
        const q = {
          gt: () => q,
          lt: () => q,
          order: () => q,
          eq: () => q,
          not: () => q,
          limit: () => q,
          range: async () => {
            historyLoads += 1;
            return { data: rows.slice(0, -1), error: null };
          },
          maybeSingle: async () => ({ data: null }),
        };
        return q;
      },
      insert: (draft: Row | Row[]) => ({
        select: () => {
          if (Array.isArray(draft)) {
            rows.push(...draft);
            return Promise.resolve({ data: draft, error: null });
          }
          rows.push(draft);
          return { single: async () => ({ data: { ...draft, created_at: since }, error: null }) };
        },
      }),
    }),
  } as unknown as DB;
  const events: MoriStreamEvent[] = [];
  const send = (
    message: string,
    opts: Pick<Parameters<typeof runMori>[0], "images" | "intent" | "timing" | "signal"> = {},
  ) =>
    runMori({
      db,
      message,
      userId: "collector",
      emit: (event) => events.push(event),
      since,
      ...opts,
    });
  return {
    send,
    rows,
    events,
    get historyLoads() {
      return historyLoads;
    },
  };
}

const call = (name: string, args: Record<string, unknown>) => ({
  type: "function_call",
  name,
  arguments: JSON.stringify(args),
  call_id: crypto.randomUUID(),
});
const say = (text: string) => ({ type: "message", content: [{ type: "output_text", text }] });
const requests: ResponsesRequest[] = [];
const replies: NonNullable<ResponsesResponse["output"]>[] = [];
function gateway(...output: NonNullable<ResponsesResponse["output"]>) {
  replies.push(output);
}

const pikaHit = { id: "base1-25", name: "Pikachu", number: "25", set: "Base Set", set_size: 102 };
const zardHit = { id: "base1-4", name: "Charizard", number: "4", set: "Base Set", set_size: 102 };
const fullCard = (hit: typeof pikaHit) => ({
  id: hit.id,
  name: hit.name,
  localId: hit.number,
  image: `https://assets.tcgdex.net/en/base/base1/${hit.number}`,
  set: { id: "base1", name: hit.set },
});

beforeEach(() => {
  vi.clearAllMocks();
  requests.length = replies.length = 0;
  vi.mocked(findCards).mockReset();
  vi.mocked(getCard).mockReset();
  vi.stubEnv("AI_GATEWAY_API_KEY", "mock-key");
  vi.stubEnv("VERCEL_OIDC_TOKEN", "");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options: RequestInit) => {
      if (url !== "https://ai-gateway.vercel.sh/v1/responses") throw new Error("Unexpected URL");
      if (options.signal?.aborted)
        throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
      requests.push(JSON.parse(String(options.body)) as ResponsesRequest);
      const output = replies.shift();
      if (!output) throw new Error("Unexpected gateway call");
      const events = output
        .filter((o) => o.type === "message")
        .map((o) => ({ type: "response.output_text.delta", delta: o.content?.[0]?.text ?? "" }));
      return new Response(
        [...events, { type: "response.completed", response: { output } }]
          .map((e) => "data: " + JSON.stringify(e) + "\n\n")
          .join(""),
      );
    }),
  );
});
afterEach(() => {
  expect(replies).toHaveLength(0);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("memory intent parsing", () => {
  it("accepts a bare memory intent and optional validated slots", () => {
    expect(parseMoriIntent({ kind: "memory" }, false)).toEqual({ kind: "memory" });
    const full: MemoryIntent = {
      kind: "memory",
      place: "Sydney Card Show",
      with_whom: "@alex",
      date: "2026-11-02",
      card_name: "Charizard 4/102",
      traded_card_name: "Pikachu 25/102",
    };
    expect(parseMoriIntent(full, false)).toEqual(full);
  });

  it.each([
    { kind: "memory", date: "2026-02-31" },
    { kind: "memory", date: "Nov 2 2026" },
    { kind: "memory", place: "" },
    { kind: "memory", place: "x".repeat(161) },
    { kind: "memory", extra: "nope" },
  ])("logs and ignores malformed memory intents (%j)", (bad) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(parseMoriIntent(bad, false)).toBeNull();
      expect(warn).toHaveBeenCalledWith("Invalid or unsupported Mori intent; using chat");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("structured memory flow", () => {
  it("makes one text-only gateway call, skips history, stores the story verbatim without suffix, and logs turn 0 timing", async () => {
    const story =
      "I pulled Umbreon VMAX 215/203 from Evolving Skies with @mina at Good Games on 2 Nov 2026. I felt excited and grateful. I’d rate the pull 5/5.";
    const message = `${story} Help me save this memory.`;
    vi.mocked(findCards).mockResolvedValue([]);
    gateway(
      call("extract_memory", {
        title: "Umbreon VMAX pull at Good Games",
        place: "Good Games",
        with_whom: "@mina",
        date: "2026-11-02",
        card_name: "Umbreon VMAX 215/203",
      }),
    );

    const c = chat();
    const timing = createTurnTimer(Date.now, () => {});
    await c.send(message, { intent: { kind: "memory" }, timing });

    const summary = timing.finish("done");
    expect(summary.models).toMatchObject([{ turn: 0, ok: true }]);
    expect(summary.tools.map((t) => t.name)).toEqual(["save_memory"]);
    expect(c.historyLoads).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      tool_choice: "required",
      tools: [{ name: "extract_memory" }],
    });
    expect(requests[0]?.input).toEqual([{ role: "user", content: story }]);
    expect(c.events[0]).toMatchObject({ type: "status", name: "extract_memory" });

    const confirms = c.rows.filter((r) => r.kind === "confirm");
    expect(confirms).toHaveLength(1);
    expect(confirms[0]).toMatchObject({
      kind: "confirm",
      content: "Save the memory “Umbreon VMAX pull at Good Games”",
      payload: {
        tool: "save_memory",
        title: "Umbreon VMAX pull at Good Games",
        story,
        place: "Good Games",
        with_whom: "@mina",
        date: "2026-11-02",
        card_name: "Umbreon VMAX 215/203",
        status: "pending",
      },
    });
    expect(c.rows.some((r) => r.kind === "text")).toBe(false);
  });

  it("resolves both trade card labels in parallel and keeps written names when there is no single match", async () => {
    // Prove the two cardFromLabel lookups start concurrently before either resolves.
    let resolveFirst!: (v: (typeof pikaHit)[]) => void;
    let resolveSecond!: (v: (typeof zardHit)[]) => void;
    vi.mocked(findCards)
      .mockImplementationOnce(() => new Promise((r) => (resolveFirst = r)))
      .mockImplementationOnce(() => new Promise((r) => (resolveSecond = r)));
    vi.mocked(getCard).mockImplementation(async (id) =>
      id === zardHit.id ? fullCard(zardHit) : id === pikaHit.id ? fullCard(pikaHit) : null,
    );
    gateway(
      call("extract_memory", {
        title: "Pikachu for Charizard trade",
        place: "Sydney Card Show",
        with_whom: "@alex",
        card_name: "Charizard 4/102",
        traded_card_name: "Pikachu 25/102",
      }),
    );

    const c = chat();
    const pending = c.send(
      "I traded my Pikachu 25/102 with @alex for Charizard 4/102 at Sydney Card Show on 2 Nov 2026. Help me save this memory.",
      { intent: { kind: "memory" } },
    );
    await vi.waitFor(() => expect(findCards).toHaveBeenCalledTimes(2));
    resolveFirst([zardHit]);
    resolveSecond([pikaHit]);
    await pending;

    const confirm = c.rows.find((r) => r.kind === "confirm");
    expect(confirm?.payload).toMatchObject({
      card: { tcgdex_id: zardHit.id, name: "Charizard", set_name: "Base Set" },
      traded_card: { tcgdex_id: pikaHit.id, name: "Pikachu", set_name: "Base Set" },
    });
    expect((confirm?.payload as Record<string, unknown>)["card_name"]).toBeUndefined();
    expect((confirm?.payload as Record<string, unknown>)["traded_card_name"]).toBeUndefined();

    // Ambiguous (2 matches) and missing (0 matches) labels keep the collector's written names.
    vi.mocked(findCards)
      .mockResolvedValueOnce([zardHit, { ...zardHit, id: "base2-4", set: "Base Set 2" }])
      .mockResolvedValueOnce([]);
    gateway(
      call("extract_memory", {
        title: "Trade with custom promo",
        card_name: "Charizard 4/102",
        traded_card_name: "Pikachu Promo 99/99",
      }),
    );
    const second = chat();
    await second.send(
      "I traded my Pikachu Promo 99/99 with @alex for Charizard 4/102 at League Night on 5 Nov 2026. Help me save this memory.",
      { intent: { kind: "memory" } },
    );
    const secondConfirm = second.rows.find((r) => r.kind === "confirm");
    expect(secondConfirm?.payload).toMatchObject({
      card_name: "Charizard 4/102",
      traded_card_name: "Pikachu Promo 99/99",
    });
    expect((secondConfirm?.payload as Record<string, unknown>)["card"]).toBeUndefined();
    expect((secondConfirm?.payload as Record<string, unknown>)["traded_card"]).toBeUndefined();
  });

  it("prefers deterministic templateDate and validated intent slots over model values", async () => {
    vi.mocked(findCards).mockResolvedValue([]);
    gateway(
      call("extract_memory", {
        title: "Tokyo card show trade",
        place: "Wrong Place",
        with_whom: "@someone-else",
        date: "2024-01-01",
      }),
    );
    const c = chat();
    await c.send(
      "I went to Tokyo Card Show in Tokyo on 14 Mar 2026 with @kenji. Help me save this memory.",
      {
        intent: {
          kind: "memory",
          place: "Tokyo",
          with_whom: "@kenji",
          date: "2026-03-14",
        },
      },
    );
    expect(requests).toHaveLength(1);
    expect(c.rows.find((r) => r.kind === "confirm")?.payload).toMatchObject({
      title: "Tokyo card show trade",
      place: "Tokyo",
      with_whom: "@kenji",
      date: "2026-03-14",
    });

    // Even with a bare { kind: "memory" } intent, templateDate still overrides a wrong model date.
    gateway(
      call("extract_memory", {
        title: "League night memory",
        date: "2020-05-05",
      }),
    );
    const bare = chat();
    await bare.send("I went to League Night in Perth on 9 Sep 2026. Help me save this memory.", {
      intent: { kind: "memory" },
    });
    expect(bare.rows.find((r) => r.kind === "confirm")?.payload).toMatchObject({
      date: "2026-09-09",
    });
  });

  it.each([
    ["plain text instead of tool call", say("Looks like a great memory.")],
    ["empty title", call("extract_memory", { title: "   " })],
    ["bad JSON", { ...call("extract_memory", {}), arguments: "{bad json" }],
  ])("falls through to the model loop on malformed extraction (%s)", async (_label, badOutput) => {
    gateway(badOutput);
    gateway(say("Tell me a little more and I will save it."));
    const c = chat();
    await c.send("I went to CardFest in Melbourne on 2 Nov 2026. Help me save this memory.", {
      intent: { kind: "memory" },
    });
    expect(requests).toHaveLength(2);
    expect(c.historyLoads).toBe(1);
    expect(c.rows.filter((r) => r.role === "user")).toHaveLength(1);
    expect(c.rows.find((r) => r.kind === "text")?.content).toBe(
      "Tell me a little more and I will save it.",
    );
    expect(c.rows.some((r) => r.kind === "confirm")).toBe(false);
  });

  it("falls through to chat when save_memory returns an error", async () => {
    gateway(call("extract_memory", { title: "Foreign photo memory" }));
    gateway(say("I could not attach that photo."));
    const c = chat();
    await c.send(
      "I pulled Pikachu at league night [photo_path: other/photo.jpg] Help me save this memory.",
      { intent: { kind: "memory" } },
    );
    expect(requests).toHaveLength(2);
    expect(c.rows.filter((r) => r.role === "user")).toHaveLength(1);
    expect(c.rows.some((r) => r.kind === "confirm")).toBe(false);
    expect(c.rows.find((r) => r.kind === "text")?.content).toBe("I could not attach that photo.");
  });

  it("rethrows when aborted before or during the model call instead of falling through", async () => {
    const pre = new AbortController();
    pre.abort(new DOMException("Stopped", "AbortError"));
    const c1 = chat();
    await expect(
      c1.send("I went to Sydney Card Show in Sydney on 2 Nov 2026. Help me save this memory.", {
        intent: { kind: "memory" },
        signal: pre.signal,
      }),
    ).rejects.toThrow(/Stopped|Abort/);
    expect(requests).toHaveLength(0);
    expect(c1.historyLoads).toBe(0);

    const mid = new AbortController();
    vi.mocked(fetch).mockImplementationOnce(async (_url, options) => {
      mid.abort(new DOMException("Cancelled mid-flight", "AbortError"));
      throw options?.signal?.reason ?? new DOMException("Aborted", "AbortError");
    });
    const c2 = chat();
    await expect(
      c2.send("I went to Sydney Card Show in Sydney on 2 Nov 2026. Help me save this memory.", {
        intent: { kind: "memory" },
        signal: mid.signal,
      }),
    ).rejects.toThrow(/Cancelled mid-flight|Abort/);
    expect(c2.historyLoads).toBe(0);
  });

  it("preserves an own embedded photo_path and falls through without dropping attached images", async () => {
    vi.mocked(findCards).mockResolvedValue([]);
    gateway(call("extract_memory", { title: "Card show haul" }));
    const withPath = chat();
    await withPath.send(
      "I picked up a promo in Osaka on 2 Nov 2026. [photo_path: collector/haul.jpg] Help me save this memory.",
      { intent: { kind: "memory" } },
    );
    expect(requests).toHaveLength(1);
    expect(withPath.rows.find((r) => r.kind === "confirm")?.payload).toMatchObject({
      photo_path: "collector/haul.jpg",
    });

    // Attached image data URLs are not supported in the text-only structured path: fall through with images intact.
    gateway(say("Great photo! Ready to save this memory."));
    const withImage = chat();
    await withImage.send("I pulled this at league night. Help me save this memory.", {
      intent: { kind: "memory" },
      images,
    });
    expect(requests).toHaveLength(2);
    expect(withImage.historyLoads).toBe(1);
    expect(JSON.stringify(requests[1]?.input)).toContain(images[0]);
    expect(withImage.rows.find((r) => r.kind === "text")?.content).toBe(
      "Great photo! Ready to save this memory.",
    );
  });

  it("keeps free-text memories without an intent on the normal model loop", async () => {
    gateway(
      call("save_memory", {
        title: "First booster pack",
        story: "My cousin gave me my first booster pack when I was ten.",
      }),
    );
    const c = chat();
    await c.send("My cousin gave me my first booster pack when I was ten.");
    expect(c.historyLoads).toBe(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.tools?.some((t) => t.name === "save_memory")).toBe(true);
    expect(c.rows.find((r) => r.kind === "confirm")?.payload).toMatchObject({
      tool: "save_memory",
      title: "First booster pack",
      story: "My cousin gave me my first booster pack when I was ten.",
    });
  });
});
