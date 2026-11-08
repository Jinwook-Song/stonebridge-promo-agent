import { env } from "cloudflare:workers";
import { createRequestHandler } from "react-router";
import { withD1Session } from "../app/server/db";

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

// Latest D1 bookmark this browser has seen. Sending it back makes a read replica wait until it
// has caught up, so a page reloaded right after a save never shows the old data.
const BOOKMARK_COOKIE = "__d1";

function readBookmark(request: Request): string | null {
  const cookie = request.headers.get("Cookie") ?? "";
  const match = cookie.match(/(?:^|;\s*)__d1=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

export default {
  async fetch(request) {
    const bookmark = readBookmark(request);
    const session = env.DB.withSession(bookmark ?? "first-unconstrained");
    const response = await withD1Session(session, () => requestHandler(request));

    const latest = session.getBookmark();
    if (!latest || latest === bookmark) return response;
    const out = new Response(response.body, response);
    out.headers.append(
      "Set-Cookie",
      `${BOOKMARK_COOKIE}=${encodeURIComponent(latest)}; Path=/; Max-Age=86400; HttpOnly; Secure; SameSite=Lax`,
    );
    return out;
  },
} satisfies ExportedHandler<Env>;

// Bound as GENERATE in wrangler.jsonc.
export { GeneratePostWorkflow } from "./generate-workflow";
