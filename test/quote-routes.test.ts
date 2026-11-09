import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { quotes, quoteVersions } from "../database/schema";
import { action as detailAction } from "../app/routes/quote-detail";
import { action as newAction } from "../app/routes/quote-new";
import { loader as layoutLoader, middleware } from "../app/routes/owner-layout";
import { createQuote, listQuotes } from "../app/quote/quotes.server";
import { getDb } from "../app/server/db";

const db = getDb(env.DB);
const now = new Date("2026-11-09T03:00:00Z");

beforeEach(async () => {
  await db.delete(quoteVersions);
  await db.delete(quotes);
});

function post(url: string, fields: Record<string, string>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return new Request(`http://localhost${url}`, { method: "POST", body: form });
}

async function runDetail(id: number, fields: Record<string, string>) {
  const res = await detailAction({ request: post(`/quotes/${id}`, fields), params: { id: String(id) }, context: {} } as never);
  // data() results carry the status; plain objects are 200.
  return res as { type?: string; data?: { error?: string; ok?: boolean }; init?: { status?: number } } & Record<string, unknown>;
}

const goodLine = {
  itemId: null,
  label: "다과",
  content: "",
  qty: 10,
  unitPrice: 5000,
  priceSource: "hand",
  svc: false,
  menu: "",
  note: "",
};

describe("quote-new action", () => {
  it("shows an error for empty text and creates no quote", async () => {
    const res = (await newAction({ request: post("/quotes/new", { text: "  \n " }), params: {}, context: {} } as never)) as {
      error?: string;
    };
    expect(res.error).toMatch(/문의 내용/);
    expect(await db.select().from(quotes)).toEqual([]);
  });
});

describe("quote-detail action", () => {
  it("rejects invalid lines with a 400 message and saves nothing", async () => {
    const { quoteId } = await createQuote(db, { text: "행사 문의", source: "app" }, now);
    await db.update(quoteVersions).set({ status: "ready" }).where(eq(quoteVersions.quoteId, quoteId));

    const bad = await runDetail(quoteId, {
      intent: "saveLines",
      version: "1",
      lines: JSON.stringify([{ ...goodLine, qty: -1 }]),
    });
    expect(bad.init?.status).toBe(400);
    expect(bad.data?.error).toMatch(/줄/);

    const malformed = await runDetail(quoteId, { intent: "saveLines", version: "1", lines: "{not json" });
    expect(malformed.init?.status).toBe(400);

    const [row] = await db.select().from(quoteVersions).where(eq(quoteVersions.quoteId, quoteId));
    expect(row.linesJson).toBeNull();
  });

  it("saves good lines on the latest ready version", async () => {
    const { quoteId } = await createQuote(db, { text: "행사 문의", source: "app" }, now);
    await db.update(quoteVersions).set({ status: "ready" }).where(eq(quoteVersions.quoteId, quoteId));
    const res = await runDetail(quoteId, { intent: "saveLines", version: "1", lines: JSON.stringify([goodLine]) });
    expect(res.ok).toBe(true);
    const [row] = await db.select().from(quoteVersions).where(eq(quoteVersions.quoteId, quoteId));
    expect(JSON.parse(row.linesJson!)).toEqual([goodLine]);
  });

  it("rejects a headcount that is not a number", async () => {
    const { quoteId } = await createQuote(db, { text: "행사 문의", source: "app" }, now);
    await db.update(quoteVersions).set({ status: "ready" }).where(eq(quoteVersions.quoteId, quoteId));
    const res = await runDetail(quoteId, {
      intent: "saveEvent",
      version: "1",
      event: JSON.stringify({ headcount: "많이" }),
    });
    expect(res.init?.status).toBe(400);
  });

  it("setStatus won shows in the list", async () => {
    const { quoteId } = await createQuote(db, { text: "행사 문의", source: "app" }, now);
    const res = await runDetail(quoteId, { intent: "setStatus", status: "won" });
    expect(res.ok).toBe(true);
    const list = await listQuotes(db);
    expect(list.find((q) => q.id === quoteId)?.status).toBe("won");
  });

  it("an unknown status is a 400", async () => {
    const { quoteId } = await createQuote(db, { text: "행사 문의", source: "app" }, now);
    const res = await runDetail(quoteId, { intent: "setStatus", status: "maybe" });
    expect(res.init?.status).toBe(400);
  });

  it("retry on a version that is not failed or stale returns an error message", async () => {
    const { quoteId } = await createQuote(db, { text: "행사 문의", source: "app" }, new Date());
    const res = await runDetail(quoteId, { intent: "retry" });
    expect(res.error).toMatch(/만드는 중/);
  });

  it("deleteQuote removes the quote and goes back to the list", async () => {
    const { quoteId } = await createQuote(db, { text: "행사 문의", source: "app" }, now);
    const res = (await detailAction({
      request: post(`/quotes/${quoteId}`, { intent: "deleteQuote" }),
      params: { id: String(quoteId) },
      context: {},
    } as never)) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/quotes");
    expect(await db.select().from(quotes)).toEqual([]);
  });

  it("an unknown intent is a 400", async () => {
    const { quoteId } = await createQuote(db, { text: "행사 문의", source: "app" }, now);
    const res = await runDetail(quoteId, { intent: "nope" });
    expect(res.init?.status).toBe(400);
  });
});

describe("login guard", () => {
  it("sends a visitor without a session from /quotes to the login page", async () => {
    const request = new Request("http://localhost/quotes");
    for (const run of [
      () => middleware[0]({ request, params: {}, context: {} } as never, async () => new Response("x")),
      () => layoutLoader({ request, params: {}, context: {} } as never),
    ]) {
      const thrown = await Promise.resolve()
        .then(run)
        .then(
          () => null,
          (e) => e,
        );
      expect(thrown).toBeInstanceOf(Response);
      expect((thrown as Response).status).toBe(302);
      expect((thrown as Response).headers.get("Location")).toBe("/login");
    }
  });
});
