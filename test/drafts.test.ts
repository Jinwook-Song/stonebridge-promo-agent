import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { drafts, examples, photos, posts } from "../database/schema";
import { clearPostError, confirmDraft, getPostStatus, saveDraftEdit } from "../app/promo/drafts.server";
import { editRatio } from "../app/promo/edit-ratio";
import { listExamples } from "../app/promo/examples.server";
import { getPost, listPosts } from "../app/promo/posts.server";
import { loader as statusLoader } from "../app/routes/api.post-status";
import { getDb } from "../app/server/db";
import { DomainError } from "../app/server/errors";

const db = getDb(env.DB);
const T0 = new Date(Date.UTC(2026, 10, 8, 3, 0, 0));
const T1 = new Date(T0.getTime() + 60_000);

// Synthetic drafts; no real customer data.
const AI_BODY = "안녕하세요.\n[사진 1]\n마카롱을 포장했어요.\n감사합니다.";
const EDITED = "안녕하세요.\n[사진 1]\n마카롱을 예쁘게 포장했어요.\n감사합니다.";

let postId: number;

async function insertPost(over: Partial<typeof posts.$inferInsert> = {}): Promise<number> {
  const [{ id }] = await db
    .insert(posts)
    .values({
      kind: "case",
      memo: "테스트 마카롱 40세트",
      privateCustomer: false,
      attachPrices: false,
      status: "ready",
      createdAt: T0.toISOString(),
      ...over,
    })
    .returning({ id: posts.id });
  return id;
}

async function seedAiDrafts(id: number) {
  const row = { postId: id, version: 1, source: "ai" as const, createdAt: T0.toISOString() };
  await db.insert(drafts).values([
    { ...row, channel: "blog", title: "블로그 제목", body: AI_BODY },
    { ...row, channel: "instagram", body: "인스타 본문", hashtags: '["마카롱","단체주문"]' },
    { ...row, channel: "daangn", title: "당근 제목", body: "당근 본문" },
    { ...row, channel: "place", body: "플레이스 본문" },
  ]);
}

async function versions(channel: "blog" | "instagram" | "daangn" | "place") {
  return db
    .select()
    .from(drafts)
    .where(and(eq(drafts.postId, postId), eq(drafts.channel, channel)))
    .orderBy(drafts.version);
}

beforeEach(async () => {
  await db.delete(examples);
  await db.delete(drafts);
  await db.delete(photos);
  await db.delete(posts);
  postId = await insertPost();
  await seedAiDrafts(postId);
});

