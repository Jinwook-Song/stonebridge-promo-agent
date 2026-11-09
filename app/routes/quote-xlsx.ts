import { env } from "cloudflare:workers";
import { data } from "react-router";
import type { Route } from "./+types/quote-xlsx";
import { buildQuoteXlsx, xlsxFileName } from "../quote/excel.server";
import { getQuoteSettings } from "../quote/quote-settings.server";
import { getQuote } from "../quote/quotes.server";
import { getDb } from "../server/db";
import { DomainError } from "../server/errors";

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function positiveInt(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) throw data("견적을 찾을 수 없어요.", { status: 404 });
  return n;
}

/** RFC 5987 value: encodeURIComponent leaves `'()*` alone, which are not allowed there. */
function encodeRfc5987(name: string): string {
  return encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

// Resource route under the owner layout: the file carries the customer's data, so the owner login applies.
export async function loader({ params }: Route.LoaderArgs) {
  const db = getDb(env.DB);
  const id = positiveInt(params.id);
  const versionNumber = positiveInt(params.version);
  let view;
  try {
    view = await getQuote(db, id, versionNumber);
  } catch (e) {
    if (e instanceof DomainError && e.code === "NOT_FOUND") throw data(e.message, { status: 404 });
    throw e;
  }
  const { quote, version } = view;
  if (version.status !== "ready" || version.event === null || version.lines === null) {
    throw data("아직 만들어진 견적이 아니에요.", { status: 404 });
  }
  const { intro, fixedLines } = await getQuoteSettings(db);
  const bytes = await buildQuoteXlsx({
    event: version.event,
    lines: version.lines,
    sender: quote.sender,
    vatIncluded: quote.vatIncluded,
    intro,
    fixedLines,
    createdAt: quote.createdAt,
  });
  const name = xlsxFileName(version.event.customerName, quote.createdAt, version.version);
  return new Response(bytes, {
    headers: {
      "Content-Type": XLSX_TYPE,
      "Content-Disposition": `attachment; filename="quote.xlsx"; filename*=UTF-8''${encodeRfc5987(name)}`,
      "Cache-Control": "no-store",
    },
  });
}
