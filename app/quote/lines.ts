// Pure quote math: no DB, no Date, so it also runs in the browser for live totals.
import type { priceItems } from "../../database/schema";
import type { QuoteLine } from "./types";

export type PriceItem = typeof priceItems.$inferSelect;

/** A line as the model proposes it. Prices never come from the model. */
export type ModelLine = {
  itemId: number | null;
  label: string;
  content: string;
  qty: number;
  menu: string;
  note: string;
  /** Index into the previous version's lines this line continues, or null for a new line. */
  prevIndex: number | null;
};

export type Totals = { supply: number; vat: number; total: number; missingPrices: number };

/** "SVC" = free of charge, null = no unit price known, otherwise whole won. */
export function lineAmount(line: QuoteLine): number | "SVC" | null {
  if (line.svc) return "SVC";
  if (line.unitPrice === null) return null;
  return line.qty * line.unitPrice;
}

export function computeTotals(lines: QuoteLine[], vatIncluded: boolean): Totals {
  let supply = 0;
  let missingPrices = 0;
  for (const line of lines) {
    const amount = lineAmount(line);
    if (amount === "SVC") continue;
    if (amount === null) {
      missingPrices += 1;
      continue;
    }
    supply += amount;
  }
  const vat = vatIncluded ? Math.round(supply * 0.1) : 0;
  return { supply, vat, total: supply + vat, missingPrices };
}

function cleanQty(qty: number): number {
  if (!Number.isFinite(qty)) return 0;
  return Math.max(0, Math.round(qty));
}

/**
 * Turns the model's proposed lines into priced quote lines.
 * 1. A valid reference to a not-yet-claimed previous line with the same itemId, or with no itemId,
 *    keeps that line's itemId, price, price source and SVC flag (hand-set values survive revisions).
 * 2. Otherwise an enabled sheet item with a price gets the sheet price.
 * 3. Otherwise the line is a hand line with no price, for the owner to fill in.
 */
export function buildLines(
  model: ModelLine[],
  sheet: PriceItem[],
  prev: QuoteLine[] | null,
): QuoteLine[] {
  const byId = new Map(sheet.map((item) => [item.id, item]));
  const claimed = new Set<number>();

  return model.map((m) => {
    const base = {
      label: m.label,
      content: m.content,
      qty: cleanQty(m.qty),
      menu: m.menu,
      note: m.note,
    };

    const index = m.prevIndex;
    if (prev && index !== null && Number.isInteger(index) && index >= 0 && index < prev.length) {
      const before = prev[index];
      // A previous line without an itemId (imported, or typed in by hand) carries its price even
      // when the model now matches it to a sheet item: the agreed price wins over the sheet.
      if (!claimed.has(index) && (before.itemId === null || before.itemId === m.itemId)) {
        claimed.add(index);
        return {
          ...base,
          itemId: before.itemId,
          unitPrice: before.unitPrice,
          priceSource: before.priceSource,
          svc: before.svc,
        };
      }
    }

    const found = m.itemId === null ? undefined : byId.get(m.itemId);
    if (found && found.enabled) {
      return {
        ...base,
        itemId: found.id,
        unitPrice: found.unitPrice,
        // A sheet item without a price is no better than a typed-in line: the owner fills it in.
        priceSource: found.unitPrice === null ? "hand" : "sheet",
        svc: false,
      };
    }

    return { ...base, itemId: null, unitPrice: null, priceSource: "hand", svc: false };
  });
}

const won = (n: number | null) => (n === null ? "없음" : n.toLocaleString("ko-KR"));

/** Lines are matched by itemId (label when there is none); repeats pair up in order. */
export function diffLines(prev: QuoteLine[], next: QuoteLine[]): string[] {
  const keyed = (lines: QuoteLine[]) => {
    const seen = new Map<string, number>();
    return lines.map((line) => {
      const base = line.itemId !== null ? `i${line.itemId}` : `l${line.label}`;
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      return { key: `${base}#${n}`, line };
    });
  };
  const before = new Map(keyed(prev).map((e) => [e.key, e.line]));
  const out: string[] = [];
  const matched = new Set<string>();

  for (const { key, line } of keyed(next)) {
    const old = before.get(key);
    if (!old) {
      out.push(`추가: ${line.label}`);
      continue;
    }
    matched.add(key);
    if (old.qty !== line.qty) {
      out.push(`수량 ${old.qty.toLocaleString("ko-KR")}→${line.qty.toLocaleString("ko-KR")}: ${line.label}`);
    }
    if (old.unitPrice !== line.unitPrice) {
      out.push(`단가 ${won(old.unitPrice)}→${won(line.unitPrice)}원: ${line.label}`);
    }
    if (old.svc !== line.svc) out.push(`${line.svc ? "SVC 켬" : "SVC 끔"}: ${line.label}`);
  }
  for (const [key, line] of before) {
    if (!matched.has(key)) out.push(`삭제: ${line.label}`);
  }
  return out;
}
