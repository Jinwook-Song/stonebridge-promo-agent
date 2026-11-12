import type ExcelJS from "exceljs";
import { computeTotals, lineAmount } from "./lines";
import type { QuoteEvent, QuoteLine, Sender } from "./types";

const COLUMNS = ["항목", "내용", "수량", "공급 단가", "공급 금액", "메뉴", "비고"] as const;
const WIDTHS = [22, 34, 8, 14, 16, 22, 26];
const LAST_COL = COLUMNS.length;
const AMOUNT_COL = 5;
const MONEY = "#,##0";
const THIN = { style: "thin", color: { argb: "FF999999" } } as const;
const BORDER: Partial<ExcelJS.Borders> = { top: THIN, left: THIN, bottom: THIN, right: THIN };
const HEAD_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFEFEF" } };
const RED = { argb: "FFB42318" };
// Rough characters per line across the merged A:G width, to size merged text rows by hand
// (Excel does not auto-fit merged cells).
const CHARS_PER_LINE = 70;

export type QuoteXlsxInput = {
  event: QuoteEvent;
  lines: QuoteLine[];
  sender: Sender;
  vatIncluded: boolean;
  intro: string;
  fixedLines: string;
  /** The version's creation time: 견적일. */
  createdAt: string;
};

/** `2026-11-09T03:00:00.000Z` → `2026-11-09` in Korean time. */
function kstDate(iso: string): string {
  return new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString().slice(0, 10);
}

function wrappedHeight(text: string): number {
  const rows = text.split("\n").reduce((n, part) => n + Math.max(1, Math.ceil(part.length / CHARS_PER_LINE)), 0);
  return Math.max(1, rows) * 17;
}

/**
 * The quote workbook the owner mails to the customer. Amounts are live formulas
 * (`=수량*단가`, `=SUM(…)`, `=ROUND(공급금액*1.1,0)`); each also carries the value the screen shows as
 * its cached result, so viewers that do not recalculate (phone and mail previews) show numbers too.
 */
