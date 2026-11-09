import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { quotes, quoteVersions } from "../../database/schema";
import {
  GenerationError,
  makeClaudeCalls,
  makeFakeClaudeCalls,
  type ImportCall,
  type QuoteCall,
} from "../promo/claude.server";
import {
  handleRunFailure,
  RETRY_LATER,
  STALE_CLAIM_MS,
  type FailureCopy,
  type RunOptions,
} from "../promo/generate.server";
import type { Db } from "../server/db";
import { DomainError } from "../server/errors";
import { selectCandidates } from "./comparison.server";
import { buildLines, diffLines } from "./lines";
import { listPriceItems } from "./price-sheet.server";
import { buildImportSystem, buildImportUser, buildQuoteSystem, buildQuoteUser, type ImportOutput } from "./prompt";
import { getQuote } from "./quotes.server";
import type { Comparison, ComparisonRow, QuoteEvent, QuoteLine } from "./types";

/** Workflow instance params (workers/quote-workflow.ts). */
export type QuoteGenParams = { quoteId: number; version: number };

export type QuoteGenDeps = {
  db: Db;
  quote: QuoteCall;
  importQuote: ImportCall;
  now: () => Date;
};

/**
 * One generation run: the version plus the Workflow instance that claimed it
 * (startQuoteGeneration stores the instance id as quote_versions.workflow_id). Every write is
 * conditional on the version still being "generating" under this id.
 */
export type QuoteRunRef = { quoteId: number; version: number; workflowId: string };

const START_FAILED = "견적 만들기를 시작하지 못했어요. 잠시 후 다시 시도해 주세요.";

/** Quote wording for failures whose promo wording talks about photos and memos. */
const QUOTE_FAILURE_COPY: FailureCopy = {
  refusal: "AI가 이 요청을 거절했어요. 문의 글이나 수정 요청을 바꿔 다시 시도해 주세요.",
  max_tokens: "견적이 너무 길어져서 끝까지 만들지 못했어요. 다시 시도해 주세요.",
  bad_request: "AI가 요청을 처리하지 못했어요. 문의 글이나 수정 요청을 바꿔 다시 만들어 주세요.",
};

function owned(run: QuoteRunRef) {
  return and(
    eq(quoteVersions.quoteId, run.quoteId),
    eq(quoteVersions.version, run.version),
    eq(quoteVersions.workflowId, run.workflowId),
    eq(quoteVersions.status, "generating"),
  );
}

async function markFailed(db: Db, run: QuoteRunRef, message: string): Promise<void> {
  await db.update(quoteVersions).set({ status: "failed", error: message }).where(owned(run));
}

/** Last resort for the Workflow (step timed out or every retry failed). */
export async function failQuoteIfStillGenerating(db: Db, run: QuoteRunRef): Promise<void> {
  await markFailed(db, run, RETRY_LATER);
}

type Generated = {
  event: QuoteEvent;
  lines: QuoteLine[];
  comparison: Comparison;
  emailSubject: string | null;
  emailBody: string | null;
  changes: string[] | null;
  inputTokens: number;
  outputTokens: number;
};

/** Whole won, or null: a file value the model could not read as a price stays empty. */
function wholeWon(n: number | null): number | null {
  return n !== null && Number.isInteger(n) && n >= 0 ? n : null;
}

function cleanEvent(event: QuoteEvent): QuoteEvent {
  const headcount = event.headcount !== null && Number.isInteger(event.headcount) && event.headcount > 0 ? event.headcount : null;
  return { ...event, headcount, missing: event.missing.map((m) => m.trim()).filter((m) => m !== "") };
}

function importedLines(lines: ImportOutput["lines"]): QuoteLine[] {
  return lines.map((l) => ({
    itemId: null,
    label: l.label,
    content: l.content,
    qty: Math.max(0, Math.round(l.qty)),
    unitPrice: wholeWon(l.unitPrice),
    priceSource: "imported",
    svc: l.svc,
    menu: l.menu,
    note: l.note,
  }));
}

