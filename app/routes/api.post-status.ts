import { env } from "cloudflare:workers";
import type { Route } from "./+types/api.post-status";
import { getPostStatus } from "../promo/drafts.server";
import { getDb } from "../server/db";

// Polled every 2 s by the result screen while a draft is being made. Inside the owner layout,
// so its middleware checks the session and adds Cache-Control: no-store.
export async function loader({ params }: Route.LoaderArgs) {
  const id = Number(params.id);
  const status = Number.isSafeInteger(id) && id > 0 ? await getPostStatus(getDb(env.DB), id) : null;
  if (!status) return Response.json({ error: "글을 찾을 수 없어요." }, { status: 404 });
  return Response.json(status);
}
