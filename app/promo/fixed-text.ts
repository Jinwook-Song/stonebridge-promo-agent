import type { PromoSettings } from "./settings.server";
import type { Channel } from "./types";

// Spec §5.4: footers and the price table are stored text the code appends verbatim,
// so the model can never print a wrong price or phone number.

/** The stored texts this module appends; the result screen sends only these to the browser. */
export type FixedTexts = Pick<PromoSettings, "footerBlog" | "footerShort" | "priceTable">;

function normalizeHashtags(tags: string[] | null | undefined): string {
  const seen = new Set<string>();
  for (const raw of tags ?? []) {
    const tag = raw.replace(/\s+/g, "").replace(/^#+/, "");
    if (tag) seen.add(tag);
  }
  return [...seen].map((tag) => `#${tag}`).join(" ");
}

export function withFixedText(
  channel: Channel,
  d: { body: string; hashtags?: string[] | null },
  s: FixedTexts,
  attachPrices: boolean,
): string {
  const prices = attachPrices ? s.priceTable : "";
  const parts = {
    blog: [d.body, prices, s.footerBlog],
    instagram: [d.body, s.footerShort, normalizeHashtags(d.hashtags)],
    daangn: [d.body, prices, s.footerShort],
    place: [d.body],
  }[channel];
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n\n");
}
