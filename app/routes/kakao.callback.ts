import { env } from "cloudflare:workers";
import { redirect } from "react-router";
import type { Route } from "./+types/kakao.callback";
import { KakaoError } from "../kakao/client.server";
import { connect, KakaoLinkError, kakaoConfig } from "../kakao/link.server";
import { kakaoStateCookie } from "../kakao/state-cookie.server";
import { safeEqual } from "../lib/crypto";
import { getDb } from "../server/db";

/** Values of `?kakao=` the settings page knows how to explain. */
export type KakaoResult = "connected" | "denied" | "bad_state" | "no_consent" | "not_configured" | "error";

// Kakao redirects here (registered in the console as <PUBLIC_ORIGIN>/kakao/callback). Inside the
// owner layout, so the owner session cookie (SameSite=Lax) is required as well as the state.
export async function loader({ request }: Route.LoaderArgs) {
  const cookie = kakaoStateCookie(env);
  const expected = await cookie.parse(request.headers.get("Cookie"));
  const clear = { headers: { "Set-Cookie": await cookie.serialize("", { maxAge: 0 }) } };
  const done = (result: KakaoResult, code?: string) =>
    redirect(`/settings?kakao=${result}${code ? `&code=${encodeURIComponent(code)}` : ""}#kakao`, clear);

  const url = new URL(request.url);
  const error = url.searchParams.get("error");
  if (error) return done(error === "access_denied" ? "denied" : "error", error);

  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code");
  if (typeof expected !== "string" || !expected || !safeEqual(state, expected) || !code) return done("bad_state");

  const cfg = kakaoConfig(env);
  if (!cfg) return done("not_configured");
  try {
    await connect(getDb(env.DB), cfg, code, new Date(), (u, init) => fetch(u, init));
  } catch (e) {
    if (e instanceof KakaoLinkError) return done(e.problem === "no_consent" ? "no_consent" : "error", e.problem);
    if (e instanceof KakaoError) {
      console.error("kakao connect failed", e);
      return done("error", e.code);
    }
    throw e;
  }
  return done("connected");
}
