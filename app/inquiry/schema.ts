// stonetable-site/app/inquiry/schema.ts 사본 — 같이 고칠 것
// Shared inquiry validation. Self-contained on purpose (only `zod`): the promo app copies this
// file as-is and calls `InquiryInputSchema.safeParse(raw)` at its trust boundary.
import { z } from "zod";

export const EVENT_TYPES = [
  "기업 행사",
  "병원·기관",
  "학교·학원",
  "개인 파티",
  "답례품·선물",
  "기타",
] as const;
export const MENU_INTERESTS = [
  "케이터링 테이블",
  "핑거푸드",
  "디저트 테이블",
  "답례품 세트",
  "음료",
] as const;
export const REFERRALS = ["네이버 검색", "블로그", "인스타", "지인 소개", "기타"] as const;

export const CONSENT_ERROR = "개인정보 수집·이용에 동의해 주세요";

const DATE_ERROR = "행사 날짜를 골라 주세요. 아직 모르면 ‘미정’을 체크해 주세요";
const PAST_DATE_ERROR = "지난 날짜는 고를 수 없어요";
const HEADCOUNT_ERROR = "인원은 1명부터 3000명까지 숫자로 적어 주세요. 아직 모르면 ‘미정’을 체크해 주세요";
const PHONE_ERROR = "연락처를 숫자로 다시 확인해 주세요 (예: 010-1234-5678)";
const TIME_RE = /^(([01]\d|2[0-3]):[0-5]\d)?$/;
const END_TIME_ERROR = "끝나는 시간을 다시 확인해 주세요";
const END_BEFORE_START_ERROR = "끝나는 시간은 시작 시간보다 늦게 골라 주세요";

/** Today's date in Asia/Seoul as YYYY-MM-DD (Korea has no DST, so a fixed +9h is exact). */
function seoulToday(now: Date): string {
  return new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function isRealDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Digits-only 02 / 0XX number -> `02-123-4567`, `010-1234-5678`. Null if it is not one (the schema checks the prefix). */
function formatPhone(raw: string): string | null {
  if (!/^[0-9\s-]+$/.test(raw)) return null;
  const d = raw.replace(/\D/g, "");
  if (!d.startsWith("0")) return null;
  const area = d.startsWith("02") ? 2 : 3;
  const rest = d.slice(area);
  // 02: 9-10 digits; every other area / mobile prefix: 10-11 digits.
  if (d.length < area + 7 || d.length > area + 8) return null;
  const tail = rest.slice(-4);
  const mid = rest.slice(0, -4);
  return `${d.slice(0, area)}-${mid}-${tail}`;
}

const text = (max: number, message: string) =>
  z.string({ error: message }).trim().max(max, message);
const requiredText = (max: number, message: string) =>
  z.string({ error: message }).trim().min(1, message).max(max, message);

/**
 * Builds the schema for an ALREADY-NORMALIZED inquiry (phone formatted, 미정 -> null).
 * `now` is only used for the "no past dates" rule; by default the clock is read at parse time.
 */
export function inquiryInputSchema(now?: Date) {
  return z
    .object({
    contactName: requiredText(40, "이름을 40자 안으로 적어 주세요"),
    org: text(60, "기관·회사명은 60자 안으로 적어 주세요"),
    phone: z
      .string({ error: PHONE_ERROR })
      // Real prefixes only: 02 Seoul, 01x mobile, 03x-06x area codes, 070 internet phone.
      .regex(/^(02-\d{3,4}-\d{4}|(01\d|0[3-6]\d|070)-\d{3,4}-\d{4})$/, PHONE_ERROR),
    email: z
      .string({ error: "이메일을 적어 주세요" })
      .trim()
      .max(254, "이메일이 너무 길어요")
      .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "이메일 형식을 다시 확인해 주세요"),
    eventDate: z
      .string({ error: DATE_ERROR })
      .nullable()
      .superRefine((v, ctx) => {
        if (v === null) return;
        if (!isRealDate(v)) {
          ctx.addIssue({ code: "custom", message: DATE_ERROR });
        } else if (v < seoulToday(now ?? new Date())) {
          ctx.addIssue({ code: "custom", message: PAST_DATE_ERROR });
        }
      }),
    startTime: z
      .string({ error: "시작 시간을 다시 확인해 주세요" })
      .regex(TIME_RE, "시작 시간을 다시 확인해 주세요"),
    // Optional with a "" default: a sender that predates the field still validates.
    endTime: z.string({ error: END_TIME_ERROR }).regex(TIME_RE, END_TIME_ERROR).default(""),
    venue: requiredText(100, "장소를 100자 안으로 적어 주세요"),
    headcount: z
      .number({ error: HEADCOUNT_ERROR })
      .int(HEADCOUNT_ERROR)
      .min(1, HEADCOUNT_ERROR)
      .max(3000, HEADCOUNT_ERROR)
      .nullable(),
    eventType: z.enum(EVENT_TYPES, { error: "행사 성격을 골라 주세요" }),
    menus: z.array(z.enum(MENU_INTERESTS), { error: "관심 메뉴를 다시 골라 주세요" }),
    budget: text(60, "예산은 60자 안으로 적어 주세요"),
    requests: text(2000, "요청 사항은 2000자 안으로 적어 주세요"),
    referral: z.union([z.enum(REFERRALS), z.literal("")], { error: "알게 된 경로를 다시 골라 주세요" }),
    consent: z.literal(true, { error: CONSENT_ERROR }),
    clientToken: z
      .string({ error: "페이지를 새로고침한 뒤 다시 보내 주세요" })
      .min(1, "페이지를 새로고침한 뒤 다시 보내 주세요")
      .max(64, "페이지를 새로고침한 뒤 다시 보내 주세요"),
    })
    .superRefine((v, ctx) => {
      // HH:MM strings compare in time order.
      if (v.startTime && v.endTime && v.endTime <= v.startTime) {
        ctx.addIssue({ code: "custom", path: ["endTime"], message: END_BEFORE_START_ERROR });
      }
    });
}

