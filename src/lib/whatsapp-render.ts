import { MARKETS } from "./market";
import { asObject, stringArg } from "./mori-context.server";
import { PHOTO_INSTRUCTIONS } from "./mori-order.server";
import { isWriteTool, proposalTitle, type MoriRow, type Proposal } from "./mori-tools";

/** Official Meta WhatsApp Cloud API (v27.0) outbound message limits. */
export const WHATSAPP_LIMITS = {
  textBody: 4096,
  imageCaption: 1024,
  interactiveBody: 1024,
  footer: 60,
  buttonMax: 3,
  buttonTitle: 20,
  buttonId: 256,
  listMaxRows: 10,
  listButton: 20,
  listSectionTitle: 24,
  listRowTitle: 24,
  listRowDescription: 72,
  listRowId: 200,
  ctaDisplayText: 20,
} as const;

export type WhatsAppMessage =
  | { type: "text"; text: { body: string; preview_url?: boolean } }
  | { type: "image"; image: { link: string; caption?: string } }
  | {
      type: "interactive";
      interactive:
        | {
            type: "button";
            header?: { type: "image"; image: { link: string } };
            body: { text: string };
            footer?: { text: string };
            action: { buttons: Array<{ type: "reply"; reply: { id: string; title: string } }> };
          }
        | {
            type: "list";
            body: { text: string };
            footer?: { text: string };
            action: {
              button: string;
              sections: Array<{
                title?: string;
                rows: Array<{ id: string; title: string; description?: string }>;
              }>;
            };
          }
        | {
            type: "cta_url";
            body: { text: string };
            footer?: { text: string };
            action: { name: "cta_url"; parameters: { display_text: string; url: string } };
          };
    }
  | { type: "template"; template: { name: string; language: { code: string } } };

// Prices, card numbers (125/094, TG30/TG30), percentages, and decimal grades must not be cut mid-token.
const PROTECTED_TOKEN =
  /(?:(?:US|AU|CA|NZ|HK|SG)?\$|[£€¥])\s*\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s*(?:USD|AUD|CAD|GBP|EUR|JPY)\b|\b[A-Z]{0,4}\d+[A-Z]?\/[A-Z]{0,4}\d+[A-Z]?\b|\b\d+(?:\.\d+)?%|\b\d+\.\d+\b/gi;

const CURRENCY_SYMBOL: Record<string, string> = Object.fromEntries(
  Object.values(MARKETS).map((m) => [m.currency, m.symbol]),
);
const GRADE_LABEL: Record<number, string> = {
  10: "Gem mint",
  9.5: "Gem mint",
  9: "Mint",
  8.5: "Near mint-mint+",
  8: "Near mint-mint",
  7: "Near mint",
  6: "Excellent-mint",
  5: "Excellent",
};
const ORDER_STATUS: Record<string, string> = {
  cancelled: "Cancelled",
  filled: "Filled",
  expired: "Expired",
  pending: "Pending payment",
};
const GRADERS = [
  ["psa", "PSA"],
  ["cgc", "CGC"],
  ["bgs", "BGS"],
  ["tag", "TAG"],
] as const;
const SUBS = [
  ["centering", "Centering"],
  ["corners", "Corners"],
  ["edges", "Edges"],
  ["surface", "Surface"],
] as const;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

const normalize = (raw: string, keepLines: boolean): string => {
  const cleaned = raw.replace(/\r\n?/g, "\n").replace(/\p{Cc}/gu, (c) => (c === "\n" ? "\n" : " "));
  if (!keepLines) return cleaned.replace(/\s+/g, " ").trim();
  return cleaned
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};

const safeUtf16Cut = (s: string, index: number): number => {
  const i = Math.max(0, Math.min(index, s.length));
  if (i === 0 || i === s.length) return i;
  const code = s.charCodeAt(i - 1);
  return code >= 0xd800 && code <= 0xdbff ? i - 1 : i;
};

