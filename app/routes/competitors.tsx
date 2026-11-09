import { env } from "cloudflare:workers";
import { CircleAlertIcon, CircleCheckIcon, ExternalLinkIcon, PlayIcon, SearchIcon } from "lucide-react";
import { Form, Link, NavLink, useFetcher } from "react-router";
import type { Route } from "./+types/competitors";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Input, inputClass } from "../components/ui/input";
import { Field } from "../components/ui/label";
import { cn } from "../lib/utils";
import { getDb } from "../server/db";
import { DomainError } from "../server/errors";
import {
  listEvents,
  listPriceGroups,
  type EventView,
  type PriceGroup,
  type PriceView,
} from "../watch/competitors.server";
import { safeHref, seenDate, won } from "../watch/format";
import { startManualWatchRun } from "../watch/run.server";
import { deleteWatchSource, listWatchSources, saveWatchSource, type WatchSource } from "../watch/sources.server";
import { WATCH_KINDS, type WatchKind } from "../watch/types";

export const handle = { wide: true };

const TABS = [
  { id: "news", label: "소식" },
  { id: "prices", label: "가격" },
  { id: "sources", label: "감시 목록" },
] as const;
type TabId = (typeof TABS)[number]["id"];

const KIND_LABELS: Record<WatchKind, string> = { rss: "블로그 글 (RSS)", page: "가격 페이지" };

/** Success text shown after a "지금 한 번 돌리기". */
const ALREADY_RUNNING = "이미 돌고 있어요. 조금 뒤에 확인해 주세요.";
const RUN_NOW_MESSAGE = "감시를 시작했어요. 몇 분 뒤에 소식 탭을 새로 열어 확인해 주세요.";

type ActionResult = { ok?: boolean; error?: string; message?: string } | undefined;

export function meta({}: Route.MetaArgs) {
  return [{ title: "경쟁 업체 · 스톤브릿지 홍보글" }];
}

function parseTab(raw: string | null): TabId {
  return TABS.find((t) => t.id === raw)?.id ?? "news";
}

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const tab = parseTab(url.searchParams.get("tab"));
  const q = (url.searchParams.get("q") ?? "").trim();
  const db = getDb(env.DB);
  // A search that fails shows the unfiltered list and says so, not an error page.
  let events: EventView[] = [];
  let searchFailed = false;
  if (tab === "news") {
    try {
      events = await listEvents(db, q);
    } catch (e) {
      if (q === "") throw e;
      console.error("competitor search failed", e);
      searchFailed = true;
      events = await listEvents(db, "");
    }
  }
  // Only the open tab's data is read.
  return {
    tab,
    q,
    searchFailed,
    events,
    prices: tab === "prices" ? await listPriceGroups(db) : [],
    sources: tab === "sources" ? await listWatchSources(db) : [],
  };
}

function wholeNumber(raw: string): number {
  if (!/^\d+$/.test(raw.trim())) throw new DomainError("INVALID_INPUT", "잘못된 요청입니다.");
  return Number(raw.trim());
}

export async function action({ request }: Route.ActionArgs): Promise<NonNullable<ActionResult>> {
  const form = await request.formData();
  const str = (key: string) => String(form.get(key) ?? "");
  const db = getDb(env.DB);

  try {
    switch (str("intent")) {
      case "saveSource": {
        const idText = str("id").trim();
        const kind = str("kind");
        if (!(WATCH_KINDS as readonly string[]).includes(kind)) throw new DomainError("INVALID_INPUT", "종류가 올바르지 않아요.");
        await saveWatchSource(
          db,
          {
            id: idText === "" ? undefined : wholeNumber(idText),
            name: str("name"),
            kind: kind as WatchKind,
            url: str("url"),
            memo: str("memo"),
            enabled: str("enabled") === "1",
          },
          new Date(),
        );
        return { ok: true };
      }
      case "deleteSource":
        await deleteWatchSource(db, wholeNumber(str("id")));
        return { ok: true };
      case "runNow": {
        const now = new Date();
        try {
          if ((await startManualWatchRun(env.WATCH, now)) === "already_running") return { ok: true, message: ALREADY_RUNNING };
        } catch (e) {
          console.error("manual watch run failed to start", e);
          return { error: "감시를 시작하지 못했어요. 잠시 뒤에 다시 눌러 주세요." };
        }
        return { ok: true, message: RUN_NOW_MESSAGE };
      }
      default:
        return { error: "잘못된 요청입니다." };
    }
  } catch (e) {
    if (e instanceof DomainError) return { error: e.message };
    throw e;
  }
}

