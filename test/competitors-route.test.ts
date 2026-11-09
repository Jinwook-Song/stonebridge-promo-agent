import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { competitorEvents, competitorPrices, watchSources } from "../database/schema";
import { action, loader } from "../app/routes/competitors";
import { listEvents, listPriceGroups } from "../app/watch/competitors.server";
import { safeHref } from "../app/watch/format";
import { startWatchRun } from "../app/watch/run.server";
import { getDb } from "../app/server/db";
import { listWatchSources, saveWatchSource } from "../app/watch/sources.server";

const db = getDb(env.DB);
const T = "2026-11-09T03:00:00.000Z";
const kstDate = (d: Date) => new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 10);

beforeEach(async () => {
  await db.delete(competitorEvents);
  await db.delete(competitorPrices);
  await db.delete(watchSources);
});

async function addSource(name = "가짜 블로그") {
  return saveWatchSource(db, { name, kind: "rss", url: "https://rival.example/feed", memo: "", enabled: true }, new Date(T));
}

async function addEvent(sourceId: number, n: number, over: Partial<typeof competitorEvents.$inferInsert> = {}) {
  await db.insert(competitorEvents).values({
    sourceId,
    sourceUrl: `https://rival.example/post/${n}`,
    seenAt: `2026-11-0${n}T03:00:00.000Z`,
    ...over,
  });
}

function loadTab(query: string) {
  return loader({ request: new Request(`http://localhost/competitors${query}`), params: {}, context: {} } as never);
}

function post(fields: Record<string, string>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return action({ request: new Request("http://localhost/competitors", { method: "POST", body: form }), params: {}, context: {} } as never);
}

