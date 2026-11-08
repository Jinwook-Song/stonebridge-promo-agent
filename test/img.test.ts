import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signImageUrl } from "../app/promo/image-url";
import { serveImage } from "../app/promo/serve-image.server";
import { getOwnerSessionStorage } from "../app/server/session.server";

const T0 = new Date(Date.UTC(2026, 10, 8, 3, 0, 0));
const KEY = "posts/901/1.jpg";
const OTHER = "posts/901/2.jpg";
const MISSING = "posts/901/3.jpg";

async function signedRequest(key: string, now = T0, signKey = key) {
  const url = new URL(await signImageUrl("https://x.dev", signKey, env.IMAGE_URL_SECRET, now));
  return new Request(`https://x.dev/img/${key}${url.search}`);
}

async function ownerCookie() {
  const storage = getOwnerSessionStorage(env);
  const session = await storage.getSession();
  session.set("owner", true);
  return (await storage.commitSession(session)).split(";")[0];
}

beforeAll(async () => {
  await env.PHOTOS.put(KEY, new Uint8Array([1, 2, 3]));
  await env.PHOTOS.put(OTHER, new Uint8Array([4]));
});
afterAll(async () => {
  await env.PHOTOS.delete([KEY, OTHER]);
});

describe("serveImage", () => {
  it("403 without signature or session", async () => {
    const res = await serveImage(new Request(`https://x.dev/img/${KEY}`), env, KEY, T0);
    expect(res.status).toBe(403);
  });

  it("200 for a valid signature, with image headers", async () => {
    const res = await serveImage(await signedRequest(KEY), env, KEY, T0);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=600");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("403 for a signature made for a different key", async () => {
    const req = await signedRequest(KEY, T0, OTHER);
    expect((await serveImage(req, env, KEY, T0)).status).toBe(403);
  });

  it("403 for an expired signature", async () => {
    const req = await signedRequest(KEY);
    const later = new Date(T0.getTime() + 601_000);
    expect((await serveImage(req, env, KEY, later)).status).toBe(403);
  });

  it("200 for the owner without a signature", async () => {
    const req = new Request(`https://x.dev/img/${KEY}`, { headers: { Cookie: await ownerCookie() } });
    expect((await serveImage(req, env, KEY, T0)).status).toBe(200);
  });

  it.each(["posts/1/1.png", "../secrets", "posts/1/1.jpg/extra", "posts/a/1.jpg", ""])(
    "404 for key outside the photo pattern: %j",
    async (key) => {
      const req = new Request(`https://x.dev/img/${key}`, { headers: { Cookie: await ownerCookie() } });
      expect((await serveImage(req, env, key, T0)).status).toBe(404);
    },
  );

  it("404 for a valid signature when the object is missing", async () => {
    expect((await serveImage(await signedRequest(MISSING), env, MISSING, T0)).status).toBe(404);
  });
});
