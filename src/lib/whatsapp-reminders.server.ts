import { sameText } from "./mori-signing.server";
import { paymentReminder } from "./mori-order-payment.server";
import { sendWhatsApp } from "./whatsapp-cloud.server";
import { buttonMessage, type WhatsAppMessage } from "./whatsapp-render";
import { claimReminder, reminderCandidates } from "./whatsapp-state.server";

export async function sweepReminders(request: Request) {
  // Leave room for the final 8 s database claim and 8 s Graph send under the 60 s limit.
  const stopAt = Date.now() + 40_000;
  const secret = process.env["CRON_SECRET"];
  if (!secret || !sameText(request.headers.get("authorization") ?? "", "Bearer " + secret))
    return new Response(null, { status: 401 });
  const name = process.env["WHATSAPP_REMINDER_TEMPLATE"] || "",
    code = process.env["WHATSAPP_REMINDER_LANGUAGE"] || "en_US";
  // Syntax only: the operator must independently verify that this exact template/locale is approved.
  if ((name && !/^[a-z0-9_]{1,512}$/.test(name)) || !/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(code))
    return Response.json(
      { error: "invalid_template_config" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  const template: WhatsAppMessage | null = name
    ? {
        type: "template",
        template: {
          name,
          language: { code },
        },
      }
    : null;
  const result = { sent: 0, skipped: 0, failed: 0 };
  const summary = (partial: boolean) =>
    Response.json(
      { ...result, partial },
      {
        status: result.failed ? 503 : 200,
        headers: { "Cache-Control": "no-store" },
      },
    );
  const batch = 50,
    concurrency = 5;
  let after: string | null = null;
  try {
    while (Date.now() < stopAt) {
      const page = await reminderCandidates(after, !!template, batch);
      for (let i = 0; i < page.length; i += concurrency) {
        if (Date.now() >= stopAt) return summary(true);
        await Promise.all(
          page.slice(i, i + concurrency).map(async (candidate) => {
            try {
              // Another invocation or inbound turn may have claimed the slot, activated the order, or unlinked.
              const link = await claimReminder(candidate, !!template);
              if (link) {
                const inside = link.freeform_until && Date.parse(link.freeform_until) > Date.now();
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
      if (page.length < batch) return summary(false);
      after = page[page.length - 1]!.user_id;
    }
  } catch {
    result.failed++;
  }
  return summary(true);
}
