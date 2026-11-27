/**
 * Trust between Mori's server and its MCP tool endpoint (src/routes/api/mori-mcp.ts), which the
 * HarnessRouter "Ask Mori" harness calls. Everything derives from one server secret,
 * MORI_MCP_SECRET, which never leaves this app:
 *
 * - bearer: the token HarnessRouter sends to the endpoint (stored there as an MCP secret), so only
 *   that harness can call the tools.
 * - user token: per task, the collector's own Supabase session sealed with AES-256-GCM. HarnessRouter
 *   only relays the ciphertext (X-Mori-User header); the endpoint opens it and queries with the
 *   collector's session, so Row Level Security stays the authorization boundary.
 * - signed rows: chat cards a tool produced (confirmation, pre-grade report, ...) travel back
 *   through the agent's tool output; the signature proves they came from this endpoint and for
 *   this collector before Mori's server saves them.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { deriveMoriKey, moriSecret, sameText } from "./mori-signing.server";

const SEAL_TTL_SECONDS = 600;
const ROWS_MARKER = "MORI_ROWS ";

const b64 = (b: Buffer) => b.toString("base64url");

/** The bearer HarnessRouter sends; computed the same way it was stored (HMAC of a fixed label). */
export function mcpBearer(): string {
  return createHmac("sha256", moriSecret()).update("mori-mcp:harnessrouter-bearer").digest("base64url");
}
export function isHarnessBearer(authorization: string | null): boolean {
  const m = /^Bearer\s+(\S+)$/i.exec(authorization ?? "");
  return Boolean(m?.[1]) && sameText(m![1]!, mcpBearer());
}

function jwtExpiry(jwt: string): number | undefined {
  try {
    const claims = JSON.parse(
      Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8"),
    ) as {
      exp?: unknown;
    };
    return typeof claims.exp === "number" ? claims.exp : undefined;
  } catch {
    return undefined;
  }
}

type CollectorSession = { userId: string; accessToken: string };

/** Seals the collector's session for one task; expires with the session or after 10 minutes. */
export function sealCollector(s: CollectorSession, now = Date.now()): string {
  const exp = Math.min(
    Math.floor(now / 1000) + SEAL_TTL_SECONDS,
    jwtExpiry(s.accessToken) ?? Infinity,
  );
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveMoriKey("mori-mcp:seal"), iv);
  const body = Buffer.concat([
    cipher.update(JSON.stringify({ u: s.userId, t: s.accessToken, e: exp }), "utf8"),
    cipher.final(),
  ]);
  return b64(Buffer.concat([iv, body, cipher.getAuthTag()]));
}

/** The collector's session from a sealed token, or null when it is forged, altered or expired. */
export function openCollector(token: string | null, now = Date.now()): CollectorSession | null {
  if (!token || token.length > 8192) return null;
  try {
    const raw = Buffer.from(token, "base64url");
    if (raw.length < 12 + 16 + 1) return null;
    const decipher = createDecipheriv("aes-256-gcm", deriveMoriKey("mori-mcp:seal"), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    const text = Buffer.concat([
      decipher.update(raw.subarray(12, raw.length - 16)),
      decipher.final(),
    ]);
    const p = JSON.parse(text.toString("utf8")) as { u?: unknown; t?: unknown; e?: unknown };
    if (typeof p.u !== "string" || typeof p.t !== "string" || typeof p.e !== "number") return null;
    if (p.e * 1000 < now) return null;
    return { userId: p.u, accessToken: p.t };
  } catch {
    return null;
  }
}

/** One line a tool result ends with, carrying the chat cards it produced, signed for this collector. */
export function signRows(userId: string, rows: unknown[]): string {
  const body = b64(Buffer.from(JSON.stringify({ u: userId, r: rows }), "utf8"));
  const sig = createHmac("sha256", deriveMoriKey("mori-mcp:rows")).update(body).digest("base64url");
  return `${ROWS_MARKER}${body}.${sig}`;
}

/** Every genuine row block for this collector found in a tool output; anything else is ignored. */
export function readSignedRows(output: string, userId: string): unknown[] {
  const rows: unknown[] = [];
  const key = deriveMoriKey("mori-mcp:rows");
  for (const m of output.matchAll(/MORI_ROWS ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})/g)) {
    const [, body, sig] = m;
    if (!body || !sig) continue;
    if (!sameText(createHmac("sha256", key).update(body).digest("base64url"), sig)) continue;
    try {
      const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as {
        u?: unknown;
        r?: unknown;
      };
      if (p.u === userId && Array.isArray(p.r)) rows.push(...(p.r as unknown[]));
    } catch {
      /* not ours */
    }
  }
  return rows;
}

/** Removes row blocks from text, in case the agent repeats one. */
export const stripRowBlocks = (text: string) =>
  text.replace(/MORI_ROWS [A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}/g, "").trim();
