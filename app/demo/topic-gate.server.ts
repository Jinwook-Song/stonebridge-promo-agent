import type { Db } from "../server/db";
import type { TopicCall } from "../promo/claude.server";
import type { PostKind } from "../promo/types";
import { DEMO_LIMIT_MESSAGE, isDemo, takeDemoCall } from "./quota.server";
import { TOPIC_CHECK_SYSTEM, topicCheckUser } from "./topic-check";

const FALLBACK_REASON = "가게 상품이나 주문, 소식과 관련 없는 내용이에요.";

/**
 * Public demo only: before a post is made, asks Claude (effort low) whether the memo is promo
 * material at all. Returns the Korean message to show instead of making a post, or null to go on.
 * The owner's app never calls Claude here. A failed check lets the post through: wrongly blocking
 * a real memo is worse than one off-topic draft.
 */
export async function demoTopicGate(
  env: { DEMO?: string },
  db: Db,
  topic: TopicCall,
  input: { memo: string; kind: PostKind },
  now: Date,
): Promise<string | null> {
  if (!isDemo(env)) return null;
  const memo = input.memo.trim();
  if (memo === "") return null;
  if (!(await takeDemoCall(db, "topic_check", now))) return DEMO_LIMIT_MESSAGE;
  try {
    const { output } = await topic({ system: TOPIC_CHECK_SYSTEM, user: [{ type: "text", text: topicCheckUser(memo, input.kind) }] });
    if (output.related) return null;
    const reason = output.reason.trim() || FALLBACK_REASON;
    return `홍보글로 쓸 수 없는 메모예요. ${reason} 상품, 주문, 가게 소식을 적어 주세요.`;
  } catch (e) {
    console.error("demo topic check failed; letting the post through", e);
    return null;
  }
}
