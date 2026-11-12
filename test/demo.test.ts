import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  demoCalls,
  examples,
  posts,
  priceItems,
  quotes,
  quoteVersions,
  settings,
  watchSources,
} from "../database/schema";
import {
  DEMO_DAILY_LIMIT,
  DEMO_HOURLY_LIMIT,
  DEMO_LIMIT_MESSAGE,
  isDemo,
  kstDayStart,
  takeDemoCall,
} from "../app/demo/quota.server";
import { resetDemo } from "../app/demo/reset.server";
import { seedStatements } from "../app/demo/seed-sql";
import { startGeneration } from "../app/promo/generate.server";
import { startQuoteGeneration } from "../app/quote/generate.server";
import { createQuote } from "../app/quote/quotes.server";
import { isOwner } from "../app/server/auth.server";
import { getDb } from "../app/server/db";
import { DEMO_SEED } from "../demo/seed";

const db = getDb(env.DB);
const T0 = new Date("2026-11-12T03:00:00.000Z"); // 12:00 KST

beforeEach(async () => {
  await db.delete(demoCalls);
});

describe("demo flag", () => {
  it("is off in the owner's config (top-level wrangler vars)", () => {
    expect(env.DEMO).toBe("0");
    expect(isDemo(env)).toBe(false);
  });

  it("only the demo skips the login", async () => {
    const request = new Request("http://localhost/");
    expect(await isOwner(request, env)).toBe(false);
    expect(await isOwner(request, { ...env, DEMO: "1" } as Env)).toBe(true);
  });
});

describe("kstDayStart", () => {
  it("is 15:00 UTC of the day before", () => {
    expect(kstDayStart(T0).toISOString()).toBe("2026-11-11T15:00:00.000Z");
    // 23:30 UTC on the 11th is already 08:30 KST on the 12th.
    expect(kstDayStart(new Date("2026-11-11T23:30:00.000Z")).toISOString()).toBe("2026-11-11T15:00:00.000Z");
  });
});

describe("takeDemoCall", () => {
  it("allows the hourly cap, refuses the next call and leaves no row for it", async () => {
    for (let i = 0; i < DEMO_HOURLY_LIMIT; i++) expect(await takeDemoCall(db, "post", T0)).toBe(true);
    expect(await takeDemoCall(db, "post", T0)).toBe(false);
    expect(await db.select().from(demoCalls)).toHaveLength(DEMO_HOURLY_LIMIT);
    // An hour later there is room again.
    expect(await takeDemoCall(db, "quote", new Date(T0.getTime() + 61 * 60_000))).toBe(true);
  });

  it("caps the KST day across hours, and a new KST day starts fresh", async () => {
    // Spread over the day so no hour is full: 4 calls an hour from 00:00 KST.
    const dayStart = kstDayStart(T0).getTime();
    for (let i = 0; i < DEMO_DAILY_LIMIT; i++) {
      const at = new Date(dayStart + Math.floor(i / 4) * 60 * 60_000 + (i % 4) * 60_000);
      expect(await takeDemoCall(db, "post", at)).toBe(true);
    }
    const late = new Date(dayStart + 20 * 60 * 60_000); // 20:00 KST
    expect(await takeDemoCall(db, "photo_pick", late)).toBe(false);
    const nextDay = new Date(dayStart + 24 * 60 * 60_000 + 60_000);
    expect(await takeDemoCall(db, "post", nextDay)).toBe(true);
  });
});

