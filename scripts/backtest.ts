// Usage: npx tsx scripts/backtest.ts --logNo <id>
// Replays one of the owner's real blog posts through the real draft call, with that post removed
// from the example pool, so the draft can be compared with what she actually wrote.
// Needs ANTHROPIC_API_KEY in the environment and private/examples.json (npx tsx scripts/import-blog.ts).
// Writes private/backtest/<logNo>.md (git-ignored). Costs real tokens (about $0.1 per run).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { makeClaudeCalls } from "../app/promo/claude.server";
import { DEFAULT_CHANNEL_RULES, DEFAULT_VOICE_RULES } from "../app/promo/default-rules";
import { findUnsupportedNumbers } from "../app/promo/fact-check";
import { buildSystem, buildUserContent } from "../app/promo/prompt";
import type { Example } from "../app/promo/examples.server";
import type { PromoSettings } from "../app/promo/settings.server";
import { CHANNELS, type Channel, type PostKind } from "../app/promo/types";
import { classifyKind, type SeedExample } from "./blog/parse";

// USD per 1M tokens, claude-opus-5-5.
const INPUT_USD_PER_M = 4;
const OUTPUT_USD_PER_M = 20;

// Same counts as pickExampleSet in app/promo/prompt.ts.
const EXAMPLE_LIMITS: Record<Channel, number> = { blog: 3, instagram: 2, daangn: 2, place: 2 };

const USAGE = "Usage: npx tsx scripts/backtest.ts --logNo <id>";

const { values } = parseArgs({ options: { logNo: { type: "string" } } });
const logNo = values.logNo;
if (!logNo || !/^\d+$/.test(logNo)) {
  console.error(USAGE);
  process.exit(1);
}

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error("ANTHROPIC_API_KEY가 없습니다. / ANTHROPIC_API_KEY is not set.");
  console.error("예: ANTHROPIC_API_KEY=sk-ant-... npx tsx scripts/backtest.ts --logNo <id>");
  process.exit(1);
}

const all = JSON.parse(await readFile("private/examples.json", "utf8")) as SeedExample[];
const target = all.find((e) => e.channel === "blog" && e.sourceUrl.endsWith(`/${logNo}`));
if (!target) {
  console.error(`private/examples.json에 logNo ${logNo} 글이 없습니다. / No blog post with logNo ${logNo} in private/examples.json.`);
  process.exit(1);
}

/** Mirrors pickExamples in app/promo/examples.server.ts: same kind first, newest first. */
function pick(channel: Channel, kind: PostKind): Example[] {
  return all
    .filter((e) => e !== target && e.enabled && e.channel === channel)
    .sort((a, b) => Number(b.kind === kind) - Number(a.kind === kind) || b.createdAt.localeCompare(a.createdAt))
    .slice(0, EXAMPLE_LIMITS[channel])
    .map((e, i) => ({ id: i, channel: e.channel, kind: e.kind, title: e.title, body: e.body, source: e.source }));
}

// Code defaults, no footers or prices: the check is about voice, not the fixed texts.
const settings: PromoSettings = {
  footerBlog: "",
  footerShort: "",
  priceTable: "",
  voiceRules: DEFAULT_VOICE_RULES,
  channelRules: DEFAULT_CHANNEL_RULES,
};

const kind = classifyKind(target.title);
const memo = target.title;
const examples = Object.fromEntries(CHANNELS.map((c) => [c, pick(c, kind)])) as Record<Channel, Example[]>;

const system = buildSystem(settings, examples);
const user = buildUserContent({ kind, memo, privateCustomer: false, attachPrices: false }, []);

console.log(`logNo ${logNo} (${kind}): ${target.title}`);
console.log("Claude 호출 중... (30초~1분) / calling Claude...");
const { drafts } = makeClaudeCalls(apiKey);
const { output, inputTokens, outputTokens } = await drafts({ system, user });

const blogText = `${output.blog.title}\n${output.blog.body}`;
const unsupported = findUnsupportedNumbers(blogText, [memo, settings.priceTable, settings.footerBlog, settings.footerShort]);
const cost = (inputTokens * INPUT_USD_PER_M + outputTokens * OUTPUT_USD_PER_M) / 1e6;

const report = [
  `# 백테스트 ${logNo}`,
  "",
  `- 글 종류: ${kind}`,
  `- 메모(실제 글 제목): ${memo}`,
  "- 조건: 사진 없음, 메모 = 실제 글 제목만. 실제 사용보다 사실이 적어서 글이 짧거나 일반적일 수 있다.",
  `- 예시: ${CHANNELS.map((c) => `${c} ${examples[c].length}`).join(", ")} (이 글 제외)`,
  `- 토큰: 입력 ${inputTokens}, 출력 ${outputTokens}, 약 $${cost.toFixed(3)}`,
  "",
  "## 실제 글",
  "",
  `제목: ${target.title}`,
  "",
  target.body,
  "",
  "## 에이전트 블로그 초안",
  "",
  `제목: ${output.blog.title}`,
  "",
  output.blog.body,
  "",
  "## 숫자 경고",
  "",
  unsupported.length > 0 ? unsupported.map((n) => `- ${n}`).join("\n") : "없음",
  "",
].join("\n");

await mkdir("private/backtest", { recursive: true });
const out = `private/backtest/${logNo}.md`;
await writeFile(out, report);
console.log(`wrote ${out} | tokens in ${inputTokens} / out ${outputTokens} | $${cost.toFixed(3)} | 숫자 경고 ${unsupported.length}`);
