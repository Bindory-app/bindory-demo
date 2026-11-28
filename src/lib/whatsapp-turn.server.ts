import { randomUUID } from "node:crypto";
import { collectorClient } from "@/integrations/supabase/collector.server";
import { runMori } from "./mori-agent.server";
import { confirmWith, orderChanges, OrderEditError } from "./mori-confirm.server";
import { asObject, type DB } from "./mori-context.server";
import { ownMessagePhotos } from "./mori-validation";
import type { MoriRow, ProposalPayload } from "./mori-tools";
import {
  paymentReminder,
  saveAlertPreferences,
  hasPendingOrders,
} from "./mori-order-payment.server";
import { whatsappNonce, whatsappToken } from "./mori-signing.server";
import { toCollectorError, TURN_DEADLINE_MS } from "./mori-chat-stream.server";
import { BodyTooLarge, downloadPhoto, sendWhatsApp, type Inbound } from "./whatsapp-cloud.server";
import {
  bindLink,
  claimReminder,
  firstDelivery,
  pairPhoto,
  setStep,
  touchLink,
  unlinkWhatsApp,
  type Linked,
  type Step,
} from "./whatsapp-state.server";
import {
  buttonMessage,
  linkMessage,
  listMessage,
  renderWhatsApp,
  textMessage,
  type WhatsAppMessage,
} from "./whatsapp-render";

const stale = "That step is no longer active. Send Mori a message to continue.";
const editPrompt =
  "Send any changes: buy or sell, a price, or 7, 30 or 90 days. For example: buy 25.50 30 days. Reply CANCEL to exit.";
