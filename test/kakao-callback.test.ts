import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { loader } from "../app/routes/kakao.callback";
import { kakaoStateCookie } from "../app/kakao/state-cookie.server";

type Args = Parameters<typeof loader>[0];

async function callback(query: string, state?: string) {
  const headers = new Headers();
  if (state !== undefined) {
    const set = await kakaoStateCookie(env).serialize(state);
    headers.set("Cookie", set.split(";")[0]);
  }
  const request = new Request(`https://app.example/kakao/callback?${query}`, { headers });
  const res = (await loader({ request, params: {}, context: {} } as unknown as Args)) as Response;
  return {
    location: res.headers.get("Location"),
    cookie: res.headers.get("Set-Cookie") ?? "",
  };
}

describe("kakao callback", () => {
  it("rejects a missing state cookie", async () => {
    const r = await callback("code=c&state=s1");
    expect(r.location).toBe("/settings?kakao=bad_state#kakao");
  });

  it("rejects a mismatched state", async () => {
    const r = await callback("code=c&state=other", "s1");
    expect(r.location).toBe("/settings?kakao=bad_state#kakao");
  });

  it("rejects a forged (unsigned) state cookie", async () => {
    const request = new Request("https://app.example/kakao/callback?code=c&state=s1", {
      headers: { Cookie: `__kakao_state=${btoa(JSON.stringify("s1"))}` },
    });
    const res = (await loader({ request, params: {}, context: {} } as unknown as Args)) as Response;
    expect(res.headers.get("Location")).toBe("/settings?kakao=bad_state#kakao");
  });

  it("rejects a matching state without a code", async () => {
    expect((await callback("state=s1", "s1")).location).toBe("/settings?kakao=bad_state#kakao");
  });

  it("reports a declined login", async () => {
    expect((await callback("error=access_denied&state=s1", "s1")).location).toBe(
      "/settings?kakao=denied&code=access_denied#kakao",
    );
  });

  it("with valid state but no Kakao keys, says not configured", async () => {
    expect((await callback("code=c&state=s1", "s1")).location).toBe("/settings?kakao=not_configured#kakao");
  });

  it("clears the state cookie on every exit", async () => {
    for (const r of [await callback("code=c&state=x", "s1"), await callback("error=access_denied", "s1")]) {
      expect(r.cookie).toContain("__kakao_state=");
      expect(r.cookie).toContain("Max-Age=0");
      expect(r.cookie).toContain("Path=/kakao");
    }
  });
});
