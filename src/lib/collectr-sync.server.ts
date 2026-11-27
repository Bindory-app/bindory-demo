/**
 * Collectr sync on the "Collection sync" harness (feature "collectr" in harnessrouter.json).
 * A task can take minutes, so it runs in the background: the chat row (kind "sync") holds the
 * response id and session id, signed for the collector, and the browser asks /api/mori-sync for
 * progress until it is done. Approved cards are added by Bindory itself, under the collector's RLS.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/types";
import {
  answerText,
  downloadFile,
  getResponse,
  harnessIdForFeature,
  isTerminal,
  responseFiles,
  startBackgroundTask,
  type HRResponse,
} from "./harnessrouter.server";
import { collectrTaskInput, syncAnswerText, syncItems, type SyncItem } from "./collectr";
import { isOwnTask, signTask } from "./mori-signing.server";
import { findCards, getCard, cardImage } from "./tcgdex";

type DB = SupabaseClient<Database>;
export type SyncState = {
  response_id: string;
  session_id: string;
  sig: string;
  status: string;
  binder?: { name: string; new: boolean } | null;
  files?: { filename: string; file_id: string }[];
  items?: SyncItem[];
  applied?: { added: number; already: number; unmatched: string[] } | null;
  progress?: string;
};

const asObj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Starts the task and saves its row; a follow-up continues the earlier task. */
export async function startSync(
  db: DB,
  userId: string,
  input:
    | { link: string; binder: { name: string; new: boolean } | null }
    | { followUp: string; prior: SyncState },
) {
  let task: string;
  let prior: SyncState | null = null;
  let binder: { name: string; new: boolean } | null = null;
  if ("link" in input) {
    const { data: owned, error } = await db
      .from("cards")
      .select("name, number, set_name")
      .limit(400);
    if (error) throw error;
    task = collectrTaskInput(input.link, input.binder, owned ?? []);
    binder = input.binder;
  } else {
    prior = input.prior;
    binder = prior.binder ?? null;
    task = `${input.followUp}\n\n(Reminder: Bindory adds approved cards itself. End with the json block of bindory_items you now propose to add.)`;
  }
  const r = await startBackgroundTask({
    harnessId: harnessIdForFeature("collectr"),
    input: task,
    user: userId,
    previousResponseId: prior?.response_id,
    sessionId: prior?.session_id,
  });
  const sessionId = String(r.metadata?.session_id ?? prior?.session_id ?? "");
  const sync: SyncState = {
    response_id: r.id,
    session_id: sessionId,
    sig: signTask(userId, r.id, sessionId),
    status: r.status || "queued",
    binder,
  };
  return {
    role: "mori" as const,
    kind: "sync",
    content: "Reading your Collectr collection. This can take a few minutes.",
    payload: { sync } as unknown as Json,
  };
}

/** Where a running task has got to, in a few words, from its latest tool step. */
function progressOf(r: HRResponse): string {
  const steps = (r.output ?? []).filter(
    (i) => i.type === "function_call" || i.type === "web_search_call",
  );
  const last = steps[steps.length - 1]?.name ?? "";
  if (!steps.length) return "Reading your Collectr collection";
  if (/browser|navigate|page|click|scroll|snapshot/i.test(last))
    return `Reading the Collectr page (step ${steps.length})`;
  return `Working (step ${steps.length})`;
}

async function loadSync(db: DB, userId: string, id: string) {
  const { data, error } = await db
    .from("mori_messages")
    .select("id, content, payload, kind")
    .eq("id", id)
    .eq("kind", "sync")
    .single();
  if (error || !data) return null;
  const sync = asObj(asObj(data.payload)["sync"]) as unknown as SyncState;
  if (!sync.response_id || !isOwnTask(userId, sync.response_id, sync.session_id, sync.sig))
    return null;
  return { row: data, sync };
}

/** The task's state for the browser (never ids or download links). Saves the result once done. */
export async function syncStatus(db: DB, userId: string, id: string) {
  const got = await loadSync(db, userId, id);
  if (!got) return null;
  let { sync } = got;
  let content = got.row.content;
  if (!isTerminal(sync.status)) {
    const r = await getResponse(sync.response_id);
    if (isTerminal(r.status)) {
      const answer = answerText(r);
      const files = (await responseFiles(r))
        .filter((f) => f.file_id && f.filename)
        .map((f) => ({ filename: f.filename!, file_id: f.file_id! }));
      sync = {
        ...sync,
        status: r.status,
        session_id: sync.session_id || String(r.metadata?.session_id ?? ""),
        files,
        items: syncItems(answer),
        progress: "",
      };
      sync.sig = signTask(userId, sync.response_id, sync.session_id);
      content =
        syncAnswerText(answer) ||
        (r.status === "completed"
          ? "The sync finished without a result."
          : "The sync could not finish. Please try again in a moment.");
      const { error } = await db
        .from("mori_messages")
        .update({ content, payload: { sync } as unknown as Json })
        .eq("id", id);
      if (error) throw error;
    } else {
      sync = { ...sync, status: r.status, progress: progressOf(r) };
    }
  }
  return {
    status: sync.status,
    done: isTerminal(sync.status),
    progress: sync.progress ?? "",
    content: isTerminal(sync.status) ? content : "",
    files: (sync.files ?? []).map((f, n) => ({ n, filename: f.filename })),
    items: (sync.items ?? []).length,
    binder: sync.binder?.name ?? null,
    applied: sync.applied ?? null,
  };
}

