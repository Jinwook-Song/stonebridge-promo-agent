import { describe, expect, it } from "vitest";
import {
  addCandidates,
  applyPicks,
  isErrorBody,
  readPicks,
  removeCandidate,
  toggle,
  type Selection,
} from "../app/promo/photo-selection";
import { MAX_PHOTOS } from "../app/promo/types";

const empty: Selection = { order: [], reasons: {} };
const range = (from: number, count: number) => Array.from({ length: count }, (_, i) => from + i);

describe("addCandidates", () => {
  it("appends new ids in order while there is room", () => {
    expect(addCandidates(empty, [3, 4, 5])).toEqual({ order: [3, 4, 5], reasons: {} });
    expect(addCandidates({ order: [1], reasons: { 1: "케이크" } }, [2])).toEqual({
      order: [1, 2],
      reasons: { 1: "케이크" },
    });
  });

  it("stops at 8 and leaves the rest unselected", () => {
    const sel = addCandidates(empty, range(0, 12));
    expect(sel.order).toEqual(range(0, 8));
    expect(MAX_PHOTOS).toBe(8);
    expect(addCandidates(sel, [20, 21])).toBe(sel);
  });

  it("fills only the room left and honours a custom max", () => {
    expect(addCandidates({ order: range(0, 6), reasons: {} }, [10, 11, 12]).order).toEqual([0, 1, 2, 3, 4, 5, 10, 11]);
    expect(addCandidates(empty, [1, 2, 3], 2).order).toEqual([1, 2]);
  });

  it("does not add an id twice", () => {
    expect(addCandidates({ order: [1], reasons: {} }, [1, 2, 2]).order).toEqual([1, 2]);
  });
});

describe("toggle", () => {
  it("removes a selected id and drops its reason", () => {
    const sel: Selection = { order: [1, 2, 3], reasons: { 1: "전체", 2: "포장" } };
    expect(toggle(sel, 2)).toEqual({ order: [1, 3], reasons: { 1: "전체" } });
  });

  it("appends an unselected id when there is room", () => {
    expect(toggle({ order: [1], reasons: { 1: "전체" } }, 5)).toEqual({ order: [1, 5], reasons: { 1: "전체" } });
  });

  it("is a no-op on a full selection", () => {
    const full: Selection = { order: range(0, 8), reasons: {} };
    expect(toggle(full, 99)).toBe(full);
    expect(toggle({ order: [1, 2], reasons: {} }, 3, 2).order).toEqual([1, 2]);
  });

  it("still lets her deselect from a full selection", () => {
    expect(toggle({ order: range(0, 8), reasons: {} }, 0).order).toEqual(range(1, 7));
  });
});

describe("removeCandidate", () => {
  it("drops the id and its reason, keeping the rest in order", () => {
    const sel: Selection = { order: [4, 2, 7], reasons: { 2: "리본", 7: "배송" } };
    expect(removeCandidate(sel, 2)).toEqual({ order: [4, 7], reasons: { 7: "배송" } });
  });

  it("returns the same selection for an unselected id", () => {
    const sel: Selection = { order: [1], reasons: {} };
    expect(removeCandidate(sel, 9)).toBe(sel);
  });
});

describe("applyPicks", () => {
  it("maps 1-based n onto the ids that were sent, in pick order", () => {
    const sel = applyPicks(
      empty,
      [
        { n: 2, reason: "포장 상자" },
        { n: 1, reason: "케이크 전체" },
      ],
      [10, 11, 12],
      new Set([10, 11, 12]),
    );
    expect(sel).toEqual({ order: [11, 10], reasons: { 11: "포장 상자", 10: "케이크 전체" } });
  });

  it("skips photos she removed while the AI was picking", () => {
    const sel = applyPicks(
      empty,
      [
        { n: 3, reason: "리본" },
        { n: 1, reason: "전체" },
      ],
      [10, 11, 12],
      new Set([10, 11]),
    );
    expect(sel.order).toEqual([10]);
    expect(sel.reasons).toEqual({ 10: "전체" });
  });

  it("replaces the order and reasons instead of merging them", () => {
    const before: Selection = { order: [11, 12, 13], reasons: { 12: "예전 이유", 13: "남으면 안 됨" } };
    const sel = applyPicks(before, [{ n: 1, reason: "새 이유" }], [12, 13], new Set([11, 12, 13]));
    expect(sel).toEqual({ order: [12], reasons: { 12: "새 이유" } });
  });

  it("ignores out-of-range and duplicate n and caps at 8", () => {
    const sent = range(100, 12);
    const picks = [
      { n: 0, reason: "x" },
      { n: 13, reason: "x" },
      { n: 1.5, reason: "x" },
      { n: 2, reason: "a" },
      { n: 2, reason: "dup" },
      ...range(3, 10).map((n) => ({ n, reason: `r${n}` })),
    ];
    const sel = applyPicks(empty, picks, sent, new Set(sent));
    expect(sel.order).toEqual([101, 102, 103, 104, 105, 106, 107, 108]);
    expect(sel.reasons[101]).toBe("a");
  });

  it("keeps the current selection when no pick is still present", () => {
    const before: Selection = { order: [1, 2], reasons: {} };
    expect(applyPicks(before, [{ n: 1, reason: "gone" }], [9], new Set([1, 2]))).toBe(before);
  });
});

describe("readPicks", () => {
  it("keeps well-formed picks in order", () => {
    expect(readPicks({ picks: [{ n: 2, reason: "전체 모습" }, { n: 1, reason: "포장" }] })).toEqual([
      { n: 2, reason: "전체 모습" },
      { n: 1, reason: "포장" },
    ]);
  });

  it("drops malformed entries and returns null when none survive", () => {
    expect(readPicks({ picks: [{ n: "2", reason: "x" }, null, { n: 3 }, { n: 4, reason: "ok" }] })).toEqual([
      { n: 4, reason: "ok" },
    ]);
    expect(readPicks({ picks: [{ n: "2", reason: "x" }] })).toBeNull();
    expect(readPicks({ picks: [] })).toBeNull();
  });

  it("returns null for bodies that are not a picks object", () => {
    for (const body of [null, undefined, "picks", 3, [], {}, { picks: "1,2" }, { error: "실패" }]) {
      expect(readPicks(body)).toBeNull();
    }
  });
});

describe("isErrorBody", () => {
  it("accepts only an object with a string error", () => {
    expect(isErrorBody({ error: "사진을 고르지 못했어요." })).toBe(true);
    for (const body of [null, undefined, "error", {}, { error: 500 }, { picks: [] }]) {
      expect(isErrorBody(body)).toBe(false);
    }
  });
});
