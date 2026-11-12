import { env } from "cloudflare:workers";
import { CircleAlertIcon } from "lucide-react";
import { useState, type FormEvent } from "react";
import { redirect, useNavigation, useSubmit } from "react-router";
import type { Route } from "./+types/post-new";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import { Field, Label } from "../components/ui/label";
import { Textarea } from "../components/ui/textarea";
import { demoTopicGate } from "../demo/topic-gate.server";
import { makeClaudeCalls, makeFakeClaudeCalls } from "../promo/claude.server";
import { startGeneration } from "../promo/generate.server";
import { createPost } from "../promo/posts.server";
import { resizeToJpeg } from "../promo/resize-image.client";
import { PhotoPicker, usePhotoPicker } from "../promo/components/PhotoPicker";
import { KIND_LABELS, MAX_MEMO_CHARS, POST_KINDS, type PostKind } from "../promo/types";
import { getDb } from "../server/db";
import { DomainError } from "../server/errors";
import { cn } from "../lib/utils";

const MEMO_PLACEHOLDER = "예) 구리 OO고등학교 마카롱 6구 40세트, 리본+쇼핑백, 선생님 선물용";

export function meta({}: Route.MetaArgs) {
  return [{ title: "새 글 · 스톤브릿지 홍보글" }];
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const kind = String(form.get("kind") ?? "");
  const numbers = (name: string) => form.getAll(name).map((v) => Math.max(0, Math.round(Number(v)) || 0));
  const widths = numbers("photoWidth");
  const heights = numbers("photoHeight");
  // An empty file input posts a 0-byte part; skip those.
  const files = form.getAll("photos").filter((v): v is File => v instanceof File && v.size > 0);

  try {
    // Public demo only: an off-topic memo gets a reason on the form instead of a post.
    if ((POST_KINDS as readonly string[]).includes(kind)) {
      const fakeClaude: string = env.FAKE_CLAUDE;
      const calls = fakeClaude === "1" ? makeFakeClaudeCalls() : makeClaudeCalls(env.ANTHROPIC_API_KEY);
      const refused = await demoTopicGate(
        env,
        getDb(env.DB),
        calls.topic,
        { memo: String(form.get("memo") ?? ""), kind: kind as PostKind },
        new Date(),
      );
      if (refused) return { error: refused };
    }
    const id = await createPost(
      getDb(env.DB),
      env.PHOTOS,
      {
        kind: kind as PostKind,
        memo: String(form.get("memo") ?? ""),
        privateCustomer: form.get("privateCustomer") === "on",
        attachPrices: form.get("attachPrices") === "on",
        photos: files,
        photoSizes: files.map((_, i) => ({ width: widths[i] ?? 0, height: heights[i] ?? 0 })),
      },
      new Date(),
    );
    // The post exists now: whatever happens to the start, go to it rather than letting the
    // owner submit again and create a duplicate. A fresh post is never "generating", and a
    // failed start is recorded on the post itself.
    try {
      await startGeneration(env, getDb(env.DB), id, {});
    } catch (e) {
      console.error("startGeneration failed after createPost", { postId: id, error: e });
    }
    return redirect(`/posts/${id}`);
  } catch (e) {
    if (e instanceof DomainError && (e.code === "INVALID_INPUT" || e.code === "INVALID_FILE")) return { error: e.message };
    throw e;
  }
}

export default function PostNew({ actionData }: Route.ComponentProps) {
  const submit = useSubmit();
  const navigation = useNavigation();
  const picker = usePhotoPicker();
  const [memo, setMemo] = useState("");
  const [kind, setKind] = useState<PostKind>("case");
  const [privateCustomer, setPrivateCustomer] = useState(false);
  const [attachPrices, setAttachPrices] = useState(false);
  const [resizing, setResizing] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const busy = resizing || navigation.state !== "idle";
  const error = localError ?? actionData?.error ?? null;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || picker.preparing) return;
    const trimmed = memo.trim();
    if (!trimmed) {
      setLocalError("메모를 입력해 주세요.");
      return;
    }
    setLocalError(null);
    // Posting never waits for the AI: her current selection goes as it is.
    picker.cancelPick();

    const body = new FormData();
    body.set("kind", kind);
    body.set("memo", trimmed);
    if (privateCustomer) body.set("privateCustomer", "on");
    if (attachPrices) body.set("attachPrices", "on");

    setResizing(true);
    try {
      // Originals, in the chosen order, resized as before; the thumbnails are only for the grid.
      for (const { file } of picker.selected) {
        const { blob, width, height } = await resizeToJpeg(file);
        body.append("photos", blob, "photo.jpg");
        body.append("photoWidth", String(width));
        body.append("photoHeight", String(height));
      }
    } catch {
      setResizing(false);
      setLocalError("사진을 읽지 못했어요. 다른 사진으로 다시 시도해 주세요.");
      return;
    }
    setResizing(false);
    await submit(body, { method: "post", encType: "multipart/form-data" });
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5">
      <h1 className="text-lg font-semibold">새 글</h1>

      <PhotoPicker picker={picker} disabled={busy} memo={memo} kind={kind} privateCustomer={privateCustomer} />

      <Field label="메모" htmlFor="memo" hint={`${MAX_MEMO_CHARS}자까지 쓸 수 있어요.`}>
        <Textarea
          id="memo"
          name="memo"
          rows={5}
          maxLength={MAX_MEMO_CHARS}
          placeholder={MEMO_PLACEHOLDER}
          value={memo}
          onChange={(e) => setMemo(e.currentTarget.value)}
          className="min-h-32"
        />
      </Field>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-medium text-foreground/80">글 종류</legend>
        <div className="flex flex-col gap-2">
          {POST_KINDS.map((k) => (
            <label
              key={k}
              className={cn(
                "flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border px-3 text-base has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/40",
                kind === k ? "border-primary bg-primary/5 font-medium" : "bg-card",
              )}
            >
              <input
                type="radio"
                name="kind"
                value={k}
                checked={kind === k}
                onChange={() => setKind(k)}
                className="size-5 accent-primary"
              />
              {KIND_LABELS[k]}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="flex flex-col gap-1">
        <CheckRow id="privateCustomer" checked={privateCustomer} onChange={setPrivateCustomer} label="개인 고객" />
        <CheckRow id="attachPrices" checked={attachPrices} onChange={setAttachPrices} label="가격표 붙이기" />
      </div>

      {error && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-800"
        >
          <CircleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </p>
      )}

      <Button type="submit" size="lg" className="h-12" disabled={busy || picker.preparing !== null}>
        {resizing || picker.preparing ? "사진 준비 중…" : busy ? "올리는 중…" : "초안 만들기"}
      </Button>
    </form>
  );
}

function CheckRow({
  id,
  checked,
  onChange,
  label,
}: {
  id: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  return (
    <div className="flex min-h-11 items-center gap-3">
      <Checkbox id={id} checked={checked} onCheckedChange={(v) => onChange(v === true)} />
      <Label htmlFor={id} className="min-h-11 flex-1 text-base">
        {label}
      </Label>
    </div>
  );
}
