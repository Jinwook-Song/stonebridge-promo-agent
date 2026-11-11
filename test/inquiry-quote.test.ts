import type Anthropic from "@anthropic-ai/sdk";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { inquiries, priceItems, quotes, quoteVersions } from "../database/schema";
import { applyInquiryContact, stripContact, submitInquiry } from "../app/inquiry/inquiries.server";
import type { QuoteCall } from "../app/promo/claude.server";
import { runQuoteGeneration, startQuoteGeneration, type QuoteGenDeps, type QuoteRunRef } from "../app/quote/generate.server";
import { CONTACT_ON_FILE_HEADING, type QuoteOutput } from "../app/quote/prompt";
import { createQuote, getQuote, requestRevision } from "../app/quote/quotes.server";
import type { QuoteEvent } from "../app/quote/types";
import { getDb } from "../app/server/db";

const db = getDb(env.DB);
const T0 = new Date("2026-11-09T01:00:00.000Z");
const T1 = new Date("2026-11-09T01:02:00.000Z");
const T2 = new Date("2026-11-09T01:04:00.000Z");

// Made-up customer; nothing here is real.
const CONTACT = { contactName: "김예시", org: "예시 학원", phone: "010-0000-0000", email: "test@example.com" };

function baseEvent(over: Partial<QuoteEvent> = {}): QuoteEvent {
  return {
    customerName: "",
    contactName: "",
    contact: "",
    email: "",
    eventDate: "2026-12-01",
    headcount: 40,
    venue: "예시 강당",
    eventType: "학원 다과",
    budget: "",
    requests: "",
    missing: [],
    ...over,
  };
}

describe("applyInquiryContact", () => {
  it("overwrites contact fields and fills an empty customerName with the org", () => {
    const model = baseEvent({ contactName: "모델이 지어낸 이름", contact: "010-9999-9999", email: "x@example.org" });
    const out = applyInquiryContact(model, CONTACT);
    expect(out).toMatchObject({
      contactName: "김예시",
      contact: "010-0000-0000",
      email: "test@example.com",
      customerName: "예시 학원",
    });
    // Everything else is the model's.
    expect(out.venue).toBe("예시 강당");
    expect(out.headcount).toBe(40);
    // A customerName the model/owner already has stays.
    expect(applyInquiryContact(baseEvent({ customerName: "예시 학원 본원" }), CONTACT).customerName).toBe("예시 학원 본원");
  });

  it("returns the event unchanged when there is no inquiry", () => {
    const event = baseEvent({ contactName: "누구", contact: "02-000-0000", email: "a@example.com", missing: ["연락처를 알려 주세요"] });
    expect(applyInquiryContact(event, null)).toEqual(event);
  });

  it("drops missing items about contact, phone, name, mail or the person in charge", () => {
    const out = applyInquiryContact(
      baseEvent({
        missing: ["연락처를 알려 주실 수 있나요?", "회신받을 메일 주소가 필요해요", "담당자 성함이 없어요", "전화번호를 알려 주세요", "성함을 알려 주세요", "예산을 알려 주실 수 있나요?"],
      }),
      CONTACT,
    );
    expect(out.missing).toEqual(["예산을 알려 주실 수 있나요?"]);
  });
});

describe("stripContact", () => {
  it("blanks name, phone and email and nothing else", () => {
    const out = stripContact(baseEvent({ customerName: "예시 학원", contactName: "김예시", contact: "010-0000-0000", email: "test@example.com" }));
    expect(out).toMatchObject({ customerName: "예시 학원", contactName: "", contact: "", email: "", venue: "예시 강당" });
  });
});

// ---- generation ------------------------------------------------------------

let snackId: number;

function output(over: Partial<QuoteOutput> = {}): QuoteOutput {
  return {
    event: baseEvent({ contactName: "모델 이름", contact: "010-1111-1111", email: "model@example.org", missing: ["연락처를 알려 주세요", "예산을 알려 주실 수 있나요?"] }),
    lines: [{ itemId: snackId, label: "다과 세트", content: "쿠키 2종", qty: 40, menu: "", note: "", tip: "", prevIndex: null }],
    comparison: { notes: "", citedIds: [] },
    email: { subject: "견적 보내드려요", body: "안녕하세요. 견적서 보내드려요." },
    requestSummary: "인원 변경",
    ...over,
  };
}

/** A fake Claude that records the whole outgoing message (system + every block) of each call. */
function recordingQuote(sent: string[], out: () => QuoteOutput = output): QuoteCall {
  return async (req) => {
    sent.push([req.system, ...req.user.map((b: Anthropic.ContentBlockParam) => (b.type === "text" ? b.text : ""))].join("\n"));
    return { output: out(), inputTokens: 1, outputTokens: 1 };
  };
}

