import { and, desc, eq, ne, sql } from "drizzle-orm";
import { competitorEvents, competitorPrices, quotes, quoteVersions, watchSources } from "../../database/schema";
import type { Db } from "../server/db";
import { computeTotals } from "./lines";
import { LinesSchema, parseColumn } from "./quotes.server";
import { QUOTE_STATUS_LABELS, QuoteEventSchema, type ComparisonRow, type QuoteEvent } from "./types";

/** Per group (own quotes, competitor prices, competitor events). */
const PER_KIND = 10;
/** Rows read per group before ranking; ranking is done in code. */
const POOL = 200;

/**
 * What the candidates are ranked against. `perPerson`: the quote's own per-person supply price when
 * known (a revision: the previous version's supply ÷ headcount); competitor packages nearest to it
 * come first.
 */
export type Target = Pick<QuoteEvent, "eventType" | "headcount"> & { perPerson?: number | null };

/** Words of 2+ characters, lower-cased: "기업 워크숍/다과" → ["기업", "워크숍", "다과"]. */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s,./·()[\]\-+&|:;!?'"]+/)
    .filter((w) => w.length >= 2);
}

/** Scores a candidate's type text: higher = closer to the quote being made. */
type Scorer = (candidateText: string) => number;

/**
 * With an event type: how many of its words appear in the candidate's text. With only the pasted
 * inquiry (v1, before the model has named the event type): how many of the candidate's words
 * appear in the inquiry.
 */
function makeScorer(eventType: string, text: string | undefined): Scorer {
  const targetWords = words(eventType);
  if (targetWords.length > 0) {
    return (candidate) => {
      const lower = candidate.toLowerCase();
      return targetWords.filter((w) => lower.includes(w)).length;
    };
  }
  const inquiry = (text ?? "").toLowerCase();
  if (inquiry === "") return () => 0;
  return (candidate) => [...new Set(words(candidate))].filter((w) => inquiry.includes(w)).length;
}

/** 0 = same number; larger = further apart (ratio). Unknown on either side sorts last. */
function ratioDistance(target: number | null | undefined, other: number | null): number {
  if (!target || !other || target <= 0 || other <= 0) return Number.POSITIVE_INFINITY;
  return Math.abs(Math.log(other / target));
}

type Ranked = { row: ComparisonRow; score: number; distance: number; at: string };

