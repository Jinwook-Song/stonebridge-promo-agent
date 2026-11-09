import { env } from "cloudflare:workers";
import { ChevronRightIcon, CircleAlertIcon, CircleCheckIcon } from "lucide-react";
import { useState } from "react";
import { data, Link, useFetcher } from "react-router";
import type { Route } from "./+types/questions";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Textarea } from "../components/ui/textarea";
import {
  answerQuestion,
  confirmQuestion,
  listDone,
  listLeft,
  reopenQuestion,
  skipQuestion,
  type OwnerQuestion,
} from "../questions/questions.server";
import { MAX_ANSWER_CHARS } from "../questions/types";
import { getDb } from "../server/db";
import { DomainError } from "../server/errors";

type ActionResult = { ok?: boolean; error?: string; intent?: string };

const INTENTS = ["answer", "confirm", "later", "unknown", "reopen"] as const;
type Intent = (typeof INTENTS)[number];
/** These take the card off the list. */
const CLOSING: readonly string[] = ["answer", "confirm", "unknown"];

export function meta({}: Route.MetaArgs) {
  return [{ title: "확인할 것 · 스톤브릿지 홍보글" }];
}

export async function loader({}: Route.LoaderArgs) {
  const db = getDb(env.DB);
  const [left, done] = await Promise.all([listLeft(db), listDone(db)]);
  return { left, done };
}

export async function action({ request }: Route.ActionArgs) {
  const db = getDb(env.DB);
  const form = await request.formData();
  const str = (key: string) => {
    const v = form.get(key);
    return typeof v === "string" ? v : "";
  };
  const intent = str("intent");
  const id = str("id");
  if (!id || !(INTENTS as readonly string[]).includes(intent)) {
    return data<ActionResult>({ error: "잘못된 요청이에요.", intent }, { status: 400 });
  }
  const now = new Date();
  try {
    switch (intent as Intent) {
      case "answer":
        await answerQuestion(db, id, str("answer"), now);
        break;
      case "confirm":
        await confirmQuestion(db, id, now);
        break;
      case "later":
      case "unknown":
        await skipQuestion(db, id, intent as "later" | "unknown", now);
        break;
      case "reopen":
        await reopenQuestion(db, id);
        break;
    }
  } catch (e) {
    if (e instanceof DomainError) {
      return data<ActionResult>({ error: e.message, intent }, { status: e.code === "NOT_FOUND" ? 404 : 400 });
    }
    throw e;
  }
  return { ok: true, intent } satisfies ActionResult;
}

export default function Questions({ loaderData }: Route.ComponentProps) {
  const { left, done } = loaderData;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold">확인할 것</h1>
        <p className="text-sm leading-relaxed text-muted-foreground break-keep">
          아는 것만 답해 주시면 돼요. 하나씩 바로 저장되고, 모르는 건 &lsquo;모르겠어요&rsquo;, 나중에 할 건
          &lsquo;나중에&rsquo;를 눌러 주세요.
        </p>
      </div>
      {left.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 px-4 py-10 text-center">
          <CircleCheckIcon className="size-8 text-emerald-600" aria-hidden="true" />
          <p className="text-base">다 답해 주셨어요. 고맙습니다!</p>
          <Button asChild variant="outline">
            <Link to="/">글 목록으로</Link>
          </Button>
        </Card>
      ) : (
        <ol className="flex flex-col gap-3" aria-label="남은 질문">
          {left.map((q) => (
            <li key={q.id}>
              <QuestionCard q={q} />
            </li>
          ))}
        </ol>
      )}
      {done.length > 0 && <DoneList done={done} />}
    </div>
  );
}

