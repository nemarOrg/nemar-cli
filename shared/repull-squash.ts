/**
 * The squash commit a re-pull's pull request is merged with (ADR 0111, decision 2, and its Phase 6f
 * and Phase 7g amendments): its title, and a message whose last paragraph is the re-pull commit's
 * two trailers, `Upstream-Snapshot:` and `Repull-Plan:` (N.0.1's `Repull-Patch:` beside them).
 * Pure, and importing nothing but the shared row columns, so the administrator's merge gate
 * (`src/lib/repull/merge.ts`) and the Worker's merge of an automatic re-pull
 * (`backend/src/services/upstream-repull-merge.ts`) send one message, built in one place.
 *
 * The message matters after the merge. The privacy ledger's fresh-clone proof (ADR 0085) reads the
 * squash commit on `main` as the re-pull's own commit only when its trailers are its last paragraph
 * as git reads them, and the release reads the committed message back (`merge-trailers`) before it
 * records anything. GitHub's default squash message lists each commit as a bullet and puts the
 * trailers mid-message, so a merge never leaves the message to GitHub.
 */

import { PULL_REQUEST_COLUMNS, type RepullPullRequest, type RepullRow } from "./repull-state.js";

/** The trailer N.0.1's commit and its squash carry beside the re-pull's two. */
export const REPULL_PATCH_TRAILER = "Repull-Patch";

/**
 * The two lines, exactly as the re-pull commit and its squash merge carry them. This is the one
 * place they are written: the re-pull commit's own message (`execute/synthesize.ts`), the squash
 * message, the N.0.1 commit (`patchMessage`) and both pull request bodies call it, and
 * `test/repull-trailers.unit.test.ts` pins each writer's lines to its output.
 */
export function repullTrailerLines(r: {
  upstream_ds: string;
  to_tag: string;
  plan_digest: string;
}): [string, string] {
  return [`Upstream-Snapshot: ${r.upstream_ds}@${r.to_tag}`, `Repull-Plan: ${r.plan_digest}`];
}

/** N.0.1's third trailer, with the plan's count of corrections: the one place it is written. */
export function repullPatchTrailerLine(corrections: number): string {
  return `${REPULL_PATCH_TRAILER}: corrections=${corrections}`;
}

/**
 * A trailer's value as the ledger proof's own patterns read it (`UPSTREAM_SNAPSHOT_TRAILER` and
 * `REPULL_PLAN_TRAILER` in `scripts/scrub/git/git-lib.ts`, which `test/repull-trailers.unit.test.ts`
 * pins these to): an upstream dataset and a tag of letters, digits, `.`, `_` and `-` that begins
 * with a letter or a digit, and the plan's `sha256:` digest.
 */
export const SNAPSHOT_TRAILER_VALUE_RE = /^ds\d{6}@[0-9A-Za-z][0-9A-Za-z._-]*$/;
export const PLAN_TRAILER_VALUE_RE = /^sha256:[0-9a-f]{64}$/;

/**
 * Why a record's two trailers would not read as the ledger proof reads them, or null when they
 * would. The Worker cannot run `git interpret-trailers`, which the administrator's gate checks the
 * whole message with, so it checks the two values: with each of the proof's shape, the message
 * {@link repullSquashMessage} builds ends with a paragraph of exactly those two trailers, which
 * the same test proves git reads as the trailers.
 */
export function trailerValuesProblem(r: {
  upstream_ds: string;
  to_tag: string;
  plan_digest: string;
}): string | null {
  if (!SNAPSHOT_TRAILER_VALUE_RE.test(`${r.upstream_ds}@${r.to_tag}`)) {
    return "the record's upstream dataset or tag is not a value the Upstream-Snapshot: trailer can carry";
  }
  if (!PLAN_TRAILER_VALUE_RE.test(r.plan_digest)) {
    return "the record's plan digest is not a value the Repull-Plan: trailer can carry";
  }
  return null;
}

/** Who sends the merge: an administrator through the gate, or the Worker for an automatic re-pull. */
export type SquashMerger = "gate" | "worker";

/**
 * The squash commit: its title and a message whose last paragraph is the trailers (N.0.1's with
 * its own `Repull-Patch:` beside them, when the record says how many corrections). Only the first
 * paragraph says who merged it; the title and the trailers are the same either way.
 */
export function repullSquashMessage(
  row: Pick<
    RepullRow,
    "id" | "upstream_ds" | "from_tag" | "to_tag" | "plan_digest" | "to_version" | "patch_version"
  > & { counts?: Record<string, number> },
  prNumber: number,
  pr: RepullPullRequest = "n0",
  merger: SquashMerger = "gate",
): { title: string; message: string } {
  const [snapshot, plan] = repullTrailerLines(row);
  const corrections = pr === "n1" ? row.counts?.corrections : undefined;
  const how =
    merger === "worker"
      ? "squash-merged by the Worker as a machine-clean automatic re-pull"
      : "squash-merged through the re-pull's merge gate";
  return {
    title: `Release v${row[PULL_REQUEST_COLUMNS[pr].version]} (#${prNumber})`,
    message: [
      pr === "n0"
        ? `Re-pull of upstream ${row.upstream_ds} from snapshot ${row.from_tag} to ${row.to_tag} (re-pull #${row.id}), ${how} (ADR 0111).`
        : `NEMAR's corrections of re-pull #${row.id} (upstream ${row.upstream_ds} ${row.from_tag} to ${row.to_tag}), replayed onto v${row.to_version}, ${how} (ADR 0111).`,
      "",
      snapshot,
      plan,
      ...(pr === "n1" && typeof corrections === "number"
        ? [repullPatchTrailerLine(corrections)]
        : []),
    ].join("\n"),
  };
}
