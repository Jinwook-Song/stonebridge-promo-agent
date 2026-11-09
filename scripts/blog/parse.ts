// Pure string/regex helpers for the Naver blog importer (no DOM, no Node APIs),
// so vitest's Workers pool can import them. Feed and post parsing live in app/watch/naver-blog.ts.
import type { Channel, ExampleSource, PostKind } from "../../app/promo/types";

export { parsePostHtml, parseRss, tagText, unescapeHtml, type RssItem } from "../../app/watch/naver-blog";

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
