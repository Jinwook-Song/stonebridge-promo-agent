import { toBase64 } from "../lib/base64";
import { GenerationError, permanentApiFailure, type PickCall } from "./claude.server";
import { pickPhotos, type PickInput, type ThumbSource } from "./photo-pick.server";
import { MAX_MEMO_CHARS, MAX_PICK_CANDIDATES, MAX_THUMB_BYTES, POST_KINDS, type PostKind } from "./types";

const THUMB_TYPES: readonly string[] = ["image/jpeg", "image/png", "image/webp"] satisfies ThumbSource["media_type"][];
const PICK_FAILED = "사진 고르기에 실패했어요. 직접 골라 주세요.";

/**
 * POST /api/photo-pick (app/routes/api.photo-pick.ts). Multipart `memo`, `kind`,
 * `privateCustomer` ("on"), repeated `thumbs` files → 200 `{ picks: [{ n, reason }] }` (n is
 * 1-based in the `thumbs` order sent) or `{ error }` (400 bad input, 502 model failure).
 * Kept out of the route file: a non-route export there would pull server code into the client.
 */
export async function handlePhotoPick(
  request: Request,
  deps: { pick: PickCall; /** Public demo: false = over the AI call cap, with the message to show. */ allowCall?: () => Promise<string | null> },
): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: "요청을 읽지 못했어요. 다시 시도해 주세요." }, { status: 400 });
  }

  const parsed = await readInput(form);
  if (typeof parsed === "string") return Response.json({ error: parsed }, { status: 400 });
  // Only valid requests count toward the demo cap, so bad posts cannot use it up.
  const refused = deps.allowCall ? await deps.allowCall() : null;
  if (refused) return Response.json({ error: refused }, { status: 429 });

  try {
    const { picks } = await pickPhotos(deps.pick, parsed);
    // Nothing usable left after cleaning: same as a failed pick, she picks by hand.
    if (picks.length === 0) {
      console.error("photo pick returned no usable picks", { count: parsed.thumbs.length });
      return Response.json({ error: PICK_FAILED }, { status: 502 });
    }
    return Response.json({ picks });
  } catch (e) {
    if (e instanceof GenerationError) return Response.json({ error: e.message }, { status: 502 });
    const permanent = permanentApiFailure(e);
    if (permanent) return Response.json({ error: permanent.message }, { status: 502 });
    console.error("photo pick failed", e);
    return Response.json({ error: PICK_FAILED }, { status: 502 });
  }
}

/** The pick input, or the Korean message to show. */
async function readInput(form: FormData): Promise<PickInput | string> {
  const kind = String(form.get("kind") ?? "");
  if (!(POST_KINDS as readonly string[]).includes(kind)) return "글 종류를 선택해 주세요.";
  const memo = String(form.get("memo") ?? "").trim();
  if (memo.length > MAX_MEMO_CHARS) return `메모는 ${MAX_MEMO_CHARS}자까지 쓸 수 있어요.`;

  const entries = form.getAll("thumbs");
  if (entries.length < 2) return "AI로 고르려면 사진이 2장 이상 있어야 해요.";
  if (entries.length > MAX_PICK_CANDIDATES) return `AI로 고르기는 사진 ${MAX_PICK_CANDIDATES}장까지 할 수 있어요.`;
  for (const entry of entries) {
    if (!(entry instanceof File) || entry.size === 0 || !THUMB_TYPES.includes(entry.type)) {
      return "사진은 JPG, PNG, WEBP 파일만 고를 수 있어요.";
    }
    if (entry.size > MAX_THUMB_BYTES) return "사진 미리보기가 너무 커요. 사진을 다시 올려 주세요.";
  }

  const thumbs = await Promise.all(
    (entries as File[]).map(async (file) => ({
      media_type: file.type as ThumbSource["media_type"],
      data: toBase64(new Uint8Array(await file.arrayBuffer())),
    })),
  );
  return { kind: kind as PostKind, memo, privateCustomer: form.get("privateCustomer") === "on", thumbs };
}
