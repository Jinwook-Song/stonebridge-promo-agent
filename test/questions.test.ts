import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { ownerQuestions, priceItems, settings } from "../database/schema";
import {
  answerQuestion,
  confirmQuestion,
  countLeft,
  listDone,
  listLeft,
  reopenQuestion,
  skipQuestion,
} from "../app/questions/questions.server";
import { action } from "../app/routes/questions";
import { loader as postsLoader } from "../app/routes/posts";
import { getDb } from "../app/server/db";
import { DomainError } from "../app/server/errors";

const db = getDb(env.DB);
const NOW = new Date("2026-11-10T01:00:00.000Z");
const CREATED = "2026-11-09T00:00:00.000Z";

type Seed = Partial<typeof ownerQuestions.$inferInsert> & { id: string };
async function seed(...rows: Seed[]) {
  await db.insert(ownerQuestions).values(
    rows.map((r, i) => ({ kind: "text" as const, title: `질문 ${r.id}`, sort: i + 1, createdAt: CREATED, ...r })),
  );
}
const get = async (id: string) => (await db.select().from(ownerQuestions).where(eq(ownerQuestions.id, id)))[0];
const settingOf = async (key: string) => (await db.select().from(settings).where(eq(settings.key, key)))[0]?.value;

beforeEach(async () => {
  await db.delete(ownerQuestions);
  await db.delete(priceItems);
  await db.delete(settings).where(eq(settings.key, "footer_short"));
  await db.delete(settings).where(eq(settings.key, "footer_blog"));
});

describe("question list", () => {
  it("shows open questions in order, then the ones put off, and counts both", async () => {
    await seed({ id: "a", sort: 2 }, { id: "b", sort: 1 }, { id: "c", sort: 3 }, { id: "d", sort: 4 });
    await skipQuestion(db, "b", "later", NOW);
    await answerQuestion(db, "d", "답", NOW);
    expect((await listLeft(db)).map((q) => q.id)).toEqual(["a", "c", "b"]);
    expect(await countLeft(db)).toBe(3);
    expect((await listDone(db)).map((q) => q.id)).toEqual(["d"]);
  });
});

