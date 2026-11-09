export const ALERT_KINDS = ["order", "monthly"] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

/** `sending` is written before the request goes out, so a second cron run skips the period. */
export const ALERT_STATUSES = ["sending", "sent", "failed"] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

export const ALERT_LABELS: Record<AlertKind, string> = {
  order: "발주 알림",
  monthly: "홍보글 알림",
};

/** "1일" or "1일·15일", earlier day first; shown in settings. */
export function monthlyDaysText(day: number, day2: number | null): string {
  const days = day2 === null ? [day] : [day, day2].sort((a, b) => a - b);
  return days.map((d) => `${d}일`).join("·");
}
