import { env } from "cloudflare:workers";
import { CircleAlertIcon } from "lucide-react";
import { Form, Link, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/quote-import";
import { Button } from "../components/ui/button";
import { Field } from "../components/ui/label";
import { xlsxToText } from "../quote/excel.server";
import { startQuoteGeneration } from "../quote/generate.server";
import { createQuote } from "../quote/quotes.server";
import { getDb } from "../server/db";
import { DomainError } from "../server/errors";

export const handle = { wide: true };

/** Uploads above this are refused before they are read. */
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

export function meta({}: Route.MetaArgs) {
  return [{ title: "지난 견적 가져오기 · 스톤브릿지 홍보글" }];
}

/** Cell text of the uploaded workbook; a Korean DomainError for anything that is not a usable .xlsx. */
async function workbookText(file: unknown): Promise<string> {
  if (!(file instanceof File) || file.size === 0) {
    throw new DomainError("INVALID_INPUT", "엑셀 파일(.xlsx)을 골라 주세요.");
  }
  if (!file.name.toLowerCase().endsWith(".xlsx")) {
    throw new DomainError("INVALID_INPUT", ".xlsx 파일만 가져올 수 있어요. 엑셀에서 'xlsx'로 저장해서 올려 주세요.");
  }
  if (file.size > MAX_IMPORT_BYTES) {
    throw new DomainError("INVALID_INPUT", "파일이 너무 커요. 5MB 이하만 가져올 수 있어요.");
  }
  let text: string;
  try {
    text = await xlsxToText(new Uint8Array(await file.arrayBuffer()));
  } catch (e) {
    console.warn("quote import: unreadable workbook", e);
    throw new DomainError("INVALID_INPUT", "엑셀 파일을 읽지 못했어요. 파일이 깨졌거나 .xlsx가 아닌 것 같아요.");
  }
  if (text.trim() === "") throw new DomainError("INVALID_INPUT", "파일에서 읽을 내용을 찾지 못했어요. 첫 번째 시트에 견적 내용이 있는지 확인해 주세요.");
  return text;
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const db = getDb(env.DB);
  try {
    const text = await workbookText(form.get("file"));
    const { quoteId } = await createQuote(db, { text, source: "imported" }, new Date());
    // The quote exists now: go to it whatever happens to the start (a failed start is recorded on
    // the version), so uploading again does not make a duplicate.
    try {
      await startQuoteGeneration(env, db, quoteId, 1);
    } catch (e) {
      console.error("startQuoteGeneration failed after import", { quoteId, error: e });
    }
    return redirect(`/quotes/${quoteId}`);
  } catch (e) {
    if (e instanceof DomainError && e.code === "INVALID_INPUT") return { error: e.message };
    throw e;
  }
}

export default function QuoteImport({ actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  return (
    <Form method="post" encType="multipart/form-data" className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">지난 견적 가져오기</h1>
        <Link to="/quotes" className="flex h-11 items-center text-sm text-muted-foreground underline">
          ← 견적 목록
        </Link>
      </div>
      <Field
        label="견적서 엑셀 파일"
        htmlFor="file"
        hint="이미 보낸 견적서(.xlsx, 5MB 이하)를 올리면 내용을 그대로 옮겨 와요. 단가는 파일에 적힌 값을 써요. 몇 분 걸릴 수 있어요."
      >
        <input
          id="file"
          name="file"
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          required
          disabled={busy}
          className="block min-h-11 w-full rounded-md border border-input bg-card px-3 py-2 text-base file:mr-3 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-sm file:font-medium"
        />
      </Field>
      {actionData?.error && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-800"
        >
          <CircleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{actionData.error}</span>
        </p>
      )}
      <Button type="submit" size="lg" className="h-12" disabled={busy}>
        {busy ? "가져오는 중…" : "가져오기"}
      </Button>
    </Form>
  );
}