describe("news tab", () => {
  it("filters by competitor, client or venue text and returns only matches", async () => {
    const a = await addSource("가짜 블로그");
    const b = await addSource("진짜 케이터링");
    await addEvent(a, 1, { client: "가짜병원", venue: "서울" });
    await addEvent(a, 2, { client: "가짜회사", venue: "부산 병원 강당" });
    await addEvent(b, 3, { client: "가짜학원", venue: "대전" });

    const hits = await loadTab("?tab=news&q=병원");
    expect(hits.events.map((e) => e.client)).toEqual(["가짜회사", "가짜병원"]);

    // The competitor's name matches too.
    expect((await loadTab("?tab=news&q=케이터링")).events.map((e) => e.client)).toEqual(["가짜학원"]);
    expect((await loadTab("?tab=news")).events).toHaveLength(3);
    expect((await loadTab("?tab=news&q=없는글자")).events).toEqual([]);
  });

  it("takes % and _ in the search literally", async () => {
    const a = await addSource();
    await addEvent(a, 1, { client: "가짜병원" });
    await addEvent(a, 2, { client: "100% 맛집" });
    expect((await loadTab("?tab=news&q=%25")).events.map((e) => e.client)).toEqual(["100% 맛집"]);
    expect((await loadTab("?tab=news&q=_")).events).toEqual([]);
  });

  it("searches with a long Korean query (D1 caps LIKE patterns at 50 bytes) without throwing", async () => {
    const long = "가나다라마바사아자차카타파하".repeat(2) + "거너더러머버"; // 30 characters
    expect(long.length).toBe(34);
    const a = await addSource();
    await addEvent(a, 1, { client: "가짜병원", venue: long });
    expect((await loadTab(`?tab=news&q=${encodeURIComponent(long)}`)).events.map((e) => e.client)).toEqual(["가짜병원"]);
    expect((await loadTab(`?tab=news&q=${encodeURIComponent(long + "없음")}`)).events).toEqual([]);
  });

  it("matches letters in any case", async () => {
    const a = await addSource("Demo Catering");
    await addEvent(a, 1, { client: "가짜병원" });
    expect((await listEvents(db, "demo CATER")).map((e) => e.client)).toEqual(["가짜병원"]);
  });

  it("shows the unfiltered list with a flag when the search query throws", async () => {
    const a = await addSource();
    await addEvent(a, 1, { client: "가짜병원" });
    // A database that refuses the search statement (what D1 does for a too-complex LIKE pattern).
    const realDb = env.DB;
    (env as { DB: unknown }).DB = new Proxy(realDb, {
      get(target, prop) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (sql.includes("instr(")) throw new Error("LIKE or GLOB pattern too complex");
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, prop) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    let res;
    try {
      res = await loader({ request: new Request("http://localhost/competitors?tab=news&q=병원"), params: {}, context: {} } as never);
    } finally {
      (env as { DB: unknown }).DB = realDb;
    }
    expect(res.searchFailed).toBe(true);
    expect(res.events).toHaveLength(1);
  });

  it("lists newest first, at most 100, with source link, seen date, menu and notes", async () => {
    const a = await addSource();
    await addEvent(a, 1, { client: "오래된" });
    await addEvent(a, 2, { client: "최신", menuJson: JSON.stringify(["다과", "음료"]), notes: "1인 8,000원", price: 300000 });
    const { events } = await loadTab("?tab=news");
    expect(events[0]).toMatchObject({
      client: "최신",
      menu: ["다과", "음료"],
      notes: "1인 8,000원",
      price: 300000,
      sourceUrl: "https://rival.example/post/2",
      seenAt: "2026-11-02T03:00:00.000Z",
      sourceName: "가짜 블로그",
    });
    expect(events.map((e) => e.client)).toEqual(["최신", "오래된"]);

    for (let i = 0; i < 105; i++) {
      await db.insert(competitorEvents).values({ sourceId: a, sourceUrl: `https://rival.example/bulk/${i}`, seenAt: T });
    }
    expect(await listEvents(db, "")).toHaveLength(100);
  });

  it("survives a broken menu_json", async () => {
    const a = await addSource();
    await addEvent(a, 1, { menuJson: "{oops" });
    expect((await listEvents(db, ""))[0]!.menu).toEqual([]);
  });

  it("treats an unknown tab as the news tab and reads only the open tab", async () => {
    const a = await addSource();
    await addEvent(a, 1, { client: "가짜병원" });
    const res = await loadTab("?tab=nope");
    expect(res.tab).toBe("news");
    expect(res.events).toHaveLength(1);
    expect(res.sources).toEqual([]);
  });
});

describe("prices tab", () => {
  async function price(sourceId: number, over: Partial<typeof competitorPrices.$inferInsert>) {
    await db.insert(competitorPrices).values({
      sourceId,
      sourceUrl: "https://rival.example/price",
      packageName: "A 다과",
      seenAt: T,
      ...over,
    });
  }

  it("puts the newest value of a package on top and counts the earlier ones", async () => {
    const a = await addSource();
    // The newer row is inserted first, so only seen_at (not the id) can say which is newest.
    await price(a, { perPerson: 11000, seenAt: "2026-11-08T03:00:00.000Z" });
    await price(a, { perPerson: 10000, seenAt: "2026-10-01T03:00:00.000Z" });
    await price(a, { perPerson: 9000, seenAt: "2026-09-01T03:00:00.000Z", itemsJson: JSON.stringify(["쿠키"]) });
    await price(a, { packageName: "B 도시락", perPerson: 12000, seenAt: "2026-11-05T03:00:00.000Z" });

    const groups = await listPriceGroups(db);
    expect(groups.map((g) => g.packageName)).toEqual(["A 다과", "B 도시락"]);
    const g = groups[0]!;
    expect(g.latest.perPerson).toBe(11000);
    expect(g.earlier.map((p) => p.perPerson)).toEqual([10000, 9000]);
    expect(g.earlier[1]!.items).toEqual(["쿠키"]);
    expect(groups[1]!.earlier).toEqual([]);
    expect((await loadTab("?tab=prices")).prices).toHaveLength(2);
  });

  it("keeps the same package name of two sources apart", async () => {
    const a = await addSource("가나");
    const b = await addSource("다라");
    await price(a, { perPerson: 1000 });
    await price(b, { perPerson: 2000 });
    const groups = await listPriceGroups(db);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.earlier.length === 0)).toBe(true);
  });
});

