import { env } from "cloudflare:workers";
import { inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { alertLog, kakaoLink, settings } from "../database/schema";
import {
  alertMessage,
  CRONS,
  getAlertSettings,
  kst,
  parseMonthlyDay,
  recentAlerts,
  runScheduled,
  saveAlertSettings,
  type ScheduledDeps,
} from "../app/kakao/alerts.server";
import { MEMO_TEXT_LIMIT, type Fetch } from "../app/kakao/client.server";
import { monthlyDaysText } from "../app/kakao/types";
import { getDb } from "../app/server/db";
import { WATCH_CRON } from "../app/watch/run.server";
import wranglerConfig from "../wrangler.jsonc?raw";

const db = getDb(env.DB);
const ORIGIN = "https://app.example";
const cfg = { restKey: "k", clientSecret: "s", redirectUri: `${ORIGIN}/kakao/callback` };

/** 2026-11-08 23:20 KST */
const ORDER_TIME = new Date("2026-11-08T14:20:00Z");

function okFetch() {
  return vi.fn<Fetch>(async () => new Response(JSON.stringify({ result_code: 0 })));
}

function deps(fetch: Fetch = okFetch(), over: Partial<ScheduledDeps> = {}): ScheduledDeps {
  return { db, cfg, origin: ORIGIN, fetch, ...over };
}

async function link(over: Partial<typeof kakaoLink.$inferInsert> = {}) {
  await db.insert(kakaoLink).values({
    id: 1,
    kakaoUserId: "42",
    accessToken: "a1",
    accessExpiresAt: "2027-01-01T00:00:00Z",
    refreshToken: "r1",
    refreshExpiresAt: "2027-01-01T00:00:00Z",
    linkedAt: "2026-11-08T00:00:00Z",
    ...over,
  });
}

beforeEach(async () => {
  await db.delete(alertLog);
  await db.delete(kakaoLink);
  await db
    .delete(settings)
    .where(inArray(settings.key, ["alert_order_enabled", "alert_monthly_enabled", "alert_monthly_day", "alert_monthly_day2", "alert_draft_ready_enabled"]));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("kst", () => {
  it("rolls the date over at 15:00 UTC", () => {
    expect(kst(new Date("2026-11-30T14:59:00Z"))).toMatchObject({ date: "2026-11-30", day: 30, month: "2026-11" });
    expect(kst(new Date("2026-11-30T15:00:00Z"))).toMatchObject({ date: "2026-12-01", day: 1, month: "2026-12" });
  });

  it("knows month lengths", () => {
    expect(kst(new Date("2027-02-10T00:00:00Z")).daysInMonth).toBe(28);
    expect(kst(new Date("2028-02-10T00:00:00Z")).daysInMonth).toBe(29);
  });
});

describe("alert settings", () => {
  it("default to off, day 1, no second day", async () => {
    expect(await getAlertSettings(db)).toEqual({
      orderEnabled: false,
      monthlyEnabled: false,
      monthlyDay: 1,
      monthlyDay2: null,
      draftReadyEnabled: true,
    });
  });

  it("save only the given fields", async () => {
    await saveAlertSettings(db, { orderEnabled: true, monthlyDay: 15 });
    await saveAlertSettings(db, { monthlyEnabled: true });
    await saveAlertSettings(db, { orderEnabled: false });
    expect(await getAlertSettings(db)).toEqual({
      orderEnabled: false,
      monthlyEnabled: true,
      monthlyDay: 15,
      monthlyDay2: null,
      draftReadyEnabled: true,
    });
  });

  it("second day saves and clears", async () => {
    await saveAlertSettings(db, { monthlyDay: 1, monthlyDay2: 15 });
    expect(await getAlertSettings(db)).toMatchObject({ monthlyDay: 1, monthlyDay2: 15 });
    await saveAlertSettings(db, { monthlyDay: 3 });
    expect((await getAlertSettings(db)).monthlyDay2).toBe(15);
    await saveAlertSettings(db, { monthlyDay2: null });
    expect((await getAlertSettings(db)).monthlyDay2).toBeNull();
  });

  it("monthlyDaysText lists one or two days, earlier first", () => {
    expect(monthlyDaysText(1, null)).toBe("1일");
    expect(monthlyDaysText(20, 5)).toBe("5일·20일");
  });

  it("parseMonthlyDay accepts 1–31 only", () => {
    expect(parseMonthlyDay(" 31 ")).toBe(31);
    for (const bad of ["0", "32", "1.5", "", "x"]) expect(parseMonthlyDay(bad)).toBeNull();
  });
});

describe("alertMessage", () => {
  it("every message fits Kakao's text limit and links to the app", () => {
    for (const kind of ["order", "monthly", "test"] as const) {
      const msg = alertMessage(kind, `${ORIGIN}/`);
      expect([...msg.text].length).toBeLessThanOrEqual(MEMO_TEXT_LIMIT);
      expect(msg.url.startsWith(`${ORIGIN}/`)).toBe(true);
      expect(msg.url).not.toContain("//posts");
    }
  });
});

describe("alertMessage: draft_ready", () => {
  it("shows the first 30 characters of the memo and links to the post", () => {
    const msg = alertMessage("draft_ready", ORIGIN, { postId: 7, memo: "가".repeat(40) });
    expect(msg).toEqual({
      text: "홍보글 초안이 준비됐어요\n" + "가".repeat(30) + "…",
      url: "https://app.example/posts/7",
      buttonTitle: "초안 보기",
    });
    expect([...msg.text].length).toBeLessThanOrEqual(MEMO_TEXT_LIMIT);
  });

  it("does not cut or mark a short memo, and counts code points", () => {
    expect(alertMessage("draft_ready", `${ORIGIN}/`, { postId: 1, memo: "짧은 메모" }).text).toBe(
      "홍보글 초안이 준비됐어요\n짧은 메모",
    );
    const emoji = alertMessage("draft_ready", ORIGIN, { postId: 1, memo: "🍪".repeat(31) });
    expect(emoji.text).toBe("홍보글 초안이 준비됐어요\n" + "🍪".repeat(30) + "…");
  });

  it("flattens a multi-line memo to one line so the preview stays a single line", () => {
    const msg = alertMessage("draft_ready", ORIGIN, { postId: 1, memo: "  크리스마스 마카롱\n\n 단체 주문\t안내 " });
    expect(msg.text).toBe("홍보글 초안이 준비됐어요\n크리스마스 마카롱 단체 주문 안내");
  });
});

describe("runScheduled: 발주 알림", () => {
  it("does nothing while off, even when connected", async () => {
    await link();
    const fetch = okFetch();
    expect(await runScheduled(CRONS.order, ORDER_TIME, deps(fetch))).toBe("disabled");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does nothing without Kakao keys", async () => {
    await saveAlertSettings(db, { orderEnabled: true });
    await link();
    expect(await runScheduled(CRONS.order, ORDER_TIME, deps(okFetch(), { cfg: null }))).toBe("not_configured");
  });

  it("does nothing (and logs nothing) when no account is connected", async () => {
    await saveAlertSettings(db, { orderEnabled: true });
    expect(await runScheduled(CRONS.order, ORDER_TIME, deps())).toBe("not_linked");
    expect(await recentAlerts(db)).toEqual([]);
  });

  it("sends once per KST day, even if the cron fires twice", async () => {
    await saveAlertSettings(db, { orderEnabled: true });
    await link();
    const fetch = okFetch();
    expect(await runScheduled(CRONS.order, ORDER_TIME, deps(fetch))).toBe("sent");
    expect(await runScheduled(CRONS.order, new Date(ORDER_TIME.getTime() + 60_000), deps(fetch))).toBe("already_sent");
    expect(fetch).toHaveBeenCalledTimes(1);
    const body = new URLSearchParams(String(fetch.mock.calls[0][1]?.body));
    expect(JSON.parse(body.get("template_object")!).text).toContain("쿠팡 발주");
    const [row] = await recentAlerts(db);
    expect(row).toMatchObject({ kind: "order", periodKey: "2026-11-08", status: "sent" });
    expect(row.sentAt).not.toBeNull();
  });

  it("the next day sends again", async () => {
    await saveAlertSettings(db, { orderEnabled: true });
    await link();
    await runScheduled(CRONS.order, ORDER_TIME, deps());
    expect(await runScheduled(CRONS.order, new Date(ORDER_TIME.getTime() + 86400_000), deps())).toBe("sent");
  });

  it("records a failure with Kakao's code and does not retry it", async () => {
    await saveAlertSettings(db, { orderEnabled: true });
    await link();
    const fetch = vi.fn<Fetch>(async () => new Response(JSON.stringify({ code: -402, msg: "insufficient scopes" }), { status: 403 }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runScheduled(CRONS.order, ORDER_TIME, deps(fetch))).toBe("failed");
    expect(await runScheduled(CRONS.order, ORDER_TIME, deps(fetch))).toBe("already_sent");
    const [row] = await recentAlerts(db);
    expect(row.status).toBe("failed");
    expect(row.error).toContain("-402");
  });

  it("records needs-relogin as a failure without calling Kakao", async () => {
    await saveAlertSettings(db, { orderEnabled: true });
    await link({ needsRelogin: true });
    const fetch = okFetch();
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runScheduled(CRONS.order, ORDER_TIME, deps(fetch))).toBe("failed");
    expect(fetch).not.toHaveBeenCalled();
    expect((await recentAlerts(db))[0].error).toContain("다시 연결");
  });

  it("ignores unknown crons", async () => {
    expect(await runScheduled("* * * * *", ORDER_TIME, deps())).toBe("unknown_cron");
  });
});

describe("runScheduled: 홍보글 알림", () => {
  const at10 = (isoDate: string) => new Date(`${isoDate}T01:00:00Z`);

  it("sends only on the chosen KST day, once that day", async () => {
    await saveAlertSettings(db, { monthlyEnabled: true, monthlyDay: 15 });
    await link();
    const fetch = okFetch();
    expect(await runScheduled(CRONS.monthly, at10("2026-11-14"), deps(fetch))).toBe("not_today");
    expect(await runScheduled(CRONS.monthly, at10("2026-11-15"), deps(fetch))).toBe("sent");
    expect(await runScheduled(CRONS.monthly, at10("2026-11-15"), deps(fetch))).toBe("already_sent");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await recentAlerts(db))[0]).toMatchObject({ kind: "monthly", periodKey: "2026-11-15" });
  });

  it("sends on both chosen days, once each", async () => {
    await saveAlertSettings(db, { monthlyEnabled: true, monthlyDay: 1, monthlyDay2: 15 });
    await link();
    const fetch = okFetch();
    expect(await runScheduled(CRONS.monthly, at10("2026-11-01"), deps(fetch))).toBe("sent");
    expect(await runScheduled(CRONS.monthly, at10("2026-11-01"), deps(fetch))).toBe("already_sent");
    expect(await runScheduled(CRONS.monthly, at10("2026-11-08"), deps(fetch))).toBe("not_today");
    expect(await runScheduled(CRONS.monthly, at10("2026-11-15"), deps(fetch))).toBe("sent");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((await recentAlerts(db)).map((a) => a.periodKey)).toEqual(["2026-11-15", "2026-11-01"]);
  });

  it("two days landing on the same short-month last day send once", async () => {
    await saveAlertSettings(db, { monthlyEnabled: true, monthlyDay: 30, monthlyDay2: 31 });
    // Default fixture tokens expire 2027-01-01, before this Feb 2027 date.
    await link({ accessExpiresAt: "2027-06-01T00:00:00Z", refreshExpiresAt: "2027-06-01T00:00:00Z" });
    const fetch = okFetch();
    expect(await runScheduled(CRONS.monthly, at10("2027-02-27"), deps(fetch))).toBe("not_today");
    expect(await runScheduled(CRONS.monthly, at10("2027-02-28"), deps(fetch))).toBe("sent");
    expect(await runScheduled(CRONS.monthly, at10("2027-02-28"), deps(fetch))).toBe("already_sent");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("uses the last day in months without the chosen day", async () => {
    await saveAlertSettings(db, { monthlyEnabled: true, monthlyDay: 31 });
    await link();
    expect(await runScheduled(CRONS.monthly, at10("2026-11-29"), deps())).toBe("not_today");
    expect(await runScheduled(CRONS.monthly, at10("2026-11-30"), deps())).toBe("sent");
  });

  it("is independent of the 발주 switch", async () => {
    await saveAlertSettings(db, { orderEnabled: true, monthlyDay: 8 });
    await link();
    expect(await runScheduled(CRONS.monthly, at10("2026-11-08"), deps())).toBe("disabled");
  });
});

describe("cron wiring", () => {
  it("wrangler.jsonc triggers match CRONS plus the competitor watch cron", () => {
    const crons = wranglerConfig.match(/"crons"\s*:\s*\[([^\]]*)\]/)?.[1];
    const listed = [...(crons ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(listed.sort()).toEqual([...Object.values(CRONS), WATCH_CRON].sort());
    expect(Object.values(CRONS)).not.toContain(WATCH_CRON);
  });

  it("the daily 발주 cron keeps the Kakao link alive even with every alert off", async () => {
    await link({ refreshExpiresAt: "2026-11-20T00:00:00Z" });
    const fetch = vi.fn<Fetch>(async () => new Response(JSON.stringify({ access_token: "a2", expires_in: 100, refresh_token: "r2", refresh_token_expires_in: 5183999 })));
    expect(await runScheduled(CRONS.order, ORDER_TIME, deps(fetch))).toBe("disabled");
    expect(fetch).toHaveBeenCalledTimes(1);
    const [row] = await db.select().from(kakaoLink);
    expect(row.refreshToken).toBe("r2");
  });
});
