import { asObject, type DB } from "./mori-context.server";

function dataUrlBytes(url: string): { bytes: Uint8Array; type: string } | null {
  const m = /^data:([\w/+.-]+);base64,(.+)$/s.exec(url);
  return m?.[1] && m[2] ? { bytes: Buffer.from(m[2], "base64"), type: m[1] } : null;
}

/** Saves the collector's front and back photos for a sell order in their own private folder
 *  (owner-only storage rules), so the order and its marketplace listing can use them. */
export async function saveOrderPhotos(db: DB, userId: string, images: string[]) {
  const parts = images.slice(0, 2).map(dataUrlBytes);
  if (parts.length < 2 || parts.some((x) => !x)) return null;
  const id = crypto.randomUUID();
  const paths = {
    front: `${userId}/orders/${id}-front.jpg`,
    back: `${userId}/orders/${id}-back.jpg`,
  };
  const bucket = db.storage.from("memory-photos");
  for (const [i, path] of [paths.front, paths.back].entries()) {
    const img = parts[i]!;
    const { error } = await bucket.upload(path, img.bytes, {
      contentType: img.type,
      upsert: false,
    });
    if (error) {
      console.error("Order photo upload failed", error.message);
      return null;
    }
  }
  return paths;
}

/** The latest order photos saved in this chat, if any. */
export async function chatPhotos(db: DB, userId: string, since?: string) {
  let q = db
    .from("mori_messages")
    .select("payload")
    .eq("role", "mori")
    .eq("kind", "status")
    .not("payload->photos", "is", null);
  if (since) q = q.gt("created_at", since);
  const { data } = await q.order("created_at", { ascending: false }).limit(1).maybeSingle();
  const ph = asObject(asObject(data?.payload)["photos"]);
  const ok = (v: unknown): v is string =>
    typeof v === "string" && v.startsWith(`${userId}/orders/`) && !v.includes("..");
  return ok(ph["front"]) && ok(ph["back"]) ? { front: ph["front"], back: ph["back"] } : null;
}
