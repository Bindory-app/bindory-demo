import { createFileRoute } from "@tanstack/react-router";
import { waitUntil } from "@vercel/functions";
export const Route = createFileRoute("/api/whatsapp-webhook")({
  server: {
    handlers: {
      GET: async ({ request }) =>
        (await import("@/lib/whatsapp-webhook.server")).verifyWebhook(request),
      POST: async ({ request }) =>
        (await import("@/lib/whatsapp-webhook.server")).receiveWebhook(request, waitUntil),
    },
  },
});
