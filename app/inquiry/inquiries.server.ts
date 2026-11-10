import { and, count, eq, gte, isNotNull, lt } from "drizzle-orm";
import { inquiries, quoteVersions } from "../../database/schema";
import { createQuote, isUniqueViolation } from "../quote/quotes.server";
import type { Db } from "../server/db";
import { inquiryInputSchema, inquiryToQuoteText } from "./schema";

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
  quoteId: number;
  org: string;
  eventDate: string | null;
  headcount: number | null;
};

export type SubmitDeps = {
  db: Db;
  startGeneration: (quoteId: number) => Promise<void>;
  notify: (info: NewInquiryInfo) => Promise<unknown>;
};

/**
 * Logging an error object could print query parameters (drizzle puts them in the message), which
 * would leak the customer's contact. Only its class name is logged for anything that touched them.
 */
function errName(e: unknown): string {
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

  const existing = await findByToken(db, v.clientToken);
  if (existing !== null) return { ok: true, inquiryId: existing };

  const since = new Date(now.getTime() - RATE_WINDOW_MS).toISOString();
  const [{ recent }] = await db
    .select({ recent: count() })
    .from(inquiries)
    .where(and(eq(inquiries.ipHash, meta.ipHash), gte(inquiries.createdAt, since)));
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

  let quoteId: number;
  try {
    ({ quoteId } = await createQuote(db, { text: inquiryToQuoteText(v), source: "app" }, now));
    await db.update(inquiries).set({ quoteId }).where(eq(inquiries.id, inquiryId));
  } catch (e) {
    console.error("inquiry quote failed", { inquiryId, error: errName(e) });
    return { ok: true, inquiryId };
  }

  try {
    await deps.startGeneration(quoteId);
  } catch (e) {
    console.error("inquiry quote generation did not start", { inquiryId, quoteId, error: errName(e) });
  }
  try {
    await deps.notify({ quoteId, org: v.org, eventDate: v.eventDate, headcount: v.headcount });
  } catch (e) {
    console.error("inquiry alert failed", { inquiryId, quoteId, error: errName(e) });
  }
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