export async function buildQuoteXlsx(input: QuoteXlsxInput): Promise<Uint8Array<ArrayBuffer>> {
  const { event, lines, sender, vatIncluded, intro, fixedLines } = input;
  const totals = computeTotals(lines, vatIncluded);

  // Loaded on demand: exceljs is ~2 MiB and only these two functions need it.
  const { default: Excel } = await import("exceljs");
  const wb = new Excel.Workbook();
  const ws = wb.addWorksheet("견적서", {
    pageSetup: { orientation: "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 },
  });
  ws.columns = WIDTHS.map((width) => ({ width }));

  /** One full-width merged row of wrapped text. */
  function textRow(text: string, opts: { bold?: boolean; size?: number; align?: "left" | "center" } = {}) {
    const row = ws.addRow([text]);
    ws.mergeCells(row.number, 1, row.number, LAST_COL);
    const cell = row.getCell(1);
    cell.font = { bold: opts.bold ?? false, size: opts.size ?? 11 };
    cell.alignment = { wrapText: true, vertical: "top", horizontal: opts.align ?? "left" };
    row.height = Math.max(wrappedHeight(text), (opts.size ?? 11) * 1.6);
    return row;
  }

  /** A label (A) and a value (B:G merged). Empty values are left out. */
  function pair(label: string, value: string) {
    if (value.trim() === "") return;
    const row = ws.addRow([label, value]);
    ws.mergeCells(row.number, 2, row.number, LAST_COL);
    row.getCell(1).font = { bold: true };
    row.getCell(1).alignment = { vertical: "top" };
    row.getCell(2).alignment = { wrapText: true, vertical: "top", horizontal: "left" };
    row.height = wrappedHeight(value);
  }

  function section(title: string) {
    const row = ws.addRow([title]);
    ws.mergeCells(row.number, 1, row.number, LAST_COL);
    row.getCell(1).font = { bold: true, size: 12 };
    row.getCell(1).fill = HEAD_FILL;
    row.height = 20;
  }

  textRow("견적서", { bold: true, size: 20, align: "center" });
  textRow(`견적일 ${kstDate(input.createdAt)}`, { align: "center" });
  ws.addRow([]);

  section("수신");
  pair("고객사", event.customerName);
  pair("담당자", event.contactName);
  pair("연락처", [event.contact, event.email].filter(Boolean).join(" / "));
  pair("행사 일시", event.eventDate);
  pair("인원", event.headcount === null ? "" : `${event.headcount}명`);
  pair("행사 성격", event.eventType);
  pair("장소", event.venue);
  pair("특이사항", event.requests);
  ws.addRow([]);

  section("발신");
  pair("업체", sender.company);
  pair("담당자", sender.person);
  pair("연락처", [sender.phone, sender.email].filter(Boolean).join(" / "));
  pair("입금 계좌", sender.payment);
  pair("현장 안내", sender.onsite);

  const introText = intro.trim();
  if (introText !== "") {
    ws.addRow([]);
    textRow(introText);
  }
  ws.addRow([]);

  const head = ws.addRow([...COLUMNS]);
  head.eachCell((cell) => {
    cell.font = { bold: true };
    cell.fill = HEAD_FILL;
    cell.border = BORDER;
    cell.alignment = { horizontal: "center", vertical: "middle" };
  });

  let firstLine = 0;
  let lastLine = 0;
  for (const line of lines) {
    const row = ws.addRow([line.label, line.content, line.qty, line.unitPrice ?? undefined, undefined, line.menu, line.note]);
    firstLine ||= row.number;
    lastLine = row.number;
    const amount = lineAmount(line);
    const cell = row.getCell(AMOUNT_COL);
    if (amount === "SVC") {
      cell.value = "SVC";
    } else if (amount !== null) {
      cell.value = { formula: `C${row.number}*D${row.number}`, result: amount };
    }
    if (amount === null) {
      const price = row.getCell(4);
      price.value = "단가 없음";
      price.font = { italic: true, color: RED };
    }
    row.eachCell({ includeEmpty: true }, (c, col) => {
      c.border = BORDER;
      c.alignment = { vertical: "top", wrapText: col !== 3 && col !== 4 && col !== AMOUNT_COL, horizontal: col >= 3 && col <= AMOUNT_COL ? "right" : "left" };
    });
    for (const col of [3, 4, AMOUNT_COL]) row.getCell(col).numFmt = MONEY;
  }

  /** A summary line: label right-aligned across A:D, value in the amount column. */
  function summary(label: string, value: ExcelJS.CellValue, bold = false): ExcelJS.Row {
    const row = ws.addRow([label]);
    ws.mergeCells(row.number, 1, row.number, AMOUNT_COL - 1);
    const labelCell = row.getCell(1);
    labelCell.font = { bold };
    labelCell.alignment = { horizontal: "right" };
    labelCell.border = BORDER;
    const cell = row.getCell(AMOUNT_COL);
    cell.value = value;
    cell.numFmt = MONEY;
    cell.font = { bold };
    cell.border = BORDER;
    return row;
  }

  const supplyValue: ExcelJS.CellValue =
    lines.length === 0
      ? totals.supply
      : { formula: `SUM(${colLetter(AMOUNT_COL)}${firstLine}:${colLetter(AMOUNT_COL)}${lastLine})`, result: totals.supply };
  const supplyRow = summary("공급금액", supplyValue, true);
  if (vatIncluded) {
    summary("합계 금액 (VAT 10% 포함)", { formula: `ROUND(${colLetter(AMOUNT_COL)}${supplyRow.number}*1.1,0)`, result: totals.total }, true);
  }
  if (sender.bizNo.trim() !== "") {
    const row = ws.addRow(["사업자번호", sender.bizNo]);
    ws.mergeCells(row.number, 2, row.number, LAST_COL);
    row.getCell(1).font = { bold: true };
    row.getCell(2).alignment = { horizontal: "left" };
  }

  const fixed = fixedLines.replace(/\r\n?/g, "\n").split("\n").map((l) => l.trim()).filter(Boolean);
  if (fixed.length > 0) {
    ws.addRow([]);
    section("기본 제공 사항");
    for (const text of fixed) textRow(text);
  }

  const buffer = await wb.xlsx.writeBuffer();
  return new Uint8Array(buffer as ArrayBuffer);
}

function colLetter(col: number): string {
  return String.fromCharCode(64 + col);
}

/** Drops what a file name cannot hold, keeping at most 40 code points (an emoji is never cut). */
function fileNamePart(text: string, fallback: string): string {
  const cleaned = text
    // Lone surrogates would make encodeURIComponent throw; drop them before anything else.
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "")
    .trim()
    .replace(/\s+/g, "_");
  return Array.from(cleaned).slice(0, 40).join("") || fallback;
}

/**
 * `<업체>_견적서_<고객>_<YYMMDD>_v<n>.xlsx`; the date is Korean time. The company is the quote's
 * sender (스톤테이블 unless changed in 견적 설정).
 */
export function xlsxFileName(customerName: string, createdAt: string, version: number, company = "스톤테이블"): string {
  const customer = fileNamePart(customerName, "고객");
  const sender = fileNamePart(company, "견적서");
  const yymmdd = kstDate(createdAt).slice(2).replace(/-/g, "");
  return `${sender}_견적서_${customer}_${yymmdd}_v${version}.xlsx`;
}

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value !== "object") return String(value);
  if ("result" in value || "formula" in value || "sharedFormula" in value) {
    return cellText((value as ExcelJS.CellFormulaValue).result as ExcelJS.CellValue);
  }
  if ("richText" in value) return value.richText.map((r) => r.text).join("");
  if ("text" in value) return typeof value.text === "string" ? value.text : cellText(value.text as ExcelJS.CellValue);
  if ("error" in value) return String(value.error);
  return "";
}

/**
 * The first sheet as text for the model: one line per row that has a value, cells joined by tabs.
 * Empty cells between values stay as empty fields so columns keep their place; formula cells give
 * their calculated value; a merged range is written once.
 */
export async function xlsxToText(bytes: Uint8Array): Promise<string> {
  const { default: Excel } = await import("exceljs");
  const wb = new Excel.Workbook();
  await wb.xlsx.load(bytes as never);
  const ws = wb.worksheets[0];
  if (!ws) return "";
  const out: string[] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const cells: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      const text = cell.isMerged && cell.master !== cell ? "" : cellText(cell.value).trim();
      cells[col - 1] = text.replace(/[\t\r\n]+/g, " ");
    });
    while (cells.length > 0 && !cells[cells.length - 1]) cells.pop();
    if (cells.length > 0) out.push(Array.from(cells, (c) => c ?? "").join("\t"));
  });
  return out.join("\n");
}
