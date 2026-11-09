import { asc, eq } from "drizzle-orm";
import { watchSources } from "../../database/schema";
import type { Db } from "../server/db";
import { DomainError } from "../server/errors";
import { WATCH_KINDS, type WatchKind } from "./types";

export type WatchSource = typeof watchSources.$inferSelect;

export type WatchSourceInput = {
  id?: number;
  name: string;
  kind: WatchKind;
  url: string;
  memo: string;
  enabled: boolean;
};

export async function listWatchSources(db: Db): Promise<WatchSource[]> {
  return db.select().from(watchSources).orderBy(asc(watchSources.id));
}

/** The URL as typed (trimmed) if it is http(s). */
function checkedUrl(raw: string): string {
  const text = raw.trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new DomainError("INVALID_INPUT", "주소를 http:// 또는 https://로 시작하게 적어 주세요.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new DomainError("INVALID_INPUT", "주소를 http:// 또는 https://로 시작하게 적어 주세요.");
  }
  return text;
}

/** Run state that belongs to one URL; cleared when the URL or kind changes. */
const FRESH_RUN_STATE = { lastSeenKey: null, lastRunAt: null, lastStatus: null, lastError: null, contentHash: null };

export async function saveWatchSource(db: Db, input: WatchSourceInput, now: Date): Promise<number> {
  const name = input.name.trim();
  if (name === "") throw new DomainError("INVALID_INPUT", "이름을 적어 주세요.");
  if (!(WATCH_KINDS as readonly string[]).includes(input.kind)) {
    throw new DomainError("INVALID_INPUT", "종류가 올바르지 않아요.");
  }
  const values = { name, kind: input.kind, url: checkedUrl(input.url), memo: input.memo.trim(), enabled: input.enabled };

  if (input.id === undefined) {
    const [row] = await db
      .insert(watchSources)
      .values({ ...values, createdAt: now.toISOString() })
      .returning({ id: watchSources.id });
    if (!row) throw new Error("watch source insert returned no row");
    return row.id;
  }

  const [current] = await db
    .select({ url: watchSources.url, kind: watchSources.kind })
    .from(watchSources)
    .where(eq(watchSources.id, input.id));
  if (!current) throw new DomainError("NOT_FOUND", "감시 출처를 찾을 수 없어요.");
  const moved = current.url !== values.url || current.kind !== values.kind;
  const updated = await db
    .update(watchSources)
    .set(moved ? { ...values, ...FRESH_RUN_STATE } : values)
    .where(eq(watchSources.id, input.id))
    .returning({ id: watchSources.id });
  if (updated.length === 0) throw new DomainError("NOT_FOUND", "감시 출처를 찾을 수 없어요.");
  return input.id;
}

/** Its stored events and prices go with it (foreign keys cascade). */
export async function deleteWatchSource(db: Db, id: number): Promise<void> {
  await db.delete(watchSources).where(eq(watchSources.id, id));
}
