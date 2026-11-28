import { describe, expect, it } from "vitest";
import {
  validateWriteArgs,
  ownPhotoPath,
  ownMessagePhotos,
  parseMoriIntent,
} from "@/lib/mori-validation";

describe("named intent cards", () => {
  it.each([
    ["25/102", "25/102"],
    ["TG01 / TG30", "TG01 / TG30"],
    ["001/SV-P", "001/SV-P"],
    ["#XY-P/099", "XY-P/099"],
  ])("accepts tagged collector number %s", (number, expected) => {
    const card = { name: "Pikachu", number };
    expect(parseMoriIntent({ kind: "price_check", card }, false)).toStrictEqual({
      kind: "price_check",
      card: { ...card, number: expected },
    });
  });
  it.each([
    { kind: "price_check" },
    { kind: "order", side: "buy", price: { amount: 12, currency: "USD" } },
  ])("keeps existing $kind cards and allows only the additional set", (base) => {
    const card = { name: "Pikachu", number: "25/102" };
    for (const c of [card, { ...card, set: "Base Set" }]) {
      expect(parseMoriIntent({ ...base, card: c }, false)).toStrictEqual({ ...base, card: c });
    }
    expect(parseMoriIntent({ ...base, card: { ...card, unexpected: true } }, false)).toBeNull();
  });
});

describe("Mori writing tools", () => {
  it("requires a one-line reason for every binder card", () => {
    expect(
      validateWriteArgs("create_binder", {
        name: "Moon moments",
        cards: [{ card_id: "swsh7-215" }],
      }).success,
    ).toBe(false);
    expect(
      validateWriteArgs("create_binder", {
        name: "Moon moments",
        cards: [{ card_id: "swsh7-215", reason: "Moonlit artwork" }],
      }).success,
    ).toBe(true);
  });
  it("requires both a memory title and story before proposing a save", () => {
    expect(validateWriteArgs("save_memory", { title: "My first card" }).success).toBe(false);
    expect(
      validateWriteArgs("save_memory", { title: "My first card", story: "A gift from my friend" })
        .success,
    ).toBe(true);
  });
  it("rejects another collector's private photo", () => {
    expect(ownPhotoPath("other/photo.jpg", "collector")).toBe(false);
    expect(ownPhotoPath("collector/photo.jpg", "collector")).toBe(true);
  });
  it("rejects foreign photo paths at the chat boundary", () => {
    expect(ownMessagePhotos("Photo [photo_path: other/photo.jpg]", "collector")).toBe(false);
    expect(ownMessagePhotos('Photo {"photo_path":"other/photo.jpg"}', "collector")).toBe(false);
    expect(ownMessagePhotos("Photo attached", "collector", "other/photo.jpg")).toBe(false);
    expect(ownMessagePhotos("Photo [photo_path: collector/photo.jpg]", "collector")).toBe(true);
  });
  it("rejects traversal and owner-prefix lookalikes", () => {
    expect(ownPhotoPath("collector-other/photo.jpg", "collector")).toBe(false);
    expect(ownPhotoPath("collector/../other/photo.jpg", "collector")).toBe(false);
    expect(ownPhotoPath("collector/", "collector")).toBe(false);
  });
});

import { orderCondition, writeSchemas } from "@/lib/mori-validation";

describe("Sell orders with photos", () => {
  it("accepts a condition read from the photos, per corner", () => {
    const ok = writeSchemas.set_order.safeParse({
      side: "sell",
      card_id: "me02-125",
      price: 550,
      currency: "USD",
      condition: {
        overall: "Near mint",
        centering: { front: "55/45", back: "60/40" },
        corners: { top_left: "Sharp", bottom_right: "Light whitening (back)" },
        edges: "Clean",
        surface: "No scratches visible",
      },
    });
    expect(ok.success).toBe(true);
  });
  it("needs an overall condition", () => {
    expect(orderCondition.safeParse({ edges: "Clean" }).success).toBe(false);
  });
});

describe("cardPhotoDataUrls", () => {
  const jpg = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
  it("accepts one or two image data URLs", async () => {
    const { cardPhotoDataUrls } = await import("@/lib/mori-validation");
    expect(cardPhotoDataUrls([jpg])).toEqual([jpg]);
    expect(cardPhotoDataUrls([jpg, jpg.replace("jpeg", "png")])).toHaveLength(2);
  });
  it("rejects URLs, other types, too many or too large", async () => {
    const { cardPhotoDataUrls } = await import("@/lib/mori-validation");
    expect(cardPhotoDataUrls(["https://example.com/a.jpg"])).toBeNull();
    expect(cardPhotoDataUrls(["data:image/svg+xml;base64,PHN2Zz4="])).toBeNull();
    expect(cardPhotoDataUrls([jpg, jpg, jpg])).toBeNull();
    expect(cardPhotoDataUrls([])).toBeNull();
    expect(cardPhotoDataUrls("x")).toBeNull();
    expect(cardPhotoDataUrls(["data:image/jpeg;base64," + "A".repeat(2_000_000)])).toBeNull();
  });
});
