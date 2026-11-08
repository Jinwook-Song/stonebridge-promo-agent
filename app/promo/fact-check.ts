// Spec §5.5: flag numbers and names in a draft that the owner never supplied.
// Pure string functions; the UI shows the hits as a yellow warning.

// A comma counts as a thousands separator only in a well-formed group (`15,000`,
// `1,234,567`); `3,4개` is the list "3 and 4", not 34.
const DIGITS = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?`;
const NUMBER_TOKEN = new RegExp(`${DIGITS}[ \\t]?(?:원|구|세트|인분|개|명|시|분|일|월|%)?`, "g");
const DIGIT_RUN = new RegExp(DIGITS, "g");

// Native Korean numbers before a counter: `세 세트`, `열두 개`, `스무 명`. 한 (one) alone is
// skipped — `한 상자`, `한 분` are everyday speech, not a claimed quantity. Sino-Korean
// numbers (`삼십 세트`) are rare in the owner's posts and not covered.
const NATIVE_TENS: Record<string, number> = {
  열: 10, 스물: 20, 스무: 20, 서른: 30, 마흔: 40, 쉰: 50, 예순: 60, 일흔: 70, 여든: 80, 아흔: 90,
};
const NATIVE_UNITS: Record<string, number> = {
  한: 1, 두: 2, 세: 3, 네: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9,
};
const NATIVE_COUNTERS = ["개", "세트", "박스", "상자", "명", "가지", "팩", "봉지", "인분", "시간", "달"];
const NATIVE_NUMBER = new RegExp(
  `(?<![가-힣])(${Object.keys(NATIVE_TENS).join("|")})?(${Object.keys(NATIVE_UNITS).join("|")})?` +
    `[ \\t]?(?:${NATIVE_COUNTERS.join("|")})`,
  "g",
);

/** `[token as written, value]` for each native number with a counter in `text`. */
function nativeNumbers(text: string): [string, number][] {
  const found: [string, number][] = [];
  for (const match of text.matchAll(NATIVE_NUMBER)) {
    const [token, tens, unit] = match;
    if (tens === undefined && unit === undefined) continue;
    const value = (tens ? NATIVE_TENS[tens] : 0) + (unit ? NATIVE_UNITS[unit] : 0);
    if (value > 1) found.push([token, value]);
  }
  return found;
}
const PHOTO_MARKER = /\[사진\s?\d+\]/g;

const NAME_WITH_HONORIFIC = /([가-힣]{2,3})\s?(님|씨)/g;
const ROLE_WORDS = [
  "사장",
  "손님",
  "고객",
  "선생",
  "여러분",
  "담당자",
  "직원",
  "원장",
  "부장",
  "팀장",
  "과장",
  "대리",
  "대표",
  "점장",
  "매니저",
  "사모",
  "이사",
];
// Words that end in 씨 without being an honorific: 손글씨, 날씨, 솜씨, 맵씨, 말씨, 마음씨.
const SSI_COMPOUND_ENDINGS = ["글", "날", "솜", "맵", "말", "음"];

/** Digit run with thousands separators removed, so `15,000` equals `15000`. */
function digitRuns(text: string): string[] {
  return (text.match(DIGIT_RUN) ?? []).map((run) => run.replace(/,+$/, "").replaceAll(",", ""));
}

/**
 * Numbers in `text` (digits, or native Korean numbers before a counter) whose value appears
 * in none of `sources`. Whole-run match, so `0` is not backed by `40`; `세 세트` is backed by
 * `3세트` and the other way round. Returns the tokens as written, deduped: digit tokens in
 * order first, then native ones in order.
 */
export function findUnsupportedNumbers(text: string, sources: string[]): string[] {
  const supported = new Set([
    ...sources.flatMap(digitRuns),
    ...sources.flatMap((source) => nativeNumbers(source).map(([, value]) => String(value))),
  ]);
  const found = new Set<string>();
  const body = text.replace(PHOTO_MARKER, " ");
  for (const match of body.matchAll(NUMBER_TOKEN)) {
    const token = match[0].trim().replace(/,+$/, "");
    const [run] = digitRuns(token);
    if (run !== undefined && !supported.has(run)) found.add(token);
  }
  for (const [token, value] of nativeNumbers(body)) {
    if (!supported.has(String(value))) found.add(token);
  }
  return [...found];
}

/** Things that look like a person's name (`김민수님`, `박서준 씨`), minus common role words. */
export function findPossibleNames(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(NAME_WITH_HONORIFIC)) {
    const [whole, group, honorific] = match;
    const roleWord = ROLE_WORDS.some((role) => group.endsWith(role) || (group + honorific).endsWith(role));
    const ssiCompound = honorific === "씨" && SSI_COMPOUND_ENDINGS.some((end) => group.endsWith(end));
    if (!roleWord && !ssiCompound) found.add(whole);
  }
  return [...found];
}