const expiredPhotos = "Those photos are no longer available. Send the front and back again.";
const skip = "Payment skipped. Your order stays pending until you connect a payment method.";
async function clearStep(l: Linked, message: string) {
  await setStep(l, {});
  return [textMessage(message)];
}
async function row(db: DB, l: Linked, id: string): Promise<MoriRow | null> {
  const { data, error } = await db
    .from("mori_messages")
    .select("id,role,kind,content,payload")
    .eq("user_id", l.user_id)
    .eq("id", id)
    .eq("role", "mori")
    .gte("created_at", l.chat_since)
    .maybeSingle();
  if (error) throw error;
  return data as MoriRow | null;
}
function origin() {
  const url = new URL(process.env["WHATSAPP_APP_ORIGIN"] ?? "");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.origin !== url.href.replace(/\/$/, "")
  )
    throw new Error("Invalid payment origin");
  return url.origin;
}
async function wallet(
  l: Linked,
  savePreferences?: () => Promise<void>,
): Promise<WhatsAppMessage[]> {
  const previous = l.step;
  const key = randomUUID(),
    token = whatsappToken("payment", key, Date.now() + 15 * 60_000),
    url = origin() + "/api/whatsapp-payment#" + token;
  if (!(await setStep(l, { kind: "wallet", key }))) return [textMessage(stale)];
  try {
    await savePreferences?.();
  } catch (error) {
    await setStep(l, previous);
    throw error;
  }
  return [
    linkMessage(
      "Connect to activate all your pending, unexpired orders.",
      "Add payment method",
      url,
    ),
    buttonMessage("Prefer to leave your order pending?", [
      { id: "skip:" + key, title: "Skip for now" },
    ]),
  ];
}
function alerts(key: string) {
  return listMessage(
    "Choose your notification preferences",
    "Choose preferences",
    [
      ["push", "Phone notification"],
      ["email", "Email"],
      ["both", "Phone and email"],
      ["none", "Neither"],
      ["skip", "Not now"],
    ].map(([value, title]) => ({ id: "alerts:" + key + ":" + value, title: title! })),
    { sectionTitle: "Notifications" },
  );
}
function parseOrderEdit(text: string, currency: string) {
  const changes: Partial<NonNullable<Step["changes"]>> = {};
  let rest = text.trim();
  const side = /(?:[,;]\s*)?\b(buy|sell)\b(?:\s*[,;])?/i.exec(rest);
  if (side) {
    changes.side = side[1]!.toLowerCase() as "buy" | "sell";
    rest = rest.replace(side[0], " ").trim();
  }
  const duration = /(?:[,;]\s*)?\b(\d+)\s+days?\b(?:\s*[,;])?/i.exec(rest);
  if (duration) {
    const days = Number(duration[1]);
    if (![7, 30, 90].includes(days)) return null;
    changes.expires_days = days;
    rest = rest.replace(duration[0], " ").trim();
  }
  if (rest) {
    const m =
      /^(?:([a-z]{1,2}\$|[£€$]|[a-z]{3})\s*)?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)(?:\s*([a-z]{1,2}\$|[£€$]|[a-z]{3}))?$/i.exec(
        rest,
      );
    if (!m || (m[1] && m[3])) return null;
    const mark = (m[1] ?? m[3])?.toUpperCase();
    const aliases: Record<string, string[]> = {
      USD: ["$", "US$"],
      AUD: ["$", "A$", "AU$"],
      CAD: ["$", "C$", "CA$"],
      GBP: ["£"],
      EUR: ["€"],
    };
    if (mark && mark !== currency && !aliases[currency]?.includes(mark))
      throw new OrderEditError(
        "Enter the price in " + currency + ", the order’s original currency.",
      );
    changes.price = Number(m[2]!.replaceAll(",", ""));
  }
  return Object.keys(changes).length ? changes : null;
}
async function editOrder(db: DB, l: Linked, text: string) {
  if (/^cancel$/i.test(text)) return clearStep(l, "Edit canceled. Nothing was saved.");
  const r = l.step.row && (await row(db, l, l.step.row));
  const p = r && (r.payload as ProposalPayload);
  if (!r || !p || p.tool !== "set_order" || p.status !== "pending") return clearStep(l, stale);
  let changes: NonNullable<Step["changes"]>;
  try {
    const patch = parseOrderEdit(text, p.price?.currency ?? "USD");
    if (!patch) return [textMessage(editPrompt)];
    const previous = asObject(r.payload)["expires_days"];
    changes = {
      side: p.side,
      price: p.price?.amount ?? p.price_usd,
      expires_days: typeof previous === "number" ? previous : 30,
      ...l.step.changes,
      ...patch,
    };
    orderChanges(p, changes);
  } catch (e) {
    if (e instanceof OrderEditError) return [textMessage(e.message + " " + editPrompt)];
    throw e;
  }
  const key = randomUUID();
  if (!(await setStep(l, { kind: "preview", key, row: r.id, changes })))
    return [textMessage(stale)];
  return [
    buttonMessage(
      `Updated order: ${changes.side} ${p.card.name} at ${changes.price} ${p.price?.currency ?? "USD"} for ${changes.expires_days} days. Nothing is saved until you confirm.`,
      [
        { id: "approve:" + key, title: "Save" },
        { id: "revise:" + key, title: "Change details" },
      ],
    ),
  ];
}
async function confirm(db: DB, l: Linked, r: MoriRow, changes?: Step["changes"]) {
  const result = await confirmWith(db, r.id, "confirm", changes);
  // SQL 015 actually opens the order, but its last sentence promises a watcher that does not exist.
  const content = result.reply?.content;
  const legacy = result.order_status === undefined && asObject(r.payload)["tool"] === "set_order";
  const msgs: WhatsAppMessage[] = content
    ? [
        textMessage(
          legacy
            ? content.replace(/ I will tell you as soon as a matching listing appears\.$/, "")
            : content,
        ),
      ]
    : [];
  if (result.order_status === "pending") {
    const key = randomUUID();
    if (await setStep(l, { kind: "alerts", key })) msgs.push(alerts(key));
  } else await setStep(l, {});
  return msgs;
}
function sellChoice(choice: unknown) {
  const intent = asObject(asObject(choice)["intent"]);
  return intent["kind"] === "order" && intent["side"] === "sell";
}
async function turn(
  db: DB,
  l: Linked,
  text: string,
  media: string[],
  intent?: unknown,
  oidc?: string | null,
  selectionOnly = false,
  freshText = false,
): Promise<WhatsAppMessage[]> {
  if (text.length > 2000) return [textMessage("Please keep your message under 2,000 characters.")];
  if (!ownMessagePhotos(text, l.user_id)) return [textMessage("Photo must belong to you")];
  let images: string[];
  try {
    images = await Promise.all(media.map(downloadPhoto));
  } catch (e) {
    return clearStep(
      l,
      e instanceof BodyTooLarge
        ? "That photo is too large. Send the front and back again, each under 1.5 MB."
        : expiredPhotos,
    );
  }
  let rows: MoriRow[] | undefined, failure: string | undefined;
  await runMori({
    db,
    userId: l.user_id,
    message: text,
    images,
    country: l.country,
    since: l.chat_since,
    intent,
    selectionOnly,
    oidcToken: oidc ?? null,
    signal: AbortSignal.timeout(TURN_DEADLINE_MS),
    emit(ev) {
      if (ev.type === "done") rows = ev.rows;
      if (ev.type === "error") failure = ev.text;
    },
  });
  if (!rows) return [textMessage(failure ?? toCollectorError(null).text)];
  const active = rows.filter((r) => ["choices", "photos", "confirm", "suggest"].includes(r.kind));
  const last = active.at(-1);
  const needsMedia =
    media.length &&
    active.some((r) => {
      const choices = asObject(r.payload)["choices"];
      return r.kind === "choices" && Array.isArray(choices) && choices.some(sellChoice);
    });
  if (
    !(await setStep(
      l,
      {
        kind: "rows",
        ...(freshText ? { fromText: true } : {}),
        rows: active.map((r) => r.id),
        ...(last?.kind === "photos" && asObject(last.payload)["intent"] ? { row: last.id } : {}),
        ...(needsMedia ? { media, mediaAt: Date.now() } : {}),
      },
      freshText,
    ))
  )
    return freshText ? [] : [textMessage(stale)];
  return renderWhatsApp(rows);
}
function heldMedia(l: Linked) {
  return !l.step.media || (l.step.mediaAt ?? 0) > Date.now() - 7 * 864e5
    ? (l.step.media ?? [])
    : null;
}
async function action(
  db: DB,
  l: Linked,
  value: string,
  oidc?: string | null,
): Promise<WhatsAppMessage[]> {
  const [kind, id, index, extra] = value.split(":");
  if (!id || extra) return [textMessage(stale)];
  if (l.step.kind === "paying") return [textMessage(stale)];
  if (kind === "pay" && id === "resume")
    return (await hasPendingOrders(db, l.user_id))
      ? wallet(l)
      : [textMessage("You have no pending orders to activate.")];
  if (
    kind === "alerts" &&
    id === l.step.key &&
    l.step.kind === "alerts" &&
    ["push", "email", "both", "none", "skip"].includes(index ?? "")
  ) {
    return wallet(
      l,
      index === "skip"
        ? undefined
        : () =>
            saveAlertPreferences(
              db,
              l.user_id,
              index === "push" || index === "both",
              index === "email" || index === "both",
            ),
    );
  }
  if (kind === "skip" && id === l.step.key && l.step.kind === "wallet" && (await setStep(l, {})))
    return [buttonMessage(skip, [{ id: "pay:resume", title: "Add payment method" }])];
  if (l.step.kind === "preview" && l.step.key === id && l.step.row) {
    if (kind === "revise" && (await setStep(l, { ...l.step, kind: "edit" })))
      return [textMessage(editPrompt)];
    if (kind === "approve") {
      const r = await row(db, l, l.step.row);
      if (r && asObject(r.payload)["status"] === "pending" && l.step.changes)
        return confirm(db, l, r, l.step.changes);
      return clearStep(l, stale);
    }
  }
  if (l.step.kind !== "rows" || !l.step.rows?.includes(id)) return [textMessage(stale)];
  const r = await row(db, l, id);
  if (!r) return clearStep(l, stale);
  const p = asObject(r.payload);
  if (r.kind === "confirm" && p["status"] !== "pending") return clearStep(l, stale);
  if (r.kind === "confirm" && p["status"] === "pending") {
    if (kind === "save") return confirm(db, l, r);
    if (kind === "edit") {
      if (p["tool"] === "set_order") {
        if (await setStep(l, { kind: "edit", row: id })) return [textMessage(editPrompt)];
      } else {
        await confirmWith(db, id, "edit");
        await setStep(l, {});
        return [textMessage("What would you like to change?")];
      }
    }
  }
  if ((kind === "pick" && r.kind === "choices") || (kind === "suggest" && r.kind === "suggest")) {
    const options = p[kind === "pick" ? "choices" : "suggestions"];
    if (!Array.isArray(options) || !/^\d+$/.test(index ?? "")) return [textMessage(stale)];
    const choice = options[Number(index)],
      obj = asObject(choice);
    const text = typeof choice === "string" ? choice : (obj["send"] ?? obj["label"]);
    const media = kind === "pick" && sellChoice(choice) ? heldMedia(l) : [];
    if (!media) return clearStep(l, expiredPhotos);
    if (typeof text === "string")
      return turn(db, l, text, media, obj["intent"], oidc, kind === "pick" && !!obj["intent"]);
  }
  return [textMessage(stale)];
}
async function reply(db: DB, l: Linked, m: Inbound, oidc?: string | null) {
  if (m.kind === "action") return action(db, l, m.action, oidc);
  if (m.kind === "image") {
    const pair = await pairPhoto(l, m.media, m.caption);
    if (!pair) return [];
    const pending = l.step.kind === "rows" && l.step.row ? await row(db, l, l.step.row) : null;
    const intent = pending?.kind === "photos" ? asObject(pending.payload)["intent"] : undefined;
    if (!pair.caption && !intent) {
      if (!(await setStep(l, { kind: "await_text", media: pair.media, mediaAt: Date.now() })))
        return [textMessage(stale)];
      return [textMessage("I have both photos. What would you like me to do with them?")];
    }
    return turn(
      db,
      l,
      pair.caption || "Here are the front and back photos.",
      pair.media,
      intent,
      oidc,
    );
  }
  if (l.step.kind === "edit") return editOrder(db, l, m.text);
  const media = l.step.kind === "await_text" ? heldMedia(l) : [];
  if (!media) return clearStep(l, expiredPhotos);
  return turn(db, l, m.text, media, undefined, oidc, false, l.step.kind !== "await_text");
}
export async function handleInbound(m: Inbound, oidc?: string | null) {
  if (!(await firstDelivery(m.id))) return;
  // Delayed retries do not reopen the customer service window.
  const delayed = Date.parse(m.at) <= Date.now() - 864e5,
    stop = m.kind === "text" && /^stop$/i.test(m.text);
  if (delayed && !stop) return;
  // Ordinary "link my binder" is chat. Never send even a damaged capability to the model.
  if (m.kind === "text" && /^link\s+[a-f0-9]{8}-[a-f0-9-]{12,}/i.test(m.text)) {
    const nonce = whatsappNonce("link", m.text.slice(5).trim());
    const ok = nonce && (await bindLink(nonce, m));
    return sendWhatsApp(
      m,
      textMessage(
        ok
          ? "WhatsApp is linked. What would you like to do with your cards? Reply STOP to unlink."
          : "That link is invalid or expired. Open Link WhatsApp in Bindory Settings and try again.",
      ),
    );
  }
  const l = await touchLink(m);
  if (!l && stop) return;
  if (!l)
    return sendWhatsApp(
      m,
      textMessage("To chat with Mori here, open Settings in Bindory and choose Link WhatsApp."),
    );
  if (stop) {
    await unlinkWhatsApp(l);
    if (delayed) return;
    return sendWhatsApp(
      l,
      textMessage("WhatsApp is unlinked. You will not receive more Bindory reminders here."),
    );
  }
  let messages: WhatsAppMessage[];
  try {
    const db = collectorClient(l.user_id);
    if (l.step.kind === "paying" && (l.step.payingAt ?? 0) <= Date.now() - 60_000)
      await setStep(l, {});
    const payment = m.kind === "text" && /^payment$/i.test(m.text);
    const mayRemind =
      !payment &&
      (m.kind !== "action" || /^(pick|suggest):/.test(m.action)) &&
      l.step.kind !== "edit" &&
      l.step.kind !== "paying";
    messages =
      l.step.kind === "paying"
        ? [textMessage(stale)]
        : payment
          ? await action(db, l, "pay:resume", oidc)
          : await reply(db, l, m, oidc);
    // A failed bookkeeping read must not discard a successful answer or confirmation.
    if (
      mayRemind &&
      messages.length > 0 &&
      messages.length < 3 &&
      (await claimReminder(l).catch(() => null))
    )
      messages.push(
        buttonMessage(paymentReminder, [{ id: "pay:resume", title: "Add payment method" }]),
      );
  } catch (error) {
    messages = [
      textMessage(error instanceof OrderEditError ? error.message : toCollectorError(null).text),
    ];
  }
  for (const msg of messages) await sendWhatsApp(l, msg);
}
