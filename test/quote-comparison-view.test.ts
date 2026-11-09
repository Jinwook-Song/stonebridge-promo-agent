import { describe, expect, it } from "vitest";
import { comparisonGroups, PANEL_LIMIT, visibleRows } from "../app/quote/comparison-view";
import type { ComparisonRow } from "../app/quote/types";

// Made-up rows; nothing here is real.
const row = (id: string, kind: ComparisonRow["kind"]): ComparisonRow => ({
  id,
  kind,
  label: `줄 ${id}`,
  perPerson: null,
  sourceUrl: null,
  seenAt: null,
});

describe("comparisonGroups", () => {
  it("groups by kind (own, price, event), cited rows first, and links own quotes", () => {
    const rows = [row("e1", "event"), row("q7", "own"), row("p1", "price"), row("p2", "price"), row("q8", "own")];
    const groups = comparisonGroups({ notes: "", rows, citedIds: ["p2", "q8"] });
    expect(groups.map((g) => g.kind)).toEqual(["own", "price", "event"]);
    expect(groups[0].rows.map((r) => [r.id, r.cited, r.href])).toEqual([
      ["q8", true, "/quotes/8"],
      ["q7", false, "/quotes/7"],
    ]);
    expect(groups[1].rows.map((r) => [r.id, r.cited, r.href])).toEqual([
      ["p2", true, null],
      ["p1", false, null],
    ]);
    expect(groups[2].rows.map((r) => r.id)).toEqual(["e1"]);
  });

  it("leaves out empty kinds", () => {
    expect(comparisonGroups({ notes: "", rows: [row("p1", "price")], citedIds: [] }).map((g) => g.kind)).toEqual(["price"]);
  });

  it("shows the first rows of a long group until it is opened", () => {
    const rows = Array.from({ length: PANEL_LIMIT + 3 }, (_, i) => row(`e${i}`, "event"));
    const [group] = comparisonGroups({ notes: "", rows, citedIds: [] });
    expect(visibleRows(group, false)).toHaveLength(PANEL_LIMIT);
    expect(visibleRows(group, true)).toHaveLength(PANEL_LIMIT + 3);
  });
});
