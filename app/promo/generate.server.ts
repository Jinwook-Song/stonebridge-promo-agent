import type Anthropic from "@anthropic-ai/sdk";
import { and, eq, max, ne, sql } from "drizzle-orm";
import { drafts, posts } from "../../database/schema";
import type { Db } from "../server/db";
import { DomainError } from "../server/errors";
import { GenerationError, makeClaudeCalls, makeFakeClaudeCalls, type DraftCall, type RewriteCall } from "./claude.server";
import { signImageUrl } from "./image-url";
import { getPost } from "./posts.server";
import { buildSystem, buildUserContent, pickExampleSet, type ImageSource } from "./prompt";
import { getSettings } from "./settings.server";
import { CHANNEL_LABELS, CHANNELS, type Channel } from "./types";

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
 * `final: false` is for a Workflow attempt that will be retried: a transient error then leaves
 * the post "generating" (so 다시 시도 stays blocked while the retry is pending) instead of
 * showing a failure that the retry may still fix.
 */
export type RunOptions = { final?: boolean };

const RETRY_LATER = "잠시 후 다시 시도해 주세요.";
const START_FAILED = "초안 만들기를 시작하지 못했어요. 잠시 후 다시 시도해 주세요.";

// ---- Runners (called inside the Workflow step) ----------------------------

export async function runGeneration(deps: GenDeps, postId: number, opts: RunOptions = {}): Promise<void> {
  const { db } = deps;
  try {
    const { view, system, user } = await prepare(deps, postId);
    const { output, inputTokens, outputTokens } = await deps.drafts({ system, user });

    const at = deps.now().toISOString();
    const next = await nextVersions(db, postId);
    const row = (channel: Channel, title: string | null, body: string, hashtags: string | null = null) => ({
      postId: view.post.id,
      channel,
      version: next[channel],
      title,
      body,
      hashtags,
      source: "ai" as const,
      createdAt: at,
    });
    await db.batch([
      db.insert(drafts).values([
        row("blog", output.blog.title, output.blog.body),
        row("instagram", null, output.instagram.body, hashtagsJson(output.instagram.hashtags)),
        row("daangn", output.daangn.title, output.daangn.body),
        row("place", null, output.place.body),
      ]),
      db
        .update(posts)
        .set({ status: "ready", rewritingChannel: null, error: null, generatedAt: at, inputTokens, outputTokens })
        .where(eq(posts.id, postId)),
    ]);
  } catch (e) {
    await handleFailure(db, postId, "failed", e, opts);
  }
}

