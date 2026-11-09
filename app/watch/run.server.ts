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
const RSS_ITEMS_PER_RUN = 10;
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
/** Run state a successful read stores besides lastRunAt/lastStatus. */
type Done = { contentHash?: string };

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
    await deps.db
      .update(watchSources)
      .set({ lastRunAt: now.toISOString(), lastStatus: "error", lastError: message.slice(0, MAX_ERROR_CHARS) })
      .where(eq(watchSources.id, source.id));
    return { ...progress, status: "error" };
  }
}

/** Body text of a page, or an error naming the HTTP status. */
async function fetchOk(deps: WatchDeps, url: string): Promise<string> {
  const { status, text } = await fetchText(url, deps.fetch);
  if (status < 200 || status >= 300) throw new Error(`가져오지 못했어요 (HTTP ${status}) ${url}`);
  return text;
}

// ---- RSS -----------------------------------------------------------------------------------

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

/** Post text; "" when the page has none (a deleted Naver post still answers 200). */
async function postText(deps: WatchDeps, item: RssItem): Promise<string> {
  const naver = naverPost(item.url);
  if (naver) {
    const url = `https://m.blog.naver.com/PostView.naver?blogId=${encodeURIComponent(naver.blogId)}&logNo=${naver.logNo}`;
    return parsePostHtml(await fetchOk(deps, url));
  }
  return htmlToText(await fetchOk(deps, item.url));
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

  for (const item of newItems(items, source.lastSeenKey)) {
    if (progress.claudeCalls >= budget) break;
    // A failed fetch throws before lastSeenKey moves past this post, so the next run reads it again.
    const text = await postText(deps, item);
    if (text !== "") {
      progress.claudeCalls += 1;
      const extract = await extractOrSkip(() => deps.watchEvent(buildEventRequest(item, text)));
      if (extract?.isEvent) progress.added += await saveEvent(deps.db, source.id, item.url, extract, now);
    }
    // Per post, so a step timeout or a later failure does not read it again.
    await deps.db.update(watchSources).set({ lastSeenKey: item.key }).where(eq(watchSources.id, source.id));
  }
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
    // The event total; a per-person-only price stays in the extract's notes (not stored).
    price: positiveOrNull(e.price),
  };
  // "An event" with nothing known about it is noise in the comparison.
  const known = [row.date, row.client, row.venue, row.eventType, row.quantity, row.headcount, row.price];
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
  const text = htmlToText(await fetchOk(deps, source.url));
  if (text === "") throw new Error("페이지에 글자가 없어요");
  // The visible text, not the HTML: scripts and tokens change on every load.
  const contentHash = await sha256Hex(text);
  if (contentHash === source.contentHash) return { contentHash };

  progress.claudeCalls += 1;
  const { output } = await deps.watchPrices(buildPricesRequest(source.url, text));
  const packages = new Map<string, Package>();
  for (const p of output.packages) {
    const name = p.name.trim();
    if (name !== "" && !packages.has(name)) packages.set(name, { ...p, name });
  }
  // Keep the hash unset so the next run reads the page again.
  if (packages.size === 0) throw new Error("페이지에서 가격을 찾지 못했어요");

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
