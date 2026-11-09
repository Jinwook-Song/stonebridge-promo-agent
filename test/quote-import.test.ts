import { env } from "cloudflare:workers";
import ExcelJS from "exceljs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { quotes, quoteVersions } from "../database/schema";
import { action } from "../app/routes/quote-import";
import { getDb } from "../app/server/db";

const db = getDb(env.DB);

beforeEach(async () => {
  await db.delete(quoteVersions);
  await db.delete(quotes);
});

const realGenerate = env.QUOTE_GENERATE;
afterEach(() => {
  (env as { QUOTE_GENERATE: unknown }).QUOTE_GENERATE = realGenerate;
});

function fakeWorkflow() {
  const create = vi.fn(async ({ id }: { id?: string }) => ({ id }));
  (env as { QUOTE_GENERATE: unknown }).QUOTE_GENERATE = { create };
  return create;
}

async function workbook(rows: (string | number | null)[][]): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("견적");
  for (const r of rows) ws.addRow(r);
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

function upload(file: File | null) {
  const form = new FormData();
  if (file) form.set("file", file);
  return action({ request: new Request("http://localhost/quotes/import", { method: "POST", body: form }), params: {}, context: {} } as never);
}

const xlsxFile = (bytes: Uint8Array, name = "지난 견적.xlsx") => new File([bytes as BlobPart], name);

describe("quote-import action", () => {
  it("rejects a .txt file and creates no quote", async () => {
    const create = fakeWorkflow();
    const res = await upload(new File(["견적 내용"], "견적.txt", { type: "text/plain" }));
    expect(res).toMatchObject({ error: expect.stringMatching(/\.xlsx 파일만/) });
    // The name decides, even when the bytes happen to be a workbook.
    const renamed = await upload(xlsxFile(await workbook([["다과", 10]]), "견적.txt"));
    expect(renamed).toMatchObject({ error: expect.stringMatching(/\.xlsx 파일만/) });
    expect(await db.select().from(quotes)).toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects a missing file and an empty file", async () => {
    expect(await upload(null)).toMatchObject({ error: expect.stringMatching(/파일/) });
    expect(await upload(new File([], "빈.xlsx"))).toMatchObject({ error: expect.stringMatching(/파일/) });
    expect(await db.select().from(quotes)).toEqual([]);
  });

  it("rejects a file over 5 MB before reading it", async () => {
    const big = new File([new Uint8Array(5 * 1024 * 1024 + 1)], "큰.xlsx");
    expect(await upload(big)).toMatchObject({ error: expect.stringMatching(/5MB/) });
    expect(await db.select().from(quotes)).toEqual([]);
  });

  it("rejects bytes that are not a workbook even with an .xlsx name", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await upload(xlsxFile(new TextEncoder().encode("hello, not a zip")));
    expect(res).toMatchObject({ error: expect.stringMatching(/읽지 못했어요/) });
    expect(await db.select().from(quotes)).toEqual([]);
  });

  it("rejects a workbook with no text in it", async () => {
    const create = fakeWorkflow();
    const res = await upload(xlsxFile(await workbook([[null, null], []])));
    expect(res).toMatchObject({ error: expect.stringMatching(/읽을 내용/) });
    expect(await db.select().from(quotes)).toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });

  it("makes an imported quote with version 1 generating, from the cell text, and goes to it", async () => {
    const create = fakeWorkflow();
    const res = (await upload(xlsxFile(await workbook([["항목", "수량", "단가"], ["다과", 40, 12500]])))) as Response;

    const [quote] = await db.select().from(quotes);
    expect(quote).toMatchObject({ source: "imported", status: "draft" });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/quotes/${quote!.id}`);

    const [version] = await db.select().from(quoteVersions);
    expect(version).toMatchObject({ quoteId: quote!.id, version: 1, status: "generating" });
    expect(version!.inputText).toBe("항목\t수량\t단가\n다과\t40\t12500");
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0]).toMatchObject({ params: { quoteId: quote!.id, version: 1 } });
  });

  it("still goes to the quote when the Workflow cannot be started", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    (env as { QUOTE_GENERATE: unknown }).QUOTE_GENERATE = {
      create: vi.fn(async () => {
        throw new Error("down");
      }),
    };
    const res = (await upload(xlsxFile(await workbook([["다과", 10]])))) as Response;
    expect(res.status).toBe(302);
    expect(await db.select().from(quotes)).toHaveLength(1);
    err.mockRestore();
  });

  it("shows the too-long error from createQuote and keeps nothing", async () => {
    const long = "가".repeat(21_000);
    expect(await upload(xlsxFile(await workbook([[long]])))).toMatchObject({ error: expect.stringMatching(/너무 길어요/) });
    expect(await db.select().from(quotes)).toEqual([]);
  });
});
