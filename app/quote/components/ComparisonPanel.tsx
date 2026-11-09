import { ExternalLinkIcon } from "lucide-react";
import { Badge } from "../../components/ui/badge";
import type { Comparison, ComparisonRow } from "../types";

const KIND: Record<ComparisonRow["kind"], { label: string; variant: "info" | "muted" | "warning" }> = {
  own: { label: "지난 견적", variant: "info" },
  price: { label: "경쟁 업체 가격", variant: "warning" },
  event: { label: "경쟁 업체 행사", variant: "muted" },
};

/** `2026-11-08T03:00:00Z` or `2026-11-08` → `2026-11-08`. */
function day(iso: string): string {
  return iso.slice(0, 10);
}

/** Source links come from saved web pages; only plain web addresses become links. */
const isWebUrl = (url: string) => /^https?:\/\//i.test(url);

/**
 * Past own quotes first, then competitor prices, then competitor events (the order the rows are
 * stored in). The AI's note is shown only together with its rows: a note with nothing under it
 * would be a claim without a source.
 */
export function ComparisonPanel({ comparison }: { comparison: Comparison | null }) {
  if (!comparison || comparison.rows.length === 0) {
    return <p className="text-sm text-muted-foreground">아직 비교할 자료가 없어요</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      {comparison.notes.trim() !== "" && <p className="text-sm leading-relaxed break-keep">{comparison.notes}</p>}
      <ul className="flex flex-col divide-y rounded-lg border bg-card">
        {comparison.rows.map((row) => (
          <li key={row.id} className="flex flex-col gap-1 px-3 py-2.5 sm:flex-row sm:items-center sm:gap-3">
            <Badge variant={KIND[row.kind].variant} className="self-start">
              {KIND[row.kind].label}
            </Badge>
            <p className="min-w-0 flex-1 text-sm break-words">{row.label}</p>
            <p className="shrink-0 text-sm font-medium tabular-nums">
              {row.perPerson === null ? "—" : `1인 ${row.perPerson.toLocaleString("ko-KR")}원`}
            </p>
            <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
              {row.sourceUrl && isWebUrl(row.sourceUrl) && (
                <a
                  href={row.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex min-h-11 items-center gap-1 text-primary underline underline-offset-2 sm:min-h-0"
                >
                  출처
                  <ExternalLinkIcon className="size-3" aria-hidden="true" />
                </a>
              )}
              {row.seenAt && <span>{day(row.seenAt)}</span>}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
