import { asc, eq, inArray, sql } from "drizzle-orm";
import { ownerQuestions, priceItems, settings } from "../../database/schema";
import type { Db } from "../server/db";
import { DomainError } from "../server/errors";
import {
  ANSWER_CONFIRMED,
  ANSWER_DONE,
  APPLY_SETTING_KEYS,
  MAX_ANSWER_CHARS,
  type QuestionStatus,
} from "./types";

export type OwnerQuestion = typeof ownerQuestions.$inferSelect;

const LEFT: QuestionStatus[] = ["open", "later"];

/** Still to do: open ones first, then the ones she put off, each in their seeded order. */
export async function listLeft(db: Db): Promise<OwnerQuestion[]> {
  return db
    .select()
    .from(ownerQuestions)
    .where(inArray(ownerQuestions.status, LEFT))
    .orderBy(sql`${ownerQuestions.status} = 'later'`, asc(ownerQuestions.sort), asc(ownerQuestions.id));
}

export async function listDone(db: Db): Promise<OwnerQuestion[]> {
  return db
    .select()
    .from(ownerQuestions)
    .where(inArray(ownerQuestions.status, ["answered", "unknown"]))
    .orderBy(asc(ownerQuestions.sort), asc(ownerQuestions.id));
}

export async function countLeft(db: Db): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(ownerQuestions)
    .where(inArray(ownerQuestions.status, LEFT));
  return Number(row?.n ?? 0);
}

async function getQuestion(db: Db, id: string): Promise<OwnerQuestion> {
  const [q] = await db.select().from(ownerQuestions).where(eq(ownerQuestions.id, id));
  if (!q) throw new DomainError("NOT_FOUND", "이 질문을 찾지 못했어요.");
  return q;
}

async function setStatus(db: Db, id: string, status: QuestionStatus, answer: string | null, now: Date) {
  await db
    .update(ownerQuestions)
    .set({ status, answer, answeredAt: status === "later" ? null : now.toISOString() })
    .where(eq(ownerQuestions.id, id));
}

function cleanAnswer(raw: string): string {
  const text = raw.replace(/\r\n/g, "\n").trim();
  if (!text) throw new DomainError("INVALID_INPUT", "답을 적어 주세요.");
  if (text.length > MAX_ANSWER_CHARS) throw new DomainError("INVALID_INPUT", `${MAX_ANSWER_CHARS}자까지 적을 수 있어요.`);
  return text;
}

/** A written answer. For a confirm question it is her rewrite of `current`. */
export async function answerQuestion(db: Db, id: string, raw: string, now: Date): Promise<void> {
  const q = await getQuestion(db, id);
  const text = cleanAnswer(raw);
  if (q.kind === "confirm" && text === (q.current ?? "").trim()) {
    // Sent back unchanged: same as 맞아요.
    return confirmQuestion(db, id, now);
  }
  const key = q.kind === "confirm" ? settingKeyOf(q.apply) : null;
  if (key) {
    await db.batch([
      db
        .insert(settings)
        .values({ key, value: text })
        .onConflictDoUpdate({ target: settings.key, set: { value: sql`excluded.value` } }),
      db
        .update(ownerQuestions)
        .set({ status: "answered", answer: text, answeredAt: now.toISOString() })
        .where(eq(ownerQuestions.id, id)),
    ]);
    return;
  }
  await setStatus(db, id, "answered", text, now);
}

/** 맞아요 (confirm) or 했어요 (action). */
export async function confirmQuestion(db: Db, id: string, now: Date): Promise<void> {
  const q = await getQuestion(db, id);
  if (q.kind === "text") throw new DomainError("INVALID_INPUT", "답을 적어 주세요.");
  const answer = q.kind === "action" ? ANSWER_DONE : ANSWER_CONFIRMED;
  if (q.kind === "confirm" && q.apply === "prices") {
    await db.batch([
      db.update(priceItems).set({ needsConfirm: false }).where(eq(priceItems.needsConfirm, true)),
      db
        .update(ownerQuestions)
        .set({ status: "answered", answer, answeredAt: now.toISOString() })
        .where(eq(ownerQuestions.id, id)),
    ]);
    return;
  }
  await setStatus(db, id, "answered", answer, now);
}

export async function skipQuestion(db: Db, id: string, how: "later" | "unknown", now: Date): Promise<void> {
  await getQuestion(db, id);
  await setStatus(db, id, how, null, now);
}

/** Back to the list, to answer again (from 답한 것). */
export async function reopenQuestion(db: Db, id: string): Promise<void> {
  await getQuestion(db, id);
  await db
    .update(ownerQuestions)
    .set({ status: "open", answer: null, answeredAt: null })
    .where(eq(ownerQuestions.id, id));
}

function settingKeyOf(apply: string | null): string | null {
  if (!apply?.startsWith("setting:")) return null;
  const key = apply.slice("setting:".length);
  return (APPLY_SETTING_KEYS as readonly string[]).includes(key) ? key : null;
}
