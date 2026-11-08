import { createCookieSessionStorage } from "react-router";

// `secure` cookies are dropped by browsers on plain http except for localhost
// in Chromium/Firefox; production is always https.
function cookieOptions(env: Env, name: string, maxAge: number) {
  const secret = env.SESSION_SECRET;
  if (typeof secret !== "string" || secret.length < 32) {
    throw new Error("SESSION_SECRET must be set to at least 32 characters (wrangler secret put SESSION_SECRET)");
  }
  return {
    name,
    httpOnly: true,
    secure: true,
    sameSite: "lax" as const,
    path: "/",
    maxAge,
    secrets: [secret],
  };
}

export function getOwnerSessionStorage(env: Env) {
  return createCookieSessionStorage({
    cookie: cookieOptions(env, "__owner", 60 * 60 * 24 * 30),
  });
}
