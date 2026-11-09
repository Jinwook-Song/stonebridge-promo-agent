import type Anthropic from "@anthropic-ai/sdk";
import { and, eq, exists, isNull, lt, ne, or, sql } from "drizzle-orm";
import { drafts, photos, posts } from "../../database/schema";
import type { Db } from "../server/db";
import { DomainError } from "../server/errors";
import {
  GenerationError,
  makeClaudeCalls,
  makeFakeClaudeCalls,
  permanentApiFailure,
  type DraftCall,
  type RewriteCall,
} from "./claude.server";
import { normalizeHashtags } from "./draft-text";
import { signImageUrl } from "./image-url";
import { getPost, type PostView } from "./posts.server";
import { buildSystem, buildUserContent, pickExampleSet, type ImageSource } from "./prompt";
import { getSettings } from "./settings.server";
import { CHANNEL_LABELS, type Channel } from "./types";

/** Workflow instance params (workers/generate-workflow.ts). No channel = all four channels. */
export type GenerateParams = { postId: number; channel?: Channel; instruction?: string };

export type GenDeps = {
  db: Db;
  drafts: DraftCall;
  rewrite: RewriteCall;
  /** Image source for a photo's R2 key, in the shape Claude takes. */
  photoSource: (key: string) => Promise<ImageSource>;
  now: () => Date;
};

/**
 * One generation run: the post plus the Workflow instance that claimed it (startGeneration
 * stores the instance id as posts.workflow_id). Every write is conditional on the post still
 * being "generating" under this id, so a late or superseded run cannot overwrite a newer one.
 */
export type RunRef = { postId: number; workflowId: string };

/**
 * `final: false` is for a Workflow attempt that will be retried: a transient error then leaves
 * the post "generating" (so 다시 시도 stays blocked while the retry is pending) instead of
 * showing a failure that the retry may still fix.
 */
export type RunOptions = { final?: boolean };

/** Workflow attempts are 1-based: with `limit` retries, attempt limit+1 is the last one. */
export function isFinalAttempt(attempt: number, retryLimit: number): boolean {
  return attempt > retryLimit;
}

const RETRY_LATER = "잠시 후 다시 시도해 주세요.";
const START_FAILED = "초안 만들기를 시작하지 못했어요. 잠시 후 다시 시도해 주세요.";

// ---- Workflow step timing (workers/generate-workflow.ts uses these) ------

/** Retries after the first attempt. */
export const STEP_RETRY_LIMIT = 2;
/** First retry delay; exponential backoff doubles it each time (10 s, 20 s). */
export const STEP_RETRY_DELAY_SECONDS = 10;
/**
 * Per attempt. One streamed call with high effort and max_tokens 64000 (thinking included) can
 * run well past 10 minutes on a long blog draft.
 */
export const STEP_TIMEOUT_MINUTES = 15;

/** Worst case for one run: every attempt times out, plus every retry delay. */
const RUN_MAX_MS =
  (STEP_RETRY_LIMIT + 1) * STEP_TIMEOUT_MINUTES * 60_000 +
  Array.from({ length: STEP_RETRY_LIMIT }, (_, i) => STEP_RETRY_DELAY_SECONDS * 2 ** i * 1000).reduce((a, b) => a + b, 0);

/**
 * A "generating" claim older than this belongs to a dead run and may be taken over. Longer than
 * RUN_MAX_MS (45 min 30 s) plus a margin for Workflow scheduling: 50 min 30 s.
 */
export const STALE_CLAIM_MS = RUN_MAX_MS + 5 * 60_000;

// ---- Runners (called inside the Workflow step) ----------------------------

/**
 * True only when this run's final write made the post "ready" (drafts saved), so the caller can
 * announce it. False when the run was skipped, superseded, or failed.
 */
