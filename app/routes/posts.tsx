import { env } from "cloudflare:workers";
import { CheckIcon, ChevronRightIcon, MessageCircleQuestionMarkIcon, PlusIcon } from "lucide-react";
import { Link } from "react-router";
import type { Route } from "./+types/posts";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { formatDay } from "../promo/format-date";
import { listPosts, type PostListItem } from "../promo/posts.server";
import { countLeft } from "../questions/questions.server";
import { CHANNELS, KIND_LABELS } from "../promo/types";
import { getDb } from "../server/db";

export function meta({}: Route.MetaArgs) {
  return [{ title: "글 목록 · 스톤브릿지 홍보글" }];
}

export async function loader({}: Route.LoaderArgs) {
  const db = getDb(env.DB);
  const [posts, questionsLeft] = await Promise.all([listPosts(db), countLeft(db)]);
  return { posts, questionsLeft };
}

const STATUS: Record<PostListItem["status"], { label: string; variant: "muted" | "info" | "success" | "destructive" }> = {
  draft: { label: "초안", variant: "muted" },
  generating: { label: "만드는 중", variant: "info" },
  ready: { label: "완료", variant: "success" },
  failed: { label: "실패", variant: "destructive" },
};

function NewPostButton() {
  return (
    <Button asChild size="lg" className="h-12 w-full">
      <Link to="/posts/new">
        <PlusIcon aria-hidden="true" />새 글
      </Link>
    </Button>
  );
}

/** Questions for her, until she has answered or skipped them all. */
function QuestionsBanner({ left }: { left: number }) {
  if (left === 0) return null;
  return (
    <Link
      to="/questions"
      className="flex min-h-14 items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-amber-900 active:bg-amber-100"
    >
      <MessageCircleQuestionMarkIcon className="size-5 shrink-0" aria-hidden="true" />
      <span className="flex-1 text-base font-medium">확인할 것 {left}개가 남았어요</span>
      <ChevronRightIcon className="size-4 shrink-0" aria-hidden="true" />
    </Link>
  );
}

export default function Posts({ loaderData }: Route.ComponentProps) {
  const { posts, questionsLeft } = loaderData;
  if (posts.length === 0) {
    return (
      <div className="flex flex-col items-center gap-4 py-16 text-center">
        <QuestionsBanner left={questionsLeft} />
        <p className="text-base text-muted-foreground">아직 쓴 글이 없어요. 사진과 메모로 첫 글을 만들어 보세요.</p>
        <NewPostButton />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <QuestionsBanner left={questionsLeft} />
      <NewPostButton />
      <h1 className="sr-only">글 목록</h1>
      <ul className="flex flex-col divide-y rounded-xl border bg-card">
        {posts.map((p) => (
          <li key={p.id}>
            <PostRow post={p} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function PostRow({ post: p }: { post: PostListItem }) {
  const status = STATUS[p.status];
  return (
    <Link to={`/posts/${p.id}`} className="flex min-h-16 items-center gap-2 px-3 py-3 active:bg-accent">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>{formatDay(p.createdAt)}</span>
          <span aria-hidden="true">·</span>
          <span>{KIND_LABELS[p.kind]}</span>
          <Badge variant={status.variant}>{status.label}</Badge>
          {p.confirmedCount > 0 && (
            <span
              className="flex items-center gap-0.5 text-emerald-700"
              aria-label={`${CHANNELS.length}개 중 ${p.confirmedCount}개 확정`}
            >
              <CheckIcon className="size-3.5" aria-hidden="true" />
              {p.confirmedCount}
            </span>
          )}
        </div>
        <p className="truncate text-base">{p.memoPreview}</p>
      </div>
      <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    </Link>
  );
}
