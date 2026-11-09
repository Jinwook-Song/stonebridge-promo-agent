import { and, desc, eq } from "drizzle-orm";
import { competitorEvents, competitorPrices, watchSources } from "../../database/schema";
import { kst } from "../kakao/alerts.server";
import {
  GenerationError,
  makeClaudeCalls,
  makeFakeClaudeCalls,
  type WatchEventCall,
  type WatchPricesCall,
} from "../promo/claude.server";
import type { WorkflowStep } from "cloudflare:workers";
import type { Db } from "../server/db";
import { buildEventRequest, buildPricesRequest, type EventExtract, type PriceExtract } from "./extract";
import { fetchText, htmlToText } from "./fetch.server";
import { canonicalPostUrl, naverPost, parsePostHtml, parseRss, type RssItem } from "./naver-blog";
import type { WatchSource } from "./sources.server";

/** Claude calls allowed per daily run, over all sources (spec §6.4). */
export const WATCH_RUN_BUDGET = 30;

/**
 * 03:00 KST daily (UTC). Also in wrangler.jsonc `triggers.crons`; the Kakao alert crons are CRONS
 * in app/kakao/alerts.server.ts.
 */
export const WATCH_CRON = "0 18 * * *";

/** New feed posts read per source per run. */
export const RSS_ITEMS_PER_RUN = 10;
/**
 * An RSS source stops taking new posts after this long, so its 5-minute Workflow step ends on its
 * own (with what it did saved) instead of timing out and being retried.
 */
export const RSS_TIME_LIMIT_MS = 210_000;
/** A price page is read once a week. */
const PAGE_INTERVAL_MS = 7 * 24 * 3600_000;
const MAX_ERROR_CHARS = 200;

export type WatchDeps = {
  db: Db;
  fetch: typeof fetch;
  watchEvent: WatchEventCall;
  watchPrices: WatchPricesCall;
  now: () => Date;
};

export type WatchRunResult = { claudeCalls: number; added: number; status: "ok" | "error" | "skipped" };

type Progress = { claudeCalls: number; added: number };
/** Run state a read stores besides lastRunAt/lastStatus/lastError. */
type Done = { contentHash?: string };

/** A source error that also stores run state (the hash of a page with no prices). */
class SourceError extends Error {
  constructor(
    message: string,
    readonly done: Done = {},
  ) {
    super(message);
  }
}

/** Stored as lastError for a page whose text has no prices (e.g. an image-only price list). */
const NO_PRICES = "페이지에서 가격을 찾지 못했어요";

/**
 * Reads one source and stores what is new. Never throws for a broken source: the error goes to
 * the source's `lastStatus`/`lastError` so the other sources still run. `budget` = Claude calls
 * this source may still make. "skipped" (not due, disabled, no budget) leaves the run state alone.
 */
export async function runWatchSource(
  deps: WatchDeps,
  sourceId: number,
  budget: number,
  now: Date,
): Promise<WatchRunResult> {
  const [source] = await deps.db.select().from(watchSources).where(eq(watchSources.id, sourceId));
  const skipped: WatchRunResult = { claudeCalls: 0, added: 0, status: "skipped" };
  if (!source || !source.enabled || budget <= 0) return skipped;
  // After an error the page is tried again the next day, not a week later.
  if (
    source.kind === "page" &&
    source.lastStatus === "ok" &&
    source.lastRunAt !== null &&
    now.getTime() - Date.parse(source.lastRunAt) < PAGE_INTERVAL_MS
  ) {
    return skipped;
  }

  const progress: Progress = { claudeCalls: 0, added: 0 };
  try {
    const done =
      source.kind === "rss"
        ? await runRss(deps, source, budget, now, progress)
        : await runPage(deps, source, now, progress);
    await deps.db
      .update(watchSources)
      .set({ ...done, lastRunAt: now.toISOString(), lastStatus: "ok", lastError: null })
      .where(eq(watchSources.id, source.id));
    return { ...progress, status: "ok" };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn("watch source failed", { sourceId, error: message });
    const done = e instanceof SourceError ? e.done : {};
    await deps.db
      .update(watchSources)
      .set({ ...done, lastRunAt: now.toISOString(), lastStatus: "error", lastError: message.slice(0, MAX_ERROR_CHARS) })
      .where(eq(watchSources.id, source.id));
    return { ...progress, status: "error" };
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    url: string,
  ) {
    super(`가져오지 못했어요 (HTTP ${status}) ${url}`);
  }
}

