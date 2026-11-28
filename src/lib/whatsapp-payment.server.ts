import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { collectorClient } from "@/integrations/supabase/collector.server";
import { connectPayment, paymentConnected, paymentLabels } from "./mori-order-payment.server";
import { whatsappNonce } from "./mori-signing.server";
import { paymentLink, setStep } from "./whatsapp-state.server";
import { boundedBytes, sendWhatsApp } from "./whatsapp-cloud.server";
import { textMessage } from "./whatsapp-render";

// The bearer capability lives in the fragment (never in the request URL or Referer).
// POST view only renders the form; only its explicit Connect submit activates orders.
const bootstrap =
  "const f=document.forms[0];f.elements.token.value=location.hash.slice(1);history.replaceState(null,'',location.pathname);f.submit();";
const headers = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy":
    "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'sha256-" +
    createHash("sha256").update(bootstrap).digest("base64") +
    "'",
};
function page(html: string, status = 200) {
  return new Response(
    '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect a payment method</title><main><h1>Connect a payment method</h1>' +
      html +
      "</main></html>",
    { status, headers },
  );
}
export function paymentLanding() {
  return page(
    '<form method="post"><input type="hidden" name="action" value="view"><input type="hidden" name="token"></form><noscript>Open this link with JavaScript enabled.</noscript><script>' +
      bootstrap +
      "</script>",
  );
}
// The one HTTPS origin payment links point at. Checked against the browser's Origin rather than
// the request URL, which reports http behind a TLS-terminating proxy or tunnel.
export function paymentOrigin() {
  const url = new URL(process.env["WHATSAPP_APP_ORIGIN"] ?? "");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.origin !== url.href.replace(/\/$/, "")
  )
    throw new Error("Invalid payment origin");
  return url.origin;
}
const invalid = () =>
  page("This payment link is no longer active. Send PAYMENT to Mori for a new link.", 410);
export async function submitPayment(request: Request) {
  if (request.headers.get("origin") !== paymentOrigin()) return page("Forbidden", 403);
  if (
    !request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded") ||
    Number(request.headers.get("content-length")) > 2048
  )
    return invalid();
  let raw: string;
  try {
    raw = (await boundedBytes(request.body, 2048)).toString("utf8");
  } catch {
    return invalid();
  }
  const form = new URLSearchParams(raw),
    token = form.get("token") ?? "",
    nonce = whatsappNonce("payment", token);
  const l = nonce ? await paymentLink(nonce) : null;
  if (!nonce || !l) return invalid();
  const db = collectorClient(l.user_id);
  if (form.get("action") === "view") {
    const { data, error } = await (db as unknown as SupabaseClient)
      .from("order_settings")
      .select("wallet")
      .eq("user_id", l.user_id)
      .maybeSingle();
    if (error) return page("Could not load payment methods. Open the link again.", 503);
    return page(
      '<p>Connect to activate all your pending, unexpired orders.</p><form method="post"><input type="hidden" name="action" value="connect"><input type="hidden" name="token" value="' +
        token +
        '">' +
        Object.entries(paymentLabels)
          .map(
            ([k, label]) =>
              '<p><label><input type="radio" name="wallet" value="' +
              k +
              '"' +
              (k === (data?.wallet ?? "card") ? " checked" : "") +
              "> " +
              label +
              "</label></p>",
          )
          .join("") +
        '<p>Demo only. Nothing is charged and no payment details are collected.</p><button type="submit">Connect</button></form>',
    );
  }
  const wallet = form.get("wallet") ?? "";
  if (form.get("action") !== "connect" || !Object.hasOwn(paymentLabels, wallet)) return invalid();
  const previous = l.step;
  if (!(await setStep(l, { kind: "paying", key: nonce, payingAt: Date.now() }))) return invalid();
  let count: number;
  try {
    count = await connectPayment(db, wallet);
  } catch {
    await setStep(l, previous);
    return page("Could not confirm activation. Open the link and try Connect again.", 503);
  }
  // The capability was already consumed. A notification failure must not undo or repeat activation.
  const message = paymentConnected(count);
  await setStep(l, {}).catch(() => false);
  try {
    await sendWhatsApp(l, textMessage(message));
  } catch {
    return page(message + " The WhatsApp confirmation could not be sent.");
  }
  return page(message);
}
