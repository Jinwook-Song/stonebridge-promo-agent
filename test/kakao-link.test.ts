import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { kakaoLink } from "../database/schema";
import type { Fetch, KakaoConfig } from "../app/kakao/client.server";
import {
  connect,
  describeKakaoError,
  disconnect,
  getAccessToken,
  getLink,
  KakaoLinkError,
  kakaoConfig,
  sendToMe,
} from "../app/kakao/link.server";
import { getDb } from "../app/server/db";

const db = getDb(env.DB);
const cfg: KakaoConfig = { restKey: "k", clientSecret: "s", redirectUri: "https://app.example/kakao/callback" };
const now = new Date("2026-11-08T12:00:00Z");
const MSG = { text: "hi", url: "https://app.example/" };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

type Route = (init: RequestInit | undefined) => Response | Promise<Response>;

/** A fake Kakao: one handler per endpoint path, every call recorded. */
function fakeKakao(routes: Record<string, Route>) {
  const calls: { path: string; form: URLSearchParams; auth: string | null }[] = [];
  const fetch = vi.fn<Fetch>(async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({
      path,
      form: new URLSearchParams(typeof init?.body === "string" ? init.body : ""),
      auth: new Headers(init?.headers).get("Authorization"),
    });
    const route = routes[path];
    if (!route) throw new Error(`unexpected ${path}`);
    return route(init);
  });
  return { fetch, calls };
}

const LOGIN_OK = {
  "/oauth/token": () =>
    json({ access_token: "a1", expires_in: 21599, refresh_token: "r1", refresh_token_expires_in: 5183999, scope: "talk_message" }),
  "/v1/user/access_token_info": () => json({ id: 42, expires_in: 21599, app_id: 1 }),
};

async function seed(over: Partial<typeof kakaoLink.$inferInsert> = {}) {
  await db.insert(kakaoLink).values({
    id: 1,
    kakaoUserId: "42",
    accessToken: "a1",
    accessExpiresAt: new Date(now.getTime() + 3 * 3600_000).toISOString(),
    refreshToken: "r1",
    refreshExpiresAt: new Date(now.getTime() + 50 * 86400_000).toISOString(),
    linkedAt: now.toISOString(),
    ...over,
  });
}

beforeEach(async () => {
  await db.delete(kakaoLink);
});

describe("kakaoConfig", () => {
  it("is null until both keys are set", () => {
    expect(kakaoConfig({ PUBLIC_ORIGIN: "https://x.dev" })).toBeNull();
    expect(kakaoConfig({ PUBLIC_ORIGIN: "https://x.dev", KAKAO_REST_KEY: "k", KAKAO_CLIENT_SECRET: " " })).toBeNull();
    expect(kakaoConfig({ PUBLIC_ORIGIN: "https://x.dev/", KAKAO_REST_KEY: "k", KAKAO_CLIENT_SECRET: "s" })).toEqual({
      restKey: "k",
      clientSecret: "s",
      redirectUri: "https://x.dev/kakao/callback",
    });
  });
});

describe("connect", () => {
  it("stores tokens with absolute expiry and the member number", async () => {
    const { fetch, calls } = fakeKakao(LOGIN_OK);
    await connect(db, cfg, "code", now, fetch);
    const link = await getLink(db);
    expect(link).toMatchObject({
      kakaoUserId: "42",
      accessToken: "a1",
      accessExpiresAt: "2026-11-08T17:59:59.000Z",
      refreshToken: "r1",
      needsRelogin: false,
    });
    expect(calls[1].auth).toBe("Bearer a1");
  });

  it("replaces the previous account (recipient swap) and clears a relogin flag", async () => {
    await seed({ kakaoUserId: "7", needsRelogin: true, lastError: "x" });
    await connect(db, cfg, "code", now, fakeKakao(LOGIN_OK).fetch);
    expect(await getLink(db)).toMatchObject({ kakaoUserId: "42", needsRelogin: false, lastError: null });
  });

  it("refuses a login without talk_message consent and stores nothing", async () => {
    const { fetch } = fakeKakao({
      ...LOGIN_OK,
      "/oauth/token": () =>
        json({ access_token: "a1", expires_in: 1, refresh_token: "r1", refresh_token_expires_in: 1, scope: "profile_nickname" }),
    });
    const err = await connect(db, cfg, "code", now, fetch).catch((e) => e);
    expect(err).toBeInstanceOf(KakaoLinkError);
    expect(err.problem).toBe("no_consent");
    expect(await getLink(db)).toBeUndefined();
  });

  it("disconnect removes the recipient", async () => {
    await seed();
    await disconnect(db);
    expect(await getLink(db)).toBeUndefined();
  });
});

