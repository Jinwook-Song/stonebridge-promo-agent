import { createCookie } from "react-router";

/** CSRF state for the Kakao login round trip; Lax so it rides along on Kakao's redirect back. */
export function kakaoStateCookie(env: { SESSION_SECRET: string }) {
  return createCookie("__kakao_state", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/kakao",
    maxAge: 10 * 60,
    secrets: [env.SESSION_SECRET],
  });
}
