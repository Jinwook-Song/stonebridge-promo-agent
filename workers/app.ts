import { env } from "cloudflare:workers";
import { createRequestHandler } from "react-router";
import { purgeOldInquiries } from "../app/inquiry/inquiries.server";
import { runScheduled } from "../app/kakao/alerts.server";
import { kakaoConfig } from "../app/kakao/link.server";
import { canonicalRedirect } from "../app/server/canonical-host";
import { getDb, withD1Session } from "../app/server/db";
import { startWatchRun, WATCH_CRON } from "../app/watch/run.server";

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
    const moved = canonicalRedirect(request.url, env.PUBLIC_ORIGIN);
    if (moved) return Response.redirect(moved, 308);

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

  // Crons in wrangler.jsonc `triggers`: the competitor watch (WATCH_CRON in app/watch/run.server.ts)
  // starts its Workflow; the rest are Kakao alerts (CRONS in app/kakao/alerts.server.ts), which
  // answer "unknown_cron" for anything else.
  async scheduled(controller) {
    const now = new Date(controller.scheduledTime);
    if (controller.cron === WATCH_CRON) {
      console.log(`competitor watch ${controller.cron}: ${await startWatchRun(env.WATCH, now)}`);
      // Inquiries older than a year go here too. After the watch has started, and on its own: a
      // purge failure must not affect the watch. Only the count or the error's class name is
      // logged (a drizzle message carries query parameters, i.e. customer contact).
      try {
        console.log(`inquiry purge: ${await purgeOldInquiries(getDb(env.DB), now)} deleted`);
      } catch (e) {
        console.error("inquiry purge failed", { error: e instanceof Error ? e.name : typeof e });
      }
      return;
    }
    const outcome = await runScheduled(controller.cron, now, {
      db: getDb(env.DB),
      cfg: kakaoConfig(env),
      origin: env.PUBLIC_ORIGIN,
      fetch: (url, init) => fetch(url, init),
    });
    console.log(`kakao alert ${controller.cron}: ${outcome}`);
  },
} satisfies ExportedHandler<Env>;

// Bound as GENERATE / QUOTE_GENERATE / WATCH in wrangler.jsonc.
export { GeneratePostWorkflow } from "./generate-workflow";
// RPC entrypoint the stonetable.kr site calls through a service binding.
export { InquiryService } from "./inquiry-service";
export { QuoteGenerateWorkflow } from "./quote-workflow";
export { WatchWorkflow } from "./watch-workflow";