export async function runGeneration(deps: GenDeps, run: RunRef, opts: RunOptions = {}): Promise<boolean> {
  const { db } = deps;
  try {
    const view = await ownedPost(db, run);
    if (!view) return false;
    const { system, user } = await prepare(deps, view);
    const { output, inputTokens, outputTokens } = await deps.drafts({ system, user });

    const at = deps.now().toISOString();
    const draft = (channel: Channel, title: string | null, body: string, hashtags: string | null = null) =>
      insertDraftIfOwned(db, run, { channel, title, body, hashtags, createdAt: at });
    const results = await db.batch([
      draft("blog", output.blog.title, output.blog.body),
      draft("instagram", null, output.instagram.body, hashtagsJson(output.instagram.hashtags)),
      draft("daangn", output.daangn.title, output.daangn.body),
      draft("place", null, output.place.body),
      setPhotoNotesIfOwned(db, run, output.photos),
      db
        .update(posts)
        .set({ status: "ready", rewritingChannel: null, error: null, generatedAt: at, inputTokens, outputTokens })
        .where(owned(run))
        .returning({ id: posts.id }),
    ]);
    // Empty when the run was superseded while Claude was writing (nothing was saved either).
    return results[5].length > 0;
  } catch (e) {
    await handleFailure(db, run, "failed", e, opts);
    return false;
  }
}

export async function runRewrite(
  deps: GenDeps,
  run: RunRef,
  channel: Channel,
  instruction: string,
  opts: RunOptions = {},
): Promise<void> {
  const { db } = deps;
  try {
    const view = await ownedPost(db, run);
    if (!view) return;
    const { system, user } = await prepare(deps, view);
    const current = view.drafts[channel];
    const currentText = [
      current?.title ? `제목: ${current.title}` : null,
      current?.body ?? "(없음)",
      current?.hashtags ? `해시태그: ${(JSON.parse(current.hashtags) as string[]).join(" ")}` : null,
    ]
      .filter((line) => line !== null)
      .join("\n");
    const ask =
      `현재 ${CHANNEL_LABELS[channel]} 초안:\n${currentText}\n\n` +
      `사장님 요청: ${instruction.trim() || "다시 써 주세요"}\n이 채널 글만 다시 쓰세요.`;

    const { output, inputTokens, outputTokens } = await deps.rewrite({
      system,
      user: [...user, { type: "text", text: ask }],
    });

    await db.batch([
      insertDraftIfOwned(db, run, {
        channel,
        // Keep only the parts this channel has. A missing title or missing tags keep the current
        // ones: "더 짧게" should not wipe her hashtags.
        title: channel === "blog" || channel === "daangn" ? (output.title ?? current?.title ?? null) : null,
        body: output.body,
        hashtags: channel === "instagram" ? rewrittenHashtags(output.hashtags, current?.hashtags ?? null) : null,
        createdAt: deps.now().toISOString(),
      }),
      db
        .update(posts)
        .set({
          status: "ready",
          rewritingChannel: null,
          error: null,
          inputTokens: sql`coalesce(${posts.inputTokens}, 0) + ${inputTokens}`,
          outputTokens: sql`coalesce(${posts.outputTokens}, 0) + ${outputTokens}`,
        })
        .where(owned(run)),
    ]);
  } catch (e) {
    // The other drafts are still there, so a failed rewrite goes back to "ready" with the reason.
    await handleFailure(db, run, "ready", e, opts);
  }
}

function owned(run: RunRef) {
  return and(eq(posts.id, run.postId), eq(posts.workflowId, run.workflowId), eq(posts.status, "generating"));
}

/**
 * The post, if this run still owns it. A retried step whose earlier attempt already finished,
 * or a run superseded by a newer one, gets null and does nothing (no Claude call).
 */
async function ownedPost(db: Db, run: RunRef) {
  const view = await getPost(db, run.postId);
  if (view && view.post.status === "generating" && view.post.workflowId === run.workflowId) return view;
  console.warn("generation run no longer owns the post, skipping", run);
  return null;
}