/** Clip to `max` UTF-16 code units without splitting surrogate pairs, words, prices, card numbers, or grades. */
function clipSafe(raw: string, max: number, keepLines = false): string {
  const text = normalize(raw, keepLines);
  if (max <= 0 || !text) return "";
  if (text.length <= max) return text;
  if (max === 1) return "…";

  let cut = safeUtf16Cut(text, max - 1);
  let backedOff = false;
  for (const m of text.matchAll(PROTECTED_TOKEN)) {
    const start = m.index ?? 0;
    if (start < cut && cut < start + m[0].length) {
      cut = start;
      backedOff = true;
      break;
    }
  }
  if (!backedOff && cut < text.length && !/\s/.test(text[cut] ?? "")) {
    const ws = text.slice(0, cut).search(/\s+\S*$/);
    if (ws > 0) cut = ws;
  }
  let head = text.slice(0, safeUtf16Cut(text, cut)).trimEnd();
  if (backedOff) head = head.replace(/(?:\s+(?:at|for|of|to|from|in|about|up to))$/i, "");
  head = head.replace(/(?:(?:US|AU|CA)?\$|[£€¥]|[,:;\-–—·(/])\s*$/i, "").trimEnd();
  return head ? `${head}…` : "…";
}

function splitText(raw: string): string[] {
  const text = normalize(raw, true);
  if (!text) return [];
  const limit = WHATSAPP_LIMITS.textBody;
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = safeUtf16Cut(rest, limit);
    const para = rest.lastIndexOf("\n\n", cut);
    const line = rest.lastIndexOf("\n", cut);
    const space = rest.lastIndexOf(" ", cut);
    if (para >= limit * 0.4) cut = para;
    else if (line >= limit * 0.4) cut = line;
    else if (space > 0) cut = space;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

const formatMoriText = (raw: string): string =>
  normalize(raw, true)
    .replace(/(^|\n)[ \t]*[*-][ \t]+/g, "$1• ")
    .replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)(?<!\s)\*(?!\*)/g, "$1_$2_")
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label: string, url: string) =>
      label.trim() === url.trim() ? url : `${label} (${url})`,
    )
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

const validHttpsUrl = (v: unknown): string | undefined => {
  const s = stringArg(v);
  if (!s) return undefined;
  try {
    const u = new URL(s);
    return u.protocol === "https:" && !u.username && !u.password ? u.toString() : undefined;
  } catch {
    return undefined;
  }
};

const tcgdexImageUrl = (v: unknown): string | undefined => {
  const url = validHttpsUrl(v);
  return url && new URL(url).hostname === "assets.tcgdex.net" ? url : undefined;
};

const validId = (raw: string, max: number): string | null => {
  const id = raw.trim();
  return id.length > 0 && id.length <= max ? id : null;
};

function uniqueButtonTitle(raw: string, seen: Set<string>, index: number): string {
  const clipped = clipSafe(raw, WHATSAPP_LIMITS.buttonTitle);
  const base = clipped && clipped !== "…" ? clipped : `Option ${index + 1}`;
  if (!seen.has(base.toLowerCase())) {
    seen.add(base.toLowerCase());
    return base;
  }
  for (let n = 2; n <= 99; n++) {
    const suffix = ` ${n}`;
    const prefix = clipSafe(raw, WHATSAPP_LIMITS.buttonTitle - suffix.length);
    const candidate = `${prefix && prefix !== "…" ? prefix : "Option"}${suffix}`;
    if (!seen.has(candidate.toLowerCase())) {
      seen.add(candidate.toLowerCase());
      return candidate;
    }
  }
  return base;
}

export function textMessage(body: string): WhatsAppMessage {
  return { type: "text", text: { body: clipSafe(body, WHATSAPP_LIMITS.textBody, true) || " " } };
}

