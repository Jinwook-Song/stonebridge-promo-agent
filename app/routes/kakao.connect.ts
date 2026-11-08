import { env } from "cloudflare:workers";
import { redirect } from "react-router";
import { authorizeUrl } from "../kakao/client.server";
import { kakaoConfig } from "../kakao/link.server";
import { kakaoStateCookie } from "../kakao/state-cookie.server";
import { randomToken } from "../lib/crypto";

// Inside the owner layout: only the logged-in owner can start a Kakao login. Whoever finishes it
// becomes the alert recipient.
export async function loader() {
  const cfg = kakaoConfig(env);
  if (!cfg) return redirect("/settings?kakao=not_configured");
  const state = randomToken();
  return redirect(authorizeUrl(cfg, state), {
    headers: { "Set-Cookie": await kakaoStateCookie(env).serialize(state) },
  });
}
