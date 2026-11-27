import { routeMoriMessage } from "./mori-agents";
import { marketFor, type Market } from "./market";
import {
  COLLECTR_BAD_LINK,
  collectrSyncBinder,
  collectrSyncLink,
  isCollectrLink,
} from "./collectr";
import type { MoriStreamEvent, MoriRow } from "./mori-tools";
import {
  streamResponse,
  GatewayError,
  type ResponsesInputItem,
  type ResponsesRequest,
  type ResponsesResponse,
} from "./ai-gateway.server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/types";
import {
  cardImage,
  cardsByIllustrator,
  getCard,
  getCardPricing,
  getSet,
  getSetCards,
  findCards,
  priceScale,
  searchCards,
  usdRange,
} from "./tcgdex";
import { validateWriteArgs, ownPhotoPath, orderCondition } from "./mori-validation";
import { ebaySoldPrices } from "./silphco.server";
import { toCondition } from "./ebay-sold.server";
import { webFetch, webSearch } from "./telem.server";
import {
  isWriteTool,
  proposalTitle,
  TOOL_STATUS,
  type Proposal,
  type ProposalCard,
  type ProposalPayload,
} from "./mori-tools";

type DB = SupabaseClient<Database>;
// Any tool-capable model ID from https://ai-gateway.vercel.sh/v1/models; override with AI_GATEWAY_MODEL.
// Default is on the AI Gateway free tier; newer models need paid credits.
const MODEL = process.env["AI_GATEWAY_MODEL"] || "google/gemini-2.5-flash";

export const SYSTEM = `You are Mori, a warm, concise Pokémon TCG collector agent inside the Bindory app. Keep replies short (2-5 sentences, or a short list), friendly, US English, sentence case. Use **bold** for card names and key numbers. Write money in the collector's currency from the App note (e.g. A$812 in Australia, £640 in the UK), with thousands separators; never US$ unless the collector is in the US or asks.
Answer only what the collector asked, in one short, focused answer: no extra analyses, cards or proposals they did not ask for. Lead them to what they are trying to achieve, one step at a time: when you need a decision or a detail from them (which day, how many, which card, which binder, what price, buy or sell), ask ONE short question and give the likely answers as Choices they can tap instead of typing. Write each choice as their reply, with the detail that helps them decide (e.g. "Both days: US$30 with Early Bird", "Just me: 1 ticket", "Moonlight Pokémon binder"). Put the next steps toward their goal (not unrelated features) in Suggestions, and do not write a separate "Next step" line. If the collector asked several things, answer each in its own short block, separated by a line containing only ---.
- What to chase next: list_my_cards, pick the set or theme they collect most, get_set_cards for it, choose ONE specific card they are missing (prefer a notable one), get_card_prices for it, and in the same answer always call add_to_wishlist for that card (do not ask first; the collector confirms on the card). Your text: one or two sentences on why it fits, with today's price range.
- Trendy collections: call market_trends and name the 2-3 cards or sets rising fastest, with the change in % and today's price range. Say which of them the collector already owns (list_my_cards).
- Card shows and events: use the collector's location from the "[App note: the collector's location ...]" (from their phone) and search for that city (e.g. "Pokemon TCG card show <city> <month year>"); never assume a city, not even one remembered from earlier chats. If there is no location note, do not list events for a guessed city: say you need their location, ask them to allow location on their phone or type their city, and stop. Call web_search and web_fetch on the best 1-2 pages, then list 2-3 upcoming events near them with date, venue, opening hours and ticket price exactly as the pages say, and the official event or ticket page as a Markdown link (e.g. [Tickets](https://...)) when a page gives one; say so when a date or venue could not be confirmed. Answer only that: do not list their cards, prices or a card to hunt, and do not call add_to_wishlist. Suggestions must be about these events, e.g. "Help me buy tickets for <event name>", "What should I bring to <event name>?", "Shows in another city?". When asked to help buy tickets: find the event's official ticket page with web_search and web_fetch, then call show_tickets with that page and every ticket option it lists (name, price, when the sale ends) so the collector can pick a ticket and quantity and open the organiser's checkout; reply in one or two short lines. Never buy, book or enter payment details yourself.
- Refer to other collectors by name, never as he or she.
- Never suggest getting a card the collector already owns (check list_my_cards).
"This card", "it" or "that one" means the card most recently discussed in this chat (from photos, a pre-grade report, a price check or an order). Use that card; never ask which card when one was just discussed.
You act through your tools: web_search, web_fetch, search_catalogue, get_card_prices, pre_grade_report, my_price_movers, get_set_cards, list_my_cards, list_my_orders, market_trends, plan_video, show_collectors, show_tickets, find_related_cards, find_collectors, suggest_binder_for_card, add_card_to_collection, add_to_wishlist, create_binder, save_memory, set_order.
Rules:
- Be proactive. When a request is open-ended (build a binder, complete my set, what to chase next, collectors who share my taste, trade-ups, value changes), start with list_my_cards and the other tools and come back with a concrete suggestion. Do not hand the work back to the collector; ask at most one short question, after you have suggested something.
- Only list_my_cards says what the collector owns. Cards in earlier confirmation cards that were not confirmed are not in their collection.
- Never invent data. Every card, set, artist, price, memory or collector you mention must come from a tool result or a photo in this conversation. If a tool returns nothing, say so and offer a next step.
- Card ids are TCGdex ids such as "swsh7-215". Find them with search_catalogue first (search by the Pokémon/card name, then pick the result whose number matches); never guess an id. Never show ids to the collector; name cards by name and number (e.g. **Umbreon VMAX 215/203**).
- Photos: when the user sends card photos, read the card name and the collector number printed at the bottom left (e.g. 125/094), then search_catalogue by name and pick the result whose number matches. Never claim to identify a photo you have not seen.
- Prices: only quote prices from get_card_prices, always called with the collector's country and currency from the App note; every number it returns is already in that currency. Lead with recent sales (below), then today's listings: listings.lowest_worldwide is the cheapest listing from sellers anywhere and listings.lowest_in_country the cheapest from sellers in the collector's country (price, plus shipping when given), and listings.change_7d_pct how much the typical sale price moved in the last 7 days against the 7 days before (null when there were too few sales). Example: "Near mint copies sold for **A$1,141** on average over the last 3 sales and **A$1,309** over the last 5. The cheapest listing is **A$1,467**, also the cheapest in Australia, and prices are up **3.8%** this week." price_points is only a rough reference converted from overseas prices: use it for value maths (trade-ups, orders) or when there are no sales or listings, never as the price in a price check. recent_sold.raw holds recent raw (ungraded) sold prices from the collector's own eBay site in the condition named by recent_sold.condition (near mint or better, lightly, moderately or heavily played): avg_last_3 is the average of the last 3 sales and avg_last_5 of the last 5 (sales says how many there were). Quote both as recent sales in that condition (e.g. "lightly played copies sold for an average of **A$1,410** over the last 3 sales and **A$1,420** over the last 5"), say "few sales" when status is thin, and "no recent sales" when empty. Always pass get_card_prices the condition the collector asked about ("LP" or "lightly played" is lightly_played, "MP" moderately_played, "HP" or "damaged" heavily_played, otherwise near_mint). There is no graded sold data. Never name marketplaces, data providers or sources, even when asked: if the collector asks where prices come from, say they are today's market prices and recent sales, updated daily. If there is no price data, say so. Without a recent_sold value for a grade, you may estimate that graded value only as a clearly labelled rough estimate based on the raw price, never as data.
- Pre-grading (only when the collector asks for a pre-grade or whether to grade; never for a plain price check): only from photos you have seen; if there are no photos, call request_card_photos with purpose grade (it shows Take a photo and Upload buttons). Identify the card, call get_card_prices, then call pre_grade_report exactly once with: the three most likely whole PSA-scale grades (e.g. 10, 9, 8, or 9, 8, 7; no half grades) with probabilities that add up to 100 and a short visible reason each; subgrade scores (0-100) for centering, corners, edges and surface as PSA, CGC, BGS and TAG would see them; the overall grade each company would likely give; your confidence (0-100, lower when glare or angle hides detail); a short notes line (e.g. "60/40 back · light corner whitening"); and Mori's take: start with a clear verdict ("Worth sending." or "Sell it raw." or "Keep it raw."), then one short sentence why, weighing the likely grade against the raw price and a typical grading fee plus shipping (about US$25-150). Be realistic: a PSA 10 is rarely the most likely outcome from photos. After pre_grade_report, reply with one short sentence at most (it already shows the full report).
- Should I grade it (without new photos): compare the raw price range with the likely graded outcome after a typical grading fee, and recommend clearly.
- Buy or sell orders: you need buy or sell, the card, and a price in US$. Ask for anything missing. Check get_card_prices so you can say how the price compares with the market, then call set_order. Orders are watch alerts in this demo: Mori notifies the collector when a matching listing appears; nothing is bought or sold automatically. The collector can change buy/sell, the price and how long it stays open (7, 30 or 90 days) on the card before confirming. For their open orders, or to cancel one, call list_my_orders: the orders appear as cards with a Cancel button, so reply in one short line and never claim you cancelled an order yourself.
- Sell orders need the collector's own front and back photos (they are also used for the marketplace listing). If none were sent in this chat, call request_card_photos and do not call set_order yet. When photos arrive, open both and check the condition: centering front and back (e.g. 55/45), each corner (top left, top right, bottom left, bottom right, front and back: sharp, light whitening, ding), edges, surface (scratches, print lines, dents; say when glare hides detail), and an overall condition (Near mint, Lightly played, Moderately played, Heavily played, Damaged). Then check get_card_prices and call set_order with side sell and that condition. If the price is missing, ask for it first; the photos and your condition notes carry over.
- Trade-up challenge: list_my_cards, then my_price_movers for their prices. Pick 2-3 cards to give that are NOT their most valuable card. Find one card they would love (search_catalogue, matching their favourite set, Pokemon or artist) and call get_card_prices for it. Its typical price must be 80-110% of the combined value of the cards they give; if not, change the cards you give until it is. Show the maths in one short list (each card and its price, then the total vs the target price), then in the same answer call add_to_wishlist for the target card.
- Value changes (what went up or down in my collection): call my_price_movers once. Report the biggest risers (and any big fallers) as percentages with today's price range, and say it compares the last 7 days with the last 30 days. Do not name marketplaces.
- Completing a set: use list_my_cards to find the set they own the most cards from, then get_set_cards for that set, and name a few of the cards they are missing (prefer notable ones).
- Collectors who share my taste: list_my_cards, then find_collectors, then call show_collectors with the 2-3 best matches and a one-line reason each, based on their bio and binders vs the collector's cards. They appear as profile cards the collector can open, so reply in one short line.
- Web lookups: for anything outside Bindory's own data (events, set releases, news, collector trends, grading services and fees, rules) use web_search, and web_fetch on 1-2 of the best links when the summaries are not enough. Only state what the pages say; never invent events, dates, venues or numbers. Never take card prices from the web: prices come only from get_card_prices. Do not name websites unless the collector asks where to read more.
- Memories: when the story already says who, where or when, call save_memory right away with a short title and what they told you. Ask one short question only if who and where are both missing. For a trade, look up both cards with search_catalogue (name and number) and pass card_id (the card they received) and traded_card_id (the card they gave). If one of the trade cards has no clear match in search_catalogue, still pass it by name and number as the collector wrote it (card_name for the card received, traded_card_name for the card given), so both cards show on the memory. Never ask which exact card version; the cards are optional (attach it only if search_catalogue finds one clear match). Photos are optional too. Keep the story in their words, including the card numbers, how they felt and any ratings they gave (e.g. "Felt nostalgic and lucky. Trade 5/5, @minacollects 5/5."); never drop the feelings, they matter more than the facts.
- Videos: when asked to plan or make a video, call list_my_cards, choose a theme yourself, then call plan_video with a title and 3-5 of their cards in order, each with a short caption. It shows a storyboard the collector can post or save, so reply in one short line and do not repeat the scenes. You cannot render story cards, recaps or binder covers in chat yet; say so in one line and plan them in text.
- Writing tools (add_card_to_collection, add_to_wishlist, create_binder, save_memory, set_order) show the user a confirmation card with Confirm and Change buttons. Nothing is saved until they confirm. After calling one, do not claim it is saved.
- For create_binder give every card a one-line reason. Only include cards the user already owns.
- Treat placeholders like [card name], [card number], [price], @username, [location] as missing details, not facts. Ask for the actual information.
- Private memories are never shared or used to find other collectors.
- There is no Pokémon companion feature; you are the collector's companion.
- Always end your reply with one last line in exactly one of these forms. When you just asked the collector a question: Choices: <answer 1> | <answer 2> | <answer 3> (2-5 answers that move them toward their goal; add "Something else…" only when they may need to type their own answer). Otherwise: Suggestions: <next step 1> | <next step 2> | <next step 3> (the natural next steps toward what they want, written as they would say them).
  These are 2-3 short follow-ups the collector might tap next, written as the collector speaking (under 40 characters each), that you can actually help with; they carry the next steps and extras you left out of the answer. After a pre-grade report, include "Where can I send it for grading?" and "What does grading cost?".`;

