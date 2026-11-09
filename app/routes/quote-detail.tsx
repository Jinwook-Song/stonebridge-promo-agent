import { env } from "cloudflare:workers";
import { CheckIcon, CircleAlertIcon, CopyIcon, DownloadIcon, LoaderCircleIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { data, Link, redirect, useFetcher } from "react-router";
import type { Route } from "./+types/quote-detail";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Field } from "../components/ui/label";
import { Switch } from "../components/ui/switch";
import { Textarea } from "../components/ui/textarea";
import { copyText } from "../promo/clipboard";
import { useStatusPolling } from "../promo/components/use-status-polling";
import { formatDay } from "../promo/format-date";
import { ownQuoteId } from "../quote/comparison-view";
import { ComparisonPanel } from "../quote/components/ComparisonPanel";
import { EventForm } from "../quote/components/EventForm";
import { LinesTable, type LinesHandle } from "../quote/components/LinesTable";
import { useJsonSaver, useReportSync, type QuoteActionResult, type SyncState } from "../quote/components/use-saver";
import { startQuoteGeneration } from "../quote/generate.server";
import { listPriceItems } from "../quote/price-sheet.server";
import {
  deleteQuote,
  existingQuoteIds,
  getQuote,
  isFreshClaim,
  requestRevision,
  saveEvent,
  saveLines,
  saveSender,
  setStatus,
  setVat,
} from "../quote/quotes.server";
import { QUOTE_STATUSES, QUOTE_STATUS_LABELS, type QuoteEvent, type QuoteStatus, type Sender } from "../quote/types";
import { getDb } from "../server/db";
import { DomainError } from "../server/errors";
import { cn } from "../lib/utils";

export const handle = { wide: true };

const WAITING = "견적을 만드는 중이에요. 몇 분 걸릴 수 있어요. 화면을 닫아도 계속 만들어요.";

export function meta({}: Route.MetaArgs) {
  return [{ title: "견적 · 스톤브릿지 홍보글" }];
}

function quoteIdOf(params: { id?: string }): number {
  const id = Number(params.id);
  if (!Number.isSafeInteger(id) || id <= 0) throw data("견적을 찾을 수 없어요.", { status: 404 });
  return id;
}

export async function loader({ params, request }: Route.LoaderArgs) {
  const db = getDb(env.DB);
  const id = quoteIdOf(params);
  const rawVersion = new URL(request.url).searchParams.get("v");
  const wanted = rawVersion === null ? undefined : Number(rawVersion);
  if (wanted !== undefined && (!Number.isSafeInteger(wanted) || wanted <= 0)) {
    throw data("그 버전을 찾을 수 없어요.", { status: 404 });
  }
  let view;
  try {
    view = await getQuote(db, id, wanted);
  } catch (e) {
    if (e instanceof DomainError && e.code === "NOT_FOUND") throw data(e.message, { status: 404 });
    throw e;
  }
  const ownIds = (view.version.comparison?.rows ?? []).map(ownQuoteId).filter((n) => n !== null);
  const [sheet, liveQuoteIds] = await Promise.all([
    listPriceItems(db, { enabledOnly: true }),
    existingQuoteIds(db, ownIds),
  ]);

  const latest = view.versions.at(-1)!;
  const isLatest = view.version.version === latest.version;
  const generating = isLatest && view.version.status === "generating";
  // Still "generating" but no run can finish it any more: offer 다시 시도 instead of waiting.
  const stale = generating && !isFreshClaim(view.version, new Date());
  return {
    ...view,
    sheet: sheet.map((s) => ({
      id: s.id,
      kind: s.kind,
      name: s.name,
      content: s.content,
      unit: s.unit,
      unitPrice: s.unitPrice,
      minimumQty: s.minimumQty,
      menu: s.menu,
      note: s.note,
    })),
    liveQuoteIds,
    latestVersion: latest.version,
    latestStatus: latest.status,
    isLatest,
    polling: generating && !stale,
    retryable: isLatest && (view.version.status === "failed" || stale),
  };
}