function QuestionCard({ q }: { q: OwnerQuestion }) {
  const fetcher = useFetcher<ActionResult>();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(q.kind === "confirm" ? (q.current ?? "") : "");
  const pendingIntent = fetcher.state !== "idle" ? String(fetcher.formData?.get("intent") ?? "") : null;
  const sentOk = fetcher.state === "idle" && fetcher.data?.ok === true && CLOSING.includes(fetcher.data.intent ?? "");
  // Off the list as soon as she taps (the server answers in the background); back with a message if it failed.
  if ((pendingIntent && CLOSING.includes(pendingIntent)) || sentOk) return null;
  const error = fetcher.state === "idle" ? fetcher.data?.error : undefined;
  const busy = fetcher.state !== "idle";
  const send = (intent: Intent, extra: Record<string, string> = {}) =>
    void fetcher.submit({ intent, id: q.id, ...extra }, { method: "post", action: "/questions" });
  const writing = q.kind === "text" || editing;

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-start justify-between gap-2">
          <h2 className="text-base font-semibold break-keep">{q.title}</h2>
          {q.status === "later" && <Badge variant="muted">나중에</Badge>}
        </div>
        {q.body && <p className="text-sm leading-relaxed whitespace-pre-line break-keep">{q.body}</p>}
        {q.why && <p className="text-xs leading-relaxed whitespace-pre-line text-muted-foreground break-keep">{q.why}</p>}
      </div>

      {q.kind === "confirm" && !editing && q.current && (
        <p className="rounded-lg border bg-muted/50 px-3 py-2.5 text-sm leading-relaxed whitespace-pre-line">
          {q.current}
        </p>
      )}

      {q.link && (
        <Button asChild variant={q.kind === "action" ? "default" : "outline"} className="h-11 justify-between">
          <Link to={q.link}>
            {q.linkLabel ?? "화면에서 보기"}
            <ChevronRightIcon aria-hidden="true" />
          </Link>
        </Button>
      )}

      {writing && (
        <Textarea
          aria-label={`${q.title} 답`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={MAX_ANSWER_CHARS}
          rows={q.kind === "confirm" ? Math.min(8, Math.max(3, text.split("\n").length + 1)) : 4}
          placeholder={q.kind === "text" ? "여기에 적어 주세요" : undefined}
        />
      )}

      {error && (
        <p role="alert" className="flex items-start gap-2 text-sm text-red-700">
          <CircleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {error}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {writing ? (
          <Button className="h-11 flex-1" disabled={busy || !text.trim()} onClick={() => send("answer", { answer: text })}>
            {q.kind === "confirm" ? "고친 내용 보내기" : "보내기"}
          </Button>
        ) : (
          <Button className="h-11 flex-1" disabled={busy} onClick={() => send("confirm")}>
            {q.kind === "action" ? "했어요" : "맞아요"}
          </Button>
        )}
        {q.kind === "confirm" && (
          <Button variant="outline" className="h-11" disabled={busy} onClick={() => setEditing(!editing)}>
            {editing ? "그대로 둘게요" : "고칠게요"}
          </Button>
        )}
      </div>
      <div className="flex gap-2">
        {q.kind !== "action" && (
          <Button variant="ghost" className="h-11 flex-1 text-muted-foreground" disabled={busy} onClick={() => send("unknown")}>
            모르겠어요
          </Button>
        )}
        {q.status !== "later" && (
          <Button variant="ghost" className="h-11 flex-1 text-muted-foreground" disabled={busy} onClick={() => send("later")}>
            나중에
          </Button>
        )}
      </div>
    </Card>
  );
}

function DoneList({ done }: { done: OwnerQuestion[] }) {
  return (
    <details className="rounded-xl border bg-card">
      <summary className="flex h-12 cursor-pointer items-center px-4 text-sm text-muted-foreground">
        답한 것 {done.length}개 보기
      </summary>
      <ul className="flex flex-col divide-y border-t">
        {done.map((q) => (
          <li key={q.id}>
            <DoneRow q={q} />
          </li>
        ))}
      </ul>
    </details>
  );
}

function DoneRow({ q }: { q: OwnerQuestion }) {
  const fetcher = useFetcher<ActionResult>();
  if (fetcher.state !== "idle") return null;
  return (
    <div className="flex items-start gap-2 px-4 py-3">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="text-sm font-medium break-keep">{q.title}</p>
        <p className="text-sm whitespace-pre-line text-muted-foreground line-clamp-3">
          {q.status === "unknown" ? "모르겠어요" : q.answer}
        </p>
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="shrink-0"
        onClick={() => void fetcher.submit({ intent: "reopen", id: q.id }, { method: "post", action: "/questions" })}
      >
        다시 답하기
      </Button>
    </div>
  );
}
