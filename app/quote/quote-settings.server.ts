import { inArray, sql } from "drizzle-orm";
import { settings } from "../../database/schema";
import type { Db } from "../server/db";
import { DomainError } from "../server/errors";
import { SenderSchema, type Sender } from "./types";

export type QuoteSettings = {
  sender: Sender;
  /** Opening line(s) of the quote message. */
  intro: string;
  /** What every quote includes, one per line. */
  fixedLines: string;
  /** One of her own past reply mails: the model follows its tone only (greeting, closing, register). */
  mailExample: string;
};

// Outside the promo KEYS map on purpose; never touches the password hash row.
const SENDER_KEY = "quote_sender";
const INTRO_KEY = "quote_intro";
const FIXED_KEY = "quote_fixed_lines";
const MAIL_EXAMPLE_KEY = "quote_mail_example";

const DEFAULT_SENDER: Sender = {
  company: "스톤테이블",
  person: "",
  phone: "",
  email: "",
  payment: "",
  onsite: "",
  bizNo: "",
};

/** One mail is enough for tone; it goes into every quote prompt. */
export const MAX_MAIL_EXAMPLE_CHARS = 2000;

/** Browsers send textarea newlines as CRLF. */
function clean(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
}

function parseSender(raw: string | undefined): Sender {
  if (raw === undefined) return DEFAULT_SENDER;
  try {
    const parsed = SenderSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : DEFAULT_SENDER;
  } catch {
    return DEFAULT_SENDER;
  }
}

export async function getQuoteSettings(db: Db): Promise<QuoteSettings> {
  const rows = await db
    .select()
    .from(settings)
    .where(inArray(settings.key, [SENDER_KEY, INTRO_KEY, FIXED_KEY, MAIL_EXAMPLE_KEY]));
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  return {
    sender: parseSender(byKey.get(SENDER_KEY)),
    intro: byKey.get(INTRO_KEY) ?? "",
    fixedLines: byKey.get(FIXED_KEY) ?? "",
    mailExample: byKey.get(MAIL_EXAMPLE_KEY) ?? "",
  };
}

export async function saveQuoteSettings(db: Db, s: QuoteSettings): Promise<void> {
  const mailExample = clean(s.mailExample);
  if (mailExample.length > MAX_MAIL_EXAMPLE_CHARS) {
    throw new DomainError("INVALID_INPUT", `회신 메일 말투 예시는 ${MAX_MAIL_EXAMPLE_CHARS.toLocaleString("ko-KR")}자까지 적을 수 있어요.`);
  }
  const sender: Sender = {
    company: clean(s.sender.company),
    person: clean(s.sender.person),
    phone: clean(s.sender.phone),
    email: clean(s.sender.email),
    payment: clean(s.sender.payment),
    onsite: clean(s.sender.onsite),
    bizNo: clean(s.sender.bizNo),
  };
  const upsert = (key: string, value: string) =>
    db
      .insert(settings)
      .values({ key, value })
      .onConflictDoUpdate({ target: settings.key, set: { value: sql`excluded.value` } });
  await db.batch([
    upsert(SENDER_KEY, JSON.stringify(sender)),
    upsert(INTRO_KEY, clean(s.intro)),
    upsert(FIXED_KEY, clean(s.fixedLines)),
    upsert(MAIL_EXAMPLE_KEY, mailExample),
  ]);
}