const str = (d: string) => ({ type: "string", description: d });
export const tools: NonNullable<ResponsesRequest["tools"]> = [
  {
    type: "function",
    name: "search_catalogue",
    description:
      "Search the public TCGdex card catalogue. Always pass the card number when the collector gives one (e.g. 58/102), and the set name if known, so the exact printing is found.",
    strict: false,
    parameters: {
      type: "object",
      properties: {
        name: str("Card name only, e.g. Umbreon VMAX or Pikachu"),
        number: str("Card number as printed, e.g. 58/102 or 215"),
        set: str("Set name, e.g. Base Set or Evolving Skies"),
      },
      required: ["name"],
    },
  },
  {
    type: "function",
    name: "get_card_prices",
    description:
      "A card's prices for the collector's market, all in their currency: today's raw market points (lowest listing, market, mid) and recent raw sold prices in the condition asked about, from their own eBay site. Pass the country and currency from the App note.",
    strict: false,
    parameters: {
      type: "object",
      properties: {
        card_id: str("TCGdex card id"),
        country: str("The collector's country code from the App note, e.g. AU, GB, US"),
        currency: str("The collector's currency code from the App note, e.g. AUD"),
        condition: {
          type: "string",
          enum: ["near_mint", "lightly_played", "moderately_played", "heavily_played"],
          description:
            "The raw card's condition the collector asked about; near_mint (near mint or better) when they did not say.",
        },
        sold_listings: {
          type: "array",
          description:
            "The raw (ungraded) sold listings you read with the eBay sold listings actor for this card, exactly as it returned them (title, soldPrice, soldCurrency, endedAt, itemLocation).",
          items: {
            type: "object",
            properties: {
              title: str("Listing title"),
              soldPrice: str("Sold price, as the actor returned it"),
              soldCurrency: str("Currency, e.g. AUD"),
              endedAt: str("Date the sale ended"),
              itemLocation: str(
                "Where the item was, exactly as the actor returned it (null or empty for the collector's own country)",
              ),
            },
          },
        },
      },
      required: ["card_id"],
    },
  },
  {
    type: "function",
    name: "pre_grade_report",
    description:
      "Show the collector a pre-grade report from the card photos: Should I grade? (likely grades with probabilities), Mori's take, and a detailed subgrade report for PSA, CGC, BGS and TAG.",
    strict: false,
    parameters: {
      type: "object",
      properties: {
        card: str("Card name and number, e.g. Mega Charizard X ex 125/094"),
        outcomes: {
          type: "array",
          description: "The three most likely grades, probabilities adding up to 100",
          items: {
            type: "object",
            properties: {
              grade: { type: "number" },
              probability: { type: "number" },
              reason: str("Short visible reason, e.g. Centering is outside 55/45"),
            },
            required: ["grade", "probability", "reason"],
          },
        },
        take: str("Mori's take: one or two plain sentences, is it worth sending?"),
        confidence: { type: "number", description: "0-100" },
        subgrades: {
          type: "object",
          description: "Scores 0-100 per aspect, per grading company",
          properties: Object.fromEntries(
            ["centering", "corners", "edges", "surface"].map((k) => [
              k,
              {
                type: "object",
                properties: {
                  psa: { type: "number" },
                  cgc: { type: "number" },
                  bgs: { type: "number" },
                  tag: { type: "number" },
                },
              },
            ]),
          ),
        },
        overall: {
          type: "object",
          description: "Likely overall grade per company",
          properties: {
            psa: { type: "number" },
            cgc: { type: "number" },
            bgs: { type: "number" },
            tag: { type: "number" },
          },
        },
        notes: str("Short notes line, e.g. 60/40 back · light corner whitening"),
      },
      required: ["outcomes", "take", "confidence", "subgrades", "overall"],
    },
  },
  {
    type: "function",
    name: "my_price_movers",
    description:
      "For the collector's own cards: compare the 7-day average price with the 30-day average and return the biggest moves, plus today's price range. One call covers the whole collection.",
    strict: false,
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "get_set_cards",
    description:
      "List the cards in a TCGdex set (id, number, name), to see which cards a collector is missing.",
    strict: false,
    parameters: {
      type: "object",
      properties: {
        set_id: str("TCGdex set id, e.g. swsh7 (the part of a card id before the dash)"),
      },
      required: ["set_id"],
    },
  },
  {
    type: "function",
    name: "set_order",
    description:
      "Propose a buy or sell order (a price alert) for a card (user confirms). Check get_card_prices first.",
    strict: false,
    parameters: {
      type: "object",
      properties: {
        side: { type: "string", enum: ["buy", "sell"] },
        card_id: str("TCGdex card id"),
        price_usd: { type: "number", description: "Target price in US dollars" },
        note: str("Optional note, e.g. condition or grade wanted"),
        condition: {
          type: "object",
          description:
            "Sell orders only: the card's condition from the collector's front and back photos (open both first).",
          properties: {
            overall: str("Overall condition, e.g. Near mint, Lightly played"),
            summary: str("One short line, e.g. Sharp corners, light back whitening"),
            centering: {
              type: "object",
              properties: { front: str("e.g. 55/45"), back: str("e.g. 60/40") },
            },
            corners: {
              type: "object",
              description: "Each corner, front and back, e.g. Sharp or Light whitening (back)",
              properties: {
                top_left: str("Top left"),
                top_right: str("Top right"),
                bottom_left: str("Bottom left"),
                bottom_right: str("Bottom right"),
              },
            },
            edges: str("Edges, e.g. Clean, minor back whitening"),
            surface: str("Surface, e.g. No scratches visible; glare hides part of the holo"),
          },
          required: ["overall"],
        },
      },
      required: ["side", "card_id", "price_usd"],
    },
  },
  {
    type: "function",
    name: "web_search",
    description:
      "Search the web for things outside Bindory's own data: card shows and events, set releases, news, grading services and fees, rules. Returns titles, links and short summaries. Never use it for card prices.",
    strict: false,
    parameters: {
      type: "object",
      properties: {
        query: str("What to search for, e.g. Pokemon TCG card show Sydney December 2026"),
      },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "web_fetch",
    description:
      "Read up to 3 web pages (links from web_search) as text, to confirm details such as an event's date and venue or a grading company's fees.",
    strict: false,
    parameters: {
      type: "object",
      properties: {
        urls: { type: "array", items: { type: "string" }, description: "1-3 http(s) links" },
      },
      required: ["urls"],
    },
  },
  {
    type: "function",
    name: "request_card_photos",
    description:
      "Ask the collector for front and back photos of their own card (shows Take a photo and Upload buttons). Use for a sell order or a pre-grade when no photos were sent in this chat.",
    strict: false,
    parameters: {
      type: "object",
      properties: {
        purpose: {
          type: "string",
          enum: ["sell", "grade"],
          description: "sell for a sell order, grade for a pre-grade",
        },
      },
    },
  },
  {
    type: "function",
    name: "find_related_cards",
    description:
      "Find cards related to a TCGdex card: other prints of the same Pokémon and cards by the same artist.",
    strict: false,
    parameters: {
      type: "object",
      properties: { card_id: str("TCGdex card id") },
      required: ["card_id"],
    },
  },
  {
    type: "function",
    name: "list_my_cards",
    description: "List cards in the user's own collection, optionally filtered.",
    strict: false,
    parameters: {
      type: "object",
      properties: {
        artist: str("Illustrator name"),
        set: str("Set name"),
        year: { type: "integer" },
      },
    },
  },
  {
    type: "function",
    name: "show_collectors",
    description:
      "Show 2-3 collectors from find_collectors as profile cards, each with why they match.",
    strict: false,
    parameters: {
      type: "object",
      properties: {
        picks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              username: str("Username from find_collectors"),
              why: str("One short reason they match"),
            },
            required: ["username", "why"],
          },
        },
      },
      required: ["picks"],
    },
  },
  {
    type: "function",
    name: "show_tickets",
    description:
      "Show the collector an event's tickets as a card: the official ticket page and every ticket option it lists (name, price, when sales end). The collector picks a ticket and quantity, then opens the organiser's checkout and pays there themselves. Only use a ticket_url and options read from the event's own pages with web_search / web_fetch.",
    strict: false,
    parameters: {
      type: "object",
      properties: {
        event: str("Event name, e.g. East Bay Card Show"),
        date: str("Date(s) as the page shows them, e.g. Sat 28 - Sun 29 Nov 2026"),
        venue: str("Venue and city"),
        ticket_url: str("The official ticket or registration page (https)"),
        options: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: str("Ticket type as the page names it, e.g. Saturday Early Bird"),
              price: str("Price as the page shows it, e.g. US$15"),
              note: str("Optional: when the sale ends, what it includes"),
            },
            required: ["name"],
          },
        },
      },
      required: ["event", "ticket_url", "options"],
    },
  },
  {
    type: "function",
    name: "plan_video",
    description:
      "Show a video storyboard from the collector's own cards (in order, with captions). They can post it to their profile or save it as a draft.",
    strict: false,
    parameters: {
      type: "object",
      properties: {
        title: str("Short video title"),
        scenes: {
          type: "array",
          description: "3-5 scenes, in order",
          items: {
            type: "object",
            properties: {
              card_id: str("TCGdex id of a card the collector owns"),
              caption: str("Short on-screen caption"),
            },
            required: ["card_id", "caption"],
          },
        },
      },
      required: ["title", "scenes"],
    },
  },
  {
    type: "function",
    name: "market_trends",
    description:
      "Price movement this week vs this month for popular chase cards across the market (real daily prices).",
    strict: false,
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "list_my_orders",
    description:
      "List the collector's own buy and sell orders (price alerts): card, side, price in US$, status and expiry.",
    strict: false,
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "find_collectors",
    description: "Find other collectors with public profiles who share an interest.",
    strict: false,
    parameters: {
      type: "object",
      properties: { interest: str("Card, set or theme") },
      required: ["interest"],
    },
  },
  {
    type: "function",
    name: "suggest_binder_for_card",
    description:
      "Show the collector their binders so they can put a card they own into one (each binder gets an Add here button).",
    strict: false,
    parameters: {
      type: "object",
      properties: { card_id: str("TCGdex card id") },
      required: ["card_id"],
    },
  },
  {
    type: "function",
    name: "add_card_to_collection",
    description:
      "Propose adding a card to the user's collection (user confirms). When the collector names a binder (one of theirs, or a new binder), pass its name as binder_name and the card goes into that binder on confirm.",
    strict: false,
    parameters: {
      type: "object",
      properties: {
        card_id: str("TCGdex card id"),
        binder_name: str(
          "Optional: the binder the collector asked for, exactly as they named it (an existing binder, or the name of a new one)",
        ),
      },
      required: ["card_id"],
    },
  },
  {
    type: "function",
    name: "add_to_wishlist",
    description: "Propose adding a card to the user's wishlist (user confirms).",
    strict: false,
    parameters: {
      type: "object",
      properties: { card_id: str("TCGdex card id"), note: str("Optional note") },
      required: ["card_id"],
    },
  },
  {
    type: "function",
    name: "create_binder",
    description: "Propose a new binder (user confirms).",
    strict: false,
    parameters: {
      type: "object",
      properties: {
        name: str("Binder name"),
        description: str("Short description"),
        cards: {
          type: "array",
          items: {
            type: "object",
            properties: { card_id: str("TCGdex card id"), reason: str("One-line reason") },
            required: ["card_id", "reason"],
          },
        },
      },
      required: ["name", "cards"],
    },
  },
  {
    type: "function",
    name: "save_memory",
    description:
      "Propose saving a collecting memory (user confirms). Who, where, date, card and photo are all optional.",
    strict: false,
    parameters: {
      type: "object",
      properties: {
        title: str("Short title"),
        story: str("The story in the user's words"),
        place: str("Where"),
        with_whom: str("Who they were with"),
        date: str("Date as YYYY-MM-DD if known"),
        card_id: str(
          "TCGdex id of the card the memory is about (in a trade: the card they received)",
        ),
        traded_card_id: str("In a trade: TCGdex id of the card they gave away"),
        card_name: str(
          "Only when the card they received is not in the catalogue: its name and number as the collector wrote it",
        ),
        traded_card_name: str(
          "Only when the card they gave is not in the catalogue: its name and number as the collector wrote it",
        ),
        photo_path: str("Photo path from an attached photo message"),
      },
      required: ["title", "story"],
    },
  },
];