describe("AI call cap at the start of a run", () => {
  const demoEnv = (create = vi.fn(async ({ id }: { id?: string }) => ({ id }))) => ({
    env: { DEMO: "1", GENERATE: { create }, QUOTE_GENERATE: { create } } as unknown as Pick<
      Env,
      "GENERATE" | "QUOTE_GENERATE"
    > & { DEMO: string },
    create,
  });

  async function fillCap() {
    for (let i = 0; i < DEMO_HOURLY_LIMIT; i++) await takeDemoCall(db, "post", T0);
  }

  it("a post over the cap fails with the reason and starts no Workflow", async () => {
    const [{ id }] = await db
      .insert(posts)
      .values({ kind: "case", memo: "데모 메모", privateCustomer: false, attachPrices: false, status: "draft", createdAt: T0.toISOString() })
      .returning({ id: posts.id });
    await fillCap();
    const { env: e, create } = demoEnv();
    await startGeneration(e, db, id, {}, T0);
    expect(create).not.toHaveBeenCalled();
    const [post] = await db.select().from(posts).where(eq(posts.id, id));
    expect(post.status).toBe("failed");
    expect(post.error).toBe(DEMO_LIMIT_MESSAGE);
  });

  it("a post under the cap starts and is counted", async () => {
    const [{ id }] = await db
      .insert(posts)
      .values({ kind: "case", memo: "데모 메모", privateCustomer: false, attachPrices: false, status: "draft", createdAt: T0.toISOString() })
      .returning({ id: posts.id });
    const { env: e, create } = demoEnv();
    await startGeneration(e, db, id, {}, T0);
    expect(create).toHaveBeenCalledTimes(1);
    expect(await db.select().from(demoCalls)).toEqual([expect.objectContaining({ kind: "post" })]);
  });

  it("the owner's app is never counted", async () => {
    const [{ id }] = await db
      .insert(posts)
      .values({ kind: "case", memo: "메모", privateCustomer: false, attachPrices: false, status: "draft", createdAt: T0.toISOString() })
      .returning({ id: posts.id });
    await fillCap();
    const create = vi.fn(async ({ id: wf }: { id?: string }) => ({ id: wf }));
    await startGeneration({ GENERATE: { create } as unknown as Env["GENERATE"] }, db, id, {}, T0);
    expect(create).toHaveBeenCalledTimes(1);
    expect(await db.select().from(demoCalls)).toHaveLength(DEMO_HOURLY_LIMIT);
  });

  it("a quote over the cap fails with the reason and starts no Workflow", async () => {
    const { quoteId } = await createQuote(db, { text: "12월 5일 회사 송년회 다과 40명", source: "app" }, T0);
    await fillCap();
    const { env: e, create } = demoEnv();
    await startQuoteGeneration(e, db, quoteId, 1, T0);
    expect(create).not.toHaveBeenCalled();
    const [version] = await db.select().from(quoteVersions).where(eq(quoteVersions.quoteId, quoteId));
    expect(version.status).toBe("failed");
    expect(version.error).toBe(DEMO_LIMIT_MESSAGE);
  });
});

describe("demo reset", () => {
  it("refuses outside the demo", async () => {
    await expect(resetDemo(env, DEMO_SEED)).rejects.toThrow("only in the demo");
  });

  it("rejects a table it does not know", () => {
    expect(() => seedStatements({ kakao_link: [{ id: 1 }] })).toThrow("unknown table");
  });

  it("puts the sample data back and removes visitor photos, keeping the call count", async () => {
    await db.insert(settings).values({ key: "owner_password_hash", value: "x" });
    await db.insert(demoCalls).values({ kind: "post", at: T0.toISOString() });
    await createQuote(db, { text: "방문자 견적", source: "app" }, T0);
    await env.PHOTOS.put("visitor/1.jpg", "x");

    const result = await resetDemo({ ...env, DEMO: "1" }, DEMO_SEED);

    expect(result.photosDeleted).toBe(1);
    expect(await env.PHOTOS.get("visitor/1.jpg")).toBeNull();
    expect(await db.select().from(quotes)).toHaveLength(DEMO_SEED.quotes?.length ?? 0);
    expect(await db.select().from(examples)).toHaveLength(DEMO_SEED.examples.length);
    expect(await db.select().from(priceItems)).toHaveLength(DEMO_SEED.price_items.length);
    expect(await db.select().from(watchSources)).toHaveLength(DEMO_SEED.watch_sources.length);
    const keys = (await db.select().from(settings)).map((s) => s.key);
    expect(keys).not.toContain("owner_password_hash");
    expect(keys).toContain("quote_sender");
    expect(await db.select().from(demoCalls)).toHaveLength(1);

    // Runs again cleanly (fixed ids in the seed must not collide with themselves).
    await resetDemo({ ...env, DEMO: "1" }, DEMO_SEED);
    expect(await db.select().from(examples)).toHaveLength(DEMO_SEED.examples.length);
  });

  it("names a fictional shop, never the owner's", () => {
    const text = JSON.stringify(DEMO_SEED);
    expect(text).toContain("돌담 디저트");
    for (const real of ["스톤브릿지", "스톤테이블", "구리", "stone_bridge"]) expect(text).not.toContain(real);
  });
});
