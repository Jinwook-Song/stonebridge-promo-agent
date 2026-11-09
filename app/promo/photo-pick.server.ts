import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
// Types only: claude.server imports PhotoPickOutput from here, so a value import would be a cycle.
import type { ModelRequest, PickCall } from "./claude.server";
import { KIND_LABELS, MAX_PHOTOS, type PostKind } from "./types";

// Structured-output subset (see the top of prompt.ts): no min/max, so the 1–8 limit lives in
// the descriptions and in cleanPicks.
export const PhotoPickOutput = z.object({
  picks: z
    .array(
      z.object({
        n: z.number().int().describe("고른 사진 번호 (사진 앞의 '사진 N'의 N)."),
        reason: z.string().describe("그 사진에 보이는 것. 20자 이내. 가격·맛·칭찬 없이 보이는 것만."),
      }),
    )
    .describe("블로그에 넣을 사진 1~8장, 블로그 글 순서대로. 같은 번호는 한 번만."),
});
export type PhotoPickOutput = z.infer<typeof PhotoPickOutput>;

export type PickedPhoto = { n: number; reason: string };

export type ThumbSource = { media_type: "image/jpeg" | "image/png" | "image/webp"; data: string };

export type PickInput = { memo: string; kind: PostKind; privateCustomer: boolean; thumbs: ThumbSource[] };

const MAX_REASON_CHARS = 40;

const PICK_SYSTEM = [
  "카페 사장님이 올린 사진 후보 중에서 블로그 홍보글에 넣을 사진을 고른다.",
  "- 메모에 쓴 내용(상품, 포장, 수량, 배달·설치 모습)이 잘 보이는 사진을 고른다.",
  "- 거의 같은 사진이 여러 장이면 가장 선명하고 밝은 한 장만 고른다.",
  "- 흐리거나 어두운 사진, 화면 캡처는 고르지 않는다.",
  "- 개인 고객 주문이면 사람 얼굴이 보이는 사진은 고르지 않는다.",
  `- 1장에서 ${MAX_PHOTOS}장까지 고른다. 겹치는 사진이 많으면 ${MAX_PHOTOS}장보다 적게 골라도 된다.`,
  "- 순서는 블로그 글 순서: 전체 모습 먼저, 그다음 자세한 모습, 마지막에 포장·배달.",
  "- n은 사진 앞에 붙은 '사진 N'의 번호다.",
  "- reason은 사진에 보이는 것을 20자 이내로 쓴다. 예: \"샌드위치 30개 전체 모습\".",
  "- reason에 가격, 맛, 품질 칭찬처럼 사진에 보이지 않는 내용은 쓰지 않는다.",
].join("\n");

export function buildPickRequest(input: PickInput): ModelRequest {
  const photos = input.thumbs.flatMap((t, i): Anthropic.ContentBlockParam[] => [
    { type: "text", text: `사진 ${i + 1}` },
    { type: "image", source: { type: "base64", media_type: t.media_type, data: t.data } },
  ]);
  const memo = input.memo.trim();
  const lines = [
    `사진 ${input.thumbs.length}장 중에서 골라 주세요.`,
    `글 종류: ${KIND_LABELS[input.kind]}`,
    `메모: ${memo || "(메모 없음)"}`,
  ];
  if (input.privateCustomer) lines.push("개인 고객 주문: 사람 얼굴이 보이는 사진은 고르지 마세요.");
  return { system: PICK_SYSTEM, user: [...photos, { type: "text", text: lines.join("\n") }] };
}

/** Keeps 1 ≤ n ≤ count, first occurrence only, at most MAX_PHOTOS; reasons trimmed and capped. */
export function cleanPicks(raw: PhotoPickOutput, count: number): PickedPhoto[] {
  const seen = new Set<number>();
  const out: PickedPhoto[] = [];
  for (const { n, reason } of raw.picks) {
    if (out.length >= MAX_PHOTOS) break;
    if (!Number.isInteger(n) || n < 1 || n > count || seen.has(n)) continue;
    seen.add(n);
    // Code points, not UTF-16 units, so an emoji is never cut in half.
    out.push({ n, reason: Array.from(reason.trim()).slice(0, MAX_REASON_CHARS).join("").trim() });
  }
  return out;
}

export async function pickPhotos(
  call: PickCall,
  input: PickInput,
): Promise<{ picks: PickedPhoto[]; inputTokens: number; outputTokens: number }> {
  const started = Date.now();
  const { output, inputTokens, outputTokens } = await call(buildPickRequest(input));
  const picks = cleanPicks(output, input.thumbs.length);
  // Numbers only (no memo, no reasons): for measuring wait and cost in Workers Logs.
  console.info("photo pick", { count: input.thumbs.length, ms: Date.now() - started, inputTokens, outputTokens });
  return { picks, inputTokens, outputTokens };
}