function jsonField(form: FormData, key: string): unknown {
  try {
    return JSON.parse(String(form.get(key) ?? ""));
  } catch {
    throw new DomainError("INVALID_INPUT", "저장할 내용이 올바르지 않아요.");
  }
}

export async function action({ request, params }: Route.ActionArgs) {
  const db = getDb(env.DB);
  const id = quoteIdOf(params);
  const form = await request.formData();
  const str = (key: string) => String(form.get(key) ?? "");
  const intent = str("intent");
  const now = new Date();
  const versionOf = () => {
    const version = Number(str("version"));
    if (!Number.isSafeInteger(version) || version <= 0) throw new DomainError("INVALID_INPUT", "잘못된 요청이에요.");
    return version;
  };

  try {
    switch (intent) {
      case "saveLines":
        await saveLines(db, id, versionOf(), jsonField(form, "lines") as never, now);
        break;
      case "saveEvent":
        await saveEvent(db, id, versionOf(), jsonField(form, "event") as QuoteEvent, now);
        break;
      case "saveSender":
        await saveSender(db, id, jsonField(form, "sender") as Sender, now);
        break;
      case "setVat":
        await setVat(db, id, str("vat") === "1", now);
        break;
      case "setStatus":
        await setStatus(db, id, str("status") as QuoteStatus, now);
        break;
      case "requestRevision": {
        const { version } = await requestRevision(db, id, str("text"), now);
        // The new version exists now: go to it whatever happens to the start (a failed start is
        // recorded on the version, which then offers 다시 시도).
        try {
          await startQuoteGeneration(env, db, id, version, now);
        } catch (e) {
          console.error("startQuoteGeneration failed after requestRevision", { quoteId: id, version, error: e });
        }
        return redirect(`/quotes/${id}?v=${version}`);
      }
      case "retry": {
        // The latest version, from the server: the page might be showing an older one.
        const { version } = await getQuote(db, id);
        if (isFreshClaim(version, now)) throw new DomainError("BUSY", "이미 만드는 중이에요.");
        await startQuoteGeneration(env, db, id, version.version, now);
        break;
      }
      case "deleteQuote":
        await deleteQuote(db, id);
        return redirect("/quotes");
      default:
        return data<QuoteActionResult>({ error: "잘못된 요청이에요.", intent }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof DomainError) {
      const result: QuoteActionResult = { error: e.message, intent };
      return e.code === "INVALID_INPUT" ? data(result, { status: 400 }) : result;
    }
    throw e;
  }
  return { ok: true, intent } satisfies QuoteActionResult;
}

// ---- Screen --------------------------------------------------------------------

type Loaded = Route.ComponentProps["loaderData"];

export default function QuoteDetail({ loaderData }: Route.ComponentProps) {
  const { quote, version, versions, isLatest, latestVersion, latestStatus, polling, retryable } = loaderData;
  useStatusPolling(quote.id, polling, { url: `/api/quotes/${quote.id}/status`, everyMs: 3000 });

  const ready = version.status === "ready" && version.lines !== null && version.event !== null;
  const title = [version.event?.customerName, version.event?.eventType].filter(Boolean).join(" · ");

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Link to="/quotes" className="flex min-h-11 items-center underline underline-offset-2">
            견적 목록
          </Link>
          <span aria-hidden="true">·</span>
          <span>{formatDay(quote.createdAt)}</span>
        </div>
        <h1 className="text-lg font-semibold break-words">{title || "견적"}</h1>
        <StatusPicker quoteId={quote.id} status={quote.status} />
        {versions.length > 1 && <VersionChips quoteId={quote.id} versions={versions} current={version.version} latest={latestVersion} />}
      </div>

      {quote.source === "imported" && (
        <p className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2.5 text-sm text-sky-900">
          가져온 견적이에요. 내용을 확인하고 상태(보냄/성사/무산)를 골라 주세요.
        </p>
      )}

      {!isLatest && (
        <p className="flex flex-wrap items-center gap-x-3 rounded-lg border bg-muted/60 px-3 py-2.5 text-sm">
          <span>지난 버전이라 행사 정보와 견적 표는 고칠 수 없어요. 상태, 발신 정보, VAT는 견적 전체에 적용돼서 여기서 바꿔도 모든 버전에 반영돼요.</span>
          <Link to={`/quotes/${quote.id}`} className="flex min-h-11 items-center font-medium text-primary underline underline-offset-2">
            최신 버전 보기 (v{latestVersion})
          </Link>
          {latestStatus === "generating" && <span className="text-muted-foreground">새 버전을 만드는 중이에요.</span>}
        </p>
      )}

      {version.status === "generating" ? (
        <Waiting retryable={retryable} previous={version.version > 1 ? version.version - 1 : null} quoteId={quote.id} />
      ) : version.status === "failed" ? (
        <Failed loaded={loaderData} />
      ) : !ready ? (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-800">
          이 버전의 내용을 읽지 못했어요.
        </p>
      ) : (
        <ReadyBody loaded={loaderData} lines={version.lines!} event={version.event!} />
      )}
    </div>
  );
}

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold">{title}</h2>
        {aside}
      </div>
      {children}
    </Card>
  );
}

