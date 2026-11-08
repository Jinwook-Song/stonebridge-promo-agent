import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { drafts, photos, posts } from "../database/schema";
import { createPost, getPost, listPosts, type NewPostInput } from "../app/promo/posts.server";
import { getDb } from "../app/server/db";
import { DomainError } from "../app/server/errors";

const db = getDb(env.DB);
const T0 = new Date(Date.UTC(2026, 10, 8, 3, 0, 0));

// Synthetic bytes only: the server never decodes them.
const jpg = (name: string, type = "image/jpeg", size = 8) =>
  new File([new Uint8Array(size).fill(7)], `${name}.jpg`, { type });

const base: Omit<NewPostInput, "photos"> = {
  kind: "case",
  memo: "메모",
  privateCustomer: false,
  attachPrices: false,
};

beforeEach(async () => {
  await db.delete(drafts);
  await db.delete(photos);
  await db.delete(posts);
});

describe("createPost validation", () => {
  it("rejects 9 photos, empty memo, gif", async () => {
    await expect(
      createPost(db, env.PHOTOS, { ...base, photos: Array.from({ length: 9 }, (_, i) => jpg(String(i))) }, T0),
    ).rejects.toThrow(DomainError);
    await expect(createPost(db, env.PHOTOS, { ...base, memo: "  \n ", photos: [] }, T0)).rejects.toThrow(DomainError);
    await expect(
      createPost(db, env.PHOTOS, { ...base, photos: [jpg("g", "image/gif")] }, T0),
    ).rejects.toThrow(DomainError);
  });

  it("uses INVALID_INPUT with a Korean message", async () => {
    const err = await createPost(db, env.PHOTOS, { ...base, memo: "", photos: [] }, T0).catch((e) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect(err.code).toBe("INVALID_INPUT");
    expect(err.message).toMatch(/[가-힣]/);
  });

  it("rejects memo over 500 chars after trim but accepts exactly 500", async () => {
    await expect(createPost(db, env.PHOTOS, { ...base, memo: "가".repeat(501), photos: [] }, T0)).rejects.toThrow(DomainError);
    await expect(createPost(db, env.PHOTOS, { ...base, memo: ` ${"가".repeat(500)} `, photos: [] }, T0)).resolves.toBeTypeOf("number");
  });

  it("rejects photos over 5 MB, accepts exactly 5 MB, and rejects unknown mime", async () => {
    const MB5 = 5 * 1024 * 1024;
    await expect(createPost(db, env.PHOTOS, { ...base, photos: [jpg("big", "image/jpeg", MB5 + 1)] }, T0)).rejects.toThrow(DomainError);
    await expect(createPost(db, env.PHOTOS, { ...base, photos: [jpg("ok", "image/jpeg", MB5)] }, T0)).resolves.toBeTypeOf("number");
    await expect(createPost(db, env.PHOTOS, { ...base, photos: [jpg("x", "")] }, T0)).rejects.toThrow(DomainError);
  });

  it("rejects an unknown kind", async () => {
    await expect(createPost(db, env.PHOTOS, { ...base, kind: "nope" as never, photos: [] }, T0)).rejects.toThrow(DomainError);
  });

  it("stores nothing when validation fails", async () => {
    await createPost(db, env.PHOTOS, { ...base, photos: [jpg("a"), jpg("g", "image/gif")] }, T0).catch(() => {});
    expect(await db.select().from(posts)).toHaveLength(0);
  });
});

describe("createPost", () => {
  it("stores rows and R2 objects in order", async () => {
    const id = await createPost(
      db,
      env.PHOTOS,
      {
        kind: "case",
        memo: " 메모 ",
        privateCustomer: true,
        attachPrices: false,
        photos: [jpg("a"), jpg("b")],
        photoSizes: [{ width: 1600, height: 1200 }, { width: 900, height: 1600 }],
      },
      T0,
    );
    const v = await getPost(db, id);
    expect(v!.post.memo).toBe("메모");
    expect(v!.post.status).toBe("draft");
    expect(v!.post.privateCustomer).toBe(true);
    expect(v!.post.createdAt).toBe(T0.toISOString());
    expect(v!.photos.map((p) => p.r2Key)).toEqual([`posts/${id}/1.jpg`, `posts/${id}/2.jpg`]);
    expect(v!.photos.map((p) => p.position)).toEqual([1, 2]);
    expect(v!.photos.map((p) => [p.width, p.height])).toEqual([[1600, 1200], [900, 1600]]);
    const obj = await env.PHOTOS.get(`posts/${id}/2.jpg`);
    expect(obj).not.toBeNull();
    expect(obj!.httpMetadata?.contentType).toBe("image/jpeg");
  });

  it("defaults missing sizes to 0", async () => {
    const id = await createPost(db, env.PHOTOS, { ...base, photos: [jpg("a")] }, T0);
    const v = await getPost(db, id);
    expect([v!.photos[0].width, v!.photos[0].height]).toEqual([0, 0]);
  });

  it("allows zero photos", async () => {
    const id = await createPost(db, env.PHOTOS, { ...base, photos: [] }, T0);
    expect(id).toBeTypeOf("number");
    expect((await getPost(db, id))!.photos).toEqual([]);
  });
});

describe("getPost / listPosts", () => {
  it("returns null for an unknown id", async () => {
    expect(await getPost(db, 99999)).toBeNull();
  });

  it("returns the latest draft version per channel and null for the rest", async () => {
    const id = await createPost(db, env.PHOTOS, { ...base, photos: [] }, T0);
    const fresh = await getPost(db, id);
    expect(fresh!.drafts).toEqual({ blog: null, instagram: null, daangn: null, place: null });

    const row = { postId: id, source: "ai" as const, createdAt: T0.toISOString() };
    await db.insert(drafts).values([
      { ...row, channel: "blog", version: 1, body: "v1" },
      { ...row, channel: "blog", version: 3, body: "v3", title: "t", hashtags: '["#a"]', editRatio: 0.2, confirmedAt: T0.toISOString() },
      { ...row, channel: "blog", version: 2, body: "v2" },
      { ...row, channel: "daangn", version: 1, body: "d1" },
    ]);
    const v = await getPost(db, id);
    expect(v!.drafts.blog).toMatchObject({ version: 3, body: "v3", hashtags: '["#a"]', editRatio: 0.2, confirmedAt: T0.toISOString() });
    expect(v!.drafts.daangn!.body).toBe("d1");
    expect(v!.drafts.instagram).toBeNull();
    expect(v!.drafts.place).toBeNull();
  });

  it("lists newest first with a 40-char memo preview and status, honouring limit", async () => {
    const a = await createPost(db, env.PHOTOS, { ...base, memo: "첫 번째", photos: [] }, T0);
    const b = await createPost(db, env.PHOTOS, { ...base, memo: "나".repeat(60), photos: [] }, new Date(T0.getTime() + 1000));
    const list = await listPosts(db);
    expect(list.map((p) => p.id)).toEqual([b, a]);
    expect(list[0].memoPreview).toBe("나".repeat(40));
    expect(list[1].memoPreview).toBe("첫 번째");
    expect(list[0].status).toBe("draft");
    expect(await listPosts(db, 1)).toHaveLength(1);
  });
});
