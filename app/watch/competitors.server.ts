import { desc, eq, sql } from "drizzle-orm";
import { competitorEvents, competitorPrices, watchSources } from "../../database/schema";
import type { Db } from "../server/db";

/** Events on the news tab. */
export const EVENT_LIMIT = 100;
/** Stored price rows read for the price tab (a row is only stored when a price changed). */
const PRICE_ROW_LIMIT = 2000;
const MAX_QUERY_CHARS = 100;

export type EventView = {
  id: number;
  sourceName: string;
  sourceUrl: string;
  date: string | null;
  client: string | null;
  venue: string | null;
  eventType: string | null;
  menu: string[];
  quantity: number | null;
  headcount: number | null;
  price: number | null;
  notes: string | null;
  seenAt: string;
};

export type PriceView = {
  id: number;
  sourceUrl: string;
  perPerson: number | null;
  items: string[];
  minimum: number | null;
  fees: string[];
  seenAt: string;
};

/** One (source, package): the newest value, and the older ones newest first. */
export type PriceGroup = {
  sourceId: number;
  sourceName: string;
  packageName: string;
  latest: PriceView;
  /** Earlier values, newest first. */
  earlier: PriceView[];
};

/** A JSON array of strings from a stored column; [] for anything else. */
function stringList(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Case-insensitive contains pattern with LIKE's own characters taken literally. */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, "\\$&")}%`;
}

/**
 * Newest 100 events (by when they were seen), optionally those whose competitor, client or venue
 * contains `q`.
 */
export async function listEvents(db: Db, q: string): Promise<EventView[]> {
  const text = q.trim().slice(0, MAX_QUERY_CHARS);
  const like = likePattern(text);
  const match =
    text === ""
      ? undefined
      : sql`(${watchSources.name} LIKE ${like} ESCAPE '\\' OR ${competitorEvents.client} LIKE ${like} ESCAPE '\\' OR ${competitorEvents.venue} LIKE ${like} ESCAPE '\\')`;
  const rows = await db
    .select({ event: competitorEvents, sourceName: watchSources.name })
    .from(competitorEvents)
    .innerJoin(watchSources, eq(watchSources.id, competitorEvents.sourceId))
    .where(match)
    .orderBy(desc(competitorEvents.seenAt), desc(competitorEvents.id))
    .limit(EVENT_LIMIT);
  return rows.map(({ event: e, sourceName }) => ({
    id: e.id,
    sourceName,
    sourceUrl: e.sourceUrl,
    date: e.date,
    client: e.client,
    venue: e.venue,
    eventType: e.eventType,
    menu: stringList(e.menuJson),
    quantity: e.quantity,
    headcount: e.headcount,
    price: e.price,
    notes: e.notes,
    seenAt: e.seenAt,
  }));
}

/** Prices grouped by (source, package), the groups with the newest change first. */
export async function listPriceGroups(db: Db): Promise<PriceGroup[]> {
  const rows = await db
    .select({ price: competitorPrices, sourceName: watchSources.name })
    .from(competitorPrices)
    .innerJoin(watchSources, eq(watchSources.id, competitorPrices.sourceId))
    .orderBy(desc(competitorPrices.seenAt), desc(competitorPrices.id))
    .limit(PRICE_ROW_LIMIT);

  // Rows come newest first, so the first row of a group is its latest and groups are in order.
  const groups = new Map<string, PriceGroup>();
  for (const { price: p, sourceName } of rows) {
    const view: PriceView = {
      id: p.id,
      sourceUrl: p.sourceUrl,
      perPerson: p.perPerson,
      items: stringList(p.itemsJson),
      minimum: p.minimum,
      fees: stringList(p.feesJson),
      seenAt: p.seenAt,
    };
    const key = `${p.sourceId}\u0000${p.packageName}`;
    const group = groups.get(key);
    if (group) group.earlier.push(view);
    else groups.set(key, { sourceId: p.sourceId, sourceName, packageName: p.packageName, latest: view, earlier: [] });
  }
  return [...groups.values()];
}
