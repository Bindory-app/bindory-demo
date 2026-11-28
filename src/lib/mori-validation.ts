import { z } from "zod";

export function isIsoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m! - 1 && dt.getUTCDate() === d;
}

const text = z.string().trim().min(1).max(2000);
const cardId = z.string().trim().min(1).max(100);
const short = z.string().trim().min(1).max(160);
export const orderCurrency = z.enum(["USD", "AUD", "CAD", "GBP", "EUR"]);
export const orderAmount = z
  .number()
  .finite()
  .positive()
  .max(9_999_999.99)
  .refine((v) => Number(v.toFixed(2)) === v);
const side = z.enum(["buy", "sell"]);

const namedCard = z
  .object({
    name: short,
    set: short.optional(),
    number: z
      .string()
      .trim()
      .min(1)
      .max(24)
      .regex(/^[a-z0-9]+(?:\s*\/\s*[a-z0-9]+)?$/i)
      .optional(),
  })
  .strict();
const catalogId = z.object({ id: cardId.regex(/^[a-z\d.-]+-[a-z\d.-]+$/i) }).strict();
const intentCard = z.union([namedCard, catalogId]);
const priceCheckIntent = z
  .object({
    kind: z.literal("price_check"),
    // Omit only when asking to identify an attached photo.
    card: intentCard.optional(),
    condition: z
      .enum(["near_mint", "lightly_played", "moderately_played", "heavily_played"])
      .optional(),
  })
  .strict();
export type PriceCheckIntent = z.infer<typeof priceCheckIntent>;
const orderIntent = z
  .object({
    kind: z.literal("order"),
    side,
    card: intentCard,
    note: text.optional(),
    price: z.object({ amount: orderAmount, currency: orderCurrency }).strict(),
  })
  .strict();
export type OrderIntent = z.infer<typeof orderIntent>;
const preGradeIntent = z
  .object({
    kind: z.literal("pre_grade"),
    card: intentCard.optional(),
  })
  .strict();
export type PreGradeIntent = z.infer<typeof preGradeIntent>;
const memoryIntent = z
  .object({
    kind: z.literal("memory"),
    place: short.optional(),
    with_whom: short.optional(),
    date: z.string().refine(isIsoDate).optional(),
    card_name: short.optional(),
    traded_card_name: short.optional(),
  })
  .strict();
export type MemoryIntent = z.infer<typeof memoryIntent>;
const moriIntent = z.discriminatedUnion("kind", [
  priceCheckIntent,
  orderIntent,
  preGradeIntent,
  memoryIntent,
]);
export type MoriIntent = z.infer<typeof moriIntent>;

export function parseMoriIntent(raw: unknown, hasPhotos: boolean) {
  if (raw === undefined) return null;
  const parsed = moriIntent.safeParse(raw);
  if (parsed.success && (parsed.data.kind !== "price_check" || parsed.data.card || hasPhotos))
    return parsed.data;
  // Never log the message, catalogue fields or image data.
  console.warn("Invalid or unsupported Mori intent; using chat");
  return null;
}
/** A sell order's condition, read from the collector's front and back photos. */
export const orderCondition = z.object({
  overall: short,
  summary: short.optional(),
  centering: z.object({ front: short.optional(), back: short.optional() }).optional(),
  corners: z
    .object({
      top_left: short.optional(),
      top_right: short.optional(),
      bottom_left: short.optional(),
      bottom_right: short.optional(),
    })
    .optional(),
  edges: short.optional(),
  surface: short.optional(),
});
export type OrderCondition = z.infer<typeof orderCondition>;
export const writeSchemas = {
  add_card_to_collection: z.object({ card_id: cardId, binder_name: text.max(60).optional() }),
  add_to_wishlist: z.object({ card_id: cardId, note: text.optional() }),
  create_binder: z.object({
    name: text,
    description: text.optional(),
    cards: z
      .array(z.object({ card_id: cardId, reason: text }))
      .min(1)
      .max(30),
  }),
  save_memory: z.object({
    title: text,
    story: text,
    place: text.optional(),
    with_whom: text.optional(),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    card_id: cardId.optional(),
    traded_card_id: cardId.optional(),
    card_name: short.optional(),
    traded_card_name: short.optional(),
    photo_path: text.optional(),
  }),
  set_order: z.object({
    side,
    card_id: cardId,
    price: orderAmount,
    currency: orderCurrency,
    note: text.optional(),
    condition: orderCondition.optional(),
  }),
};

export function validateWriteArgs(name: keyof typeof writeSchemas, args: unknown) {
  return writeSchemas[name].safeParse(args);
}

export function ownPhotoPath(path: string | undefined, userId: string) {
  return (
    !path ||
    (path.startsWith(`${userId}/`) &&
      path.length > userId.length + 1 &&
      !path.includes("..") &&
      // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
      !/[\\\u0000-\u001f]/.test(path))
  );
}

const PHOTO_PATH_RE = /photo_path\s*["']?\s*:\s*["']?([^\]\s"',}]+)/gi;

export function messagePhotoPath(message: string): string | undefined {
  return [...message.matchAll(PHOTO_PATH_RE)][0]?.[1];
}

export function ownMessagePhotos(message: string, userId: string, photoPath?: unknown) {
  if (
    photoPath !== undefined &&
    (typeof photoPath !== "string" || !ownPhotoPath(photoPath, userId))
  )
    return false;
  const matches = [...message.matchAll(PHOTO_PATH_RE)];
  return matches.every((match) => ownPhotoPath(match[1], userId));
}

/** The collector's own card photos sent with a chat message: one or two JPEG, PNG or WebP data
 *  URLs (front, then back), each under 2 MB, so the request stays inside the 4.5 MB body limit.
 *  Null when anything else is sent. */
export function cardPhotoDataUrls(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) return null;
  const ok = value.every(
    (v) =>
      typeof v === "string" &&
      v.length <= 2_000_000 &&
      /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(v),
  );
  return ok ? (value as string[]) : null;
}
