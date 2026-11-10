import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inquiries, quotes, quoteVersions } from "../database/schema";
import {
  inquiryForQuote,
  purgeOldInquiries,
  submitInquiry,
  type SubmitDeps,
} from "../app/inquiry/inquiries.server";
import { getDb } from "../app/server/db";
import { InquiryService } from "../workers/inquiry-service";

const db = getDb(env.DB);
const NOW = new Date("2026-11-10T01:00:00.000Z");
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

// Made-up customer; nothing here is real.
function raw(over: Record<string, unknown> = {}) {
  return {
    contactName: "김예시",
    org: "예시 학원",
    phone: "010-0000-0000",
    email: "test@example.com",
    eventDate: "2026-12-01",
    startTime: "14:00",
    venue: "예시 강당",
    headcount: 40,
    eventType: "학교·학원",
    menus: ["핑거푸드", "음료"],
    budget: "",
    requests: "알레르기 확인 부탁드려요",
    referral: "블로그",
    consent: true,
    clientToken: "token-1",
    ...over,
  };
}

function makeDeps(over: Partial<SubmitDeps> = {}) {
  const startGeneration = vi.fn(async (_quoteId: number) => {});
  const notify = vi.fn(async (_info: unknown) => "disabled");
  const deps: SubmitDeps = { db, startGeneration, notify, ...over };
  return { deps, startGeneration, notify };
}

const META = { ipHash: "hash-a" };

async function allInquiries() {
  return db.select().from(inquiries);
}

