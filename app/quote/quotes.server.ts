import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { quotes, quoteVersions } from "../../database/schema";
import { STALE_CLAIM_MS } from "../promo/generate.server";
import type { Db } from "../server/db";
import { DomainError } from "../server/errors";
import { getQuoteSettings } from "./quote-settings.server";
import { computeTotals } from "./lines";
import {
  ComparisonSchema,
  QUOTE_STATUSES,
  QuoteEventSchema,
  QuoteLineSchema,
  SenderSchema,
  type Comparison,
  type QuoteEvent,
  type QuoteLine,
  type QuoteSource,
  type QuoteStatus,
  type Sender,
  type VersionStatus,
} from "./types";

const MAX_TEXT = 20_000;
const MAX_LINES = 200;

export type QuoteHeader = {
  id: number;
  status: QuoteStatus;
  source: QuoteSource;
  sender: Sender;
  vatIncluded: boolean;
  createdAt: string;
  updatedAt: string;
};

/** A version with its JSON columns parsed. Generated fields stay null until the version is ready. */
export type VersionView = {
  version: number;
  status: VersionStatus;
  error: string | null;
  inputText: string;
  changeRequest: string | null;
  event: QuoteEvent | null;
  lines: QuoteLine[] | null;
  comparison: Comparison | null;
  emailSubject: string | null;
  emailBody: string | null;
  /** What changed from the previous version (first entry: the request in one line); null for v1. */
  changes: string[] | null;
  inputTokens: number | null;
  outputTokens: number | null;
  createdAt: string;
  generatedAt: string | null;
};

export type QuoteView = {
  quote: QuoteHeader;
  version: VersionView;
  versions: { version: number; status: VersionStatus; createdAt: string }[];
};

export type QuoteListItem = {
  id: number;
  status: QuoteStatus;
  source: QuoteSource;
  createdAt: string;
  /** From the latest ready version; "" / null while no version is ready yet. */
  customerName: string;
  eventType: string;
  eventDate: string;
  headcount: number | null;
  /** Total with the quote's VAT setting; null while no version is ready yet. */
  total: number | null;
  missingPrices: number;
  latestVersion: number;
  latestStatus: VersionStatus;
};

// ---- JSON columns ----------------------------------------------------------

export const LinesSchema = z.array(QuoteLineSchema).max(MAX_LINES);
const ChangesSchema = z.array(z.string());

/** Parses a JSON column; a corrupt value is logged and read as null rather than breaking the page. */
export function parseColumn<T>(raw: string | null, schema: z.ZodType<T>, what: string): T | null {
  if (raw === null) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    // fall through
  }
  console.error("unreadable quote column", { what });
  return null;
}

const DEFAULT_SENDER: Sender = { company: "", person: "", phone: "", email: "", payment: "", onsite: "", bizNo: "" };