export type Args = Record<string, unknown>;
const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** The collector's market from the tool's country (or currency) argument; US by default. */
function marketFromArgs(a: Args) {
  const byCurrency: Record<string, string> = {
    AUD: "AU",
    GBP: "GB",
    CAD: "CA",
    EUR: "DE",
    USD: "US",
  };
  const c = s(a["country"]) ?? byCurrency[(s(a["currency"]) ?? "").toUpperCase()];
  return marketFor(c);
}

/** A card's prices for the collector's market: today's market points converted into their currency,
 *  and recent sold prices from their own eBay site (Apify), else pooled eBay sales converted. */
export async function marketPrices(
  card: { id: string; name: string; number: string },
  pricing: Parameters<typeof priceScale>[0],
  market: Market,
  /** Sales the agent read with the Apify actor itself (used instead of the server's lookup). */
  agentSales?: unknown[],
  /** The raw card's condition; sold prices are for this condition only. */
  condition: import("./ebay-sold.server").Condition = "nm",
) {
  const { usdTo } = await import("./fx.server");
  const { localSoldPrices, summarise, CONDITIONS } = await import("./ebay-sold.server");
  const rate = market.currency === "USD" ? 1 : await usdTo(market.currency);
  const x = (v: number | null | undefined) =>
    typeof v === "number" ? Math.round(v * rate * 100) / 100 : null;
  const scale = priceScale(pricing);
  const sales = (agentSales ?? []).filter(
    (
      x,
    ): x is {
      title?: string;
      soldPrice?: string | number;
      soldCurrency?: string;
      endedAt?: string;
    } => Boolean(x) && typeof x === "object",
  );
  // Without item locations the sales can't be limited to the collector's country, so the server
  // looks them up itself instead.
  const located = sales.some((x) => "itemLocation" in x);
  const local =
    sales.length && located
      ? summarise(sales.slice(0, 60), card.number, market, condition)
      : await localSoldPrices(card, market, condition);
  // The pooled fallback is near mint only, so it is never shown for another condition.
  const pooled = local || condition !== "nm" ? null : await ebaySoldPrices(card.id);
  const label = CONDITIONS[condition].label;
  // Today's listings (lowest worldwide and in their country) and the 7-day change, priced from
  // the card's recent sold average (else the converted US market price) so junk listings drop out.
  const { marketListings } = await import("./ebay-listings.server");
  const listings = await marketListings(
    card,
    market,
    condition,
    local?.raw.avg_last_5 ?? x(scale?.market) ?? null,
  ).catch(() => null);
  const soldOut = (v: {
    value: number | null;
    status: string;
    n?: number;
    avg_last_3?: number | null;
    avg_last_5?: number | null;
  }) => ({
    avg_last_3: v.avg_last_3 ?? null,
    avg_last_5: v.avg_last_5 ?? v.value,
    sales: v.n ?? null,
    status: v.status,
  });
  return {
    rate,
    scale,
    local,
    pooled,
    listings,
    forTool: {
      currency: market.currency,
      ebay_site: market.ebay,
      listings: listings
        ? {
            condition: label,
            lowest_worldwide: listings.lowest_worldwide,
            lowest_in_country: listings.lowest_local,
            change_7d_pct: listings.change_7d_pct,
            sales_last_7_days: listings.sales_7d,
          }
        : null,
      price_points: scale
        ? { lowest_listing: x(scale.low), market: x(scale.market), mid: x(scale.mid) }
        : null,
      recent_sold: local
        ? { from: market.ebay, condition: label, raw: soldOut(local.raw) }
        : pooled
          ? { condition: label, raw: { value: x(pooled.raw.value_usd), status: pooled.raw.status } }
          : null,
    },
  };
}

