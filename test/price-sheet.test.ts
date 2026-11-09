import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { priceItems } from "../database/schema";
import {
  deletePriceItem,
  listPriceItems,
  nextPriceSort,
  parseWon,
  savePriceItem,
  type PriceItemInput,
} from "../app/quote/price-sheet.server";
import { getDb } from "../app/server/db";
import { DomainError } from "../app/server/errors";

const db = getDb(env.DB);
const NOW = new Date("2026-11-09T01:00:00.000Z");

function input(over: Partial<PriceItemInput> = {}): PriceItemInput {
  return {
    kind: "per_person",
    name: "다과 4종",
    content: "",
    unit: "인",
    unitPrice: 7700,
    minimumQty: null,
    menu: "",
    note: "",
    needsConfirm: false,
    enabled: true,
    sort: 0,
    ...over,
  };
}

beforeEach(async () => {
  await db.delete(priceItems);
});

describe("savePriceItem", () => {
  it("inserts a new item and edits it by id", async () => {
    const id = await savePriceItem(db, input(), NOW);
    expect((await listPriceItems(db)).map((i) => i.name)).toEqual(["다과 4종"]);

    const same = await savePriceItem(db, input({ id, unitPrice: 9000 }), NOW);
    expect(same).toBe(id);
    const rows = await listPriceItems(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.unitPrice).toBe(9000);
    expect(rows[0]?.createdAt).toBe(NOW.toISOString());
  });

  it("keeps createdAt when editing", async () => {
    const id = await savePriceItem(db, input(), NOW);
    await savePriceItem(db, input({ id, note: "x" }), new Date("2027-01-01T00:00:00.000Z"));
    expect((await listPriceItems(db))[0]?.createdAt).toBe(NOW.toISOString());
  });

  it("clears needsConfirm whatever the form sent", async () => {
    const [seed] = await db
      .insert(priceItems)
      .values({ kind: "per_person", name: "시드", unit: "인", unitPrice: 1000, needsConfirm: true, createdAt: NOW.toISOString() })
      .returning();
    expect(seed?.needsConfirm).toBe(true);
    await savePriceItem(db, input({ id: seed?.id, name: "시드", needsConfirm: true }), NOW);
    expect((await listPriceItems(db))[0]?.needsConfirm).toBe(false);

    const id = await savePriceItem(db, input({ name: "새 항목", needsConfirm: true }), NOW);
    const row = (await listPriceItems(db)).find((i) => i.id === id);
    expect(row?.needsConfirm).toBe(false);
  });

  it("rejects an empty name", async () => {
    for (const name of ["", "   "]) {
      await expect(savePriceItem(db, input({ name }), NOW)).rejects.toMatchObject({
        name: "DomainError",
        code: "INVALID_INPUT",
      });
    }
    expect(await listPriceItems(db)).toHaveLength(0);
  });

  it("rejects bad numbers and unknown ids", async () => {
    await expect(savePriceItem(db, input({ unitPrice: -1 }), NOW)).rejects.toBeInstanceOf(DomainError);
    await expect(savePriceItem(db, input({ unitPrice: 1.5 }), NOW)).rejects.toBeInstanceOf(DomainError);
    await expect(savePriceItem(db, input({ minimumQty: 0 }), NOW)).rejects.toBeInstanceOf(DomainError);
    await expect(savePriceItem(db, input({ id: 999 }), NOW)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("allows an empty price (unknown)", async () => {
    const id = await savePriceItem(db, input({ unitPrice: null }), NOW);
    expect((await listPriceItems(db)).find((i) => i.id === id)?.unitPrice).toBeNull();
  });
});

describe("listPriceItems", () => {
  it("orders by sort then id and can hide disabled items", async () => {
    await savePriceItem(db, input({ name: "c", sort: 2 }), NOW);
    await savePriceItem(db, input({ name: "a", sort: 1 }), NOW);
    await savePriceItem(db, input({ name: "b", sort: 1, enabled: false }), NOW);
    expect((await listPriceItems(db)).map((i) => i.name)).toEqual(["a", "b", "c"]);
    expect((await listPriceItems(db, { enabledOnly: true })).map((i) => i.name)).toEqual(["a", "c"]);
  });
});

describe("nextPriceSort", () => {
  it("is 0 on an empty sheet, else max + 1", async () => {
    expect(await nextPriceSort(db)).toBe(0);
    await savePriceItem(db, input({ sort: 7 }), NOW);
    expect(await nextPriceSort(db)).toBe(8);
  });
});

describe("deletePriceItem", () => {
  it("removes the item", async () => {
    const id = await savePriceItem(db, input(), NOW);
    await deletePriceItem(db, id);
    expect(await db.select().from(priceItems).where(eq(priceItems.id, id))).toHaveLength(0);
  });
});

describe("parseWon", () => {
  it("accepts digits, commas and spaces; empty is null", () => {
    expect(parseWon("7700")).toBe(7700);
    expect(parseWon(" 7,700 ")).toBe(7700);
    expect(parseWon("1 000 000")).toBe(1000000);
    expect(parseWon("")).toBeNull();
    expect(parseWon("  ")).toBeNull();
    expect(parseWon("0")).toBe(0);
  });

  it("rejects anything else with INVALID_INPUT", () => {
    for (const bad of ["abc", "7700원", "-5", "1.5", "1e3"]) {
      expect(() => parseWon(bad)).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    }
  });
});
