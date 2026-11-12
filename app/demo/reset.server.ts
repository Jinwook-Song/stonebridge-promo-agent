import { isDemo } from "./quota.server";
import { seedPhotoKeys, seedStatements, type DemoSeed } from "./seed-sql";

export type { DemoSeed };

/**
 * Puts the public demo back to its sample data: one D1 batch (a single transaction) wipes and
 * reinserts, then visitor photos are removed from R2. Refuses to run outside the demo, since it
 * empties the owner's tables otherwise.
 */
export async function resetDemo(
  env: { DEMO?: string; DB: D1Database; PHOTOS: R2Bucket },
  seed: DemoSeed,
): Promise<{ statements: number; photosDeleted: number }> {
  if (!isDemo(env)) throw new Error("resetDemo runs only in the demo (DEMO=1)");
  const statements = seedStatements(seed);
  await env.DB.batch(statements.map((s) => env.DB.prepare(s.sql).bind(...s.params)));

  const keep = seedPhotoKeys(seed);
  let photosDeleted = 0;
  let cursor: string | undefined;
  do {
    const page = await env.PHOTOS.list({ cursor, limit: 1000 });
    const stale = page.objects.map((o) => o.key).filter((k) => !keep.has(k));
    if (stale.length > 0) {
      await env.PHOTOS.delete(stale);
      photosDeleted += stale.length;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  return { statements: statements.length, photosDeleted };
}
