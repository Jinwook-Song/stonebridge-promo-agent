import { z } from "zod";

export const PRICE_KINDS = ["per_person", "per_event"] as const;
export type PriceKind = (typeof PRICE_KINDS)[number];

/** Where a line's unit price came from: the price sheet, typed by hand, or an imported quote. */
export const PRICE_SOURCES = ["sheet", "hand", "imported"] as const;
export type PriceSource = (typeof PRICE_SOURCES)[number];

export const QUOTE_STATUSES = ["draft", "sent", "won", "lost"] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

export const QUOTE_STATUS_LABELS: Record<QuoteStatus, string> = {
  draft: "초안",
  sent: "보냄",
  won: "성사",
  lost: "무산",
};

export const QUOTE_SOURCES = ["app", "imported"] as const;
export type QuoteSource = (typeof QUOTE_SOURCES)[number];

export const VERSION_STATUSES = ["generating", "ready", "failed"] as const;
export type VersionStatus = (typeof VERSION_STATUSES)[number];

/**
 * Amounts are whole won; `unitPrice` is the supply price (VAT excluded). null = not on the price sheet.
 * `note` goes to the customer (Excel 비고). `tip` is the AI's advice for the owner only: shown in the
 * app, never in the Excel file or the next version's prompt. Older stored lines have no tip.
 */
export type QuoteLine = {
  itemId: number | null;
  label: string;
  content: string;
  qty: number;
  unitPrice: number | null;
  priceSource: PriceSource;
  svc: boolean;
  menu: string;
  note: string;
  tip?: string;
};

/** Unknown string fields are "". */
export type QuoteEvent = {
  customerName: string;
  contactName: string;
  contact: string;
  email: string;
  eventDate: string;
  headcount: number | null;
  venue: string;
  eventType: string;
  budget: string;
  requests: string;
  missing: string[];
};

export type Sender = {
  company: string;
  person: string;
  phone: string;
  email: string;
  payment: string;
  onsite: string;
  bizNo: string;
};

/** id prefix: `q` (own quote line), `p` (competitor price), `e` (competitor event), followed by a number. */
export type ComparisonRow = {
  id: string;
  kind: "own" | "price" | "event";
  label: string;
  perPerson: number | null;
  sourceUrl: string | null;
  seenAt: string | null;
};

/**
 * `rows`: every candidate the model was shown, as it was shown (later watch runs do not change it).
 * `citedIds`: the rows the AI's `notes` rest on. Versions stored before citedIds read as [].
 */
export type Comparison = { notes: string; rows: ComparisonRow[]; citedIds: string[] };

// These validate JSON read back from D1 columns and form input. They are not used for structured
// output, so min/max are fine here.

export const QuoteLineSchema = z.object({
  itemId: z.number().int().nullable(),
  label: z.string(),
  content: z.string(),
  qty: z.number().int().min(0).max(100000),
  unitPrice: z.number().int().min(0).max(100000000).nullable(),
  priceSource: z.enum(PRICE_SOURCES),
  svc: z.boolean(),
  menu: z.string(),
  note: z.string(),
  // No max: a long tip from the model must not make the whole version unreadable.
  tip: z.string().default(""),
});

export const QuoteEventSchema = z.object({
  customerName: z.string(),
  contactName: z.string(),
  contact: z.string(),
  email: z.string(),
  eventDate: z.string(),
  headcount: z.number().int().nullable(),
  venue: z.string(),
  eventType: z.string(),
  budget: z.string(),
  requests: z.string(),
  missing: z.array(z.string()),
});

export const SenderSchema = z.object({
  company: z.string(),
  person: z.string(),
  phone: z.string(),
  email: z.string(),
  payment: z.string(),
  onsite: z.string(),
  bizNo: z.string(),
});

export const ComparisonRowSchema = z.object({
  id: z.string(),
  kind: z.enum(["own", "price", "event"]),
  label: z.string(),
  perPerson: z.number().int().nullable(),
  sourceUrl: z.string().nullable(),
  seenAt: z.string().nullable(),
});

export const ComparisonSchema = z.object({
  notes: z.string(),
  rows: z.array(ComparisonRowSchema),
  citedIds: z.array(z.string()).default([]),
});
