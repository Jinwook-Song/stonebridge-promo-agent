/**
 * How much of a text the owner changed: line-level Levenshtein distance divided by the longer
 * line count (at least 1), rounded to 2 decimals. Identical → 0, every line different → 1.
 * Pure; shared by the server (stored on confirm) and anything that wants to preview it.
 */
export function editRatio(before: string, after: string): number {
  const a = before.split("\n");
  const b = after.split("\n");
  // One row of the DP table at a time.
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  const distance = prev[b.length];
  return Math.round((distance / Math.max(a.length, b.length, 1)) * 100) / 100;
}
