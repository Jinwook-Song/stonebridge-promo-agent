import { ExternalLinkIcon } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { Badge } from "../../components/ui/badge";
import { cn } from "../../lib/utils";
import { comparisonGroups, PANEL_LIMIT, visibleRows, type PanelGroup } from "../comparison-view";
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
 * What the AI was shown when it made this version: past own quotes, competitor prices, competitor
 * events, up to PANEL_LIMIT of each until "더 보기". Rows the AI's note rests on are marked
 * "근거" and listed first. The note is stored only when it cites at least one of these rows.
 */
export function ComparisonPanel({
  comparison,
  liveQuoteIds,
}: {
  comparison: Comparison | null;
  /** Own quotes that still exist: a deleted one is listed without a link. */
  liveQuoteIds: ReadonlySet<number>;
}) {
  if (!comparison || comparison.rows.length === 0) {
    return <p className="text-sm text-muted-foreground">아직 비교할 자료가 없어요</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      {comparison.notes.trim() !== "" && <p className="text-sm leading-relaxed break-keep">{comparison.notes}</p>}
      {comparisonGroups(comparison, liveQuoteIds).map((group) => (
        <KindGroup key={group.kind} group={group} />
      ))}
    </div>
  );
}

function KindGroup({ group }: { group: PanelGroup }) {
  const [expanded, setExpanded] = useState(false);
  const hidden = group.rows.length - PANEL_LIMIT;
  return (
    <div className="flex flex-col gap-1">
      <ul className="flex flex-col divide-y rounded-lg border bg-card">
        {visibleRows(group, expanded).map((row) => (
          <li
            key={row.id}
            className={cn(
              "flex flex-col gap-1 px-3 py-2.5 sm:flex-row sm:items-center sm:gap-3",
              row.cited && "bg-primary/5",
            )}
          >
            <div className="flex shrink-0 items-center gap-1 self-start">
              <Badge variant={KIND[row.kind].variant}>{KIND[row.kind].label}</Badge>
              {row.cited && <Badge>근거</Badge>}
            </div>
            {row.href ? (
              <Link
                to={row.href}
                className="flex min-h-11 min-w-0 flex-1 items-center text-sm break-words text-primary underline underline-offset-2 sm:min-h-0"
              >
                {row.label || "견적"}
              </Link>
            ) : (
              <p className="min-w-0 flex-1 text-sm break-words">{row.label}</p>
            )}
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
      {hidden > 0 && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className="flex min-h-11 items-center self-start text-sm text-primary underline underline-offset-2"
        >
          {expanded ? "접기" : `${KIND[group.kind].label} 더 보기 (${hidden}개)`}
        </button>
      )}
    </div>
  );
}
