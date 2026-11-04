/**
 * NEMAR's standard edit to a dataset's `.bidsignore`: the line that keeps the BIDS validator away
 * from `.nemar/`.
 *
 * Two places make this edit today, each with its own copy of the rule: the backend's enrichment
 * commit (`commitEnrichmentWithBidsignore` in `backend/src/services/github/contents.ts`) and the
 * upload's metadata step (`writeNemarMetadata` in `src/lib/upload/finalize.ts`). They are left as
 * they are here; the upstream re-pull's planner (ADR 0111) uses this function to recognize the
 * edit, and `test/standard-edits-bidsignore.test.ts` holds it to the upload's copy byte for byte.
 *
 * Pure: no I/O, and no import from Node or the Worker runtime.
 */

/** The `.bidsignore` line NEMAR adds for its own metadata directory. */
export const NEMAR_BIDSIGNORE_ENTRY = ".nemar/";

/**
 * `content` with `entry` on a line of its own at the end, unless `content` already contains
 * `entry` anywhere (a substring test, as both callers make it, so `.nemar/` inside another line
 * counts as present). Trailing whitespace before the new line is trimmed, and the result ends
 * with a newline. An empty file becomes just the entry.
 */
export function withBidsignoreEntry(
  content: string,
  entry: string,
): { content: string; changed: boolean } {
  if (content.includes(entry)) return { content, changed: false };
  return { content: content ? `${content.trimEnd()}\n${entry}\n` : `${entry}\n`, changed: true };
}
