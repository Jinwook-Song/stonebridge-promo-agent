import { verifyImageSig } from "./image-url";
import { isOwner } from "../server/auth.server";

// Only photo keys this app writes are ever served.
const PHOTO_KEY = /^posts\/\d+\/\d+\.jpg$/;

const text = (status: number, body: string) =>
  new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });

/**
 * Serves a private R2 photo to a holder of a valid signature (Claude's servers) or to the
 * logged-in owner. This is the only route reachable without a session.
 */
export async function serveImage(
  request: Request,
  env: Pick<Env, "PHOTOS" | "IMAGE_URL_SECRET" | "SESSION_SECRET">,
  key: string,
  now: Date = new Date(),
): Promise<Response> {
  if (!PHOTO_KEY.test(key)) return text(404, "Not found");

  const url = new URL(request.url);
  const signed = await verifyImageSig(
    key,
    url.searchParams.get("exp") ?? "",
    url.searchParams.get("sig") ?? "",
    env.IMAGE_URL_SECRET,
    now,
  );
  if (!signed && !(await isOwner(request, env as Env))) return text(403, "Forbidden");

  const object = await env.PHOTOS.get(key);
  if (!object) return text(404, "Not found");
  return new Response(object.body, {
    headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": "private, max-age=600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