function deps(quote: QuoteCall): QuoteGenDeps {
  return {
    db,
    quote,
    importQuote: async () => {
      throw new Error("not used");
    },
    now: () => T1,
  };
}

async function run(quoteId: number, version: number, d: QuoteGenDeps, now = T0) {
  const create = vi.fn(async ({ id }: { id?: string }) => ({ id }));
  await startQuoteGeneration({ QUOTE_GENERATE: { create } as unknown as Env["QUOTE_GENERATE"] }, db, quoteId, version, now);
  const call = create.mock.calls.at(-1)![0] as { id: string };
  const ref: QuoteRunRef = { quoteId, version, workflowId: call.id };
  await runQuoteGeneration(d, ref);
}

/** An inquiry and the quote it made, as submitInquiry leaves them (generation not started). */
async function inquiryQuote(): Promise<number> {
  const res = await submitInquiry(
    { db, startGeneration: async () => {}, notify: async () => "disabled", defer: () => {} },
    {
      ...CONTACT,
      eventDate: "2026-12-01",
      startTime: "14:00",
      venue: "예시 강당",
      headcount: 40,
      eventType: "학교·학원",
      menus: ["샌드위치와 간식"],
      budget: "",
      requests: "",
      referral: "",
      consent: true,
      clientToken: "tok-quote-1",
    },
    { ipHash: "hash-q" },
    T0,
  );
  expect(res.ok).toBe(true);
  const [row] = await db.select().from(inquiries);
  return row.quoteId!;
}

beforeEach(async () => {
  await db.delete(inquiries);
  await db.delete(quotes);
  await db.delete(priceItems);
  const [item] = await db
    .insert(priceItems)
    .values({ kind: "per_person", name: "다과 세트", unit: "인", unitPrice: 7700, sort: 0, createdAt: T0.toISOString() })
    .returning({ id: priceItems.id });
  snackId = item.id;
});