export function buttonMessage(
  body: string,
  actions: ReadonlyArray<{ id: string; title: string }>,
  options?: { headerImageUrl?: string; footer?: string },
): WhatsAppMessage {
  const seenIds = new Set<string>();
  const seenTitles = new Set<string>();
  const buttons: Array<{ type: "reply"; reply: { id: string; title: string } }> = [];
  for (const action of actions) {
    if (buttons.length >= WHATSAPP_LIMITS.buttonMax) break;
    const id = validId(action.id, WHATSAPP_LIMITS.buttonId);
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);
    buttons.push({
      type: "reply",
      reply: { id, title: uniqueButtonTitle(action.title, seenTitles, buttons.length) },
    });
  }
  if (!buttons.length) throw new Error("buttonMessage requires at least one valid action");
  const headerLink = options?.headerImageUrl ? validHttpsUrl(options.headerImageUrl) : undefined;
  const footer = options?.footer ? clipSafe(options.footer, WHATSAPP_LIMITS.footer) : "";
  return {
    type: "interactive",
    interactive: {
      type: "button",
      ...(headerLink ? { header: { type: "image", image: { link: headerLink } } } : {}),
      body: { text: clipSafe(body, WHATSAPP_LIMITS.interactiveBody, true) || "Choose an option" },
      ...(footer ? { footer: { text: footer } } : {}),
      action: { buttons },
    },
  };
}

export function listMessage(
  body: string,
  label: string,
  rows: ReadonlyArray<{ id: string; title: string; description?: string }>,
  options?: { sectionTitle?: string; footer?: string },
): WhatsAppMessage {
  const seenIds = new Set<string>();
  const safeRows: Array<{ id: string; title: string; description?: string }> = [];
  for (const row of rows) {
    if (safeRows.length >= WHATSAPP_LIMITS.listMaxRows) break;
    const id = validId(row.id, WHATSAPP_LIMITS.listRowId);
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);
    const clipped = clipSafe(row.title, WHATSAPP_LIMITS.listRowTitle);
    const title = clipped && clipped !== "…" ? clipped : `Option ${safeRows.length + 1}`;
    const desc = row.description
      ? clipSafe(row.description, WHATSAPP_LIMITS.listRowDescription)
      : "";
    safeRows.push({ id, title, ...(desc && desc !== "…" ? { description: desc } : {}) });
  }
  if (!safeRows.length) throw new Error("listMessage requires at least one valid row");
  const sectionTitle = options?.sectionTitle
    ? clipSafe(options.sectionTitle, WHATSAPP_LIMITS.listSectionTitle)
    : "";
  const footer = options?.footer ? clipSafe(options.footer, WHATSAPP_LIMITS.footer) : "";
  return {
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: clipSafe(body, WHATSAPP_LIMITS.interactiveBody, true) || "Choose an option" },
      ...(footer ? { footer: { text: footer } } : {}),
      action: {
        button: clipSafe(label, WHATSAPP_LIMITS.listButton) || "Choose",
        sections: [{ ...(sectionTitle ? { title: sectionTitle } : {}), rows: safeRows }],
      },
    },
  };
}

export function linkMessage(
  body: string,
  label: string,
  url: string,
  options?: { footer?: string },
): WhatsAppMessage {
  const safeUrl = validHttpsUrl(url);
  if (!safeUrl) throw new Error("linkMessage requires a valid https URL");
  const footer = options?.footer ? clipSafe(options.footer, WHATSAPP_LIMITS.footer) : "";
  return {
    type: "interactive",
    interactive: {
      type: "cta_url",
      body: { text: clipSafe(body, WHATSAPP_LIMITS.interactiveBody, true) || "Open link" },
      ...(footer ? { footer: { text: footer } } : {}),
      action: {
        name: "cta_url",
        parameters: {
          display_text: clipSafe(label, WHATSAPP_LIMITS.ctaDisplayText) || "Open link",
          url: safeUrl,
        },
      },
    },
  };
}

