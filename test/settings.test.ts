import { env } from "cloudflare:workers";
import { eq, inArray } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { settings } from "../database/schema";
import { DEFAULT_CHANNEL_RULES, DEFAULT_VOICE_RULES } from "../app/promo/default-rules";
import { getSettings, saveSettings } from "../app/promo/settings.server";
import { getDb } from "../app/server/db";

const db = getDb(env.DB);

beforeEach(async () => {
  await db
    .delete(settings)
    .where(
      inArray(settings.key, [
        "footer_blog",
        "footer_short",
        "price_table",
        "voice_rules",
        "channel_rules",
        "owner_password_hash",
      ]),
    );
});

describe("settings store", () => {
  it("falls back to default rules and empty footers", async () => {
    const s = await getSettings(db);
    expect(s.footerBlog).toBe("");
    expect(s.footerShort).toBe("");
    expect(s.priceTable).toBe("");
    expect(s.voiceRules).toBe(DEFAULT_VOICE_RULES);
    expect(s.channelRules).toBe(DEFAULT_CHANNEL_RULES);
  });

  it("saveSettings upserts", async () => {
    await saveSettings(db, { footerBlog: "A" });
    await saveSettings(db, { footerBlog: "B" });
    expect((await getSettings(db)).footerBlog).toBe("B");
  });

  it("saveSettings only touches the keys in the patch", async () => {
    await saveSettings(db, { footerBlog: "A", priceTable: "P" });
    await saveSettings(db, { footerShort: "S" });
    const s = await getSettings(db);
    expect([s.footerBlog, s.footerShort, s.priceTable]).toEqual(["A", "S", "P"]);
  });

  it("stores each field under its own key", async () => {
    await saveSettings(db, {
      footerBlog: "1",
      footerShort: "2",
      priceTable: "3",
      voiceRules: "4",
      channelRules: "5",
    });
    const rows = await db.select().from(settings);
    expect(Object.fromEntries(rows.map((r) => [r.key, r.value]))).toEqual({
      footer_blog: "1",
      footer_short: "2",
      price_table: "3",
      voice_rules: "4",
      channel_rules: "5",
    });
  });

  it("an empty patch is a no-op", async () => {
    await saveSettings(db, {});
    expect(await db.select().from(settings).where(eq(settings.key, "footer_blog"))).toEqual([]);
  });

  it("never reads or writes the owner password hash", async () => {
    await db.insert(settings).values({ key: "owner_password_hash", value: "hash-secret" });
    await saveSettings(db, { footerBlog: "A" });
    const s = await getSettings(db);
    expect(JSON.stringify(s)).not.toContain("hash-secret");
    expect(Object.keys(s).sort()).toEqual(
      ["channelRules", "footerBlog", "footerShort", "priceTable", "voiceRules"],
    );
    const [row] = await db.select().from(settings).where(eq(settings.key, "owner_password_hash"));
    expect(row?.value).toBe("hash-secret");
  });
});