/** Copies a finished quote file as is (version 1 of an imported quote). */
async function importVersion(deps: QuoteGenDeps, inputText: string): Promise<Generated> {
  const { output, inputTokens, outputTokens } = await deps.importQuote({
    system: buildImportSystem(),
    user: buildImportUser(inputText),
  });
  return {
    event: cleanEvent(output.event),
    lines: importedLines(output.lines),
    comparison: { notes: "", rows: [] },
    emailSubject: null,
    emailBody: null,
    changes: null,
    inputTokens,
    outputTokens,
  };
}

/**
 * Only rows that were actually sent, as they were sent (later watch runs do not change it). Notes
 * without any surviving row are dropped: they could state numbers with no source behind them.
 */
function citedComparison(notes: string, rows: ComparisonRow[]): Comparison {
  return rows.length === 0 ? { notes: "", rows: [] } : { notes: notes.trim(), rows };
}

/** Prices come from the sheet (or carry over from the previous version), never from the model. */
async function quoteVersion(
  deps: QuoteGenDeps,
  run: QuoteRunRef,
  row: { inputText: string; changeRequest: string | null },
): Promise<Generated> {
  const { db } = deps;
  // A revision builds on the version before it (requestRevision only makes v(n+1) from a ready vn).
  // If that cannot be read, fail: running it as a first version would drop the agreed prices.
  let prev: { event: QuoteEvent; lines: QuoteLine[] } | null = null;
  if (run.version > 1) {
    const before = (await getQuote(db, run.quoteId, run.version - 1)).version;
    if (!before.event || !before.lines) throw new GenerationError("invalid_output");
    prev = { event: before.event, lines: before.lines };
  }
  const [sheet, candidates] = await Promise.all([
    listPriceItems(db, { enabledOnly: true }),
    // v1: the event type is only known after this call, so candidates are ranked by the inquiry.
    selectCandidates(db, prev?.event ?? { eventType: "", headcount: null }, run.quoteId, { text: row.inputText }),
  ]);

  const { output, inputTokens, outputTokens } = await deps.quote({
    system: buildQuoteSystem(),
    user: buildQuoteUser({ text: row.inputText, sheet, candidates, prev, changeRequest: row.changeRequest }),
  });

  const lines = buildLines(output.lines, sheet, prev?.lines ?? null);
  const cited = new Set(output.comparison.citedIds);
  const changes = prev
    ? [
        output.requestSummary.trim() || (row.changeRequest ?? "").trim().split("\n")[0],
        ...diffLines(prev.lines, lines),
      ]
    : null;
  return {
    event: cleanEvent(output.event),
    lines,
    comparison: citedComparison(output.comparison.notes, candidates.filter((c) => cited.has(c.id))),
    emailSubject: output.email.subject,
    emailBody: output.email.body,
    changes,
    inputTokens,
    outputTokens,
  };
}

/** Runs inside the Workflow step. Failures follow handleRunFailure (app/promo/generate.server.ts). */
export async function runQuoteGeneration(deps: QuoteGenDeps, run: QuoteRunRef, opts: RunOptions = {}): Promise<void> {
  const { db } = deps;
  try {
    const [row] = await db
      .select({ inputText: quoteVersions.inputText, changeRequest: quoteVersions.changeRequest, source: quotes.source })
      .from(quoteVersions)
      .innerJoin(quotes, eq(quotes.id, quoteVersions.quoteId))
      .where(owned(run));
    if (!row) {
      // A retried step whose earlier attempt finished, or a superseded run: no model call.
      console.warn("quote run no longer owns the version, skipping", run);
      return;
    }

    // Only the file's first reading is a copy; a revision of an imported quote is a normal
    // revision whose imported prices carry over through prevIndex.
    const g =
      row.source === "imported" && run.version === 1
        ? await importVersion(deps, row.inputText)
        : await quoteVersion(deps, run, row);

    const at = deps.now().toISOString();
    await db.batch([
      db
        .update(quotes)
        .set({ updatedAt: at })
        .where(and(eq(quotes.id, run.quoteId), sql`EXISTS (SELECT 1 FROM ${quoteVersions} WHERE ${owned(run)})`)),
      db
        .update(quoteVersions)
        .set({
          status: "ready",
          error: null,
          eventJson: JSON.stringify(g.event),
          linesJson: JSON.stringify(g.lines),
          comparisonJson: JSON.stringify(g.comparison),
          emailSubject: g.emailSubject,
          emailBody: g.emailBody,
          changesJson: g.changes === null ? null : JSON.stringify(g.changes),
          inputTokens: g.inputTokens,
          outputTokens: g.outputTokens,
          generatedAt: at,
        })
        .where(owned(run)),
    ]);
  } catch (e) {
    await handleRunFailure(e, opts, (message) => markFailed(db, run, message), run, QUOTE_FAILURE_COPY);
  }
}

