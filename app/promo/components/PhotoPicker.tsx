import { CircleAlertIcon, ImagePlusIcon, SparklesIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/utils";
import { addCandidates, applyPicks, removeCandidate, toggle, type Pick, type Selection } from "../photo-selection";
import { resizeToJpeg } from "../resize-image.client";
import { MAX_PHOTOS, MAX_PICK_CANDIDATES, type PostKind } from "../types";

/** One uploaded photo: the original for the final upload, a small thumbnail for preview + AI. */
export type Candidate = { id: number; file: File; thumb: Blob; preview: string };

const THUMB_EDGE = 640;
const THUMB_QUALITY = 0.7;
const PICK_TIMEOUT_MS = 45_000;
const READ_FAILED = "사진을 읽지 못했어요. 다른 사진으로 다시 시도해 주세요.";
const PICK_FAILED = "사진 고르기에 실패했어요. 직접 골라 주세요.";
const PICK_TIMEOUT = "시간이 너무 걸려요. 다시 시도하거나 직접 골라 주세요.";
const EMPTY: Selection = { order: [], reasons: {} };

type Photos = { list: Candidate[]; sel: Selection };

/**
 * State for the new-post photo grid: candidates (≤ 40), the ordered selection (≤ 8) and the
 * "AI로 고르기" request. Previews are object URLs of the thumbnails only (40 full-size previews
 * can crash iOS Safari); every one is revoked on remove and on unmount.
 */
export function usePhotoPicker() {
  const [photos, setPhotos] = useState<Photos>({ list: [], sel: EMPTY });
  const [preparing, setPreparing] = useState<{ current: number; total: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);
  const nextId = useRef(0);
  const previews = useRef(new Set<string>());
  const alive = useRef(true);
  const preparingRef = useRef(false);
  const pickAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    alive.current = true;
    const urls = previews.current;
    return () => {
      alive.current = false;
      pickAbort.current?.abort();
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, []);

  /** Thumbnails are made one at a time to bound memory; the grid fills as each is ready. */
  async function addFiles(files: File[]) {
    if (preparingRef.current || files.length === 0) return;
    const room = MAX_PICK_CANDIDATES - photos.list.length;
    const take = files.slice(0, Math.max(0, room));
    const messages: string[] = [];
    if (files.length > room) messages.push(`사진은 ${MAX_PICK_CANDIDATES}장까지 올릴 수 있어요.`);
    setNotice(messages[0] ?? null);
    if (take.length === 0) return;

    preparingRef.current = true;
    let failed = false;
    try {
      for (let i = 0; i < take.length; i++) {
        setPreparing({ current: i + 1, total: take.length });
        let thumb: Blob;
        try {
          thumb = (await resizeToJpeg(take[i], THUMB_EDGE, THUMB_QUALITY)).blob;
        } catch {
          failed = true;
          continue;
        }
        if (!alive.current) return;
        const preview = URL.createObjectURL(thumb);
        previews.current.add(preview);
        const candidate: Candidate = { id: nextId.current++, file: take[i], thumb, preview };
        setPhotos((p) => ({ list: [...p.list, candidate], sel: addCandidates(p.sel, [candidate.id]) }));
      }
    } finally {
      preparingRef.current = false;
      if (alive.current) setPreparing(null);
    }
    if (failed) messages.push(READ_FAILED);
    setNotice(messages.length ? messages.join(" ") : null);
  }

  function remove(id: number) {
    const gone = photos.list.find((c) => c.id === id);
    if (!gone) return;
    URL.revokeObjectURL(gone.preview);
    previews.current.delete(gone.preview);
    setPhotos((p) => ({ list: p.list.filter((c) => c.id !== id), sel: removeCandidate(p.sel, id) }));
    setNotice(null);
  }

  function toggleOne(id: number) {
    const full = !photos.sel.order.includes(id) && photos.sel.order.length >= MAX_PHOTOS;
    setNotice(full ? `글에 넣을 사진은 ${MAX_PHOTOS}장까지 고를 수 있어요.` : null);
    if (!full) setPhotos((p) => ({ ...p, sel: toggle(p.sel, id) }));
  }

  /** Stops an AI pick in flight without a message (she submitted, or left the page). */
  function cancelPick() {
    pickAbort.current?.abort();
  }

  async function aiPick(input: { memo: string; kind: PostKind; privateCustomer: boolean }) {
    if (pickAbort.current || preparingRef.current || photos.list.length < 2) return;
    // n in the response is 1-based into exactly this list, in this order.
    const sent = photos.list.slice(0, MAX_PICK_CANDIDATES);
    const sentIds = sent.map((c) => c.id);
    const body = new FormData();
    body.set("memo", input.memo.trim());
    body.set("kind", input.kind);
    if (input.privateCustomer) body.set("privateCustomer", "on");
    for (const c of sent) body.append("thumbs", c.thumb, `thumb-${c.id}.jpg`);

    const controller = new AbortController();
    pickAbort.current = controller;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, PICK_TIMEOUT_MS);
    setPicking(true);
    setPickError(null);

    let picks: Pick[] | null = null;
    let error: string = PICK_FAILED;
    try {
      const res = await fetch("/api/photo-pick", {
        method: "POST",
        body,
        credentials: "same-origin",
        signal: controller.signal,
      });
      const data: unknown = await res.json().catch(() => null);
      if (res.ok) picks = readPicks(data);
      else if (isErrorBody(data)) error = data.error;
    } catch {
      // network failure or abort: handled below
    } finally {
      clearTimeout(timer);
      pickAbort.current = null;
    }
    if (!alive.current) return;
    setPicking(false);
    if (controller.signal.aborted) {
      // A timeout says so; a cancel (submit) stays silent. Either way the selection is untouched.
      if (timedOut) setPickError(PICK_TIMEOUT);
      return;
    }
    if (!picks) {
      setPickError(error);
      return;
    }
    const applied = picks;
    setPhotos((p) => ({ ...p, sel: applyPicks(p.sel, applied, sentIds, new Set(p.list.map((c) => c.id))) }));
    setNotice(null);
  }

  const selected = photos.sel.order
    .map((id) => photos.list.find((c) => c.id === id))
    .filter((c): c is Candidate => c !== undefined);

  return {
    list: photos.list,
    sel: photos.sel,
    selected,
    preparing,
    notice,
    picking,
    pickError,
    addFiles,
    remove,
    toggle: toggleOne,
    aiPick,
    cancelPick,
  };
}

