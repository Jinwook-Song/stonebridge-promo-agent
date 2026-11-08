import { useEffect, useState, type ReactNode } from "react";
import { env } from "cloudflare:workers";
import { CircleAlertIcon, CircleCheckIcon } from "lucide-react";
import { Form, useFetcher, useNavigation, useSearchParams } from "react-router";
import type { Route } from "./+types/settings";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Field } from "../components/ui/label";
import { Textarea } from "../components/ui/textarea";
import {
  listExamples,
  setExampleEnabled,
  setExampleKind,
  type ExampleRow,
} from "../promo/examples.server";
import { getSettings, saveSettings } from "../promo/settings.server";
import {
  alertMessage,
  getAlertSettings,
  parseMonthlyDay,
  recentAlerts,
  saveAlertSettings,
  type AlertSettings,
} from "../kakao/alerts.server";
import { describeKakaoError, disconnect, getLink, kakaoConfig, linkExpired, sendToMe } from "../kakao/link.server";
import { ALERT_LABELS, type AlertKind, type AlertStatus } from "../kakao/types";
import type { KakaoResult } from "./kakao.callback";
import { formatDay } from "../promo/format-date";
import { CHANNEL_LABELS, KIND_LABELS, POST_KINDS, type Channel, type PostKind } from "../promo/types";
import { getDb } from "../server/db";
import { DomainError } from "../server/errors";

/** `savedAt` (saveSettings only) remounts the form so every box shows what is now in effect. */
type ActionResult = { ok?: boolean; error?: string; savedAt?: number } | undefined;

export function meta({}: Route.MetaArgs) {
  return [{ title: "설정 · 스톤브릿지 홍보글" }];
}

export async function loader({}: Route.LoaderArgs) {
  const db = getDb(env.DB);
  const [settings, examples, link, alerts, recent] = await Promise.all([
    getSettings(db),
    listExamples(db),
    getLink(db),
    getAlertSettings(db),
    recentAlerts(db),
  ]);
  const kakao: KakaoView = {
    configured: kakaoConfig(env) !== null,
    // Never send tokens to the browser.
    link: link && {
      idTail: link.kakaoUserId.slice(-4),
      linkedAt: link.linkedAt,
      needsRelogin: linkExpired(link, new Date()),
    },
    alerts,
    recent: recent.map(({ id, kind, periodKey, status, error, createdAt }) => ({
      id,
      kind,
      periodKey,
      // A row left at `sending` for long means the worker died mid-send; we can't tell if it went.
      status: status === "sending" && Date.now() - new Date(createdAt).getTime() > STUCK_MS ? "unknown" : status,
      error,
    })),
  };
  return { settings, examples, kakao };
}

function oneOf<T extends string>(values: readonly T[], raw: FormDataEntryValue | null): T {
  if (typeof raw === "string" && (values as readonly string[]).includes(raw)) return raw as T;
  throw new DomainError("INVALID_STATE", "잘못된 요청입니다.");
}

export async function action({ request }: Route.ActionArgs): Promise<NonNullable<ActionResult>> {
  const form = await request.formData();
  const str = (key: string) => String(form.get(key) ?? "");
  const db = getDb(env.DB);

  try {
    switch (str("intent")) {
      case "saveSettings":
        // saveSettings trims, and drops a box left blank or equal to its default (so a blank
        // rules box means "use the default", never "no rules").
        await saveSettings(db, {
          footerBlog: str("footerBlog"),
          footerShort: str("footerShort"),
          priceTable: str("priceTable"),
          voiceRules: str("voiceRules"),
          channelRules: str("channelRules"),
        });
        return { ok: true, savedAt: Date.now() };
      case "kakaoTest": {
        const cfg = kakaoConfig(env);
        if (!cfg) return { error: "카카오 키가 설정되지 않았어요." };
        try {
          await sendToMe(db, cfg, alertMessage("test", env.PUBLIC_ORIGIN), new Date(), (u, init) => fetch(u, init));
        } catch (e) {
          return { error: describeKakaoError(e) };
        }
        return { ok: true };
      }
      case "kakaoDisconnect":
        await disconnect(db);
        break;
      case "setAlert": {
        const enabled = str("enabled") === "1";
        const kind = oneOf(["order", "monthly"] as const, form.get("kind"));
        await saveAlertSettings(db, kind === "order" ? { orderEnabled: enabled } : { monthlyEnabled: enabled });
        break;
      }
      case "setMonthlyDay": {
        const day = parseMonthlyDay(str("day"));
        if (day === null) return { error: "1부터 31 사이 날짜를 적어 주세요." };
        await saveAlertSettings(db, { monthlyDay: day });
        break;
      }
      case "setExampleEnabled":
        await setExampleEnabled(db, Number(str("id")), str("enabled") === "1");
        break;
      case "setExampleKind":
        await setExampleKind(db, Number(str("id")), oneOf(POST_KINDS, form.get("kind")));
        break;
      default:
        return { error: "잘못된 요청입니다." };
    }
  } catch (e) {
    if (e instanceof DomainError) return { error: e.message };
    throw e;
  }
  return { ok: true };
}

