/** The link target if `url` is http(s); anything else (javascript:, data:, junk) is not a link. */
export function safeHref(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

const SEEN_DAY = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" });

/** `2026-11-08T18:00:00Z` → `2026-11-09` in Korean time; same on server and browser. */
export function seenDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : SEEN_DAY.format(d);
}

export function won(n: number): string {
  return `${n.toLocaleString("ko-KR")}원`;
}