/** Body text of a page, or an HttpError naming the status. */
async function fetchOk(deps: WatchDeps, url: string): Promise<string> {
  const { status, text } = await fetchText(url, deps.fetch);
  if (status < 200 || status >= 300) throw new HttpError(status, url);
  return text;
}

// ---- RSS -----------------------------------------------------------------------------------

/**
 * Newest first by pubDate; the feed's own order when any date is missing or unreadable (a stable
 * sort keeps that order for equal dates).
 */
function newestFirst(items: RssItem[]): RssItem[] {
  const times = items.map((i) => Date.parse(i.pubDate));
  if (times.some((t) => Number.isNaN(t))) return items;
  return items
    .map((item, index) => ({ item, time: times[index]! }))
    .sort((a, b) => b.time - a.time)
    .map((x) => x.item);
}

const isNumber = (key: string) => /^\d+$/.test(key);
/** Compares Naver post numbers as numbers (they outgrow 2^53 only far in the future). */
const newerNumber = (a: string, b: string) => a.length > b.length || (a.length === b.length && a > b);

/**
 * Items to read this run, oldest first. With a known `lastSeenKey`: the posts above it in the feed
 * (newest first), the oldest 10 of them, so a backlog is worked through over several runs. On a
 * first run, or when that post has left the feed: the newest 10 (for Naver, only numbers above it).
 */
function newItems(items: RssItem[], lastSeenKey: string | null): RssItem[] {
  if (lastSeenKey === null) return items.slice(0, RSS_ITEMS_PER_RUN).reverse();
  const at = items.findIndex((i) => i.key === lastSeenKey);
  if (at !== -1) return items.slice(0, at).slice(-RSS_ITEMS_PER_RUN).reverse();
  const fresh = isNumber(lastSeenKey)
    ? items.filter((i) => isNumber(i.key) && newerNumber(i.key, lastSeenKey))
    : items;
  return fresh.slice(0, RSS_ITEMS_PER_RUN).reverse();
}

/**
 * What m.blog.naver.com answers for a post that is not there: a tiny page that sends the browser
 * to `/MobileErrorView.naver?errorType=noPost` (checked 2026-11-09; HTTP 404 then, the spike saw a
 * 200 page). A block or captcha page has no paragraphs either, but not this.
 */
const NAVER_GONE = /MobileErrorView\.naver/;

/** Statuses after which a post will not come back; anything else (429, 5xx) is retried. */
const GONE_STATUSES = new Set([404, 410]);

/** Thrown for a post that no longer exists; the post is skipped. */
class PostGone extends Error {}

/**
 * Visible text of a post or page. A Naver blog link is a frameset, so its post is read from the
 * mobile PostView page.
 */
async function pageText(deps: WatchDeps, url: string): Promise<string> {
  const naver = naverPost(url);
  if (!naver) return htmlToText(await fetchOk(deps, url));
  const postView = `https://m.blog.naver.com/PostView.naver?blogId=${encodeURIComponent(naver.blogId)}&logNo=${naver.logNo}`;
  const html = await fetchOk(deps, postView);
  const text = parsePostHtml(html);
  if (text === "" && NAVER_GONE.test(html)) throw new PostGone(`글이 없어요 ${url}`);
  return text;
}

/**
 * Text of a feed post. PostGone for a deleted post (404/410, or Naver's not-found page). An empty
 * page without that sign (a block or captcha page answering 200) is an error, so the key stays.
 */
async function postText(deps: WatchDeps, url: string): Promise<string> {
  let text: string;
  try {
    text = await pageText(deps, url);
  } catch (e) {
    if (e instanceof HttpError && GONE_STATUSES.has(e.status)) throw new PostGone(e.message);
    throw e;
  }
  if (text === "") throw new Error(`글 본문을 찾지 못했어요 ${url}`);
  return text;
}

