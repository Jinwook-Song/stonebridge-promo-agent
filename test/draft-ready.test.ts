import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { kakaoLink, posts, settings } from "../database/schema";
import { getAlertSettings, saveAlertSettings, type ScheduledDeps } from "../app/kakao/alerts.server";
import type { Fetch } from "../app/kakao/client.server";
import { notifyDraftReady } from "../app/kakao/draft-ready.server";
import { getDb } from "../app/server/db";

const db = getDb(env.DB);
const ORIGIN = "https://app.example";
const cfg = { restKey: "k", clientSecret: "s", redirectUri: `${ORIGIN}/kakao/callback` };
const NOW = new Date("2026-11-09T03:00:00Z");
// Synthetic memo; no real customer data.
const MEMO = "구리 OO고 마카롱 40세트 리본 포장";

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

async function insertPost(status: "draft" | "generating" | "ready" | "failed" = "ready"): Promise<number> {
  const [{ id }] = await db
    .insert(posts)
    .values({
      kind: "case",
      memo: MEMO,
      privateCustomer: false,
      attachPrices: false,
      status,
      createdAt: NOW.toISOString(),
    })
    .returning({ id: posts.id });
  return id;
}

async function notifiedAt(id: number) {
  const [r] = await db.select({ at: posts.draftNotifiedAt }).from(posts).where(eq(posts.id, id));
  return r.at;
}

beforeEach(async () => {
  await db.delete(posts);
  await db.delete(kakaoLink);
  await db.delete(settings).where(eq(settings.key, "alert_draft_ready_enabled"));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("notifyDraftReady", () => {
  it("sends once for a ready post", async () => {
    await link();
    const id = await insertPost();
    const fetch = okFetch();
    expect(await notifyDraftReady(deps(fetch), id, NOW)).toBe("sent");
    expect(await notifyDraftReady(deps(fetch), id, NOW)).toBe("already_sent");
    expect(fetch).toHaveBeenCalledTimes(1);
    const body = new URLSearchParams(String(fetch.mock.calls[0][1]?.body));
    const template = JSON.parse(body.get("template_object")!);
    expect(template.text).toContain("홍보글 초안이 준비됐어요");
    expect(template.text).toContain(MEMO);
    expect(template.link.web_url).toBe(`${ORIGIN}/posts/${id}`);
    expect(await notifiedAt(id)).toBe(NOW.toISOString());
  });

  it("skips a post that is not ready", async () => {
    await link();
    const id = await insertPost("generating");
    const fetch = okFetch();
    expect(await notifyDraftReady(deps(fetch), id, NOW)).toBe("not_ready");
    expect(fetch).not.toHaveBeenCalled();
    expect(await notifiedAt(id)).toBeNull();
  });

  it("skips a post that does not exist", async () => {
    await link();
    const fetch = okFetch();
    expect(await notifyDraftReady(deps(fetch), 999999, NOW)).toBe("not_ready");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("respects the setting, which is on by default", async () => {
    expect((await getAlertSettings(db)).draftReadyEnabled).toBe(true);
    await link();
    const id = await insertPost();
    await saveAlertSettings(db, { draftReadyEnabled: false });
    expect((await getAlertSettings(db)).draftReadyEnabled).toBe(false);
    const fetch = okFetch();
    expect(await notifyDraftReady(deps(fetch), id, NOW)).toBe("disabled");
    expect(fetch).not.toHaveBeenCalled();
    expect(await notifiedAt(id)).toBeNull();
  });

  it("does nothing when no account is connected", async () => {
    const id = await insertPost();
    const fetch = okFetch();
    expect(await notifyDraftReady(deps(fetch), id, NOW)).toBe("not_linked");
    expect(fetch).not.toHaveBeenCalled();
    expect(await notifiedAt(id)).toBeNull();
  });

  it("does nothing without Kakao keys", async () => {
    await link();
    const id = await insertPost();
    const fetch = okFetch();
    expect(await notifyDraftReady(deps(fetch, { cfg: null }), id, NOW)).toBe("not_configured");
    expect(fetch).not.toHaveBeenCalled();
    expect(await notifiedAt(id)).toBeNull();
  });

  it.each([
    ["an HTTP 500", () => new Response("boom", { status: 500 })],
    ["Kakao -402", () => new Response(JSON.stringify({ code: -402, msg: "insufficient scopes" }), { status: 403 })],
  ])("records %s as failed instead of throwing, and does not retry", async (_name, respond) => {
    await link();
    const id = await insertPost();
    const fetch = vi.fn<Fetch>(async () => respond());
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await notifyDraftReady(deps(fetch), id, NOW)).toBe("failed");
    expect(error).toHaveBeenCalled();
    expect(await notifiedAt(id)).toBe(NOW.toISOString());
    expect(await notifyDraftReady(deps(fetch), id, NOW)).toBe("already_sent");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