function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-800">
      <CircleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

function StatusPicker({ quoteId, status }: { quoteId: number; status: QuoteStatus }) {
  const fetcher = useFetcher<QuoteActionResult>();
  // The chosen status shows at once; the reloaded page then agrees.
  const shown = (fetcher.formData?.get("status") as QuoteStatus | null) ?? status;
  return (
    <div className="flex flex-col gap-1">
      <div role="group" aria-label="견적 상태" className="flex gap-1">
        {QUOTE_STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={shown === s}
            onClick={() => {
              if (s !== shown) void fetcher.submit({ intent: "setStatus", status: s }, { method: "post", action: `/quotes/${quoteId}` });
            }}
            className={cn(
              "h-11 flex-1 rounded-md border text-sm font-medium sm:max-w-24",
              shown === s ? "border-primary bg-primary text-primary-foreground" : "bg-card text-muted-foreground active:bg-accent",
            )}
          >
            {QUOTE_STATUS_LABELS[s]}
          </button>
        ))}
      </div>
      {fetcher.state === "idle" && fetcher.data?.error && <ErrorLine>{fetcher.data.error}</ErrorLine>}
    </div>
  );
}

function VersionChips({
  quoteId,
  versions,
  current,
  latest,
}: {
  quoteId: number;
  versions: Loaded["versions"];
  current: number;
  latest: number;
}) {
  return (
    <nav aria-label="버전" className="flex flex-wrap gap-1">
      {versions.map((v) => (
        <Link
          key={v.version}
          to={v.version === latest ? `/quotes/${quoteId}` : `/quotes/${quoteId}?v=${v.version}`}
          aria-current={v.version === current ? "page" : undefined}
          className={cn(
            "flex h-11 min-w-11 items-center justify-center gap-1 rounded-md border px-3 text-sm font-medium",
            v.version === current ? "border-primary bg-primary/10 text-primary" : "bg-card text-muted-foreground active:bg-accent",
          )}
        >
          v{v.version}
          {v.status === "generating" && <LoaderCircleIcon className="size-3.5 animate-spin" aria-label="만드는 중" />}
          {v.status === "failed" && <span className="sr-only">실패</span>}
        </Link>
      ))}
    </nav>
  );
}

function RetryButton({ quoteId }: { quoteId: number }) {
  const fetcher = useFetcher<QuoteActionResult>();
  const busy = fetcher.state !== "idle";
  return (
    <div className="flex flex-col gap-2">
      {fetcher.state === "idle" && fetcher.data?.error && <ErrorLine>{fetcher.data.error}</ErrorLine>}
      <fetcher.Form method="post" action={`/quotes/${quoteId}`}>
        <input type="hidden" name="intent" value="retry" />
        <Button type="submit" size="lg" variant="outline" className="h-12 w-full" disabled={busy}>
          <RefreshCwIcon aria-hidden="true" />
          {busy ? "시작하는 중…" : "다시 시도"}
        </Button>
      </fetcher.Form>
    </div>
  );
}

