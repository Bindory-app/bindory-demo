- User tables remain owner-only via RLS; public binder reads use a narrowly projected, publication-gated RPC so private cards, memories and photos stay inaccessible. Profiles are created on signup.
- Mori's server-only agent runs through Vercel AI Gateway (src/lib/ai-gateway.server.ts); /api/mori-confirm handles proposal confirmation, while /api/mori-chat verifies the bearer and streams native events as NDJSON for live chat updates.
- Points are awarded by database triggers on cards/memories inserts; clients cannot insert points_events.
- All card lookups go through src/lib/tcgdex.ts (TCGdex search + detail); images are hotlinked via cardImage() and never stored.
- Mori confirmation uses a SECURITY INVOKER database function with a locked proposal row and one transaction; binder creation uses owned cards only so suggestions never become invented ownership.
- Photo ownership is validated at the chat boundary and memory proposal, with private storage policies restricting every operation to the owner's first path segment.

<!-- harnessrouter:start -->
## Mori chat and Collectr sync

- `/api/mori-chat` accepts readable `message` text plus an optional validated `intent`. Named `price_check` forms use the catalogue and price tools without a model; ambiguous printings are choices carrying catalogue IDs. A price photo without a named card uses one forced identification call first. Free text and unsuccessful lookups use the Responses tool loop (`runMori`, `ai-gateway.server.ts`). Both paths save tool results to the same chat history. `AI_GATEWAY_MODEL` selects the model.
- A single-card price check displays the server's market card. An `order` intent carries the side, card and original `price: {amount, currency}`; buys need no model, sells use one condition read from the order's own front/back pair. Missing photos return a resumable photo request. A failed condition read omits condition; no FX quote for a foreign amount means no proposal until the collector specifies a US$ amount.
- Apply `setup/015_order_confirmation.sql` before deploying the order UI/server. Proposals store the original price and quoted rate alongside canonical `price_usd`. The editor uses the locked quote, and both the HTTP endpoint and direct RPC enforce the sell-photo rule. Older USD-only pending proposals remain editable.
- Apply `setup/016_pending_orders.sql` after 015 for payment-gated orders. Confirm saves a pending order; `connect_order_payment` explicitly opens the owner's unexpired pending orders for their chosen duration. The wallet is a demo label, not a payment credential. Existing open orders are unchanged.
- Only **Sync from Collectr** uses HarnessRouter. The `collectr` setup in `harnessrouter.json` reads the public collection; `collectr-sync.server.ts` stores a signed task and `/api/mori-sync` polls it. Bindory, not the harness, applies the collector's approved import. Use `Collectr sync: <instruction>` to continue the latest finished sync in this chat.
- `HR_API_KEY` is server-only for sync. `MORI_MCP_SECRET` signs sync tasks and WhatsApp capabilities with separate HKDF labels. See `.env.example` for placeholder configuration.
<!-- harnessrouter:end -->

- Price card: "Listing and Sold · <condition>" shows the lowest worldwide listing, the lowest listing in the collector's country, and the last three sales. Sold prices come from the server, never from the model. The headline prefers recent raw sales and falls back to listings or the market reference when sales are missing.
- Listings: the server uses eBay Browse for fixed-price raw singles in the requested condition. Local results restrict the seller country; worldwide results may include local sellers. Compare by delivered cost: price + postage + estimated import fees (`importFeeRate` in `src/lib/market.ts`). Missing listing data is shown as a dash, not a zero.
- Wireframe integration: edit `wireframe/live.html`, then run `python3 scripts/sync-live-layer.py` to update its embedded copy in `wireframe/app.html`. Use `--check` to verify parity without writing either file.