export type PhotoPickerState = ReturnType<typeof usePhotoPicker>;

/** `{ picks: [{ n, reason }] }` with at least one well-formed pick, else null. */
function readPicks(data: unknown): Pick[] | null {
  if (typeof data !== "object" || data === null || !Array.isArray((data as { picks?: unknown }).picks)) return null;
  const picks = (data as { picks: unknown[] }).picks.filter(
    (p): p is Pick =>
      typeof p === "object" &&
      p !== null &&
      typeof (p as Pick).n === "number" &&
      typeof (p as Pick).reason === "string",
  );
  return picks.length ? picks : null;
}

function isErrorBody(data: unknown): data is { error: string } {
  return typeof data === "object" && data !== null && typeof (data as { error?: unknown }).error === "string";
}

export function PhotoPicker({
  picker,
  disabled,
  memo,
  kind,
  privateCustomer,
}: {
  picker: PhotoPickerState;
  /** The form is submitting: nothing in the grid may change. */
  disabled: boolean;
  memo: string;
  kind: PostKind;
  privateCustomer: boolean;
}) {
  const { list, sel, preparing, notice, picking, pickError } = picker;
  const canAdd = !disabled && preparing === null;

  return (
    <section aria-labelledby="photos-title" className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="photos-title" className="text-sm font-medium text-foreground/80">
          사진
        </h2>
        <span className="text-xs text-muted-foreground">
          선택 {sel.order.length}/{MAX_PHOTOS} · 올린 사진 {list.length}/{MAX_PICK_CANDIDATES}
        </span>
      </div>

      <ul className="grid grid-cols-3 gap-2">
        {list.map((c, i) => {
          const position = sel.order.indexOf(c.id);
          const isSelected = position >= 0;
          const reason = isSelected ? sel.reasons[c.id] : undefined;
          return (
            <li key={c.id} className="flex min-w-0 flex-col gap-1">
              <div className="relative aspect-square overflow-hidden rounded-lg border bg-muted">
                <button
                  type="button"
                  onClick={() => picker.toggle(c.id)}
                  disabled={disabled}
                  aria-pressed={isSelected}
                  aria-label={isSelected ? `사진 ${i + 1}, 글의 ${position + 1}번 사진` : `사진 ${i + 1}, 고르지 않음`}
                  className="block size-full outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:ring-inset"
                >
                  <img
                    src={c.preview}
                    alt=""
                    className={cn("size-full object-cover transition-opacity", !isSelected && "opacity-50")}
                  />
                </button>
                {isSelected && (
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute top-1 left-1 flex size-6 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground"
                  >
                    {position + 1}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => picker.remove(c.id)}
                  disabled={disabled}
                  aria-label={`사진 ${i + 1} 지우기`}
                  className="absolute top-0 right-0 flex size-11 items-start justify-end p-1.5"
                >
                  <span className="flex size-6 items-center justify-center rounded-full bg-black/65 text-white">
                    <XIcon className="size-4" aria-hidden="true" />
                  </span>
                </button>
              </div>
              {reason && <p className="line-clamp-1 text-xs break-all text-muted-foreground">{reason}</p>}
            </li>
          );
        })}
        {list.length < MAX_PICK_CANDIDATES && (
          <li>
            <label
              className={cn(
                "flex aspect-square min-h-11 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-input bg-card text-sm text-muted-foreground has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/40",
                canAdd ? "cursor-pointer active:bg-accent" : "opacity-50",
              )}
            >
              <ImagePlusIcon className="size-6" aria-hidden="true" />
              사진 추가
              <input
                type="file"
                accept="image/*"
                multiple
                disabled={!canAdd}
                className="sr-only"
                onChange={(e) => {
                  const files = Array.from(e.currentTarget.files ?? []);
                  e.currentTarget.value = "";
                  void picker.addFiles(files);
                }}
              />
            </label>
          </li>
        )}
      </ul>

      {preparing && (
        <p aria-live="polite" className="text-xs text-muted-foreground">
          사진 준비 중… ({preparing.current}/{preparing.total})
        </p>
      )}
      {notice && <Alert message={notice} />}
      <p className="text-xs text-muted-foreground">
        사진은 없어도 돼요. 사진을 탭하면 글에 넣거나 뺄 수 있어요 (최대 {MAX_PHOTOS}장).
      </p>

      {list.length >= 2 && (
        <div className="flex flex-col gap-1.5">
          <Button
            type="button"
            variant="outline"
            className="min-h-11 w-full"
            disabled={disabled || picking || preparing !== null}
            onClick={() => void picker.aiPick({ memo, kind, privateCustomer })}
          >
            <SparklesIcon aria-hidden="true" />
            {picking ? "AI가 고르는 중…" : "AI로 고르기"}
          </Button>
          {!memo.trim() && <p className="text-xs text-muted-foreground">메모를 먼저 쓰면 더 잘 골라요.</p>}
          {pickError && <Alert message={pickError} />}
        </div>
      )}
    </section>
  );
}

function Alert({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-800"
    >
      <CircleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span>{message}</span>
    </p>
  );
}
