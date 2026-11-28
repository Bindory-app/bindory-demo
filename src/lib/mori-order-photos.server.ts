import type { DB } from "./mori-context.server";

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
  const uploaded: string[] = [];
  const cleanup = async () => {
    if (!uploaded.length || typeof bucket.remove !== "function") return;
    await bucket.remove(uploaded).catch((err: unknown) => {
      console.error("Order photo cleanup failed", err instanceof Error ? err.message : err);
    });
  };
  try {
    for (const [i, path] of [paths.front, paths.back].entries()) {
      const img = parts[i]!;
      const { error } = await bucket.upload(path, img.bytes, {
        contentType: img.type,
        upsert: false,
      });
      if (error) {
        console.error("Order photo upload failed", error.message);
        await cleanup();
        return null;
      }
      uploaded.push(path);
    }
  } catch (err) {
    console.error("Order photo upload failed", err instanceof Error ? err.message : err);
    await cleanup();
    return null;
  }
  return paths;
}
