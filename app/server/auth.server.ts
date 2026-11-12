import { and, eq, gte } from "drizzle-orm";
import { redirect } from "react-router";
import { hashPassword, verifyPassword } from "../lib/crypto";
import { loginAttempts, settings } from "../../database/schema";
import type { Db } from "./db";
import { isDemo } from "../demo/quota.server";
import { DomainError } from "./errors";
import { getOwnerSessionStorage } from "./session.server";

const HASH_KEY = "owner_password_hash";
const MAX_FAILURES = 5;
const WINDOW_MS = 10 * 60_000;
const MIN_PASSWORD_LENGTH = 8;

async function getStoredHash(db: Db): Promise<string | undefined> {
  const [row] = await db.select().from(settings).where(eq(settings.key, HASH_KEY));
  return row?.value;
}

/** Seeds the owner password from the initial secret, only if none is stored yet. */
export async function ensureOwnerPassword(db: Db, initialPassword: string): Promise<void> {
  if (await getStoredHash(db)) return;
  if (initialPassword.length < MIN_PASSWORD_LENGTH) {
    throw new DomainError(
      "INVALID_STATE",
      "OWNER_INITIAL_PASSWORD가 비어 있거나 8자 미만입니다.",
    );
  }
  const value = await hashPassword(initialPassword);
  // onConflictDoNothing: a concurrent first login must not clobber the winner
  await db.insert(settings).values({ key: HASH_KEY, value }).onConflictDoNothing();
}

export async function attemptLogin(
  db: Db,
  ip: string,
  pw: string,
  now: Date,
): Promise<boolean> {
  // Record the attempt as a failure BEFORE the slow PBKDF2 check, then count
  // (including this row). Parallel requests each see at least their own rank,
  // so at most MAX_FAILURES of them can get past the gate. Blocked attempts
  // stay recorded as failures.
  const since = new Date(now.getTime() - WINDOW_MS).toISOString();
  const [attempt] = await db
    .insert(loginAttempts)
    .values({ ip, at: now.toISOString(), ok: false })
    .returning({ id: loginAttempts.id });
  const failures = await db
    .select({ id: loginAttempts.id })
    .from(loginAttempts)
    .where(
      and(eq(loginAttempts.ip, ip), eq(loginAttempts.ok, false), gte(loginAttempts.at, since)),
    );
  if (failures.length > MAX_FAILURES) {
    throw new DomainError("RATE_LIMITED", "로그인 시도가 너무 많아요. 잠시 후 다시 시도해 주세요.");
  }

  const stored = await getStoredHash(db);
  const ok = stored ? await verifyPassword(pw, stored) : false;
  if (ok) {
    await db.update(loginAttempts).set({ ok: true }).where(eq(loginAttempts.id, attempt.id));
  }
  return ok;
}

/** Whether the request carries a valid owner session cookie. Never redirects. */
export async function isOwner(request: Request, env: Env): Promise<boolean> {
  // The public demo has no login: every visitor works as the owner of a fictional shop.
  if (isDemo(env)) return true;
  const session = await getOwnerSessionStorage(env).getSession(request.headers.get("Cookie"));
  return session.get("owner") === true;
}

export async function requireOwner(request: Request, env: Env): Promise<void> {
  if (!(await isOwner(request, env))) throw redirect("/login");
}