describe("quotes made from an inquiry", () => {
  it("generation of an inquiry quote stores contact from inquiry", async () => {
    const quoteId = await inquiryQuote();
    await run(quoteId, 1, deps(recordingQuote([])));

    const { version } = await getQuote(db, quoteId, 1);
    expect(version.event).toMatchObject({
      contactName: "김예시",
      contact: "010-0000-0000",
      email: "test@example.com",
      customerName: "예시 학원",
    });
    // The model's own contact guesses and the questions about them are gone.
    expect(version.event!.missing).toEqual(["예산을 알려 주실 수 있나요?"]);
  });

  it("a quote that did not come from an inquiry keeps what the model wrote", async () => {
    const { quoteId } = await createQuote(db, { text: "12월 1일 학원 다과 40명", source: "app" }, T0);
    await run(quoteId, 1, deps(recordingQuote([])));

    const { version } = await getQuote(db, quoteId, 1);
    expect(version.event).toMatchObject({ contactName: "모델 이름", contact: "010-1111-1111", email: "model@example.org" });
    expect(version.event!.missing).toContain("연락처를 알려 주세요");
  });

  it("revision keeps inquiry contact", async () => {
    const quoteId = await inquiryQuote();
    await run(quoteId, 1, deps(recordingQuote([])));
    expect(await requestRevision(db, quoteId, "인원을 50명으로 바꿔 주세요", T1)).toEqual({ version: 2 });
    // The revision's model answer has no contact at all.
    const bare = () => output({ event: baseEvent({ headcount: 50 }) });
    await run(quoteId, 2, deps(recordingQuote([], bare)), T2);

    const { version } = await getQuote(db, quoteId, 2);
    expect(version.status).toBe("ready");
    expect(version.event).toMatchObject({
      headcount: 50,
      contactName: "김예시",
      contact: "010-0000-0000",
      email: "test@example.com",
      customerName: "예시 학원",
    });
  });

  it("prompt text for v1 and v2 of an inquiry quote has no phone, email or contact name", async () => {
    const sent: string[] = [];
    const quoteId = await inquiryQuote();
    await run(quoteId, 1, deps(recordingQuote(sent)));
    // v1 is stored with the contact: it must not reach the v2 prompt.
    const [stored] = await db
      .select({ eventJson: quoteVersions.eventJson })
      .from(quoteVersions)
      .where(and(eq(quoteVersions.quoteId, quoteId), eq(quoteVersions.version, 1)));
    expect(stored.eventJson).toContain("010-0000-0000");

    await requestRevision(db, quoteId, "인원을 50명으로 바꿔 주세요", T1);
    await run(quoteId, 2, deps(recordingQuote(sent)), T2);

    expect(sent).toHaveLength(2);
    // v2 really carries the previous event (so the check below is not vacuous).
    expect(sent[1]).toContain("## 이전 버전 행사 정보");
    expect(sent[1]).toContain("예시 강당");
    for (const text of sent) {
      expect(text).not.toContain("010-");
      expect(text).not.toContain("@");
      expect(text).not.toContain("김예시");
    }
  });

  it("a failing save of an inquiry quote leaks no contact into logs or the thrown error", async () => {
    const quoteId = await inquiryQuote();
    // What a drizzle error looks like: the query params are in the message.
    const leaky = new Error(`Failed query: update "quote_versions" params: 010-0000-0000,test@example.com,김예시`);
    const batch = vi.spyOn(db, "batch").mockRejectedValueOnce(leaky);
    const spies = (["log", "warn", "error", "info", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    try {
      const create = vi.fn(async ({ id }: { id?: string }) => ({ id }));
      await startQuoteGeneration({ QUOTE_GENERATE: { create } as unknown as Env["QUOTE_GENERATE"] }, db, quoteId, 1, T0);
      const ref: QuoteRunRef = { quoteId, version: 1, workflowId: (create.mock.calls.at(-1)![0] as { id: string }).id };
      const thrown = await runQuoteGeneration(deps(recordingQuote([])), ref).then(
        () => null,
        (e: unknown) => e as Error,
      );

      expect(batch).toHaveBeenCalledTimes(1);
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown!.message).toBe("QUOTE_SAVE_FAILED");
      expect(thrown!.cause).toBeUndefined();
      const printed = spies
        .flatMap((s) => s.mock.calls)
        .map((args) => JSON.stringify(args, (_k, v) => (v instanceof Error ? { name: v.name, message: v.message } : v)));
      expect(printed.length).toBeGreaterThan(0);
      for (const text of [...printed, thrown!.message, String(thrown!.stack)]) {
        expect(text).not.toContain("010-");
        expect(text).not.toContain("@");
        expect(text).not.toContain("김예시");
      }
    } finally {
      batch.mockRestore();
      spies.forEach((s) => s.mockRestore());
    }
    // Same end state as any other failed save: the version is failed and can be retried.
    const { version } = await getQuote(db, quoteId, 1);
    expect(version.status).toBe("failed");
  });

  it("v1 and v2 of an inquiry quote tell the model, outside the inquiry fence, that the contact is on file", async () => {
    const users: string[] = [];
    const quote: QuoteCall = async (req) => {
      users.push(req.user.map((b: Anthropic.ContentBlockParam) => (b.type === "text" ? b.text : "")).join("\n"));
      return { output: output(), inputTokens: 1, outputTokens: 1 };
    };
    const quoteId = await inquiryQuote();
    await run(quoteId, 1, deps(quote));
    await requestRevision(db, quoteId, "인원을 50명으로 바꿔 주세요", T1);
    await run(quoteId, 2, deps(quote), T2);

    expect(users).toHaveLength(2);
    for (const text of users) {
      const notice = text.indexOf(CONTACT_ON_FILE_HEADING);
      expect(notice).toBeGreaterThan(text.indexOf("</문의글>"));
    }
  });

  it("a quote that did not come from an inquiry gets no contact-on-file notice", async () => {
    const users: string[] = [];
    const quote: QuoteCall = async (req) => {
      users.push(req.user.map((b: Anthropic.ContentBlockParam) => (b.type === "text" ? b.text : "")).join("\n"));
      return { output: output(), inputTokens: 1, outputTokens: 1 };
    };
    const { quoteId } = await createQuote(db, { text: "12월 1일 학원 다과 40명", source: "app" }, T0);
    await run(quoteId, 1, deps(quote));
    expect(users[0]).not.toContain(CONTACT_ON_FILE_HEADING);
  });

  it("a non-inquiry quote's v2 prompt still carries the previous event as it was", async () => {
    const sent: string[] = [];
    const { quoteId } = await createQuote(db, { text: "12월 1일 학원 다과 40명", source: "app" }, T0);
    await run(quoteId, 1, deps(recordingQuote(sent)));
    await requestRevision(db, quoteId, "인원을 50명으로 바꿔 주세요", T1);
    await run(quoteId, 2, deps(recordingQuote(sent)), T2);
    expect(sent[1]).toContain("010-1111-1111");
  });
});