async function runRss(
  deps: WatchDeps,
  source: WatchSource,
  budget: number,
  now: Date,
  progress: Progress,
): Promise<Done> {
  const items = parseRss(await fetchOk(deps, source.url));
  // An error page, a login wall or a changed format reads as no items; say so instead of "ok".
  if (items.length === 0) throw new Error("피드에서 글을 찾지 못했어요");

  const started = deps.now().getTime();
  let read = 0;
  let gone = 0;
  for (const item of newItems(newestFirst(items), source.lastSeenKey)) {
    if (progress.claudeCalls >= budget) break;
    if (deps.now().getTime() - started >= RSS_TIME_LIMIT_MS) break;
    read += 1;
    // A failed fetch throws before lastSeenKey moves past this post, so the next run reads it again.
    let text: string | null = null;
    try {
      text = await postText(deps, item.url);
    } catch (e) {
      if (!(e instanceof PostGone)) throw e;
      console.warn("watch post gone, skipped", { sourceId: source.id, error: e.message });
      gone += 1;
    }
    if (text !== null) {
      progress.claudeCalls += 1;
      const post = text;
      const extract = await extractOrSkip(() => deps.watchEvent(buildEventRequest(item, post)));
      if (extract?.isEvent) progress.added += await saveEvent(deps.db, source.id, item.url, extract, now);
    }
    // Per post, so a step timeout or a later failure does not read it again.
    await deps.db.update(watchSources).set({ lastSeenKey: item.key }).where(eq(watchSources.id, source.id));
  }
  // Every post gone at once looks more like a block than like deletions: tell the owner.
  if (read > 0 && gone === read) throw new Error(`읽은 글 ${read}개가 모두 없는 글이었어요`);
  return {};
}

/** null for an answer that will not get better on retry (refusal, unreadable): the post is skipped. */
async function extractOrSkip<T>(run: () => Promise<{ output: T }>): Promise<T | null> {
  try {
    return (await run()).output;
  } catch (e) {
    if (!(e instanceof GenerationError)) throw e;
    console.warn("watch extract skipped", { reason: e.reason });
    return null;
  }
}

const textOrNull = (s: string) => (s.trim() === "" ? null : s.trim());
const positiveOrNull = (n: number | null) => (n !== null && Number.isSafeInteger(n) && n > 0 ? n : null);
const cleanList = (list: string[]) => list.map((s) => s.trim()).filter((s) => s !== "");

async function saveEvent(db: Db, sourceId: number, url: string, e: EventExtract, now: Date): Promise<number> {
  const sourceUrl = canonicalPostUrl(url);
  if (!sourceUrl) return 0;
  const row = {
    date: textOrNull(e.date),
    client: textOrNull(e.client),
    venue: textOrNull(e.venue),
    eventType: textOrNull(e.eventType),
    menu: cleanList(e.menu),
    quantity: positiveOrNull(e.quantity),
    headcount: positiveOrNull(e.headcount),
    // The event total; a per-person-only price is in notes.
    price: positiveOrNull(e.price),
    notes: textOrNull(e.notes),
  };
  // "An event" with nothing known about it is noise in the comparison.
  const known = [row.date, row.client, row.venue, row.eventType, row.quantity, row.headcount, row.price, row.notes];
  if (row.menu.length === 0 && known.every((v) => v === null)) return 0;

  const inserted = await db
    .insert(competitorEvents)
    .values({
      sourceId,
      sourceUrl,
      date: row.date,
      client: row.client,
      venue: row.venue,
      eventType: row.eventType,
      menuJson: row.menu.length > 0 ? JSON.stringify(row.menu) : null,
      quantity: row.quantity,
      headcount: row.headcount,
      price: row.price,
      notes: row.notes,
      seenAt: now.toISOString(),
    })
    .onConflictDoNothing({ target: competitorEvents.sourceUrl })
    .returning({ id: competitorEvents.id });
  return inserted.length;
}

// ---- Price page ----------------------------------------------------------------------------

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

type Package = PriceExtract["packages"][number];