function Message({ result, success }: { result: ActionResult; success?: string }) {
  if (result?.error) {
    return (
      <p role="alert" className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-800">
        <CircleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span>{result.error}</span>
      </p>
    );
  }
  if (result?.ok) {
    return (
      <p role="status" className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-800">
        <CircleCheckIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span>{result.message ?? success ?? "저장했어요."}</span>
      </p>
    );
  }
  return null;
}

export default function Competitors({ loaderData }: Route.ComponentProps) {
  const { tab, q, searchFailed, events, prices, sources } = loaderData;
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold">경쟁 업체</h1>
      <nav aria-label="경쟁 업체 탭" className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1">
        {TABS.map((t) => (
          <NavLink
            key={t.id}
            to={`/competitors?tab=${t.id}`}
            replace
            className={cn(
              "flex h-11 items-center justify-center rounded-md text-sm font-medium",
              t.id === tab ? "bg-card text-foreground shadow-xs" : "text-muted-foreground",
            )}
            aria-current={t.id === tab ? "page" : undefined}
          >
            {t.label}
          </NavLink>
        ))}
      </nav>
      {tab === "news" && <NewsTab q={q} searchFailed={searchFailed} events={events} />}
      {tab === "prices" && <PricesTab groups={prices} />}
      {tab === "sources" && <SourcesTab sources={sources} />}
    </div>
  );
}

// ---- Shared bits ---------------------------------------------------------------------------

/** Where a number came from: the link and the day it was seen. Always shown with competitor data. */
function Source({ url, seenAt }: { url: string; seenAt: string }) {
  const href = safeHref(url);
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="inline-flex min-h-11 items-center gap-1 break-all text-primary underline underline-offset-2"
        >
          출처 보기
          <ExternalLinkIcon className="size-3.5 shrink-0" aria-hidden="true" />
        </a>
      ) : (
        <span className="break-all">{url}</span>
      )}
      <span>{seenDate(seenAt)} 확인</span>
    </p>
  );
}

// ---- 소식 ----------------------------------------------------------------------------------

