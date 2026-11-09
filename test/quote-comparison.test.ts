import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { competitorEvents, competitorPrices, quotes, quoteVersions, watchSources } from "../database/schema";
import { selectCandidates } from "../app/quote/comparison.server";
import type { QuoteEvent, QuoteLine } from "../app/quote/types";
import { getDb } from "../app/server/db";

const db = getDb(env.DB);
const at = (day: number) => new Date(Date.UTC(2026, 9, day, 1)).toISOString();

// Made-up quotes and competitor rows; nothing here is real.
function event(eventType: string, headcount: number | null): QuoteEvent {
  return {
    customerName: "예시 고객",
    contactName: "",
    contact: "",
    email: "",
    eventDate: "2026-12-01",
    headcount,
    venue: "",
    eventType,
    budget: "",
    requests: "",
    missing: [],
  };
}

const line = (qty: number, unitPrice: number | null): QuoteLine => ({
  itemId: null,
  label: "다과",
  content: "",
  qty,
  unitPrice,
  priceSource: "hand",
  svc: false,
  menu: "",
  note: "",
});

/** A quote with the given versions (1, 2, ...) in order. */
async function ownQuote(
  day: number,
  versions: { status: "generating" | "ready" | "failed"; eventType?: string; headcount?: number | null; lines?: QuoteLine[] }[],
): Promise<number> {
  const [q] = await db
    .insert(quotes)
    .values({ status: "draft", source: "app", senderJson: "{}", vatIncluded: true, createdAt: at(day), updatedAt: at(day) })
    .returning({ id: quotes.id });
  await db.insert(quoteVersions).values(
    versions.map((v, i) => ({
      quoteId: q.id,
      version: i + 1,
      status: v.status,
      inputText: "견적",
      generationStartedAt: at(day),
      eventJson: v.status === "ready" ? JSON.stringify(event(v.eventType ?? "돌잔치", v.headcount ?? 40)) : null,
      linesJson: v.status === "ready" ? JSON.stringify(v.lines ?? [line(40, 10000)]) : null,
      createdAt: at(day),
    })),
  );
  return q.id;
}

let sourceId: number;

beforeEach(async () => {
  await db.delete(quotes);
  await db.delete(watchSources);
  const [s] = await db
    .insert(watchSources)
    .values({ name: "예시 업체", kind: "page", url: "https://example.com/a", createdAt: at(1) })
    .returning({ id: watchSources.id });
  sourceId = s.id;
});

describe("selectCandidates", () => {
  it("returns [] when there is nothing to compare", async () => {
    expect(await selectCandidates(db, { eventType: "학원 다과", headcount: 40 }, null)).toEqual([]);
  });

  it("orders own quotes, then latest package prices, then events, at most 10 each", async () => {
    // 12 own quotes; the newest ones are 돌잔치, two older ones are 학원 events.
    const academy1 = await ownQuote(1, [{ status: "ready", eventType: "학원 다과", headcount: 40, lines: [line(40, 9000)] }]);
    const academy2 = await ownQuote(2, [{ status: "ready", eventType: "보습학원 간식", headcount: 30 }]);
    for (let d = 3; d <= 12; d++) await ownQuote(d, [{ status: "ready" }]);
    const excluded = await ownQuote(20, [{ status: "ready", eventType: "학원 다과" }]);
    const generatingOnly = await ownQuote(21, [{ status: "generating" }]);
    // Latest ready version counts, not a newer generating one.
    const revising = await ownQuote(22, [
      { status: "ready", eventType: "학원 다과", headcount: 20, lines: [line(20, 5000), line(1, null)] },
      { status: "generating" },
    ]);

    // 12 packages, plus an older row of package 0 that a newer one replaced.
    const [old] = await db
      .insert(competitorPrices)
      .values({ sourceId, sourceUrl: "https://example.com/a", packageName: "패키지 0", perPerson: 1000, seenAt: at(1) })
      .returning({ id: competitorPrices.id });
    const packages = await db
      .insert(competitorPrices)
      .values(
        Array.from({ length: 12 }, (_, i) => ({
          sourceId,
          sourceUrl: "https://example.com/a",
          packageName: i === 11 ? "학원 다과 패키지" : `패키지 ${i}`,
          perPerson: 10000 + i,
          seenAt: at(2 + i),
        })),
      )
      .returning({ id: competitorPrices.id, packageName: competitorPrices.packageName });

    const events = await db
      .insert(competitorEvents)
      .values(
        Array.from({ length: 12 }, (_, i) => ({
          sourceId,
          sourceUrl: `https://example.com/post/${i}`,
          date: `2026-10-${String(i + 1).padStart(2, "0")}`,
          eventType: i === 0 ? "학원 행사" : "기업 워크숍",
          headcount: 50,
          price: 500_000,
          seenAt: at(2 + i),
        })),
      )
      .returning({ id: competitorEvents.id });

    const rows = await selectCandidates(db, { eventType: "학원 다과", headcount: 40 }, excluded);
    const kinds = rows.map((r) => r.kind);
    expect(kinds).toEqual([...Array(10).fill("own"), ...Array(10).fill("price"), ...Array(10).fill("event")]);
    for (const r of rows) expect(r.id).toMatch({ own: /^q\d+$/, price: /^p\d+$/, event: /^e\d+$/ }[r.kind]);

    const ids = rows.map((r) => r.id);
    expect(ids).not.toContain(`q${excluded}`);
    expect(ids).not.toContain(`q${generatingOnly}`);
    expect(ids).not.toContain(`p${old.id}`);

    // Keyword matches first (more matched words first, then closest headcount), then the rest.
    expect(ids.slice(0, 3)).toEqual([`q${academy1}`, `q${revising}`, `q${academy2}`]);
    const own = rows.filter((r) => r.kind === "own");
    expect(own.find((r) => r.id === `q${academy1}`)).toMatchObject({ perPerson: 9000, sourceUrl: null });
    // A quote with an unpriced line has no honest per-person price.
    expect(own.find((r) => r.id === `q${revising}`)!.perPerson).toBeNull();

    const prices = rows.filter((r) => r.kind === "price");
    expect(prices[0].id).toBe(`p${packages[11].id}`);
    expect(prices[0]).toMatchObject({ perPerson: 10011, sourceUrl: "https://example.com/a", seenAt: at(13) });
    expect(prices[0].label).toContain("학원 다과 패키지");

    const evs = rows.filter((r) => r.kind === "event");
    expect(evs[0].id).toBe(`e${events[0].id}`);
    // price is the event total: 500,000 / 50.
    expect(evs[0]).toMatchObject({ perPerson: 10000, sourceUrl: "https://example.com/post/0" });
  });

  it("without an event type, newest come first", async () => {
    const older = await ownQuote(1, [{ status: "ready" }]);
    const newer = await ownQuote(2, [{ status: "ready" }]);
    const rows = await selectCandidates(db, { eventType: "", headcount: null }, null);
    expect(rows.map((r) => r.id)).toEqual([`q${newer}`, `q${older}`]);
  });
});