function header(row: typeof quotes.$inferSelect): QuoteHeader {
  return {
    id: row.id,
    status: row.status,
    source: row.source,
    sender: parseColumn(row.senderJson, SenderSchema, "sender") ?? DEFAULT_SENDER,
    vatIncluded: row.vatIncluded,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function versionView(row: typeof quoteVersions.$inferSelect): VersionView {
  return {
    version: row.version,
    status: row.status,
    error: row.error,
    inputText: row.inputText,
    changeRequest: row.changeRequest,
    event: parseColumn(row.eventJson, QuoteEventSchema, "event"),
    lines: parseColumn(row.linesJson, LinesSchema, "lines"),
    comparison: parseColumn(row.comparisonJson, ComparisonSchema, "comparison"),
    emailSubject: row.emailSubject,
    emailBody: row.emailBody,
    changes: parseColumn(row.changesJson, ChangesSchema, "changes"),
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    createdAt: row.createdAt,
    generatedAt: row.generatedAt,
  };
}

// ---- Create / revise -------------------------------------------------------

/** Browsers send textarea newlines as CRLF. */
function cleanText(raw: string, what: string): string {
  const text = raw.replace(/\r\n?/g, "\n").trim();
  if (text === "") throw new DomainError("INVALID_INPUT", `${what}을 적어 주세요.`);
  if (text.length > MAX_TEXT) {
    throw new DomainError("INVALID_INPUT", `${what}이 너무 길어요. ${MAX_TEXT.toLocaleString("ko-KR")}자까지 돼요.`);
  }
  return text;
}

/**
 * New quote with version 1 "generating": sender copied from the settings, VAT on. The claim time
 * is stamped now so the version can go stale if startQuoteGeneration never runs; the route calls
 * startQuoteGeneration next, which stores the Workflow id.
 */
export async function createQuote(
  db: Db,
  input: { text: string; source: QuoteSource },
  now: Date,
): Promise<{ quoteId: number }> {
  const text = cleanText(input.text, input.source === "imported" ? "견적서 내용" : "문의 내용");
  const { sender } = await getQuoteSettings(db);
  const at = now.toISOString();
  // One batch (one transaction): the version row refers to the quote just inserted.
  const [[quote]] = await db.batch([
    db
      .insert(quotes)
      .values({
        status: "draft",
        source: input.source,
        senderJson: JSON.stringify(sender),
        vatIncluded: true,
        createdAt: at,
        updatedAt: at,
      })
      .returning({ id: quotes.id }),
    db.insert(quoteVersions).values({
      quoteId: sql`last_insert_rowid()`,
      version: 1,
      status: "generating",
      generationStartedAt: at,
      inputText: text,
      createdAt: at,
    }),
  ]);
  return { quoteId: quote.id };
}

async function latestVersion(db: Db, quoteId: number) {
  const [row] = await db
    .select()
    .from(quoteVersions)
    .where(eq(quoteVersions.quoteId, quoteId))
    .orderBy(desc(quoteVersions.version))
    .limit(1);
  return row;
}

/** A generating version whose claim is younger than STALE_CLAIM_MS: a run may still finish it. */
export function isFreshClaim(row: { status: VersionStatus; generationStartedAt: string | null }, now: Date): boolean {
  if (row.status !== "generating" || row.generationStartedAt === null) return false;
  return Date.parse(row.generationStartedAt) > now.getTime() - STALE_CLAIM_MS;
}

const BUSY_MESSAGE = "견적을 만드는 중이에요. 끝난 뒤에 다시 요청해 주세요.";

function isUniqueViolation(e: unknown): boolean {
  for (let cur: unknown = e; cur instanceof Error; cur = cur.cause) {
    if (cur.message.includes("UNIQUE constraint failed")) return true;
  }
  return false;
}

/**
 * Version n+1 "generating", from the latest version n when it is ready. BUSY while the latest is
 * still being made (two quick taps make one new version: the loser hits the unique
 * (quote_id, version) index). A failed or dead latest version is retried, not revised.
 */
export async function requestRevision(
  db: Db,
  quoteId: number,
  changeRequest: string,
  now: Date,
): Promise<{ version: number }> {
  const request = cleanText(changeRequest, "수정 요청");
  const latest = await latestVersion(db, quoteId);
  if (!latest) throw new DomainError("NOT_FOUND", "견적을 찾을 수 없어요.");
  if (isFreshClaim(latest, now)) throw new DomainError("BUSY", BUSY_MESSAGE);
  if (latest.status !== "ready") {
    throw new DomainError("INVALID_STATE", "지난 버전을 만들지 못했어요. 다시 시도한 뒤에 수정 요청을 해 주세요.");
  }

  const version = latest.version + 1;
  const at = now.toISOString();
  try {
    await db.batch([
      db.insert(quoteVersions).values({
        quoteId,
        version,
        status: "generating",
        generationStartedAt: at,
        inputText: latest.inputText,
        changeRequest: request,
        createdAt: at,
      }),
      db.update(quotes).set({ updatedAt: at }).where(eq(quotes.id, quoteId)),
    ]);
  } catch (e) {
    if (isUniqueViolation(e)) throw new DomainError("BUSY", BUSY_MESSAGE);
    throw e;
  }
  return { version };
}

// ---- Read ------------------------------------------------------------------

/** The quote with one version (the latest when `version` is not given) and the version list. */
export async function getQuote(db: Db, quoteId: number, version?: number): Promise<QuoteView> {
  const [[quote], rows] = await db.batch([
    db.select().from(quotes).where(eq(quotes.id, quoteId)),
    db.select().from(quoteVersions).where(eq(quoteVersions.quoteId, quoteId)).orderBy(asc(quoteVersions.version)),
  ]);
  if (!quote) throw new DomainError("NOT_FOUND", "견적을 찾을 수 없어요.");
  const picked = version === undefined ? rows.at(-1) : rows.find((r) => r.version === version);
  if (!picked) throw new DomainError("NOT_FOUND", "그 버전을 찾을 수 없어요.");
  return {
    quote: header(quote),
    version: versionView(picked),
    versions: rows.map((r) => ({ version: r.version, status: r.status, createdAt: r.createdAt })),
  };
}

/** Newest first. Customer and event fields come from each quote's latest ready version. */
export async function listQuotes(db: Db): Promise<QuoteListItem[]> {
  const latest = sql`${quoteVersions.version} = (SELECT max(v2.version) FROM ${quoteVersions} v2
    WHERE v2.quote_id = ${quoteVersions.quoteId})`;
  const latestReady = sql`${quoteVersions.version} = (SELECT max(v2.version) FROM ${quoteVersions} v2
    WHERE v2.quote_id = ${quoteVersions.quoteId} AND v2.status = 'ready')`;
  // Separate selects: a join would put quotes.status and quote_versions.status under one key.
  const [heads, latestRows, ready] = await db.batch([
    db
      .select({
        id: quotes.id,
        status: quotes.status,
        source: quotes.source,
        vatIncluded: quotes.vatIncluded,
        createdAt: quotes.createdAt,
      })
      .from(quotes)
      .orderBy(desc(quotes.createdAt), desc(quotes.id)),
    db
      .select({ quoteId: quoteVersions.quoteId, version: quoteVersions.version, status: quoteVersions.status })
      .from(quoteVersions)
      .where(latest),
    db
      .select({ quoteId: quoteVersions.quoteId, eventJson: quoteVersions.eventJson, linesJson: quoteVersions.linesJson })
      .from(quoteVersions)
      .where(and(eq(quoteVersions.status, "ready"), latestReady)),
  ]);
  const latestBy = new Map(latestRows.map((r) => [r.quoteId, r]));
  const readyBy = new Map(ready.map((r) => [r.quoteId, r]));

  return heads.flatMap((h) => {
    const last = latestBy.get(h.id);
    // Every quote is created with version 1; skip one caught mid-delete.
    if (!last) return [];
    const r = readyBy.get(h.id);
    const event = r ? parseColumn(r.eventJson, QuoteEventSchema, "event") : null;
    const lines = r ? parseColumn(r.linesJson, LinesSchema, "lines") : null;
    const totals = lines ? computeTotals(lines, h.vatIncluded) : null;
    const item: QuoteListItem = {
      id: h.id,
      status: h.status,
      source: h.source,
      createdAt: h.createdAt,
      customerName: event?.customerName ?? "",
      eventType: event?.eventType ?? "",
      eventDate: event?.eventDate ?? "",
      headcount: event?.headcount ?? null,
      total: totals?.total ?? null,
      missingPrices: totals?.missingPrices ?? 0,
      latestVersion: last.version,
      latestStatus: last.status,
    };
    return [item];
  });
}

// ---- Owner edits -------------------------------------------------------------

function validate<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new DomainError("INVALID_INPUT", message);
  return parsed.data;
}

/**
 * Updates the version only when it is the latest one and ready: old versions are read-only and a
 * generating one would be overwritten by its run.
 */
async function updateLatestReady(
  db: Db,
  quoteId: number,
  version: number,
  set: Partial<typeof quoteVersions.$inferInsert>,
  now: Date,
): Promise<void> {
  const isLatest = sql`${quoteVersions.version} = (SELECT max(v2.version) FROM ${quoteVersions} v2
    WHERE v2.quote_id = ${quoteId})`;
  const updated = await db
    .update(quoteVersions)
    .set(set)
    .where(
      and(
        eq(quoteVersions.quoteId, quoteId),
        eq(quoteVersions.version, version),
        eq(quoteVersions.status, "ready"),
        isLatest,
      ),
    )
    .returning({ id: quoteVersions.id });
  if (updated.length > 0) {
    await db.update(quotes).set({ updatedAt: now.toISOString() }).where(eq(quotes.id, quoteId));
    return;
  }
  const [exists] = await db
    .select({ id: quoteVersions.id })
    .from(quoteVersions)
    .where(and(eq(quoteVersions.quoteId, quoteId), eq(quoteVersions.version, version)));
  if (!exists) throw new DomainError("NOT_FOUND", "견적을 찾을 수 없어요.");
  throw new DomainError("INVALID_STATE", "최신 버전만 고칠 수 있어요. 만드는 중이면 끝난 뒤에 고쳐 주세요.");
}

export async function saveLines(
  db: Db,
  quoteId: number,
  version: number,
  lines: QuoteLine[],
  now: Date = new Date(),
): Promise<void> {
  const clean = validate(LinesSchema, lines, "견적 줄이 올바르지 않아요. 수량과 단가는 0 이상의 숫자로 적어 주세요.");
  await updateLatestReady(db, quoteId, version, { linesJson: JSON.stringify(clean) }, now);
}

export async function saveEvent(
  db: Db,
  quoteId: number,
  version: number,
  event: QuoteEvent,
  now: Date = new Date(),
): Promise<void> {
  const clean = validate(QuoteEventSchema, event, "행사 정보가 올바르지 않아요. 인원은 숫자로 적어 주세요.");
  await updateLatestReady(db, quoteId, version, { eventJson: JSON.stringify(clean) }, now);
}

async function updateQuote(db: Db, quoteId: number, set: Partial<typeof quotes.$inferInsert>, now: Date) {
  const updated = await db
    .update(quotes)
    .set({ ...set, updatedAt: now.toISOString() })
    .where(eq(quotes.id, quoteId))
    .returning({ id: quotes.id });
  if (updated.length === 0) throw new DomainError("NOT_FOUND", "견적을 찾을 수 없어요.");
}

export async function saveSender(db: Db, quoteId: number, sender: Sender, now: Date = new Date()): Promise<void> {
  const parsed = validate(SenderSchema, sender, "발신 정보가 올바르지 않아요.");
  const clean = Object.fromEntries(
    Object.entries(parsed).map(([k, v]) => [k, v.replace(/\r\n?/g, "\n").trim()]),
  ) as Sender;
  await updateQuote(db, quoteId, { senderJson: JSON.stringify(clean) }, now);
}

export async function setVat(db: Db, quoteId: number, on: boolean, now: Date = new Date()): Promise<void> {
  await updateQuote(db, quoteId, { vatIncluded: validate(z.boolean(), on, "VAT 설정이 올바르지 않아요.") }, now);
}

export async function setStatus(db: Db, quoteId: number, status: QuoteStatus, now: Date = new Date()): Promise<void> {
  await updateQuote(db, quoteId, { status: validate(z.enum(QUOTE_STATUSES), status, "상태가 올바르지 않아요.") }, now);
}

/** Versions go with it (ON DELETE CASCADE). */
export async function deleteQuote(db: Db, quoteId: number): Promise<void> {
  const deleted = await db.delete(quotes).where(eq(quotes.id, quoteId)).returning({ id: quotes.id });
  if (deleted.length === 0) throw new DomainError("NOT_FOUND", "견적을 찾을 수 없어요.");
}
