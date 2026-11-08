import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../app/server/db";
import { drafts, photos, posts } from "../database/schema";

const now = "2026-11-08T00:00:00Z";

async function newPost() {
  const db = getDb(env.DB);
  const [p] = await db
    .insert(posts)
    .values({ kind: "case", memo: "m", privateCustomer: false, attachPrices: false, status: "ready", createdAt: now })
    .returning();
  return p;
}

describe("schema", () => {
  it("stores a post with photos and drafts", async () => {
    const db = getDb(env.DB);
    const p = await newPost();
    await db.insert(drafts).values({ postId: p.id, channel: "blog", version: 1, body: "b", source: "ai", createdAt: now });
    await expect(
      db.insert(drafts).values({ postId: p.id, channel: "blog", version: 1, body: "x", source: "ai", createdAt: now }),
    ).rejects.toThrow();
    // another channel or version is fine
    await db.insert(drafts).values({ postId: p.id, channel: "instagram", version: 1, body: "b", source: "ai", createdAt: now });
    await db.insert(drafts).values({ postId: p.id, channel: "blog", version: 2, body: "b2", source: "edit", createdAt: now });
  });

  it("rejects duplicate photo positions and r2 keys", async () => {
    const db = getDb(env.DB);
    const p = await newPost();
    await db.insert(photos).values({ postId: p.id, r2Key: `photos/${p.id}/a`, position: 0, width: 10, height: 10 });
    await expect(
      db.insert(photos).values({ postId: p.id, r2Key: `photos/${p.id}/b`, position: 0, width: 10, height: 10 }),
    ).rejects.toThrow();
    await expect(
      db.insert(photos).values({ postId: p.id, r2Key: `photos/${p.id}/a`, position: 1, width: 10, height: 10 }),
    ).rejects.toThrow();
  });

  it("cascades photos and drafts when a post is deleted", async () => {
    const db = getDb(env.DB);
    const p = await newPost();
    await db.insert(photos).values({ postId: p.id, r2Key: `photos/${p.id}/c`, position: 0, width: 1, height: 1 });
    await db.insert(drafts).values({ postId: p.id, channel: "place", version: 1, body: "b", source: "ai", createdAt: now });
    await db.delete(posts).where(eq(posts.id, p.id));
    expect(await db.select().from(photos).where(eq(photos.postId, p.id))).toHaveLength(0);
    expect(await db.select().from(drafts).where(eq(drafts.postId, p.id))).toHaveLength(0);
  });

  it("rejects an unknown post status", async () => {
    await expect(
      env.DB.prepare(
        "insert into posts (kind, memo, private_customer, attach_prices, status, created_at) values ('case','m',0,0,'zzz',?)",
      )
        .bind(now)
        .run(),
    ).rejects.toThrow();
  });
});
