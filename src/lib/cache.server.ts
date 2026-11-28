/**
 * Shared two-tier cache (in-memory first, optional Supabase `price_cache` table second) for
 * external price, FX, listing, and token lookups.
 *
 * Guarantees:
 * - Never caches failures (`{ kind: "error" }` or thrown errors).
 * - Distinguishes genuine empty results (`{ kind: "empty" }`), caching them only briefly.
 * - Deduplicates concurrent identical lookups (singleflight).
 * - Works on memory alone when `SUPABASE_SERVICE_ROLE_KEY` is absent; shared-layer read/write
 *   errors are always tolerated and never fail the caller.
 * - Optional stale-on-error fallback (used for FX last-known rates).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type CacheOutcome<T> =
  | { kind: "hit"; value: T; ttlMs?: number }
  | { kind: "empty"; value: T; ttlMs?: number }
  | { kind: "error" };

export type CacheResult<T> =
  | { ok: true; value: T; empty: boolean; stale: boolean; fromCache: boolean }
  | { ok: false; value: null; empty: false; stale: false; fromCache: false };

export type StoredEntry<T> = {
  value: T;
  empty: boolean;
  expiresAt: number;
};

export type SharedStore = {
  get<T>(key: string): Promise<StoredEntry<T> | null>;
  set<T>(key: string, entry: StoredEntry<T>): Promise<void>;
  delete?(key: string): Promise<void>;
};

const TABLE = "price_cache";
const DEFAULT_EMPTY_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 500;

type Envelope<T> = {
  v: T;
  e?: true;
};

async function adminClient(): Promise<SupabaseClient | null> {
  if (!process.env["SUPABASE_URL"] || !process.env["SUPABASE_SERVICE_ROLE_KEY"]) return null;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin as unknown as SupabaseClient;
}

const supabaseSharedStore: SharedStore = {
  async get<T>(key: string): Promise<StoredEntry<T> | null> {
    const db = await adminClient();
    if (!db) return null;
    const { data, error } = await db
      .from(TABLE)
      .select("value, expires_at")
      .eq("key", key)
      .maybeSingle();
    if (error || !data) return null;
    const row = data as { value?: unknown; expires_at?: string };
    const expiresAt = typeof row.expires_at === "string" ? Date.parse(row.expires_at) : NaN;
    if (!Number.isFinite(expiresAt)) return null;
    const env = row.value as Envelope<T> | null;
    if (!env || typeof env !== "object" || !("v" in env)) return null;
    return { value: env.v, empty: env.e === true, expiresAt };
  },
  async set<T>(key: string, entry: StoredEntry<T>): Promise<void> {
    const db = await adminClient();
    if (!db) return;
    const payload: Envelope<T> = entry.empty ? { v: entry.value, e: true } : { v: entry.value };
    const { error } = await db.from(TABLE).upsert(
      {
        key,
        value: payload,
        expires_at: new Date(entry.expiresAt).toISOString(),
      },
      { onConflict: "key" },
    );
    if (error) throw error;
  },
  async delete(key: string): Promise<void> {
    const db = await adminClient();
    if (!db) return;
    const { error } = await db.from(TABLE).delete().eq("key", key);
    if (error) throw error;
  },
};

export type CacheOptions = {
  /** Prefix added to shared-store keys so different providers never collide. */
  namespace: string;
  /** Default TTL for non-empty hits in milliseconds. */
  ttlMs: number;
  /** Short TTL for genuine empty results in milliseconds (default 10 minutes). */
  emptyTtlMs?: number;
  /** Use the optional Supabase shared layer when service-role credentials exist (default true). */
  shared?: boolean;
  /** Maximum entries retained in the process-local Map (default 500). */
  maxEntries?: number;
  /** Return the last known non-empty value if loading fails (used for FX). */
  allowStaleOnError?: boolean;
  /** Custom shared store override (primarily for tests). */
  store?: SharedStore | null;
};

export type Cache<T> = {
  getOrLoad(
    key: string,
    loader: () => Promise<CacheOutcome<T>>,
    opts?: { now?: number },
  ): Promise<CacheResult<T>>;
  delete(key: string): Promise<void>;
  clear(): void;
};

