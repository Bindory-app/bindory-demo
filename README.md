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
