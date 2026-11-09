import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { z } from "zod";
import { PhotoPickOutput } from "./photo-pick.server";
import { ChannelRewrite, DraftOutput } from "./prompt";

const MODEL = "claude-opus-5-5";
// Thinking counts toward max_tokens on Opus 5.5 (always on; effort is set per call). Streaming,
// so a large cap is safe; it is a ceiling, not a cost.
const MAX_TOKENS = 64000;
// On a policy decline the API re-runs the request on Anthropic's recommended model for that
// refusal category, inside the same call. The SDK (0.100) does not type `fallbacks` yet; it
// forwards unknown body fields as-is.
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export type GenerationFailure = "refusal" | "max_tokens" | "invalid_output" | "public_origin";

const FAILURE_MESSAGES: Record<GenerationFailure, string> = {
  refusal: "AI가 이 요청을 거절했어요. 메모를 바꿔 다시 시도해 주세요.",
  max_tokens: "글이 너무 길어져서 끝까지 쓰지 못했어요. 다시 시도해 주세요.",
  invalid_output: "AI 답을 읽지 못했어요. 다시 시도해 주세요.",
  // Deploy setup, not the owner's input: retrying cannot fix it.
  public_origin: "앱 주소 설정(PUBLIC_ORIGIN)이 안 되어 있어요. 관리자에게 알려 주세요.",
};

/**
 * A model answer we cannot use, or a setup problem found before the call. Retrying the same
 * request will not help, so it is not retried.
 */
export class GenerationError extends Error {
  constructor(public readonly reason: GenerationFailure) {
    super(FAILURE_MESSAGES[reason]);
    this.name = "GenerationError";
  }
}

/**
 * API errors that will fail the same way on every retry (bad key, bad request, too large), with
 * the Korean message to show. null = transient (network, 408, 409, 429, 5xx) or not an API error.
 */
export function permanentApiFailure(e: unknown): { message: string } | null {
  if (!(e instanceof Anthropic.APIError)) return null;
  switch (e.status) {
    case 401:
    case 403:
    // Wrong model id or endpoint: a setup problem, like a bad key.
    case 404:
      return { message: "AI 연결 설정에 문제가 있어요. 관리자에게 알려 주세요." };
    case 400:
    case 413:
    case 422:
      return { message: "AI가 요청을 처리하지 못했어요. 사진 수를 줄이거나 메모를 바꿔 다시 시도해 주세요." };
    default:
      return null;
  }
}

export type ModelRequest = { system: string; user: Anthropic.ContentBlockParam[] };
type ModelResult<T> = { output: T; inputTokens: number; outputTokens: number };
export type DraftCall = (req: ModelRequest) => Promise<ModelResult<DraftOutput>>;
export type RewriteCall = (req: ModelRequest) => Promise<ModelResult<ChannelRewrite>>;
export type PickCall = (req: ModelRequest) => Promise<ModelResult<PhotoPickOutput>>;
export type ClaudeCalls = { drafts: DraftCall; rewrite: RewriteCall; pick: PickCall };

type Effort = "low" | "medium" | "high";

/**
 * The pick is a synchronous call the browser abandons after 45 s: no SDK retries (each retry is
 * billed) and a 40 s cap so the call ends before the browser gives up. Drafts/rewrite keep the
 * SDK defaults (they run in a Workflow step that has its own retry policy).
 */
const PICK_REQUEST_OPTIONS = { maxRetries: 0, timeout: 40_000 } as const;

/**
 * Real calls. API errors (network, 429, 5xx, ...) are left to propagate as the SDK's typed
 * errors so the Workflow step retries them; only unusable answers become GenerationError.
 */
