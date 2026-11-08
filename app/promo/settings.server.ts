import { eq, inArray, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
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

/** What a field reads as when nothing is stored. */
const DEFAULTS: PromoSettings = {
  footerBlog: "",
  footerShort: "",
  priceTable: "",
  voiceRules: DEFAULT_VOICE_RULES,
  channelRules: DEFAULT_CHANNEL_RULES,
};

/** Browsers send textarea newlines as CRLF. */
function clean(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
}

export async function getSettings(db: Db): Promise<PromoSettings> {
  const rows = await db
    .select()
    .from(settings)
    .where(inArray(settings.key, Object.values(KEYS)));
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const get = (field: keyof PromoSettings) => byKey.get(KEYS[field]) ?? DEFAULTS[field];
  return {
    footerBlog: get("footerBlog"),
    footerShort: get("footerShort"),
    priceTable: get("priceTable"),
    voiceRules: get("voiceRules"),
    channelRules: get("channelRules"),
  };
}

/**
 * Saves the fields in the patch (trimmed, LF newlines). A field left blank, or saved exactly as
 * its default, has its row deleted instead: blank rules would send the model no rules, and a
 * stored copy of the default would freeze it, so later changes to the code default never reach
 * her prompt.
 */
export async function saveSettings(db: Db, patch: Partial<PromoSettings>): Promise<void> {
  const statements: BatchItem<"sqlite">[] = [];
  for (const field of FIELDS) {
    const raw = patch[field];
    if (raw === undefined) continue;
    const value = clean(raw);
    if (value === "" || value === clean(DEFAULTS[field])) {
      statements.push(db.delete(settings).where(eq(settings.key, KEYS[field])));
    } else {
      statements.push(
        db
          .insert(settings)
          .values({ key: KEYS[field], value })
          .onConflictDoUpdate({ target: settings.key, set: { value: sql`excluded.value` } }),
      );
    }
  }
  const [first, ...rest] = statements;
  if (!first) return;
  await db.batch([first, ...rest]);
}
