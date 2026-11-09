// Pure layout of the comparison panel (no React), so it can be tested on its own.
import type { Comparison, ComparisonRow } from "./types";

/** Rows shown per kind before "더 보기". */
export const PANEL_LIMIT = 5;

const KIND_ORDER: ComparisonRow["kind"][] = ["own", "price", "event"];

/**
 * `cited`: the AI's note rests on it. `href`: the app page of an own quote (row id `q<quoteId>`),
 * null once that quote is deleted.
 */
export type PanelRow = ComparisonRow & { cited: boolean; href: string | null };
export type PanelGroup = { kind: ComparisonRow["kind"]; rows: PanelRow[] };

/** The quote an own row stands for, or null for other rows. */
export function ownQuoteId(row: ComparisonRow): number | null {
  const m = row.kind === "own" ? /^q(\d+)$/.exec(row.id) : null;
  return m ? Number(m[1]) : null;
}

/**
 * Non-empty kinds in order (own quotes, competitor prices, competitor events); cited rows first.
 * `liveQuoteIds`: own quotes that still exist (the stored rows outlive a deleted quote); left out,
 * every own row links.
 */
export function comparisonGroups(comparison: Comparison, liveQuoteIds?: ReadonlySet<number>): PanelGroup[] {
  const ownHref = (row: ComparisonRow) => {
    const id = ownQuoteId(row);
    return id === null || (liveQuoteIds && !liveQuoteIds.has(id)) ? null : `/quotes/${id}`;
  };
  const cited = new Set(comparison.citedIds);
  return KIND_ORDER.map((kind) => {
    const rows = comparison.rows
      .filter((r) => r.kind === kind)
      .map((r) => ({ ...r, cited: cited.has(r.id), href: ownHref(r) }));
    // Stable: within cited and not cited, the stored (ranked) order stays.
    rows.sort((a, b) => Number(b.cited) - Number(a.cited));
    return { kind, rows };
  }).filter((g) => g.rows.length > 0);
}

export function visibleRows(group: PanelGroup, expanded: boolean): PanelRow[] {
  return expanded ? group.rows : group.rows.slice(0, PANEL_LIMIT);
}
