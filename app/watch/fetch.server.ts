import { unescapeHtml } from "./naver-blog";

export const FETCH_TIMEOUT_MS = 15_000;

// Naver serves its mobile post page (the one with the post text inline) to phones.
const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

/** Labels Korean sites use for cp949; `TextDecoder("euc-kr")` reads all of them (spike). */
const KOREAN_LABELS = new Set(["euc-kr", "cp949", "ks_c_5601-1987", "x-windows-949", "windows-949", "ksc5601", "ks_c_5601"]);

/** Bytes searched for a `<meta charset>` or `<?xml encoding>` declaration. */
const SNIFF_BYTES = 4096;

function charsetIn(text: string, pattern: RegExp): string | null {
  return text.match(pattern)?.[1]?.trim().toLowerCase() ?? null;
}

/** Content-Type charset, then the page's own declaration, then utf-8. */
function charsetOf(contentType: string | null, bytes: Uint8Array): string {
  const fromHeader = charsetIn(contentType ?? "", /charset\s*=\s*["']?([\w.:-]+)/i);
  if (fromHeader) return fromHeader;
  // Declarations are ASCII, so reading the head byte by byte finds them whatever the encoding.
  const head = String.fromCharCode(...bytes.subarray(0, SNIFF_BYTES));
  return (
    charsetIn(head, /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i) ??
    charsetIn(head, /<\?xml[^>]+encoding\s*=\s*["']([\w.:-]+)["']/i) ??
    "utf-8"
  );
}

function decode(bytes: Uint8Array, charset: string): string {
  const label = KOREAN_LABELS.has(charset) ? "euc-kr" : charset;
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(label);
  } catch {
    decoder = new TextDecoder("utf-8");
  }
  return decoder.decode(bytes);
}

/**
 * GETs a page and decodes it in its own character set (always from bytes: `response.text()`
 * assumes UTF-8 and garbles EUC-KR pages). Never throws on an HTTP status; the caller decides.
 */
export async function fetchText(url: string, f: typeof fetch): Promise<{ status: number; text: string }> {
  const res = await f(url, {
    headers: { "User-Agent": MOBILE_UA, Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { status: res.status, text: decode(bytes, charsetOf(res.headers.get("content-type"), bytes)) };
}

const DROPPED_ELEMENTS = /<(script|style|noscript|template|svg|iframe)\b[\s\S]*?<\/\1\s*>/gi;
/** Tags that start a new line of text. */
const BLOCK_TAG =
  /<\/?(p|div|br|hr|li|ul|ol|tr|table|thead|tbody|tfoot|h[1-6]|section|article|header|footer|main|nav|aside|blockquote|pre|dl|dt|dd|form|figure|figcaption|caption)\b[^>]*>/gi;
/** End of a table cell: cells of one row are joined with " | ". */
const CELL_END = /<\/(td|th)\s*>/gi;

/**
 * Visible text of a (non-Naver-post) page: scripts, styles and comments dropped, one line per
 * block, table cells joined with " | ", spaces collapsed, blank lines removed.
 */
export function htmlToText(html: string): string {
  const text = unescapeHtml(
    html
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(DROPPED_ELEMENTS, "")
      .replace(CELL_END, "\t")
      .replace(BLOCK_TAG, "\n")
      .replace(/<[^>]*>/g, ""),
  );
  return text
    .split(/\r?\n/)
    .map((line) =>
      line
        .split("\t")
        .map((cell) => cell.replace(/[ \f\v ​﻿]+/g, " ").trim())
        .filter((cell) => cell !== "")
        .join(" | "),
    )
    .filter((line) => line !== "")
    .join("\n");
}
