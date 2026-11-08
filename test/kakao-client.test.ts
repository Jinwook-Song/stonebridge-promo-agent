import { describe, expect, it, vi } from "vitest";
import {
  authorizeUrl,
  exchangeCode,
  KakaoError,
  refreshAccessToken,
  sendMemo,
  tokenInfo,
  type KakaoConfig,
} from "../app/kakao/client.server";

const cfg: KakaoConfig = {
  restKey: "rest-key",
  clientSecret: "secret",
  redirectUri: "https://app.example/kakao/callback",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function form(init: RequestInit | undefined) {
  return new URLSearchParams(String(init?.body));
}

describe("kakao client", () => {
  it("builds the authorize URL with talk_message scope and state", () => {
    const url = new URL(authorizeUrl(cfg, "st4te"));
    expect(url.origin + url.pathname).toBe("https://kauth.kakao.com/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "rest-key",
      redirect_uri: "https://app.example/kakao/callback",
      response_type: "code",
      scope: "talk_message",
      state: "st4te",
    });
  });

  it("exchanges a code with the client secret", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) =>
      json({
        access_token: "a1",
        expires_in: 21599,
        refresh_token: "r1",
        refresh_token_expires_in: 5183999,
        scope: "talk_message profile_nickname",
      }),
    );
    const t = await exchangeCode(cfg, "c0de", fetch);
    expect(t).toEqual({
      accessToken: "a1",
      expiresIn: 21599,
      refreshToken: "r1",
      refreshExpiresIn: 5183999,
      scopes: ["talk_message", "profile_nickname"],
    });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://kauth.kakao.com/oauth/token");
    expect(init?.method).toBe("POST");
    expect(Object.fromEntries(form(init))).toEqual({
      grant_type: "authorization_code",
      client_id: "rest-key",
      client_secret: "secret",
      redirect_uri: "https://app.example/kakao/callback",
      code: "c0de",
    });
  });

  it("refresh returns no refresh token unless Kakao rotated it", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => json({ access_token: "a2", expires_in: 21599 }));
    const t = await refreshAccessToken(cfg, "r1", fetch);
    expect(t).toEqual({ accessToken: "a2", expiresIn: 21599, refreshToken: undefined, refreshExpiresIn: undefined });
    expect(Object.fromEntries(form(fetch.mock.calls[0][1]))).toEqual({
      grant_type: "refresh_token",
      client_id: "rest-key",
      client_secret: "secret",
      refresh_token: "r1",
    });
  });

  it("turns kauth errors into KakaoError with the KOE code", async () => {
    const fetch = vi.fn(async () =>
      json({ error: "invalid_grant", error_description: "expired", error_code: "KOE322" }, 400),
    );
    const err = await refreshAccessToken(cfg, "r1", fetch).catch((e) => e);
    expect(err).toBeInstanceOf(KakaoError);
    expect(err).toMatchObject({ status: 400, code: "KOE322", invalidGrant: true });
  });

  it("reads the user id from access_token_info", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => json({ id: 1234567890, expires_in: 100, app_id: 1 }));
    expect(await tokenInfo("a1", fetch)).toEqual({ id: "1234567890" });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://kapi.kakao.com/v1/user/access_token_info");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer a1");
  });

  it("sends a text memo with a link", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => json({ result_code: 0 }));
    await sendMemo("a1", { text: "발주하세요", url: "https://app.example/", buttonTitle: "앱 열기" }, fetch);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://kapi.kakao.com/v2/api/talk/memo/default/send");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer a1");
    expect(JSON.parse(form(init).get("template_object")!)).toEqual({
      object_type: "text",
      text: "발주하세요",
      link: { web_url: "https://app.example/", mobile_web_url: "https://app.example/" },
      button_title: "앱 열기",
    });
  });

  it("turns kapi errors into KakaoError with the numeric code", async () => {
    const fetch = vi.fn(async () => json({ msg: "this access token does not exist", code: -401 }, 401));
    const err = await sendMemo("a1", { text: "x", url: "https://app.example/" }, fetch).catch((e) => e);
    expect(err).toBeInstanceOf(KakaoError);
    expect(err).toMatchObject({ status: 401, code: "-401", invalidGrant: false });
    expect(err.message).toContain("this access token does not exist");
  });

  it("rejects memo text over Kakao's 200 character limit before sending", async () => {
    const fetch = vi.fn();
    await expect(sendMemo("a1", { text: "가".repeat(201), url: "https://app.example/" }, fetch)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("survives a non-JSON error body", async () => {
    const fetch = vi.fn(async () => new Response("<html>bad gateway</html>", { status: 502 }));
    const err = await tokenInfo("a1", fetch).catch((e) => e);
    expect(err).toMatchObject({ status: 502, code: "HTTP_502" });
  });
});