/** Next version for the channel; inserts nothing unless the run still owns the post. */
function insertDraftIfOwned(
  db: Db,
  run: RunRef,
  d: { channel: Channel; title: string | null; body: string; hashtags: string | null; createdAt: string },
) {
  const nextVersion = sql<number>`(SELECT coalesce(max(${drafts.version}), 0) + 1 FROM ${drafts}
    WHERE ${drafts.postId} = ${run.postId} AND ${drafts.channel} = ${d.channel})`;
  // insert…select needs every column, in table order. id NULL = next rowid.
  return db.insert(drafts).select(
    db
      .select({
        id: sql<number>`NULL`.as("id"),
        postId: posts.id,
        channel: sql<Channel>`${d.channel}`.as("channel"),
        version: nextVersion.as("version"),
        title: sql<string | null>`${d.title}`.as("title"),
        body: sql<string>`${d.body}`.as("body"),
        hashtags: sql<string | null>`${d.hashtags}`.as("hashtags"),
        source: sql<"ai">`'ai'`.as("source"),
        confirmedAt: sql<string | null>`NULL`.as("confirmed_at"),
        editRatio: sql<number | null>`NULL`.as("edit_ratio"),
        createdAt: sql<string>`${d.createdAt}`.as("created_at"),
      })
      .from(posts)
      .where(owned(run)),
  );
}

/**
 * Replaces every photo's note with this generation's (n is the 1-based position). Notes for
 * positions that do not exist are ignored; photos without a note get NULL.
 */
function setPhotoNotesIfOwned(db: Db, run: RunRef, notes: { n: number; note: string }[]) {
  const cases = notes.map(({ n, note }) => sql`WHEN ${n} THEN ${note}`);
  const note =
    cases.length > 0 ? sql<string | null>`CASE ${photos.position} ${sql.join(cases, sql` `)} ELSE NULL END` : null;
  return db
    .update(photos)
    .set({ note })
    .where(and(eq(photos.postId, run.postId), exists(db.select({ one: sql`1` }).from(posts).where(owned(run)))));
}

async function prepare(deps: GenDeps, view: PostView) {
  const [settings, examples, sources] = await Promise.all([
    getSettings(deps.db),
    pickExampleSet(deps.db, view.post.kind),
    // getPost returns photos in position order.
    Promise.all(view.photos.map((p) => deps.photoSource(p.r2Key))),
  ]);
  const system = buildSystem(settings, examples);
  const user: Anthropic.ContentBlockParam[] = buildUserContent(view.post, sources);
  return { system, user };
}

/**
 * GenerationError: final — record the reason and return, so the Workflow does not retry.
 * Permanent API error (bad key, bad request): record its reason now and rethrow; the Workflow
 * turns it into a NonRetryableError.
 * Anything else: record a generic reason on the last attempt, then rethrow so the Workflow
 * step retries it (or ends errored).
 */
async function handleFailure(
  db: Db,
  run: RunRef,
  status: "failed" | "ready",
  e: unknown,
  opts: RunOptions,
): Promise<void> {
  if (e instanceof GenerationError) {
    await markFailed(db, run, status, e.message);
    return;
  }
  console.error("generation failed", { ...run, error: e });
  const permanent = permanentApiFailure(e);
  if (permanent) await markFailed(db, run, status, permanent.message);
  else if (opts.final !== false) await markFailed(db, run, status, RETRY_LATER);
  throw e;
}

async function markFailed(db: Db, run: RunRef, status: "failed" | "ready", message: string): Promise<void> {
  await db.update(posts).set({ status, error: message, rewritingChannel: null }).where(owned(run));
}

/**
 * Last resort for the Workflow (step timed out or every retry failed): if this run still owns
 * the post, show the failure so it is not stuck behind a spinner.
 */
export async function failIfStillGenerating(db: Db, run: RunRef, rewrite: boolean): Promise<void> {
  await markFailed(db, run, rewrite ? "ready" : "failed", RETRY_LATER);
}

function hashtagsJson(tags: string[]): string {
  return JSON.stringify(normalizeHashtags(tags));
}

/** New tags replace the current ones; null, [] or only blank tags keep them (stored JSON as is). */
function rewrittenHashtags(tags: string[] | null, currentJson: string | null): string {
  const clean = normalizeHashtags(tags ?? []);
  if (clean.length > 0) return JSON.stringify(clean);
  return currentJson ?? hashtagsJson([]);
}

// ---- Start (called from route actions) ------------------------------------

