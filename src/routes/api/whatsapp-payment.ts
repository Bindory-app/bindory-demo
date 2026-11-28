import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/api/whatsapp-payment")({
  server: {
    handlers: {
      GET: async () => (await import("@/lib/whatsapp-payment.server")).paymentLanding(),
      POST: async ({ request }) => {
        try {
          return await (await import("@/lib/whatsapp-payment.server")).submitPayment(request);
        } catch {
          return new Response("Payment is unavailable. Please try again.", {
            status: 503,
            headers: { "Cache-Control": "no-store" },
          });
        }
      },
    },
  },
});
