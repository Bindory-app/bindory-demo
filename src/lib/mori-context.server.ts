import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/types";

export type DB = SupabaseClient<Database>;
export type Args = Record<string, unknown>;
export type MoriRowDraft = { role: "mori"; kind: string; content: string; payload?: Json };

export const stringArg = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export const asObject = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
