import { env } from "cloudflare:workers";
import { CircleAlertIcon, CircleCheckIcon } from "lucide-react";
import { Form, useFetcher, useNavigation } from "react-router";
import type { Route } from "./+types/settings";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Field } from "../components/ui/label";
import { Textarea } from "../components/ui/textarea";
import {
  listExamples,
  setExampleEnabled,
  setExampleKind,
  type ExampleRow,
} from "../promo/examples.server";
import { getSettings, saveSettings } from "../promo/settings.server";
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
  const [settings, examples] = await Promise.all([getSettings(db), listExamples(db)]);
  return { settings, examples };
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
