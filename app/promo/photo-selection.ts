import { MAX_PHOTOS } from "./types";

/**
 * Which uploaded candidates go into the post, in blog order. Ids are the client-side candidate
 * ids; `reasons` holds the AI's one-line reason for ids it picked (dropped when deselected).
 * Pure helpers: no React or DOM, so they are unit-tested in the workers pool.
 */
export type Selection = { order: number[]; reasons: Record<number, string> };

export type Pick = { n: number; reason: string };

/** Newly added photos are selected while there is room; the rest stay unselected. */
export function addCandidates(sel: Selection, ids: number[], max = MAX_PHOTOS): Selection {
  const order = [...sel.order];
  for (const id of ids) {
    if (order.length >= max) break;
    if (!order.includes(id)) order.push(id);
  }
  return order.length === sel.order.length ? sel : { order, reasons: sel.reasons };
}

/** Tap: selected → removed (its reason too); unselected → appended if there is room. */
export function toggle(sel: Selection, id: number, max = MAX_PHOTOS): Selection {
  if (sel.order.includes(id)) return drop(sel, id);
  if (sel.order.length >= max) return sel;
  return { order: [...sel.order, id], reasons: sel.reasons };
}

/** The candidate itself is gone (✕). */
export function removeCandidate(sel: Selection, id: number): Selection {
  return sel.order.includes(id) ? drop(sel, id) : sel;
}

/**
 * The AI's picks replace the selection. `n` is 1-based into `sentIds` (the candidates sent, in
 * that order); ids no longer in `presentIds` (removed while the AI was picking), invalid or
 * repeated `n` are skipped, and at most `max` are kept. If none survive, the current selection
 * is kept rather than leaving her with nothing selected.
 */
export function applyPicks(
  sel: Selection,
  picks: Pick[],
  sentIds: number[],
  presentIds: Set<number>,
  max = MAX_PHOTOS,
): Selection {
  const order: number[] = [];
  const reasons: Record<number, string> = {};
  for (const { n, reason } of picks) {
    if (order.length >= max) break;
    if (!Number.isInteger(n) || n < 1 || n > sentIds.length) continue;
    const id = sentIds[n - 1];
    if (!presentIds.has(id) || order.includes(id)) continue;
    order.push(id);
    reasons[id] = reason;
  }
  return order.length === 0 ? sel : { order, reasons };
}

function drop(sel: Selection, id: number): Selection {
  const reasons = { ...sel.reasons };
  delete reasons[id];
  return { order: sel.order.filter((x) => x !== id), reasons };
}