export function createCache<T>(options: CacheOptions): Cache<T> {
  const {
    namespace,
    ttlMs,
    emptyTtlMs = DEFAULT_EMPTY_TTL_MS,
    shared = true,
    maxEntries = DEFAULT_MAX_ENTRIES,
    allowStaleOnError = false,
    store: customStore,
  } = options;

  const mem = new Map<string, StoredEntry<T>>();
  const inFlight = new Map<string, Promise<CacheResult<T>>>();
  const sharedStore: SharedStore | null =
    customStore !== undefined ? customStore : shared ? supabaseSharedStore : null;

  const fullKey = (key: string) => `${namespace}:${key}`;

  const writeMem = (key: string, entry: StoredEntry<T>) => {
    if (mem.has(key)) mem.delete(key);
    else if (mem.size >= maxEntries) {
      const oldest = mem.keys().next().value;
      if (oldest !== undefined) mem.delete(oldest);
    }
    mem.set(key, entry);
  };

  async function getOrLoad(
    key: string,
    loader: () => Promise<CacheOutcome<T>>,
    opts?: { now?: number },
  ): Promise<CacheResult<T>> {
    const now = opts?.now ?? Date.now();
    const memEntry = mem.get(key);
    if (memEntry && now < memEntry.expiresAt) {
      return {
        ok: true,
        value: memEntry.value,
        empty: memEntry.empty,
        stale: false,
        fromCache: true,
      };
    }

    const existing = inFlight.get(key);
    if (existing) return existing;

    const work = (async (): Promise<CacheResult<T>> => {
      let sharedStale: StoredEntry<T> | null = null;
      if (sharedStore) {
        try {
          const row = await sharedStore.get<T>(fullKey(key));
          if (row) {
            if (now < row.expiresAt) {
              writeMem(key, row);
              return {
                ok: true,
                value: row.value,
                empty: row.empty,
                stale: false,
                fromCache: true,
              };
            }
            if (!row.empty) sharedStale = row;
          }
        } catch (e) {
          console.error(
            `[cache:${namespace}] shared read failed`,
            e instanceof Error ? e.message : e,
          );
        }
      }

      let outcome: CacheOutcome<T>;
      try {
        outcome = await loader();
      } catch (e) {
        console.error(`[cache:${namespace}] loader failed`, e instanceof Error ? e.message : e);
        outcome = { kind: "error" };
      }

      if (outcome.kind === "hit" || outcome.kind === "empty") {
        const isEmpty = outcome.kind === "empty";
        const ttl = outcome.ttlMs ?? (isEmpty ? emptyTtlMs : ttlMs);
        if (ttl > 0) {
          const entry: StoredEntry<T> = {
            value: outcome.value,
            empty: isEmpty,
            expiresAt: now + ttl,
          };
          writeMem(key, entry);
          if (sharedStore) {
            try {
              await sharedStore.set(fullKey(key), entry);
            } catch (e) {
              console.error(
                `[cache:${namespace}] shared write failed`,
                e instanceof Error ? e.message : e,
              );
            }
          }
        }
        return {
          ok: true,
          value: outcome.value,
          empty: isEmpty,
          stale: false,
          fromCache: false,
        };
      }

      if (allowStaleOnError) {
        const stale =
          memEntry && !memEntry.empty
            ? memEntry
            : sharedStale && !sharedStale.empty
              ? sharedStale
              : null;
        if (stale) {
          return {
            ok: true,
            value: stale.value,
            empty: false,
            stale: true,
            fromCache: true,
          };
        }
      }

      return { ok: false, value: null, empty: false, stale: false, fromCache: false };
    })();

    inFlight.set(key, work);
    try {
      return await work;
    } finally {
      inFlight.delete(key);
    }
  }

  async function del(key: string): Promise<void> {
    mem.delete(key);
    if (sharedStore?.delete) {
      try {
        await sharedStore.delete(fullKey(key));
      } catch (e) {
        console.error(
          `[cache:${namespace}] shared delete failed`,
          e instanceof Error ? e.message : e,
        );
      }
    }
  }

  function clear(): void {
    mem.clear();
    inFlight.clear();
  }

  return { getOrLoad, delete: del, clear };
}
