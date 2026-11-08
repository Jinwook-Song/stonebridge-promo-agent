import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { examples } from "../database/schema";
import {
  addExample,
  listExamples,
  pickExamples,
  setExampleEnabled,
  setExampleKind,
} from "../app/promo/examples.server";
import { getDb } from "../app/server/db";
import { DomainError } from "../app/server/errors";

const db = getDb(env.DB);
const at = (day: number) => new Date(Date.UTC(2026, 10, day));

let oldCaseId: number;
let newCaseId: number;
let productId: number;
let finalProductId: number;
let disabledCaseId: number;

beforeEach(async () => {
  await db.delete(examples);
  const base = { channel: "blog", body: "본문" } as const;
  oldCaseId = await addExample(db, { ...base, kind: "case", title: "old case", source: "blog_import" }, at(1));
  newCaseId = await addExample(db, { ...base, kind: "case", title: "new case", source: "blog_import" }, at(3));
  productId = await addExample(db, { ...base, kind: "product", title: "newest product", source: "blog_import" }, at(5));
  finalProductId = await addExample(db, { ...base, kind: "product", title: "final product", source: "owner_final" }, at(2));
  disabledCaseId = await addExample(db, { ...base, kind: "case", title: "off case", source: "blog_import" }, at(4));
  await setExampleEnabled(db, disabledCaseId, false);
});

describe("pickExamples", () => {
  it("owner_final first, then same kind, newest, enabled only", async () => {
    const got = await pickExamples(db, "blog", "case", 3);
    expect(got.map((e) => [e.source, e.kind])).toEqual([
      ["owner_final", "product"],
      ["blog_import", "case"],
      ["blog_import", "case"],
    ]);
    expect(got.map((e) => e.id)).toEqual([finalProductId, newCaseId, oldCaseId]);
  });

  it("falls back to other kinds after same-kind ones run out", async () => {
    const got = await pickExamples(db, "blog", "case", 10);
    expect(got.map((e) => e.id)).toEqual([finalProductId, newCaseId, oldCaseId, productId]);
    expect(got.map((e) => e.id)).not.toContain(disabledCaseId);
  });

  it("respects the limit", async () => {
    expect(await pickExamples(db, "blog", "case", 1)).toHaveLength(1);
    expect(await pickExamples(db, "blog", "case", 0)).toEqual([]);
  });

  it("returns [] for a channel with no examples", async () => {
    expect(await pickExamples(db, "place", "case", 2)).toEqual([]);
  });

  it("returns the Example shape without storage-only fields", async () => {
    const [first] = await pickExamples(db, "blog", "product", 1);
    expect(first).toEqual({
      id: finalProductId,
      channel: "blog",
      kind: "product",
      title: "final product",
      body: "본문",
      source: "owner_final",
    });
  });
});

describe("example admin", () => {
  it("addExample stores sourceUrl and allows a null title", async () => {
    const id = await addExample(
      db,
      { channel: "daangn", kind: "other", title: null, body: "x", source: "blog_import", sourceUrl: "https://example.com/p/1" },
      at(6),
    );
    const row = (await listExamples(db)).find((e) => e.id === id);
    expect(row).toMatchObject({ channel: "daangn", title: null, enabled: true });
  });

  it("listExamples includes disabled ones, newest first", async () => {
    const all = await listExamples(db);
    expect(all.map((e) => e.id)).toEqual([productId, disabledCaseId, newCaseId, finalProductId, oldCaseId]);
    expect(all.find((e) => e.id === disabledCaseId)?.enabled).toBe(false);
  });

  it("setExampleEnabled toggles back on", async () => {
    await setExampleEnabled(db, disabledCaseId, true);
    expect((await pickExamples(db, "blog", "case", 10)).map((e) => e.id)).toContain(disabledCaseId);
  });

  it("setExampleKind changes the kind", async () => {
    await setExampleKind(db, oldCaseId, "other");
    expect((await listExamples(db)).find((e) => e.id === oldCaseId)?.kind).toBe("other");
  });

  it("unknown ids raise NOT_FOUND", async () => {
    for (const p of [setExampleEnabled(db, 99999, true), setExampleKind(db, 99999, "case")]) {
      const err = await p.then(() => null, (e) => e);
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe("NOT_FOUND");
    }
  });
});
