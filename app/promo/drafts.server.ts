import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import { drafts, posts } from "../../database/schema";
import type { Db } from "../server/db";
import { DomainError } from "../server/errors";
import { HAS_TITLE, normalizeHashtags } from "./draft-text";
import { editRatio } from "./edit-ratio";
import { addExample } from "./examples.server";
import type { DraftRow, PostRow } from "./posts.server";
import type { Channel } from "./types";

export type DraftPatch = { title?: string | null; body: string; hashtags?: string[] | null };

export type PostStatusView = Pick<PostRow, "status" | "error" | "rewritingChannel">;

const notFound = () => new DomainError("NOT_FOUND", "글을 찾을 수 없어요.");
const busy = () => new DomainError("BUSY", "이미 만드는 중이에요.");

async function latestDraft(db: Db, postId: number, channel: Channel): Promise<DraftRow | undefined> {
  const [row] = await db
    .select()
    .from(drafts)
    .where(and(eq(drafts.postId, postId), eq(drafts.channel, channel)))
    .orderBy(desc(drafts.version))
    .limit(1);
  return row;
}

/** A full generation, or a rewrite of this channel, will write this channel's next version. */
function isBusy(post: Pick<PostRow, "status" | "rewritingChannel">, channel: Channel): boolean {
  return post.status === "generating" && (post.rewritingChannel === null || post.rewritingChannel === channel);
}

async function loadForWrite(db: Db, postId: number, channel: Channel) {
  const [post] = await db.select().from(posts).where(eq(posts.id, postId));
  if (!post) throw notFound();
  if (isBusy(post, channel)) throw busy();
  const latest = await latestDraft(db, postId, channel);
  if (!latest) throw notFound();
  return { post, latest };
}

/** SQL condition: the post is not generating anything that would write this channel. */
function notBusySql(postId: number, channel: Channel) {
  return sql`NOT EXISTS (SELECT 1 FROM ${posts} WHERE ${posts.id} = ${postId} AND ${posts.status} = 'generating'
    AND (${posts.rewritingChannel} IS NULL OR ${posts.rewritingChannel} = ${channel}))`;
}

/**
 * Saves the owner's edit as the channel's next version (source "edit"). Returns the version that
 * now holds this text: the current one if nothing changed. Title and hashtags left undefined keep
 * the current values; channels without them always store null.
 */
export async function saveDraftEdit(
  db: Db,
  postId: number,
  channel: Channel,
  patch: DraftPatch,
  now: Date,
): Promise<number> {
  // Retried when another save (a blur autosave racing 확정) lands first: compare against that one.
  for (let attempt = 0; attempt < 3; attempt++) {
    const { latest } = await loadForWrite(db, postId, channel);
    const next = {
      title: HAS_TITLE[channel] ? (patch.title === undefined ? latest.title : patch.title?.trim() || null) : null,
      body: patch.body,
      hashtags:
        channel === "instagram"
          ? JSON.stringify(normalizeHashtags(patch.hashtags ?? (latest.hashtags ? JSON.parse(latest.hashtags) : [])))
          : null,
    };
    const current = {
      title: latest.title,
      body: latest.body,
      hashtags: latest.hashtags === null ? null : JSON.stringify(normalizeHashtags(JSON.parse(latest.hashtags))),
    };
    if (next.title === current.title && next.body === current.body && next.hashtags === current.hashtags) {
      return latest.version;
    }

    // Insert version+1 only if `latest` is still the latest and nothing is generating this
    // channel, in one statement, so a concurrent save or a starting rewrite cannot interleave.
    const inserted = await db
      .insert(drafts)
      .select(
        db
          .select({
            id: sql<number>`NULL`.as("id"),
            postId: drafts.postId,
            channel: drafts.channel,
            version: sql<number>`${drafts.version} + 1`.as("version"),
            title: sql<string | null>`${next.title}`.as("title"),
            body: sql<string>`${next.body}`.as("body"),
            hashtags: sql<string | null>`${next.hashtags}`.as("hashtags"),
            source: sql<"edit">`'edit'`.as("source"),
            confirmedAt: sql<string | null>`NULL`.as("confirmed_at"),
            editRatio: sql<number | null>`NULL`.as("edit_ratio"),
            createdAt: sql<string>`${now.toISOString()}`.as("created_at"),
          })
          .from(drafts)
          .where(
            and(
              eq(drafts.id, latest.id),
              sql`NOT EXISTS (SELECT 1 FROM ${drafts} AS newer WHERE newer.post_id = ${postId}
                AND newer.channel = ${channel} AND newer.version > ${latest.version})`,
              notBusySql(postId, channel),
            ),
          ),
      )
      .returning({ version: drafts.version });
    if (inserted.length > 0) return inserted[0].version;
  }
  throw new DomainError("INVALID_STATE", "저장하지 못했어요. 다시 시도해 주세요.");
}

/**
 * Marks the channel's latest version as the owner's final: stores how much she changed it
 * against the first AI version, and adds it to the examples as "owner_final". Confirming a
 * version that is already confirmed does nothing.
 */
export async function confirmDraft(db: Db, postId: number, channel: Channel, now: Date): Promise<void> {
  const { post, latest } = await loadForWrite(db, postId, channel);
  if (latest.confirmedAt) return;
  const [firstAi] = await db
    .select({ body: drafts.body })
    .from(drafts)
    .where(and(eq(drafts.postId, postId), eq(drafts.channel, channel), eq(drafts.source, "ai")))
    .orderBy(asc(drafts.version))
    .limit(1);

  // Conditional on still being unconfirmed, so two confirms at once add one example.
  const claimed = await db
    .update(drafts)
    .set({ confirmedAt: now.toISOString(), editRatio: editRatio(firstAi?.body ?? latest.body, latest.body) })
    .where(and(eq(drafts.id, latest.id), sql`${drafts.confirmedAt} IS NULL`))
    .returning({ id: drafts.id });
  if (claimed.length === 0) return;

  await addExample(
    db,
    { channel, kind: post.kind, title: latest.title, body: latest.body, source: "owner_final" },
    now,
  );
}

/** Dismisses a leftover error (a failed one-channel rewrite). A failed post keeps its reason. */
export async function clearPostError(db: Db, postId: number): Promise<void> {
  await db
    .update(posts)
    .set({ error: null })
    .where(and(eq(posts.id, postId), ne(posts.status, "failed"), sql`${posts.error} IS NOT NULL`));
}

export async function getPostStatus(db: Db, postId: number): Promise<PostStatusView | null> {
  const [row] = await db
    .select({ status: posts.status, error: posts.error, rewritingChannel: posts.rewritingChannel })
    .from(posts)
    .where(eq(posts.id, postId));
  return row ?? null;
}
