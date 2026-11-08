import { env } from "cloudflare:workers";
import { CircleAlertIcon, ImagePlusIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { redirect, useNavigation, useSubmit } from "react-router";
import type { Route } from "./+types/post-new";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import { Field, Label } from "../components/ui/label";
import { Textarea } from "../components/ui/textarea";
import { createPost } from "../promo/posts.server";
import { resizeToJpeg } from "../promo/resize-image.client";
import { KIND_LABELS, MAX_MEMO_CHARS, MAX_PHOTOS, POST_KINDS, type PostKind } from "../promo/types";
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
    // Task 7 starts the generation right here.
    return redirect(`/posts/${id}`);
  } catch (e) {
    if (e instanceof DomainError && (e.code === "INVALID_INPUT" || e.code === "INVALID_FILE")) return { error: e.message };
    throw e;
  }
}

type Picked = { id: number; file: File; preview: string };

export default function PostNew({ actionData }: Route.ComponentProps) {
  const submit = useSubmit();
  const navigation = useNavigation();
  const [picked, setPicked] = useState<Picked[]>([]);
  const [kind, setKind] = useState<PostKind>("case");
  const [privateCustomer, setPrivateCustomer] = useState(false);
  const [attachPrices, setAttachPrices] = useState(false);
  const [resizing, setResizing] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const nextId = useRef(0);
  const previews = useRef<string[]>([]);

  useEffect(
    () => () => {
      for (const url of previews.current) URL.revokeObjectURL(url);
    },
    [],
  );

  const busy = resizing || navigation.state !== "idle";
  const error = localError ?? actionData?.error ?? null;

  function addFiles(list: FileList | null) {
    if (!list) return;
    const room = MAX_PHOTOS - picked.length;
    const added = Array.from(list)
      .slice(0, Math.max(0, room))
      .map((file) => {
        const preview = URL.createObjectURL(file);
        previews.current.push(preview);
        return { id: nextId.current++, file, preview };
      });
    setLocalError(list.length > room ? `사진은 ${MAX_PHOTOS}장까지 올릴 수 있어요.` : null);
    setPicked((prev) => [...prev, ...added]);
  }

  function removeFile(id: number) {
    setPicked((prev) => {
      const gone = prev.find((p) => p.id === id);
      if (gone) {
        URL.revokeObjectURL(gone.preview);
        previews.current = previews.current.filter((u) => u !== gone.preview);
      }
      return prev.filter((p) => p.id !== id);
    });
    setLocalError(null);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const memo = String(form.get("memo") ?? "").trim();
    if (!memo) {
      setLocalError("메모를 입력해 주세요.");
      return;
    }
    setLocalError(null);

    const body = new FormData();
    body.set("kind", kind);
    body.set("memo", memo);
    if (privateCustomer) body.set("privateCustomer", "on");
    if (attachPrices) body.set("attachPrices", "on");

    setResizing(true);
    try {
      for (const { file } of picked) {
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

      <section aria-labelledby="photos-title" className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between">
          <h2 id="photos-title" className="text-sm font-medium text-foreground/80">
            사진
          </h2>
          <span className="text-xs text-muted-foreground">
            {picked.length}/{MAX_PHOTOS}장
          </span>
        </div>
        <ul className="grid grid-cols-3 gap-2">
          {picked.map((p, i) => (
            <li key={p.id} className="relative aspect-square overflow-hidden rounded-lg border bg-muted">
              <img src={p.preview} alt={`선택한 사진 ${i + 1}`} className="size-full object-cover" />
              <button
                type="button"
                onClick={() => removeFile(p.id)}
                aria-label={`사진 ${i + 1} 빼기`}
                className="absolute top-0 right-0 flex size-11 items-start justify-end p-1.5"
              >
                <span className="flex size-6 items-center justify-center rounded-full bg-black/65 text-white">
                  <XIcon className="size-4" aria-hidden="true" />
                </span>
              </button>
            </li>
          ))}
          {picked.length < MAX_PHOTOS && (
            <li>
              <label className="flex aspect-square min-h-11 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-input bg-card text-sm text-muted-foreground active:bg-accent has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/40">
                <ImagePlusIcon className="size-6" aria-hidden="true" />
                사진 추가
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  className="sr-only"
                  onChange={(e) => {
                    addFiles(e.currentTarget.files);
                    e.currentTarget.value = "";
                  }}
                />
              </label>
            </li>
          )}
        </ul>
        <p className="text-xs text-muted-foreground">사진은 없어도 돼요. 최대 {MAX_PHOTOS}장까지 올릴 수 있어요.</p>
      </section>

      <Field label="메모" htmlFor="memo" hint={`${MAX_MEMO_CHARS}자까지 쓸 수 있어요.`}>
        <Textarea
          id="memo"
          name="memo"
          rows={5}
          maxLength={MAX_MEMO_CHARS}
          placeholder={MEMO_PLACEHOLDER}
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

      <Button type="submit" size="lg" className="h-12" disabled={busy}>
        {resizing ? "사진 준비 중…" : busy ? "올리는 중…" : "초안 만들기"}
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
