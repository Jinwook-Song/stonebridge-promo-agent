import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { loginAttempts, settings } from "../database/schema";
import { attemptLogin, ensureOwnerPassword, isOwner, requireOwner } from "../app/server/auth.server";
import { getDb } from "../app/server/db";
import { getOwnerSessionStorage } from "../app/server/session.server";
import { DomainError } from "../app/server/errors";

const db = getDb(env.DB);
const now = new Date("2026-11-01T03:00:00Z");
const PW = "init-pass-1";

async function storedHash() {
  const [row] = await db.select().from(settings).where(eq(settings.key, "owner_password_hash"));
  return row?.value;
}

async function rateLimited(p: Promise<unknown>) {
  const err = await p.then(
    () => null,
    (e) => e,
  );
  expect(err).toBeInstanceOf(DomainError);
  expect((err as DomainError).code).toBe("RATE_LIMITED");
}

beforeEach(async () => {
  await db.delete(loginAttempts);
  await db.delete(settings).where(eq(settings.key, "owner_password_hash"));
});

describe("owner login", () => {
  it("accepts the initial password after ensureOwnerPassword", async () => {
    await ensureOwnerPassword(db, PW);
    expect(await attemptLogin(db, "1.1.1.1", PW, now)).toBe(true);
  });

  it("does not overwrite an existing hash on a second ensure", async () => {
    await ensureOwnerPassword(db, PW);
    const first = await storedHash();
    await ensureOwnerPassword(db, "other-pass-2");
    expect(await storedHash()).toBe(first);
    expect(await attemptLogin(db, "1.1.1.1", PW, now)).toBe(true);
  });

  it("rejects wrong passwords", async () => {
    await ensureOwnerPassword(db, PW);
    expect(await attemptLogin(db, "1.1.1.1", "nope", now)).toBe(false);
  });

  it("blocks the 6th attempt after 5 failures, even with the right password", async () => {
    await ensureOwnerPassword(db, PW);
    for (let i = 0; i < 5; i++) {
      expect(await attemptLogin(db, "2.2.2.2", "wrong", now)).toBe(false);
    }
    await rateLimited(attemptLogin(db, "2.2.2.2", PW, now));
  });

  it("allows login again 11 minutes later", async () => {
    await ensureOwnerPassword(db, PW);
    for (let i = 0; i < 5; i++) await attemptLogin(db, "2.2.2.2", "wrong", now);
    const later = new Date(now.getTime() + 11 * 60_000);
    expect(await attemptLogin(db, "2.2.2.2", PW, later)).toBe(true);
  });

  it("does not affect other IPs", async () => {
    await ensureOwnerPassword(db, PW);
    for (let i = 0; i < 5; i++) await attemptLogin(db, "2.2.2.2", "wrong", now);
    expect(await attemptLogin(db, "3.3.3.3", PW, now)).toBe(true);
  });
});

describe("rate limit under concurrency", () => {
  it("blocks a correct password after 8 parallel wrong attempts, recording every attempt", async () => {
    await ensureOwnerPassword(db, PW);
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => attemptLogin(db, "5.5.5.5", "wrong", now)),
    );
    expect(results.filter((r) => r.status === "rejected")).not.toHaveLength(0);
    await rateLimited(attemptLogin(db, "5.5.5.5", PW, now));
    const rows = await db.select().from(loginAttempts).where(eq(loginAttempts.ip, "5.5.5.5"));
    expect(rows).toHaveLength(9);
    expect(rows.some((r) => r.ok)).toBe(false);
  });

  it("records a successful login as ok=true", async () => {
    await ensureOwnerPassword(db, PW);
    await attemptLogin(db, "6.6.6.6", PW, now);
    const rows = await db.select().from(loginAttempts).where(eq(loginAttempts.ip, "6.6.6.6"));
    expect(rows.map((r) => r.ok)).toEqual([true]);
  });
});

describe("ensureOwnerPassword validation", () => {
  it.each(["", "short"])("rejects initial password %j with INVALID_STATE", async (bad) => {
    await expect(ensureOwnerPassword(db, bad)).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(await storedHash()).toBeUndefined();
  });
});

describe("requireOwner / isOwner", () => {
  const fakeEnv = { SESSION_SECRET: "test-secret-0123456789-0123456789-abcdef" } as Env;

  async function ownerCookie() {
    const storage = getOwnerSessionStorage(fakeEnv);
    const session = await storage.getSession();
    session.set("owner", true);
    return (await storage.commitSession(session)).split(";")[0];
  }

  async function redirected(p: Promise<unknown>) {
    const res = await p.then(
      () => null,
      (e) => e,
    );
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(302);
    expect((res as Response).headers.get("Location")).toBe("/login");
  }

  it("redirects requests without a session", async () => {
    await redirected(requireOwner(new Request("http://x/"), fakeEnv));
  });

  it("redirects requests with a tampered cookie", async () => {
    const cookie = (await ownerCookie()).replace(/.$/, "A");
    await redirected(requireOwner(new Request("http://x/", { headers: { Cookie: cookie } }), fakeEnv));
  });

  it("lets an owner session through", async () => {
    const req = new Request("http://x/", { headers: { Cookie: await ownerCookie() } });
    await expect(requireOwner(req, fakeEnv)).resolves.toBeUndefined();
  });

  it("isOwner is true with a logged-in cookie", async () => {
    const req = new Request("http://x/", { headers: { Cookie: await ownerCookie() } });
    expect(await isOwner(req, fakeEnv)).toBe(true);
  });

  it("isOwner is false without a cookie or with a tampered one, and never redirects", async () => {
    expect(await isOwner(new Request("http://x/"), fakeEnv)).toBe(false);
    const cookie = (await ownerCookie()).replace(/.$/, "A");
    expect(await isOwner(new Request("http://x/", { headers: { Cookie: cookie } }), fakeEnv)).toBe(false);
  });

  it("layout exports a middleware that guards child loaders and actions", async () => {
    const { middleware } = await import("../app/routes/owner-layout");
    expect(middleware).toHaveLength(1);
    const next = async () => new Response();
    // child data request and child action POST, both unauthenticated
    for (const req of [
      new Request("http://x/posts.data?_routes=routes%2Fposts"),
      new Request("http://x/posts", { method: "POST", body: new FormData() }),
      // AI photo pick: spends Claude tokens, so an anonymous POST must never reach its action
      new Request("http://x/api/photo-pick", { method: "POST", body: new FormData() }),
    ]) {
      await redirected(Promise.resolve(middleware[0]({ request: req, params: {}, context: {} } as never, next)));
    }
    // The cold dynamic import above already takes ~4.5s while the pool runs every file at once, so the
    // default 5s limit flakes; give it room.
  }, 20_000);
});

describe("session secret validation", () => {
  it.each([undefined, "", "too-short-secret"])("rejects SESSION_SECRET %j", (secret) => {
    expect(() => getOwnerSessionStorage({ SESSION_SECRET: secret } as Env)).toThrow(/SESSION_SECRET/);
  });
});
