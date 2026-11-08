import { env } from "cloudflare:workers";
import type { Route } from "./+types/img";
import { serveImage } from "../promo/serve-image.server";

// Registered outside the owner layout: Claude's servers fetch these links with only a signature.
export async function loader({ request, params }: Route.LoaderArgs) {
  return serveImage(request, env, params["*"] ?? "");
}
