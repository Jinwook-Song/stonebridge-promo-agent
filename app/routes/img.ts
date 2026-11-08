import { env } from "cloudflare:workers";
import type { Route } from "./+types/img";
import { verifyImageSig } from "../promo/image-url";
import { isOwner } from "../server/auth.server";

// Registered outside the owner layout: Claude's servers fetch these links with only a signature.
const PHOTO_KEY = /^posts\/\d+\/\d+\.jpg$/;

const text = (status: number, body: string) =>
  new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });

export async function loader({ request, params }: Route.LoaderArgs) {
  const key = params["*"] ?? "";
  if (!PHOTO_KEY.test(key)) return text(404, "Not found");

  const url = new URL(request.url);
  const signed = await verifyImageSig(
    key,
    url.searchParams.get("exp") ?? "",
    url.searchParams.get("sig") ?? "",
    env.IMAGE_URL_SECRET,
    new Date(),
  );
  if (!signed && !(await isOwner(request, env))) return text(403, "Forbidden");

  const object = await env.PHOTOS.get(key);
  if (!object) return text(404, "Not found");
  return new Response(object.body, {
    headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=600" },
  });
}
