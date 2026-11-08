import { CheckIcon, CopyIcon, LoaderCircleIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { useFetcher, useRevalidator } from "react-router";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Field } from "../../components/ui/label";
import { Textarea } from "../../components/ui/textarea";
import { copyText } from "../clipboard";
import { composeCopy, formatHashtags, HAS_TITLE, parseHashtags, warningsFor } from "../draft-text";
import type { FixedTexts } from "../fixed-text";
import type { DraftRow, PostView } from "../posts.server";
import { CHANNEL_LABELS, MAX_BODY_CHARS, MAX_TITLE_CHARS, type Channel } from "../types";
import { PhotoStrip } from "./PhotoStrip";

/** What the post-detail action returns for a channel request. */
export type DraftActionResult = { ok?: true; error?: string; intent?: string; channel?: Channel };

type Fields = { title: string; body: string; tags: string };

function fieldsOf(d: DraftRow): Fields {
  const tags: string[] = d.hashtags ? JSON.parse(d.hashtags) : [];
  return { title: d.title ?? "", body: d.body, tags: formatHashtags(tags) };
}

/** Same comparison the server makes, so an untouched field never counts as an edit. */
function sameFields(channel: Channel, a: Fields, b: Fields): boolean {
  if (a.body !== b.body) return false;
  if (HAS_TITLE[channel] && a.title.trim() !== b.title.trim()) return false;
  if (channel === "instagram" && formatHashtags(parseHashtags(a.tags)) !== formatHashtags(parseHashtags(b.tags))) {
    return false;
  }
  return true;
}

function formDataFor(intent: string, channel: Channel, f: Fields, extra: Record<string, string> = {}) {
  const data: Record<string, string> = { intent, channel, body: f.body, ...extra };
  if (HAS_TITLE[channel]) data.title = f.title;
  if (channel === "instagram") data.hashtags = f.tags;
  return data;
}

/**
 * Save that outlives the page: leaving (swipe back, link tap, closing the tab) or hiding it
 * (switching to Naver) can unmount the editor with no blur, and a fetcher submit started from
 * a cleanup is dropped. Multipart, not urlencoded: Korean stays 3 bytes a character, well under
 * keepalive's 64 KB for a 10,000-character body. A racing normal save with the same text is a
 * no-op on the server.
 */
function keepaliveSave(postId: number, channel: Channel, f: Fields): Promise<unknown> {
  const body = new FormData();
  for (const [key, value] of Object.entries(formDataFor("save", channel, f))) body.set(key, value);
  return fetch(`/posts/${postId}`, { method: "POST", body, keepalive: true, credentials: "same-origin" }).catch(
    () => {},
  );
}

/** Grows with its content so the owner scrolls the page, not a box inside it. */
function useAutoGrow(value: string, visible: boolean) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !visible) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [value, visible]);
  return ref;
}