async function briefCard(id: string, reason?: string): Promise<ProposalCard | null> {
  const c = await getCard(id);
  if (!c) return null;
  return {
    tcgdex_id: c.id,
    name: c.name,
    image: cardImage(c.image, "low"),
    set_name: c.set.name,
    reason,
  };
}

async function runReadTool(db: DB, name: string, a: Args): Promise<unknown> {
  switch (name) {
    case "search_catalogue": {
      const r = await findCards(s(a["name"]) ?? "", s(a["number"]), s(a["set"]));
      return r.length
        ? r
        : {
            results: [],
            note: "No cards found. Try the name alone, or check the number with the collector.",
          };
    }
    case "get_card_prices": {
      const r = await getCardPricing(s(a["card_id"]) ?? "");
      if (!r) return { error: "Card not found" };
      const card = { id: r.card.id, name: r.card.name, number: r.card.localId };
      const m = await marketPrices(
        card,
        r.pricing,
        marketFromArgs(a),
        Array.isArray(a["sold_listings"]) ? (a["sold_listings"] as unknown[]) : undefined,
        toCondition(a["condition"]) ?? "nm",
      );
      return {
        card: { ...card, set: r.card.set.name, rarity: r.card.rarity },
        // Every price below is in this currency, for the collector's market.
        ...m.forTool,
        ...(m.forTool.price_points || m.forTool.recent_sold || m.forTool.listings
          ? {}
          : { note: "No price data for this card" }),
      };
    }
    case "web_search": {
      const results = await webSearch(s(a["query"]) ?? "");
      return results.length
        ? { results }
        : {
            results: [],
            note: "Nothing found. Try different words, or say you could not find it.",
          };
    }
    case "web_fetch": {
      const urls = Array.isArray(a["urls"]) ? a["urls"].filter((u) => typeof u === "string") : [];
      const pages = await webFetch(urls as string[]);
      return pages.length ? { pages } : { error: "Give 1-3 http(s) links from web_search." };
    }
    case "find_related_cards": {
      const c = await getCard(s(a["card_id"]) ?? "");
      if (!c) return { results: [], note: "Card not found" };
      const [same, art] = await Promise.all([
        searchCards(c.name, 6),
        c.illustrator ? cardsByIllustrator(c.illustrator, 6) : Promise.resolve([]),
      ]);
      return {
        card: { id: c.id, name: c.name, illustrator: c.illustrator },
        same_pokemon: same.filter((x) => x.id !== c.id).map((x) => ({ id: x.id, name: x.name })),
        same_artist: art.filter((x) => x.id !== c.id).map((x) => ({ id: x.id, name: x.name })),
      };
    }
    case "list_my_cards": {
      let q = db
        .from("cards")
        .select("tcgdex_id, name, set_name, illustrator, year, rarity")
        .order("created_at", { ascending: false })
        .limit(50);
      if (s(a["artist"])) q = q.ilike("illustrator", `%${s(a["artist"])}%`);
      if (s(a["set"])) q = q.ilike("set_name", `%${s(a["set"])}%`);
      if (typeof a["year"] === "number") q = q.eq("year", a["year"]);
      const { data, error } = await q;
      if (error) throw error;
      return data.length ? data : { results: [], note: "No matching cards in the collection" };
    }
    case "list_my_orders": {
      // market_orders is created by setup/009 and is not in the generated types yet.
      const { data, error } = await (db as unknown as SupabaseClient)
        .from("market_orders")
        .select("id, side, card_name, image_url, price_usd, status, expires_at, created_at")
        .eq("status", "open")
        .gt("expires_at", new Date().toISOString())
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) throw error;
      return data?.length ? data : { results: [], note: "No open orders" };
    }
    case "my_price_movers": {
      const { data, error } = await db
        .from("cards")
        .select("tcgdex_id, name, set_name")
        .order("created_at", { ascending: false })
        .limit(24);
      if (error) throw error;
      const ids = [...new Set(data.map((c) => c.tcgdex_id).filter(Boolean))];
      const moves = await priceMoves(ids);
      return moves.length
        ? {
            compared: "7-day average price vs 30-day average price",
            cards_checked: moves.length,
            moves,
          }
        : { results: [], note: "No price history for the cards in this collection" };
    }
    case "market_trends": {
      const moves = await priceMoves(TREND_CARDS);
      return moves.length
        ? { compared: "7-day average price vs 30-day average price", moves }
        : { results: [], note: "Market prices are unavailable right now. Try again shortly." };
    }
    case "get_set_cards": {
      const set = await getSetCards(s(a["set_id"]) ?? "");
      if (!set) return { error: "Set not found" };
      return {
        set: { id: set.id, name: set.name, total: set.cards.length },
        cards: set.cards.slice(0, 300).map((c) => ({ id: c.id, number: c.localId, name: c.name })),
      };
    }
    case "find_collectors": {
      // Public profiles only (bio and public binder count); private memories are never used for discovery.
      const { data, error } = await db.rpc("list_public_collectors", { p_query: "" });
      if (error) throw error;
      const list = (Array.isArray(data) ? data : []) as {
        display_name?: string;
        username?: string;
        bio?: string;
        binders?: number;
      }[];
      return list.length
        ? list.map((c) => ({
            name: c.display_name,
            username: c.username,
            bio: c.bio,
            public_binders: c.binders,
          }))
        : { results: [], note: "No public collector profiles found" };
    }
    case "suggest_binder_for_card": {
      const [{ data: binders, error }, card] = await Promise.all([
        db.from("binders").select("id, name, description, binder_cards(count)"),
        getCard(s(a["card_id"]) ?? ""),
      ]);
      if (error) throw error;
      return {
        card: card ? { id: card.id, name: card.name, set: card.set.name } : null,
        binders: binders ?? [],
      };
    }
  }
  return { error: "Unknown tool" };
}

