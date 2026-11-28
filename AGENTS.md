- User tables remain owner-only via RLS; public binder reads use a narrowly projected, publication-gated RPC so private cards, memories and photos stay inaccessible. Profiles are created on signup.
- Mori's server-only agent runs through Vercel AI Gateway (src/lib/ai-gateway.server.ts); /api/mori-confirm handles proposal confirmation, while /api/mori-chat verifies the bearer and streams native events as NDJSON for live chat updates.
- Points are awarded by database triggers on cards/memories inserts; clients cannot insert points_events.
- All card lookups go through src/lib/tcgdex.ts (TCGdex search + detail); images are hotlinked via cardImage() and never stored.
- Mori confirmation uses a SECURITY INVOKER database function with a locked proposal row and one transaction; binder creation uses owned cards only so suggestions never become invented ownership.
- Photo ownership is validated at the chat boundary and memory proposal, with private storage policies restricting every operation to the owner's first path segment.

<!-- harnessrouter:start -->
## Mori chat and Collectr sync

- `/api/mori-chat` runs one in-process Responses tool loop (`runMori`, `ai-gateway.server.ts`). The app sends country and optional phone location; prior messages, tool results and confirmation statuses provide the chat history. `AI_GATEWAY_MODEL` selects the model.
- A single-card price check displays the server's market card. Sell proposals require the collector's private front and back photos; until a pair is available, the tool shows a photo request, not a confirmation.
- Only **Sync from Collectr** uses HarnessRouter. The `collectr` setup in `harnessrouter.json` reads the public collection; `collectr-sync.server.ts` stores a signed task and `/api/mori-sync` polls it. Bindory, not the harness, applies the collector's approved import. Use `Collectr sync: <instruction>` to continue the latest finished sync in this chat.
- `HR_API_KEY` and `MORI_MCP_SECRET` (the task signing secret) are server-only and needed only for sync. See `.env.example` for placeholder configuration.
<!-- harnessrouter:end -->

- Sold prices and lowest listings are server data, not model input. `marketPrices` uses sold-price providers and eBay Browse for lowest listings. The price card compares worldwide and in-country listings by delivered cost (price, postage and estimated import fees) and shows recent raw sales for the selected condition.
