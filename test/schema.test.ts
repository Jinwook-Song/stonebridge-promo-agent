import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../app/server/db";
import {
  competitorEvents,
  competitorPrices,
  drafts,
  photos,
  posts,
  priceItems,
  quotes,
  quoteVersions,
  watchSources,
} from "../database/schema";

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

  describe("quote agent tables", () => {
    const sender = JSON.stringify({ company: "c", person: "p", phone: "1", email: "e@x.test", payment: "", onsite: "", bizNo: "" });

    async function newQuote() {
      const db = getDb(env.DB);
      const [q] = await db
        .insert(quotes)
        .values({ status: "draft", source: "app", senderJson: sender, vatIncluded: false, createdAt: now, updatedAt: now })
        .returning();
      return q;
    }

    async function newVersion(quoteId: number, version: number) {
      const db = getDb(env.DB);
      const [v] = await db
        .insert(quoteVersions)
        .values({ quoteId, version, status: "generating", inputText: "text", createdAt: now })
        .returning();
      return v;
    }

    async function newSource(url: string) {
      const db = getDb(env.DB);
      const [s] = await db
        .insert(watchSources)
        .values({ name: "src", kind: "rss", url, createdAt: now })
        .returning();
      return s;
    }

    it("stores and reads a row in each of the six tables", async () => {
      const db = getDb(env.DB);
      const [item] = await db
        .insert(priceItems)
        .values({ kind: "per_person", name: "item", unit: "person", unitPrice: 1000, createdAt: now })
        .returning();
      expect(item).toMatchObject({ content: "", minimumQty: null, needsConfirm: false, enabled: true, sort: 0 });

      const q = await newQuote();
      expect(q.vatIncluded).toBe(false);
      const v = await newVersion(q.id, 1);
      expect(v).toMatchObject({ status: "generating", eventJson: null, linesJson: null, generatedAt: null });

      const src = await newSource("https://example.test/feed");
      expect(src).toMatchObject({ enabled: true, lastStatus: null, memo: "" });

      await db.insert(competitorEvents).values({ sourceId: src.id, sourceUrl: "https://example.test/e/1", seenAt: now });
      await db
        .insert(competitorPrices)
        .values({ sourceId: src.id, sourceUrl: "https://example.test/p", packageName: "pkg", perPerson: 20000, seenAt: now });
      expect(await db.select().from(competitorEvents).where(eq(competitorEvents.sourceId, src.id))).toHaveLength(1);
      expect(await db.select().from(competitorPrices).where(eq(competitorPrices.sourceId, src.id))).toHaveLength(1);
    });

    it("rejects a duplicate (quoteId, version)", async () => {
      const q = await newQuote();
      await newVersion(q.id, 1);
      await expect(newVersion(q.id, 1)).rejects.toThrow();
      await newVersion(q.id, 2);
    });

    it("deletes versions with their quote", async () => {
      const db = getDb(env.DB);
      const q = await newQuote();
      await newVersion(q.id, 1);
      await db.delete(quotes).where(eq(quotes.id, q.id));
      expect(await db.select().from(quoteVersions).where(eq(quoteVersions.quoteId, q.id))).toHaveLength(0);
    });

    it("rejects a duplicate competitor event sourceUrl", async () => {
      const db = getDb(env.DB);
      const src = await newSource("https://example.test/feed2");
      const url = "https://example.test/e/dup";
      await db.insert(competitorEvents).values({ sourceId: src.id, sourceUrl: url, seenAt: now });
      await expect(db.insert(competitorEvents).values({ sourceId: src.id, sourceUrl: url, seenAt: now })).rejects.toThrow();
    });

    it("rejects unknown enum values through the CHECK constraints", async () => {
      const bad = (sqlText: string, ...binds: unknown[]) => expect(env.DB.prepare(sqlText).bind(...binds).run()).rejects.toThrow();
      await bad("insert into quotes (status, source, sender_json, vat_included, created_at, updated_at) values ('zzz','app','{}',0,?,?)", now, now);
      await bad("insert into quotes (status, source, sender_json, vat_included, created_at, updated_at) values ('draft','zzz','{}',0,?,?)", now, now);
      const q = await newQuote();
      await bad("insert into quote_versions (quote_id, version, status, input_text, created_at) values (?,1,'zzz','t',?)", q.id, now);
      await bad("insert into price_items (kind, name, unit, created_at) values ('zzz','n','u',?)", now);
      await bad("insert into watch_sources (name, kind, url, created_at) values ('n','zzz','u',?)", now);
      await bad("insert into watch_sources (name, kind, url, last_status, created_at) values ('n','rss','u','zzz',?)", now);
    });
  });
});
