import { describe, expect, it } from "vitest";
import { signImageUrl, verifyImageSig } from "../app/promo/image-url";

const SECRET = "test-image-url-secret-0123456789-abcdef";
const T0 = new Date(Date.UTC(2026, 10, 8, 3, 0, 0));

async function signed(key = "posts/1/1.jpg", now = T0) {
  const url = new URL(await signImageUrl("https://x.dev", key, SECRET, now));
  return { url, exp: url.searchParams.get("exp")!, sig: url.searchParams.get("sig")! };
}

describe("image url signing", () => {
  it("signed url verifies until expiry", async () => {
    const { url, exp, sig } = await signed();
    expect(url.origin + url.pathname).toBe("https://x.dev/img/posts/1/1.jpg");
    expect(await verifyImageSig("posts/1/1.jpg", exp, sig, SECRET, T0)).toBe(true);
    expect(await verifyImageSig("posts/1/2.jpg", exp, sig, SECRET, T0)).toBe(false);
    expect(
      await verifyImageSig("posts/1/1.jpg", exp, sig, SECRET, new Date(T0.getTime() + 601_000)),
    ).toBe(false);
  });

  it("is valid right up to the ttl and honours a custom ttl", async () => {
    const { exp, sig } = await signed();
    expect(
      await verifyImageSig("posts/1/1.jpg", exp, sig, SECRET, new Date(T0.getTime() + 599_000)),
    ).toBe(true);
    const short = new URL(await signImageUrl("https://x.dev", "k.jpg", SECRET, T0, 30));
    const e = short.searchParams.get("exp")!;
    const s = short.searchParams.get("sig")!;
    expect(await verifyImageSig("k.jpg", e, s, SECRET, new Date(T0.getTime() + 29_000))).toBe(true);
    expect(await verifyImageSig("k.jpg", e, s, SECRET, new Date(T0.getTime() + 31_000))).toBe(false);
  });

  it("rejects a wrong secret, tampered exp, garbage and missing params", async () => {
    const { exp, sig } = await signed();
    expect(await verifyImageSig("posts/1/1.jpg", exp, sig, "another-secret-0123456789-abcdefgh", T0)).toBe(false);
    expect(await verifyImageSig("posts/1/1.jpg", String(Number(exp) + 3600), sig, SECRET, T0)).toBe(false);
    expect(await verifyImageSig("posts/1/1.jpg", exp, "%%%not-base64%%%", SECRET, T0)).toBe(false);
    expect(await verifyImageSig("posts/1/1.jpg", exp, "", SECRET, T0)).toBe(false);
    expect(await verifyImageSig("posts/1/1.jpg", "", sig, SECRET, T0)).toBe(false);
    expect(await verifyImageSig("posts/1/1.jpg", "abc", sig, SECRET, T0)).toBe(false);
    expect(await verifyImageSig("posts/1/1.jpg", "1e20", sig, SECRET, T0)).toBe(false);
  });
});