beforeEach(async () => {
  await db.delete(inquiries);
  await db.delete(quotes);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("submitInquiry", () => {
  it("stores inquiry, creates one quote, links it", async () => {
    const { deps, startGeneration, notify } = makeDeps();
    const res = await submitInquiry(deps, raw(), META, NOW);

    expect(res.ok).toBe(true);
    const rows = await allInquiries();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(res).toEqual({ ok: true, inquiryId: row.id });
    expect(row).toMatchObject({
      clientToken: "token-1",
      ipHash: "hash-a",
      contactName: "김예시",
      org: "예시 학원",
      phone: "010-0000-0000",
      email: "test@example.com",
      eventDate: "2026-12-01",
      startTime: "14:00",
      venue: "예시 강당",
      headcount: 40,
      eventType: "학교·학원",
      budget: "",
      requests: "알레르기 확인 부탁드려요",
      referral: "블로그",
      consentAt: NOW.toISOString(),
      createdAt: NOW.toISOString(),
    });
    expect(JSON.parse(row.menusJson)).toEqual(["핑거푸드", "음료"]);

    const qs = await db.select().from(quotes);
    expect(qs).toHaveLength(1);
    expect(qs[0].source).toBe("app");
    expect(row.quoteId).toBe(qs[0].id);
    expect(startGeneration).toHaveBeenCalledExactlyOnceWith(qs[0].id);
    expect(notify).toHaveBeenCalledExactlyOnceWith({
      quoteId: qs[0].id,
      org: "예시 학원",
      eventDate: "2026-12-01",
      headcount: 40,
    });
    expect(await inquiryForQuote(db, qs[0].id)).toEqual({
      contactName: "김예시",
      org: "예시 학원",
      phone: "010-0000-0000",
      email: "test@example.com",
    });
    expect(await inquiryForQuote(db, qs[0].id + 999)).toBeNull();
  });

  it("quote input text has no phone, email or name", async () => {
    const { deps } = makeDeps();
    await submitInquiry(deps, raw(), META, NOW);

    const [v] = await db.select().from(quoteVersions);
    expect(v.version).toBe(1);
    expect(v.inputText).toContain("예시 학원");
    expect(v.inputText).toContain("예시 강당");
    expect(v.inputText).not.toContain("010-0000-0000");
    expect(v.inputText).not.toContain("test@example.com");
    expect(v.inputText).not.toContain("김예시");
    expect(v.inputText).not.toContain("token-1");
    // Tells the drafting step the contact is already stored, so the reply does not ask again.
    expect(v.inputText?.split("\n").at(-1)).toBe("연락처: 문의 양식으로 받았어요(따로 저장)");
  });

  it("quote creation failure keeps the inquiry and still notifies with a null quoteId", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "batch") return () => Promise.reject(new Error("d1 down"));
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const { deps, startGeneration, notify } = makeDeps({ db: broken });
    const res = await submitInquiry(deps, raw(), META, NOW);

    expect(res.ok).toBe(true);
    const [row] = await allInquiries();
    expect(row.quoteId).toBeNull();
    expect(startGeneration).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledExactlyOnceWith({
      quoteId: null,
      org: "예시 학원",
      eventDate: "2026-12-01",
      headcount: 40,
    });
    expect(err).toHaveBeenCalled();
  });

  it("same clientToken returns the first inquiry and creates one quote", async () => {
    const { deps, startGeneration, notify } = makeDeps();
    const first = await submitInquiry(deps, raw(), META, NOW);
    const again = await submitInquiry(deps, raw({ org: "다른 곳" }), META, new Date(NOW.getTime() + 1000));

    expect(again).toEqual(first);
    expect(await allInquiries()).toHaveLength(1);
    expect((await allInquiries())[0].org).toBe("예시 학원");
    expect(await db.select().from(quotes)).toHaveLength(1);
    expect(startGeneration).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("6th inquiry from one ipHash within an hour is RATE_LIMITED", async () => {
    const { deps, startGeneration } = makeDeps();
    for (let i = 1; i <= 5; i++) {
      const res = await submitInquiry(deps, raw({ clientToken: `t-${i}` }), META, new Date(NOW.getTime() + i * 1000));
      expect(res.ok).toBe(true);
    }
    const at = new Date(NOW.getTime() + 10_000);
    expect(await submitInquiry(deps, raw({ clientToken: "t-6" }), META, at)).toEqual({
      ok: false,
      code: "RATE_LIMITED",
    });
    expect(await allInquiries()).toHaveLength(5);
    expect(await db.select().from(quotes)).toHaveLength(5);
    expect(startGeneration).toHaveBeenCalledTimes(5);

    // Another sender is not affected, and the same one is fine again after an hour.
    expect((await submitInquiry(deps, raw({ clientToken: "t-7" }), { ipHash: "hash-b" }, at)).ok).toBe(true);
    const later = new Date(NOW.getTime() + HOUR + 6000);
    expect((await submitInquiry(deps, raw({ clientToken: "t-8" }), META, later)).ok).toBe(true);
  });

  it("startQuoteGeneration failure still returns ok and keeps inquiry", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps, notify } = makeDeps({
      startGeneration: async () => {
        throw new Error("workflow down");
      },
    });
    const res = await submitInquiry(deps, raw(), META, NOW);

    expect(res.ok).toBe(true);
    const [row] = await allInquiries();
    expect(row.quoteId).not.toBeNull();
    expect(err).toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("notify failure still returns ok", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps } = makeDeps({
      notify: async () => {
        throw new Error("kakao down");
      },
    });
    const res = await submitInquiry(deps, raw(), META, NOW);

    expect(res.ok).toBe(true);
    expect(await allInquiries()).toHaveLength(1);
    expect(err).toHaveBeenCalled();
  });

  it("a failing read rejects with a bare INQUIRY_READ_FAILED and logs nothing with the ip hash", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const leaky = () => new Error("Failed query: select ... params: secret-hash-zz,2026-11-10");
    // Fails on the token lookup (1st read), then on the rate-limit count (2nd read).
    for (const failAt of [0, 1]) {
      let reads = 0;
      const flaky = {
        select: (...args: unknown[]) => {
          if (reads++ === failAt) throw leaky();
          return (db.select as (...a: unknown[]) => unknown)(...args);
        },
      } as unknown as SubmitDeps["db"];
      const { deps, startGeneration } = makeDeps({ db: flaky });
      const caught = await submitInquiry(deps, raw(), { ipHash: "secret-hash-zz" }, NOW).catch((e) => e);
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe("INQUIRY_READ_FAILED");
      expect((caught as Error).cause).toBeUndefined();
      expect(startGeneration).not.toHaveBeenCalled();
    }
    for (const spy of [err, log, warn]) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain("secret-hash-zz");
    }
    expect(await allInquiries()).toHaveLength(0);
  });

  it("invalid input is INVALID and stores nothing", async () => {
    const { deps, startGeneration } = makeDeps();
    for (const bad of [
      raw({ phone: "123" }),
      raw({ consent: false }),
      raw({ contactName: "" }),
      raw({ eventDate: "2026-11-01" }),
      null,
      "text",
    ]) {
      expect(await submitInquiry(deps, bad, META, NOW)).toEqual({ ok: false, code: "INVALID" });
    }
    expect(await submitInquiry(deps, raw(), { ipHash: "" }, NOW)).toEqual({ ok: false, code: "INVALID" });
    expect(await allInquiries()).toHaveLength(0);
    expect(await db.select().from(quotes)).toHaveLength(0);
    expect(startGeneration).not.toHaveBeenCalled();
  });

  it("accepts an event date one day in the past (time zone slack)", async () => {
    const { deps } = makeDeps();
    // Seoul today is 2026-11-10; yesterday passes, two days ago does not.
    expect((await submitInquiry(deps, raw({ eventDate: "2026-11-09" }), META, NOW)).ok).toBe(true);
    expect(await submitInquiry(deps, raw({ eventDate: "2026-11-08", clientToken: "t-2" }), META, NOW)).toEqual({
      ok: false,
      code: "INVALID",
    });
  });

  it("does not log phone, email, name or ip hash", async () => {
    const logs = [
      vi.spyOn(console, "error").mockImplementation(() => {}),
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
    ];
    const { deps } = makeDeps({
      startGeneration: async () => {
        throw new Error("boom");
      },
      notify: async () => {
        throw new Error("boom");
      },
    });
    await submitInquiry(deps, raw(), META, NOW);
    const text = JSON.stringify(logs.flatMap((l) => l.mock.calls.map((c) => c.map(String))));
    for (const secret of ["010-0000-0000", "test@example.com", "김예시", "hash-a"]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe("purgeOldInquiries", () => {
  it("purge drops inquiries older than 365 days and blanks quote contact", async () => {
    const { deps } = makeDeps();
    const oldAt = new Date(NOW.getTime() - 366 * DAY);
    const freshAt = new Date(NOW.getTime() - 364 * DAY);
    await submitInquiry(deps, raw({ clientToken: "old", eventDate: null }), { ipHash: "h1" }, oldAt);
    await submitInquiry(deps, raw({ clientToken: "fresh", eventDate: null }), { ipHash: "h2" }, freshAt);
    const [oldRow, freshRow] = (await allInquiries()).sort((a, b) => a.id - b.id);

    const event = JSON.stringify({
      customerName: "예시 학원",
      contactName: "김예시",
      contact: "010-0000-0000",
      email: "test@example.com",
      eventDate: "",
      headcount: 40,
      venue: "예시 강당",
    });
    // Two versions on the old quote (one still generating, with no event), one on the fresh quote.
    await db.update(quoteVersions).set({ eventJson: event }).where(eq(quoteVersions.quoteId, oldRow.quoteId!));
    await db.insert(quoteVersions).values({
      quoteId: oldRow.quoteId!,
      version: 2,
      status: "generating",
      inputText: "x",
      eventJson: event,
      createdAt: oldAt.toISOString(),
    });
    await db.insert(quoteVersions).values({
      quoteId: oldRow.quoteId!,
      version: 3,
      status: "generating",
      inputText: "x",
      createdAt: oldAt.toISOString(),
    });
    await db.update(quoteVersions).set({ eventJson: event }).where(eq(quoteVersions.quoteId, freshRow.quoteId!));

    expect(await purgeOldInquiries(db, NOW)).toBe(1);

    const left = await allInquiries();
    expect(left.map((r) => r.id)).toEqual([freshRow.id]);

    const oldVersions = await db.select().from(quoteVersions).where(eq(quoteVersions.quoteId, oldRow.quoteId!));
    expect(oldVersions).toHaveLength(3);
    for (const v of oldVersions.filter((x) => x.eventJson !== null)) {
      expect(JSON.parse(v.eventJson!)).toEqual({
        customerName: "예시 학원",
        contactName: "",
        contact: "",
        email: "",
        eventDate: "",
        headcount: 40,
        venue: "예시 강당",
      });
    }
    expect(oldVersions.find((v) => v.version === 3)!.eventJson).toBeNull();
    // The quote itself stays; the fresh quote keeps its contact.
    expect(await db.select().from(quotes).where(eq(quotes.id, oldRow.quoteId!))).toHaveLength(1);
    const [freshVersion] = await db.select().from(quoteVersions).where(eq(quoteVersions.quoteId, freshRow.quoteId!));
    expect(JSON.parse(freshVersion.eventJson!).contact).toBe("010-0000-0000");

    // Nothing left to purge.
    expect(await purgeOldInquiries(db, NOW)).toBe(0);
  });
});

describe("InquiryService", () => {
  it("submit stores through the real bindings; fetch is a 404", async () => {
    const startGeneration = vi.fn();
    const svc = new InquiryService({ waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext, {
      ...env,
      // No real Workflow in this test; startQuoteGeneration reports the failure on the version.
      QUOTE_GENERATE: {
        create: async (...a: unknown[]) => {
          startGeneration(...a);
          return {};
        },
      } as unknown as Env["QUOTE_GENERATE"],
    } as Env);

    const res = await svc.submit(raw({ clientToken: "svc-1", eventDate: null }), { ipHash: "svc-hash" });
    expect(res.ok).toBe(true);
    expect(startGeneration).toHaveBeenCalledTimes(1);
    expect(await allInquiries()).toHaveLength(1);
    expect((await svc.fetch()).status).toBe(404);
  });
});
