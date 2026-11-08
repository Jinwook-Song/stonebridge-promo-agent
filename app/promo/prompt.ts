import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Db } from "../server/db";
import { type Example, pickExamples } from "./examples.server";
import type { PromoSettings } from "./settings.server";
import type { Channel, PostKind } from "./types";

// ---- Output schemas -------------------------------------------------------
// Passed to Claude structured outputs (`output_config.format`), which supports only a
// JSON-Schema subset: plain objects, strings, string arrays, integers, nullable.
// No min/max/regex/refinements/transforms/defaults here.

export const DraftOutput = z.object({
  blog: z.object({
    title: z.string().describe("블로그 제목. 채널 규칙의 제목 형식을 따른다."),
    body: z
      .string()
      .describe("블로그 본문. 사진 위치에 [사진 N] 표시 포함. 꼬리말·가격표 제외."),
  }),
  instagram: z.object({
    body: z.string().describe("인스타그램 본문. 해시태그·꼬리말 제외."),
    hashtags: z.array(z.string()).describe("해시태그 목록. # 없이 단어만."),
  }),
  daangn: z.object({
    title: z.string().describe("당근 소식 제목."),
    body: z.string().describe("당근 소식 본문. 해시태그·꼬리말·가격표 제외."),
  }),
  place: z.object({
    body: z.string().describe("네이버 플레이스 소식 본문. 핵심 정보만."),
  }),
  photos: z
    .array(
      z.object({
        n: z.number().int().describe("사진 번호 (블로그 본문의 [사진 N]과 같은 번호)."),
        note: z.string().describe("그 사진에 대한 한 줄 설명."),
      }),
    )
    .describe("블로그 사진 순서와 한 줄 설명. 사진이 없으면 빈 배열."),
});
export type DraftOutput = z.infer<typeof DraftOutput>;

export const ChannelRewrite = z.object({
  title: z.string().nullable().describe("제목. 이 채널에 제목이 없으면 null."),
  body: z.string().describe("다시 쓴 본문. 꼬리말·가격표 제외."),
  hashtags: z
    .array(z.string())
    .nullable()
    .describe("해시태그 목록(# 없이 단어만). 이 채널에 해시태그가 없으면 null."),
});
export type ChannelRewrite = z.infer<typeof ChannelRewrite>;

// ---- Labels ---------------------------------------------------------------

const KIND_LABEL: Record<PostKind, string> = {
  case: "단체 주문 사례",
  product: "상품·시즌",
  other: "기타",
};

const CHANNEL_LABEL: Record<Channel, string> = {
  blog: "블로그",
  instagram: "인스타그램",
  daangn: "당근",
  place: "플레이스",
};

// ---- System prompt --------------------------------------------------------

const ROLE_LINE =
  "당신은 실제로 운영 중인 카페의 사장님이 되어 홍보 글을 씁니다. " +
  "글은 모두 사장님이 직접 쓴 것처럼 1인칭(\"저희\")으로 씁니다. " +
  "네 채널(블로그, 인스타그램, 당근, 플레이스)에 같은 내용을 쓰되 채널마다 말투와 분량을 맞춥니다. " +
  "일반적인 마케팅 문체보다 아래 예시 글의 말투와 구성을 가깝게 따라 합니다.";

const ABSOLUTE_RULES = `- 메모, 사진, 사장님이 준 정보에 없는 숫자·가격·날짜·기관 이름·사람 이름은 쓰지 않는다. 모르면 그 문장을 빼거나 "문의 주세요"로 쓴다.
- 꼬리말(배송 정책, 주소, 영업시간, 연락처)과 가격표는 쓰지 않는다. 프로그램이 따로 붙인다.
- 일반 이모지(😊🎉👍 등)는 쓰지 않는다. 얼굴 문자만 쓴다.
- 개인 고객 주문이면 이름·연락처·사는 곳을 쓰지 않는다.`;

type ExampleSet = Record<Channel, Example[]>;

/**
 * Deterministic for identical inputs (prompt caching): no dates or randomness, and the
 * examples keep the order they were given in.
 */
export function buildSystem(s: PromoSettings, ex: ExampleSet): string {
  const exampleBlocks = (Object.keys(CHANNEL_LABEL) as Channel[]).flatMap((channel) =>
    ex[channel].map((e, i) => {
      const heading = `### ${CHANNEL_LABEL[channel]} 예시 ${i + 1} (${KIND_LABEL[e.kind]})`;
      return [heading, e.title ? `제목: ${e.title}` : null, e.body.trim()]
        .filter((line) => line !== null)
        .join("\n");
    }),
  );

  return [
    ROLE_LINE,
    `## 말투 규칙\n${s.voiceRules.trim()}`,
    `## 채널 규칙\n${s.channelRules.trim()}`,
    `## 절대 규칙\n${ABSOLUTE_RULES}`,
    exampleBlocks.length > 0 ? `## 예시 글\n\n${exampleBlocks.join("\n\n")}` : null,
  ]
    .filter((section) => section !== null)
    .join("\n\n");
}

// ---- User message ---------------------------------------------------------

/** Production passes `{ type: "url", url }`; local dev passes base64. */
export type ImageSource = Anthropic.ImageBlockParam["source"];

export function buildUserContent(
  post: { kind: PostKind; memo: string; privateCustomer: boolean; attachPrices: boolean },
  sources: ImageSource[],
): Anthropic.ContentBlockParam[] {
  const photos = sources.flatMap((source, i): Anthropic.ContentBlockParam[] => [
    { type: "text", text: `사진 ${i + 1}` },
    { type: "image", source },
  ]);
  const markerInstruction =
    sources.length > 0
      ? `블로그 본문에 사진 위치를 [사진 1]~[사진 ${sources.length}]로 표시하세요.`
      : "사진이 없습니다. [사진] 표시를 쓰지 마세요.";
  const brief = [
    `글 종류: ${KIND_LABEL[post.kind]}`,
    `메모: ${post.memo.trim() || "(없음)"}`,
    `개인 고객 여부: ${post.privateCustomer ? "개인 고객 주문 (이름·연락처·사는 곳 쓰지 않기)" : "아님"}`,
    markerInstruction,
  ].join("\n");
  return [...photos, { type: "text", text: brief }];
}

// ---- Examples -------------------------------------------------------------

export async function pickExampleSet(db: Db, kind: PostKind): Promise<ExampleSet> {
  const [blog, instagram, daangn, place] = await Promise.all([
    pickExamples(db, "blog", kind, 3),
    pickExamples(db, "instagram", kind, 2),
    pickExamples(db, "daangn", kind, 2),
    pickExamples(db, "place", kind, 2),
  ]);
  return { blog, instagram, daangn, place };
}
