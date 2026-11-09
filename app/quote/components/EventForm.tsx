import { CircleAlertIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Field } from "../../components/ui/label";
import { Textarea } from "../../components/ui/textarea";
import type { QuoteEvent } from "../types";
import { useJsonSaver, useReportSync, type SyncState } from "./use-saver";

type TextKey = Exclude<keyof QuoteEvent, "headcount" | "missing">;

const TEXT_FIELDS: { key: TextKey; label: string }[] = [
  { key: "customerName", label: "고객·단체" },
  { key: "eventType", label: "행사 종류" },
  { key: "eventDate", label: "행사 날짜" },
  { key: "venue", label: "장소" },
  { key: "contactName", label: "담당자" },
  { key: "contact", label: "연락처" },
  { key: "email", label: "이메일" },
  { key: "budget", label: "예산" },
];

/**
 * The event details and the AI's "확인할 것" questions. Boxes save when she leaves them; a
 * question is crossed off with its button.
 */
export function EventForm({
  quoteId,
  version,
  initialEvent,
  readOnly,
  onUnsavedChange,
}: {
  quoteId: number;
  version: number;
  initialEvent: QuoteEvent;
  readOnly: boolean;
  /** Like LinesTable's: the Excel button waits while the event on screen is not saved. */
  onUnsavedChange?: (state: SyncState) => void;
}) {
  const [event, setEvent] = useState(initialEvent);
  const [headcountText, setHeadcountText] = useState(initialEvent.headcount === null ? "" : String(initialEvent.headcount));
  const saver = useJsonSaver({ quoteId, version, intent: "saveEvent", field: "event", initial: initialEvent });
  useReportSync(saver, onUnsavedChange);

  const set = (patch: Partial<QuoteEvent>) => setEvent((prev) => ({ ...prev, ...patch }));

  function dismiss(index: number) {
    const next = { ...event, missing: event.missing.filter((_, i) => i !== index) };
    setEvent(next);
    saver.save(next);
  }

  return (
    <div className="flex flex-col gap-4">
      {event.missing.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-amber-900">
          <p className="text-sm font-medium">확인할 것</p>
          <ul className="mt-1 flex flex-col">
            {event.missing.map((q, i) => (
              <li key={`${i}-${q}`} className="flex items-center gap-2 text-sm">
                <span className="flex-1 py-1.5 break-keep">{q}</span>
                {!readOnly && (
                  <button
                    type="button"
                    aria-label={`확인했어요: ${q}`}
                    onClick={() => dismiss(i)}
                    className="flex size-11 shrink-0 items-center justify-center rounded-md active:bg-amber-100"
                  >
                    <XIcon className="size-4" aria-hidden="true" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {TEXT_FIELDS.map(({ key, label }) => (
          <Field key={key} label={label} htmlFor={`event-${key}`}>
            <Input
              id={`event-${key}`}
              value={event[key]}
              readOnly={readOnly}
              onChange={(e) => set({ [key]: e.currentTarget.value })}
              onBlur={() => saver.save(event)}
              className="h-11"
            />
          </Field>
        ))}
        <Field label="인원 (명)" htmlFor="event-headcount">
          <Input
            id="event-headcount"
            inputMode="numeric"
            value={headcountText}
            readOnly={readOnly}
            onChange={(e) => {
              const text = e.currentTarget.value.replace(/\D/g, "").slice(0, 6);
              setHeadcountText(text);
              set({ headcount: text === "" ? null : Number(text) });
            }}
            onBlur={() => saver.save(event)}
            className="h-11"
          />
        </Field>
        <Field label="요청 사항" htmlFor="event-requests" className="sm:col-span-2" hint="견적서에 특이사항으로 나가요.">
          <Textarea
            id="event-requests"
            rows={3}
            value={event.requests}
            readOnly={readOnly}
            onChange={(e) => set({ requests: e.currentTarget.value })}
            onBlur={() => saver.save(event)}
          />
        </Field>
      </div>
      {saver.error && (
        <p role="alert" className="flex flex-wrap items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          <CircleAlertIcon className="size-4 shrink-0" aria-hidden="true" />
          <span className="flex-1">{saver.error}</span>
          <Button type="button" size="sm" variant="outline" className="h-11" onClick={saver.retry}>
            다시 저장
          </Button>
        </p>
      )}
    </div>
  );
}