const formatMoney = (amount: number, symbolOrCurrency: string): string => {
  const upper = symbolOrCurrency.toUpperCase();
  const sym = CURRENCY_SYMBOL[upper] ?? (/^[A-Z]{3}$/.test(upper) ? `${upper} ` : symbolOrCurrency);
  return `${sym}${amount.toLocaleString("en-US", {
    minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
};

const formatIsoDate = (iso: string): string => {
  const d = /^\d{4}-\d{2}-\d{2}/.test(iso) ? new Date(`${iso.slice(0, 10)}T12:00:00Z`) : null;
  return d && !Number.isNaN(d.getTime())
    ? d.toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      })
    : iso;
};

function formatPriceRow(row: MoriRow): { text: string; imageUrl?: string } | null {
  const p = asObject(row.payload);
  const card = asObject(p["card"]);
  const market = asObject(p["market"]);
  const listings = p["listings"] ? asObject(p["listings"]) : null;
  const scale = p["scale"] ? asObject(p["scale"]) : null;
  const sold = p["sold"] ? asObject(p["sold"]) : null;
  if (!listings && !scale && !sold)
    return row.content ? { text: formatMoriText(row.content) } : null;

  const money = (n: number) => formatMoney(n, stringArg(market["symbol"]) ?? "US$");
  const country = stringArg(market["country"]) ?? "your country";
  const name = [stringArg(card["name"]), stringArg(card["number"])].filter(Boolean).join(" ");
  const headline = num(p["headline"]);
  const lines = [`*${name || "Price check"}*${headline !== null ? ` · ${money(headline)}` : ""}`];
  const meta = [stringArg(card["set"]), stringArg(card["rarity"])].filter(Boolean).join(" · ");
  if (meta) lines.push(meta);

  const rawSold = sold?.["raw"] ? asObject(sold["raw"]) : null;
  if (listings) {
    const cond = stringArg(sold?.["condition"]);
    lines.push(`Listing and Sold${cond ? ` · ${cond}` : ""}`);
    const none = listings["read"] === false ? "–" : "None listed";
    const listingLine = (label: string, raw: unknown) => {
      const item = raw && typeof raw === "object" ? asObject(raw) : null;
      const val = item ? (num(item["total"]) ?? num(item["price"])) : null;
      if (!item || val === null) return `• ${label}: ${none}`;
      const fees = num(item["import_fees"]);
      const note =
        num(item["total"]) === null
          ? ""
          : fees && fees > 0
            ? ` (from ${stringArg(item["from"]) ?? "overseas"}, incl. postage + est. import tax & fees)`
            : " (incl. postage)";
      return `• ${label}: ${money(val)}${note}`;
    };
    lines.push(
      listingLine("Lowest listing (worldwide)", listings["world"]),
      listingLine(`Lowest listing (${country})`, listings["local"]),
    );
    const avg3 = rawSold ? num(rawSold["avg_last_3"]) : null;
    const nSold = rawSold ? num(rawSold["sales"]) : null;
    lines.push(
      `• Last 3 sold (${country}): ${
        avg3 !== null
          ? `${money(avg3)}${nSold && nSold < 3 ? ` (${nSold} sale${nSold === 1 ? "" : "s"})` : ""}`
          : "No recent sales"
      }`,
    );
  } else {
    for (const [label, key] of [
      ["Lowest listing", "low"],
      ["Market price", "market"],
      ["Mid price", "mid"],
    ] as const) {
      const v = num(scale?.[key]);
      if (v !== null) lines.push(`• ${label}: ${money(v)}`);
    }
    const avg = rawSold
      ? (num(rawSold["avg_last_3"]) ?? num(rawSold["avg_last_5"]) ?? num(rawSold["value"]))
      : null;
    if (avg !== null) lines.push(`• Recent sales (${country}): ${money(avg)}`);
  }

  const imageUrl = tcgdexImageUrl(card["image"]);
  return { text: lines.join("\n"), ...(imageUrl ? { imageUrl } : {}) };
}

function formatGradeRow(row: MoriRow): string | null {
  const p = asObject(row.payload);
  const parsed = (Array.isArray(p["outcomes"]) ? p["outcomes"] : [])
    .map((o) => {
      const obj = asObject(o);
      return {
        grade: num(obj["grade"]),
        pct: num(obj["probability"]),
        reason: stringArg(obj["reason"]),
      };
    })
    .filter(
      (o): o is { grade: number; pct: number; reason: string | undefined } =>
        o.grade !== null && o.pct !== null,
    );
  if (!parsed.length) return row.content ? formatMoriText(row.content) : null;

  const top = parsed.reduce((best, cur) => (cur.pct > best.pct ? cur : best), parsed[0]!);
  const card = stringArg(p["card"]);
  const lines = [card ? `*Should I grade?* · ${card}` : "*Should I grade?*"];
  for (const o of parsed) {
    const detail = o === top ? "Most likely outcome" : o.reason;
    lines.push(
      `• *${o.grade} (${GRADE_LABEL[o.grade] ?? `Grade ${o.grade}`})* — ${Math.round(o.pct)}%${detail ? ` · ${detail}` : ""}`,
    );
  }
  const take = stringArg(p["take"]);
  if (take) lines.push(`Mori’s take: ${take}`);
  const raw = p["raw_price"] ? asObject(p["raw_price"]) : null;
  const rawAmt = raw ? num(raw["amount"]) : null;
  const rawCur = raw ? stringArg(raw["currency"]) : undefined;
  if (rawAmt !== null && rawCur) lines.push(`Raw price: ${formatMoney(rawAmt, rawCur)}`);
  else if (stringArg(p["price_note"])) lines.push(stringArg(p["price_note"])!);

  const confidence = num(p["confidence"]);
  const subgrades = p["subgrades"] ? asObject(p["subgrades"]) : null;
  const overall = p["overall"] ? asObject(p["overall"]) : null;
  if (subgrades || overall) {
    lines.push(
      `Subgrade report${confidence !== null ? ` · Confidence ${Math.round(confidence)}%` : ""}`,
    );
    for (const [key, label] of SUBS) {
      const scores = asObject(subgrades?.[key]);
      const parts = GRADERS.map(([g, n]) =>
        num(scores[g]) !== null ? `${n} ${Math.round(num(scores[g])!)}%` : null,
      ).filter(Boolean);
      if (parts.length) lines.push(`• ${label}: ${parts.join(" · ")}`);
    }
    const overallParts = GRADERS.map(([g, n]) =>
      num(overall?.[g]) !== null ? `${n} ${num(overall?.[g])}` : null,
    ).filter(Boolean);
    if (overallParts.length) lines.push(`• Grade: ${overallParts.join(" · ")}`);
  }
  if (stringArg(p["notes"])) lines.push(stringArg(p["notes"])!);
  lines.push("Estimates from your photos, not official grades.");
  return lines.join("\n");
}

function formatConfirmRow(row: MoriRow) {
  const raw = asObject(row.payload);
  const tool = stringArg(raw["tool"]);
  if (!tool || !isWriteTool(tool)) {
    const fallback = formatMoriText(row.content);
    return fallback
      ? { body: fallback, compactBody: fallback, pending: false, confirmLabel: "Confirm" }
      : null;
  }
  const p = raw as unknown as Proposal & { status?: string; expires_days?: number };
  const status = stringArg(raw["status"]);
  const pending = status === "pending";
  const title = proposalTitle(p);
  const lines: string[] = [];
  let headerImageUrl: string | undefined;

  if (p.tool === "set_order") {
    const buy = p.side !== "sell";
    const cur = p.price?.currency ?? "USD";
    const amt = p.price?.amount ?? p.price_usd;
    const rate = p.fx_rate ?? 1;
    headerImageUrl = tcgdexImageUrl(p.card?.image);
    lines.push(
      `*${buy ? "Buy order" : "Sell order"}*`,
      `*${p.card.name}*${p.card.set_name ? ` · ${p.card.set_name}` : ""}`,
      `${buy ? "Buy for up to" : "Sell for at least"}: ${formatMoney(amt, cur)}`,
    );
    if (cur !== "USD") lines.push(`US$ equivalent: ${formatMoney(p.price_usd, "USD")}`);
    if (p.market_reference === undefined) {
      if (typeof p.market_usd === "number")
        lines.push(`Market reference: About ${formatMoney(p.market_usd * rate, cur)}`);
    } else if (!p.market_reference) {
      lines.push("Market comparison: No market reference is available.");
    } else {
      const ref = p.market_reference;
      const target = ref.currency === cur ? amt : ref.currency === "USD" ? p.price_usd : null;
      const refVal = formatMoney(ref.amount, ref.currency);
      lines.push(
        target === null
          ? `Market comparison: The market reference is ${refVal} in a different currency.`
          : `Market comparison: Your target is ${target === ref.amount ? "at" : target < ref.amount ? "below" : "above"} the market reference of ${refVal}.`,
      );
    }
    lines.push(`Expires: In ${p.expires_days ?? 30} days`);
    if (p.condition?.overall) lines.push(`Condition: ${p.condition.overall}`);
    if (p.photos?.front && p.photos?.back)
      lines.push("Photos: Front and back, saved for your listing");
    if (p.note) lines.push(`Note: ${p.note}`);
  } else if (p.tool === "save_memory") {
    headerImageUrl = tcgdexImageUrl(p.card?.image ?? p.traded_card?.image);
    const gave = p.traded_card?.name ?? p.traded_card_name;
    const got = p.card?.name ?? p.card_name;
    lines.push("*New memory · Private*", `*${p.title}*`);
    if (p.story) lines.push(`Story: ${p.story}`);
    lines.push(
      `With: ${p.with_whom || "Not added"}`,
      `Where: ${p.place || "Not added"}`,
      `When: ${p.date ? formatIsoDate(p.date) : "Not added"}`,
    );
    if (gave && got) lines.push(`Traded: ${gave} → ${got}`);
    else if (got) lines.push(`Card: ${got}`);
    else if (gave) lines.push(`Card you gave: ${gave}`);
  } else {
    headerImageUrl =
      "card" in p ? tcgdexImageUrl(p.card?.image) : tcgdexImageUrl(p.cards[0]?.image);
    lines.push(`*${title}*`);
    if ("note" in p && p.note) lines.push(`Note: ${p.note}`);
    if (p.tool === "create_binder") {
      lines.push(`Cards: ${p.cards.length}`);
      if (p.description) lines.push(`About: ${p.description}`);
    }
  }

  lines.push(
    pending
      ? "Here it is. Nothing is saved until you confirm."
      : status === "confirmed"
        ? "Saved"
        : status === "edited"
          ? "Changed"
          : "Status unavailable",
  );
  return {
    body: lines.join("\n"),
    compactBody: `*${title}*\nHere it is. Nothing is saved until you confirm.`,
    pending,
    confirmLabel: p.tool === "set_order" ? "Save" : "Confirm",
    ...(headerImageUrl ? { headerImageUrl } : {}),
  };
}

function formatOrdersRow(row: MoriRow): string | null {
  const list = Array.isArray(asObject(row.payload)["orders"])
    ? (asObject(row.payload)["orders"] as unknown[])
    : [];
  if (!list.length) return row.content ? formatMoriText(row.content) : null;
  const lines: string[] = [];
  for (const item of list) {
    const o = asObject(item);
    const name = stringArg(o["card_name"]);
    const price = num(o["price_usd"]);
    if (!name || price === null) continue;
    const sell = o["side"] === "sell";
    const st = stringArg(o["status"]);
    const exp = stringArg(o["expires_at"]);
    const statusText =
      st === "open"
        ? exp
          ? `Open · expires ${formatIsoDate(exp)}`
          : "Open"
        : (st && Object.hasOwn(ORDER_STATUS, st) && ORDER_STATUS[st]) || "Status unavailable";
    lines.push(
      `• *${name}* — ${sell ? "Sell order" : "Buy order"}, ${sell ? "At least" : "Up to"} ${formatMoney(price, "USD")} (${statusText})`,
    );
  }
  if (!lines.length) return row.content ? formatMoriText(row.content) : null;
  lines.push("Open Bindory to manage or cancel orders.");
  return lines.join("\n");
}

function formatListOption(
  id: string,
  label: string,
): { id: string; title: string; description?: string } {
  const clean = normalize(label, false);
  if (clean.length <= WHATSAPP_LIMITS.listRowTitle) return { id, title: clean };
  const printing = clean.match(
    /^(.+?)\s+([A-Z]{0,4}\d+[A-Z]?(?:\/[A-Z]{0,4}\d+[A-Z]?)?)\s*\(([^)]+)\)$/i,
  );
  if (printing) {
    const [, name = "", number = "", set = ""] = printing;
    const nameBudget = WHATSAPP_LIMITS.listRowTitle - number.length - 1;
    const title =
      nameBudget >= 3
        ? `${clipSafe(name, nameBudget)} ${number}`
        : clipSafe(number, WHATSAPP_LIMITS.listRowTitle);
    return {
      id,
      title,
      description: clipSafe(`${name} · ${set}`, WHATSAPP_LIMITS.listRowDescription),
    };
  }
  return {
    id,
    title: clipSafe(clean, WHATSAPP_LIMITS.listRowTitle),
    description: clipSafe(clean, WHATSAPP_LIMITS.listRowDescription),
  };
}

function buildOptionsMessage(
  getBody: () => string,
  items: ReadonlyArray<{ id: string; label: string }>,
  listLabel: string,
  sectionTitle: string,
): WhatsAppMessage | null {
  const useButtons =
    items.length > 0 &&
    items.length <= WHATSAPP_LIMITS.buttonMax &&
    items.every((x) => {
      const clean = normalize(x.label, false);
      return (
        clean.length > 0 &&
        clean.length <= WHATSAPP_LIMITS.buttonTitle &&
        validId(x.id, WHATSAPP_LIMITS.buttonId)
      );
    }) &&
    new Set(items.map((x) => normalize(x.label, false).toLowerCase())).size === items.length;

  if (useButtons) {
    return buttonMessage(
      getBody(),
      items.map((x) => ({ id: x.id, title: normalize(x.label, false) })),
    );
  }
  const listItems = items.filter((x) => validId(x.id, WHATSAPP_LIMITS.listRowId));
  if (!listItems.length) return null;
  const footer =
    listItems.length > WHATSAPP_LIMITS.listMaxRows
      ? `Showing first ${WHATSAPP_LIMITS.listMaxRows} of ${listItems.length}.`
      : undefined;
  return listMessage(
    getBody(),
    listLabel,
    listItems.slice(0, WHATSAPP_LIMITS.listMaxRows).map((x) => formatListOption(x.id, x.label)),
    { sectionTitle, ...(footer ? { footer } : {}) },
  );
}

/** Pure renderer from persisted Mori rows to ordered outbound WhatsApp Cloud API messages. */
export function renderWhatsApp(rows: readonly MoriRow[]): WhatsAppMessage[] {
  const out: WhatsAppMessage[] = [];
  let pendingText = "";

  const appendText = (chunk: string) => {
    const clean = normalize(chunk, true);
    if (clean) pendingText = pendingText ? `${pendingText}\n\n${clean}` : clean;
  };
  const flushText = () => {
    if (!pendingText) return;
    for (const part of splitText(pendingText)) out.push(textMessage(part));
    pendingText = "";
  };
  const takeFoldedBody = (extra: string, fallback: string): string => {
    const combined = [pendingText, extra].filter(Boolean).join("\n\n");
    if (combined && combined.length <= WHATSAPP_LIMITS.interactiveBody) {
      pendingText = "";
      return combined;
    }
    flushText();
    return extra || fallback;
  };

  const moriRows = rows.filter((r) => r.role === "mori" && r.kind !== "status");
  for (let i = 0; i < moriRows.length; i++) {
    const row = moriRows[i]!;
    const nextKind = moriRows[i + 1]?.kind;

    switch (row.kind) {
      case "text":
        appendText(formatMoriText(row.content));
        break;

      case "price": {
        const price = formatPriceRow(row);
        if (!price) break;
        const followedByInteractive = nextKind === "suggest" || nextKind === "choices";
        if (price.imageUrl && !followedByInteractive) {
          const combined = [pendingText, price.text].filter(Boolean).join("\n\n");
          if (combined.length <= WHATSAPP_LIMITS.imageCaption) {
            pendingText = "";
            out.push({ type: "image", image: { link: price.imageUrl, caption: combined } });
            break;
          }
          flushText();
          if (price.text.length <= WHATSAPP_LIMITS.imageCaption) {
            out.push({ type: "image", image: { link: price.imageUrl, caption: price.text } });
            break;
          }
        }
        appendText(price.text);
        break;
      }

      case "grade": {
        const text = formatGradeRow(row);
        if (text) appendText(text);
        break;
      }

      case "confirm": {
        const confirm = formatConfirmRow(row);
        if (!confirm) break;
        const rowId = row.id.trim();
        const saveId = rowId ? validId(`save:${rowId}`, WHATSAPP_LIMITS.buttonId) : null;
        const editId = rowId ? validId(`edit:${rowId}`, WHATSAPP_LIMITS.buttonId) : null;
        if (!confirm.pending || !saveId || !editId) {
          appendText(confirm.body);
          break;
        }
        const actions = [
          { id: saveId, title: confirm.confirmLabel },
          { id: editId, title: "Change details" },
        ];
        const opts = confirm.headerImageUrl
          ? { headerImageUrl: confirm.headerImageUrl }
          : undefined;
        if (confirm.body.length <= WHATSAPP_LIMITS.interactiveBody) {
          out.push(buttonMessage(takeFoldedBody(confirm.body, confirm.compactBody), actions, opts));
        } else {
          appendText(confirm.body);
          flushText();
          out.push(buttonMessage(confirm.compactBody, actions, opts));
        }
        break;
      }

      case "orders": {
        const text = formatOrdersRow(row);
        if (text) appendText(text);
        break;
      }

      case "photos":
        if (!/front and back/i.test(pendingText)) appendText(PHOTO_INSTRUCTIONS);
        break;

      case "choices":
      case "suggest": {
        const rowId = row.id.trim();
        if (!rowId) break;
        const isChoices = row.kind === "choices";
        const key = isChoices ? "choices" : "suggestions";
        const rawList = Array.isArray(asObject(row.payload)[key])
          ? (asObject(row.payload)[key] as unknown[])
          : [];
        const items: Array<{ id: string; label: string }> = [];
        for (let idx = 0; idx < rawList.length; idx++) {
          const entry = rawList[idx];
          const label = isChoices
            ? typeof entry === "string"
              ? stringArg(entry)
              : stringArg(asObject(entry)["label"])
            : stringArg(entry);
          if (label) items.push({ id: `${isChoices ? "pick" : "suggest"}:${rowId}:${idx}`, label });
        }
        if (!items.length) break;
        const fallback = isChoices ? "Choose an option" : "Next steps";
        const msg = buildOptionsMessage(
          () => takeFoldedBody("", fallback),
          items,
          fallback,
          isChoices ? "Options" : "Next steps",
        );
        if (msg) out.push(msg);
        break;
      }

      default:
        appendText(formatMoriText(row.content) || "Open Bindory to view this.");
        break;
    }
  }

  flushText();
  // A long model answer must not burst dozens of sends to one recipient. Don't show
  // a later confirmation if the collector hasn't seen the intervening proposal details.
  return out.length <= 3
    ? out
    : [...out.slice(0, 2), textMessage("Open Bindory to view the rest.")];
}