const NEEDS_DATA =
  /card show|chase|trade-?up|trend|went up|went down|value|worth|price|complete .*set|share my taste|collectors|binder|video|orders?\b|my cards|my collection|add .* (?:to|into) my|wishlist/i;

// Popular chase cards (checked in TCGdex) whose prices show where collectors are heading.
const TREND_CARDS = [
  "sv08.5-161",
  "me02-125",
  "sv03.5-199",
  "swsh7-215",
  "swsh12-186",
  "sv08.5-156",
  "sv04.5-234",
  "sv08-238",
  "sv03.5-201",
  "swsh11-186",
  "me01-180",
  "sv09-184",
  "sv08.5-167",
];

/** 7-day vs 30-day average price change for these cards, biggest rise first. A few lookups at a
 *  time, retrying once, so a busy moment at TCGdex does not lose them all. */
async function priceMoves(ids: string[]) {
  // A few lookups at a time, retrying once, so a busy moment at TCGdex does not lose them all.
  const lookup = (id: string) =>
    getCardPricing(id).catch(() =>
      new Promise((r) => setTimeout(r, 400)).then(() => getCardPricing(id).catch(() => null)),
    );
  const priced: Awaited<ReturnType<typeof lookup>>[] = [];
  for (let i = 0; i < ids.length; i += 6)
    priced.push(...(await Promise.all(ids.slice(i, i + 6).map(lookup))));
  const rows = await Promise.all(
    priced.map(async (r) => {
      const cm = r?.pricing?.cardmarket as { avg7?: number; avg30?: number } | undefined;
      if (!r || !cm?.avg7 || !cm.avg30) return null;
      const range = usdRange(r.pricing);
      return {
        card: `${r.card.name} ${r.card.localId}`,
        set: r.card.set.name,
        change_pct: Math.round(((cm.avg7 - cm.avg30) / cm.avg30) * 1000) / 10,
        todays_price_range_usd: range ? `US$${range.low} to US$${range.high}` : undefined,
      };
    }),
  );
  const moves = rows.filter((x): x is NonNullable<typeof x> => x !== null);
  moves.sort((x, y) => y.change_pct - x.change_pct);
  return moves;
}

// "on 2 Nov 2026" in a memory template message, as YYYY-MM-DD.
const MONTH_NUM: Record<string, string> = {
  jan: "01",
  feb: "02",
  mar: "03",
  apr: "04",
  may: "05",
  jun: "06",
  jul: "07",
  aug: "08",
  sep: "09",
  oct: "10",
  nov: "11",
  dec: "12",
};
function templateDate(message: string): string | undefined {
  const m = /\bon (\d{1,2}) ([A-Za-z]{3})[a-z]* (\d{4})\b/.exec(message);
  const mon = m?.[2] ? MONTH_NUM[m[2].toLowerCase()] : undefined;
  return m && mon ? `${m[3]}-${mon}-${(m[1] ?? "").padStart(2, "0")}` : undefined;
}
const TEMPLATE_END = " Help me save this memory.";

/** One catalogue card for a label like "Charizard 125/094" or "Pikachu ex 25/25", or undefined
 *  when there is no single clear match. */
export async function cardFromLabel(label: string | undefined): Promise<ProposalCard | undefined> {
  const m = /^(.*?)\s+#?([A-Z]{0,3}\d{1,4}(?:\/[A-Z]{0,3}\d{1,4})?)$/i.exec(label?.trim() ?? "");
  if (!m?.[1] || !m[2]) return undefined;
  const found = await findCards(m[1], m[2]).catch(() => []);
  if (found.length !== 1 || !found[0]) return undefined;
  return (await briefCard(found[0].id).catch(() => null)) ?? undefined;
}

