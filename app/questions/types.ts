/**
 * Questions for the owner, answered on her phone at /questions. The questions themselves are
 * seeded into D1 from a private file (they name real prices and competitors), never from code.
 *
 * - text: she writes an answer.
 * - confirm: she checks `current` and taps 맞아요, or rewrites it.
 * - action: she does something on another screen (`link`), then taps 했어요.
 */
export const QUESTION_KINDS = ["text", "confirm", "action"] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

/** open/later = still to do (later ones go last); answered/unknown = done. */
export const QUESTION_STATUSES = ["open", "later", "answered", "unknown"] as const;
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];

/**
 * What a confirm answer changes besides being stored:
 * - `setting:<key>`: a rewritten text replaces that settings row (맞아요 leaves it as is).
 * - `prices`: 맞아요 clears the "확인 필요" mark on every price item.
 */
export type QuestionApply = `setting:${string}` | "prices";

/** Settings rows a question may overwrite. Anything else in `apply` is ignored. */
export const APPLY_SETTING_KEYS = ["footer_short", "quote_intro"] as const;

export const MAX_ANSWER_CHARS = 4000;

export const ANSWER_CONFIRMED = "맞아요";
export const ANSWER_DONE = "했어요";
