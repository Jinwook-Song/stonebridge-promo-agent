import { and, eq, gte, lte } from "drizzle-orm";
import { demoCalls } from "../../database/schema";
import type { Db } from "../server/db";

/**
 * The public demo (wrangler env.demo, DEMO = "1"): anyone can open it without a login, so every
 * AI call is capped. The owner's app has DEMO = "0" and never reaches this code.
 */
export function isDemo(env: { DEMO?: string }): boolean {
  return env.DEMO === "1";
}

export type DemoCallKind = "post" | "quote" | "photo_pick";

/** Whole demo, per KST day and per rolling hour. About $0.1 a call, so at most ~$4 a day. */
export const DEMO_DAILY_LIMIT = 40;
export const DEMO_HOURLY_LIMIT = 12;

export const DEMO_LIMIT_MESSAGE =
  `데모는 AI를 1시간에 ${DEMO_HOURLY_LIMIT}번, 하루에 ${DEMO_DAILY_LIMIT}번까지 불러요. 잠시 뒤에 다시 써 보세요.`;

const HOUR_MS = 60 * 60_000;
const KST_MS = 9 * HOUR_MS;

/** Start of the KST calendar day that `now` falls in, as a UTC instant. */
export function kstDayStart(now: Date): Date {
  const kst = new Date(now.getTime() + KST_MS);
  return new Date(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate()) - KST_MS);
}

/**
 * Takes one AI call from the demo's allowance. Records the call first, then counts the rows up
 * to and including it (as attemptLogin does), so parallel requests cannot all slip under the
 * cap. A call over the cap is removed again and `false` comes back: the caller shows
 * DEMO_LIMIT_MESSAGE instead of calling Claude.
 */
export async function takeDemoCall(db: Db, kind: DemoCallKind, now: Date): Promise<boolean> {
  const [row] = await db
    .insert(demoCalls)
    .values({ kind, at: now.toISOString() })
    .returning({ id: demoCalls.id });

  const countSince = async (since: Date) =>
    (
      await db
        .select({ id: demoCalls.id })
        .from(demoCalls)
        .where(and(gte(demoCalls.at, since.toISOString()), lte(demoCalls.id, row.id)))
    ).length;

  const hourAgo = new Date(now.getTime() - HOUR_MS);
  const dayStart = kstDayStart(now);
  if ((await countSince(hourAgo)) > DEMO_HOURLY_LIMIT || (await countSince(dayStart)) > DEMO_DAILY_LIMIT) {
    await db.delete(demoCalls).where(eq(demoCalls.id, row.id));
    return false;
  }
  return true;
}
