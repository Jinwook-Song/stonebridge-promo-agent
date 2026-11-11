import { env } from "cloudflare:workers";
import { eq, inArray } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { settings } from "../database/schema";
import { getQuoteSettings, saveQuoteSettings, type QuoteSettings } from "../app/quote/quote-settings.server";
import { getDb } from "../app/server/db";

const db = getDb(env.DB);
const KEYS = ["quote_sender", "quote_intro", "quote_fixed_lines", "quote_mail_example", "owner_password_hash"];

beforeEach(async () => {
  await db.delete(settings).where(inArray(settings.key, KEYS));
});

const sample: QuoteSettings = {
  sender: {
    company: "예시상사",
    person: "홍길동",
    phone: "010-0000-0000",
    email: "a@example.com",
    payment: "예시은행 000-00-0000",
    onsite: "현장 안내",
    bizNo: "000-00-00000",
  },
  intro: "안녕하세요.\n견적서를 보내드립니다.",
  fixedLines: "세팅 포함\n일회용품 제공",
  mailExample: "안녕하세요.\n견적서를 첨부해 드립니다.\n감사합니다!",
};

describe("quote settings", () => {
  it("reads defaults from an empty DB", async () => {
    const s = await getQuoteSettings(db);
    expect(s.sender.company).toBe("스톤테이블");
    expect(s.sender).toEqual({ company: "스톤테이블", person: "", phone: "", email: "", payment: "", onsite: "", bizNo: "" });
    expect(s.intro).toBe("");
    expect(s.fixedLines).toBe("");
    expect(s.mailExample).toBe("");
  });

  it("round-trips a save", async () => {
    await saveQuoteSettings(db, sample);
    expect(await getQuoteSettings(db)).toEqual(sample);
    await saveQuoteSettings(db, { ...sample, intro: "바뀜" });
    expect((await getQuoteSettings(db)).intro).toBe("바뀜");
  });

  it("refuses a mail example over 2,000 characters and keeps the stored one", async () => {
    await saveQuoteSettings(db, sample);
    const err = await saveQuoteSettings(db, { ...sample, mailExample: "가".repeat(2001) }).catch((e) => e);
    expect(err).toMatchObject({ code: "INVALID_INPUT" });
    expect((await getQuoteSettings(db)).mailExample).toBe(sample.mailExample);
    await saveQuoteSettings(db, { ...sample, mailExample: "가".repeat(2000) });
    expect((await getQuoteSettings(db)).mailExample).toHaveLength(2000);
  });

  it("normalizes CRLF and trims", async () => {
    await saveQuoteSettings(db, { ...sample, intro: "  a\r\nb  ", fixedLines: "x\r\ny\r\n" });
    const s = await getQuoteSettings(db);
    expect(s.intro).toBe("a\nb");
    expect(s.fixedLines).toBe("x\ny");
  });

  it("reads broken or wrong-shaped sender JSON as the default", async () => {
    for (const value of ["{not json", '{"company": 3}', "null", "[]"]) {
      await db.insert(settings).values({ key: "quote_sender", value }).onConflictDoUpdate({ target: settings.key, set: { value } });
      const s = await getQuoteSettings(db);
      expect(s.sender.company).toBe("스톤테이블");
      expect(s.sender.person).toBe("");
    }
  });

  it("never touches the password hash", async () => {
    await db.insert(settings).values({ key: "owner_password_hash", value: "h" });
    await saveQuoteSettings(db, sample);
    const [row] = await db.select().from(settings).where(eq(settings.key, "owner_password_hash"));
    expect(row?.value).toBe("h");
  });
});