/** More matched words first, then closest (headcount, or per-person price for packages), then newest. */
function rank(items: Ranked[]): ComparisonRow[] {
  return items
    .sort((a, b) => b.score - a.score || a.distance - b.distance || (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, PER_KIND)
    .map((i) => i.row);
}

const label = (parts: (string | null | undefined)[]) =>
  parts.filter((p): p is string => typeof p === "string" && p.trim() !== "").join(" · ");

/** The owner's other quotes, each at its latest ready version. */
async function ownRows(db: Db, target: Target, score: Scorer, excludeQuoteId: number | null) {
  const latestReady = sql`${quoteVersions.version} = (SELECT max(v2.version) FROM ${quoteVersions} v2
    WHERE v2.quote_id = ${quoteVersions.quoteId} AND v2.status = 'ready')`;
  const rows = await db
    .select({
      quoteId: quotes.id,
      status: quotes.status,
      createdAt: quoteVersions.createdAt,
      eventJson: quoteVersions.eventJson,
      linesJson: quoteVersions.linesJson,
    })
    .from(quoteVersions)
    .innerJoin(quotes, eq(quotes.id, quoteVersions.quoteId))
    .where(
      and(
        eq(quoteVersions.status, "ready"),
        latestReady,
        excludeQuoteId === null ? undefined : ne(quotes.id, excludeQuoteId),
      ),
    )
    .orderBy(desc(quotes.createdAt), desc(quotes.id))
    .limit(POOL);

  return rank(
    rows.map((r): Ranked => {
      const event = parseColumn(r.eventJson, QuoteEventSchema, "event");
      const lines = parseColumn(r.linesJson, LinesSchema, "lines") ?? [];
      const headcount = event?.headcount ?? null;
      const totals = computeTotals(lines, false);
      // A quote with an unpriced line has no honest per-person price.
      const perPerson =
        headcount && headcount > 0 && totals.missingPrices === 0 ? Math.round(totals.supply / headcount) : null;
      return {
        row: {
          id: `q${r.quoteId}`,
          kind: "own",
          label: label([
            event?.eventDate,
            event?.customerName,
            event?.eventType,
            headcount ? `${headcount}명` : null,
            QUOTE_STATUS_LABELS[r.status],
          ]),
          perPerson,
          sourceUrl: null,
          seenAt: r.createdAt,
        },
        score: score(event?.eventType ?? ""),
        distance: ratioDistance(target.headcount, headcount),
        at: r.createdAt,
      };
    }),
  );
}

/**
 * A package's item list counts as one matched word at most, so a long list cannot outrank a
 * package whose name matches.
 */
function packageScore(score: Scorer, packageName: string, itemsJson: string | null): number {
  return score(packageName) + Math.min(1, score(itemsJson ?? ""));
}

/** The newest row of each (source, package). With no target price every distance is the same. */
async function priceRows(db: Db, target: Target, score: Scorer) {
  const newest = sql`${competitorPrices.id} = (SELECT p2.id FROM ${competitorPrices} p2
    WHERE p2.source_id = ${competitorPrices.sourceId} AND p2.package_name = ${competitorPrices.packageName}
    ORDER BY p2.seen_at DESC, p2.id DESC LIMIT 1)`;
  const rows = await db
    .select({
      id: competitorPrices.id,
      sourceName: watchSources.name,
      sourceUrl: competitorPrices.sourceUrl,
      packageName: competitorPrices.packageName,
      perPerson: competitorPrices.perPerson,
      itemsJson: competitorPrices.itemsJson,
      seenAt: competitorPrices.seenAt,
    })
    .from(competitorPrices)
    .innerJoin(watchSources, eq(watchSources.id, competitorPrices.sourceId))
    .where(newest)
    .orderBy(desc(competitorPrices.seenAt), desc(competitorPrices.id))
    .limit(POOL);

  return rank(
    rows.map(
      (r): Ranked => ({
        row: {
          id: `p${r.id}`,
          kind: "price",
          label: label([r.sourceName, r.packageName]),
          perPerson: r.perPerson,
          sourceUrl: r.sourceUrl,
          seenAt: r.seenAt,
        },
        score: packageScore(score, r.packageName, r.itemsJson),
        distance: target.perPerson == null ? 0 : ratioDistance(target.perPerson, r.perPerson),
        at: r.seenAt,
      }),
    ),
  );
}

async function eventRows(db: Db, target: Target, score: Scorer) {
  const rows = await db
    .select({
      id: competitorEvents.id,
      sourceName: watchSources.name,
      sourceUrl: competitorEvents.sourceUrl,
      date: competitorEvents.date,
      client: competitorEvents.client,
      eventType: competitorEvents.eventType,
      headcount: competitorEvents.headcount,
      price: competitorEvents.price,
      seenAt: competitorEvents.seenAt,
    })
    .from(competitorEvents)
    .innerJoin(watchSources, eq(watchSources.id, competitorEvents.sourceId))
    .orderBy(desc(competitorEvents.seenAt), desc(competitorEvents.id))
    .limit(POOL);

  return rank(
    rows.map((r): Ranked => {
      // `price` is the whole event's price; per person only when both are known.
      const perPerson = r.price !== null && r.headcount && r.headcount > 0 ? Math.round(r.price / r.headcount) : null;
      return {
        row: {
          id: `e${r.id}`,
          kind: "event",
          label: label([r.sourceName, r.date, r.client, r.eventType, r.headcount ? `${r.headcount}명` : null]),
          perPerson,
          sourceUrl: r.sourceUrl,
          seenAt: r.seenAt,
        },
        score: score(r.eventType ?? ""),
        distance: ratioDistance(target.headcount, r.headcount),
        at: r.date ?? r.seenAt,
      };
    }),
  );
}

/**
 * Up to 30 rows the model may cite: the owner's quotes (with a ready version, except
 * `excludeQuoteId`), then the latest price of each competitor package, then competitor events,
 * at most 10 each. Within each group, rows whose type shares words with `event.eventType` (or,
 * when that is empty, with `opts.text`, the pasted inquiry) come first; packages then go by how
 * close their per-person price is to `event.perPerson`. Empty tables give fewer rows (or none);
 * this never blocks a quote.
 */
export async function selectCandidates(
  db: Db,
  event: Target,
  excludeQuoteId: number | null,
  opts: { text?: string } = {},
): Promise<ComparisonRow[]> {
  const score = makeScorer(event.eventType, opts.text);
  const [own, prices, events] = await Promise.all([
    ownRows(db, event, score, excludeQuoteId),
    priceRows(db, event, score),
    eventRows(db, event, score),
  ]);
  return [...own, ...prices, ...events];
}