async function runPage(
  deps: WatchDeps,
  source: WatchSource,
  now: Date,
  progress: Progress,
): Promise<Done> {
  // A price list pinned as a Naver blog post works too.
  const text = await pageText(deps, source.url);
  if (text === "") throw new Error("페이지에 글자가 없어요");
  // The visible text, not the HTML: scripts and tokens change on every load.
  const contentHash = await sha256Hex(text);
  if (contentHash === source.contentHash) {
    // Same text as when no prices were found: still none, and asking again costs a call a day.
    if (source.lastStatus === "error" && source.lastError === NO_PRICES) throw new SourceError(NO_PRICES, { contentHash });
    return { contentHash };
  }

  progress.claudeCalls += 1;
  const { output } = await deps.watchPrices(buildPricesRequest(source.url, text));
  const packages = new Map<string, Package>();
  for (const p of output.packages) {
    const name = p.name.trim();
    if (name !== "" && !packages.has(name)) packages.set(name, { ...p, name });
  }
  // The hash is kept so the same text is not sent again; a changed page is.
  if (packages.size === 0) throw new SourceError(NO_PRICES, { contentHash });

  for (const p of packages.values()) {
    const next = {
      perPerson: positiveOrNull(p.perPerson),
      itemsJson: JSON.stringify(cleanList(p.items)),
      minimum: positiveOrNull(p.minimum),
      feesJson: JSON.stringify(cleanList(p.fees)),
    };
    const [latest] = await deps.db
      .select()
      .from(competitorPrices)
      .where(and(eq(competitorPrices.sourceId, source.id), eq(competitorPrices.packageName, p.name)))
      .orderBy(desc(competitorPrices.seenAt), desc(competitorPrices.id))
      .limit(1);
    const same =
      latest &&
      latest.perPerson === next.perPerson &&
      latest.itemsJson === next.itemsJson &&
      latest.minimum === next.minimum &&
      latest.feesJson === next.feesJson;
    if (same) continue;
    await deps.db.insert(competitorPrices).values({
      sourceId: source.id,
      sourceUrl: source.url,
      packageName: p.name,
      ...next,
      seenAt: now.toISOString(),
    });
    progress.added += 1;
  }
  return { contentHash };
}

// ---- Daily run -----------------------------------------------------------------------------

/**
 * The Workflow's loop: each source in its own step, sharing one Claude budget. A step that fails
 * for good (both attempts) is logged and the next source runs; since its calls are unknown, it
 * counts as the most one source may make.
 */
export async function runWatch(
  step: Pick<WorkflowStep, "do">,
  deps: WatchDeps,
  sourceIds: number[],
  now: Date,
  budget: number = WATCH_RUN_BUDGET,
): Promise<{ remaining: number }> {
  let remaining = budget;
  for (const id of sourceIds) {
    const left = remaining;
    try {
      // runWatchSource records a broken source and returns; the retry covers an unexpected throw.
      const result = await step.do(
        `source-${id}`,
        { retries: { limit: 1, delay: "30 seconds" }, timeout: "5 minutes" },
        () => runWatchSource(deps, id, left, now),
      );
      remaining = Math.max(0, remaining - result.claudeCalls);
      console.log(`watch source ${id}: ${result.status}, ${result.claudeCalls} calls, ${result.added} added`);
    } catch (e) {
      remaining -= Math.min(remaining, RSS_ITEMS_PER_RUN);
      console.error("watch source step failed", { sourceId: id, error: e });
    }
  }
  return { remaining };
}

// ---- Start and real dependencies -----------------------------------------------------------

/**
 * Starts today's run (instance id `watch-<KST date>`). A second start the same day (the cron
 * fired twice) finds that instance and does nothing.
 */
export async function startWatchRun(
  workflow: Pick<Workflow, "create" | "get">,
  now: Date,
): Promise<"started" | "already_started"> {
  const id = `watch-${kst(now).date}`;
  try {
    await workflow.create({ id });
    return "started";
  } catch (e) {
    // The create error for a taken id is not typed; ask for the instance instead.
    const exists = await workflow.get(id).then(
      () => true,
      () => false,
    );
    if (exists) return "already_started";
    throw e;
  }
}

export function makeWatchDeps(env: Env, db: Db): WatchDeps {
  // Typed as its wrangler.jsonc default ("0"); only a local .dev.vars turns it on.
  const fakeClaude: string = env.FAKE_CLAUDE;
  const calls = fakeClaude === "1" ? makeFakeClaudeCalls() : makeClaudeCalls(env.ANTHROPIC_API_KEY);
  return {
    db,
    fetch: (input, init) => fetch(input, init),
    watchEvent: calls.watchEvent,
    watchPrices: calls.watchPrices,
    now: () => new Date(),
  };
}
