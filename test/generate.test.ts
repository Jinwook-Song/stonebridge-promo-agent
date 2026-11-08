import Anthropic from "@anthropic-ai/sdk";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { drafts, photos, posts } from "../database/schema";
import {
  GenerationError,
  makeFakeClaudeCalls,
  permanentApiFailure,
  type DraftCall,
  type RewriteCall,
} from "../app/promo/claude.server";
import {
  failIfStillGenerating,
  isFinalAttempt,
  makePhotoSource,
  runGeneration,
  runRewrite,
  startGeneration,
  type GenDeps,
  type RunRef,
} from "../app/promo/generate.server";
import { verifyImageSig } from "../app/promo/image-url";
import { getPost } from "../app/promo/posts.server";
import { ChannelRewrite, DraftOutput } from "../app/promo/prompt";
import { getDb } from "../app/server/db";
import { DomainError } from "../app/server/errors";

const db = getDb(env.DB);
const T0 = new Date(Date.UTC(2026, 10, 8, 3, 0, 0));

// Synthetic drafts; no real customer data.
const OUT: DraftOutput = {
  blog: { title: "[단체 주문] 테스트 마카롱 40세트", body: "안녕하세요.\n[사진 1]\n마카롱을 포장했어요!" },
  instagram: { body: "마카롱 포장했어요!", hashtags: ["마카롱", "#단체주문"] },
  daangn: { title: "마카롱 단체 주문", body: "마카롱을 포장했어요." },
  place: { body: "마카롱 단체 주문 받아요." },
  photos: [{ n: 1, note: "포장한 마카롱" }],
};
const REWRITE: ChannelRewrite = { title: "[단체 주문] 짧게 쓴 제목", body: "짧게 다시 썼어요.", hashtags: null };

const okDrafts: DraftCall = async () => ({ output: OUT, inputTokens: 10, outputTokens: 20 });
const okRewrite: RewriteCall = async () => ({ output: REWRITE, inputTokens: 3, outputTokens: 4 });

function deps(over: Partial<GenDeps> = {}): GenDeps {
  return {
    db,
    drafts: okDrafts,
    rewrite: okRewrite,
    photoSource: async (key) => ({ type: "url", url: `https://img.test/${key}` }),
    now: () => T0,
    ...over,
  };
}

const WF = "post-test-workflow";
let postId: number;
let run: RunRef;

async function insertPost(status: "draft" | "generating" | "ready" | "failed" = "generating"): Promise<number> {
  const [{ id }] = await db
    .insert(posts)
    .values({
      kind: "case",
      memo: "테스트 마카롱 40세트",
      privateCustomer: false,
      attachPrices: false,
      status,
      workflowId: WF,
      generationStartedAt: T0.toISOString(),
      createdAt: T0.toISOString(),
    })
    .returning({ id: posts.id });
  return id;
}

async function row(id = postId) {
  const [r] = await db.select().from(posts).where(eq(posts.id, id));
  return r;
}

function fakeEnv(create = vi.fn(async ({ id }: { id?: string }) => ({ id }))) {
  return { GENERATE: { create } as unknown as Env["GENERATE"] };
}

beforeEach(async () => {
  await db.delete(drafts);
  await db.delete(photos);
  await db.delete(posts);
  postId = await insertPost("generating");
  run = { postId, workflowId: WF };
});

/** Puts the post back into "generating" under this test's run, as startGeneration would. */
async function claim(rewritingChannel: "blog" | "instagram" | "daangn" | "place" | null = null) {
  await db.update(posts).set({ status: "generating", rewritingChannel, workflowId: WF }).where(eq(posts.id, postId));
}