export const InquiryInputSchema = inquiryInputSchema();

export type InquiryInput = z.infer<typeof InquiryInputSchema>;
export type InquiryErrors = Partial<Record<keyof InquiryInput, string>>;
export type InquiryParseResult =
  | { ok: true; value: InquiryInput }
  | { ok: false; errors: InquiryErrors };

type Raw = FormData | Record<string, unknown>;

function getAll(raw: Raw, key: string): unknown[] {
  if (raw instanceof FormData) return raw.getAll(key);
  const v = raw[key];
  return Array.isArray(v) ? v : v === undefined ? [] : [v];
}

/** First value of `key` as a string ("" when absent or not a plain value, e.g. a File). */
function str(raw: Raw, key: string): string {
  const v = getAll(raw, key)[0];
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}

/** A checkbox counts as checked for "on" / "true" / "1" / true. */
function checked(raw: Raw, key: string): boolean {
  const v = getAll(raw, key)[0];
  return v === true || v === "on" || v === "true" || v === "1";
}

/**
 * Turns a form post (FormData, or the JSON/object equivalent) into a validated `InquiryInput`.
 * The honeypot `website` field is deliberately unknown here; the Pages Function handles it.
 * `now` is injectable so "no past dates" (Korea time) is testable.
 */
export function parseInquiryForm(raw: Raw, now: Date = new Date()): InquiryParseResult {
  const rawPhone = str(raw, "phone").trim();
  const headcountText = str(raw, "headcount").trim();

  const candidate = {
    contactName: str(raw, "contactName"),
    org: str(raw, "org"),
    phone: formatPhone(rawPhone) ?? rawPhone,
    email: str(raw, "email"),
    eventDate: checked(raw, "eventDateUnknown") ? null : str(raw, "eventDate").trim(),
    startTime: str(raw, "startTime").trim(),
    endTime: str(raw, "endTime").trim(),
    venue: str(raw, "venue"),
    headcount: checked(raw, "headcountUnknown")
      ? null
      : /^\d+$/.test(headcountText)
        ? Number(headcountText)
        : headcountText,
    eventType: str(raw, "eventType"),
    menus: getAll(raw, "menus").filter((m): m is string => typeof m === "string" && m !== ""),
    budget: str(raw, "budget"),
    requests: str(raw, "requests"),
    referral: str(raw, "referral"),
    consent: checked(raw, "consent") ? true : undefined,
    clientToken: str(raw, "clientToken").trim(),
  };

  const parsed = inquiryInputSchema(now).safeParse(candidate);
  if (parsed.success) {
    return { ok: true, value: { ...parsed.data, menus: [...new Set(parsed.data.menus)] } };
  }
  const errors: InquiryErrors = {};
  for (const issue of parsed.error.issues) {
    const key = issue.path[0] as keyof InquiryInput | undefined;
    if (key && !(key in errors)) errors[key] = issue.message;
  }
  return { ok: false, errors };
}

/**
 * Event fields only, one `label: value` per line, for the quote agent (it goes to Claude).
 * Never includes contactName / phone / email / clientToken / referral. Empty fields are left out.
 */
export function inquiryToQuoteText(v: InquiryInput): string {
  const rows: [string, string][] = [
    ["기관", v.org],
    ["날짜", v.eventDate ?? "미정"],
    ["시간", v.endTime ? `${v.startTime}~${v.endTime}` : v.startTime],
    ["장소", v.venue],
    ["인원", v.headcount === null ? "미정" : `${v.headcount}명`],
    ["행사 성격", v.eventType],
    ["관심 메뉴", v.menus.join(", ")],
    ["예산", v.budget],
    ["요청 사항", v.requests],
  ];
  return rows
    .filter(([, value]) => value !== "")
    .map(([label, value]) => `${label}: ${value}`)
    .join("\n");
}
