import type { SupabaseClient } from "@supabase/supabase-js";
import type { DB } from "./mori-context.server";

// The standalone wireframe cannot import TypeScript. Its rendered copy is checked for parity.
export const paymentLabels = {
  card: "Debit or credit card",
  crypto: "Crypto wallet",
  paypal: "PayPal",
  google_pay: "Google Pay",
} as const;
export const paymentReminder = "You have pending orders. Add a payment method to make them live.";
export function paymentConnected(count: number) {
  if (count === 0) return "Payment method connected. No pending orders needed activation.";
  if (count === 1) return "Payment method connected. One order is now live.";
  return `Payment method connected. ${count} orders are now live.`;
}

// SQL 009/010/016 are not in the generated Database types. Always pass an RLS-scoped client.
export async function saveAlertPreferences(db: DB, userId: string, push: boolean, email: boolean) {
  const { error } = await (db as unknown as SupabaseClient).from("order_settings").upsert({
    user_id: userId,
    alert_push: push,
    alert_email: email,
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
}
export async function connectPayment(db: DB, wallet: string): Promise<number> {
  if (!Object.prototype.hasOwnProperty.call(paymentLabels, wallet))
    throw new Error("Invalid payment method");
  const { data, error } = await (db as unknown as SupabaseClient).rpc("connect_order_payment", {
    p_wallet: wallet,
  });
  if (error) throw error;
  const ids: unknown = data?.activated_ids;
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string" && id.length > 0))
    throw new Error("Activation not confirmed");
  return ids.length;
}
export async function hasPendingOrders(db: DB, userId: string): Promise<boolean> {
  const { data, error } = await (db as unknown as SupabaseClient)
    .from("market_orders")
    .select("id")
    .eq("user_id", userId)
    .eq("status", "pending")
    .gt("expires_at", new Date().toISOString())
    .limit(1);
  if (error) throw error;
  return !!data?.length;
}
