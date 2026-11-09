import { CircleAlertIcon, LightbulbIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { Button } from "../../components/ui/button";
import { Input, inputClass } from "../../components/ui/input";
import { Switch } from "../../components/ui/switch";
import { Badge } from "../../components/ui/badge";
import { cn } from "../../lib/utils";
import { computeTotals, lineAmount } from "../lines";
import type { QuoteLine } from "../types";
import { useJsonSaver, useReportSync, type SyncState } from "./use-saver";

/** The few price sheet columns the picker needs. */
export type SheetChoice = {
  id: number;
  name: string;
  content: string;
  unit: string;
  unitPrice: number | null;
  minimumQty: number | null;
  menu: string;
  note: string;
};

type Row = { key: number; line: QuoteLine };

const MAX_QTY = 100_000;
const MAX_WON = 100_000_000;

const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;

/** Digits only; "" stays "" so a box can be emptied while typing. Capped at the schema limit. */
function digits(raw: string, max: number): string {
  const text = raw.replace(/\D/g, "").replace(/^0+(?=\d)/, "");
  return text !== "" && Number(text) > max ? String(max) : text;
}

function blankLine(): QuoteLine {
  return { itemId: null, label: "", content: "", qty: 1, unitPrice: null, priceSource: "hand", svc: false, menu: "", note: "" };
}

function lineFromSheet(item: SheetChoice): QuoteLine {
  return {
    itemId: item.id,
    label: item.name,
    content: item.content,
    qty: item.minimumQty ?? 1,
    unitPrice: item.unitPrice,
    // A sheet item without a price is no better than a typed-in line: she fills it in.
    priceSource: item.unitPrice === null ? "hand" : "sheet",
    svc: false,
    menu: item.menu,
    note: item.note,
  };
}

/**
 * The quote table. Edits show at once (and the totals follow); every change is saved right away
 * through useJsonSaver, text boxes when she leaves them. Phone: one card per line. Wide: a grid.
 */
export function LinesTable({
  quoteId,
  version,
  initialLines,
  vatIncluded,
  sheet,
  readOnly,
  onUnsavedChange,
}: {
  quoteId: number;
  version: number;
  initialLines: QuoteLine[];
  vatIncluded: boolean;
  sheet: SheetChoice[];
  readOnly: boolean;
  /** While the lines on screen are not what the server holds ("saving", or "failed" until retried) a download would be stale. */
  onUnsavedChange?: (state: SyncState) => void;
}) {
  const nextKey = useRef(initialLines.length);
  const [rows, setRows] = useState<Row[]>(() => initialLines.map((line, key) => ({ key, line })));
  const [focusKey, setFocusKey] = useState<number | null>(null);
  const saver = useJsonSaver({ quoteId, version, intent: "saveLines", field: "lines", initial: initialLines });
  useReportSync(saver, onUnsavedChange);
  const lines = rows.map((r) => r.line);
  const totals = computeTotals(lines, vatIncluded);

  function commit(next: Row[]) {
    saver.save(next.map((r) => r.line));
  }

  /** `save` false while typing in a text box; the blur saves. */
  function change(key: number, patch: Partial<QuoteLine>, save: boolean) {
    const next = rows.map((r) => (r.key === key ? { ...r, line: { ...r.line, ...patch } } : r));
    setRows(next);
    if (save) commit(next);
  }

  function add(line: QuoteLine) {
    const key = nextKey.current++;
    const next = [...rows, { key, line }];
    setRows(next);
    setFocusKey(line.label === "" ? key : null);
    commit(next);
  }

  function remove(key: number) {
    const next = rows.filter((r) => r.key !== key);
    setRows(next);
    commit(next);
  }

  return (
    <div className="flex flex-col gap-3">
      {rows.length === 0 && <p className="py-4 text-center text-sm text-muted-foreground">줄이 없어요. 아래에서 추가해 주세요.</p>}
      {rows.length > 0 && (
        <div
          aria-hidden="true"
          className="hidden gap-2 px-2 text-xs font-medium text-muted-foreground md:grid md:grid-cols-[minmax(0,1.3fr)_minmax(0,1.5fr)_5rem_7rem_6.5rem_9rem]"
        >
          <span>항목</span>
          <span>내용</span>
          <span>수량</span>
          <span>단가</span>
          <span className="text-right">금액</span>
          <span />
        </div>
      )}
      <ul className="flex flex-col gap-2 md:gap-0 md:divide-y md:rounded-lg md:border md:bg-card">
        {rows.map((row) => (
          <LineRow
            key={row.key}
            line={row.line}
            readOnly={readOnly}
            autoFocus={row.key === focusKey}
            onChange={(patch, save) => change(row.key, patch, save)}
            onBlur={() => commit(rows)}
            onRemove={() => remove(row.key)}
          />
        ))}
      </ul>

      {!readOnly && (
        <div className="flex flex-col gap-2 sm:flex-row">
          <select
            aria-label="가격 기준표에서 추가"
            value=""
            onChange={(e) => {
              const item = sheet.find((s) => s.id === Number(e.currentTarget.value));
              if (item) add(lineFromSheet(item));
            }}
            className={cn(inputClass, "h-11 sm:flex-1")}
          >
            <option value="">가격 기준표에서 추가…</option>
            {sheet.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} · {s.unitPrice === null ? "단가 없음" : `${s.unitPrice.toLocaleString("ko-KR")}원`}/{s.unit}
              </option>
            ))}
          </select>
          <Button type="button" variant="outline" className="h-11" onClick={() => add(blankLine())}>
            <PlusIcon aria-hidden="true" />
            직접 입력 줄 추가
          </Button>
        </div>
      )}

      {saver.error && (
        <p role="alert" className="flex flex-wrap items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          <CircleAlertIcon className="size-4 shrink-0" aria-hidden="true" />
          <span className="flex-1">{saver.error} 화면에는 고친 값이 그대로 있어요.</span>
          <Button type="button" size="sm" variant="outline" className="h-11" onClick={saver.retry}>
            다시 저장
          </Button>
        </p>
      )}

      <dl className="ml-auto flex w-full flex-col gap-1 rounded-lg bg-muted/60 px-3 py-3 text-sm sm:max-w-xs">
        <div className="flex justify-between gap-4">
          <dt>공급금액</dt>
          <dd className="font-medium tabular-nums">{won(totals.supply)}</dd>
        </div>
        {vatIncluded && (
          <>
            <div className="flex justify-between gap-4 text-muted-foreground">
              <dt>VAT 10%</dt>
              <dd className="tabular-nums">{won(totals.vat)}</dd>
            </div>
            <div className="flex justify-between gap-4 border-t pt-1 text-base font-semibold">
              <dt>합계 (VAT 포함)</dt>
              <dd className="tabular-nums">{won(totals.total)}</dd>
            </div>
          </>
        )}
        {!vatIncluded && <p className="text-xs text-muted-foreground">VAT 없이 공급금액만 적어요.</p>}
        {totals.missingPrices > 0 && (
          <p className="mt-1 flex items-start gap-1.5 text-sm text-amber-800">
            <CircleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            단가 없는 줄 {totals.missingPrices}개는 합계에 들어가지 않았어요.
          </p>
        )}
      </dl>
    </div>
  );
}

