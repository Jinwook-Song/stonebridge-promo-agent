import { and, count, eq, gte, isNotNull, lt } from "drizzle-orm";
import { inquiries, quoteVersions } from "../../database/schema";
import { createQuote, isUniqueViolation } from "../quote/quotes.server";
import type { QuoteEvent } from "../quote/types";
import type { Db } from "../server/db";
import { inquiryInputSchema, inquiryToQuoteText } from "./schema";

/** Appended to the quote text: the contact came through the form and is kept outside the model's reach. */
const CONTACT_NOTE = "연락처: 문의 양식으로 받았어요(따로 저장)";

/** Sender limit: this many inquiries per ipHash within RATE_WINDOW_MS are stored, the next is refused. */
export const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Inquiries (and the contact in their quotes) are kept this long. */
export const RETENTION_DAYS = 365;

export type SubmitResult =
  | { ok: true; inquiryId: number }
  | { ok: false; code: "RATE_LIMITED" | "INVALID" };

/** Event fields only: what the "new inquiry" alert may say. Never name, phone or email. */
export type NewInquiryInfo = {
  /** null when the inquiry is stored but its quote could not be made. */
  quoteId: number | null;
  org: string;
  eventDate: string | null;
  headcount: number | null;
};

export type SubmitDeps = {
  db: Db;
  startGeneration: (quoteId: number) => Promise<void>;
  notify: (info: NewInquiryInfo) => Promise<unknown>;
  /** Runs work after the response (ctx.waitUntil). */
  defer: (work: Promise<unknown>) => void;
};

/**
 * Logging an error object could print query parameters (drizzle puts them in the message), which
 * would leak the customer's contact. Only its class name is logged for anything that touched them.
 */
export function errName(e: unknown): string {
  return e instanceof Error ? e.name : typeof e;
}

async function findByToken(db: Db, clientToken: string) {
  const [row] = await db
    .select({ id: inquiries.id })
    .from(inquiries)
    .where(eq(inquiries.clientToken, clientToken));
  return row?.id ?? null;
}

/**
 * Stores a site inquiry, makes a quote from its event fields and starts the quote generation.
 * `raw` is the already-normalized form the site sends (see inquiryInputSchema). The past-date rule
 * is relaxed by a day: the site validates against its own clock, this one must not refuse a
 * customer over a few hours of skew.
 *
 * The same clientToken gives back the first inquiry (double click, resend). Once the inquiry is
 * stored the result is ok even if the quote, the generation or the alert fails: the owner can
 * still start from the stored inquiry, and the customer must not be told it failed.
 *
 * The generation start stays awaited: a D1 claim and a Workflow create, both inside Cloudflare,
 * and its outcome is recorded on the version. The Kakao alert goes to `defer`: it is an outside
 * API (sometimes after a token refresh) and the site's answer must not wait on it.
 */
export async function submitInquiry(
  deps: SubmitDeps,
  raw: unknown,
  meta: { ipHash: string },
  now: Date,
): Promise<SubmitResult> {
  const { db } = deps;
  const parsed = inquiryInputSchema(new Date(now.getTime() - DAY_MS)).safeParse(raw);
  if (!parsed.success || typeof meta?.ipHash !== "string" || meta.ipHash === "") {
    return { ok: false, code: "INVALID" };
  }
  const v = { ...parsed.data, menus: [...new Set(parsed.data.menus)] };

  // Both reads carry the sender's ipHash or token as query parameters, and drizzle puts those in
  // its error message: rethrown without the cause.
  let recent: number;
  try {
    const existing = await findByToken(db, v.clientToken);
    if (existing !== null) return { ok: true, inquiryId: existing };
    const since = new Date(now.getTime() - RATE_WINDOW_MS).toISOString();
    [{ recent }] = await db
      .select({ recent: count() })
      .from(inquiries)
      .where(and(eq(inquiries.ipHash, meta.ipHash), gte(inquiries.createdAt, since)));
  } catch (e) {
    console.error("inquiry read failed", { error: errName(e) });
    throw new Error("INQUIRY_READ_FAILED");
  }
  if (recent >= RATE_LIMIT) return { ok: false, code: "RATE_LIMITED" };

  const at = now.toISOString();
  let inquiryId: number;
  try {
    const [row] = await db
      .insert(inquiries)
      .values({
        clientToken: v.clientToken,
        ipHash: meta.ipHash,
        contactName: v.contactName,
        org: v.org,
        phone: v.phone,
        email: v.email,
        eventDate: v.eventDate,
        startTime: v.startTime,
        venue: v.venue,
        headcount: v.headcount,
        eventType: v.eventType,
        menusJson: JSON.stringify(v.menus),
        budget: v.budget,
        requests: v.requests,
        referral: v.referral,
        consentAt: at,
        createdAt: at,
      })
      .returning({ id: inquiries.id });
    inquiryId = row.id;
  } catch (e) {
    if (isUniqueViolation(e)) {
      // A concurrent request with the same token won the insert.
      const winner = await findByToken(db, v.clientToken);
      if (winner !== null) return { ok: true, inquiryId: winner };
    }
    // Rethrown without the cause: the original message carries the customer's contact.
    console.error("inquiry insert failed", { error: errName(e) });
    throw new Error("INQUIRY_STORE_FAILED");
  }

  let quoteId: number | null = null;
  try {
    // The last line is not from the customer's fields: it shows the owner (in the quote's input)
    // that the contact is stored apart. The model is told by the program notice outside the fence
    // (contactOnFile in buildQuoteUser), since inside <문의글> every line is data to it.
    const text = `${inquiryToQuoteText(v)}\n${CONTACT_NOTE}`;
    ({ quoteId } = await createQuote(db, { text, source: "app" }, now));
    await db.update(inquiries).set({ quoteId }).where(eq(inquiries.id, inquiryId));
  } catch (e) {
    console.error("inquiry quote failed", { inquiryId, error: errName(e) });
    // The quote may exist but be unlinked (the update failed): do not start it, still tell the owner.
    quoteId = null;
  }

  if (quoteId !== null) {
    try {
      await deps.startGeneration(quoteId);
    } catch (e) {
      console.error("inquiry quote generation did not start", { inquiryId, quoteId, error: errName(e) });
    }
  }
  const info: NewInquiryInfo = { quoteId, org: v.org, eventDate: v.eventDate, headcount: v.headcount };
  // The async wrapper also catches a notify that throws before returning its promise.
  const alert = (async () => deps.notify(info))().catch((e: unknown) => {
    console.error("inquiry alert failed", { inquiryId, quoteId, error: errName(e) });
  });
  deps.defer(alert);
  return { ok: true, inquiryId };
}

