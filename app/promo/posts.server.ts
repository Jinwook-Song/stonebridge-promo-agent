import { desc, eq } from "drizzle-orm";
import { drafts, photos, posts } from "../../database/schema";
import type { Db } from "../server/db";
import { DomainError } from "../server/errors";
import {
  CHANNELS,
  MAX_MEMO_CHARS,
  MAX_PHOTO_BYTES,
  MAX_PHOTOS,
  POST_KINDS,
  type Channel,
  type PostKind,
} from "./types";

const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];

export type NewPostInput = {
  kind: PostKind;
  memo: string;
  privateCustomer: boolean;
  attachPrices: boolean;
  photos: File[];
  /** Pixel size of each photo as measured by the browser, parallel to `photos`. */
  photoSizes?: { width: number; height: number }[];
};

export type DraftRow = typeof drafts.$inferSelect;
export type PostRow = typeof posts.$inferSelect;

export type PostView = {
  post: PostRow;
  photos: { id: number; position: number; r2Key: string; width: number; height: number }[];
  /** Latest version of each channel; null until that channel has a draft. */
  drafts: Record<Channel, DraftRow | null>;
};

function invalid(message: string): never {
  throw new DomainError("INVALID_INPUT", message);
}

function validate(input: NewPostInput): string {
  if (!(POST_KINDS as readonly string[]).includes(input.kind)) invalid("글 종류를 선택해 주세요.");
  const memo = input.memo.trim();
  if (memo.length === 0) invalid("메모를 입력해 주세요.");
  if (memo.length > MAX_MEMO_CHARS) invalid(`메모는 ${MAX_MEMO_CHARS}자까지 쓸 수 있어요.`);
  if (input.photos.length > MAX_PHOTOS) invalid(`사진은 ${MAX_PHOTOS}장까지 올릴 수 있어요.`);
  for (const file of input.photos) {
    if (!PHOTO_TYPES.includes(file.type)) invalid("사진은 JPG, PNG, WEBP 파일만 올릴 수 있어요.");
    if (file.size > MAX_PHOTO_BYTES) invalid("사진 한 장은 5MB까지 올릴 수 있어요.");
  }
  return memo;
}

/** Creates the post (status "draft") and stores its photos. Returns the new post id. */
export async function createPost(
  db: Db,
  bucket: R2Bucket,
  input: NewPostInput,
  now: Date,
): Promise<number> {
  const memo = validate(input);

  const [{ id }] = await db
    .insert(posts)
    .values({
      kind: input.kind,
      memo,
      privateCustomer: input.privateCustomer,
      attachPrices: input.attachPrices,
      status: "draft",
      createdAt: now.toISOString(),
    })
    .returning({ id: posts.id });

  const keys = input.photos.map((_, i) => `posts/${id}/${i + 1}.jpg`);
  // The client re-encodes every photo to JPEG before upload, hence the fixed .jpg key.
  // allSettled, not all: after one put fails the others keep running, and cleanup must
  // not start until every put has finished or it could miss an object written late.
  const puts = await Promise.allSettled(
    input.photos.map(async (file, i) =>
      bucket.put(keys[i], await file.arrayBuffer(), { httpMetadata: { contentType: "image/jpeg" } }),
    ),
  );
  const written = keys.filter((_, i) => puts[i].status === "fulfilled");
  const failedPut = puts.find((r): r is PromiseRejectedResult => r.status === "rejected");

  let failure: unknown = failedPut?.reason;
  if (!failedPut && keys.length > 0) {
    try {
      await db.insert(photos).values(
        keys.map((r2Key, i) => ({
          postId: id,
          r2Key,
          position: i + 1,
          width: input.photoSizes?.[i]?.width ?? 0,
          height: input.photoSizes?.[i]?.height ?? 0,
        })),
      );
    } catch (e) {
      failure = e;
    }
  }

  if (failure !== undefined) {
    console.error("createPost failed, rolling back", { postId: id, failure });
    await rollback(db, bucket, id, written);
    throw new DomainError("INVALID_FILE", "사진을 저장하지 못했어요. 잠시 후 다시 시도해 주세요.");
  }
  return id;
}

/** Removes exactly the objects that were written, then the rows. Failures are logged, never thrown. */
async function rollback(db: Db, bucket: R2Bucket, postId: number, writtenKeys: string[]): Promise<void> {
  const step = async (what: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      console.error(`createPost rollback: ${what} failed`, { postId, error: e });
    }
  };
  if (writtenKeys.length > 0) await step("R2 delete", () => bucket.delete(writtenKeys));
  await step("photo rows delete", () => db.delete(photos).where(eq(photos.postId, postId)));
  await step("post row delete", () => db.delete(posts).where(eq(posts.id, postId)));
}

export async function getPost(db: Db, id: number): Promise<PostView | null> {
  const [post] = await db.select().from(posts).where(eq(posts.id, id));
  if (!post) return null;
  const [photoRows, draftRows] = await Promise.all([
    db
      .select({
        id: photos.id,
        position: photos.position,
        r2Key: photos.r2Key,
        width: photos.width,
        height: photos.height,
      })
      .from(photos)
      .where(eq(photos.postId, id))
      .orderBy(photos.position),
    db.select().from(drafts).where(eq(drafts.postId, id)).orderBy(drafts.version),
  ]);
  const latest = Object.fromEntries(CHANNELS.map((c) => [c, null])) as Record<Channel, DraftRow | null>;
  // Ascending by version, so the last row of each channel wins.
  for (const row of draftRows) latest[row.channel] = row;
  return { post, photos: photoRows, drafts: latest };
}

export type PostListItem = {
  id: number;
  status: PostRow["status"];
  kind: PostKind;
  memoPreview: string;
  createdAt: string;
};

export async function listPosts(db: Db, limit = 50): Promise<PostListItem[]> {
  const rows = await db
    .select({ id: posts.id, status: posts.status, kind: posts.kind, memo: posts.memo, createdAt: posts.createdAt })
    .from(posts)
    .orderBy(desc(posts.createdAt), desc(posts.id))
    .limit(limit);
  return rows.map(({ memo, ...rest }) => ({ ...rest, memoPreview: [...memo].slice(0, 40).join("") }));
}