describe("runGeneration", () => {
  it("saves 4 drafts and marks ready", async () => {
    await runGeneration(deps(), run);
    const v = await getPost(db, postId);
    expect(v!.post.status).toBe("ready");
    expect(v!.post.error).toBeNull();
    expect(v!.post.inputTokens).toBe(10);
    expect(v!.post.outputTokens).toBe(20);
    expect(v!.post.generatedAt).toBe(T0.toISOString());
    expect(Object.values(v!.drafts).every((d) => d?.version === 1 && d.source === "ai")).toBe(true);
    expect(v!.drafts.blog!.title).toBe(OUT.blog.title);
    expect(v!.drafts.blog!.body).toBe(OUT.blog.body);
    expect(v!.drafts.daangn!.title).toBe(OUT.daangn.title);
    expect(v!.drafts.place!.title).toBeNull();
    expect(v!.drafts.place!.hashtags).toBeNull();
    // Stored without a leading '#', as a JSON array.
    expect(JSON.parse(v!.drafts.instagram!.hashtags!)).toEqual(["마카롱", "단체주문"]);
  });

  it("adds the next version when run again", async () => {
    await runGeneration(deps(), run);
    await claim();
    await runGeneration(deps(), run);
    const v = await getPost(db, postId);
    expect(Object.values(v!.drafts).every((d) => d?.version === 2)).toBe(true);
  });

  it("refusal marks failed with Korean reason and does not throw", async () => {
    await runGeneration(
      deps({
        drafts: async () => {
          throw new GenerationError("refusal");
        },
      }),
      run,
    );
    const v = await getPost(db, postId);
    expect(v!.post.status).toBe("failed");
    expect(v!.post.error).toContain("거절");
    expect(Object.values(v!.drafts).every((d) => d === null)).toBe(true);
  });

  it("transient error marks failed and rethrows for workflow retry", async () => {
    await expect(
      runGeneration(
        deps({
          drafts: async () => {
            throw new Error("ECONNRESET");
          },
        }),
        run,
      ),
    ).rejects.toThrow("ECONNRESET");
    const r = await row();
    expect(r.status).toBe("failed");
    expect(r.error).toBe("잠시 후 다시 시도해 주세요.");
  });

  it("on a non-final attempt a transient error rethrows but leaves the post generating", async () => {
    await expect(
      runGeneration(
        deps({
          drafts: async () => {
            throw new Error("ECONNRESET");
          },
        }),
        run,
        { final: false },
      ),
    ).rejects.toThrow("ECONNRESET");
    const r = await row();
    expect(r.status).toBe("generating");
    expect(r.error).toBeNull();
  });

  it("passes photo blocks from photoSource in position order", async () => {
    // Inserted out of order on purpose.
    await db.insert(photos).values([
      { postId, r2Key: `posts/${postId}/2.jpg`, position: 2, width: 1, height: 1 },
      { postId, r2Key: `posts/${postId}/1.jpg`, position: 1, width: 1, height: 1 },
    ]);
    const seen: Anthropic.ContentBlockParam[][] = [];
    await runGeneration(
      deps({
        drafts: async ({ user }) => {
          seen.push(user);
          return { output: OUT, inputTokens: 1, outputTokens: 1 };
        },
      }),
      run,
    );
    const images = seen[0].filter((b): b is Anthropic.ImageBlockParam => b.type === "image");
    expect(images.map((b) => b.source)).toEqual([
      { type: "url", url: `https://img.test/posts/${postId}/1.jpg` },
      { type: "url", url: `https://img.test/posts/${postId}/2.jpg` },
    ]);
  });
});