/** The customer's contact for a quote that came from a site inquiry; null for any other quote. */
export async function inquiryForQuote(
  db: Db,
  quoteId: number,
): Promise<{ contactName: string; org: string; phone: string; email: string } | null> {
  const [row] = await db
    .select({
      contactName: inquiries.contactName,
      org: inquiries.org,
      phone: inquiries.phone,
      email: inquiries.email,
    })
    .from(inquiries)
    .where(eq(inquiries.quoteId, quoteId))
    .limit(1);
  return row ?? null;
}

const CONTACT_KEYS = ["contactName", "contact", "email"] as const;

/** event_json with the customer's contact blanked; null when it is not a JSON object. */
function blankContact(eventJson: string): string | null {
  let event: unknown;
  try {
    event = JSON.parse(eventJson);
  } catch {
    return null;
  }
  if (typeof event !== "object" || event === null || Array.isArray(event)) return null;
  const out: Record<string, unknown> = { ...event };
  for (const key of CONTACT_KEYS) if (key in out) out[key] = "";
  return JSON.stringify(out);
}

/**
 * Deletes inquiries older than RETENTION_DAYS. Before that, the contact name, phone and email are
 * blanked in every version's event_json of the quotes they made (the quotes themselves stay).
 * Returns how many inquiries were deleted. Safe to run again after a partial failure.
 */
export async function purgeOldInquiries(db: Db, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * DAY_MS).toISOString();

  const linked = await db
    .select({ quoteId: inquiries.quoteId })
    .from(inquiries)
    .where(and(lt(inquiries.createdAt, cutoff), isNotNull(inquiries.quoteId)));
  for (const { quoteId } of linked) {
    if (quoteId === null) continue;
    const versions = await db
      .select({ id: quoteVersions.id, eventJson: quoteVersions.eventJson })
      .from(quoteVersions)
      .where(and(eq(quoteVersions.quoteId, quoteId), isNotNull(quoteVersions.eventJson)));
    for (const row of versions) {
      const blanked = blankContact(row.eventJson!);
      if (blanked === null) {
        console.error("inquiry purge: unreadable event_json left as is", { quoteId });
        continue;
      }
      if (blanked !== row.eventJson) {
        await db.update(quoteVersions).set({ eventJson: blanked }).where(eq(quoteVersions.id, row.id));
      }
    }
  }

  const deleted = await db
    .delete(inquiries)
    .where(lt(inquiries.createdAt, cutoff))
    .returning({ id: inquiries.id });
  return deleted.length;
}

type InquiryContact = { contactName: string; org: string; phone: string; email: string };

/** A question the model left in `missing` about what the inquiry form already gave. */
const CONTACT_QUESTION = /연락처|메일|담당자|전화|성함/;

/**
 * The event of a quote that came from a site inquiry, with the contact the customer typed written
 * in by code (the model never saw it): name, phone and email overwrite whatever the model wrote,
 * an empty customerName gets the org, and the questions about contact are dropped. No inquiry
 * (null) leaves the event as it is.
 */
export function applyInquiryContact(event: QuoteEvent, c: InquiryContact | null): QuoteEvent {
  if (c === null) return event;
  return {
    ...event,
    customerName: event.customerName.trim() === "" ? c.org : event.customerName,
    contactName: c.contactName,
    contact: c.phone,
    email: c.email,
    missing: event.missing.filter((m) => !CONTACT_QUESTION.test(m)),
  };
}

/** The event with name, phone and email blanked: what an inquiry quote may send to the model. */
export function stripContact(event: QuoteEvent): QuoteEvent {
  return { ...event, contactName: "", contact: "", email: "" };
}
