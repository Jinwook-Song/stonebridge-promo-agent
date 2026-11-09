import { env } from "cloudflare:workers";
import ExcelJS from "exceljs";
import { beforeEach, describe, expect, it } from "vitest";
import { quotes, quoteVersions } from "../database/schema";
import { loader as xlsxLoader } from "../app/routes/quote-xlsx";
import { buildQuoteXlsx, xlsxFileName, xlsxToText } from "../app/quote/excel.server";
import { computeTotals } from "../app/quote/lines";
import { createQuote } from "../app/quote/quotes.server";
import type { QuoteEvent, QuoteLine, Sender } from "../app/quote/types";
import { getDb } from "../app/server/db";
import { eq } from "drizzle-orm";

const event: QuoteEvent = {
  customerName: "가나다 학원",
  contactName: "김담당",
  contact: "010-0000-0000",
  email: "a@example.com",
  eventDate: "2026-12-01",
  headcount: 40,
  venue: "서울 어딘가",
  eventType: "송년회",
  budget: "",
  requests: "알레르기 확인",
  missing: [],
};

const sender: Sender = {
  company: "가짜상사",
  person: "홍길동",
  phone: "02-000-0000",
  email: "s@example.com",
  payment: "가짜은행 000-00-000000",
  onsite: "도착 30분 전 연락",
  bizNo: "000-00-00000",
};

function line(over: Partial<QuoteLine>): QuoteLine {
  return {
    itemId: null,
    label: "항목",
    content: "",
    qty: 1,
    unitPrice: 1000,
    priceSource: "hand",
    svc: false,
    menu: "",
    note: "",
    ...over,
  };
}

const lines: QuoteLine[] = [
  line({ label: "다과", content: "샌드위치 외", qty: 40, unitPrice: 12500, menu: "A세트", note: "1인 기준" }),
  line({ label: "음료", qty: 40, unitPrice: 3000, svc: true }),
  line({ label: "특수 장식", qty: 1, unitPrice: null }),
];

const base = { event, lines, sender, vatIncluded: true, intro: "안녕하세요.\n견적을 드려요.", fixedLines: "일회용품 제공\n세팅 및 철거", createdAt: "2026-11-09T03:00:00.000Z" };

async function read(bytes: Uint8Array) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes as never);
  return wb.worksheets[0];
}

/** The row of the first cell whose text is `text`. */
function find(ws: ExcelJS.Worksheet, text: string) {
  let found: ExcelJS.Cell | undefined;
  ws.eachRow((row) => row.eachCell((cell) => {
    if (!found && cell.value === text) found = cell;
  }));
  if (!found) throw new Error(`no cell with text ${text}`);
  return { row: Number((found as ExcelJS.Cell).row) };
}

function allText(ws: ExcelJS.Worksheet): string {
  const out: string[] = [];
  ws.eachRow((row) => row.eachCell((cell) => out.push(String(cell.text))));
  return out.join("\n");
}

describe("buildQuoteXlsx", () => {
  it("writes live formulas with cached results, SVC text and a blank amount for a line without a price", async () => {
    const ws = await read(await buildQuoteXlsx(base));
    const normal = find(ws, "다과");
    const svc = find(ws, "음료");
    const none = find(ws, "특수 장식");
    const col = (cell: { row: number }, n: number) => ws.getCell(cell.row, n);

    // 항목 | 내용 | 수량 | 공급 단가 | 공급 금액 | 메뉴 | 비고
    expect(col(normal, 3).value).toBe(40);
    expect(col(normal, 4).value).toBe(12500);
    const amount = col(normal, 5).value as ExcelJS.CellFormulaValue;
    expect(amount.formula).toBe(`C${normal.row}*D${normal.row}`);
    expect(amount.result).toBe(500000);
    expect(col(normal, 6).value).toBe("A세트");
    expect(col(normal, 7).value).toBe("1인 기준");

    expect(col(svc, 5).value).toBe("SVC");
    expect(col(svc, 4).value).toBe(3000);

    expect(col(none, 5).value).toBeNull();
    expect(col(none, 4).text).toBe("단가 없음");
  });

  it("sums the whole amount column and matches computeTotals", async () => {
    const ws = await read(await buildQuoteXlsx(base));
    const totals = computeTotals(lines, true);
    const first = find(ws, "다과").row;
    const last = find(ws, "특수 장식").row;
    const supply = ws.getCell(find(ws, "공급금액").row, 5).value as ExcelJS.CellFormulaValue;
    expect(supply.formula).toBe(`SUM(E${first}:E${last})`);
    expect(supply.result).toBe(totals.supply);
    expect(totals.supply).toBe(500000);
    expect(allText(ws)).toContain("단가 없는 줄 1개");
  });

  it("VAT on: rounds supply * 1.1 and labels the total", async () => {
    const ws = await read(await buildQuoteXlsx(base));
    const label = find(ws, "합계 금액 (VAT 10% 포함)");
    const supplyRow = find(ws, "공급금액").row;
    const total = ws.getCell(label.row, 5).value as ExcelJS.CellFormulaValue;
    expect(total.formula).toBe(`ROUND(E${supplyRow}*1.1,0)`);
    expect(total.result).toBe(computeTotals(lines, true).total);
  });

  it("VAT off: no VAT text anywhere, no total row, supply only", async () => {
    const ws = await read(await buildQuoteXlsx({ ...base, vatIncluded: false, intro: "", fixedLines: "" }));
    expect(allText(ws)).not.toContain("VAT");
    expect(allText(ws)).not.toContain("합계 금액");
    expect(ws.getCell(find(ws, "공급금액").row, 5).value).toMatchObject({ result: 500000 });
  });

  it("omits the business number row when it is empty", async () => {
    const withNo = await read(await buildQuoteXlsx(base));
    expect(allText(withNo)).toContain("000-00-00000");
    const without = await read(await buildQuoteXlsx({ ...base, sender: { ...sender, bizNo: "" } }));
    expect(allText(without)).not.toContain("사업자번호");
  });

  it("puts sender, customer, intro (near the top) and fixed lines (at the bottom) on the sheet", async () => {
    const ws = await read(await buildQuoteXlsx(base));
    const text = allText(ws);
    for (const s of ["가짜상사", "홍길동", "가나다 학원", "김담당", "서울 어딘가", "송년회"]) expect(text).toContain(s);
    const introRow = find(ws, "안녕하세요.\n견적을 드려요.").row;
    const header = find(ws, "항목").row;
    expect(introRow).toBeLessThan(header);
    expect(find(ws, "일회용품 제공").row).toBeGreaterThan(find(ws, "공급금액").row);
    expect(find(ws, "세팅 및 철거").row).toBe(find(ws, "일회용품 제공").row + 1);
  });

  it("handles a quote with no lines", async () => {
    const ws = await read(await buildQuoteXlsx({ ...base, lines: [] }));
    expect(ws.getCell(find(ws, "공급금액").row, 5).value).toBe(0);
  });
});

