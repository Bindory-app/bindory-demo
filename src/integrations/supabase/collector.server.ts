import { createHmac } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { createSupabaseFetch } from "./client.server";
import type { Database } from "./types";

/** Server only. The caller must establish the collector from a verified channel binding,
 * never an inbound user-id parameter. The database still applies authenticated-owner RLS. */
export function collectorClient(userId: string) {
  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_PUBLISHABLE_KEY"];
  const secret = process.env["SUPABASE_JWT_SECRET"];
  const kid = process.env["SUPABASE_JWT_KID"]?.trim();
  if (!url || !key || key.startsWith("sb_secret_") || !secret || secret.trim().length < 32)
    throw new Error("Collector access is not configured");
  if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(userId))
    throw new Error("Invalid collector id");
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const iat = Math.floor(Date.now() / 1000);
  const payload = encode({
    sub: userId,
    role: "authenticated",
    aud: "authenticated",
    iat,
    exp: iat + 300,
  });
  const unsigned = encode({ alg: "HS256", typ: "JWT", ...(kid ? { kid } : {}) }) + "." + payload;
  const jwt = unsigned + "." + createHmac("sha256", secret).update(unsigned).digest("base64url");
  return createClient<Database>(url, key, {
    global: { headers: { Authorization: "Bearer " + jwt }, fetch: createSupabaseFetch(key) },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
