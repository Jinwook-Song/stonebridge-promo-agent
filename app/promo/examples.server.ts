import { desc, eq, sql } from "drizzle-orm";
import { examples } from "../../database/schema";
import type { Db } from "../server/db";
import { DomainError } from "../server/errors";
import type { Channel, ExampleSource, PostKind } from "./types";

export type Example = {
  id: number;
  channel: Channel;
  kind: PostKind;
  title: string | null;
  body: string;
  source: ExampleSource;
};

export type ExampleRow = Example & { enabled: boolean };

const columns = {
  id: examples.id,
  channel: examples.channel,
  kind: examples.kind,
  title: examples.title,
  body: examples.body,
  source: examples.source,
};

/**
 * Few-shot examples for a channel: the owner's confirmed finals before imported blog posts,
 * then same-kind before other kinds, newest first. Disabled examples never appear.
 */
export async function pickExamples(
  db: Db,
  channel: Channel,
  kind: PostKind,
  limit: number,
): Promise<Example[]> {
  if (limit <= 0) return [];
  return db
    .select(columns)
    .from(examples)
    .where(sql`${examples.channel} = ${channel} AND ${examples.enabled} = 1`)
    .orderBy(
      sql`${examples.source} = 'owner_final' DESC`,
      sql`${examples.kind} = ${kind} DESC`,
      desc(examples.createdAt),
      desc(examples.id),
    )
    .limit(limit);
}

export async function addExample(
  db: Db,
  ex: Omit<Example, "id"> & { sourceUrl?: string },
  now: Date,
): Promise<number> {
  const [row] = await db
    .insert(examples)
    .values({
      channel: ex.channel,
      kind: ex.kind,
      title: ex.title,
      body: ex.body,
      source: ex.source,
      sourceUrl: ex.sourceUrl ?? null,
      createdAt: now.toISOString(),
    })
    .returning({ id: examples.id });
  return row.id;
}

async function updateExample(db: Db, id: number, set: { enabled: boolean } | { kind: PostKind }) {
  const rows = await db.update(examples).set(set).where(eq(examples.id, id)).returning({ id: examples.id });
  if (rows.length === 0) throw new DomainError("NOT_FOUND", "예시를 찾을 수 없습니다.");
}

export function setExampleEnabled(db: Db, id: number, enabled: boolean): Promise<void> {
  return updateExample(db, id, { enabled });
}

export function setExampleKind(db: Db, id: number, kind: PostKind): Promise<void> {
  return updateExample(db, id, { kind });
}

export async function listExamples(db: Db): Promise<ExampleRow[]> {
  return db
    .select({ ...columns, enabled: examples.enabled })
    .from(examples)
    .orderBy(desc(examples.createdAt), desc(examples.id));
}
