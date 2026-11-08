import { inArray, sql } from "drizzle-orm";
import { settings } from "../../database/schema";
import type { Db } from "../server/db";
import { DEFAULT_CHANNEL_RULES, DEFAULT_VOICE_RULES } from "./default-rules";

export type PromoSettings = {
  footerBlog: string;
  footerShort: string;
  priceTable: string;
  voiceRules: string;
  channelRules: string;
};

// Only these keys are ever read or written here; the settings table also holds
// the owner password hash, which must stay out of reach of this module.
const KEYS = {
  footerBlog: "footer_blog",
  footerShort: "footer_short",
  priceTable: "price_table",
  voiceRules: "voice_rules",
  channelRules: "channel_rules",
} as const satisfies Record<keyof PromoSettings, string>;

const FIELDS = Object.keys(KEYS) as (keyof PromoSettings)[];

export async function getSettings(db: Db): Promise<PromoSettings> {
  const rows = await db
    .select()
    .from(settings)
    .where(inArray(settings.key, Object.values(KEYS)));
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const get = (field: keyof PromoSettings, fallback: string) => byKey.get(KEYS[field]) ?? fallback;
  return {
    footerBlog: get("footerBlog", ""),
    footerShort: get("footerShort", ""),
    priceTable: get("priceTable", ""),
    voiceRules: get("voiceRules", DEFAULT_VOICE_RULES),
    channelRules: get("channelRules", DEFAULT_CHANNEL_RULES),
  };
}

export async function saveSettings(db: Db, patch: Partial<PromoSettings>): Promise<void> {
  const statements = FIELDS.flatMap((field) => {
    const value = patch[field];
    if (value === undefined) return [];
    return [
      db
        .insert(settings)
        .values({ key: KEYS[field], value })
        .onConflictDoUpdate({ target: settings.key, set: { value: sql`excluded.value` } }),
    ];
  });
  const [first, ...rest] = statements;
  if (!first) return;
  await db.batch([first, ...rest]);
}
