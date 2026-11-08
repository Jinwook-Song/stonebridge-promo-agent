// What the result screen shows and copies for one channel. Pure and free of server imports
// (fixed-text's settings import is type-only), so the browser runs the same code as the tests.
import { findPossibleNames, findUnsupportedNumbers } from "./fact-check";
import { withFixedText, type FixedTexts } from "./fixed-text";
import type { Channel } from "./types";

export type DraftFields = { title: string | null; body: string; hashtags: string[] };

/** Channels whose draft has a title the owner pastes as its own first line. */
export const HAS_TITLE: Record<Channel, boolean> = { blog: true, instagram: false, daangn: true, place: false };

/**
 * Stored hashtag form: no `#`, no whitespace inside a tag (Instagram ends a tag at a space,
 * and withFixedText drops spaces too), no blanks, no duplicates.
 */
export function normalizeHashtags(tags: string[]): string[] {
  const seen = new Set<string>();
  for (const tag of tags) {
    const clean = tag.replace(/\s+/g, "").replace(/^#+/, "");
    if (clean) seen.add(clean);
  }
  return [...seen];
}

/** What the owner typed in the hashtag box (`#a b ##c`), split on spaces. */
export function parseHashtags(text: string): string[] {
  return normalizeHashtags(text.split(/\s+/));
}

export function formatHashtags(tags: string[]): string {
  return normalizeHashtags(tags)
    .map((t) => `#${t}`)
    .join(" ");
}

/**
 * `full` is exactly what 복사 puts on the clipboard: the title on its own first line (blog,
 * daangn), a blank line, then the body with the stored fixed text appended. `tail` is that
 * appended fixed text alone, for the read-only box under the editor.
 */
export function composeCopy(
  channel: Channel,
  d: DraftFields,
  settings: FixedTexts,
  attachPrices: boolean,
): { full: string; tail: string } {
  const title = HAS_TITLE[channel] ? (d.title ?? "").trim() : "";
  const text = withFixedText(channel, { body: d.body, hashtags: d.hashtags }, settings, attachPrices);
  return {
    full: [title, text].filter(Boolean).join("\n\n"),
    tail: withFixedText(channel, { body: "", hashtags: d.hashtags }, settings, attachPrices),
  };
}

/**
 * Spec §5.5 warnings for what the owner is looking at: numbers no source backs (memo, price
 * table, footers), and, for a private customer, anything that looks like a person's name.
 */
export function warningsFor(
  d: DraftFields,
  post: { memo: string; privateCustomer: boolean },
  settings: FixedTexts,
): { numbers: string[]; names: string[] } {
  const text = [d.title ?? "", d.body, d.hashtags.join(" ")].join("\n");
  return {
    numbers: findUnsupportedNumbers(text, [post.memo, settings.priceTable, settings.footerBlog, settings.footerShort]),
    names: post.privateCustomer ? findPossibleNames(text) : [],
  };
}
