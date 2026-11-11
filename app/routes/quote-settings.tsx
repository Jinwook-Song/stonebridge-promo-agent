import { env } from "cloudflare:workers";
import { CircleAlertIcon, CircleCheckIcon } from "lucide-react";
import { Form, Link, useFetcher, useNavigation } from "react-router";
import type { Route } from "./+types/quote-settings";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Input, inputClass } from "../components/ui/input";
import { Field } from "../components/ui/label";
import { Textarea } from "../components/ui/textarea";
import type { PriceItem } from "../quote/lines";
import {
  deletePriceItem,
  listPriceItems,
  nextPriceSort,
  parseWon,
  savePriceItem,
} from "../quote/price-sheet.server";
import { getQuoteSettings, saveQuoteSettings } from "../quote/quote-settings.server";
import { PRICE_KINDS, type PriceKind } from "../quote/types";
import { getDb } from "../server/db";
import { DomainError } from "../server/errors";
import { cn } from "../lib/utils";

/** `savedAt` (saveQuoteSettings only) remounts the form so every box shows what is stored. */
type ActionResult = { ok?: boolean; error?: string; savedAt?: number } | undefined;

const KIND_LABELS: Record<PriceKind, string> = { per_person: "1인당", per_event: "1회" };

export function meta({}: Route.MetaArgs) {
  return [{ title: "견적 설정 · 스톤브릿지 홍보글" }];
}

export async function loader({}: Route.LoaderArgs) {
  const db = getDb(env.DB);
  const [items, quote] = await Promise.all([listPriceItems(db), getQuoteSettings(db)]);
  return { items, quote };
}

function oneOf<T extends string>(values: readonly T[], raw: string): T {
  if ((values as readonly string[]).includes(raw)) return raw as T;
  throw new DomainError("INVALID_INPUT", "잘못된 요청이에요.");
}

function wholeNumber(raw: string, message: string): number {
  if (!/^-?\d+$/.test(raw.trim())) throw new DomainError("INVALID_INPUT", message);
  return Number(raw.trim());
}

