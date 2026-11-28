import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/api/whatsapp-reminders")({
  server: {
    handlers: {
      GET: async ({ request }) =>
        (await import("@/lib/whatsapp-reminders.server")).sweepReminders(request),
    },
  },
});