function Waiting({ retryable, previous, quoteId }: { retryable: boolean; previous: number | null; quoteId: number }) {
  return (
    <div className="flex flex-col gap-4">
      <div role="status" className="flex flex-col items-center gap-4 px-2 py-12 text-center">
        <LoaderCircleIcon className="size-10 animate-spin text-primary" aria-hidden="true" />
        <p className="text-base leading-relaxed break-keep">{WAITING}</p>
      </div>
      {retryable && (
        <div className="flex flex-col gap-2">
          <p className="text-center text-sm text-muted-foreground">너무 오래 걸리면 다시 시도해 주세요.</p>
          <RetryButton quoteId={quoteId} />
        </div>
      )}
      {previous !== null && (
        <Link to={`/quotes/${quoteId}?v=${previous}`} className="flex min-h-11 items-center justify-center text-sm text-primary underline underline-offset-2">
          지난 버전 (v{previous}) 보기
        </Link>
      )}
    </div>
  );
}

function Failed({ loaded }: { loaded: Loaded }) {
  const { quote, version, isLatest } = loaded;
  const previous = version.version > 1 ? version.version - 1 : null;
  return (
    <div className="flex flex-col gap-4">
      <ErrorLine>{version.error ?? "견적을 만들지 못했어요."}</ErrorLine>
      {isLatest && <RetryButton quoteId={quote.id} />}
      {isLatest && previous !== null && (
        <>
          <Section title="수정 요청 다시 쓰기">
            <RevisionForm quoteId={quote.id} initial={version.changeRequest ?? ""} label="다시 요청하기" />
          </Section>
          <Link to={`/quotes/${quote.id}?v=${previous}`} className="flex min-h-11 items-center justify-center text-sm text-primary underline underline-offset-2">
            지난 버전 (v{previous}) 보기
          </Link>
        </>
      )}
    </div>
  );
}

function RevisionForm({ quoteId, initial = "", label = "수정 요청 보내기" }: { quoteId: number; initial?: string; label?: string }) {
  const fetcher = useFetcher<QuoteActionResult>();
  const busy = fetcher.state !== "idle";
  return (
    <fetcher.Form method="post" action={`/quotes/${quoteId}`} className="flex flex-col gap-3">
      <input type="hidden" name="intent" value="requestRevision" />
      <Field label="고칠 내용" htmlFor="revision-text" hint="예) 인원을 40명으로 줄이고 음료는 빼 주세요. 새 버전이 만들어지고, 직접 고친 단가와 SVC는 그대로 남아요.">
        <Textarea id="revision-text" name="text" rows={4} required defaultValue={initial} disabled={busy} />
      </Field>
      {fetcher.state === "idle" && fetcher.data?.error && <ErrorLine>{fetcher.data.error}</ErrorLine>}
      <Button type="submit" className="h-11" disabled={busy}>
        {busy ? "보내는 중…" : label}
      </Button>
    </fetcher.Form>
  );
}

