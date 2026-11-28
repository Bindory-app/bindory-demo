# Bindory

Bindory is a mobile-first Pokémon TCG collecting app where users interact with Mori, their AI collector agent.

Mori is the main way to use the app. Bindory is designed for phone-sized screens, with a centered mobile layout on desktop. It is built with TanStack Start and TypeScript.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```

Builds and unit tests do not need provider credentials. [`.env.example`](.env.example) lists the server configuration with mock values. Chat uses Vercel AI Gateway; HarnessRouter credentials are only for Sync from Collectr. Never commit real credentials.

## WhatsApp channel

The existing web chat stays available. Apply `setup/016_pending_orders.sql` then `setup/017_whatsapp.sql` before enabling WhatsApp. Configure the server-only mock-listed environment names for your own Meta app, Graph Phone Number ID, business display number, HTTPS app origin and Supabase project. Collector access requires that the project accepts the configured HS256 signing secret (and key id, if required); the service-role key is only for channel bookkeeping. Do not rotate project signing settings just to enable this demo.

Subscribe the Meta app to messages at `/api/whatsapp-webhook`, using its verify token for the GET challenge and its App Secret for POST signatures. No deployment, subscription, template approval or actual provider setup happens during local builds/tests. Use Settings → Account → Link WhatsApp, then send the prefilled message. Linking uses an expiring single-use code; STOP unlinks and PAYMENT offers a fresh payment page if there are eligible orders. WhatsApp uses the same market code as web chat at link time, with the existing US fallback. No real payment details are requested or charged.

Graph requests are versioned, media is downloaded by ID from the receiving business number and only the documented example HTTPS download host is accepted. Unknown media hosts/redirects fail closed. Meta can deliver album images independently; pairing uses a database row lock and holds only IDs, not bytes. A successful webhook acknowledgement schedules work under Vercel `waitUntil`, not a durable job queue. Do not log webhook/Graph bodies, sender IDs, link tokens or photo data. Validate real callback timing, media quality, receipt delivery and platform time limits in staging before rollout.

A fresh handoff from signed-in Settings can replace a lost phone; it invalidates the old channel controls and cannot take a sender linked to another account. A first photo waits up to 30 minutes for its pair. Each encoded photo must fit the same 2,000,000-character limit as web. A sell printing pick uses its own pair for the optional condition read; other stored printing picks do not invoke the model. Change details accepts any combination of side, original-currency price and duration, previews the result and saves only on explicit approval.

### Pending-order reminders

Apply `setup/018_whatsapp_reminders.sql` after 017 and configure a private `CRON_SECRET` before enabling the daily Vercel GET at `/api/whatsapp-reminders` (12:00 UTC). The sweep uses service-role bookkeeping, checks for a pending unexpired order, and shares one rolling 24-hour slot per linked collector with inbound reminders. It never activates an order or contacts unlinked collectors. Inside the customer-service window it sends the existing payment reminder. Outside it, it skips unless `WHATSAPP_REMINDER_TEMPLATE` names an approved, enabled static template; the language must match the approved locale (`WHATSAPP_REMINDER_LANGUAGE`, default `en_US`).

Proposed template for Johnny and Meta to approve, not submitted: “Your saved Bindory order is pending payment setup. Reply PAYMENT to add a payment method, or STOP to unlink WhatsApp.” No dynamic parameters or template buttons. If Meta declines or changes the category, leave the template unset pending review.

The response contains aggregate sent/skipped/failed counts only. A send is counted when Graph accepts it, not when the collector receives it. A failed or ambiguous send consumes the claim to prevent duplicates. Unlinking removes sender details; a collector ID and last reminder timestamp preserve the 24-hour limit across relinks and are removed on account deletion. Verify the deployed schedule, function duration and capacity for the linked population in staging; this is not a durable delivery queue.
