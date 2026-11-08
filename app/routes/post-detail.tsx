import { env } from "cloudflare:workers";
import { CheckIcon, CircleAlertIcon, LoaderCircleIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { data, useFetcher } from "react-router";
import type { Route } from "./+types/post-detail";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { ChannelEditor, type DraftActionResult } from "../promo/components/ChannelEditor";
import { useStatusPolling } from "../promo/components/use-status-polling";
import { parseHashtags } from "../promo/draft-text";
import { clearPostError, confirmDraft, saveDraftEdit } from "../promo/drafts.server";
import { formatDay } from "../promo/format-date";
import { startGeneration } from "../promo/generate.server";
import { getPost } from "../promo/posts.server";
import { getSettings } from "../promo/settings.server";
import { CHANNEL_LABELS, CHANNELS, KIND_LABELS, type Channel } from "../promo/types";
import { getDb } from "../server/db";
import { DomainError } from "../server/errors";

const WAITING = "초안을 만드는 중이에요. 몇 분 걸릴 수 있어요. 화면을 닫아도 계속 만들어요.";
const MAX_INSTRUCTION_CHARS = 200;

export function meta({}: Route.MetaArgs) {
  return [{ title: "초안 · 스톤브릿지 홍보글" }];
}

function postIdOf(params: { id?: string }): number {
  const id = Number(params.id);
  if (!Number.isSafeInteger(id) || id <= 0) throw data("글을 찾을 수 없어요.", { status: 404 });
  return id;
}

export async function loader({ params }: Route.LoaderArgs) {
  const db = getDb(env.DB);
  const id = postIdOf(params);
  const [view, settings] = await Promise.all([getPost(db, id), getSettings(db)]);
  if (!view) throw data("글을 찾을 수 없어요.", { status: 404 });
  // Only the texts the screen appends and checks against; the prompt rules stay on the server.
  const fixed = { footerBlog: settings.footerBlog, footerShort: settings.footerShort, priceTable: settings.priceTable };
  return { ...view, fixed };
}

export async function action({ request, params }: Route.ActionArgs) {
  const db = getDb(env.DB);
  const id = postIdOf(params);
  const form = await request.formData();
  const str = (key: string) => {
    const v = form.get(key);
    return typeof v === "string" ? v : undefined;
  };
  const intent = str("intent") ?? "";
  const rawChannel = str("channel");
  const channel = (CHANNELS as readonly string[]).includes(rawChannel ?? "") ? (rawChannel as Channel) : undefined;
  const now = new Date();

  const saveEdit = async () => {
    const body = str("body");
    if (!channel || body === undefined) throw new DomainError("INVALID_INPUT", "잘못된 요청입니다.");
    const hashtags = str("hashtags");
    await saveDraftEdit(
      db,
      id,
      channel,
      { title: str("title"), body, hashtags: hashtags === undefined ? undefined : parseHashtags(hashtags) },
      now,
    );
  };

  try {
    switch (intent) {
      case "save":
        await saveEdit();
        await clearPostError(db, id);
        break;
      case "confirm":
        // Saves the text on screen first, in this same request, so 확정 never races an autosave.
        await saveEdit();
        await confirmDraft(db, id, channel!, now);
        await clearPostError(db, id);
        break;
      case "rewrite": {
        // The rewrite starts from what she sees, not the last autosave.
        await saveEdit();
        const instruction = (str("instruction") ?? "").trim().slice(0, MAX_INSTRUCTION_CHARS);
        await startGeneration(env, db, id, { channel, instruction }, now);
        break;
      }
      case "retry":
        await startGeneration(env, db, id, {}, now);
        break;
      case "dismissError":
        await clearPostError(db, id);
        break;
      default:
        return data<DraftActionResult>({ error: "잘못된 요청입니다.", intent }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof DomainError) {
      const result: DraftActionResult = { error: e.message, intent, channel };
      return e.code === "INVALID_INPUT" ? data(result, { status: 400 }) : result;
    }
    throw e;
  }
  return { ok: true, intent, channel } satisfies DraftActionResult;
}

export default function PostDetail({ loaderData }: Route.ComponentProps) {
  const { post, photos, drafts, fixed } = loaderData;
  const generating = post.status === "generating";
  const hasDrafts = CHANNELS.some((c) => drafts[c] !== null);
  // A one-channel rewrite keeps the other tabs usable; a full generation takes the whole page.
  const rewritingChannel = generating ? post.rewritingChannel : null;
  const fullWait = generating && (!rewritingChannel || !hasDrafts);
  useStatusPolling(post.id, generating);

  // Keyed by post: going back/forward between two posts reuses this route component, and the
  // editors seed their text from the first draft they see. A new key unmounts the old post's
  // editors (their cleanup saves unsaved text to that post) and starts fresh for this one.
  return (
    <div className="flex flex-col gap-4">
      <PostHeader post={post} />
      {fullWait ? (
        <Waiting />
      ) : post.status === "failed" || (post.status === "draft" && !hasDrafts) ? (
        <StartAgain key={post.id} status={post.status} error={post.error} />
      ) : (
        <ChannelTabs
          key={post.id}
          postId={post.id}
          post={post}
          drafts={drafts}
          photos={photos}
          fixed={fixed}
          rewritingChannel={rewritingChannel}
          generating={generating}
        />
      )}
    </div>
  );
}

function PostHeader({ post }: { post: Route.ComponentProps["loaderData"]["post"] }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
        <span>{formatDay(post.createdAt)}</span>
        <span aria-hidden="true">·</span>
        <span>{KIND_LABELS[post.kind]}</span>
        {post.privateCustomer && <Badge variant="muted">개인 고객</Badge>}
        {post.attachPrices && <Badge variant="muted">가격표</Badge>}
      </div>
      <h1 className="line-clamp-2 text-base font-semibold break-words">{post.memo}</h1>
    </div>
  );
}

function Waiting() {
  return (
    <div role="status" className="flex flex-col items-center gap-4 px-2 py-16 text-center">
      <LoaderCircleIcon className="size-10 animate-spin text-primary" aria-hidden="true" />
      <p className="text-base leading-relaxed break-keep">{WAITING}</p>
    </div>
  );
}

function StartAgain({ status, error }: { status: "draft" | "failed" | "ready" | "generating"; error: string | null }) {
  const fetcher = useFetcher<DraftActionResult>();
  const busy = fetcher.state !== "idle";
  const failed = status === "failed";
  const message = fetcher.data?.error ?? (failed ? (error ?? "초안을 만들지 못했어요.") : null);
  return (
    <div className="flex flex-col gap-4 py-8">
      {message ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-800"
        >
          <CircleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{message}</span>
        </p>
      ) : (
        <p className="text-center text-sm text-muted-foreground">아직 초안을 만들지 않았어요.</p>
      )}
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value="retry" />
        <Button type="submit" size="lg" className="h-12 w-full" disabled={busy}>
          {busy ? "시작하는 중…" : failed ? "다시 시도" : "초안 만들기"}
        </Button>
      </fetcher.Form>
    </div>
  );
}

