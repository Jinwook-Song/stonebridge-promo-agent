import { desc, eq, inArray, sql } from "drizzle-orm";
import { alertLog, settings } from "../../database/schema";
import type { Db } from "../server/db";
import type { Fetch, KakaoConfig, MemoMessage } from "./client.server";
import { describeKakaoError, getLink, keepAlive, sendToMe } from "./link.server";
import type { AlertKind } from "./types";

/**
 * Kakao alert cron expressions (UTC) in wrangler.jsonc `triggers.crons`; keep the two in sync.
 * The other cron there, 03:00 KST, is the competitor watch (WATCH_CRON in app/watch/run.server.ts),
 * routed before runScheduled in workers/app.ts. KST is UTC+9 all year (no DST).
 */
export const CRONS = {
  /** 23:20 KST — she orders cafe supplies on Coupang after closing. */
  order: "20 14 * * *",
  /** 10:00 KST daily; sends only on her chosen day(s) of the month. */
  monthly: "0 1 * * *",
} as const satisfies Record<AlertKind, string>;

export type AlertSettings = {
  orderEnabled: boolean;
  monthlyEnabled: boolean;
  /** 1–31; months without that day use their last day. */
  monthlyDay: number;
  /** Optional second day, same rules; null = once a month. She posts "한 달에 한두 번". */
  monthlyDay2: number | null;
  /** Message when a full draft is ready. On unless switched off: she asked for it by uploading. */
  draftReadyEnabled: boolean;
};

const KEYS = {
  orderEnabled: "alert_order_enabled",
  monthlyEnabled: "alert_monthly_enabled",
  monthlyDay: "alert_monthly_day",
  monthlyDay2: "alert_monthly_day2",
  draftReadyEnabled: "alert_draft_ready_enabled",
} as const satisfies Record<keyof AlertSettings, string>;

const DEFAULT_MONTHLY_DAY = 1;

export async function getAlertSettings(db: Db): Promise<AlertSettings> {
  const rows = await db.select().from(settings).where(inArray(settings.key, Object.values(KEYS)));
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const day = parseMonthlyDay(byKey.get(KEYS.monthlyDay) ?? "");
  return {
    // Off unless turned on: connecting alone must not start nightly pings.
    orderEnabled: byKey.get(KEYS.orderEnabled) === "1",
    monthlyEnabled: byKey.get(KEYS.monthlyEnabled) === "1",
    monthlyDay: day ?? DEFAULT_MONTHLY_DAY,
    // Stored as "" when cleared.
    monthlyDay2: parseMonthlyDay(byKey.get(KEYS.monthlyDay2) ?? ""),
    // Only an explicit "0" turns it off; no row yet means on.
    draftReadyEnabled: byKey.get(KEYS.draftReadyEnabled) !== "0",
  };
}

export function parseMonthlyDay(raw: string): number | null {
  const trimmed = raw.trim();
  // Number("") is 0, already out of range; the explicit check keeps that from being an accident.
  if (trimmed === "") return null;
  const day = Number(trimmed);
  return Number.isInteger(day) && day >= 1 && day <= 31 ? day : null;
}

export async function saveAlertSettings(db: Db, patch: Partial<AlertSettings>): Promise<void> {
  const values: { key: string; value: string }[] = [];
  if (patch.orderEnabled !== undefined) values.push({ key: KEYS.orderEnabled, value: patch.orderEnabled ? "1" : "0" });
  if (patch.monthlyEnabled !== undefined) {
    values.push({ key: KEYS.monthlyEnabled, value: patch.monthlyEnabled ? "1" : "0" });
  }
  if (patch.monthlyDay !== undefined) values.push({ key: KEYS.monthlyDay, value: String(patch.monthlyDay) });
  if (patch.monthlyDay2 !== undefined) {
    values.push({ key: KEYS.monthlyDay2, value: patch.monthlyDay2 === null ? "" : String(patch.monthlyDay2) });
  }
  if (patch.draftReadyEnabled !== undefined) {
    values.push({ key: KEYS.draftReadyEnabled, value: patch.draftReadyEnabled ? "1" : "0" });
  }
  if (values.length === 0) return;
  await db
    .insert(settings)
    .values(values)
    .onConflictDoUpdate({ target: settings.key, set: { value: sql`excluded.value` } });
}

