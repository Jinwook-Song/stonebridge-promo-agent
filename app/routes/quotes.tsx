import { env } from "cloudflare:workers";
import { ChevronRightIcon, PlusIcon } from "lucide-react";
import { Link } from "react-router";
import type { Route } from "./+types/quotes";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { formatDay } from "../promo/format-date";
import { listQuotes, type QuoteListItem } from "../quote/quotes.server";
import { QUOTE_STATUS_LABELS, type QuoteStatus } from "../quote/types";
import { getDb } from "../server/db";

export const handle = { wide: true };

export function meta({}: Route.MetaArgs) {
  return [{ title: "견적 목록 · 스톤브릿지 홍보글" }];
}

export async function loader({}: Route.LoaderArgs) {
  return { quotes: await listQuotes(getDb(env.DB)) };
}

const STATUS_VARIANT: Record<QuoteStatus, "muted" | "info" | "success" | "destructive"> = {
  draft: "muted",
  sent: "info",
  won: "success",
  lost: "destructive",
};

function NewQuoteButton() {
  return (
    <Button asChild size="lg" className="h-12 w-full sm:w-auto sm:self-start">
      <Link to="/quotes/new">
        <PlusIcon aria-hidden="true" />새 견적
      </Link>
    </Button>
  );
}

export default function Quotes({ loaderData }: Route.ComponentProps) {
  const { quotes } = loaderData;
  if (quotes.length === 0) {
    return (
      <div className="flex flex-col items-center gap-4 py-16 text-center">
        <p className="text-base text-muted-foreground">아직 만든 견적이 없어요. 문의 내용을 붙여 넣어 첫 견적을 만들어 보세요.</p>
        <NewQuoteButton />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <NewQuoteButton />
      <h1 className="sr-only">견적 목록</h1>
      <ul className="flex flex-col divide-y rounded-xl border bg-card">
        {quotes.map((q) => (
          <li key={q.id}>
            <QuoteRow quote={q} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function QuoteRow({ quote: q }: { quote: QuoteListItem }) {
  const title = [q.customerName, q.eventType].filter(Boolean).join(" · ");
  const making = q.total === null && q.latestStatus === "generating";
  return (
    <Link to={`/quotes/${q.id}`} className="flex min-h-16 items-center gap-2 px-3 py-3 active:bg-accent">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>{q.eventDate || formatDay(q.createdAt)}</span>
          {q.headcount !== null && (
            <>
              <span aria-hidden="true">·</span>
              <span>{q.headcount.toLocaleString("ko-KR")}명</span>
            </>
          )}
          <Badge variant={STATUS_VARIANT[q.status]}>{QUOTE_STATUS_LABELS[q.status]}</Badge>
          <span>v{q.latestVersion}</span>
          {q.latestStatus === "generating" && <Badge variant="info">만드는 중</Badge>}
          {q.latestStatus === "failed" && <Badge variant="destructive">실패</Badge>}
          {q.missingPrices > 0 && <Badge variant="warning">단가 없는 줄 {q.missingPrices}개</Badge>}
        </div>
        <p className="truncate text-base">{title || (making ? "견적을 만드는 중이에요" : "(고객 이름 없음)")}</p>
      </div>
      <p className="shrink-0 text-right text-base font-medium tabular-nums">
        {q.total === null ? <span className="text-muted-foreground">—</span> : `${q.total.toLocaleString("ko-KR")}원`}
      </p>
      <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    </Link>
  );
}
