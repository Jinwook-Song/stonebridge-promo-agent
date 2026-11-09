import { and, eq, isNull } from "drizzle-orm";
import { posts } from "../../database/schema";
import { alertMessage, getAlertSettings, type ScheduledDeps } from "./alerts.server";
import { getLink, sendToMe } from "./link.server";

export type DraftReadyOutcome =
  | "not_configured"
  | "disabled"
  | "not_linked"
  | "not_ready"
  | "already_sent"
  | "sent"
  | "failed";

/**
 * Tells her on Kakao that a full draft is ready. The claim (draft_notified_at) is written before
 * the send, so a retried Workflow step or a second run sends once; a failed send is logged, not
 * retried (a late "ready" ping is noise). Never throws: the draft is saved, this is a bonus.
 */
export async function notifyDraftReady(deps: ScheduledDeps, postId: number, now: Date): Promise<DraftReadyOutcome> {
  try {
    const { db, cfg } = deps;
    if (!cfg) return "not_configured";
    if (!(await getAlertSettings(db)).draftReadyEnabled) return "disabled";
    if (!(await getLink(db))) return "not_linked";

    const [claim] = await db
      .update(posts)
      .set({ draftNotifiedAt: now.toISOString() })
      .where(and(eq(posts.id, postId), eq(posts.status, "ready"), isNull(posts.draftNotifiedAt)))
      .returning({ memo: posts.memo });
    if (!claim) {
      const [post] = await db
        .select({ status: posts.status, notifiedAt: posts.draftNotifiedAt })
        .from(posts)
        .where(eq(posts.id, postId));
      return post?.status === "ready" && post.notifiedAt !== null ? "already_sent" : "not_ready";
    }

    try {
      await sendToMe(db, cfg, alertMessage("draft_ready", deps.origin, { postId, memo: claim.memo }), now, deps.fetch);
    } catch (e) {
      console.error("kakao draft-ready alert failed", { postId, error: e });
      return "failed";
    }
    return "sent";
  } catch (e) {
    console.error("kakao draft-ready alert errored", { postId, error: e });
    return "failed";
  }
}