describe("xlsxFileName", () => {
  it("builds the name from customer, KST date and version", () => {
    expect(xlsxFileName('A/B "학원"', "2026-11-09T03:00:00.000Z", 2)).toBe("스톤테이블_견적서_AB_학원_261109_v2.xlsx");
  });

  it("uses the KST date near midnight UTC", () => {
    expect(xlsxFileName("가", "2026-11-09T16:00:00.000Z", 1)).toBe("스톤테이블_견적서_가_261110_v1.xlsx");
  });

  it("falls back to 고객 when the name is empty after cleaning", () => {
    expect(xlsxFileName("", "2026-11-09T03:00:00.000Z", 2)).toContain("_고객_");
    expect(xlsxFileName('/:*?"<>|\n', "2026-11-09T03:00:00.000Z", 2)).toContain("_고객_");
  });

  it("drops control characters", () => {
    expect(xlsxFileName("가\r\n나\t다", "2026-11-09T03:00:00.000Z", 1)).toBe("스톤테이블_견적서_가나다_261109_v1.xlsx");
  });
});

describe("xlsxToText", () => {
  it("lists the cells row by row, tab separated, with formula results", async () => {
    const text = await xlsxToText(await buildQuoteXlsx(base));
    const row = text.split("\n").find((l) => l.includes("다과"));
    expect(row).toBeDefined();
    expect(row!.split("\t")).toEqual(expect.arrayContaining(["다과", "40", "12500", "500000", "A세트"]));
    const supply = text.split("\n").find((l) => l.includes("공급금액"));
    expect(supply).toContain("500000");
    expect(text).toContain("SVC");
  });

  it("does not repeat merged cells", async () => {
    const text = await xlsxToText(await buildQuoteXlsx(base));
    expect(text.split("일회용품 제공").length).toBe(2);
  });
});

describe("quote-xlsx route", () => {
  const db = getDb(env.DB);
  beforeEach(async () => {
    await db.delete(quoteVersions);
    await db.delete(quotes);
  });

  async function readyQuote() {
    const { quoteId } = await createQuote(db, { text: "문의", source: "app" }, new Date("2026-11-09T03:00:00Z"));
    await db
      .update(quoteVersions)
      .set({ status: "ready", eventJson: JSON.stringify(event), linesJson: JSON.stringify(lines) })
      .where(eq(quoteVersions.quoteId, quoteId));
    return quoteId;
  }

  async function get(id: string, version: string) {
    return xlsxLoader({ request: new Request(`http://localhost/quotes/${id}/v/${version}/xlsx`), params: { id, version }, context: {} } as never);
  }

  it("serves the file with a safe Content-Disposition", async () => {
    const id = await readyQuote();
    const res = (await get(String(id), "1")) as Response;
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    const disposition = res.headers.get("Content-Disposition")!;
    expect(disposition).toBe(
      `attachment; filename="quote.xlsx"; filename*=UTF-8''${encodeURIComponent("스톤테이블_견적서_가나다_학원_261109_v1.xlsx")}`,
    );
    const ws = await read(new Uint8Array(await res.arrayBuffer()));
    expect(find(ws, "다과")).toBeDefined();
  });

  it("encodes quote and paren characters in the filename*", async () => {
    const id = await readyQuote();
    await db
      .update(quoteVersions)
      .set({ eventJson: JSON.stringify({ ...event, customerName: "가'(나)" }) })
      .where(eq(quoteVersions.quoteId, id));
    const res = (await get(String(id), "1")) as Response;
    const disposition = res.headers.get("Content-Disposition")!;
    expect(disposition.split("filename*=UTF-8''")[1]).not.toMatch(/['()*]/);
  });

  it("404s for an unknown quote, a bad version, and a version that is not ready", async () => {
    const id = await readyQuote();
    for (const [i, v] of [["999999", "1"], [String(id), "7"], [String(id), "0"], ["x", "1"]]) {
      await expect(get(i, v)).rejects.toMatchObject({ init: { status: 404 } });
    }
    await db.update(quoteVersions).set({ status: "generating" }).where(eq(quoteVersions.quoteId, id));
    await expect(get(String(id), "1")).rejects.toMatchObject({ init: { status: 404 } });
  });
});