describe("sources tab actions", () => {
  it("saves a source and rejects a non-http address with a Korean message", async () => {
    const ok = await post({ intent: "saveSource", name: "새 곳", kind: "page", url: "https://rival.example/p", memo: "", enabled: "1" });
    expect(ok).toEqual({ ok: true });
    expect((await listWatchSources(db)).map((s) => [s.name, s.kind, s.enabled])).toEqual([["새 곳", "page", true]]);

    const bad = await post({ intent: "saveSource", name: "나쁜 곳", kind: "rss", url: "javascript:alert(1)", memo: "", enabled: "1" });
    expect(bad).toMatchObject({ error: expect.stringMatching(/http/) });
    expect(await listWatchSources(db)).toHaveLength(1);
  });

  it("turns a source off (unchecked box) and deletes it with its rows", async () => {
    const id = await addSource();
    await addEvent(id, 1);
    await post({ intent: "saveSource", id: String(id), name: "가짜 블로그", kind: "rss", url: "https://rival.example/feed", memo: "" });
    expect((await listWatchSources(db))[0]!.enabled).toBe(false);

    await post({ intent: "deleteSource", id: String(id) });
    expect(await listWatchSources(db)).toEqual([]);
    expect(await db.select().from(competitorEvents)).toEqual([]);
  });

  it("rejects an unknown intent and a bad kind", async () => {
    expect(await post({ intent: "nope" })).toMatchObject({ error: expect.any(String) });
    expect(await post({ intent: "saveSource", name: "x", kind: "ftp", url: "https://a.example" })).toMatchObject({
      error: expect.stringMatching(/종류/),
    });
  });

  describe("runNow", () => {
    const real = env.WATCH;
    afterEach(() => {
      (env as { WATCH: unknown }).WATCH = real;
    });

    /** A fake Workflow binding: instances by id with a status; create adds a running one. */
    function fakeWatch(initial: Record<string, string> = {}) {
      const instances = new Map(Object.entries(initial));
      const create = vi.fn(async ({ id }: { id: string }) => {
        if (instances.has(id)) throw new Error("instance.already_exists");
        instances.set(id, "running");
        return { id };
      });
      const get = vi.fn(async (id: string) => {
        if (!instances.has(id)) throw new Error("instance.not_found");
        return { status: async () => ({ status: instances.get(id)! }) };
      });
      (env as { WATCH: unknown }).WATCH = { create, get };
      return { create, instances };
    }

    it("starts a manual instance, once per KST hour", async () => {
      const { create } = fakeWatch();
      const res = await post({ intent: "runNow" });
      expect(res).toMatchObject({ ok: true, message: expect.stringContaining("시작했어요") });
      expect(create).toHaveBeenCalledTimes(1);
      expect(create.mock.calls[0]![0].id).toMatch(/^watch-manual-\d{4}-\d{2}-\d{2}-\d{2}$/);

      // A second tap in the same hour: the first is still running, nothing new starts.
      const again = await post({ intent: "runNow" });
      expect(again).toMatchObject({ ok: true, message: expect.stringContaining("이미 돌고 있어요") });
      expect(create).toHaveBeenCalledTimes(1);
    });

    it("does not start while today's cron run is going", async () => {
      const { create } = fakeWatch({ [`watch-${kstDate(new Date())}`]: "running" });
      const res = await post({ intent: "runNow" });
      expect(res).toMatchObject({ message: "이미 돌고 있어요. 조금 뒤에 확인해 주세요." });
      expect(create).not.toHaveBeenCalled();
    });

    it("starts when today's cron run is already complete", async () => {
      const { create } = fakeWatch({ [`watch-${kstDate(new Date())}`]: "complete" });
      expect(await post({ intent: "runNow" })).toMatchObject({ message: expect.stringContaining("시작했어요") });
      expect(create).toHaveBeenCalledTimes(1);
    });

    it("says so when the Workflow could not start", async () => {
      (env as { WATCH: unknown }).WATCH = {
        create: vi.fn(async () => {
          throw new Error("boom");
        }),
        get: vi.fn(async () => {
          throw new Error("not found");
        }),
      };
      vi.spyOn(console, "error").mockImplementation(() => {});
      expect(await post({ intent: "runNow" })).toMatchObject({ error: expect.stringMatching(/시작하지 못했어요/) });
    });
  });
});

describe("startWatchRun", () => {
  it("uses the given instance id, and the KST date id by default", async () => {
    const create = vi.fn(async ({ id }: { id?: string }) => ({ id }));
    const wf = { create, get: vi.fn() } as never;
    await startWatchRun(wf, new Date("2026-11-09T18:00:00Z"));
    await startWatchRun(wf, new Date("2026-11-09T18:00:00Z"), "watch-manual-5");
    expect(create.mock.calls.map((c) => c[0].id)).toEqual(["watch-2026-11-10", "watch-manual-5"]);
  });
});

describe("safeHref", () => {
  it("links only http(s)", () => {
    expect(safeHref("https://rival.example/a?b=1")).toBe("https://rival.example/a?b=1");
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,x")).toBeNull();
    expect(safeHref("not a url")).toBeNull();
  });
});
