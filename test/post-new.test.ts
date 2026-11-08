import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { drafts, photos, posts } from "../database/schema";
import { action } from "../app/routes/post-new";
import { getDb } from "../app/server/db";

const db = getDb(env.DB);

beforeEach(async () => {
  await db.delete(drafts);
  await db.delete(photos);
  await db.delete(posts);
});

describe("post-new action", () => {
  it("still redirects to the created post when the generation start throws", async () => {
    // Fail startGeneration's claim UPDATE the way a brief D1 outage would; createPost's own
    // statements go through. (vi.mock of the module does not work in the workers pool.)
    const prepare = env.DB.prepare.bind(env.DB);
    const prepareSpy = vi.spyOn(env.DB, "prepare").mockImplementation((query: string) => {
      if (/^update "posts"/i.test(query) && query.includes('"generation_started_at"')) throw new Error("D1 unavailable");
      return prepare(query);
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const form = new FormData();
    form.set("kind", "case");
    form.set("memo", "테스트 메모");
    const request = new Request("http://localhost/posts/new", { method: "POST", body: form });
    try {
      const res = await action({ request, params: {}, context: {} } as never);
      const all = await db.select({ id: posts.id, status: posts.status }).from(posts);
      expect(all).toEqual([{ id: all[0].id, status: "draft" }]);
      expect(res).toBeInstanceOf(Response);
      expect((res as Response).status).toBe(302);
      expect((res as Response).headers.get("Location")).toBe(`/posts/${all[0].id}`);
      expect(errorSpy).toHaveBeenCalledWith("startGeneration failed after createPost", expect.anything());
    } finally {
      prepareSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
