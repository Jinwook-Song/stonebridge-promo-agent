import { describe, expect, it } from "vitest";
import {
  buildLines,
  computeTotals,
  diffLines,
  lineAmount,
  type ModelLine,
  type PriceItem,
} from "../app/quote/lines";
import type { QuoteLine } from "../app/quote/types";

function item(over: Partial<PriceItem> & { id: number; name: string }): PriceItem {
  return {
    kind: "per_person",
    content: "",
    unit: "인",
    unitPrice: 0,
    minimumQty: null,
    menu: "",
    note: "",
    needsConfirm: false,
    enabled: true,
    sort: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

const sheet: PriceItem[] = [
  item({ id: 1, name: "다과 4종", unitPrice: 8500 }),
  item({ id: 2, name: "출장료", kind: "per_event", unit: "회", unitPrice: 100000 }),
  item({ id: 3, name: "꺼진 항목", unitPrice: 5000, enabled: false }),
  item({ id: 4, name: "가격 미정", unitPrice: null }),
];

function line(over: Partial<QuoteLine> = {}): QuoteLine {
  return {
    itemId: 1,
    label: "다과 4종",
    content: "",
    qty: 1,
    unitPrice: 8500,
    priceSource: "sheet",
    svc: false,
    menu: "",
    note: "",
    ...over,
  };
}

function model(over: Partial<ModelLine> = {}): ModelLine {
  return {
    itemId: 1,
    label: "다과 4종",
    content: "",
    qty: 1,
    menu: "",
    note: "",
    prevIndex: null,
    ...over,
  };
}

describe("lineAmount / computeTotals", () => {
  const lines = [line({ qty: 500 }), line({ itemId: 2, label: "출장료", qty: 1, unitPrice: 100000 })];

  it("adds VAT when included", () => {
    expect(computeTotals(lines, true)).toEqual({
      supply: 4350000,
      vat: 435000,
      total: 4785000,
      missingPrices: 0,
    });
  });

  it("has no VAT when excluded", () => {
    const t = computeTotals(lines, false);
    expect(t.vat).toBe(0);
    expect(t.total).toBe(t.supply);
    expect(t.supply).toBe(4350000);
  });

  it("rounds VAT to whole won", () => {
    expect(computeTotals([line({ qty: 1, unitPrice: 105 })], true).vat).toBe(11);
  });

  it("leaves SVC lines out of the supply amount", () => {
    const svc = line({ itemId: 5, label: "서비스", qty: 10, svc: true });
    expect(lineAmount(svc)).toBe("SVC");
    expect(computeTotals([...lines, svc], true).supply).toBe(4350000);
  });

  it("leaves lines without a price out and counts them", () => {
    const missing = line({ itemId: null, label: "특별 요청", qty: 3, unitPrice: null, priceSource: "hand" });
    expect(lineAmount(missing)).toBeNull();
    const t = computeTotals([...lines, missing], true);
    expect(t.supply).toBe(4350000);
    expect(t.missingPrices).toBe(1);
  });

  it("does not count an SVC line without a price as missing", () => {
    const svc = line({ unitPrice: null, svc: true });
    expect(computeTotals([svc], true).missingPrices).toBe(0);
  });

  it("a 0 won price is a real price, not missing", () => {
    const t = computeTotals([line({ unitPrice: 0 })], true);
    expect(t.missingPrices).toBe(0);
    expect(lineAmount(line({ unitPrice: 0 }))).toBe(0);
  });
});

describe("buildLines without a previous version", () => {
  it("prices sheet items, and marks unknown or disabled ones as hand with no price", () => {
    const out = buildLines(
      [
        model({ itemId: 1, qty: 500 }),
        model({ itemId: 99, label: "없는 항목" }),
        model({ itemId: 3, label: "꺼진 항목" }),
      ],
      sheet,
      null,
    );
    expect(out[0]).toMatchObject({ itemId: 1, unitPrice: 8500, priceSource: "sheet", svc: false, qty: 500 });
    expect(out[1]).toMatchObject({ itemId: null, unitPrice: null, priceSource: "hand", svc: false });
    expect(out[2]).toMatchObject({ itemId: null, unitPrice: null, priceSource: "hand", svc: false });
  });

  it("uses the model's wording, not the sheet's", () => {
    const [l] = buildLines(
      [model({ label: "다과 (오후)", content: "쿠키 외", menu: "m", note: "n" })],
      sheet,
      null,
    );
    expect(l).toMatchObject({ label: "다과 (오후)", content: "쿠키 외", menu: "m", note: "n" });
  });

  it("keeps the item but has no price when the sheet item has none", () => {
    const [l] = buildLines([model({ itemId: 4, label: "가격 미정" })], sheet, null);
    expect(l).toMatchObject({ itemId: 4, unitPrice: null });
    expect(computeTotals([l], true).missingPrices).toBe(1);
  });

  it("ignores a prevIndex when there is no previous version", () => {
    const [l] = buildLines([model({ prevIndex: 0 })], sheet, null);
    expect(l).toMatchObject({ unitPrice: 8500, priceSource: "sheet" });
  });
});

describe("buildLines carry-over from a previous version", () => {
  const prev = [
    line({ unitPrice: 9000, priceSource: "hand", qty: 300 }),
    line({ itemId: 2, label: "출장료", unitPrice: 100000, svc: true }),
  ];

  it("keeps a hand-set price and takes the new qty", () => {
    const [l] = buildLines([model({ qty: 350, prevIndex: 0 })], sheet, prev);
    expect(l).toMatchObject({ unitPrice: 9000, priceSource: "hand", qty: 350, svc: false });
  });

  it("keeps SVC", () => {
    const [l] = buildLines([model({ itemId: 2, label: "출장료", prevIndex: 1 })], sheet, prev);
    expect(l).toMatchObject({ svc: true, unitPrice: 100000 });
    expect(lineAmount(l)).toBe("SVC");
  });

  it("keeps an imported price and a null hand price", () => {
    const p = [
      line({ itemId: null, label: "수입", unitPrice: 7000, priceSource: "imported" }),
      line({ itemId: null, label: "미정", unitPrice: null, priceSource: "hand" }),
    ];
    const out = buildLines(
      [
        model({ itemId: null, label: "수입", prevIndex: 0 }),
        model({ itemId: null, label: "미정", prevIndex: 1 }),
      ],
      sheet,
      p,
    );
    expect(out[0]).toMatchObject({ unitPrice: 7000, priceSource: "imported" });
    expect(out[1]).toMatchObject({ unitPrice: null, priceSource: "hand" });
  });

  it("only lets the first line claim a previous line", () => {
    const out = buildLines([model({ qty: 350, prevIndex: 0 }), model({ qty: 20, prevIndex: 0 })], sheet, prev);
    expect(out[0]).toMatchObject({ unitPrice: 9000, priceSource: "hand" });
    expect(out[1]).toMatchObject({ unitPrice: 8500, priceSource: "sheet", svc: false, qty: 20 });
  });

  it("treats an out-of-range prevIndex as a new line", () => {
    const [l] = buildLines([model({ prevIndex: 7 })], sheet, prev);
    expect(l).toMatchObject({ unitPrice: 8500, priceSource: "sheet" });
    const [neg] = buildLines([model({ prevIndex: -1 })], sheet, prev);
    expect(neg).toMatchObject({ unitPrice: 8500, priceSource: "sheet" });
    const [frac] = buildLines([model({ prevIndex: 0.5 })], sheet, prev);
    expect(frac).toMatchObject({ unitPrice: 8500, priceSource: "sheet" });
  });

  it("treats a prevIndex whose itemId changed as a new line", () => {
    const [l] = buildLines([model({ itemId: 2, label: "출장료", prevIndex: 0 })], sheet, prev);
    expect(l).toMatchObject({ itemId: 2, unitPrice: 100000, priceSource: "sheet", svc: false });
  });

  it("a rejected reference does not use up the previous line", () => {
    const out = buildLines(
      [model({ itemId: 2, label: "출장료", prevIndex: 0 }), model({ prevIndex: 0 })],
      sheet,
      prev,
    );
    expect(out[1]).toMatchObject({ unitPrice: 9000, priceSource: "hand" });
  });
});

describe("buildLines qty", () => {
  it("clamps negatives to 0 and rounds fractions", () => {
    const out = buildLines(
      [model({ qty: -3 }), model({ qty: 2.6 }), model({ qty: Number.NaN }), model({ qty: 4 })],
      sheet,
      null,
    );
    expect(out.map((l) => l.qty)).toEqual([0, 3, 0, 4]);
  });
});

describe("diffLines", () => {
  it("reports an added line", () => {
    expect(diffLines([], [line()])).toEqual(["추가: 다과 4종"]);
  });

  it("reports a removed line", () => {
    expect(diffLines([line()], [])).toEqual(["삭제: 다과 4종"]);
  });

  it("reports a qty change", () => {
    expect(diffLines([line({ qty: 300 })], [line({ qty: 350 })])).toEqual(["수량 300→350: 다과 4종"]);
  });

  it("reports a price change with thousands separators", () => {
    expect(diffLines([line()], [line({ unitPrice: 9000 })])).toEqual(["단가 8,500→9,000원: 다과 4종"]);
  });

  it("reports SVC on and off", () => {
    expect(diffLines([line()], [line({ svc: true })])).toEqual(["SVC 켬: 다과 4종"]);
    expect(diffLines([line({ svc: true })], [line()])).toEqual(["SVC 끔: 다과 4종"]);
  });

  it("is empty when nothing changed", () => {
    expect(diffLines([line()], [line()])).toEqual([]);
  });

  it("matches lines without an itemId by label", () => {
    const a = line({ itemId: null, label: "특별 요청", unitPrice: null, priceSource: "hand" });
    expect(diffLines([a], [{ ...a, qty: 2 }])).toEqual(["수량 1→2: 특별 요청"]);
  });

  it("matches repeated items in order", () => {
    const a = line({ qty: 1 });
    const b = line({ qty: 2 });
    expect(diffLines([a, b], [a, b])).toEqual([]);
  });
});