export async function action({ request }: Route.ActionArgs): Promise<NonNullable<ActionResult>> {
  const form = await request.formData();
  const str = (key: string) => String(form.get(key) ?? "");
  const db = getDb(env.DB);

  try {
    switch (str("intent")) {
      case "savePriceItem": {
        const idText = str("id").trim();
        const id = idText === "" ? undefined : wholeNumber(idText, "잘못된 요청이에요.");
        const minimumText = str("minimumQty").replace(/[,\s]/g, "");
        const sortText = str("sort").trim();
        await savePriceItem(
          db,
          {
            id,
            kind: oneOf(PRICE_KINDS, str("kind")),
            name: str("name"),
            content: str("content"),
            unit: str("unit"),
            unitPrice: parseWon(str("unitPrice")),
            minimumQty: minimumText === "" ? null : wholeNumber(minimumText, "최소 수량은 숫자로 적어 주세요."),
            menu: str("menu"),
            note: str("note"),
            // savePriceItem clears it: saving is the owner confirming the price.
            needsConfirm: false,
            enabled: str("enabled") === "1",
            // A new item goes to the end unless she typed an order.
            sort: sortText !== "" ? wholeNumber(sortText, "순서는 숫자로 적어 주세요.") : await nextPriceSort(db),
          },
          new Date(),
        );
        return { ok: true };
      }
      case "deletePriceItem":
        await deletePriceItem(db, wholeNumber(str("id"), "잘못된 요청이에요."));
        return { ok: true };
      case "saveQuoteSettings":
        await saveQuoteSettings(db, {
          sender: {
            company: str("company"),
            person: str("person"),
            phone: str("phone"),
            email: str("email"),
            payment: str("payment"),
            onsite: str("onsite"),
            bizNo: str("bizNo"),
          },
          intro: str("intro"),
          fixedLines: str("fixedLines"),
          mailExample: str("mailExample"),
        });
        return { ok: true, savedAt: Date.now() };
      default:
        return { error: "잘못된 요청이에요." };
    }
  } catch (e) {
    if (e instanceof DomainError) return { error: e.message };
    throw e;
  }
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

export default function QuoteSettings({ loaderData, actionData }: Route.ComponentProps) {
  const { items, quote } = loaderData;
  const saving = useNavigation().formData?.get("intent") === "saveQuoteSettings";
  const { sender } = quote;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">견적 설정</h1>
        <Link to="/settings" className="flex h-11 items-center text-sm text-muted-foreground underline">
          ← 설정
        </Link>
      </div>

      <section aria-labelledby="price-title" className="flex flex-col gap-3">
        <div>
          <h2 id="price-title" className="font-semibold">
            가격 기준표
          </h2>
          <p className="text-sm text-muted-foreground">
            단가는 부가세 빼고 적어요. 줄마다 저장 버튼을 눌러 주세요. 단가를 비워 두면 견적서에 '단가 없음'으로 나와요.
          </p>
        </div>
        <ul className="flex flex-col gap-3">
          {items.map((item) => (
            <li key={item.id}>
              <PriceRow item={item} />
            </li>
          ))}
        </ul>
        <AddRow key={items.length} />
      </section>

      <Form key={actionData?.savedAt ?? 0} method="post" className="flex flex-col gap-4">
        <input type="hidden" name="intent" value="saveQuoteSettings" />
        <h2 className="font-semibold">보내는 사람</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="업체 이름" htmlFor="company">
            <Input id="company" name="company" defaultValue={sender.company} className="h-11" />
          </Field>
          <Field label="담당자" htmlFor="person">
            <Input id="person" name="person" defaultValue={sender.person} className="h-11" />
          </Field>
          <Field label="전화" htmlFor="phone">
            <Input id="phone" name="phone" type="tel" defaultValue={sender.phone} className="h-11" />
          </Field>
          <Field label="이메일" htmlFor="email">
            <Input id="email" name="email" type="email" defaultValue={sender.email} className="h-11" />
          </Field>
          <Field label="사업자번호" htmlFor="bizNo">
            <Input id="bizNo" name="bizNo" defaultValue={sender.bizNo} className="h-11" />
          </Field>
        </div>
        <Field label="입금 계좌" htmlFor="payment">
          <Textarea id="payment" name="payment" defaultValue={sender.payment} rows={2} />
        </Field>
        <Field label="현장 안내" htmlFor="onsite" hint="견적서 위쪽 발신 정보 칸에 들어가요.">
          <Textarea id="onsite" name="onsite" defaultValue={sender.onsite} rows={3} />
        </Field>
        <Field label="소개 문구" htmlFor="intro" hint="견적서 맨 앞에 들어가는 인사말이에요.">
          <Textarea id="intro" name="intro" defaultValue={quote.intro} rows={4} />
        </Field>
        <Field label="기본 제공 사항" htmlFor="fixedLines" hint="모든 견적에 들어가요. 한 줄에 하나씩 적어 주세요.">
          <Textarea id="fixedLines" name="fixedLines" defaultValue={quote.fixedLines} rows={5} />
        </Field>
        <Field
          label="회신 메일 말투 예시"
          htmlFor="mailExample"
          hint="손님께 보냈던 메일 하나를 붙여 넣어 주세요. 회신 메일 초안이 이 말투(인사, 맺음말)를 따라요. 내용은 옮기지 않아요."
        >
          <Textarea id="mailExample" name="mailExample" defaultValue={quote.mailExample} rows={8} />
        </Field>
        <Message result={actionData} success="저장했어요." />
        <Button type="submit" size="lg" className="h-12" disabled={saving}>
          {saving ? "저장 중…" : "저장"}
        </Button>
      </Form>
    </div>
  );
}

