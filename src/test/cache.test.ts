import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCache, type SharedStore, type StoredEntry } from "@/lib/cache.server";
import { ebaySoldPricesLookup, resetSilphcoCacheForTest } from "@/lib/silphco.server";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-27T12:00:00Z"));
  resetSilphcoCacheForTest(null);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env["SILPHCO_API_KEY"];
});

function memorySharedStore(): SharedStore & { data: Map<string, StoredEntry<unknown>> } {
  const data = new Map<string, StoredEntry<unknown>>();
  return {
    data,
    async get<T>(key: string) {
      return (data.get(key) as StoredEntry<T> | undefined) ?? null;
    },
    async set<T>(key: string, entry: StoredEntry<T>) {
      data.set(key, entry);
    },
    async delete(key: string) {
      data.delete(key);
    },
  };
}

describe("shared cache helper", () => {
  it("never caches loader errors or thrown exceptions", async () => {
    const store = memorySharedStore();
    const cache = createCache<string>({
      namespace: "test",
      ttlMs: 60_000,
      emptyTtlMs: 5_000,
      store,
    });

    let calls = 0;
    const r1 = await cache.getOrLoad("k1", async () => {
      calls++;
      return { kind: "error" };
    });
    expect(r1.ok).toBe(false);
    expect(store.data.size).toBe(0);

    const r2 = await cache.getOrLoad("k1", async () => {
      calls++;
      throw new Error("boom");
    });
    expect(r2.ok).toBe(false);
    expect(store.data.size).toBe(0);

    const r3 = await cache.getOrLoad("k1", async () => {
      calls++;
      return { kind: "hit", value: "recovered" };
    });
    expect(r3).toMatchObject({ ok: true, value: "recovered", empty: false, fromCache: false });
    expect(calls).toBe(3);
  });

  it("caches genuine empty results only for the short emptyTtlMs", async () => {
    const cache = createCache<string | null>({
      namespace: "empty-test",
      ttlMs: 6 * 60 * 60 * 1000,
      emptyTtlMs: 10 * 60 * 1000,
      store: null,
    });

    let calls = 0;
    const loader = async () => {
      calls++;
      return { kind: "empty" as const, value: null };
    };

    const r1 = await cache.getOrLoad("card-1", loader);
    expect(r1).toMatchObject({ ok: true, value: null, empty: true, fromCache: false });
    expect(calls).toBe(1);

    // Still cached after 9 minutes.
    vi.advanceTimersByTime(9 * 60 * 1000);
    const r2 = await cache.getOrLoad("card-1", loader);
    expect(r2).toMatchObject({ ok: true, value: null, empty: true, fromCache: true });
    expect(calls).toBe(1);

    // Expired after 10 minutes (well before the 6h hit TTL).
    vi.advanceTimersByTime(2 * 60 * 1000);
    const r3 = await cache.getOrLoad("card-1", loader);
    expect(r3).toMatchObject({ ok: true, value: null, empty: true, fromCache: false });
    expect(calls).toBe(2);
  });

  it("deduplicates concurrent identical lookups to a single upstream call", async () => {
    const cache = createCache<number>({
      namespace: "dedupe",
      ttlMs: 60_000,
      store: null,
    });

    let calls = 0;
    let resolveLoader!: (v: number) => void;
    const loader = () => {
      calls++;
      return new Promise<{ kind: "hit"; value: number }>((resolve) => {
        resolveLoader = (value) => resolve({ kind: "hit", value });
      });
    };

    const p1 = cache.getOrLoad("same", loader);
    const p2 = cache.getOrLoad("same", loader);
    const p3 = cache.getOrLoad("same", loader);

    expect(calls).toBe(1);
    resolveLoader(42);
    const results = await Promise.all([p1, p2, p3]);
    expect(results.map((r) => r.value)).toEqual([42, 42, 42]);
    expect(calls).toBe(1);
  });

  it("shares entries across instances and tolerates shared-layer failures without failing callers", async () => {
    const shared = memorySharedStore();
    const instanceA = createCache<number>({ namespace: "shared", ttlMs: 60_000, store: shared });
    const instanceB = createCache<number>({ namespace: "shared", ttlMs: 60_000, store: shared });

    const a = await instanceA.getOrLoad("sv1-1", async () => ({ kind: "hit", value: 123 }));
    expect(a).toMatchObject({ ok: true, value: 123, fromCache: false });

    const bLoader = vi.fn(async () => ({ kind: "hit" as const, value: 999 }));
    const b = await instanceB.getOrLoad("sv1-1", bLoader);
    expect(b).toMatchObject({ ok: true, value: 123, fromCache: true });
    expect(bLoader).not.toHaveBeenCalled();

    // Failing shared store never breaks reads or writes.
    const brokenStore: SharedStore = {
      async get() {
        throw new Error("supabase read down");
      },
      async set() {
        throw new Error("supabase write down");
      },
      async delete() {
        throw new Error("supabase delete down");
      },
    };
    const resilient = createCache<string>({
      namespace: "resilient",
      ttlMs: 60_000,
      store: brokenStore,
    });
    const r = await resilient.getOrLoad("x", async () => ({ kind: "hit", value: "still-works" }));
    expect(r).toMatchObject({ ok: true, value: "still-works", fromCache: false });
    // Second call hits memory cleanly even though shared store is broken.
    const r2 = await resilient.getOrLoad("x", async () => ({ kind: "hit", value: "unused" }));
    expect(r2).toMatchObject({ ok: true, value: "still-works", fromCache: true });
    await expect(resilient.delete("x")).resolves.toBeUndefined();
  });

  it("distinguishes SilphCo HTTP errors (uncached) from genuine empty responses (briefly cached)", async () => {
    process.env["SILPHCO_API_KEY"] = "test-key";
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        if (calls <= 2) return new Response("bad gateway", { status: 502 });
        return new Response(
          JSON.stringify({
            contract: "price.v2",
            data: { results: [{ status: "none" }, { status: "none" }, { status: "none" }] },
          }),
          { status: 200 },
        );
      }),
    );

    const p1 = ebaySoldPricesLookup("sv1-99");
    await vi.advanceTimersByTimeAsync(2_000);
    const errRes = await p1;
    expect(errRes.status).toBe("error");
    expect(calls).toBe(2); // 1 initial + 1 retry

    // Error was NOT cached: immediate next call hits SilphCo and gets genuine empty.
    const emptyRes1 = await ebaySoldPricesLookup("sv1-99");
    expect(emptyRes1.status).toBe("empty");
    expect(calls).toBe(3);

    // Genuine empty IS cached briefly (15 min), so 10 min later does not refetch.
    vi.advanceTimersByTime(10 * 60 * 1000);
    const emptyRes2 = await ebaySoldPricesLookup("sv1-99");
    expect(emptyRes2.status).toBe("empty");
    expect(calls).toBe(3);

    // After 15 min empty TTL expires, it refetches.
    vi.advanceTimersByTime(6 * 60 * 1000);
    const emptyRes3 = await ebaySoldPricesLookup("sv1-99");
    expect(emptyRes3.status).toBe("empty");
    expect(calls).toBe(4);
  });
});