/**
 * Marks the post "generating" under a new Workflow instance id and starts that instance. One SQL
 * statement claims the post, so a double tap cannot start two runs; a claim older than
 * STALE_CLAIM_MS is treated as dead and can be taken over. If the Workflow cannot be created, the post is put
 * back (failed, or ready for a rewrite) with a Korean reason instead of throwing, so the caller
 * can just go on to the post page.
 */
export async function startGeneration(
  env: Pick<Env, "GENERATE">,
  db: Db,
  postId: number,
  job: { channel?: Channel; instruction?: string },
  now: Date = new Date(),
): Promise<void> {
  const run: RunRef = { postId, workflowId: `post-${postId}-${now.getTime()}` };
  const staleBefore = new Date(now.getTime() - STALE_CLAIM_MS).toISOString();
  const claimed = await db
    .update(posts)
    .set({
      status: "generating",
      rewritingChannel: job.channel ?? null,
      error: null,
      workflowId: run.workflowId,
      generationStartedAt: now.toISOString(),
    })
    .where(
      and(
        eq(posts.id, postId),
        or(
          ne(posts.status, "generating"),
          isNull(posts.generationStartedAt),
          lt(posts.generationStartedAt, staleBefore),
        ),
      ),
    )
    .returning({ id: posts.id });
  if (claimed.length === 0) {
    const [exists] = await db.select({ id: posts.id }).from(posts).where(eq(posts.id, postId));
    if (!exists) throw new DomainError("NOT_FOUND", "글을 찾을 수 없어요.");
    throw new DomainError("BUSY", "이미 만드는 중이에요.");
  }

  const params: GenerateParams = { postId, ...job };
  try {
    await env.GENERATE.create({ id: run.workflowId, params });
  } catch (e) {
    console.error("could not start generation workflow", { ...run, error: e });
    await markFailed(db, run, job.channel ? "ready" : "failed", START_FAILED);
  }
}

// ---- Real dependencies ----------------------------------------------------

/**
 * Production (https origin): short-lived signed URLs, so Claude fetches the photos itself.
 * Local dev: Claude cannot reach localhost, so read the photo from R2 and send base64.
 * An https origin that is still the wrangler.jsonc placeholder (an `example` host) or is not a
 * valid URL would send Claude dead links, and the API's 400 would tell the owner to change her
 * photos; fail the run at once with an admin message instead (GenerationError: not retried).
 */
export function makePhotoSource(
  env: { PUBLIC_ORIGIN: string; IMAGE_URL_SECRET: string; PHOTOS: R2Bucket },
  now: () => Date,
): (key: string) => Promise<ImageSource> {
  return async (key) => {
    if (env.PUBLIC_ORIGIN.startsWith("https://")) {
      if (!isUsableOrigin(env.PUBLIC_ORIGIN)) throw new GenerationError("public_origin");
      return { type: "url", url: await signImageUrl(env.PUBLIC_ORIGIN, key, env.IMAGE_URL_SECRET, now()) };
    }
    const object = await env.PHOTOS.get(key);
    if (!object) throw new Error(`photo missing in R2: ${key}`);
    // Uploads are always re-encoded to JPEG by the browser (posts.server.ts).
    return { type: "base64", media_type: "image/jpeg", data: toBase64(new Uint8Array(await object.arrayBuffer())) };
  };
}

function isUsableOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  return url.protocol === "https:" && url.hostname !== "" && !url.hostname.split(".").includes("example");
}

export function toBase64(bytes: Uint8Array): string {
  // Chunked: spreading a whole photo into fromCharCode overflows the call stack.
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function makeGenDeps(env: Env, db: Db): GenDeps {
  const now = () => new Date();
  // Typed as its wrangler.jsonc default ("0"); only a local .dev.vars turns it on.
  const fakeClaude: string = env.FAKE_CLAUDE;
  const calls = fakeClaude === "1" ? makeFakeClaudeCalls() : makeClaudeCalls(env.ANTHROPIC_API_KEY);
  return { db, ...calls, photoSource: makePhotoSource(env, now), now };
}
