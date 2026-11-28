/**
 * Bounds serialized tool results sent back to the model and stored in `mori_messages` so oversized
 * payloads always remain valid JSON. Trims the largest arrays first, then oversized strings, and
 * marks `{ truncated: true }`.
 */

const DEFAULT_MAX_CHARS = 8_000;
const MIN_STRING_LEN = 32;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

type ArrayLoc = { arr: unknown[]; size: number };
type StringLoc = { parent: Record<string, unknown> | unknown[]; key: string | number; len: number };

function findLargestArray(node: unknown): ArrayLoc | null {
  let best: ArrayLoc | null = null;
  const visit = (v: unknown) => {
    if (Array.isArray(v)) {
      if (v.length > 0) {
        const size = JSON.stringify(v).length;
        if (!best || size > best.size) best = { arr: v, size };
      }
      for (const item of v) visit(item);
      return;
    }
    if (isPlainObject(v)) {
      for (const val of Object.values(v)) visit(val);
    }
  };
  visit(node);
  return best;
}

function findLongestString(node: unknown): StringLoc | null {
  let best: StringLoc | null = null;
  const visit = (v: unknown) => {
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        const item = v[i];
        if (typeof item === "string") {
          if (item.length > MIN_STRING_LEN && (!best || item.length > best.len)) {
            best = { parent: v, key: i, len: item.length };
          }
        } else {
          visit(item);
        }
      }
      return;
    }
    if (isPlainObject(v)) {
      for (const [k, val] of Object.entries(v)) {
        if (typeof val === "string") {
          if (val.length > MIN_STRING_LEN && (!best || val.length > best.len)) {
            best = { parent: v, key: k, len: val.length };
          }
        } else {
          visit(val);
        }
      }
    }
  };
  visit(node);
  return best;
}

/**
 * Serializes a tool result into valid JSON of at most `maxChars` characters.
 * Returns the exact `JSON.stringify(value ?? null)` untouched when already within budget.
 */
export function serializeToolResult(value: unknown, maxChars = DEFAULT_MAX_CHARS): string {
  const raw = JSON.stringify(value ?? null);
  if (raw.length <= maxChars) return raw;

  const parsed: unknown = JSON.parse(raw);

  // Ensure the root is an object so `truncated: true` can always be recorded cleanly.
  let root: Record<string, unknown>;
  if (Array.isArray(parsed)) {
    root = { results: parsed, total_items: parsed.length, truncated: true };
  } else if (isPlainObject(parsed)) {
    root = { ...parsed, truncated: true };
  } else {
    root = { value: parsed, truncated: true };
  }

  let json = JSON.stringify(root);
  if (json.length <= maxChars) return json;

  // Phase 1: trim the largest arrays first, preserving as many leading items as fit.
  while (json.length > maxChars) {
    const target = findLargestArray(root);
    if (!target || target.arr.length === 0) break;

    const snapshot = target.arr.slice();
    const prevLen = snapshot.length;
    const nextLen = prevLen > 1 ? Math.floor(prevLen / 2) : 0;
    target.arr.length = nextLen;
    json = JSON.stringify(root);

    // If halving brought the payload under budget, binary-search between nextLen and prevLen to
    // keep the maximum number of items from this array that still fit.
    if (json.length <= maxChars && prevLen - nextLen > 1) {
      let lo = nextLen;
      let hi = prevLen - 1;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        target.arr.splice(0, target.arr.length, ...snapshot.slice(0, mid));
        if (JSON.stringify(root).length <= maxChars) {
          lo = mid;
        } else {
          hi = mid - 1;
        }
      }
      target.arr.splice(0, target.arr.length, ...snapshot.slice(0, lo));
      json = JSON.stringify(root);
      break;
    }
  }

  // Phase 2: trim the longest strings (e.g. a single large web page body).
  while (json.length > maxChars) {
    const target = findLongestString(root);
    if (!target) break;
    const current = (target.parent as Record<string | number, unknown>)[target.key] as string;
    const nextLen = Math.max(MIN_STRING_LEN - 1, Math.floor(current.length / 2));
    (target.parent as Record<string | number, unknown>)[target.key] =
      `${current.slice(0, nextLen)}…`;
    json = JSON.stringify(root);
  }

  // Phase 3: drop the largest non-essential top-level keys if an object is still too wide.
  while (json.length > maxChars) {
    let largestKey: string | null = null;
    let largestSize = -1;
    for (const [k, v] of Object.entries(root)) {
      if (k === "truncated") continue;
      const sz = JSON.stringify(v).length;
      if (sz > largestSize) {
        largestSize = sz;
        largestKey = k;
      }
    }
    if (!largestKey) break;
    delete root[largestKey];
    json = JSON.stringify(root);
  }

  if (json.length <= maxChars) return json;
  return JSON.stringify({ truncated: true });
}