export function makeClaudeCalls(apiKey: string): ClaudeCalls {
  const client = new Anthropic({ apiKey });

  async function call<S extends z.ZodType>(
    schema: S,
    req: ModelRequest,
    effort: Effort,
    options?: { maxRetries?: number; timeout?: number },
  ): Promise<ModelResult<z.infer<S>>> {
    const params: BetaMessageStreamParams & { fallbacks: "default" } = {
      model: MODEL,
      max_tokens: MAX_TOKENS,
      betas: [FALLBACK_BETA],
      fallbacks: "default",
      // Thinking is always on for this model; effort defaults to medium, so set it.
      // Only the JSON schema, not the helper's `parse`: with `parse` the SDK parses every text
      // block inside finalMessage() and throws on a refusal / cut-off / fallback partial before
      // stop_reason can be checked. We parse ourselves below.
      output_config: { effort, format: { type: "json_schema", schema: zodOutputFormat(schema).schema } },
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: req.user }],
    };
    const message = await client.beta.messages.stream(params, options).finalMessage();
    // Numbers only (no text): shows in `wrangler tail` / Workers Logs, e.g. to check that a
    // rewrite reads the system prompt from cache (docs/deploy-checklist.md).
    console.info("claude usage", { stop_reason: message.stop_reason, ...message.usage });

    // Check why it stopped before reading any content: a refusal or a cut-off leaves
    // partial (or no) text.
    if (message.stop_reason === "refusal") throw new GenerationError("refusal");
    if (message.stop_reason === "max_tokens") throw new GenerationError("max_tokens");

    const output = parseOutput(schema, message.content);

    const u = message.usage;
    return {
      output,
      inputTokens: u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
      outputTokens: u.output_tokens,
    };
  }

  return {
    drafts: (req) => call(DraftOutput, req, "high"),
    rewrite: (req) => call(ChannelRewrite, req, "high"),
    // A short answer the owner waits for on the form: low keeps the wait short (spec: measure,
    // raise to medium if the picks are poor).
    pick: (req) => call(PhotoPickOutput, req, "low", PICK_REQUEST_OPTIONS),
  };
}

/**
 * Normally there is one text block. After a mid-stream fallback, `content` keeps the declined
 * partial, then a `fallback` block, then the fallback model's text — which is either a whole
 * answer or the rest of the partial — so try the last text block alone, then all text joined.
 */
function parseOutput<S extends z.ZodType>(schema: S, content: Anthropic.Beta.Messages.BetaContentBlock[]): z.infer<S> {
  const texts = content.flatMap((b) => (b.type === "text" ? [b.text] : []));
  const candidates = texts.length > 1 ? [texts[texts.length - 1], texts.join("")] : texts;
  for (const text of candidates) {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      continue;
    }
    const parsed = schema.safeParse(json);
    if (parsed.success) return parsed.data;
  }
  throw new GenerationError("invalid_output");
}

/**
 * Local-dev stand-in (FAKE_CLAUDE=1 in .dev.vars): canned drafts after a short wait, so the
 * screens can be tried without an API key or spending tokens.
 */
export function makeFakeClaudeCalls(): ClaudeCalls {
  const wait = () => new Promise((resolve) => setTimeout(resolve, 2000));
  return {
    drafts: async () => {
      await wait();
      return {
        output: {
          blog: {
            title: "[테스트] 가짜 초안 제목",
            body: "안녕하세요 (테스트 초안)\n\n[사진 1]\n\n오늘도 정성껏 준비했어요!\n감사합니다 ^^",
          },
          instagram: { body: "오늘도 정성껏 준비했어요!\n(테스트 초안)", hashtags: ["테스트", "가짜초안"] },
          daangn: { title: "가짜 초안 소식", body: "안녕하세요 이웃님들!\n오늘도 정성껏 준비했어요.\n(테스트 초안)" },
          place: { body: "오늘도 정성껏 준비했어요. (테스트 초안)" },
          photos: [{ n: 1, note: "테스트 사진 설명" }],
        },
        inputTokens: 0,
        outputTokens: 0,
      };
    },
    rewrite: async () => {
      await wait();
      return {
        output: { title: "[테스트] 다시 쓴 제목", body: "다시 써 봤어요! (테스트 초안)", hashtags: ["테스트"] },
        inputTokens: 0,
        outputTokens: 0,
      };
    },
    // The first min(8, N) photos in the order sent.
    pick: async (req) => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const count = req.user.filter((b) => b.type === "image").length;
      return {
        output: { picks: Array.from({ length: Math.min(8, count) }, (_, i) => ({ n: i + 1, reason: "테스트 사진" })) },
        inputTokens: 0,
        outputTokens: 0,
      };
    },
  };
}
