import type Anthropic from "@anthropic-ai/sdk";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { drafts, photos, posts } from "../database/schema";
import { GenerationError, makeFakeClaudeCalls, type DraftCall, type RewriteCall } from "../app/promo/claude.server";
import {
  makePhotoSource,
  runGeneration,
  runRewrite,
  startGeneration,
  type GenDeps,
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

let postId: number;

async function insertPost(status: "draft" | "generating" | "ready" | "failed" = "generating"): Promise<number> {
  const [{ id }] = await db
    .insert(posts)
    .values({
      kind: "case",
      memo: "테스트 마카롱 40세트",
      privateCustomer: false,
      attachPrices: false,
      status,
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
});

describe("runGeneration", () => {
  it("saves 4 drafts and marks ready", async () => {
    await runGeneration(deps(), postId);
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
    await runGeneration(deps(), postId);
    await runGeneration(deps(), postId);
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
      postId,
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
        postId,
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
        postId,
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
      postId,
    );
    const images = seen[0].filter((b): b is Anthropic.ImageBlockParam => b.type === "image");
    expect(images.map((b) => b.source)).toEqual([
      { type: "url", url: `https://img.test/posts/${postId}/1.jpg` },
      { type: "url", url: `https://img.test/posts/${postId}/2.jpg` },
    ]);
  });
});

describe("runRewrite", () => {
  it("adds version 2 for one channel only", async () => {
    await runGeneration(deps(), postId);
    await db.update(posts).set({ status: "generating", rewritingChannel: "blog" }).where(eq(posts.id, postId));

    let user: Anthropic.ContentBlockParam[] = [];
    await runRewrite(
      deps({
        rewrite: async (req) => {
          user = req.user;
          return { output: REWRITE, inputTokens: 3, outputTokens: 4 };
        },
      }),
      postId,
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
    await runGeneration(deps(), postId);
    let user: Anthropic.ContentBlockParam[] = [];
    await runRewrite(
      deps({
        rewrite: async (req) => {
          user = req.user;
          return { output: REWRITE, inputTokens: 1, outputTokens: 1 };
        },
      }),
      postId,
      "place",
      "  ",
    );
    expect(JSON.stringify(user.at(-1))).toContain("사장님 요청: 다시 써 주세요");
    const v = await getPost(db, postId);
    // Titles and hashtags are kept only where the channel has them.
    expect(v!.drafts.place!.title).toBeNull();
  });

  it("on refusal keeps the drafts, goes back to ready with the reason, clears the rewriting channel", async () => {
    await runGeneration(deps(), postId);
    await db.update(posts).set({ status: "generating", rewritingChannel: "instagram" }).where(eq(posts.id, postId));
    await runRewrite(
      deps({
        rewrite: async () => {
          throw new GenerationError("refusal");
        },
      }),
      postId,
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
    await runGeneration(deps(), postId);
    await db.update(posts).set({ status: "generating", rewritingChannel: "daangn" }).where(eq(posts.id, postId));
    await expect(
      runRewrite(
        deps({
          rewrite: async () => {
            throw new Error("socket hang up");
          },
        }),
        postId,
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