function NewsTab({ q, searchFailed, events }: { q: string; searchFailed: boolean; events: EventView[] }) {
  return (
    <div className="flex flex-col gap-3">
      <Form method="get" role="search" className="flex gap-2">
        <input type="hidden" name="tab" value="news" />
        <Input name="q" defaultValue={q} className="h-11 flex-1" placeholder="업체, 고객, 장소로 찾기" aria-label="업체, 고객, 장소로 찾기" />
        <Button type="submit" className="h-11">
          <SearchIcon aria-hidden="true" />
          찾기
        </Button>
      </Form>
      {searchFailed && (
        <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
          검색하지 못해서 전체 소식을 보여 드려요. 잠시 뒤에 다시 찾아 주세요.
        </p>
      )}
      {q !== "" && !searchFailed && (
        <p className="flex flex-wrap items-center gap-x-3 text-sm text-muted-foreground">
          <span>'{q}' 검색 결과 {events.length}개</span>
          <Link to="/competitors?tab=news" className="flex min-h-11 items-center underline underline-offset-2">
            검색 지우기
          </Link>
        </p>
      )}
      {events.length === 0 ? (
        <p className="py-10 text-center text-base text-muted-foreground">
          {q !== "" ? "찾은 소식이 없어요." : "아직 자료 없음. 감시 목록에서 '지금 한 번 돌리기'를 눌러 보세요."}
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {events.map((e) => (
            <li key={e.id}>
              <EventCard event={e} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EventCard({ event: e }: { event: EventView }) {
  const facts = [
    e.date,
    e.venue,
    e.headcount !== null ? `${e.headcount.toLocaleString("ko-KR")}명` : null,
    e.quantity !== null ? `${e.quantity.toLocaleString("ko-KR")}개` : null,
  ].filter(Boolean);
  return (
    <Card className="flex flex-col gap-1.5 p-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Badge variant="outline">{e.sourceName}</Badge>
        {e.eventType && <Badge variant="muted">{e.eventType}</Badge>}
      </div>
      <p className="text-base font-medium break-words">{e.client || "(고객 이름 없음)"}</p>
      {facts.length > 0 && <p className="text-sm text-muted-foreground">{facts.join(" · ")}</p>}
      {e.menu.length > 0 && <p className="text-sm break-words">메뉴: {e.menu.join(", ")}</p>}
      {e.price !== null && <p className="text-sm font-medium tabular-nums">행사 금액 {won(e.price)}</p>}
      {e.notes && <p className="text-sm break-words">메모: {e.notes}</p>}
      <Source url={e.sourceUrl} seenAt={e.seenAt} />
    </Card>
  );
}

// ---- 가격 ----------------------------------------------------------------------------------

function PricesTab({ groups }: { groups: PriceGroup[] }) {
  if (groups.length === 0) {
    return <p className="py-10 text-center text-base text-muted-foreground">아직 자료 없음. 가격 페이지를 감시 목록에 넣으면 여기에 쌓여요.</p>;
  }
  return (
    <ul className="flex flex-col gap-3">
      {groups.map((g) => (
        <li key={`${g.sourceId}-${g.packageName}`}>
          <PriceCard group={g} />
        </li>
      ))}
    </ul>
  );
}

function PriceFacts({ p }: { p: PriceView }) {
  return (
    <>
      <p className="text-base font-medium tabular-nums">{p.perPerson !== null ? `1인 ${won(p.perPerson)}` : "1인 가격 없음"}</p>
      {p.minimum !== null && <p className="text-sm text-muted-foreground">최소 {p.minimum.toLocaleString("ko-KR")}명</p>}
      {p.items.length > 0 && <p className="text-sm break-words">구성: {p.items.join(", ")}</p>}
      {p.fees.length > 0 && <p className="text-sm break-words">추가 비용: {p.fees.join(", ")}</p>}
    </>
  );
}

function PriceCard({ group: g }: { group: PriceGroup }) {
  return (
    <Card className="flex flex-col gap-1.5 p-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Badge variant="outline">{g.sourceName}</Badge>
        <h2 className="font-semibold break-words">{g.packageName}</h2>
      </div>
      <PriceFacts p={g.latest} />
      <Source url={g.latest.sourceUrl} seenAt={g.latest.seenAt} />
      {g.earlier.length > 0 && (
        <details className="group">
          <summary className="flex min-h-11 cursor-pointer items-center text-sm text-primary underline underline-offset-2">
            이전 값 {g.earlier.length}개 보기
          </summary>
          <ul className="flex flex-col divide-y rounded-lg border bg-muted/40">
            {g.earlier.map((p) => (
              <li key={p.id} className="flex flex-col gap-1 px-3 py-2">
                <PriceFacts p={p} />
                <Source url={p.sourceUrl} seenAt={p.seenAt} />
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}

// ---- 감시 목록 -----------------------------------------------------------------------------

function SourcesTab({ sources }: { sources: WatchSource[] }) {
  const run = useFetcher<ActionResult>();
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <run.Form method="post">
          <input type="hidden" name="intent" value="runNow" />
          <Button type="submit" size="lg" className="h-12 w-full sm:w-auto" disabled={run.state !== "idle"}>
            <PlayIcon aria-hidden="true" />
            {run.state !== "idle" ? "시작하는 중…" : "지금 한 번 돌리기"}
          </Button>
        </run.Form>
        <Message result={run.data} />
        <p className="text-xs text-muted-foreground">감시는 매일 밤 3시에 저절로 돌아요. 가격 페이지는 일주일에 한 번만 다시 읽어요.</p>
      </div>
      {sources.length === 0 && <p className="text-sm text-muted-foreground">아직 감시하는 곳이 없어요. 아래에서 추가해 주세요.</p>}
      <ul className="flex flex-col gap-3">
        {sources.map((s) => (
          <li key={s.id}>
            <SourceRow source={s} />
          </li>
        ))}
      </ul>
      <AddSource key={sources.length} />
    </div>
  );
}

function SourceFields({ source }: { source?: WatchSource }) {
  const id = source ? `source-${source.id}` : "source-new";
  return (
    <>
      {source && <input type="hidden" name="id" value={source.id} />}
      <Field label="이름" htmlFor={`${id}-name`}>
        <Input id={`${id}-name`} name="name" defaultValue={source?.name ?? ""} className="h-11" required />
      </Field>
      <Field label="종류" htmlFor={`${id}-kind`}>
        <select id={`${id}-kind`} name="kind" defaultValue={source?.kind ?? "rss"} className={cn(inputClass, "h-11")}>
          {WATCH_KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABELS[k]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="주소" htmlFor={`${id}-url`} hint="http:// 또는 https://로 시작해요.">
        <Input id={`${id}-url`} name="url" type="url" inputMode="url" defaultValue={source?.url ?? ""} className="h-11" required />
      </Field>
      <Field label="메모" htmlFor={`${id}-memo`}>
        <Input id={`${id}-memo`} name="memo" defaultValue={source?.memo ?? ""} className="h-11" />
      </Field>
      <label className="flex min-h-11 items-center gap-2 text-sm font-medium">
        <input type="checkbox" name="enabled" value="1" defaultChecked={source?.enabled ?? true} className="size-5" />
        감시 켜기
      </label>
    </>
  );
}

function RunState({ source: s }: { source: WatchSource }) {
  // Without an error status, lastError is a note (skipped for budget), not a failure.
  const note = s.lastStatus !== "error" && s.lastError ? <p className="break-words text-muted-foreground">{s.lastError}</p> : null;
  if (s.lastStatus === null) {
    return (
      <div className="flex flex-col gap-1 text-sm">
        <p className="text-muted-foreground">아직 돌린 적 없어요.</p>
        {note}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1 text-sm">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
        <Badge variant={s.lastStatus === "ok" ? "success" : "destructive"}>{s.lastStatus === "ok" ? "정상" : "오류"}</Badge>
        {s.lastRunAt && <span>마지막 실행 {seenDate(s.lastRunAt)}</span>}
      </p>
      {s.lastStatus === "error" && s.lastError && <p className="break-words text-red-800">{s.lastError}</p>}
      {note}
    </div>
  );
}

function SourceRow({ source }: { source: WatchSource }) {
  const save = useFetcher<ActionResult>();
  const del = useFetcher<ActionResult>();
  const busy = save.state !== "idle" || del.state !== "idle";
  return (
    <Card className={cn("flex flex-col gap-3 p-3", !source.enabled && "opacity-70")}>
      <RunState source={source} />
      <save.Form method="post" className="flex flex-col gap-3">
        <input type="hidden" name="intent" value="saveSource" />
        <SourceFields source={source} />
        <Button type="submit" className="h-11" disabled={busy}>
          {save.state !== "idle" ? "저장 중…" : "저장"}
        </Button>
      </save.Form>
      <del.Form
        method="post"
        onSubmit={(e) => {
          if (!confirm(`'${source.name}'을(를) 지울까요? 모아 둔 소식과 가격도 같이 지워져요.`)) e.preventDefault();
        }}
      >
        <input type="hidden" name="intent" value="deleteSource" />
        <input type="hidden" name="id" value={source.id} />
        <Button type="submit" variant="ghost" className="h-11 text-destructive" disabled={busy}>
          삭제
        </Button>
      </del.Form>
      <Message result={save.data} />
      {del.data?.error && <Message result={del.data} />}
    </Card>
  );
}

function AddSource() {
  const fetcher = useFetcher<ActionResult>();
  return (
    <Card className="flex flex-col gap-3 border-dashed p-3">
      <h2 className="text-sm font-medium">감시할 곳 추가</h2>
      <fetcher.Form method="post" className="flex flex-col gap-3">
        <input type="hidden" name="intent" value="saveSource" />
        <SourceFields />
        <Button type="submit" variant="outline" className="h-11" disabled={fetcher.state !== "idle"}>
          {fetcher.state !== "idle" ? "추가하는 중…" : "추가"}
        </Button>
      </fetcher.Form>
      {fetcher.data?.error && <Message result={fetcher.data} />}
    </Card>
  );
}
