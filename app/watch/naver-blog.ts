// Pure string/regex helpers for RSS feeds and Naver blog posts (no DOM, no Node APIs), shared by
// the competitor watch and the blog importer (scripts/blog/parse.ts re-exports them).

/**
 * One feed item. `key` identifies the item within its feed: the post number (`logNo`) for a Naver
 * blog, otherwise the `<guid>` or, without one, the link. `url` is the canonical post URL
 * (tracking query parameters removed). `logNo` is set for Naver blog posts only.
 */
export type RssItem = { title: string; url: string; key: string; pubDate: string; logNo?: string };

export function unescapeHtml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity[0] === "#") {
      const hex = entity[1] === "x" || entity[1] === "X";
      const code = parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    const named: Record<string, string> = {
      amp: "&",
      lt: "<",
      gt: ">",
      quot: '"',
      apos: "'",
      nbsp: " ",
    };
    return named[entity.toLowerCase()] ?? whole;
  });
}

/** Text of the first `<tag>` (attributes allowed), CDATA unwrapped, entities decoded otherwise. */
export function tagText(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`));
  if (!match) return "";
  const inner = match[1].trim();
  const cdata = inner.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  return (cdata ? cdata[1] : unescapeHtml(inner)).trim();
}

const NAVER_BLOG_HOSTS = new Set(["blog.naver.com", "m.blog.naver.com"]);
/** Query parameters feeds add for analytics; dropping them keeps one URL per post. */
const TRACKING_PARAMS = /^(utm_.*|fromRss|trackingCode|fbclid|gclid)$/i;

/** http(s) URL with tracking parameters and the fragment removed, or null for anything else. */
export function canonicalPostUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  url.hash = "";
  for (const name of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(name)) url.searchParams.delete(name);
  }
  return url.toString();
}

/** Blog id and post number of a `blog.naver.com/<blogId>/<logNo>` link, or null. */
export function naverPost(url: string): { blogId: string; logNo: string } | null {
  try {
    const u = new URL(url);
    if (!NAVER_BLOG_HOSTS.has(u.hostname)) return null;
    const match = u.pathname.match(/^\/([^/]+)\/(\d+)\/?$/);
    return match ? { blogId: match[1], logNo: match[2] } : null;
  } catch {
    return null;
  }
}

/**
 * Feed items in document order (newest first in the feeds we read). Naver blog links without a
 * post number (the channel link) are skipped; items without a title or an http(s) link too.
 */
export function parseRss(xml: string): RssItem[] {
  const items: RssItem[] = [];
  for (const [, item] of xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/g)) {
    const title = tagText(item, "title");
    const link = tagText(item, "link");
    if (!title || !link) continue;
    let host = "";
    try {
      host = new URL(link).hostname;
    } catch {
      continue;
    }
    if (NAVER_BLOG_HOSTS.has(host)) {
      const url = link.replace(/\?.*$/, "");
      const logNo = url.match(/\/(\d+)$/)?.[1];
      if (!logNo) continue;
      items.push({ title, url, key: logNo, logNo, pubDate: tagText(item, "pubDate") });
      continue;
    }
    const url = canonicalPostUrl(link);
    if (!url) continue;
    items.push({ title, url, key: tagText(item, "guid") || url, pubDate: tagText(item, "pubDate") });
  }
  return items;
}

// One alternation walks the body in document order: the title block is skipped,
// text paragraphs become lines, image resources become numbered placeholders.
const BODY_TOKEN =
  /<(div|p|span|h[1-6])\b[^>]*se-title-text[^>]*>[\s\S]*?<\/\1>|<p\b[^>]*class="[^"]*se-text-paragraph[^"]*"[^>]*>([\s\S]*?)<\/p>|class="[^"]*se-image-resource[^"]*"/g;

// Zero-width space/joiners, LTR/RTL marks, bidi embeddings, word joiner, BOM.
const INVISIBLE = /[\u200b-\u200f\u2060\u202a-\u202e\ufeff]/g;

/**
 * Whether the page is a SmartEditor post (its viewer or body container is there), as opposed to a
 * block, captcha or error page. A post may still have no text: a video-only or empty post.
 */
export function hasPostBody(html: string): boolean {
  return /class="[^"]*\bse-(?:main-container|viewer)\b/.test(html);
}

/**
 * Body text of a Naver SmartEditor post page. Empty when the page has no text paragraphs, which is
 * how a deleted post looks (Naver still answers 200).
 */
export function parsePostHtml(html: string): string {
  const lines: string[] = [];
  let photo = 0;
  for (const match of html.matchAll(BODY_TOKEN)) {
    const [whole, , paragraph] = match;
    if (paragraph !== undefined) {
      const text = unescapeHtml(paragraph.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, ""))
        .replace(INVISIBLE, "")
        .trim();
      lines.push(text);
    } else if (whole.includes("se-image-resource")) {
      photo += 1;
      lines.push(`[사진 ${photo}]`);
    }
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
