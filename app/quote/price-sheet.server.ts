import { asc, eq, max } from "drizzle-orm";
import { priceItems } from "../../database/schema";
import type { Db } from "../server/db";
import { DomainError } from "../server/errors";
import type { PriceItem } from "./lines";
import { PRICE_KINDS, type PriceKind } from "./types";

export type PriceItemInput = {
  id?: number;
  kind: PriceKind;
  name: string;
  content: string;
  unit: string;
  unitPrice: number | null;
  minimumQty: number | null;
  menu: string;
  note: string;
  needsConfirm: boolean;
  enabled: boolean;
  sort: number;
};

const MAX_WON = 100_000_000;

/** Form text to whole won: "7,700" and "7700" both work, empty means no price yet. */
export function parseWon(raw: string): number | null {
  const text = raw.replace(/[,\s]/g, "");
  if (text === "") return null;
  if (!/^\d+$/.test(text)) throw new DomainError("INVALID_INPUT", "금액은 숫자로 적어 주세요.");
  const n = Number(text);
  if (n > MAX_WON) throw new DomainError("INVALID_INPUT", "금액이 너무 커요.");
  return n;
}

export async function listPriceItems(db: Db, opts: { enabledOnly?: boolean } = {}): Promise<PriceItem[]> {
  const query = db.select().from(priceItems);
  const rows = opts.enabledOnly ? query.where(eq(priceItems.enabled, true)) : query;
  return rows.orderBy(asc(priceItems.sort), asc(priceItems.id));
}

/** Sort value that puts a new item after every existing one. */
export async function nextPriceSort(db: Db): Promise<number> {
  const [row] = await db.select({ top: max(priceItems.sort) }).from(priceItems);
  return row?.top == null ? 0 : row.top + 1;
}

/** Saving is the owner confirming the price, so `needsConfirm` is always cleared. */
export async function savePriceItem(db: Db, input: PriceItemInput, now: Date): Promise<number> {
  const name = input.name.trim();
  if (name === "") throw new DomainError("INVALID_INPUT", "이름을 적어 주세요.");
  if (!(PRICE_KINDS as readonly string[]).includes(input.kind)) {
    throw new DomainError("INVALID_INPUT", "종류가 올바르지 않아요.");
  }
  const { unitPrice, minimumQty } = input;
  if (unitPrice !== null && (!Number.isInteger(unitPrice) || unitPrice < 0 || unitPrice > MAX_WON)) {
    throw new DomainError("INVALID_INPUT", "단가가 올바르지 않아요.");
  }
  if (minimumQty !== null && (!Number.isInteger(minimumQty) || minimumQty < 1)) {
    throw new DomainError("INVALID_INPUT", "최소 수량은 1 이상이어야 해요.");
  }
  if (!Number.isInteger(input.sort)) throw new DomainError("INVALID_INPUT", "순서는 숫자로 적어 주세요.");

  const values = {
    kind: input.kind,
    name,
    content: input.content.trim(),
    unit: input.unit.trim(),
    unitPrice,
    minimumQty,
    menu: input.menu.trim(),
    note: input.note.trim(),
    needsConfirm: false,
    enabled: input.enabled,
    sort: input.sort,
  };

  if (input.id === undefined) {
    const [row] = await db
      .insert(priceItems)
      .values({ ...values, createdAt: now.toISOString() })
      .returning({ id: priceItems.id });
    if (!row) throw new Error("price item insert returned no row");
    return row.id;
  }
  const updated = await db
    .update(priceItems)
    .set(values)
    .where(eq(priceItems.id, input.id))
    .returning({ id: priceItems.id });
  if (updated.length === 0) throw new DomainError("NOT_FOUND", "가격 항목을 찾을 수 없어요.");
  return input.id;
}

/** Past quotes copied their unit prices, so deleting an item never changes them. */
export async function deletePriceItem(db: Db, id: number): Promise<void> {
  await db.delete(priceItems).where(eq(priceItems.id, id));
}
