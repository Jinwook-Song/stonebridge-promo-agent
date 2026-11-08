// Spec §5.5: flag numbers and names in a draft that the owner never supplied.
// Pure string functions; the UI shows the hits as a yellow warning.

// A comma counts as a thousands separator only in a well-formed group (`15,000`,
// `1,234,567`); `3,4개` is the list "3 and 4", not 34.
const DIGITS = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?`;
const NUMBER_TOKEN = new RegExp(`${DIGITS}[ \\t]?(?:원|구|세트|인분|개|명|시|분|일|월|%)?`, "g");
const DIGIT_RUN = new RegExp(DIGITS, "g");

// Korean-word numbers before a counter. Native: `세 세트`, `열두 개`, `스물 다섯 명`.
// Sino-Korean: `오천 원`, `이십 명`, `만 원` (a lone 일/이/삼… is skipped: `이` is "this").
// The counter must end the word or be followed by a particle, so `네 달콤한` and `두 명절`
// are not numbers. A Sino word right after digits (`30만원`, `5천원`) is left to the digit check.
const NATIVE_TENS: Record<string, number> = {
  열: 10, 스물: 20, 스무: 20, 서른: 30, 마흔: 40, 쉰: 50, 예순: 60, 일흔: 70, 여든: 80, 아흔: 90,
};
const NATIVE_UNITS: Record<string, number> = {
  한: 1, 두: 2, 세: 3, 네: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9,
};
const SINO_DIGITS: Record<string, number> = {
  일: 1, 이: 2, 삼: 3, 사: 4, 오: 5, 육: 6, 칠: 7, 팔: 8, 구: 9,
};
const SINO_UNITS: Record<string, number> = { 십: 10, 백: 100, 천: 1000 };
const byLength = (words: string[]) => [...words].sort((a, b) => b.length - a.length).join("|");
const NATIVE_COUNTERS = byLength([
  "개", "세트", "박스", "상자", "명", "가지", "팩", "봉지", "인분", "시간", "시", "달",
  "조각", "잔", "판", "병", "컵", "송이", "번", "종류",
]);
const SINO_COUNTERS = byLength(["원", "명", "개", "세트", "인분", "박스", "상자", "잔", "조각"]);
// Particles that may follow a counter: 을/를/이/가/은/는/에/의/로/으로/씩/만/도/와/과/짜리/간/
// 부터/까지/밖에/랑/쯤/반.
const WORD_END = "(?=$|[^가-힣]|[을를이가은는에의로으씩만도와과짜간부까밖랑쯤반])";
const NATIVE_NUMBER = new RegExp(
  `(?<![가-힣])(?:(${byLength(Object.keys(NATIVE_TENS))})[ \\t]?)?(${byLength(Object.keys(NATIVE_UNITS))})?` +
    `[ \\t]?(?:${NATIVE_COUNTERS})${WORD_END}`,
  "g",
);
const SINO_NUMBER = new RegExp(
  `(?<![가-힣\\d])([일이삼사오육칠팔구십백천만]{2,}|[십백천만])[ \\t]?(?:${SINO_COUNTERS})${WORD_END}`,
  "g",
);

/** `삼만오천` → 35000; undefined for strings that are not a well-formed number. */
function sinoValue(word: string): number | undefined {
  let total = 0;
  let section = 0;
  let digit: number | undefined;
  for (const ch of word) {
    if (ch in SINO_DIGITS) {
      if (digit !== undefined) return undefined;
      digit = SINO_DIGITS[ch];
    } else if (ch in SINO_UNITS) {
      section += (digit ?? 1) * SINO_UNITS[ch];
      digit = undefined;
    } else {
      total += (section + (digit ?? 0) || 1) * 10000;
      section = 0;
      digit = undefined;
    }
  }
  return total + section + (digit ?? 0);
}

/** `[token as written, value]` for each Korean-word number with a counter in `text`. */
function wordNumbers(text: string): [string, number][] {
  const found: [number, string, number][] = [];
  for (const match of text.matchAll(NATIVE_NUMBER)) {
    const [token, tens, unit] = match;
    if (tens === undefined && unit === undefined) continue;
    found.push([match.index, token, (tens ? NATIVE_TENS[tens] : 0) + (unit ? NATIVE_UNITS[unit] : 0)]);
  }
  for (const match of text.matchAll(SINO_NUMBER)) {
    const value = sinoValue(match[1]);
    if (value !== undefined) found.push([match.index, match[0], value]);
  }
  return found.sort((a, b) => a[0] - b[0]).map(([, token, value]) => [token, value]);
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
 * Numbers in `text` (digits, or Korean-word numbers before a counter) whose value appears
 * in none of `sources`. Whole-run match, so `0` is not backed by `40`; `세 세트` is backed by
 * `3세트` and the other way round. Returns the tokens as written, deduped: digit tokens in
 * order first, then Korean-word ones in order.
 */
export function findUnsupportedNumbers(text: string, sources: string[]): string[] {
  const supported = new Set([
    ...sources.flatMap(digitRuns),
    ...sources.flatMap((source) => wordNumbers(source).map(([, value]) => String(value))),
  ]);
  const found = new Set<string>();
  const body = text.replace(PHOTO_MARKER, " ");
  for (const match of body.matchAll(NUMBER_TOKEN)) {
    const token = match[0].trim().replace(/,+$/, "");
    const [run] = digitRuns(token);
    if (run !== undefined && !supported.has(run)) found.add(token);
  }
  // 한 (one) in a draft is everyday speech (`한 상자`, `한 분`), not a claimed quantity.
  for (const [token, value] of wordNumbers(body)) {
    if (value > 1 && !supported.has(String(value))) found.add(token);
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