/** One of the agent's files, downloaded with the key and passed through. */
export async function syncFile(db: DB, userId: string, id: string, n: number) {
  const got = await loadSync(db, userId, id);
  const f = got?.sync.files?.[n];
  if (!got || !f || !got.sync.session_id) return null;
  const url = `https://api.harnessrouter.ai/v1/containers/${encodeURIComponent(got.sync.session_id)}/files/${encodeURIComponent(f.file_id)}/content`;
  const res = await downloadFile(url);
  return { res, filename: f.filename.split("/").pop() || "file" };
}

/** Adds the approved cards: each matched to exactly one catalogue printing, into the binder. */
export async function applySync(db: DB, userId: string, id: string) {
  const got = await loadSync(db, userId, id);
  if (!got || got.sync.status !== "completed") return null;
  if (got.sync.applied) return got.sync.applied;
  const items = (got.sync.items ?? []).slice(0, 100);
  const unmatched: string[] = [];
  let added = 0;
  let already = 0;
  // The binder: one of the collector's own by name, or a new one.
  let binderId: string | null = null;
  if (got.sync.binder) {
    const { data: mine } = await db.from("binders").select("id, name");
    const same = (mine ?? []).find(
      (b) => b.name.trim().toLowerCase() === got.sync.binder!.name.toLowerCase(),
    );
    if (same) binderId = same.id;
    else {
      const made = await db
        .from("binders")
        .insert({ user_id: userId, name: got.sync.binder.name })
        .select("id")
        .single();
      if (made.error) throw made.error;
      binderId = made.data.id;
    }
  }
  let position = binderId
    ? ((
        await db
          .from("binder_cards")
          .select("id", { count: "exact", head: true })
          .eq("binder_id", binderId)
      ).count ?? 0)
    : 0;
  for (const it of items) {
    const label = `${it.name}${it.number ? ` ${it.number}` : ""}`;
    // Japanese printings are not in the English catalogue: never match them to an English card.
    if (/\(JP\)|\bjapanese\b/i.test(`${it.name} ${it.set ?? ""}`)) {
      unmatched.push(label);
      continue;
    }
    // Collectr adds notes in brackets ("Mewtwo EX (163 Secret Full Art)"); the catalogue name has none.
    const name = it.name.replace(/\s*\([^)]*\)/g, "").trim() || it.name;
    const matches = await findCards(name, it.number, it.set).catch(() => []);
    if (matches.length !== 1 || !it.number) {
      unmatched.push(label);
      continue;
    }
    const c = await getCard(matches[0]!.id).catch(() => null);
    if (!c) {
      unmatched.push(label);
      continue;
    }
    let { data: have } = await db.from("cards").select("id").eq("tcgdex_id", c.id).limit(1);
    let cardRow = have?.[0]?.id;
    if (cardRow) already++;
    else {
      const ins = await db
        .from("cards")
        .insert({
          user_id: userId,
          tcgdex_id: c.id,
          name: c.name,
          set_name: c.set.name,
          set_id: c.set.id,
          number: c.localId,
          image_url: cardImage(c.image, "high") ?? null,
          illustrator: c.illustrator ?? null,
          rarity: c.rarity ?? null,
        })
        .select("id")
        .single();
      if (ins.error) {
        unmatched.push(label);
        continue;
      }
      cardRow = ins.data.id;
      added++;
    }
    if (binderId && cardRow) {
      ({ data: have } = await db
        .from("binder_cards")
        .select("id")
        .eq("binder_id", binderId)
        .eq("card_id", cardRow)
        .limit(1));
      if (!have?.length) {
        await db
          .from("binder_cards")
          .insert({ user_id: userId, binder_id: binderId, card_id: cardRow, position: position++ });
      }
    }
  }
  const applied = { added, already, unmatched: unmatched.slice(0, 50) };
  const sync = { ...got.sync, applied };
  await db
    .from("mori_messages")
    .update({ payload: { sync } as unknown as Json })
    .eq("id", id);
  return applied;
}

/** The newest sync task in this chat, for follow-ups ("only the first 20", "go ahead"). */
export async function latestSync(db: DB, userId: string, since?: string) {
  let q = db.from("mori_messages").select("id, kind, payload, created_at").eq("role", "mori");
  if (since) q = q.gt("created_at", since);
  const { data } = await q.order("created_at", { ascending: false }).limit(1);
  const row = data?.[0];
  if (!row || row.kind !== "sync") return null;
  const sync = asObj(asObj(row.payload)["sync"]) as unknown as SyncState;
  if (!isTerminal(sync.status) || !isOwnTask(userId, sync.response_id, sync.session_id, sync.sig))
    return null;
  return sync;
}