describe("runGeneration ownership and notes", () => {
  it("stores photo notes by position, ignores out-of-range n, and clears notes it does not mention", async () => {
    await db.insert(photos).values([
      { postId, r2Key: `posts/${postId}/1.jpg`, position: 1, width: 1, height: 1 },
      { postId, r2Key: `posts/${postId}/2.jpg`, position: 2, width: 1, height: 1, note: "이전 설명" },
    ]);
    const out = { ...OUT, photos: [{ n: 1, note: "포장한 마카롱" }, { n: 9, note: "없는 사진" }] };
    await runGeneration(deps({ drafts: async () => ({ output: out, inputTokens: 1, outputTokens: 1 }) }), run);
    const v = await getPost(db, postId);
    expect(v!.photos.map((p) => p.note)).toEqual(["포장한 마카롱", null]);
  });

  it("a rewrite leaves photo notes alone", async () => {
    await db.insert(photos).values([{ postId, r2Key: `posts/${postId}/1.jpg`, position: 1, width: 1, height: 1 }]);
    await runGeneration(deps(), run);
    await claim("blog");
    await runRewrite(deps(), run, "blog", "");
    expect((await getPost(db, postId))!.photos[0].note).toBe("포장한 마카롱");
  });

  it("does nothing (no Claude call) when the post is not generating under this run", async () => {
    const drafts = vi.fn(okDrafts);
    await runGeneration(deps({ drafts }), { postId, workflowId: "some-older-run" });
    await db.update(posts).set({ status: "ready" }).where(eq(posts.id, postId));
    await runGeneration(deps({ drafts }), run);
    expect(drafts).not.toHaveBeenCalled();
    expect((await getPost(db, postId))!.drafts.blog).toBeNull();
  });

  it("a run superseded while Claude was writing writes nothing", async () => {
    await db.insert(photos).values([{ postId, r2Key: `posts/${postId}/1.jpg`, position: 1, width: 1, height: 1 }]);
    const supersede = () => db.update(posts).set({ workflowId: "post-newer-run" }).where(eq(posts.id, postId));
    await runGeneration(
      deps({
        drafts: async () => {
          await supersede();
          return { output: OUT, inputTokens: 10, outputTokens: 20 };
        },
      }),
      run,
    );
    let v = await getPost(db, postId);
    expect(Object.values(v!.drafts).every((d) => d === null)).toBe(true);
    expect(v!.photos[0].note).toBeNull();
    expect(v!.post).toMatchObject({ status: "generating", workflowId: "post-newer-run", inputTokens: null });

    // Failures of the stale run do not touch the newer one either.
    await runGeneration(
      deps({
        drafts: async () => {
          throw new GenerationError("refusal");
        },
      }),
      { postId, workflowId: WF },
    );
    v = await getPost(db, postId);
    expect(v!.post).toMatchObject({ status: "generating", error: null });
  });

  it("a superseded rewrite writes nothing", async () => {
    await runGeneration(deps(), run);
    await claim("blog");
    await runRewrite(
      deps({
        rewrite: async () => {
          await db.update(posts).set({ workflowId: "post-newer-run" }).where(eq(posts.id, postId));
          return { output: REWRITE, inputTokens: 3, outputTokens: 4 };
        },
      }),
      run,
      "blog",
      "",
    );
    const v = await getPost(db, postId);
    expect(v!.drafts.blog!.version).toBe(1);
    expect(v!.post).toMatchObject({ status: "generating", rewritingChannel: "blog" });
  });

  it("a permanent API error marks failed with its own reason even on a non-final attempt, and rethrows", async () => {
    const unauthorized = Anthropic.APIError.generate(401, { type: "error" }, "invalid x-api-key", new Headers());
    await expect(
      runGeneration(
        deps({
          drafts: async () => {
            throw unauthorized;
          },
        }),
        run,
        { final: false },
      ),
    ).rejects.toBe(unauthorized);
    const r = await row();
    expect(r.status).toBe("failed");
    expect(r.error).toBe("AI 연결 설정에 문제가 있어요. 관리자에게 알려 주세요.");
  });
});

describe("failIfStillGenerating", () => {
  it("fails a post this run still owns (ready for a rewrite)", async () => {
    await failIfStillGenerating(db, run, false);
    expect(await row()).toMatchObject({ status: "failed", error: "잠시 후 다시 시도해 주세요." });

    await claim("blog");
    await failIfStillGenerating(db, run, true);
    expect(await row()).toMatchObject({ status: "ready", rewritingChannel: null, error: "잠시 후 다시 시도해 주세요." });
  });

  it("leaves a post alone that is no longer generating or belongs to a newer run", async () => {
    await failIfStillGenerating(db, { postId, workflowId: "post-older-run" }, false);
    expect(await row()).toMatchObject({ status: "generating", error: null });

    await db.update(posts).set({ status: "ready" }).where(eq(posts.id, postId));
    await failIfStillGenerating(db, run, false);
    expect(await row()).toMatchObject({ status: "ready", error: null });
  });
});

describe("isFinalAttempt", () => {
  it("maps 1-based attempts to the last one", () => {
    expect([1, 2, 3].map((a) => isFinalAttempt(a, 2))).toEqual([false, false, true]);
    expect(isFinalAttempt(1, 0)).toBe(true);
  });
});

describe("permanentApiFailure", () => {
  const apiError = (status: number) => Anthropic.APIError.generate(status, { type: "error" }, "x", new Headers());

  it("treats key and request problems as permanent, with Korean reasons", () => {
    for (const status of [401, 403]) {
      expect(permanentApiFailure(apiError(status))?.message).toBe("AI 연결 설정에 문제가 있어요. 관리자에게 알려 주세요.");
    }
    for (const status of [400, 413, 422]) {
      expect(permanentApiFailure(apiError(status))?.message).toBe(
        "AI가 요청을 처리하지 못했어요. 사진 수를 줄이거나 메모를 바꿔 다시 시도해 주세요.",
      );
    }
    expect(permanentApiFailure(apiError(404))?.message).toBe("잠시 후 다시 시도해 주세요.");
  });

  it("leaves timeouts, conflicts, rate limits, server errors and non-API errors to retries", () => {
    for (const status of [408, 409, 429, 500, 529]) expect(permanentApiFailure(apiError(status))).toBeNull();
    expect(permanentApiFailure(new Anthropic.APIConnectionError({ message: "reset" }))).toBeNull();
    expect(permanentApiFailure(new Error("ECONNRESET"))).toBeNull();
    expect(permanentApiFailure(new GenerationError("refusal"))).toBeNull();
  });
});