/** Calendar parts of `now` in Korea. */
export function kst(now: Date) {
  const k = new Date(now.getTime() + 9 * 3600_000);
  const y = k.getUTCFullYear();
  const m = k.getUTCMonth() + 1;
  const d = k.getUTCDate();
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${y}-${pad(m)}-${pad(d)}`,
    month: `${y}-${pad(m)}`,
    day: d,
    daysInMonth: new Date(Date.UTC(y, m, 0)).getUTCDate(),
  };
}

/** How much of the memo the draft-ready message quotes, so she can tell which post it is. */
const MEMO_PREVIEW_CHARS = 30;

export type DraftReadyInfo = { postId: number; memo: string };

export function alertMessage(kind: AlertKind | "test", origin: string): MemoMessage;
export function alertMessage(kind: "draft_ready", origin: string, info: DraftReadyInfo): MemoMessage;
export function alertMessage(kind: AlertKind | "test" | "draft_ready", origin: string, info?: DraftReadyInfo): MemoMessage {
  const base = origin.replace(/\/+$/, "");
  switch (kind) {
    case "draft_ready": {
      // One line: a memo's line breaks would push the button text down in the chat bubble.
      const memo = info!.memo.replace(/\s+/g, " ").trim();
      // Code points, not UTF-16 units, so an emoji is never cut in half.
      const chars = [...memo];
      const preview = chars.length > MEMO_PREVIEW_CHARS ? `${chars.slice(0, MEMO_PREVIEW_CHARS).join("")}…` : memo;
      return { text: `홍보글 초안이 준비됐어요\n${preview}`, url: `${base}/posts/${info!.postId}`, buttonTitle: "초안 보기" };
    }
    case "order":
      return { text: "쿠팡 발주할 시간이에요\n카페 재료 주문 잊지 마세요.", url: `${base}/`, buttonTitle: "앱 열기" };
    case "monthly":
      return {
        text: "이번 달 홍보글 올릴 때예요\n사진이랑 메모만 올려 주시면 블로그·인스타·당근·플레이스 초안을 만들어 드려요.",
        url: `${base}/posts/new`,
        buttonTitle: "새 글 쓰기",
      };
    case "test":
      return { text: "스톤브릿지 홍보글 앱 시험 알림이에요. 이 메시지가 보이면 카톡 알림 준비 끝!", url: `${base}/settings`, buttonTitle: "설정 열기" };
  }
}

export type ScheduledDeps = {
  db: Db;
  cfg: KakaoConfig | null;
  origin: string;
  fetch: Fetch;
};

export type AlertOutcome =
  | "not_configured"
  | "unknown_cron"
  | "disabled"
  | "not_today"
  | "not_linked"
  | "already_sent"
  | "sent"
  | "failed";

/** Entry point for the Worker's `scheduled` handler. */
export async function runScheduled(cron: string, now: Date, deps: ScheduledDeps): Promise<AlertOutcome> {
  const kind = (Object.keys(CRONS) as AlertKind[]).find((k) => CRONS[k] === cron);
  if (!kind) return "unknown_cron";
  if (!deps.cfg) return "not_configured";
  if (kind === "order") await keepAlive(deps.db, deps.cfg, now, deps.fetch);

  const alerts = await getAlertSettings(deps.db);
  const today = kst(now);
  let periodKey: string;
  if (kind === "order") {
    if (!alerts.orderEnabled) return "disabled";
    periodKey = today.date;
  } else {
    if (!alerts.monthlyEnabled) return "disabled";
    const days = [alerts.monthlyDay, alerts.monthlyDay2].filter((d): d is number => d !== null);
    if (!days.some((d) => today.day === Math.min(d, today.daysInMonth))) return "not_today";
    // Per date, not per month: two days a month send twice, and 30/31 both landing on Feb 28 send
    // once. Moving the day later in a month that already got one sends again on the new day.
    periodKey = today.date;
  }
  if (!(await getLink(deps.db))) return "not_linked";

  return sendOnce(deps, kind, periodKey, now);
}

/**
 * Claims (kind, period) before sending, so a cron that fires twice sends once. A failed send is
 * recorded, not retried: a late 발주 alert is worse than none.
 */
async function sendOnce(deps: ScheduledDeps, kind: AlertKind, periodKey: string, now: Date): Promise<AlertOutcome> {
  const { db } = deps;
  const [claim] = await db
    .insert(alertLog)
    .values({ kind, periodKey, status: "sending", createdAt: now.toISOString() })
    .onConflictDoNothing()
    .returning({ id: alertLog.id });
  if (!claim) return "already_sent";

  try {
    await sendToMe(db, deps.cfg!, alertMessage(kind, deps.origin), now, deps.fetch);
  } catch (e) {
    await db
      .update(alertLog)
      .set({ status: "failed", error: describeKakaoError(e) })
      .where(eq(alertLog.id, claim.id));
    console.error(`kakao ${kind} alert failed`, e);
    return "failed";
  }
  try {
    await db.update(alertLog).set({ status: "sent", sentAt: new Date().toISOString() }).where(eq(alertLog.id, claim.id));
  } catch (e) {
    // Delivered; only the log row is stuck at `sending` (shown as 확인 안 됨).
    console.error(`kakao ${kind} alert sent but not recorded`, e);
  }
  return "sent";
}

export async function recentAlerts(db: Db, limit = 5) {
  return db.select().from(alertLog).orderBy(desc(alertLog.id)).limit(limit);
}
