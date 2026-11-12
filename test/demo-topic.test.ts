import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { demoCalls } from "../database/schema";
import { DEMO_HOURLY_LIMIT, DEMO_LIMIT_MESSAGE, takeDemoCall } from "../app/demo/quota.server";
import { demoTopicGate } from "../app/demo/topic-gate.server";
import { topicCheckUser } from "../app/demo/topic-check";
import type { TopicCall } from "../app/promo/claude.server";
import { getDb } from "../app/server/db";

const db = getDb(env.DB);
const T0 = new Date("2026-11-12T03:00:00.000Z");
const DEMO = { DEMO: "1" };
const answer = (related: boolean, reason = ""): TopicCall => vi.fn(async () => ({ output: { related, reason }, inputTokens: 1, outputTokens: 1 }));

beforeEach(async () => {
  await db.delete(demoCalls);
});

describe("demoTopicGate", () => {
  it("never runs in the owner's app", async () => {
    const topic = answer(false, "x");
    expect(await demoTopicGate({ DEMO: "0" }, db, topic, { memo: "주식 추천", kind: "other" }, T0)).toBeNull();
    expect(topic).not.toHaveBeenCalled();
    expect(await db.select().from(demoCalls)).toEqual([]);
  });

  it("an off-topic memo gets the reason, counted as one call", async () => {
    const msg = await demoTopicGate(DEMO, db, answer(false, "날씨 질문이에요."), { memo: "내일 날씨 어때?", kind: "other" }, T0);
    expect(msg).toContain("홍보글로 쓸 수 없는 메모예요. 날씨 질문이에요.");
    expect(await db.select().from(demoCalls)).toEqual([expect.objectContaining({ kind: "topic_check" })]);
  });

  it("a shop memo goes on", async () => {
    expect(await demoTopicGate(DEMO, db, answer(true), { memo: "마카롱 20세트", kind: "case" }, T0)).toBeNull();
  });

  it("a failed check lets the post through", async () => {
    const topic: TopicCall = async () => {
      throw new Error("api down");
    };
    expect(await demoTopicGate(DEMO, db, topic, { memo: "마카롱", kind: "case" }, T0)).toBeNull();
  });

  it("over the cap: the limit message, no Claude call", async () => {
    for (let i = 0; i < DEMO_HOURLY_LIMIT; i++) await takeDemoCall(db, "post", T0);
    const topic = answer(true);
    expect(await demoTopicGate(DEMO, db, topic, { memo: "마카롱", kind: "case" }, T0)).toBe(DEMO_LIMIT_MESSAGE);
    expect(topic).not.toHaveBeenCalled();
  });

  it("puts the memo inside tags with the kind", () => {
    expect(topicCheckUser("마카롱", "case")).toBe("글 종류: 단체 주문 사례\n<메모>\n마카롱\n</메모>");
  });
});
