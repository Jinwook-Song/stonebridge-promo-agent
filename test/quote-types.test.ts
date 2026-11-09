import { describe, expect, it } from "vitest";
import { QuoteLineSchema } from "../app/quote/types";

const line = {
  itemId: null,
  label: "item",
  content: "",
  qty: 10,
  unitPrice: 1000,
  priceSource: "hand",
  svc: false,
  menu: "",
  note: "",
};

describe("QuoteLineSchema", () => {
  it("accepts a line with or without a unit price", () => {
    expect(QuoteLineSchema.safeParse(line).success).toBe(true);
    expect(QuoteLineSchema.safeParse({ ...line, unitPrice: null }).success).toBe(true);
  });

  it("reads a stored line without a tip (older versions, imported lines) as an empty tip", () => {
    const parsed = QuoteLineSchema.safeParse(line);
    expect(parsed.success && parsed.data.tip).toBe("");
  });

  it("keeps the owner-only tip", () => {
    const parsed = QuoteLineSchema.safeParse({ ...line, tip: "SVC 제안" });
    expect(parsed.success && parsed.data.tip).toBe("SVC 제안");
  });

  it("rejects out-of-range or fractional numbers", () => {
    expect(QuoteLineSchema.safeParse({ ...line, qty: -1 }).success).toBe(false);
    expect(QuoteLineSchema.safeParse({ ...line, qty: 100001 }).success).toBe(false);
    expect(QuoteLineSchema.safeParse({ ...line, qty: 1.5 }).success).toBe(false);
    expect(QuoteLineSchema.safeParse({ ...line, unitPrice: 100000001 }).success).toBe(false);
    expect(QuoteLineSchema.safeParse({ ...line, unitPrice: -5 }).success).toBe(false);
    expect(QuoteLineSchema.safeParse({ ...line, priceSource: "zzz" }).success).toBe(false);
  });
});