function LineRow({
  line,
  readOnly,
  autoFocus,
  onChange,
  onBlur,
  onRemove,
}: {
  line: QuoteLine;
  readOnly: boolean;
  autoFocus: boolean;
  onChange: (patch: Partial<QuoteLine>, save: boolean) => void;
  onBlur: () => void;
  onRemove: () => void;
}) {
  // The two number boxes keep their own text so they can be emptied and retyped.
  const [qtyText, setQtyText] = useState(String(line.qty));
  const [priceText, setPriceText] = useState(line.unitPrice === null ? "" : String(line.unitPrice));
  const amount = lineAmount(line);
  const small = "h-11 md:h-10 md:text-sm";

  return (
    <li className="grid grid-cols-2 gap-2 rounded-lg border bg-card p-3 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1.5fr)_5rem_7rem_6.5rem_9rem] md:rounded-none md:border-0 md:p-2">
      <Cell label="항목" className="col-span-2 md:col-span-1">
        <Input
          value={line.label}
          readOnly={readOnly}
          autoFocus={autoFocus}
          onChange={(e) => onChange({ label: e.currentTarget.value }, false)}
          onBlur={onBlur}
          className={small}
          placeholder="항목 이름"
        />
      </Cell>
      <Cell label="내용" className="col-span-2 md:col-span-1">
        <Input
          value={line.content}
          readOnly={readOnly}
          onChange={(e) => onChange({ content: e.currentTarget.value }, false)}
          onBlur={onBlur}
          className={small}
        />
      </Cell>
      <Cell label="수량">
        <Input
          inputMode="numeric"
          value={qtyText}
          readOnly={readOnly}
          onChange={(e) => {
            const text = digits(e.currentTarget.value, MAX_QTY);
            setQtyText(text);
            onChange({ qty: text === "" ? 0 : Number(text) }, false);
          }}
          onBlur={onBlur}
          className={cn(small, "text-right tabular-nums")}
        />
      </Cell>
      <Cell label="단가 (원)">
        <Input
          inputMode="numeric"
          value={priceText}
          readOnly={readOnly}
          placeholder="없음"
          onChange={(e) => {
            const text = digits(e.currentTarget.value, MAX_WON);
            setPriceText(text);
            // Typing a price makes it her price, whatever the sheet said.
            onChange({ unitPrice: text === "" ? null : Number(text), priceSource: "hand" }, false);
          }}
          onBlur={onBlur}
          className={cn(small, "text-right tabular-nums")}
        />
      </Cell>
      <div className="col-span-2 flex items-center justify-between gap-2 md:col-span-1 md:justify-end md:pt-2">
        <span className="text-sm text-muted-foreground md:hidden">금액</span>
        <span className="text-right text-base font-medium tabular-nums md:text-sm" aria-label="금액">
          {amount === "SVC" ? (
            <Badge variant="success">SVC</Badge>
          ) : amount === null ? (
            <Badge variant="warning">단가 없음</Badge>
          ) : (
            `${amount.toLocaleString("ko-KR")}원`
          )}
        </span>
      </div>
      <div className="col-span-2 flex items-center justify-between gap-2 md:col-span-1 md:justify-end">
        <label className="flex items-center gap-1 text-sm">
          <span>SVC</span>
          <Switch
            checked={line.svc}
            disabled={readOnly}
            aria-label={`${line.label || "이 줄"} SVC`}
            onCheckedChange={(svc) => onChange({ svc }, true)}
          />
        </label>
        {!readOnly && (
          <Button
            type="button"
            variant="ghost"
            className="size-11 text-muted-foreground"
            aria-label={`${line.label || "이 줄"} 지우기`}
            onClick={onRemove}
          >
            <Trash2Icon aria-hidden="true" />
          </Button>
        )}
      </div>
      {line.unitPrice === null && line.itemId === null && (
        <p className="col-span-2 text-xs text-amber-800 md:col-span-full md:px-1">가격 기준표에 없음 - 단가를 적어 주세요.</p>
      )}
      <Cell label="메뉴" always className="md:col-span-3">
        <Input
          value={line.menu}
          readOnly={readOnly}
          onChange={(e) => onChange({ menu: e.currentTarget.value }, false)}
          onBlur={onBlur}
          className={small}
        />
      </Cell>
      <Cell label="비고" hint="견적서에 나가요" always className="md:col-span-3">
        <Input
          value={line.note}
          readOnly={readOnly}
          onChange={(e) => onChange({ note: e.currentTarget.value }, false)}
          onBlur={onBlur}
          className={small}
        />
      </Cell>
      {/* The AI's advice for her only: never in the Excel file. It rides along when she edits the line. */}
      {line.tip && (
        <p className="col-span-2 flex items-start gap-1.5 text-xs text-amber-800 md:col-span-full md:px-1">
          <LightbulbIcon className="mt-px size-3.5 shrink-0" aria-hidden="true" />
          <span>AI 제안: {line.tip}</span>
        </p>
      )}
    </li>
  );
}

/** A labeled box. The label shows above the box on a phone; on wide screens the column header (or `always`) does. */
function Cell({
  label,
  hint,
  className,
  always,
  children,
}: {
  label: string;
  /** Short note after the label, e.g. that the field is printed for the customer. */
  hint?: string;
  className?: string;
  always?: boolean;
  children: ReactNode;
}) {
  return (
    <label className={cn("flex min-w-0 flex-col gap-1", className)}>
      <span className={cn("text-xs text-muted-foreground", !always && "md:sr-only")}>
        {label}
        {hint && <span className="ml-1 text-sky-700">· {hint}</span>}
      </span>
      {children}
    </label>
  );
}
