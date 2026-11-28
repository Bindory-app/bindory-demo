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
  try {
    for (const [i, path] of [paths.front, paths.back].entries()) {
      const img = parts[i]!;
      const { error } = await bucket.upload(path, img.bytes, {
        contentType: img.type,
        upsert: false,
      });
      if (error) throw error;
    }
  } catch {
    // A transport failure can occur after storage accepted a file. These two new paths are
    // unique to this attempt; do not leave a partial listing or affect another submission.
    console.warn("Could not save the order photo pair");
    try {
      const { error } = await bucket.remove([paths.front, paths.back]);
      if (error) console.warn("Could not remove incomplete order photos");
    } catch {
      console.warn("Could not remove incomplete order photos");
    }
    return null;
  }
  return paths;
}
