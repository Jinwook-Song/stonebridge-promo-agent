import { describe, expect, it } from "vitest";
import { hashPassword, randomToken, safeEqual, verifyPassword } from "../app/lib/crypto";

describe("password hashing", () => {
  it("verifies the right password and rejects the wrong one", async () => {
    const h = await hashPassword("pw12345678");
    expect(h.startsWith("pbkdf2$100000$")).toBe(true);
    expect(await verifyPassword("pw12345678", h)).toBe(true);
    expect(await verifyPassword("x", h)).toBe(false);
  });

  it("returns false for malformed stored hashes", async () => {
    expect(await verifyPassword("x", "garbage")).toBe(false);
  });
});

describe("randomToken", () => {
  it("is 43 chars of base64url", () => {
    const t = randomToken();
    expect(t).toHaveLength(43);
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("safeEqual", () => {
  it("compares strings, including different lengths", () => {
    expect(safeEqual("930129", "930129")).toBe(true);
    expect(safeEqual("930129", "93012")).toBe(false);
  });
});