export function ChannelEditor({
  postId,
  channel,
  draft,
  post,
  fixed,
  photos,
  visible,
  rewriting,
  generating,
  onToast,
}: {
  postId: number;
  channel: Channel;
  draft: DraftRow;
  post: { memo: string; privateCustomer: boolean; attachPrices: boolean };
  fixed: FixedTexts;
  photos: PostView["photos"];
  /** This tab is the one on screen (the others stay mounted so unsaved text survives). */
  visible: boolean;
  /** This channel is being rewritten right now. */
  rewriting: boolean;
  /** Some generation is running for the post (다시 쓰기 would be refused). */
  generating: boolean;
  onToast: (message: string) => void;
}) {
  const fetcher = useFetcher<DraftActionResult>();
  const { revalidate } = useRevalidator();
  const server = fieldsOf(draft);
  const [local, setLocal] = useState<Fields>(server);
  const [rewriteOpen, setRewriteOpen] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [savedOnce, setSavedOnce] = useState(false);
  // The last request's error stays until she types, sends something new, or the status moves on.
  const [errorCleared, setErrorCleared] = useState(false);
  const seenDraftId = useRef(draft.id);
  const bodyRef = useAutoGrow(local.body, visible);

  // A new AI version (a rewrite landed) replaces the text. The owner's own saves also make new
  // versions; those already match what she typed, so her cursor and focus stay put.
  useEffect(() => {
    if (draft.id === seenDraftId.current) return;
    seenDraftId.current = draft.id;
    if (draft.source === "ai") {
      setLocal(fieldsOf(draft));
      setSavedOnce(false);
    }
  }, [draft]);

  const pendingIntent = fetcher.state !== "idle" ? fetcher.formData?.get("intent") : null;
  const dirty = !sameFields(channel, local, server);
  // Locked from the tap on 보내기, not only once the reloaded page says "rewriting": text typed
  // in between would be replaced by the rewrite.
  const locked = rewriting || pendingIntent === "rewrite";
  const { full, tail } = composeCopy(channel, toDraftFields(local), fixed, post.attachPrices);
  const warnings = warningsFor(toDraftFields(local), post, fixed);
  const confirmed = !dirty && draft.confirmedAt !== null;
  const error = fetcher.state === "idle" && !errorCleared && fetcher.data?.error ? fetcher.data.error : null;

  useEffect(() => setErrorCleared(true), [generating]);

  // A successful 다시 쓰기 closes its box; a refused one (BUSY) keeps her instruction.
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok && fetcher.data.intent === "rewrite") {
      setRewriteOpen(false);
      setInstruction("");
    }
  }, [fetcher.state, fetcher.data]);

  function submit(data: Record<string, string>) {
    setErrorCleared(false);
    void fetcher.submit(data, { method: "post" });
  }

  // Latest values for the listeners below without re-subscribing on every keystroke.
  const saveRef = useRef<(mode: "fetcher" | "keepalive") => Promise<unknown> | void>(() => {});
  saveRef.current = (mode) => {
    if (!dirty || locked) return;
    if (mode === "keepalive") return keepaliveSave(postId, channel, local);
    setSavedOnce(true);
    submit(formDataFor("save", channel, local));
  };

  useEffect(() => {
    // Switching to Naver right after typing may not blur the field first. The page stays
    // alive, so refresh once the save lands to show it as saved.
    const onVisibility = () => {
      if (document.visibilityState !== "hidden") return;
      const saving = saveRef.current("keepalive");
      if (saving) void saving.then(() => revalidate());
    };
    const onPageHide = () => void saveRef.current("keepalive");
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      // Leaving the page inside the app (back swipe, a link) unmounts with no blur.
      void saveRef.current("keepalive");
    };
  }, [revalidate]);

  function onCopy() {
    // Copy first, synchronously inside the tap, then save whatever is unsaved.
    void copyText(full).then((ok) =>
      onToast(ok ? "복사했어요" : "복사하지 못했어요. 아래 '복사될 글 전체 보기'를 열고 길게 눌러 복사해 주세요."),
    );
    void saveRef.current("fetcher");
  }

  function onConfirm() {
    submit(formDataFor("confirm", channel, local));
  }

  function onRewrite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    submit(formDataFor("rewrite", channel, local, { instruction: instruction.trim() }));
  }

  const set = (patch: Partial<Fields>) => {
    setErrorCleared(true);
    setLocal((prev) => ({ ...prev, ...patch }));
  };
  const onBlur = () => void saveRef.current("fetcher");
  const label = CHANNEL_LABELS[channel];

  return (
    <div className="relative flex flex-col gap-4">
      <div className="flex min-h-6 items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {label} · {draft.version}번째 글
        </span>
        <span role="status" aria-live="polite">
          {rewriting ? (
            <span className="flex items-center gap-1 text-sky-700">
              <LoaderCircleIcon className="size-3.5 animate-spin" aria-hidden="true" />
              다시 쓰는 중…
            </span>
          ) : pendingIntent === "save" || pendingIntent === "confirm" ? (
            "저장 중…"
          ) : savedOnce && !dirty ? (
            "저장됨"
          ) : null}
        </span>
      </div>

      {HAS_TITLE[channel] && (
        <Field label="제목" htmlFor={`${channel}-title`}>
          <Input
            id={`${channel}-title`}
            value={local.title}
            maxLength={MAX_TITLE_CHARS}
            readOnly={locked}
            onChange={(e) => set({ title: e.target.value })}
            onBlur={onBlur}
            className="h-11 text-base md:text-base"
          />
        </Field>
      )}

      <Field label="본문" htmlFor={`${channel}-body`}>
        <Textarea
          ref={bodyRef}
          id={`${channel}-body`}
          value={local.body}
          maxLength={MAX_BODY_CHARS}
          readOnly={locked}
          onChange={(e) => set({ body: e.target.value })}
          onBlur={onBlur}
          rows={8}
          className="min-h-48 resize-none overflow-hidden text-base leading-relaxed md:text-base"
        />
      </Field>

      {channel === "instagram" && (
        <Field label="해시태그" htmlFor="instagram-tags" hint="띄어쓰기로 나눠요. # 는 없어도 돼요.">
          <Input
            id="instagram-tags"
            value={local.tags}
            readOnly={locked}
            onChange={(e) => set({ tags: e.target.value })}
            onBlur={onBlur}
            autoCapitalize="off"
            className="h-11 text-base md:text-base"
          />
        </Field>
      )}

      {(warnings.numbers.length > 0 || warnings.names.length > 0) && (
        <div className="flex flex-col gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
          <p className="flex items-center gap-1.5 font-medium">
            <TriangleAlertIcon className="size-4 shrink-0" aria-hidden="true" />
            확인해 주세요
          </p>
          {warnings.numbers.length > 0 && (
            <WarningChips label="메모·가격표에 없는 숫자" items={warnings.numbers} />
          )}
          {warnings.names.length > 0 && <WarningChips label="사람 이름 같아요" items={warnings.names} />}
        </div>
      )}

      <section aria-label="끝에 붙는 글" className="flex flex-col gap-1.5">
        <p className="text-sm font-medium text-foreground/80">끝에 붙는 글</p>
        {tail ? (
          <p className="rounded-lg bg-muted px-3 py-2.5 text-sm break-words whitespace-pre-wrap text-muted-foreground">
            {tail}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            {channel === "place" ? "플레이스는 본문만 복사해요." : "붙는 글이 없어요. 설정에서 꼬리말을 넣을 수 있어요."}
          </p>
        )}
        <details className="group rounded-lg border">
          <summary className="flex min-h-11 cursor-pointer items-center px-3 text-sm text-muted-foreground select-none">
            복사될 글 전체 보기
          </summary>
          <p className="border-t px-3 py-2.5 text-sm break-words whitespace-pre-wrap select-text">{full}</p>
        </details>
      </section>

      {channel === "blog" && <PhotoStrip photos={photos} />}

      {error && (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-800">
          {error}
        </p>
      )}

      {rewriteOpen && !generating && (
        <form onSubmit={onRewrite} className="flex gap-2">
          <Input
            aria-label={`${label} 다시 쓰기 요청`}
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder="예) 더 짧게, 가격 강조"
            maxLength={200}
            enterKeyHint="send"
            autoFocus
            className="h-11 flex-1 text-base md:text-base"
          />
          <Button type="submit" className="h-11 shrink-0">
            보내기
          </Button>
        </form>
      )}

      {/* Thumb reach: the actions stay at the bottom of the screen while scrolling a long draft. */}
      <div className="sticky bottom-0 z-[5] -mx-4 border-t bg-background/95 px-4 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] backdrop-blur">
        {confirmed && (
          <p className="mb-2 flex items-center justify-center gap-1 text-sm font-medium text-emerald-700">
            <CheckIcon className="size-4" aria-hidden="true" />
            확정됨 · 고친 정도 {Math.round((draft.editRatio ?? 0) * 100)}%
          </p>
        )}
        <div className="grid grid-cols-[1.4fr_1fr_1fr] gap-2">
          <Button type="button" className="h-12 text-base" onClick={onCopy} disabled={locked}>
            <CopyIcon aria-hidden="true" />
            복사
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-12"
            onClick={() => setRewriteOpen((v) => !v)}
            disabled={generating}
            aria-expanded={rewriteOpen}
          >
            <RefreshCwIcon aria-hidden="true" />
            다시 쓰기
          </Button>
          <Button
            type="button"
            variant={confirmed ? "secondary" : "outline"}
            className="h-12"
            onClick={onConfirm}
            // Not disabled by a pending autosave: tapping here blurs the field, which starts that
            // save just before this click lands. Confirm resends the text and supersedes it.
            disabled={locked || confirmed || pendingIntent === "confirm"}
          >
            {confirmed ? "확정됨" : pendingIntent === "confirm" ? "확정 중…" : "확정"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function toDraftFields(f: Fields) {
  return { title: f.title, body: f.body, hashtags: parseHashtags(f.tags) };
}

function WarningChips({ label, items }: { label: string; items: string[] }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs">{label}</p>
      <ul className="flex flex-wrap gap-1.5">
        {items.map((item) => (
          <li key={item}>
            <Badge variant="warning" className="border-amber-300 bg-white text-sm">
              {item}
            </Badge>
          </li>
        ))}
      </ul>
    </div>
  );
}