function ChannelTabs({
  postId,
  post,
  drafts,
  photos,
  fixed,
  rewritingChannel,
  generating,
}: {
  postId: number;
  post: Route.ComponentProps["loaderData"]["post"];
  drafts: Route.ComponentProps["loaderData"]["drafts"];
  photos: Route.ComponentProps["loaderData"]["photos"];
  fixed: Route.ComponentProps["loaderData"]["fixed"];
  rewritingChannel: Channel | null;
  generating: boolean;
}) {
  const [tab, setTab] = useState<Channel>("blog");
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  function showToast(text: string) {
    clearTimeout(toastTimer.current);
    setToast({ id: Date.now(), text });
    toastTimer.current = setTimeout(() => setToast(null), 2000);
  }

  return (
    <>
      {/* Keyed by run: a later failed rewrite shows again even after an earlier one was dismissed. */}
      {post.error && !generating && <ErrorNote key={post.workflowId ?? "none"} postId={postId} error={post.error} />}
      <Tabs value={tab} onValueChange={(v) => setTab(v as Channel)}>
        <TabsList className="h-auto p-1">
          {CHANNELS.map((c) => (
            <TabsTrigger key={c} value={c} className="h-11 gap-1 px-1 text-[15px]">
              {CHANNEL_LABELS[c]}
              {rewritingChannel === c ? (
                <LoaderCircleIcon className="size-3.5 animate-spin" aria-label="다시 쓰는 중" />
              ) : drafts[c]?.confirmedAt ? (
                <CheckIcon className="size-3.5 text-emerald-600" aria-label="확정됨" />
              ) : null}
            </TabsTrigger>
          ))}
        </TabsList>
        {CHANNELS.map((c) => {
          const draft = drafts[c];
          return (
            // Mounted while hidden so text typed in one tab survives switching to another.
            <TabsContent key={c} value={c} forceMount className="data-[state=inactive]:hidden">
              {draft ? (
                <ChannelEditor
                  key={`${postId}-${c}`}
                  postId={postId}
                  channel={c}
                  draft={draft}
                  post={post}
                  fixed={fixed}
                  photos={photos}
                  visible={tab === c}
                  rewriting={rewritingChannel === c}
                  generating={generating}
                  onToast={showToast}
                />
              ) : (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  {rewritingChannel === c ? "다시 쓰는 중이에요…" : "이 채널 초안이 없어요."}
                </p>
              )}
            </TabsContent>
          );
        })}
      </Tabs>
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+6rem)] z-20 flex justify-center px-4"
      >
        {toast && (
          <span key={toast.id} className="rounded-full bg-foreground/90 px-4 py-2 text-sm text-background shadow-lg">
            {toast.text}
          </span>
        )}
      </div>
    </>
  );
}

function ErrorNote({ postId, error }: { postId: number; error: string }) {
  const fetcher = useFetcher<DraftActionResult>();
  // Hidden as soon as she taps ✕; the revalidated loader then agrees.
  if (fetcher.state !== "idle" || fetcher.data?.ok) return null;
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 py-1 pl-3 text-sm text-amber-900"
    >
      <TriangleAlertIcon className="mt-2.5 size-4 shrink-0" aria-hidden="true" />
      <p className="flex-1 py-2">다시 쓰지 못했어요. {error}</p>
      <fetcher.Form method="post" action={`/posts/${postId}`}>
        <input type="hidden" name="intent" value="dismissError" />
        <button
          type="submit"
          aria-label="알림 닫기"
          className="flex size-11 items-center justify-center rounded-md text-amber-900 active:bg-amber-100"
        >
          <XIcon className="size-4" aria-hidden="true" />
        </button>
      </fetcher.Form>
    </div>
  );
}
