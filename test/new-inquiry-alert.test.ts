import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { kakaoLink, settings } from "../database/schema";
import { alertMessage, getAlertSettings, saveAlertSettings, type ScheduledDeps } from "../app/kakao/alerts.server";
import type { Fetch } from "../app/kakao/client.server";
import { notifyNewInquiry } from "../app/kakao/new-inquiry.server";
import type { NewInquiryInfo } from "../app/inquiry/inquiries.server";
import { getDb } from "../app/server/db";

const db = getDb(env.DB);
const ORIGIN = "https://app.example";
const cfg = { restKey: "k", clientSecret: "s", redirectUri: `${ORIGIN}/kakao/callback` };
const NOW = new Date("2026-11-10T03:00:00Z");
// Synthetic event fields; no real customer data.
const INFO: NewInquiryInfo = { quoteId: 12, org: "예시 학원", eventDate: "2026-12-01", headcount: 40 };

function okFetch() {
  return vi.fn<Fetch>(async () => new Response(JSON.stringify({ result_code: 0 })));
}

function deps(fetch: Fetch = okFetch(), over: Partial<ScheduledDeps> = {}): ScheduledDeps {
  return { db, cfg, origin: ORIGIN, fetch, ...over };
}

async function link() {
  await db.insert(kakaoLink).values({
    id: 1,
    kakaoUserId: "42",
    accessToken: "a1",
    accessExpiresAt: "2027-01-01T00:00:00Z",
    refreshToken: "r1",
    refreshExpiresAt: "2027-01-01T00:00:00Z",
    linkedAt: "2026-11-08T00:00:00Z",
  });
}

function sentTemplate(fetch: ReturnType<typeof okFetch>) {
  const body = new URLSearchParams(String(fetch.mock.calls[0][1]?.body));
  return JSON.parse(body.get("template_object")!) as { text: string; link: { web_url: string }; button_title: string };
}

beforeEach(async () => {
  await db.delete(kakaoLink);
  await db.delete(settings).where(eq(settings.key, "alert_inquiry_enabled"));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("alertMessage: new_inquiry", () => {
  it("says org, date and headcount and links to the quote", () => {
    expect(alertMessage("new_inquiry", ORIGIN, INFO)).toEqual({
      text: "새 견적 문의가 왔어요\n예시 학원 · 2026-12-01 · 40명",
      url: "https://app.example/quotes/12",
      buttonTitle: "견적 열기",
    });
  });

  it("falls back for a private person, no date and no headcount", () => {
    const msg = alertMessage("new_inquiry", `${ORIGIN}/`, { quoteId: 3, org: "", eventDate: null, headcount: null });
    expect(msg.text).toBe("새 견적 문의가 왔어요\n개인 · 날짜 미정 · 인원 미정");
    expect(msg.url).toBe("https://app.example/quotes/3");
  });

  it("links to the quote list when the quote could not be made", () => {
    const msg = alertMessage("new_inquiry", `${ORIGIN}/`, { ...INFO, quoteId: null });
    expect(msg.url).toBe("https://app.example/quotes");
  });
});

describe("notifyNewInquiry", () => {
  it("is disabled by default", async () => {
    expect((await getAlertSettings(db)).inquiryEnabled).toBe(false);
    await link();
    const fetch = okFetch();
    expect(await notifyNewInquiry(deps(fetch), INFO, NOW)).toBe("disabled");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("the setting saves on and off", async () => {
    await saveAlertSettings(db, { inquiryEnabled: true });
    expect((await getAlertSettings(db)).inquiryEnabled).toBe(true);
    await saveAlertSettings(db, { inquiryEnabled: false });
    expect((await getAlertSettings(db)).inquiryEnabled).toBe(false);
  });

  it("message has no phone or email", async () => {
    await link();
    await saveAlertSettings(db, { inquiryEnabled: true });
    const fetch = okFetch();
    // Even if a caller passed extra fields along, only the event fields are used.
    const info = { ...INFO, phone: "010-0000-0000", email: "test@example.com", contactName: "김예시" };
    expect(await notifyNewInquiry(deps(fetch), info, NOW)).toBe("sent");
    const raw = String(fetch.mock.calls[0][1]?.body);
    const decoded = decodeURIComponent(raw.replace(/\+/g, " "));
    for (const secret of ["010-0000-0000", "test@example.com", "김예시"]) {
      expect(raw).not.toContain(secret);
      expect(decoded).not.toContain(secret);
    }
  });

  it("sends when enabled and linked", async () => {
    await link();
    await saveAlertSettings(db, { inquiryEnabled: true });
    const fetch = okFetch();
    expect(await notifyNewInquiry(deps(fetch), INFO, NOW)).toBe("sent");
    expect(fetch).toHaveBeenCalledTimes(1);
    const t = sentTemplate(fetch);
    expect(t.text).toBe("새 견적 문의가 왔어요\n예시 학원 · 2026-12-01 · 40명");
    expect(t.link.web_url).toBe(`${ORIGIN}/quotes/12`);
    expect(t.button_title).toBe("견적 열기");
  });

  it("sends a link to the quote list when there is no quote", async () => {
    await link();
    await saveAlertSettings(db, { inquiryEnabled: true });
    const fetch = okFetch();
    expect(await notifyNewInquiry(deps(fetch), { ...INFO, quoteId: null }, NOW)).toBe("sent");
    expect(sentTemplate(fetch).link.web_url).toBe(`${ORIGIN}/quotes`);
  });

  it("does nothing when no account is connected", async () => {
    await saveAlertSettings(db, { inquiryEnabled: true });
    const fetch = okFetch();
    expect(await notifyNewInquiry(deps(fetch), INFO, NOW)).toBe("not_linked");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does nothing without Kakao keys", async () => {
    await link();
    await saveAlertSettings(db, { inquiryEnabled: true });
    const fetch = okFetch();
    expect(await notifyNewInquiry(deps(fetch, { cfg: null }), INFO, NOW)).toBe("not_configured");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["an HTTP 500", () => new Response("boom", { status: 500 })],
    ["Kakao -402", () => new Response(JSON.stringify({ code: -402, msg: "insufficient scopes" }), { status: 403 })],
  ])("send error returns failed (%s) and does not throw", async (_name, respond) => {
    await link();
    await saveAlertSettings(db, { inquiryEnabled: true });
    const fetch = vi.fn<Fetch>(async () => respond());
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await notifyNewInquiry(deps(fetch), INFO, NOW)).toBe("failed");
    expect(error).toHaveBeenCalled();
  });

  it("a thrown fetch returns failed", async () => {
    await link();
    await saveAlertSettings(db, { inquiryEnabled: true });
    const fetch = vi.fn<Fetch>(async () => {
      throw new Error("network down");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await notifyNewInquiry(deps(fetch), INFO, NOW)).toBe("failed");
  });
});