describe("answers", () => {
  it("stores a written answer, trimmed, and takes it off the list", async () => {
    await seed({ id: "q1" });
    await answerQuestion(db, "q1", "  한양대병원\r\n마카롱 70세트  ", NOW);
    const q = await get("q1");
    expect(q.status).toBe("answered");
    expect(q.answer).toBe("한양대병원\n마카롱 70세트");
    expect(q.answeredAt).toBe(NOW.toISOString());
    expect(await countLeft(db)).toBe(0);
  });

  it("rejects an empty or too long answer", async () => {
    await seed({ id: "q1" });
    await expect(answerQuestion(db, "q1", "   ", NOW)).rejects.toBeInstanceOf(DomainError);
    await expect(answerQuestion(db, "q1", "가".repeat(4001), NOW)).rejects.toBeInstanceOf(DomainError);
    expect((await get("q1")).status).toBe("open");
  });

  it("rejects an unknown question", async () => {
    await expect(answerQuestion(db, "nope", "답", NOW)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("a text question cannot be answered with 맞아요", async () => {
    await seed({ id: "q1" });
    await expect(confirmQuestion(db, "q1", NOW)).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

describe("confirm questions", () => {
  it("맞아요 on the prices clears every 확인 필요 mark", async () => {
    await db.insert(priceItems).values([
      { kind: "per_person", name: "다과", unit: "1인", needsConfirm: true, createdAt: CREATED },
      { kind: "per_event", name: "출장료", unit: "회", needsConfirm: true, createdAt: CREATED },
    ]);
    await seed({ id: "p", kind: "confirm", current: "다과 8,500원", apply: "prices" });
    await confirmQuestion(db, "p", NOW);
    expect((await db.select().from(priceItems)).map((i) => i.needsConfirm)).toEqual([false, false]);
    expect((await get("p")).answer).toBe("맞아요");
  });

  it("a rewritten text replaces its settings row; 맞아요 leaves it alone", async () => {
    await db.insert(settings).values({ key: "footer_short", value: "옛 꼬리말" });
    await seed(
      { id: "f", kind: "confirm", current: "옛 꼬리말", apply: "setting:footer_short" },
      { id: "g", kind: "confirm", current: "옛 꼬리말", apply: "setting:footer_short" },
    );
    await confirmQuestion(db, "g", NOW);
    expect(await settingOf("footer_short")).toBe("옛 꼬리말");
    await answerQuestion(db, "f", "새 꼬리말\n010-0000-0000", NOW);
    expect(await settingOf("footer_short")).toBe("새 꼬리말\n010-0000-0000");
    expect((await get("f")).answer).toBe("새 꼬리말\n010-0000-0000");
  });

  it("sent back unchanged counts as 맞아요", async () => {
    await seed({ id: "f", kind: "confirm", current: "그대로", apply: "setting:footer_short" });
    await answerQuestion(db, "f", " 그대로 ", NOW);
    expect((await get("f")).answer).toBe("맞아요");
    expect(await settingOf("footer_short")).toBeUndefined();
  });

  it("never writes a settings key outside the allowed list", async () => {
    await db.insert(settings).values({ key: "footer_blog", value: "블로그 꼬리말" });
    await seed({ id: "x", kind: "confirm", current: "a", apply: "setting:footer_blog" });
    await answerQuestion(db, "x", "바꿈", NOW);
    expect(await settingOf("footer_blog")).toBe("블로그 꼬리말");
    expect((await get("x")).answer).toBe("바꿈");
  });
});

describe("action questions and skipping", () => {
  it("했어요 marks an action question done", async () => {
    await seed({ id: "k", kind: "action", link: "/settings" });
    await confirmQuestion(db, "k", NOW);
    expect(await get("k")).toMatchObject({ status: "answered", answer: "했어요" });
  });

  it("모르겠어요 closes it, 나중에 keeps it, 다시 답하기 reopens it", async () => {
    await seed({ id: "a" }, { id: "b" });
    await skipQuestion(db, "a", "unknown", NOW);
    await skipQuestion(db, "b", "later", NOW);
    expect(await get("a")).toMatchObject({ status: "unknown", answer: null });
    expect(await get("b")).toMatchObject({ status: "later", answeredAt: null });
    await reopenQuestion(db, "a");
    expect(await get("a")).toMatchObject({ status: "open", answer: null, answeredAt: null });
  });
});

function post(fields: Record<string, string>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return action({
    request: new Request("http://localhost/questions", { method: "POST", body: form }),
    params: {},
    context: {},
  } as never);
}

describe("questions action", () => {
  it("answers through the form", async () => {
    await seed({ id: "q1" });
    expect(await post({ intent: "answer", id: "q1", answer: "답" })).toEqual({ ok: true, intent: "answer" });
    expect((await get("q1")).answer).toBe("답");
  });

  it("refuses an unknown intent or a missing id with 400", async () => {
    const bad = (await post({ intent: "drop", id: "q1" })) as unknown as { init: { status: number } };
    expect(bad.init.status).toBe(400);
    const noId = (await post({ intent: "answer", answer: "x" })) as unknown as { init: { status: number } };
    expect(noId.init.status).toBe(400);
  });

  it("returns the message of an empty answer", async () => {
    await seed({ id: "q1" });
    const res = (await post({ intent: "answer", id: "q1", answer: "" })) as unknown as {
      data: { error: string };
      init: { status: number };
    };
    expect(res.init.status).toBe(400);
    expect(res.data.error).toBe("답을 적어 주세요.");
  });
});

describe("post list banner", () => {
  it("the post list loader counts the questions left", async () => {
    await seed({ id: "a" }, { id: "b" });
    await answerQuestion(db, "a", "답", NOW);
    const res = await postsLoader({} as never);
    expect(res.questionsLeft).toBe(1);
  });
});
