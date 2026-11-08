// Spec §5.5: flag numbers and names in a draft that the owner never supplied.
// Pure string functions; the UI shows the hits as a yellow warning.

const NUMBER_TOKEN = /\d[\d,]*(?:\.\d+)?[ \t]?(?:원|구|세트|인분|개|명|시|분|일|월|%)?/g;
const DIGIT_RUN = /\d[\d,]*(?:\.\d+)?/g;
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
 * Numbers in `text` whose digit run appears in none of `sources`. Whole-run match, so
 * `0` is not backed by `40`. Returns the tokens as written, deduped, in order.
 */
export function findUnsupportedNumbers(text: string, sources: string[]): string[] {
  const supported = new Set(sources.flatMap(digitRuns));
  const found = new Set<string>();
  for (const match of text.replace(PHOTO_MARKER, " ").matchAll(NUMBER_TOKEN)) {
    const token = match[0].trim().replace(/,+$/, "");
    const [run] = digitRuns(token);
    if (run !== undefined && !supported.has(run)) found.add(token);
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
