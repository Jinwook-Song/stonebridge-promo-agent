/** Rows per table, columns by their SQL names. Values are what D1 stores (booleans as 0/1). */
export type DemoSeed = Record<string, Record<string, string | number | null>[]>;

/** Insert order: parents before children (photos/drafts → posts, quote_versions → quotes, …). */
export const SEED_TABLES = [
  "settings",
  "examples",
  "price_items",
  "owner_questions",
  "watch_sources",
  "competitor_events",
  "competitor_prices",
  "posts",
  "photos",
  "drafts",
  "quotes",
  "quote_versions",
] as const;

/**
 * Every table a visitor can change, children first. `demo_calls` stays (the cap counts the whole
 * KST day); `d1_migrations` is not ours.
 */
const WIPE_TABLES = [
  "inquiries",
  "drafts",
  "photos",
  "quote_versions",
  "competitor_events",
  "competitor_prices",
  "posts",
  "quotes",
  "watch_sources",
  "examples",
  "price_items",
  "owner_questions",
  "settings",
  "alert_log",
  "kakao_link",
  "login_attempts",
] as const;

const IDENT = /^[a-z_]+$/;

export type SeedStatement = { sql: string; params: (string | number | null)[] };

/** Wipe + insert statements, in order. Table and column names are checked, values are bound. */
export function seedStatements(seed: DemoSeed): SeedStatement[] {
  const out: SeedStatement[] = WIPE_TABLES.map((t) => ({ sql: `DELETE FROM ${t}`, params: [] }));
  for (const table of Object.keys(seed)) {
    if (!(SEED_TABLES as readonly string[]).includes(table)) throw new Error(`demo seed: unknown table ${table}`);
  }
  for (const table of SEED_TABLES) {
    for (const row of seed[table] ?? []) {
      const columns = Object.keys(row);
      if (columns.length === 0 || !columns.every((c) => IDENT.test(c))) {
        throw new Error(`demo seed: bad columns in ${table}`);
      }
      out.push({
        sql: `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
        params: columns.map((c) => row[c]),
      });
    }
  }
  return out;
}

/** Photo keys the seed's posts use; every other R2 object was uploaded by a visitor. */
export function seedPhotoKeys(seed: DemoSeed): Set<string> {
  return new Set((seed.photos ?? []).map((p) => String(p.r2_key)));
}