async function buildProposal(
  db: DB,
  userId: string,
  name: string,
  a: Args,
  message = "",
  seen: Set<string> | null = new Set(),
): Promise<Proposal | { error: string }> {
  if (!isWriteTool(name)) return { error: "Unknown tool" };
  const parsed = validateWriteArgs(name, a);
  if (!parsed.success)
    return { error: "Missing or invalid details. Ask the collector before proposing." };
  if (name === "add_card_to_collection" || name === "add_to_wishlist") {
    const card = await briefCard(s(a["card_id"]) ?? "");
    if (!card) return { error: "Card not found in the catalogue" };
    if (name === "add_to_wishlist") return { tool: name, card, note: s(a["note"]) };
    // A binder by name: one of the collector's own (RLS), else a new binder made on confirm.
    const binderName = s(a["binder_name"])
      ?.trim()
      .replace(/^["“”']+|["“”']+$/g, "");
    if (!binderName) return { tool: name, card };
    const { data: mine, error } = await db.from("binders").select("id, name");
    if (error) throw error;
    const found = (mine ?? []).find(
      (b) => b.name.trim().toLowerCase() === binderName.toLowerCase(),
    );
    return {
      tool: name,
      card,
      binder: found
        ? { id: found.id, name: found.name, new: false }
        : { name: binderName, new: true },
    };
  }
  if (name === "create_binder") {
    const list = Array.isArray(a["cards"]) ? (a["cards"] as Args[]) : [];
    const { data: owned, error } = await db.from("cards").select("tcgdex_id");
    if (error) throw error;
    if (list.some((c) => !owned.some((card) => card.tcgdex_id === c["card_id"])))
      return {
        error:
          "Use only cards the collector owns. Suggest unowned cards separately, never add them to their collection.",
      };
    const matched = await Promise.all(
      list.map((c) => briefCard(s(c["card_id"]) ?? "", s(c["reason"]))),
    );
    if (matched.some((c) => !c))
      return { error: "Some cards were not found. Ask the collector to clarify." };
    const cards = matched.filter((c): c is ProposalCard => Boolean(c));
    if (!cards.length) return { error: "None of those cards were found in the catalogue" };
    return {
      tool: "create_binder",
      name: s(a["name"]) ?? "New binder",
      description: s(a["description"]),
      cards,
    };
  }
  if (name === "set_order") {
    const r = await getCardPricing(s(a["card_id"]) ?? "");
    if (!r) return { error: "Card not found in the catalogue" };
    const range = usdRange(r.pricing);
    return {
      tool: "set_order",
      side: a["side"] === "sell" ? "sell" : "buy",
      card: {
        tcgdex_id: r.card.id,
        name: `${r.card.name} ${r.card.localId}`,
        image: cardImage(r.card.image, "low"),
        set_name: r.card.set.name,
      },
      price_usd: Math.round(Number(a["price_usd"]) * 100) / 100,
      market_usd: range?.typical,
      note: s(a["note"]),
      ...(() => {
        // Sell orders carry the condition read from the collector's photos.
        const condition = a["side"] === "sell" ? orderCondition.safeParse(a["condition"]) : null;
        return condition?.success ? { condition: condition.data } : {};
      })(),
    };
  }
  if (name === "save_memory") {
    if (!ownPhotoPath(s(a["photo_path"]), userId))
      return { error: "Photo must belong to the collector." };
    // Cards are optional: keep only ones Mori actually looked up, so a guessed id never shows the wrong card.
    const cid = s(a["card_id"]);
    const tid = s(a["traded_card_id"]);
    const card =
      cid && (!seen || seen.has(cid)) ? ((await briefCard(cid)) ?? undefined) : undefined;
    const traded_card =
      tid && (!seen || seen.has(tid)) ? ((await briefCard(tid)) ?? undefined) : undefined;
    // From the fill-in template, the story is exactly what the collector wrote (facts, feelings, ratings).
    const fromTemplate = message.endsWith(TEMPLATE_END);
    const story = fromTemplate
      ? message.slice(0, -TEMPLATE_END.length).trim()
      : (s(a["story"]) ?? "");
    const date = s(a["date"]) ?? (fromTemplate ? templateDate(message) : undefined);
    // A trade card the agent passed only by name ("Charizard 125/094") is looked up here, so the
    // memory shows the real card whenever the catalogue has exactly one match.
    const resolvedCard = card ?? (await cardFromLabel(s(a["card_name"])));
    const resolvedTraded = traded_card ?? (await cardFromLabel(s(a["traded_card_name"])));
    return {
      tool: "save_memory",
      title: s(a["title"]) ?? "A memory",
      story,
      place: s(a["place"]),
      with_whom: s(a["with_whom"]),
      date: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined,
      card: resolvedCard,
      traded_card: resolvedTraded,
      card_name: resolvedCard ? undefined : s(a["card_name"])?.slice(0, 160),
      traded_card_name: resolvedTraded ? undefined : s(a["traded_card_name"])?.slice(0, 160),
      photo_path: s(a["photo_path"]),
    };
  }
  return { error: "Unknown tool" };
}

/** Checks and tidies the model's pre-grade report before it is shown. */
function gradeReport(a: Args) {
  const num = (v: unknown, lo: number, hi: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : undefined;
  };
  const outcomes = (Array.isArray(a["outcomes"]) ? (a["outcomes"] as Args[]) : [])
    .map((o) => ({
      grade: num(o["grade"], 1, 10),
      probability: num(o["probability"], 0, 100) ?? 0,
      reason: s(o["reason"])?.slice(0, 120) ?? "",
    }))
    .filter(
      (o): o is { grade: number; probability: number; reason: string } => o.grade !== undefined,
    )
    .slice(0, 4);
  const take = s(a["take"])?.slice(0, 400);
  if (outcomes.length < 2 || !take)
    return { error: "Give at least two likely grades and Mori's take." };
  const total = outcomes.reduce((n, o) => n + o.probability, 0) || 1;
  outcomes.forEach((o) => (o.probability = Math.round((o.probability / total) * 100)));
  outcomes.sort((x, y) => y.grade - x.grade);
  const companies = ["psa", "cgc", "bgs", "tag"] as const;
  const block = (v: unknown, lo: number, hi: number) =>
    Object.fromEntries(
      companies.map((c) => [
        c,
        num((v && typeof v === "object" ? (v as Args) : {})[c], lo, hi) ?? null,
      ]),
    );
  const subs = a["subgrades"] && typeof a["subgrades"] === "object" ? (a["subgrades"] as Args) : {};
  return {
    card: s(a["card"])?.slice(0, 120),
    outcomes,
    take,
    confidence: num(a["confidence"], 0, 100) ?? 70,
    // Some models answer subgrades on a 1-10 scale (BGS style); show everything as 0-100.
    subgrades: Object.fromEntries(
      ["centering", "corners", "edges", "surface"].map((k) => [
        k,
        Object.fromEntries(
          Object.entries(block(subs[k], 0, 100)).map(([c, v]) => [
            c,
            v !== null && v <= 10 ? v * 10 : v,
          ]),
        ),
      ]),
    ),
    overall: block(a["overall"], 1, 10),
    notes: s(a["notes"])?.slice(0, 160),
  };
}

/** The conversation so far: everything since `since` (when the collector opened Ask Mori or tapped
 *  New chat), so a new chat starts with a clean slate instead of every message ever sent. */
async function history(db: DB, since?: string): Promise<ResponsesInputItem[]> {
  const data: { role: string; kind: string; content: string; payload: Json | null }[] = [];
  for (let offset = 0; ; offset += 500) {
    let q = db.from("mori_messages").select("role, kind, content, payload");
    if (since) q = q.gt("created_at", since);
    const page = await q
      .order("created_at")
      .order("id")
      .range(offset, offset + 499);
    if (page.error) throw page.error;
    data.push(...page.data);
    if (page.data.length < 500) break;
  }
  return data
    .filter((m) => m.kind !== "suggest")
    .map((m): ResponsesInputItem => {
      if (m.role === "user") return { role: "user", content: m.content };
      const text =
        m.kind === "status"
          ? `[Tool result: ${JSON.stringify(m.payload)}]`
          : m.kind === "confirm"
            ? `[Confirmation: ${JSON.stringify(m.payload)}]`
            : m.content;
      return { role: "assistant", content: [{ type: "output_text", text, annotations: [] }] };
    });
}

// The AI Gateway free tier allows only a few requests per minute per model provider, and one Mori
// answer takes several requests (tool calls). When a model is rate limited, try the next one; each
// provider has its own limit. All of these are on the free tier and support tools and images.
const FALLBACK_MODELS = [
  "openai/gpt-4.1-mini",
  "google/gemini-2.5-flash-lite",
  "openai/gpt-5-mini",
];
const MODELS = [MODEL, ...FALLBACK_MODELS.filter((m) => m !== MODEL)];

async function streamWithFallback(
  input: ResponsesInputItem[],
  signal: AbortSignal | undefined,
  oidcToken: string | null | undefined,
  mustUseTool = false,
) {
  for (let i = 0; ; i++) {
    try {
      return await streamResponse(
        {
          model: MODELS[i] ?? MODEL,
          instructions: SYSTEM,
          input,
          tools,
          ...(mustUseTool ? { tool_choice: "required" as const } : {}),
          max_output_tokens: 3000,
        },
        { ...(signal ? { signal } : {}), oidcToken: oidcToken ?? null },
      );
    } catch (e) {
      if (!(e instanceof GatewayError && e.code === "rate_limited") || i >= MODELS.length - 1)
        throw e;
    }
  }
}

export type MoriRowDraft = { role: "mori"; kind: string; content: string; payload?: Json };
export type MoriToolContext = {
  /** The collector's message this answer is for (memory templates keep their exact words). */
  message: string;
  /** Card ids looked up in this chat; null when the caller cannot know them (the MCP endpoint),
   *  in which case a card only has to exist in the catalogue. */
  seenIds: Set<string> | null;
  /** The card most recently priced in this answer, so a pre-grade report can name it. */
  lastCard: string;
};

/** Runs one of Mori's tools for this collector. `rows` are the chat cards it shows (confirmation,
 *  pre-grade report, profiles, storyboard, binders, orders); `stop` means the answer should end
 *  after it. Shared by the AI Gateway loop and the HarnessRouter MCP endpoint. */
export async function executeMoriTool(
  db: DB,
  userId: string,
  name: string,
  args: Args,
  ctx: MoriToolContext,
): Promise<{ result: unknown; rows: MoriRowDraft[]; stop: boolean }> {
  const rows: MoriRowDraft[] = [];
  let stop = false;
  let result: unknown;
  if (name === "pre_grade_report") {
    const report = gradeReport(args);
    if (!("error" in report) && !report.card && ctx.lastCard) report.card = ctx.lastCard;
    if ("error" in report) result = report;
    else {
      rows.push({
        role: "mori",
        kind: "grade",
        content: `Pre-grade${report.card ? ` for ${report.card}` : ""}: ${report.outcomes
          .map((o) => `${o.grade} (${o.probability}%)`)
          .join(", ")}. ${report.take}`,
        payload: report as unknown as Json,
      });
      result = { shown_to_user: true, note: "The report is on screen." };
      stop = true;
    }
  } else if (name === "show_collectors") {
    // Only real public profiles; Mori supplies the reason.
    const picks = (Array.isArray(args["picks"]) ? (args["picks"] as Args[]) : []).slice(0, 4);
    const { data } = await db.rpc("list_public_collectors", { p_query: "" });
    const all = (Array.isArray(data) ? data : []) as {
      display_name?: string;
      username?: string;
      avatar_url?: string;
    }[];
    const people = picks
      .map((x) => {
        const c = all.find((o) => o.username === (s(x["username"]) ?? "").replace(/^@/, ""));
        return c
          ? {
              name: c.display_name ?? c.username,
              username: c.username,
              avatar: c.avatar_url ?? null,
              why: (s(x["why"]) ?? "").slice(0, 140),
            }
          : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    if (!people.length)
      result = { error: "Use usernames exactly as find_collectors returned them." };
    else {
      rows.push({
        role: "mori",
        kind: "people",
        content: `Collectors you may like: ${people.map((x) => x.name).join(", ")}`,
        payload: { people } as unknown as Json,
      });
      result = {
        shown_to_user: true,
        note: "The profile cards are on screen. Reply in one short line.",
      };
    }
  } else if (name === "show_tickets") {
    // The organiser's own ticket page; the collector pays there (Bindory never takes payment).
    let url = "";
    try {
      const u = new URL(s(args["ticket_url"]) ?? "");
      if (u.protocol === "https:" && !/(^|\.)bindory\.app$/i.test(u.hostname)) url = u.toString();
    } catch {
      url = "";
    }
    const clip = (v: unknown, n: number) => (s(v) ?? "").replace(/\s+/g, " ").trim().slice(0, n);
    const options = (Array.isArray(args["options"]) ? (args["options"] as Args[]) : [])
      .map((o) => ({
        name: clip(o["name"], 80),
        price: clip(o["price"], 30),
        note: clip(o["note"], 120),
      }))
      .filter((o) => o.name)
      .slice(0, 8);
    const event = clip(args["event"], 100);
    if (!url || !event)
      result = {
        error:
          "Give the event name and its official ticket page (an https link from the page you read).",
      };
    else {
      rows.push({
        role: "mori",
        kind: "tickets",
        content: `Tickets for ${event}`,
        payload: {
          event,
          date: clip(args["date"], 80),
          venue: clip(args["venue"], 120),
          url,
          options,
        } as unknown as Json,
      });
      result = {
        shown_to_user: true,
        note: "The ticket card is on screen: the collector picks a ticket and quantity and opens checkout to pay on the organiser's page. Reply in one or two short lines (which ticket suits them, if they said a day), and do not list the prices again.",
      };
    }
  } else if (name === "request_card_photos") {
    // Take a photo / Upload buttons; the photos come back as the collector's next message.
    rows.push({
      role: "mori",
      kind: "photos",
      content: "Front and back photos of your card",
      payload: { for: args["purpose"] === "grade" ? "grade" : "sell" } as Json,
    });
    result = {
      shown_to_user: true,
      note: "Take a photo and Upload buttons are on screen. In one short line, ask for the front and back on a dark, flat background with all four corners in view. Wait for the photos before set_order or pre_grade_report.",
    };
    stop = true;
  } else if (name === "plan_video") {
    // Storyboard from the collector's own cards; they post or save it with a button.
    const scenes = (Array.isArray(args["scenes"]) ? (args["scenes"] as Args[]) : []).slice(0, 6);
    const ids = scenes.map((x) => s(x["card_id"]) ?? "");
    const { data: owned } = await db
      .from("cards")
      .select("tcgdex_id, name, image_url")
      .in("tcgdex_id", ids.length ? ids : ["-"]);
    const frames = scenes
      .map((x) => {
        const c = (owned ?? []).find((o) => o.tcgdex_id === s(x["card_id"]));
        return c && c.image_url
          ? {
              name: c.name,
              image: c.image_url,
              caption: (s(x["caption"]) ?? "").slice(0, 120),
            }
          : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    if (frames.length < 2)
      result = { error: "Use 3-5 cards the collector owns (ids from list_my_cards)." };
    else {
      const title = (s(args["title"]) ?? "My collection").slice(0, 80);
      rows.push({
        role: "mori",
        kind: "video",
        content: `Video plan: ${title}`,
        payload: { title, frames } as unknown as Json,
      });
      result = {
        shown_to_user: true,
        note: "The storyboard is on screen with Post to profile and Save draft buttons. Reply in one short line.",
      };
    }
  } else if (name === "suggest_binder_for_card") {
    // The collector picks the binder with an Add here button; Mori only suggests one.
    result = await runReadTool(db, name, args).catch((e: unknown) => ({
      error: e instanceof Error ? e.message : "Tool failed",
    }));
    const r = result as {
      card?: { id: string; name: string } | null;
      binders?: { id: string; name: string; binder_cards?: { count: number }[] }[];
    };
    const owned = r.card
      ? await db.from("cards").select("id").eq("tcgdex_id", r.card.id).limit(1).maybeSingle()
      : null;
    if (!r.card) result = { error: "Card not found" };
    else if (!owned?.data)
      result = {
        note: "This card is not in the collection yet. Offer to add it to the collection first.",
      };
    else if (!r.binders?.length)
      result = {
        note: "The collector has no binders yet. Offer to build one with this card.",
      };
    else {
      rows.push({
        role: "mori",
        kind: "binders",
        content: `Pick a binder for ${r.card.name}`,
        payload: {
          card: { name: r.card.name, owned_card_id: owned.data.id },
          binders: r.binders.map((b) => ({
            id: b.id,
            name: b.name,
            count: b.binder_cards?.[0]?.count ?? 0,
          })),
        } as unknown as Json,
      });
      result = {
        shown_to_user: true,
        binders: r.binders.map((b) => ({ name: b.name })),
        note: "The binders are on screen, each with an Add here button. In one or two short sentences, say which binder fits best and why. Never claim you added the card.",
      };
    }
  } else if (name === "list_my_orders") {
    // Open orders are shown as cards with a Cancel button; Mori only summarises them.
    result = await runReadTool(db, name, args).catch((e: unknown) => ({
      error: e instanceof Error ? e.message : "Tool failed",
    }));
    if (Array.isArray(result) && result.length) {
      rows.push({
        role: "mori",
        kind: "orders",
        content: `${result.length} open order${result.length > 1 ? "s" : ""}`,
        payload: { orders: result } as unknown as Json,
      });
      result = {
        shown_to_user: true,
        count: result.length,
        note: 'The open orders are on screen as cards, each with a Cancel button. Reply in one short, warm line such as "Here are your open orders. Tap Cancel on any you no longer want." Do not list them again.',
      };
    }
  } else if (
    (name === "add_to_wishlist" || name === "add_card_to_collection") &&
    ctx.seenIds !== null &&
    !ctx.seenIds.has(s(args["card_id"]) ?? "")
  ) {
    result = {
      error:
        "Look this card up first with search_catalogue (name and number) and use the id it returns.",
    };
  } else if (isWriteTool(name)) {
    const p = await buildProposal(db, userId, name, args, ctx.message, ctx.seenIds);
    if ("error" in p) result = p;
    else {
      const payload: ProposalPayload = { ...p, status: "pending" };
      rows.push({
        role: "mori",
        kind: "confirm",
        content: proposalTitle(p),
        payload: payload as unknown as Json,
      });
      result = { shown_to_user: true, note: "Waiting for the user to tap Confirm or Edit." };
      stop = true;
    }
  } else {
    result = await runReadTool(db, name, args).catch((e: unknown) => ({
      error: e instanceof Error ? e.message : "Tool failed",
    }));
  }
  // The card this answer is about, so the report and follow-ups can name it.
  if (name === "get_card_prices" && result && typeof result === "object" && "card" in result) {
    const c = (result as { card: { name?: string; number?: string; set?: string } }).card;
    if (c.name)
      ctx.lastCard = `${c.name}${c.number ? ` ${c.number}` : ""}${c.set ? ` (${c.set})` : ""}`;
  }
  for (const m of JSON.stringify(result ?? null).matchAll(/"(?:id|tcgdex_id)":"([^"]+)"/g))
    if (m[1]) ctx.seenIds?.add(m[1]);
  return { result, rows, stop };
}

/** Which agent runtime answers: "harnessrouter" (the Ask Mori harness) or "gateway" (default, and
 *  the rollback). Set with MORI_RUNTIME in the server environment. */
export const moriRuntime = (): "harnessrouter" | "gateway" =>
  process.env["MORI_RUNTIME"]?.trim() === "harnessrouter" ? "harnessrouter" : "gateway";

/** Server execution only: shared by the authenticated RPC and streaming HTTP handler. */
export async function runMori(
  db: DB,
  userId: string,
  message: string,
  emit: (event: MoriStreamEvent) => void = () => {},
  signal?: AbortSignal,
  oidcToken?: string | null,
  images: string[] = [],
  since?: string,
  accessToken?: string,
  location?: string,
  country?: string,
) {
  // HarnessRouter runs Mori when MORI_RUNTIME=harnessrouter; it needs the collector's session for
  // the tool endpoint, so callers without one (the plain RPC) stay on AI Gateway.
  const onHarness = moriRuntime() === "harnessrouter" && Boolean(accessToken);
  const past = onHarness ? [] : await history(db, since);
  // The stored text notes the photos so later turns know they were sent (the images themselves are not stored).
  const stored = images.length
    ? `${message}\n[Sent ${images.length === 1 ? "a card photo: the front" : `${images.length} card photos: front and back`}]`
    : message;
  const ins = await db
    .from("mori_messages")
    // The chat this message belongs to (its start time, sent by the app), so History lists one
    // entry per chat and New chat always starts a new one.
    .insert({ role: "user", content: stored, payload: since ? ({ chat: since } as Json) : null })
    .select("created_at")
    .single();
  if (ins.error) throw ins.error;
  const askedAt = Date.parse(ins.data.created_at);
  // "Sync from Collectr" runs on its own harness in the background (collectr-sync.server.ts);
  // a plain follow-up right after a finished sync continues that task.
  const collectr = collectrSyncLink(message);
  const { startSync, latestSync } = await import("./collectr-sync.server");
  const priorSync =
    collectr === null && !routeMoriMessage(message, images.length > 0)
      ? await latestSync(db, userId, since)
      : null;
  if (collectr !== null || priorSync) {
    if (collectr !== null && !isCollectrLink(collectr))
      return finishMoriTurn(db, [], COLLECTR_BAD_LINK, askedAt, emit);
    try {
      const row = await startSync(
        db,
        userId,
        priorSync
          ? { followUp: message, prior: priorSync }
          : { link: collectr!, binder: collectrSyncBinder(message) },
      );
      const ins = await db
        .from("mori_messages")
        .insert(row)
        .select("id, role, kind, content, payload, created_at")
        .single();
      if (ins.error) throw ins.error;
      emit({ type: "done", rows: [ins.data as unknown as MoriRow] });
      return;
    } catch (e) {
      console.error("Collectr sync failed to start", e instanceof Error ? e.message : e);
      return finishMoriTurn(
        db,
        [],
        "I could not start the Collectr sync just now. Please try again in a moment.",
        askedAt,
        emit,
      );
    }
  }
  if (onHarness && accessToken) {
    const { runMoriHarness } = await import("./mori-harness.server");
    return runMoriHarness(
      db,
      userId,
      accessToken,
      message,
      emit,
      images,
      since,
      askedAt,
      signal,
      location,
      country,
    );
  }

  const input: ResponsesInputItem[] = [
    ...past,
    images.length
      ? {
          role: "user",
          content: [
            { type: "input_text", text: message },
            ...images.map((image_url) => ({ type: "input_image" as const, image_url })),
          ],
        }
      : { role: "user", content: message },
  ];
  const rows: { role: "mori"; kind: string; content: string; payload?: Json }[] = [];
  let finalText = "";
  const ctx: MoriToolContext = { message, seenIds: new Set<string>(), lastCard: "" };
  // Card ids Mori has actually looked up in this chat, so it never proposes a card from a guessed id.
  for (const id of JSON.stringify(past).match(/[a-z0-9.]+-[a-z0-9]+(?=\\?")/gi) ?? [])
    ctx.seenIds?.add(id);

  try {
    for (let turn = 0; turn < 6; turn++) {
      // Questions about the collector's own cards, prices or plans must look at real data first,
      // so the first step has to use a tool (the model sometimes answers from guesswork otherwise).
      const stream = await streamWithFallback(
        input,
        signal,
        oidcToken,
        turn === 0 && NEEDS_DATA.test(message),
      );
      let res: ResponsesResponse | undefined;
      for await (const event of stream) {
        if (event.type === "response.output_text.delta")
          emit({ type: "text", text: event.delta ?? "" });
        if (event.type === "response.completed") res = event.response;
        if (event.type === "response.incomplete") throw new Error("Mori response incomplete");
      }
      if (!res) throw new Error("Mori response did not complete");
      const output = res.output ?? [];
      const calls = output.filter((o) => o.type === "function_call");
      const text = output
        .filter((o) => o.type === "message")
        .flatMap((o) => o.content ?? [])
        .map((c) => (c.type === "output_text" ? c.text : ""))
        .join("")
        .trim();
      if (!calls.length) {
        finalText = text;
        break;
      }

      let stop = false;
      for (const call of calls) {
        const name = call.name ?? "";
        const args = (() => {
          try {
            return JSON.parse(call.arguments ?? "{}") as Args;
          } catch {
            return {};
          }
        })();
        emit({ type: "status", name, text: TOOL_STATUS[name] ?? "Working on it" });
        const statusRow: { role: "mori"; kind: string; content: string; payload: Json } = {
          role: "mori",
          kind: "status",
          content: TOOL_STATUS[name] ?? "Working on it",
          payload: { name, input: args as Json } as Json,
        };
        rows.push(statusRow);
        input.push({
          type: "function_call",
          call_id: call.call_id ?? "",
          name,
          arguments: call.arguments ?? "{}",
        });
        const out = await executeMoriTool(db, userId, name, args, ctx);
        rows.push(...out.rows);
        if (out.stop) stop = true;
        const result = out.result;
        statusRow.payload = {
          name,
          input: args as Json,
          output: JSON.parse(JSON.stringify(result)) as Json,
        };
        input.push({
          type: "function_call_output",
          call_id: call.call_id ?? "",
          output: JSON.stringify(result).slice(0, 8000),
        });
      }
      if (stop) {
        finalText = text;
        break;
      }
    }
  } catch (e) {
    if (signal?.aborted) throw e;
    console.error(
      "Mori gateway error",
      e instanceof GatewayError ? { code: e.code, ids: e.ids } : e,
    );
    finalText =
      e instanceof GatewayError && e.code === "rate_limited"
        ? "I am a little busy right now. Please try again in a moment."
        : "Sorry, I could not answer just now. Please try again.";
  }

  return finishMoriTurn(db, rows, finalText, askedAt, emit);
}

/** A reply's parts, one chat bubble each: the agent separates them with a line of "---". */
export function replyParts(text: string): string[] {
  return text
    .split(/\n[ \t]*-{3,}[ \t]*(?:\n|$)/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/** Ends one answer: pulls out the follow-up suggestions, puts the reply before any card, and saves
 *  every row in order after the question. `hr` (HarnessRouter ids) is kept on the turn's last text
 *  or status row so the next message can continue the same session. */
export async function finishMoriTurn(
  db: DB,
  rows: MoriRowDraft[],
  text: string,
  askedAt: number,
  emit: (event: MoriStreamEvent) => void,
  hr?: { response_id: string; session_id: string; agent?: string },
  /** Show only the cards (a price check's market card): the reply text is dropped, its
   *  suggestions are kept. */
  cardsOnly = false,
) {
  let finalText = text;
  if (!finalText && !rows.some((row) => row.kind === "confirm" || row.kind === "grade"))
    finalText = "I could not finish that request. Please try again.";
  // Pull out the follow-up questions Mori suggests (shown as buttons under the answer).
  let suggestions: string[] = [];
  const tail = /(?:^|\n|(?<=[.?!])[ \t]+)[ \t*_]*suggestions?[ \t*_]*:(.*)$/is.exec(finalText);
  if (tail) {
    suggestions = (tail[1] ?? "")
      .split(/\||\n/)
      .map((x) => x.replace(/^[\s"'*•\-\d.)]+|[\s"'*]+$/g, ""))
      .filter((x) => x.length > 2 && x.length <= 80);
    finalText = finalText.slice(0, tail.index).trim();
  }
  // Answers the collector can tap when Mori asked them something ("Choices: Both days | ...").
  let choices: string[] = [];
  const asked = /(?:^|\n|(?<=[.?!])[ \t]+)[ \t*_]*choices?[ \t*_]*:(.*)$/is.exec(finalText);
  if (asked) {
    choices = [
      ...new Set(
        (asked[1] ?? "")
          .split(/\||\n/)
          .map((x) => x.replace(/^[\s"'*•\-\d.)]+|[\s"'*]+$/g, ""))
          .filter((x) => x.length > 0 && x.length <= 90),
      ),
    ].slice(0, 6);
    finalText = finalText.slice(0, asked.index).trim();
  }
  if (rows.some((r) => r.kind === "grade"))
    suggestions = [
      "Where can I send it for grading?",
      "What does grading cost?",
      // "This card" is the card in the photos; Mori resolves it from the chat.
      "Price check this card",
    ];
  if (!suggestions.length && !choices.length)
    suggestions = [
      "Price check a card",
      "What card should I chase next?",
      "Start a trade-up challenge",
    ];
  suggestions = [...new Set(suggestions)].slice(0, 3);
  // A confirmation card is the next step itself; follow-ups come after Confirm instead.
  if (rows.some((r) => r.kind === "confirm" || r.kind === "photos")) suggestions = choices = [];
  // A question with answers to tap replaces the general next steps.
  if (choices.length >= 2) suggestions = [];
  else choices = [];
  if (cardsOnly) finalText = "";

  if (finalText) {
    // Put the reply before any confirmation card so it reads naturally.
    const confirmAt = rows.findIndex(
      (r) =>
        r.kind === "confirm" ||
        r.kind === "grade" ||
        r.kind === "orders" ||
        r.kind === "binders" ||
        r.kind === "video" ||
        r.kind === "people" ||
        r.kind === "price" ||
        r.kind === "tickets" ||
        r.kind === "photos",
    );
    // One bubble per part: a reply that answers several things separates them with a "---" line.
    const replies = replyParts(finalText).map((content) => ({
      role: "mori" as const,
      kind: "text",
      content,
    }));
    if (confirmAt >= 0) rows.splice(confirmAt, 0, ...replies);
    else rows.push(...replies);
  }
  if (choices.length)
    rows.push({ role: "mori", kind: "choices", content: "", payload: { choices } });
  if (suggestions.length)
    rows.push({ role: "mori", kind: "suggest", content: "", payload: { suggestions } });
  if (hr) {
    const holder = [...rows].reverse().find((r) => r.kind === "text" || r.kind === "status");
    if (holder)
      holder.payload = {
        ...(holder.payload && typeof holder.payload === "object" && !Array.isArray(holder.payload)
          ? holder.payload
          : {}),
        hr,
      } as Json;
    else rows.push({ role: "mori", kind: "status", content: "Answered", payload: { hr } as Json });
  }
  // One insert gives every row the same time, and history is read back in time order, so give each
  // row its own millisecond (after the question) to keep the answer in order next time.
  const base = Math.max(Date.now(), Number.isFinite(askedAt) ? askedAt + 1 : 0);
  const out = await db
    .from("mori_messages")
    .insert(rows.map((r, i) => ({ ...r, created_at: new Date(base + i).toISOString() })))
    .select("id, role, kind, content, payload, created_at");
  if (out.error) throw out.error;
  emit({ type: "done", rows: out.data });
  return out.data;
}
