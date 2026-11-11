import type { QuoteEvent, QuoteLine } from "./types";

/**
 * 보내기 전 확인: what the owner should look at before she sends the quote. Plain rules on what is
 * on screen (no AI call), so it is the same every time and follows her edits at once. It only
 * warns; the download and the copy buttons stay usable.
 * - warn: something that would be wrong to send (the mail disagrees with the quote, a price in
 *   the mail, the cafe's name on a catering quote).
 * - todo: work still open (questions for the customer, lines without a price, empty event boxes).
 */
export type SendCheck = { kind: "warn" | "todo"; text: string };

export type SendCheckInput = {
  event: QuoteEvent;
  lines: QuoteLine[];
  emailSubject: string;
  emailBody: string;
};

/** The owner does not want the catering tied to the cafe in anything a customer receives (q12). */
const CAFE_NAME = /스톤\s*브릿지|stone\s*[-_]?\s*bridge/i;
/** "120,000원", "12만 원", "3만원". A bare number with 원 is a price in a mail. */
const AMOUNT = /\d[\d,]*\s*(?:만\s*)?원/;
const HEADCOUNT = /(\d+)\s*(?:명|분)/g;

const LIST_MAX = 3;

function listed(names: string[]): string {
  const shown = names.slice(0, LIST_MAX).map((n) => n || "이름 없는 줄");
  return names.length > LIST_MAX ? `${shown.join(", ")} 외 ${names.length - LIST_MAX}개` : shown.join(", ");
}

/** Month and day found in free text: "11월 20일", "2026-11-20", "2026.11.20", "11/20". */
export function datesIn(text: string): string[] {
  const found: string[] = [];
  const add = (m: string, d: string) => {
    const month = Number(m);
    const day = Number(d);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) found.push(`${month}월 ${day}일`);
  };
  for (const m of text.matchAll(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/g)) add(m[1], m[2]);
  for (const m of text.matchAll(/\d{4}\s*[-./]\s*(\d{1,2})\s*[-./]\s*(\d{1,2})/g)) add(m[1], m[2]);
  // "11/20" without a year; skip the tail of a full date already read above.
  for (const m of text.matchAll(/(?<![\d./-])(\d{1,2})\/(\d{1,2})(?![\d/])/g)) add(m[1], m[2]);
  return [...new Set(found)];
}

function mailChecks(input: SendCheckInput): SendCheck[] {
  const { event, emailBody } = input;
  if (emailBody.trim() === "") return [];
  const checks: SendCheck[] = [];

  if (AMOUNT.test(emailBody)) {
    checks.push({ kind: "warn", text: "회신 메일에 금액이 적혀 있어요. 금액은 견적서로만 안내해요." });
  }

  if (event.headcount !== null && event.headcount > 0) {
    const counts = [...new Set([...emailBody.matchAll(HEADCOUNT)].map((m) => Number(m[1])))];
    const other = counts.filter((n) => n !== event.headcount);
    if (other.length > 0 && !counts.includes(event.headcount)) {
      checks.push({
        kind: "warn",
        text: `회신 메일에는 ${other.join("·")}명, 행사 정보에는 ${event.headcount}명이에요. 보내실 때 메일을 고쳐 주세요.`,
      });
    }
  }

  const eventDays = datesIn(event.eventDate);
  if (eventDays.length > 0) {
    const mailDays = datesIn(emailBody);
    if (mailDays.length > 0 && !mailDays.some((d) => eventDays.includes(d))) {
      checks.push({
        kind: "warn",
        text: `회신 메일의 날짜(${mailDays.join(", ")})가 행사 날짜(${eventDays.join(", ")})와 달라요. 보내실 때 메일을 고쳐 주세요.`,
      });
    }
  }
  return checks;
}

function cafeNameCheck(input: SendCheckInput): SendCheck[] {
  const places: string[] = [];
  if (CAFE_NAME.test(input.emailSubject) || CAFE_NAME.test(input.emailBody)) places.push("회신 메일");
  const lines = input.lines.filter((l) => [l.label, l.content, l.menu, l.note].some((t) => CAFE_NAME.test(t)));
  if (lines.length > 0) places.push(`견적 줄 ${listed(lines.map((l) => l.label))}`);
  if (places.length === 0) return [];
  return [{ kind: "warn", text: `'스톤브릿지' 이름이 들어 있어요 (${places.join(", ")}). 손님께 가는 글에서는 빼 주세요.` }];
}

function todoChecks(input: SendCheckInput): SendCheck[] {
  const { event, lines } = input;
  const checks: SendCheck[] = [];

  if (event.missing.length > 0) {
    checks.push({ kind: "todo", text: `손님께 확인할 것이 ${event.missing.length}개 남아 있어요.` });
  }

  const empty = [
    event.customerName.trim() === "" && "고객·단체",
    event.eventDate.trim() === "" && "행사 날짜",
    event.venue.trim() === "" && "장소",
    event.headcount === null && "인원",
  ].filter((x): x is string => x !== false);
  if (empty.length > 0) checks.push({ kind: "todo", text: `행사 정보에 비어 있는 칸: ${empty.join(", ")}` });

  const unpriced = lines.filter((l) => l.unitPrice === null && !l.svc);
  if (unpriced.length > 0) {
    checks.push({ kind: "todo", text: `단가를 적을 줄 ${unpriced.length}개: ${listed(unpriced.map((l) => l.label))}` });
  }

  const zero = lines.filter((l) => l.qty === 0 && !l.svc);
  if (zero.length > 0) checks.push({ kind: "todo", text: `수량이 0인 줄: ${listed(zero.map((l) => l.label))}` });

  return checks;
}

export function sendChecks(input: SendCheckInput): SendCheck[] {
  return [...cafeNameCheck(input), ...mailChecks(input), ...todoChecks(input)];
}
