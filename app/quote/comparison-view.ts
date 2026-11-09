// Pure layout of the comparison panel (no React), so it can be tested on its own.
import type { Comparison, ComparisonRow } from "./types";

/** Rows shown per kind before "더 보기". */
export const PANEL_LIMIT = 5;

const KIND_ORDER: ComparisonRow["kind"][] = ["own", "price", "event"];

/** `cited`: the AI's note rests on it. `href`: the app page of an own quote (row id `q<quoteId>`). */
export type PanelRow = ComparisonRow & { cited: boolean; href: string | null };
export type PanelGroup = { kind: ComparisonRow["kind"]; rows: PanelRow[] };

function ownHref(row: ComparisonRow): string | null {
  const m = row.kind === "own" ? /^q(\d+)$/.exec(row.id) : null;
  return m ? `/quotes/${m[1]}` : null;
}

/** Non-empty kinds in order (own quotes, competitor prices, competitor events); cited rows first. */
export function comparisonGroups(comparison: Comparison): PanelGroup[] {
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
