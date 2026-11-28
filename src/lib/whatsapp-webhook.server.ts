import { boundedBytes, inboundMessages, signedWebhook } from "./whatsapp-cloud.server";
import { sameText } from "./mori-signing.server";
import { handleInbound } from "./whatsapp-turn.server";
export function verifyWebhook(request: Request) {
  const q = new URL(request.url).searchParams,
    secret = process.env["WHATSAPP_VERIFY_TOKEN"],
    challenge = q.get("hub.challenge");
  if (
    !secret ||
    !challenge ||
    q.get("hub.mode") !== "subscribe" ||
    !sameText(secret, q.get("hub.verify_token") ?? "")
  )
    return new Response(null, { status: 403 });
  return new Response(challenge, {
    headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" },
  });
}
export async function receiveWebhook(request: Request, background: (p: Promise<void>) => void) {
  let raw: Uint8Array;
  try {
    raw = await boundedBytes(request.body, 3_145_728);
  } catch {
    return new Response(null, { status: 413 });
  }
  if (!signedWebhook(raw, request.headers.get("x-hub-signature-256")))
    return new Response(null, { status: 403 });
  const number = process.env["WHATSAPP_PHONE_NUMBER_ID"];
  if (!number) return new Response(null, { status: 503 });
  let messages;
  try {
    messages = inboundMessages(JSON.parse(Buffer.from(raw).toString("utf8")), number);
  } catch {
    return new Response(null, { status: 400 });
  }
  if (messages.length)
    background(
      (async () => {
        for (const m of messages) {
          try {
            await handleInbound(m, request.headers.get("x-vercel-oidc-token"));
          } catch {
            console.warn("WhatsApp inbound processing failed");
          }
        }
      })(),
    );
  return new Response(null, { status: 200 });
}