// ---- Start (called from route actions) ------------------------------------

/**
 * Claims the version under a new Workflow instance id and starts that instance. Claimable: the
 * version createQuote/requestRevision just made (generating, no Workflow yet), a claim older than
 * STALE_CLAIM_MS, or a failed latest version (다시 시도). Never a ready version. If the Workflow
 * cannot be created the version is marked failed with a Korean reason instead of throwing.
 */
export async function startQuoteGeneration(
  env: Pick<Env, "QUOTE_GENERATE">,
  db: Db,
  quoteId: number,
  version: number,
  now: Date = new Date(),
): Promise<void> {
  const run: QuoteRunRef = { quoteId, version, workflowId: `quote-${quoteId}-v${version}-${now.getTime()}` };
  const staleBefore = new Date(now.getTime() - STALE_CLAIM_MS).toISOString();
  const isLatest = sql`${quoteVersions.version} = (SELECT max(v2.version) FROM ${quoteVersions} v2
    WHERE v2.quote_id = ${quoteId})`;
  const claimed = await db
    .update(quoteVersions)
    .set({ status: "generating", error: null, workflowId: run.workflowId, generationStartedAt: now.toISOString() })
    .where(
      and(
        eq(quoteVersions.quoteId, quoteId),
        eq(quoteVersions.version, version),
        isLatest,
        or(
          eq(quoteVersions.status, "failed"),
          and(
            eq(quoteVersions.status, "generating"),
            or(
              isNull(quoteVersions.workflowId),
              isNull(quoteVersions.generationStartedAt),
              lt(quoteVersions.generationStartedAt, staleBefore),
            ),
          ),
        ),
      ),
    )
    .returning({ id: quoteVersions.id });
  if (claimed.length === 0) {
    const [row] = await db
      .select({ status: quoteVersions.status })
      .from(quoteVersions)
      .where(and(eq(quoteVersions.quoteId, quoteId), eq(quoteVersions.version, version)));
    if (!row) throw new DomainError("NOT_FOUND", "견적을 찾을 수 없어요.");
    if (row.status === "generating") throw new DomainError("BUSY", "이미 만드는 중이에요.");
    throw new DomainError("INVALID_STATE", "이 버전은 다시 만들 수 없어요.");
  }

  const params: QuoteGenParams = { quoteId, version };
  try {
    await env.QUOTE_GENERATE.create({ id: run.workflowId, params });
  } catch (e) {
    console.error("could not start quote workflow", { ...run, error: e });
    await markFailed(db, run, START_FAILED);
  }
}

// ---- Real dependencies ----------------------------------------------------

export function makeQuoteGenDeps(env: Env, db: Db): QuoteGenDeps {
  // Typed as its wrangler.jsonc default ("0"); only a local .dev.vars turns it on.
  const fakeClaude: string = env.FAKE_CLAUDE;
  const calls = fakeClaude === "1" ? makeFakeClaudeCalls() : makeClaudeCalls(env.ANTHROPIC_API_KEY);
  return { db, quote: calls.quote, importQuote: calls.importQuote, now: () => new Date() };
}