describe("saveDraftEdit", () => {
  it("makes a new version only when changed", async () => {
    expect(await saveDraftEdit(db, postId, "blog", { title: "블로그 제목", body: AI_BODY }, T1)).toBe(1);
    expect(await saveDraftEdit(db, postId, "blog", { title: "블로그 제목", body: EDITED }, T1)).toBe(2);
    const rows = await versions("blog");
    expect(rows.map((r) => [r.version, r.source, r.body, r.title])).toEqual([
      [1, "ai", AI_BODY, "블로그 제목"],
      [2, "edit", EDITED, "블로그 제목"],
    ]);
    expect(rows[1].createdAt).toBe(T1.toISOString());
    expect(rows[1].confirmedAt).toBeNull();
  });

  it("keeps the title when omitted, trims it, and treats a blank title as none", async () => {
    expect(await saveDraftEdit(db, postId, "blog", { body: AI_BODY }, T1)).toBe(1);
    expect(await saveDraftEdit(db, postId, "blog", { title: " 블로그 제목 ", body: AI_BODY }, T1)).toBe(1);
    expect(await saveDraftEdit(db, postId, "blog", { title: "  ", body: AI_BODY }, T1)).toBe(2);
    expect((await versions("blog"))[1].title).toBeNull();
  });

  it("normalizes hashtags before comparing, so an untouched instagram tab saves nothing", async () => {
    const same = { body: "인스타 본문", hashtags: ["#마카롱", " 단체주문", ""] };
    expect(await saveDraftEdit(db, postId, "instagram", same, T1)).toBe(1);
    expect(await saveDraftEdit(db, postId, "instagram", { body: "인스타 본문", hashtags: ["#선물"] }, T1)).toBe(2);
    expect((await versions("instagram"))[1].hashtags).toBe('["선물"]');
  });

  it("stores no title or hashtags for channels that have none", async () => {
    expect(await saveDraftEdit(db, postId, "place", { title: "x", body: "새 본문", hashtags: ["y"] }, T1)).toBe(2);
    const [, v2] = await versions("place");
    expect(v2.title).toBeNull();
    expect(v2.hashtags).toBeNull();
  });

  it("is BUSY while that channel (or the whole post) is being generated, not while another is", async () => {
    await db.update(posts).set({ status: "generating", rewritingChannel: "blog" }).where(eq(posts.id, postId));
    const err = await saveDraftEdit(db, postId, "blog", { body: EDITED }, T1).catch((e) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect(err.code).toBe("BUSY");
    expect(await saveDraftEdit(db, postId, "daangn", { body: "당근 고침" }, T1)).toBe(2);

    await db.update(posts).set({ rewritingChannel: null }).where(eq(posts.id, postId));
    await expect(saveDraftEdit(db, postId, "daangn", { body: "또" }, T1)).rejects.toMatchObject({ code: "BUSY" });
    expect(await versions("blog")).toHaveLength(1);
  });

  it("is NOT_FOUND for a channel with no draft or an unknown post", async () => {
    const empty = await insertPost();
    await expect(saveDraftEdit(db, empty, "blog", { body: "x" }, T1)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(saveDraftEdit(db, 99999, "blog", { body: "x" }, T1)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("two identical saves at once still make a single new version", async () => {
    const patch = { title: "블로그 제목", body: EDITED };
    const [a, b] = await Promise.all([
      saveDraftEdit(db, postId, "blog", patch, T1),
      saveDraftEdit(db, postId, "blog", patch, T1),
    ]);
    expect([a, b]).toEqual([2, 2]);
    expect(await versions("blog")).toHaveLength(2);
  });
});

describe("confirmDraft", () => {
  it("stores ratio against first ai version and adds one example", async () => {
    await saveDraftEdit(db, postId, "blog", { title: "t", body: EDITED }, T0);
    await confirmDraft(db, postId, "blog", T0);
    await confirmDraft(db, postId, "blog", T0);
    const ex = (await listExamples(db)).filter((e) => e.source === "owner_final");
    expect(ex).toHaveLength(1);
    expect(ex[0]).toMatchObject({ channel: "blog", kind: "case", title: "t", body: EDITED });
    const blog = (await getPost(db, postId))!.drafts.blog!;
    expect(blog.editRatio).toBe(editRatio(AI_BODY, EDITED));
    expect(blog.editRatio).toBe(0.25);
    expect(blog.confirmedAt).toBe(T0.toISOString());
  });

  it("measures against the lowest ai version even after a rewrite", async () => {
    await db.insert(drafts).values({
      postId,
      channel: "place",
      version: 2,
      body: "다시 쓴 본문",
      source: "ai",
      createdAt: T0.toISOString(),
    });
    await confirmDraft(db, postId, "place", T1);
    const place = (await getPost(db, postId))!.drafts.place!;
    expect(place.version).toBe(2);
    expect(place.editRatio).toBe(editRatio("플레이스 본문", "다시 쓴 본문"));
  });

  it("an unedited draft confirms with ratio 0", async () => {
    await confirmDraft(db, postId, "daangn", T1);
    expect((await getPost(db, postId))!.drafts.daangn).toMatchObject({ editRatio: 0, confirmedAt: T1.toISOString() });
    const ex = await listExamples(db);
    expect(ex).toHaveLength(1);
    expect(ex[0]).toMatchObject({ channel: "daangn", title: "당근 제목", body: "당근 본문", source: "owner_final" });
  });

  it("is BUSY while that channel is being rewritten and NOT_FOUND without a draft", async () => {
    await db.update(posts).set({ status: "generating", rewritingChannel: "blog" }).where(eq(posts.id, postId));
    await expect(confirmDraft(db, postId, "blog", T1)).rejects.toMatchObject({ code: "BUSY" });
    const empty = await insertPost();
    await expect(confirmDraft(db, empty, "blog", T1)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await listExamples(db)).toHaveLength(0);
  });
});

describe("clearPostError / getPostStatus", () => {
  it("clears a leftover rewrite error on a ready post", async () => {
    await db.update(posts).set({ error: "잠시 후 다시 시도해 주세요." }).where(eq(posts.id, postId));
    await clearPostError(db, postId);
    expect((await getPost(db, postId))!.post.error).toBeNull();
  });

  it("does not clear the reason of a failed post", async () => {
    const failed = await insertPost({ status: "failed", error: "실패 이유" });
    await clearPostError(db, failed);
    expect((await getPost(db, failed))!.post.error).toBe("실패 이유");
  });

  it("returns status, error and the channel being rewritten", async () => {
    await db
      .update(posts)
      .set({ status: "generating", rewritingChannel: "daangn", error: null })
      .where(eq(posts.id, postId));
    expect(await getPostStatus(db, postId)).toEqual({ status: "generating", error: null, rewritingChannel: "daangn" });
    expect(await getPostStatus(db, 99999)).toBeNull();
  });
});

describe("api/posts/:id/status", () => {
  const call = (id: string) =>
    statusLoader({ params: { id }, request: new Request(`http://localhost/api/posts/${id}/status`) } as never);

  it("returns {status, error, rewritingChannel} as JSON", async () => {
    await db.update(posts).set({ status: "failed", error: "이유" }).where(eq(posts.id, postId));
    const res = await call(String(postId));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/application\/json/);
    expect(await res.json()).toEqual({ status: "failed", error: "이유", rewritingChannel: null });
  });

  it("404s for an unknown or malformed id", async () => {
    expect((await call("99999")).status).toBe(404);
    expect((await call("abc")).status).toBe(404);
  });
});

describe("listPosts confirmedCount", () => {
  it("counts channels whose latest version is confirmed", async () => {
    await confirmDraft(db, postId, "blog", T1);
    await confirmDraft(db, postId, "place", T1);
    expect((await listPosts(db))[0]).toMatchObject({ id: postId, confirmedCount: 2 });
    // Editing after confirming makes a new, unconfirmed latest version.
    await saveDraftEdit(db, postId, "place", { body: "고친 플레이스" }, T1);
    expect((await listPosts(db))[0].confirmedCount).toBe(1);
  });
});
