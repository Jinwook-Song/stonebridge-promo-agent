// Pure string/regex helpers for the Naver blog importer (no DOM, no Node APIs),
// so vitest's Workers pool can import them.
import type { Channel, ExampleSource, PostKind } from "../../app/promo/types";

export type RssItem = { title: string; url: string; logNo: string; pubDate: string };

export type SeedExample = {
  channel: Channel;
  kind: PostKind;
  title: string;
  body: string;
  source: ExampleSource;
  enabled: boolean;
  sourceUrl: string;
  createdAt: string;
};

function unescapeHtml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity[0] === "#") {
      const hex = entity[1] === "x" || entity[1] === "X";
      const code = parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
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

function tagText(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  if (!match) return "";
  const inner = match[1].trim();
  const cdata = inner.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  return (cdata ? cdata[1] : unescapeHtml(inner)).trim();
}

export function parseRss(xml: string): RssItem[] {
  const items: RssItem[] = [];
  for (const [, item] of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const title = tagText(item, "title");
    const url = tagText(item, "link").replace(/\?.*$/, "");
    const logNo = url.match(/\/(\d+)$/)?.[1];
    if (!title || !logNo) continue;
    items.push({ title, url, logNo, pubDate: tagText(item, "pubDate") });
  }
  return items;
}

// One alternation walks the body in document order: the title block is skipped,
// text paragraphs become lines, image resources become numbered placeholders.
const BODY_TOKEN =
  /<(div|p|span|h[1-6])\b[^>]*se-title-text[^>]*>[\s\S]*?<\/\1>|<p\b[^>]*class="[^"]*se-text-paragraph[^"]*"[^>]*>([\s\S]*?)<\/p>|class="[^"]*se-image-resource[^"]*"/g;

// Zero-width space/joiners, LTR/RTL marks, bidi embeddings, word joiner, BOM.
const INVISIBLE = /[\u200b-\u200f\u2060\u202a-\u202e\ufeff]/g;

export function parsePostHtml(html: string): string {
  const lines: string[] = [];
  let photo = 0;
  for (const match of html.matchAll(BODY_TOKEN)) {
    const [whole, , paragraph] = match;
    if (paragraph !== undefined) {
      const text = unescapeHtml(
        paragraph.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, ""),
      )
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

export function classifyKind(title: string): PostKind {
  return /단체\s?주문|\d+\s?(세트|인분)|\d{3,}\s?개/.test(title) ? "case" : "product";
}

// Cuts the footer off at the earliest line that starts with any of `markers`
// (compared against the trimmed line).
export function stripFooter(body: string, markers: string[]): string {
  const lines = body.split("\n");
  const at = lines.findIndex((line) => {
    const text = line.trim();
    return markers.some((marker) => marker !== "" && text.startsWith(marker));
  });
  return (at === -1 ? body : lines.slice(0, at).join("\n")).trim();
}

const sqlText = (value: string) => `'${value.replace(/'/g, "''")}'`;

export function buildSeedSql(rows: SeedExample[]): string {
  return rows
    .map(
      (row) =>
        "INSERT INTO examples (channel, kind, title, body, source, enabled, source_url, created_at) VALUES (" +
        [
          sqlText(row.channel),
          sqlText(row.kind),
          sqlText(row.title),
          sqlText(row.body),
          sqlText(row.source),
          row.enabled ? "1" : "0",
          sqlText(row.sourceUrl),
          sqlText(row.createdAt),
        ].join(", ") +
        ");",
    )
    .join("\n");
}
