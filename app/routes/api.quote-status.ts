import { env } from "cloudflare:workers";
import type { Route } from "./+types/api.quote-status";
import { getQuote, isFreshClaim } from "../quote/quotes.server";
import { getDb } from "../server/db";
import { DomainError } from "../server/errors";

// Polled every 3 s by the quote screen while a version is being made. Inside the owner layout,
// so its middleware checks the session and adds Cache-Control: no-store. Reports the latest
// version; `stale` means it still says generating but no run can finish it any more.
export async function loader({ params }: Route.LoaderArgs) {
  const id = Number(params.id);
  if (!Number.isSafeInteger(id) || id <= 0) return Response.json({ error: "견적을 찾을 수 없어요." }, { status: 404 });
  try {
    const { version } = await getQuote(getDb(env.DB), id);
    return Response.json({
      version: version.version,
      status: version.status,
      error: version.error,
      stale: version.status === "generating" && !isFreshClaim(version, new Date()),
    });
  } catch (e) {
    if (e instanceof DomainError && e.code === "NOT_FOUND") {
      return Response.json({ error: e.message }, { status: 404 });
    }
    throw e;
  }
}
