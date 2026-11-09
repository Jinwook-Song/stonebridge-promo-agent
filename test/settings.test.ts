import { env } from "cloudflare:workers";
import { eq, inArray } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { settings } from "../database/schema";
import { DEFAULT_CHANNEL_RULES, DEFAULT_VOICE_RULES } from "../app/promo/default-rules";
import { getSettings, saveSettings } from "../app/promo/settings.server";
import { action } from "../app/routes/settings";
import { getAlertSettings } from "../app/kakao/alerts.server";
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
        "alert_draft_ready_enabled",
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

  it("a rules box saved as the default (even with CRLF and padding) stores nothing, so code updates reach it", async () => {
    await saveSettings(db, { voiceRules: "내 말투", channelRules: "내 채널 규칙" });
    // Browsers send textarea newlines as CRLF.
    await saveSettings(db, {
      voiceRules: `  ${DEFAULT_VOICE_RULES.replace(/\n/g, "\r\n")}\r\n`,
      channelRules: DEFAULT_CHANNEL_RULES,
    });
    const rows = await db.select().from(settings).where(inArray(settings.key, ["voice_rules", "channel_rules"]));
    expect(rows).toEqual([]);
    const s = await getSettings(db);
    expect(s.voiceRules).toBe(DEFAULT_VOICE_RULES);
    expect(s.channelRules).toBe(DEFAULT_CHANNEL_RULES);
  });

  it("a blank box goes back to its default (rules) or empty (footers, prices)", async () => {
    await saveSettings(db, { footerBlog: "A", priceTable: "P", voiceRules: "내 말투", channelRules: "내 채널 규칙" });
    await saveSettings(db, { footerBlog: "  ", priceTable: "", voiceRules: "\r\n ", channelRules: "" });
    expect(await db.select().from(settings)).toEqual([]);
    const s = await getSettings(db);
    expect([s.footerBlog, s.priceTable]).toEqual(["", ""]);
    expect(s.voiceRules).toBe(DEFAULT_VOICE_RULES);
    expect(s.channelRules).toBe(DEFAULT_CHANNEL_RULES);
  });

  it("stores custom text trimmed, with LF newlines", async () => {
    await saveSettings(db, { voiceRules: "  첫 줄\r\n둘째 줄\r\n", footerBlog: "주소\r\n전화\n" });
    const s = await getSettings(db);
    expect(s.voiceRules).toBe("첫 줄\n둘째 줄");
    expect(s.footerBlog).toBe("주소\n전화");
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

function post(fields: Record<string, string>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return action({
    request: new Request("http://localhost/settings", { method: "POST", body: form }),
    params: {},
    context: {},
  } as never);
}

describe("settings action: setAlert", () => {
  it("draft_ready off stores '0' and reads back as disabled", async () => {
    await post({ intent: "setAlert", kind: "draft_ready", enabled: "0" });
    const [row] = await db.select().from(settings).where(eq(settings.key, "alert_draft_ready_enabled"));
    expect(row.value).toBe("0");
    expect((await getAlertSettings(db)).draftReadyEnabled).toBe(false);
  });

  it("draft_ready on turns it back on", async () => {
    await post({ intent: "setAlert", kind: "draft_ready", enabled: "0" });
    await post({ intent: "setAlert", kind: "draft_ready", enabled: "1" });
    const [row] = await db.select().from(settings).where(eq(settings.key, "alert_draft_ready_enabled"));
    expect(row.value).toBe("1");
    expect((await getAlertSettings(db)).draftReadyEnabled).toBe(true);
  });

  it("unknown kind is still rejected and stores nothing", async () => {
    expect(await post({ intent: "setAlert", kind: "bogus", enabled: "0" })).toEqual({ error: "잘못된 요청입니다." });
    const rows = await db.select().from(settings).where(eq(settings.key, "alert_draft_ready_enabled"));
    expect(rows).toEqual([]);
  });
});