function Message({ result, success }: { result: ActionResult; success: string }) {
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
        <span>{success}</span>
      </p>
    );
  }
  return null;
}

const EMPTY_NOTE = (
  <Badge variant="warning" className="ml-auto">
    아직 비어 있음
  </Badge>
);

export default function Settings({ loaderData, actionData }: Route.ComponentProps) {
  const { settings, examples } = loaderData;
  const saving = useNavigation().formData?.get("intent") === "saveSettings";

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-lg font-semibold">설정</h1>

      <KakaoSection kakao={loaderData.kakao} />

      {/* The boxes are uncontrolled; after a save, remount them on the reloaded settings (a blanked
          rules box comes back showing the default it now uses). Example toggles use fetchers,
          so they never reset what she is typing here. */}
      <Form key={actionData?.savedAt ?? 0} method="post" className="flex flex-col gap-4">
        <input type="hidden" name="intent" value="saveSettings" />
        <SettingField name="footerBlog" label="꼬리말 (블로그)" value={settings.footerBlog} rows={4} warnEmpty />
        <SettingField name="footerShort" label="꼬리말 (짧은 판)" value={settings.footerShort} rows={3} warnEmpty />
        <SettingField name="priceTable" label="가격표" value={settings.priceTable} rows={6} warnEmpty />
        <SettingField name="voiceRules" label="말투 규칙" value={settings.voiceRules} rows={8} />
        <SettingField name="channelRules" label="채널 규칙" value={settings.channelRules} rows={10} />
        <Message result={actionData} success="저장했습니다." />
        <Button type="submit" size="lg" className="h-12" disabled={saving}>
          {saving ? "저장 중…" : "저장"}
        </Button>
      </Form>

      <section aria-labelledby="examples-title" className="flex flex-col gap-3">
        <div>
          <h2 id="examples-title" className="font-semibold">
            예시 글
          </h2>
          <p className="text-sm text-muted-foreground">
            켜 둔 글만 새 글을 쓸 때 참고합니다. 종류를 맞춰 두면 비슷한 글이 먼저 쓰입니다.
          </p>
        </div>
        {examples.length === 0 ? (
          <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
            아직 예시가 없습니다.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {examples.map((ex) => (
              <ExampleItem key={ex.id} example={ex} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function SettingField({
  name,
  label,
  value,
  rows,
  warnEmpty,
}: {
  name: string;
  label: string;
  value: string;
  rows: number;
  warnEmpty?: boolean;
}) {
  return (
    <Field
      label={
        <>
          {label}
          {warnEmpty && value.trim() === "" && EMPTY_NOTE}
        </>
      }
      htmlFor={name}
    >
      <Textarea id={name} name={name} defaultValue={value} rows={rows} className="min-h-24" />
    </Field>
  );
}

function ExampleItem({ example: ex }: { example: ExampleRow }) {
  const fetcher = useFetcher<ActionResult>();
  // Show what is being saved right away; the loader data catches up after revalidation.
  const pending = fetcher.formData;
  const enabled = pending?.get("intent") === "setExampleEnabled" ? pending.get("enabled") === "1" : ex.enabled;
  const kind = pending?.get("intent") === "setExampleKind" ? (pending.get("kind") as PostKind) : ex.kind;
  const title = ex.title?.trim() || `${ex.body.trim().slice(0, 30)}…`;

  return (
    <Card className={enabled ? "p-3" : "bg-muted/40 p-3"}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="mb-1 flex flex-wrap items-center gap-1.5">
            <Badge variant="secondary">{CHANNEL_LABELS[ex.channel]}</Badge>
            {ex.source === "owner_final" && <Badge variant="info">사장님 확정본</Badge>}
          </div>
          <p className={enabled ? "text-sm font-medium break-words" : "text-sm break-words text-muted-foreground"}>
            {title}
          </p>
        </div>
        <fetcher.Form method="post" className="shrink-0">
          <input type="hidden" name="intent" value="setExampleEnabled" />
          <input type="hidden" name="id" value={ex.id} />
          <input type="hidden" name="enabled" value={enabled ? "0" : "1"} />
          <Button
            type="submit"
            variant={enabled ? "outline" : "default"}
            className="h-11 min-w-16"
            aria-pressed={enabled}
            aria-label={`${title} ${enabled ? "끄기" : "켜기"}`}
          >
            {enabled ? "끄기" : "켜기"}
          </Button>
        </fetcher.Form>
      </div>
      <fetcher.Form method="post" className="mt-2">
        <input type="hidden" name="intent" value="setExampleKind" />
        <input type="hidden" name="id" value={ex.id} />
        <select
          name="kind"
          aria-label={`${title} 종류`}
          value={kind}
          onChange={(e) => fetcher.submit(e.currentTarget.form)}
          className="h-11 w-full rounded-md border border-input bg-card px-3 text-base outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/25"
        >
          {POST_KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABELS[k]}
            </option>
          ))}
        </select>
      </fetcher.Form>
      {fetcher.data?.error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {fetcher.data.error}
        </p>
      )}
    </Card>
  );
}

type KakaoView = {
  configured: boolean;
  link: { idTail: string; linkedAt: string; needsRelogin: boolean } | null | undefined;
  alerts: AlertSettings;
  recent: { id: number; kind: AlertKind; periodKey: string; status: AlertStatus | "unknown"; error: string | null }[];
};

const STUCK_MS = 10 * 60_000;

const KAKAO_RESULT: Record<KakaoResult, { ok: boolean; text: string }> = {
  connected: { ok: true, text: "카카오 계정을 연결했어요. '시험 보내기'로 카톡이 오는지 확인해 주세요." },
  denied: { ok: false, text: "카카오 로그인을 취소했어요." },
  bad_state: { ok: false, text: "연결 시간이 지났거나 다른 창에서 시작했어요. 다시 눌러 주세요." },
  no_consent: {
    ok: false,
    text: "'카카오톡 메시지 전송'에 동의해야 알림을 받을 수 있어요. 다시 연결하고 동의해 주세요.",
  },
  not_configured: { ok: false, text: "카카오 키가 설정되지 않았어요. 관리자에게 알려 주세요." },
  error: { ok: false, text: "카카오 연결에 실패했어요." },
};

const STATUS_TEXT: Record<AlertStatus | "unknown", string> = {
  sending: "보내는 중",
  sent: "보냄",
  failed: "실패",
  unknown: "확인 안 됨",
};

function KakaoSection({ kakao }: { kakao: KakaoView }) {
  const [params, setParams] = useSearchParams();
  // One-shot: keep the login result in state and drop it from the URL, so a reload, a later
  // settings save or 연결 끊기 never shows a stale "연결했어요".
  const [{ result, code }] = useState(() => ({
    result: params.get("kakao") as KakaoResult | null,
    code: params.get("code"),
  }));
  useEffect(() => {
    if (!params.has("kakao") && !params.has("code")) return;
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("kakao");
        next.delete("code");
        return next;
      },
      { replace: true, preventScrollReset: true },
    );
  }, [params, setParams]);
  const test = useFetcher<ActionResult>();
  const disconnectFetcher = useFetcher<ActionResult>();
  const { link } = kakao;
  const banner = result && KAKAO_RESULT[result] && !(result === "connected" && !link) ? KAKAO_RESULT[result] : null;
  const ready = kakao.configured && !!link && !link.needsRelogin;

  return (
    <section id="kakao" aria-labelledby="kakao-title" className="flex scroll-mt-28 flex-col gap-3">
      <div>
        <h2 id="kakao-title" className="font-semibold">
          카톡 알림
        </h2>
        <p className="text-sm text-muted-foreground">
          연결한 카카오 계정의 &lsquo;나와의 채팅&rsquo;으로 알림이 와요. 마지막에 연결한 계정 하나만 받아요.
        </p>
      </div>

      {banner && (
        <Message
          result={banner.ok ? { ok: true } : { error: code && !banner.ok ? `${banner.text} (${code})` : banner.text }}
          success={banner.text}
        />
      )}

      <Card className="flex flex-col gap-3 p-3">
        {!kakao.configured ? (
          <p className="text-sm text-muted-foreground">
            <Badge variant="warning" className="mr-1.5">
              키 미설정
            </Badge>
            관리자가 카카오 앱 키를 넣어야 쓸 수 있어요.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-1.5 text-sm">
              {!link ? (
                <Badge variant="muted">연결 안 됨</Badge>
              ) : link.needsRelogin ? (
                <Badge variant="destructive">다시 연결 필요</Badge>
              ) : (
                <Badge variant="success">연결됨</Badge>
              )}
              {link && (
                <span className="text-muted-foreground">
                  {formatDay(link.linkedAt)} 연결 · 회원번호 끝자리 {link.idTail}
                </span>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button asChild variant={ready ? "outline" : "default"} className="h-11">
                {/* A plain document request: the loader redirects off-site to Kakao. */}
                <a href="/kakao/connect">{link ? "다른 계정으로 다시 연결" : "카카오 계정 연결"}</a>
              </Button>
              {ready && (
                <test.Form method="post">
                  <input type="hidden" name="intent" value="kakaoTest" />
                  <Button type="submit" variant="outline" className="h-11" disabled={test.state !== "idle"}>
                    {test.state !== "idle" ? "보내는 중…" : "시험 보내기"}
                  </Button>
                </test.Form>
              )}
              {link && (
                <disconnectFetcher.Form method="post">
                  <input type="hidden" name="intent" value="kakaoDisconnect" />
                  <Button type="submit" variant="ghost" className="h-11 text-muted-foreground">
                    연결 끊기
                  </Button>
                </disconnectFetcher.Form>
              )}
            </div>
            <Message result={test.data} success="보냈어요. 카톡 '나와의 채팅'을 확인해 주세요." />
          </>
        )}
      </Card>

      <AlertToggle
        kind="order"
        enabled={kakao.alerts.orderEnabled}
        description="매일 밤 11시 20분, 쿠팡 발주 알림"
        canSend={ready}
      />
      <AlertToggle
        kind="monthly"
        enabled={kakao.alerts.monthlyEnabled}
        description={`매달 ${kakao.alerts.monthlyDay}일 오전 10시, 홍보글 올릴 때 알림`}
        canSend={ready}
      >
        <MonthlyDay day={kakao.alerts.monthlyDay} />
      </AlertToggle>

      {kakao.recent.length > 0 && (
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-medium">최근 알림</h3>
          <ul className="flex flex-col gap-1 text-sm">
            {kakao.recent.map((a) => (
              <li key={a.id} className="break-words text-muted-foreground">
                {a.periodKey} {ALERT_LABELS[a.kind]} ·{" "}
                <span className={a.status === "failed" ? "text-destructive" : undefined}>{STATUS_TEXT[a.status]}</span>
                {a.error && <span className="block text-xs">{a.error}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function AlertToggle({
  kind,
  enabled: saved,
  description,
  canSend,
  children,
}: {
  kind: AlertKind;
  enabled: boolean;
  description: string;
  canSend: boolean;
  children?: ReactNode;
}) {
  const fetcher = useFetcher<ActionResult>();
  const pending = fetcher.formData;
  const enabled = pending ? pending.get("enabled") === "1" : saved;
  return (
    <Card className="flex flex-col gap-2 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">{ALERT_LABELS[kind]}</p>
          <p className="text-sm text-muted-foreground">{description}</p>
          {enabled && !canSend && <p className="mt-1 text-xs text-amber-700">카카오 연결이 안 돼 있어서 아직 안 가요.</p>}
        </div>
        <fetcher.Form method="post" className="shrink-0">
          <input type="hidden" name="intent" value="setAlert" />
          <input type="hidden" name="kind" value={kind} />
          <input type="hidden" name="enabled" value={enabled ? "0" : "1"} />
          <Button
            type="submit"
            variant={enabled ? "default" : "outline"}
            className="h-11 min-w-16"
            aria-pressed={enabled}
            aria-label={`${ALERT_LABELS[kind]} ${enabled ? "끄기" : "켜기"}`}
          >
            {enabled ? "켜짐" : "꺼짐"}
          </Button>
        </fetcher.Form>
      </div>
      {children}
      {fetcher.data?.error && (
        <p role="alert" className="text-sm text-destructive">
          {fetcher.data.error}
        </p>
      )}
    </Card>
  );
}

function MonthlyDay({ day }: { day: number }) {
  const fetcher = useFetcher<ActionResult>();
  return (
    <fetcher.Form method="post" className="flex items-center gap-2" key={day}>
      <input type="hidden" name="intent" value="setMonthlyDay" />
      <label htmlFor="monthly-day" className="text-sm text-muted-foreground">
        매달
      </label>
      <Input
        id="monthly-day"
        name="day"
        type="number"
        inputMode="numeric"
        min={1}
        max={31}
        defaultValue={day}
        className="h-11 w-20"
      />
      <span className="text-sm text-muted-foreground">일</span>
      <Button type="submit" variant="outline" className="h-11" disabled={fetcher.state !== "idle"}>
        날짜 저장
      </Button>
      {fetcher.data?.error && (
        <p role="alert" className="text-sm text-destructive">
          {fetcher.data.error}
        </p>
      )}
    </fetcher.Form>
  );
}