function ReadyBody({ loaded, lines, event }: { loaded: Loaded; lines: NonNullable<Loaded["version"]["lines"]>; event: QuoteEvent }) {
  const { quote, version, sheet, isLatest } = loaded;
  const liveQuoteIds = useMemo(() => new Set(loaded.liveQuoteIds), [loaded.liveQuoteIds]);
  const readOnly = !isLatest;
  const vatFetcher = useFetcher<QuoteActionResult>();
  // The switch moves at once; the reloaded page then agrees.
  const vatForm = vatFetcher.formData?.get("vat");
  const vatIncluded = vatForm == null ? quote.vatIncluded : vatForm === "1";
  const scope = `${quote.id}-${version.version}`;
  // Lines, event or sender on screen the server does not hold yet: the download would still have
  // the old values.
  const [linesSync, setLinesSync] = useState<SyncState>("saved");
  const [eventSync, setEventSync] = useState<SyncState>("saved");
  const [senderSync, setSenderSync] = useState<SyncState>("saved");
  const syncs = [linesSync, eventSync, senderSync];
  const fileSync: SyncState = syncs.includes("saving") ? "saving" : syncs.includes("failed") ? "failed" : "saved";
  const unsaved = fileSync !== "saved";
  const linesRef = useRef<LinesHandle>(null);

  return (
    <>
      {version.changes && version.changes.length > 0 && (
        <Section title="바뀐 점">
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
            {version.changes.map((c, i) => (
              <li key={i} className={cn(i === 0 && "list-none -ml-5 font-medium")}>
                {c}
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="행사 정보">
        <EventForm
          key={scope}
          quoteId={quote.id}
          version={version.version}
          initialEvent={event}
          readOnly={readOnly}
          onUnsavedChange={setEventSync}
          onHeadcountChange={(from, to) => linesRef.current?.followHeadcount(from, to)}
        />
      </Section>

      <Section title="견적 표">
        <LinesTable
          key={scope}
          ref={linesRef}
          quoteId={quote.id}
          version={version.version}
          initialLines={lines}
          vatIncluded={vatIncluded}
          sheet={sheet}
          readOnly={readOnly}
          onUnsavedChange={setLinesSync}
        />
        {vatFetcher.state === "idle" && vatFetcher.data?.error && <ErrorLine>{vatFetcher.data.error}</ErrorLine>}
      </Section>

      <Section title="비교">
        <ComparisonPanel comparison={version.comparison} liveQuoteIds={liveQuoteIds} />
      </Section>

      <Section title="회신 메일">
        <EmailBlock subject={version.emailSubject ?? ""} body={version.emailBody ?? ""} />
      </Section>

      <Section title="발신 정보와 VAT">
        <SenderPanel
          quoteId={quote.id}
          initialSender={quote.sender}
          vatIncluded={vatIncluded}
          onUnsavedChange={setSenderSync}
          onVat={(on) =>
            void vatFetcher.submit({ intent: "setVat", vat: on ? "1" : "0" }, { method: "post", action: `/quotes/${quote.id}` })
          }
        />
      </Section>

      <div className="flex flex-col gap-3">
        <Button asChild variant="outline" size="lg" className="h-12">
          <a
            href={`/quotes/${quote.id}/v/${version.version}/xlsx`}
            aria-disabled={unsaved || undefined}
            onClick={(e) => {
              if (unsaved) e.preventDefault();
            }}
            className={cn(unsaved && "pointer-events-none opacity-60")}
          >
            {fileSync === "saving" ? <LoaderCircleIcon className="animate-spin" aria-hidden="true" /> : <DownloadIcon aria-hidden="true" />}
            {fileSync === "saving" ? "저장 중…" : fileSync === "failed" ? "저장 못 한 내용이 있어요" : "엑셀 받기"}
          </a>
        </Button>
      </div>

      {isLatest && (
        <Section title="수정 요청">
          <RevisionForm quoteId={quote.id} />
        </Section>
      )}

      <DeleteQuote quoteId={quote.id} />
    </>
  );
}

function EmailBlock({ subject, body }: { subject: string; body: string }) {
  const [note, setNote] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  function copy(text: string, what: string) {
    // Copy first, synchronously inside the tap.
    void copyText(text).then((ok) => {
      setNote(ok ? `${what}을 복사했어요` : "복사하지 못했어요. 글자를 길게 눌러 복사해 주세요.");
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setNote(null), 2500);
    });
  }

  if (subject === "" && body === "") return <p className="text-sm text-muted-foreground">회신 메일이 없어요.</p>;
  return (
    <div className="flex flex-col gap-3">
      <Field label="제목">
        <div className="flex gap-2">
          <Input readOnly value={subject} aria-label="메일 제목" className="h-11 flex-1" />
          <Button type="button" variant="outline" className="h-11" onClick={() => copy(subject, "제목")}>
            <CopyIcon aria-hidden="true" />
            제목 복사
          </Button>
        </div>
      </Field>
      <Field label="본문">
        <Textarea readOnly value={body} aria-label="메일 본문" rows={10} />
      </Field>
      <div className="flex items-center gap-3">
        <Button type="button" className="h-11" onClick={() => copy(body, "본문")}>
          <CopyIcon aria-hidden="true" />
          본문 복사
        </Button>
        <p role="status" aria-live="polite" className="flex items-center gap-1 text-sm text-emerald-700">
          {note && <CheckIcon className="size-4" aria-hidden="true" />}
          {note}
        </p>
      </div>
    </div>
  );
}

const SENDER_FIELDS: { key: keyof Sender; label: string; long?: boolean }[] = [
  { key: "company", label: "업체 이름" },
  { key: "person", label: "담당자" },
  { key: "phone", label: "전화" },
  { key: "email", label: "메일" },
  { key: "bizNo", label: "사업자번호" },
  { key: "payment", label: "입금 계좌", long: true },
  { key: "onsite", label: "현장 안내", long: true },
];

function SenderPanel({
  quoteId,
  initialSender,
  vatIncluded,
  onVat,
  onUnsavedChange,
}: {
  quoteId: number;
  initialSender: Sender;
  vatIncluded: boolean;
  onVat: (on: boolean) => void;
  onUnsavedChange: (state: SyncState) => void;
}) {
  const [sender, setSender] = useState(initialSender);
  const saver = useJsonSaver({ quoteId, intent: "saveSender", field: "sender", initial: initialSender });
  useReportSync(saver, onUnsavedChange);
  return (
    <div className="flex flex-col gap-4">
      <label className="flex min-h-11 items-center justify-between gap-3">
        <span className="text-base">
          VAT 10% 별도
          <span className="block text-xs text-muted-foreground">끄면 합계 줄 없이 공급금액만 나와요.</span>
        </span>
        <Switch checked={vatIncluded} onCheckedChange={onVat} aria-label="VAT 10% 별도" />
      </label>
      <p className="text-xs text-muted-foreground">이 견적서에만 쓰는 값이에요. 설정의 기본값은 바뀌지 않아요.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {SENDER_FIELDS.map(({ key, label, long }) => (
          <Field key={key} label={label} htmlFor={`sender-${key}`} className={long ? "sm:col-span-2" : undefined}>
            {long ? (
              <Textarea
                id={`sender-${key}`}
                rows={2}
                value={sender[key]}
                onChange={(e) => setSender({ ...sender, [key]: e.currentTarget.value })}
                onBlur={() => saver.save(sender)}
              />
            ) : (
              <Input
                id={`sender-${key}`}
                value={sender[key]}
                onChange={(e) => setSender({ ...sender, [key]: e.currentTarget.value })}
                onBlur={() => saver.save(sender)}
                className="h-11"
              />
            )}
          </Field>
        ))}
      </div>
      {saver.error && <ErrorLine>{saver.error}</ErrorLine>}
    </div>
  );
}

function DeleteQuote({ quoteId }: { quoteId: number }) {
  const [confirming, setConfirming] = useState(false);
  const fetcher = useFetcher<QuoteActionResult>();
  const busy = fetcher.state !== "idle";
  return (
    <div className="flex flex-col gap-2 border-t pt-4">
      {fetcher.state === "idle" && fetcher.data?.error && <ErrorLine>{fetcher.data.error}</ErrorLine>}
      {!confirming ? (
        <Button type="button" variant="ghost" className="h-11 self-start text-muted-foreground" onClick={() => setConfirming(true)}>
          견적 지우기
        </Button>
      ) : (
        <div className="flex flex-col gap-2 rounded-lg border border-red-200 bg-red-50 p-3">
          <p className="text-sm text-red-800">이 견적을 모든 버전과 함께 지울까요? 되돌릴 수 없어요.</p>
          <fetcher.Form method="post" action={`/quotes/${quoteId}`} className="flex gap-2">
            <input type="hidden" name="intent" value="deleteQuote" />
            <Button type="submit" variant="destructive" className="h-11 flex-1" disabled={busy}>
              {busy ? "지우는 중…" : "지우기"}
            </Button>
            <Button type="button" variant="outline" className="h-11 flex-1" onClick={() => setConfirming(false)} disabled={busy}>
              취소
            </Button>
          </fetcher.Form>
        </div>
      )}
    </div>
  );
}
