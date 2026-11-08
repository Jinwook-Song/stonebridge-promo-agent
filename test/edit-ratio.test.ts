import { describe, expect, it } from "vitest";
import { editRatio } from "../app/promo/edit-ratio";

describe("editRatio", () => {
  it("is line-level Levenshtein over the longer line count", () => {
    expect(editRatio("a\nb\nc", "a\nb\nc")).toBe(0);
    expect(editRatio("a\nb\nc\nd", "a\nX\nc\nd")).toBe(0.25);
    expect(editRatio("a", "b\nc")).toBe(1);
  });

  it("rounds to 2 decimals and handles empty text", () => {
    expect(editRatio("a\nb\nc", "a\nb\nX")).toBe(0.33);
    expect(editRatio("", "")).toBe(0);
    expect(editRatio("a\nb", "a\nb\nc")).toBe(0.33);
  });
});