describe("runRewrite", () => {
  it("adds version 2 for one channel only", async () => {
    await runGeneration(deps(), run);
    await claim("blog");

    let user: Anthropic.ContentBlockParam[] = [];
    await runRewrite(
      deps({
        rewrite: async (req) => {
          user = req.user;
          return { output: REWRITE, inputTokens: 3, outputTokens: 4 };
        },
      }),
      run,
      "blog",
      "더 짧게",
    );

    const v = await getPost(db, postId);
    expect(v!.post.status).toBe("ready");
    expect(v!.post.rewritingChannel).toBeNull();
    expect(v!.drafts.blog!.version).toBe(2);
    expect(v!.drafts.blog!.title).toBe(REWRITE.title);
    expect(v!.drafts.blog!.body).toBe(REWRITE.body);
    expect(v!.drafts.instagram!.version).toBe(1);
    expect(v!.drafts.daangn!.version).toBe(1);
    expect(v!.drafts.place!.version).toBe(1);
    // Token counts add up across calls.
    expect(v!.post.inputTokens).toBe(13);
    expect(v!.post.outputTokens).toBe(24);

    const last = JSON.stringify(user.at(-1));
    expect(last).toContain("현재 블로그 초안:");
    expect(last).toContain(OUT.blog.body.replace(/\n/g, "\\n"));
    expect(last).toContain("사장님 요청: 더 짧게");
    expect(last).toContain("이 채널 글만 다시 쓰세요.");
  });

  it("uses a default request when the instruction is empty", async () => {
    await runGeneration(deps(), run);
    await claim("place");
    let user: Anthropic.ContentBlockParam[] = [];
    await runRewrite(
      deps({
        rewrite: async (req) => {
          user = req.user;
          return { output: REWRITE, inputTokens: 1, outputTokens: 1 };
        },
      }),
      run,
      "place",
      "  ",
    );
    expect(JSON.stringify(user.at(-1))).toContain("사장님 요청: 다시 써 주세요");
    const v = await getPost(db, postId);
    // Titles and hashtags are kept only where the channel has them.
    expect(v!.drafts.place!.title).toBeNull();
  });

  it("on refusal keeps the drafts, goes back to ready with the reason, clears the rewriting channel", async () => {
    await runGeneration(deps(), run);
    await claim("instagram");
    await runRewrite(
      deps({
        rewrite: async () => {
          throw new GenerationError("refusal");
        },
      }),
      run,
      "instagram",
      "",
    );
    const v = await getPost(db, postId);
    expect(v!.post.status).toBe("ready");
    expect(v!.post.error).toContain("거절");
    expect(v!.post.rewritingChannel).toBeNull();
    expect(v!.drafts.instagram!.version).toBe(1);
  });

  it("transient error on the final attempt clears the rewriting channel and rethrows", async () => {
    await runGeneration(deps(), run);
    await claim("daangn");
    await expect(
      runRewrite(
        deps({
          rewrite: async () => {
            throw new Error("socket hang up");
          },
        }),
        run,
        "daangn",
        "",
      ),
    ).rejects.toThrow();
    const r = await row();
    expect(r.status).toBe("ready");
    expect(r.rewritingChannel).toBeNull();
    expect(r.error).toBe("잠시 후 다시 시도해 주세요.");
  });
});