describe("getAccessToken", () => {
  it("uses the stored token while it has more than 5 minutes left", async () => {
    await seed();
    const { fetch } = fakeKakao({});
    expect(await getAccessToken(db, cfg, now, fetch)).toBe("a1");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refreshes near expiry and keeps the refresh token when Kakao does not rotate", async () => {
    await seed({ accessExpiresAt: new Date(now.getTime() + 60_000).toISOString() });
    const { fetch, calls } = fakeKakao({ "/oauth/token": () => json({ access_token: "a2", expires_in: 100 }) });
    expect(await getAccessToken(db, cfg, now, fetch)).toBe("a2");
    expect(calls[0].form.get("refresh_token")).toBe("r1");
    expect(await getLink(db)).toMatchObject({ accessToken: "a2", refreshToken: "r1" });
  });

  it("persists a rotated refresh token together with the new access token", async () => {
    await seed({ accessExpiresAt: now.toISOString() });
    const { fetch } = fakeKakao({
      "/oauth/token": () => json({ access_token: "a2", expires_in: 100, refresh_token: "r2", refresh_token_expires_in: 200 }),
    });
    await getAccessToken(db, cfg, now, fetch);
    expect(await getLink(db)).toMatchObject({
      accessToken: "a2",
      refreshToken: "r2",
      refreshExpiresAt: new Date(now.getTime() + 200_000).toISOString(),
    });
  });

  it("does not overwrite tokens another request rotated meanwhile", async () => {
    await seed({ accessExpiresAt: now.toISOString() });
    const { fetch } = fakeKakao({
      "/oauth/token": async () => {
        // The other request finishes its rotation while ours is in flight.
        await db.update(kakaoLink).set({ accessToken: "a-other", refreshToken: "r-other" });
        return json({ access_token: "a-mine", expires_in: 100, refresh_token: "r-mine", refresh_token_expires_in: 200 });
      },
    });
    expect(await getAccessToken(db, cfg, now, fetch)).toBe("a-other");
    expect(await getLink(db)).toMatchObject({ accessToken: "a-other", refreshToken: "r-other" });
  });

  it("marks the link for relogin when Kakao rejects the refresh token", async () => {
    await seed({ accessExpiresAt: now.toISOString() });
    const { fetch } = fakeKakao({
      "/oauth/token": () => json({ error: "invalid_grant", error_description: "expired", error_code: "KOE322" }, 400),
    });
    const err = await getAccessToken(db, cfg, now, fetch).catch((e) => e);
    expect(err).toBeInstanceOf(KakaoLinkError);
    expect(err.problem).toBe("needs_relogin");
    expect(await getLink(db)).toMatchObject({ needsRelogin: true, lastError: "KOE322: expired" });
    // and stops calling Kakao after that
    const again = fakeKakao({});
    await expect(getAccessToken(db, cfg, now, again.fetch)).rejects.toMatchObject({ problem: "needs_relogin" });
    expect(again.fetch).not.toHaveBeenCalled();
  });

  it("an invalid_grant caused by a concurrent rotation is not a broken link", async () => {
    await seed({ accessExpiresAt: now.toISOString() });
    const { fetch } = fakeKakao({
      "/oauth/token": async () => {
        await db.update(kakaoLink).set({ accessToken: "a-other", refreshToken: "r-other" });
        return json({ error: "invalid_grant", error_code: "KOE322" }, 400);
      },
    });
    expect(await getAccessToken(db, cfg, now, fetch)).toBe("a-other");
    expect((await getLink(db))?.needsRelogin).toBe(false);
  });

  it("transient refresh failures do not flag relogin", async () => {
    await seed({ accessExpiresAt: now.toISOString() });
    const { fetch } = fakeKakao({ "/oauth/token": () => new Response("down", { status: 503 }) });
    await expect(getAccessToken(db, cfg, now, fetch)).rejects.toMatchObject({ status: 503 });
    expect((await getLink(db))?.needsRelogin).toBe(false);
  });

  it("throws not_linked with no recipient", async () => {
    await expect(getAccessToken(db, cfg, now, fakeKakao({}).fetch)).rejects.toMatchObject({ problem: "not_linked" });
  });
});

describe("sendToMe", () => {
  it("sends with the stored token", async () => {
    await seed();
    const { calls, fetch } = fakeKakao({ "/v2/api/talk/memo/default/send": () => json({ result_code: 0 }) });
    await sendToMe(db, cfg, MSG, now, fetch);
    expect(calls.map((c) => c.path)).toEqual(["/v2/api/talk/memo/default/send"]);
    expect(calls[0].auth).toBe("Bearer a1");
  });

  it("on -401 refreshes once and retries once", async () => {
    await seed();
    let sends = 0;
    const { calls, fetch } = fakeKakao({
      "/v2/api/talk/memo/default/send": () => (++sends === 1 ? json({ code: -401, msg: "expired" }, 401) : json({ result_code: 0 })),
      "/oauth/token": () => json({ access_token: "a2", expires_in: 100 }),
    });
    await sendToMe(db, cfg, MSG, now, fetch);
    expect(calls.map((c) => [c.path, c.auth])).toEqual([
      ["/v2/api/talk/memo/default/send", "Bearer a1"],
      ["/oauth/token", null],
      ["/v2/api/talk/memo/default/send", "Bearer a2"],
    ]);
  });

  it("does not loop when the retry also fails", async () => {
    await seed();
    const { calls, fetch } = fakeKakao({
      "/v2/api/talk/memo/default/send": () => json({ code: -401, msg: "expired" }, 401),
      "/oauth/token": () => json({ access_token: "a2", expires_in: 100 }),
    });
    await expect(sendToMe(db, cfg, MSG, now, fetch)).rejects.toMatchObject({ code: "-401" });
    expect(calls).toHaveLength(3);
  });

  it("describes errors with Kakao's code kept", async () => {
    await seed();
    const { fetch } = fakeKakao({ "/v2/api/talk/memo/default/send": () => json({ code: -402, msg: "insufficient scopes" }, 403) });
    const err = await sendToMe(db, cfg, MSG, now, fetch).catch((e) => e);
    expect(describeKakaoError(err)).toBe(
      "카카오톡 메시지 동의가 없어요. 다시 연결하고 동의해 주세요. (-402: insufficient scopes)",
    );
  });
});
