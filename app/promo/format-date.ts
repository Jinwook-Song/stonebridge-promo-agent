const DAY = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  month: "long",
  day: "numeric",
  weekday: "short",
});

/** `2026-11-08T03:00:00Z` → `11월 8일 (일)` in Korean time; same on server and browser. */
export function formatDay(iso: string): string {
  const parts = Object.fromEntries(DAY.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return `${parts.month} ${parts.day}일 (${parts.weekday})`;
}