function PriceFields({ item }: { item?: PriceItem }) {
  const id = item ? `item-${item.id}` : "item-new";
  return (
    <>
      {item && <input type="hidden" name="id" value={item.id} />}
      <div className="grid grid-cols-2 gap-3">
        <Field label="이름" htmlFor={`${id}-name`} className="col-span-2">
          <Input id={`${id}-name`} name="name" defaultValue={item?.name ?? ""} className="h-11" required />
        </Field>
        <Field label="종류" htmlFor={`${id}-kind`}>
          <select id={`${id}-kind`} name="kind" defaultValue={item?.kind ?? "per_person"} className={cn(inputClass, "h-11")}>
            {PRICE_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="단위" htmlFor={`${id}-unit`}>
          <Input id={`${id}-unit`} name="unit" defaultValue={item?.unit ?? "인"} className="h-11" />
        </Field>
        <Field label="단가 (원)" htmlFor={`${id}-price`}>
          <Input
            id={`${id}-price`}
            name="unitPrice"
            inputMode="numeric"
            defaultValue={item?.unitPrice ?? ""}
            className="h-11"
          />
        </Field>
        <Field label="최소 수량" htmlFor={`${id}-min`}>
          <Input id={`${id}-min`} name="minimumQty" inputMode="numeric" defaultValue={item?.minimumQty ?? ""} className="h-11" />
        </Field>
        <Field label="메뉴" htmlFor={`${id}-menu`} className="col-span-2">
          <Input id={`${id}-menu`} name="menu" defaultValue={item?.menu ?? ""} className="h-11" />
        </Field>
        <Field label="내용" htmlFor={`${id}-content`} className="col-span-2">
          <Input id={`${id}-content`} name="content" defaultValue={item?.content ?? ""} className="h-11" />
        </Field>
        <Field label="비고" htmlFor={`${id}-note`} className="col-span-2">
          <Input id={`${id}-note`} name="note" defaultValue={item?.note ?? ""} className="h-11" />
        </Field>
        <Field label="순서" htmlFor={`${id}-sort`} hint={item ? undefined : "비워 두면 맨 끝에 들어가요."}>
          <Input id={`${id}-sort`} name="sort" inputMode="numeric" defaultValue={item?.sort ?? ""} className="h-11" />
        </Field>
        <label className="flex min-h-11 items-center gap-2 self-end text-sm font-medium">
          <input type="checkbox" name="enabled" value="1" defaultChecked={item?.enabled ?? true} className="size-5" />
          견적에 쓰기
        </label>
      </div>
    </>
  );
}

function PriceRow({ item }: { item: PriceItem }) {
  const save = useFetcher<ActionResult>();
  const del = useFetcher<ActionResult>();
  const busy = save.state !== "idle" || del.state !== "idle";
  return (
    <Card className={cn("flex flex-col gap-3 p-3", item.needsConfirm && "border-amber-300 bg-amber-50", !item.enabled && "opacity-70")}>
      {item.needsConfirm && (
        <Badge variant="warning" className="self-start">
          확인 필요
        </Badge>
      )}
      <save.Form method="post" className="flex flex-col gap-3">
        <input type="hidden" name="intent" value="savePriceItem" />
        <PriceFields item={item} />
        <div className="flex items-center gap-2">
          <Button type="submit" className="h-11 flex-1" disabled={busy}>
            {save.state !== "idle" ? "저장 중…" : item.needsConfirm ? "확인하고 저장" : "저장"}
          </Button>
        </div>
      </save.Form>
      <del.Form
        method="post"
        onSubmit={(e) => {
          if (!confirm(`'${item.name}' 줄을 지울까요? 이미 만든 견적은 그대로예요.`)) e.preventDefault();
        }}
      >
        <input type="hidden" name="intent" value="deletePriceItem" />
        <input type="hidden" name="id" value={item.id} />
        <Button type="submit" variant="ghost" className="h-11 text-destructive" disabled={busy}>
          삭제
        </Button>
      </del.Form>
      <Message result={save.data} success="저장했어요." />
      {del.data?.error && <Message result={del.data} success="" />}
    </Card>
  );
}

function AddRow() {
  const fetcher = useFetcher<ActionResult>();
  return (
    <Card className="flex flex-col gap-3 border-dashed p-3">
      <h3 className="text-sm font-medium">새 줄 추가</h3>
      <fetcher.Form method="post" className="flex flex-col gap-3">
        <input type="hidden" name="intent" value="savePriceItem" />
        <PriceFields />
        <Button type="submit" variant="outline" className="h-11" disabled={fetcher.state !== "idle"}>
          {fetcher.state !== "idle" ? "추가하는 중…" : "추가"}
        </Button>
      </fetcher.Form>
      {fetcher.data?.error && <Message result={fetcher.data} success="" />}
    </Card>
  );
}