describe("startGeneration", () => {
  it("refuses while generating", async () => {
    const id = await insertPost("draft");
    const e = fakeEnv();
    await startGeneration(e, db, id, {});
    await expect(startGeneration(e, db, id, {})).rejects.toThrow("이미 만드는 중");
    await expect(startGeneration(e, db, id, {})).rejects.toBeInstanceOf(DomainError);
    expect(e.GENERATE.create).toHaveBeenCalledTimes(1);
  });

  it("marks generating, starts the workflow with the job and stores its id", async () => {
    const id = await insertPost("failed");
    await db.update(posts).set({ error: "이전 오류" }).where(eq(posts.id, id));
    const e = fakeEnv();
    await startGeneration(e, db, id, { channel: "blog", instruction: "더 짧게" });

    const call = vi.mocked(e.GENERATE.create).mock.calls[0][0]!;
    expect(call.params).toEqual({ postId: id, channel: "blog", instruction: "더 짧게" });
    expect(call.id).toMatch(new RegExp(`^post-${id}-\\d+$`));
    const r = await row(id);
    expect(r.status).toBe("generating");
    expect(r.rewritingChannel).toBe("blog");
    expect(r.error).toBeNull();
    expect(r.workflowId).toBe(call.id);
  });

  it("does not leave the post stuck when the workflow cannot start", async () => {
    const id = await insertPost("draft");
    const create = vi.fn(async () => {
      throw new Error("workflow service down");
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await startGeneration(fakeEnv(create), db, id, {});
    spy.mockRestore();
    const r = await row(id);
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/[가-힣]/);
    expect(r.rewritingChannel).toBeNull();
  });

  it("a rewrite that cannot start goes back to ready", async () => {
    const id = await insertPost("ready");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await startGeneration(
      fakeEnv(
        vi.fn(async () => {
          throw new Error("workflow service down");
        }),
      ),
      db,
      id,
      { channel: "place" },
    );
    spy.mockRestore();
    const r = await row(id);
    expect(r.status).toBe("ready");
    expect(r.rewritingChannel).toBeNull();
    expect(r.error).toMatch(/[가-힣]/);
  });

  it("stores the instance id on the post before creating the instance", async () => {
    const id = await insertPost("draft");
    const create = vi.fn(async ({ id: instanceId }: { id?: string }) => {
      expect((await row(id)).workflowId).toBe(instanceId);
      return { id: instanceId };
    });
    await startGeneration(fakeEnv(create), db, id, {}, T0);
    expect(create).toHaveBeenCalledTimes(1);
    expect(await row(id)).toMatchObject({ workflowId: `post-${id}-${T0.getTime()}`, generationStartedAt: T0.toISOString() });
  });

  it("takes over a claim older than 40 minutes, not a younger one", async () => {
    const id = await insertPost("draft");
    const e = fakeEnv();
    const after = (min: number) => new Date(T0.getTime() + min * 60_000);
    await startGeneration(e, db, id, {}, T0);
    await expect(startGeneration(e, db, id, {}, after(39))).rejects.toThrow("이미 만드는 중");
    await startGeneration(e, db, id, { channel: "blog" }, after(41));
    expect(e.GENERATE.create).toHaveBeenCalledTimes(2);
    expect(await row(id)).toMatchObject({
      status: "generating",
      rewritingChannel: "blog",
      workflowId: `post-${id}-${after(41).getTime()}`,
      generationStartedAt: after(41).toISOString(),
    });
  });

  it("throws NOT_FOUND for a missing post", async () => {
    const err = await startGeneration(fakeEnv(), db, 999_999, {}).catch((e) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect(err.code).toBe("NOT_FOUND");
  });
});

describe("makePhotoSource", () => {
  const key = "posts/1/1.jpg";

  it("gives signed https urls in production", async () => {
    const source = makePhotoSource(
      { PUBLIC_ORIGIN: "https://promo.test", IMAGE_URL_SECRET: env.IMAGE_URL_SECRET, PHOTOS: env.PHOTOS },
      () => T0,
    );
    const s = await source(key);
    expect(s.type).toBe("url");
    const url = new URL((s as { url: string }).url);
    expect(url.origin + url.pathname).toBe(`https://promo.test/img/${key}`);
    expect(
      await verifyImageSig(key, url.searchParams.get("exp")!, url.searchParams.get("sig")!, env.IMAGE_URL_SECRET, T0),
    ).toBe(true);
  });

  it("reads base64 from R2 when the origin is not https (local dev)", async () => {
    // Bigger than one encoding chunk, to cover the chunked path.
    const bytes = Uint8Array.from({ length: 100_000 }, (_, i) => i % 251);
    await env.PHOTOS.put(key, bytes);
    const source = makePhotoSource(
      { PUBLIC_ORIGIN: "http://localhost:5173", IMAGE_URL_SECRET: env.IMAGE_URL_SECRET, PHOTOS: env.PHOTOS },
      () => T0,
    );
    const s = await source(key);
    expect(s).toMatchObject({ type: "base64", media_type: "image/jpeg" });
    const decoded = Uint8Array.from(atob((s as { data: string }).data), (c) => c.charCodeAt(0));
    expect(decoded).toEqual(bytes);
    await env.PHOTOS.delete(key);
  });
});

describe("makeFakeClaudeCalls", () => {
  it("returns outputs that satisfy the schemas", async () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakeClaudeCalls();
      const d = fake.drafts({ system: "", user: [] });
      const r = fake.rewrite({ system: "", user: [] });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(DraftOutput.safeParse((await d).output).success).toBe(true);
      expect(ChannelRewrite.safeParse((await r).output).success).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