export async function runRewrite(
  deps: GenDeps,
  postId: number,
  channel: Channel,
  instruction: string,
  opts: RunOptions = {},
): Promise<void> {
  const { db } = deps;
  try {
    const { view, system, user } = await prepare(deps, postId);
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

    const next = await nextVersions(db, postId);
    await db.batch([
      db.insert(drafts).values({
        postId,
        channel,
        version: next[channel],
        // Keep only the parts this channel has.
        title: channel === "blog" || channel === "daangn" ? (output.title ?? current?.title ?? null) : null,
        body: output.body,
        hashtags: channel === "instagram" ? hashtagsJson(output.hashtags ?? []) : null,
        source: "ai",
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
        .where(eq(posts.id, postId)),
    ]);
  } catch (e) {
    // The other drafts are still there, so a failed rewrite goes back to "ready" with the reason.
    await handleFailure(db, postId, "ready", e, opts);
  }
}

async function prepare(deps: GenDeps, postId: number) {
  const view = await getPost(deps.db, postId);
  if (!view) throw new DomainError("NOT_FOUND", "글을 찾을 수 없어요.");
  const [settings, examples, sources] = await Promise.all([
    getSettings(deps.db),
    pickExampleSet(deps.db, view.post.kind),
    // getPost returns photos in position order.
    Promise.all(view.photos.map((p) => deps.photoSource(p.r2Key))),
  ]);
  const system = buildSystem(settings, examples);
  const user: Anthropic.ContentBlockParam[] = buildUserContent(view.post, sources);
  return { view, system, user };
}

/**
 * GenerationError: final — record the reason and return, so the Workflow does not retry.
 * Anything else: record a generic reason on the last attempt, then rethrow so the Workflow
 * step retries it (or ends errored).
 */
async function handleFailure(
  db: Db,
  postId: number,
  status: "failed" | "ready",
  e: unknown,
  opts: RunOptions,
): Promise<void> {
  if (e instanceof GenerationError) {
    await markFailed(db, postId, status, e.message);
    return;
  }
  console.error("generation failed", { postId, error: e });
  if (opts.final !== false) await markFailed(db, postId, status, RETRY_LATER);
  throw e;
}

async function markFailed(db: Db, postId: number, status: "failed" | "ready", message: string): Promise<void> {
  await db.update(posts).set({ status, error: message, rewritingChannel: null }).where(eq(posts.id, postId));
}

/**
 * Last resort for the Workflow (step timed out or every retry failed): if the post is still
 * "generating", show the failure so it is not stuck behind a spinner.
 */
export async function failIfStillGenerating(db: Db, postId: number, rewrite: boolean): Promise<void> {
  await db
    .update(posts)
    .set({ status: rewrite ? "ready" : "failed", error: RETRY_LATER, rewritingChannel: null })
    .where(and(eq(posts.id, postId), eq(posts.status, "generating")));
}

async function nextVersions(db: Db, postId: number): Promise<Record<Channel, number>> {
  const rows = await db
    .select({ channel: drafts.channel, version: max(drafts.version) })
    .from(drafts)
    .where(eq(drafts.postId, postId))
    .groupBy(drafts.channel);
  const next = Object.fromEntries(CHANNELS.map((c) => [c, 1])) as Record<Channel, number>;
  for (const r of rows) next[r.channel] = (r.version ?? 0) + 1;
  return next;
}

function hashtagsJson(tags: string[]): string {
  return JSON.stringify(tags.map((t) => t.trim().replace(/^#+/, "").trim()).filter((t) => t.length > 0));
}

// ---- Start (called from route actions) ------------------------------------

/**
 * Marks the post "generating" and starts the Workflow. One SQL statement claims the post, so a
 * double tap cannot start two runs. If the Workflow cannot be created, the post is put back
 * (failed, or ready for a rewrite) with a Korean reason instead of throwing, so the caller can
 * just go on to the post page.
 */
export async function startGeneration(
  env: Pick<Env, "GENERATE">,
  db: Db,
  postId: number,
  job: { channel?: Channel; instruction?: string },
): Promise<void> {
  const claimed = await db
    .update(posts)
    .set({ status: "generating", rewritingChannel: job.channel ?? null, error: null })
    .where(and(eq(posts.id, postId), ne(posts.status, "generating")))
    .returning({ id: posts.id });
  if (claimed.length === 0) {
    const [exists] = await db.select({ id: posts.id }).from(posts).where(eq(posts.id, postId));
    if (!exists) throw new DomainError("NOT_FOUND", "글을 찾을 수 없어요.");
    throw new DomainError("BUSY", "이미 만드는 중이에요.");
  }

  const id = `post-${postId}-${Date.now()}`;
  const params: GenerateParams = { postId, ...job };
  try {
    await env.GENERATE.create({ id, params });
  } catch (e) {
    console.error("could not start generation workflow", { postId, error: e });
    await markFailed(db, postId, job.channel ? "ready" : "failed", START_FAILED);
    return;
  }
  await db.update(posts).set({ workflowId: id }).where(eq(posts.id, postId));
}

// ---- Real dependencies ----------------------------------------------------

/**
 * Production (https origin): short-lived signed URLs, so Claude fetches the photos itself.
 * Local dev: Claude cannot reach localhost, so read the photo from R2 and send base64.
 */
export function makePhotoSource(
  env: { PUBLIC_ORIGIN: string; IMAGE_URL_SECRET: string; PHOTOS: R2Bucket },
  now: () => Date,
): (key: string) => Promise<ImageSource> {
  return async (key) => {
    if (env.PUBLIC_ORIGIN.startsWith("https://")) {
      return { type: "url", url: await signImageUrl(env.PUBLIC_ORIGIN, key, env.IMAGE_URL_SECRET, now()) };
    }
    const object = await env.PHOTOS.get(key);
    if (!object) throw new Error(`photo missing in R2: ${key}`);
    // Uploads are always re-encoded to JPEG by the browser (posts.server.ts).
    return { type: "base64", media_type: "image/jpeg", data: toBase64(new Uint8Array(await object.arrayBuffer())) };
  };
}

function toBase64(bytes: Uint8Array): string {
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
