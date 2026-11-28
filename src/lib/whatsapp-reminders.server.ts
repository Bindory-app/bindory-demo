import { sameText } from "./mori-signing.server";
import { paymentReminder } from "./mori-order-payment.server";
import { sendWhatsApp } from "./whatsapp-cloud.server";
import { buttonMessage, type WhatsAppMessage } from "./whatsapp-render";
import { claimReminder, reminderCandidates } from "./whatsapp-state.server";

export async function sweepReminders(request: Request) {
  const secret = process.env["CRON_SECRET"];
  if (!secret || !sameText(request.headers.get("authorization") ?? "", "Bearer " + secret))
    return new Response(null, { status: 401 });
  const name = process.env["WHATSAPP_REMINDER_TEMPLATE"]?.trim();
  const template: WhatsAppMessage | null = name
    ? {
        type: "template",
        template: {
          name,
          language: { code: process.env["WHATSAPP_REMINDER_LANGUAGE"]?.trim() || "en_US" },
        },
      }
    : null;
  const result = { sent: 0, skipped: 0, failed: 0 };
  const batch = 50,
    concurrency = 5;
  let after: string | null = null;
  try {
    for (;;) {
      const page = await reminderCandidates(after, !!template, batch);
      for (let i = 0; i < page.length; i += concurrency) {
        await Promise.all(
          page.slice(i, i + concurrency).map(async (candidate) => {
            try {
              // Another invocation or inbound turn may have claimed the slot, activated the order, or unlinked.
              const link = await claimReminder(candidate, !!template);
              if (link) {
                const inside = Date.parse(link.last_inbound) > Date.now() - 864e5;
                const message = inside
                  ? buttonMessage(paymentReminder, [
                      { id: "pay:resume", title: "Add payment method" },
                    ])
                  : template;
                if (message) {
                  await sendWhatsApp(link, message);
                  result.sent++;
                  return;
                }
              }
              result.skipped++;
            } catch {
              // A transport failure may still have delivered. Keep the daily claim; never send a second message.
              result.failed++;
            }
          }),
        );
      }
      if (page.length < batch) break;
      after = page[page.length - 1]!.user_id;
    }
  } catch {
    result.failed++;
  }
  return Response.json(result, {
    status: result.failed ? 503 : 200,
    headers: { "Cache-Control": "no-store" },
  });
}
